import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateCartridge, classifySecrets, connectionSchema, secretDeclarations, type Surface, type Cartridge, type SecretsManifest, type Connection, type SecretDeclaration } from '@beercanlabs/factory-contract';

export type AgentCategory = 'user' | 'builtin';

// Operational Built-in System Actors
export const BUILTIN_AGENT_IDS = new Set([
  'gatekeeper-ingress',
  'keymaster',
  'doctor',
  'coach',
]);

// Retired sample/placeholder cartridges that are no longer active agents
export const RETIRED_PLACEHOLDER_IDS = new Set([
  'factory-mechanic',
  'librarian',
  'compliance-officer',
  'starter-python',
]);

export function isBuiltinCartridge(id: string, _dir?: string): boolean {
  return BUILTIN_AGENT_IDS.has(id);
}

export const BUILTIN_SYSTEM_AGENTS: AgentRecord[] = [
  {
    id: 'gatekeeper-ingress',
    name: 'gatekeeper-ingress',
    role: 'gatekeeper-ingress, Routing & Agent Presence Controller',
    state: 'WORKING',
    category: 'builtin',
    isBuiltin: true,
    provider: 'cloud',
    artifact: 'factory-gatekeeper-ingress:latest',
    requires: ['GATEKEEPER_INGRESS_SECRET', 'FACTORY_API_TOKEN'],
    ungated: ['GATEKEEPER_INGRESS_SECRET', 'FACTORY_API_TOKEN'],
    gated: [],
    triggers: [
      { type: 'http', path: '/api/v1/presence' },
      { type: 'webhook', path: '/hooks/ingress' },
    ],
    memoryPrefix: 'system-gatekeeper-ingress',
    warmDownSeconds: 0,
    dir: '/app/packages/gatekeeper-ingress',
    model: 'deterministic',
    requestedModels: [],
    approvedModels: [],
  },
  {
    id: 'keymaster',
    name: 'Keymaster',
    role: 'Cryptographic Locksmith, Vault Hydration & Pre-flight Secrets Verifier',
    state: 'WORKING',
    category: 'builtin',
    isBuiltin: true,
    provider: 'cloud',
    artifact: 'factory-keymaster:latest',
    requires: ['AWS_SECRETS_MANAGER_ROLE', 'VAULT_MASTER_KEY'],
    ungated: ['AWS_SECRETS_MANAGER_ROLE', 'VAULT_MASTER_KEY'],
    gated: [],
    triggers: [{ type: 'http', path: '/api/v1/keys/verify' }],
    memoryPrefix: 'system-keymaster',
    warmDownSeconds: 0,
    dir: '/app/packages/keymaster',
    model: 'deterministic',
    requestedModels: [],
    approvedModels: [],
  },
  {
    id: 'doctor',
    name: 'Doctor',
    role: 'Triage Engine, Crash Diagnostic Router & Health Quarantine',
    state: 'WORKING',
    category: 'builtin',
    isBuiltin: true,
    provider: 'cloud',
    artifact: 'factory-triage:latest',
    requires: ['INCIDENT_WEBHOOK_URL'],
    ungated: ['INCIDENT_WEBHOOK_URL'],
    gated: [],
    triggers: [
      { type: 'webhook', path: '/hooks/triage' },
      { type: 'http', path: '/api/v1/triage' },
    ],
    memoryPrefix: 'system-doctor',
    warmDownSeconds: 0,
    dir: '/app/packages/triage',
    model: 'deterministic',
    requestedModels: [],
    approvedModels: [],
  },
  {
    id: 'coach',
    name: 'Coach',
    role: 'Quality Benchmark Evaluator, Training Function & Model Graduation Gate',
    state: 'WORKING',
    category: 'builtin',
    isBuiltin: true,
    provider: 'cloud',
    artifact: 'factory-bench:latest',
    requires: ['EVAL_MODEL_API_KEY'],
    ungated: ['EVAL_MODEL_API_KEY'],
    gated: [],
    triggers: [
      { type: 'http', path: '/api/v1/bench/run' },
      { type: 'http', path: '/api/v1/bench/scorecard' },
    ],
    memoryPrefix: 'system-coach',
    warmDownSeconds: 0,
    dir: '/app/packages/bench',
    model: 'gemini-2.0-flash',
    requestedModels: ['gemini-2.0-flash', 'claude-3-5-sonnet'],
    approvedModels: ['gemini-2.0-flash'],
  },
];

