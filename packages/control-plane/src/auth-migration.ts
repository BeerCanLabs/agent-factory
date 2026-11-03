/**
 * S8 (plans/factory-auth.md migration steps 3-5; R1, D4, D8): import the legacy env roles and identity-link roles into
 * principals, grants and keys; compare legacy and grant-backed decisions in shadow mode; cut over once nothing differs.
 *
 * Routes (all `grants.manage`):
 *   POST /api/v1/auth-migration/import     idempotent importer; returns counts (and a new service key's secret once)
 *   GET  /api/v1/auth-migration/readiness  shadow comparison of route decisions plus owner/hold routing (zero orphans)
 *   POST /api/v1/auth-migration/cutover    refuses unless ready; strips link roles so only grants decide
 */
import type http from 'node:http';
import { authorize, deriveSlugFromEmail, PRIVILEGES, type IdentityLink, type Privilege } from '@beercanlabs/factory-bouncer';
import type { Principal, Role } from '@beercanlabs/factory-auth';
import { json, readJson, requirePrivilege, resolveVerifiedPrincipal, type FactoryState } from './app.js';
import { convertLegacyOwners } from './migration-owners.js';
import { legacyAdminEmails, legacyTokenNames, legacyTokenRoles } from './legacy-env-roles.js';

export type LegacyToken = { name: string; roles: Role[] };
export type LegacySource = { adminEmails: string[]; tokens: LegacyToken[]; links: IdentityLink[] };
export type Mismatch = { subject: string; privilege: string; agentId?: string; legacy: boolean; grants: boolean };

export function legacySource(state: FactoryState): LegacySource {
  return {
    adminEmails: legacyAdminEmails(),
    tokens: legacyTokenNames().map((name) => ({ name, roles: legacyTokenRoles(name, true) ?? [] })).filter((t) => t.roles.length),
    links: (state.identityLinks?.list() ?? []).filter((l) => l.roles?.length || Object.keys(l.agentRoles ?? {}).length),
  };
}

const serviceOf = (name: string) => `service:${name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`;
const emailOf = (actor: string) => (/^(?:cloudflare|oidc):(.+@.+)$/i.exec(actor)?.[1] ?? (actor.includes('@') && !actor.includes(':') ? actor : undefined))?.toLowerCase();

function stores(state: FactoryState) {
  if (!state.principals || !state.grants) throw new Error('principal and grant stores are required');
  return { principals: state.principals, grants: state.grants };
}

/** The canonical subject for a legacy actor: the person's `user:` principal (created if missing), or the actor itself. */
async function subjectFor(state: FactoryState, actor: string, by: string, create: boolean): Promise<string | undefined> {
  const { principals } = stores(state);
  const email = emailOf(actor);
  if (!email) return actor.startsWith('user:') || actor.startsWith('service:') ? actor : actor.startsWith('token:') ? serviceOf(actor.slice(6)) : undefined;
  const found = principals.findByEmail(email);
  if (found || !create) return found?.id;
  const id = deriveSlugFromEmail(email, new Map(principals.list().map((p) => [p.id, p])));
  return (await principals.create({ id, displayName: email, emails: [email], by })).id;
}

async function ensureGrant(state: FactoryState, subject: string, scope: { kind: 'fleet' } | { kind: 'agent'; id: string }, role: string, by: string): Promise<boolean> {
  const { grants } = stores(state);
  const scopeId = scope.kind === 'agent' ? scope.id : undefined;
  const have = grants.list({ subject, scopeKind: scope.kind, ...(scopeId ? { scopeId } : {}) }).some((g) => g.role === role && (g.state ?? 'active') === 'active');
  if (have) return false;
  await grants.grant({ subject, scope, role, by, granterIsAdmin: true });
  return true;
}

/** Idempotent: a second run creates nothing. */
/**
 * A legacy per-agent link role named like a reserved fleet role ("Operator") cannot be an agent subrole. The plan's role
 * set (D7) has `operator` at fleet scope only, so it maps there, but only for a person who already holds fleet
 * `operator` or `admin` through the same link: the import never widens anyone's access.
 */
export function mapLegacyAgentRole(role: string, fleetRoles: readonly string[]): { fleet: 'operator' } | { agent: string } | { refused: string } {
  if (role.trim().toLowerCase() !== 'operator') return { agent: role };
  return fleetRoles.includes('operator') || fleetRoles.includes('admin') ? { fleet: 'operator' } : { refused: role };
}

