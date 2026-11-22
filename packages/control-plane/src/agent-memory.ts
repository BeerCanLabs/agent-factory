/**
 * Edge-node memory routes: append a finished conversation to an agent's notebook, and
 * return a compact persona + recent-memory summary, without waking a run.
 *
 *   POST /api/v1/agents/:id/memory/turns     agents.memory.append
 *   GET  /api/v1/agents/:id/memory/summary   agents.memory.read
 *
 * The control plane pulls the mind prefix, writes or reads the SQLite notebook, and pushes
 * it back. If a live run already holds the notebook, appends are refused (409) so the robot
 * can retry; summaries still read the last pushed copy and flag `notebookStale`.
 */
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pullMind, pushMind } from '@beercanlabs/factory-hydrate';
import { activeRun, effectiveMindPrefix } from '@beercanlabs/factory-property-manager';
import { canReadSettings, settingsOf } from './agent-settings.js';
import { findAgentRecord, json, readJson, requirePrivilege, type FactoryState } from './app.js';

const TURNS = /^\/api\/v1\/agents\/([^/]+)\/memory\/turns$/;
const SUMMARY = /^\/api\/v1\/agents\/([^/]+)\/memory\/summary$/;

const NOTEBOOK_FILE = 'agent_state.db';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SPEAKER_RE = /^[A-Za-z0-9:._@+-]{1,256}$/;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const TURN_ROLES = new Set(['user', 'assistant', 'system']);
const MAX_TURNS = 100;
const MAX_CONTENT = 16_384;
const MAX_SUMMARY_SESSIONS = 20;
const MAX_TURNS_PER_SESSION = 50;

export type MemoryTurnInput = {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
};

type ParsedAppend = {
  speaker: string;
  source: string;
  channel: string;
  startedAt?: string;
  endedAt?: string;
  sessionId?: string;
  sessionName?: string;
  turns: MemoryTurnInput[];
};

export async function handleAgentMemory(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  path: string,
): Promise<boolean> {
  const turns = path.match(TURNS);
  if (turns && req.method === 'POST') {
    await handleAppend(state, req, res, decodeURIComponent(turns[1]));
    return true;
  }
  const summary = path.match(SUMMARY);
  if (summary && req.method === 'GET') {
    await handleSummary(state, req, res, decodeURIComponent(summary[1]));
    return true;
  }
  return false;
}

