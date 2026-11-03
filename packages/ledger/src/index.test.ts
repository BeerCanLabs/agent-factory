import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Checkpointer, FileCheckpointSink, FileLedger, MemoryLedger, S3CheckpointSink, GcsCheckpointSink, checkpointSinkFromEnv, payloadHash, redactSecrets, toLedgerEvent } from './index.js';

describe('toLedgerEvent', () => {
  it('S7: keeps a well-formed privilege on an AUTHZ_DENIED row and drops anything else in that field', () => {
    assert.equal(toLedgerEvent({ agentId: 'cp', type: 'action', action: 'AUTHZ_DENIED', privilege: 'grants.manage' }).privilege, 'grants.manage');
    // secret-scan:allow (test fixture)
    for (const bad of ['fk_live_0123456789abcdef', 'grants manage', 'GRANTS.MANAGE', 42, 'a'.repeat(120)])
      assert.equal(toLedgerEvent({ agentId: 'cp', type: 'action', privilege: bad }).privilege, undefined, String(bad));
  });

  it('keeps well-formed connection fields (§6.11) and drops anything that could carry text or tokens', () => {
    const ok = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'CONNECTION_GRANTED',
      provider: 'google',
      connection: 'google-service-account',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly', 'not a scope <script>'],
      status: 404,
      refreshToken: '1//secret',
    });
    assert.equal(ok.provider, 'google');
    assert.equal(ok.connection, 'google-service-account');
    assert.deepEqual(ok.scopes, ['https://www.googleapis.com/auth/calendar.readonly']);
    assert.equal(ok.status, 404);
    assert.equal(JSON.stringify(ok).includes('1//secret'), false);
    const bad = toLedgerEvent({ agentId: 'd', type: 'action', provider: 'has spaces', status: 99999, scopes: 'x' });
    assert.equal(bad.provider, undefined);
    assert.equal(bad.status, undefined);
    assert.equal(bad.scopes, undefined);
  });

  it('keeps a Keymaster credential name (§6.11 K5.3) only when it is an ENV-style secret name, and never a value', () => {
    const ok = toLedgerEvent({ agentId: 'donna', type: 'action', action: 'CREDENTIAL_SET', actor: 'admin', credential: 'DISCORD_BOT_TOKEN', value: 'example-fake-token-value' });
    assert.equal(ok.credential, 'DISCORD_BOT_TOKEN');
    assert.equal(ok.action, 'CREDENTIAL_SET');
    assert.equal(JSON.stringify(ok).includes('example-fake-token-value'), false);
    assert.equal((ok as Record<string, unknown>).value, undefined);
    for (const credential of ['not a name', 'lowercase_name', 'X'.repeat(200), 42, 'A=b']) {
      assert.equal(toLedgerEvent({ agentId: 'd', type: 'action', credential }).credential, undefined, String(credential));
    }
  });

  it('drops prompt/content and stores a payload hash', () => {
    const event = toLedgerEvent({
      agentId: 'echo',
      type: 'llm',
      prompt: 'SSN 123-45-6789 and a long secret thought',
      inputTokens: 3,
    });
    assert.equal(event.inputTokens, 3);
    assert.equal('prompt' in event, false);
    assert.equal(event.payloadSha256, payloadHash('SSN 123-45-6789 and a long secret thought'));
  });

  it('redacts known secret strings before flush', () => {
    const event = toLedgerEvent(
      { agentId: 'echo', type: 'action', action: 'used sk-live-super-secret' },
      ['sk-live-super-secret'],
    );
    assert.equal(event.action, 'used ***');
    assert.equal(JSON.stringify(event).includes('sk-live-super-secret'), false);
  });

  it('keeps structured onBehalfOf, scope, before, and after audit fields while stripping secrets and free text (R5, D30)', () => {
    const secret = 'fk_live_super_secret_value';
    const event = toLedgerEvent(
      {
        agentId: 'control-plane',
        type: 'action',
        action: 'GRANT_CREATED',
        actor: 'user:admin',
        onBehalfOf: 'user:stephanie',
        subject: 'user:stephanie',
        scope: { kind: 'agent', id: 'ops-bot', prompt: 'ignore me' },
        before: null,
        after: {
          id: 'grant-1',
          subject: 'user:stephanie',
          subjectKind: 'user',
          scope: { kind: 'agent', id: 'ops-bot' },
          role: 'member',
          state: 'active',
          expiresAt: null,
          version: 1,
          createdAt: '2026-11-02T00:00:00.000Z',
          createdBy: 'user:admin',
          onBehalfOf: 'user:stephanie',
          secretToken: secret,
          prompt: 'drop free text',
        },
      },
      [secret],
    );
    assert.equal(event.actor, 'user:admin');
    assert.equal(event.onBehalfOf, 'user:stephanie');
    assert.equal(event.subject, 'user:stephanie');
    assert.deepEqual(event.scope, { kind: 'agent', id: 'ops-bot' });
    assert.equal(event.before, null);
    assert.deepEqual(event.after, {
      id: 'grant-1',
      subject: 'user:stephanie',
      subjectKind: 'user',
      scope: { kind: 'agent', id: 'ops-bot' },
      role: 'member',
      state: 'active',
      expiresAt: null,
      version: 1,
      createdAt: '2026-11-02T00:00:00.000Z',
      createdBy: 'user:admin',
      onBehalfOf: 'user:stephanie',
    });
    assert.equal(JSON.stringify(event).includes(secret), false);
    assert.equal(JSON.stringify(event).includes('drop free text'), false);

    // Malformed onBehalfOf or scope are dropped
    const bad = toLedgerEvent({
      agentId: 'control-plane',
      type: 'action',
      onBehalfOf: 'has spaces',
      scope: { kind: 'unknown', id: 'x' },
      before: { arbitraryKey: 'dropped' },
    });
    assert.equal(bad.onBehalfOf, undefined);
    assert.equal(bad.scope, undefined);
    assert.equal(bad.before, undefined);
  });
});

