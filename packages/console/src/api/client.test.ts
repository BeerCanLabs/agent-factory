// S9 fix: the people, grants and keys calls hit /api/v1/<route>, not /api/v1/api/v1/<route> (404 not_found in prod).
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { factoryApi, signOut } from './client.js';

it('#519 adoption request and approval send redeploy, defaulting to true', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, apply: { status: 'started' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await factoryApi.requestAdoption('higgins', 'conductor', '0.3.1');
  await factoryApi.requestAdoption('higgins', 'conductor', '0.3.1', 'batch', false);
  await factoryApi.approveAdoption('higgins', 'conductor');
  await factoryApi.approveAdoption('higgins', 'conductor', 'now', false);
  assert.equal(calls[0].url, '/api/v1/agents/higgins/skills');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { skillId: 'conductor', version: '0.3.1', redeploy: true });
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { skillId: 'conductor', version: '0.3.1', reason: 'batch', redeploy: false });
  assert.equal(calls[2].url, '/api/v1/agents/higgins/skills/conductor/adoption/approve');
  assert.deepEqual(JSON.parse(String(calls[2].init?.body)), { redeploy: true });
  assert.deepEqual(JSON.parse(String(calls[3].init?.body)), { reason: 'now', redeploy: false });
});

it('S9: a stale grants header asks the console to reload whoami', async () => {
  const events: string[] = [];
  const previous = (globalThis as { window?: { dispatchEvent: (event: Event) => void } }).window;
  (globalThis as { window?: { dispatchEvent: (event: Event) => void } }).window = {
    dispatchEvent: (event: Event) => events.push(event.type),
  };
  globalThis.fetch = (async () => new Response(JSON.stringify({ kinds: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-factory-grants-stale': '1' },
  })) as typeof fetch;
  await factoryApi.legacyCredentialUse();
  assert.deepEqual(events, ['factory-grants-stale']);
  if (previous) (globalThis as { window?: typeof previous }).window = previous;
  else delete (globalThis as { window?: unknown }).window;
});

it('S9: people, grants and keys calls are prefixed with /api/v1 exactly once', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ principals: [], grants: [], keys: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await factoryApi.listPrincipals();
  await factoryApi.listGrants();
  await factoryApi.listKeys();
  await factoryApi.rotateKey('key_x');
  assert.deepEqual(seen, ['/api/v1/principals', '/api/v1/grants', '/api/v1/keys', '/api/v1/keys/key_x/rotate']);
});

it('Sign out posts /api/v1/auth/logout with the session cookie, then lands on /login (even if the call fails)', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"ok":true}', { status: 200, headers: { 'set-cookie': 'factory_session=; Max-Age=0' } });
  }) as typeof fetch;
  const went: string[] = [];
  await signOut((u) => went.push(u));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/auth/logout');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.credentials, 'same-origin');
  assert.deepEqual(went, ['/login']);

  globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
  await signOut((u) => went.push(u));
  assert.deepEqual(went, ['/login', '/login']);
});

it('#434: Add person posts the display name and email to /api/v1/principals', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"id":"user:ada","displayName":"Ada","emails":["ada@example.com"]}', { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await factoryApi.createPrincipal(' Ada ', 'Ada@Example.com ');
  assert.equal(calls[0].url, '/api/v1/principals');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { displayName: 'Ada', emails: ['ada@example.com'] });
  const { validNewPerson } = await import('../views/PeopleView.js');
  assert.equal(validNewPerson('Ada', 'ada@example.com'), true);
  assert.equal(validNewPerson('', 'ada@example.com'), false);
  assert.equal(validNewPerson('Ada', 'not-an-email'), false);
  assert.equal(validNewPerson('x'.repeat(257), 'ada@example.com'), false);
});

it('#434: Rename sends PATCH /api/v1/principals/:id with the trimmed display name', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response('{"principal":{"id":"user:dale","displayName":"Dale"}}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  await factoryApi.renamePrincipal('user:dale', '  Dale  ');
  assert.equal(calls[0].url, '/api/v1/principals/user%3Adale');
  assert.equal(calls[0].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { displayName: 'Dale' });
});

it('verifyLedgerWorm returns ok: true on verified 200 response', async () => {
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, '/api/v1/ledger/verify');
    return new Response(JSON.stringify({ ok: true, checkpointsChecked: 5, worm: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await factoryApi.verifyLedgerWorm();
  assert.equal(result.ok, true);
  assert.equal(result.checkpointsChecked, 5);
  assert.equal(result.worm, true);
});

it('GAP-253 / TSK-340: verifyLedgerWorm NEVER returns ok: true on 409 tampered ledger response', async () => {
  globalThis.fetch = (async (url: string) => {
    assert.equal(url, '/api/v1/ledger/verify');
    return new Response(
      JSON.stringify({ ok: false, reason: 'Hash chain broken at seq 14', checkpointsChecked: 2, worm: true }),
      {
        status: 409,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as typeof fetch;

  const result = await factoryApi.verifyLedgerWorm();
  assert.equal(result.ok, false);
  assert.equal(result.worm, true);
  assert.equal(result.checkpointsChecked, 2);
  assert.match(result.reason!, /Hash chain broken/);
});

it('GAP-253 / TSK-340: verifyLedgerWorm returns ok: false on network or 500 error', async () => {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: 'Internal sink error' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const result = await factoryApi.verifyLedgerWorm();
  assert.equal(result.ok, false);
  assert.equal(result.worm, false);
});

it('OAuth consents management: listOAuthConsents and revokeOAuthConsent', async () => {
  const calls: { url: string; method?: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' });
    if (init?.method === 'DELETE') {
      return new Response(JSON.stringify({ ok: true, revoked: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ consents: [{ clientId: 'client_xyz', clientName: 'Cursor AI', scope: 'mcp:full', createdAt: '2026-11-16T12:00:00Z' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const list = await factoryApi.listOAuthConsents();
  assert.equal(calls[0].url, '/api/v1/oauth/consents');
  assert.equal(calls[0].method, 'GET');
  assert.equal(list.consents.length, 1);
  assert.equal(list.consents[0].clientName, 'Cursor AI');

  const revoke = await factoryApi.revokeOAuthConsent('client_xyz');
  assert.equal(calls[1].url, '/api/v1/oauth/consents/client_xyz');
  assert.equal(calls[1].method, 'DELETE');
  assert.equal(revoke.ok, true);
});

it('#520: decideApproval sends capUsd when approving and leaves it off every other call', async () => {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ approvalId: 'a', delivered: 'mailbox' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await factoryApi.decideApproval('id 1', 'approve', 'go', 16.63);
  assert.equal(calls[0].url, '/api/v1/approvals/id%201');
  assert.deepEqual(JSON.parse(calls[0].body), { decision: 'approve', notes: 'go', capUsd: 16.63 });

  await factoryApi.decideApproval('id 1', 'approve', undefined, 0);
  assert.deepEqual(JSON.parse(calls[1].body), { decision: 'approve', capUsd: 0 });

  await factoryApi.decideApproval('id 1', 'reject', 'too much', 16.63);
  assert.deepEqual(JSON.parse(calls[2].body), { decision: 'reject', notes: 'too much' });

  await factoryApi.decideApproval('id 1', 'approve');
  assert.deepEqual(JSON.parse(calls[3].body), { decision: 'approve' });
});
