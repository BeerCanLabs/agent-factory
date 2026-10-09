// GAP-088, DESIGN_AUTHORITY.md "Bouncer flow": which person a Discord user is. The Gatekeeper's ingress reports the
// author Discord verified; an admin links that id to a principal actor (the identity the person signs in as), and the
// control plane resolves it when it decides who may approve what an agent did in that person's name. This is
// authentication data: it holds no authority by itself, and the Bouncer still decides what the person may do.
//
//   GET    /api/v1/identity-links                    every link (admin)
//   PUT    /api/v1/identity-links/:provider/:id      `{ actor }`: link, or replace the link (admin; ledgered)
//   DELETE /api/v1/identity-links/:provider/:id      unlink (admin; ledgered)
import type http from 'node:http';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Role } from '@beercanlabs/factory-auth';
import { ROLES } from '@beercanlabs/factory-auth';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';

/** A principal actor as the Gatekeeper's authentication names a caller: `cloudflare:`, `oidc:` or `token:`. */
export const PRINCIPAL_ACTOR = /^(cloudflare|oidc|token):\S+$/;

/** A principal actor as stored (trimmed, lower-case), or undefined when it is not one. */
export function parseActor(value: unknown): string | undefined {
  const actor = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PRINCIPAL_ACTOR.test(actor) && actor.length <= 256 ? actor : undefined;
}

export const PROVIDERS = ['discord', 'slack', 'teams', 'webui', 'cli'] as const;
export type IdentityProvider = (typeof PROVIDERS)[number];

export function isProvider(p: string): p is IdentityProvider {
  return (PROVIDERS as readonly string[]).includes(p);
}

export type IdentityLink = {
  provider: IdentityProvider;
  id: string;
  actor: string;
  name?: string;
  roles?: Role[];
  linkedBy: string;
  linkedAt: string;
};

const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Links on disk, one file each, written the way the approval store writes. In memory when there is no directory. */
export class IdentityLinkStore {
  private readonly items = new Map<string, IdentityLink>();

  constructor(private readonly dir?: string) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const l = JSON.parse(readFileSync(join(dir, name), 'utf8')) as IdentityLink;
        this.items.set(key(l.provider, l.id), l);
      } catch (err) {
        // A truncated or hand-edited file must not stop the control plane. Skipping it grants nothing (fail closed).
        console.error(`[control-plane] identity link file ${name} skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** The principal actor linked to this external identity, if any. */
  resolve(provider: string, id: string): string | undefined {
    return this.items.get(key(provider, id))?.actor;
  }

  /** The full identity link for this external identity, if any. */
  resolveLink(provider: string, id: string): IdentityLink | undefined {
    return this.items.get(key(provider, id));
  }

  list(): IdentityLink[] {
    return [...this.items.values()].sort((a, b) => key(a.provider, a.id).localeCompare(key(b.provider, b.id)));
  }

  /** Links, or replaces the link of, an external identity. `created: false` and no write when it is already so. */
  link(
    provider: IdentityProvider,
    id: string,
    actor: string,
    by: string,
    extra?: { name?: string; roles?: Role[] },
  ): { link: IdentityLink; changed: boolean } {
    const current = this.items.get(key(provider, id));
    const sameRoles =
      (!current?.roles && !extra?.roles) ||
      (current?.roles?.length === extra?.roles?.length &&
        current?.roles?.every((r, i) => r === extra?.roles?.[i]));
    if (current?.actor === actor && current?.name === extra?.name && sameRoles) {
      return { link: { ...current }, changed: false };
    }
    const link: IdentityLink = {
      provider,
      id,
      actor,
      ...(extra?.name ? { name: extra.name } : {}),
      ...(extra?.roles ? { roles: [...extra.roles] } : {}),
      linkedBy: by,
      linkedAt: new Date().toISOString(),
    };
    // Write first: a link grants the right to decide approvals, so a failed write must not leave one live in memory.
    this.save(link);
    this.items.set(key(provider, id), link);
    return { link: { ...link }, changed: true };
  }

  unlink(provider: string, id: string): IdentityLink | undefined {
    const current = this.items.get(key(provider, id));
    if (!current) return undefined;
    this.items.delete(key(provider, id));
    if (this.dir) rmSync(join(this.dir, `${file(current)}.json`), { force: true });
    return { ...current };
  }

  private save(l: IdentityLink) {
    if (!this.dir) return;
    const path = join(this.dir, `${file(l)}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(l));
    renameSync(tmp, path);
  }
}

