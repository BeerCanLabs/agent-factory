/**
 * Owner contact details for a configuration agent's run: the content owner(s), their
 * principal aliases, and any Discord user ids linked to them. Served on
 * GET /api/v1/runs/:id/agent-config so the runtime can send a proactive Discord DM
 * (for example a family message relay) through gatekeeper-egress, without listing
 * every identity link.
 */
import type { IdentityLink, PrincipalStore } from '@beercanlabs/factory-bouncer';
import type { FactoryState } from './app.js';
import { ownersOf } from './config-store.js';

export type OwnerContact = {
  actor: string;
  name?: string;
  aliases: string[];
  discordUserIds: string[];
};

const DISCORD_ID = /^\d{15,32}$/;

function aliasesFor(actor: string, principals?: PrincipalStore): string[] {
  const out = new Set<string>([actor]);
  const rec = principals?.get(actor);
  if (rec) {
    out.add(rec.id);
    for (const email of rec.emails) out.add(`cloudflare:${email}`);
  }
  if (actor.startsWith('cloudflare:')) {
    const byEmail = principals?.findByEmail(actor.slice('cloudflare:'.length));
    if (byEmail) {
      out.add(byEmail.id);
      for (const email of byEmail.emails) out.add(`cloudflare:${email}`);
    }
  }
  return [...out];
}

function nameFor(
  actor: string,
  aliases: string[],
  links: IdentityLink[],
  principals?: PrincipalStore,
): string | undefined {
  const rec = principals?.get(actor) ?? (actor.startsWith('cloudflare:') ? principals?.findByEmail(actor.slice('cloudflare:'.length)) : undefined);
  if (rec?.displayName?.trim()) return rec.displayName.trim().slice(0, 60);
  const aliasSet = new Set(aliases);
  const named = links.find((l) => aliasSet.has(l.actor) && l.name?.trim());
  return named?.name?.trim().slice(0, 60);
}

/** The agent's owners, each with Discord user ids from identity links that belong to that person. */
export function ownerContactsFor(state: FactoryState, agentId: string): OwnerContact[] {
  let owners = ownersOf(state, agentId);
  // Grants are authoritative when a content-owner exists, but some personal agents only
  // record the owner on the configuration (Donna: cloudflare:dale.sackrider@gmail.com).
  if (!owners.length) {
    const fromConfig = state.configs?.current(agentId)?.owners ?? [];
    owners = fromConfig.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).map((o) => o.trim());
  }
  if (!owners.length) return [];
  const links = state.identityLinks?.list() ?? [];
  const contacts: OwnerContact[] = [];
  for (const actor of owners) {
    const aliases = aliasesFor(actor, state.principals);
    const aliasSet = new Set(aliases);
    const discordUserIds = [
      ...new Set(
        links
          .filter((l) => l.provider === 'discord' && aliasSet.has(l.actor) && DISCORD_ID.test(l.id))
          .map((l) => l.id),
      ),
    ];
    const name = nameFor(actor, aliases, links, state.principals);
    contacts.push({ actor, ...(name ? { name } : {}), aliases, discordUserIds });
  }
  return contacts;
}
