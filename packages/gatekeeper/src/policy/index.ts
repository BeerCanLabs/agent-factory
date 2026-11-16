import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { validateBudgetLimits } from '@beercanlabs/factory-budget';
import { archiveStamp } from '@beercanlabs/factory-registrar';
export type ToolRule = { allow: string[] | '*'; requireApproval?: string[] };

/** Admin-set egress policy for one agent. Deny by default: no routes, no tools. */
export type AgentPolicy = {
  routes: string[];
  models?: string[];
  hosts?: string[];
  tools?: Record<string, ToolRule>;
  budgetUsd?: { perRun?: number; perDay?: number; perMonth?: number };
  tokensPerMinute?: number;
  /** AP3.3 (owner-set): give the model one more turn with the notice before returning an answer given without tools. */
  grounding?: 'warn-once';
  currentModel?: string | null;
  primaryModel?: string | null;
  secondaryModel?: string;
  /** E1.3 (#294): the helper (subagent) ids this agent may list and start. Admin-set; none by default. */
  subagents?: string[];
  /** #319: the named agents this agent may wake with its run token. Admin-set, per agent only; none by default. */
  wakeAgents?: string[];
  /**
   * GAP-255: non-secret deployment settings an admin gives this agent's runs as environment variables (a fleet's
   * configuration, a URL it calls back). Never a credential: those are the agent's secrets. Per agent only.
   */
  env?: Record<string, string>;
};

/**
 * GAP-255: an allow-list. A name must start with one of these prefixes (agentic-sdlc's deployment settings:
 * SDLC_FLEET_CONFIG, SDLC_APPROVALS_URL, SDLC_APPROVALS_FALLBACK, SDLC_GLOBAL_STATE_URL, ...), so the env can never reach
 * a name the factory, the runtimes, the memory shim or the platform use (FACTORY_*, MEMORY_*, *_BASE_URL, AGENT_ID,
 * GIT_SSH_COMMAND, BASH_ENV, SSL_CERT_FILE, PATH, ...). Add a prefix here, in review, for another fleet.
 */
export const POLICY_ENV_PREFIXES = ['SDLC_'] as const;
export const POLICY_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const CREDENTIAL_ENV = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|API_?KEY|CREDENTIAL|COOKIE|SESSION)/;
const CREDENTIAL_ENV_WORD = /(^|_)(KEY|PAT|PASS|AUTH|DSN)(_|$)/;
// Values shaped like a credential: provider tokens, a JWT, a PEM private key, a URL with a password in it.
const CREDENTIAL_VALUE =
  /github_pat_\w{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|[a-z][a-z0-9+.-]*:\/\/[^/\s@:]+:[^/\s@]+@/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_ENV_VARS = 32;
// A run's environment travels in the task's start request (ECS allows 8 KiB of overrides in all, in bytes), and the
// factory adds its own FACTORY_* and egress variables to the same request, so the admin's part stays under 6,000 bytes.
const MAX_ENV_BYTES = 6000;

export function validateEnv(v: unknown): string | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'env must be an object of names to text values';
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS) return `env holds at most ${MAX_ENV_VARS} variables`;
  let total = 0;
  for (const [name, value] of entries) {
    if (!POLICY_ENV_NAME.test(name)) return `env name ${JSON.stringify(name.slice(0, 64))} must be UPPER_SNAKE_CASE`;
    if (!POLICY_ENV_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length)) {
      return `env name ${name} is not allowed: names start with ${POLICY_ENV_PREFIXES.join(' or ')}`;
    }
    if (CREDENTIAL_ENV.test(name) || CREDENTIAL_ENV_WORD.test(name)) return `env name ${name} looks like a credential: set it as the agent's secret`;
    if (typeof value !== 'string') return `env.${name} must be text`;
    if (CONTROL.test(value)) return `env.${name} must not hold control characters (newlines, NUL)`;
    if (CREDENTIAL_VALUE.test(value)) return `env.${name} looks like a credential: set it as the agent's secret`;
    total += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8');
  }
  if (total > MAX_ENV_BYTES) return `env is at most ${MAX_ENV_BYTES} bytes (UTF-8) in all`;
  return undefined;
}

