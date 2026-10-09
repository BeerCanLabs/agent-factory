"""
Type 3: Workspace Memory Interface — Keyed by project_id and task_id.
BeerCanLabs Agent Factory — Cartridge Memory Standard.

Characteristics:
- Scoped strictly by project_id and task_id for execution, engineering, and architecture agents.
- Maintains structured project metadata, task state machines, execution turns/logs,
  key-value checkpointing, and task-scoped FTS recall.
- Provides working memory whiteboard with task context banners and on-demand search.
- Preserves long-term task records while pruning ephemeral reasoning turns on wake.
"""

import json
import re
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

DEFAULT_MAX_MESSAGES = 20
DEFAULT_MAX_CHARS = 24000
DEFAULT_RETENTION_DAYS = 30

WORKSPACE_RECALL_TOOL_SPEC = {
    "type": "function",
    "function": {
        "name": "recall_workspace_task",
        "description": (
            "Search previous workspace tasks, turns, decisions, or code notes "
            "within the active project workspace."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keywords or search phrase to find historical task information.",
                },
                "task_id": {
                    "type": "string",
                    "description": "Optional: search a specific task ID. If omitted, searches across all tasks in the active project.",
                },
            },
            "required": ["query"],
        },
    },
}


def get_workspace_db_path(memory_dir: Path | str, project_id: str) -> Path:
    """Return isolated per-project database path to prevent multi-team state co-mingling."""
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", project_id.strip()) or "default"
    return Path(memory_dir) / f"workspace_{safe_id}.db"



def init_workspace_tables(conn: sqlite3.Connection):
    """Create workspace project, task, state, turn, and FTS5 tables with WAL pragma."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS workspace_projects (
            id TEXT PRIMARY KEY,
            name TEXT,
            description TEXT,
            metadata TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workspace_proj_updated ON workspace_projects (updated_at);")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS workspace_tasks (
            id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            title TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            context TEXT,
            result TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, id),
            FOREIGN KEY (project_id) REFERENCES workspace_projects(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workspace_tasks_status ON workspace_tasks (project_id, status);")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS workspace_turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            metadata TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (project_id, task_id) REFERENCES workspace_tasks(project_id, id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workspace_turns_task ON workspace_turns (project_id, task_id, id);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_workspace_turns_time ON workspace_turns (project_id, timestamp);")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS workspace_state (
            project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, task_id, key)
        )
    """)

    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS workspace_fts USING fts5(
            content,
            turn_id UNINDEXED,
            project_id UNINDEXED,
            task_id UNINDEXED
        )
    """)
    conn.commit()


# ---------------------------------------------------------------------------
# Project operations
# ---------------------------------------------------------------------------


def create_or_get_project(
    conn: sqlite3.Connection,
    project_id: str,
    name: str | None = None,
    description: str | None = None,
    metadata: dict | None = None,
) -> dict:
    """Retrieve an existing project or create a new one."""
    row = conn.execute(
        "SELECT id, name, description, metadata, created_at, updated_at FROM workspace_projects WHERE id = ?",
        (project_id,),
    ).fetchone()
    if row:
        return {
            "id": row[0],
            "name": row[1],
            "description": row[2],
            "metadata": json.loads(row[3]) if row[3] else {},
            "created_at": row[4],
            "updated_at": row[5],
        }

    now = datetime.now(timezone.utc).isoformat()
    meta_json = json.dumps(metadata) if metadata else None
    conn.execute(
        "INSERT INTO workspace_projects (id, name, description, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (project_id, name or project_id, description, meta_json, now, now),
    )
    conn.commit()
    return {
        "id": project_id,
        "name": name or project_id,
        "description": description,
        "metadata": metadata or {},
        "created_at": now,
        "updated_at": now,
    }


def get_project(conn: sqlite3.Connection, project_id: str) -> dict | None:
    """Get project details by project_id."""
    row = conn.execute(
        "SELECT id, name, description, metadata, created_at, updated_at FROM workspace_projects WHERE id = ?",
        (project_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "name": row[1],
        "description": row[2],
        "metadata": json.loads(row[3]) if row[3] else {},
        "created_at": row[4],
        "updated_at": row[5],
    }


def list_projects(conn: sqlite3.Connection, limit: int = 50) -> list[dict]:
    """List recent projects."""
    rows = conn.execute(
        "SELECT id, name, description, metadata, created_at, updated_at FROM workspace_projects ORDER BY updated_at DESC LIMIT ?",
        (limit,),
    ).fetchall()
    return [
        {
            "id": r[0],
            "name": r[1],
            "description": r[2],
            "metadata": json.loads(r[3]) if r[3] else {},
            "created_at": r[4],
            "updated_at": r[5],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Task operations
# ---------------------------------------------------------------------------


def create_or_update_task(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
    title: str | None = None,
    status: str = "pending",
    context: dict | str | None = None,
    result: dict | str | None = None,
) -> dict:
    """Create or update a task within a project."""
    create_or_get_project(conn, project_id)
    now = datetime.now(timezone.utc).isoformat()
    ctx_str = json.dumps(context) if isinstance(context, dict) else (context or "")
    res_str = json.dumps(result) if isinstance(result, dict) else (result or "")

    existing = conn.execute(
        "SELECT id, title, status, context, result, created_at, updated_at FROM workspace_tasks WHERE project_id = ? AND id = ?",
        (project_id, task_id),
    ).fetchone()

    if existing:
        new_title = title if title is not None else existing[1]
        new_status = status if status is not None else existing[2]
        new_ctx = ctx_str if context is not None else existing[3]
        new_res = res_str if result is not None else existing[4]
        conn.execute(
            """
            UPDATE workspace_tasks
            SET title = ?, status = ?, context = ?, result = ?, updated_at = ?
            WHERE project_id = ? AND id = ?
            """,
            (new_title, new_status, new_ctx, new_res, now, project_id, task_id),
        )
        created_at = existing[5]
    else:
        conn.execute(
            """
            INSERT INTO workspace_tasks (id, project_id, title, status, context, result, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (task_id, project_id, title or task_id, status, ctx_str, res_str, now, now),
        )
        created_at = now

    # Touch project updated_at
    conn.execute("UPDATE workspace_projects SET updated_at = ? WHERE id = ?", (now, project_id))
    conn.commit()

    return {
        "id": task_id,
        "project_id": project_id,
        "title": title or task_id,
        "status": status,
        "context": context,
        "result": result,
        "created_at": created_at,
        "updated_at": now,
    }


