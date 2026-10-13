import http from 'node:http';
import type { AuthProvider } from '@beercanlabs/factory-auth';
import type { GatekeeperIngress } from './index.js';

/** Health is public; presence changes come only from the control plane (GATEKEEPER_INGRESS_TOKEN). */
type ActivityEvent = { agentId?: string; route?: string; model?: string; kind?: string };

/** `POST /api/v1/activity` bounds: progress batches are small metadata (the control plane sends at most 500 events). */
const ACTIVITY_MAX_BODY_BYTES = 256 * 1024;
const ACTIVITY_MAX_EVENTS = 500;

export function createGatekeeperIngressHttp(door: GatekeeperIngress, presenceAuth: AuthProvider): http.Server {
  return http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ...door.status() }));
      return;
    }
    if (path === '/api/v1/presence' && req.method === 'POST') {
      if (!(await presenceAuth.verify(req.headers.authorization)).ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      for await (const c of req) body += c;
      let payload: { agentId?: string; presence?: string };
      try {
        payload = JSON.parse(body || '{}') as typeof payload;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      if (payload.agentId && payload.presence === 'offline') await door.onAgentIdle(payload.agentId);
      if (payload.agentId && payload.presence === 'starting') await door.onAgentStarting(payload.agentId);
      if (payload.agentId && payload.presence === 'available') await door.onAgentWorking(payload.agentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(door.status()));
      return;
    }
    if (path === '/api/v1/activity' && req.method === 'POST') {
      if (!(await presenceAuth.verify(req.headers.authorization)).ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      let tooLarge = false;
      for await (const c of req) {
        body += c;
        if (body.length > ACTIVITY_MAX_BODY_BYTES) {
          tooLarge = true;
          break;
        }
      }
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        return;
      }
      let payload: ActivityEvent & { events?: ActivityEvent[] };
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
        return;
      }
      // Events are applied in order: a late call.start must not overwrite a newer call.end.
      const events = Array.isArray(payload.events) ? payload.events.slice(0, ACTIVITY_MAX_EVENTS) : [payload];
      for (const evt of events) {
        if (evt && typeof evt.agentId === 'string') await door.onAgentActivity?.(evt.agentId, evt);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
