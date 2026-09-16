import http from 'node:http';
import { KillSwitch } from './killswitch.js';
import { Ledger } from './ledger.js';

export type ControlOptions = {
  agentId: string;
  agentName: string;
  token: string | undefined;
  killSwitch: KillSwitch;
  ledger: Ledger;
  version: string;
};

function unauthorized(res: http.ServerResponse) {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function createControlServer(opts: ControlOptions): http.Server {
  const started = Date.now();

  return http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (path === '/healthz' || path === '/' || path === '/api/v1/health') {
      const state = opts.killSwitch.mode === 'LIVE' ? 'WORKING' : opts.killSwitch.mode;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          agentId: opts.agentId,
          agentName: opts.agentName,
          state,
          uptime: Math.round((Date.now() - started) / 1000),
          timestamp: new Date().toISOString(),
          version: opts.version,
        }),
      );
      return;
    }

    if (opts.token) {
      const header = req.headers.authorization ?? '';
      if (header !== `Bearer ${opts.token}`) {
        unauthorized(res);
        return;
      }
    }

    if (path === '/api/v1/ledger' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(opts.ledger.events));
      return;
    }

    if (path === '/api/v1/command' && req.method === 'POST') {
      try {
        const payload = JSON.parse((await readBody(req)) || '{}') as { command?: string };
        const command = payload.command ?? '';
        const mode = opts.killSwitch.apply(command);
        await opts.ledger.append({
          type: 'action',
          action: command.toUpperCase(),
          requestId: `cmd-${Date.now()}`,
          actor: 'control-plane',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}
