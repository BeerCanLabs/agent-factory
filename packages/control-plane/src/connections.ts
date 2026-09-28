/**
 * Keymaster connections API (DESIGN_AUTHORITY.md §6.11 K1–K4).
 *
 *   GET  /api/v1/connections/:agentId/:provider/start?scopes=…   admin → 302 to the provider's consent page (K2)
 *   GET  /api/v1/connections/:provider/callback?code&state        provider redirect; the signed state is the auth
 *   POST /api/v1/connections/:agentId/:provider/import           admin: import an existing authorized-user credential
 *   GET  /api/v1/connections/:agentId                             viewer: connections, scopes, status (never tokens)
 *   POST /api/v1/gateway/connections/token                        gateway only: access token for a live run (K3/K4)
 */
import http from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ConnectionKeymaster, connectionProvider, grantSecretName, type Grant } from '@beercanlabs/factory-keymaster';
import { authenticate, json, readJson, type FactoryState } from './app.js';
import { isTerminal } from './runs.js';

const STATE_TTL_MS = 10 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

export function getConnections(state: FactoryState): ConnectionKeymaster {
  if (!state.connections) {
    state.connections = new ConnectionKeymaster({ providers: state.providers, ledger: state.ledger, secretValues: state.secretValues });
  }
  return state.connections;
}

/** The factory's public origin (e.g. https://factory.example.com); set by the landing zone. Never hard-coded. */
function publicBase(state: FactoryState): string | undefined {
  return state.publicBaseUrl?.replace(/\/$/, '') || undefined;
}

export function connectUrl(state: FactoryState, agentId: string, provider: string): string {
  const path = `/api/v1/connections/${encodeURIComponent(agentId)}/${encodeURIComponent(provider)}/start`;
  const base = publicBase(state);
  return base ? `${base}${path}` : path;
}

const callbackUrl = (base: string, provider: string) => `${base}/api/v1/connections/${provider}/callback`;

// ---- signed consent state ----------------------------------------------------------------------

type ConsentState = { agentId: string; provider: string; scopes: string[]; actor: string; nonce: string; exp: number };

function stateKey(state: FactoryState): Buffer | undefined {
  const key = state.connectionStateKey ?? state.callbacks.signingKey;
  // Domain-separated from the key's other uses (callback signatures).
  return key ? createHmac('sha256', key).update('factory:keymaster:connection-state:v1').digest() : undefined;
}

export function signConsentState(key: Buffer, payload: ConsentState): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
}

export function verifyConsentState(key: Buffer, token: string, now = Date.now()): ConsentState | undefined {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return undefined;
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ConsentState;
    if (typeof p.exp !== 'number' || p.exp < now) return undefined;
    if (typeof p.agentId !== 'string' || typeof p.provider !== 'string' || !Array.isArray(p.scopes) || typeof p.nonce !== 'string') return undefined;
    return p;
  } catch {
    return undefined;
  }
}

/** Consent states already redeemed (replay protection), kept until they would have expired anyway. */
const usedNonces = new Map<string, number>();
function redeem(nonce: string, exp: number): boolean {
  const now = Date.now();
  for (const [n, e] of usedNonces) if (e < now) usedNonces.delete(n);
  if (usedNonces.has(nonce)) return false;
  usedNonces.set(nonce, exp);
  return true;
}

// ---- helpers -----------------------------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(res: http.ServerResponse, status: number, title: string, message: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>` +
    `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`);
}

function parseScopes(raw: string | null): string[] {
  return raw ? [...new Set(raw.split(/[\s,]+/).filter(Boolean))] : [];
}

function declaredScopes(state: FactoryState, agentId: string, provider: string): string[] {
  return state.agents.get(agentId)?.connections?.find((c) => c.provider === provider)?.scopes ?? [];
}

// ---- routes ------------------------------------------------------------------------------------