export type AgentRecord = {
  id: string;
  name: string;
  role: string;
  state:
    | 'SLEEPING'
    | 'WORKING'
    | 'PAUSED'
    | 'ISOLATED'
    | 'BLOCKED_FOR_HUMAN'
    | 'ERROR'
    | 'PENDING_BUDGET'
    | 'PENDING_DEPLOY'
    | 'DEPLOYING'
    | 'RETIRED_PENDING_PURGE'
    | 'PURGED'
    | 'IDLE'
    | 'TRAINING'
    | 'OUT_OF_BUDGET';
  category?: AgentCategory;
  isBuiltin?: boolean;
  provider: string;
  artifact: string;
  localCommand?: string[];
  requires: string[];
  ungated: string[];
  gated: string[];
  triggers: Surface['triggers'];
  memoryPrefix?: string;
  warmDownSeconds?: number;
  dir: string;
  retiredAt?: string;
  purgeDueAt?: string;
  model?: string;
  requestedModels?: string[];
  approvedModels?: string[];
  budgetUsd?: { perRun?: number; perDay?: number; perMonth?: number };
  spendLimitUsd?: number;
  spendLimitMonthlyUsd?: number;
  currentSpendUsd?: number;
  currentSpendMonthlyUsd?: number;
  /** Registered source (§6.8 L3): git repository and the exact commit pinned for admission. */
  repo?: string;
  commit?: string;
  /** The commit whose SHA-tagged image is deployed now (L4). */
  deployedCommit?: string;
  /**
   * SK4: the skills the deployed image contains, each as the approved version it was built from. Absent or empty: none.
   * What runs, as `deployedCommit` is for the source; the configuration says what should run (SK3).
   */
  deployedSkills?: Array<{ id: string; version: string }>;
  /**
   * SK6: set when a forced retire or revocation paused this agent because it ran the skill. Redeploying the agent
   * without that skill resumes it; an agent paused for any other reason is never resumed by a skill change.
   */
  pausedForSkill?: string;
  /** Outcome of the last admission build of `commit`. */
  admission?: { commit: string; status: 'building' | 'admitted' | 'refused'; reason?: string; phase?: string; message?: string; at: string };
  /** Connections the cartridge declares (§6.11 K1): provider plus scopes. A request shown to admins, not a grant. */
  connections?: Connection[];
  /** Static credentials the cartridge declares (§6.11 K5.1): name, and source and description when given. */
  credentials?: SecretDeclaration[];
  /** Egress the cartridge declares (E7 request, E8 ceiling). Shown to the admin who sets policy; never a grant. */
  egress?: { routes: string[]; hosts: string[] };
};

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length > 0) : []);

/** The egress a cartridge body declares (`egress.routes`, `egress.hosts`), when it declares any. */
export function egressOf(cartridge: { egress?: unknown }): { egress?: { routes: string[]; hosts: string[] } } {
  const e = cartridge.egress;
  if (!e || typeof e !== 'object') return {};
  const routes = strings((e as { routes?: unknown }).routes);
  const hosts = strings((e as { hosts?: unknown }).hosts);
  return routes.length || hosts.length ? { egress: { routes, hosts } } : {};
}

/** The declared static credentials of a cartridge body (K5.1), when any carry a source or description. */
export function credentialsOf(cartridge: { secrets?: unknown }): { credentials?: SecretDeclaration[] } {
  const decl = secretDeclarations(cartridge.secrets as Parameters<typeof secretDeclarations>[0]);
  return decl.some((d) => d.source || d.description) ? { credentials: decl } : {};
}

