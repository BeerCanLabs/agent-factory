// packages/control-plane/src/webhooks-auth.e2e.test.ts
// DESIGN_AUTHORITY.md §6.12 A1, plans/factory-auth.md (D18, D22, S15; #349, #360), GAP-225, TSK-302
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import {
  createFactoryServer,
  verifyWebhookHmac,
  FACTORY_GITHUB_WEBHOOK_SECRET,
  type FactoryState,
} from './app.js';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { envProvider, type SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind server port');
  return address.port;
}

async function postWebhook(
  port: number,
  path: string,
  body: string | unknown,
  headers?: Record<string, string>,
) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: payload,
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as Record<string, unknown> | string | null };
}

describe('verifyWebhookHmac unit tests for edge cases (S15, AC2)', () => {
  const secret = 'example-super-secret-signing-key-12345'; // secret-scan:allow
  const body = Buffer.from(JSON.stringify({ event: 'ping', timestamp: 123456789 }), 'utf8');
  const validHex = createHmac('sha256', secret).update(body).digest('hex');
  const validWithPrefix = `sha256=${validHex}`;

  it('valid HMAC succeeds with matching secret and signature', () => {
    // requiredPrefix = 'sha256='
    assert.equal(verifyWebhookHmac(body, secret, validWithPrefix, { requiredPrefix: 'sha256=' }), true);
    // optional prefix (with sha256=)
    assert.equal(verifyWebhookHmac(body, secret, validWithPrefix), true);
    // optional prefix (bare hex)
    assert.equal(verifyWebhookHmac(body, secret, validHex), true);
    // string input for rawBytes
    assert.equal(verifyWebhookHmac(body.toString('utf8'), secret, validWithPrefix), true);
  });

  it('empty or unconfigured secret fails closed (returns false)', () => {
    assert.equal(verifyWebhookHmac(body, '', validWithPrefix), false);
    assert.equal(verifyWebhookHmac(body, undefined as never, validWithPrefix), false);
    assert.equal(verifyWebhookHmac(body, null as never, validWithPrefix), false);
  });

  it('whitespace-only secret fails closed (F4) while untrimmed non-blank secret computes with untrimmed value', () => {
    assert.equal(verifyWebhookHmac(body, '   ', validWithPrefix), false);
    assert.equal(verifyWebhookHmac(body, ' \t\n ', validWithPrefix), false);

    // Non-blank secret with leading/trailing spaces computes HMAC with untrimmed secret
    const untrimmedSecret = ' example-secret-with-spaces '; // secret-scan:allow
    const untrimmedHex = createHmac('sha256', untrimmedSecret).update(body).digest('hex');
    assert.equal(verifyWebhookHmac(body, untrimmedSecret, `sha256=${untrimmedHex}`), true);
  });

  it('missing or empty header fails closed (returns false)', () => {
    assert.equal(verifyWebhookHmac(body, secret, ''), false);
    assert.equal(verifyWebhookHmac(body, secret, '   '), false);
    assert.equal(verifyWebhookHmac(body, secret, undefined as never), false);
    assert.equal(verifyWebhookHmac(body, secret, null as never), false);
  });

  it('wrong prefix fails closed without throwing', () => {
    // Missing required sha256= prefix when requiredPrefix is set
    assert.equal(verifyWebhookHmac(body, secret, validHex, { requiredPrefix: 'sha256=' }), false);
    // Unsupported algorithms / prefixes
    assert.equal(verifyWebhookHmac(body, secret, `md5=${validHex}`), false);
    assert.equal(verifyWebhookHmac(body, secret, `sha1=${validHex}`), false);
    assert.equal(verifyWebhookHmac(body, secret, `other=${validHex}`), false);
  });

  it('non-hex and odd-length hex strings fail closed without throwing RangeError', () => {
    // Odd-length hex (63 characters instead of 64)
    const oddHex = validHex.slice(0, 63);
    assert.equal(verifyWebhookHmac(body, secret, `sha256=${oddHex}`), false);
    assert.equal(verifyWebhookHmac(body, secret, oddHex), false);

    // Non-hex characters
    const nonHex = 'g'.repeat(64);
    assert.equal(verifyWebhookHmac(body, secret, `sha256=${nonHex}`), false);
    const nonHexMixed = validHex.slice(0, 60) + 'zzzz';
    assert.equal(verifyWebhookHmac(body, secret, `sha256=${nonHexMixed}`), false);
    assert.equal(verifyWebhookHmac(body, secret, 'sha256=not-a-valid-hex-signature-at-all'), false);
  });

  it('truncated and extended digests fail closed without throwing RangeError', () => {
    // Truncated (32 characters)
    const truncated = validHex.slice(0, 32);
    assert.equal(verifyWebhookHmac(body, secret, `sha256=${truncated}`), false);
    assert.equal(verifyWebhookHmac(body, secret, truncated), false);

    // Extended (65 characters, 128 characters)
    const extended65 = validHex + 'a';
    assert.equal(verifyWebhookHmac(body, secret, `sha256=${extended65}`), false);
    const extended128 = validHex.repeat(2);
    assert.equal(verifyWebhookHmac(body, secret, `sha256=${extended128}`), false);
  });

  it('wrong secret fails closed', () => {
    assert.equal(verifyWebhookHmac(body, 'wrong-secret', validWithPrefix), false);
  });

  it('body tampering fails closed', () => {
    const tampered = Buffer.from(JSON.stringify({ event: 'ping', timestamp: 999999999 }), 'utf8');
    assert.equal(verifyWebhookHmac(tampered, secret, validWithPrefix), false);
  });

  it('multi-byte UTF-8 characters verify correctly', () => {
    const utf8Body = Buffer.from('{"msg":"✨ rocket launch 🚀 with emojis and multi-byte text"}', 'utf8');
    const utf8Hex = createHmac('sha256', secret).update(utf8Body).digest('hex');
    assert.equal(verifyWebhookHmac(utf8Body, secret, `sha256=${utf8Hex}`, { requiredPrefix: 'sha256=' }), true);
  });
});

