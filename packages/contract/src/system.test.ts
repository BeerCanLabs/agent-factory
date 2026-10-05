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

  it('accepts a message limit that is a positive whole number, and nothing else', () => {
    const base = { id: 'discord', name: 'Discord', kind: 'http', upstream: 'https://discord.com/api/v10' };
    assert.equal(validateSystemProposal({ ...base, maxContentChars: 2000 }).ok, true);
    for (const bad of [0, -5, 1.5, '2000', null]) {
      assert.equal(validateSystemProposal({ ...base, maxContentChars: bad as number }).ok, false, String(bad));
    }
  });

  it('refuses a non-https upstream and a model provider as a system (E10, E5)', () => {
    const base = { id: 'x', name: 'X', kind: 'http' };
    assert.equal(validateSystemProposal({ ...base, upstream: 'http://example.com' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'file:///etc/passwd' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'https://api.openai.com/v1' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'https://bedrock-runtime.us-east-1.amazonaws.com' }).ok, false);
    assert.equal(validateSystemProposal({ ...base, upstream: 'https://api.x.com/2' }).ok, true);
  });

  it('validates an OAuth user provider system proposal', () => {
    const res = validateSystemProposal({
      id: 'google',
      name: 'Google OAuth Provider',
      upstream: 'https://oauth2.googleapis.com',
      oauth: {
        kind: 'oauth-user',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientSecret: 'GOOGLE_OAUTH_CLIENT',
        authParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.proposal.oauth?.kind, 'oauth-user');
    }
  });

  it('validates a JWT bearer service account system proposal', () => {
    const res = validateSystemProposal({
      id: 'google-service-account',
      name: 'Google Service Account',
      upstream: 'https://oauth2.googleapis.com',
      oauth: {
        kind: 'jwt-bearer',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        keySecret: 'GOOGLE_SERVICE_ACCOUNT',
        defaultScopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
      },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.proposal.oauth?.kind, 'jwt-bearer');
    }
  });

  it('rejects an OAuth system proposal that also provides a static credential', () => {
    const res = validateSystemProposal({
      id: 'bad-oauth',
      name: 'Bad OAuth',
      upstream: 'https://oauth2.googleapis.com',
      credential: { secret: 'SEC', header: 'authorization' },
      oauth: {
        kind: 'oauth-user',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientSecret: 'SEC',
      },
    });
    assert.equal(res.ok, false);
  });

  it('TSK-067 provider sign-in and token URLs are https; entry names are optional (the Keymaster names them)', () => {
    const base = { id: 'microsoft', name: 'Microsoft', kind: 'http', upstream: 'https://login.microsoftonline.com' };
    const ok = validateSystemProposal({ ...base, oauth: { kind: 'oauth-user', authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' } });
    assert.equal(ok.ok, true);
    const plain = validateSystemProposal({ ...base, oauth: { kind: 'oauth-user', authUrl: 'http://evil.example/auth', tokenUrl: 'https://login.microsoftonline.com/t' } });
    assert.equal(plain.ok, false);
  });
});

