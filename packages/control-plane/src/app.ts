import http from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { checkAgentUpdate, extractGitHubRepo, isNewerVersion, parseSemVer } from './updates.js';
import type { SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { bindSecrets } from '@beercanlabs/factory-secrets-bind';
import { redactSecrets, payloadHash, type CheckpointSink, type LedgerStore } from '@beercanlabs/factory-ledger';
import { accessAssertionOf, type AccessAuth, type AuthProvider, type AuthResult, type Principal, type Role, type CliDiscovery } from '@beercanlabs/factory-auth';
import { cartridgeRoleProblems, classifySecrets, effectiveAccess, type Surface } from '@beercanlabs/factory-contract';
import {
  AgentRecord,
  registryOf,
  BUILTIN_AGENT_IDS,
  admissionOf,
  admit,
  beginAdmission,
  checkRepoUrl,
  connectionsOf,
  credentialsOf,
  egressOf,
  rolesOf,
  skillIdsOf,
  skillRoutesOf,
  FULL_SHA,
  gitLsRemoteResolver,
  isBuiltinCartridge,
  pinSource,
  stateAfterRefusal,
  type AgentCategory,
  type CommitResolver,
  type ConfigStore,
  type SkillChecker,
  type SkillSource,
} from '@beercanlabs/factory-registrar';
import { AdmissionRefusedError, SYSTEM, activeRun, applyKillSwitch, blockRun, createRun, deliverToMailbox, finishRun, haltUnhealthy, isTerminal, markRunReady, resetAgent, routeEvents, scheduleTimeout, unblockRun, type CallbackPolicy, type DeployProvider, type Run, type RunStore, type Runtime, type RunTokens, type SourceRef, type MailboxMessage, type MailboxQueue } from '@beercanlabs/factory-property-manager';
import { checkStanding, spendDetail, type BudgetLimits, type SpendTracker } from '@beercanlabs/factory-budget';
import { authorize, authorizeIngress, directCaller, heldCopyOf, heldToolName, parseHoldRequest, type Approval, type ApprovalStore, type AuthenticatedCaller, type Privilege } from '@beercanlabs/factory-bouncer';
import { validatePolicy, type PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { verifyRun } from '@beercanlabs/factory-gatekeeper/run-token';

/** E9: the largest held request body the control plane keeps (characters, base64 included). */
import { Keymaster, type ConnectionKeymaster } from '@beercanlabs/factory-keymaster';
import { handleConnections } from './connections.js';
import { handleCredentials } from './credentials.js';
import { accessForRequester, accessForRun, hasDeniedRoute } from './access-enforcement.js';
import { changeReason, handleConfig, ownersOf, recordConfig, removeConfig } from './config-store.js';
import { handleSkills, resumeSkillChecks } from './skills.js';
import { applyTrainingForCaller, handleSkillTraining } from './skill-training.js';
import { buildSkillsFor, isDeploying, runDeploy } from './apply.js';
import { handleRunProgress } from './progress-routes.js';
import { incidentsFromRuns, type FactoryMetrics, type Inspector } from '@beercanlabs/factory-inspector';
import { handleSchedules, requesterOfRun } from './schedules.js';
import { handleIdentityLinks, type IdentityLinkStore } from './identity-links.js';
import { handleSystems, type SystemsStore } from './systems.js';
import type { ScheduleStore } from '@beercanlabs/factory-timekeeper';
import { handleSpend, type Treasury } from './spend.js';
import { sanitizeOutputWithProvenance } from './provenance.js';
import { AI_PROVIDER_TEMPLATES, LEGACY_ARCHETYPES, canonicalArchetype, platformCredentialName } from '@beercanlabs/factory-contract';
import { resolveModelReference, type DiscoveredModel } from '@beercanlabs/factory-executive';
import { ModelStore, type StoredModel, type StagedModel } from './models.js';

/** AM2: a console turn the agent may answer through `POST /runs/:id/reply`. */
export type ConsoleTurn = { agentId: string; actor: string; at: number };
/** AM2: a reply to a console turn, readable only by the person who asked. */
export type ConsoleReply = { seq: number; agentId: string; actor: string; turnId: string; runId: string; content: string; footnote?: string; at: string };

/** AM2: how long a console turn can be answered, and how many replies the factory keeps for the console to collect. */
const CONSOLE_TURN_TTL_MS = 60 * 60 * 1000;
const CONSOLE_REPLIES_KEPT = 500;
/** AM2: the longest reply a run may send to the console (characters). */
const CONSOLE_REPLY_MAX = 32_000;
const CONSOLE_REPLIES_PER_PERSON = 50;
const CONSOLE_TURNS_KEPT = 5_000;
let consoleReplySeq = 0;
/** Reply sequence numbers grow across control-plane restarts (time-based), so a console's cursor never skips new replies. */
const nextReplySeq = (): number => (consoleReplySeq = Math.max(Date.now() * 1000, consoleReplySeq + 1));

export type FactoryState = {

  agents: Map<string, AgentRecord>;
  /** Dynamic model store (§6.9 M3, GAP-162). */
  modelStore?: ModelStore;
  /** Models the factory offers (§6.9 M3, FACTORY_MODEL_CATALOG), by neutral name. */
  modelCatalog?: Record<string, { provider: string; id?: string; region?: string; endpoint?: string; price?: { inputPerMTok: number; outputPerMTok: number } }>;
  /** The model a policy that names none grants (M2): configuration seeded from FACTORY_DEFAULT_MODEL; no code default. */
  defaultModel?: string;
  registryDir?: string;
  ledger: LedgerStore;
  auth: AuthProvider;
  /**
   * §6.12 A2: the identity-aware proxy's signed assertion, verified against its issuer, audience and keys. Absent:
   * Access identity is disabled and only factory credentials (bearer tokens, OIDC, run tokens) authenticate.
   */
  access?: AccessAuth;
  version: string;
  /** §6.17 CL9: how a CLI signs people in, published at `/.well-known/factory-cli` when the deployment configures it. */
  cliDiscovery?: CliDiscovery;
  providers: SecretProvider[];
  runtime: Runtime;
  /** Provider-specific deploy lifecycle (build → identity → compute). Absent = deploy endpoint returns 501. */
  deployProvider?: DeployProvider;
  /** Pins a registration that names no commit to the repository's default-branch HEAD. Default: `git ls-remote`. */
  resolveCommit?: CommitResolver;
  runs: RunStore;
  runTokens: RunTokens;
  callbacks: CallbackPolicy;
  policies: PolicyStore;
  /** §6.14 SK3: every agent's versioned deployment configuration, held in memory and written through on change. */
  configs?: ConfigStore;
  /**
   * §6.14 SK1: runs the factory's checks on a registered skill version's code. Unset: chosen from the environment
   * (the Registrar's `skillCheckerFromEnv`); null: none.
   */
  skillChecker?: SkillChecker | null;
  /**
   * §6.14 SK1, TSK-055: where registration reads a skill's `skill.yaml` when the caller sends none, and resolves a
   * branch or tag to its commit. Unset: git with the factory's read-only source token (`gitSkillSource`).
   */
  skillSource?: SkillSource;
  spend: SpendTracker;
  /** The Treasurer's cloud and compute sources, and factory budget store (§6.15). */
  treasury?: Treasury;
  approvals: ApprovalStore;
  keymaster?: Keymaster;
  /** Keymaster connections (§6.11): OAuth grants and app credentials. Created on first use. */
  connections?: ConnectionKeymaster;
  /** The factory's public origin for browser flows (OAuth consent callbacks). From the landing zone; never hard-coded. */
  publicBaseUrl?: string;
  /** Signs OAuth consent state. Defaults to the callback signing key. */
  connectionStateKey?: string;
  schedules?: ScheduleStore;
  /** GAP-088: which person a Discord user is, set by an admin. Absent: nobody is linked. */
  identityLinks?: IdentityLinkStore;
  /** Systems as factory data (§6.3.1 E10): approved external system definitions. */
  systems?: SystemsStore;
  /** URL agents use to reach the control plane (result reporting, input fetch). */
  publicUrl?: string;
  /** URL agents use to reach the gatekeeper-egress; handed to every run as FACTORY_GATEKEEPER_EGRESS_URL. */
  gatekeeperEgressUrl?: string;
  /** Bearer the control plane presents to the gatekeeper-egress for vendor discovery. Never a provider key. */
  gatekeeperEgressToken?: string;
  /** Max wall-clock per run before it is stopped as TIMED_OUT. 0 disables. */
  idleMs: number;
  idleTimers: Map<string, ReturnType<typeof setTimeout>>;
  gatekeeperIngressUrl?: string;
  /** Presented to gatekeeper-ingress's presence API. */
  gatekeeperIngressToken?: string;
  /** A run that has sent heartbeats is halted as BLOCKED_UNHEALTHY after this much silence. 0 disables. */
  heartbeatTimeoutMs?: number;
  /** When this process began judging heartbeats (GAP-176). */
  healthSince?: number;
  /** Halt a run whose reported RSS exceeds this. 0 disables. */
  maxRssMb?: number;
  /** Consecutive failed runs within 10 minutes that pause the agent. 0 disables. */
  crashLoopThreshold?: number;
  metrics?: FactoryMetrics;
  /** The Inspector: events, run progress and the enterprise bus (§6.15). */
  inspector: Inspector;
  secretValues: Set<string>;
  /** Short-lived cache of bound secret values, so pre-flight and redaction do not hit the vault on every wake. */
  secretCache?: Map<string, { value: string; at: number }>;
  /** Provider keys only the gatekeeper-egress holds (injected at egress, S1). Pre-flight treats them as satisfied and never reads them. */
  gatekeeperEgressHeldSecrets?: Set<string>;
  /** Write-once copy of the ledger; `verify` checks the local chain against it. */
  ledgerSink?: CheckpointSink;
  /** In-memory mailboxes for running tasks to receive follow-up messages while warm. */
  mailboxes?: Map<string, MailboxQueue>;
  /** AM2: console turns awaiting a reply, by turn id: which agent was asked and who asked. */
  consoleTurns?: Map<string, ConsoleTurn>;
  /** AM2: replies to console turns, kept briefly for the person who asked (never for anyone else). */
  consoleReplies?: ConsoleReply[];
};



const INGEST_TYPES = new Set(['llm', 'mcp', 'action', 'crash', 'budget.alert']);
const MAX_BODY = 256 * 1024;

type Outcome<T> = { status: number; body: T | { error: string; [k: string]: unknown } };

export function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString();
      if (body.length > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

/**
 * §6.12 A2: who is calling, from a credential the factory verifies itself. The `Authorization` header (factory tokens,
 * OIDC) first, then the identity-aware proxy's signed assertion (`cf-access-jwt-assertion` or the `CF_Authorization`
 * cookie) when Access identity is configured. Unsigned identity headers (the proxy's plain email header) are never
 * read.
 */
export async function identify(req: http.IncomingMessage, state: FactoryState): Promise<AuthResult> {
  const reasons: string[] = [];
  if (req.headers.authorization) {
    const r = await state.auth.verify(req.headers.authorization);
    if (r.ok) return r;
    reasons.push(r.reason);
  }
  const assertion = accessAssertionOf(req.headers);
  if (assertion && state.access) {
    const r = await state.access.verify(assertion);
    if (r.ok) return r;
    reasons.push(`access: ${r.reason}`);
  }
  return { ok: false, reason: reasons.join('; ') || 'no credential' };
}

/**
 * A2, E4: authenticate (the Gatekeeper's verification of who the caller is), then ask the Bouncer whether this caller
 * may do this. Answers 401 or 403 and returns null when not; the 403 names the role that holds the privilege.
 */
export async function requirePrivilege(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: FactoryState,
  privilege: Privilege,
  resource?: { agentId: string },
): Promise<Principal | null> {
  const result = await identify(req, state);
  if (!result.ok) {
    json(res, 401, { error: 'unauthorized' });
    return null;
  }
  const decision = authorize({
    principal: result.principal,
    privilege,
    ...(resource ? { resource: { agentId: resource.agentId, owners: ownersOf(state, resource.agentId) } } : {}),
  });
  if (!decision.allowed) {
    json(res, 403, { error: 'forbidden', required: decision.required });
    return null;
  }
  return result.principal;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}


/**
 * The Treasurer, before a message goes into a live run (GAP-091): the same standing the wake asks and the egress asks
 * on every model call. Returns the refused window, or undefined when the agent may take the message. A run already
 * flagged BLOCKED_BUDGET_EXCEEDED reports `blocked`, as the egress does. `perRun` counts only when a run exists.
 */
export function handoffRefusal(state: FactoryState, agent: AgentRecord): string | undefined {
  const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
  if (isBuiltin) return undefined;
  const run = activeRun(state, agent.id);
  if (run?.state === 'BLOCKED_BUDGET_EXCEEDED') return 'blocked';
  const budget = state.policies.get(agent.id).budgetUsd;
  const limits = budget ? (run ? budget : { perDay: budget.perDay, perMonth: budget.perMonth }) : undefined;
  const standing = checkStanding({ limits, spend: state.spend.get(agent.id, run?.runId) });
  return standing.inGoodStanding ? undefined : standing.window;
}

export function enrichAgent(state: FactoryState, a: AgentRecord) {
  const s = state.spend.get(a.id, undefined);
  const pol = state.policies.get(a.id);
  const activeR = activeRun(state, a.id);
  const isBuiltin = Boolean(a.isBuiltin || a.category === 'builtin' || BUILTIN_AGENT_IDS.has(a.id));
  const category: AgentCategory = isBuiltin ? 'builtin' : (a.category ?? 'user');
  return {
    ...a,
    category,
    isBuiltin,
    budgetExempt: isBuiltin,
    version: (a as any).version || '1.0.0',
    state: activeR ? 'RUNNING' : a.state,
    /** A run is live now (GAP-176): what gatekeeper-ingress presence follows, never the stored `state`. */
    liveRun: Boolean(activeR),
    currentSpendUsd: Number((s?.day ?? 0).toFixed(4)),
    currentSpendMonthlyUsd: Number((s?.month ?? 0).toFixed(4)),
    spendLimitUsd: isBuiltin ? null : Number((pol?.budgetUsd?.perDay ?? 0).toFixed(2)),
    spendLimitMonthlyUsd: isBuiltin ? null : Number((pol?.budgetUsd?.perMonth ?? 0).toFixed(2)),
    budgetUsd: isBuiltin ? undefined : pol?.budgetUsd,
    lastRunId: activeR?.runId,
    domain: (a as any).domain || (isBuiltin ? 'Platform Infrastructure' : 'Submind Autonomous Operations'),
    mindPrefix: a.memoryPrefix ? `s3://beercanlabs-minds/${a.memoryPrefix}/` : `s3://beercanlabs-minds/${a.id}/`,
    sqliteSizeKb: (a as any).sqliteSizeKb ?? 0,
  };
}


/** Kill-switch only. Waking is createRun. */
/**
 * Lets a run that was flagged BLOCKED_BUDGET_EXCEEDED go again once the agent is back inside its limits. Every route
 * that can change a budget calls this, so the console's budget field and the policy editor behave the same way.
 */
function unblockAffordableRuns(state: FactoryState, agentId: string, limits: BudgetLimits | undefined, actor: string) {
  for (const run of state.runs.list({ agentId, active: true })) {
    if (run.state === 'BLOCKED_BUDGET_EXCEEDED' && checkStanding({ limits, spend: state.spend.get(agentId, run.runId) }).inGoodStanding) {
      unblockRun(state, run.runId, 'BLOCKED_BUDGET_EXCEEDED', actor);
    }
  }
}


type ToolSpec = { name: string; description: string; privilege: Privilege; args: Record<string, { type: string }>; required?: string[] };

const TOOLS: ToolSpec[] = [
  { name: 'list_agents', description: 'List factory cartridges', privilege: 'agents.read', args: {} },
  { name: 'query_ledger', description: 'Read the execution ledger', privilege: 'ledger.read', args: { agent: { type: 'string' } } },
  { name: 'get_run', description: 'Get a run by id', privilege: 'runs.read', args: { runId: { type: 'string' } }, required: ['runId'] },
  { name: 'wake_agent', description: 'Start a run (202 semantics: returns the queued/started run)', privilege: 'agents.wake', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'pause_agent', description: 'Pause agent egress', privilege: 'agents.pause', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'resume_agent', description: 'Resume agent egress', privilege: 'agents.resume', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'isolate_agent', description: 'Isolate agent egress', privilege: 'agents.isolate', args: { id: { type: 'string' } }, required: ['id'] },
  { name: 'list_approvals', description: 'List pending tool-call approvals', privilege: 'approvals.read', args: {} },
  {
    name: 'decide_approval',
    description: 'Approve or reject a held tool call',
    privilege: 'approvals.decide',
    args: { approvalId: { type: 'string' }, decision: { type: 'string' }, notes: { type: 'string' } },
    required: ['approvalId', 'decision'],
  },
  {
    name: 'check_agent_update',
    description: 'Check for available cartridge updates from git repository',
    privilege: 'agents.update.read',
    args: { id: { type: 'string' } },
    required: ['id'],
  },
  {
    name: 'install_agent_update',
    description: 'Install an available cartridge update (mode: drain or restart_now)',
    privilege: 'agents.update.install',
    args: { id: { type: 'string' }, mode: { type: 'string' } },
    required: ['id'],
  },
  {
    name: 'list_model_catalog',
    description: 'List offered and staged models in the factory',
    privilege: 'models.read',
    args: {},
  },
  {
    name: 'scan_vendor_models',
    description: 'Scan an AI vendor endpoint to discover available models',
    privilege: 'models.manage',
    args: { vendorId: { type: 'string' } },
    required: ['vendorId'],
  },
  {
    name: 'admit_model',
    description: 'Admit a model to the factory offering with token pricing. Name its vendor (vendorId): provider, endpoint and credential come from the vendor. provider/region only for cloud model services (bedrock-converse, vertex-*).',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
      id: { type: 'string' },
      vendorId: { type: 'string' },
      provider: { type: 'string' },
      region: { type: 'string' },
      inputPerMTok: { type: 'string' },
      outputPerMTok: { type: 'string' },
    },
    required: ['name', 'id'],
  },
  {
    name: 'update_model_pricing',
    description: 'Update token pricing per million tokens for an admitted model',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
      inputPerMTok: { type: 'string' },
      outputPerMTok: { type: 'string' },
    },
    required: ['name', 'inputPerMTok', 'outputPerMTok'],
  },
  {
    name: 'retire_vendor_or_model',
    description: 'Retire an admitted model from the factory offering',
    privilege: 'models.manage',
    args: {
      name: { type: 'string' },
    },
    required: ['name'],
  },
  {
    name: 'set_default_model',
    description: 'Set the factory default model granted to agents whose policy specifies no models (requires models.manage)',
    privilege: 'models.manage',
    args: {
      model: { type: 'string' },
    },
    required: ['model'],
  },
];

export async function handleMcp(state: FactoryState, payload: Record<string, unknown>, principal: Principal): Promise<unknown> {
  const id = payload.id ?? 1;
  const method = payload.method;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-factory', version: state.version },
      },
    };
  }
  if (method === 'tools/list') {
    const tools = TOOLS.filter((t) => authorize({ principal, privilege: t.privilege }).allowed).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object', properties: t.args, ...(t.required ? { required: t.required } : {}) },
    }));
    return { jsonrpc: '2.0', id, result: { tools } };
  }
  if (method === 'tools/call') {
    const params = (payload.params ?? {}) as { name?: string; arguments?: Record<string, string> };
    const spec = TOOLS.find((t) => t.name === params.name);
    if (!spec) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${String(params.name)}` } };
    const decision = authorize({ principal, privilege: spec.privilege });
    if (!decision.allowed) {
      return { jsonrpc: '2.0', id, error: { code: -32001, message: `forbidden: requires ${decision.required}` } };
    }
    const result = await dispatchTool(state, spec.name, params.arguments ?? {}, principal);
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } };
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${String(method)}` } };
}

