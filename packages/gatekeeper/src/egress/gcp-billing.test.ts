import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import {
  gcpBillingActionOf,
  gcpTokenCache,
  mintGcpAccessToken,
  parseServiceAccount,
  GCP_BIGQUERY_READONLY_SCOPE,
  GCP_BILLING_PROJECT,
} from './gcp-billing.js';

function testKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

const PRIVATE_KEY = testKey();
const SA = {
  type: 'service_account',
  client_email: 'sm-finley@submind-matrix.iam.gserviceaccount.com',
  private_key: PRIVATE_KEY,
  private_key_id: 'test-kid-1',
  token_uri: 'https://oauth2.googleapis.com/token',
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('gcp-billing parse and allowlist', () => {
  it('parses a service-account JSON and redacts the private key', () => {
    const secretValues = new Set<string>();
    const raw = JSON.stringify(SA);
    const parsed = parseServiceAccount(raw, secretValues);
    assert.ok(parsed);
    assert.equal(parsed!.clientEmail, SA.client_email);
    assert.equal(parsed!.privateKeyId, 'test-kid-1');
    assert.ok(secretValues.has(PRIVATE_KEY));
    assert.ok(secretValues.has(raw));
  });

  it('rejects invalid JSON or a missing client_email / private_key', () => {
    assert.equal(parseServiceAccount('nope'), undefined);
    assert.equal(parseServiceAccount(JSON.stringify({ client_email: SA.client_email })), undefined);
    assert.equal(parseServiceAccount(JSON.stringify({ private_key: PRIVATE_KEY })), undefined);
  });

  it('allows only read-only BigQuery jobs/query in project submind-matrix', () => {
    const post = gcpBillingActionOf('POST', `/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries`);
    assert.equal(post.ok, true);
    if (post.ok) {
      assert.equal(post.dest.href, `https://bigquery.googleapis.com/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries`);
      assert.equal(post.method, 'POST');
    }
    const get = gcpBillingActionOf('GET', `/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries/job_abc-1?location=US`);
    assert.equal(get.ok, true);
    if (get.ok) {
      assert.equal(get.dest.search, '?location=US');
      assert.equal(get.method, 'GET');
    }

    assert.equal(gcpBillingActionOf('POST', '/bigquery/v2/projects/other-project/queries').ok, false);
    assert.equal(gcpBillingActionOf('DELETE', `/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries/job_abc-1`).ok, false);
    assert.equal(gcpBillingActionOf('POST', `/bigquery/v2/projects/${GCP_BILLING_PROJECT}/datasets`).ok, false);
    assert.equal(gcpBillingActionOf('GET', `/bigquery/v2/projects/${GCP_BILLING_PROJECT}/datasets/gcp_billing_export/tables`).ok, false);
  });

  it('test host overrides point at a local dest', () => {
    const ok = gcpBillingActionOf('POST', `/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries`, { bigquery: '127.0.0.1:9' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.dest.href, `http://127.0.0.1:9/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries`);
  });
});

describe('gcp-billing token mint and cache', () => {
  it('mints a jwt-bearer access token with the BigQuery readonly scope', async () => {
    const seen: { body: string }[] = [];
    const tok = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ body });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'gcp-test-at', expires_in: 3600, token_type: 'Bearer' }));
      });
    });
    const port = await listen(tok);
    try {
      const parsed = parseServiceAccount(JSON.stringify(SA))!;
      const secretValues = new Set<string>();
      const minted = await mintGcpAccessToken(parsed, {
        tokenUrl: `http://127.0.0.1:${port}/token`,
        secretValues,
      });
      assert.equal(minted.accessToken, 'gcp-test-at');
      assert.ok(secretValues.has('gcp-test-at'));
      const params = new URLSearchParams(seen[0]!.body);
      assert.equal(params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const assertion = params.get('assertion') ?? '';
      const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString());
      assert.equal(claims.iss, SA.client_email);
      assert.equal(claims.scope, GCP_BIGQUERY_READONLY_SCOPE);
      assert.equal(claims.aud, `http://127.0.0.1:${port}/token`);
    } finally {
      await new Promise<void>((r) => tok.close(() => r()));
    }
  });

  it('reuses a live token, refreshes five minutes before expiry, and retries after a failed mint', async () => {
    let now = Date.parse('2026-11-17T18:00:00Z');
    let calls = 0;
    const parsed = parseServiceAccount(JSON.stringify(SA))!;
    const cache = gcpTokenCache({
      now: () => now,
      mint: async () => {
        calls += 1;
        if (calls === 1) throw new Error('token_down');
        return { accessToken: `tok-${calls}`, expiresAt: new Date(now + 60 * 60_000) };
      },
    });
    await assert.rejects(() => cache.get(parsed), /token_down/);
    const a = await cache.get(parsed);
    const b = await cache.get(parsed);
    assert.equal(a, 'tok-2');
    assert.equal(b, 'tok-2');
    assert.equal(calls, 2);
    now += 56 * 60_000;
    const c = await cache.get(parsed);
    assert.equal(c, 'tok-3');
    assert.equal(calls, 3);
  });
});
