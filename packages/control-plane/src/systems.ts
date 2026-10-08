/**
 * System definition store & endpoints (DESIGN_AUTHORITY.md §6.3.1 E10, §6.13 R1).
 *
 * External systems an agent reaches, other than model providers (§6.9), are defined once in the factory:
 * where requests go (upstream), the credential kind (static secret or OAuth connection) and how it is injected.
 * Admin approval is required per definition version.
 *
 * Reads are served from memory (GAP-056). Records live in `<dataDir>/systems/<id>/<version>.json` (backed up, R1).
 *
 * The store itself (the definitions, their versions and the ledger rows) is the Registrar's, in `@beercanlabs/factory-registrar`.
 * This file is the control plane's side: the routes below, and a subclass of the store that adds the two methods which turn
 * a system's OAuth description into a Keymaster connection provider, so the Registrar does not depend on the Keymaster.
 *
 *   GET  /api/v1/systems                                  viewer: list systems & current status
 *   GET  /api/v1/systems/:id                              viewer: system details & version history
 *   POST /api/v1/systems                                  viewer/admin: propose a new system or edit
 *   POST /api/v1/systems/:id/approve                      admin: approve a system definition version
 *   POST /api/v1/systems/:id/reject                       admin: reject a system definition version
 *   GET  /api/v1/gatekeeper-egress/routes                 gatekeeper-egress: active routes derived from approved systems
 */
import http from 'node:http';
import { validateSystemProposal } from '@beercanlabs/factory-contract';
import { connectionProviderFromSystem, type ConnectionProvider } from '@beercanlabs/factory-keymaster';
import { SystemsStore as RegistrarSystemsStore } from '@beercanlabs/factory-registrar';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';

/** The Registrar's systems store, plus the connection providers the Keymaster derives from its OAuth systems. */
export class SystemsStore extends RegistrarSystemsStore {
  getConnectionProvider(id: string): ConnectionProvider | undefined {
    const sys = this.current.get(id);
    if (!sys || !sys.oauth) return undefined;
    return connectionProviderFromSystem(sys);
  }

  getConnectionProviders(): ConnectionProvider[] {
    const out: ConnectionProvider[] = [];
    for (const sys of this.current.values()) {
      const p = connectionProviderFromSystem(sys);
      if (p) out.push(p);
    }
    return out;
  }
}

export function systemsStore(state: FactoryState): SystemsStore {
  if (!state.systems) {
    throw new Error('systems store not initialized');
  }
  return state.systems;
}

export async function handleSystems(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  // Gatekeeper-egress non-model route resolution (§6.3.1 E10)
  if (path === '/api/v1/gatekeeper-egress/routes' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'egress.routes.read'))) return true;
    const store = systemsStore(state);
    json(res, 200, { routes: store.activeRoutes() });
    return true;
  }

  // System catalog list
  if (path === '/api/v1/systems' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'systems.read'))) return true;
    const store = systemsStore(state);
    json(res, 200, { systems: store.list() });
    return true;
  }

  // Propose a new system or edit
  if (path === '/api/v1/systems' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'systems.propose');
    if (!principal) return true;
    const body = await readJson(req);
    const validation = validateSystemProposal(body);
    if (!validation.ok) {
      json(res, 400, { error: 'invalid_system_proposal', issues: validation.issues });
      return true;
    }
    const store = systemsStore(state);
    const def = await store.propose(validation.proposal, principal.actor);
    json(res, 201, { system: def });
    return true;
  }

  // System details & versions
  const mSys = path.match(/^\/api\/v1\/systems\/([a-z0-9-]+)$/);
  if (mSys && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'systems.read'))) return true;
    const id = mSys[1];
    const store = systemsStore(state);
    const history = store.history(id);
    if (history.length === 0) {
      json(res, 404, { error: 'system_not_found' });
      return true;
    }
    const active = store.get(id);
    json(res, 200, {
      id,
      active,
      history,
    });
    return true;
  }

  // Approve a system
  const mApprove = path.match(/^\/api\/v1\/systems\/([a-z0-9-]+)\/approve$/);
  if (mApprove && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'systems.decide');
    if (!principal) return true;
    const id = mApprove[1];
    const body = await readJson(req);
    const version = typeof body.version === 'number' ? body.version : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const store = systemsStore(state);
    try {
      const def = await store.approve(id, version, principal.actor, reason);
      json(res, 200, { system: def });
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // Reject a system
  const mReject = path.match(/^\/api\/v1\/systems\/([a-z0-9-]+)\/reject$/);
  if (mReject && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'systems.decide');
    if (!principal) return true;
    const id = mReject[1];
    const body = await readJson(req);
    const version = typeof body.version === 'number' ? body.version : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const store = systemsStore(state);
    try {
      const def = await store.reject(id, version, principal.actor, reason);
      json(res, 200, { system: def });
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
