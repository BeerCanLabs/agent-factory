import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Keymaster, type Approval, type ApprovalConsumer } from './keymaster.js';
import { MemoryLedger, payloadHash } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens } from '@beercanlabs/factory-auth';

class MockApprovalStore implements ApprovalConsumer {
  private approvals = new Map<string, Approval>();

  add(a: Approval) {
    this.approvals.set(a.approvalId, { ...a });
  }

  get(approvalId: string): Approval | undefined {
    const a = this.approvals.get(approvalId);
    return a ? { ...a } : undefined;
  }

  consume(approvalId: string): Approval | undefined {
    const a = this.approvals.get(approvalId);
    if (!a || a.state !== 'approved') return undefined;
    const consumed: Approval = { ...a, state: 'consumed' };
    this.approvals.set(approvalId, consumed);
    return { ...consumed };
  }
}

describe('Keymaster Subsystem', () => {
  const secretKey = 'PROD_DB_PASSWORD';
  const secretVal = 'super-secret-db-pass-12345';
  const provider = envProvider({ [secretKey]: secretVal, UNGATED_SECRET: 'ungated-val' });

  it('unconsumed approval produces ephemeral lease and writes zero-knowledge transaction to ledger', async () => {
    const ledger = new MemoryLedger();
    const approvals = new MockApprovalStore();
    const runTokens = new RunTokens(undefined);

    const approval: Approval = {
      approvalId: 'app-1',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout:PROD_DB_PASSWORD',
      argsSha256: payloadHash({ secret: secretKey, turnId: 'turn-42' }),
      state: 'approved',
      requestedAt: new Date().toISOString(),
      decidedBy: 'discord:user-123',
      decidedAt: new Date().toISOString(),
    };
    approvals.add(approval);

    const token = await runTokens.mint({ runId: 'run-1', agentId: 'agent-1' });

    const keymaster = new Keymaster({
      approvals,
      ledger,
      providers: [provider],
      runTokens,
      getAgent: () => ({ id: 'agent-1', gated: [secretKey], ungated: ['UNGATED_SECRET'] }),
      getRun: () => ({ runId: 'run-1', agentId: 'agent-1', state: 'RUNNING' }),
    });

    const result = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-1',
      gatedSecret: secretKey,
      turnId: 'turn-42',
      proofHash: approval.argsSha256,
      runToken: token,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.status, 200);
    assert.equal(result.lease.secretName, secretKey);
    assert.equal(result.lease.value, secretVal);
    assert.equal(result.lease.turnId, 'turn-42');
    assert.ok(result.lease.leaseId.startsWith('lease_'));
    assert.ok(new Date(result.lease.expiresAt).getTime() > Date.now());

    // Verify approval is now consumed
    assert.equal(approvals.get('app-1')?.state, 'consumed');

    // Verify ledger event
    const events = ledger.query({ agent: 'agent-1' });
    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.action, 'KEYMASTER_CHECKOUT');
    assert.equal(ev.approvalId, 'app-1');
    assert.equal(ev.gatedSecret, secretKey);
    assert.equal(ev.turnId, 'turn-42');
    assert.equal(ev.leaseId, result.lease.leaseId);
    assert.equal(ev.payloadSha256, approval.argsSha256);

    // ZERO-KNOWLEDGE FLUSH: secret plaintext is NEVER written to ledger
    const serialized = JSON.stringify(ev);
    assert.equal(serialized.includes(secretVal), false, 'ledger event must not contain raw secret');
  });

  it('burned/consumed approval immediately fails on replay', async () => {
    const ledger = new MemoryLedger();
    const approvals = new MockApprovalStore();

    const approval: Approval = {
      approvalId: 'app-replay',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout:PROD_DB_PASSWORD',
      argsSha256: 'hash-abc',
      state: 'approved',
      requestedAt: new Date().toISOString(),
    };
    approvals.add(approval);

    const keymaster = new Keymaster({
      approvals,
      ledger,
      providers: [provider],
      getAgent: () => ({ id: 'agent-1', gated: [secretKey] }),
      getRun: () => ({ runId: 'run-1', agentId: 'agent-1', state: 'RUNNING' }),
    });

    // First checkout: succeeds
    const first = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-replay',
      gatedSecret: secretKey,
      turnId: 'turn-1',
      proofHash: 'hash-abc',
    });
    assert.equal(first.ok, true);

    // Replay checkout with same approval: must fail with 409
    const replay = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-replay',
      gatedSecret: secretKey,
      turnId: 'turn-2',
      proofHash: 'hash-abc',
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.status, 409);
    assert.equal(replay.error, 'approval_already_consumed');

    // Ledger records denial
    const deniedEvents = ledger.query().filter((e) => e.action === 'KEYMASTER_CHECKOUT_DENIED');
    assert.equal(deniedEvents.length, 1);
    assert.equal(deniedEvents[0].approvalId, 'app-replay');
  });

  it('rejects pending or rejected approvals', async () => {
    const ledger = new MemoryLedger();
    const approvals = new MockApprovalStore();

    approvals.add({
      approvalId: 'app-pending',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout',
      argsSha256: 'hash-p',
      state: 'pending',
      requestedAt: new Date().toISOString(),
    });

    approvals.add({
      approvalId: 'app-rejected',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout',
      argsSha256: 'hash-r',
      state: 'rejected',
      requestedAt: new Date().toISOString(),
    });

    const keymaster = new Keymaster({
      approvals,
      ledger,
      providers: [provider],
    });

    const p = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-pending',
      gatedSecret: secretKey,
      turnId: 'turn-1',
    });
    assert.equal(p.ok, false);
    assert.equal(p.status, 403);
    assert.equal(p.error, 'approval_pending');

    const r = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-rejected',
      gatedSecret: secretKey,
      turnId: 'turn-1',
    });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.error, 'approval_rejected');
  });

  it('rejects forged approval or proof hash mismatch', async () => {
    const ledger = new MemoryLedger();
    const approvals = new MockApprovalStore();

    approvals.add({
      approvalId: 'app-valid',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout',
      argsSha256: 'genuine-hash',
      state: 'approved',
      requestedAt: new Date().toISOString(),
    });

    const keymaster = new Keymaster({
      approvals,
      ledger,
      providers: [provider],
    });

    // 1. Forged approvalId
    const forged = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'non-existent-id',
      gatedSecret: secretKey,
      turnId: 'turn-1',
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.status, 404);
    assert.equal(forged.error, 'approval_not_found');

    // 2. Hash mismatch
    const badHash = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-valid',
      gatedSecret: secretKey,
      turnId: 'turn-1',
      proofHash: 'forged-hash-xyz',
    });
    assert.equal(badHash.ok, false);
    assert.equal(badHash.status, 403);
    assert.equal(badHash.error, 'proof_hash_mismatch');
  });

  it('rejects unauthenticated requests when runToken is invalid', async () => {
    const ledger = new MemoryLedger();
    const approvals = new MockApprovalStore();
    const runTokens = new RunTokens(undefined);

    approvals.add({
      approvalId: 'app-auth',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout',
      argsSha256: 'h',
      state: 'approved',
      requestedAt: new Date().toISOString(),
    });

    const keymaster = new Keymaster({
      approvals,
      ledger,
      providers: [provider],
      runTokens,
    });

    const result = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-auth',
      gatedSecret: secretKey,
      turnId: 'turn-1',
      runToken: 'invalid-token-here',
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.error, 'invalid_run_token');
  });

  it('rejects checkout of secrets not classified as gated', async () => {
    const ledger = new MemoryLedger();
    const approvals = new MockApprovalStore();

    approvals.add({
      approvalId: 'app-ungated',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout',
      argsSha256: 'h',
      state: 'approved',
      requestedAt: new Date().toISOString(),
    });

    const keymaster = new Keymaster({
      approvals,
      ledger,
      providers: [provider],
      getAgent: () => ({ id: 'agent-1', gated: [secretKey], ungated: ['UNGATED_SECRET'] }),
      getRun: () => ({ runId: 'run-1', agentId: 'agent-1', state: 'RUNNING' }),
    });

    const result = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-ungated',
      gatedSecret: 'UNGATED_SECRET',
      turnId: 'turn-1',
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    assert.equal(result.error, 'secret_not_gated');
  });

  it('tracks and revokes active leases', async () => {
    const ledger = new MemoryLedger();
    const approvals = new MockApprovalStore();

    approvals.add({
      approvalId: 'app-lease',
      runId: 'run-1',
      agentId: 'agent-1',
      route: 'keymaster',
      tool: 'checkout',
      argsSha256: 'h',
      state: 'approved',
      requestedAt: new Date().toISOString(),
    });

    const keymaster = new Keymaster({
      approvals,
      ledger,
      providers: [provider],
      leaseTtlMs: 10_000,
    });

    const res = await keymaster.checkout({
      runId: 'run-1',
      approvalId: 'app-lease',
      gatedSecret: secretKey,
      turnId: 'turn-1',
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;

    const leaseId = res.lease.leaseId;
    assert.ok(keymaster.getLease(leaseId));
    assert.equal(keymaster.getLease(leaseId)?.secretName, secretKey);

    // Revoke lease
    assert.equal(keymaster.revokeLease(leaseId), true);
    assert.equal(keymaster.getLease(leaseId), undefined);
  });

  it('executes gated dispatch injecting the credential without leaking secret', async () => {
    const receivedHeaders: Record<string, string | string[] | undefined> = {};
    const server = createServer((req, res) => {
      Object.assign(receivedHeaders, req.headers);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', authorized: true }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const targetUrl = `http://127.0.0.1:${port}/gated-action`;

    try {
      const ledger = new MemoryLedger();
      const approvals = new MockApprovalStore();

      approvals.add({
        approvalId: 'app-dispatch',
        runId: 'run-1',
        agentId: 'agent-1',
        route: 'keymaster',
        tool: 'dispatch',
        argsSha256: 'h-dispatch',
        state: 'approved',
        requestedAt: new Date().toISOString(),
      });

      const keymaster = new Keymaster({
        approvals,
        ledger,
        providers: [provider],
      });

      const dispatchRes = await keymaster.dispatchGated({
        runId: 'run-1',
        approvalId: 'app-dispatch',
        gatedSecret: secretKey,
        turnId: 'turn-dispatch',
        proofHash: 'h-dispatch',
        targetUrl,
        method: 'POST',
        headers: { 'X-Custom-Header': 'factory-test' },
        body: JSON.stringify({ action: 'do_privileged_thing' }),
      });

      assert.equal(dispatchRes.ok, true);
      if (!dispatchRes.ok) return;

      assert.equal(dispatchRes.status, 200);
      assert.deepEqual(JSON.parse(dispatchRes.body), { status: 'ok', authorized: true });
      assert.equal(receivedHeaders['authorization'], `Bearer ${secretVal}`);
      assert.equal(receivedHeaders['x-custom-header'], 'factory-test');

      // Ledger recorded KEYMASTER_CHECKOUT
      const events = ledger.query();
      assert.equal(events.length, 1);
      assert.equal(events[0].action, 'KEYMASTER_CHECKOUT');
      assert.equal(events[0].gatedSecret, secretKey);
    } finally {
      server.close();
    }
  });
});
