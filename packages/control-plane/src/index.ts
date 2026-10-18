import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Checkpointer, FileLedger, LedgerLease, LeaseHeldError, archiveAndStartSegment, checkpointSinkFromEnv, hydrateLedgerFromSink, readSegment, secretValuesFromEnv, segmentWormUri } from '@beercanlabs/factory-ledger';
import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { accessAuthFromEnv, authFromEnv } from '@beercanlabs/factory-auth';
import {
  BUILTIN_SYSTEM_AGENTS,
  configBackendFromEnv,
  loadCatalog,
  loadDynamicRegistry,
  mergeAgents,
  VersionedConfigStore,
} from '@beercanlabs/factory-registrar';
import { createFactoryServer, FactoryState } from './app.js';
import { activeRun, callbackPolicyFromEnv, checkHealth, cloudRunRuntime, createRun, dockerApi, dockerRuntime, ecsRuntime, FileRunStore, finishRun, memoryRuntime, parseImageMap, parseJobMap, parseTaskMap, reconcileRuns, RunTokens, startQueuePollers, SYSTEM, type DeployProvider } from '@beercanlabs/factory-property-manager';
import { scheduleRunOptions } from './schedules.js';
import { initTelemetry } from '@beercanlabs/factory-telemetry';
import { SpendTracker, type CloudCostSource, type ComputeSource } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { ScheduleStore, createTimekeeper } from '@beercanlabs/factory-timekeeper';
import { IdentityLinkStore } from './identity-links.js';
import { PolicyStore, validatePolicy } from '@beercanlabs/factory-gatekeeper/policy';
import { busSinkFromEnv, createInspector, factoryMetrics } from '@beercanlabs/factory-inspector';
import { attachEventStream } from './stream.js';
import { checkRegistry, migrateConfigs, pruneOrphans } from './config-store.js';
import { SystemsStore } from './systems.js';
import { seedBuiltinAiProviders } from './ai-providers.js';
import { syncPlatformCredentials } from './credentials.js';
import { checkFactoryBudgets, createTreasury } from './spend.js';
import { AwsComputeSource, AwsCostSource } from './aws/accountant.js';
import { GcpComputeSource, GcpCostSource } from './gcp/accountant.js';
import { ModelStore } from './models.js';

const PORT = parseInt(process.env.PORT || '8088', 10);
const AGENTS_ROOT = process.env.AGENTS_ROOT || fileURLToPath(new URL('../../../agents', import.meta.url));
const VERSION = '0.1.0';
const LEDGER_PATH = process.env.FACTORY_LEDGER_PATH || join(process.cwd(), 'data', 'ledger.jsonl');
const MEMORY_STORE = process.env.MEMORY_STORE_DIR || join(process.cwd(), 'data', 'mind');
const EPHEMERAL = process.env.MEMORY_EPHEMERAL_DIR || join(process.cwd(), 'data', 'ephemeral');
const IDLE_MS = parseInt(process.env.FACTORY_IDLE_MS || '3600000', 10);
const DATA_DIR = dirname(LEDGER_PATH);
const RUNS_DIR = process.env.FACTORY_RUNS_DIR || join(DATA_DIR, 'runs');
const REGISTRY_DIR = process.env.FACTORY_REGISTRY_DIR || join(DATA_DIR, 'registry');

function defaultPolicy() {
  if (!process.env.FACTORY_DEFAULT_POLICY) return undefined;
  const checked = validatePolicy(JSON.parse(process.env.FACTORY_DEFAULT_POLICY));
  if (!checked.ok) throw new Error(`FACTORY_DEFAULT_POLICY: ${checked.error}`);
  return checked.policy;
}

mkdirSync(MEMORY_STORE, { recursive: true });
mkdirSync(EPHEMERAL, { recursive: true });
mkdirSync(REGISTRY_DIR, { recursive: true });

