#!/usr/bin/env python3
"""
Operations Assistant — Reference Python Cartridge.
Demonstrates the 'New Hire' pattern:
- Reads input turn from FACTORY_INPUT or /tmp/factory-input.json
- Accesses secrets from environment (e.g. ALERT_WEBHOOK_SECRET)
- Uses persistent memory in MEMORY_DIR via local SQLite
- Interacts with LLM via standard SDK (metered by Factory Egress Gateway)
- Emits results to /tmp/factory-result.json
"""

import os
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

def init_memory(memory_dir: Path) -> sqlite3.Connection:
    """Initializes local SQLite memory database hydrated by the Factory Console."""
    memory_dir.mkdir(parents=True, exist_ok=True)
    db_path = memory_dir / "operations_state.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL
        )
    """)
    conn.commit()
    return conn

def log_event(conn: sqlite3.Connection, event_type: str, payload: dict):
    """Appends an event to the agent's persistent memory."""
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO audit_log (timestamp, event_type, payload) VALUES (?, ?, ?)",
        (now, event_type, json.dumps(payload))
    )
    conn.commit()

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
            return {"raw_input": raw}
    return {"message": "wake"}

def write_result(result: dict):
    """Writes the agent execution result for the Factory Console to capture."""
    result_file = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    result_file.parent.mkdir(parents=True, exist_ok=True)
    result_file.write_text(json.dumps(result, indent=2), "utf-8")
    print(f"[agent] Result written to {result_file}: {result.get('status')}")

def main():
    print("[agent] Operations Assistant waking up...")
    memory_dir = Path(os.environ.get("MEMORY_DIR", "/tmp/starter-python-mind"))
    db = init_memory(memory_dir)

    payload = get_input_payload()
    print(f"[agent] Processing input payload: {payload}")

    # Record event in local persistent memory
    log_event(db, "wake_event", payload)

    # Perform task logic / reasoning
    # In production, call anthropic.Anthropic() or openai.OpenAI() here.
    # The Factory shim automatically injects ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY.
    summary = f"Processed alert for {payload.get('service', 'general')}: {payload.get('event', payload.get('ping', 'ok'))}"
    
    result = {
        "status": "succeeded",
        "output": {
            "summary": summary,
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "echo": payload
        }
    }

    write_result(result)
    print("[agent] Task completed successfully. Shutting down to scale-to-zero.")

if __name__ == "__main__":
    main()
