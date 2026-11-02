/**
 * An agent's own settings in the factory (DESIGN_AUTHORITY.md §6.18 CF1): its soul, its roles and its memory settings,
 * an optional `agent` section of the versioned configuration record (SK3).
 *
 *   GET /api/v1/agents/:id/settings   the section and whether the factory holds one (admin, or the agent's owner)
 *   PUT /api/v1/agents/:id/settings   `{ soul?, roles?, memory? }`: each key present replaces that part, `null` removes it
 *                                     (admin, or the agent's owner; a new configuration version, ledgered).
 *                                     `name` may be sent too: it renames the agent as PUT .../name does.
 *   PUT /api/v1/agents/:id/name       `{ name }`: the agent's display name, for a config or a repository agent (#65)
 *                                     (admin, or the agent's owner: agents.settings.set; ledgered AGENT_RENAMED)
 *
 * The change is made by a person in a signed-in session, which is both its requester and its approver (CF4); an agent
 * never reaches this route (its run token holds no privilege here). Nothing is created by a registration or a commit, so
 * an agent with no section reads exactly as before. A role never grants reach: it only decides which people may use what
 * the agent's policy already grants (E7, E12).
 */
import http from 'node:http';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { authorize } from '@beercanlabs/factory-bouncer';
import type { Principal } from '@beercanlabs/factory-auth';
import { applySettingsChange, changedParts, type AgentRecord, type AgentSettings, type DeclaredRole } from '@beercanlabs/factory-registrar';
import { BUILTIN_AGENT_IDS, registryOf } from '@beercanlabs/factory-registrar';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { changeReason, configOf, ledgerVersion, ownersOf } from './config-store.js';
import { skillRegistry } from './skills.js';

/** The section the factory holds for the agent, if any. */
export function settingsOf(state: FactoryState, agentId: string): AgentSettings | undefined {
  return state.configs?.current(agentId)?.agent;
}

/** The roles in force: the factory's section wins when it holds roles, otherwise the cartridge's (an existing agent). */
export function effectiveRoles(state: FactoryState, agent: Pick<AgentRecord, 'id' | 'roles'>): DeclaredRole[] {
  return settingsOf(state, agent.id)?.roles ?? agent.roles ?? [];
}

/**
 * The skills a role may name and the routes each uses: the cartridge's own, and, only for an agent that has a section,
 * the skills it has adopted at their pinned version (routes from the skill's manifest, SK2). An agent with no section
 * is exactly what its cartridge says, so adoption alone changes nothing for an existing agent.
 */
export function effectiveSkills(state: FactoryState, agent: Pick<AgentRecord, 'id' | 'skillIds' | 'skillRoutes'>): { skillIds: string[]; skillRoutes: Record<string, string[]> } {
  const skillIds = [...(agent.skillIds ?? [])];
  const skillRoutes: Record<string, string[]> = { ...(agent.skillRoutes ?? {}) };
  // Adopted skills' routes count only for an agent whose section holds roles: a soul or memory change alone is not an access change.
  if (!settingsOf(state, agent.id)?.roles) return { skillIds, skillRoutes };
  for (const adopted of state.configs?.current(agent.id)?.skills ?? []) {
    if (!skillIds.includes(adopted.id)) skillIds.push(adopted.id);
    if (Object.prototype.hasOwnProperty.call(skillRoutes, adopted.id)) continue;
    const routes = skillRegistry(state).get(adopted.id, adopted.version)?.manifest.requires?.routes ?? [];
    if (routes.length) skillRoutes[adopted.id] = [...new Set(routes)];
  }
  return { skillIds, skillRoutes };
}

/** The agent as access decisions see it: the roles and skill routes in force. Same record when there is no section. */
export function agentInForce(state: FactoryState, agent: AgentRecord): AgentRecord {
  if (!settingsOf(state, agent.id)?.roles) return agent;
  const { skillIds, skillRoutes } = effectiveSkills(state, agent);
  return { ...agent, roles: effectiveRoles(state, agent), skillIds, skillRoutes };
}

