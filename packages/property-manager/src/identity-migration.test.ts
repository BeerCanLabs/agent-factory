import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrateAgentIdentities, MIGRATION_RETRY_DELAYS_MS } from './identity-migration.js';

type Out = 'updated' | 'no-role' | 'mismatch' | 'not-narrowed';
type Extra = { retireRefusal?: string; isRegistered?: (id: string) => boolean };
const run = async (agents: Array<{ id: string; memoryPrefix?: string }>, dp: any, delays: number[] = [], sleep = async (_ms: number) => {}, extra: Extra = {}) => {
  const lines: string[] = [];
  const r = await migrateAgentIdentities(agents, dp, { log: { log: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) }, delays, sleep, ...extra });
  return { r: r.map((x) => `${x.agentId}:${x.outcome}`), out: lines.join('\n'), lines, raw: r };
};
const lister = (ids: string[], retired: string[]) => ({
  async reconcileIdentity() { return { outcome: 'updated', revoked: [] }; },
  async listIdentities() { return ids; },
  async retireIdentity(id: string) { retired.push(id); return { revoked: [] }; },
});
const denied = () => Object.assign(new Error('no'), { name: 'AccessDenied' });

describe('agent identity migration at start (GAP-263)', () => {
  it('reconciles every registered agent on its own prefix (default its id) and logs each outcome', async () => {
    const seen: string[] = [];
    const outcomes: Record<string, Out> = { e: 'no-role', s: 'mismatch' };
    const dp = {
      async reconcileIdentity(id: string, o: { memoryPrefix?: string; narrow?: boolean }) {
        seen.push(`${id}:${o.memoryPrefix}:${o.narrow}`);
        if (id === 'x') throw new Error('boom');
        return { outcome: outcomes[id] ?? 'updated', revoked: id === 'd' ? ['BedrockConverseAccess'] : [], detail: id === 's' ? 'uses "s-old"' : undefined };
      },
    };
    const { r, out } = await run([{ id: 'a', memoryPrefix: 'a-state' }, { id: 'd' }, { id: 'e' }, { id: 'x' }, { id: 's' }], dp);
    assert.deepEqual(seen, ['a:a-state:true', 'd:d:true', 'e:e:true', 'x:x:true', 's:s:true']);
    assert.deepEqual(r, ['a:updated', 'd:updated', 'e:no-role', 'x:failed', 's:mismatch']);
    assert.match(out, /2 updated, 0 without a record retired, 1 without a role, 0 model access only, 1 prefix mismatch, 1 failed; direct model access removed from d \(BedrockConverseAccess\)/);
    assert.match(out, /ERR .*failed for x: Error: boom/);
    assert.match(out, /ERR .*skipped the mind grant for s: uses "s-old"/);
  });

  it('never narrows a shared or invalid prefix, but still revokes model access', async () => {
    const seen: string[] = [];
    const dp = { async reconcileIdentity(id: string, o: { narrow?: boolean }) { seen.push(`${id}:${o.narrow}`); return { outcome: 'not-narrowed', revoked: [] }; } };
    const { r, raw } = await run([{ id: 'a', memoryPrefix: 'p' }, { id: 'b', memoryPrefix: 'p' }, { id: 'c', memoryPrefix: 'team/c' }], dp);
    assert.deepEqual(seen, ['a:false', 'b:false', 'c:false']);
    assert.deepEqual(r, ['a:failed', 'b:failed', 'c:failed']);
    assert.match(raw[0].detail!, /shared by a, b; mind grant left unchanged/);
    assert.match(raw[2].detail!, /invalid mind prefix/);
  });

  it('retires identities with no record (purged agents, helper computes), before reconciling', async () => {
    const retired: string[] = [];
    const { r } = await run([{ id: 'a' }], lister(['a', 'e2e-cfg-skill', '__helper_x'], retired));
    assert.deepEqual(retired, ['e2e-cfg-skill', '__helper_x']);
    assert.deepEqual(r, ['e2e-cfg-skill:retired', '__helper_x:retired', 'a:updated']);
  });

  it('with an incomplete registry, nothing is retired, but registered agents are still reconciled', async () => {
    const retired: string[] = [];
    const { r, out } = await run([{ id: 'a' }], lister(['a', 'b', 'c'], retired), [], undefined, { retireRefusal: 'registry /r unreadable: EACCES' });
    assert.deepEqual(retired, []);
    assert.deepEqual(r, ['(identities with no record):skipped', 'a:updated']);
    assert.match(out, /ERR .*retires nothing: registry \/r unreadable: EACCES/);
    assert.match(out, /retire step skipped/);
  });

  it('an agent added, re-created or mid-deploy after the migration starts is not retired (live check per role)', async () => {
    const retired: string[] = [];
    const live = new Set(['a']);
    const dp = lister(['a', 'gone', 'e2e-cfg-soul', 'later'], retired);
    const retire = dp.retireIdentity;
    // e2e-cfg-soul is re-created (and 'later' deployed) while 'gone' is being retired.
    dp.retireIdentity = async (id: string) => { const x = await retire(id); if (id === 'gone') live.add('e2e-cfg-soul').add('later'); return x; };
    const { r } = await run([{ id: 'a' }], dp, [], undefined, { isRegistered: (id) => live.has(id) });
    assert.deepEqual(retired, ['gone']);
    assert.deepEqual(r, ['gone:retired', 'a:updated']);
  });

  it('waits out IAM propagation once, at the preflight, then fails fast per role and logs each failure as it happens', async () => {
    const waits: number[] = [];
    const lines: string[] = [];
    let lists = 0;
    let tries = 0;
    const dp = {
      async listIdentities() {
        if (++lists < 3) throw lists === 1 ? denied() : Object.assign(new Error('slow'), { name: 'Throttling' });
        return ['a', 'old'];
      },
      async retireIdentity(): Promise<{ revoked: string[] }> { throw denied(); },
      async reconcileIdentity(id: string) {
        tries++;
        if (id === 'a') { lines.push('reconciling a'); throw denied(); }
        return { outcome: 'updated', revoked: [] };
      },
    };
    const res = await migrateAgentIdentities([{ id: 'a' }, { id: 'b' }], dp, {
      log: { log: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) }, delays: [1, 2, 3], sleep: async (ms) => void waits.push(ms),
    });
    assert.deepEqual([lists, tries, waits], [3, 2, [1, 2]]);
    assert.deepEqual(res.map((x) => `${x.agentId}:${x.outcome}`), ['old:failed', 'a:failed', 'b:updated']);
    assert.match(lines[0], /ERR .*failed for old: identity with no record: AccessDenied/);
    assert.deepEqual(lines.slice(1, 3).map((l) => l.slice(0, 20)), ['reconciling a', 'ERR [control-plane] ']);
    assert.match(lines[3], /1 updated, 0 without a record retired, .* 2 failed/);
  });

  it('changes nothing when the preflight never succeeds; other errors are not retried', async () => {
    const waits: number[] = [];
    let tries = 0;
    const dp = { async listIdentities(): Promise<string[]> { throw denied(); }, async reconcileIdentity() { tries++; return { outcome: 'updated', revoked: [] }; } };
    const { r, out } = await run([{ id: 'a' }], dp, [1, 2, 3], async (ms) => void waits.push(ms));
    assert.deepEqual([tries, r, waits], [0, ['(preflight):failed'], [1, 2, 3]]);
    assert.match(out, /ERR .*failed for \(preflight\): AccessDenied: no; nothing changed/);
    let lists = 0;
    await run([{ id: 'x' }], { async listIdentities() { lists++; throw new Error('bad'); }, async reconcileIdentity() { return { outcome: 'updated' }; } }, [1, 2]);
    assert.equal(lists, 1);
    assert.equal(MIGRATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0), 315_000, 'about five minutes');
  });

  it('does nothing without a provider that reconciles, and starts after run reconciliation, not awaited', async () => {
    assert.deepEqual(await migrateAgentIdentities([{ id: 'a' }], {}), []);
    const src = readFileSync(fileURLToPath(new URL('../../control-plane/src/index.ts', import.meta.url)), 'utf8');
    const start = src.indexOf('void migrateAgentIdentities(state.agents.values(), deployProvider, {');
    assert.ok(start > src.indexOf('await reconcileRuns(state);'));
    const call = src.slice(start, src.indexOf('});', start));
    assert.match(call, /retireRefusal: pruneRefusal\(new Set\(state\.agents\.keys\(\)\), BUILTIN_SYSTEM_AGENTS\.map\(\(a\) => a\.id\), checkRegistry\(REGISTRY_DIR\)\)/);
    assert.match(call, /isRegistered: \(id\) => state\.agents\.has\(id\) \|\| isDeploying\(state, id\)/);
  });
});
