// DESIGN_AUTHORITY.md §6.7: every invariant names its tests, honestly. The coverage table says which invariants are
// checked, partly checked, or unchecked; this file holds the table to the document and to the test suite.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { read, registeredGaps, repoRoot } from './support.js';

const doc = read('DESIGN_AUTHORITY.md');
const intent = doc.slice(doc.indexOf('## 6. Declared Architectural Intent'), doc.indexOf('## 7.'));

/** Invariant IDs declared in §6 as `* **ID – Title.**`. */
const declared = [...intent.matchAll(/^\* \*\*([A-Z]{1,2}\d+) – /gm)].map((m) => m[1]);

type Row = { id: string; status: string; tests: string[]; gap: string };
const table = intent.slice(intent.indexOf('#### Invariant coverage'));
const rows: Row[] = [...table.matchAll(/^\| ([A-Z]{1,2}\d+) \| `([a-z]+)` \| ([^|]*) \|[^|]*\| ([^|]*) \|$/gm)].map((m) => ({
  id: m[1],
  status: m[2],
  tests: [...m[3].matchAll(/`([^`]+)`/g)].map((t) => t[1]),
  gap: m[4].trim(),
}));

const cites = (file: string, id: string) =>
  new RegExp(`\\b(?:describe|it)\\(\\s*['"\`][^'"\`]*\\b${id}\\b`).test(read(file));

describe('§6.7 invariant coverage', () => {
  it('the document declares invariants and a coverage table', () => {
    assert.ok(declared.length >= 20, `found only ${declared.length} invariants in §6`);
    assert.ok(rows.length > 0, 'no coverage table rows in §6.7');
  });

  it('every invariant has exactly one row, and every row is a declared invariant', () => {
    const ids = rows.map((r) => r.id);
    assert.deepEqual(declared.filter((d) => !ids.includes(d)), [], 'invariants with no coverage row');
    assert.deepEqual(ids.filter((i) => !declared.includes(i)), [], 'coverage rows for undeclared invariants');
    assert.deepEqual(ids.filter((i, n) => ids.indexOf(i) !== n), [], 'duplicate coverage rows');
  });

  it('statuses are honest: checked and partial rows name real tests that cite the invariant', () => {
    const bad: string[] = [];
    for (const r of rows) {
      if (!['checked', 'partial', 'unchecked'].includes(r.status)) bad.push(`${r.id}: unknown status ${r.status}`);
      if (r.status === 'unchecked') {
        if (r.tests.length) bad.push(`${r.id}: unchecked but lists tests`);
        continue;
      }
      if (!r.tests.length) bad.push(`${r.id}: ${r.status} without tests`);
      for (const t of r.tests) {
        if (!existsSync(join(repoRoot, t))) bad.push(`${r.id}: ${t} does not exist`);
        else if (!cites(t, r.id)) bad.push(`${r.id}: ${t} has no describe/it title citing ${r.id}`);
      }
    }
    assert.deepEqual(bad, []);
  });

  it('every row that is not fully checked names a registered gap', () => {
    const gaps = registeredGaps();
    const bad = rows
      .filter((r) => r.status !== 'checked')
      .filter((r) => !/^GAP-\d+$/.test(r.gap) || !gaps.has(r.gap))
      .map((r) => `${r.id}: ${r.gap || 'no gap'}`);
    assert.deepEqual(bad, []);
  });
});
