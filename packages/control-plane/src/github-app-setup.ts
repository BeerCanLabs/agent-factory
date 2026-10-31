/**
 * E5.1 (#291): an agent's own GitHub App, created from a prefilled manifest (GitHub's app-manifest flow).
 *
 *   POST /api/v1/keymaster/agents/:agentId/github-app/start   credentials.agent.set → { action, manifest, state }
 *   GET  /api/v1/keymaster/github-app/callback?code&state      GitHub redirect; the signed one-time state is the auth
 *
 * The console posts `manifest` to `action`; the admin approves on GitHub, which redirects back with a code. The factory
 * converts the code and writes the app's id, private key and webhook secret through the existing secret store. No value
 * is returned, logged or ledgered. Each named agent gets its own app (secret names carry the agent id), and a company's
 * apps live in its own factory's secret store.
 */
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { writableProvider } from '@beercanlabs/factory-secrets-bind';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { signConsentState, verifyConsentState } from './connections.js';
import { invalidateCredentials } from './credentials.js';

const STATE_TTL_MS = 10 * 60_000;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Secret names for an agent's app. Per agent, so two agents never share an app. */
export function githubAppSecretNames(agentId: string) {
  const p = `GITHUB_APP_${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return { id: `${p}_ID`, slug: `${p}_SLUG`, privateKey: `${p}_PRIVATE_KEY`, webhookSecret: `${p}_WEBHOOK_SECRET` };
}

const base = (s: FactoryState) => s.publicBaseUrl?.replace(/\/$/, '') || undefined;
const apiBase = (s: FactoryState) => (s.githubApiBase ?? 'https://api.github.com').replace(/\/$/, '');
const webBase = (s: FactoryState) => (s.githubWebBase ?? 'https://github.com').replace(/\/$/, '');

function stateKey(s: FactoryState): Buffer | undefined {
  const key = s.connectionStateKey ?? s.callbacks?.signingKey;
  return key ? createHmac('sha256', key).update('factory:keymaster:github-app-state:v1').digest() : undefined;
}

/** The manifest GitHub prefills. Permissions are what a coding agent needs; the admin can narrow them on GitHub. */
export function buildManifest(publicBase: string, agentId: string, agentName: string) {
  return {
    // GitHub App names are global: qualify the agent's name with this factory's host so the default is rarely taken.
    name: `${agentName} (${new URL(publicBase).hostname.split('.')[0]})`.slice(0, 34),
    url: publicBase,
    redirect_url: `${publicBase}/api/v1/keymaster/github-app/callback`,
    public: false,
    hook_attributes: { url: `${publicBase}/api/v1/github-app/${encodeURIComponent(agentId)}/webhook`, active: false },
    default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
    default_events: [] as string[],
  };
}

const used = new Map<string, number>();
function redeem(nonce: string, exp: number): boolean {
  const now = Date.now();
  for (const [n, e] of used) if (e < now) used.delete(n);
  if (used.has(nonce)) return false;
  used.set(nonce, exp);
  return true;
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function page(res: http.ServerResponse, status: number, title: string, message: string) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto"><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`);
}

