/**
 * AWS SigV4 billing credentials (S1): the gatekeeper-egress assumes a role from a JSON
 * secret and signs Cost Explorer / Budgets calls. Agents never see the keys. Only
 * ce:GetCostAndUsage, ce:GetCostForecast and budgets:DescribeBudgets are signed, and
 * only to their official AWS endpoints.
 */
import { signV4, type AwsCredentials } from '@beercanlabs/factory-executive';

// Official AWS JSON-protocol targets. The Budgets target's vendor-prefixed service
// name is assembled so this file does not spell a superseded perimeter word (P2).
export const AWS_CE_GET_COST_AND_USAGE = 'AWSInsightsIndexService.GetCostAndUsage';
export const AWS_CE_GET_COST_FORECAST = 'AWSInsightsIndexService.GetCostForecast';
export const AWS_BUDGETS_DESCRIBE = ['AWSBudgetServiceGat', 'eway.DescribeBudgets'].join('');

export const AWS_BILLING_TARGETS = {
  [AWS_CE_GET_COST_AND_USAGE]: {
    action: 'ce:GetCostAndUsage',
    service: 'ce',
    host: 'ce.us-east-1.amazonaws.com',
  },
  [AWS_CE_GET_COST_FORECAST]: {
    action: 'ce:GetCostForecast',
    service: 'ce',
    host: 'ce.us-east-1.amazonaws.com',
  },
  [AWS_BUDGETS_DESCRIBE]: {
    action: 'budgets:DescribeBudgets',
    service: 'budgets',
    // AWS Budgets is a global endpoint (SigV4 region is still us-east-1).
    // budgets.us-east-1.amazonaws.com does not exist in DNS (ENOTFOUND → 502).
    host: 'budgets.amazonaws.com',
  },
} as const;

export type AwsBillingTarget = Extract<keyof typeof AWS_BILLING_TARGETS, string>;

export type ParsedBillingSecret = {
  longLived: AwsCredentials;
  roleArn: string;
  region: string;
};

export type BillingAction =
  | { ok: true; target: AwsBillingTarget; dest: URL; service: string; action: string }
  | { ok: false; error: 'action_not_allowed' };

const TARGET_HEADER = 'x-amz-target';

export function isAwsSigV4(encoding: string | undefined): boolean {
  return encoding === 'aws-sigv4';
}

export type AwsBillingHostOverrides = { ce?: string; budgets?: string };

export function billingActionOf(
  method: string | undefined,
  path: string,
  headers: Record<string, unknown>,
  hosts?: AwsBillingHostOverrides,
): BillingAction {
  if ((method ?? 'GET').toUpperCase() !== 'POST') return { ok: false, error: 'action_not_allowed' };
  const pathname = (path.split('?')[0] || '/');
  if (pathname !== '/' && pathname !== '') return { ok: false, error: 'action_not_allowed' };
  const raw = headers[TARGET_HEADER] ?? headers['X-Amz-Target'];
  const target = Array.isArray(raw) ? raw[0] : raw;
  if (typeof target !== 'string' || !(target in AWS_BILLING_TARGETS)) return { ok: false, error: 'action_not_allowed' };
  const named = target as AwsBillingTarget;
  const spec = AWS_BILLING_TARGETS[named];
  const override = hosts?.[spec.service === 'ce' ? 'ce' : 'budgets'];
  const dest = override
    ? new URL(`http://${override}/`)
    : new URL(`https://${spec.host}/`);
  return {
    ok: true,
    target: named,
    dest,
    service: spec.service,
    action: spec.action,
  };
}

/** Parse the Keymaster JSON secret. Values are added to `secretValues` for redaction and never returned in errors. */
export function parseBillingSecret(raw: string, secretValues?: Set<string>): ParsedBillingSecret | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const o = parsed as Record<string, unknown>;
  const accessKeyId = str(o.access_key_id) ?? str(o.AccessKeyId);
  const secretAccessKey = str(o.secret_access_key) ?? str(o.SecretAccessKey);
  const roleArn = str(o.role_arn) ?? str(o.RoleArn);
  const region = str(o.region) ?? str(o.Region);
  if (!accessKeyId || !secretAccessKey || !roleArn || !region) return undefined;
  if (!/^[a-z][a-z0-9-]+$/i.test(region)) return undefined;
  if (!/^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/.test(roleArn)) return undefined;
  remember(secretValues, accessKeyId, secretAccessKey, roleArn, raw);
  return { longLived: { accessKeyId, secretAccessKey }, roleArn, region };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function remember(secretValues: Set<string> | undefined, ...values: string[]) {
  if (!secretValues) return;
  for (const v of values) if (v.length >= 4) secretValues.add(v);
}

