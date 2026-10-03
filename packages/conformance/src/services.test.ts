// DESIGN_AUTHORITY.md §6.15: SV1 (Intentional Services).
import { describe, it } from 'node:test';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { repoRoot } from './support.js';
import {
  FACTORY_SERVICE_NAMES,
  FACTORY_SERVICES,
  ALLOWED_PLATFORM_ROLES,
  getPackageClassification,
} from '@beercanlabs/factory-contract';

/**
 * Validates that a list of package directory names are all intentionally attributed
 * to canonical services or declared platform tooling.
 */
export function assertPackagesAttributed(packageDirNames: string[]): void {
  for (const pkg of packageDirNames) {
    const classification = getPackageClassification(pkg);
    assert.ok(
      classification,
      `SV1 violation: Package '${pkg}' has no declared service or platform role in FACTORY_SERVICES / PLATFORM_TOOL_PACKAGES.`
    );

    if (classification.services) {
      assert.ok(
        classification.services.length > 0,
        `SV1 violation: Package '${pkg}' has empty services array.`
      );
      for (const service of classification.services) {
        assert.ok(
          FACTORY_SERVICE_NAMES.includes(service),
          `SV1 violation: Package '${pkg}' references unrecognized service '${service}'. Must be in FACTORY_SERVICE_NAMES.`
        );
      }
    }

    if (classification.platformRole) {
      assert.ok(
        ALLOWED_PLATFORM_ROLES.includes(classification.platformRole),
        `SV1 violation: Package '${pkg}' references invalid platformRole '${classification.platformRole}'.`
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

    assert.ok(packageDirs.length > 0, 'No workspace packages found');
    assertPackagesAttributed(packageDirs);
  });

  it('all hostedIn paths in FACTORY_SERVICES exist on disk', () => {
    for (const service of FACTORY_SERVICE_NAMES) {
      const meta = FACTORY_SERVICES[service];
      assert.ok(meta, `missing metadata for service '${service}'`);
      assert.ok(meta.hostedIn.length > 0, `service '${service}' has no hostedIn packages`);

      for (const hostedPath of meta.hostedIn) {
        const fullPath = join(repoRoot, hostedPath);
        assert.ok(
          existsSync(fullPath),
          `SV1 violation: hostedIn path '${hostedPath}' for service '${service}' does not exist on disk.`
        );
      }
    }
  });

  it('all 11 canonical services are hosted in the factory packages', () => {
    for (const service of FACTORY_SERVICE_NAMES) {
      const meta = FACTORY_SERVICES[service];
      assert.ok(meta.hostedIn.length > 0, `Canonical service '${service}' is not hosted by any package.`);
    }
  });

  it('negative test: rejects unassigned packages or stealth additions', () => {
    assert.throws(
      () => assertPackagesAttributed(['auth', 'unassigned-stealth-service']),
      /SV1 violation: Package 'unassigned-stealth-service' has no declared service/
    );
  });
});