const staticAgents = loadCatalog(AGENTS_ROOT);
const dynamicAgents = loadDynamicRegistry(REGISTRY_DIR);
// Built-in system actors (gatekeeper-ingress, Keymaster, Doctor, Coach) are first-class system agents; a registry record
// replaces a baked static cartridge with the same id.
const allAgents = mergeAgents(BUILTIN_SYSTEM_AGENTS, staticAgents, dynamicAgents);
const secretValues = new Set<string>(secretValuesFromEnv());

// LG1: exactly one writer per ledger. Take the lease before opening the file; never share it with another process.
const ledgerLease = new LedgerLease(`${LEDGER_PATH}.lease`, {
  ttlMs: parseInt(process.env.FACTORY_LEDGER_LEASE_TTL_MS || '30000', 10),
  onLost: (by) => {
    console.error(`[control-plane] ledger lease lost to ${by?.holder ?? 'unknown'}; stopping before a second writer can tear the ledger`);
    process.exit(4);
  },
});
try {
  ledgerLease.acquire();
} catch (err) {
  if (!(err instanceof LeaseHeldError)) throw err;
  console.error(`[control-plane] ${err.message}`);
  process.exit(4);
}
ledgerLease.keepAlive();
// Release on every exit (including refusals below) so the next start need not wait out the TTL. Only frees our own lease.
process.on('exit', () => ledgerLease.release());
console.log(`[control-plane] ledger lease held by ${ledgerLease.holder}`);

