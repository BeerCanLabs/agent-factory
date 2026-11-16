import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RunTokens } from '@beercanlabs/factory-auth';
import { createGatekeeperEgress, type ControlClient, type Route } from './gatekeeper-egress.js';

const route: Route = { id: 'svc', kind: 'http', upstream: 'https://svc.example.com' } as Route;

function egress(systemRoutes: ControlClient['systemRoutes'], routeStartRetryMs: number[]) {
  const control: ControlClient = {
    async runContext() { return null; },
    async requestApproval() { throw new Error('unused'); },
    async consumeApproval() { return false; },
    async ledger() {},
    systemRoutes,
  };
  return createGatekeeperEgress({ routes: [], prices: {}, runTokens: new RunTokens('route-start-test-run-token-key-1234567890'), control, routeStartRetryMs, routeRefreshIntervalMs: 60_000 }) as http.Server;
}

async function capture<T>(fn: (logs: string[]) => Promise<T>): Promise<T> {
  const logs: string[] = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.join(' '));
  try {
    return await fn(logs);
  } finally {
    [console.log, console.error] = [log, err];
  }
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe('gatekeeper-egress start-up route fetch retries while the control plane restarts', () => {
  it('retries with backoff, then logs routes loaded (N)', async () => {
    let calls = 0;
    await capture(async (logs) => {
      egress(async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return [route];
      }, [5, 10, 20]).close();
      await until(() => logs.some((l) => l.includes('routes loaded')));
      assert.equal(calls, 3);
      assert.ok(logs.includes('[gatekeeper-egress] routes loaded (1)'), logs.join('\n'));
    });
  });

  it('gives up after the bounded attempts and says routes load lazily', async () => {
    let calls = 0;
    await capture(async (logs) => {
      egress(async () => {
        calls += 1;
        throw new Error('ECONNREFUSED');
      }, [5, 5]).close();
      await until(() => logs.some((l) => l.includes('not loaded after')));
      assert.equal(calls, 3);
      assert.ok(logs.some((l) => l.includes('routes not loaded after 3 attempts; they load on the next request')));
    });
  });
});