async function handleAppend(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentId: string,
): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'agents.memory.append', { agentId });
  if (!principal) return;
  if (!findAgentRecord(state, agentId)) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  if (!state.mind) {
    json(res, 503, { error: 'mind_store_unavailable' });
    return;
  }
  const parsed = parseAppendBody(await readJson(req));
  if (!parsed.ok) {
    json(res, 400, { error: 'invalid_memory_turns', message: parsed.error });
    return;
  }
  const live = activeRun(state, agentId);
  if (live) {
    res.setHeader('Retry-After', '15');
    json(res, 409, {
      error: 'notebook_in_use',
      message: 'a live run holds this agent\'s notebook; retry after the run ends',
      runId: live.runId,
    });
    return;
  }
  const prefix = mindPrefixOf(state, agentId);
  try {
    const result = await withMindLock(state, prefix, async () => {
      const dest = mkdtempSync(join(tmpdir(), `factory-mind-${agentId}-`));
      try {
        pullMind(state.mind!.store, prefix, dest);
        const written = appendTurns(join(dest, NOTEBOOK_FILE), parsed.value);
        pushMind(state.mind!.store, prefix, dest);
        return written;
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    });
    json(res, 201, {
      agentId,
      sessionId: result.sessionId,
      turnsAppended: result.turnsAppended,
      source: parsed.value.source,
      channel: parsed.value.channel,
    });
  } catch (err) {
    console.error(`[control-plane] memory append for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
    json(res, 500, { error: 'memory_append_failed' });
  }
}

async function handleSummary(
  state: FactoryState,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentId: string,
): Promise<void> {
  const principal = await requirePrivilege(req, res, state, 'agents.memory.read', { agentId });
  if (!principal) return;
  if (!findAgentRecord(state, agentId)) {
    json(res, 404, { error: 'not_found' });
    return;
  }
  if (!state.mind) {
    json(res, 503, { error: 'mind_store_unavailable' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://factory.local');
  const sessionLimit = boundedInt(url.searchParams.get('limit'), 5, 1, MAX_SUMMARY_SESSIONS);
  const turnsLimit = boundedInt(url.searchParams.get('turns'), 20, 1, MAX_TURNS_PER_SESSION);
  const settings = settingsOf(state, agentId);
  const seesSoul = canReadSettings(state, principal, agentId);
  const live = activeRun(state, agentId);
  const prefix = mindPrefixOf(state, agentId);
  try {
    const recentSessions = await withMindLock(state, prefix, async () => {
      const dest = mkdtempSync(join(tmpdir(), `factory-mind-${agentId}-`));
      try {
        pullMind(state.mind!.store, prefix, dest);
        return readSummary(join(dest, NOTEBOOK_FILE), sessionLimit, turnsLimit);
      } finally {
        rmSync(dest, { recursive: true, force: true });
      }
    });
    json(res, 200, {
      agentId,
      ...(seesSoul && settings?.soul ? { soul: settings.soul } : settings?.soul ? { soulSet: true } : {}),
      ...(settings?.memory ? { memory: settings.memory } : {}),
      ...(typeof settings?.timezone === 'string' && settings.timezone ? { timezone: settings.timezone } : {}),
      ...(live ? { notebookStale: true, runId: live.runId } : {}),
      recentSessions,
    });
  } catch (err) {
    console.error(`[control-plane] memory summary for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
    json(res, 500, { error: 'memory_summary_failed' });
  }
}

function mindPrefixOf(state: FactoryState, agentId: string): string {
  const agent = findAgentRecord(state, agentId);
  return effectiveMindPrefix({ id: agentId, memoryPrefix: agent?.memoryPrefix });
}

async function withMindLock<T>(state: FactoryState, prefix: string, fn: () => Promise<T>): Promise<T> {
  const locks = (state.mindLocks ??= new Map());
  const previous = locks.get(prefix) ?? Promise.resolve();
  let release!: () => void;
  locks.set(prefix, new Promise<void>((r) => {
    release = r;
  }));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function parseAppendBody(body: unknown): { ok: true; value: ParsedAppend } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.speaker !== 'string' || !SPEAKER_RE.test(raw.speaker.trim())) {
    return { ok: false, error: 'speaker must be a principal id or alias of at most 256 characters' };
  }
  if (typeof raw.source !== 'string' || !SLUG_RE.test(raw.source.trim().toLowerCase())) {
    return { ok: false, error: 'source must be a slug such as reachy-edge' };
  }
  const channelRaw = typeof raw.channel === 'string' && raw.channel.trim() ? raw.channel.trim().toLowerCase() : 'voice';
  if (!SLUG_RE.test(channelRaw)) return { ok: false, error: 'channel must be a short slug' };
  if (raw.startedAt !== undefined && !isIso(raw.startedAt)) return { ok: false, error: 'startedAt must be an ISO-8601 timestamp' };
  if (raw.endedAt !== undefined && !isIso(raw.endedAt)) return { ok: false, error: 'endedAt must be an ISO-8601 timestamp' };
  if (raw.sessionId !== undefined && (typeof raw.sessionId !== 'string' || raw.sessionId.trim().length === 0 || raw.sessionId.length > 128)) {
    return { ok: false, error: 'sessionId must be a name or id of at most 128 characters' };
  }
  if (raw.sessionName !== undefined && (typeof raw.sessionName !== 'string' || raw.sessionName.trim().length === 0 || raw.sessionName.length > 200)) {
    return { ok: false, error: 'sessionName must be text of at most 200 characters' };
  }
  if (!Array.isArray(raw.turns) || raw.turns.length < 1 || raw.turns.length > MAX_TURNS) {
    return { ok: false, error: `turns must be a list of 1 to ${MAX_TURNS} items` };
  }
  const turns: MemoryTurnInput[] = [];
  for (const item of raw.turns) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: 'each turn must be an object' };
    const turn = item as Record<string, unknown>;
    if (typeof turn.role !== 'string' || !TURN_ROLES.has(turn.role)) {
      return { ok: false, error: "each turn role must be 'user', 'assistant', or 'system'" };
    }
    if (typeof turn.content !== 'string' || !turn.content.trim() || turn.content.length > MAX_CONTENT) {
      return { ok: false, error: `each turn content must be non-empty text of at most ${MAX_CONTENT} characters` };
    }
    if (turn.timestamp !== undefined && !isIso(turn.timestamp)) {
      return { ok: false, error: 'each turn timestamp must be an ISO-8601 timestamp' };
    }
    turns.push({
      role: turn.role as MemoryTurnInput['role'],
      content: turn.content,
      ...(typeof turn.timestamp === 'string' ? { timestamp: turn.timestamp } : {}),
    });
  }
  return {
    ok: true,
    value: {
      speaker: raw.speaker.trim(),
      source: raw.source.trim().toLowerCase(),
      channel: channelRaw,
      ...(typeof raw.startedAt === 'string' ? { startedAt: raw.startedAt } : {}),
      ...(typeof raw.endedAt === 'string' ? { endedAt: raw.endedAt } : {}),
      ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId.trim() } : {}),
      ...(typeof raw.sessionName === 'string' ? { sessionName: raw.sessionName.trim() } : {}),
      turns,
    },
  };
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_RE.test(value) && !Number.isNaN(Date.parse(value));
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

