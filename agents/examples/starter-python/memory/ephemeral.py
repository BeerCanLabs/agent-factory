"""
Type 1: Ephemeral Memory Archetype — In-Memory Sliding Window Whiteboard.
BeerCanLabs Agent Factory — Cartridge Memory Standard.

Characteristics:
- Pure in-memory sliding window Whiteboard (working memory).
- Zero SQLite persistence (no SQLite connections, no tables, no local .db files).
- Zero Safe / remote object store (S3/GCS) synchronization.
- Ideal for stateless single-turn workers, cron dispatchers, ephemeral sub-agents,
  or privacy-critical micro-agents where conversation history must never persist past
  the warm window or process lifetime.
"""

from datetime import datetime, timezone
from typing import Any

DEFAULT_MAX_MESSAGES = 20
DEFAULT_MAX_CHARS = 24000


class EphemeralWhiteboard:
    """In-memory sliding window Whiteboard for ephemeral agents."""

    def __init__(
        self,
        max_messages: int = DEFAULT_MAX_MESSAGES,
        max_chars: int = DEFAULT_MAX_CHARS,
    ):
        self.max_messages = max_messages
        self.max_chars = max_chars
        self._turns: list[dict[str, Any]] = []

    def remember_turn(
        self,
        user_text: str,
        reply_text: str,
        user_role: str = "user",
        assistant_role: str = "assistant",
    ) -> None:
        """Record a single conversational turn in the in-memory log."""
        now = datetime.now(timezone.utc).isoformat()
        if user_text:
            self._turns.append({
                "role": user_role,
                "content": user_text,
                "timestamp": now,
            })
        if reply_text:
            self._turns.append({
                "role": assistant_role,
                "content": reply_text,
                "timestamp": now,
            })

    def add_message(self, role: str, content: str, timestamp: str | None = None) -> None:
        """Append an individual message to working memory."""
        if not content:
            return
        now = timestamp or datetime.now(timezone.utc).isoformat()
        self._turns.append({
            "role": role,
            "content": content,
            "timestamp": now,
        })

    def load_whiteboard(
        self,
        max_messages: int | None = None,
        max_chars: int | None = None,
    ) -> tuple[list[dict[str, str]], str | None]:
        """Assemble the active working memory (Whiteboard) for the LLM.

        Applies sliding-window budgeting by message count and character count.
        Returns (history_messages, optional_awareness_banner).
        """
        limit_messages = max_messages if max_messages is not None else self.max_messages
        limit_chars = max_chars if max_chars is not None else self.max_chars

        total_messages = len(self._turns)
        recent_slice = self._turns[-limit_messages:] if limit_messages > 0 else []

        kept: list[dict[str, str]] = []
        size = 0
        for item in reversed(recent_slice):
            msg = {"role": item["role"], "content": item["content"]}
            msg_len = len(item["content"])
            if kept and (size + msg_len) > limit_chars:
                break
            kept.append(msg)
            size += msg_len

        history = list(reversed(kept))
        shown_count = len(history)

        banner = None
        if total_messages > shown_count:
            banner = (
                f"[Ephemeral Context: in-memory session | Total turns: {total_messages} | "
                f"Showing recent: {shown_count} turns]\n"
                f"[System Note: Earlier turns from this ephemeral session have scrolled past the active "
                f"sliding window and are not stored in any persistent database.]"
            )

        return history, banner

    def clear(self) -> None:
        """Clear all in-memory turns."""
        self._turns.clear()

    @property
    def total_messages(self) -> int:
        return len(self._turns)

    def export_transcript(self, user_name: str = "User", agent_name: str = "Agent") -> str:
        """Export an in-memory Markdown transcript of the current session."""
        if not self._turns:
            return "No ephemeral conversation turns recorded."

        lines = [
            f"# Ephemeral Conversation Transcript\n"
            f"*Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}*\n"
        ]
        for t in self._turns:
            author = user_name if t["role"] == "user" else agent_name
            lines.append(f"**{author}** ({t.get('timestamp', '')}):\n{t['content']}\n")
        return "\n".join(lines).strip()


# Global in-memory session registry for multi-session ephemeral operations
_SESSIONS: dict[str, EphemeralWhiteboard] = {}


def get_or_create_session(
    session_id: str = "default",
    max_messages: int = DEFAULT_MAX_MESSAGES,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> EphemeralWhiteboard:
    """Retrieve or create an in-memory EphemeralWhiteboard session."""
    if session_id not in _SESSIONS:
        _SESSIONS[session_id] = EphemeralWhiteboard(
            max_messages=max_messages,
            max_chars=max_chars,
        )
    return _SESSIONS[session_id]


def remember_turn(
    session_id: str,
    user_text: str,
    reply_text: str,
    user_role: str = "user",
    assistant_role: str = "assistant",
) -> None:
    """Convenience module-level function to record a turn in an ephemeral session."""
    session = get_or_create_session(session_id)
    session.remember_turn(user_text, reply_text, user_role=user_role, assistant_role=assistant_role)


def load_whiteboard(
    session_id: str = "default",
    max_messages: int | None = None,
    max_chars: int | None = None,
) -> tuple[list[dict[str, str]], str | None]:
    """Convenience module-level function to load whiteboard messages from an ephemeral session."""
    session = get_or_create_session(session_id)
    return session.load_whiteboard(max_messages=max_messages, max_chars=max_chars)


def clear_session(session_id: str) -> None:
    """Clear turns for a specific ephemeral session."""
    if session_id in _SESSIONS:
        _SESSIONS[session_id].clear()


def clear_all_sessions() -> None:
    """Clear all in-memory ephemeral sessions."""
    _SESSIONS.clear()


def list_active_sessions() -> list[str]:
    """List session IDs currently held in memory."""
    return list(_SESSIONS.keys())
