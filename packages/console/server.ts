import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const CLIENT_DIR = path.join(__dirname, 'dist', 'client');
const CP_URL = process.env.FACTORY_CONTROL_PLANE_URL || 'http://127.0.0.1:8088';

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

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // 1. Health check for AWS ALB
  if (pathname === '/healthz' || pathname === '/api/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'factory-console', version: '0.1.0' }));
  }

  // 2. Auth identity resolution
  if (pathname === '/api/auth/me') {
    const cfEmail = (req.headers['cf-access-authenticated-user-email'] as string) || '';
    const cfJwt = (req.headers['cf-access-jwt-assertion'] as string) || '';

    let email = cfEmail || 'dale.sackrider@gmail.com';
    let name = 'Dale Sackrider';
    let roles = ['admin', 'operator', 'approver', 'viewer'];

    if (cfJwt && cfJwt.includes('.')) {
      try {
        const payloadBase64 = cfJwt.split('.')[1];
        const decoded = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf8'));
        if (decoded.email) email = decoded.email;
        if (decoded.name) name = decoded.name;
      } catch (err) {
        // fallback
      }
    }

    if (email.toLowerCase() === 'dale.sackrider@gmail.com') {
      roles = ['admin', 'operator', 'approver', 'viewer'];
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        user: {
          email,
          name,
          roles,
          provider: cfJwt ? 'Cloudflare Access' : 'Local Administrator',
        },
      })
    );
  }

  // 3. Proxy API calls to Factory Control Plane if needed
  if (pathname.startsWith('/api/v1/')) {
    const targetUrl = new URL(pathname + parsedUrl.search, CP_URL);
    const headers = { ...req.headers };
    headers.host = targetUrl.host;

    const proxyReq = http.request(
      targetUrl,
      {
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Control Plane unreachable: ${err.message}` }));
    });

    req.pipe(proxyReq);
    return;
  }

  // 4. Static file serving (SPA)
  let filePath = path.join(CLIENT_DIR, pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(CLIENT_DIR, 'index.html');
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[factory-console] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[factory-console] Control Plane target: ${CP_URL}`);
  console.log(`[factory-console] Admin user: dale.sackrider@gmail.com`);
});
