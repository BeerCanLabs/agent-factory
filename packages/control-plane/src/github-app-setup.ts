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
import { invalidateSecret, readSecret } from './app-setup-providers.js';
import { forgetMintedKeys } from './github-app-install.js';
import { OWNER, legacyOrgs, readAppRecord, writeAppRecord, type OwnerType } from './github-app-owners.js';

const STATE_TTL_MS = 10 * 60_000;
const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Secret names for an agent's app. Per agent, so two agents never share an app. With an owner (an org or user login),
 * the names of that agent's app for that owner (multi-owner apps); without one, the agent's original app.
 */
export function githubAppSecretNames(agentId: string, owner?: string) {
  const a = `GITHUB_APP_${agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  const p = owner ? `${a}__OWNER_${owner.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` : a;
  return { id: `${p}_ID`, slug: `${p}_SLUG`, privateKey: `${p}_PRIVATE_KEY`, webhookSecret: `${p}_WEBHOOK_SECRET` };
}

const base = (s: FactoryState) => s.publicBaseUrl?.replace(/\/$/, '') || undefined;
const apiBase = (s: FactoryState) => (s.githubApiBase ?? 'https://api.github.com').replace(/\/$/, '');
const webBase = (s: FactoryState) => (s.githubWebBase ?? 'https://github.com').replace(/\/$/, '');

function stateKey(s: FactoryState): Buffer | undefined {
  const key = s.connectionStateKey ?? s.callbacks?.signingKey;
  return key ? createHmac('sha256', key).update('factory:keymaster:github-app-state:v1').digest() : undefined;
}

/**
 * GAP-257: the events an app sends to its agent's own webhook (`/hooks/:agentId`, signed with the app's webhook
 * secret), for an agent that takes app events: the SDLC conductor is event-driven only (no timer, no polling).
 * Issues and their comments, pull requests, and CI results (completed check suites, commit statuses). `check_run` is
 * not subscribed: the factory ignores it (a suite's completion is the one CI event).
 */
export const GITHUB_APP_EVENTS = ['issues', 'issue_comment', 'pull_request', 'check_suite', 'status'];
/** The skills whose agents take app events. */
export const EVENT_SKILLS = ['sdlc-conductor'];
/**
 * #483: the ops leader (`sdlc-ops`) is woken by its deploy and rollback workflows' completion instead of polling, so its
 * app also subscribes to `workflow_run` and reads Actions. An app made before this needs both added on GitHub (app
 * settings, Permissions & events: Actions read and write, and the Workflow run event), and each installation's owner must
 * approve the new permission before GitHub sends the event. Order: add the event only once the agentic-sdlc handler
 * for `workflow-completed` is deployed (a new ops app subscribes at once). An ops-only app gets `workflow_run` and
 * Actions (write, to dispatch) and nothing of the conductor's (jury #485 B2).
 */
export const WORKFLOW_SKILLS = ['sdlc-ops'];

/** What an agent's app is for, beyond the narrow default. */
export type AppNeeds = { events?: boolean; projects?: boolean; workflows?: boolean; ci?: boolean };
/** The skills that read CI results without taking events (the PR reviewer checks the head's checks and statuses). */
export const CI_READ_SKILLS = ['sdlc-reviewer'];

/**
 * GAP-257: an agent's needs, from the skills it adopted, or as the admin declares them when starting the app:
 * app events for the conductor, organization Projects for an agent with a backlog skill (`sdlc-backlog-github`).
 */
export function appNeeds(agent: { skillIds?: string[]; skillRoutes?: Record<string, unknown> }, declared: { events?: unknown; projects?: unknown; workflows?: unknown; ci?: unknown } = {}): AppNeeds {
  const skills = new Set([...(agent.skillIds ?? []), ...Object.keys(agent.skillRoutes ?? {})]);
  const workflows = declared.workflows === true || WORKFLOW_SKILLS.some((id) => skills.has(id));
  const ci = declared.ci === true || CI_READ_SKILLS.some((id) => skills.has(id));
  return {
    events: declared.events === true || EVENT_SKILLS.some((id) => skills.has(id)),
    projects: declared.projects === true || [...skills].some((id) => /(^|-)backlog(-|$)/.test(id)),
    ...(workflows ? { workflows: true } : {}),
    ...(ci ? { ci: true } : {}),
  };
}

/**
 * The manifest GitHub prefills. Permissions are what a coding agent needs; the admin can narrow them on GitHub.
 * GAP-257 (Dale, chat, 2026-11-15): only an agent that needs them gets more. An agent that takes app events gets an
 * active hook on its own `/hooks/:agentId`, the events above, and checks and statuses (read) to read CI results (the
 * ops leader also `workflow_run` and Actions write to dispatch its workflows, #483); an
 * agent with a backlog skill gets organization Projects (write) for the fleet's board.
 * GitHub rejected `public: false` plus an inactive webhook with "Public cannot be private", so the manifest never
 * sends `public` (GitHub's form then defaults to "Only on this account", a private app), and an agent that takes no
 * events gets no hook at all. Only documented manifest keys are sent.
 */
export function buildManifest(publicBase: string, agentId: string, agentName: string, needs: AppNeeds = {}, name?: string) {
  return {
    // GitHub App names are global and a created app keeps its name: qualify the agent's name with this factory's
    // host, plus a short random tag so a second Start (after a lost callback, or for a replacement) is never refused
    // with "name already taken". An admin may choose the name instead (validated by the start route).
    name: name ?? `${`${agentName} (${new URL(publicBase).hostname.split('.')[0]})`.slice(0, 29)} ${randomUUID().slice(0, 4)}`,
    url: publicBase,
    redirect_url: `${publicBase}/api/v1/keymaster/github-app/callback`,
    ...(needs.events || needs.workflows ? { hook_attributes: { url: `${publicBase}/hooks/${encodeURIComponent(agentId)}`, active: true } } : {}),
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
      ...(needs.projects ? { organization_projects: 'write' } : {}),
      // The reviewer (`sdlc-reviewer`, or `"ci": true`) reads CI results too, with no hook or events.
      ...(needs.events || needs.ci ? { checks: 'read', statuses: 'read' } : {}),
      // Dale (2026-11-18): the ops leader dispatches its deploy and rollback workflows, which GitHub allows only with
      // Actions write (read is not enough for `POST .../actions/workflows/:id/dispatches`).
      ...(needs.workflows ? { actions: 'write' } : {}),
    },
    default_events: [...(needs.events ? GITHUB_APP_EVENTS : []), ...(needs.workflows ? ['workflow_run'] : [])],
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

/** Whether a login is an org or a user, from GitHub's public `GET /users/:login` (`type`). Undefined when unknown. */
async function lookupOwnerType(state: FactoryState, login: string): Promise<OwnerType | undefined> {
  try {
    const r = await fetch(`${apiBase(state)}/users/${encodeURIComponent(login)}`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return undefined;
    const t = ((await r.json()) as { type?: unknown }).type;
    return t === 'Organization' ? 'org' : t === 'User' ? 'user' : undefined;
  } catch {
    return undefined;
  }
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
    // Multi-owner apps: `owner` (an org or user login) creates an additional app for that owner only; the agent's other
    // apps are untouched. Without `owner` this is the agent's original app, as before (`org` only says where to create it).
    let owner: string | undefined;
    let ownerType: OwnerType | undefined;
    if (body.owner !== undefined) {
      if (typeof body.owner !== 'string' || !OWNER.test(body.owner)) return json(res, 400, { error: 'invalid_owner' }), true;
      owner = body.owner.toLowerCase();
      if (body.ownerType !== undefined && body.ownerType !== 'org' && body.ownerType !== 'user') return json(res, 400, { error: 'invalid_owner_type', message: 'ownerType is "org" or "user"' }), true;
      ownerType = (body.ownerType as OwnerType | undefined) ?? (await lookupOwnerType(state, owner));
      if (!ownerType) return json(res, 502, { error: 'owner_type_unknown', message: `GitHub did not say whether ${owner} is an org or a user; send ownerType` }), true;
      // Jury #522 G1: an owner the original app already serves would get two apps, two hooks and two runs per event.
      // Only an explicit migrate moves it to its own app (the original app should then be uninstalled there). An owner
      // that already has its own app (a replace) is not served by the original app, even if it is in the chosen list.
      if (legacyOrgs(state, agentId).some((o) => o.toLowerCase() === owner) && body.migrate !== true) {
        return json(res, 409, { error: 'owner_served_by_original_app', owner, message: `${owner} is already served by this agent's original GitHub App. Send migrate:true to give it its own app instead, then uninstall the original app from ${owner}.` }), true;
      }
    }
    const migrate = Boolean(owner) && body.migrate === true;
    let name: string | undefined;
    if (body.name !== undefined) {
      // GitHub limits an app name to 34 characters; names are global, so a taken one is refused on GitHub's form.
      if (typeof body.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ()._-]{0,33}$/.test(body.name) || body.name.length > 34) return json(res, 400, { error: 'invalid_name', message: 'name: 1 to 34 letters, digits, spaces and ( ) . _ -' }), true;
      name = body.name;
    }
    // An app already stored for this agent (and owner): say so instead of sending the admin to create a second one.
    const existing = await readSecret(state, githubAppSecretNames(agentId, owner).slug);
    if (existing && body.replace !== true) {
      return json(res, 409, { error: 'github_app_exists', slug: existing, ...(owner ? { owner } : {}), installUrl: `${webBase(state)}/apps/${encodeURIComponent(existing)}/installations/new`, message: `This agent already has the GitHub App "${existing}"${owner ? ` for ${owner}` : ''}. Install it from the install link; send replace:true to create a new one.` }), true;
    }
    const org = owner ? (ownerType === 'org' ? owner : undefined) : typeof body.org === 'string' && body.org ? body.org : undefined;
    if (org !== undefined && !ORG.test(org)) return json(res, 400, { error: 'invalid_org' }), true;
    const signed = signConsentState(key, { agentId, provider: 'github-app', scopes: [], actor: principal.actor, nonce: randomUUID(), exp: Date.now() + STATE_TTL_MS, ...(owner ? { owner, ownerType } : {}), ...(migrate ? { migrate } : {}) });
    // A user-owned app is created under the signed-in GitHub user's own settings (that user must be the owner).
    const where = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : '/settings/apps/new';
    const action = `${webBase(state)}${where}?state=${encodeURIComponent(signed)}`;
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'GITHUB_APP_SETUP_STARTED', actor: principal.actor, ...(org ? { org } : {}), ...(owner ? { owner, ownerType } : {}) });
    json(res, 200, { action, manifest: buildManifest(pub, agentId, agent.name ?? agentId, appNeeds(agent, body), name), state: signed, ...(owner ? { owner, ownerType } : {}) });
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

  let app: { id?: unknown; slug?: unknown; pem?: unknown; webhook_secret?: unknown; owner?: unknown };
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
  const owner = typeof parsed.owner === 'string' && OWNER.test(parsed.owner) ? parsed.owner.toLowerCase() : undefined;
  if (owner) {
    // Jury #522 G2: the app must belong to the signed owner. A user-owned app is made under whichever GitHub user is
    // signed in, so a wrong account would otherwise be recorded as this owner's app. Checked before anything is stored.
    const got = app.owner && typeof app.owner === 'object' ? (app.owner as { login?: unknown; type?: unknown }) : {};
    const gotType = got.type === 'Organization' ? 'org' : got.type === 'User' ? 'user' : undefined;
    const wantType = parsed.ownerType === 'user' ? 'user' : 'org';
    if (typeof got.login !== 'string' || got.login.toLowerCase() !== owner || gotType !== wantType) {
      const gotLogin = typeof got.login === 'string' && OWNER.test(got.login) ? got.login : 'another account';
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: parsed.agentId, type: 'action', action: 'GITHUB_APP_OWNER_MISMATCH', actor: parsed.actor, owner, appSlug: app.slug, ...(gotLogin !== 'another account' ? { createdUnder: gotLogin } : {}) });
      return page(res, 409, 'Setup failed', `GitHub created the app "${app.slug}" under ${gotLogin}, not ${owner} (${wantType}). Nothing was stored. Delete that app on GitHub, sign in as ${owner}${wantType === 'org' ? ' (or an owner of it)' : ''}, and start again from the factory.`);
    }
  }
  const names = githubAppSecretNames(parsed.agentId, owner);
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
  for (const n of Object.values(names)) invalidateSecret(state, n);
  if (owner) {
    // Record the owner beside the others (read-modify-write): the legacy `orgs` and every other owner are kept.
    const rec = readAppRecord(state, parsed.agentId);
    rec.owners[owner] = { type: parsed.ownerType === 'user' ? 'user' : 'org', at: new Date().toISOString(), by: parsed.actor };
    // Jury #522 G1: a migrate moves the owner off the original app's chosen list.
    if (parsed.migrate === true) rec.orgs = rec.orgs.filter((o) => o.toLowerCase() !== owner);
    if (!writeAppRecord(state, parsed.agentId, rec)) console.error(`[keymaster] ${parsed.agentId}: no registry dir; the ${owner} app is stored but not recorded`);
  }
  invalidateCredentials(state);
  // Jury #522 G3: a key minted from the app this one replaces is not served from the cache.
  forgetMintedKeys(state, parsed.agentId);
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: parsed.agentId, type: 'action', action: 'GITHUB_APP_CREATED', actor: parsed.actor, appSlug: app.slug, ...(owner ? { owner } : {}), ...(owner && parsed.migrate === true ? { migrated: true } : {}) });
  page(res, 200, `GitHub App ready for ${state.agents.get(parsed.agentId)?.name ?? parsed.agentId}`, 'The app key is stored with the Keymaster. You can close this window.');
}
