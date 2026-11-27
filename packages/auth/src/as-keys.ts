import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { calculateJwkThumbprint, type JWK } from 'jose';

export const AS_SIGNING_ALG = 'ES256' as const;

export type AsPublicJwk = JWK & {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  kid: string;
  use: 'sig';
  alg: 'ES256';
};

export type AsKey = {
  kid: string;
  /** PKCS#8 PEM of the ES256 private key. Never log or expose this. */
  privateKeyPem: string;
  privateKey: KeyObject;
  publicJwk: AsPublicJwk;
};

/**
 * Optional production signer (e.g. AWS KMS ECC_NIST_P256) injected by the control plane.
 * Slice 1 does not ship a KMS client; set a PEM/JWK (or secret) or inject this signer.
 */
export type ExternalAsSigner = {
  kid: string;
  alg: 'ES256';
  publicJwk: AsPublicJwk;
  sign(data: Uint8Array): Promise<Uint8Array>;
};

export type AsKeySet = {
  current: AsKey;
  previous?: AsKey;
  /** True when this process generated an in-memory key because none was configured. */
  ephemeral: boolean;
};

export type SecretReader = { get(name: string): Promise<string | undefined> };

export const JWKS_CACHE_CONTROL = 'public, max-age=3600';

export function publicJwksOf(set: AsKeySet): { keys: AsPublicJwk[] } {
  const keys = [set.current.publicJwk];
  if (set.previous && set.previous.kid !== set.current.kid) keys.push(set.previous.publicJwk);
  return { keys };
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function requirePrivateJwk(jwk: JWK): void {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new Error('AS signing key must be an EC P-256 (ES256) private key');
  }
  if (typeof jwk.d !== 'string' || !jwk.d) {
    throw new Error('AS signing JWK is missing the private `d` parameter');
  }
}

export async function asKeyFromMaterial(material: string, kid?: string): Promise<AsKey> {
  const trimmed = material.trim();
  if (!trimmed) throw new Error('AS signing key material is empty');
  let key: KeyObject;
  if (trimmed.startsWith('{')) {
    let jwk: JWK;
    try {
      jwk = JSON.parse(trimmed) as JWK;
    } catch {
      throw new Error('AS signing key is not valid JSON JWK');
    }
    requirePrivateJwk(jwk);
    key = createPrivateKey({ key: jwk, format: 'jwk' });
  } else {
    try {
      key = createPrivateKey(trimmed);
    } catch (err) {
      throw new Error(`AS signing key PEM could not be parsed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('AS signing key must be an EC P-256 (ES256) private key');
  }
  const privateKeyPem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicJwk = createPublicKey(key).export({ format: 'jwk' }) as JWK;
  const { d: _d, ...pubOnly } = publicJwk as JWK & { d?: string };
  const thumbprint = await calculateJwkThumbprint({ kty: 'EC', crv: pubOnly.crv, x: pubOnly.x, y: pubOnly.y }, 'sha256');
  const resolvedKid = kid?.trim() || thumbprint;
  return {
    kid: resolvedKid,
    privateKeyPem,
    privateKey: key,
    publicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: pubOnly.x as string,
      y: pubOnly.y as string,
      kid: resolvedKid,
      use: 'sig',
      alg: AS_SIGNING_ALG,
    },
  };
}

export async function generateEphemeralAsKey(kid?: string): Promise<AsKey> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return asKeyFromMaterial(pem, kid);
}

export async function loadAsKeySet(opts: {
  currentMaterial?: string;
  currentKid?: string;
  previousMaterial?: string;
  previousKid?: string;
  allowEphemeral?: boolean;
}): Promise<AsKeySet> {
  const currentMaterial = opts.currentMaterial?.trim();
  if (currentMaterial) {
    const current = await asKeyFromMaterial(currentMaterial, opts.currentKid);
    const previousMaterial = opts.previousMaterial?.trim();
    const previous = previousMaterial ? await asKeyFromMaterial(previousMaterial, opts.previousKid) : undefined;
    return { current, previous, ephemeral: false };
  }
  if (opts.allowEphemeral === false) {
    throw new Error('no AS signing key configured: set FACTORY_AS_SIGNING_KEY (PEM or JWK) or FACTORY_AS_SIGNING_KEY_SECRET');
  }
  return { current: await generateEphemeralAsKey(opts.currentKid), ephemeral: true };
}

/**
 * Load the factory AS key set from env and optional secret providers.
 *
 * Recognised env:
 *   FACTORY_AS_SIGNING_KEY / FACTORY_AS_SIGNING_KEY_KID
 *   FACTORY_AS_PREVIOUS_SIGNING_KEY / FACTORY_AS_PREVIOUS_SIGNING_KEY_KID
 *   FACTORY_AS_SIGNING_KEY_SECRET / FACTORY_AS_PREVIOUS_SIGNING_KEY_SECRET  (names resolved via `secrets`)
 *   FACTORY_AS_KMS_KEY_ID — reserved; if set without PEM/JWK material, this throws (inject a signer or provide PEM)
 *
 * When nothing is configured, an ephemeral P-256 key is generated (dev/test). Callers should warn.
 * A configured signing-key secret that cannot be read fails closed: it does not fall back to an ephemeral key.
 */
export async function loadAsKeySetFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  secrets: readonly SecretReader[] = [],
): Promise<AsKeySet> {
  const readSecret = async (label: string, name: string | undefined): Promise<string | undefined> => {
    const trimmed = name?.trim();
    if (!trimmed) return undefined;
    for (const provider of secrets) {
      let value: string | undefined;
      try {
        value = await provider.get(trimmed);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`${label} is configured (${trimmed}) but could not be read: ${detail}`);
      }
      if (typeof value === 'string' && value.trim()) return value;
    }
    throw new Error(`${label} is configured (${trimmed}) but could not be read: SecretReader returned no value`);
  };

  const currentMaterial =
    env.FACTORY_AS_SIGNING_KEY?.trim() || (await readSecret('FACTORY_AS_SIGNING_KEY_SECRET', env.FACTORY_AS_SIGNING_KEY_SECRET));
  const previousMaterial =
    env.FACTORY_AS_PREVIOUS_SIGNING_KEY?.trim() ||
    (await readSecret('FACTORY_AS_PREVIOUS_SIGNING_KEY_SECRET', env.FACTORY_AS_PREVIOUS_SIGNING_KEY_SECRET));
  const kmsKeyId = env.FACTORY_AS_KMS_KEY_ID?.trim();
  if (kmsKeyId && !currentMaterial) {
    throw new Error(
      'FACTORY_AS_KMS_KEY_ID is set but no KMS signer is wired and no FACTORY_AS_SIGNING_KEY / FACTORY_AS_SIGNING_KEY_SECRET was provided',
    );
  }
  return loadAsKeySet({
    currentMaterial,
    currentKid: env.FACTORY_AS_SIGNING_KEY_KID,
    previousMaterial,
    previousKid: env.FACTORY_AS_PREVIOUS_SIGNING_KEY_KID,
    allowEphemeral: true,
  });
}

export function parseIssuerAliases(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => stripTrailingSlash(part.trim()))
    .filter(Boolean);
}
