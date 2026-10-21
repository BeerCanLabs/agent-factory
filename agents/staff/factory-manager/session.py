"""Conversation logic for the Factory Manager.

The manager holds no factory power. Each turn the factory CLI sends the tools the signed-in person may use; the
manager asks for them, the CLI runs them as that person and sends back the results (DESIGN_AUTHORITY.md section 6.17,
CL2 to CL4). The model is reached only through the factory model API (E5); there is no provider key here.
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.request
from pathlib import Path

CONNECT = "connect_to_agent"
MAX_MESSAGES = 40
MAX_RESULT_CHARS = 12_000
MAX_HISTORY_CHARS = 60_000

RULES = """\
Rules for this conversation:
- Call a tool for every figure or state you report. Never quote a number you did not get from a tool result this turn.
- Only call tools that are offered. If the person asks for something no tool covers, say the console is the place for it.
- A change is made only when its tool result says ok. If the person declined it or the factory refused it, say so.
- Never ask for, show or repeat a secret.
"""


def system_prompt(soul: str) -> str:
    return f"{soul.strip()}\n\n{RULES}"


def actor_key(actor: str) -> str:
    return hashlib.sha256(actor.encode("utf-8")).hexdigest()[:24]


class Notebook:
    """One person's conversation with the manager, in $MEMORY_DIR (the employee's notebook, not the factory's)."""

    def __init__(self, memory_dir: Path, actor: str):
        self.path = memory_dir / "manager" / f"{actor_key(actor)}.json"

    def load(self) -> list[dict]:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text("utf-8")).get("messages", [])
            except (json.JSONDecodeError, OSError):
                return []
        return []

    def save(self, messages: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"messages": trim(messages)}), "utf-8")


def _size(messages: list[dict]) -> int:
    return sum(len(json.dumps(m, ensure_ascii=False)) for m in messages)


def trim(messages: list[dict]) -> list[dict]:
    """Keeps the newest messages, starting at a person's message so a tool result never loses its request.

    Bounded by count and by size: old tool results are the bulk of a long conversation, and each turn pays to resend them.
    """
    out = messages
    while len(out) > 1 and (len(out) > MAX_MESSAGES or _size(out) > MAX_HISTORY_CHARS):
        cut = 1
        while cut < len(out) and out[cut].get("role") != "user":
            cut += 1
        if cut >= len(out):
            break  # one turn is all that is left; keep it whole
        out = out[cut:]
    return out


def pending_call_ids(messages: list[dict]) -> list[str]:
    """Tool calls the manager made that have no result yet."""
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get("role") == "assistant" and m.get("tool_calls"):
            answered = {x.get("tool_call_id") for x in messages[i + 1 :] if x.get("role") == "tool"}
            return [c["id"] for c in m["tool_calls"] if c["id"] not in answered]
        if m.get("role") == "user":
            return []
    return []


def _clip(value: object) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= MAX_RESULT_CHARS else text[:MAX_RESULT_CHARS] + "...[truncated]"


def add_turn(messages: list[dict], payload: dict) -> None:
    """Appends what the CLI sent: tool results answer the manager's open calls; words start a new person turn."""
    pending = pending_call_ids(messages)
    results = payload.get("toolResults")
    if isinstance(results, list):
        for r in results:
            if not isinstance(r, dict) or r.get("id") not in pending:
                continue
            pending.remove(r["id"])
            body = {"ok": bool(r.get("ok"))}
            for k in ("result", "error", "declined"):
                if k in r:
                    body[k] = r[k]
            messages.append({"role": "tool", "tool_call_id": r["id"], "content": _clip(body)})
    content = payload.get("content")
    if isinstance(content, str) and content.strip():
        # A call the CLI never answered (it was closed mid-turn) must be closed before the person speaks again.
        for call_id in pending:
            messages.append({"role": "tool", "tool_call_id": call_id, "content": _clip({"ok": False, "error": "no result"})})
        messages.append({"role": "user", "content": content.strip()[:4000]})


def tool_definitions(tools: object) -> list[dict]:
    out = []
    if isinstance(tools, list):
        for t in tools:
            if isinstance(t, dict) and isinstance(t.get("name"), str):
                out.append(
                    {
                        "type": "function",
                        "function": {
                            "name": t["name"],
                            "description": str(t.get("description", ""))[:600],
                            "parameters": t.get("parameters") or {"type": "object", "properties": {}},
                        },
                    }
                )
    return out


