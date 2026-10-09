"""
Type 2: Episodic Memory Engine for Personal / Principal Agents.
BeerCanLabs Agent Factory — Cartridge Memory Standard.

Provides:
- User-partitioned conversation sessions (continuous across wakes and sleeps)
- Pre-LLM fast-path intent handling (/new, /name, /resume, /sessions, /export)
- Working memory (Whiteboard) sliding-window budgeting
- Context awareness banners when older turns exist
- On-demand episodic recall via SQLite FTS5 (Full-Text Search) with LIKE fallback
- Rolling retention pruning on wake
"""

import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

# Default configuration limits
DEFAULT_MAX_MESSAGES = 20
DEFAULT_MAX_CHARS = 24000
DEFAULT_RETENTION_DAYS = 30

# Fast-path regex patterns
NEW_SESSION_RE = re.compile(
    r"^\s*(?:please\s+)?(?:/new|(?:start|begin|open)\s+(?:a\s+)?new\s+session|new\s+session|"
    r"reset\s+(?:the\s+|our\s+|this\s+)?(?:session|conversation)|start\s+fresh|"
    r"forget\s+(?:this|our)\s+(?:session|conversation))"
    r"(?:\s+(?:named\s+)?[\"']?([^\"'\n]+)[\"']?)?\s*[.!]?\s*$",
    re.IGNORECASE,
)

NAME_SESSION_RE = re.compile(
    r"^\s*(?:/name|name\s+(?:this\s+)?(?:conversation|session)|call\s+(?:this\s+)?(?:conversation|session))\s+[\"']?([^\"'\n]+)[\"']?\s*[.!]?\s*$",
    re.IGNORECASE,
)

RESUME_SESSION_RE = re.compile(
    r"^\s*(?:/resume|resume|switch\s+to\s+(?:conversation|session)?|go\s+back\s+to)\s+[\"']?([^\"'\n]+)[\"']?\s*[.!]?\s*$",
    re.IGNORECASE,
)

LIST_SESSIONS_RE = re.compile(
    r"^\s*(?:/sessions|/conversations|list\s+(?:my\s+)?(?:sessions|conversations)|show\s+(?:my\s+)?(?:sessions|conversations))\s*[.!]?\s*$",
    re.IGNORECASE,
)

EXPORT_RE = re.compile(
    r"^\s*(?:/export|export\s+(?:my\s+)?(?:conversations|conversation|session|chat))\s*[.!]?\s*$",
    re.IGNORECASE,
)

RECALL_TOOL_SPEC = {
    "type": "function",
    "function": {
        "name": "recall_conversation",
        "description": (
            "Search earlier messages in this conversation or past named conversations "
            "when the user refers to past discussions, outlines, decisions, or ideas not shown in the current context."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Keywords or search phrase to find relevant historical turns in memory.",
                },
                "session_name": {
                    "type": "string",
                    "description": "Optional: search a specific session by name. If omitted, searches all sessions for this user.",
                },
            },
            "required": ["query"],
        },
    },
}