const inspector = createInspector();
// LG2: each segment has its own genesis and its own write-once checkpoint prefix.
// On serverless (Cloud Run) cold boots where LEDGER_PATH lives on fast local disk (/tmp/ledger.jsonl),
// restore any missing rows from the write-once checkpoint sink before opening and verifying FileLedger.
{
  const bootSegment = readSegment(LEDGER_PATH);
  const bootSink = checkpointSinkFromEnv({ ...process.env, FACTORY_LEDGER_WORM_URI: segmentWormUri(process.env.FACTORY_LEDGER_WORM_URI, bootSegment) });
  if (bootSink) {
    try {
      const hydrated = await hydrateLedgerFromSink(LEDGER_PATH, bootSink);
      if (hydrated > 0) console.log(`[control-plane] hydrated ${hydrated} ledger rows from WORM checkpoint sink`);
    } catch (err) {
      console.error(`[control-plane] ledger hydration from WORM sink failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error('[control-plane] refusing to open an empty ledger over a checkpoint sink that could not be read');
      process.exit(3);
    }
  }
}
const openSegment = () => {
  const segment = readSegment(LEDGER_PATH);
  const store = new FileLedger(LEDGER_PATH, { secrets: () => secretValues, genesis: segment?.genesis });
  const sink = checkpointSinkFromEnv({ ...process.env, FACTORY_LEDGER_WORM_URI: segmentWormUri(process.env.FACTORY_LEDGER_WORM_URI, segment) });
  return { segment, store, sink };
};
let opened = openSegment();
{
  // Never append on top of a chain that no longer verifies: that would launder the tampering.
  const check = opened.store.verify(opened.sink ? await opened.sink.list() : []);
  if (!check.ok) {
    const recoverSeq = process.env.FACTORY_LEDGER_RECOVER_SEQ;
    const reason = process.env.FACTORY_LEDGER_RECOVER_REASON ?? '';
    // Recovery is an explicit operator decision for this exact failure; a stale setting never launders a new one.
    if (recoverSeq !== String(check.firstBadSeq) || !reason.trim()) {
      console.error(`[control-plane] ledger integrity failure at seq ${check.firstBadSeq}: ${check.reason}`);
      console.error(`[control-plane] to archive this ledger unchanged and start a new segment (LG2), set FACTORY_LEDGER_RECOVER_SEQ=${check.firstBadSeq} and FACTORY_LEDGER_RECOVER_REASON`);
      process.exit(3);
    }
    const record = archiveAndStartSegment(LEDGER_PATH, { failedAtSeq: check.firstBadSeq, failure: check.reason, reason });
    opened = openSegment();
    opened.store.append({ agentId: 'factory', type: 'action', action: 'LEDGER_RECOVERY', actor: 'system:ledger', payloadSha256: record.genesis });
    console.warn(`[control-plane] ledger segment ${record.previous.segment} archived unchanged as ${record.previous.archive} (sha256 ${record.previous.archiveSha256}); recording continues in segment ${record.segment}`);
  } else if (process.env.FACTORY_LEDGER_RECOVER_SEQ) {
    console.warn('[control-plane] FACTORY_LEDGER_RECOVER_SEQ is set but the ledger verifies; ignoring it (remove the setting)');
  }
}
const ledger = inspector.tapLedger(opened.store);
const ledgerSink = opened.sink;

let deployProvider: DeployProvider | undefined;
const deployProviderType = process.env.FACTORY_DEPLOY_PROVIDER || (process.env.FACTORY_RUNTIME === 'ecs' ? 'aws' : process.env.FACTORY_RUNTIME === 'cloudrun' ? 'gcp' : undefined);
if (deployProviderType === 'aws') {
  try {
    const { awsDeployProvider } = await import('@beercanlabs/factory-property-manager/aws/deploy');
    deployProvider = awsDeployProvider();
  } catch (err) {
    console.warn('[control-plane] failed to initialize AWS deploy provider:', err);
  }
} else if (deployProviderType === 'gcp') {
  try {
    const { gcpDeployProvider } = await import('@beercanlabs/factory-property-manager/gcp/deploy');
    deployProvider = gcpDeployProvider();
  } catch (err) {
    console.warn('[control-plane] failed to initialize GCP deploy provider:', err);
  }
}

/** Model names, providers and prices from FACTORY_MODEL_CATALOG; unset or malformed means none offered. */
function modelCatalogFromEnv(json: string | undefined): FactoryState['modelCatalog'] {
  if (!json?.trim()) return {};
  try {
    const raw = JSON.parse(json) as Record<string, { provider?: unknown; id?: unknown; region?: unknown; endpoint?: unknown; price?: { inputPerMTok?: unknown; outputPerMTok?: unknown } }>;
    const out: NonNullable<FactoryState['modelCatalog']> = {};
    for (const [name, m] of Object.entries(raw ?? {})) {
      if (!m || typeof m.provider !== 'string') continue;
      const p = m.price;
      // Keep the provider model id, region and endpoint (GAP-174): the store seeds from this, and the gatekeeper-egress
      // serves what the store holds.
      out[name] = {
        provider: m.provider,
        ...(typeof m.id === 'string' ? { id: m.id } : {}),
        ...(typeof m.region === 'string' ? { region: m.region } : {}),
        ...(typeof m.endpoint === 'string' ? { endpoint: m.endpoint } : {}),
        ...(p && typeof p.inputPerMTok === 'number' && typeof p.outputPerMTok === 'number' ? { price: { inputPerMTok: p.inputPerMTok, outputPerMTok: p.outputPerMTok } } : {}),
      };
    }
    return out;
  } catch (err) {
    console.warn('[control-plane] FACTORY_MODEL_CATALOG is not valid JSON; no models offered:', err);
    return {};
  }
}

const modelStore = new ModelStore(
  join(DATA_DIR, 'models', 'catalog.json'),
  modelCatalogFromEnv(process.env.FACTORY_MODEL_CATALOG),
  process.env.FACTORY_DEFAULT_MODEL || undefined,
);

const state: FactoryState = {
  agents: new Map(allAgents.map((a) => [a.id, a])),
  modelStore,
  // §6.9 M3: the dynamic catalog gatekeeper-egress serves, so the admin chooses from what is actually offered.
  modelCatalog: modelStore.toEgressCatalog(),
  defaultModel: modelStore.getDefault() || process.env.FACTORY_DEFAULT_MODEL || undefined,
  registryDir: REGISTRY_DIR,
  ledger,
  inspector,
  deployProvider,
  policies: new PolicyStore(process.env.FACTORY_POLICIES_DIR || join(DATA_DIR, 'policies'), defaultPolicy()),
  approvals: new ApprovalStore(join(DATA_DIR, 'approvals')),
  identityLinks: new IdentityLinkStore(join(DATA_DIR, 'identity-links')),
  // Only the gatekeeper-egress can write costUsd (stripped for other writers), so every priced llm row counts.
  spend: SpendTracker.fromLedger(ledger.query(), () => true),
  secretValues,
  ledgerSink,
  gatekeeperIngressToken: process.env.GATEKEEPER_INGRESS_TOKEN,
  heartbeatTimeoutMs: parseInt(process.env.FACTORY_HEARTBEAT_TIMEOUT_MS || '90000', 10),
  // GAP-176: heartbeats are judged from this process's start, not across the gap a stop-then-start deploy leaves.
  healthSince: Date.now(),
  maxRssMb: parseInt(process.env.FACTORY_MAX_RSS_MB || '0', 10),
  crashLoopThreshold: parseInt(process.env.FACTORY_CRASH_LOOP_THRESHOLD || '3', 10),
  auth: authFromEnv(),
  // §6.12 A2: FACTORY_ACCESS_TEAM_DOMAIN + FACTORY_ACCESS_AUD; unset disables Access identity (bearer tokens only).
  access: accessAuthFromEnv(),
  version: VERSION,
  providers: providersFromEnv(),
  runs: Object.assign(new FileRunStore(RUNS_DIR), { onChange: (run: Parameters<typeof inspector.publishRun>[0]) => inspector.publishRun(run) }),
  runTokens: new RunTokens(process.env.FACTORY_RUN_TOKEN_KEY),
  callbacks: callbackPolicyFromEnv(),
  publicBaseUrl: process.env.FACTORY_PUBLIC_BASE_URL || undefined,
  publicUrl: process.env.FACTORY_PUBLIC_URL || process.env.FACTORY_URL || 'http://control-plane.factory.internal:8088',
  gatekeeperEgressUrl: process.env.FACTORY_GATEKEEPER_EGRESS_URL,
  gatekeeperEgressToken: process.env.FACTORY_GATEKEEPER_EGRESS_TOKEN,
  gatekeeperEgressHeldSecrets: new Set((process.env.FACTORY_GATEKEEPER_EGRESS_HELD_SECRETS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  idleMs: IDLE_MS,
  idleTimers: new Map(),
  gatekeeperIngressUrl: process.env.GATEKEEPER_INGRESS_URL,
  runtime:
    process.env.FACTORY_RUNTIME === 'docker'
      ? dockerRuntime({
          api: dockerApi(process.env.DOCKER_HOST || 'unix:///var/run/docker.sock'),
          images: parseImageMap(process.env.FACTORY_DOCKER_IMAGES),
          network: process.env.FACTORY_DOCKER_NETWORK || 'factory-agents',
          mindVolume: process.env.FACTORY_DOCKER_MIND_VOLUME,
          ensureMindPath: (prefix) => mkdirSync(join(MEMORY_STORE, prefix), { recursive: true }),
          memoryMb: parseInt(process.env.FACTORY_DOCKER_MEMORY_MB || '512', 10),
        })
      : process.env.FACTORY_RUNTIME === 'ecs'
      ? ecsRuntime({
          cluster: process.env.FACTORY_ECS_CLUSTER || '',
          taskMap: parseTaskMap(process.env.FACTORY_ECS_TASKS),
          subnets: (process.env.FACTORY_ECS_SUBNETS || '').split(',').filter(Boolean),
          securityGroups: (process.env.FACTORY_ECS_SECURITY_GROUPS || '').split(',').filter(Boolean),
          assignPublicIp: process.env.FACTORY_ECS_ASSIGN_PUBLIC_IP !== 'false',
        })
      : process.env.FACTORY_RUNTIME === 'cloudrun'
      ? cloudRunRuntime({
          projectId: process.env.FACTORY_GCP_PROJECT || '',
          region: process.env.FACTORY_GCP_REGION || 'us-central1',
          jobMap: parseJobMap(process.env.FACTORY_CLOUDRUN_JOBS),
        })
      : memoryRuntime({
          store: { root: MEMORY_STORE, uri: process.env.MEMORY_STORE_URI },
          ephemeralRoot: EPHEMERAL,
          workerCommand: (agent) => {
            if (process.env.FACTORY_SPAWN_WORKERS === '0') return undefined;
            if (agent.localCommand?.length) {
              const [cmd, ...args] = agent.localCommand;
              return { cmd, args };
            }
            return undefined;
          },
          onExit: (_agent, code, ctx) => {
            void finishRun(state, ctx.runId, code === 0 ? 'DONE' : 'FAILED', {
              actor: SYSTEM.runtime,
              exitCode: code,
              ...(code === 0 ? {} : { error: `exit ${code}` }),
            });
          },
        }),
};

process.env.FACTORY_STARTED_AT = String(Date.now());

if (state.runTokens.ephemeral) {
  console.warn('[control-plane] FACTORY_RUN_TOKEN_KEY unset: run tokens die with this process');
}

const telemetry = initTelemetry('factory-control-plane', VERSION);
state.metrics = factoryMetrics(telemetry.meter, () => state.runs.list({ active: true }).map((r) => r.state));

// §6.14 SK3, §6.13 R1: the deployment configuration store is read once here and written only on change; API reads are
// served from memory. If it cannot be read, the factory runs as before without it (the API reports it unavailable)
// rather than starting empty and re-numbering versions that already exist.
try {
  const backend = configBackendFromEnv(process.env.FACTORY_CONFIG_STORE_URI, join(DATA_DIR, 'config'));
  state.configs = await VersionedConfigStore.open(backend);
} catch (err) {
  console.error(`[control-plane] configuration store unavailable: ${err instanceof Error ? err.message : String(err)}`);
}
// GAP-060: archive policies and remove configuration records of ids that are not agents, before migration can copy
// them. Refused (nothing touched) unless the registry was read in full and the known agents look complete.
try {
  await pruneOrphans(state, { builtinIds: BUILTIN_SYSTEM_AGENTS.map((a) => a.id), registry: checkRegistry(REGISTRY_DIR) });
} catch (err) {
  console.error(`[control-plane] orphan prune failed: ${err instanceof Error ? err.message : String(err)}`);
}
if (state.configs) {
  try {
    const migrated = await migrateConfigs(state, [...dynamicAgents.map((a) => a.id), ...state.policies.ids()]);
    console.log(`[control-plane] configuration store ${state.configs.description}: ${state.configs.agentIds().length} agents, ${migrated.length} migrated`);
  } catch (err) {
    console.error(`[control-plane] configuration migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// §6.3.1 E10, §6.13 R1: Systems as factory data
const SYSTEMS_DIR = process.env.FACTORY_SYSTEMS_DIR || join(DATA_DIR, 'systems');
try {
  state.systems = await SystemsStore.open(SYSTEMS_DIR, ledger);
  // GAP-068 migration: the deployment's existing routes, recorded once as approved systems (never overwrites).
  if (process.env.FACTORY_SYSTEMS_IMPORT) {
    const { imported, skipped } = await state.systems.importRoutes(JSON.parse(process.env.FACTORY_SYSTEMS_IMPORT), 'migration:landing-zone');
    if (imported.length) console.log(`[control-plane] systems imported from the deployment: ${imported.join(', ')}`);
    for (const s of skipped) console.error(`[control-plane] system not imported: ${s}`);
  }
  const seeded = await seedBuiltinAiProviders(state.systems);
  if (seeded.length) console.log(`[control-plane] built-in AI providers seeded: ${seeded.join(', ')}`);
  syncPlatformCredentials(state);
  console.log(`[control-plane] systems store: ${state.systems.list().length} systems available`);
} catch (err) {
  console.error(`[control-plane] systems store initialization failed: ${err instanceof Error ? err.message : String(err)}`);
}

await reconcileRuns(state);

setInterval(() => void checkHealth(state), 15_000).unref();
if (state.runtime.status) {
  setInterval(() => void reconcileRuns(state), 15_000).unref();
}

if (ledgerSink) {
  const checkpointer = new Checkpointer(ledger, ledgerSink);
  await checkpointer.init();
  const every = parseInt(process.env.FACTORY_LEDGER_CHECKPOINT_SECONDS || '300', 10) * 1000;
  const ship = () =>
    checkpointer.flush().catch((err) => console.error(`[control-plane] ledger checkpoint failed: ${err instanceof Error ? err.message : String(err)}`));
  setInterval(ship, every).unref();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void ship().finally(() => { ledgerLease.release(); process.exit(0); }));
  }
} else {
  console.warn('[control-plane] FACTORY_LEDGER_WORM_URI unset: ledger is hash-chained but has no write-once anchor');
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => { ledgerLease.release(); process.exit(0); });
  }
}

