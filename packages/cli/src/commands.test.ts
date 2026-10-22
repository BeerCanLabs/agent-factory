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
  });

  it('CL11 words in quotes stay together and flags are found anywhere', () => {
    assert.deepEqual(tokenize('approve 1 "a b  c" d'), ['approve', '1', 'a b  c', 'd']);
    assert.deepEqual(parseFlags(['--json', 'x', '-y']), { args: ['x'], flags: { json: true, yes: true, active: false } });
  });
});
