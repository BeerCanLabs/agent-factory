import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FactoryClient } from './client.js';
import { ManagerSession, MAX_CALLS_PER_ROUND, MAX_ROUNDS } from './manager.js';
import type { Io } from './conversation.js';
import { fakeFactory, type FakeFactory } from './testing.js';

const setup = (roles: string[], answers: boolean[] = []) => {
  const f = fakeFactory();
  const said: string[] = [];
  const asked: string[] = [];
  const io: Io = { say: (t) => said.push(t), note: () => {}, busy: () => {}, confirm: async (q) => (asked.push(q), answers.shift() ?? false) };
  const client = new FactoryClient({ baseUrl: 'https://f.example.com', fetch: f.fetch, credential: async () => 'good-token', sleep: async () => {} });
  const session = new ManagerSession({ client, agent: 'factory-manager', roles, actor: 'access:dale@example.com', io, version: 'test', intervalMs: 0, timeoutMs: 1000 });
  return { f, said, asked, session };
};
const script = (f: FakeFactory, steps: Array<(input: Record<string, unknown>) => unknown>) => {
  f.agents.set('factory-manager', (input, n) => JSON.stringify(steps[Math.min(n - 1, steps.length - 1)](input)));
};
const calls = (...c: Array<[string, string, Record<string, unknown>?]>) => ({ type: 'tool_calls', calls: c.map(([id, name, a]) => ({ id, name, arguments: a ?? {} })) });

describe('§6.17 CL4 the manager proposes, the CLI executes', () => {
  it('CL4 runs a read as the person without asking, sends the result back, and shows the manager\'s answer', async () => {
    const { f, said, asked, session } = setup(['admin']);
    f.routes.set('GET /api/v1/spend', () => ({ status: 200, body: { totalUsd: 12.5, apiKey: 'sk-leak' } }));
    script(f, [() => calls(['1', 'get_spend']), (i) => ({ type: 'message', text: `Spend is ${JSON.stringify((i.toolResults as any)[0].result)}` })]);
    const out = await session.ask('what have we spent?');
    assert.deepEqual(out, { kind: 'done' });
    assert.equal(asked.length, 0);
    assert.match(said.join('\n'), /12\.5/);
    assert.doesNotMatch(said.join('\n'), /sk-leak/);
    assert.equal(f.seen.find((s) => s.path === '/api/v1/spend')?.headers['cf-access-token'], 'good-token');
  });

  it('CL4 offers the manager the person\'s tools plus connect, and says who the client is', async () => {
    const { f, session } = setup(['viewer']);
    script(f, [() => ({ type: 'message', text: 'ok' })]);
    await session.ask('hi');
    const body = f.seen.find((s) => s.method === 'POST')!.body as { content: string; tools: Array<{ name: string }>; client: { name: string } };
    assert.equal(body.content, 'hi');
    assert.equal(body.client.name, 'factory-cli');
    assert.ok(body.tools.some((t) => t.name === 'list_agents'));
    assert.ok(body.tools.some((t) => t.name === 'connect_to_agent'));
    assert.ok(!body.tools.some((t) => t.name === 'set_factory_budgets'));
  });

  it('CL4 asks before a change, runs it on yes, and reports a decline to the manager on no', async () => {
    const yes = setup(['admin'], [true]);
    yes.f.routes.set('PUT /api/v1/registry/agents/donna/budget', () => ({ status: 200, body: { ok: true } }));
    script(yes.f, [() => calls(['1', 'set_agent_budget', { id: 'donna', spendLimitUsd: 5, period: 'daily' }]), () => ({ type: 'message', text: 'done' })]);
    await yes.session.ask('cap donna at $5 a day');
    assert.equal(yes.asked.length, 1);
    assert.match(yes.asked[0], /set_agent_budget/);
    assert.ok(yes.f.seen.some((s) => s.method === 'PUT'));

    const no = setup(['admin'], [false]);
    let result: any;
    script(no.f, [() => calls(['1', 'pause_agent', { id: 'donna' }]), (i) => ((result = (i.toolResults as any)[0]), { type: 'message', text: 'ok, not paused' })]);
    await no.session.ask('pause donna');
    assert.equal(result.declined, true);
    assert.ok(!no.f.seen.some((s) => s.path.endsWith('/pause')));
  });

  it('CL3 a tool the person was not offered does not run, whatever the manager asks for', async () => {
    const { f, session } = setup(['viewer'], [true]);
    let result: any;
    script(f, [() => calls(['1', 'set_factory_budgets', { totalMonthUsd: 1 }]), (i) => ((result = (i.toolResults as any)[0]), { type: 'message', text: 'cannot' })]);
    await session.ask('set the budget');
    assert.equal(result.ok, false);
    assert.match(result.error, /not available/);
    assert.ok(!f.seen.some((s) => s.method === 'PUT'));
  });

  it('CL3 a refusal from the factory reaches the manager as the factory worded it', async () => {
    const { f, session } = setup(['admin'], [true]);
    f.routes.set('POST /api/v1/agents/donna/isolate', () => ({ status: 403, body: { error: 'forbidden', required: 'operator' } }));
    let result: any;
    script(f, [() => calls(['1', 'isolate_agent', { id: 'donna' }]), (i) => ((result = (i.toolResults as any)[0]), { type: 'message', text: 'refused' })]);
    await session.ask('isolate donna');
    assert.equal(result.ok, false);
    assert.match(result.error, /HTTP 403.*forbidden.*operator/);
  });

  it('CL4 stops a manager that keeps asking for tools', async () => {
    const { f, said, session } = setup(['admin']);
    script(f, [() => calls(['1', 'list_agents'])]);
    f.routes.set('GET /api/v1/agents', () => ({ status: 200, body: [] }));
    assert.deepEqual(await session.ask('loop'), { kind: 'done' });
    assert.equal(f.seen.filter((s) => s.method === 'POST').length, MAX_ROUNDS);
    assert.match(said.at(-1) ?? '', /stopped/);
  });
});

