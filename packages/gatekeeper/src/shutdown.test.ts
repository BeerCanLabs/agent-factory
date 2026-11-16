import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import net from 'node:net';
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

  it('ends keep-alive: a request sent on a kept-alive socket after the signal gets Connection: close, and the exit follows it', async () => {
    const server = http.createServer((req, res) => {
      setTimeout(() => res.end(req.url), req.url === '/slow' ? 150 : 0);
    });
    const port = await listen(server);
    const proc = new EventEmitter();
    const exits: number[] = [];
    const t0 = Date.now();
    const stopped = new Promise<void>((r) => installGracefulShutdown(server, { name: 'test', graceMs: 5_000, proc, exit: (c) => (exits.push(c), r()) }));
    const socket = net.connect(port, '127.0.0.1');
    let raw = '';
    let reset = false;
    socket.on('data', (d) => (raw += d));
    socket.on('error', () => (reset = true));
    const ended = new Promise<void>((r) => socket.on('close', () => r()));
    socket.write('GET /slow HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await new Promise((r) => setTimeout(r, 30));
    proc.emit('SIGTERM');
    socket.write('GET /after HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await ended;
    await stopped;
    const replies = raw.split('HTTP/1.1 200').slice(1);
    assert.equal(replies.length, 2, raw);
    assert.match(replies[0], /\/slow/);
    assert.match(replies[1], /connection: close/i);
    assert.match(replies[1], /\/after/);
    assert.equal(reset, false, 'no reset');
    assert.deepEqual(exits, [0]);
    assert.ok(Date.now() - t0 < 1_500, `exited ${Date.now() - t0} ms after start, not at the 5 s deadline`);
  });

  it('closes what is still open at the deadline and still exits 0, once', async () => {
    const server = http.createServer(() => {});
    const port = await listen(server);
    const proc = new EventEmitter();
    const exits: number[] = [];
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    const stopped = new Promise<void>((r) => installGracefulShutdown(server, { name: 'test', graceMs: 100, proc, exit: (c) => (exits.push(c), console.log = log, r()) }));
    const hung = fetch(`http://127.0.0.1:${port}/hang`).catch(() => 'closed');
    await new Promise((r) => setTimeout(r, 50));
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    await stopped;
    assert.equal(await hung, 'closed');
    assert.deepEqual(exits, [0]);
    assert.ok(logs.some((l) => l.includes('(1 open connection closed at the deadline)')), logs.join('\n'));
  });
});
