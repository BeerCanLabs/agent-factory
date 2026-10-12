import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import type { DiscordClient, Conversation, Presence, AgentActivity } from './index.js';
import { wakeRefusedText, unauthorizedCallerText } from './wake.js';

interface StandbySession {
  messageId: string;
  typingInterval: NodeJS.Timeout;
  warnTimer: NodeJS.Timeout;
  failTimer: NodeJS.Timeout;
}

interface ActiveTurnSession {
  channelId: string;
  channel: { sendTyping: () => Promise<unknown> };
  typingInterval?: NodeJS.Timeout;
  lastActivityAt: number;
  lastTypingAt: number;
  currentTool?: string;
}

export function createDiscordClient(
  client: Client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  })
): DiscordClient {
  const handlers: Array<(msg: Omit<Conversation, 'agentId'>) => void> = [];
  const standbySessions = new Map<string, StandbySession>(); // channelId -> StandbySession
  const activeTurns = new Map<string, ActiveTurnSession>(); // channelId -> ActiveTurnSession
  const turnLeaseMs = Number(process.env.GATEKEEPER_INGRESS_TURN_LEASE_MS) || 30_000;
  let currentPresence: Presence = 'offline';
  let agentName = 'your agent';
  const seenMessageIds = new Set<string>();
  const recentUnauthorized = new Map<string, number>();
  /** Discord shows starting as idle (yellow): a wake is in progress, the agent cannot take a turn yet. */
  const discordStatus = (p: Presence) => (p === 'offline' ? 'invisible' : p === 'starting' ? 'idle' : 'online');

  function clearStandbySession(channelId: string) {
    const session = standbySessions.get(channelId);
    if (!session) return;
    clearInterval(session.typingInterval);
    clearTimeout(session.warnTimer);
    clearTimeout(session.failTimer);
    standbySessions.delete(channelId);
  }

  function clearActiveTurn(channelId: string) {
    const turn = activeTurns.get(channelId);
    if (!turn) return;
    if (turn.typingInterval) {
      clearInterval(turn.typingInterval);
    }
    activeTurns.delete(channelId);
  }

  function startActiveTurn(channelId: string, channel: { sendTyping: () => Promise<unknown> }) {
    clearActiveTurn(channelId);
    const now = Date.now();
    void channel.sendTyping().catch(() => {});

    let typingInterval: NodeJS.Timeout | undefined;
    if (!standbySessions.has(channelId)) {
      typingInterval = setInterval(() => {
        const turn = activeTurns.get(channelId);
        if (!turn) {
          if (typingInterval) clearInterval(typingInterval);
          return;
        }
        if (Date.now() - turn.lastActivityAt > turnLeaseMs) {
          console.log(`[gatekeeper-ingress] Turn lease expired for channel ${channelId}, going silent.`);
          clearActiveTurn(channelId);
          if (activeTurns.size === 0) {
            client.user?.setPresence({
              status: discordStatus(currentPresence),
              activities: [],
            });
          }
          return;
        }
        turn.lastTypingAt = Date.now();
        void turn.channel.sendTyping().catch(() => {});
      }, 7000);
    }

    activeTurns.set(channelId, {
      channelId,
      channel,
      typingInterval,
      lastActivityAt: now,
      lastTypingAt: now,
    });
  }

  client.on(Events.MessageCreate, async (message) => {
    // If it's a message from this bot
    if (message.author.id === client.user?.id) {
      const session = standbySessions.get(message.channelId);
      if (session) {
        // If this message IS the standby message we just sent/edited, ignore it!
        if (message.id === session.messageId) {
          return;
        }

        // This is the real reply from the agent container!
        const standbyId = session.messageId;
        clearStandbySession(message.channelId);
        if (currentPresence === 'starting') {
          currentPresence = 'available';
        }
        try {
          const standbyMsg = await message.channel.messages.fetch(standbyId);
          if (standbyMsg) {
            await standbyMsg.delete();
          }
        } catch {
          // ignore delete errors (e.g. already deleted or missing perm)
        }
      }
      clearActiveTurn(message.channelId);
      if (activeTurns.size === 0) {
        client.user?.setPresence({
          status: discordStatus(currentPresence),
          activities: [],
        });
      }
      return;
    }

    // Ignore messages from other bots
    if (message.author.bot) return;

    // Check if it's a DM or if we were mentioned in a guild
    const isDM = message.guildId === null;
    const isMentioned = client.user && message.mentions.has(client.user.id);

    if (isDM || isMentioned) {
      if (seenMessageIds.has(message.id)) {
        return;
      }
      seenMessageIds.add(message.id);
      if (seenMessageIds.size > 2000) {
        const first = seenMessageIds.values().next().value;
        if (first) seenMessageIds.delete(first);
      }

      console.log(`[gatekeeper-ingress] Discord message received in channel ${message.channelId} from ${message.author.id}`);

      // If the agent cannot take a turn yet (asleep or still starting), start a standby session with recurring
      // typing and timers; the agent's first reply in the channel clears it.
      if (currentPresence !== 'available' && !standbySessions.has(message.channelId)) {
        try {
          // 1. Immediately trigger typing indicator and repeat every 7s so it doesn't expire
          void message.channel.sendTyping().catch(() => {});
          const typingInterval = setInterval(() => {
            void message.channel.sendTyping().catch(() => {});
          }, 7000);

          client.user?.setActivity(`Getting ${agentName} (up to 90s)...`, { type: ActivityType.Custom });
          const sent = await message.channel.send(
            `⏳ *Standby while I get ${agentName} for you — this can take up to 90 seconds...*`
          );

          // 2. Warning at 90 seconds if the agent has not yet responded. A cold wake measured 40-50 s on 2026-10-02
          // (Fargate provisioning, image pull, memory download, first model call), so 30 s warned on every wake.
          const warnTimer = setTimeout(async () => {
            try {
              const current = standbySessions.get(message.channelId);
              if (current && current.messageId === sent.id) {
                const msg = await message.channel.messages.fetch(sent.id);
                if (msg) {
                  await msg.edit(`⏳ *This is taking longer than expected. Still waiting on ${agentName}...*`);
                }
              }
            } catch (err) {
              console.warn('[gatekeeper-ingress] Failed to update 90s standby message:', err);
            }
          }, 90_000);

          // 3. Failure trigger (default 180s, configurable via GATEKEEPER_INGRESS_STANDBY_TIMEOUT_MS) if agent completely fails to load
          const failureTimeoutMs = Number(process.env.GATEKEEPER_INGRESS_STANDBY_TIMEOUT_MS) || 180_000;
          const failTimer = setTimeout(async () => {
            try {
              const current = standbySessions.get(message.channelId);
              if (current && current.messageId === sent.id) {
                const msg = await message.channel.messages.fetch(sent.id);
                if (msg) {
                  await msg.edit(`❌ *${agentName} failed to load — please contact your support staff or try again later.*`);
                }
              }
            } catch (err) {
              console.warn('[gatekeeper-ingress] Failed to update failure standby message:', err);
            }
            clearStandbySession(message.channelId);
            clearActiveTurn(message.channelId);
            client.user?.setPresence({ activities: [] });
          }, failureTimeoutMs);

          standbySessions.set(message.channelId, {
            messageId: sent.id,
            typingInterval,
            warnTimer,
            failTimer,
          });
        } catch (err) {
          console.warn('[gatekeeper-ingress] Failed to start standby session:', err);
        }
        startActiveTurn(message.channelId, message.channel);
      } else {
        // Keep typing indicator active with activity lease tracking
        startActiveTurn(message.channelId, message.channel);
      }

      for (const handler of handlers) {
        handler({
          channelId: message.channelId,
          messageId: message.id,
          content: message.content,
          authorId: message.author.id,
        });
      }
    }
  });

  client.on(Events.ClientReady, () => {
    console.log(`[gatekeeper-ingress] Discord ready as ${client.user?.tag}`);
    client.user?.setStatus(discordStatus(currentPresence));
  });

  return {
    get connected() {
      return client.isReady();
    },
    get presence(): Presence {
      return currentPresence;
    },
    setAgentName(name: string) {
      if (name) agentName = name;
    },
    async login(token: string) {
      if (client.isReady()) return;
      await client.login(token);
    },
    async recordActivity(activity: AgentActivity) {
      const toolName =
        activity.tool ||
        (activity.route && !activity.route.startsWith('models') && !activity.route.startsWith('model:') ? activity.route : undefined);
      const isModel = Boolean(activity.model || activity.route?.startsWith('model'));

      let text: string;
      if (activity.kind === 'call.start') {
        if (toolName) {
          text = `Tool: ${toolName}...`;
        } else if (isModel) {
          text = 'Thinking...';
        } else {
          text = 'Working...';
        }
      } else if (activity.kind === 'call.end') {
        text = 'Thinking...';
      } else {
        text = toolName ? `Tool: ${toolName}...` : 'Thinking...';
      }

      if (text.length > 120) {
        text = text.slice(0, 117) + '...';
      }

      client.user?.setActivity(text, { type: ActivityType.Custom });

      const now = Date.now();
      for (const turn of activeTurns.values()) {
        turn.lastActivityAt = now;
        turn.currentTool = toolName;
        if (!turn.typingInterval && !standbySessions.has(turn.channelId)) {
          turn.typingInterval = setInterval(() => {
            if (Date.now() - turn.lastActivityAt > turnLeaseMs) {
              clearActiveTurn(turn.channelId);
              if (activeTurns.size === 0) {
                client.user?.setPresence({
                  status: discordStatus(currentPresence),
                  activities: [],
                });
              }
              return;
            }
            turn.lastTypingAt = Date.now();
            void turn.channel.sendTyping().catch(() => {});
          }, 7000);
        }
        if (now - turn.lastTypingAt > 4000) {
          turn.lastTypingAt = now;
          void turn.channel.sendTyping().catch(() => {});
        }
      }
    },
    async refuseWake(channelId: string, window: string, kind: 'wake' | 'handoff' = 'wake') {
      const session = standbySessions.get(channelId);
      clearStandbySession(channelId);
      clearActiveTurn(channelId);
      if (activeTurns.size === 0) {
        client.user?.setPresence({ activities: [] });
      }
      const text = wakeRefusedText(agentName, window, kind);
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'send' in channel && 'messages' in channel) {
          if (session) await (await channel.messages.fetch(session.messageId)).edit(text);
          else await channel.send(text);
        }
      } catch (err) {
        console.warn('[gatekeeper-ingress] Failed to post the wake refusal:', err);
      }
    },
    async refuseUnauthorized(channelId: string) {
      const session = standbySessions.get(channelId);
      clearStandbySession(channelId);
      clearActiveTurn(channelId);
      if (activeTurns.size === 0) {
        client.user?.setPresence({ activities: [] });
      }
      const last = recentUnauthorized.get(channelId);
      if (last && Date.now() - last < 15_000 && !session) {
        return;
      }
      recentUnauthorized.set(channelId, Date.now());
      const text = unauthorizedCallerText(agentName);
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel && 'send' in channel && 'messages' in channel) {
          if (session) await (await channel.messages.fetch(session.messageId)).edit(text);
          else await channel.send(text);
        }
      } catch (err) {
        console.warn('[gatekeeper-ingress] Failed to post the unauthorized refusal:', err);
      }
    },
    async setPresence(status: Presence) {
      currentPresence = status;
      if (!client.isReady()) return;
      client.user?.setStatus(discordStatus(status));
      if (status === 'offline') {
        for (const channelId of activeTurns.keys()) {
          clearActiveTurn(channelId);
        }
        client.user?.setPresence({ activities: [] });
      }
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    async destroy() {
      for (const channelId of standbySessions.keys()) {
        clearStandbySession(channelId);
      }
      for (const channelId of activeTurns.keys()) {
        clearActiveTurn(channelId);
      }
      await client.destroy();
    },
  };
}
