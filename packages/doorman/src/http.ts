import http from 'node:http';
import type { AuthProvider } from '@beercanlabs/factory-auth';
import type { Doorman } from './index.js';

/** Health is public; presence changes come only from the control plane (DOORMAN_TOKEN). */
export function createDoormanHttp(door: Doorman, presenceAuth: AuthProvider): http.Server {
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
      if (payload.agentId && payload.presence === 'available') await door.onAgentWorking(payload.agentId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(door.status()));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}
