// TSK-157 (§6.14 SK3, SK6, SK7): adoption requests, rejections and revocations kept apart from the configuration, and
// the two queries: which agents use a skill, which skills an agent uses.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdoptionStore, adopters, skillsOf } from './adoptions.js';
import { FileConfigBackend, VersionedConfigStore, type ConfigContent } from './config-store.js';

const SHA = 'a'.repeat(40);
const meta = { updatedBy: 'admin', reason: 'test' };
const tmp = () => mkdtempSync(join(tmpdir(), 'registrar-adoptions-'));
const content = (agentId: string, skills: ConfigContent['skills'] = []): ConfigContent => ({ agentId, source: { repo: `https://github.com/x/${agentId}`, commit: SHA }, skills, policy: null });
const prov = (id: string, version: string, auto = false) => ({
  id,
  version,
  requestedBy: 'token:ops',
  requestedAt: '2026-10-10T01:00:00.000Z',
  approvedBy: 'cloudflare:dale@example.com',
  approvedAt: '2026-10-10T02:00:00.000Z',
  ...(auto ? { auto: true as const } : {}),
});

describe('adoption store', () => {
  it('records a request, writes <agent>/<skill>.json and reloads it', () => {
    const dir = tmp();
    try {
      const store = new AdoptionStore(dir);
      const r = store.request({ agentId: 'higgins', skillId: 'tavily-search', version: '0.1.0', requestedBy: 'token:ops', reason: 'search', accessAdded: { routes: ['tavily'], models: [], credentials: [], connections: [] } }, new Date('2026-10-10T01:00:00Z'));
      assert.deepEqual([r.state, r.requestedAt], ['requested', '2026-10-10T01:00:00.000Z']);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'higgins', 'tavily-search.json'), 'utf8')), r);
      assert.deepEqual(new AdoptionStore(dir).get('higgins', 'tavily-search'), r);
      assert.equal(store.get('higgins', 'print'), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses ids that cannot name a file', () => {
    const store = new AdoptionStore();
    assert.throws(() => store.request({ agentId: '../x', skillId: 'print', version: '1.0.0', requestedBy: 'a' }), /cannot name an adoption/);
    assert.throws(() => store.request({ agentId: 'ada', skillId: 'Bad Skill', version: '1.0.0', requestedBy: 'a' }), /cannot name an adoption/);
  });

  it('rejects only a pending request, and a newer request replaces a rejection', () => {
    const store = new AdoptionStore();
    assert.equal(store.reject('ada', 'print', 'admin'), undefined);
    store.request({ agentId: 'ada', skillId: 'print', version: '1.0.0', requestedBy: 'a' });
    const rej = store.reject('ada', 'print', 'admin', 'no', new Date('2026-10-10T03:00:00Z'))!;
    assert.deepEqual([rej.state, rej.decidedBy, rej.decisionReason], ['rejected', 'admin', 'no']);
    assert.equal(store.reject('ada', 'print', 'admin'), undefined);
    assert.equal(store.request({ agentId: 'ada', skillId: 'print', version: '1.1.0', requestedBy: 'a' }).state, 'requested');
    assert.equal(store.get('ada', 'print')!.version, '1.1.0');
  });

  it('a revoked adoption blocks automatic adoption until a new request replaces it (SK6)', () => {
    const dir = tmp();
    try {
      const store = new AdoptionStore(dir);
      assert.equal(store.blocksAutoAdopt('higgins', 'print'), false);
      store.revoke('higgins', 'print', '0.1.1', 'cloudflare:dale@example.com', 'wrong printer');
      assert.equal(store.blocksAutoAdopt('higgins', 'print'), true);
      assert.equal(new AdoptionStore(dir).blocksAutoAdopt('higgins', 'print'), true, 'survives a restart');
      store.request({ agentId: 'higgins', skillId: 'print', version: '0.2.0', requestedBy: 'cloudflare:dale@example.com' });
      assert.equal(store.blocksAutoAdopt('higgins', 'print'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears a record and its file, and says whether there was one', () => {
    const dir = tmp();
    try {
      const store = new AdoptionStore(dir);
      store.request({ agentId: 'ada', skillId: 'print', version: '1.0.0', requestedBy: 'a' });
      assert.equal(store.clear('ada', 'print'), true);
      assert.equal(existsSync(join(dir, 'ada', 'print.json')), false);
      assert.equal(store.get('ada', 'print'), undefined);
      assert.equal(store.clear('ada', 'print'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a record whose file name does not match, and reports it', () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, 'ada'));
      writeFileSync(join(dir, 'ada', 'print.json'), JSON.stringify({ agentId: 'ada', skillId: 'other', version: '1.0.0', state: 'requested', requestedBy: 'a', requestedAt: 'x' }));
      writeFileSync(join(dir, 'ada', 'broken.json'), '{');
      const warned: string[] = [];
      const store = new AdoptionStore(dir, (m) => warned.push(m));
      assert.deepEqual(store.forAgent('ada'), []);
      assert.equal(warned.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('which agents use a skill, and which skills an agent uses (SK7)', () => {
  async function fixture() {
    const dir = tmp();
    const configs = await VersionedConfigStore.open(new FileConfigBackend(join(dir, 'config')));
    const adoptions = new AdoptionStore(join(dir, 'adoptions'));
    return { dir, configs, adoptions };
  }

  it('lists approved adopters from configurations and pending requests, narrowed by version, sorted by agent', async () => {
    const { dir, configs, adoptions } = await fixture();
    try {
      await configs.put(content('higgins', [{ id: 'tavily-search', version: '0.1.0' }, { id: 'print', version: '0.1.1' }]), { ...meta, skillAdoptions: [prov('tavily-search', '0.1.0'), prov('print', '0.1.1', true)] });
      await configs.put(content('donna', [{ id: 'tavily-search', version: '0.1.0' }]), meta);
      await configs.put(content('castle'), meta);
      adoptions.request({ agentId: 'castle', skillId: 'tavily-search', version: '0.1.0', requestedBy: 'token:ops' }, new Date('2026-10-10T04:00:00Z'));
      adoptions.request({ agentId: 'nick', skillId: 'tavily-search', version: '0.2.0', requestedBy: 'token:ops' });
      adoptions.reject('nick', 'tavily-search', 'admin');

      const all = adopters(configs, adoptions, 'tavily-search');
      assert.deepEqual(all.map((a) => [a.agentId, a.version, a.state]), [['castle', '0.1.0', 'requested'], ['donna', '0.1.0', 'approved'], ['higgins', '0.1.0', 'approved']]);
      assert.deepEqual(all[2], { agentId: 'higgins', version: '0.1.0', state: 'approved', requestedBy: 'token:ops', approvedBy: 'cloudflare:dale@example.com', since: '2026-10-10T02:00:00.000Z' });
      assert.deepEqual(all[1], { agentId: 'donna', version: '0.1.0', state: 'approved' }, 'adopted before provenance was recorded');
      assert.deepEqual(adopters(configs, adoptions, 'tavily-search', '0.2.0'), []);
      assert.equal(adopters(configs, adoptions, 'print')[0].auto, true);
      assert.deepEqual(adopters(configs, adoptions, 'nobody'), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists an agent’s adopted skills, pending requests and revocations', async () => {
    const { dir, configs, adoptions } = await fixture();
    try {
      await configs.put(content('higgins', [{ id: 'print', version: '0.1.1' }]), { ...meta, skillAdoptions: [prov('print', '0.1.1', true)] });
      adoptions.request({ agentId: 'higgins', skillId: 'tavily-search', version: '0.1.0', requestedBy: 'token:ops' });
      adoptions.revoke('higgins', 'discord-progress', '0.1.1', 'admin');
      adoptions.request({ agentId: 'higgins', skillId: 'factory-schedules', version: '0.1.1', requestedBy: 'token:ops' });
      adoptions.reject('higgins', 'factory-schedules', 'admin');

      const s = skillsOf(configs, adoptions, 'higgins');
      assert.deepEqual(s.adopted, [{ id: 'print', version: '0.1.1', requestedBy: 'token:ops', approvedBy: 'cloudflare:dale@example.com', approvedAt: '2026-10-10T02:00:00.000Z', auto: true }]);
      assert.deepEqual(s.requests.map((r) => r.skillId), ['tavily-search']);
      assert.deepEqual(s.revoked.map((r) => r.skillId), ['discord-progress']);
      assert.deepEqual(skillsOf(configs, adoptions, 'unknown'), { adopted: [], requests: [], revoked: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
