import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dockerDeployProvider,
  dockerRuntime,
  dockerApi,
  parseImageMap,
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
});
