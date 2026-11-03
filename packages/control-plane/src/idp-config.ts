import http from 'node:http';
import { MemoryDocBackend, snapshotSha256, type VersionedDocBackend } from '@beercanlabs/factory-bouncer';
import { identify, json, readJson, requirePrivilege, type FactoryState } from './app.js';

/**
 * S6 (D16, R12): the identity providers this deployment trusts are a setup value, not code. Starter set: Google, Meta,
 * Cloudflare, plus generic OIDC. Only references to secrets are stored (`clientSecretRef`), never secret values.
 */
export const IDP_KINDS = ['google', 'meta', 'cloudflare', 'oidc'] as const;
export type IdpKind = (typeof IDP_KINDS)[number];

export type IdpProvider = {
  id: IdpKind;
  clientId: string;
  /** OIDC issuer URL (required for `oidc`), or the Cloudflare Access team domain for `cloudflare`. */
  issuer?: string;
  /** Name of the secret holding the client secret (e.g. a Secrets Manager id). Never the secret itself. */
  clientSecretRef?: string;
  /** Optional: only verified emails in these domains may sign in through this provider. */
  allowedDomains?: string[];
};

export type IdpConfigDoc = { providers: IdpProvider[] };

const SECRETISH = /secret|password|token|private/i;

export function validateIdpConfig(raw: unknown): { ok: true; doc: IdpConfigDoc } | { ok: false; error: string } {
  const list = (raw as { providers?: unknown })?.providers;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'providers must be a non-empty list' };
  const seen = new Set<string>();
  const providers: IdpProvider[] = [];
  for (const p of list as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'each provider must be an object' };
    for (const k of Object.keys(p)) {
      if (k !== 'clientSecretRef' && SECRETISH.test(k)) return { ok: false, error: `'${k}' looks like a secret; store a clientSecretRef instead` };
      if (!['id', 'clientId', 'issuer', 'clientSecretRef', 'allowedDomains'].includes(k)) return { ok: false, error: `unknown field '${k}'` };
    }
    if (!(IDP_KINDS as readonly string[]).includes(p.id as string)) return { ok: false, error: `id must be one of ${IDP_KINDS.join(', ')}` };
    if (seen.has(p.id as string)) return { ok: false, error: `duplicate provider '${p.id}'` };
    seen.add(p.id as string);
    if (typeof p.clientId !== 'string' || !p.clientId.trim()) return { ok: false, error: `${p.id}: clientId is required` };
    if ((p.id === 'oidc' || p.id === 'cloudflare') && (typeof p.issuer !== 'string' || !/^https:\/\/[^\s/]+/.test(p.issuer))) {
      return { ok: false, error: `${p.id}: issuer must be an https URL` };
    }
    if (p.clientSecretRef !== undefined && (typeof p.clientSecretRef !== 'string' || !/^[A-Za-z0-9/_+=.@-]{1,256}$/.test(p.clientSecretRef))) {
      return { ok: false, error: `${p.id}: clientSecretRef must be a secret name` };
    }
    let allowedDomains: string[] | undefined;
    if (p.allowedDomains !== undefined) {
      if (!Array.isArray(p.allowedDomains) || p.allowedDomains.some((d) => typeof d !== 'string' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))) {
        return { ok: false, error: `${p.id}: allowedDomains must be domain names` };
      }
      allowedDomains = [...new Set((p.allowedDomains as string[]).map((d) => d.toLowerCase()))];
    }
    providers.push({
      id: p.id as IdpKind,
      clientId: (p.clientId as string).trim(),
      ...(typeof p.issuer === 'string' ? { issuer: p.issuer } : {}),
      ...(typeof p.clientSecretRef === 'string' ? { clientSecretRef: p.clientSecretRef } : {}),
      ...(allowedDomains ? { allowedDomains } : {}),
    });
  }
  return { ok: true, doc: { providers } };
}

export class IdpConfigStore {
  private doc: IdpConfigDoc = { providers: [] };
  private version = 0;
  private constructor(private readonly backend: VersionedDocBackend<IdpConfigDoc>) {}

  static async open(backend: VersionedDocBackend<IdpConfigDoc> = new MemoryDocBackend()): Promise<IdpConfigStore> {
    const s = new IdpConfigStore(backend);
    const snap = await backend.loadLatest();
    if (snap) {
      const v = validateIdpConfig(snap.data);
      if (v.ok) s.doc = v.doc;
      s.version = snap.version;
    }
    return s;
  }

  get(): IdpConfigDoc {
    return structuredClone(this.doc);
  }

  get configured(): boolean {
    return this.doc.providers.length > 0;
  }

  async put(doc: IdpConfigDoc, by: string): Promise<void> {
    const version = this.version + 1;
    await this.backend.write({ version, updatedAt: new Date().toISOString(), updatedBy: by, sha256: snapshotSha256(doc), data: doc });
    this.doc = structuredClone(doc);
    this.version = version;
  }
}

/** GET/PUT /api/v1/setup/idp (admin) and GET /api/v1/setup/status (any signed-in caller). */
export async function handleSetupRoutes(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/setup/status' && req.method === 'GET') {
    const who = await identify(req, state);
    if (!who.ok) {
      json(res, 401, { error: 'unauthorized' });
      return true;
    }
    json(res, 200, {
      setupComplete: Boolean(state.idpConfig?.configured),
      providers: state.idpConfig?.get().providers.map((p) => p.id) ?? [],
      breakGlassAlert: Boolean(state.keys?.breakGlassAlert()),
    });
    return true;
  }
  if (path === '/api/v1/setup/idp' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'grants.manage'))) return true;
    json(res, 200, state.idpConfig?.get() ?? { providers: [] });
    return true;
  }
  if (path === '/api/v1/setup/idp' && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'grants.manage');
    if (!principal) return true;
    if (!state.idpConfig) {
      json(res, 503, { error: 'idp_config_unavailable' });
      return true;
    }
    const v = validateIdpConfig(await readJson(req));
    if (!v.ok) {
      json(res, 400, { error: 'invalid_idp_config', message: v.error });
      return true;
    }
    await state.idpConfig.put(v.doc, principal.actor);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: 'control-plane',
      type: 'action',
      action: `IDP_CONFIG_SET:${v.doc.providers.map((p) => p.id).join('+')}`,
      actor: principal.actor,
    });
    json(res, 200, v.doc);
    return true;
  }
  return false;
}
