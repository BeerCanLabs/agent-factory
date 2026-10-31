/**
 * E1.1 (#292): the helper (subagent) registry. Admins register prompt-only helper definitions; each registration is
 * written to the ledger as an audit row. Helpers live in their own map, never in `state.agents`, so `list_agents`
 * and the chat agent lists never show them.
 */
import type http from 'node:http';
import { validateSubagent } from '@beercanlabs/factory-contract';
import { SubagentStore, type SubagentRecord } from '@beercanlabs/factory-registrar';
import { json, readJson, requirePrivilege, type FactoryState } from './app.js';

export type { SubagentRecord };

function storeOf(state: FactoryState): SubagentStore {
  return new SubagentStore(state.registryDir, (m, e) => console.warn(`[control-plane] ${m}`, e ?? ''));
}

/** The helper map, read back from the registry directory on first use. */
export function subagentsOf(state: FactoryState): Map<string, SubagentRecord> {
  state.subagents ??= storeOf(state).load();
  return state.subagents;
}

/** Handles /api/v1/registry/subagents[/:id]; returns false when the path is not one of these. */
export async function handleSubagents(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/registry/subagents' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'registry.register');
    if (!principal) return true;
    const v = validateSubagent(await readJson(req));
    if (!v.ok) {
      json(res, 400, { error: 'invalid_subagent', errors: v.errors });
      return true;
    }
    const map = subagentsOf(state);
    if (state.agents.has(v.value.id)) {
      json(res, 409, { error: 'id_in_use', message: `an agent named ${v.value.id} already exists` });
      return true;
    }
    const replaced = map.has(v.value.id);
    const record: SubagentRecord = { ...v.value, kind: 'subagent', registeredBy: principal.actor, registeredAt: new Date().toISOString() };
    try {
      storeOf(state).save(record);
    } catch (err) {
      console.warn(`[control-plane] failed to persist helper ${record.id}:`, err);
      json(res, 500, { error: 'subagent_not_stored' });
      return true;
    }
    map.set(record.id, record);
    state.ledger.append({ timestamp: record.registeredAt, agentId: record.id, type: 'action', action: replaced ? 'SUBAGENT_UPDATED' : 'SUBAGENT_REGISTERED', actor: principal.actor });
    json(res, replaced ? 200 : 201, record);
    return true;
  }
  if (path === '/api/v1/registry/subagents' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'agents.read'))) return true;
    json(res, 200, [...subagentsOf(state).values()]);
    return true;
  }
  const m = path.match(/^\/api\/v1\/registry\/subagents\/([^/]+)$/);
  if (m && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'agents.read'))) return true;
    const record = subagentsOf(state).get(decodeURIComponent(m[1]));
    if (!record) json(res, 404, { error: 'not_found' });
    else json(res, 200, record);
    return true;
  }
  return false;
}
