import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { createDoorman, fakeGateway } from './index.js';

describe('doorman', () => {
  it('stays idle when no Discord token is bound', async () => {
    const gw = fakeGateway();
    const woken: string[] = [];
    const door = createDoorman({
      gateway: gw,
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

  it('connects offline, wakes and becomes available on message, offline on idle', async () => {
    const gw = fakeGateway();
    const woken: string[] = [];
    const handed: string[] = [];
    const door = createDoorman({
      gateway: gw,
      providers: [envProvider({ DISCORD_BOT_TOKEN: 'bot-token' })],
      wake: async (id) => {
        woken.push(id);
      },
      handoff: async (msg) => {
        handed.push(msg.content);
      },
    });
    await door.reconcile([{ agentId: 'echo-agent', secretRef: 'DISCORD_BOT_TOKEN' }]);
    assert.equal(door.status().discord, 'connected');
    assert.equal(gw.presence, 'offline');

    await door.receive({
      agentId: 'echo-agent',
      channelId: 'c1',
      messageId: 'm1',
      content: 'hello',
      authorId: 'u1',
    });
    assert.deepEqual(woken, ['echo-agent']);
    assert.deepEqual(handed, ['hello']);
    assert.equal(gw.presence, 'available');
    assert.equal(gw.connected, true);

    await door.onAgentIdle('echo-agent');
    assert.equal(gw.presence, 'offline');
    assert.equal(gw.connected, true);
  });
});
