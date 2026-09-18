import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ecsRuntime, parseTaskMap } from './runtime-ecs.js';
import type { AgentRecord } from './catalog.js';

const echo: AgentRecord = {
  id: 'echo-agent',
  name: 'Echo',
  role: 'echo',
  state: 'IDLE',
  provider: 'aws',
  artifact: 'oci://x',
  requires: [],
  triggers: [{ type: 'http', path: '/wake' }],
  dir: '/tmp',
};

describe('parseTaskMap', () => {
  it('parses id:family pairs', () => {
    assert.deepEqual(parseTaskMap('echo-agent:factory-echo-prod'), { 'echo-agent': 'factory-echo-prod' });
  });
});

describe('ecsRuntime', () => {
  it('RunTask on start and StopTask on stop', async () => {
    const calls: string[][] = [];
    const rt = ecsRuntime({
      cluster: 'agent-factory-prod',
      taskMap: { 'echo-agent': 'factory-echo-prod' },
      subnets: ['subnet-1'],
      securityGroups: ['sg-1'],
      cli: async (args) => {
        calls.push(args);
        if (args[1] === 'run-task') {
          return JSON.stringify({ tasks: [{ taskArn: 'arn:task/echo-1' }] });
        }
        return '{}';
      },
    });
    await rt.start(echo, {});
    assert.equal(rt.running('echo-agent'), true);
    assert.equal(calls[0]?.[1], 'run-task');
    assert.ok(calls[0]?.includes('factory-echo-prod'));
    await rt.stop(echo);
    assert.equal(rt.running('echo-agent'), false);
    assert.equal(calls[1]?.[1], 'stop-task');
  });
});
