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

export type ConsoleOptions = {
  controlPlaneUrl: string;
  clientDir?: string;
  /**
   * Front-door Phase 0 (R17): whether an anonymous GET /healthz or /api/v1/health still gets the minimal liveness
   * answer `{"status":"ok"}`. Default true because the live ALB target groups (`factory-prod-console`,
   * `factory-prod-garrison`) probe `/api/v1/health` on the public port without credentials. Set false (env
   * `FACTORY_CONSOLE_ANON_LIVENESS=off`) once those probes move to the private probe port.
   */
  anonymousLiveness?: boolean;
};

/** Minimal liveness: names no service, version, dependency or timing. */
const LIVENESS_BODY = JSON.stringify({ status: 'ok' });

/** A request presenting any credential the control plane could verify (bearer, factory session, Access assertion). */
export function presentsCredential(req: http.IncomingMessage): boolean {
  if (req.headers.authorization) return true;
  if (req.headers['cf-access-jwt-assertion']) return true;
  const cookie = String(req.headers.cookie ?? '');
  return /(?:^|;\s*)(factory_session|CF_Authorization)=/.test(cookie);
}

/**
 * Front-door Phase 0 / S16 (R17): the console's private probe listener, mirroring the control plane's
 * FACTORY_INTERNAL_HEALTH_PORT. Answers GET /healthz with `{"status":"ok"}` only. Bind it to a port the load balancer can
 * reach but the public hostname does not route to.
 */
