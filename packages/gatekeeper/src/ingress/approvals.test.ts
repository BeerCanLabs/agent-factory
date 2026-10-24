// CF4 (DESIGN_AUTHORITY.md §6.18): the ingress asks the factory's approval questions where the person last spoke, and an
// answer to one is consumed here, before the agent or a wake sees it. Discord has no buttons in this ingress: text replies.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { envProvider } from '@beercanlabs/factory-secrets-bind';
import { createGatekeeperIngress, fakeDiscordClient, type ApprovalAdapter, type ApprovalPrompt } from './index.js';

const prompt = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({ approvalId: 'a1', code: 'ABC234', deciders: ['u1'], text: 'Approval needed. Reply `approve ABC234`.', ...over });

async function setup(adapter: Partial<ApprovalAdapter> = {}) {
  const gw = fakeDiscordClient();
  const woken: string[] = [];
  const handed: string[] = [];
  const calls = { decide: [] as unknown[], asked: [] as Array<[string, string]> };
  let pending: ApprovalPrompt[] = [];
  const approvals: ApprovalAdapter = {
    prompts: async () => pending,
    asked: async (id, channelId) => {
      calls.asked.push([id, channelId]);
      pending = pending.filter((p) => p.approvalId !== id);
    },
    decide: async (r) => {
      calls.decide.push(r);
      return r.code === 'ABC234' ? { result: 'answered', text: 'Approved. It will go ahead.' } : { result: 'unknown' };
    },
    ...adapter,
  };
  const door = createGatekeeperIngress({
    discord: gw,
    providers: [envProvider({ DISCORD_BOT_TOKEN: 'bot-token' })],
    wake: async (id) => void woken.push(id),
    handoff: async (m) => void handed.push(m.content),
    approvals,
  });
  await door.reconcile([{ agentId: 'echo-agent', secretRef: 'DISCORD_BOT_TOKEN' }]);
  const msg = (content: string, authorId = 'u1', channelId = 'c1') => ({ channelId, messageId: `m${Math.random()}`, content, authorId });
  return { gw, door, woken, handed, calls, setPending: (p: ApprovalPrompt[]) => (pending = p), msg };
}

describe('CF4 approvals in the Discord ingress', () => {
  it('consumes an answer to a question: no wake, no hand-off, the reply is the factory’s text', async () => {
    const { gw, woken, handed, calls, msg } = await setup();
    await gw.inbound(msg('approve ABC234'));
    assert.deepEqual(woken, []);
    assert.deepEqual(handed, []);
    assert.deepEqual(calls.decide, [{ code: 'ABC234', decision: 'approve', identity: 'u1', channelId: 'c1' }]);
    assert.deepEqual(gw.sent, [{ channelId: 'c1', text: 'Approved. It will go ahead.' }]);
  });

  it('takes the verb in any case, and after a mention of the bot, but nothing else in the message', async () => {
    const { gw, calls, msg } = await setup();
    await gw.inbound(msg('<@123456> REJECT abc234'));
    assert.equal((calls.decide[0] as { decision: string }).decision, 'reject');
    assert.equal((calls.decide[0] as { code: string }).code, 'abc234');
    await gw.inbound(msg('please approve ABC234 thanks'));
    await gw.inbound(msg('approve ABC234 and also email everyone'));
    assert.equal(calls.decide.length, 1, 'only an exact answer is looked at');
  });

  it('passes a code the factory does not know to the agent as an ordinary message', async () => {
    const { gw, handed, woken, msg } = await setup();
    await gw.inbound(msg('approve ZZZZZZ'));
    assert.deepEqual(gw.sent, []);
    assert.deepEqual(woken, ['echo-agent'], 'it is just a message, and wakes as any other');
    assert.equal(handed.length + woken.length, 1);
  });

  it('does not let a failed lookup through to the agent: it says so and keeps the reply from it', async () => {
    const { gw, woken, handed, msg } = await setup({ decide: async () => { throw new Error('down'); } });
    await gw.inbound(msg('approve ABC234'));
    assert.deepEqual([woken, handed], [[], []]);
    assert.match(gw.sent[0].text, /could not reach the factory/);
  });

  it('asks the question where the person who may decide last spoke, once, and tells the factory where', async () => {
    const { gw, door, calls, setPending, msg } = await setup();
    setPending([prompt()]);
    await door.askPending();
    assert.deepEqual(gw.sent, [], 'it has not seen that person yet, so it asks nowhere');
    await gw.inbound(msg('hello', 'u1', 'c-old'));
    await gw.inbound(msg('and again', 'u1', 'c-new'));
    await gw.inbound(msg('hi', 'u2', 'c-other'));
    await door.askPending();
    assert.deepEqual(gw.sent, [{ channelId: 'c-new', text: prompt().text }]);
    assert.deepEqual(calls.asked, [['a1', 'c-new']]);
    await door.askPending();
    assert.equal(gw.sent.length, 1, 'the factory no longer lists it');
  });

  it('never asks a person who may not decide it: only the deciders the factory named', async () => {
    const { gw, door, setPending, msg } = await setup();
    await gw.inbound(msg('hi', 'someone-else', 'c9'));
    setPending([prompt({ deciders: ['u1'] })]);
    await door.askPending();
    assert.deepEqual(gw.sent, []);
  });

  it('records nothing when the post fails, so it is asked again later', async () => {
    const { gw, door, calls, setPending, msg } = await setup();
    await gw.inbound(msg('hi'));
    gw.send = async () => false;
    setPending([prompt()]);
    await door.askPending();
    assert.deepEqual(calls.asked, []);
  });

  it('asks and consumes nothing when no approval adapter is wired', async () => {
    const gw = fakeDiscordClient();
    const handed: string[] = [];
    const door = createGatekeeperIngress({ discord: gw, providers: [envProvider({ DISCORD_BOT_TOKEN: 't' })], wake: async () => {}, handoff: async (m) => void handed.push(m.content) });
    await door.reconcile([{ agentId: 'echo-agent', secretRef: 'DISCORD_BOT_TOKEN' }]);
    await door.askPending();
    await gw.inbound({ channelId: 'c', messageId: 'm', content: 'approve ABC234', authorId: 'u1' });
    assert.deepEqual(gw.sent, []);
  });
});
