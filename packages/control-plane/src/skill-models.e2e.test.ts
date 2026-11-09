// Story #370 ([S24] Factory-side per-skill model binding, Epic #349): D31, D26, D23, E7, M2.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore, FileDocBackend, GrantStore, PrincipalStore } from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, GroupStore, SkillModelBindingStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { createGatekeeperEgress, SKILL_CONTEXT_HEADER, type ControlClient } from '@beercanlabs/factory-gatekeeper';
import { createFactoryServer, type FactoryState } from './app.js';
import { loadSkills, skillRegistry } from './skills.js';
import { setSkillModelStore, skillModelStore } from './skill-models.js';

const SHA = '5'.repeat(40);
const RUN_KEY = 's24-skill-models-run-token-key-0123456789abcdef'; // secret-scan:allow (test fixture)

const TOKENS = {
  admin: 'tok-s24-admin', // secret-scan:allow (test fixture)
  alice: 'tok-s24-alice', // secret-scan:allow (test fixture)
  bob: 'tok-s24-bob', // secret-scan:allow (test fixture)
  egress: 'tok-s24-egress', // secret-scan:allow (test fixture)
} as const;

const ACTORS: Record<string, { actor: string; roles: string[] }> = {
  [TOKENS.admin]: { actor: 'user:admin', roles: [] },
  [TOKENS.alice]: { actor: 'user:alice', roles: [] },
  [TOKENS.bob]: { actor: 'user:bob', roles: [] },
  [TOKENS.egress]: { actor: 'service:gatekeeper-egress', roles: ['operator', 'gatekeeper-egress'] },
};

function identityOnlyAuth(): AuthProvider {
  return {
    name: 's24-identity-only',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };
      const entry = ACTORS[authorization.slice('Bearer '.length).trim()];
      if (!entry) return { ok: false, reason: 'unknown token' };
      return { ok: true, principal: { actor: entry.actor, roles: entry.roles as never } };
    },
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as { port: number }).port;
}

