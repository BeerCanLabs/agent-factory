// #492: the Fleet row offers Resume for an ISOLATED agent, the same control PAUSED already uses.
// The console has no component test runner, so this renders the view to static markup and checks the control it draws.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentRecord, AgentState } from '../api/types.js';
import { FLEET_STATE_FILTERS, FleetView, fleetQuarantineAction } from './FleetView.js';

const agent = (state: AgentState, id = 'ada'): AgentRecord => ({
  id,
  name: 'Ada',
  version: '1.0.0',
  state,
  model: 'test-model',
});

const view = (agents: AgentRecord[]) =>
  renderToStaticMarkup(<FleetView agents={agents} onSelectAgent={() => {}} onRefresh={() => {}} />);

describe('#492 fleet quarantine control', () => {
  it('offers Resume for PAUSED and ISOLATED, and Pause for every other state', () => {
    const resume: AgentState[] = ['PAUSED', 'ISOLATED'];
    const pause: AgentState[] = [
      'DRAFT',
      'PENDING_BUDGET',
      'PENDING_DEPLOY',
      'DEPLOYING',
      'SLEEPING',
      'RUNNING',
      'WORKING',
      'IDLE',
      'TRAINING',
      'BLOCKED_FOR_HUMAN',
      'ERROR',
      'OUT_OF_BUDGET',
      'RETIRED_PENDING_PURGE',
      'PURGED',
    ];
    for (const state of resume) assert.equal(fleetQuarantineAction(state), 'resume', state);
    for (const state of pause) assert.equal(fleetQuarantineAction(state), 'pause', state);
  });

  it('an ISOLATED row shows Resume, the control that calls the existing resume API', () => {
    const html = view([agent('ISOLATED')]);
    assert.match(html, /title="Resume Agent"/);
    assert.match(html, />\s*Resume\s*</);
    assert.doesNotMatch(html, /Quarantine \/ Pause Agent/);
  });

  it('a PAUSED row still shows Resume', () => {
    const html = view([agent('PAUSED')]);
    assert.match(html, /title="Resume Agent"/);
    assert.doesNotMatch(html, /Quarantine \/ Pause Agent/);
  });

  it('a RUNNING row still shows Pause', () => {
    const html = view([agent('RUNNING')]);
    assert.match(html, /title="Quarantine \/ Pause Agent"/);
    assert.doesNotMatch(html, /title="Resume Agent"/);
  });

  it('the state filter lists ISOLATED beside the states it already offered', () => {
    const html = view([]);
    for (const chip of FLEET_STATE_FILTERS) {
      assert.match(html, new RegExp(`>\\s*${chip}\\s*<`), chip);
    }
  });
});
