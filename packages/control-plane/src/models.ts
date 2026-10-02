/**
 * Model offering store & endpoints (DESIGN_AUTHORITY.md §6.9 M3, §6.13 R1).
 *
 * Each factory's offering (provider, the provider's model id, price) is factory data that admins maintain,
 * changed without a redeploy; provider keys are supplied through Keymaster platform credentials,
 * and a landing zone supplies only cloud permissions.
 *
 * Reads are served from memory (GAP-056). Records live in `<dataDir>/models/<name>/<version>.json` (backed up, R1).
 *
 *   GET  /api/v1/models                                   viewer: list offered models & default (names, providers, prices only)
 *   GET  /api/v1/models/definitions                       viewer: full model definitions & version history
 *   GET  /api/v1/models/definitions/:name                 viewer: single model definition & versions
 *   POST /api/v1/models/propose                           admin: propose a new model or new version
 *   POST /api/v1/models/:name/approve                     admin: approve a model definition version
 *   POST /api/v1/models/:name/reject                      admin: reject a model definition version
 *   GET  /api/v1/gatekeeper-egress/models                 gatekeeper-egress: active catalog with provider model ids & regions
 */
import http from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { payloadHash } from '@beercanlabs/factory-ledger';
import {
  MODEL_NAME_REGEX,
  validateModelProposal,
  type ModelDefinition,
  type ModelPrice,
  type ModelProposal,
} from '@beercanlabs/factory-contract';
import { authenticate, json, readJson, type FactoryState } from './app.js';

export type ModelSummary = {
  name: string;
  provider: string;
  id: string;
  region?: string;
  price: ModelPrice;
  description?: string;
  isDefault?: boolean;
  status: 'proposed' | 'approved' | 'rejected';
  latestVersion: number;
  approvedVersion: number | null;
  activeDefinition: ModelDefinition | null;
  versions: ModelDefinition[];
};

export const BASELINE_MODELS: ModelProposal[] = [
  {
    name: 'claude-sonnet-4-5',
    provider: 'bedrock-converse',
    id: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    region: 'us-east-1',
    price: {
      inputPerMTok: 3,
      outputPerMTok: 15,
    },
    description: 'Anthropic Claude 3.7 Sonnet via AWS Bedrock',
    isDefault: false,
  },
  {
    name: 'claude-haiku-4-5',
    provider: 'bedrock-converse',
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    region: 'us-east-1',
    price: {
      inputPerMTok: 1,
      outputPerMTok: 5,
    },
    description: 'Anthropic Claude Haiku 4.5 via AWS Bedrock (Factory Default)',
    isDefault: true,
  },
];

export class ModelsStore {
  private readonly versions = new Map<string, ModelDefinition[]>();
  private readonly current = new Map<string, ModelDefinition>();

  private constructor(
    private readonly dir: string,
    private readonly ledger?: { append(event: Record<string, unknown>): void },
  ) {}

  static async open(dir: string, ledger?: { append(event: Record<string, unknown>): void }): Promise<ModelsStore> {
    const store = new ModelsStore(dir, ledger);
    mkdirSync(dir, { recursive: true });

    const entries = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (entries.length === 0) {
      for (const m of BASELINE_MODELS) {
        store.seedBaseline(m);
      }
      return store;
    }

    for (const ent of entries) {
      const modelName = ent.name;
      const modelDir = join(dir, modelName);
      const files = readdirSync(modelDir).filter((f) => f.endsWith('.json') && f !== 'current.json');
      const defs: ModelDefinition[] = [];

      for (const f of files) {
        try {
          const content = JSON.parse(readFileSync(join(modelDir, f), 'utf8')) as ModelDefinition;
          defs.push(content);
        } catch (err) {
          console.warn(`[models-store] failed reading ${join(modelDir, f)}:`, err);
        }
      }

      defs.sort((a, b) => a.version - b.version);
      store.versions.set(modelName, defs);

      const currentPath = join(modelDir, 'current.json');
      if (existsSync(currentPath)) {
        try {
          const cur = JSON.parse(readFileSync(currentPath, 'utf8')) as ModelDefinition;
          store.current.set(modelName, cur);
        } catch {
          const approved = defs.filter((d) => d.status === 'approved');
          if (approved.length > 0) {
            store.current.set(modelName, approved[approved.length - 1]);
          }
        }
      } else {
        const approved = defs.filter((d) => d.status === 'approved');
        if (approved.length > 0) {
          store.current.set(modelName, approved[approved.length - 1]);
        }
      }
    }

    return store;
  }

