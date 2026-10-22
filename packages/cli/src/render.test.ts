import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cell, keyValues, render, table } from './render.js';

describe('§6.17 CL11 showing what the factory returned', () => {
  it('CL11 a list of things is a table with the useful columns first', () => {
    const out = render([
      { id: 'donna', state: 'SLEEPING', name: 'Donna', blob: { a: 1 }, secretish: 1 },
      { id: 'rosie', state: 'WORKING', name: 'Rosie' },
    ]);
    const [head, ...rest] = out.split('\n');
    const rows = rest.filter((l) => !l.startsWith('('));
    assert.match(head, /^ID\s+NAME\s+STATE/);
    assert.equal(rows.length, 2);
    assert.match(rest.at(-1) ?? '', /^\(1 more column not shown; --json has everything\)$/, 'the nested value is not a column, and it says so');
    assert.match(rows[0], /^donna\s+Donna\s+SLEEPING/);
  });

  it('CL11 a thing is key-value lines, and a wrapped list is shown as the list', () => {
    assert.match(render({ totalUsd: 12.5, window: 'month' }), /totalUsd\s+12\.5\nwindow\s+month/);
    assert.match(render({ replies: [{ id: 1, content: 'x' }] }), /^ID\s+CONTENT/);
    assert.equal(render([]), '(none)');
    assert.equal(render('plain'), 'plain');
    assert.equal(render(null), '');
  });

  it('CL11 long lists and long cells are cut, and it says so', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, text: 'x'.repeat(200) }));
    const out = table(rows);
    assert.match(out, /… 60 more/);
    assert.ok(out.split('\n').every((l) => l.length < 120));
    assert.equal(cell('y'.repeat(100)).length, 48);
  });

  it('CL6 control characters from the factory never reach the terminal', () => {
    const evil = 'ok\x1b[2J\x1b[8m hidden\x07';
    for (const out of [render([{ id: evil }]), render({ [evil]: evil }), render(evil), keyValues({ a: { b: evil } })]) {
      assert.doesNotMatch(out, /[\x00-\x08\x0b-\x1f\x7f]/, JSON.stringify(out));
    }
  });

  it('CL6 a key or a value cannot add a line or reorder text with bidirectional characters', () => {
    const out = keyValues({ 'id  x\nFAKE_ROW': 1 });
    assert.equal(out.split('\n').length, 1, out);
    assert.doesNotMatch(table([{ id: 'donna\u202egnp.exe\u202c' }]), /\u202e/);
  });

  it('CL11 says when columns were left out, so a missing figure is not mistaken for none', () => {
    const wide = [{ id: 'a', c1: 1, c2: 2, c3: 3, c4: 4, c5: 5, c6: 6, c7: 7, c8: 8, nested: { x: 1 } }];
    const out = table(wide);
    assert.match(out, /\(\d+ more columns? not shown; --json has everything\)/);
  });
});
