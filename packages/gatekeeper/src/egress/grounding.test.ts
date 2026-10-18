import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import type { ChatRequest, ModelAdapter } from '@beercanlabs/factory-executive';
import { createGatekeeperEgress, type ControlClient, type Policy, type RunContext } from './gatekeeper-egress.js';
import {
  GROUNDING_NOTE,
  GROUNDING_RETRY_NOTICE,
  NO_MODEL_FOOTNOTE,
  NO_TOOLS_FOOTNOTE,
  ReplyBook,
  footnoteDiscordBody,
  isDiscordReply,
  replySha256,
  toolResultsInTurn,
  withGroundingNote,
} from './grounding.js';

describe('AP3 grounding pieces', () => {
  it('a turn is grounded only by tool results after the last user message', () => {
    assert.equal(toolResultsInTurn([{ role: 'user' }]), false);
    assert.equal(toolResultsInTurn([{ role: 'user' }, { role: 'assistant' }, { role: 'tool' }]), true);
    assert.equal(toolResultsInTurn([{ role: 'user' }, { role: 'tool' }, { role: 'user' }]), false, 'an earlier turn does not count');
  });

  it('the standing note goes after the leading system messages', () => {
    const out = withGroundingNote({ model: 'x', messages: [{ role: 'system', content: 'You are Rosie.' }, { role: 'user', content: 'hi' }] });
    assert.deepEqual(out.messages, [{ role: 'system', content: 'You are Rosie.' }, { role: 'system', content: GROUNDING_NOTE }, { role: 'user', content: 'hi' }]);
  });

  it('a reply takes its answer footnote; a split answer only on its last chunk; anything else is not from the model', () => {
    const book = new ReplyBook();
    book.sawModelApiCall('run-1');
    book.remember('run-1', 'The litter box is clean.', NO_TOOLS_FOOTNOTE);
    book.remember('run-1', 'Grounded answer from a tool. It goes on for quite a while.');
    assert.equal(book.footnoteFor('run-1', 'The litter box is clean.'), NO_TOOLS_FOOTNOTE);
    assert.equal(book.footnoteFor('run-1', '<@123> The litter box is clean.'), NO_TOOLS_FOOTNOTE, 'decorated reply');
    assert.equal(book.footnoteFor('run-1', 'Grounded answer from a tool.'), undefined, 'middle chunk');
    assert.equal(book.footnoteFor('run-1', 'It goes on for quite a while.'), undefined, 'grounded last chunk');
    assert.equal(book.footnoteFor('run-1', 'Beep boop! I could not reach Home Assistant.'), NO_MODEL_FOOTNOTE);
    assert.equal(book.footnoteFor('run-2', 'The litter box is clean.'), undefined, 'a run this process never saw use the model API is not judged');
  });

  it('review #198: short answers match only exactly; an edit is not footnoted twice; a native-route run is never called model-less', () => {
    const book = new ReplyBook();
    book.sawModelApiCall('r');
    book.remember('r', 'OK', NO_TOOLS_FOOTNOTE);
    assert.equal(book.footnoteFor('r', 'OK'), NO_TOOLS_FOOTNOTE);
    assert.equal(book.footnoteFor('r', 'Beep boop! OK, I will try later.'), NO_MODEL_FOOTNOTE, 'a short answer inside a canned message is no match');
    book.remember('r', 'The kitchen lights are off and the doors are locked.', NO_TOOLS_FOOTNOTE);
    assert.equal(book.footnoteFor('r', `The kitchen lights are off and the doors are locked.\n-# ${NO_TOOLS_FOOTNOTE}`), NO_TOOLS_FOOTNOTE);
    const edited = footnoteDiscordBody(Buffer.from(JSON.stringify({ content: `The kitchen lights are off and the doors are locked.\n-# ${NO_TOOLS_FOOTNOTE}` })), () => NO_TOOLS_FOOTNOTE)!;
    assert.equal(JSON.parse(edited.body.toString()).content, `The kitchen lights are off and the doors are locked.\n-# ${NO_TOOLS_FOOTNOTE}`, 'one footnote, not two');
    book.sawNativeModelCall('r');
    assert.equal(book.footnoteFor('r', 'Anything else'), undefined);
  });

  it('recognises Discord message creates and edits only', () => {
    const discord = { id: 'discord', upstream: 'http://127.0.0.1:1/discord' };
    const byHost = { id: 'chat', upstream: 'https://discord.com/api/v10' };
    assert.equal(isDiscordReply(discord, 'POST', '/channels/123/messages'), true);
    assert.equal(isDiscordReply(byHost, 'PATCH', '/channels/123/messages/456'), true);
    assert.equal(isDiscordReply(byHost, 'GET', '/channels/123/messages'), false);
    assert.equal(isDiscordReply(byHost, 'POST', '/channels/123/typing'), false);
    assert.equal(isDiscordReply({ id: 'github', upstream: 'https://api.github.com' }, 'POST', '/channels/1/messages'), false);
  });

  it('the footnote is Discord subtext and the message stays within the limit', () => {
    const out = footnoteDiscordBody(Buffer.from(JSON.stringify({ content: 'hello', tts: false })), () => NO_TOOLS_FOOTNOTE)!;
    assert.deepEqual(JSON.parse(out.body.toString()), { content: `hello\n-# ${NO_TOOLS_FOOTNOTE}`, tts: false });
    const raw = Buffer.from(JSON.stringify({ content: 'x'.repeat(2000) }));
    const long = footnoteDiscordBody(raw, () => NO_MODEL_FOOTNOTE, 2000)!;
    assert.equal(long.skipped, true, 'content is never cut to fit a footnote');
    assert.equal(long.body, raw);
    assert.equal(footnoteDiscordBody(Buffer.from(JSON.stringify({ embeds: [] })), () => NO_MODEL_FOOTNOTE), undefined, 'no content, nothing to mark');
  });
});