def get_task(conn: sqlite3.Connection, project_id: str, task_id: str) -> dict | None:
    """Retrieve task record by project_id and task_id."""
    row = conn.execute(
        "SELECT id, project_id, title, status, context, result, created_at, updated_at FROM workspace_tasks WHERE project_id = ? AND id = ?",
        (project_id, task_id),
    ).fetchone()
    if not row:
        return None

    def _parse(val):
        if not val:
            return None
        try:
            return json.loads(val)
        except Exception:
            return val

    return {
        "id": row[0],
        "project_id": row[1],
        "title": row[2],
        "status": row[3],
        "context": _parse(row[4]),
        "result": _parse(row[5]),
        "created_at": row[6],
        "updated_at": row[7],
    }


def update_task_status(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
    status: str,
    result: dict | str | None = None,
) -> bool:
    """Update task lifecycle status (e.g. pending, in_progress, completed, failed)."""
    now = datetime.now(timezone.utc).isoformat()
    res_str = json.dumps(result) if isinstance(result, dict) else (result or None)
    if result is not None:
        cur = conn.execute(
            "UPDATE workspace_tasks SET status = ?, result = ?, updated_at = ? WHERE project_id = ? AND id = ?",
            (status, res_str, now, project_id, task_id),
        )
    else:
        cur = conn.execute(
            "UPDATE workspace_tasks SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?",
            (status, now, project_id, task_id),
        )
    conn.execute("UPDATE workspace_projects SET updated_at = ? WHERE id = ?", (now, project_id))
    conn.commit()
    return cur.rowcount > 0


