import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FileLedger, secretValuesFromEnv } from '@beercanlabs/factory-ledger';
import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { authFromEnv } from '@beercanlabs/factory-auth';
import { loadCatalog } from './catalog.js';
import { activeRun, createFactoryServer, createRun, FactoryState, finishRun, reconcileRuns, SYSTEM } from './app.js';
import { FileRunStore, RunTokens } from './runs.js';
import { callbackPolicyFromEnv } from './callbacks.js';
import { ApprovalStore, PolicyStore, SpendTracker, validatePolicy } from './policy.js';
import { memoryRuntime } from './runtime.js';
import { ecsRuntime, parseTaskMap } from './runtime-ecs.js';
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

const sidecarUrls: Record<string, string> = {};
if (process.env.SIDECAR_URLS) {
  for (const pair of process.env.SIDECAR_URLS.split(',')) {
    const [id, url] = pair.split('=').map((s) => s.trim());
    if (id && url) sidecarUrls[id] = url;
  }
}

mkdirSync(MEMORY_STORE, { recursive: true });
mkdirSync(EPHEMERAL, { recursive: true });

const agents = loadCatalog(AGENTS_ROOT, sidecarUrls);
const secretValues = new Set<string>(secretValuesFromEnv());

const ledger = new FileLedger(LEDGER_PATH, { secrets: () => secretValues });

const state: FactoryState = {
  agents: new Map(agents.map((a) => [a.id, a])),
  ledger,
  policies: new PolicyStore(process.env.FACTORY_POLICIES_DIR || join(DATA_DIR, 'policies'), defaultPolicy()),
  approvals: new ApprovalStore(join(DATA_DIR, 'approvals')),
  // Only the gateway can write costUsd (stripped for other writers), so every priced llm row counts.
  spend: SpendTracker.fromLedger(ledger.query(), () => true),
  secretValues,
  doormanToken: process.env.DOORMAN_TOKEN,
  sidecarToken: process.env.SIDECAR_TOKEN,
  auth: authFromEnv(),
  version: VERSION,
  providers: providersFromEnv(),
  runs: new FileRunStore(RUNS_DIR),
  runTokens: new RunTokens(process.env.FACTORY_RUN_TOKEN_KEY),
  callbacks: callbackPolicyFromEnv(),
  publicUrl: process.env.FACTORY_PUBLIC_URL,
  idleMs: IDLE_MS,
  idleTimers: new Map(),
  doormanUrl: process.env.DOORMAN_URL,
  runtime:
    process.env.FACTORY_RUNTIME === 'ecs'
      ? ecsRuntime({
          cluster: process.env.FACTORY_ECS_CLUSTER || '',
          taskMap: parseTaskMap(process.env.FACTORY_ECS_TASKS),
          subnets: (process.env.FACTORY_ECS_SUBNETS || '').split(',').filter(Boolean),
          securityGroups: (process.env.FACTORY_ECS_SECURITY_GROUPS || '').split(',').filter(Boolean),
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

await reconcileRuns(state);
if (state.runtime.status) {
  setInterval(() => void reconcileRuns(state), 15_000).unref();
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
