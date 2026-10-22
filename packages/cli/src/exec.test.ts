import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthRequiredError, FactoryClient } from './client.js';
import { executeTool } from './exec.js';
import { toolsFor } from './tools.js';
import { stripControl, oneLine } from './conversation.js';
import { fakeFactory } from './testing.js';

const setup = () => {
  const f = fakeFactory();
  const client = new FactoryClient({ baseUrl: 'https://f.example.com', fetch: f.fetch, credential: async () => 'good-token', sleep: async () => {} });
  const asked: string[] = [];
  const io = { note: () => {}, confirm: async (q: string) => (asked.push(q), true) };
  return { f, client, asked, io };
};

describe('§6.17 CL4 and CL11 the one place a tool runs', () => {
  it('CL4 a sign-in that is refused mid-session surfaces as AuthRequiredError, not as a tool error the manager could explain away', async () => {
    const { f, client, io } = setup();
    f.token = 'rotated'; // the factory now refuses the CLI's credential
    await assert.rejects(executeTool({ client, offered: toolsFor(['admin']), call: { id: '1', name: 'list_agents', arguments: {} }, io, asker: 'Run' }), AuthRequiredError);
  });

  it('CL4 the manager is given a trimmed result, a person\'s command the whole redacted body', async () => {
    const { f, client, io } = setup();
    const rows = Array.from({ length: 3000 }, (_, i) => ({ id: i, text: 'x'.repeat(60), apiKey: 'sk-live' }));
    f.routes.set('GET /api/v1/agents', () => ({ status: 200, body: rows }));
    const got = await executeTool({ client, offered: toolsFor(['viewer']), call: { id: '1', name: 'list_agents', arguments: {} }, io, asker: 'Run' });
    const shown = got.result.result as { truncated: boolean; total: number; shown: number };
    assert.equal(shown.truncated, true);
    assert.ok(shown.shown < 3000);
    assert.equal((got.body as unknown[]).length, 3000, 'the whole answer is there for --json');
    assert.doesNotMatch(JSON.stringify(got), /sk-live/);
  });

  it('CL4 a change is confirmed with a reset first and the text made display-safe; a tool that was not offered does not run', async () => {
    const { f, client, asked, io } = setup();
    f.routes.set('POST /api/v1/agents/donna/pause', () => ({ status: 200, body: { ok: true } }));
    await executeTool({ client, offered: toolsFor(['admin']), call: { id: '1', name: 'pause_agent', arguments: { id: 'donna', note: 'x‮y\x1b[8m' } }, io, asker: 'Run' });
    assert.match(asked[0], /^\x1b\[0mRun: pause_agent/);
    assert.doesNotMatch(asked[0].slice(4), /[\x00-\x08\x0b-\x1f\x7f‮]/);
    const refused = await executeTool({ client, offered: toolsFor(['viewer']), call: { id: '2', name: 'set_factory_budgets', arguments: { totalMonthUsd: 1 } }, io, asker: 'Run' });
    assert.equal(refused.result.ok, false);
    assert.equal(asked.length, 1);
  });

  it('CL6 display-safe text has no control, bidirectional or format characters, and no line breaks when asked for one line', () => {
    const evil = 'donna‮gnp.exe‬​⁦x⁩﻿\x1b[2J\x07 y\nz';
    assert.equal(stripControl(evil), 'donnagnp.exex[2Jy\nz'); // the escape is gone; what is left of it is inert text
    assert.equal(oneLine(evil), 'donnagnp.exex[2Jy z');
    assert.equal(stripControl('plain text, tabs\tand newlines\n are kept'), 'plain text, tabs\tand newlines\n are kept');
  });
});