const EMPTY: AgentPolicy = { routes: [] };

/** The factory-wide default policy (`PUT /api/v1/policies/budget`). Not an agent; never archived. */
export const GLOBAL_POLICY_ID = '__global__';

/** Ids starting `__` are the factory's own (`__global__`), never an agent's, so they are never orphans. */
export function isReservedPolicyId(id: string): boolean {
  return id.startsWith('__');
}

/** Moves a file, falling back to copy-then-unlink across filesystems. Never deletes without a copy. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0);
}

function positive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

export function validatePolicy(raw: unknown): { ok: true; policy: AgentPolicy } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'policy must be an object' };
  const r = raw as Record<string, unknown>;
  const allowed = new Set(['routes', 'models', 'hosts', 'tools', 'budgetUsd', 'tokensPerMinute', 'grounding', 'currentModel', 'primaryModel', 'secondaryModel', 'subagents', 'wakeAgents', 'env']);
  for (const k of Object.keys(r)) if (!allowed.has(k)) return { ok: false, error: `unknown policy field ${k}` };
  if (!isStringArray(r.routes ?? [])) return { ok: false, error: 'routes must be an array of route ids' };
  if (r.models !== undefined && !isStringArray(r.models)) return { ok: false, error: 'models must be an array of model ids' };
  if (r.hosts !== undefined && !isStringArray(r.hosts)) return { ok: false, error: 'hosts must be an array of hostnames' };
  if (r.subagents !== undefined && !isStringArray(r.subagents)) return { ok: false, error: 'subagents must be an array of helper ids' };
  if (r.wakeAgents !== undefined && !isStringArray(r.wakeAgents)) return { ok: false, error: 'wakeAgents must be an array of agent ids' };
  if (r.env !== undefined) {
    const bad = validateEnv(r.env);
    if (bad) return { ok: false, error: bad };
  }
  if (r.tokensPerMinute !== undefined && !positive(r.tokensPerMinute)) return { ok: false, error: 'tokensPerMinute must be >= 0' };
  if (r.grounding !== undefined && r.grounding !== 'warn-once') return { ok: false, error: 'grounding must be "warn-once" when set' };
  if (r.budgetUsd !== undefined) {
    const budget = validateBudgetLimits(r.budgetUsd);
    if (!budget.ok) return budget;
  }
  if (r.tools !== undefined) {
    if (!r.tools || typeof r.tools !== 'object') return { ok: false, error: 'tools must be an object keyed by route id' };
    for (const [route, rule] of Object.entries(r.tools as Record<string, unknown>)) {
      const t = rule as Record<string, unknown>;
      if (!t || (t.allow !== '*' && !isStringArray(t.allow))) return { ok: false, error: `tools.${route}.allow must be "*" or tool names` };
      if (t.requireApproval !== undefined && !isStringArray(t.requireApproval)) {
        return { ok: false, error: `tools.${route}.requireApproval must be tool names` };
      }
    }
  }

  const dedupedModels = r.models !== undefined ? [...new Set(r.models as string[])] : undefined;

  const effPrimary = r.primaryModel === undefined ? dedupedModels?.[0] : r.primaryModel;

  if (r.secondaryModel !== undefined) {
    if (typeof r.secondaryModel !== 'string' || r.secondaryModel.length === 0) {
      return { ok: false, error: 'secondaryModel must be a non-empty string' };
    }
    if (!dedupedModels || !dedupedModels.includes(r.secondaryModel)) {
      return { ok: false, error: 'secondaryModel must be in models' };
    }
    if (r.secondaryModel === effPrimary) {
      return { ok: false, error: 'secondaryModel cannot equal primaryModel' };
    }
  }

  if (r.currentModel === null || r.primaryModel === null) {
    if (r.currentModel !== null || r.primaryModel !== null) {
      return { ok: false, error: 'currentModel and primaryModel must both be null when either is null' };
    }
    if (r.secondaryModel !== undefined) {
      return { ok: false, error: 'secondaryModel must be undefined when currentModel and primaryModel are null' };
    }
    if (!dedupedModels || dedupedModels.length === 0) {
      return { ok: false, error: 'models must be a non-empty array when models are unset' };
    }
  }

  if (r.currentModel !== undefined && r.currentModel !== null) {
    if (typeof r.currentModel !== 'string' || r.currentModel.length === 0) {
      return { ok: false, error: 'currentModel must be a non-empty string' };
    }
    if (!dedupedModels || dedupedModels.length === 0) {
      return { ok: false, error: 'models must be non-empty when currentModel is set' };
    }
    if (!dedupedModels.includes(r.currentModel)) {
      return { ok: false, error: 'currentModel must be in models' };
    }
  }

  if (r.primaryModel !== undefined && r.primaryModel !== null) {
    if (typeof r.primaryModel !== 'string' || r.primaryModel.length === 0) {
      return { ok: false, error: 'primaryModel must be a non-empty string' };
    }
    if (!dedupedModels || dedupedModels.length === 0) {
      return { ok: false, error: 'models must be non-empty when primaryModel is set' };
    }
    if (!dedupedModels.includes(r.primaryModel)) {
      return { ok: false, error: 'primaryModel must be in models' };
    }
  }

  const policy: AgentPolicy = {
    ...(r as unknown as AgentPolicy),
    routes: (r.routes as string[] | undefined) ?? [],
    ...(dedupedModels !== undefined ? { models: dedupedModels } : {}),
  };
  return { ok: true, policy };
}

/**
 * Deterministically removes models from an agent policy, updating currentModel, primaryModel, and secondaryModel
 * according to §6.9 M2 retirement and unapproval transitions.
 */
