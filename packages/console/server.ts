import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export type ConsoleOptions = { controlPlaneUrl: string; clientDir?: string };

/**
 * The dashboard: static files plus a pass-through to the control plane.
 *
 * DESIGN_AUTHORITY.md §6.12 A2: the console adds no credential of its own. The caller's own credentials (the
 * identity-aware proxy's signed assertion in `cf-access-jwt-assertion` / the `CF_Authorization` cookie, or their own
 * bearer token) are forwarded unchanged, and the control plane verifies them, so every operator acts as themselves.
 */
export function createConsoleServer(opts: ConsoleOptions): http.Server {
  const clientDir = opts.clientDir ?? path.join(__dirname, 'dist', 'client');
  const cp = opts.controlPlaneUrl;

  function proxy(req: http.IncomingMessage, res: http.ServerResponse, target: URL) {
    const headers = { ...req.headers, host: target.host };
    const proxyReq = http.request(target, { method: req.method, headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Control Plane unreachable: ${err.message}` }));
    });
    req.pipe(proxyReq);
  }

  return http.createServer((req, res) => {
    const parsedUrl = new URL(req.url || '/', 'http://console.local');
    const pathname = parsedUrl.pathname;

    // 1. Health check for the load balancer
    if (pathname === '/healthz' || pathname === '/api/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'factory-console', version: '0.1.0' }));
    }

    // 2. Who the control plane says the caller is (verified there, never decoded here).
    if (pathname === '/api/auth/me') {
      const target = new URL('/api/v1/whoami', cp);
      const headers = { ...req.headers, host: target.host };
      delete headers['content-length'];
      const r = http.request(target, { method: 'GET', headers }, (cpRes) => {
        const chunks: Buffer[] = [];
        cpRes.on('data', (c) => chunks.push(c));
        cpRes.on('end', () => {
          let who: { actor?: string; roles?: string[] } = {};
          try {
            who = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // fall through to 401
          }
          if (cpRes.statusCode !== 200 || typeof who.actor !== 'string') {
            res.writeHead(cpRes.statusCode === 200 ? 502 : cpRes.statusCode || 502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'unauthorized' }));
          }
          const access = who.actor.startsWith('cloudflare:');
          const email = access ? who.actor.slice('cloudflare:'.length) : who.actor;
          const roles = (who.roles ?? []).filter((x) => ['admin', 'operator', 'approver', 'viewer'].includes(x));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ user: { email, name: email, roles, provider: access ? 'Cloudflare Access' : 'Factory token' } }));
        });
      });
      r.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Control Plane unreachable: ${err.message}` }));
      });
      return r.end();
    }

    // 3. API calls go to the control plane with the caller's own credentials.
    if (pathname.startsWith('/api/v1/')) {
      return proxy(req, res, new URL(pathname + parsedUrl.search, cp));
    }

    // 4. Static file serving (SPA)
    let filePath = path.join(clientDir, path.normalize(pathname));
    if (!filePath.startsWith(clientDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(clientDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not Found');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      });
      res.end(content);
    });
  });
}

// Run as the entry point (`tsx server.ts`); imported by tests without listening.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const PORT = Number(process.env.PORT || 3000);
  const CP_URL = process.env.FACTORY_CONTROL_PLANE_URL || 'http://127.0.0.1:8088';
  createConsoleServer({ controlPlaneUrl: CP_URL }).listen(PORT, '0.0.0.0', () => {
    console.log(`[factory-console] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[factory-console] Control Plane target: ${CP_URL}`);
  });
}
