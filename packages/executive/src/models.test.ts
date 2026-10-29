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

  it('translates tools and tool_choice to Bedrock Converse toolConfig', () => {
    const body = toConverse({
      messages: [{ role: 'user', content: 'post to x' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'publish_to_x',
            description: 'Publish a post to X',
            parameters: {
              type: 'object',
              properties: { content: { type: 'string' } },
              required: ['content'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    });
    assert.deepEqual(body.toolConfig, {
      tools: [
        {
          toolSpec: {
            name: 'publish_to_x',
            description: 'Publish a post to X',
            inputSchema: {
              json: {
                type: 'object',
                properties: { content: { type: 'string' } },
                required: ['content'],
              },
            },
          },
        },
      ],
      toolChoice: { auto: {} },
    });
  });
});

describe('Converse response mapping', () => {
  it('joins the text blocks, ignores unrecognized blocks, and reads usage', () => {
    const r = fromConverse({
      output: { message: { content: [{ text: 'Hello, ' }, { unknownBlock: { foo: 'bar' } }, { text: 'Dale.' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    assert.deepEqual(r, { content: 'Hello, Dale.', finishReason: 'stop', usage: { input: 12, output: 3 } });
  });

  it('extracts toolUse blocks into structured toolCalls with arguments and tool_calls finish_reason', () => {
    const r = fromConverse({
      output: {
        message: {
          content: [
            { text: 'Let me check that.' },
            { toolUse: { toolUseId: 'call_123', name: 'publish_to_x', input: { content: 'hello world' } } },
          ],
        },
      },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    assert.deepEqual(r, {
      content: 'Let me check that.',
      finishReason: 'tool_calls',
      usage: { input: 20, output: 10 },
      toolCalls: [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'publish_to_x',
            arguments: JSON.stringify({ content: 'hello world' }),
          },
        },
      ],
    });
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

describe('Vertex AI and API-key model adapters (M1–M3)', () => {
  const REQ: ChatRequest = {
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Say hi.' },
    ],
    maxTokens: 128,
  };

  it('vertexGemini translates OpenAI ChatRequest to generateContent and maps usageMetadata', async () => {
    const { vertexGemini } = await import('./models.js');
    let calledUrl = '';
    let sentBody: unknown;
    const adapter = vertexGemini({
      project: 'gcp-proj-1',
      accessToken: async () => 'ya29-vertex',
      endpoint: (r) => `https://${r}.vertex.test`,
      fetch: (async (url: string, init: RequestInit) => {
        calledUrl = String(url);
        sentBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'Hello from Gemini!' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const res = await adapter.complete({ provider: 'vertex-ai', id: 'gemini-2.5-pro', region: 'us-central1' }, REQ);
    assert.deepEqual(res, { content: 'Hello from Gemini!', finishReason: 'stop', usage: { input: 9, output: 4 } });
    assert.equal(calledUrl, 'https://us-central1.vertex.test/v1/projects/gcp-proj-1/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent');
    assert.deepEqual(sentBody, {
      contents: [{ role: 'user', parts: [{ text: 'Say hi.' }] }],
      systemInstruction: { parts: [{ text: 'You are helpful.' }] },
      generationConfig: { maxOutputTokens: 128 },
    });
  });

  it('vertexAnthropic calls rawPredict with vertex-2023-10-16 and maps Anthropic usage', async () => {
    const { vertexAnthropic } = await import('./models.js');
    let calledUrl = '';
    const adapter = vertexAnthropic({
      project: 'gcp-proj-1',
      accessToken: async () => 'ya29-vertex',
      endpoint: (r) => `https://${r}.vertex.test`,
      fetch: (async (url: string) => {
        calledUrl = String(url);
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Hello from Vertex Claude!' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 11, output_tokens: 5 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const res = await adapter.complete({ provider: 'vertex-anthropic', id: 'claude-sonnet-4-5@20250929', region: 'us-east5' }, REQ);
    assert.deepEqual(res, { content: 'Hello from Vertex Claude!', finishReason: 'stop', usage: { input: 11, output: 5 } });
    assert.equal(calledUrl, 'https://us-east5.vertex.test/v1/projects/gcp-proj-1/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5%4020250929:rawPredict');
  });

  it('anthropicMessages and openAiCompatible adapters call direct provider endpoints with API keys', async () => {
    const { anthropicMessages, openAiCompatible, defaultModelAdapters } = await import('./models.js');
    const claude = anthropicMessages({
      apiKey: async () => 'sk-ant-test',
      endpoint: 'https://anthropic.test',
      fetch: (async (_url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        assert.equal(h['x-api-key'], 'sk-ant-test');
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Direct Claude' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 7, output_tokens: 2 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(await claude.complete({ provider: 'anthropic', id: 'claude-sonnet-4-5' }, REQ), {
      content: 'Direct Claude',
      finishReason: 'stop',
      usage: { input: 7, output: 2 },
    });

    const grok = openAiCompatible({
      apiKey: async () => 'xai-test',
      endpoint: 'https://xai.test',
      fetch: (async (_url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        assert.equal(h['Authorization'], 'Bearer xai-test');
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Direct Grok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 8, completion_tokens: 3 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(await grok.complete({ provider: 'xai', id: 'grok-4' }, REQ), {
      content: 'Direct Grok',
      finishReason: 'stop',
      usage: { input: 8, output: 3 },
    });

    const defaults = defaultModelAdapters();
    for (const key of ['bedrock-converse', 'vertex-ai', 'vertex-gemini', 'vertex-anthropic', 'anthropic', 'openai', 'xai', 'gemini', 'google']) {
      assert.ok(defaults[key], `defaultModelAdapters includes ${key}`);
    }
  });

  it('defaultModelAdapters wires resolveSecret into anthropic and openAi adapters', async () => {
    const { defaultModelAdapters } = await import('./models.js');
    const resolved: string[] = [];
    const adapters = defaultModelAdapters({
      resolveSecret: async (name) => {
        resolved.push(name);
        return `secret-for-${name}`;
      },
      fetch: (async (url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        if (url.includes('anthropic.com')) {
          assert.equal(h['x-api-key'], 'secret-for-ANTHROPIC_API_KEY');
          return new Response(
            JSON.stringify({
              content: [{ type: 'text', text: 'Anthropic ok' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 5, output_tokens: 1 },
            }),
            { status: 200 },
          );
        }
        if (url.includes('openai.com')) {
          assert.equal(h['Authorization'], 'Bearer secret-for-OPENAI_API_KEY');
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: 'OpenAI ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 6, completion_tokens: 2 },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected url ${url}`);
      }) as unknown as typeof fetch,
    });

    const anthropicRes = await adapters['anthropic'].complete({ provider: 'anthropic', id: 'claude-3-5-haiku' }, REQ);
    assert.equal(anthropicRes.content, 'Anthropic ok');
    assert.ok(resolved.includes('ANTHROPIC_API_KEY'));

    const openaiRes = await adapters['openai'].complete({ provider: 'openai', id: 'gpt-4o' }, REQ);
    assert.equal(openaiRes.content, 'OpenAI ok');
    assert.ok(resolved.includes('OPENAI_API_KEY'));

    let customSecretUsed = '';
    const customAdapters = defaultModelAdapters({
      resolveSecret: async (name) => {
        customSecretUsed = name;
        return 'custom-key';
      },
      fetch: (async (_url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string>;
        assert.equal(h['x-api-key'], 'custom-key');
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'Custom secret ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    await customAdapters['anthropic'].complete({ provider: 'anthropic', id: 'claude-test', secret: 'MY_CUSTOM_ANTHROPIC_KEY' }, REQ);
    assert.equal(customSecretUsed, 'MY_CUSTOM_ANTHROPIC_KEY');

    // Verify entry.secret is also respected when opts.resolveSecret is omitted (resolving via resolveProviderSecret)
    const { anthropicMessages: standaloneAnthropic } = await import('./models.js');
    const origEnv = process.env.STANDALONE_CUSTOM_SECRET;
    process.env.STANDALONE_CUSTOM_SECRET = 'standalone-env-key';
    try {
      let standaloneHeaderKey = '';
      const standalone = standaloneAnthropic({
        fetch: (async (_url: string, init: RequestInit) => {
          const h = init.headers as Record<string, string>;
          standaloneHeaderKey = h['x-api-key'];
          return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }), { status: 200 });
        }) as unknown as typeof fetch,
      });
      await standalone.complete({ provider: 'anthropic', id: 'claude-test', secret: 'STANDALONE_CUSTOM_SECRET' }, REQ);
      assert.equal(standaloneHeaderKey, 'standalone-env-key');
    } finally {
      if (origEnv !== undefined) process.env.STANDALONE_CUSTOM_SECRET = origEnv;
      else delete process.env.STANDALONE_CUSTOM_SECRET;
    }
  });

  it('translates tools and parses tool_calls across OpenAI/xAI, Anthropic, and Google Gemini', async () => {
    const { openAiCompatible, anthropicMessages, vertexGemini } = await import('./models.js');

    const TOOL_REQ: ChatRequest = {
      messages: [{ role: 'user', content: 'What is the weather in Seattle?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather forecast',
            parameters: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        },
      ],
      tool_choice: 'required',
    };

    // 1. OpenAI / xAI (openAiCompatible)
    let openaiBody: Record<string, unknown> | undefined;
    const openai = openAiCompatible({
      apiKey: async () => 'test-key',
      endpoint: 'https://api.openai.com',
      fetch: (async (_url: string, init: RequestInit) => {
        openaiBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_oa1',
                      type: 'function',
                      function: { name: 'get_weather', arguments: '{"location":"Seattle"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 8 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const openaiRes = await openai.complete({ provider: 'openai', id: 'gpt-4o' }, TOOL_REQ);
    assert.deepEqual(openaiRes.toolCalls, [
      {
        id: 'call_oa1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"Seattle"}' },
      },
    ]);
    assert.equal(openaiRes.finishReason, 'tool_calls');
    assert.deepEqual(openaiBody?.tools, TOOL_REQ.tools);
    assert.equal(openaiBody?.tool_choice, 'required');

    // 2. Anthropic (anthropicMessages)
    let anthropicBody: Record<string, unknown> | undefined;
    const anthropic = anthropicMessages({
      apiKey: async () => 'sk-ant-test',
      endpoint: 'https://api.anthropic.com',
      fetch: (async (_url: string, init: RequestInit) => {
        anthropicBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            content: [
              { type: 'text', text: 'Checking the forecast...' },
              { type: 'tool_use', id: 'toolu_123', name: 'get_weather', input: { location: 'Seattle' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 18, output_tokens: 12 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const anthropicRes = await anthropic.complete({ provider: 'anthropic', id: 'claude-3-7-sonnet' }, TOOL_REQ);
    assert.equal(anthropicRes.content, 'Checking the forecast...');
    assert.equal(anthropicRes.finishReason, 'tool_calls');
    assert.deepEqual(anthropicRes.toolCalls, [
      {
        id: 'toolu_123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"Seattle"}' },
      },
    ]);
    assert.deepEqual(anthropicBody?.tools, [
      {
        name: 'get_weather',
        description: 'Get weather forecast',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    ]);
    assert.deepEqual(anthropicBody?.tool_choice, { type: 'any' });

    // 3. Google Gemini (vertexGemini)
    let geminiBody: Record<string, unknown> | undefined;
    const gemini = vertexGemini({
      project: 'gcp-proj-1',
      accessToken: async () => 'ya29-token',
      endpoint: (r) => `https://${r}.vertex.test`,
      fetch: (async (_url: string, init: RequestInit) => {
        geminiBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { functionCall: { name: 'get_weather', args: { location: 'Seattle' } } },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 14, candidatesTokenCount: 6 },
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });

    const geminiRes = await gemini.complete({ provider: 'vertex-ai', id: 'gemini-2.5-pro' }, TOOL_REQ);
    assert.equal(geminiRes.finishReason, 'tool_calls');
    assert.equal(geminiRes.toolCalls?.length, 1);
    assert.equal(geminiRes.toolCalls?.[0].function.name, 'get_weather');
    assert.equal(geminiRes.toolCalls?.[0].function.arguments, '{"location":"Seattle"}');
    assert.deepEqual(geminiBody?.tools, [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get weather forecast',
            parameters: {
              type: 'object',
              properties: { location: { type: 'string' } },
              required: ['location'],
            },
          },
        ],
      },
    ]);
    assert.deepEqual(geminiBody?.toolConfig, {
      functionCallingConfig: { mode: 'ANY' },
    });
  });

  it('honors tool_choice: "none" across providers by suppressing tool declarations or enforcing mode NONE', async () => {
    const { openAiCompatible, anthropicMessages, toAnthropicMessages, vertexGemini, toConverse } = await import('./models.js');

    const NONE_REQ: ChatRequest = {
      messages: [{ role: 'user', content: 'What is 2 + 2?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'calculate',
            description: 'Calculator',
            parameters: { type: 'object', properties: { expr: { type: 'string' } } },
          },
        },
      ],
      tool_choice: 'none',
    };

    // 1. Bedrock Converse (toConverse) omits toolConfig completely
    const converseBody = toConverse(NONE_REQ);
    assert.equal(converseBody.toolConfig, undefined);

    // 2. Anthropic (toAnthropicMessages / anthropicMessages) omits tools and tool_choice
    const anthropicMsg = toAnthropicMessages(NONE_REQ);
    assert.equal((anthropicMsg as Record<string, unknown>).tools, undefined);
    assert.equal((anthropicMsg as Record<string, unknown>).tool_choice, undefined);

    let anthropicBody: Record<string, unknown> | undefined;
    const anthropic = anthropicMessages({
      apiKey: async () => 'sk-ant-test',
      endpoint: 'https://api.anthropic.com',
      fetch: (async (_url: string, init: RequestInit) => {
        anthropicBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '4' }],
            stop_reason: 'end_turn',
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const antRes = await anthropic.complete({ provider: 'anthropic', id: 'claude-3-7-sonnet' }, NONE_REQ);
    assert.equal(antRes.content, '4');
    assert.equal(antRes.finishReason, 'stop');
    assert.equal(antRes.toolCalls, undefined);
    assert.equal(anthropicBody?.tools, undefined);
    assert.equal(anthropicBody?.tool_choice, undefined);

    // 3. Google Gemini (vertexGemini) omits tools and sets toolConfig.functionCallingConfig.mode = 'NONE'
    let geminiBody: Record<string, unknown> | undefined;
    const gemini = vertexGemini({
      project: 'gcp-proj-1',
      accessToken: async () => 'ya29-token',
      endpoint: (r) => `https://${r}.vertex.test`,
      fetch: (async (_url: string, init: RequestInit) => {
        geminiBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: '4' }] },
                finishReason: 'STOP',
              },
            ],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const gemRes = await gemini.complete({ provider: 'vertex-ai', id: 'gemini-2.5-pro' }, NONE_REQ);
    assert.equal(gemRes.content, '4');
    assert.equal(gemRes.finishReason, 'stop');
    assert.equal(gemRes.toolCalls, undefined);
    assert.equal(geminiBody?.tools, undefined);
    assert.deepEqual(geminiBody?.toolConfig, {
      functionCallingConfig: { mode: 'NONE' },
    });

    // 4. OpenAI / xAI (openAiCompatible) passes tool_choice: 'none' and tools
    let openaiBody: Record<string, unknown> | undefined;
    const openai = openAiCompatible({
      apiKey: async () => 'test-key',
      endpoint: 'https://api.openai.com',
      fetch: (async (_url: string, init: RequestInit) => {
        openaiBody = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '4' }, finish_reason: 'stop' }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const oaiRes = await openai.complete({ provider: 'openai', id: 'gpt-4o' }, NONE_REQ);
    assert.equal(oaiRes.content, '4');
    assert.equal(oaiRes.finishReason, 'stop');
    assert.equal(oaiRes.toolCalls, undefined);
    assert.deepEqual(openaiBody?.tools, NONE_REQ.tools);
    assert.equal(openaiBody?.tool_choice, 'none');
  });
});



describe('sampling parameters for Claude models (GAP-171, M3)', () => {
  const SAMPLED: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, temperature: 0.7, topP: 0.9 };

  it('accepts sampling on Claude 4.6 and earlier, and rejects it from Opus 4.7 on or for unknown Claude ids', async () => {
    const { claudeAcceptsSampling } = await import('./models.js');
    const accepts = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-20250514', 'claude-opus-4-5@20251101',
      'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-3-5-sonnet-20241022', 'claude-3-opus-20240229'];
    const rejects = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-7',
      'claude-opus-4-8', 'anthropic.claude-haiku-5-5', 'claude-fable-5-1', 'claude-mythos-5-1'];
    for (const id of accepts) assert.equal(claudeAcceptsSampling(id), true, id);
    for (const id of rejects) assert.equal(claudeAcceptsSampling(id), false, id);
  });

  it('toAnthropicMessages drops temperature and top_p only for models that reject them', async () => {
    const { toAnthropicMessages } = await import('./models.js');
    const modern = toAnthropicMessages(SAMPLED, 'claude-haiku-5-5') as Record<string, unknown>;
    assert.equal('temperature' in modern, false);
    assert.equal('top_p' in modern, false);
    const legacy = toAnthropicMessages(SAMPLED, 'claude-sonnet-4-6') as Record<string, unknown>;
    assert.equal(legacy.temperature, 0.7);
    assert.equal(legacy.top_p, 0.9);
  });

  it('toConverse drops sampling for new Claude models on Bedrock and keeps it for other Bedrock models', () => {
    assert.deepEqual(toConverse(SAMPLED, 'us.anthropic.claude-sonnet-5-5').inferenceConfig, { maxTokens: 64 });
    assert.deepEqual(toConverse(SAMPLED, 'meta.llama3-70b-instruct-v1:0').inferenceConfig, { maxTokens: 64, temperature: 0.7, topP: 0.9 });
    assert.deepEqual(toConverse(SAMPLED, 'anthropic.claude-haiku-4-5').inferenceConfig, { maxTokens: 64, temperature: 0.7, topP: 0.9 });
  });

  it('the anthropic adapter never sends temperature to a Claude 5.5 model', async () => {
    const { anthropicMessages } = await import('./models.js');
    let sent: Record<string, unknown> = {};
    const adapter = anthropicMessages({
      apiKey: async () => 'test-key',
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await adapter.complete({ provider: 'anthropic', id: 'claude-haiku-5-5' }, SAMPLED);
    assert.equal(sent.model, 'claude-haiku-5-5');
    assert.equal('temperature' in sent, false);
    assert.equal('top_p' in sent, false);
  });
});

describe('tool calls and tool results in the factory model API (GAP-173, M1, M3)', () => {
  // Rosie's second turn in prod: the model asked for a tool, and the agent returns its result.
  const BODY = {
    model: 'claude-haiku-5-5',
    messages: [
      { role: 'system', content: 'You are Rosie.' },
      { role: 'user', content: 'hey Rosie' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'get_kitty_litter_status', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'toolu_01', content: '{"level":"clean"}' },
    ],
    tools: [{ type: 'function', function: { name: 'get_kitty_litter_status', parameters: { type: 'object', properties: {} } } }],
  };

  async function parsed() {
    const { parseChatRequest } = await import('./models.js');
    const out = parseChatRequest(BODY as unknown as Record<string, unknown>);
    assert.equal(out.ok, true, JSON.stringify(out));
    return (out as { ok: true; req: ChatRequest }).req;
  }

  it('accepts an assistant tool call with null content and the tool result that answers it', async () => {
    const req = await parsed();
    assert.deepEqual(req.messages.slice(2), [
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_01', type: 'function', function: { name: 'get_kitty_litter_status', arguments: '{}' } }] },
      { role: 'tool', content: '{"level":"clean"}', toolCallId: 'toolu_01' },
    ]);
  });

  it('refuses malformed tool messages with a reason', async () => {
    const { parseChatRequest } = await import('./models.js');
    assert.deepEqual(parseChatRequest({ messages: [{ role: 'tool', content: 'x' }] }), { ok: false, error: 'invalid_tool_message' });
    assert.deepEqual(parseChatRequest({ messages: [{ role: 'assistant', content: null, tool_calls: [{ function: { name: 'f' } }] }] }), { ok: false, error: 'invalid_tool_calls' });
    assert.deepEqual(parseChatRequest({ messages: [{ role: 'assistant', content: null }] }), { ok: false, error: 'unsupported_content' });
  });

  it('translates to Anthropic tool_use and tool_result blocks', async () => {
    const { toAnthropicMessages } = await import('./models.js');
    const out = toAnthropicMessages(await parsed(), 'claude-haiku-5-5') as { system: string; messages: unknown[] };
    assert.equal(out.system, 'You are Rosie.');
    assert.deepEqual(out.messages, [
      { role: 'user', content: 'hey Rosie' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'get_kitty_litter_status', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '{"level":"clean"}' }] },
    ]);
  });

  it('merges parallel tool results into one Anthropic user turn, results first', async () => {
    const { parseChatRequest, toAnthropicMessages } = await import('./models.js');
    const out = parseChatRequest({
      messages: [
        { role: 'user', content: 'status?' },
        { role: 'assistant', content: 'Checking.', tool_calls: [
          { id: 'a', type: 'function', function: { name: 'f', arguments: '{"x":1}' } },
          { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'a', content: 'A' },
        { role: 'tool', tool_call_id: 'b', content: 'B' },
        { role: 'user', content: 'and?' },
      ],
    });
    assert.equal(out.ok, true);
    const msgs = (toAnthropicMessages((out as { ok: true; req: ChatRequest }).req) as { messages: unknown[] }).messages;
    assert.deepEqual(msgs, [
      { role: 'user', content: 'status?' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'a', name: 'f', input: { x: 1 } },
        { type: 'tool_use', id: 'b', name: 'g', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'A' },
        { type: 'tool_result', tool_use_id: 'b', content: 'B' },
        { type: 'text', text: 'and?' },
      ] },
    ]);
  });

  it('translates to Bedrock Converse toolUse and toolResult', async () => {
    const out = toConverse(await parsed(), 'us.anthropic.claude-haiku-5-5');
    assert.deepEqual(out.messages, [
      { role: 'user', content: [{ text: 'hey Rosie' }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 'toolu_01', name: 'get_kitty_litter_status', input: {} } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'toolu_01', content: [{ text: '{"level":"clean"}' }] } }] },
    ]);
  });

  it('translates to Gemini functionCall and functionResponse, matching the result to its call by name', async () => {
    const { vertexGemini } = await import('./models.js');
    let sent: { contents?: unknown } = {};
    const adapter = vertexGemini({
      project: 'p',
      accessToken: async () => 't',
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'All clean!' }] }, finishReason: 'STOP' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await adapter.complete({ provider: 'vertex-gemini', id: 'gemini-2.5-flash' }, await parsed());
    assert.deepEqual(sent.contents, [
      { role: 'user', parts: [{ text: 'hey Rosie' }] },
      // Unsigned cross-model tool call gets Google's placeholder on the first functionCall part (GAP-213).
      { role: 'model', parts: [{ functionCall: { name: 'get_kitty_litter_status', args: {} }, thoughtSignature: 'skip_thought_signature_validator' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'get_kitty_litter_status', response: { content: '{"level":"clean"}' } } }] },
    ]);
  });

  it('sends OpenAI-compatible providers the OpenAI wire format back', async () => {
    const { openAiCompatible } = await import('./models.js');
    let sent: { messages?: unknown } = {};
    const adapter = openAiCompatible({
      apiKey: async () => 'k',
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await adapter.complete({ provider: 'openai', id: 'gpt-x' }, await parsed());
    assert.deepEqual(sent.messages, [
      { role: 'system', content: 'You are Rosie.' },
      { role: 'user', content: 'hey Rosie' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'get_kitty_litter_status', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'toolu_01', content: '{"level":"clean"}' },
    ]);
  });
});

describe('model capability profile (GAP-175, M1, M3)', () => {
  const FORCED: ChatRequest = {
    messages: [{ role: 'user', content: 'check the litter box' }],
    tools: [{ type: 'function', function: { name: 'get_kitty_litter_status', parameters: { type: 'object', properties: {} } } }],
    tool_choice: 'required',
  };
  const NAMED: ChatRequest = { ...FORCED, tool_choice: { type: 'function', function: { name: 'get_kitty_litter_status' } } };

  it('knows which models accept sampling and forced tool choice', async () => {
    const { modelCapabilities } = await import('./models.js');
    const table: Array<[string, boolean, boolean]> = [
      // id, sampling, forcedToolChoice
      ['claude-haiku-4-5', true, true],
      ['claude-sonnet-4-6', true, true],
      ['claude-opus-4-6', true, true],
      ['claude-sonnet-4-20250514', true, true],
      ['claude-3-5-sonnet-20241022', true, true],
      ['claude-opus-4-7', false, true],
      ['claude-opus-4-8', false, true],
      ['claude-opus-5', false, true],
      ['claude-sonnet-5', false, true],
      ['claude-haiku-5-5', false, true],
      ['anthropic.claude-haiku-5-5', false, true],
      ['claude-opus-5-5', false, false],
      ['claude-sonnet-5-5', false, false],
      ['us.anthropic.claude-sonnet-5-5', false, false],
      ['claude-fable-5', false, true],
      ['claude-fable-5-1', false, false],
      ['claude-mythos-5-1', false, false],
      ['claude-opus-6', false, false],
      ['claude-haiku-6', false, false],
      ['claude-something-new', false, false],
      ['gpt-4o', true, true],
      ['meta.llama3-70b-instruct-v1:0', true, true],
    ];
    for (const [id, sampling, forcedToolChoice] of table) {
      assert.deepEqual(modelCapabilities(id), { sampling, forcedToolChoice }, id);
    }
  });

  it('toAnthropicMessages sends auto instead of any/tool to models that reject forced tool choice', async () => {
    const { toAnthropicMessages } = await import('./models.js');
    const choice = (req: ChatRequest, id?: string) => (toAnthropicMessages(req, id) as { tool_choice?: unknown }).tool_choice;
    assert.deepEqual(choice(FORCED, 'claude-sonnet-5-5'), { type: 'auto' });
    assert.deepEqual(choice(NAMED, 'claude-opus-5-5'), { type: 'auto' });
    assert.deepEqual(choice(FORCED, 'claude-haiku-5-5'), { type: 'any' });
    assert.deepEqual(choice(NAMED, 'claude-sonnet-4-6'), { type: 'tool', name: 'get_kitty_litter_status' });
    assert.deepEqual(choice(FORCED), { type: 'any' });
  });

  it('toConverse sends auto to Claude models on Bedrock that reject forced tool choice, and leaves others alone', () => {
    assert.deepEqual(toConverse(FORCED, 'us.anthropic.claude-sonnet-5-5').toolConfig?.toolChoice, { auto: {} });
    assert.deepEqual(toConverse(NAMED, 'anthropic.claude-opus-5-5').toolConfig?.toolChoice, { auto: {} });
    assert.deepEqual(toConverse(FORCED, 'anthropic.claude-haiku-4-5').toolConfig?.toolChoice, { any: {} });
    assert.deepEqual(toConverse(NAMED, 'meta.llama3-70b-instruct-v1:0').toolConfig?.toolChoice, { tool: { name: 'get_kitty_litter_status' } });
  });

  it('the Vertex-Anthropic adapter sends auto for a model that rejects forced tool choice', async () => {
    const { vertexAnthropic } = await import('./models.js');
    let sent: { tool_choice?: unknown } = {};
    const adapter = vertexAnthropic({
      project: 'p',
      accessToken: async () => 't',
      fetch: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await adapter.complete({ provider: 'vertex-anthropic', id: 'claude-sonnet-5-5' }, FORCED);
    assert.deepEqual(sent.tool_choice, { type: 'auto' });
  });
});

describe('a key is never sent through a redirect (GAP-182 review)', () => {
  it('both API-key adapters refuse redirects', async () => {
    const { anthropicMessages, openAiCompatible } = await import('./models.js');
    const seen: Array<RequestInit['redirect']> = [];
    const doFetch = (async (_url: string, init: RequestInit) => {
      seen.push(init.redirect);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], stop_reason: 'end_turn' }), { status: 200 });
    }) as unknown as typeof fetch;
    const req: ChatRequest = { messages: [{ role: 'user', content: 'hi' }] };
    await anthropicMessages({ apiKey: async () => 'k', fetch: doFetch }).complete({ provider: 'anthropic', id: 'claude-haiku-5-5' }, req);
    await openAiCompatible({ apiKey: async () => 'k', fetch: doFetch }).complete({ provider: 'openai', id: 'gpt-x' }, req);
    assert.deepEqual(seen, ['error', 'error']);
  });
});

describe('Gemini thought signatures across tool-call turns (GAP-213, M1, M2, M3)', () => {
  const SKIP = 'skip_thought_signature_validator';
  const TOOLS = [{ type: 'function', function: { name: 'recall_conversation', parameters: { type: 'object', properties: {} } } }];

  function scripted(...answers: unknown[]) {
    const sent: Array<Record<string, any>> = [];
    const doFetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answers[sent.length - 1]), { status: 200 });
    }) as unknown as typeof fetch;
    return { sent, doFetch };
  }

  async function followUp(toolCalls: unknown[]) {
    const { parseChatRequest } = await import('./models.js');
    const out = parseChatRequest({
      messages: [
        { role: 'user', content: 'what did we decide yesterday?' },
        { role: 'assistant', content: null, tool_calls: toolCalls },
        ...toolCalls.map((tc, i) => ({
          role: 'tool',
          tool_call_id: (tc as { id: string }).id,
          content: `{"hit":${i}}`,
        })),
      ],
      tools: TOOLS,
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    return (out as { ok: true; req: ChatRequest }).req;
  }

  it('parseChatRequest preserves non-empty extra_content.google.thought_signature and strips malformed or extra fields', async () => {
    const { parseChatRequest } = await import('./models.js');
    const call = (extra_content: unknown, id = 'c1') => ({
      id,
      type: 'function',
      function: { name: 'recall_conversation', arguments: '{}' },
      ...(extra_content === undefined ? {} : { extra_content }),
    });
    const out = parseChatRequest({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            call({ google: { thought_signature: 'SIG_OK', extraGoogle: 'drop' }, extraTop: 'drop' }, 'c1'),
            call({ google: { thought_signature: '' } }, 'c2'),
            call({ google: { thought_signature: 123 } }, 'c3'),
            call({ google: null }, 'c4'),
            call('not-an-object', 'c5'),
            call(['array'], 'c6'),
            call({ other_vendor: { token: 'drop' } }, 'c7'),
            call(undefined, 'c8'),
          ],
        },
      ],
    });
    assert.equal(out.ok, true);
    const assistant = (out as { ok: true; req: ChatRequest }).req.messages[1];
    assert.equal(assistant.role, 'assistant');
    assert.deepEqual(assistant.toolCalls, [
      {
        id: 'c1',
        type: 'function',
        function: { name: 'recall_conversation', arguments: '{}' },
        extra_content: { google: { thought_signature: 'SIG_OK' } },
      },
      { id: 'c2', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
      { id: 'c3', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
      { id: 'c4', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
      { id: 'c5', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
      { id: 'c6', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
      { id: 'c7', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
      { id: 'c8', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
    ]);
  });

  it('vertexGemini round-trips thoughtSignature across parallel tool calls without copying onto unsigned siblings', async () => {
    const { vertexGemini } = await import('./models.js');
    const { sent, doFetch } = scripted(
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'recall_conversation', args: { q: 'a' } }, thoughtSignature: 'SIG_VERTEX_1' },
                { functionCall: { name: 'recall_conversation', args: { q: 'b' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 6 },
      },
      {
        candidates: [{ content: { parts: [{ text: 'We decided X.' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5 },
      },
    );

    const adapter = vertexGemini({ project: 'gcp-proj', accessToken: async () => 'tok', fetch: doFetch });
    const entry: CatalogEntry = { provider: 'vertex-gemini', id: 'gemini-4-argon', region: 'global' };

    const turn1 = await adapter.complete(entry, { messages: [{ role: 'user', content: 'what did we decide yesterday?' }], tools: TOOLS });
    assert.equal(turn1.finishReason, 'tool_calls');
    assert.equal(turn1.toolCalls?.length, 2);
    assert.deepEqual(turn1.toolCalls?.[0].extra_content, { google: { thought_signature: 'SIG_VERTEX_1' } });
    assert.equal(turn1.toolCalls?.[1].extra_content, undefined);

    // Agent echoes turn1.toolCalls back verbatim in the OpenAI request body on turn 2.
    const turn2Req = await followUp(JSON.parse(JSON.stringify(turn1.toolCalls)));
    const turn2 = await adapter.complete(entry, turn2Req);
    assert.equal(turn2.content, 'We decided X.');

    assert.deepEqual(sent[1].contents, [
      { role: 'user', parts: [{ text: 'what did we decide yesterday?' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'recall_conversation', args: { q: 'a' } }, thoughtSignature: 'SIG_VERTEX_1' },
          { functionCall: { name: 'recall_conversation', args: { q: 'b' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'recall_conversation', response: { content: '{"hit":0}' } } },
          { functionResponse: { name: 'recall_conversation', response: { content: '{"hit":1}' } } },
        ],
      },
    ]);
  });

  it('directGemini (openAiCompatible with googleThoughtSignatures: true) round-trips signatures across parallel tool calls', async () => {
    const { defaultModelAdapters, openAiCompatible } = await import('./models.js');
    const { sent, doFetch } = scripted(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_g1',
                  type: 'function',
                  function: { name: 'recall_conversation', arguments: '{"q":"a"}' },
                  extra_content: { google: { thought_signature: 'SIG_DIRECT_1' } },
                },
                {
                  id: 'call_g2',
                  type: 'function',
                  function: { name: 'recall_conversation', arguments: '{"q":"b"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 6 },
      },
      {
        choices: [{ message: { content: 'Done.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 18, completion_tokens: 2 },
      },
    );

    const adapters = defaultModelAdapters({ resolveSecret: async () => 'gem-key', fetch: doFetch });
    const entry: CatalogEntry = { provider: 'gemini', id: 'gemini-4-argon' };

    const turn1 = await adapters.gemini.complete(entry, { messages: [{ role: 'user', content: 'what did we decide yesterday?' }], tools: TOOLS });
    assert.deepEqual(turn1.toolCalls, [
      {
        id: 'call_g1',
        type: 'function',
        function: { name: 'recall_conversation', arguments: '{"q":"a"}' },
        extra_content: { google: { thought_signature: 'SIG_DIRECT_1' } },
      },
      {
        id: 'call_g2',
        type: 'function',
        function: { name: 'recall_conversation', arguments: '{"q":"b"}' },
      },
    ]);

    const turn2Req = await followUp(JSON.parse(JSON.stringify(turn1.toolCalls)));
    const turn2 = await adapters.google.complete({ provider: 'google', id: 'gemini-4-argon' }, turn2Req);
    assert.equal(turn2.content, 'Done.');

    assert.deepEqual(sent[1].messages[1], {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_g1',
          type: 'function',
          function: { name: 'recall_conversation', arguments: '{"q":"a"}' },
          extra_content: { google: { thought_signature: 'SIG_DIRECT_1' } },
        },
        {
          id: 'call_g2',
          type: 'function',
          function: { name: 'recall_conversation', arguments: '{"q":"b"}' },
        },
      ],
    });

    // Standalone openAiCompatible with googleThoughtSignatures: true behaves identically.
    const standalone = scripted({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    await openAiCompatible({ apiKey: async () => 'k', googleThoughtSignatures: true, fetch: standalone.doFetch }).complete(entry, turn2Req);
    assert.deepEqual(standalone.sent[0].messages[1], sent[1].messages[1]);
  });

  it('openai and xai adapters never include extra_content on outgoing tool_calls', async () => {
    const { defaultModelAdapters, openAiCompatible } = await import('./models.js');
    const req = await followUp([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'recall_conversation', arguments: '{}' },
        extra_content: { google: { thought_signature: 'SIG_FROM_GEMINI' } },
      },
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'recall_conversation', arguments: '{}' },
      },
    ]);

    for (const provider of ['openai', 'xai'] as const) {
      const { sent, doFetch } = scripted({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
      const adapters = defaultModelAdapters({ resolveSecret: async () => 'key', fetch: doFetch });
      await adapters[provider].complete({ provider, id: 'model-1' }, req);
      assert.deepEqual(
        sent[0].messages[1].tool_calls,
        [
          { id: 'call_1', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'recall_conversation', arguments: '{}' } },
        ],
        provider,
      );
      assert.equal(JSON.stringify(sent[0]).includes('extra_content'), false, provider);
    }

    const custom = scripted({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    await openAiCompatible({ apiKey: async () => 'key', fetch: custom.doFetch }).complete({ provider: 'openai', id: 'gpt-4o' }, req);
    assert.equal(JSON.stringify(custom.sent[0]).includes('extra_content'), false);
  });

  it('injects skip_thought_signature_validator on the first tool call of an unsigned assistant turn on both Gemini paths', async () => {
    const { parseChatRequest, vertexGemini, defaultModelAdapters } = await import('./models.js');
    const parsed = parseChatRequest({
      messages: [
        { role: 'user', content: 'step 1' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'toolu_2', type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'R1' },
        { role: 'tool', tool_call_id: 'toolu_2', content: 'R2' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'fc_3', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG_REAL' } } },
          ],
        },
        { role: 'tool', tool_call_id: 'fc_3', content: 'R3' },
      ],
    });
    assert.equal(parsed.ok, true);
    const req = (parsed as { ok: true; req: ChatRequest }).req;

    const vertex = scripted({ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] });
    await vertexGemini({ project: 'p', accessToken: async () => 't', fetch: vertex.doFetch }).complete(
      { provider: 'vertex-gemini', id: 'gemini-4-argon' },
      req,
    );
    const modelTurns = (vertex.sent[0].contents as Array<{ role: string; parts: unknown[] }>).filter((c) => c.role === 'model');
    assert.deepEqual(modelTurns, [
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'f', args: {} }, thoughtSignature: SKIP },
          { functionCall: { name: 'g', args: {} } },
        ],
      },
      {
        role: 'model',
        parts: [{ functionCall: { name: 'f', args: {} }, thoughtSignature: 'SIG_REAL' }],
      },
    ]);

    const direct = scripted({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] });
    await defaultModelAdapters({ resolveSecret: async () => 'k', fetch: direct.doFetch }).gemini.complete(
      { provider: 'gemini', id: 'gemini-4-argon' },
      req,
    );
    const assistantTurns = (direct.sent[0].messages as Array<{ role: string; tool_calls?: unknown[] }>).filter((m) => m.role === 'assistant');
    assert.deepEqual(
      assistantTurns.map((m) => m.tool_calls),
      [
        [
          { id: 'toolu_1', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: SKIP } } },
          { id: 'toolu_2', type: 'function', function: { name: 'g', arguments: '{}' } },
        ],
        [
          { id: 'fc_3', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG_REAL' } } },
        ],
      ],
    );
  });

  it('preserves per-part signatures when multiple parts in a turn carry their own signature without copying across unsigned parts', async () => {
    const { vertexGemini, toOpenAiMessages } = await import('./models.js');
    const req = await followUp([
      { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG_A' } } },
      { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } },
      { id: 'c', type: 'function', function: { name: 'h', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG_C' } } },
    ]);
    const { sent, doFetch } = scripted({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
    await vertexGemini({ project: 'p', accessToken: async () => 't', fetch: doFetch }).complete(
      { provider: 'vertex-gemini', id: 'gemini-4-argon' },
      req,
    );
    assert.deepEqual(sent[0].contents[1].parts, [
      { functionCall: { name: 'f', args: {} }, thoughtSignature: 'SIG_A' },
      { functionCall: { name: 'g', args: {} } },
      { functionCall: { name: 'h', args: {} }, thoughtSignature: 'SIG_C' },
    ]);
    const wire = toOpenAiMessages(req.messages, { googleThoughtSignatures: true })[1] as { tool_calls: Array<{ extra_content?: unknown }> };
    assert.deepEqual(
      wire.tool_calls.map((tc) => tc.extra_content),
      [{ google: { thought_signature: 'SIG_A' } }, undefined, { google: { thought_signature: 'SIG_C' } }],
    );
  });

  it('vertexGemini coalesces contiguous assistant messages without synthesizing placeholder signatures onto non-initial functionCalls', async () => {
    const { vertexGemini } = await import('./models.js');
    const entry: CatalogEntry = { provider: 'vertex-gemini', id: 'gemini-4-argon' };

    async function sendContents(messages: ChatRequest['messages']) {
      const { sent, doFetch } = scripted({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] });
      await vertexGemini({ project: 'p', accessToken: async () => 't', fetch: doFetch }).complete(entry, { messages, tools: TOOLS });
      return sent[0].contents;
    }

    // 1. [signed, unsigned] consecutive assistant tool-call messages merge into one model turn: only first carries SIG_1.
    assert.deepEqual(
      await sendContents([
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG_1' } } }],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }],
        },
        { role: 'tool', content: 'R1', toolCallId: 'c1' },
        { role: 'tool', content: 'R2', toolCallId: 'c2' },
      ]),
      [
        { role: 'user', parts: [{ text: 'q' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'f', args: {} }, thoughtSignature: 'SIG_1' },
            { functionCall: { name: 'g', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'f', response: { content: 'R1' } } },
            { functionResponse: { name: 'g', response: { content: 'R2' } } },
          ],
        },
      ],
    );

    // 2. [unsigned, unsigned] and [unsigned, system, unsigned]: only first functionCall in merged model turn gets SKIP.
    assert.deepEqual(
      await sendContents([
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }],
        },
        { role: 'tool', content: 'R1', toolCallId: 'c1' },
        { role: 'tool', content: 'R2', toolCallId: 'c2' },
      ]),
      [
        { role: 'user', parts: [{ text: 'q' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'f', args: {} }, thoughtSignature: SKIP },
            { functionCall: { name: 'g', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'f', response: { content: 'R1' } } },
            { functionResponse: { name: 'g', response: { content: 'R2' } } },
          ],
        },
      ],
    );
    assert.deepEqual(
      await sendContents([
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
        },
        { role: 'system', content: 'mid-conversation system note' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }],
        },
        { role: 'tool', content: 'R1', toolCallId: 'c1' },
        { role: 'tool', content: 'R2', toolCallId: 'c2' },
      ]),
      [
        { role: 'user', parts: [{ text: 'q' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'f', args: {} }, thoughtSignature: SKIP },
            { functionCall: { name: 'g', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'f', response: { content: 'R1' } } },
            { functionResponse: { name: 'g', response: { content: 'R2' } } },
          ],
        },
      ],
    );

    // 3. Text-only assistant followed by unsigned assistant tool-call message still places SKIP on the first functionCall only.
    assert.deepEqual(
      await sendContents([
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'Let me check.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } },
          ],
        },
        { role: 'tool', content: 'R1', toolCallId: 'c1' },
        { role: 'tool', content: 'R2', toolCallId: 'c2' },
      ]),
      [
        { role: 'user', parts: [{ text: 'q' }] },
        {
          role: 'model',
          parts: [
            { text: 'Let me check.' },
            { functionCall: { name: 'f', args: {} }, thoughtSignature: SKIP },
            { functionCall: { name: 'g', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { name: 'f', response: { content: 'R1' } } },
            { functionResponse: { name: 'g', response: { content: 'R2' } } },
          ],
        },
      ],
    );
  });
});