describe('§6.17 CL5 connect to an agent', () => {
  it('CL5 a connect request, as a reply or as a tool call, moves the person to the agent', async () => {
    const a = setup(['admin']);
    script(a.f, [() => ({ type: 'connect', agent: 'donna', text: 'Connecting you to donna.' })]);
    assert.deepEqual(await a.session.ask('let me talk to donna'), { kind: 'connect', agent: 'donna' });
    assert.match(a.said[0], /Connecting/);

    const b = setup(['admin']);
    script(b.f, [() => calls(['1', 'connect_to_agent', { agent: 'rosie' }])]);
    assert.deepEqual(await b.session.ask('talk to rosie'), { kind: 'connect', agent: 'rosie' });
    assert.ok(!b.f.seen.some((s) => s.path.includes('/rosie/')), 'the manager is not in the path and the CLI connects only on the next line');
  });
});

describe('§6.17 CL7 answers are grounded', () => {
  it('CL7 shows the factory\'s footnote on a plain manager answer', async () => {
    const { f, said, session } = setup(['admin']);
    f.agents.set('factory-manager', () => ({ content: 'Probably about ten dollars.', footnote: '[no tools called]' }));
    await session.ask('how much?');
    assert.equal(said.length, 1);
    assert.equal(said[0], 'Probably about ten dollars.\n[no tools called]');
  });
});

describe('§6.17 CL4 limits on what a manager reply can do', () => {
  it('CL4 honours at most MAX_CALLS_PER_ROUND tool requests in a round and refuses the rest', async () => {
    const { f, session } = setup(['admin']);
    let results: any[] = [];
    f.routes.set('GET /api/v1/agents', () => ({ status: 200, body: [] }));
    const many = Array.from({ length: MAX_CALLS_PER_ROUND + 3 }, (_, n) => [`c${n}`, 'list_agents'] as [string, string]);
    script(f, [() => calls(...many), (i) => ((results = i.toolResults as any[]), { type: 'message', text: 'done' })]);
    await session.ask('everything');
    assert.equal(results.filter((r) => r.ok).length, MAX_CALLS_PER_ROUND);
    assert.match(results.at(-1).error, /too many tool calls/);
    assert.equal(f.seen.filter((s) => s.path === '/api/v1/agents').length, MAX_CALLS_PER_ROUND);
  });

  it('CL5 will not connect to something that is not an agent id', async () => {
    for (const agent of ['..', '../x', 'a/b']) {
      const { f, said, session } = setup(['admin']);
      script(f, [() => ({ type: 'connect', agent })]);
      assert.deepEqual(await session.ask('connect me'), { kind: 'done' }, agent);
      assert.match(said.at(-1) ?? '', /not an agent id/);
    }
  });

  it('CL6 control characters in what the manager says never reach the terminal, and a change prompt starts from a reset', async () => {
    const { f, said, asked, session } = setup(['admin'], [false]);
    script(f, [() => ({ type: 'tool_calls', text: 'hi\x1b[8m hidden \x07', calls: [{ id: 'a', name: 'pause_agent', arguments: { id: 'donna\x1b[2J' } }] })]);
    await session.ask('x');
    assert.doesNotMatch(said[0], /[\x00-\x08\x0b-\x1f\x7f]/);
    assert.match(asked[0], /^\x1b\[0m/);
    assert.doesNotMatch(asked[0].slice(4), /\x1b/);
  });
});
