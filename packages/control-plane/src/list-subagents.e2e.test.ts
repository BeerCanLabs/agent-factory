import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { createFactoryServer, type FactoryState } from './app.js';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';

// E1.3 (#294): an agent lists only the helpers its admin-set policy allows; none without an allow-list entry.
const ADMIN = 'admin-token';

async function call(
  port: number,
  path: string,
  method: string,
  token?: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

describe('list_subagents (E1.3)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const tokens = new RunTokens('list-subagents-run-token-key-0123456789ab');
  const registryDir = mkdtempSync(join(tmpdir(), 'list-subagents-e2e-'));
  const runs: Record<string, { runId: string; token: string }> = {};

  before(async () => {
    state = {
      registryDir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'admin', token: ADMIN, roles: ['admin'] }]),
      version: '0.1.0',
      providers: [],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: tokens,
      approvals: new ApprovalStore(),
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      secretValues: new Set(),
      idleMs: 0,
      idleTimers: new Map(),
    } as unknown as FactoryState;
    for (const id of ['reviewer', 'other']) {
      state.agents.set(id, { id, name: id, state: 'ACTIVE', roles: [], requires: [] } as any);
      const run = state.runs.create({ agentId: id, state: 'WORKING', actor: 'test', trigger: 'api' } as any);
      runs[id] = { runId: run.runId, token: await tokens.mint({ runId: run.runId, agentId: id }) };
    }
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
    for (const id of ['juror', 'scout']) assert.equal((await call(port, '/api/v1/registry/subagents', 'POST', ADMIN, { id, name: id.toUpperCase(), prompt: 'secret prompt' })).status, 201);
    assert.equal((await call(port, '/api/v1/agents/reviewer/policy', 'PUT', ADMIN, { routes: [], subagents: ['juror', 'not-registered'] })).status, 200);
  });
  after(async () => {
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(registryDir, { recursive: true, force: true });
  });

  const mcp = async (id: string, path = '/mcp/run') => {
    const r = await call(port, path, 'POST', runs[id].token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_subagents', arguments: {} } });
    return JSON.parse(r.body.result.content[0].text);
  };

  it('an allowed agent gets exactly its allowed, registered helpers (no prompts) over REST and MCP', async () => {
    const r = await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents`, 'GET', runs.reviewer.token);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { subagents: [{ id: 'juror', name: 'JUROR', approvedModels: [] }] });
    assert.deepEqual(await mcp('reviewer'), r.body);
    assert.doesNotMatch(JSON.stringify(r.body), /secret prompt/);
  });

  it('an agent with no allow-list entry gets an empty list', async () => {
    const r = await call(port, `/api/v1/runs/${runs.other.runId}/subagents`, 'GET', runs.other.token);
    assert.deepEqual(r.body, { subagents: [] });
    assert.deepEqual(await mcp('other'), { subagents: [] });
  });

  it('the run MCP lists the tool; a wrong or missing run token is refused', async () => {
    const list = await call(port, '/mcp/run', 'POST', runs.other.token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(list.body.result.tools.some((t: any) => t.name === 'list_subagents'));
    assert.equal((await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents`, 'GET')).status, 401);
    assert.equal((await call(port, `/api/v1/runs/${runs.reviewer.runId}/subagents`, 'GET', runs.other.token)).status, 401);
  });

  const listCall = (path: string, token?: string, extraHeaders?: Record<string, string>) =>
    call(port, path, 'POST', token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_subagents', arguments: {} } }, extraHeaders);
  const listTools = (path: string, token?: string) =>
    call(port, path, 'POST', token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });

  it('a valid run token on POST /mcp is handled like POST /mcp/run (#510)', async () => {
    assert.deepEqual(await mcp('reviewer', '/mcp'), await mcp('reviewer', '/mcp/run'));
    assert.deepEqual(await mcp('other', '/mcp'), { subagents: [] });
    const denied = await listCall('/mcp');
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error, 'unauthorized');
  });

  it('a run token on /mcp/readonly, /mcp/x/*, or with read-only or toolset headers is still 401 (#510 B2)', async () => {
    const token = runs.reviewer.token;
    for (const path of ['/mcp/readonly', '/mcp/x/all', '/mcp/x/not-a-toolset']) {
      const r = await listCall(path, token);
      assert.equal(r.status, 401, path);
      assert.equal(r.body.error, 'unauthorized', path);
    }
    const readonlyHeader = await listCall('/mcp', token, { 'x-mcp-readonly': 'true' });
    assert.equal(readonlyHeader.status, 401);
    assert.equal(readonlyHeader.body.error, 'unauthorized');
    const toolsetHeader = await listCall('/mcp', token, { 'x-mcp-toolsets': 'all' });
    assert.equal(toolsetHeader.status, 401);
    assert.equal(toolsetHeader.body.error, 'unauthorized');
  });

  it('a refused run token on POST /mcp is 401 invalid_run_token with no OAuth challenge (#510 B3)', async () => {
    const ended = state.runs.create({ agentId: 'reviewer', state: 'WORKING', actor: 'test', trigger: 'api' } as any);
    const endedToken = await tokens.mint({ runId: ended.runId, agentId: 'reviewer' });
    state.runs.update(ended.runId, { state: 'DONE' } as any);
    const endedRes = await listCall('/mcp', endedToken);
    assert.equal(endedRes.status, 401);
    assert.equal(endedRes.body.error, 'invalid_run_token');
    assert.equal(endedRes.headers.get('www-authenticate'), null);

    const wrongAgent = await tokens.mint({ runId: runs.reviewer.runId, agentId: 'other' });
    const wrongRes = await listCall('/mcp', wrongAgent);
    assert.equal(wrongRes.status, 401);
    assert.equal(wrongRes.body.error, 'invalid_run_token');
    assert.equal(wrongRes.headers.get('www-authenticate'), null);

    const endedOnRun = await listCall('/mcp/run', endedToken);
    assert.equal(endedOnRun.status, 401);
    assert.equal(endedOnRun.body.error, 'invalid_run_token');
  });

  it('a forged run token on POST /mcp still gets the OAuth 401; an admin bearer still reaches handleMcp (#510 B3)', async () => {
    const forged = await listCall('/mcp', 'forged-not-a-run-token');
    assert.equal(forged.status, 401);
    assert.equal(forged.body.error, 'unauthorized');
    assert.ok((forged.headers.get('www-authenticate') ?? '').includes('oauth-protected-resource/mcp'));

    const admin = await listTools('/mcp', ADMIN);
    assert.equal(admin.status, 200);
    const adminTools = (admin.body.result?.tools ?? []).map((t: any) => t.name);
    assert.ok(adminTools.length > 4, 'principal MCP exposes more than the run toolset');
    assert.ok(!adminTools.includes('list_subagents'));
    const runTools = await listTools('/mcp', runs.reviewer.token);
    assert.equal(runTools.status, 200);
    const runNames = (runTools.body.result?.tools ?? []).map((t: any) => t.name);
    assert.ok(runNames.includes('list_subagents'));
  });

  it('a throwing run handler on POST /mcp matches POST /mcp/run, with no OAuth challenge (#510 B5)', async () => {
    const orig = state.policies.get.bind(state.policies);
    state.policies.get = (() => { throw new Error('boom'); }) as typeof orig;
    try {
      const onMcp = await listCall('/mcp', runs.reviewer.token);
      const onRun = await listCall('/mcp/run', runs.reviewer.token);
      assert.equal(onMcp.status, onRun.status);
      assert.deepEqual(onMcp.body, onRun.body);
      assert.equal(onMcp.status, 400);
      assert.equal(onMcp.body.error, 'boom');
      assert.equal(onMcp.headers.get('www-authenticate'), null);
    } finally {
      state.policies.get = orig;
    }
  });

  it('a policy with a malformed subagents list is refused', async () => {
    assert.equal((await call(port, '/api/v1/agents/other/policy', 'PUT', ADMIN, { routes: [], subagents: 'juror' })).status, 400);
  });
});
