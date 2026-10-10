// TSK-159 (DESIGN_AUTHORITY.md §6.14 SK4): what an image is tagged, what the build is told, and what the container is
// launched with when an agent has adopted skills. An agent with none must be exactly what it was before skills existed.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SKILLS_ENV_CHARS, buildAgentImage, skillsEnv } from './aws/codebuild.js';
import { agentEnvironment } from './aws/ecs.js';
import { AdmissionRefusedError, SKILLS_MANIFEST_ENV, SKILLS_MANIFEST_PATH, imageTagFor, skillsHash, type BuildSkill } from './runtime.js';

const C = 'a'.repeat(40);
const S1: BuildSkill = { id: 'tavily-search', version: '0.1.0', repo: 'https://github.com/BeerCanLabs/skill-tavily-search', path: '.', commit: '1'.repeat(40) };
const S2: BuildSkill = { id: 'print', version: '0.1.1', repo: 'https://github.com/BeerCanLabs/skills-mono', path: 'print', commit: '2'.repeat(40) };

describe('the image tag (L4, SK4)', () => {
  it('is exactly what it always was for an agent with no skills', () => {
    assert.equal(imageTagFor('higgins', C), 'higgins-aaaaaaaaaaaa');
    assert.equal(imageTagFor('higgins', C, []), 'higgins-aaaaaaaaaaaa');
  });

  it('adds a hash of the skill pins for an agent with skills: pinned vector', () => {
    // sha256 of the canonical JSON [{"commit":"1…","id":"tavily-search","version":"0.1.0"}], computed outside this code.
    assert.equal(imageTagFor('higgins', C, [S1]), 'higgins-aaaaaaaaaaaa-d0f7195426a9');
    assert.match(imageTagFor('higgins', C, [S1, S2]), /^higgins-aaaaaaaaaaaa-[0-9a-f]{12}$/);
  });

  it('does not depend on the order skills are listed in', () => {
    assert.equal(imageTagFor('higgins', C, [S1, S2]), imageTagFor('higgins', C, [S2, S1]));
  });

  it('changes when a skill, its version or its commit changes, and not when only the repository path does', () => {
    const base = imageTagFor('higgins', C, [S1]);
    assert.notEqual(imageTagFor('higgins', C, [S1, S2]), base, 'another skill');
    assert.notEqual(imageTagFor('higgins', C, [{ ...S1, version: '0.2.0' }]), base, 'another version');
    assert.notEqual(imageTagFor('higgins', C, [{ ...S1, commit: '3'.repeat(40) }]), base, 'another commit');
    assert.notEqual(imageTagFor('higgins', 'b'.repeat(40), [S1]), base, 'another agent commit');
    assert.equal(imageTagFor('higgins', C, [{ ...S1, repo: 'https://github.com/x/y', path: 'moved' }]), base, 'what is built is the same commit');
    assert.equal(skillsHash([S1]).length, 64);
  });
});

describe('the build’s input (SK4)', () => {
  const sent = () => {
    const calls: Array<{ input: { projectName?: string; environmentVariablesOverride?: Array<{ name: string; value: string }> } }> = [];
    const client = {
      send: async (cmd: { input: never; constructor: { name: string } }) => {
        if (cmd.constructor.name === 'StartBuildCommand') {
          calls.push(cmd as never);
          return { build: { id: 'b1' } };
        }
        return { builds: [{ buildStatus: 'SUCCEEDED' }] };
      },
    };
    return { client, calls };
  };
  const env = (c: ReturnType<typeof sent>['calls']) => Object.fromEntries((c[0].input.environmentVariablesOverride ?? []).map((e) => [e.name, e.value]));
  const previous = process.env.FACTORY_ECR_REPO_URI;
  process.env.FACTORY_ECR_REPO_URI = '111111111111.dkr.ecr.us-east-1.amazonaws.com/agents';
  afterEach(() => void 0);

  it('sends the pins as JSON, sorted by id, and a tag that carries their hash', async () => {
    const { client, calls } = sent();
    const uri = await buildAgentImage('higgins', { repo: 'https://github.com/BeerCanLabs/SM-higgins', commit: C }, { client, pollMs: 0, skills: [S1, S2] });
    const e = env(calls);
    assert.deepEqual(JSON.parse(e.SKILLS), [
      { id: 'print', version: '0.1.1', repo: S2.repo, path: 'print', commit: S2.commit },
      { id: 'tavily-search', version: '0.1.0', repo: S1.repo, path: '.', commit: S1.commit },
    ]);
    assert.equal(e.IMAGE_TAG, imageTagFor('higgins', C, [S1, S2]));
    assert.equal(uri, `111111111111.dkr.ecr.us-east-1.amazonaws.com/agents:${e.IMAGE_TAG}`);
    assert.deepEqual(Object.keys(JSON.parse(e.SKILLS)[0]).sort(), ['commit', 'id', 'path', 'repo', 'version'], 'only what the build needs');
  });

  it('sends no SKILLS for an agent without skills, and the tag it always had', async () => {
    const { client, calls } = sent();
    await buildAgentImage('higgins', { repo: 'https://github.com/BeerCanLabs/SM-higgins', commit: C }, { client, pollMs: 0 });
    assert.equal('SKILLS' in env(calls), false);
    assert.equal(env(calls).IMAGE_TAG, 'higgins-aaaaaaaaaaaa');
    const empty = sent();
    await buildAgentImage('higgins', { repo: 'https://github.com/BeerCanLabs/SM-higgins', commit: C }, { client: empty.client, pollMs: 0, skills: [] });
    assert.equal('SKILLS' in env(empty.calls), false);
  });

  it('refuses, rather than truncates, more skills than the build’s environment can hold', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...S1, id: `skill-${i}`, commit: String(i % 10).repeat(40) }));
    assert.ok(skillsEnv(many).length > MAX_SKILLS_ENV_CHARS);
    const { client, calls } = sent();
    await assert.rejects(buildAgentImage('higgins', { repo: 'https://github.com/BeerCanLabs/SM-higgins', commit: C }, { client, pollMs: 0, skills: many }), (err: unknown) => err instanceof AdmissionRefusedError && err.reason === 'build_failed' && /do not fit/.test(err.message));
    assert.equal(calls.length, 0, 'no build was started');
    if (previous === undefined) delete process.env.FACTORY_ECR_REPO_URI;
    else process.env.FACTORY_ECR_REPO_URI = previous;
  });
});

describe('the container’s environment at launch (SK4)', () => {
  it('names the skills manifest, beside the mind settings', () => {
    assert.deepEqual(agentEnvironment('mind-bucket', 'higgins', { [SKILLS_MANIFEST_ENV]: SKILLS_MANIFEST_PATH }), [
      { name: 'FACTORY_MIND_BUCKET', value: 'mind-bucket' },
      { name: 'MEMORY_STORE_URI', value: 's3://mind-bucket' },
      { name: 'MEMORY_PREFIX', value: 'higgins' },
      { name: 'FACTORY_SKILLS_MANIFEST', value: '/opt/factory/skills.json' },
    ]);
  });

  it('is what it was for an agent with nothing to add, and launch settings never replace the mind’s', () => {
    assert.equal(agentEnvironment('mind-bucket', 'higgins').length, 3);
    const env = agentEnvironment('mind-bucket', 'higgins', { MEMORY_PREFIX: 'someone-else', FACTORY_MIND_BUCKET: 'other' });
    assert.deepEqual(env.map((e) => e.value), ['mind-bucket', 's3://mind-bucket', 'higgins']);
  });
});
