import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileLedger } from './index.js';

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
});
