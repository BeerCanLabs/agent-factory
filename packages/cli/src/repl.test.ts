import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { FactoryClient } from './client.js';
import { repl } from './repl.js';
import { fakeFactory } from './testing.js';

async function session(lines: string[], setup: (f: ReturnType<typeof fakeFactory>) => void) {
  const f = fakeFactory();
  setup(f);
  const client = new FactoryClient({ baseUrl: 'https://f.example.com', fetch: f.fetch, credential: async () => 'good-token', sleep: async () => {} });
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const done = repl({ client, instance: 'https://f.example.com', managerAgent: 'factory-manager', version: 'test', input, output });
  for (const l of lines) input.write(l + '\n');
  input.end();
  await done;
  return { f, text };
}

describe('§6.17 CL5 the terminal conversation', () => {
  it('CL5 talks to the manager, is connected to an agent on its say-so, then to that agent directly, then back', async () => {
    const { f, text } = await session(['talk to donna', 'hello donna', '/manager', '/whoami', '/exit'], (f) => {
      f.agents.set('factory-manager', () => JSON.stringify({ type: 'connect', agent: 'donna', text: 'Connecting you.' }));
      f.agents.set('donna', (i) => `donna heard: ${i.content}`);
    });
    assert.match(text, /Connected to https:\/\/f\.example\.com as access:dale@example\.com \(admin\)/);
    assert.match(text, /Connecting you\./);
    assert.match(text, /donna> /);
    assert.match(text, /donna heard: hello donna/);
    assert.match(text, /Back with the Factory Manager/);
    const direct = f.seen.find((s) => s.path === '/api/v1/agents/donna/conversation');
    assert.deepEqual(direct?.body, { content: 'hello donna' }, 'the agent is sent the words only, with no manager tools');
  });

  it('CL5 /connect goes straight to an agent, and a refusal is worded for the person', async () => {
    const { text } = await session(['/connect nobody', 'hi', '/bogus', '/exit'], () => {});
    assert.match(text, /no agent called nobody/);
    assert.match(text, /manager> /, 'an unknown agent returns the person to the manager');
    assert.match(text, /Unknown command/);
  });
});
