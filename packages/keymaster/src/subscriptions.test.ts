import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLedger, redactSecrets } from '@beercanlabs/factory-ledger';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { SUBSCRIPTION_TEMPLATES } from '@beercanlabs/factory-contract';
import {
  SubscriptionKeymaster,
  defaultConnectionName,
  endpointMeetsHostRule,
  subscriptionSecretName,
  type NeedsReconsentEvent,
  type SubscriptionTokenOutcome,
} from './subscriptions.js';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;

function memory(opts: { failWritesAfter?: number } = {}) {
  const values = new Map<string, string>();
  const writes: string[] = [];
  let n = 0;
  const provider: SecretProvider = {
    name: 'mem',
    async get(k) {
      return values.get(k);
    },
    async put(k, v) {
      if (opts.failWritesAfter !== undefined && n++ >= opts.failWritesAfter) throw new Error('disk full');
      writes.push(k);
      values.set(k, v);
    },
  };
  return { provider, values, writes, failAll: () => (opts.failWritesAfter = 0), failFrom: (k: number) => ((opts.failWritesAfter = n + k)) };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; body: string; headers: Record<string, string> };

/** A fake xAI and OpenAI. Each test scripts the account that signs in and what the token endpoint answers. */
function fakeVendors() {
  const calls: Call[] = [];
  const st = {
    xai: {
      pendingPolls: 1,
      claims: { sub: 'xai-sub-1', email: 'Dale@example.com', name: 'Dale Rider' } as Record<string, unknown>,
      discovery: { token_endpoint: 'https://auth.x.ai/oauth2/token' } as Record<string, unknown>,
      verification: 'https://auth.x.ai/oauth2/device',
      refresh: (n: number): Response => json(200, { access_token: `xai-access-r${n}-aaaaaaaa`, refresh_token: `xai-refresh-r${n}-aaaaaaaa`, expires_in: 3600 }),
      refreshCount: 0,
      issued: 0,
    },
    openai: {
      pendingPolls: 1,
      claims: { sub: 'oa-sub-1', email: 'stephanie@example.com', name: 'Stephanie Q', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'plus' } } as Record<string, unknown>,
      refresh: (n: number): Response => json(200, { access_token: `oa-access-r${n}-aaaaaaaa`, refresh_token: `oa-refresh-r${n}-aaaaaaaa`, expires_in: 3600 }),
      refreshCount: 0,
      issued: 0,
    },
  };
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = String(init?.body ?? '');
    calls.push({ url, method: init?.method ?? 'GET', body, headers });
    const form = () => new URLSearchParams(body);
    if (url === 'https://auth.x.ai/.well-known/openid-configuration') return json(200, st.xai.discovery);
    if (url === 'https://auth.x.ai/oauth2/device/code') {
      return json(200, { device_code: 'xai-device-code-0001', user_code: 'ABCD-EFGH', verification_uri: st.xai.verification, verification_uri_complete: `${st.xai.verification}?user_code=ABCD-EFGH`, expires_in: 600, interval: 5 });
    }
    const xaiToken = String(st.xai.discovery.token_endpoint);
    if (url === xaiToken || url === 'https://auth.x.ai/oauth2/token') {
      const f = form();
      if (f.get('grant_type') === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (st.xai.pendingPolls-- > 0) return json(400, { error: 'authorization_pending' });
        st.xai.issued++;
        return json(200, { access_token: 'xai-access-0-aaaaaaaa', refresh_token: 'xai-refresh-0-aaaaaaaa', id_token: jwt(st.xai.claims), expires_in: 3600 }); // secret-scan:allow (fake vendor fixture)
      }
      st.xai.refreshCount++;
      return st.xai.refresh(st.xai.refreshCount);
    }
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') return json(200, { device_auth_id: 'oa-device-auth-0001', user_code: 'WXYZ-1234', interval: '5' });
    if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
      if (st.openai.pendingPolls-- > 0) return json(403, { error: 'deviceauth_authorization_pending' });
      return json(200, { authorization_code: 'oa-authz-code-0001', code_verifier: 'oa-code-verifier-0001' });
    }
    if (url === 'https://auth.openai.com/oauth/token') {
      const f = form();
      if (f.get('grant_type') === 'authorization_code') {
        st.openai.issued++;
        return json(200, { access_token: jwt({ sub: st.openai.claims.sub, 'https://api.openai.com/auth': st.openai.claims['https://api.openai.com/auth'] }), refresh_token: 'oa-refresh-0-aaaaaaaa', id_token: jwt(st.openai.claims), expires_in: 3600 }); // secret-scan:allow (fake vendor fixture)
      }
      st.openai.refreshCount++;
      return st.openai.refresh(st.openai.refreshCount);
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { fn, calls, st };
}

