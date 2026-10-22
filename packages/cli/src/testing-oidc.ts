/** A small OIDC provider for tests: checks what a real one checks (PKCE, redirect, client) and plays the browser. */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Provider = {
  issuer: string;
  /** What the "browser" did, and what the token endpoint was asked, in order. */
  log: { authorize: URLSearchParams[]; token: URLSearchParams[]; refresh: URLSearchParams[] };
  /** Overrides for misbehaving providers. */
  behave: { wrongNonce?: boolean; wrongIssuerInMetadata?: boolean; refuseRefresh?: boolean; omitIdToken?: boolean; error?: string; strayRequestFirst?: boolean; noRefreshToken?: boolean; plainHttpEndpoints?: boolean };
  issuedExp: number;
  openBrowser: (url: string) => Promise<void>;
  close: () => Promise<void>;
};

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const fakeJwt = (claims: Record<string, unknown>) => `${b64({ alg: 'none' })}.${b64(claims)}.sig`;

export async function fakeProvider(opts: { clientId?: string; sign?: (claims: Record<string, unknown>) => Promise<string> | string } = {}): Promise<Provider> {
  const clientId = opts.clientId ?? 'cli-client-1';
  const log: Provider['log'] = { authorize: [], token: [], refresh: [] };
  const codes = new Map<string, { challenge: string; redirectUri: string; nonce: string }>();
  let n = 0;
  const p = { behave: {} as Provider['behave'], issuedExp: Math.floor(Date.now() / 1000) + 3600 } as Provider;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/.well-known/openid-configuration') {
      const base = p.behave.plainHttpEndpoints ? 'http://idp.example.com' : p.issuer;
      return send(200, { issuer: p.behave.wrongIssuerInMetadata ? 'https://evil.example.com' : p.issuer, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token` });
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const form = new URLSearchParams(raw);
      if (form.get('client_id') !== clientId || form.has('client_secret')) return send(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'refresh_token') {
        log.refresh.push(form);
        if (p.behave.refuseRefresh || form.get('refresh_token') !== 'refresh-1') return send(400, { error: 'invalid_grant' });
        const id = await (opts.sign ?? fakeJwt)({ iss: p.issuer, aud: clientId, sub: 'user-1', email: 'dale@example.com', exp: p.issuedExp });
        return send(200, { id_token: id, access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 });
      }
      log.token.push(form);
      const rec = codes.get(form.get('code') ?? '');
      if (!rec) return send(400, { error: 'invalid_grant' });
      codes.delete(form.get('code')!);
      const verifier = form.get('code_verifier') ?? '';
      if (createHash('sha256').update(verifier).digest('base64url') !== rec.challenge) return send(400, { error: 'invalid_grant' });
      if (form.get('redirect_uri') !== rec.redirectUri) return send(400, { error: 'invalid_grant' });
      if (p.behave.error) return send(400, { error: p.behave.error });
      const claims = { iss: p.issuer, aud: clientId, sub: 'user-1', email: 'dale@example.com', nonce: p.behave.wrongNonce ? 'not-yours' : rec.nonce, exp: p.issuedExp };
      return send(200, {
        ...(p.behave.omitIdToken ? {} : { id_token: await (opts.sign ?? fakeJwt)(claims) }),
        access_token: 'access-1',
        ...(p.behave.noRefreshToken ? {} : { refresh_token: 'refresh-1' }),
        expires_in: 3600,
      });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  p.issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  p.log = log;
  p.close = () => new Promise<void>((r) => server.close(() => r()));
  /** Plays the browser: the person approves, and the provider sends them to the redirect with a code. */
  p.openBrowser = async (raw) => {
    const url = new URL(raw);
    const q = url.searchParams;
    log.authorize.push(q);
    assert(url.origin === p.issuer && url.pathname === '/authorize', 'authorize url');
    assert(q.get('client_id') === clientId && q.get('response_type') === 'code' && q.get('code_challenge_method') === 'S256', 'oauth params');
    const redirect = new URL(q.get('redirect_uri')!);
    assert(redirect.hostname === '127.0.0.1' && redirect.pathname === '/callback', 'loopback redirect');
    const back = new URL(redirect);
    if (p.behave.strayRequestFirst) await fetch(`${redirect.origin}/callback?code=forged&state=wrong`);
    if (p.behave.error) back.searchParams.set('error', 'access_denied');
    else {
      const code = `code-${++n}`;
      codes.set(code, { challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce')! });
      back.searchParams.set('code', code);
    }
    back.searchParams.set('state', q.get('state')!);
    if (p.behave.error) { /* the provider sends the person back with an error, not a token error */ }
    await fetch(back);
  };
  return p;
}

function assert(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(`fake provider: ${what}`);
}
