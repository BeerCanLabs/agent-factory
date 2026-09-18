import http from 'node:http';
import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createDoorman, fakeGateway } from './index.js';

const PORT = parseInt(process.env.PORT || '8090', 10);
const FACTORY_URL = (process.env.FACTORY_URL || 'http://127.0.0.1:8088').replace(/\/$/, '');
const FACTORY_TOKEN = process.env.FACTORY_TOKEN;
const presenceAuth = bearerAuth(
  process.env.DOORMAN_TOKEN ? [{ name: 'control-plane', token: process.env.DOORMAN_TOKEN, roles: ['operator'] }] : [],
);

const gateway = fakeGateway();
const door = createDoorman({
  gateway,
  providers: providersFromEnv(),
  wake: async (agentId) => {
    const res = await fetch(`${FACTORY_URL}/api/v1/agents/${encodeURIComponent(agentId)}/wake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FACTORY_TOKEN ? { Authorization: `Bearer ${FACTORY_TOKEN}` } : {}),
      },
    });
    if (!res.ok) console.error(`[doorman] wake ${agentId} ${res.status}`);
  },
  handoff: async (msg) => {
    const res = await fetch(`${FACTORY_URL}/api/v1/agents/${encodeURIComponent(msg.agentId)}/conversation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FACTORY_TOKEN ? { Authorization: `Bearer ${FACTORY_TOKEN}` } : {}),
      },
      body: JSON.stringify(msg),
    });
    if (!res.ok) console.error(`[doorman] handoff ${msg.agentId} ${res.status}`);
  },
});

async function reconcileFromFactory() {
  try {
    const res = await fetch(`${FACTORY_URL}/api/v1/agents`, {
      headers: FACTORY_TOKEN ? { Authorization: `Bearer ${FACTORY_TOKEN}` } : {},
    });
    if (!res.ok) return;
    const agents = (await res.json()) as Array<{
      id: string;
      triggers?: Array<{ type: string; secretRef?: string }>;
    }>;
    const surfaces = agents.flatMap((a) =>
      (a.triggers ?? [])
        .filter((t) => t.type === 'discord')
        .map((t) => ({ agentId: a.id, secretRef: t.secretRef || 'DISCORD_BOT_TOKEN' })),
    );
    await door.reconcile(surfaces);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[doorman] reconcile: ${message}`);
  }
}

const server = http.createServer(async (req, res) => {
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
    const payload = JSON.parse(body || '{}') as { agentId?: string; presence?: string };
    if (payload.agentId && payload.presence === 'offline') await door.onAgentIdle(payload.agentId);
    if (payload.agentId && payload.presence === 'available') await door.onAgentWorking(payload.agentId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(door.status()));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[doorman] idle mailbox on :${PORT} (no Discord app required to deploy)`);
});

setInterval(() => void reconcileFromFactory(), 15_000);
void reconcileFromFactory();