function setup(over: { failWritesAfter?: number; onNeedsReconsent?: (e: NeedsReconsentEvent) => void } = {}) {
  const mem = memory({ failWritesAfter: over.failWritesAfter });
  const ledger = new MemoryLedger();
  const secretValues = new Set<string>();
  const vendors = fakeVendors();
  let clock = Date.parse('2026-11-08T00:00:00Z');
  const km = new SubscriptionKeymaster({ providers: [mem.provider], ledger, secretValues, fetch: vendors.fn, now: () => clock, version: '9.9.9', onNeedsReconsent: over.onNeedsReconsent });
  return { km, mem, ledger, secretValues, vendors, tick: (ms: number) => (clock += ms), now: () => clock };
}

type Ctx = ReturnType<typeof setup>;

/** Starts a sign-in and polls until the subscriber has "approved". */
async function signIn(c: Ctx, templateId: string, actor = 'oidc:admin@example.com', extra: { name?: string; reconnect?: string } = {}) {
  const started = await c.km.startSignIn({ templateId, actor, subscriberAttested: true, ...extra });
  if (!started.ok) return started;
  let out;
  for (let i = 0; i < 5; i++) {
    c.tick(6000);
    out = await c.km.pollSignIn(started.signIn.signInId, actor);
    if (!(out.ok && out.status === 'pending')) break;
  }
  return { started, out: out! };
}

const ledgerText = (c: Ctx) => JSON.stringify(c.ledger.events);

