"""Memory by archetype (AM1 to AM5), opened only here, inside the agent's own container. The factory never opens a notebook."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from memory import (
    ARCHETYPE_PERSONAL_ASSISTANT,
    ARCHETYPE_PURPOSE_BUILT,
    ARCHETYPE_TEAM_MEMBER,
    DEFAULT_MAX_CHARS,
    DEFAULT_MAX_MESSAGES,
    DEFAULT_RETENTION_DAYS,
    canonical_archetype,
)
from memory import ephemeral, episodic, workspace, notebook



def is_scheduled_payload(payload: dict) -> bool:
    """Return True when the turn payload represents a background schedule or cron invocation (#345)."""
    if not isinstance(payload, dict):
        return False
    if payload.get("source") in ("schedule", "cron"):
        return True
    caller = payload.get("caller")
    return isinstance(caller, dict) and caller.get("source") in ("schedule", "cron")


def _schedule_meta(payload: dict) -> tuple[str | None, str | None, str | None]:
    if not isinstance(payload, dict):
        return None, None, None
    schedule_id = payload.get("scheduleId") if isinstance(payload.get("scheduleId"), str) else None
    caller = payload.get("caller") if isinstance(payload.get("caller"), dict) else {}
    schedule_name = (
        payload.get("scheduleName")
        if isinstance(payload.get("scheduleName"), str)
        else (caller.get("scheduleName") if isinstance(caller.get("scheduleName"), str) else None)
    )
    reply_to = payload.get("replyTo") if isinstance(payload.get("replyTo"), dict) else {}
    channel_id = str(reply_to["channelId"]) if reply_to.get("channelId") else None
    return schedule_id, schedule_name, channel_id


def _connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(str(path))
    db.execute("PRAGMA journal_mode = WAL;")
    db.execute("PRAGMA synchronous = NORMAL;")
    db.execute("PRAGMA busy_timeout = 5000;")
    return db


class Mind:
    """What the loop needs of memory: the history for this turn, a place to remember it, and the AM5 answers."""

    archetype = ""

    def fast_path(self, who: str, text: str) -> str | None:
        return None

    def history(self, who: str, payload: dict) -> tuple[list[dict], str | None]:
        return [], None

    def remember(self, who: str, payload: dict, user_text: str, reply: str, surface: str, channel_id: str | None) -> None:
        pass

    def tools(self) -> list[tuple[dict, Any]]:
        return []

    def conversations(self, who: str, op: str, conversation: str | None, limit: int) -> dict:
        return {"conversations": []} if op == "list" else {"conversation": None, "turns": []}

    def close(self) -> None:
        pass


class PurposeBuilt(Mind):
    archetype = ARCHETYPE_PURPOSE_BUILT

    def __init__(self, bounds: dict):
        self.bounds = bounds
        # One board per person: people who join one warm run never see each other's turns (AM2).
        self.boards: dict[str, ephemeral.EphemeralWhiteboard] = {}

    def _board(self, who: str, payload: dict) -> ephemeral.EphemeralWhiteboard:
        if is_scheduled_payload(payload):
            sched_id, sched_name, _ = _schedule_meta(payload)
            key = f"{who}#schedule:{sched_id or sched_name or 'default'}"
        else:
            key = who
        if key not in self.boards:
            self.boards[key] = ephemeral.EphemeralWhiteboard(max_messages=self.bounds["max_messages"], max_chars=self.bounds["max_chars"])
        return self.boards[key]

    def history(self, who, payload):
        return self._board(who, payload).load_whiteboard()

    def remember(self, who, payload, user_text, reply, surface, channel_id):
        self._board(who, payload).remember_turn(user_text, reply)


class PersonalAssistant(Mind):
    archetype = ARCHETYPE_PERSONAL_ASSISTANT

    def __init__(self, memory_dir: Path, bounds: dict):
        self.memory_dir = memory_dir
        self.bounds = bounds
        self.db = _connect(memory_dir / "agent_state.db")
        episodic.init_episodic_tables(self.db)
        notebook.init_notebook_tables(self.db)
        if notebook.should_rotate(memory_dir, self.db):
            try:
                self.db = notebook.rotate(memory_dir, self.db, init_fn=episodic.init_episodic_tables)
            except Exception as e:
                print(f"[mind] Error rotating notebook: {e}", flush=True)
                self.db = _connect(memory_dir / "agent_state.db")

    def fast_path(self, who, text):
        handled, reply = episodic.handle_turn_intent(self.db, user_id=who, text=text)
        return (reply or "") if handled else None

    def _session(self, who: str, payload: dict) -> tuple[str, str | None]:
        if is_scheduled_payload(payload):
            sched_id, sched_name, channel_id = _schedule_meta(payload)
            return episodic.get_or_create_scheduled_session(
                self.db,
                user_id=who,
                schedule_id=sched_id,
                schedule_name=sched_name,
                channel_id=channel_id,
            )
        return episodic.get_or_create_active_session(self.db, user_id=who)

    def history(self, who, payload):
        session_id, name = self._session(who, payload)
        return episodic.load_whiteboard(self.db, user_id=who, session_id=session_id, session_name=name, max_messages=self.bounds["max_messages"], max_chars=self.bounds["max_chars"])

    def remember(self, who, payload, user_text, reply, surface, channel_id):
        session_id, _ = self._session(who, payload)
        episodic.remember_turn(self.db, session_id=session_id, user_id=who, user_text=user_text, reply_text=reply, surface=surface, channel_id=channel_id)

    def tools(self):
        def recall(args: dict, who: str) -> str:
            query = str(args.get("query", ""))
            session_name = args.get("session_name")
            rows = episodic.recall_conversation(self.db, who, query, session_name)
            if len(rows) < 5:
                rows += notebook.search_volumes(self.memory_dir, self.db, who, query, session_name=session_name, limit=5 - len(rows))
            return json.dumps(rows)[:8000]

        return [(episodic.RECALL_TOOL_SPEC, recall)]

    def conversations(self, who, op, conversation, limit):
        limit = max(1, min(int(limit or 10), 50))
        if op == "list":
            return {"conversations": [{"id": s["id"], "name": s["name"], "is_active": s["is_active"], "turn_count": s["turn_count"]} for s in episodic.list_sessions(self.db, who, limit)]}
        # Only among this person's conversations.
        row = self.db.execute(
            "SELECT id, name FROM conversation_sessions WHERE user_id = ? AND (id = ? OR LOWER(name) = LOWER(?)) LIMIT 1",
            (who, conversation or "", conversation or ""),
        ).fetchone()
        if not row:
            return {"conversation": None, "turns": []}
        rows = self.db.execute(
            "SELECT role, content, surface, timestamp FROM conversation_turns WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (row[0], limit),
        ).fetchall()
        return {"conversation": {"id": row[0], "name": row[1] or "Unnamed"}, "turns": [{"role": r[0], "content": r[1], "channel": r[2], "at": r[3]} for r in reversed(rows)]}

    def close(self):
        try:
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        except Exception:
            pass
        self.db.close()


class TeamMember(Mind):
    archetype = ARCHETYPE_TEAM_MEMBER

    def __init__(self, memory_dir: Path, bounds: dict):
        self.memory_dir = memory_dir
        self.bounds = bounds
        self._dbs: dict[str, sqlite3.Connection] = {}
        self._project = "default-project"

    def _db(self, project: str) -> sqlite3.Connection:
        # `project_id` and `task_id` are caller-supplied input, not a verified scope (GAP-116): they separate work, they do not protect it.
        if project not in self._dbs:
            db = _connect(workspace.get_workspace_db_path(self.memory_dir, project))
            workspace.init_workspace_tables(db)
            self._dbs[project] = db
        return self._dbs[project]

    def _ids(self, payload: dict) -> tuple[str, str]:
        # The engine keeps different ids apart (a short hash of the original is part of the file name), so they pass as given,
        # bounded in length; sanitising them here would let `a/b` and `a_b` share a notebook.
        project = str(payload.get("project_id") or "default-project").strip()[:200] or "default-project"
        task = str(payload.get("task_id") or "default-task").strip()[:200] or "default-task"
        return project, task

    def history(self, who, payload):
        project, task = self._ids(payload)
        self._project = project  # the recall tool searches the project this turn is in, no other
        db = self._db(project)
        return workspace.load_task_whiteboard(db, project, task, max_messages=self.bounds["max_messages"], max_chars=self.bounds["max_chars"])

    def remember(self, who, payload, user_text, reply, surface, channel_id):
        project, task = self._ids(payload)
        db = self._db(project)
        workspace.create_or_update_task(db, project_id=project, task_id=task, title=user_text[:200])
        workspace.record_task_turn(db, project_id=project, task_id=task, role="user", content=user_text)
        effective_reply = episodic.NO_REPLY_SENTINEL if (user_text and episodic.is_silent_reply(reply)) else reply
        workspace.record_task_turn(db, project_id=project, task_id=task, role="assistant", content=effective_reply)

    def tools(self):
        def recall(args: dict, who: str) -> str:
            project = self._project
            rows = workspace.recall_task_memory(self._db(project), project, str(args.get("query", "")), args.get("task_id"))
            return json.dumps(rows)[:8000]

        return [(workspace.WORKSPACE_RECALL_TOOL_SPEC, recall)]

    def close(self):
        for db in self._dbs.values():
            try:
                db.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            except Exception:
                pass
            db.close()


def bounds_of(memory: dict) -> dict:
    def bound(key: str, default: int, low: int, high: int) -> int:
        v = memory.get(key)
        return max(low, min(int(v), high)) if isinstance(v, int) and not isinstance(v, bool) else default

    return {
        "retention_days": bound("retentionDays", DEFAULT_RETENTION_DAYS, 1, 3650),
        "max_messages": bound("maxMessages", DEFAULT_MAX_MESSAGES, 1, 500),
        "max_chars": bound("maxChars", DEFAULT_MAX_CHARS, 500, 500000),
    }


def open_mind(memory: dict, memory_dir: Path) -> Mind:
    """Open memory by the archetype the factory's configuration names; an unknown one fails closed (nothing is opened)."""
    memory_dir.mkdir(parents=True, exist_ok=True)
    kind = canonical_archetype(str(memory.get("archetype", "")))
    bounds = bounds_of(memory)
    if kind == ARCHETYPE_PERSONAL_ASSISTANT:
        return PersonalAssistant(memory_dir, bounds)
    if kind == ARCHETYPE_TEAM_MEMBER:
        return TeamMember(memory_dir, bounds)
    if kind == ARCHETYPE_PURPOSE_BUILT:
        return PurposeBuilt(bounds)
    raise ValueError(f"unknown memory archetype {memory.get('archetype')!r}")
