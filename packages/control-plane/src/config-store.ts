/**
 * Deployment configuration store (DESIGN_AUTHORITY.md §6.14 SK3, §6.13 R1).
 *
 * Each agent has one versioned configuration record: its pinned source (repo and commit), the skills it has adopted
 * (each pinned to an approved version; empty until skill adoption exists) and its policy. Every change creates a new,
 * immutable version recording who, when and why, and is ledgered with the record's content hash (never the policy
 * body). Versions are never overwritten.
 *
 * The store, its backends and the content hash are in `@beercanlabs/factory-registrar`. This file is the control plane's
 * side: the agent's configuration built from its state, the ledger rows, orphan pruning and the routes below.
 *
 * Reads are served from memory. The backend is read once on start and written only on change, so no API read ever
 * calls the store (GAP-056: a per-read backend call once starved the control plane).
 *
 * Backends are provider-neutral behind `ConfigBackend`:
 *   - a directory (local, Compose): `<dir>/<agentId>/<n>.json` plus `<dir>/<agentId>/current.json`
 *   - an S3 bucket with versioning (AWS): the same layout under `s3://bucket/prefix/`, through the AWS CLI (no SDK in
 *     the kernel, GAP-014); bucket versioning gives point-in-time restore (R1).
 *
 *   GET /api/v1/agents/:id/config                 the current version (viewer)
 *   GET /api/v1/agents/:id/config/history         every version, oldest first (viewer)
 *   GET /api/v1/agents/:id/config/versions/:n     one version (viewer)
 *   GET /api/v1/config/export[?agent=<id>]        every agent's full history (admin), or one agent's (admin or its owner); ledgered
 *   PUT /api/v1/agents/:id/owners                 set, replace or clear the agent's owners (admin; a new version)
 *
 * GAP-060: no configuration record exists for an agent that does not exist. On start, records for ids that are neither
 * a known agent nor have a policy are removed (`pruneOrphans`), and migration never creates one for an unknown id.
 * Removal is recoverable: on S3 it leaves delete markers in the versioned bucket (restorable for the non-current
 * retention period, R1); on a directory it moves the agent's folder to `_removed/<timestamp>/`.
 */
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ID, type ConfigContent, type ConfigRecord } from '@beercanlabs/factory-registrar';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { parseActor } from './identity-links.js';
import { isReservedPolicyId } from './policy.js';

/**
 * The agent's configuration as the factory holds it now. Adopted skills and owners carry forward: a registration, a
 * policy change and a deploy never drop them.
 */
export function configOf(state: FactoryState, agentId: string): ConfigContent {
  const agent = state.agents.get(agentId);
  const previous = state.configs?.current(agentId);
  return {
    agentId,
    source: { ...(agent?.repo ? { repo: agent.repo } : {}), ...(agent?.commit ? { commit: agent.commit } : {}) },
    skills: previous?.skills ?? [],
    policy: state.policies.has(agentId) ? state.policies.get(agentId) : null,
    ...(previous?.owners ? { owners: previous.owners } : {}),
  };
}

/** The agent's owners. No store or no record means no owners: it fails closed. */
export function ownersOf(state: FactoryState, agentId: string): string[] {
  return state.configs?.current(agentId)?.owners ?? [];
}

export const MAX_OWNERS = 10;

/** A list of owners as stored: lower-case principal actors, sorted, unique, at most ten. `[]` is "none". */
export function parseOwners(value: unknown): { ok: true; owners: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'owners must be an array of principal actors' };
  const owners: string[] = [];
  for (const v of value) {
    const actor = parseActor(v);
    if (!actor) return { ok: false, error: 'each owner must be a principal actor such as cloudflare:alice@example.com, oidc:... or token:...' };
    owners.push(actor);
  }
  const unique = [...new Set(owners)].sort();
  if (unique.length > MAX_OWNERS) return { ok: false, error: `an agent has at most ${MAX_OWNERS} owners` };
  return { ok: true, owners: unique };
}

/**
 * Write-through: record the agent's current configuration as a new version when it changed, and ledger it
 * (`CONFIG_VERSIONED`: agent, version, content hash; never the policy). Never fails the caller: the registry and
 * policy files remain authoritative for running agents, so a store failure is logged and ledgered, not raised.
 */
export async function recordConfig(state: FactoryState, agentId: string, change: { actor: string; reason: string }): Promise<ConfigRecord | undefined> {
  const store = state.configs;
  if (!store || agentId.startsWith('__')) return undefined;
  try {
    const { record, created } = await store.put(configOf(state, agentId), { updatedBy: change.actor, reason: change.reason });
    if (created) ledgerVersion(state, record, change.actor);
    return record;
  } catch (err) {
    console.error(`[control-plane] configuration for ${agentId} not versioned: ${err instanceof Error ? err.message : String(err)}`);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'CONFIG_VERSION_FAILED', actor: change.actor });
    return undefined;
  }
}

function ledgerVersion(state: FactoryState, record: ConfigRecord, actor: string): void {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: record.agentId,
    type: 'action',
    action: 'CONFIG_VERSIONED',
    actor,
    // The ledger's fixed schema has no version field: the version travels as the row's request id, the content hash
    // as its payload hash.
    requestId: `config:${record.agentId}:v${record.version}`,
    payloadSha256: record.hash,
  });
}

