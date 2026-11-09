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

  it('§6.9 M5 renders subscriptions list with needs_reconsent, limitWindow + resetAt, template permission URLs, and Anthropic/Google notOffered', () => {
    const out = render({
      connections: [
        {
          id: 'sub_1',
          name: "Dale's Grok Subscription",
          scope: 'personal',
          ownerPrincipalId: 'user:dale',
          status: 'needs_reconsent',
          vendor: 'xai',
          tier: 'SuperGrok',
          accountEmail: 'dale@example.com',
          dailyTokenCap: 250000,
          limitWindow: {
            kind: 'quota',
            code: '429',
            openedAt: '2026-11-08T10:00:00Z',
            resetAt: '2026-11-08T14:00:00Z',
          },
          discovery: { status: 'ok', listAvailable: true },
          discoveredModels: [{ id: 'grok-4.6' }],
        },
      ],
      templates: [
        {
          id: 'xai-subscription',
          name: 'xAI SuperGrok',
          permission: {
            tiers: ['SuperGrok'],
            checkedDate: '2026-11-07',
            statementUrls: ['https://x.ai/legal/terms-of-service'],
          },
        },
      ],
      notOffered: [
        {
          vendor: 'anthropic',
          name: 'Anthropic (Claude Pro / Max)',
          checkedDate: '2026-11-07',
          reason: 'Consumer OAuth tokens prohibited in third-party agents.',
          statementUrls: ['https://code.claude.com/docs/en/legal-and-compliance'],
        },
        {
          vendor: 'google',
          name: 'Google (Gemini / Antigravity)',
          checkedDate: '2026-11-07',
          reason: 'Consumer subscription credentials prohibited in third-party agents.',
          statementUrls: ['https://antigravity.google/terms'],
        },
      ],
    });
    assert.match(out, /Dale's Grok Subscription \[sub_1\]/);
    assert.match(out, /personal \(user:dale\)/);
    assert.match(out, /needs_reconsent \[RECONSENT REQUIRED\]/);
    assert.match(out, /limit window: kind=quota code=429.*resetAt=2026-11-08T14:00:00Z/);
    assert.match(out, /checked 2026-11-07.*https:\/\/x\.ai\/legal\/terms-of-service/);
    assert.match(out, /Anthropic \(Claude Pro \/ Max\) \[NOT OFFERED, checked 2026-11-07\]/);
    assert.match(out, /Google \(Gemini \/ Antigravity\) \[NOT OFFERED, checked 2026-11-07\]/);
  });

  it('§6.9 M5 renders /models with subscription markers & display labels and /spend with subscription token usage', () => {
    const modelsOut = render({
      default: 'grok-api',
      models: [
        {
          name: 'grok-api',
          id: 'grok-4.6',
          credentialMode: 'api-key',
          subscription: false,
          displayLabel: 'grok-4.6 · xAI API',
          price: { inputPerMTok: 3, outputPerMTok: 15 },
        },
        {
          name: 'grok-dale',
          id: 'grok-4.6',
          credentialMode: 'subscription',
          subscription: true,
          scope: 'personal',
          ownerPrincipalId: 'user:dale',
          displayLabel: "grok-4.6 · Dale's Grok Subscription",
          price: { inputPerMTok: 0, outputPerMTok: 0 },
        },
      ],
    });
    assert.match(modelsOut, /grok-4\.6 · xAI API/);
    assert.match(modelsOut, /grok-4\.6 · Dale's Grok Subscription/);
    assert.match(modelsOut, /subscription \[personal BYOM user:dale\]/);

    const spendOut = render({
      day: '2026-11-08',
      month: '2026-11',
      agents: {},
      subscriptions: {
        day: '2026-11-08',
        month: '2026-11',
        connections: {
          sub_1: {
            connectionName: "Dale's Grok Subscription",
            scope: 'personal',
            ownerPrincipalId: 'user:dale',
            dailyTokenCap: 250000,
            day: { totalTokens: 1200, calls: 3, inputTokens: 800, outputTokens: 400 },
            month: { totalTokens: 9600, calls: 20, inputTokens: 6000, outputTokens: 3600 },
          },
        },
        agents: {
          'dale-agent': {
            day: { totalTokens: 1200, calls: 3 },
            month: { totalTokens: 9600, calls: 20 },
          },
        },
      },
    });
    assert.match(spendOut, /Subscription token usage \(today 2026-11-08, month 2026-11\)/);
    assert.match(spendOut, /Dale's Grok Subscription/);
    assert.match(spendOut, /dale-agent/);
  });
});
