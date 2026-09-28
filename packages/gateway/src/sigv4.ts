import { createHash, createHmac } from 'node:crypto';

/** Cloud credentials held by the gateway (never by agents, E5/S1). */
export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };

export type SignableRequest = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | Buffer;
};

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as SigV4 requires: everything except unreserved characters. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20150830T123600Z` */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * AWS Signature Version 4 for non-S3 services: the canonical URI encodes each segment of the
 * request path again (so a path already carrying `%3A` is signed as `%253A`), as the AWS SDKs do.
 * Returns the headers to send (input headers plus host, x-amz-date, x-amz-content-sha256 when
 * requested, x-amz-security-token, authorization).
 */
export function signV4(
  req: SignableRequest,
  creds: AwsCredentials,
  scope: { region: string; service: string },
  now: Date = new Date(),
  opts: { contentSha256Header?: boolean } = {},
): Record<string, string> {
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const payloadHash = sha256(req.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
  headers['host'] = req.url.host;
  headers['x-amz-date'] = date;
  if (opts.contentSha256Header) headers['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  delete headers['authorization'];

  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = (req.url.pathname || '/').split('/').map(uriEncode).join('/');
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [req.method.toUpperCase(), canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', date, credentialScope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, day);
  const kRegion = hmac(kDate, scope.region);
  const kService = hmac(kRegion, scope.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

type Fetch = typeof fetch;

/**
 * The gateway's own AWS credentials: static env (local use) or the ECS container credentials
 * endpoint (Fargate task role), cached until five minutes before expiry.
 */
export function awsCredentialsFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: Fetch = fetch): () => Promise<AwsCredentials> {
  let cached: AwsCredentials | undefined;
  return async () => {
    if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
      return { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined };
    }
    if (cached && (!cached.expiration || cached.expiration.getTime() - Date.now() > 5 * 60_000)) return cached;
    const url = env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
      ? `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`
      : env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
    if (!url) throw new Error('no AWS credentials: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or run with a container role');
    const headers: Record<string, string> = {};
    if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN) headers.authorization = env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`container credentials endpoint ${res.status}`);
    const j = (await res.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string; Expiration?: string };
    if (!j.AccessKeyId || !j.SecretAccessKey) throw new Error('container credentials endpoint returned no keys');
    cached = { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token, expiration: j.Expiration ? new Date(j.Expiration) : undefined };
    return cached;
  };
}