describe('subscription connections: sign-in', () => {
  it('xAI device-code sign-in connects a named connection, stored at shared/xai/subscription/<id>', async () => {
    const c = setup();
    const r = await signIn(c, 'xai-subscription');
    assert.ok('out' in r && r.out.ok && r.out.status === 'connected');
    const conn = (r.out as { connection: { id: string; name: string; subscriberEmail: string } }).connection;
    assert.equal(conn.name, "Dale's Grok Subscription");
    assert.equal(conn.subscriberEmail, 'dale@example.com');
    assert.ok(c.mem.values.has(subscriptionSecretName('xai', conn.id)), 'grant stored at shared/<provider>/subscription/<connection>');
    assert.match(subscriptionSecretName('xai', conn.id), /^shared\/xai\/subscription\/c-[a-f0-9]{12}$/);
    assert.ok(c.mem.writes.every((w) => w.startsWith('shared/xai/subscription/')), 'nothing is stored under any agent');
    // The device-code request used the template's public client and scope, with no client secret.
    const dev = c.vendors.calls.find((x) => x.url.endsWith('/device/code'))!;
    const f = new URLSearchParams(dev.body);
    assert.equal(f.get('client_id'), SUBSCRIPTION_TEMPLATES['xai-subscription'].client.id);
    assert.equal(f.get('scope'), 'openid profile email offline_access grok-cli:access api:access');
    assert.equal(f.has('client_secret'), false);
    assert.equal(dev.headers['user-agent'], 'BeerCanLabs-AgentFactory/9.9.9');
    // The token is then served from the Keymaster.
    const tok = await c.km.accessToken(conn.id);
    assert.ok(tok.ok && tok.accessToken === 'xai-access-0-aaaaaaaa');
  });

  it('the admin must attest that the subscriber agreed; nothing starts without it', async () => {
    const c = setup();
    const r = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'a', subscriberAttested: false });
    assert.deepEqual(r.ok, false);
    assert.equal(!r.ok && r.error, 'attestation_required');
    assert.equal(c.vendors.calls.length, 0);
    const u = await c.km.startSignIn({ templateId: 'nope', actor: 'a', subscriberAttested: true });
    assert.equal(!u.ok && u.error, 'unknown_template');
  });

  it('xAI: refuses a discovery token endpoint that is not https on x.ai', async () => {
    for (const bad of ['http://auth.x.ai/oauth2/token', 'https://auth.evil.example/oauth2/token', 'https://evilx.ai/token', 'https://x.ai.evil.example/t']) {
      const c = setup();
      c.vendors.st.xai.discovery = { token_endpoint: bad };
      const r = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'a', subscriberAttested: true });
      assert.equal(!r.ok && r.error, 'discovery_invalid', bad);
      assert.equal(c.vendors.calls.some((x) => x.url.endsWith('/device/code')), false, 'no device code is requested after bad discovery');
    }
    assert.ok(endpointMeetsHostRule('https://auth.x.ai/t', { scheme: 'https', host: 'x.ai', allowSubdomains: true }));
    assert.ok(endpointMeetsHostRule('https://x.ai/t', { scheme: 'https', host: 'x.ai', allowSubdomains: true }));
  });

  it('xAI: refuses a verification URL outside x.ai', async () => {
    const c = setup();
    c.vendors.st.xai.verification = 'https://phish.example/device';
    const r = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'a', subscriberAttested: true });
    assert.equal(!r.ok && r.error, 'discovery_invalid');
  });

  it('xAI: the token endpoint from discovery is the one used for sign-in and refresh', async () => {
    const c = setup();
    c.vendors.st.xai.discovery = { token_endpoint: 'https://login.x.ai/oauth/tokens' };
    const rs = await signIn(c, 'xai-subscription');
    assert.ok('out' in rs && rs.out.ok);
    assert.ok(c.vendors.calls.some((x) => x.url === 'https://login.x.ai/oauth/tokens'));
  });

  it('OpenAI device sign-in: 403/404 is pending, then the code is exchanged at the token endpoint with the device redirect', async () => {
    const c = setup();
    c.vendors.st.openai.pendingPolls = 2;
    const r = await signIn(c, 'openai-subscription');
    assert.ok('out' in r && r.out.ok && r.out.status === 'connected');
    const started = (r as { started: { ok: true; signIn: { verificationUrl: string; userCode: string } } }).started;
    assert.equal(started.signIn.verificationUrl, 'https://auth.openai.com/codex/device');
    assert.equal(started.signIn.userCode, 'WXYZ-1234');
    const usercode = c.vendors.calls.find((x) => x.url.endsWith('/deviceauth/usercode'))!;
    assert.deepEqual(JSON.parse(usercode.body), { client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' });
    const polls = c.vendors.calls.filter((x) => x.url.endsWith('/deviceauth/token'));
    assert.equal(polls.length, 3);
    assert.deepEqual(JSON.parse(polls[0].body), { device_auth_id: 'oa-device-auth-0001', user_code: 'WXYZ-1234' });
    const ex = c.vendors.calls.find((x) => x.url === 'https://auth.openai.com/oauth/token')!;
    const f = new URLSearchParams(ex.body);
    assert.equal(f.get('grant_type'), 'authorization_code');
    assert.equal(f.get('code'), 'oa-authz-code-0001');
    assert.equal(f.get('code_verifier'), 'oa-code-verifier-0001');
    assert.equal(f.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
    assert.equal(f.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
    assert.equal(f.has('client_secret'), false);
    const conn = (r.out as { connection: { id: string; name: string; tier?: string } }).connection;
    assert.equal(conn.name, "Stephanie's ChatGPT Subscription");
    assert.equal(conn.tier, 'ChatGPT Plus');
    const tok = await c.km.accessToken(conn.id);
    assert.ok(tok.ok && tok.accountId === 'acct-1', 'the signed-in account id is available for ChatGPT-Account-ID');
  });

  it('a poll inside the vendor interval does not call the vendor', async () => {
    const c = setup();
    const s = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'a', subscriberAttested: true });
    assert.ok(s.ok);
    const before = c.vendors.calls.length;
    const p = await c.km.pollSignIn(s.signIn.signInId, 'a');
    assert.ok(p.ok && p.status === 'pending');
    assert.equal(c.vendors.calls.length, before);
  });

  it('only the admin who started a sign-in may poll it', async () => {
    const c = setup();
    const s = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'alice', subscriberAttested: true });
    assert.ok(s.ok);
    c.tick(6000);
    const p = await c.km.pollSignIn(s.signIn.signInId, 'mallory');
    assert.equal(!p.ok && p.error, 'unknown_sign_in');
  });

  it('a declined or expired sign-in connects nothing', async () => {
    const c = setup();
    const s = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'a', subscriberAttested: true });
    assert.ok(s.ok);
    c.tick(11 * 60 * 1000);
    const p = await c.km.pollSignIn(s.signIn.signInId, 'a');
    assert.equal(!p.ok && p.error, 'sign_in_expired');
    assert.deepEqual(await c.km.list(), []);
  });
});

