import { readFileSync } from 'node:fs';
import { RunTokens } from '@beercanlabs/factory-auth';
import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperEgress, type ControlClient, type Route } from './gatekeeper-egress.js';
import type { Price } from './meter.js';
import { parseModelCatalog, type ModelCatalog } from './models.js';
import { traceConfigFromEnv } from './traces.js';
import { initTelemetry } from '@beercanlabs/factory-telemetry';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const FACTORY_URL = required('FACTORY_URL').replace(/\/$/, '');
const TOKEN = required('FACTORY_GATEKEEPER_EGRESS_TOKEN');
const config = process.env.FACTORY_GATEKEEPER_EGRESS_CONFIG
  ? (JSON.parse(readFileSync(process.env.FACTORY_GATEKEEPER_EGRESS_CONFIG, 'utf8')) as { routes?: Route[]; prices?: Record<string, Price>; models?: ModelCatalog })
  : { routes: JSON.parse(process.env.FACTORY_GATEKEEPER_EGRESS_ROUTES ?? '[]') as Route[], prices: JSON.parse(process.env.FACTORY_PRICES ?? '{}') as Record<string, Price> };
// Offered models (§6.9 M3): FACTORY_MODEL_CATALOG wins over a config file's `models`.
const modelCatalog = process.env.FACTORY_MODEL_CATALOG ? parseModelCatalog(process.env.FACTORY_MODEL_CATALOG) : parseModelCatalog(JSON.stringify(config.models ?? {}));

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${FACTORY_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

// Circuit breaker: track Control Plane ledger health so the gatekeeper-egress can refuse
// to proxy when the audit trail is unreachable, rather than crashing.
let _ledgerUp = true;
let _lastLedgerFailure = 0;
const LEDGER_PROBE_INTERVAL_MS = 5_000;

const control: ControlClient = {
  ledgerAvailable() {
    if (_ledgerUp) return true;
    // Half-open: allow a probe attempt after cooldown so recovery is automatic.
    return Date.now() - _lastLedgerFailure > LEDGER_PROBE_INTERVAL_MS;
  },
  async runContext(runId) {
    const res = await call('GET', `/api/v1/gatekeeper-egress/runs/${encodeURIComponent(runId)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`control plane ${res.status}`);
    return res.json() as never;
  },
  async requestApproval(req) {
    const res = await call('POST', '/api/v1/gatekeeper-egress/approvals', req);
    if (!res.ok) throw new Error(`approval request ${res.status}`);
    return res.json() as never;
  },
  async holdRequest(req) {
    const res = await call('POST', '/api/v1/gatekeeper-egress/holds', req);
    if (!res.ok) throw new Error(`hold request ${res.status}`);
    return res.json() as never;
  },
  async consumeApproval(id) {
    return (await call('POST', `/api/v1/gatekeeper-egress/approvals/${encodeURIComponent(id)}/consume`)).ok;
  },
  async connectionToken(req) {
    const res = await call('POST', '/api/v1/gatekeeper-egress/connections/token', req);
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && typeof body.accessToken === 'string' && typeof body.expiresAt === 'string') {
      return { ok: true, accessToken: body.accessToken, expiresAt: body.expiresAt };
    }
    return {
      ok: false,
      status: res.status,
      error: typeof body.error === 'string' ? body.error : `control_plane_${res.status}`,
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      connectUrl: typeof body.connectUrl === 'string' ? body.connectUrl : undefined,
    };
  },
  // Run progress (§6.5): best effort, batched by the emitter, one request in flight. Never touches the ledger
  // circuit breaker: a lost progress batch is not a lost audit row.
  async progress(events) {
    const res = await call('POST', '/api/v1/gatekeeper-egress/progress', { events });
    if (!res.ok) throw new Error(`control plane ${res.status}`);
    await res.body?.cancel();
  },
  async ledger(event) {
    try {
      const res = await call('POST', '/api/v1/ledger', event);
      if (!res.ok) {
        console.error(`[gatekeeper-egress] ledger write rejected: ${res.status}`);
        _ledgerUp = false;
        _lastLedgerFailure = Date.now();
        return;
      }
      if (!_ledgerUp) console.log('[gatekeeper-egress] ledger connection recovered');
      _ledgerUp = true;
    } catch (err) {
      console.error(`[gatekeeper-egress] ledger write failed: ${err instanceof Error ? err.message : String(err)}`);
      _ledgerUp = false;
      _lastLedgerFailure = Date.now();
    }
  },
};

const server = createGatekeeperEgress({
  routes: config.routes ?? [],
  prices: config.prices ?? {},
  runTokens: new RunTokens(required('FACTORY_RUN_TOKEN_KEY')),
  control,
  providers: providersFromEnv(),
  traces: traceConfigFromEnv(),
  meter: initTelemetry('factory-gatekeeper-egress', '0.1.0').meter,
  modelCatalog,
  defaultModel: process.env.FACTORY_DEFAULT_MODEL || undefined,
});

const port = parseInt(process.env.PORT || '8081', 10);
server.listen(port, '0.0.0.0', () => {
  console.log(`[gatekeeper-egress] :${port} routes=${(config.routes ?? []).map((r) => r.id).join(',') || '(none)'} models=${Object.keys(modelCatalog).join(',') || '(none)'}`);
});
