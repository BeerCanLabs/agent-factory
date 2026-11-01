/**
 * E5.1b (#316): install an agent's GitHub App on the orgs an admin picks, and mint short-lived installation keys.
 *
 *   POST /api/v1/keymaster/agents/:agentId/github-app/installations   credentials.agent.set: { orgs } → install links
 *   POST /api/v1/gatekeeper-egress/github-app/token                      gatekeeper-egress only: { runId, agentId, org }
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
import { agentPath, readSecret, registerAppSetupProvider } from './app-setup-providers.js';

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
const cache = new WeakMap<FactoryState, Map<string, Minted>>();

/** Mint (or reuse) an installation key for a chosen org. Errors carry codes only, never key material. */
export async function mintInstallationToken(state: FactoryState, agentId: string, org: string): Promise<{ ok: true } & Minted | { ok: false; status: number; error: string }> {
  const lower = org.toLowerCase();
  if (!chosenOrgs(state, agentId).some((o) => o.toLowerCase() === lower)) return { ok: false, status: 403, error: 'org_not_chosen' };
  const c = cache.get(state) ?? new Map<string, Minted>();
  cache.set(state, c);
  const hit = c.get(`${agentId}/${lower}`);
  if (hit && Date.parse(hit.expiresAt) - EARLY_MS > Date.now()) return { ok: true, ...hit };
  const names = githubAppSecretNames(agentId);
  const [appId, pem] = [await readSecret(state, names.id), await readSecret(state, names.privateKey)];
  if (!appId || !pem) return { ok: false, status: 428, error: 'github_app_missing' };
  try {
    const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${appJwt(appId, pem)}` };
    const inst = await fetch(`${apiBase(state)}/orgs/${encodeURIComponent(org)}/installation`, { headers });
    if (inst.status === 404) return { ok: false, status: 428, error: 'not_installed' };
    if (!inst.ok) return { ok: false, status: 502, error: 'github_unavailable' };
    const { id } = (await inst.json()) as { id?: unknown };
    if (typeof id !== 'number') return { ok: false, status: 502, error: 'github_unavailable' };
    const tok = await fetch(`${apiBase(state)}/app/installations/${id}/access_tokens`, { method: 'POST', headers });
    if (tok.status !== 201) return { ok: false, status: 502, error: 'github_unavailable' };
    const { token, expires_at } = (await tok.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof token !== 'string' || typeof expires_at !== 'string') return { ok: false, status: 502, error: 'github_unavailable' };
    state.secretValues.add(token);
    const minted = { token, expiresAt: expires_at };
    c.set(`${agentId}/${lower}`, minted);
    return { ok: true, ...minted };
  } catch {
    return { ok: false, status: 502, error: 'github_unavailable' };
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
    const org = typeof b.org === 'string' && ORG.test(b.org) ? b.org : undefined;
    if (!runId || !agentId || !org) return json(res, 400, { error: 'runId, agentId, org required' }), true;
    const run = state.runs.get(runId);
    // #334: a helper run borrows its parent's app key (the gatekeeper keeps it read-only), only while both runs are live.
    const parentRun = run?.parentAgentId === agentId && run.parentRunId ? state.runs.get(run.parentRunId) : undefined;
    const own = run?.agentId === agentId;
    const borrowed = Boolean(parentRun && !isTerminal(parentRun.state));
    if (!run || (!own && !borrowed) || isTerminal(run.state)) return json(res, 403, { error: 'run_not_live' }), true;
    const out = await mintInstallationToken(state, agentId, org);
    if (!out.ok) return json(res, out.status, { error: out.error }), true;
    res.setHeader('Cache-Control', 'no-store');
    json(res, 200, { accessToken: out.token, expiresAt: out.expiresAt });
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
