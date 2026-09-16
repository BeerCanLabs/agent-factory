import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLedger, payloadHash, redactSecrets, toLedgerEvent } from './index.js';

describe('toLedgerEvent', () => {
  it('drops prompt/content and stores a payload hash', () => {
    const event = toLedgerEvent({
      agentId: 'echo',
      type: 'llm',
      prompt: 'SSN 123-45-6789 and a long secret thought',
      inputTokens: 3,
    });
    assert.equal(event.inputTokens, 3);
    assert.equal('prompt' in event, false);
    assert.equal(event.payloadSha256, payloadHash('SSN 123-45-6789 and a long secret thought'));
  });

  it('redacts known secret strings before flush', () => {
    const event = toLedgerEvent(
      { agentId: 'echo', type: 'action', action: 'used sk-live-super-secret' },
      ['sk-live-super-secret'],
    );
    assert.equal(event.action, 'used ***');
    assert.equal(JSON.stringify(event).includes('sk-live-super-secret'), false);
  });
});

describe('FileLedger', () => {
  it('appends and never rewrites prior rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const ledger = new FileLedger(path);
    ledger.append({ timestamp: '', agentId: 'a', type: 'llm', inputTokens: 1 });
    const before = readFileSync(path, 'utf8');
    ledger.append({ timestamp: '', agentId: 'a', type: 'mcp', mcpName: 'tool' });
    const after = readFileSync(path, 'utf8');
    assert.ok(after.startsWith(before));
    assert.equal(ledger.query({ agent: 'a' }).length, 2);
    rmSync(dir, { recursive: true });
  });

  it('never writes extra keys or secret plaintext to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
    const path = join(dir, 'ledger.jsonl');
    const secret = 'sk-live-do-not-store';
    const ledger = new FileLedger(path, { secrets: [secret] });
    ledger.append({
      agentId: 'echo',
      type: 'llm',
      prompt: `hello ${secret}`,
      content: 'user email a@b.c',
      extra: 'drop me',
    });
    const disk = readFileSync(path, 'utf8');
    assert.equal(disk.includes(secret), false);
    assert.equal(disk.includes('"prompt"'), false);
    assert.equal(disk.includes('"content"'), false);
    assert.equal(disk.includes('"extra"'), false);
    assert.equal(
      disk.includes(payloadHash({ prompt: `hello ${secret}`, content: 'user email a@b.c' })),
      true,
    );
    rmSync(dir, { recursive: true });
  });
});

describe('redactSecrets', () => {
  it('masks the longest match first', () => {
    assert.equal(redactSecrets('id token-long and token-longer', ['token-long', 'token-longer']), 'id *** and ***');
  });
});
