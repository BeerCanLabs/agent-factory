import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ApprovalStore, type HeldRequest } from './index.js';

const key = { runId: 'r1', agentId: 'a1', route: 'mcp', tool: 'send', argsSha256: 'h1' };
const heldRequest: HeldRequest = { method: 'POST', path: '/v1/post', headers: {}, body: '{}', bodyEncoding: 'utf8' };
const heldKey = { ...key, route: 'linkedin', tool: 'held', request: heldRequest };

describe('ApprovalStore.request', () => {
  it('is idempotent per run, route, tool and args hash while pending or approved', () => {
    const s = new ApprovalStore();
    const first = s.request(key);
    assert.equal(first.created, true);
    assert.equal(s.request(key).created, false);
    assert.equal(s.request(key).approval.approvalId, first.approval.approvalId);
    s.decide(first.approval.approvalId, 'approved', 'alice');
    assert.equal(s.request(key).approval.approvalId, first.approval.approvalId);
  });

  it('creates a new approval once the earlier one was consumed', () => {
    const s = new ApprovalStore();
    const first = s.request(key).approval;
    s.decide(first.approvalId, 'approved', 'alice');
    s.consume(first.approvalId);
    const next = s.request(key);
    assert.equal(next.created, true);
    assert.notEqual(next.approval.approvalId, first.approvalId);
  });
});

describe('ApprovalStore.hold', () => {
  it('returns the open hold for the same agent, route and hash', () => {
    const s = new ApprovalStore();
    const first = s.hold(heldKey);
    assert.equal(first.created, true);
    assert.equal(first.approval.kind, 'held');
    const again = s.hold({ ...heldKey, runId: 'r2' });
    assert.equal(again.created, false);
    assert.equal(again.approval.approvalId, first.approval.approvalId);
  });

  it('returns the rejected hold so an identical request is refused, not asked again', () => {
    const s = new ApprovalStore();
    const first = s.hold(heldKey).approval;
    s.decide(first.approvalId, 'rejected', 'alice', 'no');
    const again = s.hold(heldKey);
    assert.equal(again.created, false);
    assert.equal(again.approval.state, 'rejected');
  });

  it('creates a new hold once the last was consumed', () => {
    const s = new ApprovalStore();
    const first = s.hold(heldKey).approval;
    s.decide(first.approvalId, 'approved', 'alice');
    s.consume(first.approvalId);
    const next = s.hold(heldKey);
    assert.equal(next.created, true);
    assert.notEqual(next.approval.approvalId, first.approvalId);
  });
});

describe('ApprovalStore.decide and consume', () => {
  it('decides only a pending approval and records who, when and the notes', () => {
    const s = new ApprovalStore();
    const a = s.request(key).approval;
    const d = s.decide(a.approvalId, 'approved', 'alice', 'ok');
    assert.equal(d?.state, 'approved');
    assert.equal(d?.decidedBy, 'alice');
    assert.equal(d?.notes, 'ok');
    assert.ok(d?.decidedAt);
    assert.equal(s.decide(a.approvalId, 'rejected', 'bob'), undefined);
    assert.equal(s.decide('nope', 'approved', 'alice'), undefined);
  });

  it('consumes only an approved approval', () => {
    const s = new ApprovalStore();
    const a = s.request(key).approval;
    assert.equal(s.consume(a.approvalId), undefined);
    s.decide(a.approvalId, 'approved', 'alice');
    assert.equal(s.consume(a.approvalId)?.state, 'consumed');
    assert.equal(s.consume(a.approvalId), undefined);
  });
});

describe('ApprovalStore persistence and list', () => {
  it('a second store on the same directory sees every saved approval', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bouncer-'));
    try {
      const s = new ApprovalStore(dir);
      const a = s.request(key).approval;
      const h = s.hold(heldKey).approval;
      s.decide(a.approvalId, 'approved', 'alice');
      const s2 = new ApprovalStore(dir);
      assert.equal(s2.get(a.approvalId)?.state, 'approved');
      assert.equal(s2.get(h.approvalId)?.kind, 'held');
      assert.equal(s2.list().length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('filters by state and by run', () => {
    const s = new ApprovalStore();
    const a = s.request(key).approval;
    s.request({ ...key, runId: 'r2' });
    s.decide(a.approvalId, 'approved', 'alice');
    assert.equal(s.list().length, 2);
    assert.deepEqual(s.list({ state: 'approved' }).map((x) => x.approvalId), [a.approvalId]);
    assert.equal(s.list({ state: 'pending' }).length, 1);
    assert.deepEqual(s.list({ runId: 'r2' }).map((x) => x.runId), ['r2']);
  });
});

describe('ApprovalStore configuration changes (CF4)', () => {
  const change = { type: 'role-assignment' as const, provider: 'discord', identity: '1', roles: ['Family'] };
  it('an approved change cannot be burned as a tool or secret approval; only the factory uses it up', () => {
    const s = new ApprovalStore();
    const { approval } = s.requestChange({ runId: 'r', agentId: 'a', change, ttlMs: 60_000 }) as { approval: { approvalId: string } };
    s.decide(approval.approvalId, 'approved', 'owner');
    assert.equal(s.consume(approval.approvalId), undefined, 'the Keymaster and the egress cannot spend it');
    assert.equal(s.get(approval.approvalId)!.state, 'approved');
    assert.equal(s.consumeChange(approval.approvalId)!.state, 'consumed');
    assert.equal(s.consumeChange(approval.approvalId), undefined, 'once');
  });

  it('a tool approval cannot be used up as a change', () => {
    const s = new ApprovalStore();
    const a = s.request({ runId: 'r', agentId: 'a', route: 'x', tool: 't', argsSha256: 'h' });
    s.decide(a.approvalId, 'approved', 'owner');
    assert.equal(s.consumeChange(a.approvalId), undefined);
  });

  it('an identical request from another agent is a different request', () => {
    const s = new ApprovalStore();
    const one = s.requestChange({ runId: 'r1', agentId: 'a', change, ttlMs: 60_000 }) as { approval: { approvalId: string } };
    const two = s.requestChange({ runId: 'r2', agentId: 'b', change, ttlMs: 60_000 }) as { approval: { approvalId: string }; created: boolean };
    assert.equal(two.created, true);
    assert.notEqual(two.approval.approvalId, one.approval.approvalId);
  });

  it('refuses a new request at the cap and answers an identical one', () => {
    const s = new ApprovalStore();
    const first = s.requestChange({ runId: 'r', agentId: 'a', change, ttlMs: 60_000, maxPending: 1 }) as { approval: { approvalId: string } };
    assert.deepEqual(s.requestChange({ runId: 'r', agentId: 'a', change: { ...change, identity: '2' }, ttlMs: 60_000, maxPending: 1 }), { limited: true });
    const same = s.requestChange({ runId: 'r', agentId: 'a', change, ttlMs: 60_000, maxPending: 1 }) as { approval: { approvalId: string }; created: boolean };
    assert.equal(same.created, false);
    assert.equal(same.approval.approvalId, first.approval.approvalId);
  });
});
