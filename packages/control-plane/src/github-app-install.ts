/**
 * E5.1b (#316): install an agent's GitHub App on the orgs an admin picks, and mint short-lived installation keys.
 *
 *   POST /api/v1/keymaster/agents/:agentId/github-app/installations   credentials.agent.set: { orgs } → install links
 *   POST /api/v1/gatekeeper-egress/github-app/token                      gatekeeper-egress only: { runId, agentId, org? }
 *                                                                        (no org: the app's only chosen org, GAP-256)
 *
 * The chosen orgs are recorded (not secret) beside the registry. A key is minted only for a chosen org and a live run
 * of that agent, from the app key the manifest flow stored (E5.1a); it is returned to the gatekeeper-egress only,
 * redacted everywhere, and cached until five minutes before GitHub expires it.
 */
import http from 'node:http';
import { createSign } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal } from '@beercanlabs/factory-property-manager';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { githubAppSecretNames } from './github-app-setup.js';
import { agentPath, readSecret, readSecretCached, registerAppSetupProvider } from './app-setup-providers.js';

const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_ORGS = 50;
const EARLY_MS = 5 * 60_000;

const apiBase = (s: FactoryState) => (s.githubApiBase ?? 'https://api.github.com').replace(/\/$/, '');
const webBase = (s: FactoryState) => (s.githubWebBase ?? 'https://github.com').replace(/\/$/, '');
const orgsDir = (s: FactoryState) => (s.registryDir ? join(s.registryDir, 'github-apps') : undefined);

/** The orgs an admin chose for this agent's app; empty when none were chosen. */
export function chosenOrgs(state: FactoryState, agentId: string): string[] {
  const d = orgsDir(state);
  if (!d) return [];
  try {
    const v = JSON.parse(readFileSync(join(d, `${agentId}.json`), 'utf8')) as { orgs?: unknown };
    return Array.isArray(v.orgs) ? v.orgs.filter((o): o is string => typeof o === 'string') : [];
  } catch {
    return [];
  }
}

