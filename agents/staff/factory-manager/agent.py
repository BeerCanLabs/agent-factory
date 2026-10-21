#!/usr/bin/env python3
"""Factory Manager: optional house staff shipped with the Agent Factory (DESIGN_AUTHORITY.md section 6.17)."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

from session import ModelClient, Notebook, encode, turn

HERE = Path(__file__).parent
WARM_SECONDS = int(os.environ.get("MANAGER_WARM_SECONDS", "900"))
MAX_BACKOFF = 30.0


def read_input() -> dict:
    raw = os.environ.get("FACTORY_INPUT")
    if not raw:
        path = Path(os.environ.get("FACTORY_INPUT_FILE", "/tmp/factory-input.json"))
        if path.exists():
            raw = path.read_text("utf-8")
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {"content": raw}
    return value if isinstance(value, dict) else {}


def _call(method: str, path: str, body: dict | None = None, timeout: int = 40) -> dict:
    url = os.environ.get("FACTORY_URL", "").rstrip("/")
    run_id = os.environ.get("FACTORY_RUN_ID", "")
    token = os.environ.get("FACTORY_RUN_TOKEN", "")
    if not (url and run_id and token):
        return {"error": "factory_unconfigured"}
    req = urllib.request.Request(
        f"{url}/api/v1/runs/{run_id}/{path}",
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        method=method,
        headers={"content-type": "application/json", "authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as err:
        return {"error": f"http_{err.code}"}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return {"error": "unreachable"}


def reply(payload: dict, answer: dict) -> None:
    """Answers a console turn (AM2). The factory shows it only to the person who asked and adds the AP3 footnote."""
    reply_to = payload.get("replyTo") or {}
    turn_id = payload.get("turnId")
    if reply_to.get("channel") == "console" and isinstance(turn_id, str):
        content = json.dumps(answer["body"]) if answer.get("type") == "raw" else encode(answer)
        sent = _call("POST", "reply", {"turnId": turn_id, "content": content})
        if sent.get("error"):
            print(f"[factory-manager] reply was not delivered: {sent['error']}", flush=True)


def conversation_request(payload: dict) -> dict:
    """AM5: the console asks every agent for a person's conversations. The manager keeps none a console should list."""
    request = payload.get("request") or {}
    if request.get("op") == "turns":
        return {"type": "raw", "body": {"conversation": None, "turns": []}}
    return {"type": "raw", "body": {"conversations": []}}


def handle(payload: dict, soul: str, memory: Path, model: ModelClient) -> dict:
    if payload.get("kind") == "conversation-request":
        answer = conversation_request(payload)
        reply(payload, answer)
        return {"type": "message", "text": ""}
    caller = payload.get("caller") or {}
    actor = caller.get("actor") if isinstance(caller, dict) else None
    if not isinstance(actor, str) or not actor:
        answer = {"type": "message", "text": "I only talk to people the factory has identified."}
    else:
        answer = turn(payload, soul, Notebook(memory, actor), model)
    reply(payload, answer)
    return answer


def main() -> int:
    memory = Path(os.environ.get("MEMORY_DIR", "/tmp/factory-manager-mind"))
    soul = (HERE / "soul.md").read_text("utf-8")
    model = ModelClient()
    payload = read_input()
    last = handle(payload, soul, memory, model)

    # Stay warm for follow-up turns: the CLI sends tool results and the person's next words here (GAP-176).
    deadline = time.time() + WARM_SECONDS
    backoff = 1.0
    while time.time() < deadline:
        got = _call("GET", "mailbox?timeout=20000", timeout=40)
        if got.get("error"):
            time.sleep(backoff)  # never spin against the control plane (GAP-030)
            backoff = min(backoff * 2, MAX_BACKOFF)
            continue
        backoff = 1.0
        message = got.get("message")
        if not message:
            continue
        nxt = message.get("payload") if isinstance(message, dict) else None
        if not isinstance(nxt, dict):
            continue
        if nxt.get("done"):
            break
        last = handle(nxt, soul, memory, model)
        deadline = time.time() + WARM_SECONDS

    out = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"status": "succeeded", "message": last.get("text", "")}, indent=2), "utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
