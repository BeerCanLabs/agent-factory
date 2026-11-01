// CF6 (#328): the landing zone carries the repository-agent allowlist to the control plane.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './support.js';

describe('CF6 repository agent allowlist reaches the control plane', () => {
  it('landing zone declares repository_agent_ids, empty by default', () => {
    const vars = read('landing-zones/aws/variables.tf');
    const block = vars.match(/variable "repository_agent_ids" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(block, 'repository_agent_ids variable not found');
    assert.match(block, /type\s*=\s*string/);
    assert.match(block, /default\s*=\s*""/);
  });

  it('the control-plane task env sets FACTORY_REPOSITORY_AGENT_IDS from the variable', () => {
    const ecs = read('landing-zones/aws/ecs.tf');
    const cp = ecs.slice(ecs.indexOf('name         = "control-plane"'));
    assert.ok(cp.length > 0, 'control-plane container not found');
    assert.match(cp.slice(0, 6000), /\{ name = "FACTORY_REPOSITORY_AGENT_IDS", value = var\.repository_agent_ids \}/);
  });

  it('the control plane reads the same variable name', () => {
    assert.match(read('packages/control-plane/src/index.ts'), /process\.env\.FACTORY_REPOSITORY_AGENT_IDS/);
  });
});
