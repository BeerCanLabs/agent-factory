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
  gateway: Gateway;
  providers: SecretProvider[];
  wake: (agentId: string) => Promise<void>;
  handoff: (msg: Conversation) => Promise<void>;
}): Doorman {
  let boundAgent: string | undefined;
  let boundRef: string | undefined;

  return {
    status() {
      return {
        discord: opts.gateway.connected ? 'connected' : 'idle',
        presence: opts.gateway.presence,
        agentId: boundAgent,
      };
    },
    async reconcile(surfaces) {
      if (surfaces.length === 0) return;
      const surface = surfaces[0];
      const bound = await bindSecrets([surface.secretRef], opts.providers);
      if (!bound.ok) {
        return;
      }
      if (!opts.gateway.connected) {
        await opts.gateway.login(bound.env[surface.secretRef]);
        await opts.gateway.setPresence('offline');
        boundAgent = surface.agentId;
        boundRef = surface.secretRef;
        opts.gateway.onMessage((msg) => {
          void this.receive({ ...msg, agentId: surface.agentId });
        });
      } else if (boundAgent !== surface.agentId) {
        boundAgent = surface.agentId;
        boundRef = surface.secretRef;
      }
      void boundRef;
    },
    async receive(msg) {
      if (!opts.gateway.connected) return;
      await opts.wake(msg.agentId);
      await opts.gateway.setPresence('available');
      await opts.handoff(msg);
    },
    async onAgentIdle(agentId) {
      if (boundAgent !== agentId || !opts.gateway.connected) return;
      await opts.gateway.setPresence('offline');
    },
    async onAgentWorking(agentId) {
      if (boundAgent !== agentId || !opts.gateway.connected) return;
      await opts.gateway.setPresence('available');
    },
  };
}
