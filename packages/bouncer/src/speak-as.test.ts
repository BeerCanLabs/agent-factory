import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDocBackend } from './index.js';
import {
  SpeakAsGrantStore,
  SpeakAsStoreError,
  deliveredCaller,
  verifySpeakAs,
  type SpeakAsDoc,
} from './speak-as.js';

describe('speak-as grants', () => {
  it('lets an enrolled member be connected to any agent when no allowlist is set, and only listed agents otherwise', async () => {
    const store = await SpeakAsGrantStore.open(new MemoryDocBackend<SpeakAsDoc>());
    const grant = await store.create({
      client: 'agent:rosie',
      members: [
        { principalId: 'user:dale.sackrider', aliases: ['dale'] },
        { principalId: 'user:spouse', targetAgents: ['higgins'] },
      ],
      expiresAt: '2028-01-01T00:00:00Z',
      purpose: 'household voice and errands',
      by: 'user:admin',
    });
    assert.match(grant.id, /^sag_/);
    assert.equal(grant.client, 'agent:rosie');

    const daleDonna = store.verify({ client: 'agent:rosie', asUser: 'user:dale.sackrider', targetAgentId: 'donna' });
    assert.equal(daleDonna.ok, true);
    if (daleDonna.ok) assert.equal(daleDonna.actor, 'user:dale.sackrider');
    const byAlias = store.verifyRequest({ client: 'agent:rosie', speaker: 'dale', targetAgentId: 'donna' });
    assert.equal(byAlias.ok, true);
    if (byAlias.ok) assert.equal(byAlias.actor, 'user:dale.sackrider');
    const unknown = store.verifyRequest({ client: 'agent:rosie', speaker: 'bob', targetAgentId: 'donna' });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error, 'unknown_speaker');

    const spouseHiggins = store.verify({ client: 'agent:rosie', asUser: 'user:spouse', targetAgentId: 'higgins' });
    assert.equal(spouseHiggins.ok, true);

    const spouseDonna = store.verify({ client: 'agent:rosie', asUser: 'user:spouse', targetAgentId: 'donna' });
    assert.equal(spouseDonna.ok, false);
    if (!spouseDonna.ok) assert.equal(spouseDonna.error, 'agent_not_allowed');

    const stranger = store.verify({ client: 'agent:rosie', asUser: 'user:stranger', targetAgentId: 'higgins' });
    assert.equal(stranger.ok, false);
    if (!stranger.ok) assert.equal(stranger.error, 'person_not_enrolled');

    const noGrant = store.verify({ client: 'agent:other', asUser: 'user:dale.sackrider', targetAgentId: 'donna' });
    assert.equal(noGrant.ok, false);
    if (!noGrant.ok) assert.equal(noGrant.error, 'no_speak_as_grant');
  });

  it('enrols and unenrols members, and refuses a revoked or expired grant', async () => {
    let now = new Date('2026-11-19T00:00:00Z');
    const store = await SpeakAsGrantStore.open(new MemoryDocBackend<SpeakAsDoc>(), { now: () => now });
    const grant = await store.create({
      client: 'agent:rosie',
      members: [{ principalId: 'user:dale.sackrider' }],
      expiresAt: '2026-12-01T00:00:00Z',
      by: 'user:admin',
    });
    const enrolled = await store.enroll(grant.id, { principalId: 'user:spouse', targetAgents: ['higgins'] }, 'user:admin');
    assert.equal(enrolled.members.length, 2);
    const dropped = await store.unenroll(grant.id, 'user:spouse', 'user:admin');
    assert.deepEqual(dropped.members.map((m) => m.principalId), ['user:dale.sackrider']);

    await store.revoke(grant.id, 'user:admin');
    const after = store.verify({ client: 'agent:rosie', asUser: 'user:dale.sackrider', targetAgentId: 'donna' });
    assert.equal(after.ok, false);

    const g2 = await store.create({
      client: 'service:reachy-rosie-body',
      members: [{ principalId: 'user:dale.sackrider' }],
      expiresAt: '2026-11-20T00:00:00Z',
      by: 'user:admin',
    });
    now = new Date('2026-11-21T00:00:00Z');
    const expired = store.verify({ client: 'service:reachy-rosie-body', asUser: 'user:dale.sackrider', targetAgentId: 'donna' });
    assert.equal(expired.ok, false);
    assert.equal(store.get(g2.id)?.expiresAt, '2026-11-20T00:00:00.000Z');

    await assert.rejects(store.create({ client: 'rosie', by: 'user:admin' }), SpeakAsStoreError);
  });

  it('stamps a delivered caller with no onBehalfOf field', () => {
    const caller = deliveredCaller({
      actor: 'user:dale.sackrider',
      via: 'agent:rosie',
      channel: 'voice',
      assurance: 'voice-asserted',
      mode: 'errand',
    });
    assert.deepEqual(caller, {
      actor: 'user:dale.sackrider',
      verified: true,
      channel: 'voice',
      via: 'agent:rosie',
      assurance: 'voice-asserted',
      mode: 'errand',
    });
    assert.equal('onBehalfOf' in caller, false);
    assert.equal(verifySpeakAs([], { client: 'agent:rosie', asUser: 'not-a-user', targetAgentId: 'donna' }).ok, false);
  });
});
