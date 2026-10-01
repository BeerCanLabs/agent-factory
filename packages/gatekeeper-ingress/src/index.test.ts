import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperIngress, fakeDiscordClient } from './index.js';

describe('gatekeeper-ingress', () => {
  it('stays idle when no Discord token is bound', async () => {
    const gw = fakeDiscordClient();
    const woken: string[] = [];
    const door = createGatekeeperIngress({
      discord: gw,
      providers: [envProvider({})],
      wake: async (id) => {
        woken.push(id);
      },
      handoff: async () => {},
    });
    await door.reconcile([{ agentId: 'echo-agent', secretRef: 'DISCORD_BOT_TOKEN' }]);
    assert.equal(door.status().discord, 'idle');
    assert.equal(gw.connected, false);
    assert.equal(woken.length, 0);
  });

  const msg = (messageId: string, content: string) => ({ agentId: 'echo-agent', channelId: 'c1', messageId, content, authorId: 'u1' });

  async function connected(wake: (id: string) => Promise<void> = async () => {}) {
    const gw = fakeDiscordClient();
    const woken: string[] = [];
    const handed: string[] = [];
    const door = createGatekeeperIngress({
      discord: gw,
      providers: [envProvider({ DISCORD_BOT_TOKEN: 'bot-token' })],
      wake: async (id) => {
        woken.push(id);
        await wake(id);
      },
      handoff: async (m) => {
        handed.push(m.content);
      },
    });
    await door.reconcile([{ agentId: 'echo-agent', secretRef: 'DISCORD_BOT_TOKEN' }]);
    return { gw, door, woken, handed };
  }

  it('P1: a message to a sleeping agent wakes it and shows starting, not available', async () => {
    const { gw, door, woken, handed } = await connected();
    assert.equal(door.status().discord, 'connected');
    assert.equal(gw.presence, 'offline');

    await door.receive(msg('m1', 'hello'));
    assert.deepEqual(woken, ['echo-agent']);
    assert.deepEqual(handed, []);
    assert.equal(gw.presence, 'starting', 'a wake request is not readiness');
    assert.equal(gw.connected, true);
  });

  it('P1: messages while the agent is starting go to its run, without a second wake', async () => {
    const { gw, door, woken, handed } = await connected();
    await door.receive(msg('m1', 'hello'));
    await door.receive(msg('m2', 'are you there?'));
    assert.deepEqual(woken, ['echo-agent'], 'must NOT wake again while starting');
    assert.deepEqual(handed, ['are you there?']);
    assert.equal(gw.presence, 'starting');
  });

  it('P1: only the control plane readiness signal makes the agent available; idle takes it offline', async () => {
    const { gw, door, woken, handed } = await connected();
    await door.receive(msg('m1', 'hello'));
    await door.onAgentWorking('echo-agent');
    assert.equal(gw.presence, 'available');

    // Reconcile runs in background while agent is warm and working
    await door.reconcile([{ agentId: 'echo-agent', secretRef: 'DISCORD_BOT_TOKEN' }]);
    assert.equal(gw.presence, 'available', 'reconcile must NOT clobber available presence back to offline');

    await door.receive(msg('m2', 'how are you?'));
    assert.deepEqual(woken, ['echo-agent'], 'must NOT wake again while available');
    assert.deepEqual(handed, ['how are you?']);

    await door.onAgentIdle('echo-agent');
    assert.equal(gw.presence, 'offline');
    assert.equal(gw.connected, true);
  });

  it('P1: a wake from elsewhere shows starting, and a late starting notice never hides a ready agent', async () => {
    const { gw, door, woken, handed } = await connected();
    await door.onAgentStarting('echo-agent');
    assert.equal(gw.presence, 'starting', 'a dashboard or cron wake also shows starting');
    await door.receive(msg('m1', 'hello'));
    assert.deepEqual(woken, [], 'the starting run takes the message; no second run is queued');
    assert.deepEqual(handed, ['hello']);

    await door.onAgentWorking('echo-agent');
    await door.onAgentStarting('echo-agent');
    assert.equal(gw.presence, 'available');
  });

  it('P1: a refused wake returns presence to offline so the next message wakes again', async () => {
    let refuse = true;
    const { gw, door, woken } = await connected(async () => {
      if (refuse) throw new Error('factory answered 412');
    });
    await door.receive(msg('m1', 'hello'));
    assert.equal(gw.presence, 'offline');
    refuse = false;
    await door.receive(msg('m2', 'hello again'));
    assert.deepEqual(woken, ['echo-agent', 'echo-agent']);
    assert.equal(gw.presence, 'starting');
  });
});