/** A GitHub App JWT (RS256), valid ten minutes and backdated one for clock skew. */
export function appJwt(appId: string, pem: string, now = Date.now()): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(now / 1000) - 60;
  const body = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat, exp: iat + 600, iss: appId })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(pem).toString('base64url')}`;
}

type Minted = { token: string; expiresAt: string };
type MintResult = ({ ok: true } & Minted) | { ok: false; status: number; error: string };
const cache = new WeakMap<FactoryState, Map<string, Minted>>();
/** #501: one mint per agent and org at a time; later callers share it. */
const minting = new WeakMap<FactoryState, Map<string, Promise<MintResult>>>();
/** #501: installation ids per agent, org and app id. Stable while the app stays installed; dropped on any refusal. */
const installations = new WeakMap<FactoryState, Map<string, number>>();
/** #501: each GitHub call gets its own limit, so a stalled call ends instead of hanging the mint. */
export const GITHUB_CALL_TIMEOUT_MS = 8_000;
/** #501: how long the token route waits for a mint; under the gatekeeper-egress's 10 s call limit. */
export const TOKEN_ROUTE_DEADLINE_MS = 8_000;

const mapOf = <V>(m: WeakMap<FactoryState, Map<string, V>>, s: FactoryState): Map<string, V> => {
  const v = m.get(s) ?? new Map<string, V>();
  m.set(s, v);
  return v;
};

/** Mint (or reuse) an installation key for a chosen org. Errors carry codes only, never key material. */
export async function mintInstallationToken(state: FactoryState, agentId: string, org: string): Promise<MintResult> {
  const lower = org.toLowerCase();
  if (!chosenOrgs(state, agentId).some((o) => o.toLowerCase() === lower)) return { ok: false, status: 403, error: 'org_not_chosen' };
  const key = `${agentId}/${lower}`;
  const hit = mapOf(cache, state).get(key);
  if (hit && Date.parse(hit.expiresAt) - EARLY_MS > Date.now()) return { ok: true, ...hit };
  const inFlight = mapOf(minting, state);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = mint(state, agentId, org, key).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function mint(state: FactoryState, agentId: string, org: string, key: string): Promise<MintResult> {
  const t0 = Date.now();
  const phases: string[] = [];
  const lap = (name: string, since: number) => (phases.push(`${name} ${Date.now() - since} ms`), Date.now());
  const done = (out: MintResult): MintResult => {
    // #501: one line per mint: agent, org, outcome and where the time went. Never a key or key material.
    console.log(`[github-app] token ${agentId}/${org}: ${out.ok ? 'minted' : out.error} in ${Date.now() - t0} ms (${phases.join(', ')})`);
    return out;
  };
  const names = githubAppSecretNames(agentId);
  // #501: both app secrets at once, through the short-lived secret cache (each uncached read spawns the AWS CLI).
  const [appId, pem] = await Promise.all([readSecretCached(state, names.id), readSecretCached(state, names.privateKey)]);
  let t = lap('secrets', t0);
  if (!appId || !pem) return done({ ok: false, status: 428, error: 'github_app_missing' });
  const instKey = `${key}/${appId}`;
  const known = mapOf(installations, state);
  try {
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${appJwt(appId, pem)}` };
    let id = known.get(instKey);
    if (id === undefined) {
      const inst = await fetch(`${apiBase(state)}/orgs/${encodeURIComponent(org)}/installation`, { headers, signal: AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS) });
      t = lap('installation', t);
      if (inst.status === 404) return done({ ok: false, status: 428, error: 'not_installed' });
      if (!inst.ok) return done({ ok: false, status: 502, error: 'github_unavailable' });
      const body = (await inst.json()) as { id?: unknown };
      if (typeof body.id !== 'number') return done({ ok: false, status: 502, error: 'github_unavailable' });
      id = body.id;
    } else t = lap('installation cached', t);
    const tok = await fetch(`${apiBase(state)}/app/installations/${id}/access_tokens`, { method: 'POST', headers, signal: AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS) });
    lap('token', t);
    if (tok.status !== 201) {
      known.delete(instKey);
      return done({ ok: false, status: 502, error: 'github_unavailable' });
    }
    const { token, expires_at } = (await tok.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof token !== 'string' || typeof expires_at !== 'string') return done({ ok: false, status: 502, error: 'github_unavailable' });
    known.set(instKey, id);
    state.secretValues.add(token);
    const minted = { token, expiresAt: expires_at };
    mapOf(cache, state).set(key, minted);
    return done({ ok: true, ...minted });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return done({ ok: false, status: timedOut ? 504 : 502, error: timedOut ? 'github_timeout' : 'github_unavailable' });
  }
}

/**
 * #501: a mint bounded by the route deadline. A mint that outlasts it keeps running and caches its key, so the
 * caller's next request is served from the cache; this request gets a 504 the gatekeeper-egress logs.
 */
