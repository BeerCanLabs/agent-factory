import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Checkpointer, FileLedger, checkpointSinkFromEnv, secretValuesFromEnv } from '@beercanlabs/factory-ledger';
import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { authFromEnv } from '@beercanlabs/factory-auth';
import { loadCatalog } from './catalog.js';
import { activeRun, checkHealth, createFactoryServer, createRun, FactoryState, factoryMetrics, finishRun, reconcileRuns, SYSTEM } from './app.js';
import { initTelemetry } from '@beercanlabs/factory-telemetry';
import { FileRunStore, RunTokens } from './runs.js';
import { callbackPolicyFromEnv } from './callbacks.js';
import { ApprovalStore, PolicyStore, SpendTracker, validatePolicy } from './policy.js';
import { memoryRuntime } from './runtime.js';
import { ecsRuntime, parseTaskMap } from './runtime-ecs.js';
import { dockerApi, dockerRuntime, parseImageMap } from './runtime-docker.js';
import { agentsDueForCron } from './scheduler.js';

const PORT = parseInt(process.env.PORT || '8088', 10);
const AGENTS_ROOT = process.env.AGENTS_ROOT || fileURLToPath(new URL('../../../agents', import.meta.url));
const VERSION = '0.1.0';
const LEDGER_PATH = process.env.FACTORY_LEDGER_PATH || join(process.cwd(), 'data', 'ledger.jsonl');
const MEMORY_STORE = process.env.MEMORY_STORE_DIR || join(process.cwd(), 'data', 'mind');
const EPHEMERAL = process.env.MEMORY_EPHEMERAL_DIR || join(process.cwd(), 'data', 'ephemeral');
const IDLE_MS = parseInt(process.env.FACTORY_IDLE_MS || '300000', 10);
const DATA_DIR = dirname(LEDGER_PATH);
const RUNS_DIR = process.env.FACTORY_RUNS_DIR || join(DATA_DIR, 'runs');

function defaultPolicy() {
  if (!process.env.FACTORY_DEFAULT_POLICY) return undefined;
  const checked = validatePolicy(JSON.parse(process.env.FACTORY_DEFAULT_POLICY));
  if (!checked.ok) throw new Error(`FACTORY_DEFAULT_POLICY: ${checked.error}`);
  return checked.policy;
}

mkdirSync(MEMORY_STORE, { recursive: true });
mkdirSync(EPHEMERAL, { recursive: true });

const agents = loadCatalog(AGENTS_ROOT);
const secretValues = new Set<string>(secretValuesFromEnv());

const ledger = new FileLedger(LEDGER_PATH, { secrets: () => secretValues });
const ledgerSink = checkpointSinkFromEnv();
{
  // Never append on top of a chain that no longer verifies: that would launder the tampering.
  const check = ledger.verify(ledgerSink ? await ledgerSink.list() : []);
  if (!check.ok) {
    console.error(`[control-plane] ledger integrity failure at seq ${check.firstBadSeq}: ${check.reason}`);
    process.exit(3);
  }
}

const state: FactoryState = {
  agents: new Map(agents.map((a) => [a.id, a])),
  ledger,
  policies: new PolicyStore(process.env.FACTORY_POLICIES_DIR || join(DATA_DIR, 'policies'), defaultPolicy()),
  approvals: new ApprovalStore(join(DATA_DIR, 'approvals')),
  // Only the gateway can write costUsd (stripped for other writers), so every priced llm row counts.
  spend: SpendTracker.fromLedger(ledger.query(), () => true),
  secretValues,
  ledgerSink,
  doormanToken: process.env.DOORMAN_TOKEN,
  heartbeatTimeoutMs: parseInt(process.env.FACTORY_HEARTBEAT_TIMEOUT_MS || '90000', 10),
  maxRssMb: parseInt(process.env.FACTORY_MAX_RSS_MB || '0', 10),
  crashLoopThreshold: parseInt(process.env.FACTORY_CRASH_LOOP_THRESHOLD || '3', 10),
  auth: authFromEnv(),
  version: VERSION,
  providers: providersFromEnv(),
  runs: new FileRunStore(RUNS_DIR),
  runTokens: new RunTokens(process.env.FACTORY_RUN_TOKEN_KEY),
  callbacks: callbackPolicyFromEnv(),
  publicUrl: process.env.FACTORY_PUBLIC_URL,
  gatewayUrl: process.env.FACTORY_GATEWAY_URL,
  idleMs: IDLE_MS,
  idleTimers: new Map(),
  doormanUrl: process.env.DOORMAN_URL,
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
state.metrics = factoryMetrics(telemetry.meter, () => state);

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
    process.once(sig, () => void ship().finally(() => process.exit(0)));
  }
} else {
  console.warn('[control-plane] FACTORY_LEDGER_WORM_URI unset: ledger is hash-chained but has no write-once anchor');
}

const server = createFactoryServer(state);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[control-plane] listening on :${PORT} with ${state.agents.size} cartridges`);
});

if (process.env.FACTORY_CRON !== '0') {
  setInterval(() => {
    const due = agentsDueForCron(state.agents.values());
    for (const agent of due) {
      if (!activeRun(state, agent.id)) void createRun(state, agent.id, { actor: SYSTEM.scheduler, trigger: 'cron' });
    }
  }, 60_000);
}
