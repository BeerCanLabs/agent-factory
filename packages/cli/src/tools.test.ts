import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, ToolArgumentError, redact, toolsFor, trim } from './tools.js';
import { FactoryClient } from './client.js';
import { fakeFactory } from './testing.js';

const names = (roles: string[]) => toolsFor(roles).map((t) => t.spec.name);

describe('§6.17 CL3 the person\'s roles decide what is offered', () => {
  it('CL3 a viewer is offered reads and nothing fleet-wide that changes state', () => {
    const viewer = names(['viewer']);
    for (const n of ['list_agents', 'get_spend', 'factory_metrics', 'list_approvals']) assert.ok(viewer.includes(n), n);
    for (const n of ['set_factory_budgets', 'set_agent_budget', 'retire_agent', 'isolate_agent', 'reset_agent']) assert.ok(!viewer.includes(n), n);
  });

  it('CL3 an admin is offered the budget and lifecycle tools', () => {
    const admin = names(['admin']);
    for (const n of ['set_factory_budgets', 'set_agent_budget', 'pause_agent', 'retire_agent']) assert.ok(admin.includes(n), n);
  });

  it('CL3 an agent-scoped tool is offered to anyone, because an owner holds it on their own agent and the factory decides', () => {
    assert.ok(names(['viewer']).includes('pause_agent'));
  });

  it('CL3 every tool that changes state says so, so the CLI asks first (CL4)', () => {
    const changing = ['set_factory_budgets', 'set_agent_budget', 'decide_approval', 'pause_agent', 'resume_agent', 'isolate_agent', 'wake_agent', 'reset_agent', 'cancel_run', 'retire_agent', 'reinstate_agent'];
    for (const t of TOOLS) assert.equal(t.spec.mutating, changing.includes(t.spec.name), t.spec.name);
  });

  it('CL6 offers no tool that supplies or reads a credential, or registers, deploys or purges', () => {
    for (const t of TOOLS) assert.doesNotMatch(t.spec.name, /credential|secret|key|token|purge|deploy|register/, t.spec.name);
  });
});

describe('§6.17 CL4 tools make one factory call as the person', () => {
  it('CL4 set_agent_budget sends the limit and period to the registry route', async () => {
    const f = fakeFactory();
    f.routes.set('PUT /api/v1/registry/agents/donna/budget', (b) => ({ status: 200, body: { ok: true, got: b } }));
    const c = new FactoryClient({ baseUrl: 'https://f.example.com', fetch: f.fetch, credential: async () => 'good-token' });
    const tool = TOOLS.find((t) => t.spec.name === 'set_agent_budget')!;
    const r = await tool.run(c, { id: 'donna', spendLimitUsd: 5, period: 'daily' });
    assert.equal(r.status, 200);
    assert.deepEqual(f.seen.at(-1)?.body, { spendLimitUsd: 5, period: 'daily' });
  });

  it('CL4 refuses malformed arguments before any request', async () => {
    const f = fakeFactory();
    const c = new FactoryClient({ baseUrl: 'https://f.example.com', fetch: f.fetch, credential: async () => 'good-token' });
    const budget = TOOLS.find((t) => t.spec.name === 'set_agent_budget')!;
    await assert.rejects(budget.run(c, { id: '../x', spendLimitUsd: 5, period: 'daily' }), ToolArgumentError);
    await assert.rejects(budget.run(c, { id: 'a', spendLimitUsd: -1, period: 'daily' }), ToolArgumentError);
    await assert.rejects(budget.run(c, { id: 'a', spendLimitUsd: 1, period: 'hourly' }), ToolArgumentError);
    assert.equal(f.seen.length, 0);
  });
});

describe('§6.17 CL6 nothing sensitive reaches the terminal', () => {
  it('CL6 hides string values under secret-looking names, at any depth, and keeps numbers', () => {
    const out = redact({ id: 'a', apiKey: 'sk-123', nested: [{ client_secret: 'x', tokensIn: 5, authorization: 'Bearer y' }], password: 'p' });
    assert.deepEqual(out, { id: 'a', apiKey: '[hidden]', nested: [{ client_secret: '[hidden]', tokensIn: 5, authorization: '[hidden]' }], password: '[hidden]' });
  });

  it('CL4 trims a long list for the manager and says it did', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ i, pad: 'x'.repeat(50) }));
    const t = trim(rows, 2000) as { truncated: boolean; total: number; shown: number };
    assert.equal(t.truncated, true);
    assert.equal(t.total, 5000);
    assert.ok(t.shown < 5000);
    assert.deepEqual(trim({ a: 1 }), { a: 1 });
  });
});
