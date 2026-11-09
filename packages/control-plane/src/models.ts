import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatModelDisplayLabel, type CatalogEntry } from '@beercanlabs/factory-executive';

/**
 * Dynamic Model Catalog & Persistence (§6.9 M1–M5, GAP-162, GAP-245).
 *
 * Persists admitted models and staged vendor-discovered models under DATA_DIR/models/catalog.json.
 * Bootstraps from FACTORY_MODEL_CATALOG if no store exists yet.
 */

/** A landing-zone catalog entry (FACTORY_MODEL_CATALOG) the store bootstraps from (§6.9 M3, M5). */
export type ModelSeed = {
  provider: string;
  id?: string;
  region?: string;
  endpoint?: string;
  price?: { inputPerMTok: number; outputPerMTok: number };
  credentialMode?: 'api-key' | 'subscription';
  scope?: 'factory' | 'personal';
  ownerPrincipalId?: string;
  connection?: string;
  templateId?: string;
};

export interface StoredModel {
  name: string;
  provider: string;
  id: string;
  endpoint?: string;
  /** The vendor credential the gatekeeper-egress sends (GAP-182): the vendor system's `credential.secret`. */
  secret?: string;
  vendorId?: string;
  region?: string;
  price?: {
    inputPerMTok: number;
    outputPerMTok: number;
  };
  /** M5(1): `'api-key'` (platform credential) or `'subscription'` (served on one subscription connection). */
  credentialMode?: 'api-key' | 'subscription';
  /** M5(1), (4): subscription entry scope (`'factory'` or `'personal'`). */
  scope?: 'factory' | 'personal';
  /** M5(1), (4): canonical `'user:<id>'` owner when `credentialMode === 'subscription' && scope === 'personal'`. */
  ownerPrincipalId?: string;
  /** M5(1), (4): subscription connection id (`sub_...`), NEVER a connection's display name. */
  connection?: string;
  /** M5(5): shipped subscription template id (`'xai-subscription'` | `'openai-subscription'`). */
  templateId?: string;
  admittedAt: string;
  admittedBy?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface EnrichedModelView extends StoredModel {
  credentialMode: 'api-key' | 'subscription';
  subscription: boolean;
  connectionName?: string;
  dailyTokenCap?: number;
  displayLabel: string;
}

export type ModelConnectionMetadata = {
  name?: string;
  dailyTokenCap?: number;
};

export class ModelCatalogError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface StagedModel {
  vendorId: string;
  rawId: string;
  displayName?: string;
  discoveredAt: string;
  suggestedFriendlyName: string;
  suggestedPrice?: {
    inputPerMTok: number;
    outputPerMTok: number;
  };
}

interface PersistedCatalog {
  version: number;
  defaultModel?: string;
  models: Record<string, StoredModel>;
  staged: StagedModel[];
}

export class ModelStore {
  private filePath: string;
  private version = 1;
  private defaultModel?: string;
  private models = new Map<string, StoredModel>();
  private staged: StagedModel[] = [];
  private connectionResolver?: (connectionId: string) => ModelConnectionMetadata | undefined;

  constructor(
    filePath: string,
    seed?: Record<string, ModelSeed>,
    initialDefaultModel?: string,
  ) {
    this.filePath = filePath;
    this.load(seed, initialDefaultModel);
  }

  setConnectionResolver(fn: ((connectionId: string) => ModelConnectionMetadata | undefined) | undefined): void {
    this.connectionResolver = fn;
  }

  /** Bump in-memory catalog version when live connection presentation or dailyTokenCap changes. */
  bumpVersion(): void {
    this.version += 1;
  }