/**
 * GAP-060: removes the agent's configuration record and ledgers it (`CONFIG_REMOVED`: agent, the removed record's last
 * hash; never the policy). Unlike `recordConfig` it raises, so a caller can report what was not removed.
 */
export async function removeConfig(state: FactoryState, agentId: string, change: { actor: string; reason: string; now?: Date }): Promise<ConfigRecord | undefined> {
  const removed = await state.configs?.remove(agentId, change.actor, change.reason, change.now);
  if (!removed) return undefined;
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId,
    type: 'action',
    action: 'CONFIG_REMOVED',
    actor: change.actor,
    requestId: `config:${agentId}:removed:v${removed.version}`,
    payloadSha256: removed.hash,
  });
  return removed;
}

/**
 * Migration on start: every known agent with registry or policy state but no configuration record gets version 1 from
 * what exists (`updatedBy: 'migration'`). Agents that already have a record are untouched, so it is idempotent. An id
 * that is not a known agent never gets a record (GAP-060).
 */
export async function migrateConfigs(state: FactoryState, candidates: Iterable<string>): Promise<ConfigRecord[]> {
  const store = state.configs;
  if (!store) return [];
  const created: ConfigRecord[] = [];
  for (const agentId of new Set(candidates)) {
    if (agentId.startsWith('__') || store.current(agentId)) continue;
    if (!state.agents.has(agentId)) {
      console.warn(`[control-plane] configuration migration skipped ${JSON.stringify(agentId)}: not a known agent`);
      continue;
    }
    if (!AGENT_ID.test(agentId)) {
      console.warn(`[control-plane] configuration migration skipped ${JSON.stringify(agentId)}: not a valid record name`);
      continue;
    }
    const record = await recordConfig(state, agentId, { actor: 'migration', reason: 'migrated from existing registry and policy state' });
    if (record) created.push(record);
  }
  return created;
}

/** Whether the agent registry was read in full: every `*.json` in it parsed and named an agent. */
export type RegistryCheck = { ok: true; records: number } | { ok: false; reason: string };

