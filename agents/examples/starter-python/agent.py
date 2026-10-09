#!/usr/bin/env python3
"""
Operations Assistant — Reference Python Cartridge.
Demonstrates the BeerCanLabs Cartridge Standard:
- Loads canonical memory archetype (Ephemeral, Episodic, Workspace) from cartridge.yaml
- Uses embedded SQLite memory in MEMORY_DIR with WAL and clean Safe checkpointing
- Reads input turn from FACTORY_INPUT or /tmp/factory-input.json
- Emits results to /tmp/factory-result.json
"""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

# Import canonical memory engine
from memory import (
    ARCHETYPE_EPHEMERAL,
    ARCHETYPE_EPISODIC,
    ARCHETYPE_WORKSPACE,
    load_archetype_from_cartridge,
)
from memory import episodic
from memory import ephemeral
from memory import workspace


def get_input_payload() -> dict:
    """Loads input payload from environment variable or bridged file."""
    raw = os.environ.get("FACTORY_INPUT")
    if not raw:
        input_file = Path(os.environ.get("FACTORY_INPUT_FILE", "/tmp/factory-input.json"))
        if input_file.exists():
            raw = input_file.read_text("utf-8")
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"raw_input": raw, "message": raw}
    return {"message": "wake"}


def write_result(result: dict):
    """Writes the agent execution result for the Factory Console to capture."""
    result_file = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    result_file.parent.mkdir(parents=True, exist_ok=True)
    result_file.write_text(json.dumps(result, indent=2), "utf-8")
    print(f"[agent] Result written to {result_file}: {result.get('status')}")


def main() -> int:
    print("[agent] Operations Assistant waking up...")
    memory_dir = Path(os.environ.get("MEMORY_DIR", "/tmp/starter-python-mind"))
    memory_dir.mkdir(parents=True, exist_ok=True)

    # Determine memory archetype from cartridge.yaml (fails closed on invalid/missing config)
    cartridge_path = Path(__file__).resolve().parent / "cartridge.yaml"
    archetype_name, _ = load_archetype_from_cartridge(cartridge_path)
    print(f"[agent] Operating under memory archetype: '{archetype_name}'")

    payload = get_input_payload()
    print(f"[agent] Processing input payload: {payload}")

    author_id = str(payload.get("authorId") or payload.get("author_id") or "operations")
    user_message = str(payload.get("message") or payload.get("raw_input") or "wake")
    status = "succeeded"
    summary = ""

    db = None
    try:
        if archetype_name == ARCHETYPE_EPISODIC:
            db_path = memory_dir / "starter_python_state.db"
            db = sqlite3.connect(str(db_path))
            db.execute("PRAGMA journal_mode = WAL;")
            db.execute("PRAGMA synchronous = NORMAL;")
            db.execute("PRAGMA busy_timeout = 5000;")

            episodic.init_episodic_tables(db)
            pruned = episodic.prune_conversations(db, retention_days=30)
            if pruned:
                print(f"[agent] Pruned {pruned} historical turns older than 30 days.")

            session_id, session_name = episodic.get_or_create_active_session(db, user_id=author_id)

            # Handle fast-path intents if user submitted a session command
            is_handled, intent_reply = episodic.handle_turn_intent(db, user_id=author_id, text=user_message)
            if is_handled:
                summary = intent_reply or ""
            else:
                # Assemble working memory Whiteboard
                turns, banner = episodic.load_whiteboard(
                    db,
                    user_id=author_id,
                    session_id=session_id,
                    session_name=session_name,
                )
                summary = f"Processed alert for {payload.get('service', 'general')}: {payload.get('event', payload.get('ping', 'ok'))}"

                # Record user and assistant turn in episodic memory
                episodic.remember_turn(
                    db,
                    session_id=session_id,
                    user_id=author_id,
                    user_text=user_message,
                    reply_text=summary,
                )

        elif archetype_name == ARCHETYPE_WORKSPACE:
            project_id = str(payload.get("project_id") or "default-project")
            task_id = str(payload.get("task_id") or "default-task")
            db_path = workspace.get_workspace_db_path(memory_dir, project_id)
            db = sqlite3.connect(str(db_path))
            db.execute("PRAGMA journal_mode = WAL;")
            db.execute("PRAGMA synchronous = NORMAL;")
            db.execute("PRAGMA busy_timeout = 5000;")

            workspace.init_workspace_tables(db)
            workspace.create_or_update_task(db, project_id=project_id, task_id=task_id, title=user_message)
            workspace.record_task_turn(db, project_id=project_id, task_id=task_id, role="user", content=user_message)
            summary = f"Workspace task '{task_id}' processed in project '{project_id}'"
            workspace.record_task_turn(db, project_id=project_id, task_id=task_id, role="assistant", content=summary)

        else:
            # Ephemeral archetype: transient in-memory whiteboard only, zero SQLite persistence
            whiteboard = ephemeral.EphemeralWhiteboard()
            whiteboard.add_message(role="user", content=user_message)
            summary = f"Ephemeral query processed: {user_message}"
            whiteboard.add_message(role="assistant", content=summary)

    finally:
        if db is not None:
            try:
                # Safe Sync Checkpoint: collapse WAL before shutdown
                db.execute("PRAGMA wal_checkpoint(TRUNCATE);")
            except Exception:
                pass
            db.close()

    result = {
        "status": status,
        "output": {
            "summary": summary,
            "archetype": archetype_name,
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "echo": payload,
        },
    }

    write_result(result)
    print("[agent] Task completed successfully. Shutting down to scale-to-zero.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
