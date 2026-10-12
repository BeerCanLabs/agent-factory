import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import { createDiscordClient } from './discord.js';

function createMockClient() {
  const emitter = new EventEmitter();
  const activities: Array<{ name: string; options?: unknown }> = [];
  let presenceStatus = 'online';

  const mockUser = {
    id: 'bot-id-123',
    tag: 'TestBot#0001',
    setStatus(status: string) {
      presenceStatus = status;
    },
    setActivity(name: string, options?: unknown) {
      activities.push({ name, options });
    },
    setPresence(data: { status?: string; activities?: unknown[] }) {
      if (data.status) presenceStatus = data.status;
      if (data.activities && data.activities.length === 0) {
        activities.length = 0;
      }
    },
  };

  const mockClient = Object.assign(emitter, {
    user: mockUser,
    isReady: () => true,
    channels: {
      fetch: async () => undefined,
    },
    login: async () => 'token',
    destroy: async () => {},
  });

  return { mockClient, activities, getStatus: () => presenceStatus };
}

describe('gatekeeper-ingress discord client', () => {
  it('starts active turn and pulses sendTyping on incoming user message', async () => {
    const { mockClient } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');

    let typingCalls = 0;
    const channel = {
      sendTyping: async () => {
        typingCalls++;
      },
    };

    const userMessage = {
      id: 'm1',
      channelId: 'ch1',
      guildId: null, // DM
      author: { id: 'u1', bot: false },
      channel,
      mentions: { has: () => false },
      content: 'hello',
    };

    // User sends a message
    mockClient.emit(Events.MessageCreate, userMessage);
    assert.equal(typingCalls, 1, 'immediately pulses typing');
    await discord.destroy();
  });

  it('updates bot activity to Tool: <name>... and pulses typing on tool start', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');

    let typingCalls = 0;
    const channel = {
      sendTyping: async () => {
        typingCalls++;
      },
    };

    mockClient.emit(Events.MessageCreate, {
      id: 'm1',
      channelId: 'ch1',
      guildId: null,
      author: { id: 'u1', bot: false },
      channel,
      mentions: { has: () => false },
      content: 'search something',
    });
    assert.equal(typingCalls, 1);

    // Agent calls tool via gatekeeper
    await discord.recordActivity?.({
      route: 'tavily',
      kind: 'call.start',
    });

    assert.equal(activities.length, 1);
    assert.equal(activities[0].name, 'Tool: tavily...');

    // Tool finishes -> thinking
    await discord.recordActivity?.({
      route: 'tavily',
      kind: 'call.end',
    });
    assert.equal(activities.length, 2);
    assert.equal(activities[1].name, 'Thinking...');

    // Second tool call with explicit tool name
    await discord.recordActivity?.({
      tool: 'github_create_issue',
      route: 'github',
      kind: 'call.start',
    });
    assert.equal(activities.length, 3);
    assert.equal(activities[2].name, 'Tool: github_create_issue...');

    await discord.destroy();
  });

  it('sets activity to Thinking... for model routes and LLM calls', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');

    mockClient.emit(Events.MessageCreate, {
      id: 'm1',
      channelId: 'ch1',
      guildId: null,
      author: { id: 'u1', bot: false },
      channel: { sendTyping: async () => {} },
      mentions: { has: () => false },
      content: 'think',
    });

    await discord.recordActivity?.({
      route: 'models',
      model: 'claude-sonnet-4-5',
      kind: 'call.start',
    });

    assert.equal(activities.length, 1);
    assert.equal(activities[0].name, 'Thinking...');

    await discord.destroy();
  });

  it('clears active turn and resets custom activity when bot replies', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');

    const channel = {
      sendTyping: async () => {},
    };

    mockClient.emit(Events.MessageCreate, {
      id: 'm1',
      channelId: 'ch1',
      guildId: null,
      author: { id: 'u1', bot: false },
      channel,
      mentions: { has: () => false },
      content: 'do work',
    });

    await discord.recordActivity?.({
      route: 'github',
      kind: 'call.start',
    });
    assert.equal(activities.length, 1);
    assert.equal(activities[0].name, 'Tool: github...');

    // Agent bot sends its reply
    mockClient.emit(Events.MessageCreate, {
      id: 'bot-reply-1',
      channelId: 'ch1',
      guildId: null,
      author: { id: 'bot-id-123', bot: true }, // bot's own id
      channel,
      content: 'Here is the answer!',
    });

    // Activities should be cleared
    assert.equal(activities.length, 0);

    await discord.destroy();
  });
});