export function applyModelsRemoval(policy: AgentPolicy, removed: Iterable<string>): AgentPolicy {
  const next: AgentPolicy = structuredClone(policy);
  if (!next.models) return next;
  const remSet = new Set(removed);
  const remaining = next.models.filter((m) => !remSet.has(m));
  if (remaining.length === 0) {
    delete next.models;
    delete next.currentModel;
    delete next.primaryModel;
    delete next.secondaryModel;
    return next;
  }
  next.models = remaining;

  let current = policy.currentModel;
  let primary = policy.primaryModel;
  let secondary = policy.secondaryModel;

  if (policy.models && primary === undefined && current === undefined && policy.models.length > 0) {
    primary = policy.models[0];
    current = policy.models[0];
  }

  if (secondary !== undefined && remSet.has(secondary)) {
    secondary = undefined;
  }

  const currentInRem = current !== null && current !== undefined && remSet.has(current);
  const primaryInRem = primary !== null && primary !== undefined && remSet.has(primary);

  if (currentInRem && primaryInRem) {
    // Case A (or both current and primary removed)
    if (secondary !== undefined) {
      current = secondary;
      primary = secondary;
      secondary = undefined;
    } else {
      current = null;
      primary = null;
      secondary = undefined;
    }
  } else if (currentInRem && !primaryInRem) {
    // Case B
    current = primary;
  } else if (!currentInRem && primaryInRem) {
    // Case C
    primary = current;
    if (secondary === current) {
      secondary = undefined;
    }
  }

  next.currentModel = current;
  next.primaryModel = primary;
  if (secondary === undefined) {
    delete next.secondaryModel;
  } else {
    next.secondaryModel = secondary;
  }

  return next;
}

export type EffectiveAgentModels = {
  approvedModels: string[];
  usesDefault: boolean;
  currentModel: string | null;
  primaryModel: string | null;
  secondaryModel?: string;
};