describe('FileLedger', () => {
  it('appends and never rewrites prior rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new FileLedger(path);
    ledger.append({ timestamp: '', agentId: 'a', type: 'llm', inputTokens: 1 });
    const before = readFileSync(path, 'utf8');
    ledger.append({ timestamp: '', agentId: 'a', type: 'mcp', mcpName: 'tool' });
    const after = readFileSync(path, 'utf8');
    assert.ok(after.startsWith(before));
    assert.equal(ledger.query({ agent: 'a' }).length, 2);
    rmSync(dir, { recursive: true });
  });

  it('never writes extra keys or secret plaintext to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const secret = 'sk-live-do-not-store';
    const ledger = new FileLedger(path, { secrets: [secret] });
    ledger.append({
      agentId: 'echo',
      type: 'llm',
      prompt: `hello ${secret}`,
      content: 'user email a@b.c',
      extra: 'drop me',
    });
    const disk = readFileSync(path, 'utf8');
    assert.equal(disk.includes(secret), false);
    assert.equal(disk.includes('"prompt"'), false);
    assert.equal(disk.includes('"content"'), false);
    assert.equal(disk.includes('"extra"'), false);
    assert.equal(
      disk.includes(payloadHash({ prompt: `hello ${secret}`, content: 'user email a@b.c' })),
      true,
    );
    rmSync(dir, { recursive: true });
  });
});

describe('redactSecrets', () => {
  it('masks the longest match first', () => {
    assert.equal(redactSecrets('id token-long and token-longer', ['token-long', 'token-longer']), 'id *** and ***');
  });
});

