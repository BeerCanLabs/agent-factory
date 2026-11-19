// GAP-258, TSK-344: GitHub App webhooks into an agent's own /hooks/:agentId: the event and delivery travel with the
// run, a conductor gets one mapped conductor event, the app's webhook secret signs the config-only path, and a
// delivery id starts at most one run.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFactoryServer, type FactoryState } from './app.js';
import { conductorEventFor, DeliveryLog, opsEventFor } from './github-webhooks.js';
import { MemoryLedger } from '@beercanlabs/factory-ledger';
import { bearerAuth, RunTokens } from '@beercanlabs/factory-auth';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { PolicyStore } from '@beercanlabs/factory-gatekeeper/policy';
import { SpendTracker } from '@beercanlabs/factory-budget';
import { ApprovalStore } from '@beercanlabs/factory-bouncer';
import { MemoryRunStore, noopRuntime } from '@beercanlabs/factory-property-manager';

const SHA = 'a'.repeat(40);
const repo = { full_name: 'BeerCanLabs/sdlc-sandbox' };

describe('conductorEventFor maps GitHub events to sdlc-on-event events', () => {
  const map = (event: string, payload: unknown, self?: string | string[]) => conductorEventFor(event, payload, self);
  it('issues: a plan issue is plan-submitted; any other new issue is issue-opened', () => {
    assert.deepEqual(map('issues', { action: 'opened', repository: repo, issue: { number: 3, labels: [{ name: 'sdlc:plan' }] } }), { event: { type: 'plan-submitted', repo: repo.full_name, issue: 3 } });
    assert.deepEqual(map('issues', { action: 'labeled', label: { name: 'sdlc:plan' }, repository: repo, issue: { number: 3, labels: [] } }), { event: { type: 'plan-submitted', repo: repo.full_name, issue: 3 } });
    assert.deepEqual(map('issues', { action: 'opened', repository: repo, issue: { number: 4, labels: [] } }), { event: { type: 'issue-opened', repo: repo.full_name, issue: 4 } });
    assert.deepEqual(map('issues', { action: 'labeled', label: { name: 'triage:story' }, repository: repo, issue: { number: 4 } }), { event: { type: 'triage-result', repo: repo.full_name, issue: 4 } });
    assert.deepEqual(map('issues', { action: 'labeled', label: { name: 'ready' }, repository: repo, issue: { number: 4 } }), { event: { type: 'story-ready', repo: repo.full_name } });
    assert.ok('ignored' in map('issues', { action: 'closed', repository: repo, issue: { number: 4 } }));
  });
  it("the agent's own labels and comments never wake it again", () => {
    assert.ok('ignored' in map('issues', { action: 'labeled', label: { name: 'sdlc:plan' }, sender: { login: 'flow-app[bot]' }, repository: repo, issue: { number: 3 } }, 'flow-app[bot]'));
    assert.ok('ignored' in map('issue_comment', { action: 'created', sender: { login: 'Flow-App[bot]' }, repository: repo, issue: { number: 3 }, comment: { id: 9, body: '/approve' } }, 'flow-app[bot]'));
    // ...but its merges still do: the next story hangs on them.
    assert.deepEqual(map('pull_request', { action: 'closed', sender: { login: 'flow-app[bot]' }, repository: repo, pull_request: { number: 7, merged: true, head: { ref: 'sdlc/story-1' } } }, 'flow-app[bot]'), { event: { type: 'pr-merged', repo: repo.full_name, pr: 7 } });
  });
  it('jury #522 G1: with an app per owner, every one of the agent\'s apps is self', () => {
    const selves = ['flow-bcl[bot]', 'flow-getdraft[bot]'];
    assert.ok('ignored' in map('issue_comment', { action: 'created', sender: { login: 'Flow-GetDraft[bot]' }, repository: repo, issue: { number: 3 }, comment: { id: 9, body: '/approve' } }, selves));
    assert.ok('ignored' in map('issues', { action: 'labeled', label: { name: 'sdlc:plan' }, sender: { login: 'flow-bcl[bot]' }, repository: repo, issue: { number: 3 } }, selves));
    assert.ok('event' in map('issue_comment', { action: 'created', sender: { login: 'dale' }, repository: repo, issue: { number: 3 }, comment: { id: 9, body: '/approve' } }, selves));
    assert.ok('event' in map('issue_comment', { action: 'created', sender: { login: '' }, repository: repo, issue: { number: 3 }, comment: { id: 9, body: '/approve' } }, ['']), 'an empty login is never self');
  });
  it('pull requests, reviews and CI', () => {
    assert.deepEqual(map('pull_request', { action: 'synchronize', repository: repo, pull_request: { number: 7 } }), { event: { type: 'pr-updated', repo: repo.full_name, pr: 7 } });
    assert.deepEqual(map('pull_request', { action: 'closed', repository: repo, pull_request: { number: 8, merged: true, head: { ref: 'sdlc/plan-x' } } }), { event: { type: 'plan-merged', repo: repo.full_name, pr: 8 } });
    assert.deepEqual(map('pull_request', { action: 'closed', repository: repo, pull_request: { number: 8, merged: false } }), { event: { type: 'review-outcome', repo: repo.full_name, pr: 8 } });
    assert.deepEqual(map('pull_request', { action: 'labeled', label: { name: 'needs-split' }, repository: repo, pull_request: { number: 8 } }), { event: { type: 'review-outcome', repo: repo.full_name, pr: 8 } });
    assert.deepEqual(map('issue_comment', { action: 'created', repository: repo, issue: { number: 7, pull_request: {} }, comment: { id: 5, body: 'clean\n<!-- sdlc-review: {} -->' } }), { event: { type: 'review-outcome', repo: repo.full_name, pr: 7 } });
    assert.deepEqual(map('issue_comment', { action: 'created', repository: repo, issue: { number: 7 }, comment: { id: 5, body: '/approve cap $2,500' } }), { event: { type: 'approval-signal', repo: repo.full_name, number: 7, comment_id: 5 } });
    assert.deepEqual(map('check_suite', { action: 'completed', repository: repo, check_suite: { head_sha: SHA } }), { event: { type: 'check-completed', repo: repo.full_name, sha: SHA } });
    assert.deepEqual(map('status', { state: 'success', sha: SHA, repository: repo }), { event: { type: 'check-completed', repo: repo.full_name, sha: SHA } });
    assert.ok('ignored' in map('status', { state: 'pending', sha: SHA, repository: repo }));
    assert.ok('ignored' in map('check_run', { action: 'completed', repository: repo, check_run: { head_sha: SHA } }), 'one wake per CI result (the suite), not per job');
    assert.ok('ignored' in map('ping', { zen: 'x' }));
    assert.ok('ignored' in map('issue_comment', { action: 'created', repository: repo, issue: { number: 7 }, comment: { id: 5, body: 'just chatting' } }));
  });
});

