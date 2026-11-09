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
  type SubscriptionDiscoveredModel,
  type SubscriptionScope,
  type SubscriptionView,
} from '@beercanlabs/factory-keymaster';
import {
  actorIsAdmin,
  admitSubscriptionCatalogModel,
  checkOwnsPersonalAgent,
  effectiveGrantsForActor,
  json,
  ownedAgentIdsForPrincipal,
  parseModelPriceInput,
  readJson,
  requirePrivilege,
  retireCatalogModel,
  syncModelCatalogFromStore,
  type FactoryState,
} from './app.js';
import { rolesForSubjectActor } from './grants-routes.js';
import { ModelCatalogError } from './models.js';
import { getSubscriptionCaps } from './subscription-caps.js';
import { getSubscriptionWindows } from './subscription-windows.js';

const connectionViewsCache = new WeakMap<FactoryState, Map<string, SubscriptionView>>();

function viewMapOf(state: FactoryState): Map<string, SubscriptionView> {
  let m = connectionViewsCache.get(state);
  if (!m) {
    m = new Map();
    connectionViewsCache.set(state, m);
  }
  return m;
}

export function cacheSubscriptionView(state: FactoryState, view: SubscriptionView): void {
  viewMapOf(state).set(view.id, view);
  state.modelStore?.bumpVersion();
  syncModelCatalogFromStore(state);
}

export function cacheSubscriptionViews(state: FactoryState, views: SubscriptionView[]): void {
  const m = viewMapOf(state);
  for (const v of views) m.set(v.id, v);
  state.modelStore?.bumpVersion();
  syncModelCatalogFromStore(state);
}

export function evictCachedSubscriptionView(state: FactoryState, id: string): void {
  viewMapOf(state).delete(id);
  state.modelStore?.bumpVersion();
  syncModelCatalogFromStore(state);
}

export function getCachedSubscriptionView(state: FactoryState, id: string): SubscriptionView | undefined {
  return viewMapOf(state).get(id);
}

export function listCachedSubscriptionViews(state: FactoryState): SubscriptionView[] {
  return [...viewMapOf(state).values()];
}

export function bindModelStoreConnectionResolver(state: FactoryState): void {
  state.modelStore?.setConnectionResolver((connectionId) => {
    const v = getCachedSubscriptionView(state, connectionId);
    return v ? { name: v.name, ...(v.dailyTokenCap !== undefined ? { dailyTokenCap: v.dailyTokenCap } : {}) } : undefined;
  });
}

export function getSubscriptions(state: FactoryState): SubscriptionKeymaster {
  bindModelStoreConnectionResolver(state);
  if (!state.subscriptions) {
    state.subscriptions = new SubscriptionKeymaster({
      providers: state.providers,
      ledger: state.ledger,
      secretValues: state.secretValues,
      fetch: state.subscriptionFetch,
      now: state.subscriptionNow,
      version: state.version,
      onNeedsReconsent: (ev) => {
        cacheSubscriptionView(state, ev.connection);
        return notifyNeedsReconsent(state, ev);
      },
    });
    void state.subscriptions
      .list()
      .then((views) => cacheSubscriptionViews(state, views))
      .catch(() => {});
  }
  return state.subscriptions;
}

// ---- notification (K4 as amended by M5(6), plus M5(6)-(8) priced-fallback notices) ---------------

export type SubscriptionNotice =
  | {
      kind: 'needs_reconsent';
      connection: SubscriptionView;
      reason: string;
      /**
       * For `scope: 'factory'`: the connecting admin if still admin, else every factory admin.
       * For `scope: 'personal'`: `[ownerPrincipalId]` if that principal has an active human identity, else every factory admin.
       */
      recipients: string[];
    }
  | {
      kind: 'priced_fallback';
      agentId: string;
      connection: string;
      connectionName?: string;
      fallbackModel: string;
      reason: 'subscription_limit_reached' | 'subscription_needs_reconsent' | 'subscription_cap_reached';
      resetAt?: string;
      recipients: string[];
    };
export type SubscriptionNotifier = (notice: SubscriptionNotice) => void | Promise<void>;

