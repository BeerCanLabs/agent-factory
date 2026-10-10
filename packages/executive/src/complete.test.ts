import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { complete, findModel } from './complete.js';
import { ModelUpstreamError, type CatalogEntry, type ChatRequest, type ChatResult, type ModelAdapter, type ModelCatalog } from './models.js';

const ENTRY: CatalogEntry = { provider: 'fake', id: 'fake-model-1', region: 'us-east-1' };
const BODY = { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 };
const RESULT: ChatResult = { content: 'Hi.', finishReason: 'stop', usage: { input: 5, output: 1 } };

/** An adapter that records what it was called with. */
const recording = (outcome: () => Promise<ChatResult>) => {
  const calls: Array<{ entry: CatalogEntry; req: ChatRequest }> = [];
  const adapter: ModelAdapter = {
    async complete(entry, req) {
      calls.push({ entry, req });
      return outcome();
    },
  };
  return { adapter, calls };
};

describe('findModel', () => {
  const catalog: ModelCatalog = { 'claude-sonnet-4-6': ENTRY };

  it('finds a model the catalog offers', () => {
    assert.equal(findModel(catalog, 'claude-sonnet-4-6'), ENTRY);
  });

  it('does not find a model it does not offer', () => {
    assert.equal(findModel(catalog, 'claude-sonnet-4-5'), undefined);
  });

  it('never treats an inherited object property as a model', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(findModel(catalog, name), undefined, name);
  });
});

describe('complete', () => {
  it('calls the provider\'s adapter with the entry and the parsed request, and returns both with the result', async () => {
    const { adapter, calls } = recording(async () => RESULT);
    const done = await complete({ entry: ENTRY, adapters: { fake: adapter }, body: BODY });
    assert.deepEqual(done, { ok: true, request: { messages: [{ role: 'user', content: 'hello' }], maxTokens: 64 }, result: RESULT });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].entry, ENTRY);
    assert.deepEqual(calls[0].req, { messages: [{ role: 'user', content: 'hello' }], maxTokens: 64 });
  });

  it('refuses a body that is not a valid chat request, with the reason, and calls no provider', async () => {
    const { adapter, calls } = recording(async () => RESULT);
    const adapters = { fake: adapter };
    assert.deepEqual(await complete({ entry: ENTRY, adapters, body: { model: 'm' } }), { ok: false, kind: 'refused', status: 400, code: 'messages_required' });
    assert.deepEqual(await complete({ entry: ENTRY, adapters, body: { model: 'm', messages: [{ role: 'tool', content: 'x' }] } }), {
      ok: false,
      kind: 'refused',
      status: 400,
      code: 'unsupported_role',
    });
    assert.equal(calls.length, 0);
  });

  it('refuses a provider it has no adapter for, naming the provider', async () => {
    assert.deepEqual(await complete({ entry: ENTRY, adapters: {}, body: BODY }), { ok: false, kind: 'refused', status: 503, code: 'provider_unavailable', detail: { provider: 'fake' } });
  });

  it('never treats an inherited object property as an adapter', async () => {
    const entry = { ...ENTRY, provider: 'constructor' };
    const done = await complete({ entry, adapters: {}, body: BODY });
    assert.deepEqual(done, { ok: false, kind: 'refused', status: 503, code: 'provider_unavailable', detail: { provider: 'constructor' } });
  });

  it('checks the body before the provider, so a bad body is reported even when the provider is also missing', async () => {
    const done = await complete({ entry: ENTRY, adapters: {}, body: { model: 'm' } });
    assert.deepEqual(done, { ok: false, kind: 'refused', status: 400, code: 'messages_required' });
  });

  it('returns an upstream failure as the adapter reported it, not rewritten', async () => {
    const failure = new ModelUpstreamError(429, 'upstream_throttled', 'Too many requests', 429);
    const { adapter } = recording(async () => {
      throw failure;
    });
    const done = await complete({ entry: ENTRY, adapters: { fake: adapter }, body: BODY });
    assert.equal(done.ok === false && done.kind === 'upstream' && done.error, failure);
  });

  it('wraps any other failure as a 502 upstream_error carrying its message', async () => {
    const boom = recording(async () => {
      throw new Error('socket hang up');
    });
    const done = await complete({ entry: ENTRY, adapters: { fake: boom.adapter }, body: BODY });
    assert.ok(done.ok === false && done.kind === 'upstream');
    assert.equal(done.error.status, 502);
    assert.equal(done.error.code, 'upstream_error');
    assert.equal(done.error.message, 'socket hang up');
    assert.ok(done.error instanceof ModelUpstreamError);

    const odd = recording(async () => {
      throw 'not an error object';
    });
    const done2 = await complete({ entry: ENTRY, adapters: { fake: odd.adapter }, body: BODY });
    assert.ok(done2.ok === false && done2.kind === 'upstream');
    assert.equal(done2.error.message, 'not an error object');
  });
});
