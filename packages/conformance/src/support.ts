import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

/** Repo files under `dir` matching `test`, skipping dependencies and build output. */
export function files(dir: string, test: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (name === 'node_modules' || name === 'dist' || name === '.terraform' || name.startsWith('.')) continue;
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (test(relative(repoRoot, p))) out.push(relative(repoRoot, p));
    }
  };
  walk(join(repoRoot, dir));
  return out;
}

export type Violation = { rule: string; where: string; detail: string };
type BaselineEntry = Violation & { gap: string; why: string };

export const baseline: BaselineEntry[] = JSON.parse(readFileSync(new URL('../baseline.json', import.meta.url), 'utf8'));

/** Gap IDs registered in DESIGN_AUTHORITY.md §4. */
export function registeredGaps(): Set<string> {
  return new Set([...read('DESIGN_AUTHORITY.md').matchAll(/^\| \*\*(GAP-\d+)\*\* \|/gm)].map((m) => m[1]));
}

const key = (v: Violation) => `${v.rule} | ${v.where} | ${v.detail}`;

/**
 * Compare what a check found against the baseline for its rule. New violations fail; so do baseline entries
 * that no longer occur (the gap was fixed — delete the entry so it cannot silently come back).
 */
export function expectOnlyBaselined(rule: string, found: Violation[]) {
  const known = new Set(baseline.filter((b) => b.rule === rule).map(key));
  const seen = new Set(found.map(key));
  const unexpected = [...seen].filter((k) => !known.has(k));
  const stale = [...known].filter((k) => !seen.has(k));
  assert.deepEqual(unexpected, [], `${rule}: new violation(s) of DESIGN_AUTHORITY.md. Fix them, or register a gap and add them to packages/conformance/baseline.json`);
  assert.deepEqual(stale, [], `${rule}: baseline entries no longer violated. Remove them from packages/conformance/baseline.json`);
}
