// §6.11 K5: outstanding credentials and the instruction catalog.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTION_CATALOG, PENDING_REVIEW_LABEL, catalogView, inferSource } from './catalog.js';
import { assessCredentials, submittableSecrets, summarize, type AssessOptions } from './credentials.js';
import type { GrantView } from './connections.js';

const CAL = 'https://www.googleapis.com/auth/calendar.readonly';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';

function opts(over: Partial<AssessOptions> & { have?: string[]; grants?: Record<string, GrantView> } = {}): AssessOptions {
  const have = new Set(over.have ?? []);
  return {
    agentId: 'donna',
    secrets: [],
    connections: [],
    gatewayHeld: new Set(),
    present: async (n) => have.has(n),
    grant: async (p) => over.grants?.[p],
    submitPath: (n) => `/api/v1/keymaster/agents/donna/credentials/${n}`,
    consent: (p) => ({ path: `/api/v1/connections/donna/${p}/start`, url: `https://factory.example.test/api/v1/connections/donna/${p}/start` }),
    ...over,
  };
}

describe('instruction catalog (K5.4)', () => {
  it('has one entry per source system, each AI-drafted and pending human review', () => {
    const ids = INSTRUCTION_CATALOG.map((e) => e.id);
    for (const id of ['discord', 'github', 'slack', 'notion', 'xai', 'anthropic', 'home-assistant', 'google']) assert.ok(ids.includes(id), id);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    for (const e of INSTRUCTION_CATALOG) {
      assert.equal(e.approved, null, `${e.id} ships unapproved`);
      assert.ok(e.instructions.length > 100, `${e.id} has instructions`);
      assert.ok(['static', 'oauth'].includes(e.kind));
      // K5.6: never ask for a script, a terminal, or a secret in a chat.
      assert.doesNotMatch(e.instructions, /\b(terminal|aws secretsmanager|curl|run the script|paste (it|the value) (in|into) (a |the )?chat)\b/i, e.id);
    }
    assert.equal(INSTRUCTION_CATALOG.find((e) => e.id === 'google')?.kind, 'oauth');
  });

  it('labels unapproved entries and drops the label once a person approves', () => {
    const draft = catalogView(INSTRUCTION_CATALOG[0]);
    assert.equal(draft.reviewState, 'pending_review');
    assert.equal(draft.label, PENDING_REVIEW_LABEL);
    const approved = catalogView({ ...INSTRUCTION_CATALOG[0], approved: { by: 'a person', at: '2026-09-28' } });
    assert.equal(approved.reviewState, 'approved');
    assert.equal(approved.label, undefined);
  });

  it('infers a source only from well-known name prefixes', () => {
    assert.equal(inferSource('DISCORD_BOT_TOKEN'), 'discord');
    assert.equal(inferSource('GITHUB_TOKEN'), 'github');
    assert.equal(inferSource('HA_TOKEN'), 'home-assistant');
    assert.equal(inferSource('SOMETHING_ELSE'), undefined);
  });
});

