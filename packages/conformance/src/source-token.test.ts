// DESIGN_AUTHORITY.md §6.3.2 S1, §6.14 SK1: the agent source token is sent only to an allowed source host. Agent and
// skill registrations name any https repository, so a build must never send the token to a host someone chose.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './support.js';

describe('S1 the source token goes only to allowed source hosts', () => {
  const tf = read('landing-zones/aws/codebuild.tf');
  const projects = [...tf.matchAll(/resource "aws_codebuild_project" "(\w+)" \{[\s\S]*?\n\}/g)];

  it('both CodeBuild projects that clone registered repositories are covered', () => {
    const names = projects.map((m) => m[1]).sort();
    assert.ok(names.includes('factory_agent_builder'), names.join(','));
    assert.ok(names.includes('factory_skill_checker'), names.join(','));
  });

  for (const [block, name] of projects.map((m) => [m[0], m[1]] as const)) {
    if (!/GIT_TOKEN_SECRET_ID/.test(block)) continue;
    it(`${name} fetches the token only for an allowed host, from var.agent_source_token_hosts`, () => {
      assert.match(block, /name\s*=\s*"SOURCE_TOKEN_HOSTS"[\s\S]*?var\.agent_source_token_hosts/, 'SOURCE_TOKEN_HOSTS comes from the variable');
      const fetches = [...block.matchAll(/if \[ -n "\$GIT_TOKEN_SECRET_ID" \]([^\n]*)then/g)];
      assert.ok(fetches.length > 0, 'the build reads the token somewhere');
      for (const f of fetches) assert.match(f[1], /\[ -n "\$allowed" \]/, 'every token read is gated on the host check');
    });
  }

  it('the control plane gets the same host list as the builds', () => {
    assert.match(read('landing-zones/aws/ecs.tf'), /name = "FACTORY_AGENT_SOURCE_TOKEN_HOSTS", value = join\(",", var\.agent_source_token_hosts\)/);
  });
});
