import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const contract = JSON.parse(readFileSync(join(dir, 'moneyman-chuck-bank-card-handoff.contract.json'), 'utf8'));
const doc = readFileSync(join(dir, 'moneyman-chuck-bank-card-handoff.md'), 'utf8');

function section(heading) {
  const start = doc.indexOf(`## ${heading}\n`);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const rest = doc.slice(start + heading.length + 4);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

test('Lexi Savings 0000 is excluded and is not an exported account', () => {
  assert.equal(contract.excluded.length, 1);
  assert.equal(contract.excluded[0].display, 'Lexi Savings 0000');
  assert.equal(contract.excluded[0].last4, '0000');
  assert.equal(contract.accounts.some((account) => account.display === 'Lexi Savings 0000' || account.last4 === '0000'), false);
  assert.equal(contract.accounts.some((account) => /lexi/i.test(account.display)), false);
  const inScope = section('Accounts in scope');
  const excluded = section('Accounts excluded');
  assert.equal(inScope.includes('Lexi'), false);
  assert.equal(inScope.includes('0000'), false);
  assert.match(excluded, /Lexi Savings 0000/);
});

test('the export lists the seven in-scope accounts and the issue fields', () => {
  const displays = contract.accounts.map((account) => account.display);
  assert.deepEqual(displays, [
    'Desert Financial checking',
    'HELOC Savings',
    'Business 0402',
    'Kemba 6606',
    'Chase Marriott 4914',
    'Citi 3530',
    'Citi AAdvantage 4609',
  ]);
  for (const display of displays) {
    assert.match(section('Accounts in scope'), new RegExp(display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const transactionNames = contract.transactionFields.map((field) => field.name);
  for (const required of ['Date', 'Amount', 'Merchant', 'Last 4', 'Running balance']) {
    assert.equal(transactionNames.includes(required), true, required);
  }
  assert.equal(contract.transactionFields.some((field) => field.name === 'PAN' || field.name === 'Access token'), false);
  assert.match(section('Schema'), /13- to 19-digit number/);
  assert.match(section('Schema'), /full account number/);
  assert.match(section('Schema'), /Plaid access tokens/);
});

test("Chuck's egress stays notion and gains no finance-broker route", () => {
  assert.deepEqual(contract.chuckEgress.routes, ['models', 'discord', 'notion']);
  assert.equal(contract.chuckEgress.grantChange, 'none');
  for (const forbidden of contract.chuckEgress.forbiddenRoutes) {
    assert.equal(contract.chuckEgress.routes.includes(forbidden), false);
  }
  const egress = section('Chuck egress');
  assert.match(egress, /Grant decision: \*\*none\*\*/);
  assert.match(egress, /`models`, `discord`, `notion`/);
  assert.match(egress, /no Plaid route/);
  assert.match(section('Operator note'), /#458/);
  assert.match(section('Ready-to-send MoneyMan request'), /Never export Lexi Savings 0000/);
});

test('cadence and destination match the approved plan', () => {
  assert.equal(contract.cadence.timezone, 'America/Phoenix');
  assert.equal(JSON.stringify(contract).includes('America/Denver'), false);
  assert.equal(doc.includes('America/Denver'), false);
  assert.match(section('Cadence'), /America\/Phoenix/);
  assert.match(section('Ready-to-send MoneyMan request'), /05:00 America\/Phoenix/);
  assert.equal(contract.cadence.dailyLocalTime, '05:00');
  assert.equal(contract.cadence.lookbackDays, 7);
  assert.equal(contract.cadence.backfillStart, '2026-01-01');
  assert.equal(contract.cadence.statusFreshWithinHours, 26);
  assert.equal(contract.destination.pageTitle, 'Chuck feed (read-only)');
  assert.equal(contract.destination.chuckAccess.includes('read'), true);
  assert.match(section('Cadence'), /05:00/);
  assert.match(section('Notion destination'), /Chuck feed \(read-only\)/);
  assert.match(section('Notion destination'), /NOTION_DATABASE_ID/);
});
