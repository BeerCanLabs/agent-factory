/**
 * Subscription connections API (DESIGN_AUTHORITY.md §6.9 M5(4) to (6), §6.11 K1 to K4 as amended, TSK-332).
 *
 * Subscription connections exist in two scopes:
 *   - `scope: 'factory'` (`shared/<provider>/subscription/<id>`): connected and managed by factory admins (`subscriptions.read`, `subscriptions.manage`).
 *   - `scope: 'personal'` (`users/<principalKey>/<provider>/subscription/<id>`): Owner BYOM connected and managed by a qualifying
 *     canonical `user:<id>` principal holding `subscriptions.own` (or an admin acting via `X-Factory-Act-As: user:<id>`).
 * No response ever carries a token.
 *
 *   GET    /api/v1/subscriptions                       list connections (all for `subscriptions.read`, own `personal` for `subscriptions.own`), templates and reviewed instructions (K5.4)
 *   POST   /api/v1/subscriptions                       {templateId, subscriberAttested: true, scope?, name?} start a sign-in
 *   POST   /api/v1/subscriptions/connect               alias for POST /api/v1/subscriptions
 *   GET    /api/v1/subscriptions/sign-ins/:id          poll the sign-in; connects when the subscriber has signed in
 *   POST   /api/v1/subscriptions/:id/reconnect         {subscriberAttested: true} start a sign-in for this connection
 *   PATCH  /api/v1/subscriptions/:id                   {name} rename a connection
 *   POST   /api/v1/subscriptions/:id/rename            alias for PATCH /api/v1/subscriptions/:id
 *   DELETE /api/v1/subscriptions/:id                   disconnect (retires the connection's catalog entries)
 *
 * Deferred to TSK-328 (the catalog does not exist yet): retiring a connection's catalog entries on disconnect goes through
 * `setSubscriptionEntryRetirer`; until it is set, no entries exist to retire and disconnect reports `entriesRetired: 0`.
 * The gatekeeper-egress's token route is in `connections.ts` (TSK-327) and the plan-limit windows are in `subscription-windows.ts`.
 */
import http from 'node:http';
import type { Principal } from '@beercanlabs/factory-auth';
import { SUBSCRIPTION_TEMPLATES } from '@beercanlabs/factory-contract';
import {
  authorize,
  isValidUserPrincipalId,
  normalizeActorToPrincipal,
  type AuthorizeResource,
} from '@beercanlabs/factory-bouncer';
import {
  SubscriptionKeymaster,
  catalogEntry,
  catalogView,
  type NeedsReconsentEvent,
  type SubscriptionScope,
  type SubscriptionView,
} from '@beercanlabs/factory-keymaster';
import {
  actorIsAdmin,
  checkOwnsPersonalAgent,
  effectiveGrantsForActor,
  json,
  readJson,
  requirePrivilege,
  type FactoryState,
} from './app.js';
import { rolesForSubjectActor } from './grants-routes.js';
import { getSubscriptionWindows } from './subscription-windows.js';

export function getSubscriptions(state: FactoryState): SubscriptionKeymaster {
  if (!state.subscriptions) {
    state.subscriptions = new SubscriptionKeymaster({
      providers: state.providers,
      ledger: state.ledger,
      secretValues: state.secretValues,
      fetch: state.subscriptionFetch,
      version: state.version,
      onNeedsReconsent: (ev) => notifyNeedsReconsent(state, ev),
    });
  }
  return state.subscriptions;
}

// ---- notification (K4 as amended by M5(6)) -------------------------------------------------------

export type SubscriptionNotice = {
  kind: 'needs_reconsent';
  connection: SubscriptionView;
  reason: string;
  /**
   * For `scope: 'factory'`: the connecting admin if still admin, else every factory admin.
   * For `scope: 'personal'`: `[ownerPrincipalId]` if that principal has an active human identity, else every factory admin.
   */
  recipients: string[];
};
export type SubscriptionNotifier = (notice: SubscriptionNotice) => void | Promise<void>;

