import { readFileSync } from 'node:fs';
import { RunTokens } from '@beercanlabs/factory-auth';
import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { createGateway, type ControlClient, type Route } from './gateway.js';
import type { Price } from './meter.js';
import { traceConfigFromEnv } from './traces.js';
import { initTelemetry } from '@beercanlabs/factory-telemetry';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const FACTORY_URL = required('FACTORY_URL').replace(/\/$/, '');
const TOKEN = required('FACTORY_GATEWAY_TOKEN');
const config = process.env.FACTORY_GATEWAY_CONFIG
  ? (JSON.parse(readFileSync(process.env.FACTORY_GATEWAY_CONFIG, 'utf8')) as { routes?: Route[]; prices?: Record<string, Price> })
  : { routes: JSON.parse(process.env.FACTORY_GATEWAY_ROUTES ?? '[]') as Route[], prices: JSON.parse(process.env.FACTORY_PRICES ?? '{}') as Record<string, Price> };

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${FACTORY_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

const control: ControlClient = {
  async runContext(runId) {
    const res = await call('GET', `/api/v1/gateway/runs/${encodeURIComponent(runId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`control plane ${res.status}`);
    return res.json() as never;
  },
  async requestApproval(req) {
    const res = await call('POST', '/api/v1/gateway/approvals', req);
    if (!res.ok) throw new Error(`approval request ${res.status}`);
    return res.json() as never;
  },
  async consumeApproval(id) {
    return (await call('POST', `/api/v1/gateway/approvals/${encodeURIComponent(id)}/consume`)).ok;
  },
  async ledger(event) {
    const res = await call('POST', '/api/v1/ledger', event);
    if (!res.ok) throw new Error(`ledger ${res.status}`);
  },
};

const server = createGateway({
  routes: config.routes ?? [],
  prices: config.prices ?? {},
  runTokens: new RunTokens(required('FACTORY_RUN_TOKEN_KEY')),
  control,
  providers: providersFromEnv(),
  traces: traceConfigFromEnv(),
  meter: initTelemetry('factory-gateway', '0.1.0').meter,
});

const port = parseInt(process.env.PORT || '8081', 10);
server.listen(port, '0.0.0.0', () => {
  console.log(`[gateway] :${port} routes=${(config.routes ?? []).map((r) => r.id).join(',') || '(none)'}`);
});
