import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverAuth, parseDiscovery } from './discover.js';

const doc = { auth: { type: 'oidc', issuer: 'https://login.example.com/', clientId: 'cli-1', scopes: ['openid', 'email'], tokenUse: 'id_token', redirectPort: 53682 } };
const answer = (status: number, body?: unknown, headers: Record<string, string> = {}) => (async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

describe('§6.17 CL9 finding out how a factory signs people in', () => {
  it('CL9 reads the factory\'s published document', async () => {
    assert.deepEqual(await discoverAuth('https://f.example.com', answer(200, doc)), { type: 'oidc', issuer: 'https://login.example.com', clientId: 'cli-1', scopes: ['openid', 'email'], tokenUse: 'id_token', redirectPort: 53682 });
  });

  it('CL9 recognises Cloudflare Access by its redirect, and only that', async () => {
    const access = answer(302, undefined, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/f.example.com' });
    assert.deepEqual(await discoverAuth('https://f.example.com', access), { type: 'cloudflare-access' });
    await assert.rejects(discoverAuth('https://f.example.com', answer(302, undefined, { location: 'https://evil.example.com/login' })), /not a sign-in the CLI knows/);
    await assert.rejects(discoverAuth('https://f.example.com', answer(302, undefined, { location: 'https://cloudflareaccess.com.evil.example/x' })), /not a sign-in/);
  });

  it('CL9 says what to do when the factory does not say, or cannot be reached', async () => {
    await assert.rejects(discoverAuth('https://f.example.com', answer(404, { error: 'not_found' })), /FACTORY_OIDC_CLI_CLIENT_ID/);
    await assert.rejects(discoverAuth('https://f.example.com', (async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch), /could not reach/);
  });

  it('CL9 accepts only a document that is as strict as the one the factory builds', () => {
    assert.ok(parseDiscovery(doc));
    const bad = (patch: Record<string, unknown>) => parseDiscovery({ auth: { ...doc.auth, ...patch } });
    assert.equal(bad({ issuer: 'http://remote.example.com' }), undefined);
    assert.equal(bad({ clientId: '' }), undefined);
    assert.equal(bad({ scopes: [] }), undefined);
    assert.equal(bad({ scopes: ['ok', 'bad scope'] }), undefined);
    assert.equal(bad({ tokenUse: 'refresh_token' }), undefined);
    assert.equal(bad({ redirectPort: 80 }), undefined);
    assert.equal(bad({ type: 'saml' }), undefined);
    assert.equal(parseDiscovery(null), undefined);
    assert.equal(parseDiscovery({}), undefined);
    assert.ok(parseDiscovery({ auth: { ...doc.auth, issuer: 'http://127.0.0.1:9000' } }), 'loopback http is for development');
  });
});
