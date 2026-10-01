// TSK-048: the factory owns policy. What an admin needs to set it: the agent's declared egress and preferred model
// (requests, never grants: E7, E8, M2) and the models this factory offers (M3).
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

const ADMIN = 'admin-policy-token';
const VIEWER = 'viewer-policy-token';

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

describe('E7 M3 the factory owns policy; the agent only declares (TSK-048)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let regDir: string;
  let state: FactoryState;

  before(async () => {
    regDir = mkdtempSync(join(tmpdir(), 'cp-policy-editor-'));
    state = {
      agents: new Map(),
      registryDir: regDir,
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
      resolveCommit: async () => '0'.repeat(40),
      modelCatalog: {
        'claude-haiku-4-5': { provider: 'bedrock', price: { inputPerMTok: 1, outputPerMTok: 5 } },
        'claude-sonnet-4-5': { provider: 'bedrock' },
      },
    };
    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(() => {
    cp.close();
    rmSync(regDir, { recursive: true, force: true });
  });

  it('registration records the declared egress and preferred models and grants nothing (E7)', async () => {
    const reg = await call(port, '/api/v1/registry/agents', 'POST', ADMIN, {
      repo: 'https://github.com/beercanlabs/SM-ada',
      cartridge: {
        id: 'ada',
        name: 'Ada',
        model: 'claude-sonnet-4-5',
        models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
        egress: { routes: ['models', 'discord', 'notion'], hosts: ['api.example.com'] },
      },
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));

    const agent = await call(port, '/api/v1/registry/agents/ada', 'GET', VIEWER);
    assert.deepEqual(agent.body.egress, { routes: ['models', 'discord', 'notion'], hosts: ['api.example.com'] });
    assert.equal(agent.body.model, 'claude-sonnet-4-5');
    assert.deepEqual(agent.body.requestedModels, ['claude-sonnet-4-5', 'claude-haiku-4-5']);
    assert.equal(state.policies.has('ada'), false, 'a declaration is a request, never a grant');
  });

  it('lists the offered models to a viewer without provider model ids (M3)', async () => {
    const res = await call(port, '/api/v1/models', 'GET', VIEWER);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.models, [
      { name: 'claude-haiku-4-5', provider: 'bedrock', price: { inputPerMTok: 1, outputPerMTok: 5 } },
      { name: 'claude-sonnet-4-5', provider: 'bedrock' },
    ]);
    assert.equal((await call(port, '/api/v1/models', 'GET')).status, 401);
  });

  it('only an admin sets policy, and re-registering keeps it (E7)', async () => {
    const policy = { routes: ['models', 'discord'], models: ['claude-haiku-4-5'], budgetUsd: { perDay: 5, perMonth: 50 } };
    assert.equal((await call(port, '/api/v1/agents/ada/policy', 'PUT', VIEWER, policy)).status, 403);
    assert.equal((await call(port, '/api/v1/agents/ada/policy', 'PUT', ADMIN, policy)).status, 200);

    await call(port, '/api/v1/registry/agents', 'POST', ADMIN, {
      repo: 'https://github.com/beercanlabs/SM-ada',
      cartridge: { id: 'ada', name: 'Ada', model: 'claude-sonnet-4-5', egress: { routes: ['models', 'discord', 'notion', 'github'] } },
    });
    const after = await call(port, '/api/v1/agents/ada/policy', 'GET', VIEWER);
    assert.deepEqual(after.body, policy, 'a new declaration never changes what the company granted');
    assert.deepEqual((await call(port, '/api/v1/registry/agents/ada', 'GET', VIEWER)).body.egress.routes, ['models', 'discord', 'notion', 'github']);
  });
});