/**
 * Rerunnable: every write is ensure-style, grants go first and service keys last, so a failed run issues no key whose
 * secret is lost. `reissueKeys` revokes the import-shaped (no roles, no scopes) active keys of the legacy token subjects (left by an earlier
 * partial run, their secrets never returned) and issues fresh ones; secrets are returned once, never ledgered.
 */
export async function importLegacyAuth(state: FactoryState, source: LegacySource, by: string, opts: { reissueKeys?: boolean } = {}) {
  const out = { principals: 0, grants: 0, keys: 0, revokedKeys: 0, refused: [] as Array<{ subject: string; agentId: string; role: string }>, secrets: [] as Array<{ owner: string; secret: string }> };
  const before = stores(state).principals.list().length;
  for (const email of source.adminEmails) {
    const subject = (await subjectFor(state, `cloudflare:${email}`, by, true))!;
    if (await ensureGrant(state, subject, { kind: 'fleet' }, 'admin', by)) out.grants++;
  }
  for (const t of source.tokens) {
    for (const role of t.roles) if (await ensureGrant(state, serviceOf(t.name), { kind: 'fleet' }, role, by)) out.grants++;
  }
  for (const l of source.links) {
    const subject = await subjectFor(state, l.actor, by, true);
    if (!subject) continue;
    const fleetRoles = [...(l.roles ?? [])];
    for (const role of fleetRoles) if (await ensureGrant(state, subject, { kind: 'fleet' }, role, by)) out.grants++;
    for (const [agentId, roles] of Object.entries(l.agentRoles ?? {})) {
      for (const role of roles) {
        const m = mapLegacyAgentRole(role, fleetRoles);
        if ('refused' in m) out.refused.push({ subject, agentId, role });
        else if (await ensureGrant(state, subject, 'fleet' in m ? { kind: 'fleet' } : { kind: 'agent', id: agentId }, 'fleet' in m ? m.fleet : m.agent, by)) out.grants++;
      }
    }
  }
  for (const t of source.tokens) {
    const subject = serviceOf(t.name);
    if (!state.keys) break;
    const active = state.keys.list({ owner: subject }).filter((k) => !k.revokedAt);
    if (opts.reissueKeys) {
      for (const k of active.filter((k) => !k.roles && !k.scopes)) {
        await state.keys.revoke(k.id, { by });
        out.revokedKeys++;
        state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: `KEY_REVOKED:${k.id}`, actor: by, subject });
      }
    } else if (active.length) continue;
    const k = await state.keys.create({ owner: subject, deviceFamily: 'service', by });
    out.keys++;
    out.secrets.push({ owner: subject, secret: k.plaintext });
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: `KEY_ISSUED:${k.record.id}`, actor: by, subject });
  }
  out.principals = stores(state).principals.list().length - before;
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: 'AUTH_LEGACY_IMPORTED', actor: by });
  return out;
}

/** Legacy vs grant-backed decision for every privilege, at fleet scope and on every agent a link names. */
export async function shadowCompare(state: FactoryState, source: LegacySource): Promise<Mismatch[]> {
  const cases: Array<{ actor: string; roles: Role[]; agents: string[] }> = [
    ...source.adminEmails.map((e) => ({ actor: `cloudflare:${e}`, roles: ['admin'] as Role[], agents: [] })),
    ...source.tokens.map((t) => ({ actor: serviceOf(t.name), roles: t.roles, agents: [] })),
    ...source.links.map((l) => ({ actor: l.actor, roles: [...(l.roles ?? [])], agents: Object.keys(l.agentRoles ?? {}) })),
  ];
  const out: Mismatch[] = [];
  for (const c of cases) {
    const subject = (await subjectFor(state, c.actor, 'system:shadow', false)) ?? c.actor;
    const backed: Principal = await resolveVerifiedPrincipal(state, { actor: subject, roles: [] }, false);
    const legacy: Principal = { actor: subject, roles: c.roles };
    for (const privilege of PRIVILEGES as readonly Privilege[]) {
      for (const agentId of [undefined, ...c.agents]) {
        const resource = agentId ? { agentId } : undefined;
        const a = authorize({ principal: legacy, privilege, ...(resource ? { resource } : {}) }).allowed;
        const b = authorize({ principal: backed, privilege, ...(resource ? { resource } : {}) }).allowed;
        if (a !== b) out.push({ subject, privilege, ...(agentId ? { agentId } : {}), legacy: a, grants: b });
      }
    }
  }
  // Per-agent link roles: each must be held as an active agent-scope grant by the same person.
  for (const l of source.links) {
    const found = await subjectFor(state, l.actor, 'system:shadow', false);
    const subject = found ?? l.actor;
    for (const [agentId, roles] of Object.entries(l.agentRoles ?? {})) {
      const held = new Set(!found ? [] : stores(state).grants.list({ subject, scopeKind: 'agent', scopeId: agentId }).filter((g) => (g.state ?? 'active') === 'active').map((g) => g.role));
      const fleetHeld = new Set(!found ? [] : stores(state).grants.list({ subject, scopeKind: 'fleet' }).filter((g) => (g.state ?? 'active') === 'active').map((g) => g.role));
      for (const role of roles) {
        const m = mapLegacyAgentRole(role, [...(l.roles ?? [])]);
        const ok = 'fleet' in m ? fleetHeld.has(m.fleet) : 'agent' in m && held.has(m.agent);
        if (!ok) out.push({ subject, privilege: `agent-role.${role}`, agentId, legacy: true, grants: false });
      }
    }
  }
  for (const m of out.slice(0, 50)) {
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: 'AUTH_SHADOW_MISMATCH', actor: 'system:shadow', subject: m.subject, privilege: m.privilege, ...(m.agentId ? { scope: { kind: 'agent', id: m.agentId } } : {}) });
  }
  return out;
}

