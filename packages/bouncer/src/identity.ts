import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Principal, Role } from '@beercanlabs/factory-auth';
import { authorize } from './authorize.js';
import { ROLE_PRIVILEGES, type Privilege } from './privileges.js';

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

const key = (provider: string, id: string) => `${provider}:${id}`;
const file = (l: Pick<IdentityLink, 'provider' | 'id'>) => `${l.provider}__${l.id}`;

/**
 * Links on disk, one file each, written the way the approval store writes.
 * Owned by the Bouncer (GAP-090). In memory when there is no directory.
 */
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
        // A truncated or hand-edited file must not stop the factory. Skipping it grants nothing (fail closed).
        console.error(`[bouncer] identity link file ${name} skipped: ${err instanceof Error ? err.message : String(err)}`);
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
    // Write first: a link grants access, so a failed write must not leave one live in memory.
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

export type ExternalIdentity = {
  provider: string;
  id: string;
};

export type AuthenticatedCaller = {
  actor: string;
  name?: string;
  role: Role | 'agent-owner';
  roles: readonly Role[];
  provider?: string;
  id?: string;
};

export type IngressPrivilege = 'agents.wake' | 'agents.converse';

export type IngressAuthorizeRequest = {
  requestedBy?: ExternalIdentity;
  agentId: string;
  privilege?: IngressPrivilege;
  owners?: readonly string[];
  link?: {
    actor: string;
    name?: string;
    roles?: readonly Role[];
  };
  adminEmails?: readonly string[];
  isIngressCaller?: boolean;
};

export type IngressAuthorizeResult =
  | { allowed: true; caller?: AuthenticatedCaller }
  | { allowed: false; error: 'unauthorized_caller'; reason: string; required?: Role };

/**
 * Perimeter ingress authorization (GAP-090, A1, A2).
 * When an interaction originates from an external surface (Discord, Slack, Teams, WebUI, CLI),
 * the Bouncer verifies that the external identity is mapped to a primary actor and possesses
 * authorization to wake or converse with the agent. Unmapped or unauthorized callers are refused
 * before any compute is provisioned.
 */
export function authorizeIngress(req: IngressAuthorizeRequest): IngressAuthorizeResult {
  const privilege: Privilege = req.privilege ?? 'agents.wake';

  // An external ingress caller (e.g. gatekeeper-ingress) must provide a resolvable requestedBy
  if (req.isIngressCaller && !req.requestedBy) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: 'missing requestedBy for external ingress caller',
      required: 'operator',
    };
  }

  // Internal calls (cron, schedule, mcp, queue) without external requestedBy are allowed
  if (!req.requestedBy) {
    return { allowed: true };
  }

  const { requestedBy, agentId, owners = [], link } = req;
  if (!link) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: `unmapped external identity: ${requestedBy.provider}:${requestedBy.id}`,
      required: 'operator',
    };
  }

  const actor = link.actor;
  const isCloudflare = actor.startsWith('cloudflare:');
  const email = isCloudflare ? actor.slice('cloudflare:'.length).trim().toLowerCase() : '';
  const isEmailAdmin = Boolean(email && req.adminEmails?.some((e) => e.trim().toLowerCase() === email));

  // Resolve roles:
  // 1. Explicit link roles if set
  // 2. Admin if email listed in FACTORY_ADMIN_EMAILS
  // 3. Clean slate mapping: zero grandfathering for un-roled legacy links.
  //    External callers without explicit roles have no roles assigned and must be granted roles by an admin.
  const resolvedRoles: readonly Role[] =
    link.roles && link.roles.length > 0
      ? link.roles
      : isEmailAdmin
        ? (['admin', 'operator', 'approver', 'viewer', 'ingest'] as const)
        : [];

  const principal: Principal = { actor, roles: [...resolvedRoles] };

  const auth = authorize({
    principal,
    privilege,
    resource: { agentId, owners },
  });

  if (!auth.allowed) {
    return {
      allowed: false,
      error: 'unauthorized_caller',
      reason: `principal '${actor}' does not hold ${privilege} on agent '${agentId}'`,
      required: auth.required,
    };
  }

  const isOwner = owners.some((o) => o.toLowerCase() === actor.toLowerCase());

  // Determine the primary role that actually satisfied the privilege
  let satisfyingRole: Role | 'agent-owner';
  if (resolvedRoles.includes('admin')) {
    satisfyingRole = 'admin';
  } else if (isOwner) {
    satisfyingRole = 'agent-owner';
  } else {
    // Find the granted role that holds the required privilege (e.g. ['viewer', 'operator'] -> 'operator')
    satisfyingRole = resolvedRoles.find((r) => ROLE_PRIVILEGES[r]?.includes(privilege)) ?? resolvedRoles[0] ?? 'operator';
  }

  // Report faithfully: link's explicitly granted roles, or admin if derived from email, or empty array if un-roled
  const faithfulRoles: readonly Role[] = link.roles
    ? [...link.roles]
    : isEmailAdmin
      ? (['admin'] as const)
      : [];

  return {
    allowed: true,
    caller: {
      actor,
      name: link.name,
      role: satisfyingRole,
      roles: faithfulRoles,
      provider: requestedBy.provider,
      id: requestedBy.id,
    },
  };
}
