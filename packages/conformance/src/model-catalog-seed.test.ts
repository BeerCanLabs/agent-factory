// #557: the landing-zone seeds offer the six Bedrock open-weight models (and Flex) at the
// 2026-11-27 list prices, and the GCP seed no longer carries the retired Claude generation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './support.js';

type SeedEntry = { id?: string; provider?: string; serviceTier?: string; input: number; output: number };

/** Quoted `"name" = { ... }` objects inside a Terraform `default = {` map. */
function parseHclCatalog(section: string): Record<string, SeedEntry> {
  const def = section.indexOf('default = {');
  assert.ok(def >= 0, 'model_catalog default not found');
  const body = section.slice(def);
  const out: Record<string, SeedEntry> = {};
  const re = /"([a-z0-9.-]+)"\s*=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const name = m[1];
    let i = re.lastIndex;
    let depth = 1;
    while (i < body.length && depth > 0) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}') depth--;
      i++;
    }
    const inner = body.slice(re.lastIndex, i - 1);
    out[name] = {
      id: inner.match(/id\s*=\s*"([^"]+)"/)?.[1],
      provider: inner.match(/provider\s*=\s*"([^"]+)"/)?.[1],
      serviceTier: inner.match(/serviceTier\s*=\s*"([^"]+)"/)?.[1],
      input: Number(inner.match(/inputPerMTok\s*=\s*([0-9.]+)/)?.[1]),
      output: Number(inner.match(/outputPerMTok\s*=\s*([0-9.]+)/)?.[1]),
    };
  }
  return out;
}

const AWS_STANDARD: Record<string, { id: string; input: number; output: number }> = {
  'deepseek-v3.2': { id: 'deepseek.v3.2', input: 0.62, output: 1.85 },
  'minimax-m2.5': { id: 'minimax.minimax-m2.5', input: 0.3, output: 1.2 },
  'kimi-k2.5': { id: 'moonshotai.kimi-k2.5', input: 0.6, output: 3 },
  'glm-5': { id: 'zai.glm-5', input: 1, output: 3.2 },
  'qwen3-coder-next': { id: 'qwen.qwen3-coder-next', input: 0.5, output: 1.2 },
  'gpt-oss-120b': { id: 'openai.gpt-oss-120b-1:0', input: 0.15, output: 0.6 },
  'gpt-oss-20b': { id: 'openai.gpt-oss-20b-1:0', input: 0.07, output: 0.3 },
};

describe('model catalog seeds match the 2026-11-27 price audit (#557)', () => {
  it('the AWS seed offers the seven open-weight Bedrock models and a Flex entry for each', () => {
    const tf = read('landing-zones/aws/variables.tf');
    const start = tf.indexOf('variable "model_catalog"');
    const next = tf.indexOf('\nvariable ', start + 20);
    const catalog = parseHclCatalog(tf.slice(start, next));
    const names = Object.keys(catalog).sort();
    const expected = [
      ...Object.keys(AWS_STANDARD),
      ...Object.keys(AWS_STANDARD).map((n) => `${n}-flex`),
    ].sort();
    assert.deepEqual(names, expected);
    for (const [name, want] of Object.entries(AWS_STANDARD)) {
      const standard = catalog[name];
      assert.equal(standard.provider, 'bedrock-converse', name);
      assert.equal(standard.id, want.id, name);
      assert.equal(standard.serviceTier, undefined, name);
      assert.equal(standard.input, want.input, name);
      assert.equal(standard.output, want.output, name);
      const flex = catalog[`${name}-flex`];
      assert.equal(flex.provider, 'bedrock-converse', `${name}-flex`);
      assert.equal(flex.id, want.id, `${name}-flex`);
      assert.equal(flex.serviceTier, 'flex', `${name}-flex`);
      assert.ok(flex.input < standard.input, `${name}-flex input`);
      assert.ok(flex.output < standard.output, `${name}-flex output`);
    }
    assert.equal(catalog['deepseek-v3.2-flex'].input, 0.31);
    assert.equal(catalog['deepseek-v3.2-flex'].output, 0.925);
    assert.equal(catalog['minimax-m2.5-flex'].input, 0.15);
    assert.equal(catalog['minimax-m2.5-flex'].output, 0.6);
    assert.equal(catalog['kimi-k2.5-flex'].input, 0.3);
    assert.equal(catalog['kimi-k2.5-flex'].output, 1.5);
    assert.equal(catalog['glm-5-flex'].input, 0.5);
    assert.equal(catalog['glm-5-flex'].output, 1.6);
    assert.equal(catalog['qwen3-coder-next-flex'].input, 0.25);
    assert.equal(catalog['qwen3-coder-next-flex'].output, 0.6);
    assert.equal(catalog['gpt-oss-120b-flex'].input, 0.075);
    assert.equal(catalog['gpt-oss-120b-flex'].output, 0.3);
    assert.equal(catalog['gpt-oss-20b-flex'].input, 0.035);
    assert.equal(catalog['gpt-oss-20b-flex'].output, 0.15);
    assert.ok(!names.some((n) => n.startsWith('claude-')), 'Claude is not seeded on Bedrock');
  });

  it('the GCP seed prices the current Anthropic, Gemini, OpenAI and xAI models', () => {
    const tf = read('landing-zones/gcp/variables.tf');
    const start = tf.indexOf('variable "model_catalog"');
    const next = tf.indexOf('\nvariable ', start + 20);
    const raw = tf.slice(start, next).match(/default\s*=\s*"((?:\\.|[^"\\])*)"/)?.[1];
    assert.ok(raw, 'GCP model_catalog default string not found');
    const catalog = JSON.parse(raw.replace(/\\"/g, '"')) as Record<string, { provider: string; price: { inputPerMTok: number; outputPerMTok: number } }>;
    assert.deepEqual(Object.keys(catalog).sort(), [
      'claude-haiku-5-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gpt-4o',
      'grok-4.7',
    ]);
    assert.deepEqual(catalog['claude-haiku-5-5'].price, { inputPerMTok: 0.1, outputPerMTok: 0.5 });
    assert.deepEqual(catalog['claude-sonnet-5-5'].price, { inputPerMTok: 2, outputPerMTok: 10 });
    assert.deepEqual(catalog['claude-opus-5-5'].price, { inputPerMTok: 4, outputPerMTok: 20 });
    assert.deepEqual(catalog['gemini-2.5-flash'].price, { inputPerMTok: 0.3, outputPerMTok: 2.5 });
    assert.deepEqual(catalog['gemini-2.5-pro'].price, { inputPerMTok: 1.25, outputPerMTok: 10 });
    assert.deepEqual(catalog['gpt-4o'].price, { inputPerMTok: 2.5, outputPerMTok: 10 });
    assert.deepEqual(catalog['grok-4.7'].price, { inputPerMTok: 2, outputPerMTok: 6 });
    assert.equal(catalog['grok-4.7'].provider, 'xai');
    for (const gone of ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-5', 'grok-3']) {
      assert.equal(catalog[gone], undefined, gone);
    }
  });
});
