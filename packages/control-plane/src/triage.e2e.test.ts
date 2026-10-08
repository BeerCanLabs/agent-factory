import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from './policy.js';

const VIEWER = 'viewer-triage-e2e';

describe('§6.5 /api/v1/triage: incidents derived from failed runs', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'viewer', token: VIEWER, roles: ['viewer'] }]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('triage-e2e-run-token-key-0123456789abcdef'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as FactoryState;
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
  });

  const get = async (token?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/triage`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json()) as Array<Record<string, string>> };
  };
  const run = (agentId: string, fields: Record<string, unknown>) =>
    state.runs.create({ agentId, actor: 'test', trigger: 'test', state: 'SUCCEEDED', ...fields } as never);

  it('needs the triage.read privilege', async () => {
    assert.equal((await get()).status, 401);
  });

  it('lists failed runs and runs with an error, in store order, with the severity, category and message the rule gives them', async () => {
    const fine = run('a-fine', {});
    const plain = run('a-plain', { state: 'FAILED' });
    const oom = run('a-oom', { state: 'FAILED', error: 'container OOM killed' });
    const slow = run('a-slow', { state: 'FAILED', error: 'run timeout after 600s' });
    const secret = run('a-secret', { state: 'BLOCKED', missing: ['GOOGLE_OAUTH_CLIENT'], error: 'missing secrets' });
    const emptyMissing = run('a-empty', { state: 'FAILED', missing: [], error: 'timeout' });
    const oomAndTimeout = run('a-both', { state: 'FAILED', error: 'OOM after timeout' });
    const errorButSucceeded = run('a-warn', { state: 'SUCCEEDED', error: 'exit 0 with a warning' });

    const { status, body } = await get(VIEWER);
    assert.equal(status, 200);
    const ours = body.filter((i) => i.agentId.startsWith('a-'));
    const inc = (r: { runId: string; updatedAt: string; agentId: string }, severity: string, category: string, message: string) => ({
      id: `inc-${r.runId.slice(0, 8)}`,
      timestamp: r.updatedAt,
      agentId: r.agentId,
      severity,
      category,
      message,
    });
    assert.deepEqual(ours, [
      inc(plain, 'ERROR', 'CRASH_LOOP', 'Run terminated with failure state'),
      inc(oom, 'CRITICAL', 'CRASH_LOOP', 'container OOM killed'),
      inc(slow, 'ERROR', 'TIMEOUT', 'run timeout after 600s'),
      inc(secret, 'ERROR', 'SECRET_MISSING', 'missing secrets'),
      // An empty `missing` list is still a list: GAP-108 records that this reads as a missing secret.
      inc(emptyMissing, 'ERROR', 'SECRET_MISSING', 'timeout'),
      inc(oomAndTimeout, 'CRITICAL', 'TIMEOUT', 'OOM after timeout'),
      inc(errorButSucceeded, 'ERROR', 'CRASH_LOOP', 'exit 0 with a warning'),
    ]);
    assert.ok(!ours.some((i) => i.agentId === fine.agentId));
  });

  it('falls back to startedAt when updatedAt is empty', async () => {
    const r = run('b-ts', { state: 'FAILED', startedAt: '2026-10-08T01:00:00.000Z' });
    (state.runs as unknown as { runs: Map<string, { updatedAt: string }> }).runs.get(r.runId)!.updatedAt = '';
    const mine = (await get(VIEWER)).body.find((i) => i.agentId === 'b-ts')!;
    assert.equal(mine.timestamp, '2026-10-08T01:00:00.000Z');
  });
});
