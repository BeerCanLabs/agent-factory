// #346: an agent left DEPLOYING by a control-plane restart mid-deploy is recovered at startup.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { recoverInterruptedDeploys } from './apply.js';
import type { FactoryState } from './app.js';

const agent = (id: string, extra: Record<string, unknown>) => ({ id, name: id, provider: 'cloud', artifact: 'x', requires: [], ungated: [], gated: [], ...extra });

describe('recovering deploys interrupted by a restart (#346)', () => {
  it('puts a stuck deployed agent back to SLEEPING, a never-deployed one to ERROR, and leaves others alone', () => {
    const ledger = new MemoryLedger();
    const agents = new Map<string, any>([
      ['rosie', agent('rosie', { state: 'DEPLOYING', deployedCommit: 'old', admission: { commit: 'new', status: 'building', at: 't' } })],
      ['fresh', agent('fresh', { state: 'DEPLOYING', admission: { commit: 'new', status: 'building', at: 't' } })],
      ['donna', agent('donna', { state: 'SLEEPING', deployedCommit: 'old' })],
    ]);
    const state = { agents, ledger } as unknown as FactoryState;
    const ids = recoverInterruptedDeploys(state, { reapply: false, now: new Date('2026-11-02T00:00:00Z') });
    assert.deepEqual(ids.sort(), ['fresh', 'rosie']);
    assert.equal(agents.get('rosie').state, 'SLEEPING');
    assert.equal(agents.get('rosie').deployedCommit, 'old');
    assert.equal(agents.get('rosie').admission.status, 'refused');
    assert.equal(agents.get('rosie').admission.reason, 'interrupted');
    assert.equal(agents.get('fresh').state, 'ERROR');
    assert.equal(agents.get('donna').state, 'SLEEPING');
    assert.equal(ledger.query({}).filter((r) => (r as { action?: string }).action === 'AGENT_DEPLOY_INTERRUPTED').length, 2);
  });
});
