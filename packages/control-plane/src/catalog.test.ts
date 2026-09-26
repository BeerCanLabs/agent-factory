import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadCatalog, loadDynamicRegistry } from './catalog.js';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));

describe('loadCatalog', () => {
  it('loads all repo cartridges including unified cartridge.yaml agents', () => {
    const agents = loadCatalog(agentsRoot);
    const byId = new Map(agents.map((a) => [a.id, a]));

    // Check that user submind cartridges are loaded
    for (const submindId of ['archie', 'castle', 'donna', 'finley', 'geordi', 'higgins', 'nick', 'rosie', 'switch']) {
      assert.ok(byId.has(submindId), `submind ${submindId} should be loaded`);
      assert.equal(byId.get(submindId)?.category, 'user');
    }

    // Verify retired placeholders are excluded from the main active catalog
    assert.equal(byId.has('starter-python'), false);
    assert.equal(byId.has('echo-agent'), false);
  });

  it('loads dynamic agents from registry directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    try {
      const record = {
        id: 'test-agent',
        name: 'Test Agent',
        role: 'Tester',
        state: 'SLEEPING' as const,
        provider: 'cloud',
        artifact: 'image:latest',
        requires: ['API_KEY'],
        triggers: [{ type: 'discord' as const }],
        dir: '/tmp/test-agent',
      };
      writeFileSync(join(dir, 'test-agent.json'), JSON.stringify(record));
      const loaded = loadDynamicRegistry(dir);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, 'test-agent');
      assert.equal(loaded[0].name, 'Test Agent');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
