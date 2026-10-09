import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { awsCredentialsFromEnv, signV4 } from './sigv4.js';

const EXAMPLE = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

describe('SigV4', () => {
  it('matches the AWS SigV4 test suite vector get-vanilla', () => {
    const h = signV4(
      { method: 'GET', url: new URL('https://example.amazonaws.com/'), headers: {}, body: '' },
      EXAMPLE,
      { region: 'us-east-1', service: 'service' },
      new Date('2015-08-30T12:36:00Z'),
    );
    assert.equal(
      h.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    assert.equal(h['x-amz-date'], '20150830T123600Z');
  });

  it('matches the AWS SDK signer (@smithy/signature-v4) for a Bedrock Converse call with a session token', () => {
    // Expected value produced by @smithy/signature-v4 for the identical request (path segment `%3A` is
    // signed double-encoded as `%253A`, as the SDK does for every service except S3).
    const url = new URL(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${encodeURIComponent('us.anthropic.claude-sonnet-4-5-20250929-v1:0')}/converse`);
    const h = signV4(
      { method: 'POST', url, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'hi' }] }] }) },
      { ...EXAMPLE, sessionToken: 'SESSIONTOKEN123' },
      { region: 'us-east-1', service: 'bedrock' },
      new Date('2026-09-28T12:34:56Z'),
      { contentSha256Header: true },
    );
    assert.equal(
      h.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260928/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=68b91d2a22946d899acbcd8471b1fbef780dc90cd2d13f1b1abf8fb53a0dcf6c',
    );
    assert.equal(h['x-amz-security-token'], 'SESSIONTOKEN123');
  });
});

describe('gatekeeper-egress AWS credentials', () => {
  it('uses static env credentials when present', async () => {
    const creds = await awsCredentialsFromEnv({ AWS_ACCESS_KEY_ID: 'AK', AWS_SECRET_ACCESS_KEY: 'SK', AWS_SESSION_TOKEN: 'ST' }, async () => {
      throw new Error('must not call the endpoint');
    })();
    assert.deepEqual(creds, { accessKeyId: 'AK', secretAccessKey: 'SK', sessionToken: 'ST' });
  });

  it('reads the ECS container credentials endpoint and caches until near expiry', async () => {
    const urls: string[] = [];
    let expiry = new Date(Date.now() + 60 * 60_000);
    const fake = (async (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ AccessKeyId: `AK${urls.length}`, SecretAccessKey: 'SK', Token: 'T', Expiration: expiry.toISOString() }), { status: 200 });
    }) as typeof fetch;
    const get = awsCredentialsFromEnv({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }, fake);
    assert.equal((await get()).accessKeyId, 'AK1');
    assert.equal((await get()).accessKeyId, 'AK1', 'cached');
    assert.deepEqual(urls, ['http://169.254.170.2/v2/credentials/abc']);

    expiry = new Date(Date.now() + 60_000);
    const soon = awsCredentialsFromEnv({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc' }, fake);
    await soon();
    await soon();
    assert.equal(urls.length, 3, 'credentials within five minutes of expiry are refreshed');
  });

  it('fails clearly with no credential source', async () => {
    await assert.rejects(awsCredentialsFromEnv({})(), /no AWS credentials/);
  });
});
