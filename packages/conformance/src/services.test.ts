// DESIGN_AUTHORITY.md §6.15: SV1 (Intentional Services).
import { describe, it } from 'node:test';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { repoRoot } from './support.js';
import {
  FACTORY_SERVICE_NAMES,
  type FactoryServiceName,
} from '@beercanlabs/factory-contract';

/**
 * Declared platform tooling and non-service infrastructure roles.
 */
export const ALLOWED_PLATFORM_ROLES = [
  'operator-ui',
  'conformance-suite',
  'diagnostic-tool',
] as const;

export type PlatformRole = (typeof ALLOWED_PLATFORM_ROLES)[number];

export interface PackageClassification {
  services?: readonly FactoryServiceName[];
  platformRole?: PlatformRole;
}

/**
 * Strict attribution of all workspace packages to canonical services or declared platform tooling.
 */
export const PACKAGE_CLASSIFICATION: Record<string, PackageClassification> = {
  auth: { services: ['keymaster'] },
  bench: { platformRole: 'diagnostic-tool' },
  budget: { services: ['treasurer'] },
  conformance: { platformRole: 'conformance-suite' },
  console: { platformRole: 'operator-ui' },
  contract: { services: ['registrar'] },
  'control-plane': {
    services: ['landlord', 'bouncer', 'timekeeper', 'registrar', 'treasurer'],
  },
  'gatekeeper-egress': {
    services: ['gatekeeper', 'tinman', 'bouncer', 'treasurer'],
  },
  'gatekeeper-ingress': { services: ['gatekeeper'] },
  hydrate: { services: ['secretary'] },
  keymaster: { services: ['keymaster'] },
  ledger: { services: ['auditor'] },
  'secrets-bind': { services: ['keymaster'] },
  telemetry: { services: ['seer'] },
  triage: { services: ['seer'] },
};

/**
 * Validates a classification record against canonical service taxonomy and platform rules.
 */
export function validatePackageClassification(
  pkgName: string,
  classification: PackageClassification,
  allowedServices: readonly string[] = FACTORY_SERVICE_NAMES
): void {
  const hasServices = classification.services && classification.services.length > 0;
  const hasPlatformRole = !!classification.platformRole;

  if (!hasServices && !hasPlatformRole) {
    throw new Error(
      `Package '${pkgName}' must declare at least one canonical service or an allowed platformRole.`
    );
  }

  if (classification.services) {
    for (const service of classification.services) {
      if (!allowedServices.includes(service)) {
        throw new Error(
          `Package '${pkgName}' assigns unrecognized service '${service}'. Must be in FACTORY_SERVICE_NAMES.`
        );
      }
    }
  }

  if (classification.platformRole) {
    if (!ALLOWED_PLATFORM_ROLES.includes(classification.platformRole)) {
      throw new Error(
        `Package '${pkgName}' declares invalid platformRole '${classification.platformRole}'.`
      );
    }
  }
}

describe('SV1 intentional services (§6.15)', () => {
  it('every workspace package belongs to an intentional service or declared platform tooling', () => {
    const packagesDir = join(repoRoot, 'packages');
    // Discover workspace packages by presence of package.json
    const packageDirs = readdirSync(packagesDir).filter((name) => {
      const pkgJson = join(packagesDir, name, 'package.json');
      return existsSync(pkgJson);
    });

    for (const pkg of packageDirs) {
      const classification = PACKAGE_CLASSIFICATION[pkg];
      assert.ok(
        classification,
        `SV1 violation: Package '${pkg}' has no declared service or platform role in PACKAGE_CLASSIFICATION.`
      );
      validatePackageClassification(pkg, classification);
    }
  });

  it('all 11 canonical services are hosted in the factory packages', () => {
    const coveredServices = new Set<string>();

    for (const [, classification] of Object.entries(PACKAGE_CLASSIFICATION)) {
      if (classification.services) {
        for (const s of classification.services) {
          coveredServices.add(s);
        }
      }
    }

    for (const service of FACTORY_SERVICE_NAMES) {
      assert.ok(
        coveredServices.has(service),
        `SV1 violation: Canonical service '${service}' is not hosted by any package.`
      );
    }
  });

  it('negative test: rejects unassigned packages or invalid service names', () => {
    // 1. Unrecognized service name
    assert.throws(
      () =>
        validatePackageClassification('fake-pkg', {
          services: ['unrecognized_service' as any],
        }),
      /unrecognized service 'unrecognized_service'/
    );

    // 2. Empty classification
    assert.throws(
      () => validatePackageClassification('fake-pkg', {}),
      /must declare at least one canonical service/
    );

    // 3. Invalid platform role
    assert.throws(
      () =>
        validatePackageClassification('fake-pkg', {
          platformRole: 'made-up-role' as any,
        }),
      /invalid platformRole 'made-up-role'/
    );
  });
});