const notifiers = new WeakMap<FactoryState, SubscriptionNotifier>();
export function setSubscriptionNotifier(state: FactoryState, fn: SubscriptionNotifier | undefined): void {
  if (fn) notifiers.set(state, fn);
  else notifiers.delete(state);
}

/** TSK-328's hook: retire the catalog entries served on a connection (M2 retirement transitions); returns how many. */
export type SubscriptionEntryRetirer = (connection: SubscriptionView) => number | Promise<number>;
const retirers = new WeakMap<FactoryState, SubscriptionEntryRetirer>();
export function setSubscriptionEntryRetirer(state: FactoryState, fn: SubscriptionEntryRetirer | undefined): void {
  if (fn) retirers.set(state, fn);
  else retirers.delete(state);
}

/** Every actor who holds the factory admin role today: fleet admin grants and linked identities with the role. */
export function factoryAdmins(state: FactoryState): string[] {
  const out = new Set<string>();
  try {
    for (const g of state.grants?.list({ scopeKind: 'fleet' }) ?? []) {
      if (g.role === 'admin' && g.state === 'active') out.add(g.subject);
    }
  } catch {
    // an unhealthy grant store tells no one anything; the identity links below still may
  }
  for (const l of state.identityLinks?.list() ?? []) {
    if (l.roles?.includes('admin')) out.add(l.actor);
  }
  return [...out].sort();
}

/**
 * M5(6): Whether canonical `ownerPrincipalId` (`user:<id>`) currently has an active human identity in the factory.
 * Returns false if the principal is missing from `PrincipalStore`, has no bound login email/IdP identity, or has had all
 * active grants revoked (`POST /api/v1/principals/:id/revoke-access`).
 */
export function hasActiveHumanIdentity(state: FactoryState, ownerPrincipalId: string): boolean {
  if (!isValidUserPrincipalId(ownerPrincipalId)) return false;
  if (state.principals) {
    if (!state.principals.healthy) return false;
    const rec = state.principals.get(ownerPrincipalId);
    if (!rec) return false;
    if (rec.emails.length === 0 && rec.idpBindings.length === 0) return false;
  }
  if (state.grants) {
    if (!state.grants.healthy) return false;
    const grantRes = effectiveGrantsForActor(state, ownerPrincipalId);
    if (!grantRes.ok) return false;
    const hasActiveGrant = (grantRes.grants ?? []).some((eg) => !eg.readOnly);
    return hasActiveGrant || checkOwnsPersonalAgent(state, ownerPrincipalId);
  }
  if (state.principals) {
    return true;
  }
  if (checkOwnsPersonalAgent(state, ownerPrincipalId)) return true;
  for (const l of state.identityLinks?.list() ?? []) {
    try {
      if (normalizeActorToPrincipal(l.actor) === ownerPrincipalId) return true;
    } catch {
      if (l.actor.toLowerCase() === ownerPrincipalId.toLowerCase()) return true;
    }
  }
  return false;
}

/**
 * M5(6): Recipients for a `needs_reconsent` notice:
 *   - `scope === 'personal'`: `[ownerPrincipalId]` when `ownerPrincipalId` has an active human identity, falling back to
 *     `factoryAdmins(state)` only when `ownerPrincipalId` has no active human identity (disabled/deleted/revoked principal).
 *   - `scope === 'factory'` (or legacy string `connectedBy`): `[connectedBy]` if still admin, else `factoryAdmins(state)`.
 */
export function reconsentRecipients(
  state: FactoryState,
  target: string | Pick<SubscriptionView, 'connectedBy' | 'scope' | 'ownerPrincipalId'>,
): string[] {
  if (typeof target === 'string') {
    return actorIsAdmin(state, target) ? [target] : factoryAdmins(state);
  }
  if (target.scope === 'personal' && target.ownerPrincipalId) {
    return hasActiveHumanIdentity(state, target.ownerPrincipalId) ? [target.ownerPrincipalId] : factoryAdmins(state);
  }
  return actorIsAdmin(state, target.connectedBy) ? [target.connectedBy] : factoryAdmins(state);
}

