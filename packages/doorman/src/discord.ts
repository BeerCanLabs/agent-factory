import { Client, GatewayIntentBits, Partials, Events, ActivityType } from 'discord.js';
import type { Gateway, Conversation, Presence } from './index.js';

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
  const standbyMessages = new Map<string, string>(); // channelId -> standby messageId
  let currentPresence: Presence = 'offline';
  let agentName = 'your agent';

  client.on(Events.MessageCreate, async (message) => {
    // If it's a message from this bot, check if there is a standby message to auto-delete
    if (message.author.id === client.user?.id) {
      const pendingStandby = standbyMessages.get(message.channelId);
      if (pendingStandby) {
        standbyMessages.delete(message.channelId);
        try {
          await message.channel.messages.delete(pendingStandby);
        } catch {
          // ignore delete errors (e.g. already deleted or missing perm)
        }
      }
      client.user?.setPresence({ activities: [] });
      return;
    }

    // Ignore messages from other bots
    if (message.author.bot) return;

    // Check if it's a DM or if we were mentioned in a guild
    const isDM = message.guildId === null;
    const isMentioned = client.user && message.mentions.has(client.user.id);

    if (isDM || isMentioned) {
      console.log(`[doorman] Discord message received in channel ${message.channelId} from ${message.author.id}`);

      // 1. Immediately trigger Discord typing indicator
      void message.channel.sendTyping().catch(() => {});

      // 2. If the agent is currently offline (sleeping), send standby message and set booting activity
      if (currentPresence === 'offline') {
        try {
          client.user?.setActivity(`Booting up ${agentName}...`, { type: ActivityType.Custom });
          const sent = await message.channel.send(`⏳ *Standby, while I get ${agentName} for you...*`);
          standbyMessages.set(message.channelId, sent.id);
        } catch (err) {
          console.warn('[doorman] Failed to send standby message:', err);
        }
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
      await client.destroy();
    },
  };
}
