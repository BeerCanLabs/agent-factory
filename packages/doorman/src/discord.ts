import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
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

  client.on(Events.MessageCreate, (message) => {
    // Ignore own messages
    if (message.author.id === client.user?.id) return;
    
    // Ignore messages from other bots
    if (message.author.bot) return;
    
    // Check if it's a DM or if we were mentioned in a guild
    const isDM = message.guildId === null;
    const isMentioned = client.user && message.mentions.has(client.user.id);
    
    if (isDM || isMentioned) {
      console.log(`[doorman] Discord message received in channel ${message.channelId} from ${message.author.id}`);
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

  let currentPresence: Presence = 'offline';

  client.on(Events.ClientReady, () => {
    console.log(`[doorman] Discord gateway ready as ${client.user?.tag}`);
    client.user?.setStatus(currentPresence === 'offline' ? 'invisible' : 'online');
  });

  return {
    get connected() {
      return client.isReady();
    },
    get presence(): Presence {
      return client.user?.presence?.status === 'invisible' ? 'offline' : 'available';
    },
    async login(token: string) {
      if (client.isReady()) return;
      await client.login(token);
    },
    async setPresence(status: Presence) {
      currentPresence = status;
      if (!client.isReady()) return;
      client.user?.setStatus(status === 'offline' ? 'invisible' : 'online');
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    async destroy() {
      await client.destroy();
    },
  };
}
