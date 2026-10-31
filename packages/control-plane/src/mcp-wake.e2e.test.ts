import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelStore } from './models.js';
import { IdentityLinkStore } from './identity-links.js';
import { FileConfigBackend, VersionedConfigStore } from '@beercanlabs/factory-registrar';

// E4.1 (#300): MCP wake_agent accepts model and input and starts the run through the same path as REST.
const ADMIN = 'admin-token';

async function call(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('MCP wake_agent matches REST (E4.1)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  let n = 0;
  let tmp = '';

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-wake-e2e-'));
    state = {
      agents: new Map(),
      modelStore: new ModelStore(join(tmp, 'catalog.json'), {
        'claude-haiku': { provider: 'bedrockConverse', id: 'haiku-id', price: { inputPerMTok: 1, outputPerMTok: 5 } },
        'claude-sonnet': { provider: 'bedrockConverse', id: 'sonnet-id', price: { inputPerMTok: 3, outputPerMTok: 15 } },
      }),
      defaultModel: 'claude-haiku',
      identityLinks: new IdentityLinkStore(join(tmp, 'identity')),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('mcp-wake-run-token-key-0123456789abc'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    state.configs = await VersionedConfigStore.open(new FileConfigBackend(join(tmp, 'configs')));
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  function freshAgent(): string {
    const id = `agent-${++n}`;
    state.agents.set(id, { id, name: id, state: 'ACTIVE', roles: [], requires: [] } as any);
    state.policies.set(id, { models: ['claude-haiku', 'claude-sonnet'] } as any);
    return id;
  }
  async function mcpWake(args: Record<string, unknown>) {
    const r = await call(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wake_agent', arguments: args } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return JSON.parse(r.body.result.content[0].text);
  }
  const shape = (run: any) => ({ state: run.state, model: run.model, input: run.input, actor: run.actor, error: run.error });

  it('lists model and input on the wake_agent tool', async () => {
    const r = await call(port, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const tool = r.body.result.tools.find((t: any) => t.name === 'wake_agent');
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['id', 'input', 'model']);
    assert.deepEqual(tool.inputSchema.required, ['id']);
  });

  it('pins the model and passes the input, producing the same run record as REST', async () => {
    const input = { task: 'review', turnId: 'forged', replyTo: 'forged', caller: 'forged', factoryKind: 'forged' };
    const viaMcp = await mcpWake({ id: freshAgent(), model: 'claude-sonnet', input });
    const viaRest = (await call(port, `/api/v1/agents/${freshAgent()}/runs`, { model: 'claude-sonnet', input })).body;
    assert.equal(viaMcp.model, 'claude-sonnet');
    assert.deepEqual(viaMcp.input, { task: 'review' });
    assert.equal(viaMcp.trigger, 'mcp');
    assert.deepEqual(shape(viaMcp), shape(viaRest));
    assert.deepEqual(state.runs.get(viaMcp.runId)?.input, { task: 'review' });
  });

  it('without model or input behaves as before (unpinned, no input)', async () => {
    const run = await mcpWake({ id: freshAgent() });
    assert.ok(run.runId);
    assert.equal(run.model, undefined);
    assert.equal(run.input, undefined);
  });

  it('refuses a malformed model exactly as REST does, and starts no run', async () => {
    for (const model of ['bad model!', 42, 'x'.repeat(129)]) {
      const id = freshAgent();
      const viaMcp = await mcpWake({ id, model });
      const viaRest = await call(port, `/api/v1/agents/${id}/runs`, { model });
      assert.equal(viaRest.status, 400);
      assert.deepEqual(viaMcp, viaRest.body);
      assert.equal(state.runs.list({ agentId: id }).length, 0);
    }
  });

  // REST does not refuse at start: an unapproved pin is refused by gatekeeper egress on the first model call. MCP must match.
  it('an unapproved model gets the same outcome as REST', async () => {
    const viaMcp = await mcpWake({ id: freshAgent(), model: 'claude-opus' });
    const viaRest = (await call(port, `/api/v1/agents/${freshAgent()}/runs`, { model: 'claude-opus' })).body;
    assert.deepEqual(shape(viaMcp), shape(viaRest));
  });
});
