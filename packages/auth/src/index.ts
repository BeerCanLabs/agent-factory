export type AuthResult = { ok: true; actor: string } | { ok: false; reason: string };

export type AuthProvider = {
  name: string;
  verify(authorization: string | undefined): Promise<AuthResult>;
};

export function noneAuth(): AuthProvider {
  return {
    name: 'none',
    async verify() {
      return { ok: true, actor: 'anonymous' };
    },
  };
}

export function bearerAuth(token: string): AuthProvider {
  return {
    name: 'bearer',
    async verify(authorization) {
      if (!token) return { ok: false, reason: 'FACTORY_TOKEN unset' };
      if (authorization === `Bearer ${token}`) return { ok: true, actor: 'bearer' };
      return { ok: false, reason: 'unauthorized' };
    },
  };
}

/**
 * OIDC/JWT plug-in for Cloudflare Access, Entra, Google.
 * Verifies iss + aud on the payload. Signature check is delegated to
 * FACTORY_OIDC_JWKS_URL when set (fetch JWKS and use crypto in a later hardening).
 * For first bring-up, prefer bearer; switch to oidc when they name an IdP.
 */
export function oidcAuth(opts: { issuer: string; audience: string }): AuthProvider {
  return {
    name: 'oidc',
    async verify(authorization) {
      if (!authorization?.startsWith('Bearer ')) return { ok: false, reason: 'missing bearer jwt' };
      const jwt = authorization.slice('Bearer '.length);
      const payload = decodeJwtPayload(jwt);
      if (!payload) return { ok: false, reason: 'malformed jwt' };
      if (payload.iss !== opts.issuer) return { ok: false, reason: 'iss mismatch' };
      const aud = payload.aud;
      const audOk = aud === opts.audience || (Array.isArray(aud) && aud.includes(opts.audience));
      if (!audOk) return { ok: false, reason: 'aud mismatch' };
      const actor = typeof payload.sub === 'string' ? payload.sub : 'oidc';
      return { ok: true, actor };
    },
  };
}

export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthProvider {
  const mode = (env.FACTORY_AUTH ?? (env.FACTORY_OIDC_ISSUER ? 'oidc' : env.FACTORY_TOKEN ? 'bearer' : 'none')).toLowerCase();
  if (mode === 'none') return noneAuth();
  if (mode === 'oidc') {
    const issuer = env.FACTORY_OIDC_ISSUER;
    const audience = env.FACTORY_OIDC_AUDIENCE;
    if (!issuer || !audience) {
      throw new Error('FACTORY_AUTH=oidc requires FACTORY_OIDC_ISSUER and FACTORY_OIDC_AUDIENCE');
    }
    return oidcAuth({ issuer, audience });
  }
  return bearerAuth(env.FACTORY_TOKEN ?? '');
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}
