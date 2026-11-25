"""#552: bring an agent's pre-shared-runtime notebook forward, once, instead of starting with an empty memory.

Before the shared runtime, an agent's cartridge kept its notebook in `<mind>/<agent>_state.db`. The shared runtime opens
`<mind>/agent_state.db` and never read the old file, so everything an agent had learned (people facts, named
conversations, its skills' tables) silently disappeared from its working memory on the switch.

On boot, every `*_state.db` in the mind directory other than the runtime's own notebook is imported into it:

- conversations (`conversation_sessions`, `conversation_turns`, and the full-text index) are merged, de-duplicated, and
  kept under the speaker id they were stored with. Ids are never re-mapped: guessing that an old id is a person would
  show one person's conversation to another (AM2). Imported sessions come in inactive, so they never replace a person's
  current conversation; they can be resumed by name and are found by recall.
- every other table (people facts such as `entity_knowledge`, a skill's own tables) is copied whole when the notebook
  does not have it, or merged row by row (`INSERT OR IGNORE`) when it does, and is carried through notebook rotation.

The legacy file is never changed or deleted: it stays as the backup. What was imported is recorded in
`<mind>/legacy-import.json` (the file's sha256, row counts, tables), which is synced with the mind and survives
rotation, so a file is imported once. A failed import is reported loudly (stderr and the run's result), never skipped
silently, and the next boot tries again.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

from memory.notebook import NOTEBOOK_FILE

MARKER_FILE = "legacy-import.json"
LEGACY_SUFFIX = "_state.db"
# The runtime's own bookkeeping: never copied from a legacy notebook (conversations are merged on their own).
_RUNTIME_TABLES = frozenset({"conversation_sessions", "conversation_turns", "conversation_fts", "notebook_meta", "notebook_volumes", "sqlite_sequence"})


def find_legacy(memory_dir: Path) -> list[Path]:
    """Legacy notebooks at the top of the mind directory (closed volumes and the runtime's own file are not legacy)."""
    if not memory_dir.is_dir():
        return []
    found = []
    for p in memory_dir.iterdir():
        if p.is_file() and p.name.endswith(LEGACY_SUFFIX) and p.name != NOTEBOOK_FILE and not p.name.startswith("."):
            found.append(p)
    return sorted(found, key=lambda p: p.name)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_marker(memory_dir: Path) -> dict:
    try:
        data = json.loads((memory_dir / MARKER_FILE).read_text())
        return data if isinstance(data, dict) and isinstance(data.get("files"), dict) else {"files": {}}
    except (OSError, ValueError):
        return {"files": {}}


def _write_marker(memory_dir: Path, marker: dict) -> None:
    tmp = memory_dir / (MARKER_FILE + ".tmp")
    tmp.write_text(json.dumps(marker, indent=2, sort_keys=True))
    os.replace(tmp, memory_dir / MARKER_FILE)


def carried_tables(memory_dir: Path) -> list[str]:
    """Every table a past import brought in: notebook rotation must carry them forward, or they are lost again."""
    names: set[str] = set()
    for entry in read_marker(memory_dir)["files"].values():
        if isinstance(entry, dict):
            names.update(t for t in entry.get("tables", {}) if isinstance(t, str))
    return sorted(names)


def table_sql(conn: sqlite3.Connection, tables: list[str]) -> dict[str, str]:
    """CREATE statements for those of `tables` that `conn` has, so a rotated notebook can be given the same tables."""
    out: dict[str, str] = {}
    for name in tables:
        row = conn.execute("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)).fetchone()
        if row and row[0]:
            out[name] = row[0].replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1)
    return out


def _q(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [r[1] for r in conn.execute(f"PRAGMA table_info({_q(table)})")]


def _user_tables(conn: sqlite3.Connection) -> list[tuple[str, str]]:
    rows = conn.execute("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").fetchall()
    out = []
    for name, sql in rows:
        if name in _RUNTIME_TABLES or name.startswith("conversation_fts_") or not sql:
            continue
        if sql.upper().startswith("CREATE VIRTUAL TABLE"):
            continue  # a virtual table's shadow tables are its storage; its source rows are copied instead
        out.append((name, sql))
    return out


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?", (name,)).fetchone() is not None


def _import_conversations(src: sqlite3.Connection, dst: sqlite3.Connection) -> tuple[int, int]:
    if not (_has_table(src, "conversation_sessions") and _has_table(src, "conversation_turns")):
        return 0, 0
    sessions = 0
    for row in src.execute("SELECT id, user_id, name, channel_id, created_at, updated_at FROM conversation_sessions"):
        cur = dst.execute(
            "INSERT OR IGNORE INTO conversation_sessions (id, user_id, name, channel_id, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 0)",
            row,
        )
        sessions += cur.rowcount
    have_fts = _has_table(dst, "conversation_fts")
    src_cols = set(_columns(src, "conversation_turns"))
    surface = "surface" if "surface" in src_cols else "'discord'"
    channel = "channel_id" if "channel_id" in src_cols else "NULL"
    turns = 0
    for session_id, user_id, surf, chan, role, content, ts in src.execute(
        f"SELECT session_id, user_id, {surface}, {channel}, role, content, timestamp FROM conversation_turns ORDER BY id"
    ):
        dup = dst.execute(
            "SELECT 1 FROM conversation_turns WHERE session_id = ? AND role = ? AND timestamp = ? AND content = ? LIMIT 1",
            (session_id, role, ts, content),
        ).fetchone()
        if dup:
            continue
        cur = dst.execute(
            "INSERT INTO conversation_turns (session_id, user_id, surface, channel_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (session_id, user_id, surf or "discord", chan, role, content, ts),
        )
        if have_fts:
            dst.execute(
                "INSERT INTO conversation_fts (content, turn_id, session_id, user_id) VALUES (?, ?, ?, ?)",
                (content, str(cur.lastrowid), session_id, user_id),
            )
        turns += 1
    return sessions, turns


def _import_tables(src: sqlite3.Connection, dst: sqlite3.Connection) -> dict[str, int]:
    counts: dict[str, int] = {}
    for name, sql in _user_tables(src):
        if not _has_table(dst, name):
            dst.execute(sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1))
        cols = [c for c in _columns(src, name) if c in set(_columns(dst, name))]
        if not cols:
            counts[name] = 0
            continue
        col_list = ", ".join(_q(c) for c in cols)
        marks = ", ".join("?" for _ in cols)
        n = 0
        for row in src.execute(f"SELECT {col_list} FROM {_q(name)}"):
            n += dst.execute(f"INSERT OR IGNORE INTO {_q(name)} ({col_list}) VALUES ({marks})", row).rowcount
        counts[name] = n
    return counts


def _import_one(path: Path, dst: sqlite3.Connection) -> dict:
    src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        dst.commit()  # nothing of an earlier step rides in this import's transaction
        try:
            sessions, turns = _import_conversations(src, dst)
            tables = _import_tables(src, dst)
            dst.commit()
        except Exception:
            dst.rollback()
            raise
    finally:
        src.close()
    return {"sessions": sessions, "turns": turns, "tables": tables}


def import_legacy(memory_dir: Path, dst: sqlite3.Connection) -> dict:
    """Import every legacy notebook not yet imported. Returns a summary for the run's result:
    `status` is `none` (no legacy file), `done` (all imported, now or before) or `failed` (at least one was not)."""
    legacy = find_legacy(memory_dir)
    if not legacy:
        return {"status": "none"}
    marker = read_marker(memory_dir)
    files = []
    failed = False
    for path in legacy:
        try:
            digest = _sha256(path)
            seen = marker["files"].get(path.name)
            if isinstance(seen, dict) and seen.get("sha256") == digest:
                files.append({"file": path.name, "status": "already"})
                continue
            counts = _import_one(path, dst)
            marker["files"][path.name] = {"sha256": digest, "importedAt": datetime.now(timezone.utc).isoformat(), **counts}
            _write_marker(memory_dir, marker)
            files.append({"file": path.name, "status": "imported", "sessions": counts["sessions"], "turns": counts["turns"], "tables": sorted(counts["tables"])})
            print(f"[mind] imported legacy notebook {path.name}: {counts['sessions']} session(s), {counts['turns']} turn(s), tables {sorted(counts['tables'])}", flush=True)
        except Exception as err:  # loud, never silent: the agent must not quietly run on an empty memory (#552)
            failed = True
            files.append({"file": path.name, "status": "failed", "error": f"{type(err).__name__}: {err}"[:300]})
            print(f"[mind] ERROR: legacy notebook {path.name} was NOT imported ({type(err).__name__}: {err}); the agent is running without that memory", file=sys.stderr, flush=True)
    return {"status": "failed" if failed else "done", "files": files}