describe('assessCredentials (K5.2)', () => {
  it('reports static secrets present or missing, with a submit action and instructions', async () => {
    const items = await assessCredentials(opts({
      secrets: [{ name: 'DISCORD_BOT_TOKEN', source: 'discord' }, { name: 'GITHUB_TOKEN' }, { name: 'CUSTOM_THING' }],
      have: ['GITHUB_TOKEN'],
    }));
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(by.DISCORD_BOT_TOKEN.status, 'missing');
    assert.equal(by.DISCORD_BOT_TOKEN.outstanding, true);
    assert.equal(by.DISCORD_BOT_TOKEN.instructions?.id, 'discord');
    assert.equal(by.DISCORD_BOT_TOKEN.instructions?.reviewState, 'pending_review');
    assert.deepEqual(by.DISCORD_BOT_TOKEN.action, { type: 'submit', method: 'POST', path: '/api/v1/keymaster/agents/donna/credentials/DISCORD_BOT_TOKEN' });
    assert.equal(by.GITHUB_TOKEN.status, 'present');
    assert.equal(by.GITHUB_TOKEN.sourceInferred, true);
    assert.equal(by.CUSTOM_THING.instructions, null);
    assert.deepEqual(summarize(items), { total: 3, outstanding: 2, present: 1 });
  });

  it('treats gateway-held secrets as present and managed by the platform, and never checks them', async () => {
    const asked: string[] = [];
    const items = await assessCredentials(opts({
      secrets: [{ name: 'NOTION_API_KEY' }, { name: 'ANTHROPIC_API_KEY' }],
      gatewayHeld: new Set(['NOTION_API_KEY', 'ANTHROPIC_API_KEY']),
      present: async (n) => (asked.push(n), false),
    }));
    assert.deepEqual(asked, []);
    for (const i of items) {
      assert.equal(i.status, 'present');
      assert.equal(i.managedBy, 'platform');
      assert.equal(i.action.type, 'none');
    }
    assert.deepEqual([...submittableSecrets({ secrets: [{ name: 'NOTION_API_KEY' }, { name: 'X_TOKEN' }], connections: [], gatewayHeld: new Set(['NOTION_API_KEY']) })], ['X_TOKEN']);
  });

  it('reports OAuth connections: needs_consent, missing_scopes, needs_reconsent, present', async () => {
    const conn = { connections: [{ provider: 'google', scopes: [CAL, GMAIL] }], have: ['GOOGLE_OAUTH_CLIENT'] };
    const grant = (scopes: string[], status: GrantView['status'] = 'active'): GrantView => ({ provider: 'google', scopes, status, obtainedAt: '2026-09-28T00:00:00Z', grantedBy: 'admin' });
    const google = async (grants?: Record<string, GrantView>) => (await assessCredentials(opts({ ...conn, grants }))).find((i) => i.name === 'google')!;

    const none = await google();
    assert.equal(none.status, 'needs_consent');
    assert.equal(none.action.type, 'consent');
    if (none.action.type === 'consent') {
      assert.equal(none.action.available, true);
      assert.equal(none.action.path, '/api/v1/connections/donna/google/start');
    }
    const partial = await google({ google: grant([CAL]) });
    assert.equal(partial.status, 'missing_scopes');
    assert.deepEqual(partial.scopes?.missing, [GMAIL]);
    assert.equal((await google({ google: grant([CAL, GMAIL], 'needs_reconsent') })).status, 'needs_reconsent');
    const ok = await google({ google: grant([GMAIL, CAL]) });
    assert.equal(ok.status, 'present');
    assert.equal(ok.outstanding, false);
    assert.deepEqual(ok.grant, { grantedBy: 'admin', obtainedAt: '2026-09-28T00:00:00Z' });
  });

  it('lists the platform app credentials a connection needs, and blocks consent until the OAuth client exists', async () => {
    const items = await assessCredentials(opts({ connections: [{ provider: 'google', scopes: [CAL] }, { provider: 'google-service-account', scopes: [] }] }));
    const by = Object.fromEntries(items.map((i) => [i.name, i]));
    assert.equal(by.GOOGLE_OAUTH_CLIENT.status, 'missing');
    assert.equal(by.GOOGLE_OAUTH_CLIENT.managedBy, 'platform');
    assert.equal(by.GOOGLE_OAUTH_CLIENT.shared, true);
    assert.equal(by.GOOGLE_OAUTH_CLIENT.instructions?.id, 'google-oauth-client');
    assert.equal(by.GOOGLE_SERVICE_ACCOUNT.status, 'missing');
    assert.equal(by.GOOGLE_SERVICE_ACCOUNT.requiredBy, 'connection:google-service-account');
    assert.equal(by['google-service-account'], undefined, 'a service-account connection needs no consent');
    const action = by.google.action;
    assert.equal(action.type === 'consent' && action.available, false);
    assert.deepEqual(
      [...submittableSecrets({ secrets: [], connections: [{ provider: 'google', scopes: [] }, { provider: 'google-service-account', scopes: [] }], gatewayHeld: new Set() })],
      ['GOOGLE_OAUTH_CLIENT', 'GOOGLE_SERVICE_ACCOUNT'],
    );
  });

  it('reports an unsupported connection as outstanding with no action', async () => {
    const [item] = await assessCredentials(opts({ connections: [{ provider: 'fitbit', scopes: ['x'] }] }));
    assert.equal(item.status, 'missing');
    assert.equal(item.action.type, 'none');
  });
});
