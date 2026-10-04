/**
 * Keymaster credentials API (DESIGN_AUTHORITY.md §6.11 K5). The one flow every surface (dashboard, Garrison, API)
 * uses to bring an agent to zero outstanding credentials. Admin-only until owner roles exist (TSK-027).
 *
 *   GET  /api/v1/keymaster/agents/:agentId/credentials         every declared credential: status, instructions, action
 *   POST /api/v1/keymaster/agents/:agentId/credentials/:name   write-only: the body is the value; never echoed or logged
 *   GET  /api/v1/keymaster/outstanding                         outstanding count per agent (fleet view)
 *   GET  /api/v1/keymaster/platform/credentials                gatekeeper-held platform keys: status, instructions, action
 *   POST /api/v1/keymaster/platform/credentials/:name          write-only, as above; the control plane can write these but never read them
 *
 * Presence is checked without reading values where the backend allows it (secrets-bind `has`), and no value is ever
 * returned, logged, or ledgered. The ledger records only that a credential was set or rotated, by whom, and when.
 */
import http from 'node:http';
import { secretPresent, writableProvider, type SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { assessCredentials, assessPlatformCredentials, submittableSecrets, summarize, type CredentialItem, type CredentialSummary } from '@beercanlabs/factory-keymaster';
import { requirePrivilege, json, type FactoryState } from './app.js';
import { BUILTIN_AGENT_IDS, declaredCredentials, type AgentRecord } from './catalog.js';
import { consentUnavailable, getConnections } from './connections.js';

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_VALUE = 64 * 1024;
const MIN_VALUE = 8;
// Credential state changes only when someone supplies or rotates a credential, or a grant changes, and each of those
// clears the cache (invalidateCredentials). Polling dashboards must not re-check the secret manager: every check is a
// secret-manager call, and a fleet scan on each poll once starved the control plane of CPU so that live runs'
// token refreshes timed out (GAP-056).
const CREDENTIAL_TTL_MS = 10 * 60_000;

// Outstanding counts for the fleet view, per agent.
const summaries = new WeakMap<FactoryState, Map<string, { at: number; summary: Promise<CredentialSummary | undefined> }>>();
// Whether a secret exists, by name: shared by every agent that declares it (most share the same platform keys).
const presence = new WeakMap<FactoryState, Map<string, { at: number; present: Promise<boolean> }>>();

/** Forget cached credential state (after a credential is set or a grant changes). Shared credentials affect every agent. */
export function invalidateCredentials(state: FactoryState): void {
  summaries.delete(state);
  presence.delete(state);
  for (const p of state.providers) listings.delete(p);
}

/** Cached presence check; concurrent callers share one lookup, and a failed lookup is not cached. */
function cachedPresent(state: FactoryState, name: string): Promise<boolean> {
  const cache = presence.get(state) ?? new Map<string, { at: number; present: Promise<boolean> }>();
  presence.set(state, cache);
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < CREDENTIAL_TTL_MS) return hit.present;
  const present = lookupPresent(state, name);
  cache.set(name, { at: Date.now(), present });
  present.catch(() => cache.delete(name));
  return present;
}

// One listing per provider that can list (one secret-manager call, metadata only) instead of one call per secret.
const listings = new WeakMap<SecretProvider, { at: number; names: Promise<Set<string>> }>();

function listing(p: SecretProvider): Promise<Set<string>> {
  const hit = listings.get(p);
  if (hit && Date.now() - hit.at < CREDENTIAL_TTL_MS) return hit.names;
  const names = p.present!();
  listings.set(p, { at: Date.now(), names });
  names.catch(() => listings.delete(p));
  return names;
}

async function lookupPresent(state: FactoryState, name: string): Promise<boolean> {
  for (const p of state.providers) {
    if (p.present) {
      try {
        if ((await listing(p)).has(name)) return true;
        continue;
      } catch {
        // listing failed: fall back to asking this provider by name
      }
    }
    if (await secretPresent(name, [p])) return true;
  }
  return false;
}

const platformSubmitPath = (name: string) => `/api/v1/keymaster/platform/credentials/${encodeURIComponent(name)}`;