type VendorTarget = { upstream: string; adapter: string; discoveryPath?: string; secretName: string };

/**
 * Hands a turn to the agent (GAP-176, §6.15): to its live run's mailbox, or, with no run to hand it to (live or queued),
 * by waking it through the one wake path, so it is never parked in a mailbox nobody reads.
 */
async function handOff(
  state: FactoryState,
  agent: AgentRecord,
  actor: string,
  payload: unknown,
  opts: { requestedBy?: { provider: string; id: string }; caller?: AuthenticatedCaller },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const active = state.runs.list({ agentId: agent.id, active: true });
  // E12 item 4: a run's roles are those of the person it was started for. A message from a person whose roles deny a
  // skill route must not be handled inside someone else's run, where it would have that person's reach. It waits.
  if (active.length > 0 && opts.requestedBy) {
    const sender = accessForRequester(state, agent, { kind: 'identity', provider: opts.requestedBy.provider, id: opts.requestedBy.id });
    const sameAsRun = active.every((r) => r.requestedBy && r.requestedBy.provider === opts.requestedBy!.provider && r.requestedBy.id === opts.requestedBy!.id);
    if (hasDeniedRoute(sender) && !sameAsRun) {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent.id, type: 'action', action: 'HANDOFF_REFUSED_BUSY_FOR_ANOTHER_PERSON', actor });
      return { status: 409, body: { error: 'busy_with_another_person', message: 'the agent is working for someone else; try again in a moment' } };
    }
  }
  if (active.length === 0) {
    const out = await createRun(state, agent.id, {
      actor,
      trigger: 'conversation',
      input: payload,
      ...(opts.requestedBy ? { requestedBy: opts.requestedBy } : {}),
      ...(opts.caller ? { caller: opts.caller } : {}),
    });
    if (out.status >= 300) return { status: out.status, body: out.body as Record<string, unknown> };
    const woke = out.body as { runId: string };
    state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent.id, runId: woke.runId, type: 'action', action: 'CONVERSATION_HANDOFF', actor, content: payload });
    return { status: 202, body: { ok: true, woke: true, runId: woke.runId } };
  }
  await state.runtime.deliver(agent, payload);
  deliverToMailbox(state, agent.id, payload);
  const currentRun = activeRun(state, agent.id);
  if (currentRun) {
    if (currentRun.input === undefined) currentRun.input = payload;
    scheduleTimeout(state, currentRun);
  }
  state.ledger.append({ timestamp: new Date().toISOString(), agentId: agent.id, runId: currentRun?.runId, type: 'action', action: 'CONVERSATION_HANDOFF', actor, content: payload });
  return { status: 202, body: { ok: true } };
}

/** AM2: a console turn the agent may answer, kept for an hour; the oldest are dropped past the cap. */
function rememberConsoleTurn(state: FactoryState, turnId: string, agentId: string, actor: string): void {
  if (!state.consoleTurns) state.consoleTurns = new Map();
  const now = Date.now();
  for (const [id, t] of state.consoleTurns) if (now - t.at > CONSOLE_TURN_TTL_MS || state.consoleTurns.size >= CONSOLE_TURNS_KEPT) state.consoleTurns.delete(id);
  state.consoleTurns.set(turnId, { agentId, actor, at: now });
}

/**
 * AM2: where a turn's reply goes. A Discord message is answered in its channel; a person conversing directly is answered
 * in the console. Anything else (another ingress) names no address yet.
 */
function replyAddress(isIngress: boolean, caller: AuthenticatedCaller | undefined, input: Record<string, unknown>): { channel: string; channelId?: string } | undefined {
  if (!isIngress) return { channel: 'console' };
  if (caller?.provider === 'discord' && typeof input.channelId === 'string' && /^\d{1,32}$/.test(input.channelId)) return { channel: 'discord', channelId: input.channelId };
  return undefined;
}

/**
 * AP3.4: the footnote a text result needs. The gatekeeper-egress records a hash of every final model answer
 * (`MODEL_REPLY`, or `UNGROUNDED_REPLY` when tools were offered and none called); the result is matched by hash.
 */
function resultFootnote(output: string, runRows: ReadonlyArray<Record<string, unknown>>): string | undefined {
  const text = output.trim();
  // A machine-read result (JSON) is never altered.
  if (/^[[{]/.test(text)) {
    try {
      JSON.parse(text);
      return undefined;
    } catch {
      // not JSON: a text reply
    }
  }
  const sha = createHash('sha256').update(text).digest('hex');
  const match = [...runRows].reverse().find((r) => (r.action === 'MODEL_REPLY' || r.action === 'UNGROUNDED_REPLY') && r.replySha256 === sha);
  if (match) return match.action === 'UNGROUNDED_REPLY' ? '[no tools called]' : undefined;
  // "No model" only when the run used the factory model API and no provider-native route (whose answers are not recorded).
  const modelApi = runRows.some((r) => r.route === 'models');
  const native = runRows.some((r) => r.type === 'llm' && r.route !== 'models');
  return modelApi && !native ? '[no model or tools used]' : undefined;
}

/** The factory default model: configuration (M2, GAP-181), never a value in code. Undefined when none is set. */
function defaultModelOf(state: FactoryState): string | undefined {
  return state.modelStore?.getDefault() ?? state.defaultModel;
}

/**
 * Retire a model and take it out of every policy that lists it (§6.9 M2, GAP-162). Each changed policy goes through
 * the same record as a policy change: `POLICY_UPDATED` and a configuration version (GAP-181).
 */
async function retireModel(state: FactoryState, modelName: string, actor: string): Promise<{ retired: false } | { retired: true; affectedAgents: string[] }> {
  if (!state.modelStore?.retire(modelName)) return { retired: false };
  if (state.defaultModel === modelName) state.defaultModel = undefined;
  const affectedAgents: string[] = [];
  for (const agentId of state.policies.ids()) {
    const policy = state.policies.get(agentId);
    if (!policy.models?.includes(modelName)) continue;
    affectedAgents.push(agentId);
    const remaining = policy.models.filter((m) => m !== modelName);
    if (remaining.length === 0) delete policy.models;
    else policy.models = remaining;
    state.policies.set(agentId, policy);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'POLICY_UPDATED', actor });
    await recordConfig(state, agentId, { actor, reason: `model ${modelName} retired` });
  }
  state.modelCatalog = state.modelStore.toEgressCatalog();
  state.ledger.append({ action: 'MODEL_RETIRED', actor, model: modelName, affectedAgents, timestamp: new Date().toISOString() });
  return { retired: true, affectedAgents };
}

/** Registered ai-provider, else a built-in template. HTTPS only. The secret name is held by the gatekeeper-egress. */
function vendorTarget(state: FactoryState, vendorId: string): VendorTarget | { error: string; message?: string } {
  let upstream: string | undefined;
  let adapter = 'openAiCompatible';
  let discoveryPath: string | undefined;
  const sys = state.systems?.get(vendorId);
  if (sys && sys.kind === 'ai-provider') {
    upstream = sys.upstream;
    if (sys.aiProvider) {
      adapter = sys.aiProvider.adapter;
      discoveryPath = sys.aiProvider.discoveryPath;
    }
  }
  if (!upstream && AI_PROVIDER_TEMPLATES[vendorId]) {
    const tmpl = AI_PROVIDER_TEMPLATES[vendorId];
    upstream = tmpl.upstream;
    adapter = tmpl.adapter;
    discoveryPath = tmpl.discoveryPath;
  }
  if (!upstream) return { error: 'invalid_request', message: 'vendorId must match a registered ai-provider system or built-in template' };
  try {
    if (new URL(upstream).protocol !== 'https:') return { error: 'invalid_upstream', message: 'upstream must be an https URL' };
  } catch {
    return { error: 'invalid_upstream', message: 'upstream must be a valid URL' };
  }
  const secretName = sys?.credential?.secret
    || AI_PROVIDER_TEMPLATES[vendorId]?.heldSecret
    || platformCredentialName(vendorId);
  return { upstream, adapter, discoveryPath, secretName };
}

/** Adapter key (catalog `provider`) for a registered vendor's adapter type. */
const ADAPTER_KEYS: Record<string, string> = {
  openAiCompatible: 'openai',
  anthropicMessages: 'anthropic',
  // An API-key Gemini vendor uses the direct Gemini adapter, like the built-in one (not Vertex's cloud identity).
  vertexGemini: 'google',
  vertexAnthropic: 'vertex-anthropic',
  bedrockConverse: 'bedrock-converse',
};
/** Built-in vendors (template id -> adapter key); a model admitted for one keeps its adapter's default endpoint. */
const BUILTIN_VENDOR_ADAPTER: Record<string, string> = Object.fromEntries(
  Object.entries(AI_PROVIDER_TEMPLATES).filter(([id]) => id !== 'custom').map(([id, t]) => [id, t.adapterKey]),
);
/** Cloud model services: the gatekeeper-egress's cloud identity, never a vendor key. A vendor never re-routes them. */
const CLOUD_PROVIDERS = new Set(['bedrock-converse', 'vertex-ai', 'vertex-gemini', 'vertex-anthropic']);
/** API-key adapter keys and the built-in vendor each implies when a caller names a provider but no vendor. */
const API_KEY_PROVIDER_VENDOR: Record<string, string> = { openai: 'openai', anthropic: 'anthropic', 'anthropic-messages': 'anthropic', xai: 'xai', gemini: 'gemini', google: 'gemini' };

/**
 * GAP-182: an admitted vendor model takes its provider, endpoint and credential from the vendor itself (the registered
 * system, or a built-in template), never from the caller. Built-in vendors keep their adapter's default endpoint.
 */
