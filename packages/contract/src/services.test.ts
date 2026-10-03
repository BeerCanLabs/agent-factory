import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import {
  FACTORY_SERVICE_NAMES,
  FACTORY_SERVICES,
  factoryServiceNameSchema,
} from './index.js';

const designAuthorityPath = fileURLToPath(new URL('../../../DESIGN_AUTHORITY.md', import.meta.url));

/** Bold names under the §6.15 cast heading, in document order. */
function castNames(): string[] {
  const doc = readFileSync(designAuthorityPath, 'utf8');
  const heading = '#### The 11 Factory Services (The Cast):';
  const start = doc.indexOf(heading);
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const rest = doc.slice(start + heading.length);
  const end = rest.search(/\n#### /);
  const section = end === -1 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^\d+\. \*\*([A-Za-z]+)/gm)].map((m) => m[1].toLowerCase());
}

describe('Factory Services (The Cast)', () => {
  it('SV1 names match the cast in DESIGN_AUTHORITY.md §6.15', () => {
    assert.deepEqual([...FACTORY_SERVICE_NAMES], castNames());
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
