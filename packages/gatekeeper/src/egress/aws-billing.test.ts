import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AWS_BUDGETS_DESCRIBE, billingActionOf, billingSessionCache, parseBillingSecret, signBillingRequest, assumeBillingRole } from './aws-billing.js';
import type { ParsedBillingSecret } from './aws-billing.js';
import type { AwsCredentials } from '@beercanlabs/factory-executive';

const SECRET = {
  access_key_id: 'TESTACCESSKEY01XXXX',
  secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  role_arn: 'arn:aws:iam::566332862296:role/ChuckFinleyBillingReadOnly',
  region: 'us-east-1',
};

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('aws-billing parse and allowlist', () => {
  it('parses snake_case and AWS-cased JSON and redacts values', () => {
    const secretValues = new Set<string>();
    const a = parseBillingSecret(JSON.stringify(SECRET), secretValues);
    assert.ok(a);
    assert.equal(a!.longLived.accessKeyId, SECRET.access_key_id);
    assert.equal(a!.roleArn, SECRET.role_arn);
    assert.ok(secretValues.has(SECRET.secret_access_key));
    assert.ok(secretValues.has(SECRET.access_key_id));

    const b = parseBillingSecret(JSON.stringify({
      AccessKeyId: SECRET.access_key_id,
      SecretAccessKey: SECRET.secret_access_key,
      RoleArn: SECRET.role_arn,
      Region: 'us-east-1',
    }));
    assert.deepEqual(b?.roleArn, SECRET.role_arn);
  });

  it('rejects a missing field, a bad role ARN, or a bad region', () => {
    assert.equal(parseBillingSecret('not-json'), undefined);
    assert.equal(parseBillingSecret(JSON.stringify({ ...SECRET, role_arn: 'arn:aws:iam::566332862296:user/x' })), undefined);
    assert.equal(parseBillingSecret(JSON.stringify({ ...SECRET, region: 'us-east-1;evil' })), undefined);
    const { role_arn: _, ...rest } = SECRET;
    assert.equal(parseBillingSecret(JSON.stringify(rest)), undefined);
  });

  it('allows only the three billing actions to official hosts', () => {
    const ok = billingActionOf('POST', '/', { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.dest.href, 'https://ce.us-east-1.amazonaws.com/');
      assert.equal(ok.action, 'ce:GetCostAndUsage');
    }
    const forecast = billingActionOf('POST', '/', { 'X-Amz-Target': 'AWSInsightsIndexService.GetCostForecast' });
    assert.equal(forecast.ok, true);
    const budgets = billingActionOf('POST', '/', { 'x-amz-target': AWS_BUDGETS_DESCRIBE });
    assert.equal(budgets.ok, true);
    if (budgets.ok) assert.equal(budgets.dest.href, 'https://budgets.us-east-1.amazonaws.com/');

    assert.equal(billingActionOf('GET', '/', { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' }).ok, false);
    assert.equal(billingActionOf('POST', '/elsewhere', { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' }).ok, false);
    assert.equal(billingActionOf('POST', '/', { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsageWithResources' }).ok, false);
    assert.equal(billingActionOf('POST', '/', {}).ok, false);
  });

  it('test host overrides point at a local dest, never the official host', () => {
    const ok = billingActionOf('POST', '/', { 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage' }, { ce: '127.0.0.1:9' });
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.dest.href, 'http://127.0.0.1:9/');
  });
});

describe('aws-billing session cache', () => {
  const parsed = parseBillingSecret(JSON.stringify(SECRET))!;
  const creds = (exp: Date): AwsCredentials => ({
    accessKeyId: 'ASIASESSION',
    secretAccessKey: 'session-secret',
    sessionToken: 'session-token',
    expiration: exp,
  });

  it('reuses a live session and refreshes five minutes before expiry', async () => {
    let now = Date.parse('2026-11-17T18:00:00Z');
    let calls = 0;
    const cache = billingSessionCache({
      now: () => now,
      assume: async () => {
        calls += 1;
        return creds(new Date(now + 60 * 60_000));
      },
    });
    const a = await cache.get(parsed);
    const b = await cache.get(parsed);
    assert.equal(calls, 1);
    assert.equal(a.accessKeyId, b.accessKeyId);
    now += 56 * 60_000;
    await cache.get(parsed);
    assert.equal(calls, 2);
  });

  it('drops a failed assume so the next call retries', async () => {
    let calls = 0;
    const cache = billingSessionCache({
      assume: async () => {
        calls += 1;
        if (calls === 1) throw new Error('sts_down');
        return creds(new Date(Date.now() + 60 * 60_000));
      },
    });
    await assert.rejects(() => cache.get(parsed), /sts_down/);
    const ok = await cache.get(parsed);
    assert.equal(calls, 2);
    assert.equal(ok.accessKeyId, 'ASIASESSION');
  });
});

describe('aws-billing assume and sign', () => {
  it('AssumeRole posts to the STS endpoint and signs the billing request', async () => {
    const seen: { path: string; body: string; auth?: string }[] = [];
    const sts = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ path: req.url ?? '', body, auth: req.headers.authorization });
        res.setHeader('content-type', 'text/xml');
        res.end(`<AssumeRoleResponse><AssumeRoleResult><Credentials>
          <AccessKeyId>ASIASESSIONKEY01</AccessKeyId>
          <SecretAccessKey>session-secret-value-xxxx</SecretAccessKey>
          <SessionToken>session-token-value-xxxx</SessionToken>
          <Expiration>2099-01-01T00:00:00Z</Expiration>
        </Credentials></AssumeRoleResult></AssumeRoleResponse>`);
      });
    });
    const port = await listen(sts);
    try {
      const parsed = parseBillingSecret(JSON.stringify(SECRET))!;
      const secretValues = new Set<string>();
      const session = await assumeBillingRole(parsed, {
        stsEndpoint: `http://127.0.0.1:${port}/`,
        secretValues,
      });
      assert.equal(session.accessKeyId, 'ASIASESSIONKEY01');
      assert.ok(seen[0]?.body.includes('Action=AssumeRole'));
      assert.ok(seen[0]?.auth?.startsWith('AWS4-HMAC-SHA256'));
      assert.ok(secretValues.has('session-secret-value-xxxx'));
      const headers = signBillingRequest({
        dest: new URL('https://ce.us-east-1.amazonaws.com/'),
        service: 'ce',
        body: Buffer.from('{"Metrics":["UnblendedCost"]}'),
        contentType: 'application/x-amz-json-1.1',
        target: 'AWSInsightsIndexService.GetCostAndUsage',
        creds: session,
      });
      assert.match(headers.authorization ?? headers.Authorization ?? '', /AWS4-HMAC-SHA256/);
      assert.equal(headers['x-amz-target'] ?? headers['X-Amz-Target'], 'AWSInsightsIndexService.GetCostAndUsage');
    } finally {
      await new Promise<void>((r) => sts.close(() => r()));
    }
  });
});