/** Handles the connections API. Returns false when the path is not one of its routes. */
export async function handleConnections(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://factory.local');

  if (path === '/api/v1/gateway/connections/token' && req.method === 'POST') {
    await tokenForGateway(state, req, res);
    return true;
  }

  const cb = path.match(/^\/api\/v1\/connections\/([a-z0-9-]+)\/callback$/i);
  if (cb && req.method === 'GET') {
    await callback(state, res, cb[1], url);
    return true;
  }

  const start = path.match(/^\/api\/v1\/connections\/([^/]+)\/([^/]+)\/start$/);
  if (start && req.method === 'GET') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;
    const [agentId, provider] = [decodeURIComponent(start[1]), decodeURIComponent(start[2])];
    const def = connectionProvider(provider);
    if (!def || def.kind !== 'oauth-user') return json(res, 404, { error: 'unknown_provider', provider }), true;
    if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const base = publicBase(state);
    const key = stateKey(state);
    if (!base || !key) return json(res, 503, { error: 'connections_unconfigured', message: 'FACTORY_PUBLIC_BASE_URL and a factory signing key are required' }), true;
    const scopes = url.searchParams.has('scopes') ? parseScopes(url.searchParams.get('scopes')) : declaredScopes(state, agentId, provider);
    if (!scopes.length) return json(res, 400, { error: 'scopes_required', message: `no scopes given and ${agentId} declares none for ${provider}` }), true;
    const client = await getConnections(state).oauthClient(def.clientSecret);
    if (!client) return json(res, 503, { error: 'oauth_client_unconfigured', secret: def.clientSecret }), true;
    const signed = signConsentState(key, { agentId, provider, scopes, actor: principal.actor, nonce: randomUUID(), exp: Date.now() + STATE_TTL_MS });
    const consent = new URL(def.authUrl);
    const params: Record<string, string> = {
      client_id: client.client_id,
      redirect_uri: callbackUrl(base, provider),
      response_type: 'code',
      scope: scopes.join(' '),
      state: signed,
      ...def.authParams,
    };
    for (const [k, v] of Object.entries(params)) consent.searchParams.set(k, v);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'CONNECTION_CONSENT_STARTED', actor: principal.actor, provider, scopes });
    res.writeHead(302, { Location: consent.toString(), 'Cache-Control': 'no-store' });
    res.end();
    return true;
  }

  const imp = path.match(/^\/api\/v1\/connections\/([^/]+)\/([^/]+)\/import$/);
  if (imp && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;
    await importGrant(state, res, decodeURIComponent(imp[1]), decodeURIComponent(imp[2]), await readJson(req), principal.actor);
    return true;
  }

  const list = path.match(/^\/api\/v1\/connections\/([^/]+)$/);
  if (list && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return true;
    const agentId = decodeURIComponent(list[1]);
    const agent = state.agents.get(agentId);
    if (!agent) return json(res, 404, { error: 'not_found' }), true;
    const connections = await getConnections(state).listGrants(agentId);
    json(res, 200, {
      agentId,
      declared: agent.connections ?? [],
      connections: connections.map((c) => ({ ...c, ...(c.status === 'needs_reconsent' ? { connectUrl: connectUrl(state, agentId, c.provider) } : {}) })),
    });
    return true;
  }

  return false;
}

async function callback(state: FactoryState, res: http.ServerResponse, provider: string, url: URL) {
  const key = stateKey(state);
  const base = publicBase(state);
  const def = connectionProvider(provider);
  if (!key || !base || !def || def.kind !== 'oauth-user') return page(res, 404, 'Not found', 'Unknown connection provider.');
  const parsed = verifyConsentState(key, url.searchParams.get('state') ?? '');
  if (!parsed || parsed.provider !== provider) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'unknown', type: 'action', action: 'CONNECTION_CALLBACK_REJECTED', actor: 'anonymous', provider });
    return page(res, 400, 'Connection failed', 'This link is invalid or has expired. Start again from the factory.');
  }
  if (url.searchParams.get('error')) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: parsed.agentId, type: 'action', action: 'CONNECTION_CONSENT_DECLINED', actor: parsed.actor, provider });
    return page(res, 400, 'Connection not made', `${def.provider} did not grant access. Nothing was changed.`);
  }
  const code = url.searchParams.get('code');
  if (!code) return page(res, 400, 'Connection failed', 'The provider did not return an authorization code.');
  if (!redeem(parsed.nonce, parsed.exp)) return page(res, 400, 'Connection failed', 'This link was already used. Start again from the factory.');
  if (!state.agents.has(parsed.agentId)) return page(res, 404, 'Connection failed', 'That agent no longer exists.');

  const km = getConnections(state);
  const out = await km.exchangeCode(provider, { code, redirectUri: callbackUrl(base, provider) });
  if (!out.ok) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: parsed.agentId, type: 'action', action: 'CONNECTION_CALLBACK_FAILED', actor: parsed.actor, provider });
    return page(res, 502, 'Connection failed', `The token exchange failed (${out.error}). Start again from the factory.`);
  }
  const grant: Grant = {
    provider,
    clientRef: out.clientRef,
    refreshToken: out.refreshToken,
    scopes: out.scopes.length ? out.scopes : parsed.scopes,
    accessToken: out.accessToken,
    expiresAt: out.expiresAt,
    obtainedAt: new Date().toISOString(),
    grantedBy: parsed.actor,
    status: 'active',
  };
  await km.saveGrant(parsed.agentId, grant);
  // K2: who granted what, and when. Never tokens.
  state.ledger.append({ timestamp: grant.obtainedAt, agentId: parsed.agentId, type: 'action', action: 'CONNECTION_GRANTED', actor: parsed.actor, provider, scopes: grant.scopes });
  const agentName = state.agents.get(parsed.agentId)?.name ?? parsed.agentId;
  page(res, 200, `Connected ${def.provider === 'google' ? 'Google' : def.provider} for ${agentName}`, 'You can close this window.');
}

