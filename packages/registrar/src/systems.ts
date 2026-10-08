/**
 * The system definition store (DESIGN_AUTHORITY.md §6.3.1 E10, §6.13 R1).
 *
 * External systems an agent reaches, other than model providers (§6.9), are defined once in the factory: where requests
 * go (upstream), the credential kind (static secret or OAuth connection) and how it is injected. Admin approval is
 * required per definition version. Reads are served from memory (GAP-056). Records live in
 * `<dir>/<id>/<version>.json` (backed up, R1), with `current.json` pointing at the approved one.
 *
 * Each proposal, approval, rejection and import is handed to the ledger sink as one row, keyed `system:<id>@<version>`
 * and carrying the definition's content hash (the ledger's `payloadHash`, so the two agree by construction).
 *
 * The Registrar does not know the Keymaster. The two methods that turn a system's OAuth description into a connection
 * provider are the control plane's, on a subclass in `packages/control-plane/src/systems.ts`, as are the routes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { payloadHash } from '@beercanlabs/factory-ledger';
import { validateSystemProposal, type SystemDefinition, type SystemProposal } from '@beercanlabs/factory-contract';

export type SystemSummary = {
  id: string;
  name: string;
  description?: string;
  kind: 'http' | 'mcp';
  upstream: string;
  status: 'proposed' | 'approved' | 'rejected';
  latestVersion: number;
  approvedVersion: number | null;
  activeDefinition: SystemDefinition | null;
  versions: SystemDefinition[];
};

export type EgressRoute = {
  id: string;
  kind: 'http' | 'mcp';
  upstream?: string;
  credential?: { secret: string; header: string; format?: string; fallback?: boolean; encoding?: 'basic' };
  connection?: string;
  scopes?: string[];
  hold?: { methods: string[]; preview?: string };
  stripSignInLinks?: boolean;
  maxContentChars?: number;
};


export class SystemsStore {
  protected readonly versions = new Map<string, SystemDefinition[]>();
  protected readonly current = new Map<string, SystemDefinition>();

  constructor(
    private readonly dir: string,
    private readonly ledger?: { append(event: Record<string, unknown>): void },
  ) {}

  /** Opens the store at `dir`. It builds `this`, so a subclass opens as itself (the control plane's adds the Keymaster-derived methods). */
  static async open<T extends SystemsStore>(
    this: new (dir: string, ledger?: { append(event: Record<string, unknown>): void }) => T,
    dir: string,
    ledger?: { append(event: Record<string, unknown>): void },
  ): Promise<T> {
    const store = new this(dir, ledger);
    mkdirSync(dir, { recursive: true });

    // Load existing records
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const sysDir = join(dir, ent.name);
      const files = readdirSync(sysDir).filter((f) => f.endsWith('.json') && f !== 'current.json');
      const defs: SystemDefinition[] = [];
      for (const f of files) {
        try {
          const raw = JSON.parse(readFileSync(join(sysDir, f), 'utf8')) as SystemDefinition;
          if (raw && raw.id && typeof raw.version === 'number') {
            defs.push(raw);
          }
        } catch {}
      }
      defs.sort((a, b) => a.version - b.version);
      if (defs.length > 0) {
        store.versions.set(ent.name, defs);
        // Find latest approved
        const approved = [...defs].reverse().find((d) => d.status === 'approved');
        if (approved) {
          store.current.set(ent.name, approved);
        }
      }
    }

    return store;
  }

  /**
   * GAP-068 migration: record a deployment's existing gatekeeper-egress routes as approved systems, once. A system
   * the store already has is never touched (an admin's edits win), so re-running on every boot is safe. The routes
   * come from the deployment (`FACTORY_SYSTEMS_IMPORT`), never from this code. Model routes stay landing-zone routes.
   */
  async importRoutes(raw: unknown, actor: string): Promise<{ imported: string[]; skipped: string[] }> {
    const imported: string[] = [];
    const skipped: string[] = [];
    if (!Array.isArray(raw)) return { imported, skipped };
    for (const r of raw as Array<Record<string, unknown>>) {
      const id = typeof r?.id === 'string' ? r.id : '';
      if (!id || r.kind === 'llm' || r.kind === 'models') continue;
      const existing = this.current.get(id);
      // TSK-067: OAuth provider facts move from code into the store once. A system only the migration ever wrote
      // gains its `oauth` block; one an admin has changed is never touched.
      const addOAuth = Boolean(existing && r.oauth && !existing.oauth && (this.versions.get(id) ?? []).every((d) => d.proposedBy.startsWith('migration:')));
      if (this.versions.has(id) && !addOAuth) continue;
      const v = validateSystemProposal({
        id,
        name: typeof r.name === 'string' ? r.name : id,
        kind: r.kind,
        upstream: r.upstream,
        credential: r.credential,
        connection: r.connection,
        scopes: r.scopes,
        hold: r.hold,
        stripSignInLinks: r.stripSignInLinks,
        maxContentChars: r.maxContentChars,
        oauth: r.oauth,
      });
      if (!v.ok) {
        skipped.push(`${id}: ${v.issues.map((i) => i.message).join('; ')}`);
        continue;
      }
      await this.record(v.proposal, actor);
      imported.push(id);
    }
    return { imported, skipped };
  }

  private async record(proposal: SystemProposal, actor: string): Promise<SystemDefinition> {
    const prior = this.versions.get(proposal.id) ?? [];
    const version = prior.length ? prior[prior.length - 1].version + 1 : 1;
    const content = {
      id: proposal.id,
      name: proposal.name,
      description: proposal.description,
      kind: proposal.kind,
      upstream: proposal.upstream,
      credential: proposal.credential,
      connection: proposal.connection,
      scopes: proposal.scopes,
      hold: proposal.hold,
      stripSignInLinks: proposal.stripSignInLinks,
      maxContentChars: proposal.maxContentChars,
      oauth: proposal.oauth,
    };
    const hash = payloadHash(content);
    const at = new Date().toISOString();
    const def: SystemDefinition = {
      ...content,
      version,
      status: 'approved',
      proposedBy: actor,
      proposedAt: at,
      decidedBy: actor,
      decidedAt: at,
      reason: 'imported from the deployment\'s gatekeeper-egress routes (GAP-068)',
      hash,
    };
    const sysDir = join(this.dir, proposal.id);
    mkdirSync(sysDir, { recursive: true });
    writeFileSync(join(sysDir, `${version}.json`), JSON.stringify(def, null, 2));
    this.versions.set(proposal.id, [...prior, def]);
    this.current.set(proposal.id, def);
    this.ledger?.append({
      timestamp: at,
      agentId: `system:${proposal.id}@${version}`,
      type: 'action',
      action: 'SYSTEM_IMPORTED',
      actor,
      route: proposal.id,
      payloadSha256: hash,
    });
    return def;
  }

  async propose(proposal: SystemProposal, actor: string): Promise<SystemDefinition> {
    const existing = this.versions.get(proposal.id) ?? [];
    const nextVersion = existing.length > 0 ? existing[existing.length - 1].version + 1 : 1;

    const content = {
      id: proposal.id,
      name: proposal.name,
      description: proposal.description,
      kind: proposal.kind,
      upstream: proposal.upstream,
      credential: proposal.credential,
      connection: proposal.connection,
      scopes: proposal.scopes,
      hold: proposal.hold,
      stripSignInLinks: proposal.stripSignInLinks,
      maxContentChars: proposal.maxContentChars,
      oauth: proposal.oauth,
    };
    const hash = payloadHash(content);
    const def: SystemDefinition = {
      ...content,
      version: nextVersion,
      status: 'proposed',
      proposedBy: actor,
      proposedAt: new Date().toISOString(),
      hash,
    };

    const sysDir = join(this.dir, proposal.id);
    mkdirSync(sysDir, { recursive: true });
    writeFileSync(join(sysDir, `${nextVersion}.json`), JSON.stringify(def, null, 2));

    existing.push(def);
    this.versions.set(proposal.id, existing);

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `system:${proposal.id}@${nextVersion}`,
      type: 'action',
      action: 'SYSTEM_PROPOSED',
      actor,
      route: proposal.id,
      payloadSha256: hash,
    });

    return def;
  }

  async approve(id: string, version: number | undefined, actor: string, reason?: string): Promise<SystemDefinition> {
    const existing = this.versions.get(id);
    if (!existing || existing.length === 0) {
      throw new Error(`system ${id} not found`);
    }

    const target = version !== undefined
      ? existing.find((v) => v.version === version)
      : [...existing].reverse().find((v) => v.status === 'proposed') ?? existing[existing.length - 1];

    if (!target) {
      throw new Error(`version ${version ?? 'latest'} not found for system ${id}`);
    }

    target.status = 'approved';
    target.decidedBy = actor;
    target.decidedAt = new Date().toISOString();
    if (reason) target.reason = reason;

    const sysDir = join(this.dir, id);
    writeFileSync(join(sysDir, `${target.version}.json`), JSON.stringify(target, null, 2));
    writeFileSync(join(sysDir, 'current.json'), JSON.stringify(target, null, 2));

    this.current.set(id, target);

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `system:${id}@${target.version}`,
      type: 'action',
      action: 'SYSTEM_APPROVED',
      actor,
      route: id,
      payloadSha256: target.hash,
    });

    return target;
  }

  async reject(id: string, version: number | undefined, actor: string, reason?: string): Promise<SystemDefinition> {
    const existing = this.versions.get(id);
    if (!existing || existing.length === 0) {
      throw new Error(`system ${id} not found`);
    }

    const target = version !== undefined
      ? existing.find((v) => v.version === version)
      : [...existing].reverse().find((v) => v.status === 'proposed') ?? existing[existing.length - 1];

    if (!target) {
      throw new Error(`version ${version ?? 'latest'} not found for system ${id}`);
    }

    target.status = 'rejected';
    target.decidedBy = actor;
    target.decidedAt = new Date().toISOString();
    if (reason) target.reason = reason;

    const sysDir = join(this.dir, id);
    writeFileSync(join(sysDir, `${target.version}.json`), JSON.stringify(target, null, 2));

    // If active current was rejected, find preceding approved version
    if (this.current.get(id)?.version === target.version) {
      const prevApproved = [...existing].reverse().find((v) => v.status === 'approved' && v.version !== target.version);
      if (prevApproved) {
        this.current.set(id, prevApproved);
        writeFileSync(join(sysDir, 'current.json'), JSON.stringify(prevApproved, null, 2));
      } else {
        this.current.delete(id);
      }
    }

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `system:${id}@${target.version}`,
      type: 'action',
      action: 'SYSTEM_REJECTED',
      actor,
      route: id,
      payloadSha256: target.hash,
    });

    return target;
  }


  get(id: string): SystemDefinition | null {
    return this.current.get(id) ?? null;
  }

  history(id: string): SystemDefinition[] {
    return this.versions.get(id) ?? [];
  }

  list(): SystemSummary[] {
    const summaries: SystemSummary[] = [];
    for (const [id, defs] of this.versions.entries()) {
      const active = this.current.get(id) ?? null;
      const latest = defs[defs.length - 1];
      summaries.push({
        id,
        name: active?.name ?? latest.name,
        description: active?.description ?? latest.description,
        kind: active?.kind ?? latest.kind,
        upstream: active?.upstream ?? latest.upstream,
        status: active ? 'approved' : latest.status,
        latestVersion: latest.version,
        approvedVersion: active?.version ?? null,
        activeDefinition: active,
        versions: [...defs],
      });
    }
    return summaries.sort((a, b) => a.id.localeCompare(b.id));
  }

  activeRoutes(): EgressRoute[] {
    const routes: EgressRoute[] = [];
    for (const def of this.current.values()) {
      routes.push({
        id: def.id,
        kind: def.kind,
        upstream: def.upstream,
        credential: def.credential,
        connection: def.connection,
        scopes: def.scopes,
        hold: def.hold,
        stripSignInLinks: def.stripSignInLinks,
        maxContentChars: def.maxContentChars,
      });
    }
    return routes;
  }
}
