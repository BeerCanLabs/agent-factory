/**
 * Graceful stop for the gatekeeper services. On SIGTERM (ECS stop) or SIGINT the server stops accepting connections and
 * ends keep-alive: every response from then on carries `Connection: close`, and idle connections are closed as each
 * response finishes and every 250 ms. In-flight requests get `graceMs` to finish; what is still open then is closed.
 * The process exits 0 well inside ECS's stop timeout (30 s by default), not by SIGKILL (exit 137). A second signal
 * during the drain is ignored: ECS sends one SIGTERM, then SIGKILL at its timeout.
 */
import type http from 'node:http';
import type { Socket } from 'node:net';
import type { EventEmitter } from 'node:events';

export type ShutdownOptions = {
  name: string;
  /** How long in-flight requests may run before their connections are closed. Default 20 s. */
  graceMs?: number;
  /** For tests: the signal source and the exit call. Default: the process. */
  proc?: Pick<EventEmitter, 'on'>;
  exit?: (code: number) => void;
};

export function installGracefulShutdown(server: http.Server, opts: ShutdownOptions): () => Promise<void> {
  const graceMs = opts.graceMs ?? 20_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const open = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
  });
  let stopping: Promise<void> | undefined;
  // Registered first, so it runs before the service's own handler writes the head.
  server.prependListener('request', (_req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!stopping) return;
    res.shouldKeepAlive = false;
    res.setHeader('Connection', 'close');
    res.once('finish', () => server.closeIdleConnections());
  });
  const stop = (signal = 'stop'): Promise<void> =>
    (stopping ??= new Promise<void>((resolve) => {
      console.log(`[${opts.name}] ${signal}: closing, draining for up to ${graceMs} ms`);
      let done = false;
      const finish = (forced: number) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(sweep);
        console.log(`[${opts.name}] stopped${forced ? ` (${forced} open connection${forced === 1 ? '' : 's'} closed at the deadline)` : ''}`);
        resolve();
        exit(0);
      };
      const timer = setTimeout(() => {
        const left = open.size;
        server.closeAllConnections();
        finish(left);
      }, graceMs);
      const sweep = setInterval(() => server.closeIdleConnections(), 250);
      timer.unref?.();
      sweep.unref?.();
      server.close(() => finish(0));
      server.closeIdleConnections();
    }));
  const proc = opts.proc ?? process;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) proc.on(signal, () => void stop(signal));
  return () => stop();
}
