import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign as rsaSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { RunTokens, cloudflareAccessAuth, type AuthProvider } from '@beercanlabs/factory-auth';
import { SpendTracker } from '@beercanlabs/factory-budget';
import {
  ApiKeyStore,
  ApprovalStore,
  FileDocBackend,
  GrantStore,
  PrincipalStore,
  SpeakAsGrantStore,
  type GrantsDoc,
  type PrincipalsDoc,
  type SpeakAsDoc,
} from '@beercanlabs/factory-bouncer';
import { FileConfigBackend, GroupStore, VersionedConfigStore } from '@beercanlabs/factory-registrar';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import { createFactoryServer, type FactoryState } from './app.js';
import { IdpConfigStore } from './idp-config.js';
import { IdentityLinkStore } from './identity-links.js';
import { loadSkills } from './skills.js';

const TEAM = 'speak-as.example.cloudflareaccess.com';
const AUD = 'speak-as-aud';
const SHA = '9'.repeat(40);
const RUNTIME_SHA = 'c'.repeat(40);
const IMAGE = 'registry.example/factory-agent-runtime:speak-as';
const RUN_KEY = 'speak-as-run-token-key-0123456789abcdef'; // secret-scan:allow (test fixture)

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 's3-k1', alg: 'RS256', use: 'sig' };
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

function cfAssertion(email: string, extra: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 's3-k1' })}.${b64({
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: now,
    exp: now + 300,
    email,
    email_verified: true,
    ...extra,
  })}`;
  return `${input}.${rsaSign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
}

const TOKENS = {
  admin: 'tok-speak-as-admin', // secret-scan:allow (test fixture)
} as const;

function identityOnlyBearer(): AuthProvider {
  return {
    name: 'speak-as-identity',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer' };
      const tok = authorization.slice('Bearer '.length).trim();
      if (tok === TOKENS.admin) return { ok: true, principal: { actor: 'user:admin', roles: [] } };
      return { ok: false, reason: 'unknown token' };
    },
  };
}

