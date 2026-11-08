import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformCredentialName,
  validateSystemProposal,
  systemDefinitionSchema,
  SUBSCRIPTION_TEMPLATES,
  subscriptionTemplateIssue,
  subscriptionTemplateHosts,
  subscriptionDefaultHeaders,
  type SubscriptionTemplate,
} from './system.js';

describe('system definition schemas', () => {
  it('gives each vendor its own platform credential name', () => {
    assert.equal(platformCredentialName('gemini'), 'GEMINI_API_KEY');
    assert.equal(platformCredentialName('google'), 'GOOGLE_API_KEY');
    assert.equal(platformCredentialName('openai'), 'OPENAI_API_KEY');
    assert.equal(platformCredentialName('deepseek'), 'DEEPSEEK_API_KEY');
    assert.equal(platformCredentialName('custom-provider'), 'CUSTOM_PROVIDER_API_KEY');
    assert.notEqual(platformCredentialName('deepseek'), platformCredentialName('openai'));
  });

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


const subscriptionDefinition = (templateId: string, over: Record<string, unknown> = {}) => {
  const t = SUBSCRIPTION_TEMPLATES[templateId]!;
  return {
    id: t.id,
    name: t.name,
    kind: 'ai-provider',
    upstream: t.inference.upstream,
    aiProvider: {
      adapter: t.aiProvider.adapter,
      discoveryPath: t.aiProvider.discoveryPath,
      credentialMode: 'subscription',
      templateId: t.id,
      defaultHeaders: subscriptionDefaultHeaders(t),
    },
    oauth: { kind: 'oauth-user', authUrl: t.signIn.deviceCodeUrl, tokenUrl: t.tokenUrl, refresh: true, defaultScopes: t.scopes },
    version: 1,
    status: 'approved',
    proposedBy: 'system',
    proposedAt: '2026-11-08T00:00:00Z',
    hash: 'h',
    ...over,
  };
};

describe('subscription templates (M5)', () => {
  it('ships exactly the xAI and OpenAI templates with the public clients', () => {
    assert.deepEqual(Object.keys(SUBSCRIPTION_TEMPLATES).sort(), ['openai-subscription', 'xai-subscription']);
    assert.equal(SUBSCRIPTION_TEMPLATES['xai-subscription']!.client.id, 'b1a00492-073a-47ea-816f-4c329264a828');
    assert.equal(SUBSCRIPTION_TEMPLATES['openai-subscription']!.client.id, 'app_EMoamEEZ73f0CkXaXp7hrann');
  });

  it('records hosts, scopes, headers with roles, error recognisers and the permission record', () => {
    for (const t of Object.values(SUBSCRIPTION_TEMPLATES)) {
      assert.match(t.signIn.deviceCodeUrl, /^https:\/\//);
      assert.match(t.tokenUrl, /^https:\/\//);
      assert.match(t.inference.upstream, /^https:\/\//);
      assert.ok(t.scopes.includes('offline_access'));
      assert.ok(t.headers.length > 0);
      for (const h of t.headers) assert.ok(h.role === 'factory-identity' || h.role === 'vendor-required');
      assert.ok(t.headers.some((h) => h.name === 'User-Agent' && h.role === 'factory-identity' && /BeerCanLabs/.test(h.value)));
      assert.ok(t.errors.some((e) => e.kind === 'plan-limit'));
      assert.ok(t.errors.some((e) => e.kind === 'tier-refused'));
      assert.equal(t.permission.checkedDate, '2026-11-07');
      assert.ok(t.permission.statementUrls.length > 0 && t.permission.tiers.length > 0);
      assert.equal(subscriptionTemplateIssue(t), undefined);
      assert.ok(t.aiProvider.discoveryPath.startsWith('/'));
    }
    const xai = SUBSCRIPTION_TEMPLATES['xai-subscription']!;
    assert.equal(xai.signIn.discoveryUrl, 'https://auth.x.ai/.well-known/openid-configuration');
    assert.deepEqual(xai.signIn.hostRule, { scheme: 'https', host: 'x.ai', allowSubdomains: true });
    const confirmed = Object.values(SUBSCRIPTION_TEMPLATES).flatMap((t) => t.errors.filter((e) => e.confirmed));
    assert.deepEqual(confirmed.map((e) => e.code), ['usage_limit_reached']);
    const openai = SUBSCRIPTION_TEMPLATES['openai-subscription']!;
    assert.deepEqual(openai.headers.find((h) => h.name === 'ChatGPT-Account-ID')?.role, 'vendor-required');
    assert.equal(openai.headers.find((h) => h.name === 'originator')?.role, 'factory-identity');
    assert.equal(openai.inference.upstream + openai.inference.path, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(SUBSCRIPTION_TEMPLATES['xai-subscription']!.inference.upstream + SUBSCRIPTION_TEMPLATES['xai-subscription']!.inference.path, 'https://api.x.ai/v1/responses');
  });

  it('refuses with subscription_not_permitted any template with an Anthropic or Google host', () => {
    const base = SUBSCRIPTION_TEMPLATES['xai-subscription']!;
    const bad: SubscriptionTemplate[] = [
      { ...base, signIn: { ...base.signIn, deviceCodeUrl: 'https://accounts.google.com/o/oauth2/device/code' } },
      { ...base, tokenUrl: 'https://console.anthropic.com/v1/oauth/token' },
      { ...base, tokenUrl: 'https://oauth2.googleapis.com/token' },
      { ...base, inference: { ...base.inference, upstream: 'https://api.anthropic.com' } },
      { ...base, inference: { ...base.inference, upstream: 'https://cloudcode-pa.googleapis.com' } },
      { ...base, signIn: { ...base.signIn, verificationUrl: 'https://claude.ai/device' } },
    ];
    for (const t of bad) {
      assert.equal(subscriptionTemplateIssue(t), 'subscription_not_permitted', subscriptionTemplateHosts(t).join(','));
    }
  });
});

describe('subscription credential mode (M5)', () => {
  it('accepts a definition created from each shipped template, with OAuth on a non-http system', () => {
    for (const id of Object.keys(SUBSCRIPTION_TEMPLATES)) {
      const r = systemDefinitionSchema.safeParse(subscriptionDefinition(id));
      assert.equal(r.success, true, JSON.stringify(r.success ? '' : r.error.issues));
    }
  });

  it('accepts api-key mode unchanged and still refuses OAuth on a non-http system without the mode', () => {
    const ok = validateSystemProposal({ id: 'deepseek', name: 'DeepSeek', kind: 'ai-provider', upstream: 'https://api.deepseek.com', aiProvider: { credentialMode: 'api-key' } });
    assert.equal(ok.ok, true);
    const t = SUBSCRIPTION_TEMPLATES['xai-subscription']!;
    const oauth = { kind: 'oauth-user', authUrl: t.signIn.deviceCodeUrl, tokenUrl: t.tokenUrl };
    const bad = validateSystemProposal({ id: 'deepseek', name: 'DeepSeek', kind: 'ai-provider', upstream: 'https://api.deepseek.com', oauth });
    assert.equal(bad.ok, false);
    const badDef = systemDefinitionSchema.safeParse(subscriptionDefinition('xai-subscription', { aiProvider: { credentialMode: 'api-key' } }));
    assert.equal(badDef.success, false);
  });

  it('refuses the mode on any admin-proposed system, even one mimicking a template', () => {
    const t = SUBSCRIPTION_TEMPLATES['xai-subscription']!;
    const { version: _v, status: _s, proposedBy: _p, proposedAt: _a, hash: _h, ...proposal } = subscriptionDefinition('xai-subscription');
    const r = validateSystemProposal(proposal);
    assert.equal(r.ok, false);
    const r2 = validateSystemProposal({ id: 'my-sub', name: 'X', kind: 'ai-provider', upstream: 'https://api.example.com', aiProvider: { credentialMode: 'subscription' } });
    assert.equal(r2.ok, false);
    const r3 = validateSystemProposal({ ...proposal, aiProvider: { templateId: t.id } });
    assert.equal(r3.ok, false);
  });

  it('refuses a definition with the mode but no known template id', () => {
    assert.equal(systemDefinitionSchema.safeParse(subscriptionDefinition('xai-subscription', { aiProvider: { credentialMode: 'subscription' } })).success, false);
    assert.equal(systemDefinitionSchema.safeParse(subscriptionDefinition('xai-subscription', { aiProvider: { credentialMode: 'subscription', templateId: 'made-up' } })).success, false);
  });

  it('takes client, hosts, scopes and headers from the template: an admin cannot change them', () => {
    const t = SUBSCRIPTION_TEMPLATES['openai-subscription']!;
    const d = subscriptionDefinition('openai-subscription') as { oauth: Record<string, unknown>; aiProvider: Record<string, unknown> };
    const variants = [
      { upstream: 'https://evil.example.com' },
      { id: 'other-id' },
      { credential: { secret: 'S', header: 'Authorization' } },
      { oauth: { ...d.oauth, tokenUrl: 'https://evil.example.com/token' } },
      { oauth: { ...d.oauth, authUrl: 'https://evil.example.com/device' } },
      { oauth: { ...d.oauth, defaultScopes: [...t.scopes, 'extra'] } },
      { oauth: undefined },
      { oauth: { ...d.oauth, clientSecret: 'shared/x/secret' } },
      { oauth: { ...d.oauth, authParams: { audience: 'x' } } },
      { oauth: { ...d.oauth, refresh: false } },
      { oauth: { ...d.oauth, refresh: undefined } },
      { aiProvider: { ...d.aiProvider, adapter: 'anthropicMessages' } },
      { aiProvider: { ...d.aiProvider, discoveryPath: '/v1/other' } },
      { aiProvider: { ...d.aiProvider, defaultHeaders: undefined } },
      { aiProvider: { ...d.aiProvider, defaultHeaders: {} } },
      { hold: { methods: ['POST'] } },
      { scopes: ['x'] },
      { aiProvider: { ...d.aiProvider, defaultHeaders: { 'User-Agent': 'claude-cli/1.0' } } },
    ];
    for (const v of variants) {
      assert.equal(systemDefinitionSchema.safeParse({ ...d, ...v }).success, false, JSON.stringify(v).slice(0, 80));
    }
  });

  it('refuses a subscription definition on an Anthropic or Google host with subscription_not_permitted', () => {
    for (const upstream of ['https://api.anthropic.com', 'https://generativelanguage.googleapis.com']) {
      const r = systemDefinitionSchema.safeParse(subscriptionDefinition('xai-subscription', { upstream }));
      assert.equal(r.success, false);
      if (!r.success) assert.ok(r.error.issues.some((i) => /subscription_not_permitted/.test(i.message)));
    }
  });
});
