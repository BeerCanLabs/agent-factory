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
import { payloadHash } from '@beercanlabs/factory-ledger';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';

/** A principal actor as the Gatekeeper's authentication names a caller: `cloudflare:`, `oidc:` or `token:`. */
export const PRINCIPAL_ACTOR = /^(cloudflare|oidc|token):\S+$/;

/** A principal actor as stored (trimmed, lower-case), or undefined when it is not one. */
export function parseActor(value: unknown): string | undefined {
  const actor = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PRINCIPAL_ACTOR.test(actor) && actor.length <= 256 ? actor : undefined;
}

export type IdentityProvider = 'discord';
export type IdentityLink = { provider: IdentityProvider; id: string; actor: string; linkedBy: string; linkedAt: string };

const PROVIDERS: readonly string[] = ['discord'];
const EXTERNAL_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Links on disk, one file each, written the way the approval store writes. In memory when there is no directory. */
export class IdentityLinkStore {
  private readonly items = new Map<string, IdentityLink>();

  constructor(private readonly dir?: string) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const l = JSON.parse(readFileSync(join(dir, name), 'utf8')) as IdentityLink;
      this.items.set(key(l.provider, l.id), l);
    }
  }

  /** The principal actor linked to this external identity, if any. */
  resolve(provider: string, id: string): string | undefined {
    return this.items.get(key(provider, id))?.actor;
  }

  list(): IdentityLink[] {
    return [...this.items.values()].sort((a, b) => key(a.provider, a.id).localeCompare(key(b.provider, b.id)));
  }

  /** Links, or replaces the link of, an external identity. `created: false` and no write when it is already so. */
  link(provider: IdentityProvider, id: string, actor: string, by: string): { link: IdentityLink; changed: boolean } {
    const current = this.items.get(key(provider, id));
    if (current?.actor === actor) return { link: { ...current }, changed: false };
    const link: IdentityLink = { provider, id, actor, linkedBy: by, linkedAt: new Date().toISOString() };
    this.items.set(key(provider, id), link);
    this.save(link);
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
  if (!PROVIDERS.includes(provider) || !EXTERNAL_ID.test(id)) {
    return json(res, 400, { error: 'unknown_identity', message: `provider must be one of ${PROVIDERS.join(', ')} and id letters, digits, dot, dash or underscore` }), true;
  }
  const ledger = (action: 'IDENTITY_LINKED' | 'IDENTITY_UNLINKED', actor: string) =>
    // Never the external id itself: only a hash of the provider, id and person.
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: 'factory', type: 'action', action, actor: principal.actor, payloadSha256: payloadHash({ provider, id, actor }) });
  if (req.method === 'DELETE') {
    const removed = store.unlink(provider, id);
    if (!removed) return json(res, 404, { error: 'not_found' }), true;
    ledger('IDENTITY_UNLINKED', removed.actor);
    json(res, 200, { ok: true });
    return true;
  }
  const actor = parseActor((await readJson(req)).actor);
  if (!actor) return json(res, 400, { error: 'actor must be a principal actor such as cloudflare:alice@example.com, oidc:... or token:...' }), true;
  const { link, changed } = store.link(provider as IdentityProvider, id, actor, principal.actor);
  if (changed) ledger('IDENTITY_LINKED', actor);
  json(res, 200, link);
  return true;
}