describe('speak-as grants, speaker field, discovery, and delivered caller', { concurrency: false }, () => {
  let cp: http.Server;
  let dir: string;
  let state: FactoryState;
  let port = 0;
  let rosieKey: string;
  let grantId: string;

  const call = async (
    method: string,
    path: string,
    opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: opts.body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body: body as any };
  };

  const mcpAgent = async (agentId: string, method: string, params: unknown, token: string) => {
    const res = await call('POST', `/mcp/agents/${encodeURIComponent(agentId)}`, {
      token,
      body: { jsonrpc: '2.0', id: 1, method, params },
    });
    return { status: res.status, rpc: res.body as Record<string, any> };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'speak-as-'));
    const principals = await PrincipalStore.open(new FileDocBackend<PrincipalsDoc>(join(dir, 'auth', 'principals.json')));
    const groups = await GroupStore.open(join(dir, 'groups'));
    const grants = await GrantStore.open(new FileDocBackend<GrantsDoc>(join(dir, 'auth', 'grants.json')), {
      principals,
      knownGroups: (gid) => Boolean(groups.getGroup(gid)),
    });
    await principals.create({ id: 'user:admin', displayName: 'Admin', emails: ['admin@beercanlabs.com'], by: 'user:admin' });
    await principals.create({ id: 'user:dale.sackrider', displayName: 'Dale', emails: ['dale@example.com'], by: 'user:admin' });
    await grants.grant({ subject: 'user:admin', scope: { kind: 'fleet' }, role: 'admin', by: 'user:admin', granterIsAdmin: true });

    const access = cloudflareAccessAuth({
      teamDomain: TEAM,
      audience: AUD,
      identityOnly: true,
      fetchJwks: async () => ({ keys: [jwk] }),
    });

    state = {
      agents: new Map(),
      registryDir: join(dir, 'registry'),
      ledger: new MemoryLedger(),
      auth: identityOnlyBearer(),
      access,
      principals,
      grants,
      groups,
      speakAs: await SpeakAsGrantStore.open(new FileDocBackend<SpeakAsDoc>(join(dir, 'auth', 'speak-as.json'))),
      identityLinks: new IdentityLinkStore(join(dir, 'links')),
      schedules: new ScheduleStore(),
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
        'gemini-2.0-flash': { provider: 'google', url: 'https://models.example/v1' } as never,
      },
      defaultModel: 'gemini-2.0-flash',
      sharedRuntime: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: RUNTIME_SHA, image: IMAGE },
      deployProvider: {
        buildImage: async (agentId: string, source: { commit: string }) => `registry.example/${agentId}:${source.commit}`,
        provisionIdentity: async (agentId: string) => ({ identity: `role/${agentId}`, executionIdentity: `exec/${agentId}` }),
        registerCompute: async () => {},
      },
    } as unknown as FactoryState;

    state.keys = await ApiKeyStore.open();
    state.idpConfig = await IdpConfigStore.open();
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    loadSkills(state, join(dir, 'skills'));

    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;

    for (const spec of [
      { id: 'rosie', name: 'Rosie', role: 'Household companion' },
      { id: 'donna', name: 'Donna', role: 'Executive Assistant & Orchestrator' },
      { id: 'higgins', name: 'Higgins', role: 'Butler and household help' },
    ]) {
      const created = await call('POST', '/api/v1/agents', {
        token: TOKENS.admin,
        body: {
          id: spec.id,
          name: spec.name,
          role: spec.role,
          kind: 'team',
          accountableLead: 'user:admin',
          soul: `${spec.name} is helpful.`,
          memory: { archetype: 'team-member' },
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      state.policies.set(spec.id, { models: ['gemini-2.0-flash'], budgetUsd: { perDay: 10, perMonth: 100 } } as never);
    }

    const missing = await call('POST', '/api/v1/keys', {
      token: TOKENS.admin,
      body: { owner: 'agent:no-such-agent', roles: ['operator'], scopes: { privileges: ['agents.converse'] } },
    });
    assert.equal(missing.status, 400, JSON.stringify(missing.body));
    assert.equal(missing.body.error, 'unknown_agent');

    const minted = await call('POST', '/api/v1/keys', {
      token: TOKENS.admin,
      body: {
        owner: 'agent:rosie',
        roles: ['operator'],
        scopes: { privileges: ['agents.converse', 'mcp.use', 'agents.read'] },
        expiresAt: null,
      },
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    assert.equal(minted.body.key.owner, 'agent:rosie');
    rosieKey = minted.body.secret;

    const grant = await call('POST', '/api/v1/speak-as-grants', {
      token: TOKENS.admin,
      body: {
        client: 'agent:rosie',
        purpose: 'household voice and errands',
        expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
        members: [{ principalId: 'user:dale.sackrider', aliases: ['dale'], relationship: 'owner' }],
      },
    });
    assert.equal(grant.status, 201, JSON.stringify(grant.body));
    grantId = grant.body.grant.id;
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a new conversation without speaker, and unknown or disallowed speakers, with the documented error shape', async () => {
    const none = await call('POST', '/api/v1/agents/donna/conversation', { token: rosieKey, body: { input: 'hi' } });
    assert.equal(none.status, 400, JSON.stringify(none.body));
    assert.equal(none.body.error, 'speaker_required');
    assert.equal(typeof none.body.message, 'string');

    const unknown = await call('POST', '/api/v1/agents/donna/conversation', {
      token: rosieKey,
      body: { input: 'hi', speaker: 'bob' },
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error, 'unknown_speaker');

    const notEnrolled = await call('POST', '/api/v1/agents/donna/conversation', {
      token: rosieKey,
      body: { input: 'hi', speaker: 'user:stranger' },
    });
    assert.equal(notEnrolled.status, 403, JSON.stringify(notEnrolled.body));
    assert.equal(notEnrolled.body.error, 'person_not_enrolled');
  });

  it('stamps a live call as the enrolled speaker (alias or user id) with via=agent:rosie and no onBehalfOf', async () => {
    const started = await call('POST', '/api/v1/agents/donna/conversation', {
      token: rosieKey,
      body: { input: 'who am I talking to?', speaker: 'dale', mode: 'call', assurance: 'voice-asserted' },
    });
    assert.ok(started.status < 300, JSON.stringify(started.body));
    assert.equal(started.body.caller.actor, 'user:dale.sackrider');
    assert.equal(started.body.caller.verified, true);
    assert.equal(started.body.caller.via, 'agent:rosie');
    assert.equal(started.body.caller.mode, 'call');
    assert.equal(started.body.caller.assurance, 'voice-asserted');
    assert.equal(started.body.caller.relationship, 'owner');
    assert.equal(started.body.caller.isOwner, true);
    assert.deepEqual(started.body.caller.agentRoles, ['Owner']);
    assert.equal(started.body.caller.onBehalfOf, undefined);
    assert.match(started.body.conversationId, /^convo_/);
    const run = state.runs.get(started.body.runId);
    assert.equal(run?.caller?.actor, 'user:dale.sackrider');
    assert.equal((run?.input as { caller?: { actor?: string; onBehalfOf?: unknown } })?.caller?.actor, 'user:dale.sackrider');
    assert.equal((run?.input as { caller?: { onBehalfOf?: unknown } })?.caller?.onBehalfOf, undefined);

    const enrolled = await call('POST', `/api/v1/speak-as-grants/${grantId}/members`, {
      token: TOKENS.admin,
      body: { principalId: 'user:partner', aliases: ['partner'], targetAgents: ['higgins'], relationship: 'family' },
    });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));

    const denied = await call('POST', '/api/v1/agents/donna/conversation', {
      token: rosieKey,
      body: { input: 'hi', speaker: 'partner' },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, 'agent_not_allowed');

    const allowed = await call('POST', '/api/v1/agents/higgins/conversation', {
      token: rosieKey,
      body: { input: 'hello', speaker: 'user:partner', mode: 'call' },
    });
    assert.ok(allowed.status < 300, JSON.stringify(allowed.body));
    assert.equal(allowed.body.caller.actor, 'user:partner');
    assert.equal(allowed.body.caller.relationship, 'family');
    assert.equal(allowed.body.caller.isOwner, undefined);
    assert.deepEqual(allowed.body.caller.agentRoles, ['Family']);
  });

  it('stamps an errand with mode=errand and lists callable agents per speaker', async () => {
    const errand = await call('POST', '/api/v1/agents/donna/conversation', {
      token: rosieKey,
      body: { input: 'add lunch to my calendar', speaker: 'user:dale.sackrider', mode: 'errand' },
    });
    assert.ok(errand.status < 300, JSON.stringify(errand.body));
    assert.equal(errand.body.caller.mode, 'errand');
    assert.equal(errand.body.caller.actor, 'user:dale.sackrider');
    assert.equal(errand.body.caller.via, 'agent:rosie');

    const daleList = await call('GET', '/api/v1/speak-as/callable-agents?speaker=dale', { token: rosieKey });
    assert.equal(daleList.status, 200, JSON.stringify(daleList.body));
    assert.equal(daleList.body.speaker, 'user:dale.sackrider');
    const daleIds = (daleList.body.agents as { id: string; name: string; description: string }[]).map((a) => a.id);
    assert.ok(daleIds.includes('donna') && daleIds.includes('higgins') && daleIds.includes('rosie'));
    const donna = daleList.body.agents.find((a: { id: string }) => a.id === 'donna');
    assert.equal(donna.name, 'Donna');
    assert.equal(typeof donna.description, 'string');

    const partnerList = await call('GET', '/api/v1/speak-as/callable-agents?speaker=partner', { token: rosieKey });
    assert.equal(partnerList.status, 200, JSON.stringify(partnerList.body));
    assert.deepEqual(
      (partnerList.body.agents as { id: string }[]).map((a) => a.id),
      ['higgins'],
    );
  });

  it('MCP ask forwards speaker and list_callable_agents, and get_replies accepts conversationId', async () => {
    const listed = await mcpAgent('donna', 'tools/list', {}, rosieKey);
    assert.equal(listed.status, 200, JSON.stringify(listed.rpc));
    const names = (listed.rpc.result?.tools ?? []).map((t: { name: string }) => t.name);
    assert.ok(names.includes('ask') && names.includes('get_replies') && names.includes('list_callable_agents'));

    const ask = await mcpAgent(
      'donna',
      'tools/call',
      { name: 'ask', arguments: { message: 'who am I talking to?', speaker: 'dale', mode: 'call' } },
      rosieKey,
    );
    assert.equal(ask.status, 200, JSON.stringify(ask.rpc));
    assert.equal(ask.rpc.result?.isError, undefined);
    const content = ask.rpc.result?.structuredContent;
    assert.equal(content.caller.actor, 'user:dale.sackrider');
    assert.match(content.conversationId, /^convo_/);

    const replies = await mcpAgent(
      'donna',
      'tools/call',
      { name: 'get_replies', arguments: { after: 0, conversationId: content.conversationId } },
      rosieKey,
    );
    assert.equal(replies.status, 200, JSON.stringify(replies.rpc));
    assert.equal(replies.rpc.result?.isError, undefined);

    const discovered = await mcpAgent('rosie', 'tools/call', { name: 'list_callable_agents', arguments: { speaker: 'dale' } }, rosieKey);
    assert.equal(discovered.status, 200, JSON.stringify(discovered.rpc));
    assert.equal(discovered.rpc.result?.structuredContent?.speaker, 'user:dale.sackrider');
    assert.ok((discovered.rpc.result?.structuredContent?.agents ?? []).some((a: { id: string }) => a.id === 'donna'));
  });

  it('enrolls a child on an allowlist, lists only those agents, and refuses other agents and errands', async () => {
    const created = await call('POST', `/api/v1/speak-as-grants/${grantId}/members`, {
      token: TOKENS.admin,
      body: { principalId: 'user:kid', aliases: ['kid'], relationship: 'child' },
    });
    assert.equal(created.status, 400, JSON.stringify(created.body));
    assert.equal(created.body.error, 'child_requires_allowlist');

    const enrolled = await call('POST', `/api/v1/speak-as-grants/${grantId}/members`, {
      token: TOKENS.admin,
      body: { principalId: 'user:kid', aliases: ['kid'], targetAgents: ['rosie'], relationship: 'child' },
    });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));

    const listed = await call('GET', '/api/v1/speak-as/callable-agents?speaker=kid', { token: rosieKey });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.speaker, 'user:kid');
    assert.deepEqual(
      (listed.body.agents as { id: string }[]).map((a) => a.id),
      ['rosie'],
    );

    const denied = await call('POST', '/api/v1/agents/donna/conversation', {
      token: rosieKey,
      body: { input: 'hi', speaker: 'kid' },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, 'child_restricted');

    const errand = await call('POST', '/api/v1/agents/rosie/conversation', {
      token: rosieKey,
      body: { input: 'call Donna', speaker: 'kid', mode: 'errand' },
    });
    assert.equal(errand.status, 403, JSON.stringify(errand.body));
    assert.equal(errand.body.error, 'child_restricted');

    const allowed = await call('POST', '/api/v1/agents/rosie/conversation', {
      token: rosieKey,
      body: { input: 'hello', speaker: 'kid', mode: 'call' },
    });
    assert.ok(allowed.status < 300, JSON.stringify(allowed.body));
    assert.equal(allowed.body.caller.actor, 'user:kid');
    assert.equal(allowed.body.caller.relationship, 'child');
    assert.equal(allowed.body.caller.mode, 'call');
    assert.equal(allowed.body.caller.isOwner, undefined);
    assert.equal(allowed.body.caller.agentRoles, undefined);
  });

  it('lets a verified owner take over the same conversation after a child, and refuses a disallowed speaker', async () => {
    const child = await call('POST', '/api/v1/agents/rosie/conversation', {
      token: rosieKey,
      body: { input: { message: 'hello from the kid' }, speaker: 'kid', channel: 'voice', mode: 'call' },
    });
    assert.ok(child.status < 300, JSON.stringify(child.body));
    assert.equal(child.body.caller.actor, 'user:kid');
    assert.equal(child.body.caller.relationship, 'child');
    const conversationId = child.body.conversationId as string;
    assert.match(conversationId, /^convo_/);

    const denied = await call('POST', '/api/v1/agents/rosie/conversation', {
      token: rosieKey,
      body: {
        input: { message: 'hi' },
        speaker: 'partner',
        conversationId,
        channel: 'voice',
        mode: 'call',
      },
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    assert.equal(denied.body.error, 'agent_not_allowed');

    const stillChild = await call('POST', '/api/v1/agents/rosie/conversation', {
      token: rosieKey,
      body: { input: { message: 'still me' }, conversationId, channel: 'voice', mode: 'call' },
    });
    assert.ok(stillChild.status < 300, JSON.stringify(stillChild.body));
    assert.equal(stillChild.body.caller.actor, 'user:kid');
    assert.equal(stillChild.body.conversationId, conversationId);

    const owner = await call('POST', '/api/v1/agents/rosie/conversation', {
      token: rosieKey,
      body: {
        input: { message: 'Turn off only light.bar.' },
        speaker: 'dale',
        conversationId,
        channel: 'voice',
        mode: 'call',
      },
    });
    assert.ok(owner.status < 300, JSON.stringify(owner.body));
    assert.equal(owner.body.conversationId, conversationId);
    assert.equal(owner.body.caller.actor, 'user:dale.sackrider', 'body.caller');
    assert.equal(owner.body.caller.name, 'Dale');
    assert.equal(owner.body.caller.relationship, 'owner');
    assert.equal(owner.body.caller.isOwner, true);
    assert.deepEqual(owner.body.caller.agentRoles, ['Owner']);
    assert.equal(owner.body.caller.channel, 'voice');
    assert.equal(owner.body.caller.verified, true);
    const run = state.runs.get(owner.body.runId);
    assert.equal(run?.caller?.actor, 'user:dale.sackrider', 'run.caller');
    assert.equal((run?.input as { caller?: { actor?: string } })?.caller?.actor, 'user:dale.sackrider', 'run.input.caller');
  });
});