const notifiers = new WeakMap<FactoryState, SubscriptionNotifier>();
export function setSubscriptionNotifier(state: FactoryState, fn: SubscriptionNotifier | undefined): void {
  if (fn) notifiers.set(state, fn);
  else notifiers.delete(state);
}

export async function dispatchSubscriptionNotice(state: FactoryState, notice: SubscriptionNotice): Promise<void> {
  const fn = notifiers.get(state);
  if (!fn) return;
  await fn(notice);
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
  try {
    await dispatchSubscriptionNotice(state, { kind: 'needs_reconsent', connection: ev.connection, reason: ev.reason, recipients });
  } catch (err) {
    console.error(`[subscriptions] notify needs_reconsent ${ev.connection.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- discovery, retirement & vendor-permission-withdrawn migration (M5(2), (4), (4a)) ------------

async function retireConnectionEntries(state: FactoryState, connection: SubscriptionView, actor: string): Promise<number> {
  const entries = state.modelStore?.listForConnection(connection.id) ?? [];
  let count = 0;
  for (const entry of entries) {
    if ((await retireCatalogModel(state, entry.name, actor)).retired) count += 1;
  }
  return count;
}

export type SubscriptionDiscoveryOutcome =
  | {
      ok: true;
      connection: SubscriptionView;
      listAvailable: true;
      models: SubscriptionDiscoveredModel[];
      entriesRetired: number;
    }
  | {
      ok: true;
      connection: SubscriptionView;
      listAvailable: false;
      reason: 'no_model_list' | 'vendor_refused';
      models: SubscriptionDiscoveredModel[];
      entriesRetired: 0;
    }
  | {
      ok: false;
      status: number;
      error: string;
      message?: string;
      connection?: SubscriptionView;
    };

/**
 * M5(4a): Discover the models a subscription connection's plan serves through Gatekeeper Egress
 * (`POST /internal/subscription-models`), storing the result on the connection without seeing the OAuth token.
 * When a successful discovery (`listAvailable: true`) drops a previously offered vendor model on that connection,
 * its catalog entries are retired with full M2 retirement transitions; failed or `no_model_list` / `vendor_refused`
 * discovery retires nothing.
 */
export async function discoverSubscriptionConnection(
  state: FactoryState,
  connectionId: string,
  actor = 'factory:subscription-discovery',
): Promise<SubscriptionDiscoveryOutcome> {
  const km = getSubscriptions(state);
  const existing = await km.get(connectionId);
  if (!existing) {
    return { ok: false, status: 404, error: 'unknown_connection', message: `no connection "${connectionId}"` };
  }
  if (!state.gatekeeperEgressUrl || !state.gatekeeperEgressToken) {
    return {
      ok: false,
      status: 503,
      error: 'egress_discovery_unconfigured',
      message: 'Gatekeeper Egress URL and token are required for subscription model discovery',
      connection: existing,
    };
  }

  const doFetch = state.discoverFetch ?? fetch;
  const discoveredAt = new Date((state.subscriptionNow ?? Date.now)()).toISOString();
  let res: Response;
  try {
    res = await doFetch(`${state.gatekeeperEgressUrl.replace(/\/$/, '')}/internal/subscription-models`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.gatekeeperEgressToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ connection: existing.id, templateId: existing.templateId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const saved = await km.saveDiscovery(existing.id, {
      listAvailable: false,
      status: 'failed',
      reason: message,
      discoveredAt,
    });
    if (saved.ok) cacheSubscriptionView(state, saved.connection);
    return {
      ok: false,
      status: 502,
      error: 'discovery_failed',
      message,
      connection: saved.ok ? saved.connection : existing,
    };
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (res.status === 409) {
    const saved = await km.saveDiscovery(existing.id, {
      listAvailable: false,
      status: 'needs_reconsent',
      reason: typeof body.error === 'string' ? body.error : 'subscription_needs_reconsent',
      discoveredAt,
    });
    if (saved.ok) cacheSubscriptionView(state, saved.connection);
    return {
      ok: false,
      status: 409,
      error: 'subscription_needs_reconsent',
      message: typeof body.message === 'string' ? body.message : 'subscription connection needs re-consent',
      connection: saved.ok ? saved.connection : existing,
    };
  }

  if (!res.ok) {
    const message = typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `egress HTTP ${res.status}`;
    const saved = await km.saveDiscovery(existing.id, {
      listAvailable: false,
      status: 'failed',
      reason: message,
      discoveredAt,
    });
    if (saved.ok) cacheSubscriptionView(state, saved.connection);
    return {
      ok: false,
      status: 502,
      error: 'discovery_failed',
      message,
      connection: saved.ok ? saved.connection : existing,
    };
  }

  if (body.listAvailable === false) {
    const reason: 'no_model_list' | 'vendor_refused' =
      body.reason === 'vendor_refused' ? 'vendor_refused' : 'no_model_list';
    const saved = await km.saveDiscovery(existing.id, {
      listAvailable: false,
      status: reason,
      reason,
      discoveredAt,
    });
    const updated = saved.ok ? saved.connection : existing;
    cacheSubscriptionView(state, updated);
    return {
      ok: true,
      connection: updated,
      listAvailable: false,
      reason,
      models: [],
      entriesRetired: 0,
    };
  }

  const rawModels = Array.isArray(body.models) ? body.models : [];
  const models: SubscriptionDiscoveredModel[] = rawModels
    .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object' && typeof (m as any).id === 'string'))
    .map((m) => ({
      id: String(m.id),
      ...(typeof m.displayName === 'string' ? { displayName: m.displayName } : {}),
    }));

  const saved = await km.saveDiscovery(existing.id, {
    listAvailable: true,
    status: 'ok',
    models,
    discoveredAt,
  });
  const updated = saved.ok ? saved.connection : existing;
  cacheSubscriptionView(state, updated);

  // M5(4a): When a successful discovery no longer lists a model on this connection, retire its catalog entries
  // and run M2 retirement transitions across agent policies.
  const presentIds = new Set(models.map((m) => m.id));
  let entriesRetired = 0;
  for (const entry of state.modelStore?.listForConnection(existing.id) ?? []) {
    if (!presentIds.has(entry.id)) {
      if ((await retireCatalogModel(state, entry.name, actor)).retired) {
        entriesRetired += 1;
      }
    }
  }

  return {
    ok: true,
    connection: updated,
    listAvailable: true,
    models,
    entriesRetired,
  };
}

/** Run discovery across all active subscription connections (daily schedule or ops sweep). */
export async function discoverAllActiveSubscriptions(state: FactoryState): Promise<void> {
  if (!state.gatekeeperEgressUrl || !state.gatekeeperEgressToken) return;
  const km = getSubscriptions(state);
  const all = await km.list();
  cacheSubscriptionViews(state, all);
  for (const conn of all) {
    if (conn.status !== 'active') continue;
    try {
      await discoverSubscriptionConnection(state, conn.id, 'factory:subscription-daily-discovery');
    } catch (err) {
      console.error(`[subscriptions] daily discovery ${conn.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function startSubscriptionDiscoveryTimer(
  state: FactoryState,
  intervalMs = 24 * 60 * 60 * 1000,
): ReturnType<typeof setInterval> | undefined {
  if (intervalMs <= 0) return undefined;
  const t = setInterval(() => {
    void discoverAllActiveSubscriptions(state);
  }, intervalMs);
  t.unref?.();
  return t;
}

/**
 * M5(2): Migration helper when a vendor withdraws third-party subscription permission.
 * Retires every subscription catalog entry for that vendor/template (running full M2 retirement transitions + `POLICY_UPDATED`)
 * and disconnects all factory and personal subscription connections for that vendor, ledgered as `SUBSCRIPTION_DISCONNECTED`
 * by `migration:vendor-permission-withdrawn`.
 */
export async function withdrawSubscriptionVendor(
  state: FactoryState,
  vendorOrTemplateId: string,
): Promise<{ vendor: string; connectionsDisconnected: number; entriesRetired: number }> {
  const actor = 'migration:vendor-permission-withdrawn';
  const trimmed = vendorOrTemplateId.trim().toLowerCase();
  const vendor = trimmed.endsWith('-subscription') ? trimmed.slice(0, -'-subscription'.length) : trimmed;
  const templateId = `${vendor}-subscription`;

  let entriesRetired = 0;
  for (const entry of state.modelStore?.listOffered() ?? []) {
    if (entry.credentialMode !== 'subscription') continue;
    const matchesVendor =
      entry.provider.toLowerCase() === vendor ||
      entry.provider.toLowerCase() === templateId ||
      entry.templateId?.toLowerCase() === templateId ||
      entry.templateId?.toLowerCase() === trimmed;
    if (matchesVendor && (await retireCatalogModel(state, entry.name, actor)).retired) {
      entriesRetired += 1;
    }
  }

  const km = getSubscriptions(state);
  const customRetirer = retirers.get(state);
  const disconnected = await km.disconnectVendor(vendor, actor, async (conn) => {
    const extra = customRetirer ? await customRetirer(conn) : await retireConnectionEntries(state, conn, actor);
    entriesRetired += extra;
    return extra;
  });
  for (const item of disconnected) {
    const conn = item.connection;
    getSubscriptionWindows(state).close(conn.id, 'disconnect');
    getSubscriptionCaps(state).closeConnection(conn.id, 'disconnect');
    evictCachedSubscriptionView(state, conn.id);
  }

  return {
    vendor,
    connectionsDisconnected: disconnected.length,
    entriesRetired,
  };
}

// ---- routes ----------------------------------------------------------------------------------------

const STATUS: Record<string, number> = {
  unknown_template: 404,
  unknown_connection: 404,
  unknown_sign_in: 404,
  attestation_required: 400,
  invalid_name: 400,
  invalid_cap: 400,
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

export type NotOfferedSubscriptionVendor = {
  vendor: 'anthropic' | 'google';
  name: string;
  reason: string;
  statementUrls: readonly string[];
  checkedDate: string;
};

/** M5(2): Consumer subscriptions explicitly NOT offered in Agent Factory, with vendor reason and checked date. */
export const NOT_OFFERED_SUBSCRIPTION_VENDORS: readonly NotOfferedSubscriptionVendor[] = Object.freeze([
  Object.freeze({
    vendor: 'anthropic',
    name: 'Anthropic (Claude Pro / Max)',
    reason:
      "Anthropic's legal and compliance terms limit Claude Pro and Max subscriptions to Anthropic's own products and prohibit OAuth tokens from consumer plans in third-party or custom agent software. Use an Anthropic API key or AWS Bedrock instead.",
    statementUrls: Object.freeze(['https://code.claude.com/docs/en/legal-and-compliance']),
    checkedDate: '2026-11-07',
  }),
  Object.freeze({
    vendor: 'google',
    name: 'Google (Gemini / Antigravity)',
    reason:
      "Google's Gemini CLI and Antigravity terms prohibit third-party agent software from using consumer subscription credentials, and Google suspends accounts that do so. Use a Gemini API key or Vertex AI instead.",
    statementUrls: Object.freeze(['https://geminicli.com/docs/resources/tos-privacy', 'https://antigravity.google/terms']),
    checkedDate: '2026-11-07',
  }),
]);

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

function enrichConnectionsForCaller(
  state: FactoryState,
  connections: SubscriptionView[],
  opts: { canReadAll: boolean; canonicalUser?: string },
) {
  const windows = getSubscriptionWindows(state);
  const allActiveCaps = getSubscriptionCaps(state).listActive();
  const visibleAgentIds = opts.canReadAll
    ? undefined
    : new Set(opts.canonicalUser ? ownedAgentIdsForPrincipal(state, opts.canonicalUser) : []);

  return connections.map((c) => {
    const openWindow = windows.get(c.id);
    const activeCaps = allActiveCaps.filter(
      (cap) => cap.connection === c.id && (visibleAgentIds === undefined || visibleAgentIds.has(cap.agentId)),
    );
    const catalogModels = state.modelStore
      ? state.modelStore.listForConnection(c.id).map((m) => state.modelStore!.enrich(m))
      : [];
    return {
      ...c,
      ...(openWindow
        ? {
            limitWindow: {
              kind: openWindow.kind,
              code: openWindow.code,
              openedAt: openWindow.openedAt,
              ...(openWindow.resetAt ? { resetAt: openWindow.resetAt } : {}),
              ...(openWindow.lastProbeAt ? { lastProbeAt: openWindow.lastProbeAt } : {}),
            },
          }
        : {}),
      ...(activeCaps.length > 0 ? { activeCaps } : {}),
      ...(catalogModels.length > 0 ? { catalogModels } : {}),
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
      const connections = await km.list({ scope: 'factory' });
      cacheSubscriptionViews(state, connections);
      json(res, 200, {
        connections: enrichConnectionsForCaller(state, connections, { canReadAll: true }),
        templates: templateViews(),
        notOffered: NOT_OFFERED_SUBSCRIPTION_VENDORS,
      });
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
    cacheSubscriptionViews(state, connections);
    json(res, 200, {
      connections: enrichConnectionsForCaller(state, connections, { canReadAll, canonicalUser: caller.canonicalUser }),
      templates: templateViews(),
      notOffered: NOT_OFFERED_SUBSCRIPTION_VENDORS,
    });
    return true;
  }

  if (path === '/api/v1/subscriptions/spend' && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canReadAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.read', resource: caller.resource }).allowed;
    const now = state.subscriptionNow ? new Date(state.subscriptionNow()) : undefined;
    const allViews = await km.list();
    cacheSubscriptionViews(state, allViews);
    const viewById = new Map(allViews.map((v) => [v.id, v]));
    if (canReadAll) {
      const report = state.spend.subscriptionReport(now);
      json(res, 200, enrichSubscriptionSpendReport(report, viewById));
      return true;
    }
    const ownConnections = new Set(
      caller.canonicalUser
        ? allViews.filter((v) => v.scope === 'personal' && v.ownerPrincipalId === caller.canonicalUser).map((v) => v.id)
        : [],
    );
    const ownAgents = new Set(caller.canonicalUser ? ownedAgentIdsForPrincipal(state, caller.canonicalUser) : []);
    const report = state.spend.subscriptionReport(now, {
      connections: ownConnections,
      agents: ownAgents,
    });
    json(res, 200, enrichSubscriptionSpendReport(report, viewById));
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
    if (r.status === 'connected') {
      cacheSubscriptionView(state, r.connection);
      if (state.gatekeeperEgressUrl && state.gatekeeperEgressToken) {
        const disc = await discoverSubscriptionConnection(
          state,
          r.connection.id,
          r.reconnect ? 'factory:subscription-reconnect' : 'factory:subscription-connect',
        );
        if (disc.connection) {
          json(res, 200, { ...r, connection: disc.connection });
          return true;
        }
      }
    }
    json(res, 200, r);
    return true;
  }

  const one = path.match(/^\/api\/v1\/subscriptions\/([^/]+)\/(reconnect|rename|discover)$/);
  if (one && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageAll = authorize({ principal: caller.evalPrincipal, privilege: 'subscriptions.manage', resource: caller.resource }).allowed;
    const id = decodeURIComponent(one[1]);
    const existing = await km.get(id);
    if (!existing) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    cacheSubscriptionView(state, existing);
    if (existing.scope === 'factory') {
      if (!canManageAll) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    } else if (!caller.canonicalUser || existing.ownerPrincipalId !== caller.canonicalUser) {
      if (canManageAll && one[2] !== 'discover') {
        return json(res, 403, {
          error: 'forbidden_connection',
          message: `use X-Factory-Act-As to ${one[2]} another principal's personal subscription connection`,
        }), true;
      }
      if (!canManageAll) {
        return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
      }
    }
    if (one[2] === 'discover') {
      const disc = await discoverSubscriptionConnection(state, id, principal.actor);
      if (!disc.ok) {
        json(res, disc.status, {
          error: disc.error,
          ...(disc.message ? { message: disc.message } : {}),
          ...(disc.connection ? { connection: disc.connection } : {}),
        });
        return true;
      }
      json(res, 200, {
        connection: disc.connection,
        listAvailable: disc.listAvailable,
        ...(disc.listAvailable ? {} : { reason: disc.reason }),
        models: disc.models,
        entriesRetired: disc.entriesRetired,
      });
      return true;
    }
    const b = await readJson(req);
    if (one[2] === 'rename') {
      const r = await km.rename(id, b.name, principal.actor, {
        ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      });
      if (!r.ok) return fail(res, r), true;
      cacheSubscriptionView(state, r.connection);
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

  const subModels = path.match(/^\/api\/v1\/subscriptions\/([^/]+)\/models$/);
  if (subModels && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageModels = authorize({ principal: caller.evalPrincipal, privilege: 'models.manage', resource: caller.resource }).allowed;
    const id = decodeURIComponent(subModels[1]);
    const existing = await km.get(id);
    if (!existing) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    cacheSubscriptionView(state, existing);

    if (existing.scope === 'factory') {
      if (!(await requirePrivilege(req, res, state, 'models.manage'))) return true;
      if (!canManageModels) {
        json(res, 403, {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: 'adding catalog entries from a factory subscription requires models.manage',
        });
        return true;
      }
    } else if (!caller.canonicalUser || existing.ownerPrincipalId !== caller.canonicalUser) {
      if (canManageModels) {
        return json(res, 403, {
          error: 'forbidden_connection',
          message: "use X-Factory-Act-As to add catalog entries from another principal's personal subscription connection",
        }), true;
      }
      return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    }

    if (!SUBSCRIPTION_TEMPLATES[existing.templateId]) {
      json(res, 403, {
        error: 'subscription_not_permitted',
        message: `subscription template '${existing.templateId}' is not permitted by DESIGN_AUTHORITY.md §6.9 M5(2)`,
      });
      return true;
    }

    const b = await readJson(req);
    const rawName = typeof b.name === 'string' ? b.name.trim() : '';
    const rawModelId = typeof b.modelId === 'string' ? b.modelId.trim() : typeof b.id === 'string' ? b.id.trim() : '';
    if (!rawName || !rawModelId || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(rawModelId)) {
      json(res, 400, { error: 'invalid_model', message: 'name and valid vendor modelId are required' });
      return true;
    }

    if (existing.discovery?.listAvailable === true && Array.isArray(existing.discoveredModels)) {
      const inPlan = existing.discoveredModels.some((m) => m.id === rawModelId);
      if (!inPlan) {
        json(res, 422, {
          error: 'model_not_in_subscription_plan',
          message: `model '${rawModelId}' was not returned by discovery for subscription connection '${existing.name}'`,
        });
        return true;
      }
    }

    let parsedPrice: { inputPerMTok: number; outputPerMTok: number } | undefined;
    if (existing.scope === 'personal') {
      if (b.price !== undefined) {
        const p = parseModelPriceInput(b.price);
        if (!p.ok || p.price.inputPerMTok !== 0 || p.price.outputPerMTok !== 0) {
          json(res, 400, {
            error: 'personal_model_price_immutable',
            message: 'personal BYOM subscription entries have a fixed immutable $0 price',
          });
          return true;
        }
      }
      parsedPrice = { inputPerMTok: 0, outputPerMTok: 0 };
    } else if (b.price !== undefined) {
      const p = parseModelPriceInput(b.price);
      if (!p.ok) {
        json(res, 400, { error: 'invalid_price', message: p.error });
        return true;
      }
      parsedPrice = p.price;
    }

    try {
      const stored = admitSubscriptionCatalogModel(state, {
        name: rawName,
        provider: existing.templateId,
        id: rawModelId,
        connection: existing.id,
        connectionName: existing.name,
        templateId: existing.templateId,
        scope: existing.scope,
        ...(existing.ownerPrincipalId ? { ownerPrincipalId: existing.ownerPrincipalId } : {}),
        ...(parsedPrice ? { price: parsedPrice } : {}),
        actor: principal.actor,
        ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      });
      const enriched = state.modelStore ? state.modelStore.enrich(stored) : stored;
      json(res, 201, { ok: true, model: enriched });
      return true;
    } catch (err) {
      if (err instanceof ModelCatalogError) {
        json(res, err.status, { error: err.code, message: err.message });
        return true;
      }
      json(res, 400, { error: 'admit_failed', message: err instanceof Error ? err.message : String(err) });
      return true;
    }
  }

  const subModelItem = path.match(/^\/api\/v1\/subscriptions\/([^/]+)\/models\/([^/]+)$/);
  if (subModelItem && req.method === 'DELETE') {
    const principal = await requirePrivilege(req, res, state, 'subscriptions.own');
    if (!principal) return true;
    const caller = resolveCaller(state, principal);
    if (!caller.ok) return json(res, 503, { error: caller.error }), true;
    const canManageModels = authorize({ principal: caller.evalPrincipal, privilege: 'models.manage', resource: caller.resource }).allowed;
    const id = decodeURIComponent(subModelItem[1]);
    const modelName = decodeURIComponent(subModelItem[2]);
    const existing = await km.get(id);
    if (!existing) return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    cacheSubscriptionView(state, existing);

    if (existing.scope === 'factory') {
      if (!(await requirePrivilege(req, res, state, 'models.manage'))) return true;
      if (!canManageModels) {
        json(res, 403, {
          error: 'forbidden',
          required: 'admin',
          requiredRole: 'admin',
          message: 'retiring catalog entries on a factory subscription requires models.manage',
        });
        return true;
      }
    } else if (!canManageModels && (!caller.canonicalUser || existing.ownerPrincipalId !== caller.canonicalUser)) {
      return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    }

    const offered = state.modelStore?.getOffered(modelName);
    if (!offered || offered.credentialMode !== 'subscription' || offered.connection !== existing.id) {
      json(res, 404, { error: 'model_not_found', message: `no catalog entry '${modelName}' on connection '${id}'` });
      return true;
    }
    const retired = await retireCatalogModel(state, modelName, principal.actor, {
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    });
    json(res, 200, { ok: true, retired: modelName, policiesUpdated: retired.policiesUpdated });
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
          message: "use X-Factory-Act-As to update another principal's personal subscription connection",
        }), true;
      }
      return json(res, 404, { error: 'unknown_connection', message: `no connection "${id}"` }), true;
    }
    const b = await readJson(req);
    const hasName = b.name !== undefined;
    const hasCap = Object.prototype.hasOwnProperty.call(b, 'dailyTokenCap');
    if (!hasName && !hasCap) {
      return fail(res, { error: 'invalid_name', message: 'name or dailyTokenCap is required' }), true;
    }
    let updatedView = existing;
    if (hasName) {
      const r = await km.rename(id, b.name, principal.actor, {
        ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      });
      if (!r.ok) return fail(res, r), true;
      updatedView = r.connection;
    }
    if (hasCap) {
      const r = await km.setDailyTokenCap(id, b.dailyTokenCap, principal.actor, {
        ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      });
      if (!r.ok) return fail(res, r), true;
      updatedView = r.connection;
      cacheSubscriptionView(state, updatedView);
      getSubscriptionCaps(state).evaluateConnection(id, updatedView);
    } else {
      cacheSubscriptionView(state, updatedView);
    }
    json(res, 200, { connection: updatedView });
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
    const customRetirer = retirers.get(state);
    const effectiveRetirer: SubscriptionEntryRetirer =
      customRetirer ?? ((conn) => retireConnectionEntries(state, conn, principal.actor));
    const r = await km.disconnect(id, principal.actor, effectiveRetirer, {
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
    });
    if (!r.ok) return fail(res, r), true;
    // A disconnected connection has no plan to be limited or capped on: its window and caps close with it.
    getSubscriptionWindows(state).close(r.connection.id, 'disconnect');
    getSubscriptionCaps(state).closeConnection(r.connection.id, 'disconnect');
    evictCachedSubscriptionView(state, r.connection.id);
    json(res, 200, { connection: r.connection, entriesRetired: r.entriesRetired });
    return true;
  }

  return false;
}

export function enrichSubscriptionSpendReport(
  report: ReturnType<FactoryState['spend']['subscriptionReport']>,
  viewById: Map<string, SubscriptionView>,
) {
  const connections = Object.fromEntries(
    Object.entries(report.connections).map(([connId, entry]) => {
      const v = viewById.get(connId);
      return [
        connId,
        {
          ...entry,
          ...(v
            ? {
                connectionName: v.name,
                vendor: v.provider,
                status: v.status,
                scope: v.scope,
                ...(v.ownerPrincipalId ? { ownerPrincipalId: v.ownerPrincipalId } : {}),
                ...(v.dailyTokenCap !== undefined ? { dailyTokenCap: v.dailyTokenCap } : {}),
              }
            : {}),
        },
      ];
    }),
  );
  return {
    day: report.day,
    month: report.month,
    connections,
    agents: report.agents,
  };
}
