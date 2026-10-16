// GAP-160: a skill's training account is separate from every agent's budget.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { loadSkills } from './skills.js';

const ADMIN = 'admin-training-token';
const VIEWER = 'viewer-training-token';
const SHA = 'c'.repeat(40);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

async function call(port: number, path: string, method = 'GET', token?: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('skill training account', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let dataDir: string;
  let state: FactoryState;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'cp-training-'));
    state = {
      agents: new Map(),
      registryDir: join(dataDir, 'registry'),
      ledger: new MemoryLedger(),
      auth: bearerAuth([
        { name: 'admin', token: ADMIN, roles: ['admin'] },
        { name: 'viewer', token: VIEWER, roles: ['viewer'] },
      ]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      gatekeeperEgressHeldSecrets: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      callbacks: { allowHosts: [] } as unknown as FactoryState['callbacks'],
      runTokens: { issue: async () => '', verify: async () => undefined } as unknown as FactoryState['runTokens'],
      secretValues: new Set(),
    } as FactoryState;
    loadSkills(state, join(dataDir, 'skills'));
    cp = createFactoryServer(state);
    port = await listen(cp);
    const reg = await call(port, '/api/v1/registry/skills', 'POST', ADMIN, {
      repo: 'https://github.com/BeerCanLabs/skill-summarize',
      path: '.',
      commit: SHA,
      manifest: {
        id: 'summarize',
        version: '1.0.0',
        name: 'Summarize',
        description: 'Summarize a note.',
        language: 'python',
        entry: 'skill.py',
        visibility: 'public',
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
  });

  after(() => {
    cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('charges the skill and leaves the agent spend at zero', async () => {
    const denied = await call(port, '/api/v1/skills/summarize/training-account', 'PUT', VIEWER, { capUsd: 5 });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    const open = await call(port, '/api/v1/skills/summarize/training-account', 'PUT', ADMIN, { capUsd: 1 });
    assert.equal(open.status, 200, JSON.stringify(open.body));

    const noBaseline = await call(port, '/api/v1/skills/summarize/training-runs', 'POST', ADMIN, {
      model: 'small',
      costUsd: 0.1,
      outputs: [],
    });
    assert.equal(noBaseline.status, 409);

    const baseline = await call(port, '/api/v1/skills/summarize/training-baseline', 'PUT', ADMIN, {
      cases: [{ name: 'short', input: 'a long note', contains: 'brief' }],
    });
    assert.equal(baseline.status, 200, JSON.stringify(baseline.body));

    const cheap = await call(port, '/api/v1/skills/summarize/training-runs', 'POST', ADMIN, {
      model: 'small',
      costUsd: 0.2,
      outputs: [{ name: 'short', output: 'a brief note' }],
    });
    assert.equal(cheap.status, 200, JSON.stringify(cheap.body));
    assert.equal(cheap.body.passed, 1);
    assert.equal(cheap.body.failed, 0);

    const pricey = await call(port, '/api/v1/skills/summarize/training-runs', 'POST', ADMIN, {
      model: 'large',
      costUsd: 0.9,
      outputs: [{ name: 'short', output: 'a brief note' }],
    });
    assert.equal(pricey.status, 402);

    const winner = await call(port, '/api/v1/skills/summarize/training-recommendation', 'POST', ADMIN, {});
    assert.equal(winner.status, 200, JSON.stringify(winner.body));
    assert.equal(winner.body.recommendation.model, 'small');
    assert.equal(winner.body.adopted, false);

    const hidden = await call(port, '/api/v1/skills/summarize/training', 'GET', VIEWER);
    assert.equal(hidden.status, 403);
    const view = await call(port, '/api/v1/skills/summarize/training', 'GET', ADMIN);
    assert.equal(view.status, 200);
    assert.equal(view.body.baseline[0].input, undefined);
    assert.equal(JSON.stringify(view.body).includes('long note'), false);

    assert.equal(state.spend.get('summarize', undefined).day, 0);
    const actions = state.ledger.query().map((e) => e.action);
    assert.ok(actions.includes('TRAINING_CAP_SET'));
    assert.ok(actions.includes('TRAINING_RECOMMENDED'));
    const runRow = state.ledger.query().find((e) => String(e.action).startsWith('TRAINING_RUN'));
    const baselineRow = state.ledger.query().find((e) => e.action === 'TRAINING_BASELINE_SET');
    assert.equal(runRow?.payloadSha256, baselineRow?.payloadSha256);
    assert.equal(runRow?.payloadSha256?.length, 64);
    assert.equal(actions.some((a) => String(a).includes('long note')), false);
  });
});