  private seedBaseline(proposal: ModelProposal): ModelDefinition {
    const hash = payloadHash({
      name: proposal.name,
      provider: proposal.provider,
      id: proposal.id,
      region: proposal.region,
      price: proposal.price,
      description: proposal.description,
      isDefault: proposal.isDefault,
    });

    const def: ModelDefinition = {
      ...proposal,
      version: 1,
      status: 'approved',
      proposedBy: 'system:migration',
      proposedAt: new Date().toISOString(),
      decidedBy: 'system:migration',
      decidedAt: new Date().toISOString(),
      reason: 'Baseline migration from landing zone model catalog',
      hash,
    };

    const modelDir = join(this.dir, proposal.name);
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, '1.json'), JSON.stringify(def, null, 2));
    writeFileSync(join(modelDir, 'current.json'), JSON.stringify(def, null, 2));

    this.versions.set(proposal.name, [def]);
    this.current.set(proposal.name, def);

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `model:${proposal.name}@1`,
      type: 'action',
      action: 'MODEL_APPROVED',
      actor: 'system:migration',
      route: proposal.name,
      payloadSha256: hash,
    });

    return def;
  }

  list(): ModelSummary[] {
    const out: ModelSummary[] = [];
    const names = new Set([...this.versions.keys(), ...this.current.keys()]);

    for (const name of names) {
      const sum = this.get(name);
      if (sum) out.push(sum);
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ModelSummary | undefined {
    const versions = this.versions.get(name) ?? [];
    const active = this.current.get(name) ?? null;
    if (versions.length === 0 && !active) return undefined;

    const latest = versions.length > 0 ? versions[versions.length - 1] : active!;
    const approved = versions.filter((v) => v.status === 'approved');
    const approvedVersion = approved.length > 0 ? approved[approved.length - 1].version : null;

    return {
      name,
      provider: active?.provider ?? latest.provider,
      id: active?.id ?? latest.id,
      region: active?.region ?? latest.region,
      price: active?.price ?? latest.price,
      description: active?.description ?? latest.description,
      isDefault: active?.isDefault ?? latest.isDefault,
      status: active ? 'approved' : latest.status,
      latestVersion: latest.version,
      approvedVersion,
      activeDefinition: active,
      versions,
    };
  }

  getApprovedCatalog(): Record<string, { provider: string; id: string; region?: string; price: ModelPrice; isDefault?: boolean }> {
    const catalog: Record<string, { provider: string; id: string; region?: string; price: ModelPrice; isDefault?: boolean }> = {};
    for (const [name, def] of this.current.entries()) {
      catalog[name] = {
        provider: def.provider,
        id: def.id,
        ...(def.region ? { region: def.region } : {}),
        price: def.price,
        ...(def.isDefault ? { isDefault: true } : {}),
      };
    }
    return catalog;
  }

  getDefaultModel(): string {
    for (const [name, def] of this.current.entries()) {
      if (def.isDefault) return name;
    }
    return 'claude-haiku-4-5';
  }

  getOfferedForViewer(): { models: { name: string; provider: string; price?: ModelPrice }[]; default: string } {
    const models = Array.from(this.current.entries()).map(([name, def]) => ({
      name,
      provider: def.provider,
      ...(def.price ? { price: def.price } : {}),
    }));
    return {
      models,
      default: this.getDefaultModel(),
    };
  }

  async propose(proposal: ModelProposal, actor: string): Promise<ModelDefinition> {
    const checked = validateModelProposal(proposal);
    if (!checked.ok) throw new Error(checked.error);

    const existing = this.versions.get(proposal.name) ?? [];
    const nextVersion = existing.length > 0 ? existing[existing.length - 1].version + 1 : 1;

    const hash = payloadHash({
      name: proposal.name,
      provider: proposal.provider,
      id: proposal.id,
      region: proposal.region,
      price: proposal.price,
      description: proposal.description,
      isDefault: proposal.isDefault,
    });

    const def: ModelDefinition = {
      ...proposal,
      version: nextVersion,
      status: 'proposed',
      proposedBy: actor,
      proposedAt: new Date().toISOString(),
      hash,
    };

    const modelDir = join(this.dir, proposal.name);
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, `${nextVersion}.json`), JSON.stringify(def, null, 2));

    existing.push(def);
    this.versions.set(proposal.name, existing);

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `model:${proposal.name}@${nextVersion}`,
      type: 'action',
      action: 'MODEL_PROPOSED',
      actor,
      route: proposal.name,
      payloadSha256: hash,
    });

    return def;
  }

  async approve(name: string, version: number | undefined, actor: string): Promise<ModelDefinition> {
    const versions = this.versions.get(name);
    if (!versions || versions.length === 0) {
      throw new Error(`model '${name}' not found`);
    }

    const target = version !== undefined ? versions.find((v) => v.version === version) : versions[versions.length - 1];
    if (!target) {
      throw new Error(`model '${name}' version ${version} not found`);
    }

    target.status = 'approved';
    target.decidedBy = actor;
    target.decidedAt = new Date().toISOString();

    const modelDir = join(this.dir, name);
    writeFileSync(join(modelDir, `${target.version}.json`), JSON.stringify(target, null, 2));
    writeFileSync(join(modelDir, 'current.json'), JSON.stringify(target, null, 2));

    // If this approved model is set as default, clear default flag from other active models
    if (target.isDefault) {
      for (const [otherName, otherDef] of this.current.entries()) {
        if (otherName !== name && otherDef.isDefault) {
          otherDef.isDefault = false;
          const otherDir = join(this.dir, otherName);
          writeFileSync(join(otherDir, 'current.json'), JSON.stringify(otherDef, null, 2));
        }
      }
    }

    this.current.set(name, target);

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `model:${name}@${target.version}`,
      type: 'action',
      action: 'MODEL_APPROVED',
      actor,
      route: name,
      payloadSha256: target.hash,
    });

    return target;
  }

  async reject(name: string, version: number | undefined, reason: string | undefined, actor: string): Promise<ModelDefinition> {
    const versions = this.versions.get(name);
    if (!versions || versions.length === 0) {
      throw new Error(`model '${name}' not found`);
    }

    const target = version !== undefined ? versions.find((v) => v.version === version) : versions[versions.length - 1];
    if (!target) {
      throw new Error(`model '${name}' version ${version} not found`);
    }

    target.status = 'rejected';
    target.decidedBy = actor;
    target.decidedAt = new Date().toISOString();
    target.reason = reason;

    const modelDir = join(this.dir, name);
    writeFileSync(join(modelDir, `${target.version}.json`), JSON.stringify(target, null, 2));

    const cur = this.current.get(name);
    if (cur?.version === target.version) {
      this.current.delete(name);
      const curPath = join(modelDir, 'current.json');
      if (existsSync(curPath)) {
        writeFileSync(curPath, JSON.stringify({ ...target, status: 'rejected' }, null, 2));
      }
    }

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `model:${name}@${target.version}`,
      type: 'action',
      action: 'MODEL_REJECTED',
      actor,
      route: name,
      payloadSha256: target.hash,
    });

    return target;
  }
}

