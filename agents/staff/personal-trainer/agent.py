#!/usr/bin/env python3
"""Personal Trainer — optional house staff shipped with the Agent Factory."""

import json
import os
from pathlib import Path

from session import load_state, save_state, turn


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
    memory = Path(os.environ.get("MEMORY_DIR", "/tmp/personal-trainer-mind"))
    state_path = memory / "trainer-session.json"
    state = load_state(state_path)
    payload = read_input()
    message = str(payload.get("message") or payload.get("raw_input") or "wake")
    reply = turn(state, message)
    save_state(state_path, state)
    result = {"status": "succeeded", "message": reply, "skillId": state.get("skillId")}
    out = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), "utf-8")
    print(reply)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
