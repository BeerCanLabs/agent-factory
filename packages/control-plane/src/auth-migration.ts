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
import { json, requirePrivilege, resolveVerifiedPrincipal, type FactoryState } from './app.js';
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
export async function importLegacyAuth(state: FactoryState, source: LegacySource, by: string) {
  const out = { principals: 0, grants: 0, keys: 0, secrets: [] as Array<{ owner: string; secret: string }> };
  const before = stores(state).principals.list().length;
  for (const email of source.adminEmails) {
    const subject = (await subjectFor(state, `cloudflare:${email}`, by, true))!;
    if (await ensureGrant(state, subject, { kind: 'fleet' }, 'admin', by)) out.grants++;
  }
  for (const t of source.tokens) {
    const subject = serviceOf(t.name);
    for (const role of t.roles) if (await ensureGrant(state, subject, { kind: 'fleet' }, role, by)) out.grants++;
    if (state.keys && !state.keys.list({ owner: subject }).some((k) => !k.revokedAt)) {
      const k = await state.keys.create({ owner: subject, deviceFamily: 'service', by });
      out.keys++;
      out.secrets.push({ owner: subject, secret: k.plaintext });
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: `KEY_ISSUED:${k.record.id}`, actor: by, subject });
    }
  }
  for (const l of source.links) {
    const subject = await subjectFor(state, l.actor, by, true);
    if (!subject) continue;
    for (const role of l.roles ?? []) if (await ensureGrant(state, subject, { kind: 'fleet' }, role, by)) out.grants++;
    for (const [agentId, roles] of Object.entries(l.agentRoles ?? {})) for (const role of roles) if (await ensureGrant(state, subject, { kind: 'agent', id: agentId }, role, by)) out.grants++;
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
    cutover: Boolean(state.authCutover),
    mismatches: mismatches.length,
    ownerOrphans: owners.orphans.length,
    sample: mismatches.slice(0, 20),
  };
}

/** Grants-only: refused unless shadow mode shows zero mismatches; then link roles are stripped and the cutover ledgered. */
export async function cutover(state: FactoryState, by: string) {
  const r = await readiness(state);
  if (!r.ready) return { ok: false as const, ...r };
  for (const l of state.identityLinks?.list() ?? []) {
    if (l.roles?.length || Object.keys(l.agentRoles ?? {}).length) state.identityLinks!.link(l.provider, l.id, l.actor, by, l.name ? { name: l.name } : undefined);
  }
  state.authCutover = true;
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'control-plane', type: 'action', action: 'AUTH_CUTOVER', actor: by });
  return { ok: true as const, ...r, cutover: true };
}

export async function handleAuthMigration(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const routes: Record<string, string> = { '/api/v1/auth-migration/import': 'POST', '/api/v1/auth-migration/readiness': 'GET', '/api/v1/auth-migration/cutover': 'POST' };
  if (routes[path] !== req.method) return false;
  const who = await requirePrivilege(req, res, state, 'grants.manage');
  if (!who) return true;
  if (!state.principals || !state.grants) return json(res, 503, { error: 'auth_stores_unavailable' }), true;
  res.setHeader('cache-control', 'no-store');
  if (path.endsWith('/import')) return json(res, 200, await importLegacyAuth(state, legacySource(state), who.actor)), true;
  if (path.endsWith('/readiness')) return json(res, 200, await readiness(state)), true;
  const c = await cutover(state, who.actor);
  return json(res, c.ok ? 200 : 409, c), true;
}