/** Built-in system actors get their credentials from the platform's own deployment, not from an owner. */
const isBuiltin = (a: AgentRecord) => Boolean(a.isBuiltin || a.category === 'builtin' || BUILTIN_AGENT_IDS.has(a.id));

export async function agentCredentials(state: FactoryState, agentId: string): Promise<CredentialItem[] | undefined> {
  const agent = state.agents.get(agentId);
  if (!agent) return undefined;
  if (isBuiltin(agent)) return [];
  const km = getConnections(state);
  const enc = encodeURIComponent(agentId);
  const base = state.publicBaseUrl?.replace(/\/$/, '') ?? '';
  const items = await assessCredentials({
    agentId,
    secrets: declaredCredentials(agent),
    connections: agent.connections ?? [],
    getProvider: (name) => state.systems?.getConnectionProvider(name),
    gatekeeperEgressHeld: state.gatekeeperEgressHeldSecrets ?? new Set(),
    present: (name) => cachedPresent(state, name),
    grant: async (provider) => (await km.listGrants(agentId, [provider]))[0],
    submitPath: (name) => `/api/v1/keymaster/agents/${enc}/credentials/${encodeURIComponent(name)}`,
    platformSubmitPath,
    consent: (provider) => {
      const path = `/api/v1/connections/${enc}/${encodeURIComponent(provider)}/start`;
      return { path, url: `${base}${path}` };
    },
    consentUnavailable: consentUnavailable(state),
  });
  const cache = summaries.get(state) ?? new Map();
  summaries.set(state, cache);
  cache.set(agentId, { at: Date.now(), summary: Promise.resolve(summarize(items)) });
  return items;
}

function summaryFor(state: FactoryState, agentId: string): Promise<CredentialSummary | undefined> {
  const cache = summaries.get(state) ?? new Map<string, { at: number; summary: Promise<CredentialSummary | undefined> }>();
  summaries.set(state, cache);
  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < CREDENTIAL_TTL_MS) return hit.summary;
  // Concurrent fleet views share one assessment per agent.
  const summary = agentCredentials(state, agentId).then((items) => (items ? summarize(items) : undefined));
  cache.set(agentId, { at: Date.now(), summary });
  summary.catch(() => cache.delete(agentId));
  return summary;
}

/** Reads the request body without ever putting it in an error message. */
function readRaw(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    let body = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      body += c.toString();
      if (body.length > MAX_VALUE + 1024) over = true;
    });
    req.on('end', () => resolve(over ? undefined : body));
    req.on('error', () => resolve(undefined));
  });
}

/** The submitted value: `{"value": "..."}` as JSON, or the raw body for any other content type. */
function submittedValue(req: http.IncomingMessage, raw: string): string | undefined {
  let value: unknown = raw;
  if (/application\/json/i.test(String(req.headers['content-type'] ?? ''))) {
    try {
      value = (JSON.parse(raw) as { value?: unknown })?.value;
    } catch {
      return undefined;
    }
  }
  return typeof value === 'string' ? value.trim() : undefined;
}

function noStore(res: http.ServerResponse, status: number, payload: unknown) {
  res.setHeader('Cache-Control', 'no-store');
  json(res, status, payload);
}

/**
 * K5.3 write-only submission. The value exists only in `value` below: it goes to the secret manager and to the
 * redaction set, and nowhere else. Responses and ledger rows carry the agent, the name, and the actor only.
 * (A conformance check in packages/conformance/src/keymaster.test.ts holds this function to that.)
 */
async function submitCredential(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string, name: string, actor: string) {
  const agent = state.agents.get(agentId);
  if (!agent) return noStore(res, 404, { error: 'not_found' });
  if (isBuiltin(agent)) return noStore(res, 409, { error: 'builtin_agent', message: 'built-in system agents get their credentials from the platform deployment' });
  if (!SECRET_NAME.test(name)) return noStore(res, 400, { error: 'invalid_name', message: 'credential names are ENV-style (A-Z, 0-9, _)' });
  const held = state.gatekeeperEgressHeldSecrets ?? new Set<string>();
  if (held.has(name)) return noStore(res, 409, { error: 'managed_by_platform', name, message: 'the factory gatekeeper-egress holds this credential for every agent; supply it as a platform credential', path: platformSubmitPath(name) });
  const allowed = submittableSecrets({
    secrets: declaredCredentials(agent),
    connections: agent.connections ?? [],
    gatekeeperEgressHeld: held,
    getProvider: (name) => state.systems?.getConnectionProvider(name),
  });
  if (!allowed.has(name)) return noStore(res, 404, { error: 'undeclared_credential', name, message: `${agentId} does not declare ${name}` });
  await writeCredential(state, req, res, agentId, name, actor);
}

