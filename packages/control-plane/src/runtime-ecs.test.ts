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
  function fake() {
    const calls: string[][] = [];
    let stopped = false;
    const rt = ecsRuntime({
      cluster: 'agent-factory-prod',
      taskMap: { 'echo-agent': 'factory-echo-prod' },
      subnets: ['subnet-1'],
      securityGroups: ['sg-1'],
      cli: async (args) => {
        calls.push(args);
        if (args[1] === 'run-task') return JSON.stringify({ tasks: [{ taskArn: 'arn:task/echo-1' }] });
        if (args[1] === 'describe-tasks') {
          return JSON.stringify({
            tasks: [stopped ? { lastStatus: 'STOPPED', containers: [{ name: 'worker', exitCode: 3 }] } : { lastStatus: 'RUNNING' }],
          });
        }
        return '{}';
      },
    });
    return { rt, calls, stop: () => (stopped = true) };
  }

  it('RunTask carries run metadata but never secret values', async () => {
    const { rt, calls } = fake();
    const { handle } = await rt.start(echo, { ECHO_WEBHOOK_SECRET: 'super-secret-value' }, {
      runId: 'run-1',
      runEnv: { FACTORY_RUN_ID: 'run-1', FACTORY_RUN_TOKEN: 'tok' },
    });
    assert.equal(handle, 'arn:task/echo-1');
    const args = calls[0].join(' ');
    assert.ok(args.includes('FACTORY_RUN_ID'));
    assert.equal(args.includes('super-secret-value'), false);
    assert.equal(args.includes('ECHO_WEBHOOK_SECRET'), false);
  });

  it('stops by durable handle and reports exit via DescribeTasks', async () => {
    const { rt, calls, stop } = fake();
    await rt.start(echo, {}, { runId: 'run-2', runEnv: {} });
    assert.deepEqual(await rt.status!('arn:task/echo-1'), { state: 'running' });
    stop();
    const s = await rt.status!('arn:task/echo-1');
    assert.equal(s.state, 'stopped');
    if (s.state === 'stopped') assert.equal(s.exitCode, 3);
    await rt.stop(echo, 'arn:task/other');
    assert.ok(calls.some((c) => c[1] === 'stop-task' && c.includes('arn:task/other')));
  });

  it('throws when RunTask returns no task', async () => {
    const rt = ecsRuntime({
      cluster: 'c',
      taskMap: { 'echo-agent': 'f' },
      subnets: [],
      securityGroups: [],
      cli: async () => JSON.stringify({ tasks: [], failures: [{ reason: 'RESOURCE:CPU' }] }),
    });
    await assert.rejects(rt.start(echo, {}, { runId: 'r', runEnv: {} }), /RESOURCE:CPU/);
  });
});
