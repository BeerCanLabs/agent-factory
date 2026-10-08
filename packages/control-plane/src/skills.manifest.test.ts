// TSK-053: the `skill.yaml` contract (packages/contract/src/skill.ts). These tests live with the control plane because
// the contract package's test script runs only validate.test.ts and its package.json is outside the TSK-053 lock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { skillDesignIssues, skillManifestSchema, validateSkillManifest, type SkillManifest } from '@beercanlabs/factory-contract';
import { compareSemver } from '@beercanlabs/factory-registrar';

const base = {
  id: 'discord-progress',
  version: '1.0.0',
  name: 'Discord progress',
  description: 'Renders run progress as one live Discord status message.',
  language: 'node',
  entry: 'src/index.ts',
};

function manifest(over: Record<string, unknown> = {}): SkillManifest {
  const r = validateSkillManifest({ ...base, ...over });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { manifest: SkillManifest }).manifest;
}

describe('SK2 skill.yaml declares what a skill needs', () => {
  it('SK2 accepts a minimal manifest and defaults every requirement to empty', () => {
    const m = manifest();
    assert.deepEqual(m.requires, { routes: [], connections: [], credentials: [], models: [] });
  });

  it('SK2 accepts routes, connections with scopes, credentials by name and models', () => {
    const m = manifest({
      requires: {
        routes: ['discord'],
        connections: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }],
        credentials: [{ name: 'DISCORD_BOT_TOKEN', source: 'discord', description: 'Bot token' }],
        models: ['claude-haiku-4-5', 'gemini-2.0-flash'],
      },
    });
    assert.equal(m.requires.connections[0].provider, 'google');
    assert.equal(m.requires.credentials[0].name, 'DISCORD_BOT_TOKEN');
    assert.deepEqual(skillDesignIssues(m), []);
  });

  it('SK1 ids are kebab-case and versions are semver', () => {
    for (const id of ['Discord', 'discord_progress', '-x', 'x-', 'a--b', '']) {
      assert.equal(validateSkillManifest({ ...base, id }).ok, false, id);
    }
    for (const version of ['1', '1.0', 'v1.0.0', '01.0.0', 'latest', '1.0.0-']) {
      assert.equal(validateSkillManifest({ ...base, version }).ok, false, version);
    }
    for (const version of ['0.1.0', '1.2.3-rc.1', '2.0.0+build.7']) {
      assert.equal(validateSkillManifest({ ...base, version }).ok, true, version);
    }
  });

  it('S1 a manifest carries no secret value: unknown keys are refused, including a credential value', () => {
    assert.equal(skillManifestSchema.safeParse({ ...base, token: 'abc' }).success, false);
    const r = validateSkillManifest({ ...base, requires: { credentials: [{ name: 'DISCORD_BOT_TOKEN', value: 'xoxb-123' }] } });
    assert.equal(r.ok, false);
    assert.equal(validateSkillManifest({ ...base, requires: { credentials: [{ name: 'discord token' }] } }).ok, false);
    assert.equal(validateSkillManifest({ ...base, requires: { hosts: ['discord.com'] } }).ok, false);
  });

  it('SK2 required fields and a contained entry point', () => {
    for (const key of ['id', 'version', 'name', 'description', 'language', 'entry']) {
      const { [key as keyof typeof base]: _, ...rest } = base;
      assert.equal(validateSkillManifest(rest).ok, false, key);
    }
    assert.equal(validateSkillManifest({ ...base, entry: '/etc/passwd' }).ok, false);
    assert.equal(validateSkillManifest({ ...base, entry: '../other/index.js' }).ok, false);
    assert.equal(validateSkillManifest({ ...base, entry: 'discord_progress.main' }).ok, true);
  });
});

describe('SK1 E1 E5 admission design rules on the manifest', () => {
  it('E1 SK2 a raw host, URL or host:port is refused as a route', () => {
    for (const route of ['discord.com', 'https://discord.com', 'api.github.com:443', '10.0.0.1', 'user@host']) {
      const issues = skillDesignIssues(manifest({ requires: { routes: [route] } }));
      assert.ok(issues.some((i) => /host|not a plain route/.test(i.message)), route);
    }
  });

  it('E5 M1 models are plain factory model names, not provider ids or URLs', () => {
    for (const model of ['anthropic/claude-sonnet-4-5', 'bedrock:anthropic.claude-v2', 'https://api.openai.com/v1', 'api.openai.com']) {
      assert.ok(skillDesignIssues(manifest({ requires: { models: [model] } })).length > 0, model);
    }
  });

  it('S1 E5 a gatekeeper-held platform key is refused as a credential', () => {
    const m = manifest({ requires: { credentials: [{ name: 'ANTHROPIC_API_KEY' }] } });
    const issues = skillDesignIssues(m, { gatekeeperEgressHeld: ['ANTHROPIC_API_KEY'] });
    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /gatekeeper-egress holds/);
  });

  it('SK2 each requirement is declared once', () => {
    const m = manifest({ requires: { routes: ['discord', 'discord'] } });
    assert.ok(skillDesignIssues(m).some((i) => /more than once/.test(i.message)));
  });
});

describe('SK5 semver precedence picks the latest version', () => {
  it('orders releases, pre-releases and ignores build metadata', () => {
    const sorted = ['1.0.0', '1.0.0-rc.1', '0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.10.0', '1.2.0', '1.0.0-beta.11', '1.0.0-beta.2'].sort(compareSemver);
    assert.deepEqual(sorted, ['0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.2.0', '1.10.0']);
    assert.equal(compareSemver('1.0.0+a', '1.0.0+b'), 0);
  });
});