describe('DeliveryLog survives a restart and releases a failed claim', () => {
  it('claims once, remembers the run, and forgets a released claim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deliveries-'));
    try {
      const a = new DeliveryLog(dir);
      assert.equal(a.claim('flow', 'd-1'), undefined);
      a.done('flow', 'd-1', 'run-1');
      assert.equal(new DeliveryLog(dir).claim('flow', 'd-1')?.runId, 'run-1');
      assert.equal(a.claim('flow', 'd-2'), undefined);
      a.release('flow', 'd-2');
      assert.equal(new DeliveryLog(dir).claim('flow', 'd-2'), undefined);
      assert.equal(a.claim('other', 'd-1'), undefined, 'per agent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('/hooks/:agentId with GitHub App deliveries (GAP-258)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const dir = mkdtempSync(join(tmpdir(), 'gh-hooks-'));
  const APP_SECRET = 'example-app-webhook-secret-0123456789'; // secret-scan:allow
  const HOOK_SECRET = 'example-cartridge-hook-secret-abcdef'; // secret-scan:allow
  const agent = (id: string, extra: Record<string, unknown>) => ({ id, name: id, role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: `/agents/${id}`, ...extra });

  before(async () => {
    state = {
      registryDir: dir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'operator', token: 'operator-token', roles: ['operator'] }]),
      version: '0.1.0-test',
      providers: [envProvider({
        GITHUB_APP_BEERCANLABS_CONDUCTOR_WEBHOOK_SECRET: APP_SECRET,
        GITHUB_APP_BEERCANLABS_CONDUCTOR_SLUG: 'flow-app',
        GITHUB_APP_BEERCANLABS_CODER_WEBHOOK_SECRET: APP_SECRET,
        GITHUB_APP_SLUGLESS_WEBHOOK_SECRET: APP_SECRET,
        GITHUB_APP_TRIGGERED_WEBHOOK_SECRET: APP_SECRET,
        GITHUB_APP_TRIGGERED_SLUG: 'triggered-app',
        HOOK_SECRET,
      })],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('test-run-token-key-01234567890123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;
    state.agents.set('beercanlabs-conductor', agent('beercanlabs-conductor', { skillIds: ['sdlc-conductor'] }) as never);
    state.agents.set('beercanlabs-coder', agent('beercanlabs-coder', {}) as never);
    state.agents.set('slugless', agent('slugless', { skillIds: ['sdlc-conductor'] }) as never);
    state.agents.set('triggered', agent('triggered', { skillIds: ['sdlc-conductor'], triggers: [{ type: 'webhook', path: '/hooks/triggered', secretRef: 'HOOK_SECRET' }] }) as never);
    state.agents.set('hooked', agent('hooked', { triggers: [{ type: 'webhook', path: '/hooks/hooked', secretRef: 'HOOK_SECRET' }] }) as never);
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const hook = async (id: string, event: string, delivery: string | undefined, payload: unknown, secret = APP_SECRET, extra: Record<string, string> = {}) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`, ...extra };
    if (delivery) headers['x-github-delivery'] = delivery;
    const r = await fetch(`http://127.0.0.1:${port}/hooks/${id}`, { method: 'POST', headers, body });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const runsOf = (id: string) => state.runs.list({ agentId: id });

  it("a conductor's own app wakes it with one conductor event, the event and delivery in the run input", async () => {
    const r = await hook('beercanlabs-conductor', 'issues', '11111111-aaaa-bbbb-cccc-000000000001', { action: 'opened', repository: repo, issue: { number: 12, labels: [] } });
    assert.equal(r.status, 202);
    const run = state.runs.get(r.body.runId)!;
    const input = run.input as Record<string, any>;
    assert.deepEqual(input.event, { type: 'issue-opened', repo: repo.full_name, issue: 12 });
    assert.equal(input.githubEvent, 'issues');
    assert.equal(input.githubDelivery, '11111111-aaaa-bbbb-cccc-000000000001');
    assert.match(input.message, /Call sdlc-on-event with exactly these arguments/);
  });

  it('a redelivered delivery id starts no second run and answers with the first', async () => {
    const before = runsOf('beercanlabs-conductor').length;
    const payload = { action: 'synchronize', repository: repo, pull_request: { number: 9 } };
    const first = await hook('beercanlabs-conductor', 'pull_request', '11111111-aaaa-bbbb-cccc-000000000002', payload);
    const again = await hook('beercanlabs-conductor', 'pull_request', '11111111-aaaa-bbbb-cccc-000000000002', payload);
    assert.equal(first.status, 202);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.runId, first.body.runId);
    assert.equal(runsOf('beercanlabs-conductor').length, before + 1);
    assert.ok((state.ledger as any).events.some((e: any) => e.action === 'WEBHOOK_DUPLICATE'));
  });

  it('an event with no conductor mapping starts nothing', async () => {
    const before = runsOf('beercanlabs-conductor').length;
    const r = await hook('beercanlabs-conductor', 'check_run', '11111111-aaaa-bbbb-cccc-000000000003', { action: 'completed', repository: repo, check_run: { head_sha: SHA } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, true);
    assert.equal(runsOf('beercanlabs-conductor').length, before);
  });

  it('the signature still decides: a wrong secret, a missing signature or the legacy header is refused', async () => {
    const payload = { action: 'opened', repository: repo, issue: { number: 13 } };
    assert.equal((await hook('beercanlabs-conductor', 'issues', undefined, payload, 'wrong-secret-0123456789')).status, 401);
    const body = JSON.stringify(payload);
    const legacy = await fetch(`http://127.0.0.1:${port}/hooks/beercanlabs-conductor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-factory-secret': APP_SECRET }, body });
    assert.equal(legacy.status, 401, 'the app path takes only an HMAC signature');
    const noEvent = await fetch(`http://127.0.0.1:${port}/hooks/beercanlabs-conductor`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` }, body });
    assert.equal(noEvent.status, 401, 'without a GitHub event header there is no app path');
  });

  it("another fleet app's events reach its agent but start nothing (only the conductor takes events)", async () => {
    const r = await hook('beercanlabs-coder', 'issues', '11111111-aaaa-bbbb-cccc-000000000004', { action: 'opened', repository: repo, issue: { number: 14 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ignored, true);
    assert.equal(runsOf('beercanlabs-coder').length, 0);
  });

  it('a cartridge webhook keeps its payload and gains githubEvent and githubDelivery', async () => {
    const r = await hook('hooked', 'push', '11111111-aaaa-bbbb-cccc-000000000005', { ref: 'refs/heads/main' }, HOOK_SECRET);
    assert.equal(r.status, 202);
    assert.deepEqual(state.runs.get(r.body.runId)!.input, { ref: 'refs/heads/main', githubEvent: 'push', githubDelivery: '11111111-aaaa-bbbb-cccc-000000000005' });
    const again = await hook('hooked', 'push', '11111111-aaaa-bbbb-cccc-000000000005', { ref: 'refs/heads/main' }, HOOK_SECRET);
    assert.equal(again.body.duplicate, true);
  });
  it('the legacy header never maps an event; a conductor with a cartridge trigger still gets its own app\'s events', async () => {
    const payload = { action: 'created', repository: repo, issue: { number: 7 }, comment: { id: 5, body: '/approve cap $2,500' } };
    const body = JSON.stringify(payload);
    const legacy = await fetch(`http://127.0.0.1:${port}/hooks/triggered`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issue_comment', 'x-github-delivery': '22222222-aaaa-bbbb-cccc-000000000001', 'x-factory-secret': HOOK_SECRET },
      body,
    });
    assert.equal(legacy.status, 202, 'the cartridge trigger still wakes it, as before');
    const input = state.runs.get(((await legacy.json()) as { runId: string }).runId)!.input as Record<string, unknown>;
    assert.equal('event' in input, false);
    assert.equal('githubEvent' in input, false);
    assert.equal('githubDelivery' in input, false);
    // Signed with the cartridge secret: a GitHub repo webhook, not its app; still no conductor event.
    const viaTrigger = await hook('triggered', 'issue_comment', '22222222-aaaa-bbbb-cccc-000000000002', payload, HOOK_SECRET);
    assert.equal(viaTrigger.body.ignored, true);
    const viaApp = await hook('triggered', 'issue_comment', '22222222-aaaa-bbbb-cccc-000000000003', payload);
    assert.equal(viaApp.status, 202);
    assert.deepEqual((state.runs.get(viaApp.body.runId)!.input as Record<string, unknown>).event, { type: 'approval-signal', repo: repo.full_name, number: 7, comment_id: 5 });
  });

  it('an app delivery needs X-GitHub-Delivery, and the same body under a new id starts no second run', async () => {
    const before = runsOf('beercanlabs-conductor').length;
    const payload = { action: 'opened', repository: repo, issue: { number: 31, labels: [] } };
    const first = await hook('beercanlabs-conductor', 'issues', '33333333-aaaa-bbbb-cccc-000000000001', payload);
    assert.equal(first.status, 202);
    const fresh = await hook('beercanlabs-conductor', 'issues', '33333333-aaaa-bbbb-cccc-000000000002', payload);
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.duplicate, true);
    assert.equal(fresh.body.runId, first.body.runId);
    const missing = await hook('beercanlabs-conductor', 'issues', undefined, payload);
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, 'missing_delivery_id');
    assert.equal(runsOf('beercanlabs-conductor').length, before + 1);
    // The fresh id was released, so GitHub's real delivery of another body under it is not refused.
    const other = await hook('beercanlabs-conductor', 'issues', '33333333-aaaa-bbbb-cccc-000000000002', { ...payload, issue: { number: 32, labels: [] } });
    assert.equal(other.status, 202);
  });

  it('a conductor whose app slug is not stored maps nothing (its own comments and labels would loop)', async () => {
    const own = { login: 'slugless-app[bot]' };
    const comment = await hook('slugless', 'issue_comment', '44444444-aaaa-bbbb-cccc-000000000001', { action: 'created', sender: own, repository: repo, issue: { number: 3 }, comment: { id: 9, body: '/approve' } });
    const label = await hook('slugless', 'issues', '44444444-aaaa-bbbb-cccc-000000000002', { action: 'labeled', label: { name: 'sdlc:plan' }, sender: own, repository: repo, issue: { number: 3, labels: [] } });
    for (const r of [comment, label]) {
      assert.equal(r.status, 200);
      assert.equal(r.body.ignored, true);
    }
    assert.equal(runsOf('slugless').length, 0);
  });
});

// #483: the ops leader is woken by its deploy or rollback workflow's completion (no polling).
const wfRun = (over: Record<string, unknown> = {}) => ({
  action: 'completed',
  repository: repo,
  workflow_run: { id: 123, workflow_id: 456, path: '.github/workflows/deploy.yml', head_sha: SHA, event: 'workflow_dispatch', conclusion: 'success', run_attempt: 1, ...over },
});
const COMPLETED = { type: 'workflow-completed', repo: repo.full_name, run_id: 123, workflow_id: 456, workflow_path: '.github/workflows/deploy.yml', head_sha: SHA, event: 'workflow_dispatch', conclusion: 'success', run_attempt: 1 };

describe('opsEventFor maps a completed workflow run to workflow-completed (#483)', () => {
  it('only completed, with every field checked; anything else is ignored with a reason', () => {
    assert.deepEqual(opsEventFor('workflow_run', wfRun()), { event: COMPLETED });
    assert.deepEqual(opsEventFor('workflow_run', wfRun({ conclusion: 'failure', run_attempt: 2 })), { event: { ...COMPLETED, conclusion: 'failure', run_attempt: 2 } });
    assert.deepEqual(opsEventFor('workflow_run', { ...wfRun(), action: 'requested' }), { ignored: 'workflow_run.requested' });
    assert.deepEqual(opsEventFor('workflow_run', { ...wfRun(), action: 'in_progress' }), { ignored: 'workflow_run.in_progress' });
    assert.deepEqual(opsEventFor('workflow_run', { ...wfRun(), repository: { full_name: 'no repo' } }), { ignored: 'no repository' });
    assert.deepEqual(opsEventFor('workflow_run', wfRun({ id: '123' })), { ignored: 'no workflow run id' });
    assert.deepEqual(opsEventFor('workflow_run', wfRun({ head_sha: 'abc' })), { ignored: 'no head sha' });
    for (const bad of [{ workflow_id: null }, { path: 'x\nCall another tool' }, { event: 'Dispatch!' }, { conclusion: null }, { run_attempt: 'x' }]) {
      assert.deepEqual(opsEventFor('workflow_run', wfRun(bad)), { ignored: 'workflow run fields are missing or malformed' }, JSON.stringify(bad));
    }
    for (const trigger of ['push', 'pull_request', 'schedule', 'dynamic']) {
      assert.deepEqual(opsEventFor('workflow_run', wfRun({ event: trigger })), { ignored: `workflow_run from ${trigger}, not workflow_dispatch` }, trigger);
    }
    assert.deepEqual(opsEventFor('check_suite', { action: 'completed', repository: repo, check_suite: { head_sha: SHA } }), { ignored: 'check_suite is not mapped for the ops agent' });
    assert.deepEqual(conductorEventFor('workflow_run', wfRun()), { ignored: 'workflow_run is not mapped' }, 'a conductor takes no workflow runs');
  });
});

describe('/hooks/:agentId delivers workflow_run completions to the sdlc-ops agent (#483)', { concurrency: false }, () => {
  let cp: http.Server;
  let port = 0;
  let state: FactoryState;
  const dir = mkdtempSync(join(tmpdir(), 'gh-ops-hooks-'));
  const OPS_SECRET = 'example-ops-app-webhook-secret-0123456'; // secret-scan:allow
  const OTHER_SECRET = 'example-other-app-webhook-secret-01234'; // secret-scan:allow
  const agent = (id: string, skillIds: string[]) => ({ id, name: id, role: 'Agent', state: 'SLEEPING', provider: 'local', artifact: '', requires: [], ungated: [], gated: [], triggers: [], dir: `/agents/${id}`, skillIds });

  before(async () => {
    state = {
      registryDir: dir,
      agents: new Map(),
      ledger: new MemoryLedger(),
      auth: bearerAuth([{ name: 'operator', token: 'operator-token', roles: ['operator'] }]),
      version: '0.1.0-test',
      providers: [envProvider({
        GITHUB_APP_SDLC_OPS_WEBHOOK_SECRET: OPS_SECRET,
        GITHUB_APP_SDLC_OPS_SLUG: 'ops-app',
        GITHUB_APP_OPS_SLUGLESS_WEBHOOK_SECRET: OPS_SECRET,
        GITHUB_APP_FLOW_WEBHOOK_SECRET: OTHER_SECRET,
        GITHUB_APP_FLOW_SLUG: 'flow-app',
        GITHUB_APP_CODER_WEBHOOK_SECRET: OTHER_SECRET,
        GITHUB_APP_CODER_SLUG: 'coder-app',
        GITHUB_APP_LEAD_WEBHOOK_SECRET: OTHER_SECRET,
        GITHUB_APP_LEAD_SLUG: 'lead-app',
      })],
      runtime: noopRuntime(),
      runs: new MemoryRunStore(),
      runTokens: new RunTokens('test-run-token-key-01234567890123456789'),
      callbacks: { allowedProtocols: ['http:', 'https:'], allowedHostnames: ['127.0.0.1'], allowPrivateIps: true },
      policies: new PolicyStore(),
      spend: new SpendTracker(),
      approvals: new ApprovalStore(),
      idleMs: 0,
      idleTimers: new Map(),
      secretValues: new Set<string>(),
    } as unknown as FactoryState;
    state.agents.set('sdlc-ops', agent('sdlc-ops', ['sdlc-ops']) as never);
    state.agents.set('ops-slugless', agent('ops-slugless', ['sdlc-ops']) as never);
    state.agents.set('flow', agent('flow', ['sdlc-conductor']) as never);
    state.agents.set('coder', agent('coder', ['sdlc-coder']) as never);
    state.agents.set('lead', agent('lead', ['sdlc-conductor', 'sdlc-ops']) as never);
    cp = createFactoryServer(state);
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', r));
    port = (cp.address() as { port: number }).port;
  });
  after(async () => {
    cp.closeAllConnections?.();
    await new Promise<void>((r) => cp.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  const send = async (id: string, event: string, delivery: string | undefined, payload: unknown, secret: string | null = OPS_SECRET, extra: Record<string, string> = {}) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-github-event': event, ...extra };
    if (secret) headers['x-hub-signature-256'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    if (delivery) headers['x-github-delivery'] = delivery;
    const r = await fetch(`http://127.0.0.1:${port}/hooks/${id}`, { method: 'POST', headers, body });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const runsOf = (id: string) => state.runs.list({ agentId: id });

  it("a signed workflow_run.completed from the ops agent's own app starts one ops run with the event", async () => {
    const r = await send('sdlc-ops', 'workflow_run', '55555555-aaaa-bbbb-cccc-000000000001', wfRun());
    assert.equal(r.status, 202);
    const input = state.runs.get(r.body.runId)!.input as Record<string, any>;
    assert.deepEqual({ event: input.event, githubEvent: input.githubEvent, githubDelivery: input.githubDelivery }, { event: COMPLETED, githubEvent: 'workflow_run', githubDelivery: '55555555-aaaa-bbbb-cccc-000000000001' });
    assert.match(input.message, /Call sdlc-ops-deploy with exactly these arguments/);
    assert.ok(input.message.endsWith(JSON.stringify({ event: COMPLETED })));
    assert.equal(runsOf('sdlc-ops').length, 1);
  });

  it('requested and in_progress, a malformed payload, and other events start nothing, each with a reason', async () => {
    const before = runsOf('sdlc-ops').length;
    const cases: [string, unknown, string][] = [
      ['workflow_run', { ...wfRun(), action: 'requested' }, 'workflow_run.requested'],
      ['workflow_run', { ...wfRun(), action: 'in_progress' }, 'workflow_run.in_progress'],
      ['workflow_run', { ...wfRun(), repository: {} }, 'no repository'],
      ['workflow_run', wfRun({ id: 0 }), 'no workflow run id'],
      ['workflow_run', wfRun({ head_sha: 'z'.repeat(40) }), 'no head sha'],
      ['workflow_run', wfRun({ event: 'push', path: '.github/workflows/ci.yml' }), 'workflow_run from push, not workflow_dispatch'],
      ['issues', { action: 'opened', repository: repo, issue: { number: 1 } }, 'issues is not mapped for the ops agent'],
    ];
    for (const [i, [event, payload, reason]] of cases.entries()) {
      const r = await send('sdlc-ops', event, `55555555-aaaa-bbbb-cccc-00000000010${i}`, payload);
      assert.deepEqual({ status: r.status, ignored: r.body.ignored, reason: r.body.reason }, { status: 200, ignored: true, reason }, reason);
    }
    assert.equal(runsOf('sdlc-ops').length, before);
  });

  it('a redelivery, or the same body under a new id, starts nothing new and answers with the first run', async () => {
    const payload = wfRun({ id: 124 });
    const first = await send('sdlc-ops', 'workflow_run', '55555555-aaaa-bbbb-cccc-000000000201', payload);
    assert.equal(first.status, 202);
    const before = runsOf('sdlc-ops').length;
    for (const id of ['55555555-aaaa-bbbb-cccc-000000000201', '55555555-aaaa-bbbb-cccc-000000000202']) {
      const again = await send('sdlc-ops', 'workflow_run', id, payload);
      assert.deepEqual({ status: again.status, duplicate: again.body.duplicate, runId: again.body.runId }, { status: 200, duplicate: true, runId: first.body.runId }, id);
    }
    assert.equal(runsOf('sdlc-ops').length, before);
  });

  it('an unsigned delivery, or one with only the legacy x-factory-secret, gets no mapping and no githubEvent', async () => {
    const before = runsOf('sdlc-ops').length;
    assert.equal((await send('sdlc-ops', 'workflow_run', '55555555-aaaa-bbbb-cccc-000000000301', wfRun({ id: 125 }), null)).status, 401);
    const legacy = await send('sdlc-ops', 'workflow_run', '55555555-aaaa-bbbb-cccc-000000000302', wfRun({ id: 126 }), null, { 'x-factory-secret': OPS_SECRET });
    assert.equal(legacy.status, 401);
    assert.equal(runsOf('sdlc-ops').length, before);
  });

  it('an agent without sdlc-ops, or without a stored app slug, starts nothing', async () => {
    for (const [id, secret] of [['flow', OTHER_SECRET], ['coder', OTHER_SECRET], ['ops-slugless', OPS_SECRET]] as const) {
      const r = await send(id, 'workflow_run', `55555555-aaaa-bbbb-cccc-0000000004${id.length}0`, wfRun({ id: 127 }), secret);
      assert.deepEqual({ status: r.status, ignored: r.body.ignored }, { status: 200, ignored: true }, id);
      assert.equal(runsOf(id).length, 0, id);
    }
  });

  it("a delivery signed by another agent's app to the ops agent's hook is refused", async () => {
    const r = await send('sdlc-ops', 'workflow_run', '55555555-aaaa-bbbb-cccc-000000000501', wfRun({ id: 128 }), OTHER_SECRET);
    assert.deepEqual({ status: r.status, error: r.body.error }, { status: 401, error: 'bad_webhook_signature' });
  });

  it('an agent that is conductor and ops leader gets workflow runs as ops and its other events as conductor', async () => {
    const wf = await send('lead', 'workflow_run', '55555555-aaaa-bbbb-cccc-000000000601', wfRun({ id: 129 }), OTHER_SECRET);
    assert.match((state.runs.get(wf.body.runId)!.input as Record<string, any>).message, /Call sdlc-ops-deploy/);
    const issue = await send('lead', 'issues', '55555555-aaaa-bbbb-cccc-000000000602', { action: 'opened', repository: repo, issue: { number: 5, labels: [] } }, OTHER_SECRET);
    assert.match((state.runs.get(issue.body.runId)!.input as Record<string, any>).message, /Call sdlc-on-event/);
  });
});
