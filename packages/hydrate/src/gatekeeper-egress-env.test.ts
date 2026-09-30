import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gatekeeperEgressEnv } from './gatekeeper-egress-env.js';

describe('gatekeeperEgressEnv TSK-045 routes (S1)', () => {
  it('points agents at the github, motion and deployment-specific routes; never at the upstreams', () => {
    const env = gatekeeperEgressEnv({ FACTORY_GATEKEEPER_EGRESS_URL: 'http://gw:8081/', FACTORY_RUN_TOKEN: 'run-tok' });
    assert.equal(env.GITHUB_BASE_URL, 'http://gw:8081/github');
    assert.equal(env.MOTION_BASE_URL, 'http://gw:8081/motion');
    assert.equal(env.CLOSING_CLIMB_BASE_URL, 'http://gw:8081/closing-climb');
    assert.equal(env.HOME_ASSISTANT_BASE_URL, 'http://gw:8081/home-assistant');
    // No credential for these services is ever handed to the agent.
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.MOTION_API_KEY, undefined);
  });
});