function vendorCatalogFields(state: FactoryState, vendorId: string): { provider: string; endpoint?: string; secret: string } | { error: string; message?: string } {
  const target = vendorTarget(state, vendorId);
  if ('error' in target) return target;
  const builtin = BUILTIN_VENDOR_ADAPTER[vendorId];
  return {
    provider: builtin ?? ADAPTER_KEYS[target.adapter] ?? 'openai',
    ...(builtin ? {} : { endpoint: target.upstream }),
    secret: target.secretName,
  };
}

type AdmitInput = { name?: string; id?: string; vendorId?: string; provider?: string; endpoint?: string; region?: string; price?: { inputPerMTok: number; outputPerMTok: number } };

/** One admission path for REST, MCP and the console (GAP-182). */
function admitModel(state: FactoryState, input: AdmitInput, actor: string): { ok: true; model: StoredModel } | { ok: false; status: number; error: string; message?: string } {
  if (!state.modelStore) return { ok: false, status: 500, error: 'model_store_not_configured' };
  if (!input.name || !input.id) return { ok: false, status: 400, error: 'invalid_request', message: 'name and id are required' };
  const cloud = Boolean(input.provider && CLOUD_PROVIDERS.has(input.provider));
  let vendorId = cloud ? undefined : input.vendorId;
  if (!vendorId && input.provider && API_KEY_PROVIDER_VENDOR[input.provider]) {
    // An API-key provider needs a vendor (its credential and host). A custom endpoint must be a registered vendor.
    if (input.endpoint) return { ok: false, status: 400, error: 'vendor_required', message: 'a model on a custom endpoint is admitted through its registered vendor (vendorId)' };
    vendorId = API_KEY_PROVIDER_VENDOR[input.provider];
  }
  let fields: { provider: string; endpoint?: string; secret?: string; region?: string };
  if (vendorId) {
    const v = vendorCatalogFields(state, vendorId);
    if ('error' in v) return { ok: false, status: 400, error: v.error, message: v.message };
    fields = v;
  } else {
    if (!input.provider) return { ok: false, status: 400, error: 'invalid_request', message: 'vendorId or provider is required' };
    // Cloud model services (Bedrock, Vertex) use the gatekeeper-egress's cloud identity, not a key.
    fields = { provider: input.provider, ...(input.region ? { region: input.region } : {}) };
  }
  try {
    const model = state.modelStore.admit({ name: input.name, id: input.id, ...fields, vendorId: vendorId ?? input.vendorId, price: input.price, actor });
    state.modelCatalog = state.modelStore.toEgressCatalog();
    state.ledger.append({ action: 'MODEL_ADMITTED', actor, model: model.name, provider: model.provider, vendorId: model.vendorId, price: model.price, timestamp: new Date().toISOString() });
    return { ok: true, model };
  } catch (err) {
    return { ok: false, status: 409, error: 'admission_failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * GAP-182 repair: every admitted model with a vendor takes its vendor's current provider, endpoint and credential.
 * Run at start (after the built-in vendors are seeded) and whenever a vendor changes. Returns the models re-linked.
 */
export function relinkVendorModels(state: FactoryState): string[] {
  if (!state.modelStore) return [];
  const changed: string[] = [];
  for (const m of state.modelStore.listOffered()) {
    // Cloud model services keep their provider and region; a vendor id on them is a label only.
    if (!m.vendorId || CLOUD_PROVIDERS.has(m.provider)) continue;
    const v = vendorCatalogFields(state, m.vendorId);
    if ('error' in v) continue;
    if (state.modelStore.relinkVendor(m.name, v, false)) changed.push(m.name);
  }
  if (changed.length) {
    state.modelStore.save();
    state.modelCatalog = state.modelStore.toEgressCatalog();
    state.ledger.append({ action: 'MODEL_RELINKED', actor: SYSTEM.policy, models: changed, timestamp: new Date().toISOString() });
  }
  return changed;
}

/**
 * S1: the control plane never reads a provider key. The gatekeeper-egress holds it and calls the vendor.
 * Returns model ids only.
 */
async function discoverViaEgress(state: FactoryState, target: VendorTarget): Promise<DiscoveredModel[]> {
  const base = state.gatekeeperEgressUrl?.replace(/\/$/, '');
  const token = state.gatekeeperEgressToken;
  if (!base || !token) {
    const err = new Error('vendor discovery is not configured');
    (err as Error & { status?: number }).status = 503;
    throw err;
  }
  const res = await fetch(`${base}/internal/vendor-models`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      upstream: target.upstream,
      adapter: target.adapter,
      discoveryPath: target.discoveryPath,
      secretName: target.secretName,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { models?: DiscoveredModel[]; error?: string };
  if (!res.ok || !Array.isArray(body.models)) {
    const err = new Error(body.error === 'credential_unbound' ? 'credential_unbound' : 'discovery_failed');
    (err as Error & { status?: number }).status = res.status === 503 ? 503 : 502;
    throw err;
  }
  return body.models;
}

function stageDiscovered(state: FactoryState, vendorId: string, discovered: DiscoveredModel[], actor: string): StagedModel[] {
  const staged: StagedModel[] = discovered.map((d) => {
    const ref = resolveModelReference(d.id);
    return {
      vendorId,
      rawId: d.id,
      displayName: d.name ?? d.id,
      discoveredAt: new Date().toISOString(),
      suggestedFriendlyName: ref.friendlyName,
      suggestedPrice: ref.price,
    };
  });
  if (state.modelStore) {
    state.modelStore.stageDiscovered(staged);
    state.modelCatalog = state.modelStore.toEgressCatalog();
  }
  state.ledger.append({
    action: 'MODELS_DISCOVERED',
    actor,
    vendorId,
    count: staged.length,
    timestamp: new Date().toISOString(),
  });
  return staged;
}

async function dispatchTool(state: FactoryState, name: string, args: Record<string, string>, principal: Principal): Promise<unknown> {
  const actor = principal.actor;
  if (name === 'list_agents') return [...state.agents.values()];
  if (name === 'query_ledger') return state.ledger.query({ agent: args.agent });
  if (name === 'get_run') return state.runs.get(args.runId) ?? { error: 'not_found' };
  if (name === 'list_approvals') return state.approvals.list({ state: 'pending' });
  if (name === 'decide_approval') return (await decideApproval(state, args.approvalId, args.decision, principal, args.notes)).body;
  if (name === 'list_model_catalog') {
    return {
      offered: state.modelStore ? state.modelStore.listOffered() : Object.entries(state.modelCatalog ?? {}).map(([n, m]) => ({ name: n, ...m })),
      staged: state.modelStore?.listStaged() ?? [],
      default: defaultModelOf(state) ?? null,
    };
  }
  if (name === 'scan_vendor_models') {
    const vendorId = args.vendorId;
    if (!vendorId) return { error: 'vendorId is required' };
    const target = vendorTarget(state, vendorId);
    if ('error' in target) return target;
    try {
      const discovered = await discoverViaEgress(state, target);
      const staged = stageDiscovered(state, vendorId, discovered, actor);
      return { ok: true, count: staged.length, staged };
    } catch (err: any) {
      const code = err?.message === 'credential_unbound' ? 'credential_unbound' : err?.status === 503 ? 'discovery_unavailable' : 'discovery_failed';
      return { error: code, message: `Model discovery failed for vendor ${vendorId}` };
    }
  }
  if (name === 'admit_model') {
    const price = (args.inputPerMTok && args.outputPerMTok) ? {
      inputPerMTok: parseFloat(args.inputPerMTok),
      outputPerMTok: parseFloat(args.outputPerMTok),
    } : undefined;
    const out = admitModel(state, { name: args.name, id: args.id, vendorId: args.vendorId, provider: args.provider, region: args.region, price }, actor);
    return out.ok ? { ok: true, model: out.model } : { error: out.error, ...(out.message ? { message: out.message } : {}) };
  }
  if (name === 'update_model_pricing') {
    if (!state.modelStore) return { error: 'model_store_not_configured' };
    const price = {
      inputPerMTok: parseFloat(args.inputPerMTok),
      outputPerMTok: parseFloat(args.outputPerMTok),
    };
    try {
      const model = state.modelStore.updatePricing(args.name, price, actor);
      state.modelCatalog = state.modelStore.toEgressCatalog();
      state.ledger.append({
        action: 'MODEL_PRICING_UPDATED',
        actor,
        model: args.name,
        price,
        timestamp: new Date().toISOString(),
      });
      return { ok: true, model };
    } catch (err: any) {
      return { error: 'not_found', message: err.message };
    }
  }
  if (name === 'retire_vendor_or_model') {
    if (!state.modelStore) return { error: 'model_store_not_configured' };
    const modelName = args.name;
    const out = await retireModel(state, modelName, actor);
    if (!out.retired) return { error: 'not_found' };
    return { ok: true, retired: modelName, affectedAgents: out.affectedAgents };
  }
  if (name === 'set_default_model') {
    if (!state.modelStore) return { error: 'model_store_not_configured' };
    const model = args.model;
    if (!model || typeof model !== 'string') return { error: 'model is required' };
    try {
      state.modelStore.setDefault(model, actor);
      state.defaultModel = model;
      state.ledger.append({
        action: 'MODEL_DEFAULT_UPDATED',
        actor,
        model,
        timestamp: new Date().toISOString(),
      });
      return { ok: true, default: model };
    } catch (err: any) {
      return { error: 'invalid_request', message: err.message };
    }
  }

  const id = args.id;
  if (!id) return { error: 'id required' };
  if (name === 'wake_agent') return (await createRun(state, id, { actor, trigger: 'mcp' })).body;
  if (name === 'pause_agent') return (await applyKillSwitch(state, id, 'PAUSE', actor)).body;
  if (name === 'resume_agent') return (await applyKillSwitch(state, id, 'RESUME', actor)).body;
  if (name === 'isolate_agent') return (await applyKillSwitch(state, id, 'ISOLATE', actor)).body;
  if (name === 'check_agent_update') {
    const agent = state.agents.get(id);
    if (!agent) return { error: 'not_found' };
    const res = await checkAgentUpdate(agent, process.env.FACTORY_AGENT_SOURCE_TOKEN);
    Object.assign(agent, res);
    registryOf(state).save(agent);
    return res;
  }
  if (name === 'install_agent_update') {
    const agent = state.agents.get(id);
    if (!agent) return { error: 'not_found' };
    const mode = (args.mode === 'restart_now' ? 'restart_now' : 'drain') as 'drain' | 'restart_now';
    const targetCommit = agent.offeredCommit ?? agent.commit;
    const targetVersion = agent.offeredVersion;
    if (!targetCommit) return { error: 'no_commit_available' };
    if (agent.state === 'WORKING' && mode === 'drain') {
      agent.stagedCommit = targetCommit;
      agent.stagedVersion = targetVersion;
      agent.pendingDrain = true;
      registryOf(state).save(agent);
      return { ok: true, status: 'staged_drain', agentId: id, commit: targetCommit, version: targetVersion };
    }
    agent.commit = targetCommit;
    agent.deployedCommit = targetCommit;
    if (targetVersion) agent.installedVersion = targetVersion;
    agent.updateAvailable = false;
    delete agent.pendingDrain;
    delete agent.stagedCommit;
    delete agent.stagedVersion;
    registryOf(state).save(agent);
    return { ok: true, status: 'applied', agentId: id, commit: targetCommit, version: targetVersion };
  }
  return { error: `unknown tool ${name}` };
}

/**
 * E9, E4: who may decide what an agent did. The global `admin` and `approver` roles decide any agent's; otherwise the
 * requesting user of the run decides, or, when the run has no requesting user, any owner of the agent. A requester whose
 * Discord id is not linked to a person lets no owner decide. This runs before anything changes, and a caller who may
 * not decide is refused whether or not the approval exists.
 */
function mayDecide(state: FactoryState, principal: Principal, approvalId: string): { ok: true } | { ok: false; required: Role } {
  const global = authorize({ principal, privilege: 'approvals.decide' });
  if (global.allowed) return { ok: true };
  const approval = state.approvals.get(approvalId);
  if (!approval) return { ok: false, required: global.required };
  const run = state.runs.get(approval.runId);
  // The run is the record of who asked. If it is gone nobody can say, so no owner or requester decides (fail closed);
  // an admin or approver already passed above.
  if (!run) return { ok: false, required: global.required };
  const requester = run.requestedBy ? { actor: state.identityLinks?.resolve(run.requestedBy.provider, run.requestedBy.id) } : undefined;
  const scoped = authorize({
    principal,
    privilege: 'approvals.decide',
    resource: { agentId: approval.agentId, owners: ownersOf(state, approval.agentId), ...(requester ? { requester } : {}) },
  });
  return scoped.allowed ? { ok: true } : { ok: false, required: scoped.required };
}

async function decideApproval(state: FactoryState, id: string, decision: unknown, principal: Principal, notes?: unknown): Promise<Outcome<unknown>> {
  const actor = principal.actor;
  const may = mayDecide(state, principal, id);
  if (!may.ok) return { status: 403, body: { error: 'forbidden', required: may.required } };
  if (decision !== 'approve' && decision !== 'reject') return { status: 400, body: { error: 'decision must be approve or reject' } };
  if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 4000)) return { status: 400, body: { error: 'notes must be text, at most 4000 characters' } };
  const note = typeof notes === 'string' && notes.trim() ? notes.trim() : undefined;
  const decided = state.approvals.decide(id, decision === 'approve' ? 'approved' : 'rejected', actor, note);
  if (!decided) return { status: 409, body: { error: 'approval not pending' } };
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: decided.agentId,
    runId: decided.runId,
    type: 'action',
    action: decision === 'approve' ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
    actor,
    approvalId: decided.approvalId,
    mcpName: decided.tool,
    route: decided.route,
  });
  if (decided.kind === 'held') {
    // E9: the decision goes to the agent; no run waited for it.
    const delivered = await deliverDecision(state, decided, actor);
    return { status: 200, body: { ...decided, delivered } };
  }
  if (!state.approvals.list({ state: 'pending', runId: decided.runId }).length) {
    unblockRun(state, decided.runId, 'BLOCKED_FOR_HUMAN', actor);
  }
  return { status: 200, body: decided };
}

/**
 * E9: tell the agent what was decided about its held request: into the mailbox of its live run, or as the input of a new
 * run. Approved: send the identical request again to release it. Rejected: nothing was sent; `notes` say why.
 */