/** Whether the principal may read the agent's settings (the soul is not for every viewer). */
export function canReadSettings(state: FactoryState, principal: Principal, agentId: string): boolean {
  return authorize({ principal, privilege: 'agents.settings.read', resource: { agentId, owners: ownersOf(state, agentId) } }).allowed;
}

/** One change at a time per agent: the read, merge and write of a settings change are not interleaved. */
const locks = new Map<string, Promise<void>>();

const SETTINGS = /^\/api\/v1\/agents\/([^/]+)\/settings$/;
const NAME = /^\/api\/v1\/agents\/([^/]+)\/name$/;

/** A display name: a trimmed, non-empty string of at most 120 characters with no control characters. */
export function parseDisplayName(value: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'name must be a string' };
  const name = value.trim();
  if (!name) return { ok: false, error: 'name must not be empty' };
  if (name.length > 120) return { ok: false, error: 'name must be at most 120 characters' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: 'name must not contain control characters' };
  return { ok: true, name };
}

/** Renames the agent in memory and in its saved record, and ledgers the change when the name actually changed. */
function renameAgent(state: FactoryState, agent: AgentRecord, name: string, actor: string): { previous: string; changed: boolean } {
  const previous = agent.name;
  if (previous === name && agent.nameSetInFactory) return { previous, changed: false };
  const next: AgentRecord = { ...agent, name, nameSetInFactory: true };
  state.agents.set(agent.id, next);
  registryOf(state).update(next);
  if (previous !== name) {
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      type: 'action',
      action: 'AGENT_RENAMED',
      actor,
      payloadSha256: payloadHash({ from: previous, to: name }),
    });
  }
  return { previous, changed: previous !== name };
}

function isBuiltin(agent: AgentRecord): boolean {
  return !!(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
}

async function handleAgentName(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, agentId: string): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'agents.settings.set', { agentId });
  if (!principal) return;
  const agent = state.agents.get(agentId);
  if (!agent || agent.ephemeral) return json(res, 404, { error: 'not_found' });
  if (isBuiltin(agent)) return json(res, 400, { error: 'builtin_agents_cannot_be_renamed' });
  const body = (await readJson(req)) as { name?: unknown } | null;
  const parsed = parseDisplayName(body && typeof body === 'object' ? body.name : undefined);
  if (!parsed.ok) return json(res, 400, { error: 'invalid_name', message: parsed.error });
  const current = state.agents.get(agentId);
  if (!current) return json(res, 404, { error: 'not_found' });
  const { previous, changed } = renameAgent(state, current, parsed.name, principal.actor);
  json(res, 200, { agentId, name: parsed.name, previous, changed });
}

