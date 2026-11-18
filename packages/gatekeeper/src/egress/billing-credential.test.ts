import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { RunTokens } from '@beercanlabs/factory-auth';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';

const tokens = new RunTokens('billing-credential-test-run-token-key-0123456789');

const AWS_SECRET = {
  access_key_id: 'AKIATESTACCESSKEY01',
  secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  role_arn: 'arn:aws:iam::566332862296:role/ChuckFinleyBillingReadOnly',
  region: 'us-east-1',
  note: 'keep $& braces {} intact',
};

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const GCP_SECRET = {
  type: 'service_account',
  client_email: 'sm-finley@submind-matrix.iam.gserviceaccount.com',
  private_key: PRIVATE_KEY,
  private_key_id: 'test-kid-1',
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(
  port: number,
  path: string,
  opts: { token: string; body?: unknown; method?: string; headers?: Record<string, string>; rawBody?: Buffer },
): Promise<{ status: number; text: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = opts.rawBody ?? (opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body)));
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    headers.authorization = `Bearer ${opts.token}`;
    if (data) headers['content-length'] = String(data.length);
    const req = http.request({ host: '127.0.0.1', port, path, method: opts.method ?? 'POST', headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

type Seen = { method?: string; path: string; headers: http.IncomingHttpHeaders; body: string };

describe('gatekeeper-egress aws-sigv4 and gcp-sa-jwt billing credentials', { concurrency: false }, () => {
  const stsSeen: Seen[] = [];
  const ceSeen: Seen[] = [];
  const tokenSeen: Seen[] = [];
  const bqSeen: Seen[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  const secrets: Record<string, string> = {
    FINLEY_AWS_BILLING_CREDENTIALS: JSON.stringify(AWS_SECRET),
    FINLEY_GCP_CREDENTIALS: JSON.stringify(GCP_SECRET),
    AWS_BILLING_CREDENTIALS: JSON.stringify({ ...AWS_SECRET, access_key_id: 'AKIASHAREDSHOULDNOTUSE' }),
    GCP_CREDENTIALS: JSON.stringify({ ...GCP_SECRET, client_email: 'shared@example.com' }),
  };

  let stsStatus = 200;
  let ceStatus = 200;
  let tokenStatus = 200;
  let bqStatus = 200;
  let sts: http.Server;
  let ce: http.Server;
  let tokenServer: http.Server;
  let bq: http.Server;
  let egress: http.Server;
  let stsPort = 0;
  let cePort = 0;
  let tokenPort = 0;
  let bqPort = 0;
  let port = 0;
  let finleyToken = '';
  let castleToken = '';
  let ctx: RunContext;

  const control: ControlClient = {
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() { throw new Error('unused'); },
    async consumeApproval() { return false; },
    async ledger(event) { ledger.push(event); },
  };

  const providers: SecretProvider[] = [
    {
      name: 'test',
      async get(name) { return secrets[name]; },
    },
  ];

  before(async () => {
    sts = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        stsSeen.push({ method: req.method, path: req.url ?? '', headers: req.headers, body });
        if (stsStatus !== 200) {
          res.writeHead(stsStatus, { 'content-type': 'text/xml' });
          return res.end('<Error><Code>AccessDenied</Code></Error>');
        }
        res.setHeader('content-type', 'text/xml');
        res.end(`<AssumeRoleResponse><AssumeRoleResult><Credentials>
          <AccessKeyId>ASIASESSIONKEY01</AccessKeyId>
          <SecretAccessKey>session-secret-value-xxxx</SecretAccessKey>
          <SessionToken>session-token-value-xxxx</SessionToken>
          <Expiration>2099-01-01T00:00:00Z</Expiration>
        </Credentials></AssumeRoleResult></AssumeRoleResponse>`);
      });
    });
    ce = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        ceSeen.push({ method: req.method, path: req.url ?? '', headers: req.headers, body });
        res.writeHead(ceStatus, { 'content-type': 'application/x-amz-json-1.1' });
        res.end(ceStatus === 200 ? '{"ResultsByTime":[]}' : '{"__type":"UnrecognizedClientException"}');
      });
    });
    tokenServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        tokenSeen.push({ method: req.method, path: req.url ?? '', headers: req.headers, body });
        res.writeHead(tokenStatus, { 'content-type': 'application/json' });
        res.end(tokenStatus === 200
          ? JSON.stringify({ access_token: 'ya29.test-access-token', expires_in: 3600, token_type: 'Bearer' })
          : JSON.stringify({ error: 'invalid_grant' }));
      });
    });
    bq = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        bqSeen.push({ method: req.method, path: req.url ?? '', headers: req.headers, body });
        res.writeHead(bqStatus, { 'content-type': 'application/json' });
        res.end(bqStatus === 200 ? '{"jobComplete":true,"rows":[]}' : '{"error":{"code":401,"message":"Unauthorized"}}');
      });
    });
    stsPort = await listen(sts);
    cePort = await listen(ce);
    tokenPort = await listen(tokenServer);
    bqPort = await listen(bq);

    egress = createGatekeeperEgress({
      routes: [
        {
          id: 'aws-billing',
          kind: 'http',
          upstream: 'https://ce.us-east-1.amazonaws.com',
          credential: { secret: '{agent}_AWS_BILLING_CREDENTIALS', fallback: false, encoding: 'aws-sigv4' },
        },
        {
          id: 'gcp-billing',
          kind: 'http',
          upstream: 'https://bigquery.googleapis.com',
          credential: { secret: '{agent}_GCP_CREDENTIALS', fallback: false, encoding: 'gcp-sa-jwt' },
        },
      ],
      prices: {},
      runTokens: tokens,
      control,
      providers,
      stsEndpoint: `http://127.0.0.1:${stsPort}/`,
      awsBillingHosts: { ce: `127.0.0.1:${cePort}`, budgets: `127.0.0.1:${cePort}` },
      gcpTokenUrl: `http://127.0.0.1:${tokenPort}/token`,
      gcpBillingHosts: { bigquery: `127.0.0.1:${bqPort}` },
    });
    port = await listen(egress);

    finleyToken = await tokens.mint({ runId: 'run-finley', agentId: 'finley' });
    castleToken = await tokens.mint({ runId: 'run-castle', agentId: 'castle' });
    ctx = {
      run: { runId: 'run-finley', agentId: 'finley', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['aws-billing', 'gcp-billing'], hosts: [] },
      spend: { run: 0, day: 0, month: 0 },
    };
  });

  after(async () => {
    await new Promise<void>((r) => egress.close(() => r()));
    await new Promise<void>((r) => sts.close(() => r()));
    await new Promise<void>((r) => ce.close(() => r()));
    await new Promise<void>((r) => tokenServer.close(() => r()));
    await new Promise<void>((r) => bq.close(() => r()));
  });

  function asFinley() {
    ctx = {
      run: { runId: 'run-finley', agentId: 'finley', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['aws-billing', 'gcp-billing'], hosts: [] },
      spend: { run: 0, day: 0, month: 0 },
    };
  }
  function asCastle() {
    ctx = {
      run: { runId: 'run-castle', agentId: 'castle', state: 'WORKING', live: true },
      agentState: 'WORKING',
      policy: { routes: ['aws-billing', 'gcp-billing'], hosts: [] },
      spend: { run: 0, day: 0, month: 0 },
    };
  }

  it('signs GetCostAndUsage to the allowlisted host and never forwards the agent token or long-lived key', async () => {
    asFinley();
    ceSeen.length = 0;
    stsSeen.length = 0;
    const body = { TimePeriod: { Start: '2026-11-01', End: '2026-11-18' }, Metrics: ['UnblendedCost'] };
    const res = await call(port, '/aws-billing/', {
      token: finleyToken,
      body,
      headers: { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage', 'content-type': 'application/x-amz-json-1.1' },
    });
    assert.equal(res.status, 200);
    assert.equal(ceSeen.length, 1);
    const auth = String(ceSeen[0]!.headers.authorization ?? '');
    assert.match(auth, /AWS4-HMAC-SHA256/);
    assert.ok(!auth.includes(finleyToken), 'run token must not reach AWS');
    assert.ok(!JSON.stringify(ceSeen[0]!.headers).includes(AWS_SECRET.secret_access_key));
    assert.ok(!JSON.stringify(ceSeen[0]!.headers).includes(AWS_SECRET.access_key_id));
    assert.equal(ceSeen[0]!.headers['x-amz-security-token'], 'session-token-value-xxxx');
    assert.ok(ledger.some((e) => e.action === 'EGRESS' && e.awsAction === 'ce:GetCostAndUsage'));
  });

  it('refuses a billing action that is not on the allowlist', async () => {
    asFinley();
    const res = await call(port, '/aws-billing/', {
      token: finleyToken,
      body: {},
      headers: { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsageWithResources' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json().error, 'action_not_allowed');
  });

  it('does not fall back to a shared AWS billing secret for another agent', async () => {
    asCastle();
    const res = await call(port, '/aws-billing/', {
      token: castleToken,
      body: {},
      headers: { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
    });
    assert.equal(res.status, 503);
    assert.equal(res.json().error, 'credential_unbound');
    assert.ok(!res.text.includes('AKIASHAREDSHOULDNOTUSE'));
    assert.ok(!res.text.includes(AWS_SECRET.secret_access_key));
  });

  it('clears the AWS session when Cost Explorer returns 401', async () => {
    asFinley();
    stsSeen.length = 0;
    ceStatus = 401;
    try {
      const first = await call(port, '/aws-billing/', {
        token: finleyToken,
        body: {},
        headers: { 'x-amz-target': 'AWSInsightsIndexService.GetCostForecast' },
      });
      assert.equal(first.status, 401);
      const assumes = stsSeen.length;
      ceStatus = 200;
      const second = await call(port, '/aws-billing/', {
        token: finleyToken,
        body: {},
        headers: { 'x-amz-target': 'AWSInsightsIndexService.GetCostForecast' },
      });
      assert.equal(second.status, 200);
      assert.ok(stsSeen.length > assumes, 'AssumeRole must run again after 401');
    } finally {
      ceStatus = 200;
    }
  });

  it('mints a GCP access token and injects it only on the allowlisted BigQuery query path', async () => {
    asFinley();
    bqSeen.length = 0;
    const res = await call(port, '/gcp-billing/bigquery/v2/projects/submind-matrix/queries', {
      token: finleyToken,
      body: { query: 'SELECT 1', useLegacySql: false },
    });
    assert.equal(res.status, 200);
    assert.equal(bqSeen.length, 1);
    assert.equal(bqSeen[0]!.headers.authorization, 'Bearer ya29.test-access-token');
    assert.ok(!String(bqSeen[0]!.headers.authorization).includes(finleyToken));
    assert.ok(!JSON.stringify(bqSeen[0]!.headers).includes(PRIVATE_KEY.slice(0, 40)));
    assert.ok(ledger.some((e) => e.action === 'EGRESS' && String(e.gcpAction).includes('/bigquery/v2/projects/submind-matrix/queries')));
  });

  it('allows GET of a query job in submind-matrix and refuses any other project or write method', async () => {
    asFinley();
    const ok = await call(port, '/gcp-billing/bigquery/v2/projects/submind-matrix/queries/job_abc-1?location=US', {
      token: finleyToken,
      method: 'GET',
    });
    assert.equal(ok.status, 200);

    const other = await call(port, '/gcp-billing/bigquery/v2/projects/other-project/queries', {
      token: finleyToken,
      body: { query: 'SELECT 1' },
    });
    assert.equal(other.status, 403);
    assert.equal(other.json().error, 'action_not_allowed');

    const write = await call(port, '/gcp-billing/bigquery/v2/projects/submind-matrix/datasets', {
      token: finleyToken,
      body: {},
    });
    assert.equal(write.status, 403);
  });

  it('does not fall back to a shared GCP credential for another agent, and never leaks the key', async () => {
    asCastle();
    const res = await call(port, '/gcp-billing/bigquery/v2/projects/submind-matrix/queries', {
      token: castleToken,
      body: { query: 'SELECT 1' },
    });
    assert.equal(res.status, 503);
    assert.equal(res.json().error, 'credential_unbound');
    assert.ok(!res.text.includes(PRIVATE_KEY.slice(0, 40)));
    assert.ok(!res.text.includes('shared@example.com'));
  });

  it('does not leak the long-lived AWS secret when AssumeRole fails', async () => {
    asFinley();
    ceStatus = 401;
    const evict = await call(port, '/aws-billing/', {
      token: finleyToken,
      body: {},
      headers: { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
    });
    assert.equal(evict.status, 401);
    ceStatus = 200;
    const previous = secrets.FINLEY_AWS_BILLING_CREDENTIALS;
    secrets.FINLEY_AWS_BILLING_CREDENTIALS = JSON.stringify({ ...AWS_SECRET, access_key_id: 'AKIATESTACCESSKEY02' });
    stsStatus = 403;
    try {
      const res = await call(port, '/aws-billing/', {
        token: finleyToken,
        body: {},
        headers: { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' },
      });
      assert.equal(res.status, 502);
      assert.equal(res.json().error, 'upstream_unreachable');
      assert.ok(!res.text.includes(AWS_SECRET.secret_access_key));
      assert.ok(!res.text.includes('AKIATESTACCESSKEY02'));
    } finally {
      stsStatus = 200;
      secrets.FINLEY_AWS_BILLING_CREDENTIALS = previous;
    }
  });
});