class ModelClient:
    """The factory model API (OpenAI Chat Completions). The run token is the only credential (E5, S1)."""

    def __init__(self, base_url: str | None = None, token: str | None = None, model: str | None = None):
        self.base_url = (base_url if base_url is not None else os.environ.get("FACTORY_MODEL_BASE_URL", "")).rstrip("/")
        self.token = token if token is not None else os.environ.get("FACTORY_RUN_TOKEN", "")
        self.model = model if model is not None else os.environ.get("FACTORY_MODEL", "")

    def complete(self, messages: list[dict], tools: list[dict]) -> dict:
        if not self.base_url or not self.token:
            return {"error": "factory_unconfigured"}
        body: dict = {"max_tokens": 1024, "messages": messages}
        if self.model:
            body["model"] = self.model
        if tools:
            body["tools"] = tools
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            try:
                parsed = json.loads(err.read().decode("utf-8") or "{}")
            except json.JSONDecodeError:
                parsed = {}
            return {"error": parsed.get("error") or f"http_{err.code}", "status": err.code}
        except (urllib.error.URLError, TimeoutError):
            return {"error": "model_unreachable"}


def model_refusal(result: dict) -> str:
    error = result.get("error")
    if error == "factory_unconfigured":
        return "I have no model to think with on this run, so I cannot help right now."
    if error == "budget_exceeded":
        return "My own budget is spent for this period, so I cannot help until an admin raises it."
    if error in ("route_not_allowed", "model_not_allowed", "model_pinned"):
        return "I am not allowed to use a model yet. An admin has to grant the models route in my policy."
    return f"I could not reach my model just now ({error}). Try again in a moment."


def reply_from_model(result: dict, messages: list[dict]) -> dict:
    """Turns the model's answer into a protocol reply and records it in the conversation."""
    if "error" in result:
        return {"type": "message", "text": model_refusal(result)}
    try:
        message = result["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return {"type": "message", "text": "I got an answer I could not read. Try again."}
    text = (message.get("content") or "").strip()
    raw_calls = message.get("tool_calls") or []
    if not raw_calls:
        messages.append({"role": "assistant", "content": text or "(no answer)"})
        return {"type": "message", "text": text or "I have nothing to add."}

    calls = []
    for c in raw_calls:
        fn = c.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            args = {}
        calls.append({"id": str(c.get("id")), "name": str(fn.get("name")), "arguments": args if isinstance(args, dict) else {}})
    messages.append(
        {
            "role": "assistant",
            "content": text or None,
            "tool_calls": [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["arguments"])}} for c in calls],
        }
    )
    connect = next((c for c in calls if c["name"] == CONNECT and isinstance(c["arguments"].get("agent"), str) and c["arguments"]["agent"]), None)
    if connect:
        # The CLI moves the person to the agent; close every call so the conversation stays valid for later.
        for c in calls:
            messages.append({"role": "tool", "tool_call_id": c["id"], "content": _clip({"ok": c is connect, "result": "The person is now talking to the agent directly."})})
        return {"type": "connect", "agent": connect["arguments"]["agent"], **({"text": text} if text else {})}
    return {"type": "tool_calls", "calls": calls, **({"text": text} if text else {})}


def encode(answer: dict) -> str:
    """What goes in the reply's `content` (AM2, CL7).

    A plain answer goes as plain text, so the factory can footnote one given without tools (AP3): it never alters a
    machine-read JSON result. Tool requests and connect requests are protocol and go as JSON. An answer that would itself
    read as protocol is wrapped, so a model cannot make the CLI act by writing JSON in its words.
    """
    if answer.get("type") == "message":
        text = str(answer.get("text", ""))
        if text.lstrip()[:1] in ("{", "["):
            return json.dumps(answer, ensure_ascii=False)
        return text
    return json.dumps(answer, ensure_ascii=False)


def turn(payload: dict, soul: str, notebook: Notebook, model: ModelClient) -> dict:
    """One turn: the person's words or tool results in, one protocol reply out."""
    messages = notebook.load()
    add_turn(messages, payload)
    if not messages or messages[-1].get("role") not in ("user", "tool"):
        return {"type": "message", "text": "I am the Factory Manager. Ask me about costs, agents, budgets or approvals, or tell me which agent to connect you to."}
    result = model.complete([{"role": "system", "content": system_prompt(soul)}] + messages, tool_definitions(payload.get("tools")))
    reply = reply_from_model(result, messages)
    notebook.save(messages)
    return reply
