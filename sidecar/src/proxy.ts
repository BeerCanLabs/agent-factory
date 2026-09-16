import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { KillSwitch } from './killswitch.js';
import { Ledger } from './ledger.js';
import { toolFromMcpJson, usageFromLlmJson } from './tokens.js';

export type ProxyOptions = {
  upstream: string;
  killSwitch: KillSwitch;
  ledger: Ledger;
  actor?: string;
};

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tryJson(buf: Buffer): unknown {
  if (!buf.length) return undefined;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

export function createProxyServer(opts: ProxyOptions): http.Server {
  const upstream = new URL(opts.upstream);

  return http.createServer(async (req, res) => {
    const gate = opts.killSwitch.allow();
    if (!gate.ok) {
      res.writeHead(gate.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: gate.reason }));
      return;
    }

    const requestId = randomUUID();
    const incoming = await readBody(req);
    const inboundJson = tryJson(incoming);
    const mcp = toolFromMcpJson(inboundJson);
    if (mcp) {
      await opts.ledger.append({
        type: 'mcp',
        mcpMethod: mcp.method,
        mcpName: mcp.name,
        requestId,
        actor: opts.actor,
      });
    }

    const dest = new URL(req.url ?? '/', upstream);
    const headers = { ...req.headers, host: dest.host };
    delete headers['content-length'];
    const transport = dest.protocol === 'https:' ? https : http;

    const proxyReq = transport.request(
      dest,
      {
        method: req.method,
        headers,
      },
      async (proxyRes) => {
        const out = await readBody(proxyRes);
        const parsed = tryJson(out);
        const usage = usageFromLlmJson(parsed);
        if (usage) {
          opts.killSwitch.record(usage.input + usage.output);
          await opts.ledger.append({
            type: 'llm',
            model: usage.model,
            inputTokens: usage.input,
            outputTokens: usage.output,
            requestId,
            actor: opts.actor,
          });
        }
        const outHeaders = { ...proxyRes.headers };
        delete outHeaders['content-length'];
        res.writeHead(proxyRes.statusCode ?? 502, outHeaders);
        res.end(out);
      },
    );

    proxyReq.on('error', (err) => {
      console.error(`[factory-sidecar] upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'upstream_unreachable' }));
    });

    if (incoming.length) proxyReq.write(incoming);
    proxyReq.end();
  });
}
