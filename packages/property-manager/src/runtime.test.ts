import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skillsHash, imageTagFor, type BuildSkill } from './runtime.js';
import { skillsEnv as awsSkillsEnv } from './aws/codebuild.js';
import { skillsEnv as gcpSkillsEnv } from './gcp/cloudbuild.js';

describe('runtime skills hashing and environment (SK4, A14)', () => {
  const repoSkill: BuildSkill = {
    id: 'test-skill',
    version: '1.0.0',
    repo: 'https://github.com/org/repo',
    path: 'skills/test-skill',
    commit: 'a'.repeat(40),
  };

  const packagedSkill: BuildSkill = {
    id: 'pkg-skill',
    version: '2.0.0',
    repo: 'https://factory.internal/packages',
    path: '.',
    commit: '0'.repeat(40),
    packageHash: 'b'.repeat(64),
  };

  it('preserves backward-compatible skillsEnv output for repository pins', () => {
    const envAws = awsSkillsEnv([repoSkill]);
    const envGcp = gcpSkillsEnv([repoSkill]);
    const expected = JSON.stringify([{
      id: 'test-skill',
      version: '1.0.0',
      repo: 'https://github.com/org/repo',
      path: 'skills/test-skill',
      commit: 'a'.repeat(40),
    }]);
    assert.equal(envAws, expected);
    assert.equal(envGcp, expected);
  });

  it('formats skillsEnv for packaged skills using packageHash', () => {
    const envAws = awsSkillsEnv([packagedSkill]);
    const envGcp = gcpSkillsEnv([packagedSkill]);
    const expected = JSON.stringify([{
      id: 'pkg-skill',
      version: '2.0.0',
      packageHash: 'b'.repeat(64),
    }]);
    assert.equal(envAws, expected);
    assert.equal(envGcp, expected);
  });

  it('skillsHash is stable and unchanged for repository pins', () => {
    const hash1 = skillsHash([repoSkill]);
    const hash2 = skillsHash([repoSkill]);
    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64);
  });

  it('skillsHash incorporates packageHash for packaged skills', () => {
    const hashPkg = skillsHash([packagedSkill]);
    assert.equal(hashPkg.length, 64);
    assert.notEqual(hashPkg, skillsHash([repoSkill]));
  });

  it('imageTagFor formats tag as <agentId>-<runtimeCommit[:12]>-<skillsHash[:12]>', () => {
    const tag = imageTagFor('my-agent', 'c'.repeat(40), [repoSkill]);
    const expectedHash = skillsHash([repoSkill]).slice(0, 12);
    assert.equal(tag, `my-agent-${'c'.repeat(12)}-${expectedHash}`);
  });
});
