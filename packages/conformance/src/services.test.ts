// DESIGN_AUTHORITY.md §6.15: SV1 (Intentional Services).
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { repoRoot } from './support.js';
import {
  FACTORY_SERVICE_NAMES,
  FACTORY_SERVICES,
  ALLOWED_PLATFORM_ROLES,
  RESERVED_PACKAGES,
  getPackageClassification,
} from '@beercanlabs/factory-contract';

export function assertPackagesAttributed(packageDirNames: string[]): void {
  for (const pkg of packageDirNames) {
    const classification = getPackageClassification(pkg);
    assert.ok(
      classification,
      `SV1 violation: Package '${pkg}' has no declared service or platform role in FACTORY_SERVICES / PLATFORM_TOOL_PACKAGES / RESERVED_PACKAGES.`
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

    if (classification.reservedFor) {
      assert.ok(
        FACTORY_SERVICE_NAMES.includes(classification.reservedFor),
        `SV1 violation: Package '${pkg}' reserves unrecognized service '${classification.reservedFor}'.`
      );
    }
  }
}

function isImplementationFile(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  if (/\.test\.(ts|tsx|js|mjs|cjs)$/.test(name)) return false;
  return /\.(ts|tsx|js|mjs|cjs)$/.test(name);
}

export function hasImplementationSource(packageDir: string): boolean {
  const src = join(packageDir, 'src');
  if (!existsSync(src)) return false;
  const walk = (abs: string): boolean => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(abs, name);
      if (statSync(p).isDirectory()) {
        if (walk(p)) return true;
      } else if (isImplementationFile(name)) {
        return true;
      }
    }
    return false;
  };
  return walk(src);
}

export function assertHostedImplementation(service: string, hostedPath: string, root: string): void {
  const fullPath = join(root, hostedPath);
  assert.ok(
    existsSync(join(fullPath, 'package.json')),
    `SV1 violation: hostedIn path '${hostedPath}' for service '${service}' is not a workspace package.`
  );
  assert.ok(
    hasImplementationSource(fullPath),
    `SV1 violation: hostedIn path '${hostedPath}' for service '${service}' has no implementation source.`
  );
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

  it('every hostedIn path is a workspace package with implementation source', () => {
    for (const service of FACTORY_SERVICE_NAMES) {
      const meta = FACTORY_SERVICES[service];
      assert.ok(meta, `missing metadata for service '${service}'`);
      assert.ok(meta.hostedIn.length > 0, `service '${service}' has no hostedIn packages`);

      for (const hostedPath of meta.hostedIn) {
        assertHostedImplementation(service, hostedPath, repoRoot);
        const pkgName = hostedPath.slice('packages/'.length);
        assert.equal(
          RESERVED_PACKAGES[pkgName],
          undefined,
          `SV1 violation: hostedIn path '${hostedPath}' for service '${service}' is a reservation, not a host.`
        );
      }
    }
  });

  it('SV1 reservations name a service, contain no implementation, and are not hosts', () => {
    for (const [pkg, service] of Object.entries(RESERVED_PACKAGES)) {
      assert.ok(
        FACTORY_SERVICE_NAMES.includes(service),
        `SV1 violation: reservation '${pkg}' names unrecognized service '${service}'.`
      );
      const fullPath = join(repoRoot, 'packages', pkg);
      assert.ok(
        existsSync(join(fullPath, 'package.json')),
        `SV1 violation: reservation '${pkg}' is not a workspace package.`
      );
      assert.equal(
        hasImplementationSource(fullPath),
        false,
        `SV1 violation: reservation '${pkg}' has implementation source; list it in hostedIn for '${service}' and drop the reservation.`
      );
      for (const meta of Object.values(FACTORY_SERVICES)) {
        assert.equal(
          meta.hostedIn.includes(`packages/${pkg}`),
          false,
          `SV1 violation: reservation '${pkg}' is also hostedIn for '${meta.name}'.`
        );
      }
    }
  });

  it('SV1 rejects a hostedIn directory that has no implementation source', () => {
    const root = mkdtempSync(join(tmpdir(), 'sv1-'));
    try {
      const pkg = join(root, 'packages', 'empty-host');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'package.json'), '{}\n');
      writeFileSync(join(pkg, 'README.md'), '# stub\n');
      assert.throws(
        () => assertHostedImplementation('treasurer', 'packages/empty-host', root),
        /has no implementation source/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
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