describe('subscription connections: naming, reconnect, rename, disconnect', () => {
  it('falls back to the email local part when the profile has no name', async () => {
    const c = setup();
    c.vendors.st.xai.claims = { sub: 'xai-sub-9', email: 'pat.lee@example.com' };
    const r = await signIn(c, 'xai-subscription');
    assert.equal(((r as any).out.connection).name, "pat.lee's Grok Subscription");
    assert.equal(defaultConnectionName('openai', { email: 'x@y.z', firstName: 'Ann' }), "Ann's ChatGPT Subscription");
  });

  it('refuses a name clash, case-insensitively, at connect and rename', async () => {
    const c = setup();
    const first = await signIn(c, 'xai-subscription');
    assert.ok((first as any).out.ok);
    // A different account whose default name collides.
    c.vendors.st.xai.claims = { sub: 'xai-sub-2', email: 'dale@other.example', name: 'dale Other' };
    c.vendors.st.xai.pendingPolls = 0;
    const second = await signIn(c, 'xai-subscription');
    assert.equal((second as any).out.error, 'name_taken');
    assert.equal((await c.km.list()).length, 1, 'the clashing sign-in stored nothing');
    // An explicit name works, and one that clashes is refused at the start.
    c.vendors.st.xai.pendingPolls = 0;
    const named = await signIn(c, 'xai-subscription', 'oidc:admin@example.com', { name: "Dale's backup" });
    assert.ok((named as any).out.ok);
    const clash = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'a', subscriberAttested: true, name: "DALE'S GROK SUBSCRIPTION" });
    assert.equal(!clash.ok && clash.error, 'name_taken');
    const conn = (named as any).out.connection;
    const rn = await c.km.rename(conn.id, "dale's grok subscription", 'oidc:admin@example.com');
    assert.equal(!rn.ok && rn.error, 'name_taken');
  });

  it('renames, and the ledger names the admin, subscriber and tier', async () => {
    const c = setup();
    const r = await signIn(c, 'openai-subscription');
    const id = (r as any).out.connection.id;
    const rn = await c.km.rename(id, '  Family   plan ', 'oidc:boss@example.com');
    assert.ok(rn.ok && rn.connection.name === 'Family plan');
    const row = c.ledger.events.find((e) => e.action === 'SUBSCRIPTION_RENAMED')!;
    assert.equal(row.actor, 'oidc:boss@example.com');
    assert.equal(row.subscriber, 'stephanie@example.com');
    assert.equal(row.tier, 'ChatGPT Plus');
    assert.equal(row.previousName, "Stephanie's ChatGPT Subscription");
    assert.equal(row.connectionName, 'Family plan');
    const bad = await c.km.rename(id, '   ', 'x');
    assert.equal(!bad.ok && bad.error, 'invalid_name');
  });

  it('connect is ledgered with the admin, subscriber, tier and attestation, and never a token', async () => {
    const c = setup();
    await signIn(c, 'openai-subscription', 'oidc:admin@example.com');
    const row = c.ledger.events.find((e) => e.action === 'SUBSCRIPTION_CONNECTED')!;
    assert.equal(row.actor, 'oidc:admin@example.com');
    assert.equal(row.subscriber, 'stephanie@example.com');
    assert.equal(row.tier, 'ChatGPT Plus');
    assert.equal(row.attested, true);
    assert.equal(row.reconnect, false);
    assert.equal(row.provider, 'openai');
    const text = ledgerText(c);
    for (const v of c.secretValues) assert.equal(text.includes(v), false, `ledger must not contain a token: ${v.slice(0, 6)}`);
  });

  it('signing in to a connected account reconnects it: grant replaced, name and id kept', async () => {
    const c = setup();
    const first = await signIn(c, 'xai-subscription');
    const conn = (first as any).out.connection;
    await c.km.rename(conn.id, 'Dale grok', 'a');
    c.vendors.st.xai.pendingPolls = 0;
    const again = await signIn(c, 'xai-subscription', 'oidc:other-admin@example.com');
    const out = (again as any).out;
    assert.ok(out.ok && out.reconnect === true);
    assert.equal(out.connection.id, conn.id);
    assert.equal(out.connection.name, 'Dale grok');
    assert.equal(out.connection.connectedBy, 'oidc:other-admin@example.com');
    assert.equal((await c.km.list()).length, 1, 'one vendor account, one connection');
    const rows = c.ledger.events.filter((e) => e.action === 'SUBSCRIPTION_CONNECTED');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].reconnect, true);
  });

  it('a reconnect for one connection refuses another account', async () => {
    const c = setup();
    const first = await signIn(c, 'xai-subscription');
    const id = (first as any).out.connection.id;
    c.vendors.st.xai.claims = { sub: 'someone-else', email: 'else@example.com', name: 'Else' };
    c.vendors.st.xai.pendingPolls = 0;
    const r = await signIn(c, 'xai-subscription', 'oidc:admin@example.com', { reconnect: id });
    assert.equal((r as any).out.error, 'account_mismatch');
    assert.equal((await c.km.list()).length, 1);
    const unknown = await c.km.startSignIn({ templateId: 'xai-subscription', actor: 'a', subscriberAttested: true, reconnect: 'c-000000000000' });
    assert.equal(!unknown.ok && unknown.error, 'unknown_connection');
    const wrongVendor = await c.km.startSignIn({ templateId: 'openai-subscription', actor: 'a', subscriberAttested: true, reconnect: id });
    assert.equal(!wrongVendor.ok && wrongVendor.error, 'provider_mismatch');
  });

  it('the same person on xAI and OpenAI is two connections (accounts are per vendor)', async () => {
    const c = setup();
    await signIn(c, 'xai-subscription');
    await signIn(c, 'openai-subscription');
    assert.equal((await c.km.list()).length, 2);
  });

  it('disconnect retires the entries through the hook, tombstones the grant, and is ledgered', async () => {
    const c = setup();
    const r = await signIn(c, 'xai-subscription');
    const conn = (r as any).out.connection;
    const retired: string[] = [];
    const d = await c.km.disconnect(conn.id, 'oidc:admin@example.com', (v) => (retired.push(v.id), 3));
    assert.ok(d.ok && d.entriesRetired === 3);
    assert.deepEqual(retired, [conn.id]);
    assert.deepEqual(await c.km.list(), []);
    const tok = await c.km.accessToken(conn.id);
    assert.ok(!tok.ok && tok.error === 'unknown_connection');
    assert.equal(JSON.parse(c.mem.values.get(subscriptionSecretName('xai', conn.id))!).refreshToken, undefined, 'the grant is overwritten');
    const row = c.ledger.events.find((e) => e.action === 'SUBSCRIPTION_DISCONNECTED')!;
    assert.equal(row.actor, 'oidc:admin@example.com');
    assert.equal(row.subscriber, 'dale@example.com');
    assert.equal(row.entriesRetired, 3);
    const again = await c.km.disconnect(conn.id, 'x');
    assert.equal(!again.ok && again.error, 'unknown_connection');
    // A new sign-in to the same account makes a fresh connection.
    c.vendors.st.xai.pendingPolls = 0;
    const back = await signIn(c, 'xai-subscription');
    assert.ok((back as any).out.ok && (back as any).out.reconnect === false);
  });
});

