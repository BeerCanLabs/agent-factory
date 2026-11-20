import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IdentityLinkStore } from '@beercanlabs/factory-bouncer';
import { ownerContactsFor } from './owner-contacts.js';
import type { FactoryState } from './app.js';

function state(opts: {
  owners?: string[];
  principals?: { id: string; displayName: string; emails: string[] }[];
  links?: { provider: 'discord' | 'github'; id: string; actor: string; name?: string }[];
}): FactoryState {
  const links = new IdentityLinkStore();
  for (const l of opts.links ?? []) {
    links.link(l.provider, l.id, l.actor, 'token:admin', l.name ? { name: l.name } : undefined);
  }
  const records = new Map((opts.principals ?? []).map((p) => [p.id, p]));
  const byEmail = new Map<string, (typeof opts.principals)[0]>();
  for (const p of opts.principals ?? []) {
    for (const e of p.emails) byEmail.set(e, p);
  }
  return {
    agents: new Map([['donna', { id: 'donna', kind: 'personal' }]]),
    configs: { current: () => ({ owners: opts.owners ?? [] }) },
    identityLinks: links,
    principals: {
      get: (id: string) => records.get(id),
      findByEmail: (email: string) => byEmail.get(email.trim().toLowerCase()),
    },
  } as unknown as FactoryState;
}

describe('ownerContactsFor', () => {
  it('resolves a user principal owner to a Discord id linked on the cloudflare email', () => {
    const contacts = ownerContactsFor(
      state({
        owners: ['user:dale.sackrider'],
        principals: [{ id: 'user:dale.sackrider', displayName: 'Dale', emails: ['dale.sackrider@gmail.com'] }],
        links: [
          { provider: 'discord', id: '470400107028938752', actor: 'cloudflare:dale.sackrider@gmail.com', name: 'Dale' },
          { provider: 'discord', id: '925492344764104734', actor: 'cloudflare:stephaniesackrider@gmail.com', name: 'Stephanie' },
        ],
      }),
      'donna',
    );
    assert.deepEqual(contacts, [
      {
        actor: 'user:dale.sackrider',
        name: 'Dale',
        aliases: ['user:dale.sackrider', 'cloudflare:dale.sackrider@gmail.com'],
        discordUserIds: ['470400107028938752'],
      },
    ]);
  });

  it('matches a discord link whose actor is already the owner id', () => {
    const contacts = ownerContactsFor(
      state({
        owners: ['cloudflare:dale.sackrider@gmail.com'],
        principals: [{ id: 'user:dale.sackrider', displayName: 'Dale', emails: ['dale.sackrider@gmail.com'] }],
        links: [{ provider: 'discord', id: '470400107028938752', actor: 'cloudflare:dale.sackrider@gmail.com' }],
      }),
      'donna',
    );
    assert.equal(contacts[0]?.name, 'Dale');
    assert.deepEqual(contacts[0]?.aliases.sort(), ['cloudflare:dale.sackrider@gmail.com', 'user:dale.sackrider'].sort());
    assert.deepEqual(contacts[0]?.discordUserIds, ['470400107028938752']);
  });

  it('returns no discord ids when none are linked, and an empty list when the agent has no owners', () => {
    assert.deepEqual(ownerContactsFor(state({ owners: ['user:dale.sackrider'] }), 'donna'), [
      { actor: 'user:dale.sackrider', aliases: ['user:dale.sackrider'], discordUserIds: [] },
    ]);
    assert.deepEqual(ownerContactsFor(state({ owners: [] }), 'donna'), []);
  });

  it('ignores a non-numeric discord id', () => {
    const contacts = ownerContactsFor(
      state({
        owners: ['user:dale.sackrider'],
        links: [{ provider: 'discord', id: 'not-an-id', actor: 'user:dale.sackrider' }],
      }),
      'donna',
    );
    assert.deepEqual(contacts[0]?.discordUserIds, []);
  });
});
