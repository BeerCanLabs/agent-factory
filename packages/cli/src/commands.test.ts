import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, UsageError, commandHelp, findCommand, money, parseFlags, tokenize } from './commands.js';
import { TOOLS, toolByName } from './tools.js';

const parse = (line: string) => {
  const [name, ...rest] = tokenize(line);
  const { args, flags } = parseFlags(rest);
  return findCommand(name)!.parse(args, flags);
};

describe('§6.17 CL11 the CLI works without the manager: the command table', () => {
  it('CL11 every command is one tool from the catalog the manager uses, and every tool has a command', () => {
    for (const c of COMMANDS) assert.ok(toolByName(c.tool), `${c.name} names a tool that does not exist: ${c.tool}`);
    const covered = new Set(COMMANDS.map((c) => c.tool));
    const missing = TOOLS.map((t) => t.spec.name).filter((n) => !covered.has(n));
    assert.deepEqual(missing, [], 'the person can do anything the manager can');
  });

  it('CL11 command names are unique and none collides with a conversation command', () => {
    const names = COMMANDS.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
    for (const reserved of ['login', 'config', 'connect', 'manager', 'whoami', 'help', 'exit', 'quit']) assert.ok(!names.includes(reserved), reserved);
  });

  it('CL11 the help lists every command with its usage', () => {
    const help = commandHelp();
    for (const c of COMMANDS) assert.ok(help.includes(c.usage), c.usage);
  });

  it('CL11 turns typed words into the tool\'s arguments', () => {
    assert.deepEqual(parse('agent donna'), { id: 'donna' });
    assert.deepEqual(parse('budget donna $12.50 monthly'), { id: 'donna', spendLimitUsd: 12.5, period: 'monthly' });
    assert.deepEqual(parse('budget donna 5 day'), { id: 'donna', spendLimitUsd: 5, period: 'daily' });
    assert.deepEqual(parse('factory-budget total=500 ai=300 alert=0.8,1'), { totalMonthUsd: 500, aiMonthUsd: 300, alertAt: [0.8, 1] });
    assert.deepEqual(parse('runs donna --active --limit 5'), { agent: 'donna', active: true, limit: 5 });
    assert.deepEqual(parse('runs'), {});
    assert.deepEqual(parse('report last'), { period: 'last' });
    assert.deepEqual(parse('report'), { period: 'current' });
    assert.deepEqual(parse('approve abc123 "looks fine to me"'), { id: 'abc123', decision: 'approve', notes: 'looks fine to me' });
    assert.deepEqual(parse('reject abc123'), { id: 'abc123', decision: 'reject' });
    assert.deepEqual(parse('ledger donna --limit 3'), { agent: 'donna', limit: 3 });
  });

  it('CL11 says what is wrong instead of guessing', () => {
    for (const bad of ['agent', 'agent a b', 'budget donna', 'budget donna x daily', 'budget donna -5 daily', 'budget donna 5 hourly', 'factory-budget', 'factory-budget total', 'factory-budget bogus=1', 'factory-budget alert=0', 'report next', 'spend extra', 'approve']) {
      assert.throws(() => parse(bad), UsageError, bad);
    }
    assert.throws(() => parseFlags(['--bogus']), /unknown option/);
    assert.throws(() => parseFlags(['--limit', 'x']), /whole number/);
    assert.equal(findCommand('nope'), undefined);
    assert.equal(money('1,250.5'), 1250.5);
    assert.equal(money('$12.50'), 12.5);
    assert.equal(money('0'), 0);
  });

  it('CL11 words in quotes stay together and flags are found anywhere', () => {
    assert.deepEqual(tokenize('approve 1 "a b  c" d'), ['approve', '1', 'a b  c', 'd']);
    assert.deepEqual(parseFlags(['--json', 'x', '-y']), { args: ['x'], flags: { json: true, yes: true, active: false } });
  });

  it('CL11 money is written plainly: no exponents, hex, lone $, odd commas or absurd sizes', () => {
    for (const bad of ['1e3', '0x10', '0b11', '1e308', '1e-7', '$', '', '1,5', '1,50,000', '-5', '5.', '.5', '5.123', 'Infinity', 'NaN', '2000000000', ' 5']) {
      assert.throws(() => money(bad), UsageError, JSON.stringify(bad));
    }
    assert.throws(() => parse('budget donna $ daily'), UsageError);
    assert.throws(() => parse('budget donna 1e3 daily'), UsageError);
  });

  it('CL11 factory budgets: one = per setting, no duplicates, no names from the object prototype', () => {
    for (const bad of ['total=5=6', 'total=5 total=6', 'constructor=3', 'toString=1', '__proto__=1', 'total=5 constructor=3', '=5', 'total=']) {
      assert.throws(() => parse(`factory-budget ${bad}`), UsageError, bad);
    }
    assert.throws(() => parse('budget donna 5 constructor'), UsageError);
    assert.throws(() => parse('budget donna 5 toString'), UsageError);
    assert.deepEqual(parse('factory-budget total=5 alert=0.5'), { totalMonthUsd: 5, alertAt: [0.5] });
  });
});