/**
 * Resolves effective model slots for an agent policy (M2):
 * - If policy.models is undefined: uses factory defaultModel.
 * - If policy.models is empty: approvedModels is [], currentModel/primaryModel null.
 * - If policy.models is non-empty: primary defaults to models[0], current defaults to primary, secondary optional.
 */
export function effectiveAgentModels(policy?: AgentPolicy, defaultModel?: string): EffectiveAgentModels {
  if (!policy || policy.models === undefined) {
    return {
      approvedModels: defaultModel ? [defaultModel] : [],
      usesDefault: true,
      currentModel: defaultModel ?? null,
      primaryModel: defaultModel ?? null,
      secondaryModel: undefined,
    };
  }
  if (policy.models.length === 0) {
    return {
      approvedModels: [],
      usesDefault: false,
      currentModel: null,
      primaryModel: null,
      secondaryModel: undefined,
    };
  }
  const primary = policy.primaryModel === undefined ? policy.models[0] : policy.primaryModel;
  const current = policy.currentModel === undefined ? primary : policy.currentModel;
  const secondary = policy.secondaryModel;
  return {
    approvedModels: [...policy.models],
    usesDefault: false,
    currentModel: current,
    primaryModel: primary,
    secondaryModel: secondary,
  };
}

export class PolicyStore {
  private readonly policies = new Map<string, AgentPolicy>();
  private readonly ephemeralIds = new Set<string>();

  constructor(
    private readonly dir?: string,
    private readonly fallback: AgentPolicy = EMPTY,
  ) {
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      this.policies.set(name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), 'utf8')) as AgentPolicy);
    }
  }

  get(agentId: string): AgentPolicy {
    return structuredClone(this.policies.get(agentId) ?? this.fallback);
  }

  /** True only for a policy set for this agent (not the fallback). */
  has(agentId: string): boolean {
    return this.policies.has(agentId);
  }

  /** Every id with a policy set (including `__global__`). */
  ids(): string[] {
    return [...this.policies.keys()];
  }

  /**
   * GAP-060: moves these ids' policy files to `<parent of the policy dir>/policies-orphaned/<timestamp>/` (moved, never
   * deleted) and stops serving them. Reserved ids (`__global__`) and ids without a policy are skipped. Returns the ids
   * archived and where; a file that cannot be moved stays where it is and keeps being served.
   */
  archive(ids: Iterable<string>, now = new Date()): { archived: string[]; to?: string } {
    const archived: string[] = [];
    let to: string | undefined;
    for (const id of new Set(ids)) {
      if (isReservedPolicyId(id) || !this.policies.has(id)) continue;
      if (this.dir) {
        const from = join(this.dir, `${id}.json`);
        if (existsSync(from)) {
          to ??= join(dirname(this.dir), 'policies-orphaned', archiveStamp(now));
          try {
            mkdirSync(to, { recursive: true });
            moveFile(from, join(to, `${id}.json`));
          } catch (err) {
            console.error(`[control-plane] policy ${id} not archived: ${err instanceof Error ? err.message : String(err)}`);
            continue;
          }
        }
      }
      this.policies.delete(id);
      archived.push(id);
    }
    return { archived, ...(to && archived.length ? { to } : {}) };
  }

  /** E1.4 (#295): a policy held in memory only (a helper run's), never written to the policy directory. */
  setEphemeral(agentId: string, policy: AgentPolicy): void {
    this.policies.set(agentId, policy);
    this.ephemeralIds.add(agentId);
  }

  /** E1.4 (#295): drops an in-memory-only policy; a stored policy is left alone. */
  forgetEphemeral(agentId: string): void {
    if (!this.ephemeralIds.delete(agentId)) return;
    this.policies.delete(agentId);
  }

  set(agentId: string, policy: AgentPolicy): void {
    this.policies.set(agentId, policy);
    this.ephemeralIds.delete(agentId);
    if (!this.dir) return;
    const path = join(this.dir, `${agentId}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(policy, null, 2));
    renameSync(tmp, path);
  }
}
