import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Dynamic Model Catalog & Persistence (§6.9 M1–M4, GAP-162).
 *
 * Persists admitted models and staged vendor-discovered models under DATA_DIR/models/catalog.json.
 * Bootstraps from FACTORY_MODEL_CATALOG if no store exists yet.
 */

/** A landing-zone catalog entry (FACTORY_MODEL_CATALOG) the store bootstraps from (§6.9 M3). */
export type ModelSeed = { provider: string; id?: string; region?: string; endpoint?: string; price?: { inputPerMTok: number; outputPerMTok: number } };

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
  admittedAt: string;
  admittedBy?: string;
  updatedAt?: string;
  updatedBy?: string;
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

  constructor(
    filePath: string,
    seed?: Record<string, ModelSeed>,
    initialDefaultModel?: string,
  ) {
    this.filePath = filePath;
    this.load(seed, initialDefaultModel);
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
        this.models.set(name, {
          name,
          provider: m.provider,
          id: m.id ?? name,
          ...(m.region ? { region: m.region } : {}),
          ...(m.endpoint ? { endpoint: m.endpoint } : {}),
          price: m.price,
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
    if (!this.models.has(name)) {
      throw new Error(`Model '${name}' is not in the admitted model catalog`);
    }
    this.defaultModel = name;
    this.persist();
  }

  listOffered(): StoredModel[] {
    return [...this.models.values()];
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
  toEgressCatalog(): Record<string, { provider: string; id: string; endpoint?: string; secret?: string; region?: string; price?: { inputPerMTok: number; outputPerMTok: number } }> {
    const out: Record<string, { provider: string; id: string; endpoint?: string; secret?: string; region?: string; price?: { inputPerMTok: number; outputPerMTok: number } }> = {};
    for (const [name, m] of this.models.entries()) {
      out[name] = {
        provider: m.provider,
        id: m.id,
        ...(m.endpoint ? { endpoint: m.endpoint } : {}),
        ...(m.secret ? { secret: m.secret } : {}),
        ...(m.region ? { region: m.region } : {}),
        ...(m.price ? { price: m.price } : {}),
      };
    }
    return out;
  }
}
