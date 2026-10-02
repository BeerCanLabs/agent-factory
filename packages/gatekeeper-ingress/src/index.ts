import { bindSecrets, type SecretProvider } from '@beercanlabs/factory-secrets-bind';

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
  /** Inbound Discord activity: wake a sleeping agent (presence `starting`), otherwise hand off to its run. */
  receive(msg: Conversation): Promise<void>;
  /** Control plane tells us the agent scaled to zero. Keep the socket. */
  onAgentIdle(agentId: string): Promise<void>;
  /** Control plane tells us a run is starting for the agent; it cannot take a turn yet. */
  onAgentStarting(agentId: string): Promise<void>;
  /** Control plane tells us the agent's run is ready to take a turn. */
  onAgentWorking(agentId: string): Promise<void>;
};

export function createGatekeeperIngress(opts: {
  discord?: DiscordClient;
  discordFactory?: () => DiscordClient;
  providers: SecretProvider[];
  /** Rejects if the factory did not accept the wake, so presence falls back to offline. */
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

          const upperAgent = surface.agentId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
          const candidates = [
            surface.secretRef,
            `agents/${surface.agentId.toLowerCase()}/discord/${surface.secretRef.toLowerCase()}`,
            `agents/${surface.agentId.toLowerCase()}/discord/bot_token`,
            `shared/discord/${surface.secretRef.toLowerCase()}`,
            `${upperAgent}_DISCORD_BOT_TOKEN`,
            `${upperAgent}_${surface.secretRef.toUpperCase()}`,
          ];
          const uniqueCandidates = [...new Set(candidates)];
          let token: string | undefined;
          for (const cand of uniqueCandidates) {
            const bound = await bindSecrets([cand], opts.providers);
            if (bound.ok && bound.env[cand]) {
              token = bound.env[cand];
              break;
            }
          }
          if (!token) {
            console.warn(`[gatekeeper-ingress] failed to bind secret for ${surface.agentId} (tried: ${uniqueCandidates.join(', ')})`);
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
            await discord.login(token);
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
      if (state.discord.presence !== 'offline') {
        // Starting or available: the agent has a run, so the message goes to it (its mailbox holds the message
        // until the run polls). Waking again would queue a second run behind the one that is starting.
        await opts.handoff(msg);
        return;
      }
      // A wake request is not readiness: show starting until the control plane reports the run ready.
      await state.discord.setPresence('starting');
      try {
        await opts.wake(msg.agentId, msg);
      } catch (err) {
        console.error(`[gatekeeper-ingress] wake ${msg.agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
        // Re-read: the control plane may have moved presence on while the wake was in flight.
        if ((state.discord.presence as Presence) === 'starting') await state.discord.setPresence('offline');
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
  };
  
  return gatekeeperIngress;
}