function openNotebook(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT,
      channel_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON conversation_sessions (user_id, is_active, updated_at);');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      surface TEXT,
      channel_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      source TEXT,
      FOREIGN KEY (session_id) REFERENCES conversation_sessions(id)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_turns_session_id ON conversation_turns (session_id, id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_turns_user_time ON conversation_turns (user_id, timestamp);');
  ensureColumn(db, 'conversation_turns', 'source', 'TEXT');
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
      content,
      turn_id,
      session_id,
      user_id
    );
  `);
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, decl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((r) => r.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function appendTurns(dbPath: string, body: ParsedAppend): { sessionId: string; turnsAppended: number } {
  const db = openNotebook(dbPath);
  try {
    const now = new Date().toISOString();
    const sessionId = resolveSession(db, body, now);
    const insertTurn = db.prepare(`
      INSERT INTO conversation_turns (session_id, user_id, surface, channel_id, role, content, timestamp, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = db.prepare(
      'INSERT INTO conversation_fts (content, turn_id, session_id, user_id) VALUES (?, ?, ?, ?)',
    );
    for (const turn of body.turns) {
      const ts = turn.timestamp && isIso(turn.timestamp) ? new Date(turn.timestamp).toISOString() : now;
      const result = insertTurn.run(
        sessionId,
        body.speaker,
        body.channel,
        body.channel,
        turn.role,
        turn.content,
        ts,
        body.source,
      );
      insertFts.run(turn.content, String(result.lastInsertRowid), sessionId, body.speaker);
    }
    db.prepare('UPDATE conversation_sessions SET updated_at = ?, channel_id = COALESCE(channel_id, ?) WHERE id = ?').run(
      body.endedAt && isIso(body.endedAt) ? new Date(body.endedAt).toISOString() : now,
      body.channel,
      sessionId,
    );
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { sessionId, turnsAppended: body.turns.length };
  } finally {
    db.close();
  }
}

function resolveSession(db: DatabaseSync, body: ParsedAppend, now: string): string {
  if (body.sessionId) {
    const existing = db.prepare('SELECT id FROM conversation_sessions WHERE id = ? AND user_id = ? LIMIT 1').get(
      body.sessionId,
      body.speaker,
    ) as { id: string } | undefined;
    if (existing) return existing.id;
    db.prepare(
      'INSERT INTO conversation_sessions (id, user_id, name, channel_id, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
    ).run(body.sessionId, body.speaker, body.sessionName ?? null, body.channel, body.startedAt ?? now, now);
    return body.sessionId;
  }
  const active = db
    .prepare(
      "SELECT id FROM conversation_sessions WHERE user_id = ? AND is_active = 1 AND id NOT LIKE 's_sched_%' ORDER BY updated_at DESC LIMIT 1",
    )
    .get(body.speaker) as { id: string } | undefined;
  if (active) return active.id;
  const id = `s_edge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    'INSERT INTO conversation_sessions (id, user_id, name, channel_id, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)',
  ).run(id, body.speaker, body.sessionName ?? null, body.channel, body.startedAt ?? now, now);
  return id;
}

function readSummary(
  dbPath: string,
  sessionLimit: number,
  turnsLimit: number,
): Array<Record<string, unknown>> {
  if (!existsSync(dbPath)) return [];
  const db = openNotebook(dbPath);
  try {
    const sessions = db
      .prepare(
        `SELECT s.id, s.user_id, s.name, s.channel_id, s.created_at, s.updated_at, s.is_active,
                (SELECT COUNT(*) FROM conversation_turns t WHERE t.session_id = s.id) AS turn_count
         FROM conversation_sessions s
         ORDER BY s.updated_at DESC
         LIMIT ?`,
      )
      .all(sessionLimit) as Array<{
      id: string;
      user_id: string;
      name: string | null;
      channel_id: string | null;
      created_at: string;
      updated_at: string;
      is_active: number;
      turn_count: number;
    }>;
    const turnStmt = db.prepare(
      'SELECT role, content, timestamp, surface, channel_id, source FROM conversation_turns WHERE session_id = ? ORDER BY id DESC LIMIT ?',
    );
    return sessions.map((s) => {
      const turns = (turnStmt.all(s.id, turnsLimit) as Array<Record<string, unknown>>).reverse();
      return {
        id: s.id,
        userId: s.user_id,
        name: s.name,
        channelId: s.channel_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        isActive: Boolean(s.is_active),
        turnCount: Number(s.turn_count),
        turns,
      };
    });
  } finally {
    db.close();
  }
}