/** Every static credential an agent declares: its typed declarations, plus any other required secret by name. */
export function declaredCredentials(agent: Pick<AgentRecord, 'requires' | 'credentials'>): SecretDeclaration[] {
  const out = [...(agent.credentials ?? [])];
  const names = new Set(out.map((d) => d.name));
  for (const name of agent.requires ?? []) if (!names.has(name)) out.push({ name });
  return out;
}

/** The declared connections of a cartridge body, validated; invalid entries are dropped. */
export function connectionsOf(cartridge: { connections?: unknown }): { connections?: Connection[] } {
  if (!Array.isArray(cartridge.connections)) return {};
  const out: Connection[] = [];
  for (const c of cartridge.connections) {
    const parsed = connectionSchema.safeParse(c);
    if (parsed.success) out.push(parsed.data);
  }
  return out.length ? { connections: out } : {};
}

/**
 * One agent list from the three sources. Built-in system actors cannot be replaced. A dynamic registry record
 * replaces a static catalog cartridge with the same id (§6.8 L2: agents move from the baked catalog to
 * registration one at a time).
 */
export function mergeAgents(builtins: AgentRecord[], staticAgents: AgentRecord[], registry: AgentRecord[]): AgentRecord[] {
  const out = new Map<string, AgentRecord>();
  for (const a of staticAgents) out.set(a.id, a);
  for (const a of registry) out.set(a.id, a);
  for (const a of builtins) out.set(a.id, a);
  return [...out.values()];
}

export function loadCatalog(agentsRoot: string, options: { includeRetired?: boolean } = {}): AgentRecord[] {
  const dirs = walk(agentsRoot);
  const out: AgentRecord[] = [];
  for (const dir of dirs) {
    const result = validateCartridge(dir);
    if (!result.ok) continue;
    if (!options.includeRetired && RETIRED_PLACEHOLDER_IDS.has(result.cartridgeId)) continue;

    const entries = new Set(readdirSync(dir));
    let soulContent = '';
    if (entries.has('soul.md')) {
      try {
        soulContent = readFileSync(join(dir, 'soul.md'), 'utf8');
      } catch {}
    }

    let name = (soulContent ? titleFromSoul(soulContent) : undefined) ?? result.cartridgeId;
    let role = (soulContent ? mandateFromSoul(soulContent) : undefined) ?? name;
    let artifact = '';
    let localCommand: string[] | undefined;
    let requires: string[] = [];
    let ungated: string[] = [];
    let gated: string[] = [];
    let triggers: Surface['triggers'] = [];
    let memoryPrefix: string | undefined = result.cartridgeId;
    let warmDownSeconds: number | undefined;

    let rawCartridge: Cartridge | undefined;

    // Check for unified cartridge.yaml first
    if (entries.has('cartridge.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'cartridge.yaml'), 'utf8')) as Cartridge;
        rawCartridge = raw;
        if (raw.name) name = raw.name;
        if (raw.role) role = raw.role;
        if (raw.compute?.ref || raw.artifact?.ref) {
          artifact = raw.compute?.ref || raw.artifact?.ref || '';
        }
        if (raw.compute?.localCommand || raw.artifact?.localCommand) {
          localCommand = raw.compute?.localCommand || raw.artifact?.localCommand;
        }
        if (raw.secrets) {
          const classified = classifySecrets(raw.secrets);
          requires = classified.all;
          ungated = classified.ungated;
          gated = classified.gated;
        }
        if (raw.triggers) {
          triggers = raw.triggers;
        }
        if (raw.persistence?.prefix || raw.memory?.prefix) {
          memoryPrefix = raw.persistence?.prefix || raw.memory?.prefix;
        }
        if (raw.runtime?.warmDownSeconds) {
          warmDownSeconds = Number(raw.runtime.warmDownSeconds);
        }
      } catch (err) {
        console.error(`[catalog] failed to parse cartridge.yaml in ${dir}:`, err);
      }
    }

    // Fall back to legacy individual files if not populated by cartridge.yaml
    if (!artifact && entries.has('artifact.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'artifact.yaml'), 'utf8')) as {
          ref?: string;
          localCommand?: string[];
        };
        artifact = raw.ref ?? '';
        localCommand = raw.localCommand;
      } catch {
        artifact = '';
      }
    }
    if (requires.length === 0 && entries.has('secrets.manifest.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'secrets.manifest.yaml'), 'utf8')) as SecretsManifest;
        const classified = classifySecrets(raw);
        requires = classified.all;
        ungated = classified.ungated;
        gated = classified.gated;
      } catch {
        requires = [];
        ungated = [];
        gated = [];
      }
    }
    if (triggers.length === 0 && entries.has('surface.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'surface.yaml'), 'utf8')) as Surface;
        triggers = raw.triggers ?? [];
      } catch {
        triggers = [];
      }
    }
    if (memoryPrefix === result.cartridgeId && entries.has('memory.yaml')) {
      try {
        const raw = parseYaml(readFileSync(join(dir, 'memory.yaml'), 'utf8')) as { prefix?: string };
        if (raw.prefix) memoryPrefix = raw.prefix;
      } catch {
        memoryPrefix = result.cartridgeId;
      }
    }

    const isBuiltin = (rawCartridge as any)?.isBuiltin ?? ((rawCartridge as any)?.category ? (rawCartridge as any).category === 'builtin' : isBuiltinCartridge(result.cartridgeId, dir));
    const category: AgentCategory = isBuiltin ? 'builtin' : 'user';
    const isCloud = rawCartridge?.compute?.kind === 'oci' || (process.env.FACTORY_RUNTIME === 'ecs' && !localCommand);

    out.push({
      id: result.cartridgeId,
      name,
      role,
      state: 'SLEEPING',
      category,
      isBuiltin,
      provider: isCloud ? 'cloud' : 'local',
      artifact,
      localCommand,
      requires,
      ungated: ungated.length ? ungated : requires,
      gated,
      triggers,
      memoryPrefix,
      warmDownSeconds: warmDownSeconds ?? rawCartridge?.runtime?.warmDownSeconds ?? 300,
      dir,
      model: rawCartridge?.model || 'gemini-2.0-flash',
      requestedModels: rawCartridge?.requestedModels || rawCartridge?.models || [],
      approvedModels: rawCartridge?.approvedModels && rawCartridge.approvedModels.length > 0
        ? rawCartridge.approvedModels
        : [rawCartridge?.model || 'gemini-2.0-flash'],
      ...connectionsOf(rawCartridge ?? {}),
      ...credentialsOf(rawCartridge ?? {}),
    });
  }
  return out;
}