  private load(
    seed?: Record<string, ModelSeed>,
    initialDefaultModel?: string,
  ): void {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedCatalog;
        this.version = typeof raw.version === 'number' ? raw.version : 1;
        this.defaultModel = typeof raw.defaultModel === 'string' ? raw.defaultModel : initialDefaultModel;
        this.models = new Map(Object.entries(raw.models ?? {}));
        this.staged = Array.isArray(raw.staged) ? raw.staged : [];
        this.resyncBootstrap(seed);
        return;
      } catch (err) {
        console.warn(`[control-plane] failed to read ${this.filePath}, initializing fresh store:`, err);
      }
    }

    this.defaultModel = initialDefaultModel;

    // Bootstrap from seed (e.g. FACTORY_MODEL_CATALOG) if provided
    if (seed && Object.keys(seed).length > 0) {
      const now = new Date().toISOString();
      for (const [name, m] of Object.entries(seed)) {
        const isSub = m.credentialMode === 'subscription';
        this.models.set(name, {
          name,
          provider: m.provider,
          id: m.id ?? name,
          ...(m.region ? { region: m.region } : {}),
          ...(m.endpoint ? { endpoint: m.endpoint } : {}),
          price: m.price,
          credentialMode: isSub ? 'subscription' : 'api-key',
          ...(isSub ? { scope: m.scope ?? 'factory' } : {}),
          ...(isSub && m.scope === 'personal' && m.ownerPrincipalId ? { ownerPrincipalId: m.ownerPrincipalId } : {}),
          ...(isSub && m.connection ? { connection: m.connection } : {}),
          ...(isSub && m.templateId ? { templateId: m.templateId } : {}),
          admittedAt: now,
          admittedBy: 'bootstrap',
        });
      }
      this.persist();
    }
  }

  /**
   * Models the store bootstrapped from the landing zone take their provider id, region and endpoint from the current
   * landing-zone catalog (GAP-174). Earlier seeding kept only the name, so a Bedrock entry was stored with its friendly
   * name as the provider model id and no region. Models an admin admitted are never touched.
   */
  private resyncBootstrap(seed?: Record<string, ModelSeed>): void {
    if (!seed) return;
    let changed = false;
    for (const [name, m] of this.models) {
      const s = seed[name];
      if (m.admittedBy !== 'bootstrap' || !s || s.provider !== m.provider) continue;
      const next: StoredModel = { ...m, id: s.id ?? name };
      delete next.region;
      delete next.endpoint;
      if (s.region) next.region = s.region;
      if (s.endpoint) next.endpoint = s.endpoint;
      if (JSON.stringify(next) !== JSON.stringify(m)) {
        this.models.set(name, next);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.version += 1;
    const data: PersistedCatalog = {
      version: this.version,
      ...(this.defaultModel ? { defaultModel: this.defaultModel } : {}),
      models: Object.fromEntries(this.models.entries()),
      staged: this.staged,
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  getVersion(): number {
    return this.version;
  }

  getDefault(): string | undefined {
    return this.defaultModel;
  }

  setDefault(name: string, _actor?: string): void {
    const target = this.models.get(name);
    if (!target) {
      throw new Error(`Model '${name}' is not in the admitted model catalog`);
    }
    if (target.credentialMode === 'subscription' && target.scope === 'personal') {
      throw new ModelCatalogError(403, 'personal_model_cannot_be_default', `Personal subscription model '${name}' cannot be set as the factory default model`);
    }
    this.defaultModel = name;
    this.persist();
  }

  listOffered(): StoredModel[] {
    return [...this.models.values()];
  }

  listForConnection(connectionId: string): StoredModel[] {
    return [...this.models.values()].filter((m) => m.credentialMode === 'subscription' && m.connection === connectionId);
  }

  enrich(m: StoredModel): EnrichedModelView {
    const isSub = m.credentialMode === 'subscription';
    const connMeta = isSub && m.connection ? this.connectionResolver?.(m.connection) : undefined;
    const connectionName = connMeta?.name;
    return {
      ...m,
      credentialMode: isSub ? 'subscription' : 'api-key',
      subscription: isSub,
      ...(isSub ? { scope: m.scope ?? 'factory' } : {}),
      ...(connectionName ? { connectionName } : {}),
      ...(connMeta?.dailyTokenCap !== undefined ? { dailyTokenCap: connMeta.dailyTokenCap } : {}),
      displayLabel: formatModelDisplayLabel({
        id: m.id,
        provider: m.provider,
        credentialMode: isSub ? 'subscription' : 'api-key',
        connectionName,
      }),
    };
  }

  getOffered(name: string): StoredModel | undefined {
    return this.models.get(name);
  }

  listStaged(): StagedModel[] {
    return [...this.staged];
  }

  stageDiscovered(discovered: StagedModel[]): void {
    // Merge discovered models by vendorId + rawId
    const existing = new Map(this.staged.map((s) => [`${s.vendorId}:${s.rawId}`, s]));
    for (const d of discovered) {
      existing.set(`${d.vendorId}:${d.rawId}`, d);
    }
    this.staged = [...existing.values()];
    this.persist();
  }

  clearStagedForVendor(vendorId: string): void {
    this.staged = this.staged.filter((s) => s.vendorId !== vendorId);
    this.persist();
  }

  admit(params: {
    name: string;
    provider: string;
    id: string;
    endpoint?: string;
    secret?: string;
    vendorId?: string;
    region?: string;
    price?: { inputPerMTok: number; outputPerMTok: number };
    actor?: string;
  }): StoredModel {
    let targetName = params.name;
    const existing = this.models.get(targetName);
    if (existing?.credentialMode === 'subscription') {
      throw new ModelCatalogError(409, 'model_name_taken', `Catalog name '${targetName}' is already in use by a subscription entry`);
    }
    if (existing && (existing.id !== params.id || existing.provider !== params.provider)) {
      // Disambiguate using raw id if friendly name collides with a different model
      if (!this.models.has(params.id)) {
        targetName = params.id;
      } else {
        throw new Error(`Model name '${params.name}' collides with existing model '${existing.name}' (${existing.provider}:${existing.id})`);
      }
    }

    const now = new Date().toISOString();
    const model: StoredModel = {
      name: targetName,
      provider: params.provider,
      id: params.id,
      endpoint: params.endpoint,
      ...(params.secret ? { secret: params.secret } : {}),
      vendorId: params.vendorId,
      region: params.region,
      price: params.price,
      credentialMode: 'api-key',
      admittedAt: now,
      admittedBy: params.actor ?? 'admin',
    };
    this.models.set(targetName, model);

    // Remove from staged if it was there
    if (params.vendorId) {
      this.staged = this.staged.filter((s) => !(s.vendorId === params.vendorId && s.rawId === params.id));
    }

    this.persist();
    return model;
  }

  /**
   * M5(1), (4a): Admit a subscription catalog entry on a specific subscription connection.
   * Factory-wide catalog names are strictly unique (no silent overwrite across connections or scopes).
   */
  admitSubscription(params: {
    name: string;
    provider: string;
    id: string;
    connection: string;
    templateId: string;
    scope: 'factory' | 'personal';
    ownerPrincipalId?: string;
    price?: { inputPerMTok: number; outputPerMTok: number };
    actor: string;
  }): StoredModel {
    const trimmedName = params.name.trim();
    if (!trimmedName || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(trimmedName)) {
      throw new ModelCatalogError(400, 'invalid_model_name', 'Catalog name must be 1..128 alphanumeric or . _ : @ / - characters');
    }
    const existing = this.models.get(trimmedName);
    if (existing) {
      throw new ModelCatalogError(
        409,
        'model_name_taken',
        `Catalog name '${trimmedName}' is already in use`,
      );
    }
    if (!params.connection.trim()) {
      throw new ModelCatalogError(400, 'invalid_connection', 'Subscription catalog entry requires a connection id');
    }
    if (params.scope === 'personal') {
      if (!params.ownerPrincipalId || !params.ownerPrincipalId.startsWith('user:')) {
        throw new ModelCatalogError(400, 'invalid_owner_principal', 'Personal BYOM entry requires canonical user:<id> ownerPrincipalId');
      }
    }
    const effectivePrice =
      params.scope === 'personal'
        ? { inputPerMTok: 0, outputPerMTok: 0 }
        : params.price;
    const now = new Date().toISOString();
    const model: StoredModel = {
      name: trimmedName,
      provider: params.provider,
      id: params.id,
      ...(effectivePrice ? { price: effectivePrice } : {}),
      credentialMode: 'subscription',
      scope: params.scope,
      ...(params.scope === 'personal' ? { ownerPrincipalId: params.ownerPrincipalId } : {}),
      connection: params.connection,
      templateId: params.templateId,
      admittedAt: now,
      admittedBy: params.actor,
    };
    this.models.set(trimmedName, model);
    this.persist();
    return model;
  }

  /**
   * Re-link a vendor's admitted model to the vendor's current provider, endpoint and credential (GAP-182). Returns true
   * when something changed (persisted).
   */
  relinkVendor(name: string, fields: { provider: string; endpoint?: string; secret?: string }, persist = true): boolean {
    const m = this.models.get(name);
    if (!m) return false;
    const next: StoredModel = { ...m, provider: fields.provider };
    delete next.endpoint;
    delete next.secret;
    if (fields.endpoint) next.endpoint = fields.endpoint;
    if (fields.secret) next.secret = fields.secret;
    if (JSON.stringify(next) === JSON.stringify(m)) return false;
    this.models.set(name, next);
    if (persist) this.persist();
    return true;
  }

  /** Persist pending changes once (after a batch of `relinkVendor(..., false)`), bumping the catalog version. */
  save(): void {
    this.persist();
  }

  updatePricing(name: string, price: { inputPerMTok: number; outputPerMTok: number }, actor?: string): StoredModel {
    const model = this.models.get(name);
    if (!model) throw new Error(`Model '${name}' not found`);
    if (model.credentialMode === 'subscription' && model.scope === 'personal') {
      throw new ModelCatalogError(
        403,
        'personal_model_price_immutable',
        `Personal BYOM subscription model '${name}' has a fixed immutable $0 price`,
      );
    }

    model.price = price;
    model.updatedAt = new Date().toISOString();
    model.updatedBy = actor ?? 'admin';

    this.persist();
    return model;
  }

  retire(name: string): boolean {
    const deleted = this.models.delete(name);
    if (deleted) {
      if (this.defaultModel === name) {
        this.defaultModel = undefined;
      }
      this.persist();
    }
    return deleted;
  }

  /** Formats the catalog for gatekeeper-egress / Executive Consumption */
  toEgressCatalog(): Record<string, CatalogEntry> {
    const out: Record<string, CatalogEntry> = {};
    for (const [name, m] of this.models.entries()) {
      const isSub = m.credentialMode === 'subscription';
      const connMeta = isSub && m.connection ? this.connectionResolver?.(m.connection) : undefined;
      out[name] = {
        provider: m.provider,
        id: m.id,
        ...(m.endpoint ? { endpoint: m.endpoint } : {}),
        ...(m.secret ? { secret: m.secret } : {}),
        ...(m.region ? { region: m.region } : {}),
        ...(m.price ? { price: m.price } : {}),
        ...(isSub
          ? {
              credentialMode: 'subscription',
              scope: m.scope ?? 'factory',
              ...(m.scope === 'personal' && m.ownerPrincipalId ? { ownerPrincipalId: m.ownerPrincipalId } : {}),
              connection: m.connection,
              ...(connMeta?.name ? { connectionName: connMeta.name } : {}),
              ...(m.templateId ? { templateId: m.templateId } : {}),
              ...(connMeta?.dailyTokenCap !== undefined ? { dailyTokenCap: connMeta.dailyTokenCap } : {}),
            }
          : {}),
      };
    }
    return out;
  }
}
