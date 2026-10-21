import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PLAIN, styleFor } from './theme.js';
import { parseManager, parseTheme } from './config.js';
import { splash } from './splash.js';

describe('§6.17 CL8 terminal preferences', () => {
  it('CL8 colour only on a terminal, never for mono or NO_COLOR', () => {
    assert.equal(styleFor('dark', { isTTY: false, env: {} }), PLAIN);
    assert.equal(styleFor('mono', { isTTY: true, env: {} }), PLAIN);
    assert.equal(styleFor('dark', { isTTY: true, env: { NO_COLOR: '1' } }), PLAIN);
    assert.notEqual(styleFor('auto', { isTTY: true, env: {} }), PLAIN);
  });

  it('CL8 dark and light use different accents, and plain text is the same words without escapes', () => {
    const dark = styleFor('dark', { isTTY: true, env: {} });
    const light = styleFor('light', { isTTY: true, env: {} });
    assert.notEqual(dark.accent('x'), light.accent('x'));
    assert.match(dark.accent('x'), /\x1b\[/);
    assert.equal(PLAIN.accent('x'), 'x');
    const state = { version: '1', config: {} };
    assert.equal(splash(state, dark).replace(/\x1b\[[0-9;]*m/g, ''), splash(state, PLAIN));
  });

  it('CL8 validates what it saves', () => {
    assert.equal(parseTheme(' Dark '), 'dark');
    assert.throws(() => parseTheme('neon'), /one of/);
    assert.equal(parseManager('factory-manager'), 'factory-manager');
    assert.throws(() => parseManager('a b'), /agent id/);
    assert.throws(() => parseManager('../x'), /agent id/);
  });
});