describe('hash chain', () => {
  function ledgerWith(n: number) {
    const dir = mkdtempSync(join(tmpdir(), 'chain-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new FileLedger(path);
    for (let i = 0; i < n; i++) ledger.append({ agentId: 'a', type: 'action', action: `A${i}`, actor: 'token:t' });
    return { dir, path, ledger };
  }

  it('links every row to the one before it and verifies clean', () => {
    const { dir, ledger } = ledgerWith(5);
    const rows = ledger.query();
    assert.deepEqual(rows.map((r) => r.seq), [1, 2, 3, 4, 5]);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prevHash, rows[i - 1].hash);
    const v = ledger.verify();
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.head, rows[4].hash);
    rmSync(dir, { recursive: true });
  });

  it('detects an edited row on disk', () => {
    const { dir, path, ledger } = ledgerWith(5);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const row = JSON.parse(lines[2]);
    row.actor = 'oidc:someone-else@example.com';
    lines[2] = JSON.stringify(row);
    writeFileSync(path, `${lines.join('\n')}\n`);
    const v = ledger.verify();
    assert.equal(v.ok, false);
    if (!v.ok) {
      assert.equal(v.firstBadSeq, 3);
      assert.match(v.reason, /altered/);
    }
    rmSync(dir, { recursive: true });
  });

  it('detects a deleted middle row', () => {
    const { dir, path, ledger } = ledgerWith(5);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines.splice(1, 1);
    writeFileSync(path, `${lines.join('\n')}\n`);
    assert.equal(ledger.verify().ok, false);
    rmSync(dir, { recursive: true });
  });

  it('truncation or a rebuilt chain is caught by the WORM checkpoints', async () => {
    const { dir, path, ledger } = ledgerWith(4);
    const sink = new FileCheckpointSink(join(dir, 'worm'));
    const cp = new Checkpointer(ledger, sink);
    await cp.init();
    const anchor = await cp.flush();
    assert.equal(anchor?.toSeq, 4);
    assert.equal((await cp.flush()), null, 'nothing new to ship');
    assert.equal(ledger.verify(await sink.list()).ok, true);

    // Duplicate checkpoint for same sequence (e.g. from an aborted concurrent writer):
    // as long as the chain matches a valid checkpoint for that seq, verification succeeds.
    const checkpointsWithOrphan = [
      ...(await sink.list()),
      { toSeq: 4, hash: '0'.repeat(64) }, // orphan/alternate checkpoint for seq 4
    ];
    assert.equal(ledger.verify(checkpointsWithOrphan).ok, true);

    // If no checkpoint for that seq matches, it must fail:
    const checkpointsWithoutMatch = [
      { toSeq: 4, hash: '1'.repeat(64) },
      { toSeq: 4, hash: '2'.repeat(64) },
    ];
    const failedMatch = ledger.verify(checkpointsWithoutMatch);
    assert.equal(failedMatch.ok, false);
    if (!failedMatch.ok) assert.match(failedMatch.reason, /WORM/);

    // Drop the last two rows: the chain alone still verifies, the checkpoint does not.
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${lines.slice(0, 2).join('\n')}\n`);
    assert.equal(ledger.verify().ok, true);
    const truncated = ledger.verify(await sink.list());
    assert.equal(truncated.ok, false);
    if (!truncated.ok) assert.match(truncated.reason, /rows missing/);

    // Rewrite history consistently from genesis: still diverges from the WORM anchor.
    const forged = new FileLedger(join(dir, 'forged.jsonl'));
    for (let i = 0; i < 4; i++) forged.append({ agentId: 'a', type: 'action', action: `FORGED${i}`, actor: 'token:t' });
    const v = forged.verify(await sink.list());
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /WORM/);

    rmSync(dir, { recursive: true });
  });

  it('checkpoints carry the rows themselves and are never overwritten', async () => {
    const { dir, ledger } = ledgerWith(2);
    const sink = new FileCheckpointSink(join(dir, 'worm'));
    const rows = ledger.query();
    const c = { fromSeq: 1, toSeq: 2, prevHash: rows[0].prevHash, hash: rows[1].hash, rows };
    await sink.write(c);
    await assert.rejects(sink.write(c), /EEXIST/);
    rmSync(dir, { recursive: true });
  });

  it('seals pre-chain rows under the genesis hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-'));
    const path = join(dir, 'ledger.jsonl');
    writeFileSync(path, '{"timestamp":"t","agentId":"a","type":"action"}\n');
    const ledger = new FileLedger(path);
    ledger.append({ agentId: 'a', type: 'action', action: 'NEW' });
    assert.equal(ledger.verify().ok, true);
    writeFileSync(path, readFileSync(path, 'utf8').replace('"agentId":"a","type":"action"}', '"agentId":"b","type":"action"}'));
    assert.equal(new FileLedger(path).verify().ok, false, 'editing a legacy row breaks the chain');
    rmSync(dir, { recursive: true });
  });

  it('recovers canonical chain and prunes orphaned concurrent writes from disk', () => {
    const { dir, path, ledger } = ledgerWith(3);
    // Rows 1, 2, 3 are written.
    // Simulate a concurrent write where two instances write seq 4.
    // Row 4a: orphan write that never gets continued
    // Row 4b: canon write that is followed by row 5
    const row4b = ledger.append({ agentId: 'a', type: 'action', action: 'CANON_4', actor: 'token:t' });
    const row5 = ledger.append({ agentId: 'a', type: 'action', action: 'CANON_5', actor: 'token:t' });

    // Now inject orphan row4a into disk between row 3 and row 4b
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const row3 = JSON.parse(lines[2]);
    const fake4a = {
      timestamp: new Date().toISOString(),
      agentId: 'a',
      type: 'action',
      action: 'ORPHAN_4A',
      actor: 'token:t',
      seq: 4,
      prevHash: row3.hash,
      hash: 'e'.repeat(64),
    };
    lines.splice(3, 0, JSON.stringify(fake4a));
    writeFileSync(path, `${lines.join('\n')}\n`);

    // Reloading FileLedger should prune the orphan and verify clean
    const reloaded = new FileLedger(path);
    assert.equal(reloaded.query().length, 5);
    assert.deepEqual(reloaded.query().map((r) => r.seq), [1, 2, 3, 4, 5]);
    const v = reloaded.verify();
    assert.equal(v.ok, true);
    rmSync(dir, { recursive: true });
  });

  it('memory ledger chains too', () => {
    const m = new MemoryLedger();
    m.append({ agentId: 'a', type: 'action' });
    m.append({ agentId: 'a', type: 'action' });
    assert.equal(m.verify().ok, true);
    (m.events[0] as { action?: string }).action = 'X';
    assert.equal(m.verify().ok, false);
  });
});

describe('S3 object-lock sink', () => {
  it('writes in COMPLIANCE mode with a retention date and lists anchors from keys', async () => {
    const calls: string[][] = [];
    const hash = 'a'.repeat(64);
    const sink = new S3CheckpointSink('s3://ledger-bucket/prod', 365, async (args) => {
      calls.push(args);
      if (args[1] === 'list-objects-v2') return JSON.stringify({ Contents: [{ Key: `prod/ckpt-000000000007-${hash}.jsonl` }, { Key: 'prod/other' }] });
      return '{}';
    });
    await sink.write({ fromSeq: 1, toSeq: 7, prevHash: '0'.repeat(64), hash, rows: [] });
    const put = calls[0];
    assert.equal(put[put.indexOf('--object-lock-mode') + 1], 'COMPLIANCE');
    const until = new Date(put[put.indexOf('--object-lock-retain-until-date') + 1]).getTime();
    assert.ok(until > Date.now() + 364 * 86_400_000);
    assert.equal(put[put.indexOf('--key') + 1], `prod/ckpt-000000000007-${hash}.jsonl`);
    assert.deepEqual(await sink.list(), [{ toSeq: 7, hash }]);
  });
});

describe('GCS checkpoint sink', () => {
  it('writes to GCS and parses ckpt keys from listing', async () => {
    const calls: string[][] = [];
    const hash = 'b'.repeat(64);
    const sink = new GcsCheckpointSink('gcs://my-gcp-bucket/ledger', 365, async (args) => {
      calls.push(args);
      if (args[0] === 'ls') {
        return `gs://my-gcp-bucket/ledger/ckpt-000000000012-${hash}.jsonl\ngs://my-gcp-bucket/ledger/other.txt\n`;
      }
      return '';
    });
    await sink.write({ fromSeq: 1, toSeq: 12, prevHash: '0'.repeat(64), hash, rows: [] });
    assert.equal(calls[0][0], 'cp');
    assert.equal(calls[0][2], `gs://my-gcp-bucket/ledger/ckpt-000000000012-${hash}.jsonl`);
    assert.deepEqual(await sink.list(), [{ toSeq: 12, hash }]);
  });

  it('instantiates GcsCheckpointSink from gcs:// and gs:// environment variable', () => {
    const s1 = checkpointSinkFromEnv({ FACTORY_LEDGER_WORM_URI: 'gcs://bucket/path' });
    assert.ok(s1 instanceof GcsCheckpointSink);
    const s2 = checkpointSinkFromEnv({ FACTORY_LEDGER_WORM_URI: 'gs://bucket/path' });
    assert.ok(s2 instanceof GcsCheckpointSink);
  });

  it('writes, lists, and hydrates FileLedger over native GCS JSON API without gcloud binary', async () => {
    const { hydrateLedgerFromSink } = await import('./index.js');
    const objects = new Map<string, string>();
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.pathname === '/upload/storage/v1/b/worm-bucket/o') {
        const name = url.searchParams.get('name') ?? '';
        objects.set(name, String(init?.body ?? ''));
        return new Response(JSON.stringify({ name }), { status: 200 });
      }
      if (method === 'GET' && url.pathname === '/storage/v1/b/worm-bucket/o') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const items = [...objects.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      const dlMatch = url.pathname.match(/^\/storage\/v1\/b\/worm-bucket\/o\/(.+)$/);
      if (method === 'GET' && dlMatch && url.searchParams.get('alt') === 'media') {
        const name = decodeURIComponent(dlMatch[1]);
        const body = objects.get(name);
        if (body === undefined) return new Response('', { status: 404 });
        return new Response(body, { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const dir = mkdtempSync(join(tmpdir(), 'gcs-hydrate-'));
    try {
      const path1 = join(dir, 'instance1.jsonl');
      const ledger1 = new FileLedger(path1);
      for (let i = 0; i < 3; i++) ledger1.append({ agentId: 'a', type: 'action', action: `STEP_${i}`, actor: 'token:t' });
      const sink = new GcsCheckpointSink('gcs://worm-bucket/ledger', 365, undefined, {
        fetch: fetchMock,
        getAccessToken: async () => 'tok',
      });
      const cp = new Checkpointer(ledger1, sink);
      await cp.init();
      await cp.flush();

      // Simulate cold Cloud Run container restart with empty /tmp/ledger.jsonl
      const path2 = join(dir, 'instance2.jsonl');
      const hydratedCount = await hydrateLedgerFromSink(path2, sink);
      assert.equal(hydratedCount, 3);
      const ledger2 = new FileLedger(path2);
      const verify = ledger2.verify(await sink.list());
      assert.equal(verify.ok, true);
      if (verify.ok) {
        assert.equal(verify.rows, 3);
        assert.equal(verify.checkpointsChecked, 1);
      }
      ledger2.append({ agentId: 'a', type: 'action', action: 'STEP_3', actor: 'token:t' });
      assert.equal(ledger2.query().length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe('toLedgerEvent egress and commit fields (E3)', () => {
  it('keeps a well-formed host, port and commit', () => {
    const e = toLedgerEvent({ agentId: 'a', type: 'action', action: 'EGRESS_TUNNEL', host: 'API.Notion.com', port: 443, commit: 'a'.repeat(40) });
    assert.equal(e.host, 'api.notion.com');
    assert.equal(e.port, 443);
    assert.equal(e.commit, 'a'.repeat(40));
  });
  it('drops malformed values so they cannot carry arbitrary text', () => {
    const e = toLedgerEvent({ agentId: 'a', type: 'action', host: 'evil.com/path?secret=x', port: 70000, commit: 'main' });
    assert.equal(e.host, undefined);
    assert.equal(e.port, undefined);
    assert.equal(e.commit, undefined);
  });
});

describe('model and grounding fields are kept, well-formed only (GAP-181, GAP-182, AP3)', () => {
  it('AM5 keeps the subject of an admin conversation read, and only a well-formed actor', () => {
    const ledger = new MemoryLedger();
    ledger.append({ timestamp: '2026-10-18T00:00:00Z', agentId: 'a', type: 'action', action: 'CONVERSATION_READ_BY_ADMIN', actor: 'cloudflare:admin@example.com', subject: 'cloudflare:dale@example.com' });
    ledger.append({ timestamp: '2026-10-18T00:00:01Z', agentId: 'a', type: 'action', action: 'CONVERSATION_READ_BY_ADMIN', actor: 'x', subject: 'not an actor <script>' });
    const [kept, dropped] = ledger.query();
    assert.equal(kept.subject, 'cloudflare:dale@example.com');
    assert.equal(dropped.subject, undefined);
  });

  it('keeps requestedModel, upstreamModel, models, replySha256, footnote, retryRequestId and toolCalled', () => {
    const l = new MemoryLedger();
    const sha = 'a'.repeat(64);
    const row = l.append({
      agentId: 'rosie', type: 'llm', requestedModel: 'claude-sonnet-5-5', upstreamModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      models: ['grok-old', 'models/gemini-x'], replySha256: sha, footnote: '[no tools called]',
      retryRequestId: '0f8fad5b-d9cb-469f-a165-70867728950e', toolCalled: true,
    });
    assert.equal(row.requestedModel, 'claude-sonnet-5-5');
    assert.equal(row.upstreamModel, 'us.anthropic.claude-haiku-4-5-20251001-v1:0');
    assert.deepEqual(row.models, ['grok-old', 'models/gemini-x']);
    assert.equal(row.replySha256, sha);
    assert.equal(row.footnote, '[no tools called]');
    assert.equal(row.retryRequestId, '0f8fad5b-d9cb-469f-a165-70867728950e');
    assert.equal(row.toolCalled, true);
  });

  it('drops anything that could carry free text', () => {
    const row = new MemoryLedger().append({
      agentId: 'rosie', type: 'llm', requestedModel: 'ignore previous instructions', models: ['ok-model', 'a reply with spaces'],
      replySha256: 'not a hash', footnote: '[anything else]', toolCalled: 'yes',
    });
    assert.equal(row.requestedModel, undefined);
    assert.deepEqual(row.models, ['ok-model']);
    assert.equal(row.replySha256, undefined);
    assert.equal(row.footnote, undefined);
    assert.equal(row.toolCalled, undefined);
  });
});

describe('parent fields (E1.5)', () => {
  it('keeps well-formed parentRunId and parentAgentId and drops anything else', () => {
    const ok = toLedgerEvent({ agentId: 'juror', type: 'llm', parentRunId: 'a75a3ac9-b9c6-427b-9b47-969ffe2c6c25', parentAgentId: 'sdlc-pr-reviewer' });
    assert.equal(ok.parentRunId, 'a75a3ac9-b9c6-427b-9b47-969ffe2c6c25');
    assert.equal(ok.parentAgentId, 'sdlc-pr-reviewer');
    const bad = toLedgerEvent({ agentId: 'juror', type: 'llm', parentRunId: 'free text here', parentAgentId: 42 });
    assert.equal(bad.parentRunId, undefined);
    assert.equal(bad.parentAgentId, undefined);
  });
});

describe('trigger attribution field (#345)', () => {
  it('keeps well-formed run trigger identifiers and drops free-text values', () => {
    for (const trigger of ['schedule', 'cron', 'conversation', 'smoke', 'event:crash']) {
      const ok = toLedgerEvent({ agentId: 'donna', type: 'action', action: 'RUN_READY', trigger });
      assert.equal(ok.trigger, trigger);
    }
    for (const badTrigger of ['has spaces', 'prompt\ninjection', '', 42]) {
      const bad = toLedgerEvent({ agentId: 'donna', type: 'action', action: 'RUN_READY', trigger: badTrigger });
      assert.equal(bad.trigger, undefined);
    }
  });
});

describe('owner conversion fields (S18)', () => {
  it('keeps well-formed legacyOwner, principalId, and role', () => {
    const ok = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'OWNER_CONVERTED',
      actor: 'admin@example.com',
      legacyOwner: 'cloudflare:dale@example.com',
      principalId: 'user:dale',
      role: 'content-owner',
    });
    assert.equal(ok.legacyOwner, 'cloudflare:dale@example.com');
    assert.equal(ok.principalId, 'user:dale');
    assert.equal(ok.role, 'content-owner');

    const bad = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'OWNER_CONVERTED',
      legacyOwner: 'free text with spaces',
      principalId: 'bad principal <script>',
      role: 'Invalid Role With Spaces',
    });
    assert.equal(bad.legacyOwner, undefined);
    assert.equal(bad.principalId, undefined);
    assert.equal(bad.role, undefined);
  });

  it('keeps RFC 5322 apostrophe emails and 265-char cloudflare emails, while rejecting fk_ tokens and prefixless strings (F5)', () => {
    const oconnor = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'OWNER_CONVERTED',
      legacyOwner: "cloudflare:o'connor@example.com",
      principalId: "user:o'connor@example.com",
      subject: "user:o'connor@example.com",
      role: 'content-owner',
    });
    assert.equal(oconnor.legacyOwner, "cloudflare:o'connor@example.com");
    assert.equal(oconnor.principalId, "user:o'connor@example.com");
    assert.equal(oconnor.subject, "user:o'connor@example.com");

    const rawEmail = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'OWNER_CONVERTED',
      legacyOwner: "o'connor@example.com",
    });
    assert.equal(rawEmail.legacyOwner, "o'connor@example.com");

    // 254-char email prefixed with 'cloudflare:' = 265 chars (under 320 max)
    const longLocal = 'a'.repeat(64);
    const longDomain = `${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.com`;
    const longEmail = `${longLocal}@${longDomain}`;
    const longPrefixed = `cloudflare:${longEmail}`;
    const longEvent = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'OWNER_CONVERTED',
      legacyOwner: longPrefixed,
      principalId: `user:${longEmail}`,
      subject: `user:${longEmail}`,
    });
    assert.equal(longEvent.legacyOwner, longPrefixed);
    assert.equal(longEvent.principalId, `user:${longEmail}`);
    assert.equal(longEvent.subject, `user:${longEmail}`);

    // Reject fk_ tokens and prefixless strings
    const rejected = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'OWNER_CONVERTED',
      legacyOwner: 'fk_live_abc123secrettoken',
      principalId: 'fk_live_abc123secrettoken',
      subject: 'fk_live_abc123secrettoken',
    });
    assert.equal(rejected.legacyOwner, undefined);
    assert.equal(rejected.principalId, undefined);
    assert.equal(rejected.subject, undefined);

    const prefixless = toLedgerEvent({
      agentId: 'donna',
      type: 'action',
      action: 'OWNER_CONVERTED',
      legacyOwner: 'just_a_bare_token_without_at_or_prefix',
      principalId: 'dale@example.com', // lacks user: prefix
      subject: 'bare_subject',
    });
    assert.equal(prefixless.legacyOwner, undefined);
    assert.equal(prefixless.principalId, undefined);
    assert.equal(prefixless.subject, undefined);
  });
});

