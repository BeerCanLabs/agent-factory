// Story #370 ([S24] Factory-side per-skill model binding, Epic #349): D31, E7, M2.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, SKILL_CONTEXT_HEADER, type ControlClient, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('s24-skill-model-run-token-key-0123456789'); // secret-scan:allow (test fixture)

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as { port: number }).port;
}

async function chat(port: number, token: string, headers: Record<string, string> = {}, model?: string) {
  const res = await fetch(`http://127.0.0.1:${port}/models/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ ...(model ? { model } : {}), messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('S24: gatekeeper egress serves a skill-bound model for calls made on a skill’s behalf (#370)', { concurrency: false }, () => {
  let gk: http.Server;
  let port = 0;
  let ctx: RunContext;
  let token = '';
  let seq = 0;
  const served: string[] = [];

  const control: ControlClient = {
    async runContext(id) {
      return id === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() {
      throw new Error('unused');
    },
    async consumeApproval() {
      return false;
    },
    async ledger() {},
  };

  before(async () => {
    const entry = (id: string) => ({ provider: 'fake', id, price: { inputPerMTok: 1, outputPerMTok: 1 } });
    gk = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens: tokens,
      control,
      providers: [],
      contextTtlMs: 0,
      modelCatalog: { 'agent-model': entry('agent-model'), 'claude-sonnet': entry('claude-sonnet'), 'claude-haiku': entry('claude-haiku'), 'ungranted': entry('ungranted') } as never,
      defaultModel: 'agent-model',
      modelAdapters: {
        fake: {
          async complete(e) {
            served.push(e.id);
            return { content: 'ok', finishReason: 'stop', usage: { input: 1, output: 1 } } as never;
          },
        },
      },
    });
    port = await listen(gk);
  });

  after(async () => {
    await new Promise<void>((r) => gk.close(() => r()));
  });

  beforeEach(async () => {
    served.length = 0;
    const runId = `s24-run-${++seq}`;
    ctx = {
      run: { runId, agentId: 'friday', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['models'], models: ['agent-model', 'claude-sonnet', 'claude-haiku'], currentModel: 'agent-model' },
      spend: { run: 0, day: 0, month: 0 },
      skillModels: { 'summarize-doc': 'claude-sonnet' },
    };
    token = await tokens.mint({ runId, agentId: 'friday' });
  });

  it('AC1: a call with skill context resolves to the bound model; a call without it keeps the agent model', async () => {
    const skill = await chat(port, token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' });
    assert.equal(skill.status, 200, JSON.stringify(skill.body));
    assert.equal(skill.body.model, 'claude-sonnet');
    const own = await chat(port, token);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal(own.body.model, 'agent-model');
    assert.deepEqual(served, ['claude-sonnet', 'agent-model']);
  });

  it('AC1: a swapped binding is served on the next call without touching the agent policy', async () => {
    ctx.skillModels = { 'summarize-doc': 'claude-haiku' };
    const res = await chat(port, token, { [SKILL_CONTEXT_HEADER]: 'Summarize-Doc' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.model, 'claude-haiku');
    assert.equal(ctx.policy.currentModel, 'agent-model');
  });

  it('the model name a call carries never overrides the skill binding (M2)', async () => {
    const res = await chat(port, token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' }, 'claude-haiku');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.model, 'claude-sonnet');
  });

  it('an explicit run pin (a skill eval) wins over the skill binding', async () => {
    ctx.run.model = 'claude-haiku';
    const res = await chat(port, token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.model, 'claude-haiku');
  });

  it('a skill the agent does not run (no binding in context) falls back to the agent model', async () => {
    const res = await chat(port, token, { [SKILL_CONTEXT_HEADER]: 'not-adopted' });
    assert.equal(res.status, 200);
    assert.equal(res.body.model, 'agent-model');
    const proto = await chat(port, token, { [SKILL_CONTEXT_HEADER]: '__proto__' });
    assert.equal(proto.status, 200);
    assert.equal(proto.body.model, 'agent-model');
  });

  it('E7: a binding outside the agent’s granted models is not served; the agent model is used instead', async () => {
    ctx.skillModels = { 'summarize-doc': 'ungranted' };
    const res = await chat(port, token, { [SKILL_CONTEXT_HEADER]: 'summarize-doc' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.model, 'agent-model');
    assert.deepEqual(served, ['agent-model']);
  });
});
