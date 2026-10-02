import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type RunContext } from './gatekeeper-egress.js';

const KEY = 'test-token-key-for-gatekeeper-models-dynamic';
const runTokens = new RunTokens(KEY);

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('dynamic model resolution (§6.9 M3)', () => {
  it('dynamically resolves newly offered models from control plane without restart', async () => {
    const run = { runId: 'run-dyn-1', agentId: 'test-agent', taskId: 't1', live: true };
    const token = await runTokens.mint(run, 60);

    const ctx: RunContext = {
      run,
      agentState: 'RUNNING',
      policy: {
        routes: ['models'],
        models: ['new-dynamic-model'],
      },
      spend: { run: 0, day: 0, month: 0 },
    };

    let controlFetched = false;
    const dynamicCatalog = {
      'new-dynamic-model': {
        provider: 'fake',
        id: 'fake-dynamic-id',
        price: { inputPerMTok: 2, outputPerMTok: 8 },
      },
    };

    const control: ControlClient = {
      async runContext() {
        return ctx;
      },
      async ledger() {},
      async models() {
        controlFetched = true;
        return { catalog: dynamicCatalog };
      },
    };

    const server = createGatekeeperEgress({
      routes: [{ id: 'models', kind: 'models' }],
      prices: {},
      runTokens,
      control,
      providers: [],
      // Initially empty catalog:
      modelCatalog: {},
      modelAdapters: {
        fake: {
          async complete() {
            return {
              content: 'dynamic response',
              finishReason: 'stop',
              usage: { input: 10, output: 20 },
            };
          },
        },
      },
    });

    const port = await listen(server);
    try {
      // 1. GET /models/v1/models dynamically fetches offered models
      const listRes = await fetch(`http://127.0.0.1:${port}/models/v1/models`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const listText = await listRes.text();
      assert.equal(listRes.status, 200, listText);
      const listData = JSON.parse(listText) as { data: { id: string }[] };
      assert.ok(listData.data.some((m) => m.id === 'new-dynamic-model'));
      assert.equal(controlFetched, true);

      // 2. POST /models/v1/chat/completions succeeds using the dynamically resolved model
      const chatRes = await fetch(`http://127.0.0.1:${port}/models/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'new-dynamic-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      assert.equal(chatRes.status, 200);
      const chatData = (await chatRes.json()) as { choices: { message: { content: string } }[] };
      assert.equal(chatData.choices[0].message.content, 'dynamic response');
    } finally {
      server.close();
    }
  });
});
