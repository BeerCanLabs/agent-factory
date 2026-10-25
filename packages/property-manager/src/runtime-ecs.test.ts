import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ecsRuntime, parseTaskMap } from './runtime-ecs.js';
import type { AgentRecord } from '@beercanlabs/factory-registrar';

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

  it('a landing-zone mapped task overrides its worker container, even for an oci (cloud) cartridge', async () => {
    const { rt, calls } = fake();
    await rt.start({ ...echo, provider: 'cloud' }, {}, { runId: 'run-9', runEnv: { FACTORY_RUN_ID: 'run-9' } });
    const overrides = calls[0][calls[0].indexOf('--overrides') + 1];
    assert.ok(overrides.includes('"name":"worker"'), overrides);
    assert.equal(calls[0][calls[0].indexOf('--task-definition') + 1], 'factory-echo-prod');
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

  it('runs an admitted deploy from its registered task definition, not the static task map', async () => {
    const { rt, calls } = fake();
    await rt.start({ ...echo, deployedCommit: 'a'.repeat(40) }, {}, { runId: 'run-3', runEnv: {} });
    const args = calls[0];
    assert.equal(args[args.indexOf('--task-definition') + 1], 'agent-echo-agent');
    assert.ok(args[args.indexOf('--overrides') + 1].includes('"agent-container"'));
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

  describe('a just-created task role (IAM propagation)', () => {
    const assumeErr = () =>
      new Error(
        'Command failed: aws ecs run-task\nAn error occurred (ClientException) when calling the RunTask operation: ECS was unable to assume the role ' +
          "'arn:aws:iam::1:role/AgentTaskRole-x' that was provided for this task. Please verify that the role being passed has the proper trust relationship",
      );
    function harness(cliImpl: (n: number) => Promise<string>) {
      let t = 0;
      const sleeps: number[] = [];
      let calls = 0;
      const rt = ecsRuntime({
        cluster: 'c',
        taskMap: { 'echo-agent': 'f' },
        subnets: [],
        securityGroups: [],
        assumeRoleRetryWindowMs: 60_000,
        assumeRoleRetryDelayMs: 5_000,
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
        cli: async () => cliImpl(++calls),
      });
      return { rt, sleeps, calls: () => calls };
    }

    it('retries RunTask until the role is assumable, then starts the task', async () => {
      const h = harness(async (n) => {
        if (n < 4) throw assumeErr();
        return JSON.stringify({ tasks: [{ taskArn: 'arn:task/ok' }] });
      });
      const { handle } = await h.rt.start(echo, {}, { runId: 'r', runEnv: {} });
      assert.equal(handle, 'arn:task/ok');
      assert.equal(h.calls(), 4);
      assert.deepEqual(h.sleeps, [5_000, 5_000, 5_000]);
    });

    it('does not retry any other error', async () => {
      const h = harness(async () => {
        throw new Error('An error occurred (AccessDeniedException) when calling the RunTask operation: nope');
      });
      await assert.rejects(h.rt.start(echo, {}, { runId: 'r', runEnv: {} }), /AccessDeniedException/);
      assert.equal(h.calls(), 1);
      assert.deepEqual(h.sleeps, []);
    });

    it('does not retry a RunTask that returns failures', async () => {
      const h = harness(async () => JSON.stringify({ tasks: [], failures: [{ reason: 'RESOURCE:CPU' }] }));
      await assert.rejects(h.rt.start(echo, {}, { runId: 'r', runEnv: {} }), /RESOURCE:CPU/);
      assert.equal(h.calls(), 1);
    });

    it('stops retrying once the run is abandoned', async () => {
      const h = harness(async () => {
        throw assumeErr();
      });
      let n = 0;
      await assert.rejects(
        h.rt.start(echo, {}, { runId: 'r', runEnv: {}, abandoned: () => ++n > 2 }),
        /abandoned/,
      );
      assert.equal(h.calls(), 3);
    });

    it('records only ECS own answer, never the command line (run token)', async () => {
      const h = harness(async () => {
        throw new Error('Command failed: aws ecs run-task --overrides FACTORY_RUN_TOKEN=tok-secret\n' + assumeErr().message.split('\n')[1]);
      });
      await assert.rejects(h.rt.start(echo, {}, { runId: 'r', runEnv: {} }), (e: Error) => {
        assert.match(e.message, /unable to assume the role/);
        assert.equal(e.message.includes('tok-secret'), false);
        return true;
      });
    });

    it('fails with a clear reason once the window is exhausted', async () => {
      const h = harness(async () => {
        throw assumeErr();
      });
      await assert.rejects(
        h.rt.start(echo, {}, { runId: 'r', runEnv: {} }),
        /could not assume the task role after 13 attempts over 60s.*unable to assume the role/s,
      );
      assert.equal(h.calls(), 13);
    });
  });
});
