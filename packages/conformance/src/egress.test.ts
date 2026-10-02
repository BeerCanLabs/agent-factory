// DESIGN_AUTHORITY.md §6.3.1 — egress invariants E1–E6.
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type RunContext } from '@beercanlabs/factory-gatekeeper-egress';
import { gatekeeperEgressEnv } from '@beercanlabs/factory-hydrate';
import { expectOnlyBaselined, files, read, type Violation } from './support.js';

const MODEL_HOSTS = [/bedrock-runtime\./, /api\.anthropic\.com/, /api\.openai\.com/, /api\.x\.ai/, /generativelanguage\.googleapis\.com/, /aiplatform\.googleapis\.com/, /openai\.azure\.com/];
const ALLOWED_NO_PROXY = new Set(['localhost', '127.0.0.1', '.internal', '169.254.169.254', '169.254.170.2']);

/** Hosts a landing zone grants every agent for CONNECT tunnels (FACTORY_EGRESS_HOSTS). */
function landingZoneEgressHosts(): Violation[] {
  const out: Violation[] = [];
  for (const f of files('landing-zones', (p) => /\.(tf|ya?ml|env)$/.test(p))) {
    const text = read(f);
    for (const m of text.matchAll(/FACTORY_EGRESS_HOSTS[\s\S]*?(?:\]\)|\n\s*\n|$)/g)) {
      for (const h of m[0].matchAll(/"([^"\s,]+\.[^"\s,]+)"/g)) out.push({ rule: '', where: f, detail: h[1] });
    }
  }
  return out;
}

describe('E1 single egress path', () => {
  it('agents may bypass the gatekeeper-egress only for loopback, .internal, and metadata addresses', () => {
    const env = gatekeeperEgressEnv({ FACTORY_GATEKEEPER_EGRESS_URL: 'http://gw:8081', FACTORY_RUN_TOKEN: 't' });
    for (const k of ['NO_PROXY', 'no_proxy']) {
      const extra = env[k].split(',').filter((e) => !ALLOWED_NO_PROXY.has(e));
      assert.deepEqual(extra, [], `${k} lets agents bypass the gatekeeper-egress`);
    }
    assert.ok(env.HTTPS_PROXY && env.HTTP_PROXY, 'agents must be pointed at the gatekeeper-egress');
  });

  it('nothing else sets NO_PROXY for agents', () => {
    const offenders = files('packages', (p) => /\/src\/.*\.ts$/.test(p) && !p.endsWith('.test.ts'))
      .concat(files('landing-zones', (p) => /\.(tf|ya?ml)$/.test(p)))
      .filter((f) => f !== 'packages/hydrate/src/gatekeeper-egress-env.ts' && /\bNO_PROXY\b/i.test(read(f)));
    assert.deepEqual(offenders, []);
  });
});

describe('E5 every model call is metered', () => {
  it('no landing zone grants tunnel access to a model provider host', () => {
    const found = landingZoneEgressHosts().filter((v) => MODEL_HOSTS.some((re) => re.test(v.detail)));
    expectOnlyBaselined('E5', found.map((v) => ({ ...v, rule: 'E5' })));
  });
});

describe('§6.6 mind storage belongs to the shim', () => {
  it('no landing zone grants cartridges tunnel access to object storage', () => {
    const found = landingZoneEgressHosts().filter((v) => /(\.s3[.-]|storage\.googleapis\.com|blob\.core\.windows\.net)/.test(v.detail));
    expectOnlyBaselined('M1', found.map((v) => ({ ...v, rule: 'M1' })));
  });
});