async function deliverDecision(state: FactoryState, a: Approval, actor: string): Promise<'mailbox' | 'run' | 'not_delivered'> {
  // E12: whatever the decision starts or joins carries the reach of the person whose run asked, never the decider's own.
  // The decider's notes and the held request's path are free text written by people and agents who may be restricted,
  // so they travel only where the receiving run has no more reach than their source.
  // A run the factory started itself (a queue, an event) has no person: that is not "unknown". Only a run whose person
  // should exist but cannot be read (a missing origin, a scheduled run whose schedule is gone) is unplaceable.
  type Who = NonNullable<ReturnType<typeof requesterOfRun>> | 'none' | 'unknown';
  const whoOf = (r: Run | undefined): Who => {
    if (!r) return 'unknown';
    return requesterOfRun(state, r) ?? (r.trigger === 'schedule' ? 'unknown' : 'none');
  };
  const who = whoOf(state.runs.get(a.runId));
  const sameRequester = (r: Run | undefined): boolean => {
    const there = whoOf(r);
    if (who === 'unknown' || there === 'unknown') return false;
    if (who === 'none' || there === 'none') return who === there;
    if (who.kind === 'identity') return there.kind === 'identity' && there.provider === who.provider && there.id === who.id;
    if (who.kind === 'principal') return there.kind === 'principal' && there.actor === who.actor;
    return there.kind === who.kind;
  };
  const plain = {
    type: 'approval',
    approvalId: a.approvalId,
    route: a.route,
    decision: a.state === 'approved' ? 'approved' : 'rejected',
    decidedBy: a.decidedBy,
    decidedAt: a.decidedAt,
  };
  const full = {
    ...plain,
    request: a.request ? { method: a.request.method, path: a.request.path } : undefined,
    ...(a.notes ? { notes: a.notes } : {}),
  };
  const live = activeRun(state, a.agentId);
  if (live) {
    deliverToMailbox(state, a.agentId, sameRequester(live) ? full : plain);
    return 'mailbox';
  }
  // A person's request stays that person's. An origin that cannot be placed starts a run that holds nothing: a
  // requester no identity link resolves to is restricted to nothing.
  const forPerson =
    who === 'unknown'
      ? { requestedBy: { provider: 'factory', id: 'unplaceable-origin' } }
      : typeof who === 'object' && who.kind === 'identity'
        ? { requestedBy: { provider: who.provider, id: who.id } }
        : {};
  const out = await createRun(state, a.agentId, { actor, trigger: 'approval', input: who === 'unknown' ? plain : full, ...forPerson });
  if (out.status < 300) return 'run';
  state.ledger.append({
    timestamp: new Date().toISOString(),
    agentId: a.agentId,
    type: 'action',
    action: 'APPROVAL_DECISION_UNDELIVERED',
    actor,
    approvalId: a.approvalId,
    route: a.route,
  });
  return 'not_delivered';
}

