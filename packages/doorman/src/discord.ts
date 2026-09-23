import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import type { Gateway, Conversation, Presence } from './index.js';

interface StandbySession {
  messageId: string;
  typingInterval: NodeJS.Timeout;
  warnTimer: NodeJS.Timeout;
  failTimer: NodeJS.Timeout;
}

export function createDiscordGateway(): Gateway {
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
        status: currentPresence === 'offline' ? 'invisible' : 'online',
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
      console.log(`[doorman] Discord message received in channel ${message.channelId} from ${message.author.id}`);

      // If the agent is currently offline (sleeping), start standby session with recurring typing and timers
      if (currentPresence === 'offline' && !standbySessions.has(message.channelId)) {
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
              console.warn('[doorman] Failed to update 30s standby message:', err);
            }
          }, 30_000);

          // 3. Failure trigger at 75 seconds if agent completely fails to load
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
              console.warn('[doorman] Failed to update failure standby message:', err);
            }
            clearStandbySession(message.channelId);
            client.user?.setPresence({ activities: [] });
          }, 75_000);

          standbySessions.set(message.channelId, {
            messageId: sent.id,
            typingInterval,
            warnTimer,
            failTimer,
          });
        } catch (err) {
          console.warn('[doorman] Failed to start standby session:', err);
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
    console.log(`[doorman] Discord gateway ready as ${client.user?.tag}`);
    client.user?.setStatus(currentPresence === 'offline' ? 'invisible' : 'online');
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
      client.user?.setStatus(status === 'offline' ? 'invisible' : 'online');
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