export async function handleAgentSettings(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const n = path.match(NAME);
  if (n && req.method === 'PUT') {
    await handleAgentName(state, req, res, decodeURIComponent(n[1]));
    return true;
  }
  const m = path.match(SETTINGS);
  if (!m || (req.method !== 'GET' && req.method !== 'PUT')) return false;
  const agentId = decodeURIComponent(m[1]);
  const write = req.method === 'PUT';
  const principal = await requirePrivilege(req, res, state, write ? 'agents.settings.set' : 'agents.settings.read', { agentId });
  if (!principal) return true;
  const agent = state.agents.get(agentId);
  if (!state.configs) return json(res, 503, { error: 'config_store_unavailable' }), true;
  if (!agent) return json(res, 404, { error: 'not_found' }), true;
  if (!write) {
    const current = state.configs.current(agentId);
    json(res, 200, { agentId, managed: !!current?.agent, ...(current?.agent ? { settings: current.agent } : {}), version: current?.version ?? null });
    return true;
  }
  if (isBuiltin(agent)) return json(res, 400, { error: 'builtin_agents_have_no_settings' }), true;
  // The body is read first, then the read-merge-write runs alone for this agent: two changes never overwrite each other.
  let body = await readJson(req);
  // #65: `name` rides along with the settings; it lives on the agent record, not in the configuration section.
  let newName: string | undefined;
  if (body && typeof body === 'object' && !Array.isArray(body) && 'name' in (body as object)) {
    const { name, ...rest } = body as Record<string, unknown>;
    const parsed = parseDisplayName(name);
    if (!parsed.ok) return json(res, 400, { error: 'invalid_name', message: parsed.error }), true;
    newName = parsed.name;
    body = rest;
    if (!Object.keys(rest).length) {
      const latest = state.agents.get(agentId);
      if (!latest) return json(res, 404, { error: 'not_found' }), true;
      const { previous, changed } = renameAgent(state, latest, newName, principal.actor);
      const current = state.configs.current(agentId);
      json(res, 200, { agentId, name: newName, previous, managed: !!current?.agent, ...(current?.agent ? { settings: current.agent } : {}), version: current?.version ?? null, changed: changed ? ['name'] : [] });
      return true;
    }
  }
  const previous = locks.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  locks.set(agentId, new Promise<void>((r) => (release = r)));
  await previous;
  try {
    // A purge that landed while this waited for the body or the lock must not be undone by recreating a record.
    if (!state.agents.has(agentId)) return json(res, 404, { error: 'not_found' }), true;
    const current = state.configs.current(agentId);
    const next = applySettingsChange(current?.agent, body);
    if (!next.ok) return json(res, 400, { error: 'invalid_settings', message: next.error }), true;
    let renamed = false;
    if (next.settings.roles) {
      // A role may name only a skill the agent declares or has adopted, so those stay the ceiling (CF2).
      const known = new Set(effectiveSkills(state, agent).skillIds);
      for (const adopted of current?.skills ?? []) known.add(adopted.id);
      for (const role of next.settings.roles) {
        for (const skill of Object.keys(role.skills)) {
          if (skill !== '*' && !known.has(skill)) {
            return json(res, 422, { error: 'unknown_skill', role: role.name, skill, message: `role "${role.name}" names skill "${skill}", which the agent neither declares nor has adopted` }), true;
          }
        }
      }
    }
    const parts = changedParts(current?.agent, next.settings);
    const { agent: _was, ...content } = configOf(state, agentId);
    try {
      // `replaces: ['agent']`: owners, adoptions and policy are taken from the latest record when the store writes, so a
      // concurrent change of another kind is never put back (and this change never puts back an older one).
      const { record, created } = await state.configs.put(
        { ...content, ...(Object.keys(next.settings).length ? { agent: next.settings } : {}) },
        { updatedBy: principal.actor, reason: changeReason(req, `settings changed: ${parts.join(', ') || 'none'}`), replaces: ['agent'] },
      );
      if (created) {
        ledgerVersion(state, record, principal.actor);
        // Which parts changed, by name; never the soul or the roles themselves.
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId,
          type: 'action',
          action: 'AGENT_SETTINGS_CHANGED',
          actor: principal.actor,
          requestId: `config:${agentId}:v${record.version}`,
          payloadSha256: payloadHash({ parts, hash: record.hash }),
        });
      }
      if (newName !== undefined) {
        const latest = state.agents.get(agentId);
        if (latest) renamed = renameAgent(state, latest, newName, principal.actor).changed;
      }
      json(res, 200, { agentId, ...(newName !== undefined ? { name: newName } : {}), managed: !!record.agent, ...(record.agent ? { settings: record.agent } : {}), version: record.version, changed: [...(created ? parts : []), ...(renamed ? ['name'] : [])] });
    } catch (err) {
      console.error(`[control-plane] settings for ${agentId} not stored: ${err instanceof Error ? err.message : String(err)}`);
      json(res, 500, { error: 'settings_not_stored' });
    }
    return true;
  } finally {
    release();
  }
}
