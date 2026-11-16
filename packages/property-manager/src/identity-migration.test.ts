import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrateAgentIdentities, MIGRATION_RETRY_DELAYS_MS } from './identity-migration.js';

type Out = 'updated' | 'no-role' | 'mismatch' | 'not-narrowed';
const run = async (agents: Array<{ id: string; memoryPrefix?: string }>, dp: any, delays: number[] = [], sleep = async (_ms: number) => {}) => {
  const lines: string[] = [];
  const r = await migrateAgentIdentities(agents, dp, { log: { log: (m) => lines.push(m), error: (m) => lines.push(`ERR ${m}`) }, delays, sleep });
  return { r: r.map((x) => `${x.agentId}:${x.outcome}`), out: lines.join('\n'), raw: r };
};
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

  it('retires identities with no record (purged agents, helper computes)', async () => {
    const retired: string[] = [];
    const dp = {
      async reconcileIdentity() { return { outcome: 'updated', revoked: [] }; },
      async listIdentities() { return ['a', 'e2e-cfg-skill', '__helper_x']; },
      async retireIdentity(id: string) { retired.push(id); return { revoked: [] }; },
    };
    const { r } = await run([{ id: 'a' }], dp);
    assert.deepEqual(retired, ['e2e-cfg-skill', '__helper_x']);
    assert.deepEqual(r, ['a:updated', 'e2e-cfg-skill:retired', '__helper_x:retired']);
  });

  it('retries AccessDenied and throttling with backoff, then gives up; other errors are not retried', async () => {
    const waits: number[] = [];
    let tries = 0;
    const dp = {
      async reconcileIdentity() {
        if (++tries < 3) throw tries === 1 ? denied() : Object.assign(new Error('slow'), { name: 'Throttling' });
        return { outcome: 'updated', revoked: [] };
      },
      async listIdentities(): Promise<string[]> { throw denied(); },
      async retireIdentity() { return { revoked: [] }; },
    };
    const { r } = await run([{ id: 'a' }], dp, [1, 2, 3], async (ms) => void waits.push(ms));
    assert.deepEqual([tries, r, waits], [3, ['a:updated', '(identities with no record):failed'], [1, 2, 1, 2, 3]]);
    tries = 0;
    await run([{ id: 'x' }], { async reconcileIdentity() { tries++; throw new Error('bad'); } }, [1, 2]);
    assert.equal(tries, 1);
    assert.equal(MIGRATION_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0), 315_000, 'about five minutes');
  });

  it('does nothing without a provider that reconciles, and starts after run reconciliation, not awaited', async () => {
    assert.deepEqual(await migrateAgentIdentities([{ id: 'a' }], {}), []);
    const src = readFileSync(fileURLToPath(new URL('../../control-plane/src/index.ts', import.meta.url)), 'utf8');
    assert.ok(src.indexOf('void migrateAgentIdentities(state.agents.values(), deployProvider);') > src.indexOf('await reconcileRuns(state);'));
  });
});
