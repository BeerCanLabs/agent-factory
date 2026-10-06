// DESIGN_AUTHORITY.md §6.15: SV1 (Intentional Services).
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import assert from 'node:assert/strict';
import { repoRoot } from './support.js';
import {
  FACTORY_SERVICE_NAMES,
  FACTORY_SERVICES,
  ALLOWED_PLATFORM_ROLES,
  RESERVED_PACKAGES,
  SHARED_PACKAGES,
  SPLIT_FILES,
  COMPOSITION_ROOT_FILES,
  PLATFORM_FILES,
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

type FileMap = {
  members: Record<string, readonly string[]>;
  hostedIn: Record<string, readonly string[]>;
  split: readonly string[];
  roots: readonly string[];
  platform: readonly string[];
  shared: readonly string[];
};

function sourceFiles(root: string, pkg: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (isImplementationFile(name)) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  const src = join(root, pkg, 'src');
  if (existsSync(src)) walk(src);
  return out;
}

/** Returns every way the file-to-member map disagrees with the source tree (empty when it agrees). */
export function fileMapViolations(root: string, map: FileMap): string[] {
  const problems: string[] = [];
  const claims = new Map<string, string[]>();
  const claim = (file: string, who: string) => claims.set(file, [...(claims.get(file) ?? []), who]);
  for (const [member, files] of Object.entries(map.members)) for (const f of files) claim(f, member);
  for (const f of map.roots) claim(f, 'composition root');
  for (const f of map.platform) claim(f, 'platform');

  for (const [file, who] of claims) {
    if (!existsSync(join(root, file))) problems.push(`'${file}' is claimed by ${who.join(', ')} but does not exist.`);
    if (who.length > 1 && !map.split.includes(file)) {
      problems.push(`'${file}' is claimed by ${who.join(', ')} but is not marked split.`);
    }
  }
  for (const file of map.split) {
    if ((claims.get(file)?.length ?? 0) < 2) problems.push(`'${file}' is marked split but is claimed by fewer than two owners.`);
  }
  for (const pkg of map.shared) {
    for (const file of sourceFiles(root, pkg)) {
      if (!claims.has(file)) problems.push(`'${file}' in shared package '${pkg}' is owned by no member.`);
    }
  }
  for (const [member, files] of Object.entries(map.members)) {
    for (const f of files) {
      const pkg = map.shared.find((p) => f.startsWith(`${p}/`));
      if (pkg && !map.hostedIn[member]?.includes(pkg)) {
        problems.push(`'${member}' owns '${f}' but does not list '${pkg}' in hostedIn.`);
      }
    }
  }
  for (const [member, hosted] of Object.entries(map.hostedIn)) {
    for (const pkg of hosted.filter((h) => map.shared.includes(h))) {
      if (!(map.members[member] ?? []).some((f) => f.startsWith(`${pkg}/`))) {
        problems.push(`'${member}' lists '${pkg}' in hostedIn but owns no file there.`);
      }
    }
  }
  return problems;
}

function repoFileMap(): FileMap {
  return {
    members: Object.fromEntries(FACTORY_SERVICE_NAMES.map((n) => [n, FACTORY_SERVICES[n].owns ?? []])),
    hostedIn: Object.fromEntries(FACTORY_SERVICE_NAMES.map((n) => [n, FACTORY_SERVICES[n].hostedIn])),
    split: SPLIT_FILES,
    roots: COMPOSITION_ROOT_FILES,
    platform: Object.keys(PLATFORM_FILES),
    shared: SHARED_PACKAGES,
  };
}

describe('SV1 file-to-member map (§6.15, TSK-093)', () => {
  it('every source file in a shared package has one owner or an explicit split, and hosts agree', () => {
    assert.deepEqual(fileMapViolations(repoRoot, repoFileMap()), []);
  });

  it('rejects an unowned file, an unmarked double claim, a missing file, an empty split, and a host the map contradicts either way', () => {
    const root = mkdtempSync(join(tmpdir(), 'sv1-map-'));
    try {
      const src = join(root, 'packages', 'shared', 'src');
      mkdirSync(src, { recursive: true });
      for (const f of ['a.ts', 'b.ts', 'orphan.ts']) writeFileSync(join(src, f), 'export {};\n');
      writeFileSync(join(src, 'a.test.ts'), 'export {};\n');
      const base: FileMap = {
        members: { one: ['packages/shared/src/a.ts', 'packages/shared/src/b.ts'] },
        hostedIn: { one: ['packages/shared'] },
        split: [],
        roots: [],
        platform: [],
        shared: ['packages/shared'],
      };
      const bad = (m: Partial<FileMap>) => fileMapViolations(root, { ...base, ...m });

      assert.deepEqual(bad({}), ["'packages/shared/src/orphan.ts' in shared package 'packages/shared' is owned by no member."]);
      assert.match(bad({ members: { ...base.members, two: ['packages/shared/src/a.ts'] }, hostedIn: { ...base.hostedIn, two: ['packages/shared'] } }).join('\n'), /claimed by one, two but is not marked split/);
      assert.match(bad({ members: { one: ['packages/shared/src/gone.ts'] } }).join('\n'), /does not exist/);
      assert.match(bad({ split: ['packages/shared/src/a.ts'] }).join('\n'), /marked split but is claimed by fewer than two/);
      assert.match(bad({ hostedIn: { one: [] } }).join('\n'), /does not list 'packages\/shared' in hostedIn/);
      assert.match(bad({ members: { one: [], two: ['packages/shared/src/a.ts', 'packages/shared/src/b.ts'] }, hostedIn: { one: ['packages/shared'], two: ['packages/shared'] } }).join('\n'), /'one' lists 'packages\/shared' in hostedIn but owns no file there/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
