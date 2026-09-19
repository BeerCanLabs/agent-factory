#!/usr/bin/env node
/**
 * Agent task entrypoint. No security role: the gateway enforces egress, the control plane owns state.
 * The shim only makes a stock worker image behave like a factory run:
 *   hydrate mind -> point SDKs at the gateway -> heartbeat -> run worker -> replicate mind -> report crash.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pullMind, pushMind, type MindStore } from './index.js';
import { gatewayEnv } from './gateway-env.js';

export { gatewayEnv };

function rssMb(pid: number | undefined): number | undefined {
  if (!pid) return undefined;
  try {
    const m = readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s+kB/);
    return m ? Math.round(Number(m[1]) / 1024) : undefined;
  } catch {
    return undefined;
  }
}

async function post(path: string, body: unknown): Promise<number | undefined> {
  const base = process.env.FACTORY_URL?.replace(/\/$/, '');
  const runId = process.env.FACTORY_RUN_ID;
  const token = process.env.FACTORY_RUN_TOKEN;
  if (!base || !runId || !token) return undefined;
  try {
    const res = await fetch(`${base}/api/v1/runs/${runId}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return res.status;
  } catch {
    return undefined;
  }
}

function safePush(store: MindStore, prefix: string | undefined, dir: string) {
  if (!prefix) return;
  try {
    pushMind(store, prefix, dir);
  } catch (err) {
    console.error(`[shim] mind push failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] === '--' ? argv.slice(1) : argv;
  if (!cmd.length) {
    console.error('usage: factory-shim [--] <worker command...>');
    return 2;
  }
  const dir = process.env.MEMORY_DIR;
  if (!dir) {
    console.error('[shim] MEMORY_DIR must be set');
    return 2;
  }
  const store: MindStore = { root: process.env.MEMORY_STORE_DIR ?? '', uri: process.env.MEMORY_STORE_URI };
  const prefix = process.env.MEMORY_PREFIX;
  const usesStore = Boolean(store.uri || store.root);
  if (usesStore && prefix) pullMind(store, prefix, dir);

  const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, ...gatewayEnv(process.env) } });
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => child.kill(sig));

  const beatEvery = Number(process.env.FACTORY_HEARTBEAT_SECONDS || '15') * 1000;
  const beat = () => void post('heartbeat', { rssMb: rssMb(child.pid) });
  beat();
  const hb = setInterval(beat, beatEvery);
  const syncEvery = Number(process.env.FACTORY_MIND_SYNC_SECONDS || '60') * 1000;
  const sync = usesStore ? setInterval(() => safePush(store, prefix, dir), syncEvery) : undefined;

  const code: number = await new Promise((resolve) => {
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
    child.on('error', (err) => {
      console.error(`[shim] could not start worker: ${err.message}`);
      resolve(127);
    });
  });
  clearInterval(hb);
  if (sync) clearInterval(sync);
  if (usesStore) safePush(store, prefix, dir);
  // If the worker died without reporting, say so now instead of waiting for task reconciliation.
  if (code !== 0) await post('result', { status: 'failed', error: `worker exited ${code}` });
  return code;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
