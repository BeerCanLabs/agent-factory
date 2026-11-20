"""Tools so a config-only agent (Rosie) can start errands or live calls.

`ask_agent` runs the errand server-side: it calls the target agent's conversation
API as this agent, with speaker = the enrolled person and mode = errand, and
returns the result to speak back.

`call_agent` does not open the call. It returns a structured intent
`{action: "call", agent, speaker}` (also tagged as FACTORY_CALL_INTENT:...) so
the robot can open POST /mcp/agents/<id> itself and hold the multi-turn conversation.

Speaker identification happens on the robot. The speaker on these tools should be
the factory-stamped caller.actor from this turn (or the same asserted id/alias).
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


def _context_value(context: dict, *keys: str) -> str | None:
    for k in keys:
        v = context.get(k) if isinstance(context, dict) else None
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _factory_url(context: dict) -> str:
    url = (
        _context_value(context, "factory_url", "factoryUrl")
        or os.environ.get("FACTORY_URL")
        or os.environ.get("FACTORY_PUBLIC_URL")
        or ""
    )
    return url.rstrip("/")


def _agent_key(context: dict) -> str:
    secrets = context.get("secrets") if isinstance(context, dict) else None
    if isinstance(secrets, dict):
        for k in ("FACTORY_AGENT_KEY", "ROSIE_AGENT_KEY", "agent_key"):
            v = secrets.get(k)
            if isinstance(v, str) and v.strip():
                return v.strip()
    for k in ("FACTORY_AGENT_KEY", "ROSIE_AGENT_KEY"):
        v = os.environ.get(k)
        if v and v.strip():
            return v.strip()
    return ""


def _speaker_from_context(context: dict, explicit: str | None) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    caller = context.get("caller") if isinstance(context, dict) else None
    if isinstance(caller, dict) and isinstance(caller.get("actor"), str):
        return caller["actor"]
    input_ = context.get("input") if isinstance(context, dict) else None
    if isinstance(input_, dict):
        c = input_.get("caller")
        if isinstance(c, dict) and isinstance(c.get("actor"), str):
            return c["actor"]
        if isinstance(input_.get("speaker"), str):
            return input_["speaker"]
    return ""


def _post_conversation(factory_url: str, key: str, agent: str, message: str, speaker: str, mode: str) -> dict[str, Any]:
    req = urllib.request.Request(
        f"{factory_url}/api/v1/agents/{urllib.parse.quote(agent, safe='')}/conversation",
        data=json.dumps(
            {
                "input": message,
                "speaker": speaker,
                "mode": mode,
                "channel": "voice",
                "assurance": "voice-asserted",
                "waitSeconds": 20,
            }
        ).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {key}",
            "user-agent": "curl/8.5.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
            return {"ok": True, "status": resp.status, "body": json.loads(body) if body else {}}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8") if exc.fp else ""
        try:
            parsed = json.loads(raw) if raw else {"error": "http_error"}
        except json.JSONDecodeError:
            parsed = {"error": "http_error", "message": raw[:500]}
        return {"ok": False, "status": exc.code, "body": parsed}



def _child_restricted(context: dict) -> str | None:
    caller = context.get("caller") if isinstance(context, dict) else None
    if isinstance(caller, dict) and caller.get("relationship") == "child":
        return json.dumps({"error": "child_restricted", "message": "a child speaker cannot start an agent-to-agent call or errand"})
    return None


def _call_agent(arguments: dict, context: dict) -> str:
    blocked = _child_restricted(context)
    if blocked:
        return blocked
    agent = str(arguments.get("agent") or "").strip()
    speaker = _speaker_from_context(context, arguments.get("speaker") if isinstance(arguments.get("speaker"), str) else None)
    if not agent:
        return json.dumps({"error": "agent_required", "message": "agent is required"})
    if not speaker:
        return json.dumps({"error": "speaker_required", "message": "speaker is required to open a conversation as an enrolled person"})
    if arguments.get("dryRun") is True:
        intent = {"action": "call", "agent": agent, "speaker": speaker, "dryRun": True}
        return json.dumps(intent)
    intent = {"action": "call", "agent": agent, "speaker": speaker}
    return "FACTORY_CALL_INTENT:" + json.dumps(intent, separators=(",", ":"))


def _ask_agent(arguments: dict, context: dict) -> str:
    blocked = _child_restricted(context)
    if blocked:
        return blocked
    agent = str(arguments.get("agent") or "").strip()
    message = str(arguments.get("message") or arguments.get("task") or "").strip()
    speaker = _speaker_from_context(context, arguments.get("speaker") if isinstance(arguments.get("speaker"), str) else None)
    if not agent:
        return json.dumps({"error": "agent_required", "message": "agent is required"})
    if not message:
        return json.dumps({"error": "message_required", "message": "message is required"})
    if not speaker:
        return json.dumps({"error": "speaker_required", "message": "speaker is required to open a conversation as an enrolled person"})
    if arguments.get("dryRun") is True:
        return json.dumps({"ok": True, "dryRun": True, "agent": agent, "speaker": speaker, "mode": "errand"})
    url = _factory_url(context)
    key = _agent_key(context)
    if not url or not key:
        return json.dumps({"error": "not_configured", "message": "FACTORY_URL and FACTORY_AGENT_KEY must be bound on this agent"})
    result = _post_conversation(url, key, agent, message, speaker, "errand")
    if not result["ok"]:
        return json.dumps({"error": result["body"].get("error", "ask_failed"), "message": result["body"].get("message"), "status": result["status"]})
    body = result["body"] if isinstance(result["body"], dict) else {}
    reply = body.get("reply")
    return json.dumps({"ok": True, "agent": agent, "speaker": speaker, "mode": "errand", "reply": reply, "runId": body.get("runId"), "conversationId": body.get("conversationId"), "status": body.get("status")})


def tools() -> list[dict]:
    return [
        {
            "name": "call_agent",
            "description": (
                "Start a live voice call between the enrolled speaker and another factory agent. "
                "Do not proxy the conversation. This tool returns a structured intent "
                "{action:'call', agent, speaker} tagged as FACTORY_CALL_INTENT:... so the robot "
                "can open /mcp/agents/<id> itself and hold the multi-turn call."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "description": "Target agent id (e.g. donna, higgins, geordi)"},
                    "speaker": {"type": "string", "description": "Enrolled user:<id> or alias. Defaults to this turn's verified caller."},
                },
                "required": ["agent"],
            },
            "handler": _call_agent,
        },
        {
            "name": "ask_agent",
            "description": (
                "Run a one-shot errand on another factory agent as the enrolled speaker "
                "(mode=errand). Waits for the result and returns it so you can speak it back. "
                "Use this when the person wants something done without a live call, e.g. "
                "'tell Donna to add this to my calendar'."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "description": "Target agent id"},
                    "message": {"type": "string", "description": "The errand to send"},
                    "speaker": {"type": "string", "description": "Enrolled user:<id> or alias. Defaults to this turn's verified caller."},
                },
                "required": ["agent", "message"],
            },
            "handler": _ask_agent,
        },
    ]
