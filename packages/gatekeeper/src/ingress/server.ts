import { providersFromEnv } from '@beercanlabs/factory-secrets-bind';
import { bearerAuth } from '@beercanlabs/factory-auth';
import { createGatekeeperIngress, type ApprovalAdapter, type ApprovalPrompt } from './index.js';
import { createGatekeeperIngressHttp } from './http.js';
import { createDiscordClient } from './discord.js';
import { WakeRefusedError, UnauthorizedCallerError, wakeBody, wakeFailure } from './wake.js';
import { initialPresence } from './presence.js';

const PORT = parseInt(process.env.PORT || '8090', 10);
const FACTORY_URL = (process.env.FACTORY_URL || 'http://127.0.0.1:8088').replace(/\/$/, '');
const FACTORY_TOKEN = process.env.FACTORY_TOKEN;
const presenceAuth = bearerAuth(
  process.env.GATEKEEPER_INGRESS_TOKEN ? [{ name: 'control-plane', token: process.env.GATEKEEPER_INGRESS_TOKEN, roles: ['operator'] }] : [],
);

const factoryHeaders = () => ({
  'Content-Type': 'application/json',
  ...(FACTORY_TOKEN ? { Authorization: `Bearer ${FACTORY_TOKEN}` } : {}),
});

/** CF4: the factory asks, the ingress posts and reads the answer; this token must hold `gatekeeper-ingress` (approvals.channel). */
const approvals: ApprovalAdapter = {
  async prompts(agentId) {
    const res = await fetch(`${FACTORY_URL}/api/v1/ingress/approval-prompts`, { method: 'POST', headers: factoryHeaders(), body: JSON.stringify({ agentId }) });
    if (!res.ok) throw new Error(`factory answered ${res.status}`);
    return ((await res.json()) as { prompts?: ApprovalPrompt[] }).prompts ?? [];
  },
  async asked(approvalId, channelId) {
    const res = await fetch(`${FACTORY_URL}/api/v1/ingress/approvals/${encodeURIComponent(approvalId)}/asked`, {
      method: 'POST',
      headers: factoryHeaders(),
      body: JSON.stringify({ provider: 'discord', channelId }),
    });
    if (!res.ok) throw new Error(`factory answered ${res.status}`);
  },
  async decide(reply) {
    const res = await fetch(`${FACTORY_URL}/api/v1/ingress/approvals/decision`, {
      method: 'POST',
      headers: factoryHeaders(),
      body: JSON.stringify({ ...reply, provider: 'discord' }),
    });
    if (res.status === 404) return { result: 'unknown' };
    const body = (await res.json().catch(() => ({}))) as { text?: unknown };
    if (res.status >= 500) throw new Error(`factory answered ${res.status}`);
    // The factory's own answer (a decision or a refusal) carries the text to show. Anything without it (a rejected
    // credential, a malformed request) is not an answer: the message goes on as an ordinary one.
    if (typeof body.text !== 'string' || !body.text) {
      console.error(`[gatekeeper-ingress] approval reply: factory answered ${res.status} without a decision`);
      return { result: 'unknown' };
    }
    return { result: 'answered', text: body.text };
  },
};

const door = createGatekeeperIngress({
  approvals,
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
      body: JSON.stringify({
        input: msg,
        ...(msg.authorId ? { requestedBy: { provider: 'discord', id: msg.authorId } } : {}),
      }),
    });
    if (res.ok) return;
    const failure = wakeFailure(res.status, await res.text().catch(() => ''), 'handoff');
    if (failure instanceof WakeRefusedError || failure instanceof UnauthorizedCallerError) throw failure;
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
      liveRun?: boolean;
      triggers?: Array<{ type: string; secretRef?: string }>;
    }>;
    const surfaces = agents.flatMap((a) =>
      (a.triggers ?? [])
        .filter((t) => t.type === 'discord')
        .map((t) => ({
          agentId: a.id,
          name: a.name,
          initialPresence: initialPresence(a),
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

async function pollApprovals() {
  try {
    await door.askPending();
  } catch {}
  setTimeout(() => void pollApprovals(), 10_000);
}
void pollApprovals();