def list_tasks(conn: sqlite3.Connection, project_id: str, status: str | None = None, limit: int = 50) -> list[dict]:
    """List tasks in a project, optionally filtered by status."""
    if status:
        rows = conn.execute(
            """
            SELECT id, project_id, title, status, context, result, created_at, updated_at
            FROM workspace_tasks
            WHERE project_id = ? AND status = ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (project_id, status, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT id, project_id, title, status, context, result, created_at, updated_at
            FROM workspace_tasks
            WHERE project_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (project_id, limit),
        ).fetchall()

    def _parse(val):
        if not val:
            return None
        try:
            return json.loads(val)
        except Exception:
            return val

    return [
        {
            "id": r[0],
            "project_id": r[1],
            "title": r[2],
            "status": r[3],
            "context": _parse(r[4]),
            "result": _parse(r[5]),
            "created_at": r[6],
            "updated_at": r[7],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Task Reasoning Turns & Whiteboard
# ---------------------------------------------------------------------------


def record_task_turn(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
    role: str,
    content: str,
    metadata: dict | None = None,
) -> int:
    """Record a single task turn / event (user, assistant, tool, system) in SQLite and FTS5."""
    if not content:
        return 0
    create_or_get_project(conn, project_id)
    now = datetime.now(timezone.utc).isoformat()
    meta_json = json.dumps(metadata) if metadata else None

    cur = conn.execute(
        """
        INSERT INTO workspace_turns (project_id, task_id, role, content, metadata, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (project_id, task_id, role, content, meta_json, now),
    )
    turn_id = cur.lastrowid

    # Update FTS5 virtual table
    conn.execute(
        "INSERT INTO workspace_fts (content, turn_id, project_id, task_id) VALUES (?, ?, ?, ?)",
        (content, str(turn_id), project_id, task_id),
    )

    conn.execute("UPDATE workspace_tasks SET updated_at = ? WHERE project_id = ? AND id = ?", (now, project_id, task_id))
    conn.execute("UPDATE workspace_projects SET updated_at = ? WHERE id = ?", (now, project_id))
    conn.commit()
    return turn_id


def load_task_whiteboard(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
    max_messages: int = DEFAULT_MAX_MESSAGES,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> tuple[list[dict], str | None]:
    """Assemble active working memory (Whiteboard) for a specific workspace task."""
    task = get_task(conn, project_id, task_id)
    task_title = task["title"] if task else task_id
    task_status = task["status"] if task else "unknown"

    total_turns = conn.execute(
        "SELECT COUNT(*) FROM workspace_turns WHERE project_id = ? AND task_id = ?",
        (project_id, task_id),
    ).fetchone()[0]

    rows = conn.execute(
        "SELECT role, content FROM workspace_turns WHERE project_id = ? AND task_id = ? ORDER BY id DESC LIMIT ?",
        (project_id, task_id, max_messages),
    ).fetchall()

    kept: list[dict] = []
    size = 0
    for role, content in rows:
        size += len(content)
        if kept and size > max_chars:
            break
        kept.append({"role": role, "content": content})

    history = list(reversed(kept))
    shown_count = len(history)

    banner = None
    if total_turns > shown_count or task:
        banner = (
            f"[Workspace Context: Project '{project_id}' | Task '{task_id}' ({task_status}: {task_title}) | "
            f"Total turns: {total_turns} | Showing recent: {shown_count} turns]\n"
            f"[System Note: Earlier task steps and project history exist. Use the `recall_workspace_task` "
            f"tool to search past execution turns, decisions, or code changes.]"
        )

    return history, banner


# ---------------------------------------------------------------------------
# Key-Value Task State Checkpointing
# ---------------------------------------------------------------------------


def set_task_state(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
    key: str,
    value: Any,
) -> None:
    """Store or update a checkpoint state value for a specific task."""
    now = datetime.now(timezone.utc).isoformat()
    val_json = json.dumps(value)
    conn.execute(
        """
        INSERT INTO workspace_state (project_id, task_id, key, value, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(project_id, task_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        """,
        (project_id, task_id, key, val_json, now),
    )
    conn.commit()


def get_task_state(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
    key: str,
    default: Any = None,
) -> Any:
    """Retrieve a checkpoint state value for a specific task."""
    row = conn.execute(
        "SELECT value FROM workspace_state WHERE project_id = ? AND task_id = ? AND key = ?",
        (project_id, task_id, key),
    ).fetchone()
    if not row:
        return default
    try:
        return json.loads(row[0])
    except Exception:
        return row[0]


def get_all_task_state(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
) -> dict[str, Any]:
    """Retrieve all checkpoint state key-values for a task."""
    rows = conn.execute(
        "SELECT key, value FROM workspace_state WHERE project_id = ? AND task_id = ?",
        (project_id, task_id),
    ).fetchall()
    out = {}
    for k, v in rows:
        try:
            out[k] = json.loads(v)
        except Exception:
            out[k] = v
    return out


def delete_task_state(
    conn: sqlite3.Connection,
    project_id: str,
    task_id: str,
    key: str,
) -> bool:
    """Delete a specific checkpoint state key for a task."""
    cur = conn.execute(
        "DELETE FROM workspace_state WHERE project_id = ? AND task_id = ? AND key = ?",
        (project_id, task_id, key),
    )
    conn.commit()
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Workspace Recall (FTS5 + LIKE fallback)
# ---------------------------------------------------------------------------


def recall_task_memory(
    conn: sqlite3.Connection,
    project_id: str,
    query: str,
    task_id: str | None = None,
    limit: int = 5,
) -> list[dict]:
    """Search workspace turns using FTS5 with LIKE fallback, scoped to project and optional task."""
    clean_query = query.strip()
    if not clean_query:
        return []

    results = []
    # 1. Try FTS5 MATCH
    try:
        terms = [f'"{w}"' for w in re.findall(r"\w+", clean_query) if w]
        fts_query = " OR ".join(terms) if terms else clean_query
        if task_id:
            rows = conn.execute(
                """
                SELECT turn_id, task_id, content
                FROM workspace_fts
                WHERE project_id = ? AND task_id = ? AND workspace_fts MATCH ?
                LIMIT ?
                """,
                (project_id, task_id, fts_query, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT turn_id, task_id, content
                FROM workspace_fts
                WHERE project_id = ? AND workspace_fts MATCH ?
                LIMIT ?
                """,
                (project_id, fts_query, limit),
            ).fetchall()

        for t_id, t_task_id, content in rows:
            meta = conn.execute(
                "SELECT role, timestamp, metadata FROM workspace_turns WHERE id = ?",
                (int(t_id),),
            ).fetchone()
            results.append({
                "turn_id": int(t_id),
                "project_id": project_id,
                "task_id": t_task_id,
                "role": meta[0] if meta else "unknown",
                "timestamp": meta[1] if meta else "",
                "metadata": json.loads(meta[2]) if meta and meta[2] else {},
                "content": content,
            })
    except Exception as e:
        print(f"[workspace] FTS5 search error ('{e}'), falling back to LIKE", flush=True)

    # 2. Fallback to LIKE if FTS5 returned nothing or errored
    if not results:
        like_query = f"%{clean_query}%"
        if task_id:
            rows = conn.execute(
                """
                SELECT id, task_id, role, content, timestamp, metadata
                FROM workspace_turns
                WHERE project_id = ? AND task_id = ? AND content LIKE ?
                ORDER BY id DESC LIMIT ?
                """,
                (project_id, task_id, like_query, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, task_id, role, content, timestamp, metadata
                FROM workspace_turns
                WHERE project_id = ? AND content LIKE ?
                ORDER BY id DESC LIMIT ?
                """,
                (project_id, like_query, limit),
            ).fetchall()

        for r in rows:
            results.append({
                "turn_id": r[0],
                "project_id": project_id,
                "task_id": r[1],
                "role": r[2],
                "content": r[3],
                "timestamp": r[4],
                "metadata": json.loads(r[5]) if r[5] else {},
            })

    return results


# ---------------------------------------------------------------------------
# Rolling Retention Pruning
# ---------------------------------------------------------------------------


def prune_workspace(conn: sqlite3.Connection, retention_days: int = DEFAULT_RETENTION_DAYS) -> int:
    """Drop workspace turns older than retention_days, preserving tasks and checkpoint state."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    old_turn_ids = [r[0] for r in conn.execute("SELECT id FROM workspace_turns WHERE timestamp < ?", (cutoff,)).fetchall()]
    if not old_turn_ids:
        return 0

    cur = conn.execute("DELETE FROM workspace_turns WHERE timestamp < ?", (cutoff,))
    for t_id in old_turn_ids:
        conn.execute("DELETE FROM workspace_fts WHERE turn_id = ?", (str(t_id),))

    conn.commit()
    return cur.rowcount