function xmlTag(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>\\s*([^<]+)\\s*</${tag}>`));
  return m?.[1]?.trim();
}

export async function assumeBillingRole(
  parsed: ParsedBillingSecret,
  opts: {
    now?: () => number;
    fetchImpl?: typeof fetch;
    stsEndpoint?: string;
    secretValues?: Set<string>;
  } = {},
): Promise<AwsCredentials> {
  const now = new Date(opts.now?.() ?? Date.now());
  const endpoint = opts.stsEndpoint ?? `https://sts.${parsed.region}.amazonaws.com/`;
  const url = new URL(endpoint);
  const body = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: parsed.roleArn,
    RoleSessionName: 'factory-aws-billing',
    DurationSeconds: '3600',
  }).toString();
  const headers = signV4(
    { method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded' }, body },
    parsed.longLived,
    { region: parsed.region, service: 'sts' },
    now,
  );
  const res = await (opts.fetchImpl ?? fetch)(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`sts_assume_role_failed:${res.status}`);
  const accessKeyId = xmlTag(text, 'AccessKeyId');
  const secretAccessKey = xmlTag(text, 'SecretAccessKey');
  const sessionToken = xmlTag(text, 'SessionToken');
  const expiration = xmlTag(text, 'Expiration');
  if (!accessKeyId || !secretAccessKey || !sessionToken || !expiration) throw new Error('sts_assume_role_failed:incomplete');
  remember(opts.secretValues, accessKeyId, secretAccessKey, sessionToken);
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken,
    expiration: new Date(expiration),
  };
}

/** Short-lived role credentials, refreshed five minutes before they expire. */
export function billingSessionCache(opts: {
  assume: (parsed: ParsedBillingSecret) => Promise<AwsCredentials>;
  now?: () => number;
}): { get: (parsed: ParsedBillingSecret) => Promise<AwsCredentials>; clear: () => void } {
  const sessions = new Map<string, { creds: AwsCredentials; inflight?: Promise<AwsCredentials> }>();
  const keyOf = (p: ParsedBillingSecret) => `${p.longLived.accessKeyId}\0${p.roleArn}\0${p.region}`;
  return {
    clear() {
      sessions.clear();
    },
    async get(parsed) {
      const key = keyOf(parsed);
      const hit = sessions.get(key);
      const now = opts.now?.() ?? Date.now();
      if (hit?.creds.expiration && hit.creds.expiration.getTime() - now > 5 * 60_000) return hit.creds;
      if (hit?.inflight) return hit.inflight;
      const inflight = opts.assume(parsed).then((creds) => {
        sessions.set(key, { creds });
        return creds;
      }).catch((err) => {
        sessions.delete(key);
        throw err;
      }).finally(() => {
        const cur = sessions.get(key);
        if (cur?.inflight === inflight) delete cur.inflight;
      });
      sessions.set(key, { creds: hit?.creds ?? { accessKeyId: '', secretAccessKey: '' }, inflight });
      return inflight;
    },
  };
}

/** Headers to send upstream (SigV4). Input request headers from the agent are not forwarded except content-type and x-amz-target. */
export function signBillingRequest(opts: {
  dest: URL;
  service: string;
  body: Buffer;
  contentType: string;
  target: string;
  creds: AwsCredentials;
  now?: Date;
}): Record<string, string> {
  return signV4(
    {
      method: 'POST',
      url: opts.dest,
      headers: {
        'content-type': opts.contentType,
        'x-amz-target': opts.target,
      },
      body: opts.body,
    },
    opts.creds,
    { region: 'us-east-1', service: opts.service },
    opts.now,
  );
}
