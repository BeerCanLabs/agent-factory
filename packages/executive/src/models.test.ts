import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ModelUpstreamError, bedrockConverse, fromConverse, parseModelCatalog, toConverse, type CatalogEntry, type ChatRequest } from './models.js';
import { signV4 } from './sigv4.js';

describe('model catalog and translation', () => {
  it('rejects a malformed catalog', () => {
    assert.throws(() => parseModelCatalog('[]'));
    assert.throws(() => parseModelCatalog('{"x":{"provider":"bedrock-converse"}}'), /needs provider and id/);
    assert.deepEqual(parseModelCatalog(undefined), {});
  });

  it('merges consecutive same-role turns for Converse', () => {
    const body = toConverse({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'c' },
      ],
    });
    assert.deepEqual(body, {
      messages: [
        { role: 'user', content: [{ text: 'a' }, { text: 'b' }] },
        { role: 'assistant', content: [{ text: 'c' }] },
      ],
    });
  });
});

describe('Converse response mapping', () => {
  it('joins the text blocks, ignores the others, and reads usage', () => {
    const r = fromConverse({
      output: { message: { content: [{ text: 'Hello, ' }, { toolUse: { name: 'x' } }, { text: 'Dale.' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    assert.deepEqual(r, { content: 'Hello, Dale.', finishReason: 'stop', usage: { input: 12, output: 3 } });
  });

  it('maps every Converse stop reason to an OpenAI finish_reason, defaulting to stop', () => {
    const reason = (stopReason?: string) => fromConverse({ output: { message: { content: [] } }, stopReason }).finishReason;
    assert.equal(reason('end_turn'), 'stop');
    assert.equal(reason('stop_sequence'), 'stop');
    assert.equal(reason('max_tokens'), 'length');
    assert.equal(reason('tool_use'), 'tool_calls');
    assert.equal(reason('guardrail_intervened'), 'content_filter');
    assert.equal(reason('content_filtered'), 'content_filter');
    assert.equal(reason('something_new'), 'stop');
    assert.equal(reason(undefined), 'stop');
  });

  it('reports no usage unless both counts are numbers, and survives a malformed body', () => {
    assert.equal(fromConverse({ output: { message: { content: [{ text: 'a' }] } } }).usage, null);
    assert.equal(fromConverse({ usage: { inputTokens: '1', outputTokens: 2 } }).usage, null);
    assert.deepEqual(fromConverse(undefined), { content: '', finishReason: 'stop', usage: null });
    assert.deepEqual(fromConverse('nope'), { content: '', finishReason: 'stop', usage: null });
  });
});

describe('bedrock-converse adapter', () => {
  const CREDS = { accessKeyId: 'AKIDEXECUTIVE', secretAccessKey: 'executive-secret-key', sessionToken: 'executive-session' };
  const ENTRY: CatalogEntry = { provider: 'bedrock-converse', id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', region: 'us-east-1' };
  const REQ: ChatRequest = { messages: [{ role: 'system', content: 'You are Donna.' }, { role: 'user', content: 'hello' }], maxTokens: 256 };
  const OK = { output: { message: { content: [{ text: 'Hi.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } };

  type Sent = { url: URL; init: RequestInit };
  const upstream = (status: number, body: unknown, sent: Sent[] = []): typeof fetch =>
    (async (url: URL, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const adapter = (f: typeof fetch, creds = async () => CREDS) => bedrockConverse({ credentials: creds, endpoint: (region) => `https://bedrock.test/${region}/`, fetch: f });
  const fails = (p: Promise<unknown>, status: number, code: string, upstreamStatus?: number) =>
    assert.rejects(p, (e: unknown) => e instanceof ModelUpstreamError && e.status === status && e.code === code && e.upstreamStatus === upstreamStatus);

  it('posts the translated request to the model, signed for the bedrock service, and returns the mapped result', async () => {
    const sent: Sent[] = [];
    const result = await adapter(upstream(200, OK, sent)).complete(ENTRY, REQ);
    assert.deepEqual(result, { content: 'Hi.', finishReason: 'stop', usage: { input: 5, output: 1 } });

    assert.equal(sent.length, 1);
    const { url, init } = sent[0];
    assert.equal(url.href, `https://bedrock.test/us-east-1/model/${encodeURIComponent(ENTRY.id)}/converse`);
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), toConverse(REQ));

    const h = init.headers as Record<string, string>;
    assert.equal(h['host'], undefined, 'fetch sets the host itself');
    assert.equal(h['x-amz-security-token'], CREDS.sessionToken);
    assert.equal(h['content-type'], 'application/json');
    // The signature is the one signV4 gives for exactly what was sent.
    const d = h['x-amz-date'];
    const when = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
    const expected = signV4(
      { method: 'POST', url, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: String(init.body) },
      CREDS,
      { region: 'us-east-1', service: 'bedrock' },
      when,
      { contentSha256Header: true },
    );
    assert.equal(h['authorization'], expected['authorization']);
    assert.match(h['authorization'], /^AWS4-HMAC-SHA256 Credential=AKIDEXECUTIVE\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
  });

  it('has no region to call and says so, rather than guessing one', async () => {
    const saved = { r: process.env.AWS_REGION, d: process.env.AWS_DEFAULT_REGION };
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      const { region: _omit, ...noRegion } = ENTRY;
      await fails(adapter(upstream(200, OK)).complete(noRegion, REQ), 503, 'provider_misconfigured');
    } finally {
      if (saved.r !== undefined) process.env.AWS_REGION = saved.r;
      if (saved.d !== undefined) process.env.AWS_DEFAULT_REGION = saved.d;
    }
  });

  it('does not repeat the credential failure to the agent', async (t) => {
    t.mock.method(console, 'error', () => {});
    const broken = async () => {
      throw new Error('imds said: secret-detail-0000');
    };
    await assert.rejects(adapter(upstream(200, OK), broken).complete(ENTRY, REQ), (e: unknown) => {
      return e instanceof ModelUpstreamError && e.status === 503 && e.code === 'provider_credentials_unavailable' && !e.message.includes('secret-detail-0000');
    });
  });

  it('maps provider throttling to 429 and other failures to 502, keeping the upstream status', async () => {
    await fails(adapter(upstream(429, { message: 'Too many requests, please wait.' })).complete(ENTRY, REQ), 429, 'upstream_throttled', 429);
    await fails(adapter(upstream(500, { message: 'boom' })).complete(ENTRY, REQ), 502, 'upstream_error', 500);
    await assert.rejects(adapter(upstream(429, { message: 'Too many requests, please wait.' })).complete(ENTRY, REQ), /Too many requests/);
  });

  it('falls back to the raw body when an error is not JSON, and caps what it repeats', async () => {
    await assert.rejects(adapter(upstream(503, 'upstream is down')).complete(ENTRY, REQ), /upstream is down/);
    await assert.rejects(adapter(upstream(500, { message: 'x'.repeat(2000) })).complete(ENTRY, REQ), (e: unknown) => e instanceof Error && e.message.length === 500);
  });

  it('reports an unreachable provider as a 502', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await fails(adapter(down).complete(ENTRY, REQ), 502, 'upstream_unreachable');
  });
});