export async function notifyNeedsReconsent(state: FactoryState, ev: NeedsReconsentEvent): Promise<void> {
  const recipients = reconsentRecipients(state, ev.connection);
  // Each notice is auditable on its own, whether or not a delivery channel is wired.
  for (const to of recipients) {
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'factory',
      type: 'action',
      action: 'SUBSCRIPTION_RECONSENT_NOTIFIED',
      actor: 'factory:keymaster',
      provider: ev.connection.provider,
      connection: ev.connection.id,
      scope: ev.connection.scope,
      ...(ev.connection.scope === 'personal' && ev.connection.ownerPrincipalId
        ? { ownerPrincipalId: ev.connection.ownerPrincipalId }
        : {}),
      subject: to,
    });
  }
  const fn = notifiers.get(state);
  if (!fn) return;
  try {
    await fn({ kind: 'needs_reconsent', connection: ev.connection, reason: ev.reason, recipients });
  } catch (err) {
    console.error(`[subscriptions] notify needs_reconsent ${ev.connection.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- routes ----------------------------------------------------------------------------------------

const STATUS: Record<string, number> = {
  unknown_template: 404,
  unknown_connection: 404,
  unknown_sign_in: 404,
  attestation_required: 400,
  invalid_name: 400,
  invalid_scope: 400,
  invalid_owner: 400,
  provider_mismatch: 400,
  forbidden_connection: 403,
  name_taken: 409,
  account_mismatch: 409,
  account_already_connected: 409,
  sign_in_expired: 410,
  sign_in_denied: 400,
  sign_in_rate_limited: 429,
  sign_in_unavailable: 502,
  discovery_invalid: 502,
  sign_in_failed: 502,
  profile_unavailable: 502,
};

const fail = (res: http.ServerResponse, f: { error: string; message: string }) =>
  json(res, STATUS[f.error] ?? 400, { error: f.error, message: f.message });

function templateViews() {
  return Object.values(SUBSCRIPTION_TEMPLATES).map((t) => {
    const entry = catalogEntry(t.id);
    return {
      id: t.id,
      vendor: t.vendor,
      name: t.name,
      description: t.description,
      signIn: { flow: t.signIn.flow, verificationUrl: t.signIn.verificationUrl },
      permission: t.permission,
      ...(entry ? { instructions: catalogView(entry) } : {}),
    };
  });
}

function resolveCaller(
  state: FactoryState,
  principal: Principal,
):
  | { ok: true; evalPrincipal: Principal; resource: AuthorizeResource; canonicalUser?: string }
  | { ok: false; error: string } {
  const subjectActor = principal.onBehalfOf ?? principal.actor;
  const grantRes = effectiveGrantsForActor(state, subjectActor);
  if (!grantRes.ok) {
    return { ok: false, error: grantRes.error };
  }
  const evalPrincipal: Principal = principal.onBehalfOf
    ? {
        actor: subjectActor,
        roles: rolesForSubjectActor(state, subjectActor, grantRes.grants),
      }
    : principal;
  const resource: AuthorizeResource = {
    ownsPersonalAgent: checkOwnsPersonalAgent(state, subjectActor),
    ...(grantRes.grants !== undefined ? { grants: grantRes.grants } : {}),
  };
  let canonicalCandidate = subjectActor;
  try {
    canonicalCandidate = normalizeActorToPrincipal(subjectActor, state.principals);
  } catch {
    canonicalCandidate = subjectActor;
  }
  const canonicalUser = isValidUserPrincipalId(canonicalCandidate) ? canonicalCandidate : undefined;
  return { ok: true, evalPrincipal, resource, canonicalUser };
}

/** Handles the subscriptions API. Returns false when the path is not one of its routes. */
export async function handleSubscriptions(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/v1/subscriptions' && !path.startsWith('/api/v1/subscriptions/')) return false;
  const km = getSubscriptions(state);

  if (path === '/api/v1/subscriptions' && req.method === 'GET') {
    const scopeParam = new URL(req.url ?? path, 'http://factory.local').searchParams.get('scope');
    if (scopeParam !== null && scopeParam !== 'factory' && scopeParam !== 'personal') {
      json(res, 400, { error: 'invalid_scope', message: "scope must be 'factory' or 'personal'" });
      return true;
    }
    if (scopeParam === 'factory') {
      const principal = await requirePrivilege(req, res, state, 'subscriptions.read');
      if (!principal) return true;
      const caller = resolveCaller(state, principal);
      if (!caller.ok) return json(res, 503, { error: caller.error }), true;
      if (!authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.read', resource: caller.resource }).allowed) {
        json(res, 403, {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: 'listing factory subscriptions requires subscriptions.read',
        });
        return true;
      }
      json(res, 200, { connections: await km.list({ scope: 'factory' }), templates: templateViews() });
      return true;
    }
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canReadAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.read', resource: caller.resource }).allowed;
    const connections = canReadAll
      ? await km.list(scopeParam === 'personal' ? { scope: 'personal' } : undefined)
      : caller.canonicalUser
        ? await km.list({ scope: 'personal', ownerPrincipalId: caller.canonicalUser })
        : [];
    json(res, 200, { connections, templates: templateViews() });
    return true;
  }

  if ((path === '/api/v1/subscriptions' || path === '/api/v1/subscriptions/connect') && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const b = await readJson(req);
    if (b.scope !== undefined && b.scope !== 'factory' && b.scope !== 'personal') {
      json(res, 400, { error: 'invalid_scope', message: "scope must be 'factory' or 'personal'" });
      return true;
    }
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.manage', resource: caller.resource }).allowed;
    if (b.scope === 'factory') {
      if (!(await requirePrivilege(req, res, state, 'subscriptions.manage'))) return true;
      if (!canManageAll) {
        json(res, 403, {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: 'connecting a factory subscription requires subscriptions.manage',
        });
        return true;
      }
    }
    const effectiveScope: SubscriptionScope = (b.scope as SubscriptionScope | undefined) ?? (canManageAll ? 'factory' : 'personal');
    if (b.subscriberAttested !== true) {
      return fail(res, {
        error: 'attestation_required',
        message: 'subscriberAttested: true is required (K2: the subscriber confirms the subscription is theirs and vendor terms permit this use)',
      }), true;
    }
    if (effectiveScope === 'personal') {
      if (!caller.canonicalUser) {
        json(res, 403, {
          error: 'user_principal_required',
          message: 'a personal subscription connection requires a canonical user:<id> principal (or admin X-Factory-Act-As)',
        });
        return true;
      }
      if (b.ownerPrincipalId !== undefined) {
        if (typeof b.ownerPrincipalId !== 'string' || !isValidUserPrincipalId(b.ownerPrincipalId)) {
          json(res, 400, { error: 'invalid_owner', message: 'ownerPrincipalId must be a canonical user:<id> principal' });
          return true;
        }
        if (b.ownerPrincipalId !== caller.canonicalUser) {
          json(res, 403, { error: 'forbidden_connection', message: 'cannot create a personal subscription connection for another principal' });
          return true;
        }
      }
    } else if (b.ownerPrincipalId !== undefined) {
      json(res, 400, { error: 'invalid_owner', message: 'factory subscription connections cannot set ownerPrincipalId' });
      return true;
    }
    const r = await km.startSignIn({
      templateId: typeof b.templateId === 'string' ? b.templateId : '',
      actor: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      scope: effectiveScope,
      ...(effectiveScope === 'personal' ? { ownerPrincipalId: caller.canonicalUser } : {}),
      subscriberAttested: true,
      ...(b.name !== undefined ? { name: b.name as string } : {}),
    });
    if (!r.ok) return fail(res, r), true;
    json(res, 201, { signIn: r.signIn });
    return true;
  }

  const poll = path.match(/^\/api\/v1\/subscriptions\/sign-ins\/([^/]+)$/);
  if (poll && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.manage', resource: caller.resource }).allowed;
    const signInId = decodeURIComponent(poll[1]);
    const meta = km.getSignIn(signInId);
    if (!meta) {
      return json(res, 404, { error: 'unknown_sign_in', message: 'unknown sign-in (or already completed)' }), true;
    }
    if (meta.scope === 'factory') {
      if (!canManageAll) {
        return json(res, 404, { error: 'unknown_sign_in', message: 'unknown sign-in (or already completed)' }), true;
      }
    } else if (!caller.canonicalUser || meta.ownerPrincipalId !== caller.canonicalUser) {
      if (canManageAll) {
        return json(res, 403, {
          error: 'forbidden_connection',
          message: 'use X-Factory-Act-As to poll another principal\'s personal subscription sign-in',
        }), true;
      }
      return json(res, 404, { error: 'unknown_sign_in', message: 'unknown sign-in (or already completed)' }), true;
    }
    const r = await km.pollSignIn(signInId, principal.actor, {
      scope: meta.scope,
      ...(meta.ownerPrincipalId ? { ownerPrincipalId: meta.ownerPrincipalId } : {}),
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    });
    if (!r.ok) return fail(res, r), true;
    json(res, 200, r);
    return true;
  }

  const one = path.match(/^\/api\/v1\/subscriptions\/([^/]+)\/(reconnect|rename)$/);
  if (one && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.manage', resource: caller.resource }).allowed;
    const id = decodeURIComponent(one[1]);
    const existing = await km.get(id);
    if (!existing) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    if (existing.scope === 'factory') {
      if (!canManageAll) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    } else if (!caller.canonicalUser || existing.ownerPrincipalId !== caller.canonicalUser) {
      if (canManageAll) {
        return json(res, 403, {
          error: 'forbidden_connection',
          message: `use X-Factory-Act-As to ${one[2]} another principal's personal subscription connection`,
        }), true;
      }
      return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    }
    const b = await readJson(req);
    if (one[2] === 'rename') {
      const r = await km.rename(id, b.name, principal.actor, {
        ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      });
      if (!r.ok) return fail(res, r), true;
      json(res, 200, { connection: r.connection });
      return true;
    }
    const r = await km.reconnect(id, {
      actor: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      scope: existing.scope,
      ...(existing.ownerPrincipalId ? { ownerPrincipalId: existing.ownerPrincipalId } : {}),
      subscriberAttested: b.subscriberAttested === true,
    });
    if (!r.ok) return fail(res, r), true;
    json(res, 201, { signIn: r.signIn });
    return true;
  }

  const byId = path.match(/^\/api\/v1\/subscriptions\/([^/]+)$/);
  if (byId && req.method === 'PATCH') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.manage', resource: caller.resource }).allowed;
    const id = decodeURIComponent(byId[1]);
    const existing = await km.get(id);
    if (!existing) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    if (existing.scope === 'factory') {
      if (!canManageAll) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    } else if (!caller.canonicalUser || existing.ownerPrincipalId !== caller.canonicalUser) {
      if (canManageAll) {
        return json(res, 403, {
          error: 'forbidden_connection',
          message: "use X-Factory-Act-As to rename another principal's personal subscription connection",
        }), true;
      }
      return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    }
    const b = await readJson(req);
    const r = await km.rename(id, b.name, principal.actor, {
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    });
    if (!r.ok) return fail(res, r), true;
    json(res, 200, { connection: r.connection });
    return true;
  }

  if (byId && req.method === 'DELETE') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.manage', resource: caller.resource }).allowed;
    const id = decodeURIComponent(byId[1]);
    const existing = await km.get(id);
    if (!existing) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    if (existing.scope === 'factory') {
      if (!canManageAll) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    } else if (!canManageAll && (!caller.canonicalUser || existing.ownerPrincipalId !== caller.canonicalUser)) {
      return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    }
    const retire = retirers.get(state);
    const r = await km.disconnect(id, principal.actor, retire, {
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    });
    if (!r.ok) return fail(res, r), true;
    // A disconnected connection has no plan to be limited on: its window (M5(7)) closes with it.
    getSubscriptionWindows(state).close(r.connection.id, 'disconnect');
    json(res, 200, { connection: r.connection, entriesRetired: r.entriesRetired });
    return true;
  }

  return false;
}