export function bearerOf(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/** Authenticate a run token for exactly this run while it is still live. */
async function authenticateRun(req: http.IncomingMessage, res: http.ServerResponse, state: FactoryState, runId: string) {
  const isResultPost = (req.url?.includes('/result') || false) && req.method === 'POST';
  const verdict = await verifyRun({
    tokens: state.runTokens,
    token: bearerOf(req),
    runId,
    runOf: (id) => state.runs.get(id),
    ended: (r) => isTerminal(r.state),
    endedOk: (r) => isResultPost && r.state === 'TIMED_OUT', // a timed-out run may still post its result
  });
  if (verdict.kind !== 'ok') {
    json(res, 401, { error: 'invalid_run_token' });
    return null;
  }
  return verdict.run;
}

export function getKeymaster(state: FactoryState): Keymaster {
  if (!state.keymaster) {
    state.keymaster = new Keymaster({
      approvals: state.approvals,
      ledger: state.ledger,
      providers: state.providers,
      secretValues: state.secretValues,
      getAgent: (agentId: string) => state.agents.get(agentId),
      getRun: (runId: string) => state.runs.get(runId),
    });
  }
  return state.keymaster;
}

import { UI_HTML } from './ui.js';

export function createFactoryServer(state: FactoryState): http.Server {
  // SK1: follow skill checks a previous control plane started and did not see end.
  void resumeSkillChecks(state).catch((err) => console.warn('[control-plane] could not resume skill checks:', err));
  return http.createServer(async (req, res) => {
    try {
      await route(state, req, res);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

async function route(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse) {
  const path = (req.url ?? '/').split('?')[0];
  const started = Number(process.env.FACTORY_STARTED_AT ?? Date.now());

  if (path === '/ui' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(UI_HTML);
    return;
  }

  if ((path.startsWith('/api/v1/connections/') || path === '/api/v1/gatekeeper-egress/connections/token') && (await handleConnections(state, req, res, path))) return;
  if (path.startsWith('/api/v1/keymaster/') && (await handleCredentials(state, req, res, path))) return;
  if (await handleConfig(state, req, res, path)) return;
  if (path.startsWith('/api/v1/skills/') && (await handleSkillTraining(state, req, res, path))) return;
  if ((path.startsWith('/api/v1/registry/skills') || path.startsWith('/api/v1/skills') || /^\/api\/v1\/agents\/[^/]+\/skills(\/|$)/.test(path)) && (await handleSkills(state, req, res, path))) return;
  if (await handleRunProgress(state, req, res, path)) return;
  if (path.startsWith('/api/v1/schedules') && (await handleSchedules(state, req, res, path))) return;
  if (path.startsWith('/api/v1/identity-links') && (await handleIdentityLinks(state, req, res, path))) return;
  if ((path.startsWith('/api/v1/systems') || path === '/api/v1/gatekeeper-egress/routes') && (await handleSystems(state, req, res, path))) return;
  if (path.startsWith('/api/v1/spend/') && (await handleSpend(state, req, res, path))) return;

  // CL9: public, no secret in it, and only when the deployment configured a CLI client.
  if (path === '/.well-known/factory-cli' && req.method === 'GET') {
    if (!state.cliDiscovery) return json(res, 404, { error: 'not_found' });
    res.setHeader('cache-control', 'public, max-age=300');
    return json(res, 200, state.cliDiscovery);
  }

  if ((path === '/healthz' || path === '/' || path === '/api/v1/health') && req.method === 'GET') {

    json(res, 200, {
      status: 'ok',
      version: state.version,
      uptime: Math.round((Date.now() - started) / 1000),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // The caller's verified identity and roles (the dashboard shows what the factory will actually allow).
  if (path === '/api/v1/whoami' && req.method === 'GET') {
    const who = await identify(req, state);
    if (!who.ok) return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { actor: who.principal.actor, roles: who.principal.roles });
    return;
  }

  if ((path === '/api/v1/metrics' || path === '/metrics') && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'metrics.read'))) return;
    const activeRuns = state.runs.list({ active: true });
    const runCounts: Record<string, number> = {};
    for (const r of activeRuns) runCounts[r.state] = (runCounts[r.state] ?? 0) + 1;

    const agentCounts: Record<string, number> = {};
    for (const a of state.agents.values()) agentCounts[a.state] = (agentCounts[a.state] ?? 0) + 1;

    let daySpend = 0;
    let monthSpend = 0;
    let totalBudgetDay = 0;
    let totalBudgetMonth = 0;
    for (const id of state.agents.keys()) {
      const a = state.agents.get(id);
      const isBuiltin = Boolean(a?.isBuiltin || a?.category === 'builtin' || BUILTIN_AGENT_IDS.has(id));
      const s = state.spend.get(id, undefined);
      daySpend += s.day;
      monthSpend += s.month;
      if (!isBuiltin) {
        const pol = state.policies.get(id);
        if (pol?.budgetUsd?.perDay) {
          totalBudgetDay += pol.budgetUsd.perDay;
        }
        if (pol?.budgetUsd?.perMonth) {
          totalBudgetMonth += pol.budgetUsd.perMonth;
        }
      }
    }

    json(res, 200, {
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      agents: {
        total: state.agents.size,
        byState: agentCounts,
      },
      runs: {
        active: activeRuns.length,
        byState: runCounts,
      },
      ledger: {
        totalRows: state.ledger.query().length,
        wormConfigured: Boolean(state.ledgerSink),
      },
      spendUsd: {
        day: Number(daySpend.toFixed(4)),
        month: Number(monthSpend.toFixed(4)),
        limit: Number(totalBudgetDay.toFixed(2)),
        monthLimit: Number(totalBudgetMonth.toFixed(2)),
      },
    });
    return;
  }

  // TSK-045: per-agent model spend (gatekeeper-egress-metered `llm` rows) for the current UTC day and month. Counts only:
  // no prompt bodies, no secrets. A verified viewer, or a live run whose agent's admin-set policy grants the
  // `factory-spend` tool (E7: never implied). Every read is ledgered.
  if (path === '/api/v1/spend' && req.method === 'GET') {
    let actor: string;
    let agentId = 'factory';
    const verdict = await verifyRun({ tokens: state.runTokens, token: bearerOf(req), runOf: (id) => state.runs.get(id), ended: (r) => isTerminal(r.state) });
    if (verdict.kind === 'refused') return json(res, 401, { error: 'invalid_run_token' });
    if (verdict.kind === 'ok') {
      const claims = verdict.claims;
      // Only a policy an admin set for this agent counts; the factory fallback policy never grants it.
      const granted = state.policies.has(claims.agentId) && Object.prototype.hasOwnProperty.call(state.policies.get(claims.agentId).tools ?? {}, 'factory-spend');
      if (!granted) {
        return json(res, 403, { error: 'forbidden', required: 'policy.tools.factory-spend' });
      }
      actor = `run:${claims.agentId}:${claims.runId}`;
      agentId = claims.agentId;
    } else {
      const principal = await requirePrivilege(req, res, state, 'spend.read');
      if (!principal) return;
      actor = principal.actor;
    }
    const report = state.spend.report();
    const round = <T extends { usd: number }>(w: T): T => ({ ...w, usd: Number(w.usd.toFixed(6)) });
    const agents = Object.fromEntries(
      Object.entries(report.agents).map(([id, a]) => [
        id,
        Object.fromEntries(
          (['day', 'month'] as const).map((k) => [k, { ...round(a[k]), byModel: Object.fromEntries(Object.entries(a[k].byModel).map(([m, c]) => [m, round(c)])) }]),
        ),
      ]),
    );
    const total = (k: 'day' | 'month') => Number(Object.values(report.agents).reduce((n, a) => n + a[k].usd, 0).toFixed(6));
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'SPEND_READ', actor });
    json(res, 200, { currency: 'USD', day: report.day, month: report.month, totalUsd: { day: total('day'), month: total('month') }, agents });
    return;
  }

  if (path === '/api/v1/triage' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'triage.read'))) return;
    const incidents = incidentsFromRuns(state.runs.list({}));
    json(res, 200, incidents);
    return;
  }

  if (path === '/api/v1/hooks/github' && req.method === 'POST') {
    const raw = await readBody(req);
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'invalid_json' });
      return;
    }
    const event = req.headers['x-github-event'];
    if (event === 'release' && body.action === 'published') {
      const repoUrl = body.repository?.html_url || body.repository?.clone_url || body.repository?.full_name;
      const release = body.release;
      if (repoUrl && release?.tag_name) {
        const matched = [...state.agents.values()].find((a) => {
          if (!a.repo) return false;
          const aRepo = extractGitHubRepo(a.repo);
          const bRepo = extractGitHubRepo(repoUrl);
          return aRepo && bRepo && aRepo.owner.toLowerCase() === bRepo.owner.toLowerCase() && aRepo.repo.toLowerCase() === bRepo.repo.toLowerCase();
        });
        if (matched) {
          const sem = parseSemVer(release.tag_name);
          const offeredVersion = sem ? `${sem.major}.${sem.minor}.${sem.patch}` : release.tag_name.replace(/^v/, '');
          matched.offeredVersion = offeredVersion;
          matched.offeredCommit = release.target_commitish;
          matched.releaseNotes = release.body ?? '';
          matched.publishedAt = release.published_at ?? new Date().toISOString();
          matched.updateAvailable = isNewerVersion(offeredVersion, matched.installedVersion ?? '0.1.0');
          matched.lastCheckedAt = new Date().toISOString();
          registryOf(state).save(matched);
          state.ledger.append({
            timestamp: new Date().toISOString(),
            agentId: matched.id,
            type: 'action',
            action: 'AGENT_UPDATE_OFFERED',
            actor: 'github:release',
            payloadSha256: createHash('sha256').update(offeredVersion).digest('hex'),
          });
          json(res, 200, { ok: true, agentId: matched.id, offeredVersion, updateAvailable: matched.updateAvailable });
          return;
        }
      }
    }
    json(res, 200, { ok: true, ignored: true });
    return;
  }

  // Webhooks authenticate with the cartridge's own shared secret, not a factory bearer.
  const hookMatch = path.match(/^\/api\/v1\/hooks\/([^/]+)$/);
  if (hookMatch && req.method === 'POST') {
    const agent = state.agents.get(hookMatch[1]);
    const trigger = agent?.triggers.find((t) => t.type === 'webhook');
    if (!agent || !trigger || trigger.type !== 'webhook') {
      


  json(res, 404, { error: 'not_found' });
      return;
    }
    let actor: string;
    if (trigger.secretRef) {
      const bound = await bindSecrets([trigger.secretRef], state.providers);
      const provided = (req.headers['x-factory-secret'] as string | undefined) ?? '';
      if (!bound.ok || !provided || !safeEqual(provided, bound.env[trigger.secretRef] ?? '')) {
        json(res, 401, { error: 'bad_webhook_secret' });
        return;
      }
      actor = `webhook:${agent.id}`;
    } else {
      const principal = await requirePrivilege(req, res, state, 'hooks.invoke');
      if (!principal) return;
      actor = principal.actor;
    }
    const raw = await readBody(req);
    let input: unknown;
    try {
      input = raw.trim() ? JSON.parse(raw) : undefined;
    } catch {
      input = raw;
    }
    const out = await createRun(state, agent.id, { actor, trigger: 'webhook', input });
    json(res, out.status, out.body);
    return;
  }

  // Agent-facing: authenticated by the run token minted at start.
  const runSelf = path.match(/^\/api\/v1\/runs\/([^/]+)\/(input|result|heartbeat|mailbox|training|reply)$/);
  if (runSelf && (((runSelf[2] === 'input' || runSelf[2] === 'mailbox') && req.method === 'GET') || (runSelf[2] !== 'input' && runSelf[2] !== 'mailbox' && req.method === 'POST'))) {
    const run = await authenticateRun(req, res, state, runSelf[1]);
    if (!run) return;
    if (runSelf[2] === 'heartbeat') {
      const hb = await readJson(req);
      const rssMb = typeof hb.rssMb === 'number' && Number.isFinite(hb.rssMb) ? hb.rssMb : undefined;
      state.runs.update(run.runId, { lastHeartbeatAt: new Date().toISOString(), ...(rssMb !== undefined ? { rssMb } : {}) });
      if (state.maxRssMb && rssMb !== undefined && rssMb > state.maxRssMb) await haltUnhealthy(state, run.runId, 'MEMORY_CEILING');
      void markRunReady(state, run.runId);
      json(res, 200, { ok: true, state: state.runs.get(run.runId)?.state });
      return;
    }
    if (runSelf[2] === 'input') {
      void markRunReady(state, run.runId);
      const now = new Date();
      json(res, 200, {
        runId: run.runId,
        input: run.input ?? null,
        temporal: {
          local: now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'full', timeStyle: 'long' }),
          utc: now.toISOString(),
          dayOfWeek: now.toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }),
          timezone: 'America/Los_Angeles',
        },
      });
      return;
    }
    if (runSelf[2] === 'reply') {
      // AM2: a run answers a console turn. The reply goes only to the person who asked, and it carries the AP3 footnote.
      const body = (await readJson(req)) as { turnId?: unknown; content?: unknown };
      const turn = typeof body.turnId === 'string' ? state.consoleTurns?.get(body.turnId) : undefined;
      if (!turn || turn.agentId !== run.agentId || Date.now() - turn.at > CONSOLE_TURN_TTL_MS) {
        json(res, 404, { error: 'unknown_turn' });
        return;
      }
      if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > CONSOLE_REPLY_MAX) {
        json(res, 400, { error: `content must be a non-empty string of at most ${CONSOLE_REPLY_MAX} characters` });
        return;
      }
      // One answer per turn: a run cannot flood the person (or push out other people's replies).
      state.consoleTurns!.delete(body.turnId as string);
      const runRows = state.ledger.query({ agent: run.agentId }).filter((r) => r.runId === run.runId);
      // AP1: the same provenance check as a result: a reply may not claim actions the run never took.
      const { sanitized, unverifiedClaims } = sanitizeOutputWithProvenance(redactSecrets(body.content, state.secretValues), runRows);
      if (unverifiedClaims.length > 0) {
        state.ledger.append({ timestamp: new Date().toISOString(), agentId: run.agentId, runId: run.runId, type: 'action', action: 'UNVERIFIED_ACTION_CLAIM', actor: SYSTEM.policy, claims: unverifiedClaims });
      }
      const content = typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
      const footnote = resultFootnote(content, runRows);
      const reply: ConsoleReply = { seq: nextReplySeq(), agentId: run.agentId, actor: turn.actor, turnId: body.turnId as string, runId: run.runId, content, ...(footnote ? { footnote } : {}), at: new Date().toISOString() };
      if (!state.consoleReplies) state.consoleReplies = [];
      state.consoleReplies.push(reply);
      const theirs = state.consoleReplies.filter((r) => r.actor === reply.actor);
      if (theirs.length > CONSOLE_REPLIES_PER_PERSON) {
        const drop = new Set(theirs.slice(0, theirs.length - CONSOLE_REPLIES_PER_PERSON));
        state.consoleReplies = state.consoleReplies.filter((r) => !drop.has(r));
      }
      if (state.consoleReplies.length > CONSOLE_REPLIES_KEPT) state.consoleReplies.splice(0, state.consoleReplies.length - CONSOLE_REPLIES_KEPT);
      state.ledger.append({
        timestamp: reply.at,
        agentId: run.agentId,
        runId: run.runId,
        type: 'action',
        action: 'CONVERSATION_REPLY',
        actor: `run:${run.agentId}:${run.runId}`,
        turnId: reply.turnId,
        replySha256: createHash('sha256').update(content.trim()).digest('hex'),
        ...(footnote ? { footnote } : {}),
      });
      json(res, 200, { ok: true, delivered: 'console' });
      return;
    }
    if (runSelf[2] === 'training') {
      const body = (await readJson(req)) as { op?: unknown; skillId?: unknown; capUsd?: number; cases?: unknown; model?: unknown; costUsd?: unknown; outputs?: unknown };
      const caller = run.caller;
      if (!caller) {
        json(res, 403, { error: 'training_caller_required' });
        return;
      }
      const result = await applyTrainingForCaller(state, { actor: caller.actor, roles: [...caller.roles] }, body);
      json(res, result.status, result.body);
      return;
    }
    if (runSelf[2] === 'mailbox') {
      void markRunReady(state, run.runId);
      // Polling is not activity: refreshing the timeout here let a looping agent keep itself alive forever.
      // Only a delivered conversation turn extends the idle window (see the conversation handler).
      if (!state.mailboxes) state.mailboxes = new Map();
      let queue = state.mailboxes.get(run.agentId);
      if (!queue) {
        queue = { messages: [], waiters: [] };
        state.mailboxes.set(run.agentId, queue);
      }
      if (queue.messages.length > 0) {
        const nextMsg = queue.messages.shift();
        json(res, 200, { ok: true, message: nextMsg });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://factory.local');
      const timeout = Math.min(Math.max(parseInt(url.searchParams.get('timeout') || '15000', 10), 0), 30000);
      if (timeout === 0) {
        json(res, 200, { ok: true, message: null });
        return;
      }
      let resolved = false;
      const waiter = (msg: MailboxMessage) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        json(res, 200, { ok: true, message: msg });
      };
      const timer = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        const idx = queue!.waiters.indexOf(waiter);
        if (idx !== -1) queue!.waiters.splice(idx, 1);
        json(res, 200, { ok: true, message: null });
      }, timeout);
      queue.waiters.push(waiter);
      req.on('close', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          const idx = queue!.waiters.indexOf(waiter);
          if (idx !== -1) queue!.waiters.splice(idx, 1);
        }
      });
      return;
    }
    const body = await readJson(req);
    if (body.status !== 'succeeded' && body.status !== 'failed') {
      json(res, 400, { error: 'status must be succeeded or failed' });
      return;
    }
    let output = body.output === undefined ? undefined : JSON.parse(redactSecrets(JSON.stringify(body.output), state.secretValues));
    if (output !== undefined) {
      const runRows = state.ledger.query({ agent: run.agentId });
      const currentRunRows = runRows.filter((r) => r.runId === run.runId);
      const { sanitized, unverifiedClaims } = sanitizeOutputWithProvenance(output, currentRunRows);
      if (unverifiedClaims.length > 0) {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: run.agentId,
          runId: run.runId,
          type: 'action',
          action: 'UNVERIFIED_ACTION_CLAIM',
          actor: SYSTEM.policy,
          claims: unverifiedClaims,
        });
      }
      output = sanitized;
      // AP3.4: a text result built from an answer given without tools, or from no model answer this run, is footnoted.
      if (body.status === 'succeeded' && typeof output === 'string' && output.trim()) {
        const footnote = resultFootnote(output, currentRunRows);
        if (footnote) {
          output = `${output}\n\n${footnote}`;
          state.ledger.append({ timestamp: new Date().toISOString(), agentId: run.agentId, runId: run.runId, type: 'action', action: 'REPLY_FOOTNOTED', actor: SYSTEM.policy, footnote });
        }
      }
    }
    const done = await finishRun(state, run.runId, body.status === 'succeeded' ? 'DONE' : 'FAILED', {
      actor: `run:${run.agentId}`,
      result: output,
      ...(typeof body.error === 'string' ? { error: redactSecrets(body.error, state.secretValues) } : {}),
    });
    json(res, 200, done);
    return;
  }

  if (path === '/api/v1/agents' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'agents.read'))) return;
    json(res, 200, [...state.agents.values()].map((a) => enrichAgent(state, a)));
    return;
  }

  const runCreate = path.match(/^\/api\/v1\/agents\/([^/]+)\/(runs|wake)$/);
  if (runCreate && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'agents.wake', { agentId: runCreate[1] });
    if (!principal) return;
    const body = await readJson(req);
    if (body.callbackUrl !== undefined && typeof body.callbackUrl !== 'string') {
      json(res, 400, { error: 'callbackUrl must be a string' });
      return;
    }
    if (body.model !== undefined && (typeof body.model !== 'string' || !/^[\w.:@/-]{1,128}$/.test(body.model))) {
      json(res, 400, { error: 'model must be a model id' });
      return;
    }
    // Only a caller allowed to say who asked (the ingress) may name the requester. `input.authorId` is whatever the
    // caller wrote and is never an identity.
    const isIngress = authorize({ principal, privilege: 'runs.attest-requester' }).allowed;
    let requestedBy: { provider: string; id: string } | undefined;
    let caller: AuthenticatedCaller | undefined;
    if (body.requestedBy !== undefined) {
      const attest = authorize({ principal, privilege: 'runs.attest-requester' });
      if (!attest.allowed) {
        json(res, 403, { error: 'forbidden', required: attest.required });
        return;
      }
      const rb = body.requestedBy as Record<string, unknown> | null;
      const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
      if (!rb || typeof rb !== 'object' || Array.isArray(rb) || !text(rb.provider) || !text(rb.id)) {
        json(res, 400, { error: 'requestedBy must be { provider, id }, each a string of at most 128 characters' });
        return;
      }
      requestedBy = { provider: rb.provider, id: rb.id };
    }

    if (isIngress && !requestedBy) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: runCreate[1],
        type: 'action',
        action: 'WAKE_REFUSED_UNAUTHORIZED_CALLER',
        actor: principal.actor,
      });
      json(res, 403, {
        error: 'unauthorized_caller',
        reason: 'missing requestedBy for external ingress caller',
        required: 'operator',
      });
      return;
    }

    if (requestedBy) {
      const adminEmails = (process.env.FACTORY_ADMIN_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const link = state.identityLinks?.resolveLink(requestedBy.provider, requestedBy.id);
      const ingressAuth = authorizeIngress({
        requestedBy,
        agentId: runCreate[1],
        privilege: 'agents.wake',
        owners: ownersOf(state, runCreate[1]),
        link,
        adminEmails,
        isIngressCaller: isIngress,
      });

      if (!ingressAuth.allowed) {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: runCreate[1],
          type: 'action',
          action: 'WAKE_REFUSED_UNAUTHORIZED_CALLER',
          actor: principal.actor,
          payloadSha256: payloadHash(requestedBy),
        });
        json(res, 403, {
          error: ingressAuth.error,
          reason: ingressAuth.reason,
          required: ingressAuth.required,
        });
        return;
      }
      caller = ingressAuth.caller;
    }
    // AM2: the turn id and reply address are the factory's. A message from an ingress that wakes the agent is a turn like
    // any other (the first of a Discord session arrives here); an operator's run is a job and gets neither.
    let input = body.input;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const copy = { ...(input as Record<string, unknown>) };
      delete copy.turnId;
      delete copy.replyTo;
      const replyTo = isIngress ? replyAddress(true, caller, copy) : undefined;
      if (replyTo) Object.assign(copy, { turnId: randomUUID(), replyTo });
      input = copy;
    }
    const out = await createRun(state, runCreate[1], {
      actor: principal.actor,
      trigger: runCreate[2] === 'wake' ? 'manual' : 'api',
      input,
      callbackUrl: body.callbackUrl as string | undefined,
      model: body.model as string | undefined,
      ...(requestedBy ? { requestedBy } : {}),
      ...(caller ? { caller } : {}),
    });
    json(res, out.status, out.body);
    return;
  }

  const killMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/(pause|resume|isolate)$/);
  if (killMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, killMatch[2] === 'pause' ? 'agents.pause' : killMatch[2] === 'resume' ? 'agents.resume' : 'agents.isolate', { agentId: killMatch[1] });
    if (!principal) return;
    const out = await applyKillSwitch(state, killMatch[1], killMatch[2].toUpperCase() as 'PAUSE' | 'RESUME' | 'ISOLATE', principal.actor);
    json(res, out.status, out.body);
    return;
  }

  const updateCheckMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/updates\/check$/);
  if (updateCheckMatch && req.method === 'POST') {
    const agentId = updateCheckMatch[1];
    const principal = await requirePrivilege(req, res, state, 'agents.update.read', { agentId });
    if (!principal) return;
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const update = await checkAgentUpdate(agent, process.env.FACTORY_AGENT_SOURCE_TOKEN);
    Object.assign(agent, update);
    registryOf(state).save(agent);
    json(res, 200, update);
    return;
  }

  const updateInstallMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/updates\/install$/);
  if (updateInstallMatch && req.method === 'POST') {
    const agentId = updateInstallMatch[1];
    const principal = await requirePrivilege(req, res, state, 'agents.update.install', { agentId });
    if (!principal) return;
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const body = await readJson(req);
    const mode = (body.mode === 'restart_now' ? 'restart_now' : 'drain') as 'drain' | 'restart_now';
    const targetCommit = (body.commit as string | undefined) ?? agent.offeredCommit ?? agent.commit;
    const targetVersion = (body.version as string | undefined) ?? agent.offeredVersion;
    if (!targetCommit) {
      json(res, 400, { error: 'no_commit_available', message: 'No target commit available to install' });
      return;
    }
    if (agent.state === 'WORKING' && mode === 'drain') {
      agent.stagedCommit = targetCommit;
      agent.stagedVersion = targetVersion;
      agent.pendingDrain = true;
      registryOf(state).save(agent);
      json(res, 200, { ok: true, status: 'staged_drain', agentId, commit: targetCommit, version: targetVersion });
      return;
    }
    agent.commit = targetCommit;
    agent.deployedCommit = targetCommit;
    if (targetVersion) agent.installedVersion = targetVersion;
    agent.updateAvailable = false;
    delete agent.pendingDrain;
    delete agent.stagedCommit;
    delete agent.stagedVersion;
    registryOf(state).save(agent);
    json(res, 200, { ok: true, status: 'applied', agentId, commit: targetCommit, version: targetVersion });
    return;
  }

  if (path === '/api/v1/runs' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'runs.read'))) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const runs = state.runs.list({ agentId: url.searchParams.get('agent'), active: url.searchParams.get('active') === 'true' });
    const limit = url.searchParams.has('limit') ? Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit')!, 10) || 50)) : undefined;
    const offset = url.searchParams.has('offset') ? Math.max(0, parseInt(url.searchParams.get('offset')!, 10) || 0) : 0;
    const paged = limit !== undefined ? runs.slice(offset, offset + limit) : runs;
    json(res, 200, paged);
    return;
  }

  const runGet = path.match(/^\/api\/v1\/runs\/([^/]+)$/);
  if (runGet && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'runs.read'))) return;
    const run = state.runs.get(runGet[1]);
    json(res, run ? 200 : 404, run ?? { error: 'not_found' });
    return;
  }

  const resetMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/reset$/);
  if (resetMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'agents.reset');
    if (!principal) return;
    const out = await resetAgent(state, resetMatch[1], principal.actor);
    json(res, out.status, out.body);
    return;
  }

  const runCancel = path.match(/^\/api\/v1\/runs\/([^/]+)\/cancel$/);
  if (runCancel && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'runs.cancel');
    if (!principal) return;
    const run = state.runs.get(runCancel[1]);
    if (!run) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, await finishRun(state, run.runId, 'CANCELLED', { actor: principal.actor }));
    return;
  }

  const convoMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/conversation$/);
  if (convoMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'agents.converse');
    if (!principal) return;
    const agent = state.agents.get(convoMatch[1]);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const refused = handoffRefusal(state, agent);
    if (refused) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        runId: activeRun(state, agent.id)?.runId,
        type: 'action',
        action: 'CONVERSATION_REFUSED_BUDGET_EXCEEDED',
        actor: SYSTEM.policy,
      });
      json(res, 402, { error: 'budget_exceeded', window: refused });
      return;
    }
    const rawBody = (await readJson(req)) as Record<string, unknown>;
    const isIngress = authorize({ principal, privilege: 'runs.attest-requester' }).allowed;
    let requestedBy: { provider: string; id: string } | undefined;
    if (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)) {
      if (rawBody.requestedBy !== undefined) {
        const attest = authorize({ principal, privilege: 'runs.attest-requester' });
        if (!attest.allowed) {
          json(res, 403, { error: 'forbidden', required: attest.required });
          return;
        }
        const rb = rawBody.requestedBy as Record<string, unknown> | null;
        const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
        if (!rb || typeof rb !== 'object' || Array.isArray(rb) || !text(rb.provider) || !text(rb.id)) {
          json(res, 400, { error: 'requestedBy must be { provider, id }, each a string of at most 128 characters' });
          return;
        }
        requestedBy = { provider: rb.provider, id: rb.id };
      }
    }

    if (isIngress && !requestedBy) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        runId: activeRun(state, agent.id)?.runId,
        type: 'action',
        action: 'CONVERSATION_REFUSED_UNAUTHORIZED_CALLER',
        actor: principal.actor,
      });
      json(res, 403, {
        error: 'unauthorized_caller',
        reason: 'missing requestedBy for external ingress caller',
        required: 'operator',
      });
      return;
    }

    let caller: AuthenticatedCaller | undefined;
    if (requestedBy) {
      const adminEmails = (process.env.FACTORY_ADMIN_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
      const link = state.identityLinks?.resolveLink(requestedBy.provider, requestedBy.id);
      const ingressAuth = authorizeIngress({
        requestedBy,
        agentId: agent.id,
        privilege: 'agents.converse',
        owners: ownersOf(state, agent.id),
        link,
        adminEmails,
        isIngressCaller: isIngress,
      });
      if (!ingressAuth.allowed) {
        state.ledger.append({
          timestamp: new Date().toISOString(),
          agentId: agent.id,
          runId: activeRun(state, agent.id)?.runId,
          type: 'action',
          action: 'CONVERSATION_REFUSED_UNAUTHORIZED_CALLER',
          actor: principal.actor,
          payloadSha256: payloadHash(requestedBy),
        });
        json(res, 403, {
          error: ingressAuth.error,
          reason: ingressAuth.reason,
          required: ingressAuth.required,
        });
        return;
      }
      caller = ingressAuth.caller;
    }
    // AM2: every delivered turn says who is speaking. A person conversing directly (the console) speaks as themselves.
    if (!caller && !isIngress) caller = directCaller(principal, ownersOf(state, agent.id), 'agents.converse');
    const turnId = randomUUID();

    // Input hygiene: unwrap body.input if sent as { input, requestedBy }, strip unverified caller
    let payload = (rawBody && typeof rawBody === 'object' && 'input' in rawBody && rawBody.input !== undefined) ? rawBody.input : rawBody;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const copy = { ...(payload as Record<string, unknown>) };
      delete copy.caller;
      // AM2: the turn id and reply address are the factory's to set, never the sender's.
      delete copy.turnId;
      delete copy.replyTo;
      if (caller) {
        copy.caller = { ...caller };
      }
      copy.turnId = turnId;
      const replyTo = replyAddress(isIngress, caller, copy);
      if (replyTo) copy.replyTo = replyTo;
      payload = copy;
    } else if (payload === undefined) {
      payload = { ...(caller ? { caller: { ...caller } } : {}), turnId, ...(isIngress ? {} : { replyTo: { channel: 'console' } }) };
    }
    const shaped = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as { turnId?: string; replyTo?: { channel?: string } }) : undefined;
    const replyTo = shaped?.replyTo;
    const answerable = shaped?.turnId === turnId ? { turnId } : {};
    if (replyTo?.channel === 'console' && caller) rememberConsoleTurn(state, turnId, agent.id, caller.actor);

    const handed = await handOff(state, agent, principal.actor, payload, { requestedBy, caller });
    json(res, handed.status, handed.status >= 300 ? handed.body : { ...handed.body, ...answerable });
    return;
  }

  // AM5: the console asks the agent, through the factory, for a person's conversations or a conversation's last turns.
  // The factory never opens a notebook: it relays the request as a turn and the agent answers it (`/runs/:id/reply`).
  // Reading someone else's conversations needs `conversations.read-others` and is ledgered.
  const convReq = path.match(/^\/api\/v1\/agents\/([^/]+)\/conversation-requests$/);
  if (convReq && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'agents.converse', { agentId: convReq[1] });
    if (!principal) return;
    const body = (await readJson(req)) as { op?: unknown; conversation?: unknown; limit?: unknown; subject?: unknown };
    const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
    if (body.op !== 'list' && body.op !== 'turns') {
      json(res, 400, { error: "op must be 'list' or 'turns'" });
      return;
    }
    if (body.conversation !== undefined && !text(body.conversation, 128)) {
      json(res, 400, { error: 'conversation must be a name or id of at most 128 characters' });
      return;
    }
    if (body.limit !== undefined && !(Number.isInteger(body.limit) && (body.limit as number) >= 1 && (body.limit as number) <= 20)) {
      json(res, 400, { error: 'limit must be a whole number from 1 to 20' });
      return;
    }
    // The subject must be an actor the ledger can record in clear, or the admin read would go unrecorded.
    if (body.subject !== undefined && !(typeof body.subject === 'string' && /^[A-Za-z0-9:._@+-]{1,256}$/.test(body.subject))) {
      json(res, 400, { error: 'subject must be an actor' });
      return;
    }
    const refuse = (status: number, action: string, out: Record<string, unknown>) => {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: convReq[1], type: 'action', action, actor: principal.actor });
      json(res, status, out);
    };
    // A conversation request is a person's; the ingress service speaks for others and may not make one.
    if (authorize({ principal, privilege: 'runs.attest-requester' }).allowed) {
      refuse(403, 'CONVERSATION_REQUEST_REFUSED', { error: 'forbidden', reason: 'a conversation request is made by a person, not the ingress' });
      return;
    }
    const subject = typeof body.subject === 'string' ? body.subject : undefined;
    const othersRead = subject !== undefined && subject !== principal.actor;
    if (othersRead && !authorize({ principal, privilege: 'conversations.read-others' }).allowed) {
      refuse(403, 'CONVERSATION_REQUEST_REFUSED', { error: 'forbidden', required: 'admin' });
      return;
    }
    const agent = state.agents.get(convReq[1]);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const refused = handoffRefusal(state, agent);
    if (refused) {
      refuse(402, 'CONVERSATION_REFUSED_BUDGET_EXCEEDED', { error: 'budget_exceeded', window: refused });
      return;
    }
    const turnId = randomUUID();
    const caller = directCaller(principal, ownersOf(state, agent.id), 'agents.converse');
    const request = { op: body.op, ...(body.conversation ? { conversation: body.conversation } : {}), ...(body.limit ? { limit: body.limit } : {}), ...(othersRead ? { subject } : {}) };
    const payload = { kind: 'conversation-request', request, caller, turnId, replyTo: { channel: 'console' } };
    rememberConsoleTurn(state, turnId, agent.id, principal.actor);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      runId: activeRun(state, agent.id)?.runId,
      type: 'action',
      // AM5: an admin reading another person's conversation is always on the record.
      action: othersRead ? 'CONVERSATION_READ_BY_ADMIN' : 'CONVERSATION_REQUESTED',
      actor: principal.actor,
      turnId,
      ...(othersRead ? { subject } : {}),
      content: request,
    });
    const handed = await handOff(state, agent, principal.actor, payload, { caller });
    json(res, handed.status, handed.status >= 300 ? handed.body : { ...handed.body, turnId });
    return;
  }

  // AM2: the replies to this person's console turns with this agent, after `after` (a sequence number). Only the person
  // who asked can read them; an admin reading someone else's conversation goes through the agent (AM5), not here.
  const repliesMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/replies$/);
  if (repliesMatch && req.method === 'GET') {
    const principal = await requirePrivilege(req, res, state, 'agents.converse');
    if (!principal) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const after = Number(url.searchParams.get('after') ?? 0) || 0;
    const replies = (state.consoleReplies ?? [])
      .filter((r) => r.agentId === repliesMatch[1] && r.actor === principal.actor && r.seq > after)
      .map(({ seq, turnId, runId, content, footnote, at }) => ({ seq, turnId, runId, content, ...(footnote ? { footnote } : {}), at }));
    json(res, 200, { replies });
    return;
  }

  if (path === '/api/v1/ledger/verify' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'ledger.read'))) return;
    const anchors = state.ledgerSink ? await state.ledgerSink.list() : [];
    const result = state.ledger.verify(anchors);
    json(res, result.ok ? 200 : 409, { ...result, worm: Boolean(state.ledgerSink) });
    return;
  }

  if (path === '/api/v1/ledger' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'ledger.read'))) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const rows = state.ledger.query({
      agent: url.searchParams.get('agent') || url.searchParams.get('agentId') || undefined,
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    const limit = url.searchParams.has('limit') ? Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit')!, 10) || 50)) : undefined;
    const offset = url.searchParams.has('offset') ? Math.max(0, parseInt(url.searchParams.get('offset')!, 10) || 0) : 0;
    const paged = limit !== undefined ? rows.slice(offset, offset + limit) : rows;
    json(res, 200, paged);
    return;
  }

  if (path === '/api/v1/ledger' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'ledger.ingest');
    if (!principal) return;
    const event = (await readJson(req)) as { agentId?: string; type?: string; [k: string]: unknown };
    if (!event.agentId || !event.type) {
      json(res, 400, { error: 'agentId and type required' });
      return;
    }
    if (!INGEST_TYPES.has(event.type)) {
      json(res, 400, { error: `type must be one of ${[...INGEST_TYPES].join(', ')}` });
      return;
    }
    // The gatekeeper-egress verified the run token, so it may attest the run as the actor. Other writers may not.
    const isGatekeeperEgress = authorize({ principal, privilege: 'ledger.attest-run-actor' }).allowed;
    const run = typeof event.runId === 'string' ? state.runs.get(event.runId) : undefined;
    if (isGatekeeperEgress && event.runId !== undefined && (!run || run.agentId !== event.agentId)) {
      json(res, 400, { error: 'runId does not belong to agentId' });
      return;
    }
    const actor = isGatekeeperEgress && run && event.actor === `run:${run.agentId}` ? event.actor : principal.actor;
    const stored = state.ledger.append({
      ...event,
      ...(isGatekeeperEgress ? {} : { costUsd: undefined }),
      agentId: event.agentId,
      type: event.type,
      actor,
      timestamp: new Date().toISOString(),
    });
    if (isGatekeeperEgress && stored.type === 'llm' && typeof stored.costUsd === 'number') {
      const agent = state.agents.get(stored.agentId);
      const isBuiltin = Boolean(agent?.isBuiltin || agent?.category === 'builtin' || BUILTIN_AGENT_IDS.has(stored.agentId));
      const policy = state.policies.get(stored.agentId);
      // `before` must be read before the spend is added, or a crossing is never detected.
      const beforeStanding = checkStanding({ limits: policy?.budgetUsd, spend: state.spend.get(stored.agentId, stored.runId) });
      const before = beforeStanding.inGoodStanding ? undefined : beforeStanding.window;
      state.spend.add(stored.agentId, stored.runId, stored.costUsd, stored.timestamp, spendDetail(stored));
      if (!isBuiltin) {
        const afterStanding = checkStanding({ limits: policy?.budgetUsd, spend: state.spend.get(stored.agentId, stored.runId) });
        const after = afterStanding.inGoodStanding ? undefined : afterStanding.window;
        // Alert once per crossing, even if the run already finished; block only a run that is still live.
        if (after && after !== before) {
          const alert = state.ledger.append({
            timestamp: new Date().toISOString(),
            agentId: stored.agentId,
            runId: stored.runId,
            type: 'budget.alert',
            action: `BUDGET_${after.toUpperCase()}_EXCEEDED`,
            actor: SYSTEM.policy,
          });
          await routeEvents(state, alert);
        }
        const live = run ? state.runs.get(run.runId) : undefined;
        if (after && live && !isTerminal(live.state) && live.state !== 'BLOCKED_BUDGET_EXCEEDED') {
          blockRun(state, live.runId, 'BLOCKED_BUDGET_EXCEEDED', SYSTEM.policy);
        }
      }
    }
    await routeEvents(state, stored);
    json(res, 201, { ok: true });
    return;
  }

  // §6.9 M3: the models this factory offers, for the admin choosing an agent's models.
  if (path === '/api/v1/models' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'models.read'))) return;
    json(res, 200, {
      models: state.modelStore
        ? state.modelStore.listOffered().map((m) => ({ name: m.name, provider: m.provider, id: m.id, vendorId: m.vendorId, ...(m.price ? { price: m.price } : {}) }))
        : Object.entries(state.modelCatalog ?? {}).map(([name, m]) => ({ name, provider: m.provider, ...(m.price ? { price: m.price } : {}) })),
      staged: state.modelStore?.listStaged() ?? [],
      // M2: what an agent gets when its policy names no models.
      default: defaultModelOf(state) ?? null,
      templates: AI_PROVIDER_TEMPLATES,
    });
    return;
  }

  // Internal catalog endpoint with ETag for gatekeeper-egress sync (§6.9 M3, GAP-162, GAP-163)
  if (path === '/api/v1/models/internal/catalog' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'egress.models.read'))) return;
    const version = state.modelStore?.getVersion() ?? 1;
    res.setHeader('ETag', `"${version}"`);
    json(res, 200, {
      version,
      models: state.modelStore ? state.modelStore.toEgressCatalog() : (state.modelCatalog ?? {}),
      default: defaultModelOf(state) ?? null,
    });
    return;
  }

  // On-demand vendor model discovery (Executive §6.9 M1–M4, GAP-162, GAP-163)
  if (path === '/api/v1/models/scan' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'models.manage');
    if (!principal) return;
    const body = (await readJson(req)) as { vendorId?: string };
    const vendorId = body.vendorId;
    if (!vendorId) {
      json(res, 400, { error: 'invalid_request', message: 'vendorId is required' });
      return;
    }

    const target = vendorTarget(state, vendorId);
    if ('error' in target) {
      json(res, 400, target);
      return;
    }

    try {
      const discovered = await discoverViaEgress(state, target);
      const staged = stageDiscovered(state, vendorId, discovered, principal.actor);
      json(res, 200, { ok: true, count: staged.length, staged });
      return;
    } catch (err: any) {
      const status = err?.status === 503 ? 503 : 502;
      const error = err?.message === 'credential_unbound' ? 'credential_unbound' : status === 503 ? 'discovery_unavailable' : 'discovery_failed';
      json(res, status, { error, message: `Model discovery failed for vendor ${vendorId}` });
      return;
    }
  }

  // Model admission with token pricing (Accountant §6.4, GAP-162, GAP-163)
  if (path === '/api/v1/models/admit' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'models.manage');
    if (!principal) return;
    const out = admitModel(state, (await readJson(req)) as AdmitInput, principal.actor);
    if (!out.ok) {
      json(res, out.status, { error: out.error, ...(out.message ? { message: out.message } : {}) });
      return;
    }
    json(res, 201, { ok: true, model: out.model });
    return;
  }

  // Dynamic token pricing update (Accountant §6.4, GAP-162)
  const pricingMatch = path.match(/^\/api\/v1\/models\/([^/]+)\/pricing$/);
  if (pricingMatch && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'models.manage');
    if (!principal) return;
    const modelName = pricingMatch[1];
    const body = (await readJson(req)) as { price?: { inputPerMTok: number; outputPerMTok: number } };
    if (!body.price || typeof body.price.inputPerMTok !== 'number' || typeof body.price.outputPerMTok !== 'number') {
      json(res, 400, { error: 'invalid_request', message: 'price with numeric inputPerMTok and outputPerMTok required' });
      return;
    }
    if (!state.modelStore) {
      json(res, 500, { error: 'model_store_not_configured' });
      return;
    }
    try {
      const model = state.modelStore.updatePricing(modelName, body.price, principal.actor);
      state.modelCatalog = state.modelStore.toEgressCatalog();
      state.ledger.append({
        action: 'MODEL_PRICING_UPDATED',
        actor: principal.actor,
        model: modelName,
        price: body.price,
        timestamp: new Date().toISOString(),
      });
      json(res, 200, { ok: true, model });
      return;
    } catch (err: any) {
      json(res, 404, { error: 'not_found', message: err.message });
      return;
    }
  }

  // Set factory default model (§6.9 M2, M3, GAP-168)
  if (path === '/api/v1/models/default' && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'models.manage');
    if (!principal) return;
    const body = (await readJson(req)) as { model?: string; name?: string };
    const modelName = body.model || body.name;
    if (!modelName || typeof modelName !== 'string') {
      json(res, 400, { error: 'invalid_request', message: 'model is required' });
      return;
    }
    if (!state.modelStore) {
      json(res, 500, { error: 'model_store_not_configured' });
      return;
    }
    try {
      state.modelStore.setDefault(modelName, principal.actor);
      state.defaultModel = modelName;
      state.ledger.append({
        action: 'MODEL_DEFAULT_UPDATED',
        actor: principal.actor,
        model: modelName,
        timestamp: new Date().toISOString(),
      });
      json(res, 200, { ok: true, default: modelName });
      return;
    } catch (err: any) {
      json(res, 400, { error: 'invalid_request', message: err.message });
      return;
    }
  }

  // Model retirement with policy fallback migration (§6.9 M2, GAP-162, GAP-163)
  const modelDeleteMatch = path.match(/^\/api\/v1\/models\/([^/]+)$/);
  if (modelDeleteMatch && req.method === 'DELETE') {
    const principal = await requirePrivilege(req, res, state, 'models.manage');
    if (!principal) return;
    const modelName = modelDeleteMatch[1];
    if (!state.modelStore) {
      json(res, 500, { error: 'model_store_not_configured' });
      return;
    }

    const out = await retireModel(state, modelName, principal.actor);
    if (!out.retired) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, { ok: true, retired: modelName, affectedAgents: out.affectedAgents });
    return;
  }

  const policyMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/policy$/);
  if (policyMatch && (req.method === 'GET' || req.method === 'PUT')) {
    const principal = await requirePrivilege(req, res, state, req.method === 'GET' ? 'policy.read' : 'policy.set');
    if (!principal) return;
    const agentId = policyMatch[1];
    const agent = state.agents.get(agentId);
    // GAP-060: a policy exists only for a known agent. `__global__` is not an agent: it is set through
    // PUT /api/v1/policies/budget, never here.
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
    if (req.method === 'GET') {
      const pol = state.policies.get(agentId);
      if (isBuiltin) {
        delete pol.budgetUsd;
      }
      json(res, 200, pol);
      return;
    }
    const checked = validatePolicy(await readJson(req));
    if (!checked.ok) {
      json(res, 400, { error: checked.error });
      return;
    }
    if (isBuiltin && checked.policy.budgetUsd !== undefined) {
      json(res, 400, {
        error: 'builtin_agents_exempt_from_budget',
        message: 'Built-in system agents are critical infrastructure and are exempt from spend limits. Budgets cannot be assigned.',
      });
      return;
    }
    state.policies.set(agentId, checked.policy);
    state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'POLICY_UPDATED', actor: principal.actor });
    await recordConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, 'policy updated') });
    unblockAffordableRuns(state, agentId, checked.policy?.budgetUsd, principal.actor);
    json(res, 200, checked.policy);
    return;
  }

  const gwRun = path.match(/^\/api\/v1\/gatekeeper-egress\/runs\/([^/]+)$/);
  if (gwRun && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'egress.run.read'))) return;
    const run = state.runs.get(gwRun[1]);
    const agent = run ? state.agents.get(run.agentId) : undefined;
    if (!run || !agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
    const pol = state.policies.get(run.agentId);
    json(res, 200, {
      run: { runId: run.runId, agentId: run.agentId, state: run.state, live: !isTerminal(run.state), ...(run.model ? { model: run.model } : {}) },
      agentState: agent.state,
      isBuiltin,
      // E7: a policy set for this agent implies the factory model API; the global fallback never does.
      policySet: state.policies.has(run.agentId),
      policy: isBuiltin ? { ...pol, budgetUsd: undefined } : pol,
      spend: state.spend.get(run.agentId, run.runId),
      // E12 item 4: what the run's requesting person may reach through skill routes; the egress applies it.
      // A built-in agent is the factory's own and has no person's roles.
      access: isBuiltin ? { restricted: false } : accessForRun(state, run, agent),
    });
    return;
  }

  if (path === '/api/v1/gatekeeper-egress/approvals' && req.method === 'POST') {
    if (!(await requirePrivilege(req, res, state, 'egress.approvals.request'))) return;
    const b = await readJson(req);
    const run = typeof b.runId === 'string' ? state.runs.get(b.runId) : undefined;
    if (!run || isTerminal(run.state) || typeof b.route !== 'string' || typeof b.tool !== 'string' || typeof b.argsSha256 !== 'string') {
      json(res, 400, { error: 'live runId, route, tool, argsSha256 required' });
      return;
    }
    const { approval, created } = state.approvals.request({
      runId: run.runId,
      agentId: run.agentId,
      route: b.route,
      tool: b.tool,
      argsSha256: b.argsSha256,
    });
    if (created) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: run.agentId,
        runId: run.runId,
        type: 'action',
        action: 'APPROVAL_REQUESTED',
        actor: `run:${run.agentId}`,
        approvalId: approval.approvalId,
        mcpName: approval.tool,
        route: approval.route,
      });
      blockRun(state, run.runId, 'BLOCKED_FOR_HUMAN', SYSTEM.policy);
    }
    json(res, created ? 201 : 200, approval);
    return;
  }

  if (path === '/api/v1/gatekeeper-egress/holds' && req.method === 'POST') {
    if (!(await requirePrivilege(req, res, state, 'egress.holds.create'))) return;
    const b = await readJson(req);
    const run = typeof b.runId === 'string' ? state.runs.get(b.runId) : undefined;
    const parsed = parseHoldRequest(b);
    if (!run || isTerminal(run.state) || !parsed) {
      json(res, 400, { error: 'live runId, route, argsSha256 and request {method, path, body, bodyEncoding} required' });
      return;
    }
    // S1 backstop: the copy is shown to people, so every known secret value is masked in it.
    const request = heldCopyOf(parsed, (v) => redactSecrets(v, state.secretValues));
    const { approval, created } = state.approvals.hold({
      runId: run.runId,
      agentId: run.agentId,
      route: parsed.route,
      tool: heldToolName(request),
      argsSha256: parsed.argsSha256,
      request,
    });
    if (created) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: run.agentId,
        runId: run.runId,
        type: 'action',
        action: 'REQUEST_HELD',
        actor: `run:${run.agentId}`,
        approvalId: approval.approvalId,
        route: approval.route,
        mcpName: approval.tool,
        payloadSha256: approval.argsSha256,
      });
    }
    json(res, created ? 201 : 200, { approvalId: approval.approvalId, state: approval.state, ...(approval.notes ? { notes: approval.notes } : {}) });
    return;
  }

  const gwConsume = path.match(/^\/api\/v1\/gatekeeper-egress\/approvals\/([^/]+)\/consume$/);
  if (gwConsume && req.method === 'POST') {
    if (!(await requirePrivilege(req, res, state, 'egress.approvals.consume'))) return;
    const consumed = state.approvals.consume(gwConsume[1]);
    json(res, consumed ? 200 : 409, consumed ?? { error: 'approval not approved or already used' });
    return;
  }

  const kmCheckout = path === '/api/v1/keymaster/checkout' || path === '/api/v1/gatekeeper-egress/keymaster/checkout';
  if (kmCheckout && req.method === 'POST') {
    const isGatekeeperEgressPath = path.startsWith('/api/v1/gatekeeper-egress/');
    let actor: string | undefined;
    if (isGatekeeperEgressPath) {
      const principal = await requirePrivilege(req, res, state, 'egress.keymaster.checkout');
      if (!principal) return;
      actor = principal.actor;
    }
    const b = (await readJson(req)) as Record<string, unknown>;
    const runId = typeof b.runId === 'string' ? b.runId : undefined;
    const approvalId = typeof b.approvalId === 'string' ? b.approvalId : undefined;
    const gatedSecret = typeof b.gatedSecret === 'string' ? b.gatedSecret : undefined;
    const turnId = typeof b.turnId === 'string' ? b.turnId : undefined;
    const proofHash = typeof b.proofHash === 'string' ? b.proofHash : undefined;

    if (!runId || !approvalId || !gatedSecret || !turnId) {
      json(res, 400, { error: 'runId, approvalId, gatedSecret, turnId required' });
      return;
    }

    if (!isGatekeeperEgressPath) {
      const run = await authenticateRun(req, res, state, runId);
      if (!run) return;
      actor = `run:${run.agentId}`;
    }

    const km = getKeymaster(state);
    const outcome = await km.checkout({
      runId,
      approvalId,
      gatedSecret,
      turnId,
      proofHash,
      actor,
    });
    json(res, outcome.status, outcome.ok ? outcome.lease : { error: outcome.error, details: outcome.details });
    return;
  }

  if (path === '/api/v1/approvals' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'approvals.read'))) return;
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const st = url.searchParams.get('state') as 'pending' | null;
    json(res, 200, state.approvals.list({ ...(st ? { state: st } : {}), ...(url.searchParams.get('runId') ? { runId: url.searchParams.get('runId')! } : {}) }));
    return;
  }

  const decideMatch = path.match(/^\/api\/v1\/approvals\/([^/]+)$/);
  if (decideMatch && req.method === 'POST') {
    // Who may decide depends on the approval, so authenticate here and let `decideApproval` authorize.
    const who = await identify(req, state);
    if (!who.ok) return json(res, 401, { error: 'unauthorized' });
    const b = await readJson(req);
    const out = await decideApproval(state, decideMatch[1], b.decision, who.principal, b.notes);
    json(res, out.status, out.body);
    return;
  }

  if (path === '/mcp' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'mcp.use');
    if (!principal) return;
    json(res, 200, await handleMcp(state, await readJson(req), principal));
    return;
  }

  // --- REGISTRY SERVICE ---
  if (path === '/api/v1/registry/agents' && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'registry.register');
    if (!principal) return;
    const body = await readJson(req);
    const cartridge = (body.cartridge && typeof body.cartridge === 'object' ? body.cartridge : body) as Record<string, unknown>;
    const agentId = typeof cartridge.id === 'string' ? cartridge.id : (typeof body.id === 'string' ? body.id : randomUUID());
    if (BUILTIN_AGENT_IDS.has(agentId)) {
      json(res, 409, { error: 'builtin_agent', message: `${agentId} is a built-in system agent and cannot be registered` });
      return;
    }

    // E12: the roles a cartridge declares must be well formed and name only skills it declares, or a typo would silently
    // allow a person nothing (or the wrong thing). Refused before anything is recorded.
    const roleProblems = cartridgeRoleProblems(cartridge as { roles?: unknown; skills?: unknown });
    if (roleProblems.length) {
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId,
        type: 'action',
        action: 'AGENT_REGISTRATION_REFUSED:roles',
        actor: principal.actor,
        payloadSha256: payloadHash(roleProblems),
      });
      json(res, 422, { error: 'invalid_roles', reasons: roleProblems });
      return;
    }

    // §6.8 L3: a registration names a repository and is pinned to one exact commit, never a branch.
    const rawRepo = body.repo ?? cartridge.repo;
    // AM1: a new agent version (one registered from a repository) declares its archetype; old names are aliases for now.
    const declaredArchetype = ((cartridge.memory ?? cartridge.persistence) as { archetype?: unknown } | undefined)?.archetype;
    const archetype = canonicalArchetype(declaredArchetype);
    if (rawRepo !== undefined && !archetype) {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId, type: 'action', action: 'AGENT_REGISTRATION_REFUSED:archetype', actor: principal.actor });
      json(res, 422, { error: 'archetype_required', message: 'memory.archetype is required: purpose-built, personal-assistant or team-member (AM1)' });
      return;
    }
    const archetypeWarning = typeof declaredArchetype === 'string' && LEGACY_ARCHETYPES[declaredArchetype]
      ? `memory.archetype "${declaredArchetype}" is deprecated; declare "${LEGACY_ARCHETYPES[declaredArchetype]}" (AM1)`
      : undefined;
    let source: SourceRef | undefined;
    if (rawRepo !== undefined) {
      const repo = checkRepoUrl(rawRepo);
      if (!repo) {
        json(res, 400, { error: 'invalid_repo', message: 'repo must be an https git URL without embedded credentials' });
        return;
      }
      let commit = body.commit ?? cartridge.commit;
      if (commit !== undefined && (typeof commit !== 'string' || !FULL_SHA.test(commit))) {
        json(res, 400, { error: 'invalid_commit', message: 'commit must be a full 40-character lowercase git SHA' });
        return;
      }
      if (commit === undefined) {
        try {
          commit = await (state.resolveCommit ?? gitLsRemoteResolver)(repo);
        } catch (err) {
          json(res, 422, {
            error: 'commit_unresolved',
            message: `could not resolve the default-branch HEAD of ${repo}; pass "commit" explicitly (${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'})`,
          });
          return;
        }
        if (typeof commit !== 'string' || !FULL_SHA.test(commit)) {
          json(res, 422, { error: 'commit_unresolved', message: `resolver returned no full SHA for ${repo}` });
          return;
        }
      }
      source = { repo, commit: commit as string };
    }

    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_REGISTERED',
      actor: principal.actor,
      ...(source ? { commit: source.commit } : {}),
    });
    
    // Only a first registration gets the global default; re-registering keeps the policy its owner set (GAP-048).
    const globalPolicy = state.policies.get('__global__');
    let stateResult: 'PENDING_BUDGET' | 'PENDING_DEPLOY' = 'PENDING_BUDGET';

    if (state.policies.has(agentId)) {
      if (state.policies.get(agentId).budgetUsd) stateResult = 'PENDING_DEPLOY';
    } else if (globalPolicy && globalPolicy.budgetUsd) {
      state.policies.set(agentId, globalPolicy);
      stateResult = 'PENDING_DEPLOY';
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId,
        type: 'action',
        action: 'BUDGET_APPROVED_BY_POLICY',
        actor: 'SYSTEM.policy'
      });
    }
    const artifact = typeof cartridge.compute === 'object' && cartridge.compute !== null
      ? ((cartridge.compute as { ref?: string }).ref ?? '')
      : (typeof cartridge.repo === 'string' ? cartridge.repo : (typeof body.repo === 'string' ? body.repo : ''));

    const classified = cartridge.secrets && typeof cartridge.secrets === 'object'
      ? classifySecrets(cartridge.secrets as Parameters<typeof classifySecrets>[0])
      : classifySecrets({ requires: Array.isArray(body.secrets) ? body.secrets : [] });
    const requires = classified.all;
    const ungated = classified.ungated;
    const gated = classified.gated;
    const triggers = (Array.isArray(cartridge.triggers) ? cartridge.triggers : (Array.isArray(body.triggers) ? body.triggers : [])) as Surface['triggers'];
    const memoryPrefix = (typeof cartridge.persistence === 'object' && cartridge.persistence !== null && 'prefix' in cartridge.persistence)
      ? (cartridge.persistence as { prefix: string }).prefix
      : (typeof cartridge.memory === 'object' && cartridge.memory !== null && 'prefix' in cartridge.memory ? (cartridge.memory as { prefix: string }).prefix : agentId);

    const warmDownSeconds = (typeof cartridge.runtime === 'object' && cartridge.runtime !== null && 'warmDownSeconds' in cartridge.runtime)
      ? Number((cartridge.runtime as { warmDownSeconds: number }).warmDownSeconds)
      : undefined;

    const model = typeof cartridge.model === 'string' ? cartridge.model : (typeof body.model === 'string' ? body.model : 'gemini-2.0-flash');
    // M2: the models the cartridge was built for, preferred first. A request shown to the admin, never a grant.
    const requestedModels = Array.isArray(cartridge.requestedModels)
      ? cartridge.requestedModels
      : Array.isArray(cartridge.models)
      ? cartridge.models
      : (Array.isArray(body.requestedModels) ? body.requestedModels : (Array.isArray(body.models) ? body.models : []));
    const approvedModels = Array.isArray(cartridge.approvedModels) && cartridge.approvedModels.length > 0
      ? cartridge.approvedModels
      : (Array.isArray(body.approvedModels) && body.approvedModels.length > 0 ? body.approvedModels : [model]);

    const record: AgentRecord = {
      id: typeof cartridge.id === 'string' ? cartridge.id : agentId,
      name: typeof cartridge.name === 'string' ? cartridge.name : (typeof body.name === 'string' ? body.name : agentId),
      role: typeof cartridge.role === 'string' ? cartridge.role : (typeof body.role === 'string' ? body.role : 'Agent'),
      state: stateResult,
      provider: 'cloud',
      artifact,
      requires,
      ungated: ungated.length ? ungated : requires,
      gated,
      triggers,
      memoryPrefix,
      warmDownSeconds,
      dir: '/tmp/' + agentId,
      model,
      requestedModels,
      approvedModels,
      ...(source ? { repo: source.repo, commit: source.commit } : {}),
      ...connectionsOf(cartridge),
      ...credentialsOf({ secrets: cartridge.secrets ?? (Array.isArray(body.secrets) ? { requires: body.secrets } : undefined) }),
      ...egressOf(cartridge),
      ...rolesOf(cartridge),
      ...skillRoutesOf(cartridge),
      ...skillIdsOf(cartridge),
    };
    state.agents.set(record.id, record);

    // E7 deny-by-default: registration grants nothing. The cartridge's declared egress is a request an admin
    // reviews; routes, hosts, and budgets come only from the policy API.

    registryOf(state).save(record);
    await recordConfig(state, record.id, { actor: principal.actor, reason: changeReason(req, state.configs?.current(record.id) ? 're-registered' : 'registered') });
    json(res, 201, archetypeWarning ? { ...record, warnings: [archetypeWarning] } : record);
    return;
  }
  
  if (path === '/api/v1/registry/agents' && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'agents.read'))) return;
    json(res, 200, Array.from(state.agents.values()).map((a) => enrichAgent(state, a)));
    return;
  }

  /**
 * The skills an agent declares. A record saved before `skillIds` existed (dynamic records load as saved, not re-derived)
 * has none, so fall back to the skills we can still see: those with an egress route, and those a role names. That can
 * miss a skill with neither; registering the agent again records them all.
 */
