import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrateAgentIdentities } from './identity-migration.js';

describe('agent identity migration at start (GAP-249)', () => {
  const quiet = () => {
    const lines: string[] = [];
    return { lines, log: { log: (m: string) => lines.push(m), error: (m: string) => lines.push(`ERR ${m}`) } };
  };

  it('re-scopes every registered agent to its own prefix (default its id) and reports what it revoked', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const dp = {
      async reconcileIdentity(id: string, opts: { memoryPrefix?: string }) {
        seen.push([id, opts.memoryPrefix]);
        if (id === 'echo-agent') return { skipped: 'no-role', revoked: [] };
        if (id === 'broken') throw new Error('AccessDenied');
        return { revoked: id === 'donna' ? ['BedrockConverseAccess', 'AgentBedrockModelInvocation'] : [] };
      },
    };
    const q = quiet();
    const r = await migrateAgentIdentities(
      [{ id: 'archie', memoryPrefix: 'archie-state' }, { id: 'donna', memoryPrefix: 'donna-state' }, { id: 'echo-agent' }, { id: 'broken' }, { id: 'skippy' }],
      dp,
      q.log,
    );
    assert.deepEqual(seen, [['archie', 'archie-state'], ['donna', 'donna-state'], ['echo-agent', 'echo-agent'], ['broken', 'broken'], ['skippy', 'skippy']]);
    assert.deepEqual(r.map((x) => `${x.agentId}:${x.outcome}`), ['archie:updated', 'donna:updated', 'echo-agent:skipped', 'broken:failed', 'skippy:updated']);
    assert.match(q.lines.join('\n'), /3 updated, 2 skipped or failed; direct model access removed from donna \(BedrockConverseAccess, AgentBedrockModelInvocation\)/);
    assert.match(q.lines.join('\n'), /ERR .*failed for broken: AccessDenied/);
  });

  it('does nothing for a provider with no identities to migrate', async () => {
    assert.deepEqual(await migrateAgentIdentities([{ id: 'a' }], {}), []);
    assert.deepEqual(await migrateAgentIdentities([{ id: 'a' }], undefined), []);
  });

  it('the control plane starts the migration after run reconciliation, without awaiting it', () => {
    const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    const at = src.indexOf('void migrateAgentIdentities(state.agents.values(), deployProvider);');
    assert.ok(at > src.indexOf('await reconcileRuns(state);'), 'migration starts after reconcileRuns');
  });
});
