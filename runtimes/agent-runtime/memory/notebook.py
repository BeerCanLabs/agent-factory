"""
Notebook rotation and closed volumes (Agent Factory AM3).

Nothing in the notebook is forgotten; the notebook rotates instead. When the current notebook reaches the factory's
limits (FACTORY_NOTEBOOK_MAX_BYTES, FACTORY_NOTEBOOK_MAX_DAYS: 10 MB or 90 days, whichever comes first), the agent
closes it as a read-only volume under $MEMORY_DIR/volumes/<name>/ and starts a new one that carries forward the open
conversations and an index of the closed volumes. The factory archives volumes and never hydrates them on wake; a closed
volume comes back when the agent asks for it ($MEMORY_DIR/.volume-requests/<name>), so the agent never touches storage.
"""

import os
import shutil
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from . import episodic

NOTEBOOK_FILE = "agent_state.db"
DEFAULT_MAX_BYTES = 10 * 1024 * 1024
DEFAULT_MAX_DAYS = 90
CARRY_FORWARD_TURNS = 20
CARRY_FORWARD_CONVERSATIONS = 500  # the most recently used; older ones stay in the volume, found by search


def limits() -> tuple[int, int]:
    """The factory-wide rotation limits (bytes, days), from the run's environment."""
    max_bytes = DEFAULT_MAX_BYTES
    raw_bytes = os.environ.get("FACTORY_NOTEBOOK_MAX_BYTES", "")
    if raw_bytes:
        try:
            v = int(raw_bytes)
            if v > 0:
                max_bytes = v
        except ValueError:
            pass

    max_days = DEFAULT_MAX_DAYS
    raw_days = os.environ.get("FACTORY_NOTEBOOK_MAX_DAYS", "")
    if raw_days:
        try:
            v = int(raw_days)
            if v > 0:
                max_days = v
        except ValueError:
            pass

    return max_bytes, max_days


def volumes_dir(memory_dir: Path) -> Path:
    return memory_dir / os.environ.get("FACTORY_NOTEBOOK_VOLUMES_DIR", "volumes")


def requests_dir(memory_dir: Path) -> Path:
    return memory_dir / os.environ.get("FACTORY_VOLUME_REQUESTS_DIR", ".volume-requests")


def init_notebook_tables(conn: sqlite3.Connection) -> None:
    """The notebook's own record: when it was opened, and the index of closed volumes."""
    conn.execute("CREATE TABLE IF NOT EXISTS notebook_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notebook_volumes (name TEXT PRIMARY KEY, opened_at TEXT, closed_at TEXT NOT NULL, size_bytes INTEGER)"
    )
    # A notebook that predates rotation was opened when its oldest conversation began, not at the upgrade.
    opened = datetime.now(timezone.utc).isoformat()
    try:
        oldest = conn.execute("SELECT MIN(timestamp) FROM conversation_turns").fetchone()[0]
        if oldest:
            opened = oldest
    except sqlite3.OperationalError:
        pass
    conn.execute("INSERT OR IGNORE INTO notebook_meta (key, value) VALUES ('opened_at', ?)", (opened,))
    conn.commit()


def opened_at(conn: sqlite3.Connection) -> datetime:
    row = conn.execute("SELECT value FROM notebook_meta WHERE key = 'opened_at'").fetchone()
    return datetime.fromisoformat(row[0]) if row else datetime.now(timezone.utc)


def notebook_bytes(memory_dir: Path, db_file: str = NOTEBOOK_FILE) -> int:
    return sum(p.stat().st_size for p in memory_dir.glob(db_file + "*") if p.is_file())


def should_rotate(memory_dir: Path, conn: sqlite3.Connection, now: datetime | None = None, db_file: str = NOTEBOOK_FILE) -> bool:
    max_bytes, max_days = limits()
    now = now or datetime.now(timezone.utc)
    return notebook_bytes(memory_dir, db_file=db_file) >= max_bytes or (now - opened_at(conn)).days >= max_days