/**
 * K5.3 write-only submission, shared by agent and platform credentials. The value exists only in `value` below: it
 * goes to the secret manager and to the redaction set, and nowhere else. Responses and ledger rows carry the agent
 * (or `platform`), the name, and the actor only.
 */
async function writeCredential(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string, name: string, actor: string) {
  const writer = writableProvider(state.providers);
  if (!writer) return noStore(res, 503, { error: 'no_writable_secrets_backend' });

  const raw = await readRaw(req);
  if (raw === undefined) return noStore(res, 413, { error: 'value_too_large', max: MAX_VALUE });
  const value = submittedValue(req, raw);
  if (!value) return noStore(res, 400, { error: 'value_required', message: 'send {"value": "..."} as JSON, or the value as the raw body' });
  if (value.length < MIN_VALUE || value.length > MAX_VALUE) return noStore(res, 400, { error: 'value_invalid', message: `a value is ${MIN_VALUE} to ${MAX_VALUE} characters` });

  // Redact it everywhere from now on (S1 backstop), before anything else can see it.
  state.secretValues.add(value);
  const existed = await secretPresent(name, state.providers);
  try {
    await writer.put(name, value);
  } catch {
    // The backend's error text is not trusted not to contain what was sent.
    console.error(`[keymaster] writing ${name} for ${agentId} failed`);
    return noStore(res, 502, { error: 'write_failed', name });
  }
  state.secretCache?.delete(name);
  invalidateCredentials(state);
  const action = existed ? 'CREDENTIAL_ROTATED' : 'CREDENTIAL_SET';
  const at = new Date().toISOString();
  state.ledger.append({ timestamp: at, agentId, type: 'action', action, actor, credential: name });
  noStore(res, existed ? 200 : 201, { agentId, name, status: 'present', action, at });
}

/**
 * TSK-067, K5.3: an OAuth provider's app credentials, write-only. The admin sends the client the provider issued
 * (`{client_id, client_secret}`, or a service-account key for a jwt-bearer provider); the Keymaster stores it under the
 * name the provider's approved system definition gives (`shared/<id>/oauth-client` by default). The value goes to the
 * secret manager and the redaction set only; responses and the ledger carry the system, the name and the actor.
 */
async function submitProviderClient(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, systemId: string, actor: string) {
  const def = state.systems?.getConnectionProvider(systemId);
  if (!def) return noStore(res, 404, { error: 'not_an_oauth_provider', system: systemId, message: `${systemId} is not an approved system with an oauth block` });
  const name = def.kind === 'oauth-user' ? def.clientSecret : def.keySecret;
  const writer = writableProvider(state.providers);
  if (!writer) return noStore(res, 503, { error: 'no_writable_secrets_backend' });
  const raw = await readRaw(req);
  if (raw === undefined) return noStore(res, 413, { error: 'value_too_large', max: MAX_VALUE });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return noStore(res, 400, { error: 'json_required' });
  }
  let value: string;
  if (def.kind === 'oauth-user') {
    const id = typeof body.client_id === 'string' ? body.client_id.trim() : '';
    const secret = typeof body.client_secret === 'string' ? body.client_secret.trim() : '';
    if (!id || !secret) return noStore(res, 400, { error: 'client_required', message: 'send {"client_id": "...", "client_secret": "..."}' });
    value = JSON.stringify({ client_id: id, client_secret: secret });
    state.secretValues.add(secret);
  } else {
    const key = typeof body.value === 'string' ? body.value : '';
    if (!key) return noStore(res, 400, { error: 'value_required', message: 'send {"value": "<service-account key JSON>"}' });
    value = key;
    state.secretValues.add(key);
  }
  const existed = await secretPresent(name, state.providers);
  try {
    await writer.put(name, value);
  } catch {
    console.error(`[keymaster] writing the OAuth client for ${systemId} failed`);
    return noStore(res, 502, { error: 'write_failed', name });
  }
  state.secretCache?.delete(name);
  invalidateCredentials(state);
  const action = existed ? 'OAUTH_CLIENT_ROTATED' : 'OAUTH_CLIENT_SET';
  const at = new Date().toISOString();
  // The ledger names the provider; its Keymaster-named entry follows from it (shared/<id>/oauth-client).
  state.ledger.append({ timestamp: at, agentId: 'platform', type: 'action', action, actor, provider: systemId });
  noStore(res, existed ? 200 : 201, { system: systemId, name, status: 'present', action, at });
}