def init_episodic_tables(conn: sqlite3.Connection):
    """Create conversation sessions, turns, and FTS5 tables with WAL pragma."""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS conversation_sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT,
            channel_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_active INTEGER DEFAULT 1
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON conversation_sessions (user_id, is_active, updated_at);")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS conversation_turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            surface TEXT NOT NULL DEFAULT 'discord',
            channel_id TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES conversation_sessions(id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_turns_session_id ON conversation_turns (session_id, id);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_turns_user_time ON conversation_turns (user_id, timestamp);")

    # FTS5 full-text search table
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_fts USING fts5(
            content,
            turn_id UNINDEXED,
            session_id UNINDEXED,
            user_id UNINDEXED
        )
    """)
    conn.commit()


def get_or_create_active_session(conn: sqlite3.Connection, user_id: str, channel_id: str | None = None) -> tuple[str, str | None]:
    """Retrieve the currently active session for this user, or create one if none exists."""
    row = conn.execute(
        "SELECT id, name FROM conversation_sessions WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1",
        (user_id,),
    ).fetchone()
    if row:
        return row[0], row[1]

    # Create fresh session
    session_id = f"s_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO conversation_sessions (id, user_id, name, channel_id, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)",
        (session_id, user_id, None, channel_id, now, now),
    )
    conn.commit()
    return session_id, None


def start_new_session(conn: sqlite3.Connection, user_id: str, name: str | None = None, channel_id: str | None = None) -> tuple[str, str]:
    """Deactivate existing sessions for this user and activate a fresh session."""
    conn.execute("UPDATE conversation_sessions SET is_active = 0 WHERE user_id = ?", (user_id,))
    session_id = f"s_{uuid.uuid4().hex[:12]}"
    now = datetime.now(timezone.utc).isoformat()
    clean_name = name.strip() if name else None
    conn.execute(
        "INSERT INTO conversation_sessions (id, user_id, name, channel_id, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)",
        (session_id, user_id, clean_name, channel_id, now, now),
    )
    conn.commit()
    return session_id, clean_name or "new session"


def rename_active_session(conn: sqlite3.Connection, user_id: str, new_name: str) -> bool:
    """Give the current active session a human-readable name."""
    clean_name = new_name.strip()
    session_id, _ = get_or_create_active_session(conn, user_id)
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute(
        "UPDATE conversation_sessions SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?",
        (clean_name, now, session_id, user_id),
    )
    conn.commit()
    return cur.rowcount > 0


def resume_session(conn: sqlite3.Connection, user_id: str, name_or_id: str) -> tuple[bool, str | None, int]:
    """Resume an existing session by name or ID. Sets it as active. Returns (found, name, turn_count)."""
    target = name_or_id.strip()
    # Try exact match on name or ID, case-insensitive
    row = conn.execute(
        "SELECT id, name FROM conversation_sessions WHERE user_id = ? AND (LOWER(name) = LOWER(?) OR id = ?) ORDER BY updated_at DESC LIMIT 1",
        (user_id, target, target),
    ).fetchone()

    # Try partial name match if not found
    if not row:
        row = conn.execute(
            "SELECT id, name FROM conversation_sessions WHERE user_id = ? AND LOWER(name) LIKE LOWER(?) ORDER BY updated_at DESC LIMIT 1",
            (user_id, f"%{target}%"),
        ).fetchone()

    if not row:
        return False, None, 0

    session_id, session_name = row[0], row[1]
    now = datetime.now(timezone.utc).isoformat()
    conn.execute("UPDATE conversation_sessions SET is_active = 0 WHERE user_id = ?", (user_id,))
    conn.execute("UPDATE conversation_sessions SET is_active = 1, updated_at = ? WHERE id = ?", (now, session_id))
    conn.commit()

    turn_count = conn.execute(
        "SELECT COUNT(*) FROM conversation_turns WHERE session_id = ?", (session_id,)
    ).fetchone()[0]

    return True, session_name or session_id, turn_count


def list_sessions(conn: sqlite3.Connection, user_id: str, limit: int = 10) -> list[dict]:
    """List recent sessions for this user with turn counts and active status."""
    rows = conn.execute(
        """
        SELECT s.id, s.name, s.is_active, s.updated_at, COUNT(t.id) as turn_count
        FROM conversation_sessions s
        LEFT JOIN conversation_turns t ON s.id = t.session_id
        WHERE s.user_id = ?
        GROUP BY s.id
        ORDER BY s.is_active DESC, s.updated_at DESC
        LIMIT ?
        """,
        (user_id, limit),
    ).fetchall()
    return [
        {
            "id": r[0],
            "name": r[1] or "Unnamed",
            "is_active": bool(r[2]),
            "updated_at": r[3],
            "turn_count": r[4],
        }
        for r in rows
    ]


def export_conversations(conn: sqlite3.Connection, user_id: str, agent_name: str = "Agent", user_name: str = "User") -> str:
    """Generate Markdown transcript of all sessions for this user."""
    sessions = list_sessions(conn, user_id, limit=50)
    if not sessions:
        return "No conversation history found to export."

    lines = [f"# Conversation Export for User: {user_id}\n*Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}*\n"]
    for s in sessions:
        status = " (Active)" if s["is_active"] else ""
        lines.append(f"## Session: {s['name']}{status} [ID: `{s['id']}`]")
        lines.append(f"*Last updated: {s['updated_at']} | {s['turn_count']} turns*\n")

        turns = conn.execute(
            "SELECT role, content, timestamp, surface FROM conversation_turns WHERE session_id = ? ORDER BY id ASC",
            (s["id"],),
        ).fetchall()
        for role, content, ts, surface in turns:
            author = user_name if role == "user" else agent_name
            lines.append(f"**{author}** ({surface} at {ts}):\n{content}\n")
        lines.append("---\n")

    return "\n".join(lines).strip()


def handle_turn_intent(conn: sqlite3.Connection, user_id: str, text: str, channel_id: str | None = None) -> tuple[bool, str | None]:
    """Pre-LLM fast path: check for session administration commands.

    Returns (is_handled, reply_message). If handled, reply immediately with 0 token cost.
    """
    if not text:
        return False, None

    # 1. New Session
    m_new = NEW_SESSION_RE.match(text)
    if m_new:
        named = m_new.group(1)
        _, session_name = start_new_session(conn, user_id, name=named, channel_id=channel_id)
        name_str = f" named '{session_name}'" if named else ""
        return True, f"Started a new session{name_str}. I won't carry anything from before."

    # 2. Name Active Session
    m_name = NAME_SESSION_RE.match(text)
    if m_name:
        new_name = m_name.group(1)
        if rename_active_session(conn, user_id, new_name):
            return True, f"Named this conversation '{new_name}'."
        return True, "Could not name the session; no active session found."

    # 3. Resume Session
    m_resume = RESUME_SESSION_RE.match(text)
    if m_resume:
        target = m_resume.group(1)
        found, session_name, count = resume_session(conn, user_id, target)
        if found:
            return True, f"Resumed conversation '{session_name}' ({count} messages in history)."
        return True, f"Could not find a conversation matching '{target}'. Say 'list conversations' to see your sessions."

    # 4. List Sessions
    if LIST_SESSIONS_RE.match(text):
        sessions = list_sessions(conn, user_id, limit=10)
        if not sessions:
            return True, "No stored conversations found."
        formatted = ["Your conversations:"]
        for s in sessions:
            active_tag = " *(active)*" if s["is_active"] else ""
            formatted.append(f"• **{s['name']}**{active_tag} — {s['turn_count']} turns (ID: `{s['id']}`)")
        formatted.append("\nSay `resume <name>` to jump into any of these, or `start fresh` to begin anew.")
        return True, "\n".join(formatted)

    # 5. Export History
    if EXPORT_RE.match(text):
        export_text = export_conversations(conn, user_id)
        return True, f"Here is your conversation export:\n\n```markdown\n{export_text[:1800]}\n```\n*(Full transcript preserved in your local mind db)*"

    return False, None


def load_whiteboard(
    conn: sqlite3.Connection,
    user_id: str,
    session_id: str,
    session_name: str | None = None,
    max_messages: int = DEFAULT_MAX_MESSAGES,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> tuple[list[dict], str | None]:
    """Assemble the active working memory (Whiteboard) for the LLM.

    Returns (history_messages, optional_awareness_banner).
    """
    total_turns = conn.execute(
        "SELECT COUNT(*) FROM conversation_turns WHERE session_id = ?", (session_id,)
    ).fetchone()[0]

    rows = conn.execute(
        "SELECT role, content FROM conversation_turns WHERE session_id = ? ORDER BY id DESC LIMIT ?",
        (session_id, max_messages),
    ).fetchall()

    kept: list[dict] = []
    size = 0
    for role, content in rows:  # newest first
        size += len(content)
        if kept and size > max_chars:
            break
        kept.append({"role": role, "content": content})

    history = list(reversed(kept))

    # Add awareness banner if older turns exist
    banner = None
    shown_count = len(history)
    if total_turns > shown_count:
        name_display = f"'{session_name}'" if session_name else "active session"
        banner = (
            f"[Session Context: {name_display} | Total turns: {total_turns} | Showing recent: {shown_count} turns]\n"
            f"[System Note: Earlier turns from this conversation exist in your notebook. If the user refers to past decisions, "
            f"drafts, outlines, or ideas not shown above, you can recall them using the `recall_conversation` tool.]"
        )

    return history, banner


def remember_turn(
    conn: sqlite3.Connection,
    session_id: str,
    user_id: str,
    user_text: str,
    reply_text: str,
    surface: str = "discord",
    channel_id: str | None = None,
):
    """Record a complete user + assistant conversational turn in SQLite and FTS5."""
    now = datetime.now(timezone.utc).isoformat()
    for role, content in (("user", user_text), ("assistant", reply_text)):
        if not content:
            continue
        cur = conn.execute(
            """
            INSERT INTO conversation_turns (session_id, user_id, surface, channel_id, role, content, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (session_id, user_id, surface, channel_id, role, content, now),
        )
        turn_id = cur.lastrowid
        # Update FTS5 virtual table
        conn.execute(
            "INSERT INTO conversation_fts (content, turn_id, session_id, user_id) VALUES (?, ?, ?, ?)",
            (content, str(turn_id), session_id, user_id),
        )

    # Touch session updated_at
    conn.execute("UPDATE conversation_sessions SET updated_at = ? WHERE id = ?", (now, session_id))
    conn.commit()


def recall_conversation(
    conn: sqlite3.Connection,
    user_id: str,
    query: str,
    session_name: str | None = None,
    limit: int = 5,
) -> list[dict]:
    """Search episodic memory using SQLite FTS5 (BM25) with LIKE fallback."""
    clean_query = query.strip()
    if not clean_query:
        return []

    target_session_id = None
    if session_name:
        row = conn.execute(
            "SELECT id FROM conversation_sessions WHERE user_id = ? AND (LOWER(name) = LOWER(?) OR id = ?) LIMIT 1",
            (user_id, session_name.strip(), session_name.strip()),
        ).fetchone()
        if row:
            target_session_id = row[0]

    results = []
    # 1. Try FTS5 MATCH
    try:
        # Sanitize query for FTS5 (quote bare terms)
        terms = [f'"{w}"' for w in re.findall(r"\w+", clean_query) if w]
        fts_query = " OR ".join(terms) if terms else clean_query
        if target_session_id:
            rows = conn.execute(
                """
                SELECT turn_id, session_id, content
                FROM conversation_fts
                WHERE user_id = ? AND session_id = ? AND conversation_fts MATCH ?
                LIMIT ?
                """,
                (user_id, target_session_id, fts_query, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT turn_id, session_id, content
                FROM conversation_fts
                WHERE user_id = ? AND conversation_fts MATCH ?
                LIMIT ?
                """,
                (user_id, fts_query, limit),
            ).fetchall()

        for t_id, s_id, content in rows:
            # Fetch turn metadata
            meta = conn.execute(
                "SELECT role, timestamp, surface FROM conversation_turns WHERE id = ?",
                (int(t_id),),
            ).fetchone()
            results.append({
                "turn_id": int(t_id),
                "session_id": s_id,
                "role": meta[0] if meta else "unknown",
                "timestamp": meta[1] if meta else "",
                "surface": meta[2] if meta else "",
                "content": content,
            })
    except Exception as e:
        print(f"[episodic] FTS5 search error ('{e}'), falling back to LIKE", flush=True)

    # 2. Fallback to LIKE if FTS5 returned nothing or errored
    if not results:
        like_query = f"%{clean_query}%"
        if target_session_id:
            rows = conn.execute(
                """
                SELECT id, session_id, role, content, timestamp, surface
                FROM conversation_turns
                WHERE user_id = ? AND session_id = ? AND content LIKE ?
                ORDER BY id DESC LIMIT ?
                """,
                (user_id, target_session_id, like_query, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, session_id, role, content, timestamp, surface
                FROM conversation_turns
                WHERE user_id = ? AND content LIKE ?
                ORDER BY id DESC LIMIT ?
                """,
                (user_id, like_query, limit),
            ).fetchall()

        for r in rows:
            results.append({
                "turn_id": r[0],
                "session_id": r[1],
                "role": r[2],
                "content": r[3],
                "timestamp": r[4],
                "surface": r[5],
            })

    return results


def prune_conversations(conn: sqlite3.Connection, retention_days: int = DEFAULT_RETENTION_DAYS) -> int:
    """Drop conversation turns older than retention_days (rolling retention, run on wake)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).isoformat()
    old_turn_ids = [r[0] for r in conn.execute("SELECT id FROM conversation_turns WHERE timestamp < ?", (cutoff,)).fetchall()]
    if not old_turn_ids:
        return 0

    cur = conn.execute("DELETE FROM conversation_turns WHERE timestamp < ?", (cutoff,))
    # Remove from FTS table as well
    for t_id in old_turn_ids:
        conn.execute("DELETE FROM conversation_fts WHERE turn_id = ?", (str(t_id),))

    conn.commit()
    return cur.rowcount