/**
 * Dispatches model API requests.
 */
export async function handleModels(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const store = state.models;
  if (!store) return false;

  // 1. GET /api/v1/models (M3 viewer endpoint: names, providers, prices only, default model)
  if (pathname === '/api/v1/models' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return true;
    json(res, 200, store.getOfferedForViewer());
    return true;
  }

  // 2. GET /api/v1/gatekeeper-egress/models (for gatekeeper-egress dynamic resolution)
  if (pathname === '/api/v1/gatekeeper-egress/models' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'gatekeeper-egress'))) return true;
    json(res, 200, {
      catalog: store.getApprovedCatalog(),
      default: store.getDefaultModel(),
    });
    return true;
  }

  // 3. GET /api/v1/models/definitions (viewer: list full model definitions & version history)
  if (pathname === '/api/v1/models/definitions' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return true;
    json(res, 200, { models: store.list() });
    return true;
  }

  // 4. GET /api/v1/models/definitions/:name
  const getMatch = pathname.match(/^\/api\/v1\/models\/definitions\/([a-z0-9.-]+)$/);
  if (getMatch && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return true;
    const model = store.get(getMatch[1]);
    if (!model) {
      json(res, 404, { error: 'model_not_found' });
      return true;
    }
    json(res, 200, model);
    return true;
  }

  // 5. POST /api/v1/models/propose (admin: propose a new model)
  if (pathname === '/api/v1/models/propose' && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;

    try {
      const body = (await readJson(req)) as unknown;
      const checked = validateModelProposal(body);
      if (!checked.ok) {
        json(res, 400, { error: checked.error });
        return true;
      }
      const def = await store.propose(checked.proposal, principal.actor);
      json(res, 201, def);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // 6. POST /api/v1/models/:name/approve
  const approveMatch = pathname.match(/^\/api\/v1\/models\/([a-z0-9.-]+)\/approve$/);
  if (approveMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;

    const name = approveMatch[1];
    const body = ((await readJson(req).catch(() => ({}))) || {}) as { version?: number };
    try {
      const def = await store.approve(name, body.version, principal.actor);
      json(res, 200, def);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // 7. POST /api/v1/models/:name/reject
  const rejectMatch = pathname.match(/^\/api\/v1\/models\/([a-z0-9.-]+)\/reject$/);
  if (rejectMatch && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;

    const name = rejectMatch[1];
    const body = ((await readJson(req).catch(() => ({}))) || {}) as { version?: number; reason?: string };
    try {
      const def = await store.reject(name, body.version, body.reason, principal.actor);
      json(res, 200, def);
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