def list_volumes(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT name, opened_at, closed_at, size_bytes FROM notebook_volumes ORDER BY closed_at DESC").fetchall()
    return [{"name": r[0], "opened_at": r[1], "closed_at": r[2], "size_bytes": r[3]} for r in rows]


def rotate(
    memory_dir: Path,
    conn: sqlite3.Connection,
    init_fn=None,
    now: datetime | None = None,
    carry_tables: tuple[str, ...] = (),
    db_file: str = NOTEBOOK_FILE,
) -> sqlite3.Connection:
    """Close the current notebook as a volume and open a new one. Returns the new connection.

    `init_fn(conn)` creates the agent's tables in the new notebook; without one, the current notebook's schema is copied.
    `carry_tables` are copied whole: the agent's lasting knowledge. Every person's conversations (the most recently used
    CARRY_FORWARD_CONVERSATIONS, each with its last turns) come along, so naming, listing and resuming keep working; the
    volume index comes too. The new notebook is built first and swapped in last, so a failure leaves the current one.
    """
    now = now or datetime.now(timezone.utc)
    vols = volumes_dir(memory_dir)
    name = now.strftime("%Y%m%d-%H%M%S")
    n = 1
    while (vols / name).exists():
        n += 1
        name = f"{now.strftime('%Y%m%d-%H%M%S')}-{n}"
    carried = _conversations(conn)
    index = list_volumes(conn)
    first_opened = opened_at(conn).isoformat()
    current = memory_dir / db_file
    staged = memory_dir / (db_file + ".next")
    staged.unlink(missing_ok=True)

    conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    new = sqlite3.connect(str(staged))
    try:
        if init_fn:
            init_fn(new)
        else:
            copy_schema(conn, new)
        init_notebook_tables(new)
        if carry_tables:
            new.execute("ATTACH DATABASE ? AS old", (str(current),))
            for table in carry_tables:
                new.execute(f'INSERT INTO main."{table}" SELECT * FROM old."{table}"')
            new.commit()
            new.execute("DETACH DATABASE old")
        for v in index:
            new.execute(
                "INSERT OR IGNORE INTO notebook_volumes (name, opened_at, closed_at, size_bytes) VALUES (?, ?, ?, ?)",
                (v["name"], v["opened_at"], v["closed_at"], v["size_bytes"]),
            )
        new.execute(
            "INSERT INTO notebook_volumes (name, opened_at, closed_at, size_bytes) VALUES (?, ?, ?, ?)",
            (name, first_opened, now.isoformat(), notebook_bytes(memory_dir, db_file=db_file)),
        )
        for session, turns in carried:
            new.execute(
                "INSERT INTO conversation_sessions (id, user_id, name, channel_id, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)",
                session,
            )
            for t in turns:
                cur = new.execute(
                    "INSERT INTO conversation_turns (session_id, user_id, surface, channel_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    t,
                )
                new.execute(
                    "INSERT INTO conversation_fts (content, turn_id, session_id, user_id) VALUES (?, ?, ?, ?)",
                    (t[5], str(cur.lastrowid), t[0], t[1]),
                )
        new.commit()
    finally:
        new.close()

    conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
    conn.close()
    (vols / name).mkdir(parents=True, exist_ok=True)
    closed = vols / name / db_file
    try:
        if current.exists():
            shutil.move(str(current), str(closed))
        for suffix in ("-wal", "-shm"):
            (memory_dir / (db_file + suffix)).unlink(missing_ok=True)
        os.replace(staged, current)  # the new notebook keeps the file name (the factory's sync never deletes)
    except Exception:
        # Put the notebook back as it was: a failed rotation must never look like a wiped memory.
        if closed.exists() and not current.exists():
            shutil.move(str(closed), str(current))
        shutil.rmtree(vols / name, ignore_errors=True)
        raise

    reopened = sqlite3.connect(str(current))
    reopened.execute("PRAGMA journal_mode = WAL;")
    reopened.execute("PRAGMA busy_timeout = 5000;")
    print(f"[notebook] Rotated: closed volume {name}; carried {len(carried)} conversation(s).", flush=True)
    return reopened


def copy_schema(src: sqlite3.Connection, dst: sqlite3.Connection) -> None:
    """Create in `dst` every table and index `src` has (full-text search tables once, not their internal tables)."""
    rows = src.execute(
        "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' "
        "ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END"
    ).fetchall()
    virtual = [r[1] for r in rows if r[0] == "table" and r[2].upper().startswith("CREATE VIRTUAL")]
    for kind, name, sql in rows:
        if any(name.startswith(v + "_") for v in virtual):
            continue  # created by its virtual table
        dst.execute(
            sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ", 1)
            .replace("CREATE VIRTUAL TABLE ", "CREATE VIRTUAL TABLE IF NOT EXISTS ", 1)
            .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ", 1)
            .replace("CREATE UNIQUE INDEX ", "CREATE UNIQUE INDEX IF NOT EXISTS ", 1)
        )
    dst.commit()


def _conversations(conn: sqlite3.Connection) -> list[tuple[tuple, list[tuple]]]:
    try:
        sessions = conn.execute(
            "SELECT id, user_id, name, channel_id, created_at, updated_at, is_active FROM conversation_sessions ORDER BY updated_at DESC LIMIT ?",
            (CARRY_FORWARD_CONVERSATIONS,),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    out = []
    for s in sessions:
        turns = conn.execute(
            "SELECT session_id, user_id, surface, channel_id, role, content, timestamp FROM conversation_turns WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (s[0], CARRY_FORWARD_TURNS),
        ).fetchall()
        out.append((s, list(reversed(turns))))
    return out


def request_volume(memory_dir: Path, name: str, timeout_s: float = 30.0, poll_s: float = 0.25, db_file: str = NOTEBOOK_FILE) -> Path | None:
    """Ask the factory for a closed volume. Returns its local directory, or None if it could not be fetched in time."""
    local = volumes_dir(memory_dir) / name / db_file
    if local.exists():
        return local.parent
    reqs = requests_dir(memory_dir)
    reqs.mkdir(parents=True, exist_ok=True)
    for stale in (reqs / f"{name}.done", reqs / f"{name}.error"):
        stale.unlink(missing_ok=True)
    (reqs / name).write_text("", "utf-8")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if (reqs / f"{name}.done").exists():
            (reqs / f"{name}.done").unlink(missing_ok=True)
            return local.parent if local.exists() else None
        if (reqs / f"{name}.error").exists():
            print(f"[notebook] Volume {name} could not be fetched: {(reqs / f'{name}.error').read_text('utf-8')}", flush=True)
            (reqs / f"{name}.error").unlink(missing_ok=True)
            return None
        time.sleep(poll_s)
    return None


VOLUMES_SEARCHED = 3  # per search: the newest closed volumes, so a recall never waits on the whole archive


def search_volumes(
    memory_dir: Path,
    conn: sqlite3.Connection,
    user_id: str,
    query: str,
    limit: int = 5,
    fetch=None,
    db_file: str = NOTEBOOK_FILE,
    session_name: str | None = None,
) -> list[dict]:
    """Search this person's turns in closed volumes, newest first, fetching each volume only when needed (AM4)."""
    fetch = fetch or (lambda d, n: request_volume(d, n, timeout_s=10.0, db_file=db_file))
    hits: list[dict] = []
    for v in list_volumes(conn)[:VOLUMES_SEARCHED]:
        if len(hits) >= limit:
            break
        where = fetch(memory_dir, v["name"])
        if not where:
            continue
        try:
            vol = sqlite3.connect(f"file:{where / db_file}?mode=ro", uri=True)
        except sqlite3.Error:
            continue
        try:
            for h in episodic.recall_conversation(vol, user_id, query, session_name=session_name, limit=limit - len(hits)):
                hits.append({**h, "volume": v["name"]})
        except sqlite3.Error as e:
            # A volume from before conversations were kept per person has no such tables: skip it, search the rest.
            print(f"[notebook] Volume {v['name']} not searchable: {e}", flush=True)
        finally:
            vol.close()
    return hits