/** Handles the credentials API. Returns false when the path is not one of its routes. */
export async function handleCredentials(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const providerClient = path.match(/^\/api\/v1\/keymaster\/providers\/([a-z0-9-]+)\/client$/);
  if (providerClient && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'credentials.provider.read'))) return true;
    const def = state.systems?.getConnectionProvider(providerClient[1]);
    if (!def) return noStore(res, 404, { error: 'not_an_oauth_provider', system: providerClient[1] }), true;
    const name = def.kind === 'oauth-user' ? def.clientSecret : def.keySecret;
    return noStore(res, 200, { system: providerClient[1], kind: def.kind, name, present: await secretPresent(name, state.providers) }), true;
  }
  if (providerClient && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'credentials.provider.set');
    if (!principal) return true;
    await submitProviderClient(state, req, res, providerClient[1], principal.actor);
    return true;
  }

  if (path === '/api/v1/keymaster/outstanding' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'credentials.outstanding.read'))) return true;
    const agents: Array<{ agentId: string; name: string } & CredentialSummary> = [];
    await Promise.all([...state.agents.values()].filter((a) => !isBuiltin(a)).map(async (a) => {
      const s = await summaryFor(state, a.id);
      if (s) agents.push({ agentId: a.id, name: a.name, ...s });
    }));
    agents.sort((x, y) => x.agentId.localeCompare(y.agentId));
    noStore(res, 200, { agents, outstanding: agents.reduce((n, a) => n + a.outstanding, 0) });
    return true;
  }

  if (path === '/api/v1/keymaster/platform/credentials' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'credentials.platform.read'))) return true;
    const items = await assessPlatformCredentials({
      gatekeeperEgressHeld: state.gatekeeperEgressHeldSecrets ?? new Set(),
      present: (name) => cachedPresent(state, name),
      submitPath: platformSubmitPath,
    });
    noStore(res, 200, { summary: summarize(items), credentials: items });
    return true;
  }
  const plat = path.match(/^\/api\/v1\/keymaster\/platform\/credentials\/([^/]+)$/);
  if (plat && (req.method === 'POST' || req.method === 'PUT')) {
    const principal = await requirePrivilege(req, res, state, 'credentials.platform.set');
    if (!principal) return true;
    const name = decodeURIComponent(plat[1]);
    if (!(state.gatekeeperEgressHeldSecrets ?? new Set<string>()).has(name)) {
      return noStore(res, 404, { error: 'not_a_platform_credential', name, message: `${name} is not held by the gatekeeper-egress` }), true;
    }
    await writeCredential(state, req, res, 'platform', name, principal.actor);
    return true;
  }

  const one = path.match(/^\/api\/v1\/keymaster\/agents\/([^/]+)\/credentials(?:\/([^/]+))?$/);
  if (!one) return false;
  const agentId = decodeURIComponent(one[1]);
  if (!one[2] && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'credentials.agent.read', { agentId }))) return true;
    const items = await agentCredentials(state, agentId);
    if (!items) return noStore(res, 404, { error: 'not_found' }), true;
    const builtin = isBuiltin(state.agents.get(agentId)!);
    noStore(res, 200, { agentId, ...(builtin ? { builtin: true } : {}), summary: summarize(items), credentials: items });
    return true;
  }
  if (one[2] && (req.method === 'POST' || req.method === 'PUT')) {
    const principal = await requirePrivilege(req, res, state, 'credentials.agent.set', { agentId });
    if (!principal) return true;
    await submitCredential(state, req, res, agentId, decodeURIComponent(one[2]), principal.actor);
    return true;
  }
  return false;
}
