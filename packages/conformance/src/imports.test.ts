// DESIGN_AUTHORITY.md §6.15 (Cast extraction decisions D1-C, D3 a and b), SV1, GAP-085: a package is used through its entry point.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { files, read, repoRoot } from './support.js';

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
const PACKAGE_PREFIX = '@beercanlabs/factory-';

/** Every module specifier a source file names. */
const specifiers = (src: string) => [...src.matchAll(SPECIFIER)].map((m) => m[1]);

/** The package a repo-relative path sits in (`packages/<name>/...`), or undefined outside `packages/`. */
const packageOf = (rel: string) => /^packages\/([^/]+)\//.exec(rel)?.[1];

/** A relative specifier that lands in another package's folder. `from` is the importing file, repo-relative. */
export function crossPackageRelative(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const target = relative(repoRoot, resolve(repoRoot, dirname(from), spec)).split('\\').join('/');
  const owner = packageOf(from);
  const landed = packageOf(`${target}/`);
  return landed !== undefined && landed !== owner ? target : undefined;
}

/** The `exports` keys of a package, or undefined when the package has no map. */
type Exports = Record<string, unknown> | undefined;

/** Is `@beercanlabs/factory-x/<sub>` a subpath the package lists? `./aws/*` style patterns match one or more segments. */
export function subpathListed(exports: Exports, sub: string): boolean {
  if (!exports) return false;
  const want = `./${sub}`;
  return Object.keys(exports).some((key) => {
    if (!key.includes('*')) return key === want;
    const [head, tail] = key.split('*');
    return want.length > head.length + tail.length && want.startsWith(head) && want.endsWith(tail);
  });
}

/** A package specifier with a subpath (`@beercanlabs/factory-budget/dist/spend.js`), split into package folder and subpath. */
export function packageSubpath(spec: string): { pkg: string; sub: string } | undefined {
  if (!spec.startsWith(PACKAGE_PREFIX)) return undefined;
  const rest = spec.slice(PACKAGE_PREFIX.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? undefined : { pkg: rest.slice(0, slash), sub: rest.slice(slash + 1) };
}

const exportsOf = (pkg: string): Exports => {
  const manifest = join('packages', pkg, 'package.json');
  return existsSync(join(repoRoot, manifest)) ? JSON.parse(read(manifest)).exports : undefined;
};

/** This file's own sample lines would match its patterns. */
const sources = () => files('packages', (p) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(p) && p !== 'packages/conformance/src/imports.test.ts');

describe('Imports: a package is used through its entry point', () => {
  it('the patterns recognize what they exist to forbid, and allow what they must', () => {
    assert.deepEqual(specifiers(`import { a } from '../../budget/src/spend.js';\nconst b = await import("@beercanlabs/factory-budget");`), ['../../budget/src/spend.js', '@beercanlabs/factory-budget']);
    assert.equal(crossPackageRelative('packages/control-plane/src/app.ts', '../../budget/src/spend.js'), 'packages/budget/src/spend.js');
    assert.equal(crossPackageRelative('packages/control-plane/src/aws/ecs.ts', '../../../budget/dist/index.js'), 'packages/budget/dist/index.js');
    assert.equal(crossPackageRelative('packages/control-plane/src/app.ts', './runs.js'), undefined, 'inside the same package');
    assert.equal(crossPackageRelative('packages/control-plane/src/aws/ecs.ts', '../runs.js'), undefined, 'inside the same package');
    assert.equal(crossPackageRelative('packages/control-plane/src/app.ts', '@beercanlabs/factory-budget'), undefined, 'not a relative path');
    assert.deepEqual(packageSubpath('@beercanlabs/factory-budget/dist/spend.js'), { pkg: 'budget', sub: 'dist/spend.js' });
    assert.equal(packageSubpath('@beercanlabs/factory-budget'), undefined);
    assert.equal(packageSubpath('node:fs'), undefined);
    const map = { '.': {}, './runtime': {}, './aws/*': {} };
    assert.equal(subpathListed(map, 'runtime'), true);
    assert.equal(subpathListed(map, 'aws/ecs'), true);
    assert.equal(subpathListed(map, 'aws/'), false);
    assert.equal(subpathListed(map, 'dist/spend.js'), false);
    assert.equal(subpathListed(undefined, 'runtime'), false);
  });

  it('no source file reaches into another package by a relative path', () => {
    const found = sources().flatMap((f) =>
      specifiers(read(f)).flatMap((s) => {
        const target = crossPackageRelative(f, s);
        return target ? [`${f}: '${s}' lands in ${target}`] : [];
      }),
    );
    assert.deepEqual(found, [], "import the package by name, from its entry point: '@beercanlabs/factory-<name>'");
  });

  it("every '@beercanlabs/factory-*/subpath' import is a subpath the package exports", () => {
    const found = sources().flatMap((f) =>
      specifiers(read(f)).flatMap((s) => {
        const parts = packageSubpath(s);
        return parts && !subpathListed(exportsOf(parts.pkg), parts.sub) ? [`${f}: '${s}' is not in the exports of packages/${parts.pkg}`] : [];
      }),
    );
    assert.deepEqual(found, [], 'export the symbol from the package root instead of importing its internals (D1-C)');
  });

  it('every package another package imports lists its entry point and no deep path (exports map)', () => {
    const imported = new Set(
      sources().flatMap((f) =>
        specifiers(read(f)).flatMap((s) => {
          const name = s.startsWith(PACKAGE_PREFIX) ? s.slice(PACKAGE_PREFIX.length).split('/')[0] : undefined;
          return name && name !== packageOf(f) ? [name] : [];
        }),
      ),
    );
    const open = [...imported].filter((name) => {
      const map = exportsOf(name);
      return !map || !Object.keys(map).includes('.');
    });
    assert.deepEqual(open, [], 'give these packages an "exports" map with "." (types and default pointing at dist/index)');
    const deep = [...imported].flatMap((name) => Object.keys(exportsOf(name) ?? {}).filter((k) => /\/dist\/|\/src\//.test(k) || k.endsWith('.js')).map((k) => `${name}: ${k}`));
    assert.deepEqual(deep, [], 'an exports key must name a contract, not a file inside dist or src');
  });
});
