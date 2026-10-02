/**
 * System definition store & endpoints (DESIGN_AUTHORITY.md §6.3.1 E10, §6.13 R1).
 *
 * External systems an agent reaches, other than model providers (§6.9), are defined once in the factory:
 * where requests go (upstream), the credential kind (static secret or OAuth connection) and how it is injected.
 * Admin approval is required per definition version.
 *
 * Reads are served from memory (GAP-056). Records live in `<dataDir>/systems/<id>/<version>.json` (backed up, R1).
 *
 *   GET  /api/v1/systems                                  viewer: list systems & current status
 *   GET  /api/v1/systems/:id                              viewer: system details & version history
 *   POST /api/v1/systems                                  viewer/admin: propose a new system or edit
 *   POST /api/v1/systems/:id/approve                      admin: approve a system definition version
 *   POST /api/v1/systems/:id/reject                       admin: reject a system definition version
 *   GET  /api/v1/gatekeeper-egress/routes                 gatekeeper-egress: active routes derived from approved systems
 */
import http from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { payloadHash } from '@beercanlabs/factory-ledger';
import {
  SYSTEM_ID,
  validateSystemProposal,
  type SystemDefinition,
  type SystemProposal,
} from '@beercanlabs/factory-contract';
import {
  connectionProviderFromSystem,
  type ConnectionProvider,
} from '@beercanlabs/factory-keymaster';
import { authenticate, json, readJson, type FactoryState } from './app.js';

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
  credential?: { secret: string; header: string; format?: string; fallback?: boolean };
  connection?: string;
  scopes?: string[];
  hold?: { methods: string[]; preview?: string };
  stripSignInLinks?: boolean;
};

export const BASELINE_SYSTEMS: SystemProposal[] = [
  {
    id: 'discord',
    name: 'Discord API',
    kind: 'http',
    upstream: 'https://discord.com/api/v10',
    credential: {
      secret: '{agent}_DISCORD_BOT_TOKEN',
      header: 'authorization',
      format: 'Bot {}',
    },
    stripSignInLinks: true,
  },
  {
    id: 'notion',
    name: 'Notion API',
    kind: 'http',
    upstream: 'https://api.notion.com',
    credential: {
      secret: 'NOTION_API_KEY',
      header: 'authorization',
      format: 'Bearer {}',
    },
  },
  {
    id: 'google',
    name: 'Google Accounts',
    kind: 'http',
    upstream: 'https://accounts.google.com',
    oauth: {
      kind: 'oauth-user',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      clientSecret: 'GOOGLE_OAUTH_CLIENT',
      authParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    },
  },
  {
    id: 'google-service-account',
    name: 'Google Cloud Service Account',
    kind: 'http',
    upstream: 'https://oauth2.googleapis.com',
    oauth: {
      kind: 'jwt-bearer',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      keySecret: 'GOOGLE_SERVICE_ACCOUNT',
      defaultScopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
    },
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar API',
    kind: 'http',
    upstream: 'https://www.googleapis.com/calendar/v3',
    connection: 'google',
  },
  {
    id: 'google-oauth',
    name: 'Google OAuth API',
    kind: 'http',
    upstream: 'https://oauth2.googleapis.com',
  },
  {
    id: 'google-gmail',
    name: 'Google Gmail API',
    kind: 'http',
    upstream: 'https://gmail.googleapis.com',
    connection: 'google',
  },
  {
    id: 'google-drive',
    name: 'Google Drive API',
    kind: 'http',
    upstream: 'https://www.googleapis.com/drive/v3',
    connection: 'google',
  },
  {
    id: 'google-drive-upload',
    name: 'Google Drive Upload API',
    kind: 'http',
    upstream: 'https://www.googleapis.com/upload/drive/v3',
    connection: 'google',
  },
  {
    id: 'google-health',
    name: 'Google Health API',
    kind: 'http',
    upstream: 'https://health.googleapis.com',
    connection: 'google',
  },
  {
    id: 'google-storage',
    name: 'Google Cloud Storage API',
    kind: 'http',
    upstream: 'https://storage.googleapis.com',
    connection: 'google-service-account',
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
  },
  {
    id: 'github',
    name: 'GitHub API',
    kind: 'http',
    upstream: 'https://api.github.com',
    credential: {
      secret: '{agent}_GITHUB_TOKEN',
      header: 'authorization',
      format: 'Bearer {}',
      fallback: false,
    },
  },
  {
    id: 'motion',
    name: 'Motion API',
    kind: 'http',
    upstream: 'https://api.usemotion.com/v1',
    credential: {
      secret: 'MOTION_API_KEY',
      header: 'x-api-key',
    },
  },
  {
    id: 'linkedin',
    name: 'LinkedIn API',
    kind: 'http',
    upstream: 'https://api.linkedin.com',
    connection: 'linkedin',
    hold: {
      methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
      preview: 'linkedin-post',
    },
    oauth: {
      kind: 'oauth-user',
      authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
      tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
      clientSecret: 'LINKEDIN_OAUTH_CLIENT',
      authParams: {},
      refresh: false,
    },
  },
  {
    id: 'closing-climb',
    name: 'Closing Climb API',
    kind: 'http',
    upstream: 'https://app.closingclimb.com/api',
    credential: {
      secret: 'CC_API_TOKEN',
      header: 'authorization',
      format: 'Bearer {}',
    },
  },
];

