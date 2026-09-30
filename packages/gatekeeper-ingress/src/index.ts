import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';

export type Presence = 'offline' | 'available';

export type Conversation = {
  agentId: string;
  channelId: string;
  messageId: string;
  content: string;
  authorId: string;
};

export type DiscordClient = {
  connected: boolean;
  presence: Presence;
  login(token: string): Promise<void>;
  setPresence(status: Presence): Promise<void>;
  setAgentName?(name: string): void;
  onMessage(handler: (msg: Omit<Conversation, 'agentId'>) => void): void;
  destroy(): Promise<void>;
};

export function fakeDiscordClient(): DiscordClient {
  const handlers: Array<(msg: Omit<Conversation, 'agentId'>) => void> = [];
  return {
    connected: false,
    presence: 'offline',
    setAgentName(_name) {},
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

export type GatekeeperIngress = {
  status(): { discord: 'idle' | 'connected'; presence: Presence; agentId?: string };
  reconcile(surfaces: DiscordSurface[]): Promise<void>;
  /** Inbound Discord activity: wake factory, mark available, hand off. */
  receive(msg: Conversation): Promise<void>;
  /** Control plane tells us the agent scaled to zero. Keep the socket. */
  onAgentIdle(agentId: string): Promise<void>;
  onAgentWorking(agentId: string): Promise<void>;
};

export function createGatekeeperIngress(opts: {
  discord?: DiscordClient;
  discordFactory?: () => DiscordClient;
  providers: SecretProvider[];
  wake: (agentId: string, msg?: unknown) => Promise<void>;
  handoff: (msg: Conversation) => Promise<void>;
}): GatekeeperIngress {
  const agents = new Map<string, { ref: string; discord: DiscordClient }>();
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
      if (state.discord.presence === 'offline') {
        await state.discord.setPresence('available');
        await opts.wake(msg.agentId, msg);
      } else {
        await opts.handoff(msg);
      }
    },
    async onAgentIdle(agentId) {
      const state = agents.get(agentId);
      if (!state || !state.discord.connected) return;
      await state.discord.setPresence('offline');
    },
    async onAgentWorking(agentId) {
      const state = agents.get(agentId);
      if (!state || !state.discord.connected) return;
      await state.discord.setPresence('available');
    },
  };
  
  return gatekeeperIngress;
}
