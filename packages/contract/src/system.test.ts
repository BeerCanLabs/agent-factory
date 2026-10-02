import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateSystemProposal, systemDefinitionSchema } from './system.js';

describe('system definition schemas', () => {
  it('validates a valid http system proposal with static credential', () => {
    const res = validateSystemProposal({
      id: 'github',
      name: 'GitHub API',
      kind: 'http',
      upstream: 'https://api.github.com',
      credential: {
        secret: '{agent}_GITHUB_TOKEN',
        header: 'authorization',
        format: 'Bearer {}',
        fallback: false,
      },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.proposal.id, 'github');
      assert.equal(res.proposal.kind, 'http');
    }
  });

  it('validates a valid system proposal with Keymaster connection and hold', () => {
    const res = validateSystemProposal({
      id: 'linkedin',
      name: 'LinkedIn API',
      kind: 'http',
      upstream: 'https://api.linkedin.com',
      connection: 'linkedin',
      hold: {
        methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
        preview: 'linkedin-post',
      },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.proposal.id, 'linkedin');
      assert.equal(res.proposal.connection, 'linkedin');
      assert.deepEqual(res.proposal.hold?.methods, ['POST', 'PUT', 'PATCH', 'DELETE']);
    }
  });

  it('rejects a proposal combining both static credential and connection', () => {
    const res = validateSystemProposal({
      id: 'invalid-sys',
      name: 'Invalid System',
      upstream: 'https://example.com',
      credential: { secret: 'KEY', header: 'authorization' },
      connection: 'google',
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.ok(res.issues.some((i) => i.message.includes('cannot combine a static credential and a Keymaster connection')));
    }
  });

  it('validates a full approved system definition', () => {
    const def = {
      id: 'discord',
      name: 'Discord API',
      kind: 'http' as const,
      upstream: 'https://discord.com/api/v10',
      credential: {
        secret: '{agent}_DISCORD_BOT_TOKEN',
        header: 'authorization',
        format: 'Bot {}',
      },
      stripSignInLinks: true,
      version: 1,
      status: 'approved' as const,
      proposedBy: 'admin',
      proposedAt: new Date().toISOString(),
      decidedBy: 'admin',
      decidedAt: new Date().toISOString(),
      reason: 'Baseline seed',
      hash: 'abc123hash',
    };
    const parsed = systemDefinitionSchema.safeParse(def);
    assert.equal(parsed.success, true);
  });

  it('refuses a non-https upstream and a model provider as a system (E10, E5)', () => {
    const base = { id: 'x', name: 'X', kind: 'http' };
    assert.equal(validateSystemProposal({ ...base, upstream: 'http://example.com' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'file:///etc/passwd' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'https://api.openai.com/v1' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'https://bedrock-runtime.us-east-1.amazonaws.com' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'https://api.x.com/2' }).ok, true);
  });
});