export function createConsoleProbeServer(): http.Server {
  return http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://probe.local').pathname;
    if (req.method === 'GET' && pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(LIVENESS_BODY);
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

/**
 * The dashboard: static files plus a pass-through to the control plane.
 *
 * DESIGN_AUTHORITY.md §6.12 A2: the console adds no credential of its own. The caller's own credentials (the
 * identity-aware proxy's signed assertion in `cf-access-jwt-assertion` / the `CF_Authorization` cookie, or their own
 * bearer token) are forwarded unchanged, and the control plane verifies them, so every operator acts as themselves.
 */
/** #432: the label for how the current session signed in (from whoami's signedInWith), never a linked IdP. */
export function providerLabel(signedInWith: unknown, access = false): string {
  const labels: Record<string, string> = {
    google: 'Google',
    meta: 'Meta',
    cloudflare: 'Cloudflare',
    oidc: 'OIDC',
    'cloudflare-access': 'Cloudflare Access',
    'api-key': 'API key',
    oauth: 'Connected app (OAuth)',
    'static-token': 'Static token',
    'oidc-bearer': 'OIDC token',
    'run-token': 'Agent run',
  };
  return (typeof signedInWith === 'string' && labels[signedInWith]) || (access ? 'Cloudflare Access' : 'API key');
}

export function createConsoleServer(opts: ConsoleOptions): http.Server {
  const clientDir = opts.clientDir ?? path.join(__dirname, 'dist', 'client');
  const cp = opts.controlPlaneUrl;
  const anonymousLiveness = opts.anonymousLiveness !== false;

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

    // 1. Health (R17, front-door Phase 0). A caller presenting a credential gets the control plane's verified health
    // (401 if the credential is not valid). An anonymous caller gets only `{"status":"ok"}` so the ALB keeps working, and
    // nothing about the service, its version or its dependencies; or 401 once anonymous liveness is turned off.
    if (pathname === '/healthz' || pathname === '/api/v1/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, HEAD' });
        return res.end(JSON.stringify({ error: 'method_not_allowed' }));
      }
      if (presentsCredential(req)) {
        return proxy(req, res, new URL('/api/v1/health', cp));
      }
      if (anonymousLiveness) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(req.method === 'HEAD' ? undefined : LIVENESS_BODY);
      }
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
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
          const w = who as { principal?: unknown; grants?: unknown[]; privileges?: unknown; onBehalfOf?: string; breakGlassAlert?: unknown };
          res.end(JSON.stringify({ user: { email, name: (typeof (who as { displayName?: unknown }).displayName === 'string' && (who as { displayName: string }).displayName) || email, actor: who.actor, roles, provider: providerLabel((who as { signedInWith?: unknown }).signedInWith, access) }, whoami: { actor: who.actor, ...(typeof w.principal === 'string' ? { principal: w.principal } : {}), roles, grants: w.grants ?? [], privileges: w.privileges ?? {}, ...(w.onBehalfOf ? { onBehalfOf: w.onBehalfOf } : {}), ...(w.breakGlassAlert ? { breakGlassAlert: w.breakGlassAlert } : {}) } }));
        });
      });
      r.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Control Plane unreachable: ${err.message}` }));
      });
      return r.end();
    }

    // 3. Transparent proxy to control plane:
    // API calls, login page (S12), OAuth 2.1 AS endpoints & discovery (TSK-339/TSK-340), and MCP surfaces.
    const isControlPlaneRoute =
      pathname.startsWith('/api/v1/') ||
      pathname === '/login' ||
      pathname.startsWith('/.well-known/oauth-protected-resource') ||
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/authorize' ||
      pathname === '/token' ||
      pathname === '/revoke' ||
      pathname === '/register' ||
      pathname === '/mcp' ||
      pathname.startsWith('/mcp/');

    if (isControlPlaneRoute) {
      return proxy(req, res, new URL(pathname + parsedUrl.search, cp));
    }

    // 5. SPA assets only for a caller the control plane verifies (S12, D22): HTML navigations go to /login, the rest 401.
    return verifyCaller(req, (ok) => {
      if (ok) return serveStatic(pathname, res);
      // A page navigation (GET/HEAD of a path with no file extension, or one asking for HTML) goes to /login; asset
      // and API-style requests get 401.
      const page = (req.method === 'GET' || req.method === 'HEAD') && !/\.[A-Za-z0-9]+$/.test(pathname);
      const html = page || String(req.headers.accept ?? '').includes('text/html');
      res.writeHead(html ? 302 : 401, html ? { Location: '/login', 'Cache-Control': 'no-store' } : { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(html ? '' : JSON.stringify({ error: 'unauthorized' }));
    });
  });

  function verifyCaller(req: http.IncomingMessage, done: (ok: boolean) => void) {
    const target = new URL('/api/v1/whoami', cp);
    const headers = { ...req.headers, host: target.host };
    delete headers['content-length'];
    const r = http.request(target, { method: 'GET', headers }, (cpRes) => {
      cpRes.resume();
      cpRes.on('end', () => done(cpRes.statusCode === 200));
    });
    r.on('error', () => done(false));
    r.end();
  }

  function serveStatic(pathname: string, res: http.ServerResponse) {
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
  }
}

// Run as the entry point (`tsx server.ts`); imported by tests without listening.
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const PORT = Number(process.env.PORT || 3000);
  const CP_URL = process.env.FACTORY_CONTROL_PLANE_URL || 'http://127.0.0.1:8088';
  const anonymousLiveness = (process.env.FACTORY_CONSOLE_ANON_LIVENESS ?? '').toLowerCase() !== 'off';
  createConsoleServer({ controlPlaneUrl: CP_URL, anonymousLiveness }).listen(PORT, '0.0.0.0', () => {
    console.log(`[factory-console] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[factory-console] Control Plane target: ${CP_URL}`);
  });
  const PROBE_PORT = parseInt(process.env.FACTORY_CONSOLE_INTERNAL_HEALTH_PORT ?? '', 10);
  if (Number.isInteger(PROBE_PORT) && PROBE_PORT > 0 && PROBE_PORT !== PORT) {
    createConsoleProbeServer().listen(PROBE_PORT, '0.0.0.0', () => {
      console.log(`[factory-console] Private probe listener on :${PROBE_PORT} (GET /healthz)`);
    });
  }
}