const tokens = new RunTokens('grounding-test-run-token-key-0123456789');

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

function call(port: number, path: string, token: string, body: unknown): Promise<{ status: number; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('AP3 through the gatekeeper-egress', { concurrency: false }, () => {
  async function setup(policy: Policy, answers: Array<{ content: string; toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }>) {
    const runId = `ap3-${Math.random().toString(36).slice(2)}`;
    const ctx: RunContext = { run: { runId, agentId: 'rosie', state: 'WORKING', live: true }, agentState: 'WORKING', policy, spend: { run: 0, day: 0, month: 0 } };
    const ledger: Array<Record<string, any>> = [];
    const seenRequests: ChatRequest[] = [];
    const posted: string[] = [];
    const discord = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        posted.push(JSON.parse(b).content);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    const dPort = await listen(discord);
    const adapter: ModelAdapter = {
      async complete(_entry, req) {
        seenRequests.push(req);
        const a = answers.shift() ?? { content: 'done' };
        if (a.content === '__THROW__') throw new Error('upstream down');
        return { content: a.content, finishReason: a.toolCalls ? 'tool_calls' : 'stop', usage: { input: 10, output: 2 }, ...(a.toolCalls ? { toolCalls: a.toolCalls } : {}) };
      },
    };
    const control: ControlClient = {
      async runContext(id) { return id === runId ? structuredClone(ctx) : null; },
      async requestApproval() { throw new Error('unused'); },
      async consumeApproval() { return false; },
      async ledger(e) { ledger.push(e); return true; },
    } as ControlClient;
    const gk = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }, { id: 'discord', kind: 'http', upstream: `http://127.0.0.1:${dPort}/discord` }],
      prices: {},
      runTokens: tokens,
      control,
      contextTtlMs: 0,
      modelCatalog: { 'fake-model': { provider: 'fake', id: 'fake-model', price: { inputPerMTok: 1, outputPerMTok: 1 } } },
      modelAdapters: { fake: adapter },
    });
    const port = await listen(gk);
    const token = await tokens.mint({ runId, agentId: 'rosie' });
    const close = async () => {
      await new Promise<void>((r) => gk.close(() => r()));
      await new Promise<void>((r) => discord.close(() => r()));
    };
    return { port, token, ledger, seenRequests, posted, close };
  }
  const TOOLS = [{ type: 'function', function: { name: 'get_kitty_litter_status', parameters: { type: 'object', properties: {} } } }];
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('AP3 an answer given without tools is recorded and its Discord reply footnoted; a canned reply is footnoted too', async () => {
    const t = await setup({ routes: ['models', 'discord'], models: ['fake-model'] }, [{ content: 'The litter box is clean.' }]);
    try {
      const res = await call(t.port, '/models/v1/chat/completions', t.token, { messages: [{ role: 'system', content: 'You are Rosie.' }, { role: 'user', content: 'hey' }], tools: TOOLS });
      assert.equal(res.status, 200);
      assert.equal(res.json().choices[0].message.content, 'The litter box is clean.');
      assert.ok(t.seenRequests[0].messages.some((m) => m.role === 'system' && m.content === GROUNDING_NOTE), 'the standing note reached the model');
      await settle();
      const ungrounded = t.ledger.find((e) => e.action === 'UNGROUNDED_REPLY');
      assert.equal(ungrounded?.replySha256, replySha256('The litter box is clean.'));
      assert.equal(JSON.stringify(t.ledger).includes('litter box'), false, 'the answer text never reaches the ledger');

      assert.equal((await call(t.port, '/discord/channels/123/messages', t.token, { content: 'The litter box is clean.' })).status, 200);
      assert.equal((await call(t.port, '/discord/channels/123/messages', t.token, { content: 'Beep boop! Try again.' })).status, 200);
      assert.deepEqual(t.posted, [`The litter box is clean.\n-# ${NO_TOOLS_FOOTNOTE}`, `Beep boop! Try again.\n-# ${NO_MODEL_FOOTNOTE}`]);
      await settle();
      assert.equal(t.ledger.filter((e) => e.action === 'REPLY_FOOTNOTED').length, 2);
    } finally {
      await t.close();
    }
  });

  it('AP3 an answer built from tool results is not footnoted, and a request without tools gets no note', async () => {
    const t = await setup({ routes: ['models', 'discord'], models: ['fake-model'] }, [{ content: 'Clean, per the sensor.' }, { content: 'Plain chat.' }]);
    try {
      const turn = [
        { role: 'user', content: 'hey' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_kitty_litter_status', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '{"level":"clean"}' },
      ];
      await call(t.port, '/models/v1/chat/completions', t.token, { messages: turn, tools: TOOLS });
      await call(t.port, '/models/v1/chat/completions', t.token, { messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(t.seenRequests[1].messages.some((m) => m.content === GROUNDING_NOTE), false);
      await call(t.port, '/discord/channels/123/messages', t.token, { content: 'Clean, per the sensor.' });
      assert.deepEqual(t.posted, ['Clean, per the sensor.']);
      await settle();
      assert.equal(t.ledger.filter((e) => e.action === 'MODEL_REPLY').length, 2);
      assert.equal(t.ledger.some((e) => e.action === 'UNGROUNDED_REPLY'), false);
    } finally {
      await t.close();
    }
  });

  it('AP3 warn-once: a retry that answers in text replaces the answer; a failed retry keeps the first and is ledgered', async () => {
    const t = await setup({ routes: ['models'], models: ['fake-model'], grounding: 'warn-once' }, [{ content: 'Probably clean.' }, { content: 'I could not check: no live data.' }]);
    try {
      const res = await call(t.port, '/models/v1/chat/completions', t.token, { messages: [{ role: 'user', content: 'hey' }], tools: TOOLS });
      assert.equal(res.json().choices[0].message.content, 'I could not check: no live data.');
      await settle();
      assert.equal(t.ledger.find((e) => e.action === 'UNGROUNDED_REPLY')?.replySha256, replySha256('I could not check: no live data.'));
    } finally {
      await t.close();
    }
    const f = await setup({ routes: ['models'], models: ['fake-model'], grounding: 'warn-once' }, [{ content: 'Probably clean.' }, { content: '__THROW__' }]);
    try {
      const res = await call(f.port, '/models/v1/chat/completions', f.token, { messages: [{ role: 'user', content: 'hey' }], tools: TOOLS });
      assert.equal(res.json().choices[0].message.content, 'Probably clean.');
      await settle();
      assert.ok(f.ledger.some((e) => e.action === 'GROUNDING_RETRY_FAILED'));
    } finally {
      await f.close();
    }
  });

  it('AP3 grounding warn-once gives the model one more turn with the notice; both calls are metered', async () => {
    const t = await setup({ routes: ['models'], models: ['fake-model'], grounding: 'warn-once' }, [
      { content: 'Probably clean.' },
      { content: '', toolCalls: [{ id: 'c9', type: 'function', function: { name: 'get_kitty_litter_status', arguments: '{}' } }] },
    ]);
    try {
      const res = await call(t.port, '/models/v1/chat/completions', t.token, { messages: [{ role: 'user', content: 'hey' }], tools: TOOLS });
      assert.equal(res.status, 200);
      assert.equal(res.json().choices[0].message.tool_calls[0].function.name, 'get_kitty_litter_status', 'the retry called the tool');
      assert.equal(t.seenRequests.length, 2);
      assert.equal(t.seenRequests[1].messages.at(-1)?.content, GROUNDING_RETRY_NOTICE);
      await settle();
      assert.equal(t.ledger.filter((e) => e.type === 'llm').length, 2, 'both calls metered');
      const retry = t.ledger.find((e) => e.action === 'GROUNDING_RETRY');
      assert.equal(retry?.toolCalled, true);
      assert.equal(t.ledger.some((e) => e.action === 'UNGROUNDED_REPLY'), false, 'the turn continues with a tool call');
    } finally {
      await t.close();
    }
  });
});