type AuthorizedUser = { client_id?: string; client_secret?: string; refresh_token?: string; scopes?: string[] | string; scope?: string; token_uri?: string };

async function importGrant(state: FactoryState, res: http.ServerResponse, agentId: string, provider: string, body: Record<string, unknown>, actor: string) {
  const def = connectionProvider(provider);
  if (!def || def.kind !== 'oauth-user') return json(res, 404, { error: 'unknown_provider', provider });
  if (!state.agents.has(agentId) || !SLUG.test(agentId)) return json(res, 404, { error: 'not_found' });
  const secretRef = typeof body.secretRef === 'string' ? body.secretRef : undefined;
  const clientSecretRef = typeof body.clientSecretRef === 'string' ? body.clientSecretRef : undefined;
  if (!secretRef) return json(res, 400, { error: 'secretRef required' });
  const km = getConnections(state);
  const raw = await km.readSecret(secretRef);
  if (!raw) return json(res, 404, { error: 'secret_not_found', secretRef });
  let cred: AuthorizedUser;
  try {
    cred = JSON.parse(raw) as AuthorizedUser;
  } catch {
    return json(res, 400, { error: 'secret_not_json', secretRef });
  }
  if (typeof cred.refresh_token !== 'string' || !cred.refresh_token) return json(res, 400, { error: 'no_refresh_token', secretRef });
  if (cred.token_uri && new URL(cred.token_uri).hostname !== new URL(def.tokenUrl).hostname) return json(res, 400, { error: 'token_uri_mismatch' });
  const scopes = Array.isArray(cred.scopes) ? cred.scopes : typeof cred.scopes === 'string' ? parseScopes(cred.scopes) : parseScopes(cred.scope ?? null);

  // The refresh token is bound to the client that issued it; keep that client as a Keymaster-held app credential.
  let clientRef: string;
  if (clientSecretRef) {
    if (!(await km.oauthClient(clientSecretRef))) return json(res, 400, { error: 'client_secret_not_found', clientSecretRef });
    clientRef = clientSecretRef;
  } else {
    if (!cred.client_id || !cred.client_secret) return json(res, 400, { error: 'no_client', message: 'the credential has no client_id/client_secret; pass clientSecretRef' });
    const existing = await km.oauthClient(def.clientSecret);
    const client = JSON.stringify({ client_id: cred.client_id, client_secret: cred.client_secret });
    if (!existing) {
      await km.writeSecret(def.clientSecret, client);
      clientRef = def.clientSecret;
    } else if (existing.client_id === cred.client_id) {
      clientRef = def.clientSecret;
    } else {
      clientRef = `${grantSecretName(agentId, provider)}-client`;
      await km.writeSecret(clientRef, client);
    }
  }
  const grant: Grant = { provider, clientRef, refreshToken: cred.refresh_token, scopes, obtainedAt: new Date().toISOString(), grantedBy: actor, status: 'active' };
  await km.saveGrant(agentId, grant);
  state.ledger.append({ timestamp: grant.obtainedAt, agentId, type: 'action', action: 'CONNECTION_IMPORTED', actor, provider, scopes });
  json(res, 201, { agentId, ...ConnectionKeymaster.view(grant), clientRef });
}

async function tokenForGateway(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse) {
  const principal = await authenticate(req, res, state, 'gateway');
  if (!principal) return;
  // Only the gateway injects tokens (K3): an admin token is not enough.
  if (!principal.roles.includes('gateway')) return json(res, 403, { error: 'forbidden', required: 'gateway' });
  const b = await readJson(req);
  const runId = typeof b.runId === 'string' ? b.runId : undefined;
  const agentId = typeof b.agentId === 'string' ? b.agentId : undefined;
  const connection = typeof b.connection === 'string' ? b.connection : undefined;
  const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s): s is string => typeof s === 'string') : [];
  if (!runId || !agentId || !connection) return json(res, 400, { error: 'runId, agentId, connection required' });
  const run = state.runs.get(runId);
  if (!run || run.agentId !== agentId || isTerminal(run.state)) return json(res, 403, { error: 'run_not_live' });
  const def = connectionProvider(connection);
  if (!def) return json(res, 400, { error: 'unknown_connection', connection });
  const out = await getConnections(state).accessToken(agentId, connection, scopes);
  if (out.ok) return json(res, 200, { accessToken: out.accessToken, expiresAt: out.expiresAt });
  if (out.error === 'needs_reconsent') {
    return json(res, 428, { error: 'needs_reconsent', provider: out.provider, connectUrl: connectUrl(state, agentId, out.provider) });
  }
  console.error(`[keymaster] ${agentId}/${connection}: ${out.error}: ${out.message}`);
  return json(res, out.error === 'connection_unavailable' ? 502 : 503, { error: out.error });
}
