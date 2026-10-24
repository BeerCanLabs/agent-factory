import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';
import { WakeRefusedError, UnauthorizedCallerError } from './wake.js';

/**
 * offline: asleep (Discord invisible). starting: a wake is in progress but the agent cannot take a turn yet
 * (Discord idle). available: the agent's run is ready to take a turn (Discord online). Only the control plane's
 * readiness signal (the run's first heartbeat or mailbox poll) makes an agent available.
 */
export type Presence = 'offline' | 'starting' | 'available';

export type Conversation = {
  agentId: string;
  channelId: string;
  messageId: string;
  content: string;
  authorId: string;
};

export type AgentActivity = {
  route?: string;
  model?: string;
  kind?: string;
  durationMs?: number;
  status?: number;
  outcome?: 'ok' | 'denied' | 'error' | 'timeout';
  inputTokens?: number;
  outputTokens?: number;
};

export type DiscordClient = {
  connected: boolean;
  presence: Presence;
  login(token: string): Promise<void>;
  setPresence(status: Presence): Promise<void>;
  setAgentName?(name: string): void;
  /** The factory refused to wake the agent over budget: tell the channel why, replacing the standby message. */
  refuseWake?(channelId: string, window: string, kind?: 'wake' | 'handoff'): Promise<void>;
  /** The factory refused the caller because they are unmapped or unauthorized. */
  refuseUnauthorized?(channelId: string): Promise<void>;
  recordActivity?(activity: AgentActivity): Promise<void>;
  onMessage(handler: (msg: Omit<Conversation, 'agentId'>) => void): void;
  /**
   * CF4: asked about every message before anything else is done with it (no standby, no wake, no hand-off). It answers
   * true when the message was an answer to an approval question: the agent never sees it.
   */
  setInterceptor?(fn: (msg: Omit<Conversation, 'agentId'>) => Promise<boolean>): void;
  /** CF4: post text in a channel without pinging anyone; returns whether it was posted. */
  send?(channelId: string, text: string): Promise<boolean>;
  destroy(): Promise<void>;
};

