import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type CallbackPolicy = {
  signingKey?: string;
  /** Dev/test only: permit http:// and loopback/private targets. */
  allowInsecure: boolean;
  attempts: number;
  backoffMs: number;
};

export function callbackPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): CallbackPolicy {
  return {
    signingKey: env.FACTORY_CALLBACK_SIGNING_KEY || undefined,
    allowInsecure: env.FACTORY_ALLOW_INSECURE_CALLBACKS === '1',
    attempts: 3,
    backoffMs: 1000,
  };
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Returns an error string if the URL may not be used as a callback target, else undefined. */
export function checkCallbackUrl(raw: string, policy: CallbackPolicy): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'callbackUrl is not a valid URL';
  }
  if (url.protocol !== 'https:' && !(policy.allowInsecure && url.protocol === 'http:')) {
    return 'callbackUrl must be https';
  }
  if (url.username || url.password) return 'callbackUrl must not embed credentials';
  if (!policy.signingKey) return 'callbacks are disabled: FACTORY_CALLBACK_SIGNING_KEY is not set';
  return undefined;
}

async function resolvesPrivate(host: string): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return isPrivateAddress(bare);
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare.endsWith('.internal')) return true;
  const addrs = await lookup(bare, { all: true });
  return addrs.some((a) => isPrivateAddress(a.address));
}

export function signBody(key: string, timestamp: string, body: string): string {
  return createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex');
}

/** POST a signed JSON payload with retries. Receivers verify `x-factory-signature: t=<ts>,v1=<hmac>`. */
export async function deliverCallback(
  rawUrl: string,
  payload: unknown,
  policy: CallbackPolicy,
): Promise<{ ok: boolean; status?: number; error?: string; attempts: number }> {
  const bad = checkCallbackUrl(rawUrl, policy);
  if (bad) return { ok: false, error: bad, attempts: 0 };
  const url = new URL(rawUrl);
  if (!policy.allowInsecure && (await resolvesPrivate(url.hostname).catch(() => true))) {
    return { ok: false, error: 'callbackUrl resolves to a private or unresolvable address', attempts: 0 };
  }
  const body = JSON.stringify(payload);
  let last: { status?: number; error?: string } = {};
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'x-factory-signature': `t=${ts},v1=${signBody(policy.signingKey!, ts, body)}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };
      last = { status: res.status };
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      last = { error: err instanceof Error ? err.message : String(err) };
    }
    if (attempt < policy.attempts) await new Promise((r) => setTimeout(r, policy.backoffMs * 4 ** (attempt - 1)));
  }
  return { ok: false, ...last, attempts: policy.attempts };
}
