import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** S5 / D3, D14, D23: factory API keys are `fk_` + 32 random bytes (base64url). Only the SHA-256 hash is stored. */
export const API_KEY_PREFIX = 'fk_';

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = API_KEY_PREFIX + randomBytes(32).toString('base64url');
  return { plaintext, prefix: plaintext.slice(0, 10), hash: hashApiKey(plaintext) };
}

/** Constant-time comparison of two hex SHA-256 digests. */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** The bearer value when an Authorization header carries an `fk_` key, else undefined. */
export function apiKeyFromAuthorization(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer\s+(fk_[A-Za-z0-9_-]{1,200})\s*$/.exec(authorization);
  if (m) return m[1];
  return /^Bearer\s+fk_/.test(authorization) ? '' : undefined;
}
