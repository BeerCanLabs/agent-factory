import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger, payloadHash } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import type { AgentRecord } from './catalog.js';

const KEY = 'e2e-run-token-key-0123456789abcdefghij';
const ADMIN = 'admin-e2e';
const GATEWAY = 'gateway-e2e';
const APPROVER = 'approver-e2e';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function http_(port: number, path: string, method = 'GET', token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('Keymaster Subsystem E2E & Secrets Gating', { concurrency: false }, () => {
  let cp: http.Server;
  let cpPort = 0;
  let state: FactoryState & { runtime: ReturnType<typeof noopRuntime> };

  const secretValues = {
    PUBLIC_TOKEN: 'public-token-12345',
    SECURE_VAULT_KEY: 'vault-secret-do-not-leak-99999',
    LEGACY_SECRET: 'legacy-secret-abcde',
  };

  const runtime = noopRuntime();
  const ledger = new MemoryLedger();
  const runTokens = new RunTokens(KEY);

  before(async () => {
    state = {
      agents: new Map<string, AgentRecord>(),
      ledger,
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'gateway', token: GATEWAY, roles: ['gateway'] },
        { name: 'approver', token: APPROVER, roles: ['approver'] },
      ]),
      version: '0.1.0-test',
      providers: [envProvider(secretValues)],
      runtime,
      runs: new MemoryRunStore(),
      runTokens,
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    };

    // Agent with both ungated and gated secrets
    const secureAgent: AgentRecord = {
      id: 'secure-agent',
      name: 'Secure Agent',
      role: 'Finance Bot',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: ['PUBLIC_TOKEN', 'SECURE_VAULT_KEY'],
      ungated: ['PUBLIC_TOKEN'],
      gated: ['SECURE_VAULT_KEY'],
      triggers: [{ type: 'http', path: '/run' }],
      memoryPrefix: 'secure-agent',
      dir: '/tmp/secure-agent',
    };
    state.agents.set(secureAgent.id, secureAgent);

    // Agent with legacy 1.0 requires
    const legacyAgent: AgentRecord = {
      id: 'legacy-agent',
      name: 'Legacy Agent',
      role: 'Echo Bot',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: ['LEGACY_SECRET'],
      ungated: ['LEGACY_SECRET'],
      gated: [],
      triggers: [{ type: 'http', path: '/run' }],
      memoryPrefix: 'legacy-agent',
      dir: '/tmp/legacy-agent',
    };
    state.agents.set(legacyAgent.id, legacyAgent);

    cp = createFactoryServer(state);
    cpPort = await listen(cp);
  });

  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
  });

  it('boot-time secrets isolation: only ungated secrets are mounted at boot; gated secrets are omitted', async () => {
    runtime.started.length = 0;
    const runRes = await http_(cpPort, '/api/v1/agents/secure-agent/runs', 'POST', ADMIN);
    assert.equal(runRes.status, 202);

    assert.equal(runtime.started.length, 1);
    const bootSecrets = runtime.started[0].secrets;

    // Ungated secret is mounted
    assert.equal(bootSecrets['PUBLIC_TOKEN'], secretValues.PUBLIC_TOKEN);

    // Gated secret is strictly omitted from the boot container environment!
    assert.equal(bootSecrets['SECURE_VAULT_KEY'], undefined);
    assert.equal('SECURE_VAULT_KEY' in bootSecrets, false);
  });

  it('backwards compatibility: legacy 1.0 cartridges mount all requires secrets at boot', async () => {
    runtime.started.length = 0;
    const runRes = await http_(cpPort, '/api/v1/agents/legacy-agent/runs', 'POST', ADMIN);
    assert.equal(runRes.status, 202);

    assert.equal(runtime.started.length, 1);
    const bootSecrets = runtime.started[0].secrets;
    assert.equal(bootSecrets['LEGACY_SECRET'], secretValues.LEGACY_SECRET);
  });

  it('unconsumed approval produces ephemeral lease and records zero-knowledge transaction to ledger', async () => {
    // 1. Create a run for secure-agent
    const runRes = await http_(cpPort, '/api/v1/agents/secure-agent/runs', 'POST', ADMIN);
    assert.equal(runRes.status, 202);
    const runId = runRes.body.runId;
    const runToken = await runTokens.mint({ runId, agentId: 'secure-agent' });

    // 2. Request approval via gateway / control-plane
    const turnId = 'turn-101';
    const proofHash = payloadHash({ secret: 'SECURE_VAULT_KEY', turn: turnId });
    const appReq = await http_(cpPort, '/api/v1/gateway/approvals', 'POST', GATEWAY, {
      runId,
      route: 'keymaster',
      tool: 'checkout:SECURE_VAULT_KEY',
      argsSha256: proofHash,
    });
    assert.equal(appReq.status, 201);
    const approvalId = appReq.body.approvalId;

    // 3. Human approver approves it
    const decideRes = await http_(cpPort, `/api/v1/approvals/${approvalId}`, 'POST', APPROVER, { decision: 'approve' });
    assert.equal(decideRes.status, 200);

    // 4. Agent checks out gated secret using Keymaster endpoint
    const checkoutRes = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId,
      gatedSecret: 'SECURE_VAULT_KEY',
      turnId,
      proofHash,
    });

    assert.equal(checkoutRes.status, 200);
    assert.equal(checkoutRes.body.secretName, 'SECURE_VAULT_KEY');
    assert.equal(checkoutRes.body.value, secretValues.SECURE_VAULT_KEY);
    assert.equal(checkoutRes.body.turnId, turnId);
    assert.ok(checkoutRes.body.leaseId.startsWith('lease_'));

    // 5. Verify ledger committed KEYMASTER_CHECKOUT event with zero-knowledge
    const checkoutEvents = ledger.query().filter((e) => e.action === 'KEYMASTER_CHECKOUT');
    assert.ok(checkoutEvents.length >= 1);
    const ev = checkoutEvents[checkoutEvents.length - 1];
    assert.equal(ev.agentId, 'secure-agent');
    assert.equal(ev.runId, runId);
    assert.equal(ev.approvalId, approvalId);
    assert.equal(ev.gatedSecret, 'SECURE_VAULT_KEY');
    assert.equal(ev.turnId, turnId);
    assert.equal(ev.payloadSha256, proofHash);
    assert.equal(ev.leaseId, checkoutRes.body.leaseId);

    // Zero knowledge: Raw secret plaintext is never in ledger
    assert.equal(JSON.stringify(ev).includes(secretValues.SECURE_VAULT_KEY), false);
  });

  it('burned/consumed approval immediately fails on replay', async () => {
    // 1. Create run
    const runRes = await http_(cpPort, '/api/v1/agents/secure-agent/runs', 'POST', ADMIN);
    const runId = runRes.body.runId;
    const runToken = await runTokens.mint({ runId, agentId: 'secure-agent' });

    // 2. Request and approve
    const appReq = await http_(cpPort, '/api/v1/gateway/approvals', 'POST', GATEWAY, {
      runId,
      route: 'keymaster',
      tool: 'checkout:SECURE_VAULT_KEY',
      argsSha256: 'proof-replay-1',
    });
    const approvalId = appReq.body.approvalId;
    await http_(cpPort, `/api/v1/approvals/${approvalId}`, 'POST', APPROVER, { decision: 'approve' });

    // 3. First checkout succeeds
    const firstCheckout = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId,
      gatedSecret: 'SECURE_VAULT_KEY',
      turnId: 'turn-1',
      proofHash: 'proof-replay-1',
    });
    assert.equal(firstCheckout.status, 200);

    // 4. Replay with the same burned approval: immediately fails with 409
    const replayCheckout = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId,
      gatedSecret: 'SECURE_VAULT_KEY',
      turnId: 'turn-2',
      proofHash: 'proof-replay-1',
    });
    assert.equal(replayCheckout.status, 409);
    assert.equal(replayCheckout.body.error, 'approval_already_consumed');

    // 5. Ledger has recorded denial
    const denials = ledger.query().filter((e) => e.action === 'KEYMASTER_CHECKOUT_DENIED' && e.approvalId === approvalId);
    assert.equal(denials.length, 1);
  });

  it('rejects forged approval, mismatched hash, or unapproved states', async () => {
    const runRes = await http_(cpPort, '/api/v1/agents/secure-agent/runs', 'POST', ADMIN);
    const runId = runRes.body.runId;
    const runToken = await runTokens.mint({ runId, agentId: 'secure-agent' });

    // 1. Non-existent approval
    const fakeRes = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId: 'forged-uuid-999',
      gatedSecret: 'SECURE_VAULT_KEY',
      turnId: 'turn-1',
    });
    assert.equal(fakeRes.status, 404);
    assert.equal(fakeRes.body.error, 'approval_not_found');

    // 2. Pending approval (not approved yet)
    const pendingReq = await http_(cpPort, '/api/v1/gateway/approvals', 'POST', GATEWAY, {
      runId,
      route: 'keymaster',
      tool: 'checkout:SECURE_VAULT_KEY',
      argsSha256: 'hash-pending',
    });
    const pendingAppId = pendingReq.body.approvalId;

    const pendingCheckout = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId: pendingAppId,
      gatedSecret: 'SECURE_VAULT_KEY',
      turnId: 'turn-1',
      proofHash: 'hash-pending',
    });
    assert.equal(pendingCheckout.status, 403);
    assert.equal(pendingCheckout.body.error, 'approval_pending');

    // 3. Rejected approval
    await http_(cpPort, `/api/v1/approvals/${pendingAppId}`, 'POST', APPROVER, { decision: 'reject' });
    const rejectedCheckout = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId: pendingAppId,
      gatedSecret: 'SECURE_VAULT_KEY',
      turnId: 'turn-1',
      proofHash: 'hash-pending',
    });
    assert.equal(rejectedCheckout.status, 403);
    assert.equal(rejectedCheckout.body.error, 'approval_rejected');

    // 4. Hash mismatch on approved approval
    const okReq = await http_(cpPort, '/api/v1/gateway/approvals', 'POST', GATEWAY, {
      runId,
      route: 'keymaster',
      tool: 'checkout:SECURE_VAULT_KEY',
      argsSha256: 'valid-hash-abc',
    });
    const okAppId = okReq.body.approvalId;
    await http_(cpPort, `/api/v1/approvals/${okAppId}`, 'POST', APPROVER, { decision: 'approve' });

    const mismatchCheckout = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId: okAppId,
      gatedSecret: 'SECURE_VAULT_KEY',
      turnId: 'turn-1',
      proofHash: 'tampered-hash-xyz',
    });
    assert.equal(mismatchCheckout.status, 403);
    assert.equal(mismatchCheckout.body.error, 'proof_hash_mismatch');
  });

  it('rejects checkout of secrets not declared as gated for the agent', async () => {
    const runRes = await http_(cpPort, '/api/v1/agents/secure-agent/runs', 'POST', ADMIN);
    const runId = runRes.body.runId;
    const runToken = await runTokens.mint({ runId, agentId: 'secure-agent' });

    const appReq = await http_(cpPort, '/api/v1/gateway/approvals', 'POST', GATEWAY, {
      runId,
      route: 'keymaster',
      tool: 'checkout:PUBLIC_TOKEN',
      argsSha256: 'hash-ungated',
    });
    const approvalId = appReq.body.approvalId;
    await http_(cpPort, `/api/v1/approvals/${approvalId}`, 'POST', APPROVER, { decision: 'approve' });

    // PUBLIC_TOKEN is ungated, not gated
    const res = await http_(cpPort, '/api/v1/keymaster/checkout', 'POST', runToken, {
      runId,
      approvalId,
      gatedSecret: 'PUBLIC_TOKEN',
      turnId: 'turn-1',
      proofHash: 'hash-ungated',
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'secret_not_gated');
  });
});
