import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileLedger } from '@beercanlabs/factory-ledger';
import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { loadCatalog } from './catalog.js';
import { apply, createFactoryServer, FactoryState } from './app.js';
import { memoryRuntime } from './runtime.js';
import { agentsDueForCron } from './scheduler.js';

const PORT = parseInt(process.env.PORT || '8088', 10);
const AGENTS_ROOT = process.env.AGENTS_ROOT || fileURLToPath(new URL('../../../agents', import.meta.url));
const TOKEN = process.env.FACTORY_TOKEN;
const VERSION = '0.1.0';
const LEDGER_PATH = process.env.FACTORY_LEDGER_PATH || join(process.cwd(), 'data', 'ledger.jsonl');
const MEMORY_STORE = process.env.MEMORY_STORE_DIR || join(process.cwd(), 'data', 'mind');
const EPHEMERAL = process.env.MEMORY_EPHEMERAL_DIR || join(process.cwd(), 'data', 'ephemeral');
const IDLE_MS = parseInt(process.env.FACTORY_IDLE_MS || '300000', 10);

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

const state: FactoryState = {
  agents: new Map(agents.map((a) => [a.id, a])),
  ledger: new FileLedger(LEDGER_PATH),
  token: TOKEN,
  version: VERSION,
  providers: providersFromEnv(),
  idleMs: IDLE_MS,
  idleTimers: new Map(),
  runtime: memoryRuntime({
    store: { root: MEMORY_STORE },
    ephemeralRoot: EPHEMERAL,
    workerCommand: (agent) => {
      if (process.env.FACTORY_SPAWN_WORKERS !== '1') return undefined;
      if (agent.id === 'echo-agent') {
        return { cmd: 'node', args: [join(agent.dir, 'worker.mjs')] };
      }
      return undefined;
    },
    onExit: (agent, code) => {
      agent.state = code === 0 ? 'IDLE' : 'ERROR';
      state.ledger.append({
        timestamp: new Date().toISOString(),
        agentId: agent.id,
        type: code === 0 ? 'action' : 'crash',
        action: 'EXIT',
        actor: 'runtime',
        requestId: `exit-${Date.now()}`,
      });
      if (code !== 0 && state.agents.has('med-doc')) {
        void apply(state, 'med-doc', 'WORKING', 'RESUME');
      }
    },
  }),
};

process.env.FACTORY_STARTED_AT = String(Date.now());

const server = createFactoryServer(state);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[control-plane] listening on :${PORT} with ${state.agents.size} cartridges`);
});

if (process.env.FACTORY_CRON !== '0') {
  setInterval(() => {
    const due = agentsDueForCron(state.agents.values());
    for (const agent of due) {
      if (agent.state === 'IDLE') void apply(state, agent.id, 'WORKING', 'RESUME');
    }
  }, 60_000);
}
