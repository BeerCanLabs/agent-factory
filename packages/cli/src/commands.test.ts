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
