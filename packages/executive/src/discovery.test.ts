import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { discoverVendorModels, resolveModelReference, REFERENCE_MODEL_PRICING } from './discovery.js';

describe('Executive Model Discovery & Reference Pricing', () => {
  it('resolves reference pricing and friendly name for known models', () => {
    const gpt4o = resolveModelReference('gpt-4o');
    assert.equal(gpt4o.friendlyName, 'gpt-4o');
    assert.deepEqual(gpt4o.price, { inputPerMTok: 2.5, outputPerMTok: 10.0 });

    const datedSonnet = resolveModelReference('claude-3-5-sonnet-20241022');
    assert.equal(datedSonnet.friendlyName, 'claude-sonnet-3-5');
    assert.deepEqual(datedSonnet.price, { inputPerMTok: 3.0, outputPerMTok: 15.0 });

    const grok = resolveModelReference('grok-2-1212');
    assert.equal(grok.friendlyName, 'grok-2');
    assert.deepEqual(grok.price, { inputPerMTok: 2.0, outputPerMTok: 10.0 });

    const gemini = resolveModelReference('models/gemini-2.0-flash');
    assert.equal(gemini.friendlyName, 'gemini-2.0-flash');
    assert.deepEqual(gemini.price, { inputPerMTok: 0.1, outputPerMTok: 0.4 });
  });

  it('handles custom uncataloged models gracefully with derived friendly name', () => {
    const custom = resolveModelReference('my-company-finetuned-llama3-20261017');
    assert.equal(custom.friendlyName, 'my-company-finetuned-llama3');
    assert.equal(custom.price, undefined);
  });

  it('discovers OpenAI-compatible models format', async () => {
    const fakeFetch: typeof fetch = async (url, init) => {
      assert.match(String(url), /api\.openai\.com\/v1\/models/);
      assert.equal((init?.headers as any)?.Authorization, 'Bearer test-key');
      return {
        ok: true,
        json: async () => ({
          object: 'list',
          data: [
            { id: 'gpt-4o', object: 'model', created: 1715368132, owned_by: 'system' },
            { id: 'gpt-4o-mini', object: 'model', created: 1721172741, owned_by: 'system' },
          ],
        }),
      } as any;
    };

    const models = await discoverVendorModels({
      upstream: 'https://api.openai.com',
      adapter: 'openAiCompatible',
      apiKey: 'test-key',
      fetchFn: fakeFetch,
    });

    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'gpt-4o');
    assert.equal(models[1].id, 'gpt-4o-mini');
  });

  it('discovers Anthropic models format', async () => {
    const fakeFetch: typeof fetch = async (url, init) => {
      assert.match(String(url), /api\.anthropic\.com\/v1\/models/);
      assert.equal((init?.headers as any)?.['x-api-key'], 'test-anthropic-key');
      assert.equal((init?.headers as any)?.['anthropic-version'], '2023-06-01');
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-3-5-sonnet-20241022', display_name: 'Claude 3.5 Sonnet', type: 'model' },
          ],
        }),
      } as any;
    };

    const models = await discoverVendorModels({
      upstream: 'https://api.anthropic.com',
      adapter: 'anthropicMessages',
      apiKey: 'test-anthropic-key',
      fetchFn: fakeFetch,
    });

    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'claude-3-5-sonnet-20241022');
    assert.equal(models[0].name, 'Claude 3.5 Sonnet');
  });

  it('discovers Google Gemini models format', async () => {
    const fakeFetch: typeof fetch = async (url, init) => {
      assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models/);
      assert.equal((init?.headers as any)?.['x-goog-api-key'], 'test-gemini-key');
      return {
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash', description: 'Fast' },
          ],
        }),
      } as any;
    };

    const models = await discoverVendorModels({
      upstream: 'https://generativelanguage.googleapis.com',
      adapter: 'vertexGemini',
      discoveryPath: '/v1beta/models',
      apiKey: 'test-gemini-key',
      fetchFn: fakeFetch,
    });

    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'models/gemini-2.0-flash');
    assert.equal(models[0].name, 'Gemini 2.0 Flash');
  });

  it('throws on HTTP failure', async () => {
    const fakeFetch: typeof fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => 'Invalid API Key',
    } as any);

    await assert.rejects(
      discoverVendorModels({
        upstream: 'https://api.x.ai',
        adapter: 'openAiCompatible',
        apiKey: 'bad-key',
        fetchFn: fakeFetch,
      }),
      /Model discovery failed with HTTP 401/,
    );
  });

  it('rejects non-https upstream URLs', async () => {
    await assert.rejects(
      discoverVendorModels({
        upstream: 'http://169.254.169.254',
        adapter: 'openAiCompatible',
      }),
      /https upstream URL/,
    );
  });
});
