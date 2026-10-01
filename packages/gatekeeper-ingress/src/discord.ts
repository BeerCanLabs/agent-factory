import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import type { DiscordClient, Conversation, Presence } from './index.js';

interface StandbySession {
  messageId: string;
  typingInterval: NodeJS.Timeout;
  warnTimer: NodeJS.Timeout;
  failTimer: NodeJS.Timeout;
}

export function createDiscordClient(): DiscordClient {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  const handlers: Array<(msg: Omit<Conversation, 'agentId'>) => void> = [];
  const standbySessions = new Map<string, StandbySession>(); // channelId -> StandbySession
  let currentPresence: Presence = 'offline';
  let agentName = 'your agent';
  const seenMessageIds = new Set<string>();
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
        try {
          const standbyMsg = await message.channel.messages.fetch(standbyId);
          if (standbyMsg) {
            await standbyMsg.delete();
          }
        } catch {
          // ignore delete errors (e.g. already deleted or missing perm)
        }
      }
      client.user?.setPresence({
        status: discordStatus(currentPresence),
        activities: [],
      });
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

          client.user?.setActivity(`Getting ${agentName} (~30s)...`, { type: ActivityType.Custom });
          const sent = await message.channel.send(
            `⏳ *Standby while I get ${agentName} for you — should take about 30 seconds...*`
          );

          // 2. Warning trigger at 30 seconds if agent has not yet responded
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
              console.warn('[gatekeeper-ingress] Failed to update 30s standby message:', err);
            }
          }, 30_000);

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
      } else {
        // Keep typing indicator active if already in a session or active conversation
        void message.channel.sendTyping().catch(() => {});
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
    async setPresence(status: Presence) {
      currentPresence = status;
      if (!client.isReady()) return;
      client.user?.setStatus(discordStatus(status));
      if (status === 'offline') {
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
      await client.destroy();
    },
  };
}