describe('Fail-closed webhook signature verification e2e (S15, AC1 & AC2)', () => {
  let cp: http.Server;
  let port: number;
  let state: FactoryState;

  const GH_SECRET = 'example-gh-webhook-platform-secret-12345'; // secret-scan:allow
  const GENERIC_SECRET = 'example-generic-hook-secret-abcdef'; // secret-scan:allow

  before(async () => {
    state = {
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'operator', token: 'operator-token', roles: ['operator'] }]),
      version: '0.1.0-test',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('test-run-token-key-01234567890123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;

    // Agent with webhook trigger and configured secretRef
    state.agents.set('secured-agent', {
      id: 'secured-agent',
      name: 'Secured Agent',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [{ type: 'webhook', path: '/hooks/secured-agent', secretRef: 'SECURED_HOOK_SECRET' }],
      dir: '/agents/secured-agent',
    } as never);

    // Agent with webhook trigger but NO secretRef
    state.agents.set('unconfigured-hook-agent', {
      id: 'unconfigured-hook-agent',
      name: 'Unconfigured Hook Agent',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [{ type: 'webhook', path: '/hooks/unconfigured' }],
      dir: '/agents/unconfigured-hook-agent',
    } as never);

    // GitHub release agent
    state.agents.set('gh-agent', {
      id: 'gh-agent',
      name: 'GH Release Agent',
      role: 'Agent',
      state: 'SLEEPING',
      provider: 'local',
      artifact: '',
      requires: [],
      ungated: [],
      gated: [],
      triggers: [],
      dir: '/agents/gh-agent',
      repo: 'https://github.com/BeerCanLabs/test-repo',
      installedVersion: '1.0.0',
    } as never);

    cp = createFactoryServer(state);
    port = await listen(cp);
  });

  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((resolve) => cp.close(() => resolve()));
  });

  describe('GitHub webhook endpoint (/api/v1/hooks/github and aliases)', () => {
    const validReleasePayload = {
      action: 'published',
      repository: { html_url: 'https://github.com/BeerCanLabs/test-repo' },
      release: { tag_name: 'v2.0.0', target_commitish: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', body: 'v2 release' },
    };
    const validBody = JSON.stringify(validReleasePayload);
    const validSig = 'sha256=' + createHmac('sha256', GH_SECRET).update(validBody).digest('hex');

    it('AC1: unconfigured signing secret refuses every delivery (401) before JSON parse or state change', async () => {
      // 1. Providers have no secret configured
      state.providers = [];
      const rUnset = await postWebhook(port, '/api/v1/hooks/github', validBody, {
        'x-github-event': 'release',
        'x-hub-signature-256': validSig,
      });
      assert.equal(rUnset.status, 401);
      assert.deepEqual(rUnset.body, { error: 'bad_webhook_signature' });

      // 2. Secret resolves empty string
      state.providers = [envProvider({ FACTORY_GITHUB_WEBHOOK_SECRET: '' })];
      const rEmpty = await postWebhook(port, '/api/v1/hooks/github', validBody, {
        'x-github-event': 'release',
        'x-hub-signature-256': validSig,
      });
      assert.equal(rEmpty.status, 401);
      assert.deepEqual(rEmpty.body, { error: 'bad_webhook_signature' });

      // 3. AC2: Malformed JSON with unconfigured secret fails with 401, NOT 400 invalid_json!
      const rMalformed = await postWebhook(port, '/api/v1/hooks/github', '{not-valid-json', {
        'x-github-event': 'release',
        'x-hub-signature-256': validSig,
      });
      assert.equal(rMalformed.status, 401, 'malformed JSON must fail closed with 401 before JSON parse');

      // 4. Missing signature header with unconfigured secret fails with 401
      const rNoHeader = await postWebhook(port, '/api/v1/hooks/github', validBody, {
        'x-github-event': 'release',
      });
      assert.equal(rNoHeader.status, 401);
      assert.deepEqual(rNoHeader.body, { error: 'bad_webhook_signature' });

      // Verify agent state was untouched
      const ghAgent = state.agents.get('gh-agent')!;
      assert.equal(ghAgent.offeredVersion, undefined);
      assert.equal(ghAgent.updateAvailable, undefined);
    });

    it('AC2: with configured secret, missing/invalid signatures are refused (401) before JSON parse', async () => {
      state.providers = [envProvider({ FACTORY_GITHUB_WEBHOOK_SECRET: GH_SECRET })];

      // 1. Missing signature header
      const rMissing = await postWebhook(port, '/api/v1/hooks/github', validBody, { 'x-github-event': 'release' });
      assert.equal(rMissing.status, 401);
      assert.deepEqual(rMissing.body, { error: 'bad_webhook_signature' });

      // 2. Wrong prefix (not sha256=)
      const rWrongPrefix = await postWebhook(port, '/api/v1/hooks/github', validBody, {
        'x-github-event': 'release',
        'x-hub-signature-256': 'md5=' + '0'.repeat(32),
      });
      assert.equal(rWrongPrefix.status, 401);
      assert.deepEqual(rWrongPrefix.body, { error: 'bad_webhook_signature' });

      // 3. Non-hex or invalid hex length
      const rNonHex = await postWebhook(port, '/api/v1/hooks/github', validBody, {
        'x-github-event': 'release',
        'x-hub-signature-256': 'sha256=' + 'z'.repeat(64),
      });
      assert.equal(rNonHex.status, 401);
      assert.deepEqual(rNonHex.body, { error: 'bad_webhook_signature' });

      // 4. Wrong signature
      const rWrong = await postWebhook(port, '/api/v1/hooks/github', validBody, {
        'x-github-event': 'release',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      });
      assert.equal(rWrong.status, 401);
      assert.deepEqual(rWrong.body, { error: 'bad_webhook_signature' });

      // 5. Tampered body
      const tamperedBody = JSON.stringify({ ...validReleasePayload, action: 'edited' });
      const rTampered = await postWebhook(port, '/api/v1/hooks/github', tamperedBody, {
        'x-github-event': 'release',
        'x-hub-signature-256': validSig,
      });
      assert.equal(rTampered.status, 401);
      assert.deepEqual(rTampered.body, { error: 'bad_webhook_signature' });

      // 6. Malformed JSON with bad/missing signature fails with 401, NOT 400
      const rBadJsonBadSig = await postWebhook(port, '/api/v1/hooks/github', '{not-valid-json', {
        'x-github-event': 'release',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      });
      assert.equal(rBadJsonBadSig.status, 401, 'malformed JSON with bad signature must fail with 401');

      const rBadJsonNoSig = await postWebhook(port, '/api/v1/hooks/github', '{not-valid-json', {
        'x-github-event': 'release',
      });
      assert.equal(rBadJsonNoSig.status, 401, 'malformed JSON without signature must fail with 401');

      // 7. Malformed JSON with VALID signature fails with 400 invalid_json (proving JSON parse occurs only after valid sig)
      const malformedBody = '{not-valid-json';
      const malformedSig = 'sha256=' + createHmac('sha256', GH_SECRET).update(malformedBody).digest('hex');
      const rBadJsonValidSig = await postWebhook(port, '/api/v1/hooks/github', malformedBody, {
        'x-github-event': 'release',
        'x-hub-signature-256': malformedSig,
      });
      assert.equal(rBadJsonValidSig.status, 400);
      assert.deepEqual(rBadJsonValidSig.body, { error: 'invalid_json' });
    });

    it('valid HMAC signature succeeds on canonical path and aliases', async () => {
      state.providers = [envProvider({ FACTORY_GITHUB_WEBHOOK_SECRET: GH_SECRET })];

      for (const p of ['/api/v1/hooks/github', '/hooks/github', '/api/v1/webhooks/github', '/webhooks/github']) {
        const payloadObj = {
          action: 'published',
          repository: { html_url: 'https://github.com/BeerCanLabs/test-repo' },
          release: { tag_name: 'v2.1.0', target_commitish: '11223344556677889900aabbccddeeff11223344', body: 'v2.1 release' },
        };
        const raw = JSON.stringify(payloadObj);
        const sig = 'sha256=' + createHmac('sha256', GH_SECRET).update(raw).digest('hex');

        const res = await postWebhook(port, p, raw, {
          'x-github-event': 'release',
          'x-hub-signature-256': sig,
        });
        assert.equal(res.status, 200, `expected 200 on ${p}`);
        assert.deepEqual(res.body, {
          ok: true,
          agentId: 'gh-agent',
          offeredVersion: '2.1.0',
          updateAvailable: true,
        });
      }
    });
  });

  describe('Generic webhook endpoint (/api/v1/hooks/:id and /hooks/:id)', () => {
    it('F1: non-existent agent or invalid agent ID format refuses uniformly with 401 bad_webhook_signature (not 404)', async () => {
      const validSig = 'sha256=' + '0'.repeat(64);
      const rInvalid = await postWebhook(port, '/api/v1/hooks/_invalid_id', {}, {
        'x-hub-signature-256': validSig,
      });
      assert.equal(rInvalid.status, 401);
      assert.deepEqual(rInvalid.body, { error: 'bad_webhook_signature' });

      const rNonExistent = await postWebhook(port, '/api/v1/hooks/does-not-exist', {}, {
        'x-hub-signature-256': validSig,
      });
      assert.equal(rNonExistent.status, 401);
      assert.deepEqual(rNonExistent.body, { error: 'bad_webhook_signature' });
    });

    it('AC1 & F1: agent with NO configured secretRef refuses every delivery uniformly (401 bad_webhook_signature)', async () => {
      // 1. Without credentials
      const r1 = await postWebhook(port, '/api/v1/hooks/unconfigured-hook-agent', { test: true });
      assert.equal(r1.status, 401);
      assert.deepEqual(r1.body, { error: 'bad_webhook_signature' });

      // 2. Even with an operator bearer token, unconfigured hook fails closed (no fallback)
      const rAuth = await postWebhook(port, '/api/v1/hooks/unconfigured-hook-agent', { test: true }, {
        authorization: 'Bearer operator-token',
      });
      assert.equal(rAuth.status, 401);
      assert.deepEqual(rAuth.body, { error: 'bad_webhook_signature' });

      // 3. With syntactically valid HMAC header, unconfigured hook refuses uniformly with 401 bad_webhook_signature
      const rWithSig = await postWebhook(port, '/api/v1/hooks/unconfigured-hook-agent', { test: true }, {
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      });
      assert.equal(rWithSig.status, 401);
      assert.deepEqual(rWithSig.body, { error: 'bad_webhook_signature' });

      // 4. AC2: Malformed JSON with unconfigured secret fails with 401, NOT 400
      const rMalformed = await postWebhook(port, '/api/v1/hooks/unconfigured-hook-agent', '{malformed-json');
      assert.equal(rMalformed.status, 401, 'unconfigured hook must refuse malformed JSON with 401 before parse');
      assert.deepEqual(rMalformed.body, { error: 'bad_webhook_signature' });
    });

    it('AC1 & F1: agent with secretRef but secret missing from providers refuses delivery uniformly (401 bad_webhook_signature)', async () => {
      state.providers = []; // SECURED_HOOK_SECRET is not in providers
      const validSig = 'sha256=' + '0'.repeat(64);
      const rUnset = await postWebhook(port, '/api/v1/hooks/secured-agent', { ping: true }, {
        'x-hub-signature-256': validSig,
      });
      assert.equal(rUnset.status, 401);
      assert.deepEqual(rUnset.body, { error: 'bad_webhook_signature' });

      // Secret is empty string or whitespace
      state.providers = [envProvider({ SECURED_HOOK_SECRET: '   ' })];
      const rEmpty = await postWebhook(port, '/api/v1/hooks/secured-agent', { ping: true }, {
        'x-hub-signature-256': validSig,
      });
      assert.equal(rEmpty.status, 401);
      assert.deepEqual(rEmpty.body, { error: 'bad_webhook_signature' });

      // Malformed JSON with missing secret fails with 401, NOT 400
      const rMalformed = await postWebhook(port, '/api/v1/hooks/secured-agent', '{not-json', {
        'x-hub-signature-256': validSig,
      });
      assert.equal(rMalformed.status, 401);
      assert.deepEqual(rMalformed.body, { error: 'bad_webhook_signature' });
    });

    it('AC2 & F1 & F4: with configured secret, missing/invalid signatures and secrets are refused (401 bad_webhook_signature) before JSON parse', async () => {
      state.providers = [envProvider({ SECURED_HOOK_SECRET: GENERIC_SECRET })];
      const validPayload = JSON.stringify({ event: 'build_complete', status: 'success' });
      const validSig = 'sha256=' + createHmac('sha256', GENERIC_SECRET).update(validPayload).digest('hex');

      // 1. Missing both signature and secret headers
      const rMissing = await postWebhook(port, '/api/v1/hooks/secured-agent', validPayload);
      assert.equal(rMissing.status, 401);
      assert.deepEqual(rMissing.body, { error: 'bad_webhook_signature' });

      // 2. Bad HMAC signature in X-Hub-Signature-256
      const rBadHubSig = await postWebhook(port, '/api/v1/hooks/secured-agent', validPayload, {
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      });
      assert.equal(rBadHubSig.status, 401);
      assert.deepEqual(rBadHubSig.body, { error: 'bad_webhook_signature' });

      // 3. Bad HMAC signature in X-Factory-Signature
      const rBadFactorySig = await postWebhook(port, '/api/v1/hooks/secured-agent', validPayload, {
        'x-factory-signature': 'sha256=' + '0'.repeat(64),
      });
      assert.equal(rBadFactorySig.status, 401);
      assert.deepEqual(rBadFactorySig.body, { error: 'bad_webhook_signature' });

      // 4. Bad legacy secret in X-Factory-Secret
      const rBadSecret = await postWebhook(port, '/api/v1/hooks/secured-agent', validPayload, {
        'x-factory-secret': 'wrong-secret',
      });
      assert.equal(rBadSecret.status, 401);
      assert.deepEqual(rBadSecret.body, { error: 'bad_webhook_signature' });

      // 5. Tampered body with HMAC signature
      const rTampered = await postWebhook(port, '/api/v1/hooks/secured-agent', JSON.stringify({ tampered: true }), {
        'x-hub-signature-256': validSig,
      });
      assert.equal(rTampered.status, 401);
      assert.deepEqual(rTampered.body, { error: 'bad_webhook_signature' });

      // 6. Malformed JSON with bad signature or secret returns 401, NOT 400
      const rMalformedBadSig = await postWebhook(port, '/api/v1/hooks/secured-agent', '{not-json', {
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      });
      assert.equal(rMalformedBadSig.status, 401, 'must fail with 401 before JSON parse');
      assert.deepEqual(rMalformedBadSig.body, { error: 'bad_webhook_signature' });

      const rMalformedBadSecret = await postWebhook(port, '/api/v1/hooks/secured-agent', '{not-json', {
        'x-factory-secret': 'wrong',
      });
      assert.equal(rMalformedBadSecret.status, 401, 'must fail with 401 before JSON parse');
      assert.deepEqual(rMalformedBadSecret.body, { error: 'bad_webhook_signature' });

      // 7. Malformed JSON with VALID signature returns 400 invalid_json
      const malformedBody = '{invalid-json-content';
      const malformedSig = 'sha256=' + createHmac('sha256', GENERIC_SECRET).update(malformedBody).digest('hex');
      const rMalformedValidSig = await postWebhook(port, '/api/v1/hooks/secured-agent', malformedBody, {
        'x-hub-signature-256': malformedSig,
      });
      assert.equal(rMalformedValidSig.status, 400);
      assert.deepEqual(rMalformedValidSig.body, { error: 'invalid_json' });
    });

    it('F4: empty HMAC header in req.headers fails closed and never falls through to x-factory-secret', async () => {
      state.providers = [envProvider({ SECURED_HOOK_SECRET: GENERIC_SECRET })];
      const payload = JSON.stringify({ ping: true });

      // Empty string X-Hub-Signature-256 with valid legacy secret
      const rEmptySig = await postWebhook(port, '/api/v1/hooks/secured-agent', payload, {
        'x-hub-signature-256': '',
        'x-factory-secret': GENERIC_SECRET,
      });
      assert.equal(rEmptySig.status, 401);
      assert.deepEqual(rEmptySig.body, { error: 'bad_webhook_signature' });

      // Whitespace-only X-Hub-Signature-256 with valid legacy secret
      const rWhitespaceSig = await postWebhook(port, '/api/v1/hooks/secured-agent', payload, {
        'x-hub-signature-256': '   ',
        'x-factory-secret': GENERIC_SECRET,
      });
      assert.equal(rWhitespaceSig.status, 401);
      assert.deepEqual(rWhitespaceSig.body, { error: 'bad_webhook_signature' });
    });

    it('valid deliveries succeed across HMAC headers, legacy secret, and path aliases', async () => {
      state.providers = [envProvider({ SECURED_HOOK_SECRET: GENERIC_SECRET })];
      const payloadObj = { trigger: 'alert', code: 200 };
      const raw = JSON.stringify(payloadObj);
      const hmacHex = createHmac('sha256', GENERIC_SECRET).update(raw).digest('hex');

      // 1. Valid X-Hub-Signature-256 (sha256=<hex>)
      const rHubSig = await postWebhook(port, '/api/v1/hooks/secured-agent', raw, {
        'x-hub-signature-256': `sha256=${hmacHex}`,
      });
      assert.equal(rHubSig.status, 202);
      assert.equal((rHubSig.body as { actor: string }).actor, 'webhook:secured-agent');

      // 2. Valid X-Factory-Signature (sha256=<hex>)
      const rFactorySig = await postWebhook(port, '/api/v1/hooks/secured-agent', raw, {
        'x-factory-signature': `sha256=${hmacHex}`,
      });
      assert.equal(rFactorySig.status, 202);

      // 3. Valid X-Factory-Signature (bare <hex>)
      const rBareHex = await postWebhook(port, '/api/v1/hooks/secured-agent', raw, {
        'x-factory-signature': hmacHex,
      });
      assert.equal(rBareHex.status, 202);

      // 4. Valid legacy X-Factory-Secret
      const rLegacySecret = await postWebhook(port, '/api/v1/hooks/secured-agent', raw, {
        'x-factory-secret': GENERIC_SECRET,
      });
      assert.equal(rLegacySecret.status, 202);

      // 5. Short path alias (/hooks/:id) with valid signature
      const rShortPath = await postWebhook(port, '/hooks/secured-agent', raw, {
        'x-hub-signature-256': `sha256=${hmacHex}`,
      });
      assert.equal(rShortPath.status, 202);
    });

    it('F2: bindSecrets is NEVER invoked on unsigned or malformed-header requests', async () => {
      let getCalls = 0;
      const spyProvider: SecretProvider = {
        name: 'spy-provider',
        get: async () => {
          getCalls++;
          return 'spy-secret';
        },
      };
      state.providers = [spyProvider];

      // 1. Unsigned GitHub webhook
      const rGhUnsigned = await postWebhook(port, '/api/v1/hooks/github', '{}');
      assert.equal(rGhUnsigned.status, 401);
      assert.deepEqual(rGhUnsigned.body, { error: 'bad_webhook_signature' });
      assert.equal(getCalls, 0, 'bindSecrets must not be called on unsigned GitHub webhook');

      // 2. Malformed-header GitHub webhook
      const rGhMalformed = await postWebhook(port, '/api/v1/hooks/github', '{}', {
        'x-hub-signature-256': 'not-sha256-hex',
      });
      assert.equal(rGhMalformed.status, 401);
      assert.deepEqual(rGhMalformed.body, { error: 'bad_webhook_signature' });
      assert.equal(getCalls, 0, 'bindSecrets must not be called on malformed GitHub webhook header');

      // 3. Unsigned generic webhook
      const rGenericUnsigned = await postWebhook(port, '/api/v1/hooks/secured-agent', '{}');
      assert.equal(rGenericUnsigned.status, 401);
      assert.deepEqual(rGenericUnsigned.body, { error: 'bad_webhook_signature' });
      assert.equal(getCalls, 0, 'bindSecrets must not be called on unsigned generic webhook');

      // 4. Malformed-header generic webhook
      const rGenericMalformed = await postWebhook(port, '/api/v1/hooks/secured-agent', '{}', {
        'x-hub-signature-256': 'not-sha256-hex',
      });
      assert.equal(rGenericMalformed.status, 401);
      assert.deepEqual(rGenericMalformed.body, { error: 'bad_webhook_signature' });
      assert.equal(getCalls, 0, 'bindSecrets must not be called on malformed generic webhook header');

      // 5. Non-existent agent ID even with syntactically valid HMAC header
      const validSyntaxSig = 'sha256=' + '0'.repeat(64);
      const rNonExistent = await postWebhook(port, '/api/v1/hooks/non-existent-agent', '{}', {
        'x-hub-signature-256': validSyntaxSig,
      });
      assert.equal(rNonExistent.status, 401);
      assert.deepEqual(rNonExistent.body, { error: 'bad_webhook_signature' });
      assert.equal(getCalls, 0, 'bindSecrets must not be called on non-existent agent');
    });
  });
});