const key = (provider: string, id: string) => `${provider}:${id}`;
const file = (l: Pick<IdentityLink, 'provider' | 'id'>) => `${l.provider}__${l.id}`;

const ONE = /^\/api\/v1\/identity-links\/([^/]+)\/([^/]+)$/;

/** Handles the identity link routes. Returns false for any other path or method. */
export async function handleIdentityLinks(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  const one = path.match(ONE);
  if (path === '/api/v1/identity-links' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'identity.links.read'))) return true;
    if (!state.identityLinks) return json(res, 503, { error: 'identity_links_unavailable' }), true;
    json(res, 200, { links: state.identityLinks.list() });
    return true;
  }
  if (!one || (req.method !== 'PUT' && req.method !== 'DELETE')) return false;
  const principal = await requirePrivilege(req, res, state, 'identity.links.set');
  if (!principal) return true;
  const store = state.identityLinks;
  if (!store) return json(res, 503, { error: 'identity_links_unavailable' }), true;
  const [provider, id] = [decodeURIComponent(one[1]), decodeURIComponent(one[2])];
  if (!isProvider(provider) || !EXTERNAL_ID.test(id)) {
    return json(res, 400, { error: 'unknown_identity', message: `provider must be one of ${PROVIDERS.join(', ')} and id letters, digits, dot, dash or underscore` }), true;
  }
  const ledger = (action: 'IDENTITY_LINKED' | 'IDENTITY_UNLINKED', actor: string, details?: { name?: string; roles?: Role[] }) =>
    // Never the external id itself: only a hash of the provider, id, person, name and roles.
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'factory',
      type: 'action',
      action,
      actor: principal.actor,
      payloadSha256: payloadHash({
        provider,
        id,
        actor,
        ...(details?.name ? { name: details.name } : {}),
        ...(details?.roles ? { roles: details.roles } : {}),
      }),
    });
  if (req.method === 'DELETE') {
    const removed = store.unlink(provider, id);
    if (!removed) return json(res, 404, { error: 'not_found' }), true;
    ledger('IDENTITY_UNLINKED', removed.actor, { name: removed.name, roles: removed.roles });
    json(res, 200, { ok: true });
    return true;
  }
  const body = await readJson(req);
  const actor = parseActor(body.actor);
  if (!actor) return json(res, 400, { error: 'actor must be a principal actor such as cloudflare:alice@example.com, oidc:... or token:...' }), true;
  let name: string | undefined;
  if (body.name !== undefined && body.name !== null) {
    if (typeof body.name !== 'string' || body.name.length > 128) {
      return json(res, 400, { error: 'name must be a string of at most 128 characters' }), true;
    }
    name = body.name.trim() || undefined;
  }
  let roles: Role[] | undefined;
  if (body.roles !== undefined && body.roles !== null) {
    if (!Array.isArray(body.roles) || !body.roles.every((r: unknown) => typeof r === 'string' && (ROLES as readonly string[]).includes(r))) {
      return json(res, 400, { error: `roles must be an array of valid roles: ${ROLES.join(', ')}` }), true;
    }
    roles = [...new Set(body.roles as Role[])];
    // Escalation check: caller cannot grant roles above their own unless admin
    if (!principal.roles?.includes('admin')) {
      for (const r of roles) {
        if (!principal.roles?.includes(r)) {
          return json(res, 403, { error: 'privilege_escalation', message: `cannot grant role '${r}' above caller roles` }), true;
        }
      }
    }
  }
  const { link, changed } = store.link(provider, id, actor, principal.actor, { name, roles });
  if (changed) ledger('IDENTITY_LINKED', actor, { name: link.name, roles: link.roles });
  json(res, 200, link);
  return true;
}
