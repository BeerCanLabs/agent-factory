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
