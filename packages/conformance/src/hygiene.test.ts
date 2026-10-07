// DESIGN_AUTHORITY.md §6.3.2 (S1), §6.7 (enforcement), and cross-package contracts that have drifted before.
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { baseline, expectOnlyBaselined, files, read, registeredGaps, repoRoot } from './support.js';

describe('S1 agents never hold real secrets', () => {
  it('agent task definitions do not inject secret values', () => {
    const found = files('packages', (p) => /\/src\/.*\.ts$/.test(p) && !p.endsWith('.test.ts'))
      .filter((f) => /valueFrom/.test(read(f)) && /containerDefinitions|registerTaskDefinition|RegisterTaskDefinition/.test(read(f)))
      .map((f) => ({ rule: 'S1', where: f, detail: 'valueFrom' }));
    expectOnlyBaselined('S1', found);
  });
});

describe('§6.7 enforcement', () => {
  it('no test is skipped', () => {
    const skipped = files('packages', (p) => /\.test\.ts$/.test(p))
      .flatMap((f) => [...read(f).matchAll(/^.*\b(describe|it|test)\.(skip|todo)\(.*$/gm)].map((m) => `${f}: ${m[0].trim()}`));
    assert.deepEqual(skipped, [], 'skipped tests hide regressions; fix them or delete them');
  });

  it('every test file runs: each package test script names it or a glob that matches it', () => {
    const unrun: string[] = [];
    for (const pkgJson of files('packages', (p) => /^packages\/[^/]+\/package\.json$/.test(p))) {
      const dir = pkgJson.slice(0, -'/package.json'.length);
      const script = String((JSON.parse(read(pkgJson)) as { scripts?: Record<string, string> }).scripts?.test ?? '');
      const globs = script.split(/\s+/).filter((t) => t.includes('*')).map((g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`));
      for (const f of files(dir, (p) => /\/src\/.*\.test\.tsx?$/.test(p))) {
        const rel = f.slice(dir.length + 1);
        if (!script.split(/\s+/).includes(rel) && !globs.some((g) => g.test(rel))) unrun.push(f);
      }
    }
    assert.deepEqual(unrun, [], 'test files no package test script runs (CI passes without them)');
  });

  it('every baseline entry is owned by a registered gap', () => {
    const gaps = registeredGaps();
    for (const b of baseline) assert.ok(gaps.has(b.gap), `${b.rule} ${b.where}: ${b.gap} is not in the Gap Register`);
  });

  it('intent, its checks and AI instructions have a code owner (GAP-074)', () => {
    const owned = new Set(
      read('.github/CODEOWNERS')
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
        .filter((f) => f[0] && !f[0].startsWith('#') && f.length > 1 && f.slice(1).every((o) => o.startsWith('@')))
        .map((f) => f[0]),
    );
    const required = [
      '/DESIGN_AUTHORITY.md', '/CLAUDE.md', '/GEMINI.md', '/AGENTS.md', '/packages/conformance/', '/.github/', '/.githooks/',
      '/.claude/', '/scripts/conformance.sh', '/scripts/conformance-hook.sh', '/scripts/secret-scan.sh',
    ];
    assert.deepEqual(required.filter((p) => !owned.has(p)), [], 'paths without a code owner in .github/CODEOWNERS');
  });

  it('every LOCKED task names its owner and scope', () => {
    const rows = read('DESIGN_AUTHORITY.md').split('\n').filter((l) => /^\| \*\*TSK-\d+\*\*/.test(l) && /`LOCKED`/.test(l));
    for (const row of rows) {
      const cells = row.split('|').map((c) => c.trim());
      assert.ok(cells[5] && !/None/.test(cells[5]), `locked task without owner: ${cells[1]}`);
      assert.ok(cells[6], `locked task without scope: ${cells[1]}`);
    }
  });

  it('every gap a task references is registered', () => {
    const gaps = registeredGaps();
    const referenced = [...read('DESIGN_AUTHORITY.md').matchAll(/^\| \*\*TSK-\d+\*\* \| ([^|]+)\|/gm)].flatMap((m) => m[1].match(/GAP-\d+/g) ?? []);
    assert.deepEqual([...new Set(referenced)].filter((g) => !gaps.has(g)), []);
  });
});

describe('console mirrors control-plane contracts', () => {
  const union = (src: string, anchor: RegExp) => {
    const block = src.match(anchor)?.[0] ?? '';
    return new Set([...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
  };
  it('the console knows every agent state the control plane sets', () => {
    const cp = union(read('packages/registrar/src/catalog.ts'), /\n\s+state:\s*\n([\s\S]*?);/);
    const console_ = union(read('packages/console/src/api/types.ts'), /export type AgentState =[\s\S]*?;/);
    assert.ok(cp.size > 5, 'could not read control-plane states');
    assert.deepEqual([...cp].filter((s) => !console_.has(s)), []);
  });
});

describe('K1 no hard-coded credentials (GAP-045)', () => {
  it('the platform repo contains no credential values (scripts/secret-scan.sh)', () => {
    const r = spawnSync('bash', [join(repoRoot, 'scripts/secret-scan.sh'), repoRoot], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
