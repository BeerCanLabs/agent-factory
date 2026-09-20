import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';

export type Presence = 'offline' | 'available';

export type Conversation = {
  agentId: string;
  channelId: string;
  messageId: string;
  content: string;
  authorId: string;
};

export type Gateway = {
  connected: boolean;
  presence: Presence;
  login(token: string): Promise<void>;
  setPresence(status: Presence): Promise<void>;
  onMessage(handler: (msg: Omit<Conversation, 'agentId'>) => void): void;
  destroy(): Promise<void>;
};

export function fakeGateway(): Gateway {
  const handlers: Array<(msg: Omit<Conversation, 'agentId'>) => void> = [];
  return {
    connected: false,
    presence: 'offline',
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
  secretRef: string;
};

export type Doorman = {
  status(): { discord: 'idle' | 'connected'; presence: Presence; agentId?: string };
  reconcile(surfaces: DiscordSurface[]): Promise<void>;
  /** Inbound Discord activity: wake factory, mark available, hand off. */
  receive(msg: Conversation): Promise<void>;
  /** Control plane tells us the agent scaled to zero. Keep the socket. */
  onAgentIdle(agentId: string): Promise<void>;
  onAgentWorking(agentId: string): Promise<void>;
};

export function createDoorman(opts: {
  gateway?: Gateway;
  gatewayFactory?: () => Gateway;
  providers: SecretProvider[];
  wake: (agentId: string, msg?: unknown) => Promise<void>;
  handoff: (msg: Conversation) => Promise<void>;
}): Doorman {
  const agents = new Map<string, { ref: string; gateway: Gateway }>();

  const doorman: Doorman = {
    status() {
      // Just returning the status of the first one for backwards compatibility of the healthcheck format
      // In a real app we'd want to return a list of agent statuses
      const first = [...agents.values()][0];
      return {
        discord: first?.gateway.connected ? 'connected' : 'idle',
        presence: first?.gateway.presence || 'offline',
        agentId: agents.keys().next().value,
      };
    },
    async reconcile(surfaces) {
      if (surfaces.length === 0) return;
      
      const desiredAgents = new Set(surfaces.map(s => s.agentId));
      
      // Destroy gateways for agents no longer requested
      for (const [agentId, state] of agents) {
        if (!desiredAgents.has(agentId)) {
          await state.gateway.destroy();
          agents.delete(agentId);
        }
      }

      // Create and login new gateways
      for (const surface of surfaces) {
        if (agents.has(surface.agentId)) continue; // Already running

        const bound = await bindSecrets([surface.secretRef], opts.providers);
        if (!bound.ok || !bound.env[surface.secretRef]) {
          console.error(`[doorman] failed to bind secret ${surface.secretRef} for ${surface.agentId}`);
          continue;
        }

        const gateway = opts.gatewayFactory ? opts.gatewayFactory() : (opts.gateway || fakeGateway());
        agents.set(surface.agentId, { ref: surface.secretRef, gateway });
        
        try {
          await gateway.login(bound.env[surface.secretRef]);
          await gateway.setPresence('offline');
          
          gateway.onMessage((msg) => {
            void doorman.receive({ ...msg, agentId: surface.agentId });
          });
          console.log(`[doorman] connected Discord gateway for ${surface.agentId}`);
        } catch (err) {
          console.error(`[doorman] Discord login failed for ${surface.agentId}:`, err);
          agents.delete(surface.agentId);
        }
      }
    },
    async receive(msg) {
      const state = agents.get(msg.agentId);
      if (!state || !state.gateway.connected) return;
      await opts.wake(msg.agentId, msg);
      await state.gateway.setPresence('available');
      await opts.handoff(msg);
    },
    async onAgentIdle(agentId) {
      const state = agents.get(agentId);
      if (!state || !state.gateway.connected) return;
      await state.gateway.setPresence('offline');
    },
    async onAgentWorking(agentId) {
      const state = agents.get(agentId);
      if (!state || !state.gateway.connected) return;
      await state.gateway.setPresence('available');
    },
  };
  
  return doorman;
}
