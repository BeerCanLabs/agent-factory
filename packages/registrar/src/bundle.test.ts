// CF3: an agent's configuration moves as one bundle that holds no owner, person, secret or memory, and parses strictly.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLE_FORMAT, buildBundle, parseBundle } from './bundle.js';

const agent = { id: 'nova', name: 'Nova', role: 'Assistant', model: 'test-small', createdFrom: 'configuration' as const };
const content = {
  source: { repo: 'https://github.com/BeerCanLabs/agent-factory', commit: 'a'.repeat(40) },
  skills: [{ id: 'notes', version: '1.0.0' }],
  policy: { routes: ['models'] },
  agent: { soul: 'You are Nova.', memory: { archetype: 'personal-assistant' as const }, roles: [{ name: 'Family', skills: { notes: { allow: ['*'], deny: [] } } }] },
  owners: ['cloudflare:dale@example.com'],
};

describe('CF3 agent bundle', () => {
  it('holds the configuration and nothing of the person, the owners or the pin of a configuration agent', () => {
    const b = buildBundle(agent, content as never, new Date('2026-10-24T00:00:00Z'));
    assert.equal(b.format, BUNDLE_FORMAT);
    assert.equal(b.origin, 'configuration');
    assert.equal(b.source, undefined, 'the runtime pin is the importing factory\'s own');
    assert.deepEqual(b.skills, [{ id: 'notes', version: '1.0.0' }]);
    const wide = buildBundle(agent, { ...content, skills: [{ id: 'notes', version: '1.0.0', extra: 'leak' }] } as never);
    assert.deepEqual(wide.skills, [{ id: 'notes', version: '1.0.0' }], 'only id and version leave');
    assert.equal(b.settings!.soul, 'You are Nova.');
    assert.ok(!JSON.stringify(b).includes('dale@example.com'), 'no owner');
  });

  it('records a repository agent as read-only with its pin and no settings', () => {
    const b = buildBundle({ ...agent, createdFrom: undefined }, { ...content, agent: undefined } as never);
    assert.equal(b.origin, 'repository');
    assert.deepEqual(b.source, content.source);
    assert.equal(b.settings, undefined);
  });

  it('round trips through the strict parser', () => {
    const b = buildBundle(agent, content as never);
    const parsed = parseBundle(JSON.parse(JSON.stringify(b)));
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(JSON.parse(JSON.stringify(parsed.bundle.settings)), JSON.parse(JSON.stringify(b.settings)));
  });

  it('refuses what is malformed or carries more than a bundle holds', () => {
    const ok = JSON.parse(JSON.stringify(buildBundle(agent, content as never)));
    const refused = (mutate: (b: any) => void) => {
      const b = JSON.parse(JSON.stringify(ok));
      mutate(b);
      return parseBundle(b).ok;
    };
    assert.equal(refused((b) => (b.format = 'other')), false);
    assert.equal(refused((b) => (b.agent.id = '../x')), false);
    assert.equal(refused((b) => (b.agent.id = '__sys')), false);
    assert.equal(refused((b) => (b.agent.name = '')), false);
    assert.equal(refused((b) => (b.origin = 'else')), false);
    assert.equal(refused((b) => b.skills.push({ id: 'notes', version: '2.0.0' })), false, 'a skill twice');
    assert.equal(refused((b) => (b.skills[0].id = '../x')), false);
    assert.equal(refused((b) => (b.skills[0].version = 'latest')), false);
    assert.equal(refused((b) => (b.skills = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, version: '1.0.0' })))), false);
    assert.equal(refused((b) => (b.policy = 'open')), false);
    assert.equal(refused((b) => (b.policy = { x: 'y'.repeat(40000) })), false);
    assert.equal(refused((b) => (b.settings.extra = 1)), false, 'unknown settings');
    assert.equal(refused((b) => (b.settings.memory.archetype = 'wizard')), false);
    assert.equal(refused((b) => (b.settings.soul = 'x'.repeat(70000))), false);
    assert.equal(refused((b) => (b.skills[0].id = 'Bad_Id')), false, 'a malformed skill id');
    assert.equal(refused((b) => (b.agent.model = 'm'.repeat(201))), false);
    assert.equal(refused((b) => (b.agent.name = 'n'.repeat(121))), false);
    assert.equal(refused((b) => (b.agent.name = '   ')), false);
    assert.equal(refused(() => undefined), true);
  });

  it('keeps nothing but the known fields (an owner or a token smuggled in is dropped)', () => {
    const b = JSON.parse(JSON.stringify(buildBundle(agent, content as never)));
    b.owners = ['token:evil'];
    b.token = 'secret';
    b.agent.owners = ['token:evil'];
    const parsed = parseBundle(b);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.ok(!JSON.stringify(parsed.bundle).includes('evil') && !JSON.stringify(parsed.bundle).includes('secret'));
  });
});
