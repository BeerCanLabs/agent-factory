import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createDoorman } from './index.js';
import { createDoormanHttp } from './http.js';
import { createDiscordGateway } from './discord.js';

const PORT = parseInt(process.env.PORT || '8090', 10);
const FACTORY_URL = (process.env.FACTORY_URL || 'http://127.0.0.1:8088').replace(/\/$/, '');
const FACTORY_TOKEN = process.env.FACTORY_TOKEN;
const presenceAuth = bearerAuth(
  process.env.DOORMAN_TOKEN ? [{ name: 'control-plane', token: process.env.DOORMAN_TOKEN, roles: ['operator'] }] : [],
);

const door = createDoorman({
  gatewayFactory: createDiscordGateway,
  providers: providersFromEnv(),
  wake: async (agentId, msg) => {
    const res = await fetch(`${FACTORY_URL}/api/v1/agents/${encodeURIComponent(agentId)}/wake`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(FACTORY_TOKEN ? { Authorization: `Bearer ${FACTORY_TOKEN}` } : {}),
      },
      body: msg ? JSON.stringify({ input: msg }) : undefined,
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

const server = createDoormanHttp(door, presenceAuth);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[doorman] idle mailbox on :${PORT} (no Discord app required to deploy)`);
});

setInterval(() => void reconcileFromFactory(), 15_000);
void reconcileFromFactory();
