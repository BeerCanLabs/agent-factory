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

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const userMsg = (channel: unknown, id = 'm1', channelId = 'ch1') => ({
    id,
    channelId,
    guildId: null,
    author: { id: 'u1', bot: false },
    channel,
    mentions: { has: () => false },
    content: 'work',
  });

  it('ignores a late activity event when no turn is open, so no status is left behind', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');

    await discord.recordActivity?.({ route: 'github', kind: 'call.start' });
    assert.equal(activities.length, 0);

    // The same after the agent has replied: a late call.end must not bring "Thinking..." back.
    mockClient.emit(Events.MessageCreate, userMsg({ sendTyping: async () => {} }));
    mockClient.emit(Events.MessageCreate, { id: 'r1', channelId: 'ch1', guildId: null, author: { id: 'bot-id-123', bot: true }, channel: {}, content: 'done' });
    await discord.recordActivity?.({ route: 'github', kind: 'call.end' });
    assert.equal(activities.length, 0);

    await discord.destroy();
  });

  it('goes silent and clears the status when the lease lapses with no activity', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any, { turnLeaseMs: 40, typingIntervalMs: 10 });
    await discord.setPresence('available');

    let typingCalls = 0;
    mockClient.emit(Events.MessageCreate, userMsg({ sendTyping: async () => { typingCalls++; } }));
    await discord.recordActivity?.({ route: 'github', kind: 'call.start' });
    assert.equal(activities.length, 1);

    await sleep(150);
    assert.equal(activities.length, 0, 'status cleared');
    const after = typingCalls;
    await sleep(50);
    assert.equal(typingCalls, after, 'typing stopped');

    // The lapsed turn owns nothing, so a straggler sets nothing.
    await discord.recordActivity?.({ route: 'github', kind: 'call.start' });
    assert.equal(activities.length, 0);
    await discord.destroy();
  });

  it('activity keeps the lease alive past its nominal length', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any, { turnLeaseMs: 60, typingIntervalMs: 10 });
    await discord.setPresence('available');
    mockClient.emit(Events.MessageCreate, userMsg({ sendTyping: async () => {} }));
    for (let i = 0; i < 5; i++) {
      await sleep(30);
      await discord.recordActivity?.({ route: 'github', kind: i % 2 ? 'call.end' : 'call.start' });
    }
    assert.ok(activities.length >= 5, 'still active after 150 ms with a 60 ms lease');
    await discord.destroy();
  });

  it('a standby (cold wake) turn is not cut off by the lease while the agent starts', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any, { turnLeaseMs: 30, typingIntervalMs: 10 });
    // Presence stays offline, so the message starts a standby session.
    const channel = { sendTyping: async () => {}, send: async () => ({ id: 'standby-1' }) };
    mockClient.emit(Events.MessageCreate, userMsg(channel));
    await sleep(100);

    // The turn is still open after the lease length, so activity once the agent is up is shown.
    await discord.recordActivity?.({ route: 'github', kind: 'call.start' });
    assert.equal(activities.at(-1)?.name, 'Tool: github...');
    await discord.destroy();
  });

  it('a call.start for a model route shows Thinking... and never the route name', async () => {
    const { mockClient, activities } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');
    mockClient.emit(Events.MessageCreate, userMsg({ sendTyping: async () => {} }));
    await discord.recordActivity?.({ route: 'model:anthropic', kind: 'call.start' });
    assert.equal(activities.at(-1)?.name, 'Thinking...');
    await discord.destroy();
  });

  it('posts in-channel progress message and updates it to summary on reply', async () => {
    const { mockClient } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');

    let sentMessage: any = null;
    const edits: string[] = [];
    const channel = {
      sendTyping: async () => {},
      send: async (options: any) => {
        sentMessage = {
          id: 'progress-msg-1',
          content: typeof options === 'string' ? options : options.content,
          edit: async (c: string) => {
            edits.push(c);
            sentMessage.content = c;
          },
        };
        return sentMessage;
      },
    };

    mockClient.emit(Events.MessageCreate, userMsg(channel));
    assert.ok(sentMessage, 'posted progress message');
    assert.equal(sentMessage.content, '⏳ Working…');

    // Agent executes tool and model call
    await discord.recordActivity?.({ route: 'google-calendar', kind: 'call.start' });
    await discord.recordActivity?.({ route: 'google-calendar', kind: 'call.end', durationMs: 1200, outcome: 'ok' });
    await discord.recordActivity?.({ route: 'models', model: 'claude-sonnet-4-6', kind: 'call.start' });
    await discord.recordActivity?.({
      route: 'models',
      model: 'claude-sonnet-4-6',
      kind: 'call.end',
      durationMs: 3200,
      outcome: 'ok',
      inputTokens: 1200,
      outputTokens: 180,
    });

    // Wait for throttled edit
    await sleep(1100);
    assert.ok(sentMessage.content.includes('🔧 google-calendar ✓ 1.2s'), sentMessage.content);
    assert.ok(sentMessage.content.includes('🧠 claude-sonnet-4-6 ✓ 3.2s'), sentMessage.content);

    // Bot replies
    mockClient.emit(Events.MessageCreate, {
      id: 'bot-reply-1',
      channelId: 'ch1',
      guildId: null,
      author: { id: 'bot-id-123', bot: true },
      channel,
      content: 'Here is your calendar.',
    });

    assert.equal(
      sentMessage.content,
      '✓ Thought for 3.2s, called 1 tool, spent 1,200 input tokens and 180 output tokens',
    );
    await discord.destroy();
  });

  it('does not treat discord messaging egress or internal routes as tool calls', async () => {
    const { mockClient } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    await discord.setPresence('available');

    let sentMessage: any = null;
    const channel = {
      sendTyping: async () => {},
      send: async (options: any) => {
        sentMessage = {
          id: 'progress-msg-1',
          content: typeof options === 'string' ? options : options.content,
          edit: async (c: string) => {
            sentMessage.content = c;
          },
        };
        return sentMessage;
      },
    };

    mockClient.emit(Events.MessageCreate, userMsg(channel));

    // Agent executes model call, then posts to discord route
    await discord.recordActivity?.({ route: 'models', model: 'haiku', kind: 'call.end', durationMs: 500, inputTokens: 100, outputTokens: 20 });
    await discord.recordActivity?.({ route: 'discord', kind: 'call.start' });
    await discord.recordActivity?.({ route: 'discord', kind: 'call.end', durationMs: 200, outcome: 'ok' });
    await discord.recordActivity?.({ route: 'control-plane', kind: 'call.start' });
    await discord.recordActivity?.({ route: 'control-plane', kind: 'call.end', durationMs: 50 });

    // Bot replies
    mockClient.emit(Events.MessageCreate, {
      id: 'bot-reply-1',
      channelId: 'ch1',
      guildId: null,
      author: { id: 'bot-id-123', bot: true },
      channel,
      content: 'Hello!',
    });

    // Tool calls count must remain 0
    assert.equal(
      sentMessage.content,
      '✓ Thought for 0.5s, called 0 tools, spent 100 input tokens and 20 output tokens',
    );
    await discord.destroy();
  });

  it('standby session transitions to summary when agent replies', async () => {
    const { mockClient } = createMockClient();
    const discord = createDiscordClient(mockClient as any);
    // Offline presence triggers standby session
    let standbyMessage: any = null;
    const channel = {
      sendTyping: async () => {},
      send: async (options: any) => {
        standbyMessage = {
          id: 'standby-msg-1',
          content: typeof options === 'string' ? options : options.content,
          edit: async (c: string) => {
            standbyMessage.content = c;
          },
          delete: async () => {},
        };
        return standbyMessage;
      },
    };

    mockClient.emit(Events.MessageCreate, userMsg(channel));
    await sleep(20);
    assert.ok(standbyMessage.content.includes('Standby while I get'));

    // Agent wakes and makes a call
    await discord.recordActivity?.({
      route: 'models',
      model: 'haiku',
      kind: 'call.end',
      durationMs: 800,
      outcome: 'ok',
      inputTokens: 400,
      outputTokens: 50,
    });

    // Bot replies
    mockClient.emit(Events.MessageCreate, {
      id: 'bot-reply-1',
      channelId: 'ch1',
      guildId: null,
      author: { id: 'bot-id-123', bot: true },
      channel,
      content: 'Hello!',
    });

    assert.equal(
      standbyMessage.content,
      '✓ Thought for 0.8s, called 0 tools, spent 400 input tokens and 50 output tokens',
    );
    await discord.destroy();
  });

  it('turn lease expiration updates progress message with warning', async () => {
    const { mockClient } = createMockClient();
    const discord = createDiscordClient(mockClient as any, { turnLeaseMs: 40, typingIntervalMs: 10 });
    await discord.setPresence('available');

    let sentMessage: any = null;
    const channel = {
      sendTyping: async () => {},
      send: async (options: any) => {
        sentMessage = {
          id: 'progress-msg-1',
          content: typeof options === 'string' ? options : options.content,
          edit: async (c: string) => {
            sentMessage.content = c;
          },
        };
        return sentMessage;
      },
    };

    mockClient.emit(Events.MessageCreate, userMsg(channel));
    await discord.recordActivity?.({ route: 'tavily', kind: 'call.end', durationMs: 500 });

    await sleep(150);
    assert.ok(sentMessage.content.startsWith('⚠️'), sentMessage.content);
    assert.ok(sentMessage.content.toLowerCase().includes('called 1 tool'), sentMessage.content);
    await discord.destroy();
  });

  describe('CF4 approval answers on the real client', () => {
    it('hands every message to the interceptor first, with whether it is a direct message, and an answered message gets no standby, no typing and no hand-off', async () => {
      const { mockClient } = createMockClient();
      const discord = createDiscordClient(mockClient as any);
      const seen: Array<{ content: string; direct?: boolean }> = [];
      const handled: string[] = [];
      discord.onMessage((m) => handled.push(m.content));
      discord.setInterceptor?.(async (m) => {
        seen.push({ content: m.content, direct: m.direct });
        return m.content === 'approve ABCDEF';
      });
      let typing = 0;
      let sent = 0;
      const channel = { sendTyping: async () => void typing++, send: async () => (sent++, { id: 's' }), messages: { fetch: async () => undefined } };
      const msg = (id: string, content: string, guildId: string | null) => ({ id, channelId: 'ch', guildId, author: { id: 'u1', bot: false }, channel, mentions: { has: () => true }, content });
      mockClient.emit(Events.MessageCreate, msg('a', 'approve ABCDEF', null));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(handled, [], 'the agent never sees it');
      assert.equal(typing, 0);
      assert.equal(sent, 0, 'no standby message either');
      mockClient.emit(Events.MessageCreate, msg('b', 'hello', 'guild-1'));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(handled, ['hello']);
      assert.deepEqual(seen, [{ content: 'approve ABCDEF', direct: true }, { content: 'hello', direct: false }]);
      await discord.destroy();
    });

    it('posts a question without letting anything in it ping anyone', async () => {
      const { mockClient } = createMockClient();
      const posts: unknown[] = [];
      (mockClient as any).channels.fetch = async () => ({ send: async (o: unknown) => void posts.push(o) });
      const discord = createDiscordClient(mockClient as any);
      assert.equal(await discord.send?.('ch', 'hello @everyone'), true);
      assert.deepEqual(posts, [{ content: 'hello @everyone', allowedMentions: { parse: [] } }]);
      (mockClient as any).channels.fetch = async () => undefined;
      assert.equal(await discord.send?.('ch', 'x'), false);
      await discord.destroy();
    });
  });
});
