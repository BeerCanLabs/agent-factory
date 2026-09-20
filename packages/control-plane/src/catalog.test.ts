import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadCatalog } from './catalog.js';

const agentsRoot = fileURLToPath(new URL('../../../agents', import.meta.url));

describe('loadCatalog', () => {
  it('loads all repo cartridges including unified cartridge.yaml agents', () => {
    const agents = loadCatalog(agentsRoot);
    const byId = new Map(agents.map((a) => [a.id, a]));

    // Check that starter-python is discovered and loaded from its unified cartridge.yaml
    const starter = byId.get('starter-python');
    assert.ok(starter, 'starter-python should be loaded');
    assert.equal(starter.name, 'Operations Assistant');
    assert.equal(starter.role, 'Operations & Incident Triage');
    assert.equal(starter.artifact, 'ghcr.io/beercanlabs/starter-python:latest');
    assert.equal(starter.memoryPrefix, 'starter-python-state');
    assert.ok(starter.requires.includes('ALERT_WEBHOOK_SECRET'));
    assert.ok(starter.requires.includes('OPS_NOTIFY_WEBHOOK'));
    assert.ok(starter.triggers.some((t) => t.type === 'webhook' && t.path === '/hooks/ops-alerts'));
    assert.ok(starter.triggers.some((t) => t.type === 'discord'));

    // Check that echo-agent is loaded
    const echo = byId.get('echo-agent');
    assert.ok(echo, 'echo-agent should be loaded');
    assert.equal(echo.name, 'Echo Agent');
    assert.ok(echo.requires.includes('ECHO_WEBHOOK_SECRET'));

    // Check that legacy cartridges continue to load
    for (const legacyId of ['librarian', 'factory-mechanic', 'compliance-officer']) {
      assert.ok(byId.has(legacyId), `${legacyId} should be loaded`);
    }
  });
});