describe('S9 people, grants and keys commands', () => {
  it('S9 AC1: grant parses subject, role and scope; people tools are offered by role', async () => {
    const { findCommand } = await import('./commands.js');
    const { toolsFor } = await import('./tools.js');
    assert.deepEqual(findCommand('grant')!.parse(['user:alice', 'viewer', 'agent:higgins'], { json: false, yes: false, active: false }), { subject: 'user:alice', role: 'viewer', scope: 'agent:higgins' });
    assert.throws(() => findCommand('grant')!.parse(['user:alice'], { json: false, yes: false, active: false }));
    const names = (roles: string[]) => toolsFor(roles, 'user:x').map((t) => t.spec.name);
    assert.ok(names(['admin']).includes('list_principals'), 'admin sees people');
    assert.ok(!names([]).includes('list_principals'), 'a zero-grant user does not');
  });

  it('S9: --as sends X-Factory-Act-As on every request', async () => {
    const { FactoryClient } = await import('./client.js');
    const seen: Record<string, string>[] = [];
    const client = new FactoryClient({ baseUrl: 'https://f.example.com', actAs: 'user:alice', credential: async () => ({ name: 'authorization', value: 'Bearer x' }), fetch: (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return new Response('{"actor":"user:alice","roles":[]}', { status: 200 }); }) as unknown as typeof fetch });
    await client.request('GET', '/api/v1/whoami');
    assert.equal(seen[0]['x-factory-act-as'], 'user:alice');
  });
});

describe('§6.9 M5 subscription commands (TSK-329)', () => {
  it('parses personal BYOM and factory subscription commands with explicit --attested requirement', () => {
    assert.deepEqual(parse('subscriptions'), {});
    assert.deepEqual(parse('subscriptions personal'), { scope: 'personal' });
    assert.deepEqual(parse('subscriptions factory'), { scope: 'factory' });
    assert.deepEqual(parse('subscription-spend'), {});
    assert.deepEqual(parse('subscription-connect xai-subscription personal "Alice Grok" --attested'), {
      templateId: 'xai-subscription',
      scope: 'personal',
      name: 'Alice Grok',
      subscriberAttested: true,
    });
    assert.deepEqual(parse('subscription-connect openai-subscription factory "Shared Codex" --attested'), {
      templateId: 'openai-subscription',
      scope: 'factory',
      name: 'Shared Codex',
      subscriberAttested: true,
    });
    assert.throws(() => parse('subscription-connect xai-subscription personal "Alice Grok"'), UsageError);
    assert.throws(() => parse('subscription-reconnect sub_1'), UsageError);
    assert.deepEqual(parse('subscription-reconnect sub_1 --attested'), { id: 'sub_1', subscriberAttested: true });
    assert.deepEqual(parse('subscription-rename sub_1 "Dale\'s Grok Plan"'), { id: 'sub_1', name: "Dale's Grok Plan" });
    assert.deepEqual(parse('subscription-cap sub_1 250,000'), { id: 'sub_1', cap: 250000 });
    assert.deepEqual(parse('subscription-cap sub_1 none'), { id: 'sub_1', cap: null });
    assert.throws(() => parse('subscription-cap sub_1 0'), UsageError);
    assert.deepEqual(parse('subscription-discover sub_1'), { id: 'sub_1' });
    assert.deepEqual(parse('subscription-add-model sub_1 grok-alice grok-4.6'), {
      id: 'sub_1',
      name: 'grok-alice',
      modelId: 'grok-4.6',
    });
    assert.deepEqual(parse('subscription-add-model sub_1 codex-shared gpt-5-codex 0 0'), {
      id: 'sub_1',
      name: 'codex-shared',
      modelId: 'gpt-5-codex',
      inputPerMTok: 0,
      outputPerMTok: 0,
    });
    assert.deepEqual(parse('subscription-retire-model sub_1 grok-alice'), { id: 'sub_1', model: 'grok-alice' });
    assert.deepEqual(parse('subscription-disconnect sub_1'), { id: 'sub_1' });
  });
});
