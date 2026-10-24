/**
 * Export and import of an agent's whole configuration as one bundle (DESIGN_AUTHORITY.md §6.18 CF3).
 *
 *   GET  /api/v1/agents/:id/bundle   the agent's owner or an admin (`config.export.agent`): the bundle, ledgered
 *   POST /api/v1/agents/import       an admin (`agents.create`): the bundle becomes a new agent; the importer owns it
 *
 * A bundle holds no owner, person, secret or memory. An import creates the agent exactly as `POST /api/v1/agents` does
 * (CF6), and grants nothing: the bundle's skills become adoption requests an admin decides (SK3) and its policy is a
 * request an admin sets by hand (E7), reported back and never applied. An agent from a repository exports as a read-only
 * record and cannot be imported (it would register a new agent from a repository); an id that already exists, registered
 * or retired, is refused.
 */
import http from 'node:http';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { buildBundle, canAdopt, parseBundle } from '@beercanlabs/factory-registrar';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { createFromConfiguration, discardCreated } from './agent-creation.js';
import { adoptionStore, requestAdoptionFor, skillRegistry } from './skills.js';

const BUNDLE = /^\/api\/v1\/agents\/([^/]+)\/bundle$/;
const IMPORT = '/api/v1/agents/import';

export async function handleAgentBundle(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const exporting = path.match(BUNDLE);
  if (exporting && req.method === 'GET') {
    const agentId = decodeURIComponent(exporting[1]);
    const principal = await requirePrivilege(req, res, state, 'config.export.agent', { agentId });
    if (!principal) return true;
    const agent = state.agents.get(agentId);
    const current = state.configs?.current(agentId);
    if (!agent || !current) return json(res, 404, { error: agent ? 'no_config' : 'not_found' }), true;
    const bundle = buildBundle(agent, current);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'CONFIG_BUNDLE_EXPORTED', actor: principal.actor, payloadSha256: payloadHash(bundle) });
    json(res, 200, bundle);
    return true;
  }
  if (path !== IMPORT || req.method !== 'POST') return false;
  const principal = await requirePrivilege(req, res, state, 'agents.create');
  if (!principal) return true;
  const body = await readJson(req);
  const parsed = parseBundle(body.bundle ?? body);
  if (!parsed.ok) return json(res, 400, { error: parsed.error, message: parsed.message }), true;
  const { bundle } = parsed;
  if (bundle.origin !== 'configuration' || !bundle.settings) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: bundle.agent.id, type: 'action', action: 'AGENT_IMPORT_REFUSED:bundle_not_importable', actor: principal.actor });
    return json(res, 422, { error: 'bundle_not_importable', message: 'this bundle records an agent that runs from a repository; its soul and roles are in that repository, and importing it would register a new agent from a repository (CF6)' }), true;
  }
  const created = await createFromConfiguration(state, principal, {
    id: bundle.agent.id,
    name: bundle.agent.name,
    role: bundle.agent.role,
    model: bundle.agent.model,
    soul: bundle.settings.soul,
    roles: bundle.settings.roles,
    memory: bundle.settings.memory,
    // A role may name only a skill this very agent can be given (approved, not retired, public or its own): anything else would be a ceiling that is not there (CF2).
    rolesMayNameSkills: new Set(bundle.skills.filter((s) => canAdopt(skillRegistry(state), bundle.agent.id, s.id, s.version).ok).map((s) => s.id)),
    reason: 'imported from a bundle',
  });
  if (created.status !== 201) return json(res, created.status, created.body), true;
  const id = bundle.agent.id;
  const skills: Array<{ id: string; version: string; state: string; error?: string }> = [];
  try {
    for (const s of bundle.skills) {
      const asked = await requestAdoptionFor(state, id, s.id, s.version, principal.actor, 'imported from a bundle');
      skills.push(asked.status === 201 ? { ...s, state: 'requested' } : { ...s, state: 'unavailable', error: String(asked.body.error ?? asked.status) });
    }
    // A role that names a skill whose request was refused would be a ceiling that is not there (CF2): the import is not made.
    const refused = new Set(skills.filter((s) => s.state !== 'requested').map((s) => s.id));
    const named = (bundle.settings.roles ?? []).flatMap((r) => Object.keys(r.skills)).find((k) => refused.has(k));
    if (named) throw new Error(`role names ${named}, whose adoption could not be requested`);
    if (bundle.policy) {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: 'AGENT_IMPORT_POLICY_REQUESTED', actor: principal.actor, payloadSha256: payloadHash(bundle.policy) });
    }
    // Last, so that a success row is never written for an import that is then rolled back.
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: 'AGENT_IMPORTED', actor: principal.actor, payloadSha256: payloadHash(bundle) });
  } catch (err) {
    // All or nothing: the agent, its configuration and the requests made for it are removed, so the import can be tried again.
    for (const s of bundle.skills) {
      try {
        adoptionStore(state).clear(id, s.id);
      } catch {
        // the store may not hold one
      }
    }
    await discardCreated(state, id, principal.actor, 'import failed');
    try {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: 'AGENT_IMPORT_FAILED', actor: principal.actor, payloadSha256: payloadHash(bundle) });
    } catch {
      // the ledger is what failed, perhaps
    }
    console.error(`[control-plane] import of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    return json(res, 500, { error: 'import_failed' }), true;
  }
  json(res, 201, { ...created.body, skills, ...(bundle.policy ? { policyRequested: bundle.policy, policyApplied: false } : {}) });
  return true;
}
