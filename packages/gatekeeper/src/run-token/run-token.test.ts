// DESIGN_AUTHORITY.md §6.15 (Gatekeeper), A1, A2: a run token speaks for exactly one live run of the agent it names.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RunTokens } from '@beercanlabs/factory-auth';
import { verifyRun, type VerifyRunInput } from './index.js';

type Run = { agentId: string; state: 'WORKING' | 'DONE' | 'TIMED_OUT' };

const tokens = new RunTokens('run-token-contract-test-key-0123456789abcdef');
const RUNS: Record<string, Run> = {
  r1: { agentId: 'castle', state: 'WORKING' },
  r2: { agentId: 'castle', state: 'DONE' },
  r3: { agentId: 'castle', state: 'TIMED_OUT' },
  r4: { agentId: 'other', state: 'WORKING' },
};
const base = (token: string | undefined): VerifyRunInput<Run> => ({
  tokens,
  token,
  runOf: (id) => RUNS[id],
  ended: (r) => r.state !== 'WORKING',
});
const mint = (runId: string, agentId = 'castle') => tokens.mint({ runId, agentId });

describe('verifyRun', () => {
  it('accepts a live run\'s own token and returns the claims and the run', async () => {
    const v = await verifyRun(base(await mint('r1')));
    assert.equal(v.kind, 'ok');
    if (v.kind === 'ok') {
      assert.deepEqual(v.claims, { runId: 'r1', agentId: 'castle' });
      assert.equal(v.run, RUNS.r1);
    }
  });

  it('says "not a run token" for no token, a forged token and another kind of token, so a caller may try a person', async () => {
    for (const token of [undefined, '', 'not-a-jwt', 'a.b.c', (await new RunTokens('a-different-key-0123456789abcdefghij').mint({ runId: 'r1', agentId: 'castle' }))]) {
      assert.deepEqual(await verifyRun(base(token)), { kind: 'not_a_run_token' });
    }
  });

  it('refuses a valid token for an unknown run, for another agent\'s run and for a run that has ended', async () => {
    assert.deepEqual(await verifyRun(base(await mint('nope'))), { kind: 'refused' });
    assert.deepEqual(await verifyRun(base(await mint('r4', 'castle'))), { kind: 'refused' }); // the token names castle; r4 is other's
    assert.deepEqual(await verifyRun(base(await mint('r2'))), { kind: 'refused' });
  });

  it('refuses a token for a different run than the route names, and accepts the run it names', async () => {
    const token = await mint('r1');
    assert.deepEqual(await verifyRun({ ...base(token), runId: 'r1b' }), { kind: 'refused' });
    assert.equal((await verifyRun({ ...base(token), runId: 'r1' })).kind, 'ok');
  });

  it('honors an ended run only where the caller says so, and only for what it says', async () => {
    const timedOut = await mint('r3');
    const done = await mint('r2');
    assert.deepEqual(await verifyRun(base(timedOut)), { kind: 'refused' });
    const endedOk = (r: Run) => r.state === 'TIMED_OUT';
    assert.equal((await verifyRun({ ...base(timedOut), endedOk })).kind, 'ok');
    assert.deepEqual(await verifyRun({ ...base(done), endedOk }), { kind: 'refused' });
  });
});
