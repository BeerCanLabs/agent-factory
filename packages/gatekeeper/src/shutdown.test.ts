import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { installGracefulShutdown } from './shutdown.js';

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('no port');
  return a.port;
}

describe('gatekeeper graceful shutdown (SIGTERM exits 0, not 137)', () => {
  it('on SIGTERM stops accepting, lets an in-flight request finish, and exits 0', async () => {
    let release: () => void = () => {};
    const server = http.createServer((_req, res) => {
      release = () => res.end('done');
    });
    const port = await listen(server);
    const proc = new EventEmitter();
    const exits: number[] = [];
    const stopped = new Promise<void>((r) => installGracefulShutdown(server, { name: 'test', graceMs: 5_000, proc, exit: (c) => (exits.push(c), r()) }));
    const inflight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    proc.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.listening, false, 'no new connections');
    assert.deepEqual(exits, [], 'waits for the in-flight request');
    release();
    assert.equal(await inflight, 'done');
    await stopped;
    assert.deepEqual(exits, [0]);
  });

  it('closes what is still open at the deadline and still exits 0, once', async () => {
    const server = http.createServer(() => {});
    const port = await listen(server);
    const proc = new EventEmitter();
    const exits: number[] = [];
    const stopped = new Promise<void>((r) => installGracefulShutdown(server, { name: 'test', graceMs: 100, proc, exit: (c) => (exits.push(c), r()) }));
    const hung = fetch(`http://127.0.0.1:${port}/hang`).catch(() => 'closed');
    await new Promise((r) => setTimeout(r, 50));
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    await stopped;
    assert.equal(await hung, 'closed');
    assert.deepEqual(exits, [0]);
  });
});
