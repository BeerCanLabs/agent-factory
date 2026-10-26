import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSkillsImage, buildAgentImage, skillsEnv } from './codebuild.js';
import type { BuildSkill } from '../runtime.js';

describe('aws/codebuild image builders (SK4, A14, TSK-276)', () => {
  const repoSkill: BuildSkill = {
    id: 'repo-skill',
    version: '1.0.0',
    repo: 'https://github.com/org/repo',
    path: 'skills/repo-skill',
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

  it('skillsEnv formats repo skills and packaged skills with packageHash', () => {
    const env = skillsEnv([repoSkill, packagedSkill]);
    assert.deepEqual(JSON.parse(env), [
      { id: 'pkg-skill', version: '2.0.0', packageHash: 'b'.repeat(64) },
      { id: 'repo-skill', version: '1.0.0', repo: 'https://github.com/org/repo', path: 'skills/repo-skill', commit: 'a'.repeat(40) },
    ]);
  });

  it('buildSkillsImage injects PACKAGE_STORE_URI from opts into CodeBuild environment', async () => {
    process.env.FACTORY_ECR_REPO_URI = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agents';
    const sent: any[] = [];
    const client = {
      send: async (cmd: any) => {
        sent.push(cmd);
        if (cmd.constructor.name === 'StartBuildCommand') {
          return { build: { id: 'build:123' } };
        }
        if (cmd.constructor.name === 'BatchGetBuildsCommand') {
          return { builds: [{ id: 'build:123', buildStatus: 'SUCCEEDED' }] };
        }
        return {};
      },
    };

    const res = await buildSkillsImage(
      'agent-1',
      { image: 'base:tag', commit: 'c'.repeat(40) },
      [packagedSkill],
      {
        client,
        pollMs: 1,
        packageStoreUri: 's3://factory-skill-packages-12345/packages',
      },
    );

    assert.ok(res.startsWith('123456789012.dkr.ecr.us-east-1.amazonaws.com/agents:agent-1-'));
    const startCmd = sent.find((c) => c.constructor.name === 'StartBuildCommand');
    assert.ok(startCmd);
    const envOverrides = startCmd.input.environmentVariablesOverride;
    const envMap = Object.fromEntries(envOverrides.map((e: any) => [e.name, e.value]));

    assert.equal(envMap.AGENT_ID, 'agent-1');
    assert.equal(envMap.BASE_IMAGE, 'base:tag');
    assert.equal(envMap.RUNTIME_COMMIT, 'c'.repeat(40));
    assert.equal(envMap.PACKAGE_STORE_URI, 's3://factory-skill-packages-12345/packages');
    assert.ok(envMap.SKILLS.includes('pkg-skill'));
  });

  it('buildSkillsImage injects PACKAGE_STORE_URI from process.env when omitted in opts', async () => {
    process.env.FACTORY_ECR_REPO_URI = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agents';
    process.env.FACTORY_SKILL_PACKAGES_URI = 's3://env-skill-packages/packages';
    const sent: any[] = [];
    const client = {
      send: async (cmd: any) => {
        sent.push(cmd);
        if (cmd.constructor.name === 'StartBuildCommand') {
          return { build: { id: 'build:456' } };
        }
        if (cmd.constructor.name === 'BatchGetBuildsCommand') {
          return { builds: [{ id: 'build:456', buildStatus: 'SUCCEEDED' }] };
        }
        return {};
      },
    };

    try {
      await buildSkillsImage(
        'agent-2',
        { image: 'base:tag', commit: 'd'.repeat(40) },
        [packagedSkill],
        { client, pollMs: 1 },
      );

      const startCmd = sent.find((c) => c.constructor.name === 'StartBuildCommand');
      assert.ok(startCmd);
      const envOverrides = startCmd.input.environmentVariablesOverride;
      const envMap = Object.fromEntries(envOverrides.map((e: any) => [e.name, e.value]));
      assert.equal(envMap.PACKAGE_STORE_URI, 's3://env-skill-packages/packages');
    } finally {
      delete process.env.FACTORY_SKILL_PACKAGES_URI;
    }
  });

  it('buildSkillsImage omits PACKAGE_STORE_URI when not set', async () => {
    process.env.FACTORY_ECR_REPO_URI = '123456789012.dkr.ecr.us-east-1.amazonaws.com/agents';
    delete process.env.FACTORY_SKILL_PACKAGES_URI;
    const sent: any[] = [];
    const client = {
      send: async (cmd: any) => {
        sent.push(cmd);
        if (cmd.constructor.name === 'StartBuildCommand') {
          return { build: { id: 'build:789' } };
        }
        if (cmd.constructor.name === 'BatchGetBuildsCommand') {
          return { builds: [{ id: 'build:789', buildStatus: 'SUCCEEDED' }] };
        }
        return {};
      },
    };

    await buildSkillsImage(
      'agent-3',
      { image: 'base:tag', commit: 'e'.repeat(40) },
      [repoSkill],
      { client, pollMs: 1 },
    );

    const startCmd = sent.find((c) => c.constructor.name === 'StartBuildCommand');
    assert.ok(startCmd);
    const envOverrides = startCmd.input.environmentVariablesOverride;
    const envMap = Object.fromEntries(envOverrides.map((e: any) => [e.name, e.value]));
    assert.equal(envMap.PACKAGE_STORE_URI, undefined);
  });
});