export function checkRegistry(dir: string): RegistryCheck {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (err) {
    return { ok: false, reason: `registry ${dir} unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }
  for (const n of names) {
    try {
      const data = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { id?: unknown };
      if (!data || typeof data.id !== 'string' || !data.id) return { ok: false, reason: `registry record ${n} names no agent` };
    } catch (err) {
      return { ok: false, reason: `registry record ${n} unreadable: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { ok: true, records: names.length };
}

/**
 * Why pruning must not run, if it must not: an agent list that may be incomplete would make real agents look like
 * orphans. Refused when the registry was not read in full, when the known set is empty, smaller than the built-ins or
 * missing one of them, or when it holds nothing beyond the built-ins (an empty or unmounted registry).
 */
export function pruneRefusal(known: ReadonlySet<string>, builtinIds: readonly string[], registry: RegistryCheck): string | undefined {
  if (!registry.ok) return registry.reason;
  if (known.size === 0) return 'no agents are known';
  if (known.size < builtinIds.length) return `only ${known.size} agents are known, fewer than the ${builtinIds.length} built-ins`;
  const missing = builtinIds.filter((id) => !known.has(id));
  if (missing.length) return `built-in agents missing from the known set: ${missing.join(', ')}`;
  if (![...known].some((id) => !builtinIds.includes(id))) return 'no agents are known beyond the built-ins';
  return undefined;
}

export type PruneResult = { refused?: string; archived: string[]; archivedTo?: string; removed: string[]; failed: string[] };

/**
 * GAP-060, on start: (1) policy files for ids that are not known agents (reserved ids such as `__global__` excepted)
 * are moved to `policies-orphaned/<timestamp>/` and stop being served, one `POLICY_ORPHAN_ARCHIVED` row each; then
 * (2) configuration records for ids that are neither known agents nor have a policy are removed, one `CONFIG_REMOVED`
 * row each. Nothing is touched when `pruneRefusal` refuses. Idempotent: a second run finds nothing.
 */
export async function pruneOrphans(
  state: FactoryState,
  opts: { builtinIds: readonly string[]; registry: RegistryCheck; actor?: string; now?: Date },
): Promise<PruneResult> {
  const actor = opts.actor ?? 'system:orphan-prune';
  const now = opts.now ?? new Date();
  const known = new Set(state.agents.keys());
  const refused = pruneRefusal(known, opts.builtinIds, opts.registry);
  if (refused) {
    console.warn(`[control-plane] orphan prune refused, nothing archived or removed: ${refused}`);
    return { refused, archived: [], removed: [], failed: [] };
  }
  const orphans = state.policies.ids().filter((id) => !isReservedPolicyId(id) && !known.has(id));
  const { archived, to } = state.policies.archive(orphans, now);
  const failed = orphans.filter((id) => !archived.includes(id));
  for (const agentId of archived) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'POLICY_ORPHAN_ARCHIVED', actor });
  }
  const removed: string[] = [];
  for (const agentId of state.configs?.agentIds() ?? []) {
    if (known.has(agentId) || state.policies.has(agentId)) continue;
    try {
      if (await removeConfig(state, agentId, { actor, reason: 'orphaned: not a known agent (GAP-060)', now })) removed.push(agentId);
    } catch (err) {
      failed.push(agentId);
      console.error(`[control-plane] configuration for ${agentId} not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(
    `[control-plane] orphan prune: ${archived.length} policies archived${to ? ` to ${to}` : ''}, ${removed.length} configuration records removed` +
      (failed.length ? `, ${failed.length} failed (${failed.join(', ')})` : ''),
  );
  return { archived, ...(to ? { archivedTo: to } : {}), removed, failed };
}

/** Who changed it and why: the principal, and an optional `X-Change-Reason` header over the default. */
export function changeReason(req: http.IncomingMessage, fallback: string): string {
  const raw = req.headers['x-change-reason'];
  const given = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return given ? given.slice(0, 500) : fallback;
}

const AGENT_OWNERS = /^\/api\/v1\/agents\/([^/]+)\/owners$/;
const AGENT_CONFIG = /^\/api\/v1\/agents\/([^/]+)\/config(?:\/(history|versions\/([^/]+)))?$/;

/**
 * `PUT /api/v1/agents/:id/owners` `{ owners }` (admin): sets, replaces or (with `[]`) clears the agent's owners as a new
 * configuration version. It goes through `put` and raises: a change that was not stored must not look stored.
 */
async function handleOwners(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string): Promise<boolean> {
  const principal = await requirePrivilege(req, res, state, 'agents.owners.set');
  if (!principal) return true;
  if (!state.configs) {
    json(res, 503, { error: 'config_store_unavailable' });
    return true;
  }
  if (agentId.startsWith('__')) {
    json(res, 400, { error: 'reserved_agent_id' });
    return true;
  }
  if (!state.agents.has(agentId)) {
    json(res, 404, { error: 'not_found' });
    return true;
  }
  const checked = parseOwners((await readJson(req)).owners);
  if (!checked.ok) {
    json(res, 400, { error: checked.error });
    return true;
  }
  const { owners: _previous, ...content } = configOf(state, agentId);
  try {
    const { record, created } = await state.configs.put(
      { ...content, ...(checked.owners.length ? { owners: checked.owners } : {}) },
      { updatedBy: principal.actor, reason: changeReason(req, 'owners changed') },
    );
    if (created) ledgerVersion(state, record, principal.actor);
    json(res, 200, record);
  } catch (err) {
    console.error(`[control-plane] owners for ${agentId} not stored: ${err instanceof Error ? err.message : String(err)}`);
    json(res, 500, { error: 'owners_not_stored' });
  }
  return true;
}

/** The configuration API. Returns false for any path it does not own. Reads never touch the backend. */
export async function handleConfig(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const ownersPath = path.match(AGENT_OWNERS);
  if (ownersPath && req.method === 'PUT') return handleOwners(state, req, res, decodeURIComponent(ownersPath[1]));
  if (req.method !== 'GET') return false;
  if (path === '/api/v1/config/export') {
    // `?agent=<id>` exports that one agent (its owner may); without it, every agent (admin only).
    const agent = new URL(req.url ?? '/', 'http://factory.local').searchParams.get('agent') || undefined;
    const principal = await requirePrivilege(req, res, state, agent ? 'config.export.agent' : 'config.export', agent ? { agentId: agent } : undefined);
    if (!principal) return true;
    if (!state.configs) {
      json(res, 503, { error: 'config_store_unavailable' });
      return true;
    }
    const all = state.configs.exportAll();
    const out = agent ? { ...all, agents: all.agents.filter((a) => a.agentId === agent) } : all;
    if (agent && !out.agents.length) {
      json(res, 404, { error: state.agents.has(agent) ? 'no_config' : 'not_found' });
      return true;
    }
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent ?? 'factory', type: 'action', action: 'CONFIG_EXPORTED', actor: principal.actor });
    json(res, 200, out);
    return true;
  }
  const m = path.match(AGENT_CONFIG);
  if (!m) return false;
  if (!(await requirePrivilege(req, res, state, 'config.read', { agentId: decodeURIComponent(m[1]) }))) return true;
  if (!state.configs) {
    json(res, 503, { error: 'config_store_unavailable' });
    return true;
  }
  const agentId = decodeURIComponent(m[1]);
  const history = state.configs.history(agentId);
  if (!history.length) {
    json(res, 404, { error: state.agents.has(agentId) ? 'no_config' : 'not_found' });
    return true;
  }
  if (!m[2]) {
    json(res, 200, history[history.length - 1]);
  } else if (m[2] === 'history') {
    json(res, 200, { agentId, current: history[history.length - 1].version, versions: history });
  } else {
    const n = /^[1-9]\d*$/.test(m[3]) ? Number(m[3]) : NaN;
    const record = history.find((r) => r.version === n);
    if (record) json(res, 200, record);
    else json(res, 404, { error: 'version_not_found' });
  }
  return true;
}
