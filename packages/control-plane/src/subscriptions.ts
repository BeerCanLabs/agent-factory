/**
 * Subscription connections API (DESIGN_AUTHORITY.md §6.9 M5(4) to (6), §6.11 K1 to K4 as amended).
 *
 * A subscription connection is the factory's, not an agent's: an admin signs a subscriber in at the vendor with the vendor's
 * device-code flow, with the subscriber's confirmation attested, and the Keymaster holds the grant. Every route is admin only
 * (Bouncer privileges `subscriptions.read` and `subscriptions.manage`); no response carries a token.
 *
 *   GET    /api/v1/subscriptions                       connections, templates and reviewed instructions (K5.4)
 *   POST   /api/v1/subscriptions/connect               {templateId, subscriberAttested: true, name?} start a sign-in
 *   GET    /api/v1/subscriptions/sign-ins/:id          poll the sign-in; connects when the subscriber has signed in
 *   POST   /api/v1/subscriptions/:id/reconnect         {subscriberAttested: true} start a sign-in for this connection
 *   POST   /api/v1/subscriptions/:id/rename            {name}
 *   DELETE /api/v1/subscriptions/:id                   disconnect (retires the connection's catalog entries)
 *
 * Deferred to TSK-328 (the catalog does not exist yet): retiring a connection's catalog entries on disconnect goes through
 * `setSubscriptionEntryRetirer`; until it is set, no entries exist to retire and disconnect reports `entriesRetired: 0`.
 * Deferred to TSK-327: the gatekeeper-egress route that hands a token to the adapter (`SubscriptionKeymaster.accessToken`).
 */
import http from 'node:http';
import { SUBSCRIPTION_TEMPLATES } from '@beercanlabs/factory-contract';
import { SubscriptionKeymaster, catalogEntry, catalogView, type NeedsReconsentEvent, type SubscriptionView } from '@beercanlabs/factory-keymaster';
import { actorIsAdmin, json, readJson, requirePrivilege, type FactoryState } from './app.js';

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
  /** The admin who connected it, or every factory admin when that admin no longer holds the role. */
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

/** The admin who connected it, or every admin if that admin no longer holds the role. */
export function reconsentRecipients(state: FactoryState, connectedBy: string): string[] {
  return actorIsAdmin(state, connectedBy) ? [connectedBy] : factoryAdmins(state);
}

export async function notifyNeedsReconsent(state: FactoryState, ev: NeedsReconsentEvent): Promise<void> {
  const recipients = reconsentRecipients(state, ev.connection.connectedBy);
  // Each notice is auditable on its own, whether or not a delivery channel is wired.
  for (const to of recipients) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'factory', type: 'action', action: 'SUBSCRIPTION_RECONSENT_NOTIFIED', actor: 'factory:keymaster', provider: ev.connection.provider, connection: ev.connection.id, subject: to });
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
  provider_mismatch: 400,
  name_taken: 409,
  account_mismatch: 409,
  sign_in_expired: 410,
  sign_in_denied: 400,
  sign_in_rate_limited: 429,
  sign_in_unavailable: 502,
  discovery_invalid: 502,
  sign_in_failed: 502,
  profile_unavailable: 502,
};

const fail = (res: http.ServerResponse, f: { error: string; message: string }) => json(res, STATUS[f.error] ?? 400, { error: f.error, message: f.message });

/** Handles the subscriptions API. Returns false when the path is not one of its routes. */
export async function handleSubscriptions(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/v1/subscriptions' && !path.startsWith('/api/v1/subscriptions/')) return false;
  const km = getSubscriptions(state);

  if (path === '/api/v1/subscriptions' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'subscriptions.read'))) return true;
    const templates = Object.values(SUBSCRIPTION_TEMPLATES).map((t) => {
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
    json(res, 200, { connections: await km.list(), templates });
    return true;
  }

  if (path === '/api/v1/subscriptions/connect' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.manage');
    if (!principal) return true;
    const b = await readJson(req);
    const r = await km.startSignIn({
      templateId: typeof b.templateId === 'string' ? b.templateId : '',
      actor: principal.actor,
      subscriberAttested: b.subscriberAttested === true,
      ...(b.name !== undefined ? { name: b.name as string } : {}),
    });
    if (!r.ok) return fail(res, r), true;
    json(res, 201, { signIn: r.signIn });
    return true;
  }

  const poll = path.match(/^\/api\/v1\/subscriptions\/sign-ins\/([^/]+)$/);
  if (poll && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.manage');
    if (!principal) return true;
    const r = await km.pollSignIn(decodeURIComponent(poll[1]), principal.actor);
    if (!r.ok) return fail(res, r), true;
    json(res, 200, r);
    return true;
  }

  const one = path.match(/^\/api\/v1\/subscriptions\/([^/]+)\/(reconnect|rename)$/);
  if (one && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.manage');
    if (!principal) return true;
    const id = decodeURIComponent(one[1]);
    const b = await readJson(req);
    if (one[2] === 'rename') {
      const r = await km.rename(id, b.name, principal.actor);
      if (!r.ok) return fail(res, r), true;
      json(res, 200, { connection: r.connection });
      return true;
    }
    const existing = await km.get(id);
    if (!existing) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    const r = await km.startSignIn({ templateId: existing.templateId, actor: principal.actor, subscriberAttested: b.subscriberAttested === true, reconnect: id });
    if (!r.ok) return fail(res, r), true;
    json(res, 201, { signIn: r.signIn });
    return true;
  }

  const del = path.match(/^\/api\/v1\/subscriptions\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.manage');
    if (!principal) return true;
    const retire = retirers.get(state);
    const r = await km.disconnect(decodeURIComponent(del[1]), principal.actor, retire);
    if (!r.ok) return fail(res, r), true;
    json(res, 200, { connection: r.connection, entriesRetired: r.entriesRetired });
    return true;
  }

  return false;
}