function skillIdsFor(agent: { skillIds?: string[]; skillRoutes?: Record<string, string[]>; roles?: Array<{ skills: Record<string, unknown> }> }): string[] {
  if (agent.skillIds) return agent.skillIds;
  const ids = new Set(Object.keys(agent.skillRoutes ?? {}));
  for (const r of agent.roles ?? []) for (const s of Object.keys(r.skills ?? {})) if (s !== '*') ids.add(s);
  return [...ids];
}

// E12: the roles an agent's cartridge declares, for the screen that assigns them and the egress that applies them.
  const rolesMatch = path.match(/^\/api\/v1\/agents\/([^/]+)\/roles$/);
  if (rolesMatch && req.method === 'GET') {
    const agentId = decodeURIComponent(rolesMatch[1]);
    if (!(await requirePrivilege(req, res, state, 'agents.roles.read', { agentId }))) return;
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const roles = agent.roles ?? [];
    // `?held=Family,Realtor`: what someone who holds those roles may use, by the rule the egress will apply (E12, TSK-174;
    // nothing enforces it there yet). More than 20 names is refused, not silently cut.
    const heldParam = new URL(req.url ?? '/', 'http://factory.local').searchParams.get('held');
    const held = heldParam === null ? undefined : heldParam.split(',').map((s) => s.trim()).filter(Boolean);
    if (held && held.length > 20) {
      json(res, 400, { error: 'too_many_roles', max: 20, message: 'ask about at most 20 roles at a time' });
      return;
    }
    const skillIds = skillIdsFor(agent);
    json(res, 200, {
      agentId,
      roles,
      // Owner is declared but never assigned (it comes from ownership): these are the names a person can be given.
      assignable: roles.map((r) => r.name).filter((n) => n.toLowerCase() !== 'owner'),
      skillRoutes: agent.skillRoutes ?? {},
      skillIds,
      ...(held ? { effective: effectiveAccess(roles, held, skillIds, agent.skillRoutes ?? {}) } : {}),
    });
    return;
  }

  const regAgentMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)$/);
  if (regAgentMatch && req.method === 'GET') {
    if (!(await requirePrivilege(req, res, state, 'agents.read'))) return;
    const agent = state.agents.get(regAgentMatch[1]);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, enrichAgent(state, agent));
    return;
  }

  const budgetMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/budget$/);
  if (budgetMatch && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'registry.budget.set');
    if (!principal) return;
    const agentId = budgetMatch[1];
    const agent = state.agents.get(agentId);
    // GAP-060: never a budget (a policy) for an id that is not a known agent.
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const isBuiltin = Boolean(agent.isBuiltin || agent.category === 'builtin' || BUILTIN_AGENT_IDS.has(agent.id));
    if (isBuiltin) {
      json(res, 400, {
        error: 'builtin_agents_exempt_from_budget',
        message: 'Built-in system agents are critical infrastructure and are exempt from spend limits. Budgets cannot be assigned.',
      });
      return;
    }
    const body = await readJson(req);
    let policyInput: unknown = body;
    if (body && typeof body === 'object' && 'spendLimitUsd' in body) {
      const currentPol = state.policies.get(agentId) ?? { routes: ['anthropic', 'openai'] };
      const period = (body as any).period === 'monthly' ? 'perMonth' : 'perDay';
      policyInput = {
        ...currentPol,
        budgetUsd: {
          ...currentPol.budgetUsd,
          [period]: Number((body as any).spendLimitUsd),
        },
      };
    }
    const checked = validatePolicy(policyInput);
    if (!checked.ok) {
      json(res, 400, { error: checked.error });
      return;
    }
    state.policies.set(agentId, checked.policy);
    unblockAffordableRuns(state, agentId, checked.policy?.budgetUsd, principal.actor);
    if (agent.state === 'PENDING_BUDGET') {
      agent.state = 'PENDING_DEPLOY';
    }
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'BUDGET_APPROVED',
      actor: principal.actor,
    });
    await recordConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, 'budget updated') });
    registryOf(state).save(agent);
    json(res, 200, enrichAgent(state, agent));
    return;
  }

  const retireMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/retire$/);
  if (retireMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'registry.retire');
    if (!principal) return;
    const agentId = retireMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    agent.state = 'RETIRED_PENDING_PURGE';
    const now = new Date();
    agent.retiredAt = now.toISOString();
    agent.purgeDueAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    state.ledger.append({
      timestamp: now.toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_RETIRED_PENDING_PURGE',
      actor: principal.actor,
    });
    registryOf(state).save(agent);
    json(res, 200, agent);
    return;
  }

  const reinstateMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/reinstate$/);
  if (reinstateMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'registry.reinstate');
    if (!principal) return;
    const agentId = reinstateMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (agent.state !== 'RETIRED_PENDING_PURGE') {
      json(res, 400, { error: 'agent_not_retired', message: 'Only retired agents can be reinstated' });
      return;
    }
    agent.state = 'SLEEPING';
    delete agent.retiredAt;
    delete agent.purgeDueAt;
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_REINSTATED',
      actor: principal.actor,
    });
    registryOf(state).save(agent);
    json(res, 200, agent);
    return;
  }

  const purgeMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/purge$/);
  if (purgeMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'registry.purge');
    if (!principal) return;
    const agentId = purgeMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    state.agents.delete(agentId);
    registryOf(state).remove(agentId);
    state.ledger.append({
      timestamp: new Date().toISOString(),
      agentId,
      type: 'action',
      action: 'AGENT_PURGED',
      actor: principal.actor,
    });
    // GAP-060: a purged agent leaves no policy or configuration record behind. Both are recoverable: the policy file is
    // moved to policies-orphaned/, the configuration removal is versioned (R1).
    for (const id of state.policies.archive([agentId]).archived) {
      state.ledger.append({ timestamp: new Date().toISOString(), agentId: id, type: 'action', action: 'POLICY_ORPHAN_ARCHIVED', actor: principal.actor });
    }
    try {
      await removeConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, 'agent purged') });
    } catch (err) {
      console.error(`[control-plane] configuration for ${agentId} not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
    json(res, 200, { ok: true, id: agentId, action: 'purged' });
    return;
  }
  
  const deployMatch = path.match(/^\/api\/v1\/registry\/agents\/([^\/]+)\/deploy$/);
  if (deployMatch && req.method === 'POST') {
    const principal = await requirePrivilege(req, res, state, 'registry.deploy');
    if (!principal) return;
    const agentId = deployMatch[1];
    const agent = state.agents.get(agentId);
    if (!agent) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    if (agent.isBuiltin || BUILTIN_AGENT_IDS.has(agent.id)) {
      json(res, 400, { error: 'builtin_agent', message: 'Built-in system agents are deployed with the platform, not through the registry' });
      return;
    }
    if (agent.state === 'DEPLOYING' || isDeploying(state, agentId) || agent.state === 'RETIRED_PENDING_PURGE' || agent.state === 'PURGED') {
      json(res, 409, { error: 'invalid_state', message: `Agent is ${agent.state}` });
      return;
    }

    // A deploy request may re-pin the registered source to another exact commit (it is then admitted afresh).
    // L4: only an admitted commit deploys, as an image tagged by its SHA. A record without a pinned source, or
    // whose image is a mutable tag, is refused rather than built from "latest" (the Registrar's rule).
    const body = await readJson(req);
    const pin = pinSource(agent, body);
    if (!pin.ok) {
      json(res, pin.error === 'commit_required' ? 409 : 400, { error: pin.error, message: pin.message });
      return;
    }
    const { repo, commit } = pin.source;

    // L4 / E7: a policy owner must have set this agent's own policy, with at least one route, before it deploys.
    if (!state.policies.has(agentId) || state.policies.get(agentId).routes.length === 0) {
      json(res, 409, { error: 'policy_required', message: 'Set the agent policy (PUT /api/v1/agents/:id/policy) with at least one route before deploying' });
      return;
    }

    if (!state.deployProvider) {
      json(res, 501, { error: 'deploy_provider_not_configured', message: 'No deploy provider bound. Configure a DeployProvider for your target cloud.' });
      return;
    }

    // SK4: the image is the agent's source plus the skills its configuration adopts, each at its approved pin.
    const built = buildSkillsFor(state, agentId);
    if (!built.ok) {
      json(res, 409, { error: built.error, message: built.message });
      return;
    }

    const source: SourceRef = { repo, commit };
    const previousState = agent.state;
    agent.repo = repo;
    agent.commit = commit;
    agent.state = 'DEPLOYING';
    agent.admission = beginAdmission(commit);
    registryOf(state).save(agent);
    await recordConfig(state, agentId, { actor: principal.actor, reason: changeReason(req, `deploy of ${commit}`) });
    json(res, 202, agent);

    void runDeploy(state, { agent, actor: principal.actor, source, skills: built.skills, previousState, isApply: false });
    return;
  }

  if (path === '/api/v1/policies/budget' && req.method === 'PUT') {
    const principal = await requirePrivilege(req, res, state, 'policy.budget.set');
    if (!principal) return;
    const checked = validatePolicy(await readJson(req));
    if (!checked.ok) {
      json(res, 400, { error: checked.error });
      return;
    }
    state.policies.set('__global__', checked.policy);
    json(res, 200, checked.policy);
    return;
  }

  // GAP-062 (M2, E7): one place chooses an agent's models, its policy (`PUT /api/v1/agents/:id/policy`, the
  // console's Policy tab). The old approve and hot-swap endpoints granted models outside that editor and rewrote
  // the agent's declared preferred model, which no run reads. They are gone; a caller is told where to go instead.
  const retiredModelMatch = path.match(/^\/api\/v1\/registry\/agents\/([^/]+)\/(model|models\/approve)$/);
  if (retiredModelMatch && (req.method === 'POST' || req.method === 'PUT')) {
    const principal = await requirePrivilege(req, res, state, 'registry.model.set');
    if (!principal) return;
    json(res, 410, {
      error: 'models_set_in_policy',
      message: `An agent's models are granted only in its policy: PUT /api/v1/agents/${retiredModelMatch[1]}/policy with "models".`,
    });
    return;
  }
  // --- END REGISTRY SERVICE ---
  json(res, 404, { error: 'not_found' });
}
