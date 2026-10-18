import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initialPresence } from './presence.js';

describe('initial presence follows a live run, never the stored agent state (GAP-176)', () => {
  it('is available only while a run is live', () => {
    assert.equal(initialPresence({ liveRun: true, state: 'RUNNING' }), 'available');
    assert.equal(initialPresence({ liveRun: false, state: 'SLEEPING' }), 'offline');
  });

  it('after an ingress restart, a WORKING agent with no run is offline, so the next message wakes it', () => {
    // Prod 2026-10-18 10:51: Rosie's stored state was WORKING with no run; presence was available and messages parked.
    assert.equal(initialPresence({ liveRun: false, state: 'WORKING' }), 'offline');
  });

  it('a control plane without liveRun is read from RUNNING, which it reports for a live run', () => {
    assert.equal(initialPresence({ state: 'RUNNING' }), 'available');
    assert.equal(initialPresence({ state: 'WORKING' }), 'offline');
  });
});