const busSink = busSinkFromEnv();
if (busSink) inspector.attachBus(busSink);

const schedulesPath = process.env.FACTORY_SCHEDULES_PATH || join(DATA_DIR, 'schedules.json');
const schedules = new ScheduleStore(schedulesPath);
state.schedules = schedules;

// §6.15 Accountant: cloud spend, ECS / Cloud Run compute inventory, and factory budgets.
const budgetsPath = process.env.FACTORY_BUDGETS_PATH || join(DATA_DIR, 'budgets.json');
const accountantRoleArn = process.env.FACTORY_ACCOUNTANT_ROLE_ARN;
const ecsCluster = process.env.FACTORY_ECS_CLUSTER;

let cloudSource: CloudCostSource | undefined;
let computeSource: ComputeSource | undefined;
if (accountantRoleArn) {
  try {
    cloudSource = AwsCostSource.fromRole(accountantRoleArn);
    if (ecsCluster) {
      computeSource = AwsComputeSource.fromRole(accountantRoleArn, ecsCluster);
    }
  } catch (err) {
    console.error(`[control-plane] accountant initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }
} else if (process.env.FACTORY_GCP_PROJECT) {
  try {
    cloudSource = GcpCostSource.fromEnv();
    computeSource = GcpComputeSource.fromEnv();
  } catch (err) {
    console.error(`[control-plane] GCP accountant initialization failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
const treasury = createTreasury({ cloud: cloudSource, compute: computeSource, budgetsPath });
if (!treasury.budgets.current()) {
  treasury.budgets.set({ totalMonthUsd: 300 }, SYSTEM.policy);
}
state.treasury = treasury;
setInterval(() => void checkFactoryBudgets(state).catch((e) => console.error(`[accountant] budget check: ${e instanceof Error ? e.message : String(e)}`)), 60 * 60_000).unref();

const server = createFactoryServer(state);
attachEventStream(server, state, inspector);
startQueuePollers(state.agents.values(), (id, o) => createRun(state, id, o));
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[control-plane] listening on :${PORT} with ${state.agents.size} cartridges`);
});

if (process.env.FACTORY_CRON !== '0') {
  createTimekeeper({
    agents: () => state.agents.values(),
    schedules,
    fire: (request) => {
      if (request.kind === 'cartridge') {
        // Skipping a cartridge cron while the agent is running is the Property Manager's rule, not the Timekeeper's.
        if (!activeRun(state, request.agentId)) void createRun(state, request.agentId, { actor: SYSTEM.scheduler, trigger: 'cron' });
        return;
      }
      const sched = request.schedule;
      // E12, GAP-131: the run carries its requester's current authority, or does not start.
      const who = scheduleRunOptions(state, sched);
      if (!who) return;
      console.log(`[scheduler] Firing dynamic schedule "${sched.name}" (${sched.id}) for agent ${sched.agentId}`);
      void createRun(state, sched.agentId, {
        actor: SYSTEM.scheduler,
        trigger: 'schedule',
        ...who,
        input: {
          content: sched.prompt,
          message: sched.prompt,
          channelId: sched.channelId,
          scheduleId: sched.id,
          scheduleName: sched.name,
          source: 'schedule',
        },
      });
    },
  }).start();
}