export class SystemsStore {
  private readonly versions = new Map<string, SystemDefinition[]>();
  private readonly current = new Map<string, SystemDefinition>();

  constructor(
    private readonly dir: string,
    private readonly ledger?: { append(event: Record<string, unknown>): void },
  ) {}

  static async open(
    dir: string,
    ledger?: { append(event: Record<string, unknown>): void },
  ): Promise<SystemsStore> {
    const store = new SystemsStore(dir, ledger);
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

    // Seed baseline systems if missing
    for (const base of BASELINE_SYSTEMS) {
      if (!store.versions.has(base.id)) {
        await store.seedBaseline(base);
      }
    }

    return store;
  }

  private async seedBaseline(proposal: SystemProposal): Promise<SystemDefinition> {
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
      oauth: proposal.oauth,
    };
    const hash = payloadHash(content);
    const def: SystemDefinition = {
      ...content,
      version: 1,
      status: 'approved',
      proposedBy: 'system:migration',
      proposedAt: new Date().toISOString(),
      decidedBy: 'system:migration',
      decidedAt: new Date().toISOString(),
      reason: 'Baseline migration from landing zone and ops configuration',
      hash,
    };

    const sysDir = join(this.dir, proposal.id);
    mkdirSync(sysDir, { recursive: true });
    writeFileSync(join(sysDir, '1.json'), JSON.stringify(def, null, 2));
    writeFileSync(join(sysDir, 'current.json'), JSON.stringify(def, null, 2));

    this.versions.set(proposal.id, [def]);
    this.current.set(proposal.id, def);

    this.ledger?.append({
      timestamp: new Date().toISOString(),
      agentId: `system:${proposal.id}@1`,
      type: 'action',
      action: 'SYSTEM_APPROVED',
      actor: 'system:migration',
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
      });
    }
    return routes;
  }

  getConnectionProvider(id: string): ConnectionProvider | undefined {
    const sys = this.current.get(id);
    if (!sys || !sys.oauth) return undefined;
    return connectionProviderFromSystem(sys);
  }

  getConnectionProviders(): ConnectionProvider[] {
    const out: ConnectionProvider[] = [];
    for (const sys of this.current.values()) {
      const p = connectionProviderFromSystem(sys);
      if (p) out.push(p);
    }
    return out;
  }
}

export function systemsStore(state: FactoryState): SystemsStore {
  if (!state.systems) {
    throw new Error('systems store not initialized');
  }
  return state.systems;
}

export async function handleSystems(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  // Gatekeeper-egress non-model route resolution (§6.3.1 E10)
  if (path === '/api/v1/gatekeeper-egress/routes' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'gatekeeper-egress'))) return true;
    const store = systemsStore(state);
    json(res, 200, { routes: store.activeRoutes() });
    return true;
  }

  // System catalog list
  if (path === '/api/v1/systems' && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return true;
    const store = systemsStore(state);
    json(res, 200, { systems: store.list() });
    return true;
  }

  // Propose a new system or edit
  if (path === '/api/v1/systems' && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'viewer');
    if (!principal) return true;
    const body = await readJson(req);
    const validation = validateSystemProposal(body);
    if (!validation.ok) {
      json(res, 400, { error: 'invalid_system_proposal', issues: validation.issues });
      return true;
    }
    const store = systemsStore(state);
    const def = await store.propose(validation.proposal, principal.actor);
    json(res, 201, { system: def });
    return true;
  }

  // System details & versions
  const mSys = path.match(/^\/api\/v1\/systems\/([a-z0-9-]+)$/);
  if (mSys && req.method === 'GET') {
    if (!(await authenticate(req, res, state, 'viewer'))) return true;
    const id = mSys[1];
    const store = systemsStore(state);
    const history = store.history(id);
    if (history.length === 0) {
      json(res, 404, { error: 'system_not_found' });
      return true;
    }
    const active = store.get(id);
    json(res, 200, {
      id,
      active,
      history,
    });
    return true;
  }

  // Approve a system
  const mApprove = path.match(/^\/api\/v1\/systems\/([a-z0-9-]+)\/approve$/);
  if (mApprove && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;
    const id = mApprove[1];
    const body = await readJson(req);
    const version = typeof body.version === 'number' ? body.version : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const store = systemsStore(state);
    try {
      const def = await store.approve(id, version, principal.actor, reason);
      json(res, 200, { system: def });
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // Reject a system
  const mReject = path.match(/^\/api\/v1\/systems\/([a-z0-9-]+)\/reject$/);
  if (mReject && req.method === 'POST') {
    const principal = await authenticate(req, res, state, 'admin');
    if (!principal) return true;
    const id = mReject[1];
    const body = await readJson(req);
    const version = typeof body.version === 'number' ? body.version : undefined;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const store = systemsStore(state);
    try {
      const def = await store.reject(id, version, principal.actor, reason);
      json(res, 200, { system: def });
    } catch (err) {
      json(res, 404, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  return false;
}
