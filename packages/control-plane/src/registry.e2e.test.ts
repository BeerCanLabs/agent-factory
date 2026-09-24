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
import { noopRuntime } from './runtime.js';
import { MemoryRunStore } from './runs.js';
import { ApprovalStore, PolicyStore, SpendTracker } from './policy.js';
import { Keymaster } from '@beercanlabs/factory-keymaster';

const ADMIN = 'admin-e2e-token';

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

describe('KPF 1: Agent Registry & Lifecycle E2E', { concurrency: false }, () => {
  let cp: http.Server;
  let cpPort = 0;
  let regDir: string;
  let state: FactoryState;

  before(async () => {
    regDir = mkdtempSync(join(tmpdir(), 'cp-registry-test-'));
    const ledger = new MemoryLedger();
    const runtime = noopRuntime();
    const approvals = new ApprovalStore();
    const keymaster = new Keymaster(approvals, ledger, {
      resolveSecret: async (name) => `secret-val-for-${name}`,
    });

    state = {
      agents: new Map(),
      registryDir: regDir,
      ledger,
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime,
      runs: new MemoryRunStore(),
      approvals,
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      keymaster,
    };

    cp = createFactoryServer(state);
    cpPort = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(regDir, { recursive: true, force: true });
  });

  it('executes full agent lifecycle: register -> pending_budget -> budget -> pending_deploy -> retire -> reinstate -> purge', async () => {
    // 1. Register new agent
    const regRes = await http_(cpPort, '/api/v1/registry/agents', 'POST', ADMIN, {
      id: 'sm-builder-test',
      name: 'Builder Test Agent',
      role: 'Test Assistant',
      repo: 'https://github.com/beercanlabs/SM-builder-test',
      secrets: ['OPENAI_API_KEY'],
    });
    assert.equal(regRes.status, 201);
    assert.equal(regRes.body.id, 'sm-builder-test');
    assert.equal(regRes.body.state, 'PENDING_BUDGET');

    // 2. Query state via GET /api/v1/registry/agents/:id
    const getRes = await http_(cpPort, '/api/v1/registry/agents/sm-builder-test', 'GET', ADMIN);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.id, 'sm-builder-test');
    assert.equal(getRes.body.state, 'PENDING_BUDGET');

    // 3. Assign budget via PUT /api/v1/registry/agents/:id/budget -> transitions to PENDING_DEPLOY
    const budgetRes = await http_(cpPort, '/api/v1/registry/agents/sm-builder-test/budget', 'PUT', ADMIN, {
      routes: ['openai'],
      budgetUsd: { perDay: 15.0 },
    });
    assert.equal(budgetRes.status, 200);
    assert.equal(budgetRes.body.state, 'PENDING_DEPLOY');

    // Verify state updated
    const afterBudget = await http_(cpPort, '/api/v1/registry/agents/sm-builder-test', 'GET', ADMIN);
    assert.equal(afterBudget.body.state, 'PENDING_DEPLOY');

    // 4. Manually set to SLEEPING to test retirement lifecycle (as deployment requires cloud provider)
    state.agents.get('sm-builder-test')!.state = 'SLEEPING';

    // 5. Soft-Retire -> transitions to RETIRED_PENDING_PURGE with scream-test timestamps
    const retireRes = await http_(cpPort, '/api/v1/registry/agents/sm-builder-test/retire', 'POST', ADMIN);
    assert.equal(retireRes.status, 200);
    assert.equal(retireRes.body.state, 'RETIRED_PENDING_PURGE');
    assert.ok(retireRes.body.retiredAt);
    assert.ok(retireRes.body.purgeDueAt);

    // 6. Reinstate -> cancels scream test, restores to SLEEPING
    const reinstateRes = await http_(cpPort, '/api/v1/registry/agents/sm-builder-test/reinstate', 'POST', ADMIN);
    assert.equal(reinstateRes.status, 200);
    assert.equal(reinstateRes.body.state, 'SLEEPING');
    assert.equal(reinstateRes.body.retiredAt, undefined);
    assert.equal(reinstateRes.body.purgeDueAt, undefined);

    // 7. Retire again and Purge -> permanently deletes agent
    await http_(cpPort, '/api/v1/registry/agents/sm-builder-test/retire', 'POST', ADMIN);
    const purgeRes = await http_(cpPort, '/api/v1/registry/agents/sm-builder-test/purge', 'POST', ADMIN);
    assert.equal(purgeRes.status, 200);
    assert.equal(purgeRes.body.ok, true);
    assert.equal(purgeRes.body.id, 'sm-builder-test');

    // 8. Confirm 404 after purge
    const afterPurge = await http_(cpPort, '/api/v1/registry/agents/sm-builder-test', 'GET', ADMIN);
    assert.equal(afterPurge.status, 404);

    // 9. Verify immutable ledger recorded all lifecycle transitions
    const ledgerEvents = state.ledger.query().filter((e) => e.agentId === 'sm-builder-test');
    const actions = ledgerEvents.map((e) => (e as { action?: string }).action);
    assert.ok(actions.includes('AGENT_REGISTERED'));
    assert.ok(actions.includes('BUDGET_APPROVED'));
    assert.ok(actions.includes('AGENT_RETIRED_PENDING_PURGE'));
    assert.ok(actions.includes('AGENT_REINSTATED'));
    assert.ok(actions.includes('AGENT_PURGED'));
  });

  it('governs model approval and active model switching', async () => {
    // 1. Register agent with requestedModels and default approvedModel
    const regRes = await http_(cpPort, '/api/v1/registry/agents', 'POST', ADMIN, {
      id: 'sm-model-test',
      name: 'Model Test Agent',
      model: 'claude-3-5-sonnet',
      requestedModels: ['claude-3-5-sonnet', 'gemini-2.0-flash'],
      approvedModels: ['claude-3-5-sonnet'],
    });
    assert.equal(regRes.status, 201);
    assert.equal(regRes.body.model, 'claude-3-5-sonnet');
    assert.deepEqual(regRes.body.approvedModels, ['claude-3-5-sonnet']);
    assert.deepEqual(regRes.body.requestedModels, ['claude-3-5-sonnet', 'gemini-2.0-flash']);

    // 2. Attempt to switch to an unapproved model -> fails 400
    const failSwitch = await http_(cpPort, '/api/v1/registry/agents/sm-model-test/model', 'POST', ADMIN, {
      model: 'gemini-2.0-flash',
    });
    assert.equal(failSwitch.status, 400);
    assert.equal(failSwitch.body.error, 'model_not_approved');

    // 3. Approve model (e.g. following Gym training results) -> succeeds
    const approveRes = await http_(cpPort, '/api/v1/registry/agents/sm-model-test/models/approve', 'POST', ADMIN, {
      model: 'gemini-2.0-flash',
    });
    assert.equal(approveRes.status, 200);
    assert.ok(approveRes.body.approvedModels.includes('gemini-2.0-flash'));

    // 4. Verify policy store was updated with approved model
    const policy = state.policies.get('sm-model-test');
    assert.ok(policy.models?.includes('gemini-2.0-flash'));

    // 5. Now switch active model to newly approved model -> succeeds
    const successSwitch = await http_(cpPort, '/api/v1/registry/agents/sm-model-test/model', 'POST', ADMIN, {
      model: 'gemini-2.0-flash',
    });
    assert.equal(successSwitch.status, 200);
    assert.equal(successSwitch.body.activeModel, 'gemini-2.0-flash');

    // 6. Confirm agent record has active model updated
    const afterSwitch = await http_(cpPort, '/api/v1/registry/agents/sm-model-test', 'GET', ADMIN);
    assert.equal(afterSwitch.body.model, 'gemini-2.0-flash');

    // 7. Verify ledger recorded MODEL_APPROVED and MODEL_SWITCHED
    const ledgerEvents = state.ledger.query().filter((e) => e.agentId === 'sm-model-test');
    const actions = ledgerEvents.map((e) => (e as { action?: string }).action);
    assert.ok(actions.includes('MODEL_APPROVED'));
    assert.ok(actions.includes('MODEL_SWITCHED'));
  });
});