describe('subscription connections: refresh, rotation, reuse, redaction', () => {
  async function connected(c: Ctx, templateId = 'xai-subscription') {
    const r = await signIn(c, templateId);
    const id = (r as any).out.connection.id as string;
    // Let the sign-in access token expire so the next call refreshes.
    c.tick(2 * 60 * 60 * 1000);
    return id;
  }

  it('persists the rotated refresh token BEFORE the new access token is returned', async () => {
    const c = setup();
    const id = await connected(c);
    let writesAtResponse = -1;
    let storedAtResponse = '';
    const orig = c.vendors.st.xai.refresh;
    c.vendors.st.xai.refresh = (n) => {
      writesAtResponse = c.mem.writes.length;
      storedAtResponse = c.mem.values.get(subscriptionSecretName('xai', id))!;
      return orig(n);
    };
    const before = c.mem.writes.length;
    const tok = await c.km.accessToken(id);
    assert.ok(tok.ok && tok.accessToken === 'xai-access-r1-aaaaaaaa');
    assert.equal(writesAtResponse, before, 'nothing is written before the vendor answers');
    assert.ok(c.mem.writes.length > before, 'the rotated grant was written');
    const stored = JSON.parse(c.mem.values.get(subscriptionSecretName('xai', id))!);
    assert.equal(stored.refreshToken, 'xai-refresh-r1-aaaaaaaa');
    assert.equal(JSON.parse(storedAtResponse).refreshToken, 'xai-refresh-0-aaaaaaaa');
    assert.equal(c.ledger.events.filter((e) => e.action === 'SUBSCRIPTION_REFRESH_TOKEN_ROTATED').length, 1);
  });

  it('withholds the access token when the rotated grant cannot be persisted, then persists it first next time', async () => {
    const c = setup();
    const id = await connected(c);
    c.mem.failFrom(0); // every write from now fails
    const t1 = await c.km.accessToken(id);
    assert.ok(!t1.ok && t1.error === 'connection_unavailable', 'the new access token is not used');
    assert.equal(c.vendors.st.xai.refreshCount, 1);
    // The disk comes back: the rotated grant is written first, with no second (dead-token) refresh.
    (c.mem as any).failFrom = undefined;
    c.mem.provider.put = async (k, v) => void c.mem.values.set(k, v);
    const t2 = await c.km.accessToken(id);
    assert.ok(t2.ok && t2.accessToken === 'xai-access-r1-aaaaaaaa');
    assert.equal(c.vendors.st.xai.refreshCount, 1, 'the consumed refresh token is never replayed');
    assert.equal(JSON.parse(c.mem.values.get(subscriptionSecretName('xai', id))!).refreshToken, 'xai-refresh-r1-aaaaaaaa');
  });

  it('serializes refresh per grant: concurrent callers share one refresh', async () => {
    const c = setup();
    const id = await connected(c, 'openai-subscription');
    const outs = await Promise.all(Array.from({ length: 8 }, () => c.km.accessToken(id)));
    assert.equal(c.vendors.st.openai.refreshCount, 1);
    assert.ok(outs.every((o) => o.ok && o.accessToken === 'oa-access-r1-aaaaaaaa'));
    // A cached token is served without another refresh.
    await c.km.accessToken(id);
    assert.equal(c.vendors.st.openai.refreshCount, 1);
  });

  it('adds every token to the redaction set the moment it is obtained, so redaction removes it from any text', async () => {
    const c = setup();
    const id = await connected(c);
    await c.km.accessToken(id);
    for (const t of ['xai-access-0-aaaaaaaa', 'xai-refresh-0-aaaaaaaa', 'xai-access-r1-aaaaaaaa', 'xai-refresh-r1-aaaaaaaa', 'xai-device-code-0001']) {
      assert.ok(c.secretValues.has(t), `${t} is in the redaction set`);
      assert.equal(redactSecrets(`error: upstream said ${t} bad`, c.secretValues).includes(t), false);
    }
    const idt = [...c.secretValues].find((v) => v.split('.').length === 3);
    assert.ok(idt, 'the id token is redacted too');
  });

  it('redacts the sign-in tokens before the connection exists (a failing profile still remembers them)', async () => {
    const c = setup();
    c.vendors.st.xai.claims = { sub: 'x' }; // no email: the profile is unusable
    const r = await signIn(c, 'xai-subscription');
    assert.equal((r as any).out.error, 'profile_unavailable');
    assert.ok(c.secretValues.has('xai-access-0-aaaaaaaa') && c.secretValues.has('xai-refresh-0-aaaaaaaa'));
    assert.deepEqual(await c.km.list(), []);
  });

  for (const [label, body] of [
    ['invalid_grant', { error: 'invalid_grant' }],
    ['reuse (OpenAI nested code)', { error: { code: 'refresh_token_reused', message: 'reused' } }],
  ] as const) {
    it(`a refused refresh (${label}) marks needs re-consent, notifies once, and is never retried`, async () => {
      const notified: NeedsReconsentEvent[] = [];
      const c = setup({ onNeedsReconsent: (e) => void notified.push(e) });
      const id = await connected(c, 'openai-subscription');
      c.vendors.st.openai.refresh = () => json(400, body);
      const t1 = await c.km.accessToken(id);
      assert.ok(!t1.ok && t1.error === 'needs_reconsent');
      assert.equal(c.vendors.st.openai.refreshCount, 1);
      const t2 = (await c.km.accessToken(id)) as SubscriptionTokenOutcome;
      assert.ok(!t2.ok && t2.error === 'needs_reconsent');
      assert.equal(c.vendors.st.openai.refreshCount, 1, 'no refresh retry');
      assert.equal(notified.length, 1);
      assert.equal(notified[0].connection.id, id);
      assert.equal(notified[0].connection.connectedBy, 'oidc:admin@example.com');
      assert.equal((await c.km.get(id))!.status, 'needs_reconsent');
      const row = c.ledger.events.find((e) => e.action === 'SUBSCRIPTION_NEEDS_RECONSENT')!;
      assert.equal(row.connection, id);
      for (const v of c.secretValues) assert.equal(ledgerText(c).includes(v), false);
      // Reconnecting ends it.
      c.vendors.st.openai.pendingPolls = 0;
      const re = await signIn(c, 'openai-subscription', 'oidc:admin@example.com', { reconnect: id });
      assert.ok((re as any).out.ok);
      assert.equal((await c.km.get(id))!.status, 'active');
      const t3 = await c.km.accessToken(id);
      assert.ok(t3.ok);
    });
  }

  it('a transient failure (5xx, 429, unreachable) is not a refused refresh and marks nothing', async () => {
    for (const mk of [() => json(503, { error: 'server_error' }), () => json(429, { error: 'rate_limited' }), () => json(400, { error: 'temporarily_unavailable' })]) {
      const notified: NeedsReconsentEvent[] = [];
      const c = setup({ onNeedsReconsent: (e) => void notified.push(e) });
      const id = await connected(c);
      c.vendors.st.xai.refresh = mk;
      const t = await c.km.accessToken(id);
      assert.ok(!t.ok && t.error === 'connection_unavailable');
      assert.equal((await c.km.get(id))!.status, 'active');
      assert.equal(notified.length, 0);
    }
  });

  it('a stored token endpoint outside the vendor origin never receives the refresh token', async () => {
    const c = setup();
    const id = await connected(c);
    const name = subscriptionSecretName('xai', id);
    const rec = JSON.parse(c.mem.values.get(name)!);
    c.mem.values.set(name, JSON.stringify({ ...rec, tokenUrl: 'https://evil.example/token' }));
    const before = c.vendors.calls.length;
    const t = await c.km.accessToken(id);
    assert.ok(!t.ok && t.error === 'connection_unavailable');
    assert.equal(c.vendors.calls.length, before);
  });

  it('a reconnect that lands during a refusal is not marked needs re-consent', async () => {
    const c = setup();
    const id = await connected(c);
    c.vendors.st.xai.refresh = () => {
      // The refresh is refused, but an admin has reconnected in the meantime (new refresh token in storage).
      const name = subscriptionSecretName('xai', id);
      const rec = JSON.parse(c.mem.values.get(name)!);
      c.mem.values.set(name, JSON.stringify({ ...rec, refreshToken: 'xai-refresh-new-aaaaaaaa' }));
      return json(400, { error: 'invalid_grant' });
    };
    await c.km.accessToken(id);
    assert.equal((await c.km.get(id))!.status, 'active');
  });
});