describe('E6 network-enforced (AWS landing zone)', () => {
  const network = read('landing-zones/aws/network.tf');
  it('the agent route table has no routes', () => {
    const table = network.match(/resource "aws_route_table" "agents" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(table, 'agent route table not found');
    assert.doesNotMatch(table, /\broute\s*\{/);
    assert.doesNotMatch(network, /route_table_id\s*=\s*aws_route_table\.agents\.id[\s\S]{0,200}(gateway_id|nat_gateway_id)/);
  });
  it('agents get no public IP', () => {
    assert.match(read('landing-zones/aws/ecs.tf'), /FACTORY_ECS_ASSIGN_PUBLIC_IP", value = "false"/);
  });
  it('the agent security group has no open egress', () => {
    for (const m of network.matchAll(/resource "aws_vpc_security_group_egress_rule" "[^"]+" \{[\s\S]*?\n\}/g)) {
      if (/security_group_id\s*=\s*aws_security_group\.agents\.id/.test(m[0])) assert.doesNotMatch(m[0], /0\.0\.0\.0\/0/);
    }
  });
});

describe('LG1 single ledger writer (AWS landing zone)', () => {
  it('the control plane deploys stop-then-start, never side by side', () => {
    const svc = read('landing-zones/aws/ecs.tf').match(/resource "aws_ecs_service" "control_plane" \{[\s\S]*?\n\}/)?.[0] ?? '';
    assert.ok(svc, 'control-plane service not found');
    assert.match(svc, /deployment_minimum_healthy_percent\s*=\s*0\b/);
    assert.match(svc, /deployment_maximum_percent\s*=\s*100\b/);
  });
  it('the control plane takes the ledger lease before opening the ledger', () => {
    const src = read('packages/control-plane/src/index.ts');
    const lease = src.indexOf('ledgerLease.acquire()');
    const open = src.indexOf('new FileLedger(');
    assert.ok(lease > 0 && open > lease, 'lease must be acquired before the ledger is opened');
  });
});

describe('E2–E4 the gatekeeper-egress attributes, ledgers, and gates every egress path', { concurrency: false }, () => {
  const tokens = new RunTokens('conformance-run-token-key-0123456789');
  const ledger: Array<Record<string, unknown>> = [];
  let ctx: RunContext;
  let token = '';
  let seq = 0;
  let upstream: http.Server;
  let upPort = 0;
  let gatekeeperEgress: http.Server;
  let port = 0;

  const control: ControlClient = {
    async runContext(runId) {
      return runId === ctx.run.runId ? structuredClone(ctx) : null;
    },
    async requestApproval() {
      throw new Error('not used');
    },
    async consumeApproval() {
      return false;
    },
    async ledger(event) {
      ledger.push(event);
    },
  };

  const listen = async (s: http.Server) => {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as net.AddressInfo).port;
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  /** Raw proxy request: CONNECT or absolute-URI forward proxy. Returns the status line. */
  const proxy = (line: string, auth?: string) =>
    new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(`${line}\r\nHost: x\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`));
      s.once('data', (b) => {
        resolve(b.toString().split('\r\n')[0]);
        s.destroy();
      });
    });
  const route = (auth?: string) =>
    new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/svc/ping', method: 'GET', headers: auth ? { authorization: auth } : {} }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });

  before(async () => {
    upstream = http.createServer((_req, res) => res.end('{}'));
    upPort = await listen(upstream);
    gatekeeperEgress = createGatekeeperEgress({
      routes: [{ id: 'svc', kind: 'http', upstream: `http://127.0.0.1:${upPort}` }],
      prices: {},
      runTokens: tokens,
      control,
      providers: [],
      contextTtlMs: 0,
    });
    port = await listen(gatekeeperEgress);
  });
  after(async () => {
    await new Promise<void>((r) => gatekeeperEgress.close(() => r()));
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  beforeEach(async () => {
    ledger.length = 0;
    const runId = `run-${++seq}`;
    ctx = { run: { runId, agentId: 'agent-x', state: 'WORKING', live: true }, agentState: 'WORKING', policy: { routes: ['svc'], hosts: ['127.0.0.1'] }, spend: { run: 0, day: 0, month: 0 } };
    token = await tokens.mint({ runId, agentId: 'agent-x' });
  });

  const basic = () => `Basic ${Buffer.from(`run:${token}`).toString('base64')}`;

  it('E2: every path rejects a request without a run token', async () => {
    assert.equal(await route(), 401);
    assert.match(await proxy(`CONNECT 127.0.0.1:${upPort} HTTP/1.1`), / 401 /);
    assert.match(await proxy(`GET http://127.0.0.1:${upPort}/ HTTP/1.1`), / 401 /);
  });

  it('E3: every allowed path writes a ledger row attributed to the run', async () => {
    assert.equal(await route(`Bearer ${token}`), 200);
    assert.match(await proxy(`CONNECT 127.0.0.1:${upPort} HTTP/1.1`, basic()), / 200 /);
    assert.match(await proxy(`GET http://127.0.0.1:${upPort}/ HTTP/1.1`, basic()), / 200 /);
    await settle();
    const rows = ledger.filter((e) => e.runId === ctx.run.runId && e.agentId === 'agent-x');
    assert.ok(rows.some((e) => e.action === 'EGRESS_TUNNEL' && e.host === '127.0.0.1'), 'CONNECT tunnel not ledgered with its host');
    assert.ok(rows.some((e) => e.action === 'EGRESS_PROXY'), 'forward proxy not ledgered');
    assert.ok(rows.length >= 3, 'route call not ledgered');
  });

  it('E3/E4: a denied host is refused and ledgered', async () => {
    assert.match(await proxy('CONNECT evil.example:443 HTTP/1.1', basic()), / 403 /);
    await settle();
    assert.ok(ledger.some((e) => String(e.action).startsWith('EGRESS_DENIED_HOST')));
  });

  it('E4: an isolated agent cannot egress on any path', async () => {
    ctx.agentState = 'ISOLATED';
    assert.notEqual(await route(`Bearer ${token}`), 200);
    assert.match(await proxy(`CONNECT 127.0.0.1:${upPort} HTTP/1.1`, basic()), / 403 /);
    assert.match(await proxy(`GET http://127.0.0.1:${upPort}/ HTTP/1.1`, basic()), / 403 /);
  });
});

describe('E10 systems are factory data', () => {
  it('no landing zone declares non-model routes or deprecated extra route variables', () => {
    // Assert no landing zone declares extra_gatekeeper_egress_routes or extra_provider_secret_names
    for (const f of files('landing-zones', (p) => /\.(tf|ya?ml|env)$/.test(p))) {
      const text = read(f);
      assert.doesNotMatch(text, /\bextra_gatekeeper_egress_routes\b/, `${f} must not declare extra_gatekeeper_egress_routes`);
      assert.doesNotMatch(text, /\bextra_provider_secret_names\b/, `${f} must not declare extra_provider_secret_names`);
    }

    // Assert no landing zone defines a non-model route (kind !== 'llm' and kind !== 'models')
    for (const f of files('landing-zones', (p) => /\.(tf|ya?ml)$/.test(p))) {
      const text = read(f);
      for (const m of text.matchAll(/gatekeeper_egress_routes[\s\S]*?default\s*=\s*"(\[[^"]+\])"/g)) {
        const rawJson = m[1].replace(/\\"/g, '"');
        try {
          const routes = JSON.parse(rawJson);
          for (const r of routes) {
            assert.ok(
              r.kind === 'llm' || r.kind === 'models',
              `${f} defines non-model route '${r.id}' (kind: '${r.kind}'). Systems must be factory data (E10).`
            );
          }
        } catch (e: any) {
          assert.fail(`Failed to parse gatekeeper_egress_routes in ${f}: ${e.message}`);
        }
      }
    }
  });
});

