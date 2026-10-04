import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createGatekeeperIngress } from './index.js';
import { createGatekeeperIngressHttp } from './http.js';
import { createDiscordClient } from './discord.js';
import { WakeRefusedError, wakeBody, wakeFailure } from './wake.js';

const PORT = parseInt(process.env.PORT || '8090', 10);
const FACTORY_URL = (process.env.FACTORY_URL || 'http://127.0.0.1:8088').replace(/\/$/, '');
const FACTORY_TOKEN = process.env.FACTORY_TOKEN;
const presenceAuth = bearerAuth(
  process.env.GATEKEEPER_INGRESS_TOKEN ? [{ name: 'control-plane', token: process.env.GATEKEEPER_INGRESS_TOKEN, roles: ['operator'] }] : [],
);

const door = createGatekeeperIngress({
  discordFactory: createDiscordClient,
  providers: providersFromEnv(),
  wake: async (agentId, msg) => {
    const res = await fetch(`${FACTORY_URL}/api/v1/agents/${encodeURIComponent(agentId)}/wake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FACTORY_TOKEN ? { Authorization: `Bearer ${FACTORY_TOKEN}` } : {}),
      },
      body: wakeBody(msg),
    });
    if (!res.ok) throw wakeFailure(res.status, await res.text().catch(() => ''));
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
    if (res.ok) return;
    const failure = wakeFailure(res.status, await res.text().catch(() => ''), 'handoff');
    if (failure instanceof WakeRefusedError) throw failure;
    console.error(`[gatekeeper-ingress] handoff ${msg.agentId} ${res.status}`);
  },
});

let isReconciling = false;

async function reconcileFromFactory() {
  if (isReconciling) return;
  isReconciling = true;
  try {
    const res = await fetch(`${FACTORY_URL}/api/v1/agents`, {
      headers: FACTORY_TOKEN ? { Authorization: `Bearer ${FACTORY_TOKEN}` } : {},
    });
    if (!res.ok) return;
    const agents = (await res.json()) as Array<{
      id: string;
      name?: string;
      state?: string;
      triggers?: Array<{ type: string; secretRef?: string }>;
    }>;
    const surfaces = agents.flatMap((a) =>
      (a.triggers ?? [])
        .filter((t) => t.type === 'discord')
        .map((t) => ({
          agentId: a.id,
          name: a.name,
          initialPresence: (a.state === 'WORKING' ? 'available' : 'offline') as 'available' | 'offline',
          secretRef: t.secretRef || 'DISCORD_BOT_TOKEN',
        })),
    );
    await door.reconcile(surfaces);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gatekeeper-ingress] reconcile: ${message}`);
  } finally {
    isReconciling = false;
  }
}

const server = createGatekeeperIngressHttp(door, presenceAuth);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[gatekeeper-ingress] idle mailbox on :${PORT} (no Discord app required to deploy)`);
});

async function pollReconcile() {
  try {
    await reconcileFromFactory();
  } catch {}
  setTimeout(() => void pollReconcile(), 30_000);
}
void pollReconcile();
