/**
 * Graceful stop for the gatekeeper services. On SIGTERM (ECS stop) or SIGINT the server stops accepting connections,
 * idle keep-alive connections close at once, in-flight requests get `graceMs` to finish, and the process exits 0 well
 * inside ECS's stop timeout (30 s by default), so a deploy no longer ends each task with SIGKILL (exit 137).
 */
import type http from 'node:http';
import type { EventEmitter } from 'node:events';

export type ShutdownOptions = {
  name: string;
  /** How long in-flight requests may run before their connections are closed. Default 20 s. */
  graceMs?: number;
  /** For tests: the signal source and the exit call. Default: the process. */
  proc?: Pick<EventEmitter, 'once'>;
  exit?: (code: number) => void;
};

export function installGracefulShutdown(server: http.Server, opts: ShutdownOptions): () => Promise<void> {
  const graceMs = opts.graceMs ?? 20_000;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let stopping: Promise<void> | undefined;
  const stop = (signal = 'stop'): Promise<void> =>
    (stopping ??= new Promise<void>((resolve) => {
      console.log(`[${opts.name}] ${signal}: closing, draining for up to ${graceMs} ms`);
      let done = false;
      const finish = (forced: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        console.log(`[${opts.name}] stopped${forced ? ' (open connections closed at the deadline)' : ''}`);
        resolve();
        exit(0);
      };
      const timer = setTimeout(() => {
        server.closeAllConnections();
        finish(true);
      }, graceMs);
      timer.unref?.();
      server.close(() => finish(false));
      server.closeIdleConnections();
    }));
  const proc = opts.proc ?? process;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) proc.once(signal, () => void stop(signal));
  return () => stop();
}
