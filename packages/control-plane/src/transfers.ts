/**
 * S3b (D15, D26, D23): two-phase content-ownership transfer for personal agents and skills.
 *
 *   GET  /api/v1/agents/:id/transfer           outgoing owner, recipient, or admin: the pending transfer (or null)
 *   POST /api/v1/agents/:id/transfer           active content-owner or admin: { "to": "<user:id | email>" }
 *   POST /api/v1/agents/:id/transfer/accept    the recipient (an admin completes for them via act-as)
 *   POST /api/v1/agents/:id/transfer/decline   the recipient (or admin)
 *   POST /api/v1/agents/:id/transfer/cancel    the outgoing owner (or admin)
 *
 * Skills use the same transaction through `/api/v1/skills/:id/transfer[/accept|/decline|/cancel]` when the grant store
 * is configured (`handleSkillGrantTransfer`).
 *
 * Starting a transfer writes `pending-revoked` (outgoing) and `pending-accepted` (incoming) in one GrantStore commit
 * with a 7-day TTL. While pending, the outgoing owner is read-only (Bouncer: `content-owner-readonly`) and the recipient
 * holds nothing yet. Decline, cancel, or the stale-pending sweeper restores the outgoing owner unchanged (OAuth
 * connections intact). Accept promotes the recipient and revokes the outgoing grant; for a personal agent it also
 * purges every `oauth-user` grant (ConnectionKeymaster) on the agent and detaches the outgoing owner's private skills,
 * while static `credentials.agent.*` secrets stay. Team agents refuse with 409. Every step is ledgered.
 */
import http from 'node:http';
import { payloadHash } from '@beercanlabs/factory-ledger';
import type { Principal } from '@beercanlabs/factory-auth';
import { GrantStoreError, GrantStoreUnavailableError, PrincipalStoreUnavailableError, authorize, normalizeActorToPrincipal, type GrantRecord } from '@beercanlabs/factory-bouncer';
import { effectiveAgentKind } from '@beercanlabs/factory-registrar';
import { writableProvider } from '@beercanlabs/factory-secrets-bind';
import { agentKindOf, detachDisallowedPersonalModelsOnAgent, effectiveGrantsForActor, findAgentRecord, identify, json, readJson, type FactoryState } from './app.js';
import { getConnections } from './connections.js';
import { detachOwnerPrivateSkills, skillRegistry } from './skills.js';

export type TransferScope = { kind: 'agent' | 'skill'; id: string };
export type TransferAction = 'accept' | 'decline' | 'cancel';
export type TransferOutcome = { status: number; body: Record<string, unknown> };

/** Notification hook (channel / inbox) for the recipient and the outgoing owner; ledgering never depends on it. */
export type TransferNotifier = (event: {
  kind: 'started' | 'accepted' | 'declined' | 'cancelled' | 'expired';
  scope: TransferScope;
  transferId: string;
  from: string;
  to: string;
}) => void | Promise<void>;

const notifiers = new WeakMap<FactoryState, TransferNotifier>();
export function setTransferNotifier(state: FactoryState, fn: TransferNotifier | undefined): void {
  if (fn) notifiers.set(state, fn);
  else notifiers.delete(state);
}

