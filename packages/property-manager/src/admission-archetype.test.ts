import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_AND_SKILLS_STEP_SCRIPT } from './gcp/cloudbuild.js';
import { admissionFailure } from './aws/codebuild.js';

const MARK = '# AM1 / GAP-179';

/** The archetype check as each builder runs it: the GCP step script, and the AWS buildspec (dedented from Terraform). */
function gcpCheck(): string {
  const s = TEST_AND_SKILLS_STEP_SCRIPT;
  const start = s.indexOf(MARK);
  return s.slice(start, s.indexOf('exit 7; fi', start) + 'exit 7; fi'.length);
}
function awsCheck(): string {
  const tf = readFileSync(fileURLToPath(new URL('../../../landing-zones/aws/codebuild.tf', import.meta.url)), 'utf8');
  const start = tf.indexOf(MARK);
  return tf
    .slice(start, tf.indexOf('exit 7; fi', start) + 'exit 7; fi'.length)
    .split('\n')
    .map((l) => l.replace(/^ {8}/, ''))
    .join('\n');
}

function run(check: string, files: Record<string, string>): number | null {
  const dir = mkdtempSync(join(tmpdir(), 'am1-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return spawnSync('bash', ['-c', check], { cwd: dir }).status;
}

describe('AM1 the admission build refuses a commit that declares no archetype', () => {
  for (const [builder, check] of [['gcp', gcpCheck()], ['aws', awsCheck()]] as const) {
    it(`AM1 ${builder}: accepts a declared archetype (cartridge.yaml or memory.yaml, quoted, legacy alias) and refuses none with exit 7`, () => {
      assert.ok(check.startsWith(MARK) && check.endsWith('exit 7; fi'), 'check found in the builder script');
      assert.equal(run(check, { 'cartridge.yaml': 'id: a\nmemory:\n  archetype: team-member\n' }), 0);
      assert.equal(run(check, { 'cartridge.yaml': "id: a\nmemory:\n  archetype: 'personal-assistant'  # AM1\n" }), 0);
      assert.equal(run(check, { 'cartridge.yaml': 'id: a\n', 'memory.yaml': 'archetype: purpose-built\n' }), 0);
      assert.equal(run(check, { 'memory.yaml': 'archetype: episodic\n' }), 0);
      assert.equal(run(check, { 'cartridge.yaml': 'id: a\nmemory:\n  prefix: a\n' }), 7);
      assert.equal(run(check, { 'cartridge.yaml': 'id: a\nmemory:\n  archetype: chatty\n' }), 7);
      assert.equal(run(check, { 'memory.yaml': '  archetype: team-member\n' }), 7);
      assert.equal(run(check, {}), 7);
    });
  }

  it('AM1 aws: exit 7 maps to archetype_required', () => {
    const err = admissionFailure({
      buildStatus: 'FAILED',
      phases: [{ phaseType: 'PRE_BUILD', phaseStatus: 'FAILED', contexts: [{ message: 'COMMAND_EXECUTION_ERROR: Error while executing command: ... Reason: exit status 7' }] }],
    });
    assert.equal(err.reason, 'archetype_required');
  });
});
