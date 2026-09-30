import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadCatalog, loadDynamicRegistry, mergeAgents, BUILTIN_SYSTEM_AGENTS } from './catalog.js';

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

    // Retired placeholders are excluded from the main active catalog
    assert.equal(byId.has('starter-python'), false);
    // echo-agent is the factory self-test (compose proof, deploy DoD), listed with built-in & system agents
    assert.equal(byId.get('echo-agent')?.category, 'builtin');
  });

  it('a registry record overrides the static catalog cartridge with the same id; built-ins cannot be replaced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    try {
      const commit = 'e3410b53beb5bfb037ff1444e1778acd32c39530';
      const registered = {
        id: 'donna',
        name: 'Donna (registered)',
        role: 'Executive Assistant',
        state: 'SLEEPING' as const,
        provider: 'cloud',
        artifact: `123456789012.dkr.ecr.us-east-1.amazonaws.com/factory-dynamic-agents:donna-${commit.slice(0, 12)}`,
        requires: [],
        triggers: [],
        dir: '/tmp/donna',
        repo: 'https://github.com/BeerCanLabs/SM-donna.git',
        commit,
        deployedCommit: commit,
      };
      writeFileSync(join(dir, 'donna.json'), JSON.stringify(registered));
      writeFileSync(join(dir, 'gatekeeper-ingress.json'), JSON.stringify({ ...registered, id: 'gatekeeper-ingress', name: 'Impostor' }));
      const staticAgents = loadCatalog(agentsRoot);
      assert.ok(staticAgents.some((a) => a.id === 'donna'), 'static catalog still carries donna');
      const merged = mergeAgents(BUILTIN_SYSTEM_AGENTS, staticAgents, loadDynamicRegistry(dir));
      const donnas = merged.filter((a) => a.id === 'donna');
      assert.equal(donnas.length, 1);
      assert.equal(donnas[0].name, 'Donna (registered)');
      assert.equal(donnas[0].deployedCommit, commit);
      assert.equal(donnas[0].repo, 'https://github.com/BeerCanLabs/SM-donna.git');
      // The other static agents are untouched.
      assert.equal(merged.find((a) => a.id === 'archie')?.dir, staticAgents.find((a) => a.id === 'archie')?.dir);
      assert.equal(merged.find((a) => a.id === 'gatekeeper-ingress')?.name, 'gatekeeper-ingress');
    } finally {
      rmSync(dir, { recursive: true });
    }
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
