import type http from 'node:http';
import { PROGRESS_MAX_WAIT_MS } from '@beercanlabs/factory-inspector';
import { requirePrivilege, json, readJson, type FactoryState } from './app.js';
import { isTerminal } from './runs.js';

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
}

/**
 * `POST /api/v1/gatekeeper-egress/progress` (gatekeeper-egress role): a batch of progress events.
 * `GET /api/v1/runs/:id/events?after=<seq>&wait=<ms>` (that run's own token, while live): the run's progress.
 * Returns false when the request is not one of these.
 */
export async function handleRunProgress(state: FactoryState, req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (path === '/api/v1/gatekeeper-egress/progress' && req.method === 'POST') {
    if (!(await requirePrivilege(req, res, state, 'egress.progress.report'))) return true;
    const body = await readJson(req);
    const batch = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
    // Attribution comes from the run itself: an event naming another agent is not this run's.
    const accepted = state.inspector.reportProgress(batch, (e) => {
      const run = state.runs.get(e.runId);
      return Boolean(run) && run!.agentId === e.agentId && !isTerminal(run!.state);
    });
    json(res, 200, { accepted });
    return true;
  }

  const m = path.match(/^\/api\/v1\/runs\/([^/]+)\/events$/);
  if (m && req.method === 'GET') {
    const runId = decodeURIComponent(m[1]);
    // Only this run's own live token reads this run's progress (like /input).
    const claims = await state.runTokens.verify(bearer(req));
    const run = claims && claims.runId === runId ? state.runs.get(runId) : undefined;
    if (!claims || !run || run.agentId !== claims.agentId || isTerminal(run.state)) {
      json(res, 401, { error: 'invalid_run_token' });
      return true;
    }
    const url = new URL(req.url ?? '/', 'http://factory.local');
    const afterRaw = url.searchParams.get('after');
    const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? parseInt(afterRaw, 10) : undefined;
    const waitRaw = parseInt(url.searchParams.get('wait') ?? String(PROGRESS_MAX_WAIT_MS), 10);
    const waitMs = Number.isFinite(waitRaw) ? Math.min(Math.max(waitRaw, 0), PROGRESS_MAX_WAIT_MS) : PROGRESS_MAX_WAIT_MS;
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const out = await state.inspector.readProgress(runId, after, after === undefined ? 0 : waitMs, abort.signal);
    if (!res.writableEnded && !res.destroyed) json(res, 200, { runId, ...out });
    return true;
  }
  return false;
}