/** Handles the GitHub App setup routes. Returns false when the path is not one of them. */
export async function handleGitHubAppSetup(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const start = path.match(/^\/api\/v1\/keymaster\/agents\/([a-z0-9-]+)\/github-app\/start$/);
  if (start && req.method === 'POST') {
    const agentId = start[1];
    const principal = await requirePrivilege(req, res, state, 'credentials.agent.set', { agentId });
    if (!principal) return true;
    const agent = state.agents.get(agentId);
    if (!agent) return json(res, 404, { error: 'not_found' }), true;
    const pub = base(state);
    const key = stateKey(state);
    if (!pub || !key) return json(res, 503, { error: 'github_app_setup_unconfigured', message: 'FACTORY_PUBLIC_BASE_URL and a factory signing key are required' }), true;
    const body = await readJson(req);
    const org = typeof body.org === 'string' && body.org ? body.org : undefined;
    if (org !== undefined && !ORG.test(org)) return json(res, 400, { error: 'invalid_org' }), true;
    const signed = signConsentState(key, { agentId, provider: 'github-app', scopes: [], actor: principal.actor, nonce: randomUUID(), exp: Date.now() + STATE_TTL_MS });
    const where = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : '/settings/apps/new';
    const action = `${webBase(state)}${where}?state=${encodeURIComponent(signed)}`;
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'GITHUB_APP_SETUP_STARTED', actor: principal.actor, ...(org ? { org } : {}) });
    json(res, 200, { action, manifest: buildManifest(pub, agentId, agent.name ?? agentId), state: signed });
    return true;
  }

  if (path === '/api/v1/keymaster/github-app/callback' && req.method === 'GET') {
    await callback(state, res, new URL(req.url ?? '/', 'http://factory.local'));
    return true;
  }
  return false;
}

async function callback(state: FactoryState, res: http.ServerResponse, url: URL) {
  const key = stateKey(state);
  const parsed = key ? verifyConsentState(key, url.searchParams.get('state') ?? '') : undefined;
  if (!parsed || parsed.provider !== 'github-app') {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'unknown', type: 'action', action: 'GITHUB_APP_CALLBACK_REJECTED', actor: 'anonymous' });
    return page(res, 400, 'Setup failed', 'This link is invalid or has expired. Start again from the factory.');
  }
  const code = url.searchParams.get('code');
  if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return page(res, 400, 'Setup failed', 'GitHub did not return a code.');
  if (!redeem(parsed.nonce, parsed.exp)) return page(res, 400, 'Setup failed', 'This link was already used. Start again from the factory.');
  if (!state.agents.has(parsed.agentId)) return page(res, 404, 'Setup failed', 'That agent no longer exists.');
  const writer = writableProvider(state.providers);
  if (!writer) return page(res, 503, 'Setup failed', 'The factory has no writable secret store.');

  let app: { id?: unknown; slug?: unknown; pem?: unknown; webhook_secret?: unknown };
  try {
    const r = await fetch(`${apiBase(state)}/app-manifests/${code}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } });
    if (r.status !== 201) throw new Error(String(r.status));
    app = (await r.json()) as typeof app;
  } catch {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: parsed.agentId, type: 'action', action: 'GITHUB_APP_CALLBACK_FAILED', actor: parsed.actor });
    return page(res, 502, 'Setup failed', 'GitHub did not convert the manifest. Start again from the factory.');
  }
  if (typeof app.id !== 'number' || typeof app.slug !== 'string' || typeof app.pem !== 'string') {
    return page(res, 502, 'Setup failed', 'GitHub returned an incomplete app.');
  }
  const names = githubAppSecretNames(parsed.agentId);
  // Redact before anything else can see them (S1 backstop).
  state.secretValues.add(app.pem);
  if (typeof app.webhook_secret === 'string' && app.webhook_secret) state.secretValues.add(app.webhook_secret);
  try {
    await writer.put(names.id, String(app.id));
    await writer.put(names.slug, app.slug);
    await writer.put(names.privateKey, app.pem);
    if (typeof app.webhook_secret === 'string' && app.webhook_secret) await writer.put(names.webhookSecret, app.webhook_secret);
  } catch {
    console.error(`[keymaster] storing the GitHub App for ${parsed.agentId} failed`);
    return page(res, 502, 'Setup failed', 'The factory could not store the app key. Start again.');
  }
  for (const n of Object.values(names)) state.secretCache?.delete(n);
  invalidateCredentials(state);
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: parsed.agentId, type: 'action', action: 'GITHUB_APP_CREATED', actor: parsed.actor, appSlug: app.slug });
  page(res, 200, `GitHub App ready for ${state.agents.get(parsed.agentId)?.name ?? parsed.agentId}`, 'The app key is stored with the Keymaster. You can close this window.');
}
