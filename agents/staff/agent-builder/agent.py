#!/usr/bin/env python3
"""Agent Builder — headless house staff agent shipped with the Agent Factory."""

import json
import os
from pathlib import Path

from session import BuilderClient, load_state, save_state, turn


def read_input() -> dict:
    raw = os.environ.get("FACTORY_INPUT")
    if not raw:
        path = Path(os.environ.get("FACTORY_INPUT_FILE", "/tmp/factory-input.json"))
        if path.exists():
            raw = path.read_text("utf-8")
    if not raw:
        return {"message": "wake"}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"message": raw}


def main() -> int:
    memory = Path(os.environ.get("MEMORY_DIR", "/tmp/agent-builder-mind"))
    state_path = memory / "builder-session.json"
    state = load_state(state_path)
    payload = read_input()
    message = payload.get("message") if "message" in payload else payload.get("raw_input")
    arg = payload if message is None else message
    reply = turn(state, arg, BuilderClient())
    save_state(state_path, state)
    result = {
        "status": "succeeded",
        "message": reply,
        "draft": state.get("draft"),
        "published": state.get("published"),
    }
    out = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), "utf-8")
    print(reply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