export function fakeDiscordClient(): DiscordClient & {
  refusals: Array<{ channelId: string; window: string; kind: 'wake' | 'handoff' }>;
  unauthorizedRefusals: string[];
  activities: AgentActivity[];
  sent: Array<{ channelId: string; text: string }>;
  /** A message arriving from Discord: the interceptor first, then the handlers, as the real client does. */
  inbound(msg: Omit<Conversation, 'agentId'>): Promise<void>;
} {
  const handlers: Array<(msg: Omit<Conversation, 'agentId'>) => void> = [];
  let interceptor: ((msg: Omit<Conversation, 'agentId'>) => Promise<boolean>) | undefined;
  return {
    sent: [] as Array<{ channelId: string; text: string }>,
    setInterceptor(fn) {
      interceptor = fn;
    },
    async send(channelId, text) {
      this.sent.push({ channelId, text });
      return true;
    },
    async inbound(msg) {
      if (interceptor && (await interceptor(msg))) return;
      for (const h of handlers) h(msg);
    },
    connected: false,
    presence: 'offline',
    refusals: [] as Array<{ channelId: string; window: string; kind: 'wake' | 'handoff' }>,
    unauthorizedRefusals: [] as string[],
    activities: [] as AgentActivity[],
    setAgentName(_name) {},
    async refuseWake(channelId, window, kind = 'wake') {
      this.refusals.push({ channelId, window, kind });
    },
    async refuseUnauthorized(channelId) {
      this.unauthorizedRefusals.push(channelId);
    },
    async recordActivity(activity) {
      this.activities.push(activity);
    },
    async login() {
      this.connected = true;
      this.presence = 'offline';
    },
    async setPresence(status) {
      if (!this.connected) throw new Error('not connected');
      this.presence = status;
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    async destroy() {
      this.connected = false;
    },
  };
}

export type DiscordSurface = {
  agentId: string;
  name?: string;
  secretRef: string;
  initialPresence?: Presence;
};

/** CF4: what the ingress asks of the factory about approvals. All three need the ingress's own credential. */
export type ApprovalPrompt = { approvalId: string; code: string; deciders: string[]; text: string };
export type ApprovalReply = { code: string; decision: 'approve' | 'reject'; identity: string; channelId: string };
export type ApprovalReplyResult = { result: 'unknown' } | { result: 'answered'; text: string };
export type ApprovalAdapter = {
  prompts(agentId: string): Promise<ApprovalPrompt[]>;
  asked(approvalId: string, channelId: string): Promise<void>;
  /** `unknown`: not a question the factory asked there, so the message is an ordinary one. */
  decide(reply: ApprovalReply): Promise<ApprovalReplyResult>;
};

/** `approve CODE` or `reject CODE`, after any mentions of the bot, and nothing else in the message. */
const APPROVAL_REPLY = /^(?:\s*<@[!&]?\d+>)*\s*(approve|reject)\s+([A-Za-z0-9]{4,12})\s*$/i;
const MAX_REMEMBERED_AUTHORS = 2000;

export type GatekeeperIngress = {
  status(): { discord: 'idle' | 'connected'; presence: Presence; agentId?: string };
  reconcile(surfaces: DiscordSurface[]): Promise<void>;
  /** Inbound Discord activity: wake a sleeping agent (presence `starting`), otherwise hand off to its run. */
  receive(msg: Conversation): Promise<void>;
  /** Control plane tells us the agent scaled to zero. Keep the socket. */
  onAgentIdle(agentId: string): Promise<void>;
  /** Control plane tells us a run is starting for the agent; it cannot take a turn yet. */
  onAgentStarting(agentId: string): Promise<void>;
  /** Control plane tells us the agent's run is ready to take a turn. */
  onAgentWorking(agentId: string): Promise<void>;
  /** Outbound tool/model progress reported for the agent; pulses typing and sets custom activity. */
  onAgentActivity?(agentId: string, activity: AgentActivity): Promise<void>;
  /** CF4: post the factory's pending approval questions where the person who may decide each last spoke. */
  askPending(): Promise<void>;
};

export function createGatekeeperIngress(opts: {
  discord?: DiscordClient;
  discordFactory?: () => DiscordClient;
  providers: SecretProvider[];
  /** Rejects if the factory did not accept the wake, so presence falls back to offline. */
  wake: (agentId: string, msg?: unknown) => Promise<void>;
  handoff: (msg: Conversation) => Promise<void>;
  /** CF4: absent, the ingress asks for no approvals and consumes no replies. */
  approvals?: ApprovalAdapter;
}): GatekeeperIngress {
  const agents = new Map<string, { ref: string; discord: DiscordClient }>();
  // Where each person last wrote to each agent: the only channels a question is asked in.
  const lastSeen = new Map<string, { channelId: string; at: number }>();
  const seenKey = (agentId: string, authorId: string) => `${agentId}\u0000${authorId}`;

  /** CF4: true when the message answered an approval question. The agent never sees such a message. */
  async function intercept(agentId: string, discord: DiscordClient, msg: Omit<Conversation, 'agentId'>): Promise<boolean> {
    if (msg.authorId) {
      lastSeen.delete(seenKey(agentId, msg.authorId));
      lastSeen.set(seenKey(agentId, msg.authorId), { channelId: msg.channelId, at: Date.now() });
      if (lastSeen.size > MAX_REMEMBERED_AUTHORS) lastSeen.delete(lastSeen.keys().next().value as string);
    }
    const m = opts.approvals && typeof msg.content === 'string' ? APPROVAL_REPLY.exec(msg.content) : null;
    if (!m || !opts.approvals || !msg.authorId) return false;
    try {
      const out = await opts.approvals.decide({ code: m[2], decision: m[1].toLowerCase() as 'approve' | 'reject', identity: msg.authorId, channelId: msg.channelId });
      if (out.result === 'unknown') return false;
      await discord.send?.(msg.channelId, out.text).catch(() => false);
      return true;
    } catch (err) {
      console.error(`[gatekeeper-ingress] approval reply for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
      await discord.send?.(msg.channelId, 'I could not reach the factory just now. Please send your answer again in a minute.').catch(() => false);
      return true;
    }
  }
  const connecting = new Set<string>();
  let isReconciling = false;

  const gatekeeperIngress: GatekeeperIngress = {
    status() {
      // Just returning the status of the first one for backwards compatibility of the healthcheck format
      // In a real app we'd want to return a list of agent statuses
      const first = [...agents.values()][0];
      return {
        discord: first?.discord.connected ? 'connected' : 'idle',
        presence: first?.discord.presence || 'offline',
        agentId: agents.keys().next().value,
      };
    },
    async reconcile(surfaces) {
      if (isReconciling || surfaces.length === 0) return;
      isReconciling = true;
      try {
        const desiredAgents = new Set(surfaces.map(s => s.agentId));
        
        // Destroy Discord clients for agents no longer requested
        for (const [agentId, state] of agents) {
          if (!desiredAgents.has(agentId)) {
            await state.discord.destroy().catch(() => {});
            agents.delete(agentId);
          }
        }

        // Create and login new Discord clients
        for (const surface of surfaces) {
          if (agents.has(surface.agentId) || connecting.has(surface.agentId)) {
            continue;
          }
          connecting.add(surface.agentId);

          const bound = await bindSecrets([surface.secretRef], opts.providers);
          if (!bound.ok || !bound.env[surface.secretRef]) {
            console.warn(`[gatekeeper-ingress] failed to bind secret ${surface.secretRef} for ${surface.agentId}`);
            connecting.delete(surface.agentId);
            continue;
          }

          if (agents.has(surface.agentId)) {
            connecting.delete(surface.agentId);
            continue;
          }

          const discord = opts.discordFactory ? opts.discordFactory() : (opts.discord || fakeDiscordClient());
          if (surface.name && discord.setAgentName) {
            discord.setAgentName(surface.name);
          }
          
          try {
            await discord.login(bound.env[surface.secretRef]);
            await discord.setPresence(surface.initialPresence ?? 'offline');
            
            discord.setInterceptor?.((msg) => intercept(surface.agentId, discord, msg));
            discord.onMessage((msg) => {
              void gatekeeperIngress.receive({ ...msg, agentId: surface.agentId });
            });
            agents.set(surface.agentId, { ref: surface.secretRef, discord });
            console.log(`[gatekeeper-ingress] connected Discord for ${surface.agentId} (presence: ${surface.initialPresence ?? 'offline'})`);
          } catch (err) {
            console.error(`[gatekeeper-ingress] Discord login failed for ${surface.agentId}:`, err);
            await discord.destroy().catch(() => {});
            agents.delete(surface.agentId);
          } finally {
            connecting.delete(surface.agentId);
          }
        }
      } finally {
        isReconciling = false;
      }
    },
    async receive(msg) {
      const state = agents.get(msg.agentId);
      if (!state || !state.discord.connected) return;
      if (state.discord.presence !== 'offline') {
        // Starting or available: the agent has a run, so the message goes to it (its mailbox holds the message
        // until the run polls). Waking again would queue a second run behind the one that is starting.
        try {
          await opts.handoff(msg);
        } catch (err) {
          // The agent is out of budget: say so from the Gatekeeper; the agent never sees the message.
          if (err instanceof WakeRefusedError) await state.discord.refuseWake?.(msg.channelId, err.window, err.kind).catch(() => {});
          else if (err instanceof UnauthorizedCallerError) await state.discord.refuseUnauthorized?.(msg.channelId).catch(() => {});
          else console.error(`[gatekeeper-ingress] handoff ${msg.agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      }
      // A wake request is not readiness: show starting until the control plane reports the run ready.
      await state.discord.setPresence('starting');
      try {
        await opts.wake(msg.agentId, msg);
      } catch (err) {
        if (err instanceof WakeRefusedError) await state.discord.refuseWake?.(msg.channelId, err.window, err.kind).catch(() => {});
        else if (err instanceof UnauthorizedCallerError) await state.discord.refuseUnauthorized?.(msg.channelId).catch(() => {});
        else console.error(`[gatekeeper-ingress] wake ${msg.agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
        // Re-read: the control plane may have moved presence on while the wake was in flight.
        if ((state.discord.presence as Presence) === 'starting') await state.discord.setPresence('offline');
      }
    },
    async askPending() {
      const approvals = opts.approvals;
      if (!approvals) return;
      for (const [agentId, state] of agents) {
        if (!state.discord.connected || !state.discord.send) continue;
        let prompts: ApprovalPrompt[];
        try {
          prompts = await approvals.prompts(agentId);
        } catch (err) {
          console.error(`[gatekeeper-ingress] approval prompts for ${agentId}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        for (const p of prompts) {
          // Only where a person who may decide it has spoken to this agent; the most recent such place.
          const where = p.deciders
            .map((id) => lastSeen.get(seenKey(agentId, id)))
            .filter((x): x is { channelId: string; at: number } => !!x)
            .sort((a, b) => b.at - a.at)[0];
          if (!where) continue;
          if (!(await state.discord.send(where.channelId, p.text).catch(() => false))) continue;
          await approvals.asked(p.approvalId, where.channelId).catch((err) => console.error(`[gatekeeper-ingress] recording the question ${p.approvalId} failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    },
    async onAgentIdle(agentId) {
      const state = agents.get(agentId);
      if (!state || !state.discord.connected) return;
      await state.discord.setPresence('offline');
    },
    async onAgentStarting(agentId) {
      const state = agents.get(agentId);
      if (!state || !state.discord.connected) return;
      // Never downgrade a ready agent: a late starting notice must not hide a run that already reported ready.
      if (state.discord.presence === 'available') return;
      await state.discord.setPresence('starting');
    },
    async onAgentWorking(agentId) {
      const state = agents.get(agentId);
      if (!state || !state.discord.connected) return;
      await state.discord.setPresence('available');
    },
    async onAgentActivity(agentId, activity) {
      const state = agents.get(agentId);
      if (!state || !state.discord.connected) return;
      await state.discord.recordActivity?.(activity);
    },
  };
  
  return gatekeeperIngress;
}
