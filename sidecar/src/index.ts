import { secretValuesFromEnv } from '@beercanlabs/factory-ledger';
import { KillSwitch } from './killswitch.js';
import { Ledger } from './ledger.js';
import { createProxyServer } from './proxy.js';
import { createControlServer } from './server.js';
import { garrisonFromEnv, pushHeartbeat } from './garrison.js';
import { traceConfigFromEnv } from './traces.js';

const AGENT_ID = process.env.AGENT_ID || 'agent';
const AGENT_NAME = process.env.AGENT_NAME || AGENT_ID;
const PORT = parseInt(process.env.PORT || '9090', 10);
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '8080', 10);
const UPSTREAM = process.env.UPSTREAM_LLM_BASE_URL || process.env.OPENAI_BASE_URL || 'http://127.0.0.1:9';
const LEDGER_URL = process.env.FACTORY_LEDGER_URL;
const TOKEN = process.env.SIDECAR_TOKEN;
const VERSION = '0.1.0';

if (process.env.AGENT_CMD) {
  console.warn('[factory-sidecar] AGENT_CMD is ignored. The sidecar is not the agent PID 1.');
}

const secrets = secretValuesFromEnv();
const traces = traceConfigFromEnv();
const killSwitch = new KillSwitch(parseInt(process.env.THROTTLE_TPM || '60', 10));
const ledger = new Ledger(AGENT_ID, LEDGER_URL, process.env.FACTORY_TOKEN || TOKEN, secrets);
const garrison = garrisonFromEnv(process.env);

const control = createControlServer({
  agentId: AGENT_ID,
  agentName: AGENT_NAME,
  token: TOKEN,
  killSwitch,
  ledger,
  version: VERSION,
  traces,
});

const proxy = createProxyServer({
  upstream: UPSTREAM,
  killSwitch,
  ledger,
  secrets,
  traces,
});

control.listen(PORT, '0.0.0.0', () => {
  console.log(`[factory-sidecar] control/health on :${PORT} (agent ${AGENT_NAME})`);
});

proxy.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[factory-sidecar] intercept proxy on :${PROXY_PORT} -> ${UPSTREAM}`);
});

setInterval(() => {
  const state = killSwitch.mode === 'LIVE' ? 'WORKING' : killSwitch.mode;
  void pushHeartbeat(garrison, state, {
    tokensPerMinute: killSwitch.tokensPerMinute,
    memoryUsageMb: Math.round(process.memoryUsage().heapUsed / (1024 * 1024)),
  });
}, 4000);
