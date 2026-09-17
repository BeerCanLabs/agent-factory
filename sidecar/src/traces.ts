import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactSecrets } from '@beercanlabs/factory-ledger';

export type TraceConfig = {
  enabled: boolean;
  ttlMs: number;
  dir: string;
};

const TRUTH = new Set(['1', 'true', 'on', 'yes']);

export function traceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TraceConfig {
  const enabled = TRUTH.has((env.FACTORY_TRACE_PROMPTS ?? '').trim().toLowerCase());
  const root = env.FACTORY_TRACE_DIR || env.MEMORY_DIR || '';
  const ttlSec = Number.parseInt(env.FACTORY_TRACE_TTL_SECONDS ?? '86400', 10);
  const ttlMs = Number.isFinite(ttlSec) ? Math.max(0, ttlSec) * 1000 : 86_400_000;
  return {
    enabled: enabled && Boolean(root),
    ttlMs,
    dir: root ? join(root, 'traces') : '',
  };
}

export function pruneTraces(dir: string, ttlMs: number, now = Date.now()): number {
  if (!dir || ttlMs <= 0) return 0;
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      if (now - st.mtimeMs > ttlMs) {
        unlinkSync(path);
        removed += 1;
      }
    } catch {
      /* skip */
    }
  }
  return removed;
}

export type TraceRecord = {
  timestamp: string;
  requestId: string;
  kind: 'llm' | 'mcp';
  model?: string;
  request?: unknown;
  response?: unknown;
};

export function writeTrace(cfg: TraceConfig, record: TraceRecord, secrets: Iterable<string> = []): string | null {
  if (!cfg.enabled || !cfg.dir) return null;
  mkdirSync(cfg.dir, { recursive: true });
  pruneTraces(cfg.dir, cfg.ttlMs);
  const safeId = record.requestId.replace(/[^a-zA-Z0-9._-]/g, '');
  const path = join(cfg.dir, `${record.timestamp.replace(/[:]/g, '-')}-${safeId}.json`);
  const body = redactSecrets(JSON.stringify(record, null, 2), secrets);
  writeFileSync(path, `${body}\n`, { encoding: 'utf8' });
  return path;
}
