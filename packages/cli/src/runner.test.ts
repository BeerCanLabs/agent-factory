import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FactoryClient } from './client.js';
import { runCommand } from './runner.js';
import { COMMANDS } from './commands.js';
import { toolsFor } from './tools.js';
import { fakeFactory, type FakeFactory } from './testing.js';

const setup = (answers: boolean[] = []) => {
  const f = fakeFactory();
  const asked: string[] = [];
  const noted: string[] = [];
  const io = { note: (t: string) => void noted.push(t), confirm: async (q: string) => (asked.push(q), answers.shift() ?? false) };
  const client = new FactoryClient({ baseUrl: 'https://f.example.com', fetch: f.fetch, credential: async () => 'good-token', sleep: async () => {} });
  const run = (line: string, roles: string[], extra: { json?: boolean; yes?: boolean } = {}) => runCommand({ client, roles, actor: 'access:dale@example.com', line, io, ...extra });
  return { f, asked, noted, run };
};
const route = (f: FakeFactory, key: string, body: unknown, status = 200) => f.routes.set(key, () => ({ status, body }));

describe('§6.17 CL11 running a command', () => {
  it('CL11 a read runs without a question, calls the factory as the person, and shows a table', async () => {
    const { f, asked, run } = setup();
    route(f, 'GET /api/v1/agents', [{ id: 'donna', state: 'SLEEPING' }, { id: 'rosie', state: 'WORKING' }]);
    const out = await run('/agents', ['viewer']);
    assert.equal(out.ok, true);
    assert.match(out.output, /^ID\s+STATE\ndonna\s+SLEEPING\nrosie\s+WORKING$/);
    assert.equal(asked.length, 0);
    assert.equal(f.seen.at(-1)?.headers['cf-access-token'], 'good-token');
  });

  it('CL11 --json prints the factory\'s answer whole, with secret-looking values hidden', async () => {
    const { f, run } = setup();
    route(f, 'GET /api/v1/spend', { totalUsd: 12.5, apiKey: 'sk-live-123', byAgent: { donna: 3 } });
    const out = await run('spend --json', ['viewer']);
    assert.deepEqual(JSON.parse(out.output), { totalUsd: 12.5, apiKey: '[hidden]', byAgent: { donna: 3 } });
    assert.doesNotMatch(out.output, /sk-live/);
    assert.deepEqual(JSON.parse((await run('spend', ['viewer'], { json: true })).output).totalUsd, 12.5);
  });

  it('CL3 a command the person\'s roles do not hold is not run, and no request is made', async () => {
    const { f, run } = setup();
    for (const line of ['budget donna 5 daily', 'factory-budget total=1', 'retire donna', 'isolate donna', 'reset donna']) {
      const out = await run(line, ['viewer']);
      assert.equal(out.ok, false, line);
      assert.match(out.output, /Your roles do not allow/, line);
    }
    assert.equal(f.seen.length, 0);
  });

  it('CL4 a change is confirmed first, runs on yes, and does nothing on no', async () => {
    const yes = setup([true]);
    route(yes.f, 'PUT /api/v1/registry/agents/donna/budget', { ok: true, spendLimitUsd: 5 });
    const done = await yes.run('budget donna 5 daily', ['admin']);
    assert.equal(done.ok, true);
    assert.match(done.output, /^Done: set an agent's spend limit\./);
    assert.match(yes.asked[0], /Run: set_agent_budget \{"id":"donna","spendLimitUsd":5,"period":"daily"\}/);
    assert.deepEqual(yes.f.seen.at(-1)?.body, { spendLimitUsd: 5, period: 'daily' });

    const no = setup([false]);
    const declined = await no.run('pause donna', ['admin']);
    assert.deepEqual([declined.ok, declined.declined], [false, true]);
    assert.equal(no.f.seen.length, 0);
  });

  it('CL4 --yes answers the question for a script, and only for that command', async () => {
    const { f, asked, run } = setup();
    route(f, 'POST /api/v1/agents/donna/pause', { ok: true });
    assert.equal((await run('pause donna --yes', ['admin'])).ok, true);
    assert.equal(asked.length, 0);
    assert.equal((await run('pause donna', ['admin'])).ok, false, 'the next one asks again (and gets no)');
    assert.equal(asked.length, 1);
  });

  it('CL11 a refusal from the factory is shown as the factory worded it; bad input says how to use the command', async () => {
    const { f, run } = setup([true]);
    route(f, 'POST /api/v1/agents/donna/isolate', { error: 'forbidden', required: 'operator' }, 403);
    const refused = await run('isolate donna', ['admin']);
    assert.equal(refused.ok, false);
    assert.match(refused.output, /HTTP 403: forbidden \(needs the operator role\)/);
    const usage = await run('budget donna', ['admin']);
    assert.match(usage.output, /usage: \/budget <agent> <amount> daily\|monthly/);
    assert.match((await run('frobnicate', ['admin'])).output, /Unknown command/);
  });

  it('CL6 text the factory returns cannot carry escape sequences to the terminal', async () => {
    const { f, run } = setup();
    route(f, 'GET /api/v1/agents', [{ id: 'a\x1b[2J', state: 'x\x07' }]);
    assert.doesNotMatch((await run('agents', ['viewer'])).output, /[\x00-\x08\x0b-\x1f\x7f]/);
    route(f, 'GET /api/v1/models', { error: 'bad\x1b[8m' }, 500);
    assert.doesNotMatch((await run('models', ['viewer'])).output, /[\x00-\x08\x0b-\x1f\x7f]/);
  });

  it('CL11 a command is refused for exactly the roles whose manager would not be offered its tool, for every command', async () => {
    const sample = (usage: string) =>
      usage
        .replace(/\[[^\]]*\]/g, '')
        .replace('total=<$> ai=<$> infra=<$> alert=0.8,1', 'total=1')
        .replace('<amount>', '5')
        .replace('daily|monthly', 'daily')
        .replace(/<[^>]*>/g, 'x1')
        .replace(/\s+/g, ' ')
        .trim();
    for (const roles of [[], ['viewer'], ['operator'], ['approver'], ['admin']]) {
      for (const c of COMMANDS) {
        const { run, f } = setup([false]);
        const line = sample(c.usage);
        const out = await run(line, roles);
        const allowed = toolsFor(roles).some((t) => t.spec.name === c.tool);
        assert.equal(/Your roles do not allow/.test(out.output), !allowed, `${line} as [${roles}]: ${out.output}`);
        if (!allowed) assert.equal(f.seen.length, 0, `${line} reached the factory`);
      }
    }
  });
});
