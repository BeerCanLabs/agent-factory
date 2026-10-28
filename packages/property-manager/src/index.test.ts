import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRecord } from '@beercanlabs/factory-registrar';
import {
  dockerDeployProvider,
  dockerRuntime,
  dockerApi,
  parseImageMap,
  type DockerApi,
} from './index.js';

describe('Property Manager index and dockerDeployProvider', () => {
  it('exports docker utilities from index', () => {
    assert.equal(typeof dockerDeployProvider, 'function');
    assert.equal(typeof dockerRuntime, 'function');
    assert.equal(typeof dockerApi, 'function');
    assert.equal(typeof parseImageMap, 'function');
  });

  it('dockerDeployProvider builds images, provisions identities, and registers compute', async () => {
    const images: Record<string, string> = { 'known-agent': 'custom-image:1' };
    const provider = dockerDeployProvider(images);

    // buildImage
    assert.equal(await provider.buildImage('known-agent'), 'custom-image:1');
    assert.equal(await provider.buildImage('new-agent'), 'factory-agent-new-agent:dev');

    // buildSkillsImage
    assert.equal(await provider.buildSkillsImage('new-agent', { image: 'base-img:v1' }), 'base-img:v1');

    // provisionIdentity
    assert.deepEqual(await provider.provisionIdentity('new-agent'), { identity: 'docker:new-agent' });

    // registerCompute mutates images map
    await provider.registerCompute('new-agent', 'updated-image:v2');
    assert.equal(images['new-agent'], 'updated-image:v2');
    assert.equal(await provider.buildImage('new-agent'), 'updated-image:v2');
  });

  it('dockerRuntime.start falls back to sha256:<digest> when repo@sha256:<digest> returns 404', async () => {
    const digest = 'a'.repeat(64);
    const repoWithDigest = `factory-agent-runtime@sha256:${digest}`;
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    const api: DockerApi = async (method, path, body: any) => {
      calls.push({ method, path, body });
      if (path.startsWith('/containers/create')) {
        if (body?.Image === repoWithDigest) {
          return { status: 404, body: { message: 'No such image' } };
        }
        return { status: 201, body: { Id: 'fallback-c123' } };
      }
      if (path.endsWith('/start')) return { status: 204, body: {} };
      return { status: 200, body: {} };
    };

    const rt = dockerRuntime({
      api,
      images: { 'test-agent': repoWithDigest },
      network: 'test-net',
    });

    const agent: AgentRecord = {
      id: 'test-agent',
      name: 'Test',
      role: 'agent',
      state: 'IDLE',
      provider: 'local',
      artifact: '',
      requires: [],
      triggers: [],
      memoryPrefix: 'test-agent',
      dir: '/tmp',
    };

    const { handle } = await rt.start(agent, {}, { runId: 'run-fallback', runEnv: {} });
    assert.equal(handle, 'docker:fallback-c123');

    const createCalls = calls.filter((c) => c.path.startsWith('/containers/create'));
    assert.equal(createCalls.length, 2);
    assert.equal(createCalls[0].body.Image, repoWithDigest);
    assert.equal(createCalls[1].body.Image, `sha256:${digest}`);
  });
});

