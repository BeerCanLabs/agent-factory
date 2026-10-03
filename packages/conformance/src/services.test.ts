// DESIGN_AUTHORITY.md §6.15: SV1 (Intentional Services) and SV2 (First-Class Cross-Service Contracts).
import { describe, it } from 'node:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { repoRoot } from './support.js';
import {
  FACTORY_SERVICE_NAMES,
  FACTORY_SERVICES,
  hydrationRequestSchema,
  preflightCheckRequestSchema,
  budgetCheckRequestSchema,
  heldActionRequestSchema,
  progressEventSchema,
  modelInferenceRequestSchema,
} from '@beercanlabs/factory-contract';

/**
 * Recognized attribution of packages/ directories to canonical services or infrastructure roles.
 */
const PACKAGE_ATTRIBUTION: Record<string, string> = {
  auth: 'gatekeeper',
  bench: 'registrar',
  budget: 'treasurer',
  conformance: 'meta-governance',
  console: 'client-ui',
  contract: 'contracts-schema',
  'control-plane': 'composite-host',
  'gatekeeper-egress': 'gatekeeper',
  'gatekeeper-ingress': 'gatekeeper',
  hydrate: 'secretary',
  keymaster: 'keymaster',
  ledger: 'auditor',
  'secrets-bind': 'keymaster',
  telemetry: 'seer',
  triage: 'seer',
};

describe('SV1 intentional services', () => {
  it('every package directory belongs to an intentional service or platform role', () => {
    const packagesDir = join(repoRoot, 'packages');
    const entries = readdirSync(packagesDir).filter((name) => {
      const p = join(packagesDir, name);
      return statSync(p).isDirectory() && !name.startsWith('.');
    });

    const unassigned = entries.filter((name) => !(name in PACKAGE_ATTRIBUTION));
    assert.deepEqual(
      unassigned,
      [],
      'SV1 violation: found unassigned package directory. Every capability must belong to a recognized service.'
    );
  });

  it('defines exactly the 11 canonical cast members in the service taxonomy', () => {
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

    for (const name of FACTORY_SERVICE_NAMES) {
      assert.ok(FACTORY_SERVICES[name], `missing metadata for service: ${name}`);
      assert.ok(FACTORY_SERVICES[name].title.length > 0);
      assert.ok(FACTORY_SERVICES[name].role.length > 0);
    }
  });
});

describe('SV2 first-class cross-service contracts', () => {
  it('enforces typed schemas across all cross-service boundaries', () => {
    // HydrationContract: Landlord <-> Secretary
    assert.ok(hydrationRequestSchema);
    assert.throws(() => hydrationRequestSchema.parse({}));

    // KeymasterContract: Landlord <-> Keymaster
    assert.ok(preflightCheckRequestSchema);
    assert.throws(() => preflightCheckRequestSchema.parse({}));

    // SpendMeteringContract: Tinman <-> Treasurer
    assert.ok(budgetCheckRequestSchema);
    assert.throws(() => budgetCheckRequestSchema.parse({}));

    // ActionHoldContract: Gatekeeper <-> Bouncer
    assert.ok(heldActionRequestSchema);
    assert.throws(() => heldActionRequestSchema.parse({}));

    // ProgressEventContract: Streaming <-> Seer
    assert.ok(progressEventSchema);
    assert.throws(() => progressEventSchema.parse({}));

    // ModelInferenceContract: Cartridge <-> Tinman
    assert.ok(modelInferenceRequestSchema);
    assert.throws(() => modelInferenceRequestSchema.parse({}));
  });

  it('rejects malformed cross-service contract payloads', () => {
    // Rejects non-URL memory store in Hydration
    assert.throws(() =>
      hydrationRequestSchema.parse({
        agentId: 'donna',
        runId: 'run-1',
        memoryStoreUri: 'not-a-valid-uri',
        localMemoryDir: '/tmp/mem',
        mode: 'pull',
      })
    );

    // Rejects invalid SHA-256 body hash in HeldAction
    assert.throws(() =>
      heldActionRequestSchema.parse({
        approvalId: 'appr-1',
        agentId: 'castle',
        runId: 'run-1',
        system: 'linkedin',
        method: 'POST',
        path: '/v2/ugcPosts',
        bodySha256: 'short-hash',
      })
    );
  });
});
