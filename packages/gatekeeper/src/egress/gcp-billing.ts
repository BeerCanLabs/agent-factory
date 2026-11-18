/**
 * GCP service-account JWT billing credentials (S1): the gatekeeper-egress mints an access
 * token from a per-agent JSON key and injects it only on read-only BigQuery jobs/query
 * calls for project `submind-matrix`. Agents never see the key.
 */
import { signJwtRs256 } from '@beercanlabs/factory-keymaster';

export const GCP_BILLING_PROJECT = 'submind-matrix';
export const GCP_BIGQUERY_HOST = 'bigquery.googleapis.com';
export const GCP_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GCP_BIGQUERY_READONLY_SCOPE = 'https://www.googleapis.com/auth/bigquery.readonly';

const QUERY_POST = new RegExp(`^/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries$`);
const QUERY_GET = new RegExp(`^/bigquery/v2/projects/${GCP_BILLING_PROJECT}/queries/[-_A-Za-z0-9]+$`);

export type ParsedServiceAccount = {
  clientEmail: string;
  privateKey: string;
  privateKeyId?: string;
  tokenUri: string;
};

export type GcpBillingAction =
  | { ok: true; dest: URL; method: 'GET' | 'POST' }
  | { ok: false; error: 'action_not_allowed' };

export type GcpBillingHostOverrides = { bigquery?: string; token?: string };

export function isGcpSaJwt(encoding: string | undefined): boolean {
  return encoding === 'gcp-sa-jwt';
}

function pathnameOf(path: string): string {
  return (path.split('?')[0] || '/');
}

export function gcpBillingActionOf(
  method: string | undefined,
  path: string,
  hosts?: GcpBillingHostOverrides,
): GcpBillingAction {
  const verb = (method ?? 'GET').toUpperCase();
  const pathname = pathnameOf(path);
  const search = path.includes('?') ? path.slice(path.indexOf('?')) : '';
  const allowed =
    (verb === 'POST' && QUERY_POST.test(pathname)) ||
    (verb === 'GET' && QUERY_GET.test(pathname));
  if (!allowed) return { ok: false, error: 'action_not_allowed' };
  const override = hosts?.bigquery;
  const dest = override
    ? new URL(`http://${override}${pathname}${search}`)
    : new URL(`https://${GCP_BIGQUERY_HOST}${pathname}${search}`);
  return { ok: true, dest, method: verb as 'GET' | 'POST' };
}

export function parseServiceAccount(raw: string, secretValues?: Set<string>): ParsedServiceAccount | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const o = parsed as Record<string, unknown>;
  const clientEmail = str(o.client_email);
  const privateKeyRaw = typeof o.private_key === 'string' ? o.private_key : undefined;
  const privateKey = privateKeyRaw?.trim();
  const privateKeyId = str(o.private_key_id);
  const tokenUri = str(o.token_uri) ?? GCP_TOKEN_URL;
  if (!clientEmail || !privateKey) return undefined;
  if (secretValues) {
    for (const v of [raw, privateKey, privateKeyRaw ?? '', privateKeyId ?? '']) if (v.length >= 4) secretValues.add(v);
  }
  return { clientEmail, privateKey, ...(privateKeyId ? { privateKeyId } : {}), tokenUri };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export async function mintGcpAccessToken(
  sa: ParsedServiceAccount,
  opts: {
    now?: () => number;
    fetchImpl?: typeof fetch;
    tokenUrl?: string;
    secretValues?: Set<string>;
  } = {},
): Promise<{ accessToken: string; expiresAt: Date }> {
  const nowMs = opts.now?.() ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const tokenUrl = opts.tokenUrl ?? sa.tokenUri ?? GCP_TOKEN_URL;
  const assertion = signJwtRs256(
    { alg: 'RS256', typ: 'JWT', ...(sa.privateKeyId ? { kid: sa.privateKeyId } : {}) },
    {
      iss: sa.clientEmail,
      scope: GCP_BIGQUERY_READONLY_SCOPE,
      aud: tokenUrl,
      iat: nowSec,
      exp: nowSec + 3600,
    },
    sa.privateKey,
  );
  const res = await (opts.fetchImpl ?? fetch)(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof body.access_token !== 'string') {
    throw new Error(`gcp_token_failed:${typeof body.error === 'string' ? body.error : res.status}`);
  }
  const expiresAt = new Date(nowMs + (typeof body.expires_in === 'number' ? body.expires_in : 3600) * 1000);
  if (opts.secretValues && body.access_token.length >= 4) opts.secretValues.add(body.access_token);
  return { accessToken: body.access_token, expiresAt };
}

/** Access tokens, refreshed five minutes before they expire. */
export function gcpTokenCache(opts: {
  mint: (sa: ParsedServiceAccount) => Promise<{ accessToken: string; expiresAt: Date }>;
  now?: () => number;
}): { get: (sa: ParsedServiceAccount) => Promise<string>; clear: () => void } {
  const sessions = new Map<string, { token: string; expiresAt: Date; inflight?: Promise<string> }>();
  const keyOf = (sa: ParsedServiceAccount) => sa.clientEmail;
  return {
    clear() {
      sessions.clear();
    },
    async get(sa) {
      const key = keyOf(sa);
      const hit = sessions.get(key);
      const now = opts.now?.() ?? Date.now();
      if (hit?.token && hit.expiresAt.getTime() - now > 5 * 60_000) return hit.token;
      if (hit?.inflight) return hit.inflight;
      const inflight = opts.mint(sa).then((tok) => {
        sessions.set(key, { token: tok.accessToken, expiresAt: tok.expiresAt });
        return tok.accessToken;
      }).catch((err) => {
        sessions.delete(key);
        throw err;
      }).finally(() => {
        const cur = sessions.get(key);
        if (cur?.inflight === inflight) delete cur.inflight;
      });
      sessions.set(key, { token: hit?.token ?? '', expiresAt: hit?.expiresAt ?? new Date(0), inflight });
      return inflight;
    },
  };
}
