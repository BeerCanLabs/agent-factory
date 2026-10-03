import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACTORY_SERVICE_NAMES,
  FACTORY_SERVICES,
  factoryServiceNameSchema,
} from './index.js';

describe('Factory Services (The Cast)', () => {
  it('defines exactly the 11 canonical services from DESIGN_AUTHORITY.md §6.15', () => {
    assert.equal(FACTORY_SERVICE_NAMES.length, 11);
    const expected = [
      'gatekeeper',
      'keymaster',
      'tinman',
      'secretary',
      'landlord',
      'auditor',
      'treasurer',
      'bouncer',
      'timekeeper',
      'registrar',
      'seer',
    ];
    assert.deepEqual([...FACTORY_SERVICE_NAMES].sort(), expected.sort());
  });

  it('validates service names via schema', () => {
    for (const name of FACTORY_SERVICE_NAMES) {
      assert.equal(factoryServiceNameSchema.parse(name), name);
    }
    assert.throws(() => factoryServiceNameSchema.parse('unregistered_service'));
  });

  it('provides metadata for every service', () => {
    for (const name of FACTORY_SERVICE_NAMES) {
      const meta = FACTORY_SERVICES[name];
      assert.ok(meta, `missing metadata for ${name}`);
      assert.equal(meta.name, name);
      assert.ok(meta.title.length > 0);
      assert.ok(meta.role.length > 0);
      assert.ok(Array.isArray(meta.hostedIn));
      assert.ok(meta.hostedIn.length > 0);
      for (const pkg of meta.hostedIn) {
        assert.ok(pkg.startsWith('packages/'), `hostedIn path must start with packages/: ${pkg}`);
      }
    }
  });
});