function walk(root: string, depth = 0): string[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const here = entries.includes('cartridge.yaml') || entries.includes('soul.md') ? [root] : [];
  if (depth >= 3) return here;
  const nested = entries.flatMap((name) => {
    if (name.startsWith('.')) return [];
    const child = join(root, name);
    try {
      return statSync(child).isDirectory() && basename(child) !== 'node_modules' ? walk(child, depth + 1) : [];
    } catch {
      return [];
    }
  });
  return [...here, ...nested];
}

function titleFromSoul(soul: string): string | undefined {
  const m = soul.match(/^#\s+Soul:\s*(.+)$/m);
  return m?.[1]?.trim();
}

function mandateFromSoul(soul: string): string | undefined {
  const m = soul.match(/\*\*Mandate:\*\*\s*(.+)$/m);
  return m?.[1]?.trim();
}

export function loadDynamicRegistry(registryDir: string): AgentRecord[] {
  if (!existsSync(registryDir)) return [];
  const records: AgentRecord[] = [];
  try {
    for (const f of readdirSync(registryDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(registryDir, f), 'utf8')) as AgentRecord;
        if (data && data.id) {
          const isBuiltin = data.isBuiltin ?? (data.category ? data.category === 'builtin' : isBuiltinCartridge(data.id, data.dir));
          records.push({
            ...data,
            isBuiltin,
            category: isBuiltin ? 'builtin' : 'user',
          });
        }
      } catch (err) {
        console.warn(`[control-plane] failed to parse dynamic agent ${f}:`, err);
      }
    }
  } catch (err) {
    console.warn(`[control-plane] failed to read dynamic registry dir ${registryDir}:`, err);
  }
  return records;
}