async function mintWithin(state: FactoryState, agentId: string, org: string, ms: number): Promise<MintResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<MintResult>((resolve) => {
    timer = setTimeout(() => {
      console.error(`[github-app] token ${agentId}/${org}: not ready after ${ms} ms; the mint continues and caches its key`);
      resolve({ ok: false, status: 504, error: 'github_app_token_slow' });
    }, ms);
  });
  try {
    return await Promise.race([mintInstallationToken(state, agentId, org), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Handles the install and token routes. Returns false when the path is not one of them. */
export async function handleGitHubAppInstall(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const inst = path.match(/^\/api\/v1\/keymaster\/agents\/([a-z0-9-]+)\/github-app\/installations$/);
  if (inst && req.method === 'POST') {
    const agentId = inst[1];
    const principal = await requirePrivilege(req, res, state, 'credentials.agent.set', { agentId });
    if (!principal) return true;
    if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const b = await readJson(req);
    const orgs = Array.isArray(b.orgs) ? [...new Set(b.orgs.filter((o): o is string => typeof o === 'string'))] : [];
    if (!orgs.length || orgs.length > MAX_ORGS || !orgs.every((o) => ORG.test(o))) return json(res, 400, { error: 'orgs_invalid', message: `send {"orgs": ["org", ...]}, 1 to ${MAX_ORGS} GitHub org names` }), true;
    const slug = await readSecret(state, githubAppSecretNames(agentId).slug);
    if (!slug) return json(res, 428, { error: 'github_app_missing', message: 'create the agent\'s GitHub App first' }), true;
    const d = orgsDir(state);
    if (!d) return json(res, 503, { error: 'no_registry_dir' }), true;
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${agentId}.json`), JSON.stringify({ orgs, by: principal.actor, at: new Date().toISOString() }, null, 2));
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'GITHUB_APP_ORGS_CHOSEN', actor: principal.actor, orgs });
    const installUrl = `${webBase(state)}/apps/${encodeURIComponent(slug)}/installations/new`;
    json(res, 200, { agentId, orgs: orgs.map((org) => ({ org, installUrl })) });
    return true;
  }

  if (path === '/api/v1/gatekeeper-egress/github-app/token' && req.method === 'POST') {
    // Exclusive to the gatekeeper-egress, like connection tokens (K3): an admin token is not enough.
    if (!(await requirePrivilege(req, res, state, 'egress.connections.token'))) return true;
    const b = await readJson(req);
    const runId = typeof b.runId === 'string' ? b.runId : undefined;
    const agentId = typeof b.agentId === 'string' ? b.agentId : undefined;
    // GAP-256: a GraphQL call has no owner in its path. Without an org, the app's only chosen org is used; with two or
    // more chosen there is no safe guess, so the call keeps the route's own credential.
    const chosen = typeof agentId === 'string' ? chosenOrgs(state, agentId) : [];
    const org = b.org === undefined ? (chosen.length === 1 ? chosen[0] : undefined) : typeof b.org === 'string' && ORG.test(b.org) ? b.org : undefined;
    if (!runId || !agentId) return json(res, 400, { error: 'runId, agentId, org required' }), true;
    if (!org) return json(res, b.org === undefined ? 409 : 400, { error: b.org === undefined ? 'org_ambiguous' : 'runId, agentId, org required' }), true;
    const run = state.runs.get(runId);
    // #334: a helper run borrows its parent's app key (the gatekeeper keeps it read-only), only while both runs are live.
    const parentRun = run?.parentAgentId === agentId && run.parentRunId ? state.runs.get(run.parentRunId) : undefined;
    const own = run?.agentId === agentId;
    const borrowed = Boolean(parentRun && !isTerminal(parentRun.state));
    if (!run || (!own && !borrowed) || isTerminal(run.state)) return json(res, 403, { error: 'run_not_live' }), true;
    const out = await mintWithin(state, agentId, org, state.githubAppTokenDeadlineMs ?? TOKEN_ROUTE_DEADLINE_MS);
    if (!out.ok) return json(res, out.status, { error: out.error }), true;
    res.setHeader('Cache-Control', 'no-store');
    json(res, 200, { accessToken: out.token, expiresAt: out.expiresAt, org });
    return true;
  }
  return false;
}

// E5.3: GitHub through the shared setup pattern; its routes above and in github-app-setup.ts are unchanged.
registerAppSetupProvider({
  id: 'github',
  title: 'GitHub App',
  steps: (_s, agentId) => [
    { id: 'create', manual: false, text: 'Create this agent\'s own GitHub App from a prefilled manifest (optionally under an org), then approve it on GitHub. The factory stores its key.', action: { kind: 'browser-post', path: agentPath(agentId, 'github-app/start'), input: 'org', postField: 'manifest' } },
    { id: 'orgs', manual: false, text: 'Choose the orgs the app is for (comma-separated). Keys are minted only for these.', action: { kind: 'list', path: agentPath(agentId, 'github-app/installations'), input: 'orgs' } },
    { id: 'install', manual: true, text: 'Open the install link and install the app on each chosen org.' },
  ],
  async status(state, agentId) {
    const slug = await readSecret(state, githubAppSecretNames(agentId).slug);
    return slug ? { configured: true, links: [{ label: 'Install the app on an org', url: `${webBase(state)}/apps/${encodeURIComponent(slug)}/installations/new` }] } : { configured: false };
  },
});
