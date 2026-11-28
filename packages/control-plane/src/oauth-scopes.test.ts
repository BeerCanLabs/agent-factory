import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocBackend, type VersionedDocBackend } from '@beercanlabs/factory-bouncer';
import { FACTORY_SCOPE_LABELS, THIRD_PARTY_DENIED_SCOPES } from '@beercanlabs/factory-auth';
import { consentCovers, mapOAuthScopeToKeyScopes, normalizeRequestedScopes } from './oauth-scopes.js';
import { consentPageHtml, McpOAuthStore, type McpOAuthDoc } from './mcp-oauth.js';

describe('oauth scope normalization (front-door Phase 1 Slice 4)', () => {
  it('defaults an omitted scope to mcp and rewrites mcp:full and dotted aliases', () => {
    assert.equal(normalizeRequestedScopes(undefined, false).ok && normalizeRequestedScopes(undefined, false).scope, 'mcp');
    const legacy = normalizeRequestedScopes('mcp:full', false);
    assert.equal(legacy.ok && legacy.scope, 'mcp');
    const dotted = normalizeRequestedScopes('agents.read', false);
    assert.equal(dotted.ok && dotted.scope, 'agents:read');
  });

  it('drops admin, grants:manage, and keys:manage for a third party, and refuses a request that is only those', () => {
    const mixed = normalizeRequestedScopes('admin grants:manage keys:manage mcp agents:read', false);
    assert.equal(mixed.ok, true);
    if (!mixed.ok) return;
    assert.deepEqual(mixed.scopes, ['mcp', 'agents:read']);
    for (const denied of THIRD_PARTY_DENIED_SCOPES) assert.equal(mixed.scopes.includes(denied), false);
    const onlyDenied = normalizeRequestedScopes('admin grants:manage keys:manage', false);
    assert.deepEqual(onlyDenied, { ok: false, error: 'invalid_scope' });
  });

  it('lets a first-party client keep admin, grants:manage, and keys:manage', () => {
    const scopes = normalizeRequestedScopes('keys:manage admin grants:manage mcp', true);
    assert.equal(scopes.ok, true);
    if (!scopes.ok) return;
    assert.deepEqual(scopes.scopes, ['mcp', 'grants:manage', 'keys:manage', 'admin']);
  });

  it('refuses an unknown scope', () => {
    assert.deepEqual(normalizeRequestedScopes('mcp not-a-scope', false), { ok: false, error: 'invalid_scope' });
  });

  it('treats a stored mcp:full grant as covering later non-admin scopes', () => {
    assert.equal(consentCovers('mcp:full', ['mcp', 'agents:read']), true);
    assert.equal(consentCovers('mcp:full', ['admin']), false);
    assert.equal(consentCovers('mcp', ['mcp', 'agents:read']), false);
  });

  it('narrows key scopes below admin unless the token carries admin', () => {
    const broad = mapOAuthScopeToKeyScopes('mcp');
    assert.ok(broad?.privileges?.includes('agents.read'));
    assert.equal(broad?.privileges?.includes('grants.manage'), false);
    assert.equal(broad?.privileges?.includes('credentials.platform.set'), false);
    const legacy = mapOAuthScopeToKeyScopes('mcp:full');
    assert.equal(legacy?.privileges?.includes('grants.manage'), false);
    const read = mapOAuthScopeToKeyScopes('agents:read');
    assert.ok(read?.privileges?.includes('agents.read'));
    assert.equal(read?.privileges?.includes('agents.create'), false);
    assert.equal(mapOAuthScopeToKeyScopes('admin mcp'), undefined);
  });
});

describe('consent page', () => {
  it('names the origin and lists scopes in plain language', () => {
    const html = consentPageHtml({
      clientName: 'Made Up',
      origin: 'https://thisismadeup.ai',
      principalId: 'user:stephanie',
      scopes: [{ id: 'mcp', label: FACTORY_SCOPE_LABELS.mcp }, { id: 'agents:read', label: FACTORY_SCOPE_LABELS['agents:read'] }],
      consentNonce: 'n',
      csrfToken: 'c',
    });
    assert.match(html, /Authorize MCP Client/);
    assert.match(html, /thisismadeup\.ai/);
    assert.match(html, /https:\/\/thisismadeup\.ai/);
    assert.match(html, new RegExp(FACTORY_SCOPE_LABELS.mcp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /data-scope="mcp"/);
    assert.match(html, /data-scope="agents:read"/);
    assert.doesNotMatch(html, /data-scope="admin"/);
    assert.match(html, /third-party application/);
    assert.match(html, /Factory Console, Garrison, Web Chat, and Connect/);
  });
});

describe('admin client writes survive a lost S3 or GCS race', () => {
  it('retries PreconditionFailed and keeps a consent the other task committed', async () => {
    const docs = new MemoryDocBackend<McpOAuthDoc>();
    let race = false;
    const racing: VersionedDocBackend<McpOAuthDoc> = {
      description: 'memory://race',
      loadState: () => docs.loadState(),
      loadLatest: () => docs.loadLatest(),
      async write(snapshot) {
        if (race) {
          race = false;
          const latest = await docs.loadLatest();
          const data = structuredClone(latest?.data ?? { clients: [], consents: [], refreshTokens: [] });
          data.consents.push({
            principalId: 'user:ada',
            clientId: 'app',
            clientName: 'App',
            scope: 'mcp',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          });
          await docs.write({ ...snapshot, data });
          throw Object.assign(new Error('aws s3api put-object failed'), {
            stderr: 'An error occurred (PreconditionFailed) when calling the PutObject operation',
          });
        }
        await docs.write(snapshot);
      },
    };
    const store = await McpOAuthStore.open(racing);
    await store.upsertAdminClient({
      clientId: 'app',
      clientName: 'App',
      redirectUris: ['https://app.example/cb'],
      firstParty: false,
      blocked: false,
    });
    race = true;
    const blocked = await store.upsertAdminClient({
      clientId: 'app',
      clientName: 'App',
      redirectUris: ['https://app.example/cb'],
      firstParty: false,
      blocked: true,
    });
    assert.equal(blocked.record.blocked, true);
    assert.equal(store.getClient('app')?.blocked, true);
    assert.equal(store.getConsent('user:ada', 'app')?.scope, 'mcp');
    const again = await McpOAuthStore.open(docs);
    assert.equal(again.getClient('app')?.blocked, true);
    assert.equal(again.getConsent('user:ada', 'app')?.scope, 'mcp');
  });
});