async function notify(state: FactoryState, event: Parameters<TransferNotifier>[0]): Promise<void> {
  const fn = notifiers.get(state);
  if (!fn) return;
  try {
    await fn(event);
  } catch (err) {
    console.error(`[transfers] notify ${event.kind} ${event.scope.kind}:${event.scope.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function ledgerKey(scope: TransferScope): string {
  return scope.kind === 'agent' ? scope.id : `skill:${scope.id}`;
}

function ledgerTransfer(state: FactoryState, scope: TransferScope, action: string, actor: string, detail: Record<string, unknown>): void {
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: ledgerKey(scope),
    type: 'action',
    action,
    actor,
    requestId: typeof detail.transferId === 'string' ? `transfer:${detail.transferId}` : undefined,
    payloadSha256: payloadHash({ scope, ...detail }),
  });
}

function canonical(state: FactoryState, actor: string): string {
  try {
    return normalizeActorToPrincipal(actor, state.principals);
  } catch {
    return actor.toLowerCase();
  }
}

type Caller = { principal: Principal; subject: string; isAdmin: boolean };

function callerOf(state: FactoryState, principal: Principal): Caller | TransferOutcome {
  const g = effectiveGrantsForActor(state, principal.actor);
  if (!g.ok) return { status: 503, body: { error: g.error } };
  const isAdmin = authorize({ principal, privilege: 'grants.manage', ...(g.grants !== undefined ? { resource: { grants: g.grants } } : {}) }).allowed;
  // D23 act-as: the person acted for is the one whose ownership or acceptance counts; admin authority stays the caller's.
  return { principal, subject: canonical(state, principal.onBehalfOf ?? principal.actor), isAdmin };
}

function storeReady(state: FactoryState): TransferOutcome | undefined {
  if (!state.grants) return { status: 501, body: { error: 'grant_store_not_configured', message: 'ownership transfer requires the grant store (S2)' } };
  if (!state.grants.healthy) return { status: 503, body: { error: 'grant_store_unavailable' } };
  if (state.principals && !state.principals.healthy) return { status: 503, body: { error: 'principal_store_unavailable' } };
  return undefined;
}

function fromStoreError(err: unknown): TransferOutcome {
  if (err instanceof GrantStoreError) return { status: err.status, body: { error: err.code, message: err.message } };
  if (err instanceof GrantStoreUnavailableError || err instanceof PrincipalStoreUnavailableError) return { status: 503, body: { error: err.code } };
  throw err;
}

function scopeGrants(state: FactoryState, scope: TransferScope): GrantRecord[] {
  return state.grants!.list({ scopeKind: scope.kind, scopeId: scope.id.toLowerCase(), includeExpired: true }).filter((g) => g.role === 'content-owner');
}

/** The live pending pair on `scope` (expired pairs are the sweeper's), or undefined. */
export function pendingTransferOf(state: FactoryState, scope: TransferScope, now = Date.now()) {
  const grants = scopeGrants(state, scope);
  const outgoing = grants.find((g) => g.state === 'pending-revoked' && g.transferId);
  if (!outgoing) return undefined;
  const incoming = grants.find((g) => g.state === 'pending-accepted' && g.transferId === outgoing.transferId);
  if (!incoming) return undefined;
  const expiresAt = outgoing.pendingExpiresAt ?? incoming.pendingExpiresAt ?? null;
  if (expiresAt && Date.parse(expiresAt) <= now) return undefined;
  return { transferId: outgoing.transferId!, from: outgoing.subject, to: incoming.subject, pendingExpiresAt: expiresAt, startedAt: incoming.createdAt, startedBy: incoming.createdBy };
}

function scopeExists(state: FactoryState, scope: TransferScope): boolean {
  return scope.kind === 'agent' ? !!findAgentRecord(state, scope.id) : skillRegistry(state).versions(scope.id).length > 0;
}

function isTeamAgent(state: FactoryState, agentId: string): boolean {
  const rec = findAgentRecord(state, agentId);
  return (rec ? effectiveAgentKind(rec) : agentKindOf(state, agentId)) === 'team';
}

export async function getTransfer(state: FactoryState, principal: Principal, scope: TransferScope): Promise<TransferOutcome> {
  const unready = storeReady(state);
  if (unready) return unready;
  const caller = callerOf(state, principal);
  if ('status' in caller) return caller;
  if (!scopeExists(state, scope)) return { status: 404, body: { error: 'not_found', scope } };
  const pending = pendingTransferOf(state, scope);
  const owner = state.grants!.activeContentOwnerOf(scope);
  if (!caller.isAdmin && caller.subject !== owner && caller.subject !== pending?.from && caller.subject !== pending?.to) {
    return { status: 403, body: { error: 'forbidden', required: 'admin', requiredRole: 'content-owner' } };
  }
  return { status: 200, body: { scope, transfer: pending ?? null } };
}

export async function startTransfer(state: FactoryState, principal: Principal, scope: TransferScope, body: Record<string, unknown>): Promise<TransferOutcome> {
  const unready = storeReady(state);
  if (unready) return unready;
  const caller = callerOf(state, principal);
  if ('status' in caller) return caller;
  if (!scopeExists(state, scope)) return { status: 404, body: { error: 'not_found', scope } };
  const owner = state.grants!.activeContentOwnerOf(scope);
  if (!caller.isAdmin && caller.subject !== owner) {
    return { status: 403, body: { error: 'forbidden', required: 'admin', requiredRole: 'content-owner' } };
  }
  // AC3 (D11): a team agent has an accountable-lead, not a transferable owner.
  if (scope.kind === 'agent' && isTeamAgent(state, scope.id)) {
    return { status: 409, body: { error: 'agent_kind_conflict', message: `team agent '${scope.id}' does not support ownership transfer` } };
  }
  const to = typeof body.to === 'string' ? body.to.trim() : typeof body.recipient === 'string' ? body.recipient.trim() : '';
  if (!to) return { status: 400, body: { error: 'invalid_recipient', message: 'to is required (user:<id> or email)' } };
  if (!owner) return { status: 409, body: { error: 'transfer_conflict', message: `${scope.kind} '${scope.id}' has no active content-owner to transfer from` } };
  let started;
  try {
    started = await state.grants!.startOwnershipTransfer({
      scope,
      fromSubject: owner,
      toSubject: to.includes('@') && !to.includes(':') ? `user:${to}` : to,
      by: principal.actor,
      ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}),
      granterIsAdmin: caller.isAdmin,
    });
  } catch (err) {
    return fromStoreError(err);
  }
  const detachedModels =
    scope.kind === 'agent'
      ? (await detachDisallowedPersonalModelsOnAgent(state, scope.id, principal.actor, 'ownership transfer started — pending-revoked (D15)')).detached
      : [];
  const detail = {
    transferId: started.transferId,
    from: started.outgoing.subject,
    to: started.incoming.subject,
    pendingExpiresAt: started.incoming.pendingExpiresAt,
    ...(detachedModels.length ? { personalModelsDetached: detachedModels } : {}),
  };
  ledgerTransfer(state, scope, 'OWNERSHIP_TRANSFER_STARTED', principal.actor, detail);
  await notify(state, { kind: 'started', scope, transferId: started.transferId, from: detail.from, to: detail.to });
  return { status: 202, body: { scope, transfer: { ...detail, state: 'pending' } } };
}

/**
 * Every provider that may hold a user-OAuth grant on `agentId`: the factory's oauth-user systems, the agent's declared
 * connections, and any `connections/<agentId>/<provider>` secret a listing backend reports (a provider removed from the
 * catalog can still hold an old owner's token).
 */
async function oauthProvidersFor(state: FactoryState, agentId: string): Promise<string[]> {
  const agent = state.agents.get(agentId) ?? findAgentRecord(state, agentId);
  const names = new Set<string>([
    ...(state.systems?.getConnectionProviders().filter((p) => p.kind === 'oauth-user').map((p) => p.provider) ?? []),
    ...((agent as { connections?: Array<{ provider: string }> } | undefined)?.connections?.map((c) => c.provider) ?? []),
  ]);
  const prefix = `connections/${agentId}/`;
  for (const p of state.providers) {
    if (!p.present) continue;
    try {
      for (const n of await p.present()) if (n.startsWith(prefix) && !n.slice(prefix.length).includes('/')) names.add(n.slice(prefix.length));
    } catch (err) {
      console.error(`[transfers] list ${p.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return [...names];
}

async function hasUserOAuthGrants(state: FactoryState, agentId: string): Promise<boolean> {
  const km = getConnections(state);
  for (const provider of await oauthProvidersFor(state, agentId)) {
    const def = await km.resolveProvider(provider).catch(() => undefined);
    if (def && def.kind !== 'oauth-user') continue;
    if (await km.getGrant(agentId, provider).catch(() => undefined)) return true;
  }
  return false;
}

/** Purges every `oauth-user` grant on a personal agent (D15). Returns purged and failed providers; never token values. */
async function purgeUserOAuth(state: FactoryState, agentId: string, actor: string): Promise<{ purged: string[]; failed: string[] }> {
  const purged: string[] = [];
  const failed: string[] = [];
  const km = getConnections(state);
  for (const provider of await oauthProvidersFor(state, agentId)) {
    try {
      const def = await km.resolveProvider(provider);
      if (def && def.kind !== 'oauth-user') continue; // app-level (jwt-bearer) credentials are not personal tokens
      if (await km.purgeGrant(agentId, provider, actor)) purged.push(provider);
    } catch (err) {
      console.error(`[transfers] purge ${agentId}/${provider}: ${err instanceof Error ? err.message : String(err)}`);
      failed.push(provider);
    }
  }
  return { purged, failed };
}

export async function resolveTransfer(state: FactoryState, principal: Principal, scope: TransferScope, action: TransferAction): Promise<TransferOutcome> {
  const unready = storeReady(state);
  if (unready) return unready;
  const caller = callerOf(state, principal);
  if ('status' in caller) return caller;
  if (!scopeExists(state, scope)) return { status: 404, body: { error: 'not_found', scope } };
  const pending = pendingTransferOf(state, scope);
  if (!pending) return { status: 404, body: { error: 'transfer_not_found', message: `no pending transfer on ${scope.kind} '${scope.id}'` } };

  // accept: only the recipient (an admin completes for a recipient via act-as, D23). decline: recipient or admin.
  // cancel: the outgoing owner (read-only while pending, but may withdraw) or admin.
  const allowed =
    action === 'accept' ? caller.subject === pending.to : action === 'decline' ? caller.subject === pending.to || caller.isAdmin : caller.subject === pending.from || caller.isAdmin;
  if (!allowed) {
    const requiredRole = action === 'cancel' ? 'content-owner' : 'transfer-recipient';
    return { status: 403, body: { error: 'forbidden', requiredRole, message: `only the ${action === 'cancel' ? 'outgoing owner or an admin' : action === 'accept' ? 'recipient' : 'recipient or an admin'} may ${action} this transfer` } };
  }

  // D15: on accept of a personal agent, purging the outgoing owner's OAuth tokens needs a writable secrets backend;
  // refuse before ownership moves rather than hand the new owner the old owner's tokens.
  const personalAgent = scope.kind === 'agent' && !isTeamAgent(state, scope.id);
  const detail: Record<string, unknown> = { transferId: pending.transferId, from: pending.from, to: pending.to };

  // D15: for a personal agent the outgoing owner's OAuth tokens and private skills are removed BEFORE ownership moves,
  // so a failed cleanup can never hand them to the new owner: on any failure the transfer stays pending (the outgoing
  // owner is still read-only and may cancel; the recipient may retry). Failing this way only ever removes access.
  if (action === 'accept' && personalAgent) {
    if (!writableProvider(state.providers) && (await hasUserOAuthGrants(state, scope.id))) {
      return { status: 503, body: { error: 'connections_unpurgeable', message: 'no writable secrets backend: personal OAuth tokens could not be purged, so the transfer was not accepted' } };
    }
    const oauth = await purgeUserOAuth(state, scope.id, principal.actor);
    const skills = oauth.failed.length ? { detached: [] as string[], failed: [] as string[] } : await detachOwnerPrivateSkills(state, scope.id, pending.from, principal.actor);
    detail.oauthPurged = oauth.purged;
    detail.privateSkillsDetached = skills.detached;
    if (oauth.failed.length || skills.failed.length) {
      detail.oauthPurgeFailed = oauth.failed;
      detail.privateSkillDetachFailed = skills.failed;
      ledgerTransfer(state, scope, 'OWNERSHIP_TRANSFER_CLEANUP_FAILED', principal.actor, detail);
      return { status: 500, body: { error: 'transfer_cleanup_failed', message: 'the outgoing owner’s OAuth tokens or private skills could not all be removed; ownership did not move. Retry accept, or cancel.', ...detail } };
    }
  }

  try {
    await state.grants!.resolveOwnershipTransfer({ transferId: pending.transferId, action, by: principal.actor, ...(principal.onBehalfOf ? { onBehalfOf: principal.onBehalfOf } : {}) });
  } catch (err) {
    return fromStoreError(err);
  }

  if (action === 'accept' && scope.kind === 'agent') {
    const { detached: detachedModels } = await detachDisallowedPersonalModelsOnAgent(state, scope.id, principal.actor, 'ownership transfer accepted (D15)');
    if (detachedModels.length) detail.personalModelsDetached = detachedModels;
  }

  if (action === 'accept' && scope.kind === 'skill') {
    // Keep the registry's legacy owner field in step with the grant (used where no grant store is configured).
    try {
      skillRegistry(state).setOwner(scope.id, pending.to);
    } catch (err) {
      console.error(`[transfers] skill owner sync ${scope.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const verb = action === 'accept' ? 'ACCEPTED' : action === 'decline' ? 'DECLINED' : 'CANCELLED';
  ledgerTransfer(state, scope, `OWNERSHIP_TRANSFER_${verb}`, principal.actor, detail);
  await notify(state, { kind: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled', scope, transferId: pending.transferId, from: pending.from, to: pending.to });
  return {
    status: 200,
    body: {
      scope,
      action,
      owner: action === 'accept' ? pending.to : pending.from,
      ...detail,
    },
  };
}

/**
 * Stale-pending sweeper (D15): expired transfers roll back, restoring the outgoing owner's write grant. Ledgered per
 * restored owner. Safe to call often; the GrantStore serializes it with every other write.
 */
export async function sweepStaleTransfers(state: FactoryState): Promise<GrantRecord[]> {
  if (!state.grants || !state.grants.healthy) return [];
  const before = new Map(
    state.grants.list({ includeExpired: true }).filter((g) => g.state === 'pending-revoked' && g.transferId).map((g) => [g.id, g]),
  );
  const incoming = new Map(
    state.grants.list({ includeExpired: true }).filter((g) => g.state === 'pending-accepted' && g.transferId).map((g) => [g.transferId!, g.subject]),
  );
  const restored = await state.grants.sweepExpiredTransfers('system:transfer-sweeper');
  for (const g of restored) {
    const prior = before.get(g.id);
    if (!prior || g.scope.kind === 'fleet') continue;
    const scope = { kind: g.scope.kind, id: g.scope.id } as TransferScope;
    const to = incoming.get(prior.transferId!) ?? '';
    ledgerTransfer(state, scope, 'OWNERSHIP_TRANSFER_EXPIRED', 'system:transfer-sweeper', { transferId: prior.transferId, from: g.subject, to });
    await notify(state, { kind: 'expired', scope, transferId: prior.transferId!, from: g.subject, to });
  }
  return restored;
}

const AGENT_TRANSFER = /^\/api\/v1\/agents\/([^/]+)\/transfer(?:\/(accept|decline|cancel))?$/;

async function respond(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, scope: TransferScope, action: TransferAction | undefined): Promise<void> {
  const who = await identify(req, state);
  if (!who.ok) return json(res, 401, { error: 'unauthorized' });
  if (!state.grants) {
    // Without the grant store there is no owner or recipient to recognise: only an admin is told why it cannot run.
    const caller = callerOf(state, who.principal);
    if ('status' in caller) return json(res, caller.status, caller.body);
    if (!caller.isAdmin) return json(res, 403, { error: 'forbidden', required: 'admin', requiredRole: 'admin' });
  }
  // Roll back anything stale first, so a request never acts on (or reports) an expired transfer.
  await sweepStaleTransfers(state).catch(() => undefined);
  const out =
    req.method === 'GET'
      ? await getTransfer(state, who.principal, scope)
      : action
        ? await resolveTransfer(state, who.principal, scope, action)
        : await startTransfer(state, who.principal, scope, await readJson(req));
  json(res, out.status, out.body);
}

export async function handleAgentTransfers(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const m = path.match(AGENT_TRANSFER);
  if (!m) return false;
  const action = m[2] as TransferAction | undefined;
  if (!((req.method === 'GET' && !action) || req.method === 'POST')) return false;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    json(res, 400, { error: 'invalid_agent_id' });
    return true;
  }
  await respond(state, req, res, { kind: 'agent', id }, action);
  return true;
}

/** Skill transfer through the grant store (used by `handleSkills` when `state.grants` is configured). */
export async function handleSkillGrantTransfer(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, skillId: string, action: TransferAction | undefined): Promise<void> {
  await respond(state, req, res, { kind: 'skill', id: skillId.toLowerCase() }, action);
}

/** Starts the periodic stale-pending sweeper (D15); returns the timer so a caller can stop it. */
export function startTransferSweeper(state: FactoryState, everyMs = 15 * 60_000): NodeJS.Timeout {
  return setInterval(() => void sweepStaleTransfers(state).catch((e) => console.error(`[transfers] sweep: ${e instanceof Error ? e.message : String(e)}`)), everyMs).unref();
}
