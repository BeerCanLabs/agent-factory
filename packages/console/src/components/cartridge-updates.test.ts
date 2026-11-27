import { it } from 'node:test';
import assert from 'node:assert/strict';
import { cartridgeUpdateBuckets, isConfigurationHostedAgent } from './cartridge-updates.js';

it('a configuration agent with stale SM-finley release fields is not offered a cartridge update', () => {
  const finley = {
    id: 'finley',
    name: 'Chuck',
    createdFrom: 'configuration' as const,
    installedVersion: '1.1.0',
    offeredVersion: '1.1.0',
    updateAvailable: false,
    releaseNotes: 'See BeerCanLabs/SM-finley/compare/v1.0.1...v1.1.0',
  };
  const donna = {
    id: 'donna',
    name: 'Donna',
    createdFrom: undefined,
    installedVersion: '1.0.0',
    offeredVersion: '1.2.0',
    updateAvailable: true,
    releaseNotes: 'SM-donna notes',
  };
  const archie = { id: 'archie', name: 'Archie', createdFrom: undefined, installedVersion: '2.0.0', updateAvailable: false };

  assert.equal(isConfigurationHostedAgent(finley), true);
  assert.equal(isConfigurationHostedAgent(donna), false);

  const buckets = cartridgeUpdateBuckets([finley, donna, archie]);
  assert.deepEqual(buckets.configurationHosted.map((a) => a.id), ['finley']);
  assert.deepEqual(buckets.updatesAvailable.map((a) => a.id), ['donna']);
  assert.deepEqual(buckets.upToDate.map((a) => a.id), ['archie']);
  assert.equal(buckets.updatesAvailable.some((a) => JSON.stringify(a).includes('SM-finley')), false);
  assert.equal(buckets.upToDate.some((a) => a.id === 'finley'), false);
});
