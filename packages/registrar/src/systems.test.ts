// TSK-128 (GAP-098, §6.3.1 E10): the system definition store, its files and its ledger rows, as the control plane had it
// before the move. The control plane's systems.e2e.test.ts covers the routes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSystemProposal, type SystemProposal } from '@beercanlabs/factory-contract';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { SystemsStore } from './systems.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'registrar-systems-'));

function proposal(over: Record<string, unknown> = {}): SystemProposal {
  const r = validateSystemProposal({
    id: 'github',
    name: 'GitHub API',
    kind: 'http',
    upstream: 'https://api.github.com',
    credential: { secret: '{agent}_GITHUB_TOKEN', header: 'authorization', format: 'Bearer {}', fallback: false },
    ...over,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { proposal: SystemProposal }).proposal;
}

function ledgerSink() {
  const rows: Array<Record<string, unknown>> = [];
  return { rows, append: (e: Record<string, unknown>) => void rows.push(e) };
}

describe('system definition store', () => {
  it('a proposal is a new, unapproved version: written as two-space JSON, hashed, ledgered, not yet served', async () => {
    const dir = tmp();
    try {
      const ledger = ledgerSink();
      const store = await SystemsStore.open(dir, ledger);
      const def = await store.propose(proposal(), 'alice');
      assert.equal(def.version, 1);
      assert.equal(def.status, 'proposed');
      assert.equal(def.proposedBy, 'alice');
      assert.equal(readFileSync(join(dir, 'github', '1.json'), 'utf8'), JSON.stringify(def, null, 2));
      assert.equal(store.get('github'), null, 'a proposal is not served until approved');
      assert.deepEqual(store.activeRoutes(), []);
      assert.equal(ledger.rows.length, 1);
      assert.deepEqual(
        { ...ledger.rows[0], timestamp: undefined },
        { timestamp: undefined, agentId: 'system:github@1', type: 'action', action: 'SYSTEM_PROPOSED', actor: 'alice', route: 'github', payloadSha256: def.hash },
      );
      const { version, status, proposedBy, proposedAt, hash, ...content } = def;
      assert.equal(hash, payloadHash(JSON.parse(JSON.stringify(content))), 'the hash is the ledger\'s payload hash of the content');
      void version; void status; void proposedBy; void proposedAt;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('approving makes a version the served one, writes current.json and ledgers who decided', async () => {
    const dir = tmp();
    try {
      const ledger = ledgerSink();
      const store = await SystemsStore.open(dir, ledger);
      await store.propose(proposal(), 'alice');
      const approved = await store.approve('github', undefined, 'admin', 'looks right');
      assert.equal(approved.status, 'approved');
      assert.equal(approved.decidedBy, 'admin');
      assert.equal(approved.reason, 'looks right');
      assert.equal(store.get('github')?.version, 1);
      assert.equal(readFileSync(join(dir, 'github', 'current.json'), 'utf8'), JSON.stringify(approved, null, 2));
      assert.equal(ledger.rows[1].action, 'SYSTEM_APPROVED');
      assert.equal(ledger.rows[1].agentId, 'system:github@1');
      await assert.rejects(() => store.approve('nope', undefined, 'admin'), /system nope not found/);
      await assert.rejects(() => store.approve('github', 9, 'admin'), /version 9 not found for system github/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a later proposal does not replace the approved version, and rejecting the served one falls back to the previous approved', async () => {
    const dir = tmp();
    try {
      const store = await SystemsStore.open(dir, ledgerSink());
      await store.propose(proposal(), 'alice');
      await store.approve('github', 1, 'admin');
      await store.propose(proposal({ name: 'GitHub API v2' }), 'alice');
      assert.equal(store.get('github')?.version, 1, 'version 2 is only proposed');
      await store.approve('github', 2, 'admin');
      assert.equal(store.get('github')?.version, 2);
      await store.reject('github', 2, 'admin', 'no');
      assert.equal(store.get('github')?.version, 1, 'back to the previous approved version');
      assert.equal(JSON.parse(readFileSync(join(dir, 'github', 'current.json'), 'utf8')).version, 1);
      await store.reject('github', 1, 'admin');
      assert.equal(store.get('github'), null, 'nothing approved is left to serve');
      assert.deepEqual(store.history('github').map((d) => d.status), ['rejected', 'rejected']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a new store over the same directory reads every version back and serves the latest approved', async () => {
    const dir = tmp();
    try {
      const first = await SystemsStore.open(dir, ledgerSink());
      await first.propose(proposal(), 'alice');
      await first.approve('github', 1, 'admin');
      await first.propose(proposal({ name: 'GitHub API v2' }), 'alice');
      mkdirSync(join(dir, '.hidden'));
      const again = await SystemsStore.open(dir);
      assert.deepEqual(again.history('github').map((d) => [d.version, d.status]), [[1, 'approved'], [2, 'proposed']]);
      assert.equal(again.get('github')?.version, 1);
      assert.deepEqual(again.list().map((s) => s.id), ['github']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists systems by id with their status, and serves only approved ones as egress routes', async () => {
    const dir = tmp();
    try {
      const store = await SystemsStore.open(dir, ledgerSink());
      await store.propose(proposal({ id: 'zeta', name: 'Zeta', upstream: 'https://zeta.example' }), 'a');
      await store.propose(proposal(), 'a');
      await store.approve('github', undefined, 'admin');
      const list = store.list();
      assert.deepEqual(list.map((s) => [s.id, s.status, s.approvedVersion, s.latestVersion]), [['github', 'approved', 1, 1], ['zeta', 'proposed', null, 1]]);
      const routes = store.activeRoutes();
      assert.deepEqual(routes.map((r) => r.id), ['github']);
      assert.equal(routes[0].upstream, 'https://api.github.com');
      assert.equal(routes[0].credential?.secret, '{agent}_GITHUB_TOKEN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a deployment\'s existing routes are imported once as approved systems; model routes, invalid ones and existing systems are left alone', async () => {
    const dir = tmp();
    try {
      const ledger = ledgerSink();
      const store = await SystemsStore.open(dir, ledger);
      const routes = [
        { id: 'notion', name: 'Notion', kind: 'http', upstream: 'https://api.notion.com', credential: { secret: 'NOTION_API_KEY', header: 'authorization', format: 'Bearer {}', fallback: false } },
        { id: 'openai', kind: 'llm' },
        { id: 'models', kind: 'models' },
        { id: 'bad id!', kind: 'http', upstream: 'https://x.example' },
      ];
      const out = await store.importRoutes(routes, 'migration:boot');
      assert.deepEqual(out.imported, ['notion']);
      assert.equal(out.skipped.length, 1);
      assert.match(out.skipped[0], /^bad id!: /);
      assert.equal(store.get('notion')?.status, 'approved');
      assert.match(store.get('notion')!.reason!, /imported from the deployment's gatekeeper-egress routes \(GAP-068\)/);
      assert.equal(ledger.rows.at(-1)?.action, 'SYSTEM_IMPORTED');

      const again = await store.importRoutes(routes, 'migration:boot');
      assert.deepEqual(again.imported, [], 're-running on every boot is safe');
      assert.equal(store.history('notion').length, 1);
      assert.deepEqual(await store.importRoutes('not an array', 'x'), { imported: [], skipped: [] });

      // Updating scopes on a migration-created system imports a new approved version
      const withScopes = [{ id: 'notion', kind: 'http', upstream: 'https://api.notion.com', scopes: ['notion:read'] }];
      const updated = await store.importRoutes(withScopes, 'migration:boot');
      assert.deepEqual(updated.imported, ['notion']);
      assert.equal(store.get('notion')?.version, 2);
      assert.deepEqual(store.get('notion')?.scopes, ['notion:read']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens a missing directory by creating it, and works without a ledger', async () => {
    const root = tmp();
    try {
      const dir = join(root, 'a', 'systems');
      const store = await SystemsStore.open(dir);
      assert.equal(existsSync(dir), true);
      assert.deepEqual(store.list(), []);
      await store.propose(proposal(), 'alice');
      assert.deepEqual(readdirSync(join(dir, 'github')), ['1.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a subclass opens as itself, so the control plane\'s adds its methods to the same store', async () => {
    class Extended extends SystemsStore {
      served(): string[] {
        return [...this.current.keys()];
      }
    }
    const dir = tmp();
    try {
      const store = await Extended.open(dir, ledgerSink());
      assert.equal(store instanceof Extended, true);
      await store.propose(proposal(), 'alice');
      await store.approve('github', undefined, 'admin');
      assert.deepEqual(store.served(), ['github']);
      writeFileSync(join(dir, 'stray.txt'), 'not a system');
      assert.equal((await Extended.open(dir)).served().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