export async function readiness(state: FactoryState) {
  const source = legacySource(state);
  const mismatches = await shadowCompare(state, source);
  // Owner and hold routing: holds go to an item's content-owner / accountable-lead grant, so every live item needs one (S18 dry run).
  const owners = await convertLegacyOwners(state, { by: 'system:shadow', dryRun: true });
  return {
    ready: mismatches.length === 0 && owners.orphans.length === 0,
    cutover: isCutOver(state),
    mismatches: mismatches.length,
    ownerOrphans: owners.orphans.length,
    // Which items lack an owner/lead, so an admin can grant one through /api/v1/grants (no legacy owner strings shown).
    orphans: owners.orphans.map((o) => ({ targetKind: o.targetKind, targetId: o.targetId, agentKind: o.agentKind, reason: o.reason })),
    sample: mismatches.slice(0, 20),
  };
}

/** Grants-only: refused unless shadow mode shows zero mismatches; then link roles are stripped and the cutover ledgered. */
/**
 * Whether the cutover already ran. The flag in memory is lost on restart, so the ledgered AUTH_CUTOVER row is the
 * durable record; once found it is cached.
 */
export function isCutOver(state: FactoryState): boolean {
  if (!state.authCutover && state.ledger.query({ agent: 'control-plane' }).some((e) => e.action === 'AUTH_CUTOVER')) state.authCutover = true;
  return Boolean(state.authCutover);
}

export async function cutover(state: FactoryState, by: string) {
  // A rerun after cutover skips the readiness gate: it only finishes stripping legacy link roles.
  const already = isCutOver(state);
  const r = await readiness(state);
  if (!r.ready && !already) return { ok: false as const, ...r };
  for (const l of state.identityLinks?.list() ?? []) {
    // agentRoles must be cleared explicitly: link() keeps the current ones when the actor is unchanged.
    if (l.roles?.length || Object.keys(l.agentRoles ?? {}).length) state.identityLinks!.link(l.provider, l.id, l.actor, by, { ...(l.name ? { name: l.name } : {}), agentRoles: {} });
  }
  state.authCutover = true;
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: 'AUTH_CUTOVER', actor: by });
  return { ok: true as const, ...r, cutover: true };
}

export async function handleAuthMigration(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/auth-migration/import' && req.method === 'POST') {
    const who = await requirePrivilege(req, res, state, 'grants.manage');
    if (!who) return true;
    if (!state.principals || !state.grants) return json(res, 503, { error: 'auth_stores_unavailable' }), true;
    res.setHeader('cache-control', 'no-store');
    const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
    return json(res, 200, await importLegacyAuth(state, legacySource(state), who.actor, { reissueKeys: body.reissueKeys === true })), true;
  }
  if (path === '/api/v1/auth-migration/readiness' && req.method === 'GET') {
    const who = await requirePrivilege(req, res, state, 'grants.manage');
    if (!who) return true;
    if (!state.principals || !state.grants) return json(res, 503, { error: 'auth_stores_unavailable' }), true;
    return json(res, 200, await readiness(state)), true;
  }
  if (path === '/api/v1/auth-migration/cutover' && req.method === 'POST') {
    const who = await requirePrivilege(req, res, state, 'grants.manage');
    if (!who) return true;
    if (!state.principals || !state.grants) return json(res, 503, { error: 'auth_stores_unavailable' }), true;
    const c = await cutover(state, who.actor);
    return json(res, c.ok ? 200 : 409, c), true;
  }
  return false;
}
