import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SseMeter, costUsd, priceFor, usageFromJson } from './meter.js';

describe('usage from JSON', () => {
  it('reads Anthropic usage including cache tokens', () => {
    const u = usageFromJson('anthropic', {
      model: 'test-claude',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    });
    assert.deepEqual(u, { model: 'test-claude', input: 10, output: 20, cacheRead: 30, cacheWrite: 40 });
  });

  it('reads OpenAI chat usage and splits cached prompt tokens out of input', () => {
    const u = usageFromJson('openai', {
      model: 'test-gpt',
      usage: { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } },
    });
    assert.deepEqual(u, { model: 'test-gpt', input: 40, output: 7, cacheRead: 60, cacheWrite: 0 });
  });

  it('reads OpenAI Responses usage', () => {
    const u = usageFromJson('openai', { model: 'test-gpt', usage: { input_tokens: 5, output_tokens: 6 } });
    assert.equal(u?.input, 5);
    assert.equal(u?.output, 6);
  });
});

describe('SSE metering', () => {
  it('Anthropic: input from message_start, cumulative output from message_delta, split across chunk boundaries', () => {
    const stream =
      'event: message_start\ndata: {"type":"message_start","message":{"model":"test-claude","usage":{"input_tokens":12,"output_tokens":1,"cache_read_input_tokens":3}}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n';
    const m = new SseMeter('anthropic');
    for (let i = 0; i < stream.length; i += 7) m.feed(stream.slice(i, i + 7));
    assert.deepEqual(m.result(), { model: 'test-claude', input: 12, output: 42, cacheRead: 3, cacheWrite: 0 });
  });

  it('OpenAI chat: final usage chunk', () => {
    const m = new SseMeter('openai');
    m.feed('data: {"model":"test-gpt","choices":[{"delta":{"content":"a"}}]}\n\n');
    m.feed('data: {"model":"test-gpt","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\ndata: [DONE]\n\n');
    assert.deepEqual(m.result(), { model: 'test-gpt', input: 9, output: 4, cacheRead: 0, cacheWrite: 0 });
  });

  it('OpenAI Responses: response.completed', () => {
    const m = new SseMeter('openai');
    m.feed('data: {"type":"response.completed","response":{"model":"test-gpt","usage":{"input_tokens":3,"output_tokens":2}}}\n');
    assert.equal(m.result()?.output, 2);
  });

  it('returns null when the stream carried no usage', () => {
    const m = new SseMeter('openai');
    m.feed('data: {"model":"test-gpt","choices":[{"delta":{"content":"a"}}]}\n\n');
    assert.equal(m.result(), null);
  });
});

describe('pricing', () => {
  const prices = { 'test-*': { inputPerMTok: 1, outputPerMTok: 2 }, 'test-big': { inputPerMTok: 10, outputPerMTok: 20, cacheReadPerMTok: 1 } };

  it('exact match beats prefix; unknown models are unpriced', () => {
    assert.equal(priceFor(prices, 'test-big')?.inputPerMTok, 10);
    assert.equal(priceFor(prices, 'test-small')?.inputPerMTok, 1);
    assert.equal(priceFor(prices, 'other'), undefined);
  });

  it('computes USD from normalized usage', () => {
    const usd = costUsd({ input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheWrite: 0 }, prices['test-big']);
    assert.equal(usd, 10 + 10 + 2);
  });
});
