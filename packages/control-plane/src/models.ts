import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Dynamic Model Catalog & Persistence (§6.9 M1–M4, GAP-162).
 *
 * Persists admitted models and staged vendor-discovered models under DATA_DIR/models/catalog.json.
 * Bootstraps from FACTORY_MODEL_CATALOG if no store exists yet.
 */

export interface StoredModel {
  name: string;
  provider: string;
  id: string;
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
  models: Record<string, StoredModel>;
  staged: StagedModel[];
}

export class ModelStore {
  private filePath: string;
  private version = 1;
  private models = new Map<string, StoredModel>();
  private staged: StagedModel[] = [];

  constructor(filePath: string, seed?: Record<string, { provider: string; id?: string; region?: string; price?: { inputPerMTok: number; outputPerMTok: number } }>) {
    this.filePath = filePath;
    this.load(seed);
  }

  private load(seed?: Record<string, { provider: string; id?: string; region?: string; price?: { inputPerMTok: number; outputPerMTok: number } }>): void {
    if (existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as PersistedCatalog;
        this.version = typeof raw.version === 'number' ? raw.version : 1;
        this.models = new Map(Object.entries(raw.models ?? {}));
        this.staged = Array.isArray(raw.staged) ? raw.staged : [];
        return;
      } catch (err) {
        console.warn(`[control-plane] failed to read ${this.filePath}, initializing fresh store:`, err);
      }
    }

    // Bootstrap from seed (e.g. FACTORY_MODEL_CATALOG) if provided
    if (seed && Object.keys(seed).length > 0) {
      const now = new Date().toISOString();
      for (const [name, m] of Object.entries(seed)) {
        this.models.set(name, {
          name,
          provider: m.provider,
          id: m.id ?? name,
          region: m.region,
          price: m.price,
          admittedAt: now,
          admittedBy: 'bootstrap',
        });
      }
      this.persist();
    }
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.version += 1;
    const data: PersistedCatalog = {
      version: this.version,
      models: Object.fromEntries(this.models.entries()),
      staged: this.staged,
    };
    writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  getVersion(): number {
    return this.version;
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
    vendorId?: string;
    region?: string;
    price?: { inputPerMTok: number; outputPerMTok: number };
    actor?: string;
  }): StoredModel {
    const now = new Date().toISOString();
    const model: StoredModel = {
      name: params.name,
      provider: params.provider,
      id: params.id,
      vendorId: params.vendorId,
      region: params.region,
      price: params.price,
      admittedAt: now,
      admittedBy: params.actor ?? 'admin',
    };
    this.models.set(params.name, model);

    // Remove from staged if it was there
    if (params.vendorId) {
      this.staged = this.staged.filter((s) => !(s.vendorId === params.vendorId && s.rawId === params.id));
    }

    this.persist();
    return model;
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
      this.persist();
    }
    return deleted;
  }

  /** Formats the catalog for gatekeeper-egress / Executive Consumption */
  toEgressCatalog(): Record<string, { provider: string; id: string; region?: string; price?: { inputPerMTok: number; outputPerMTok: number } }> {
    const out: Record<string, { provider: string; id: string; region?: string; price?: { inputPerMTok: number; outputPerMTok: number } }> = {};
    for (const [name, m] of this.models.entries()) {
      out[name] = {
        provider: m.provider,
        id: m.id,
        ...(m.region ? { region: m.region } : {}),
        ...(m.price ? { price: m.price } : {}),
      };
    }
    return out;
  }
}