describe('S24: factory-side per-skill model binding (#370)', { concurrency: false }, () => {
  let cp: http.Server;
  let gk: http.Server;
  let cpPort = 0;
  let gkPort = 0;
  let dir: string;
  let state: FactoryState;
  let ledger: MemoryLedger;
  const served: string[] = [];

  const call = async (method: string, path: string, body?: unknown, token: string = TOKENS.admin, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${cpPort}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const chat = async (token: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${gkPort}/models/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'summarize' }] }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cp-s24-'));
    ledger = new MemoryLedger();
    const principals = await PrincipalStore.open(new FileDocBackend(join(dir, 'principals')));
    const grants = await GrantStore.open(new FileDocBackend(join(dir, 'grants')), { principals });
    for (const [id, email] of [
      ['user:admin', 'admin@sackrider.org'],
      ['user:alice', 'alice@sackrider.org'],
      ['user:bob', 'bob@sackrider.org'],
    ] as const) {
      await principals.create({ id, displayName: id.slice(5), emails: [email], by: 'user:admin' });
    }
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });
    for (const v of ['user:alice', 'user:bob']) {
      await grants.grant({ subject: v, scope: { kind: 'fleet' }, role: 'viewer', by: 'user:admin', granterIsAdmin: true });
    }
    await grants.grant({ subject: 'user:alice', scope: { kind: 'skill', id: 'summarize-doc' }, role: 'content-owner', by: 'user:admin', granterIsAdmin: true });
    await grants.grant({ subject: 'user:bob', scope: { kind: 'skill', id: 'summarize-doc' }, role: 'member', by: 'user:admin', granterIsAdmin: true });

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger,
      auth: identityOnlyAuth(),
      principals,
      grants,
      groups: await GroupStore.open(join(dir, 'groups')),
      version: '0.1.0',
      providers: [envProvider({})],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens(RUN_KEY),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      resolveCommit: async () => SHA,
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
      modelCatalog: {
        'agent-model': { provider: 'fake', id: 'agent-model' },
        'claude-sonnet': { provider: 'fake', id: 'claude-sonnet' },
        'claude-haiku': { provider: 'fake', id: 'claude-haiku' },
        'alice-byom': {
          provider: 'xai-subscription',
          id: 'grok-4',
          credentialMode: 'subscription',
          scope: 'personal',
          ownerPrincipalId: 'user:alice',
          connection: 'sub_alice',
          price: { inputPerMTok: 0, outputPerMTok: 0 },
        },
      },
      defaultModel: 'agent-model',
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));
    setSkillModelStore(state, new SkillModelBindingStore(join(dir, 'skill-models.json')));

    const manifest = { id: 'summarize-doc', version: '1.0.0', name: 'summarize-doc', description: 'Summarize', language: 'python', entry: 'summarize_doc', requires: { routes: [] } };
    skillRegistry(state).save({
      id: 'summarize-doc',
      version: '1.0.0',
      repo: 'https://github.com/BeerCanLabs/summarize-doc',
      path: '.',
      commit: SHA,
      manifest,
      status: 'approved',
      tests: 'passed',
      registeredBy: 'user:alice',
      registeredAt: new Date().toISOString(),
      owner: 'user:alice',
    } as never);

    state.agents.set('friday', { id: 'friday', name: 'Friday', state: 'IDLE', kind: 'personal' } as never);
    state.policies.set('friday', {
      routes: ['models'],
      models: ['agent-model', 'claude-sonnet', 'claude-haiku'],
      currentModel: 'agent-model',
      budgetUsd: { perDay: 5, perMonth: 50 },
    } as never);
    await state.configs.put(
      { agentId: 'friday', source: {}, skills: [{ id: 'summarize-doc', version: '1.0.0' }] as never, policy: null },
      { updatedBy: 'user:admin', reason: 's24 fixture' },
    );

    cp = createFactoryServer(state);
    cpPort = await listen(cp);

    const control: ControlClient = {
      runContext: async (runId) => {
        const r = await call('GET', `/api/v1/gatekeeper-egress/runs/${runId}`, undefined, TOKENS.egress);
        return r.status === 200 ? r.body : null;
      },
      requestApproval: async () => {
        throw new Error('unused');
      },
      consumeApproval: async () => false,
      ledger: async () => {},
    };
    gk = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: state.runTokens!,
      control,
      providers: [],
      contextTtlMs: 0,
      modelCatalog: {
        'agent-model': { provider: 'fake', id: 'agent-model', price: { inputPerMTok: 1, outputPerMTok: 1 } },
        'claude-sonnet': { provider: 'fake', id: 'claude-sonnet', price: { inputPerMTok: 1, outputPerMTok: 1 } },
        'claude-haiku': { provider: 'fake', id: 'claude-haiku', price: { inputPerMTok: 1, outputPerMTok: 1 } },
        'alice-byom': {
          provider: 'fake',
          id: 'grok-4',
          credentialMode: 'subscription',
          scope: 'personal',
          ownerPrincipalId: 'user:alice',
          connection: 'sub_alice',
          price: { inputPerMTok: 0, outputPerMTok: 0 },
        },
      } as never,
      defaultModel: 'agent-model',
      modelAdapters: {
        fake: {
          async complete(e) {
            served.push(e.id);
            return { content: 'ok', finishReason: 'stop', usage: { input: 1, output: 1 } } as never;
          },
        },
      },
    });
    gkPort = await listen(gk);
  });

  after(async () => {
    for (const s of [gk, cp]) await new Promise<void>((r) => s.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('PUT/GET is guarded: the skill content-owner and admin may bind; another person may not', async () => {
    assert.equal((await call('GET', '/api/v1/skills/summarize-doc/model', undefined, TOKENS.alice)).body.binding, null);
    // Bob holds a skill `member` grant (which carries skills.version.add) but is not the content-owner (D31).
    const denied = await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 'claude-haiku' }, TOKENS.bob);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.requiredRole, 'content-owner');
    assert.equal(skillModelStore(state).get('summarize-doc'), undefined);
    assert.equal((await call('PUT', '/api/v1/skills/missing-skill/model', { model: 'claude-haiku' }, TOKENS.admin)).status, 404);
    assert.equal((await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 'not-offered' }, TOKENS.alice)).status, 422);
    assert.equal((await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 7 }, TOKENS.alice)).status, 400);
  });

  it('AC1: owner binds claude-sonnet, calling agent resolves to it, then a swap is served live without a manifest or agent change', async () => {
    const bound = await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 'claude-sonnet' }, TOKENS.alice);
    assert.equal(bound.status, 200, JSON.stringify(bound.body));
    assert.equal(bound.body.binding.model, 'claude-sonnet');
    assert.equal(bound.body.binding.setBy, 'user:alice');
    const got = await call('GET', '/api/v1/skills/summarize-doc/model', undefined, TOKENS.alice);
    assert.equal(got.body.binding.model, 'claude-sonnet');

    const manifestBefore = JSON.stringify(skillRegistry(state).get('summarize-doc', '1.0.0')!.manifest);
    const policyBefore = JSON.stringify(state.policies.get('friday'));
    const configVersionBefore = state.configs!.current('friday')!.version;

    const run = state.runs.create({ agentId: 'friday', state: 'WORKING', actor: 'user:alice', trigger: 'manual' } as never);
    const token = await state.runTokens!.mint({ runId: run.runId, agentId: 'friday' });

    const ctxRes = await call('GET', `/api/v1/gatekeeper-egress/runs/${run.runId}`, undefined, TOKENS.egress);
    assert.deepEqual(ctxRes.body.skillModels, { 'summarize-doc': 'claude-sonnet' });

    const first = await chat(token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.model, 'claude-sonnet');
    const agentOwn = await chat(token);
    assert.equal(agentOwn.body.model, 'agent-model');

    // Admin swaps (also allowed), and the next call on the same live run gets the new model.
    const swapped = await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 'claude-haiku' }, TOKENS.admin);
    assert.equal(swapped.status, 200, JSON.stringify(swapped.body));
    assert.equal(swapped.body.previous, 'claude-sonnet');
    const second = await chat(token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' });
    assert.equal(second.body.model, 'claude-haiku');

    assert.equal(JSON.stringify(skillRegistry(state).get('summarize-doc', '1.0.0')!.manifest), manifestBefore);
    assert.equal(JSON.stringify(state.policies.get('friday')), policyBefore);
    assert.equal(state.configs!.current('friday')!.version, configVersionBefore);
    assert.deepEqual(served, ['claude-sonnet', 'agent-model', 'claude-haiku']);

    const events = ledger.query({}).filter((e) => e.action === 'SKILL_MODEL_BOUND');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => e.model), ['claude-sonnet', 'claude-haiku']);
    assert.deepEqual(events.map((e) => e.actor), ['user:alice', 'user:admin']);
  });

  it('clearing the binding returns skill calls to the agent model and is ledgered', async () => {
    const cleared = await call('PUT', '/api/v1/skills/summarize-doc/model', { model: null }, TOKENS.alice);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.binding, null);
    assert.equal(ledger.query({}).filter((e) => e.action === 'SKILL_MODEL_CLEARED').length, 1);
    const run = state.runs.create({ agentId: 'friday', state: 'WORKING', actor: 'user:alice', trigger: 'manual' } as never);
    const token = await state.runTokens!.mint({ runId: run.runId, agentId: 'friday' });
    const res = await chat(token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' });
    assert.equal(res.body.model, 'agent-model');
  });

  it('bindings persist across a store reopen', async () => {
    await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 'claude-sonnet' }, TOKENS.alice);
    const reopened = new SkillModelBindingStore(join(dir, 'skill-models.json'));
    assert.equal(reopened.get('summarize-doc')?.model, 'claude-sonnet');
  });

  it('M5(1) / S24: refuses binding a personal BYOM entry to a skill (even by owner or admin) and refuses stale skill bindings at egress', async () => {
    for (const tok of [TOKENS.alice, TOKENS.admin]) {
      const denied = await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 'alice-byom' }, tok);
      assert.equal(denied.status, 403, JSON.stringify(denied.body));
      assert.equal(denied.body.error, 'personal_model_skill_forbidden');
    }

    // Even if a stale binding existed in the store, gatekeeper-egress refuses personal BYOM on skill context at call time.
    skillModelStore(state).set('summarize-doc', 'alice-byom', 'user:alice');
    const run = state.runs.create({ agentId: 'friday', state: 'WORKING', actor: 'user:alice', trigger: 'manual' } as never);
    const token = await state.runTokens!.mint({ runId: run.runId, agentId: 'friday' });
    const res = await chat(token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, 'personal_model_skill_forbidden');
    await call('PUT', '/api/v1/skills/summarize-doc/model', { model: 'claude-sonnet' }, TOKENS.alice);
  });
});
