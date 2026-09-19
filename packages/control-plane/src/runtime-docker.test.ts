import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dockerRuntime, parseImageMap, type DockerApi } from './runtime-docker.js';
import type { AgentRecord } from './catalog.js';

const agent: AgentRecord = { id: 'echo-agent', name: 'Echo', role: 'r', state: 'IDLE', provider: 'local', artifact: '', requires: [], triggers: [], memoryPrefix: 'echo-agent', dir: '/tmp' };

function fakeApi() {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let running = true;
  const api: DockerApi = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith('/containers/create')) return { status: 201, body: { Id: 'c123' } };
    if (path.endsWith('/start')) return { status: 204, body: {} };
    if (path.endsWith('/json')) return { status: 200, body: { State: running ? { Running: true } : { Running: false, ExitCode: 4 } } };
    return { status: 204, body: {} };
  };
  return { api, calls, exit: () => (running = false) };
}

describe('dockerRuntime', () => {
  it('creates a hardened container on the internal network with only its own mind mounted', async () => {
    const { api, calls } = fakeApi();
    const made: string[] = [];
    const rt = dockerRuntime({ api, images: { 'echo-agent': 'factory-runtime:dev' }, network: 'factory-agents', mindVolume: 'factory-mind', ensureMindPath: (p) => made.push(p) });
    const { handle } = await rt.start(agent, { SECRET: 's' }, { runId: 'r1', runEnv: { FACTORY_RUN_ID: 'r1' } });
    assert.equal(handle, 'docker:c123');
    const create = calls[0].body;
    assert.equal(create.Image, 'factory-runtime:dev');
    assert.equal(create.HostConfig.NetworkMode, 'factory-agents');
    assert.equal(create.HostConfig.Privileged, false);
    assert.equal(create.HostConfig.ReadonlyRootfs, true);
    assert.deepEqual(create.HostConfig.CapDrop, ['ALL']);
    assert.deepEqual(create.HostConfig.Mounts, [{ Type: 'volume', Source: 'factory-mind', Target: '/store/echo-agent', VolumeOptions: { Subpath: 'echo-agent' } }]);
    assert.ok(create.Env.includes('FACTORY_RUN_ID=r1'));
    assert.ok(create.Env.includes('MEMORY_STORE_DIR=/store'));
    assert.deepEqual(made, ['echo-agent']);
  });

  it('reports exit codes, removes finished containers, and refuses unmapped agents', async () => {
    const { api, calls, exit } = fakeApi();
    const rt = dockerRuntime({ api, images: { 'echo-agent': 'img' }, network: 'n' });
    await rt.start(agent, {}, { runId: 'r2', runEnv: {} });
    assert.deepEqual(await rt.status!('docker:c123'), { state: 'running' });
    exit();
    const s = await rt.status!('docker:c123');
    assert.equal(s.state, 'stopped');
    if (s.state === 'stopped') assert.equal(s.exitCode, 4);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/containers/c123')));
    await assert.rejects(rt.start({ ...agent, id: 'other' }, {}, { runId: 'r3', runEnv: {} }), /no image mapped/);
  });

  it('parses agent=image maps', () => {
    assert.deepEqual(parseImageMap('echo-agent=factory-runtime:dev, llm-summarizer=registry/x:1'), { 'echo-agent': 'factory-runtime:dev', 'llm-summarizer': 'registry/x:1' });
  });
});
