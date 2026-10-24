"""The loop (RT1): wake, open memory by archetype, build the prompt (soul, memory, message), call the model, run the tools
the model asks for and repeat, reply on the channel the turn came from (AM2), save memory, report, sleep.

Cron and scheduled runs use this same loop: only the caller differs, and the caller is what the factory says it is.
Nothing here decides who may do what: that is the factory's (the egress applies the person's roles to every call a tool makes).
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from runtime.factory import Factory, FactoryError
from runtime.mind import Mind, open_mind
from runtime.skills import Tool, load_skills, run_tool

MAX_ROUNDS = 6
MAX_USER_CHARS = 20000
DEFAULT_SOUL = "You are a helpful assistant."


def write_result(result: dict) -> None:
    path = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2), "utf-8")


def caller_of(payload: dict) -> dict:
    """The person speaking, as the factory verified them (AM2). Conversations are keyed by `caller.actor`, never by channel."""
    c = payload.get("caller")
    return c if isinstance(c, dict) else {}


def who_of(payload: dict) -> str:
    actor = caller_of(payload).get("actor")
    return str(actor) if actor else "system"


def text_of(payload: dict) -> str:
    return str(payload.get("message") or payload.get("content") or payload.get("raw_input") or "wake")[:MAX_USER_CHARS]


def system_prompt(soul: str, payload: dict) -> str:
    caller = caller_of(payload)
    speaking = ""
    if caller.get("actor"):
        name = caller.get("name") or caller["actor"]
        speaking = f"\n\nYou are speaking with {name}."
    now = datetime.now(timezone.utc).strftime("%A %Y-%m-%d %H:%M UTC")
    return f"{soul.strip() or DEFAULT_SOUL}{speaking}\n\nIt is {now}."


def converse(factory: Factory, soul: str, mind: Mind, tools: dict[str, Tool], payload: dict) -> str:
    who = who_of(payload)
    user_text = text_of(payload)
    fast = mind.fast_path(who, user_text)
    if fast is not None:
        return fast
    history, banner = mind.history(who, payload)
    system = system_prompt(soul, payload) + (f"\n\n{banner}" if banner else "")
    messages: list[dict] = [{"role": "system", "content": system}, *history, {"role": "user", "content": user_text}]
    specs = [t.spec() for t in tools.values()]
    for spec, _ in mind.tools():
        specs.append(spec)
    memory_tools = {spec["function"]["name"]: fn for spec, fn in mind.tools()}
    reply = ""
    for _ in range(MAX_ROUNDS):
        answer = factory.complete(messages, specs or None)
        calls = answer.get("tool_calls") or []
        if not calls:
            reply = str(answer.get("content") or "")
            break
        messages.append({"role": "assistant", "content": answer.get("content") or "", "tool_calls": calls})
        for call in calls:
            fn = call.get("function") or {}
            name = str(fn.get("name", ""))
            if name in memory_tools:
                try:
                    out = str(memory_tools[name](json.loads(fn.get("arguments") or "{}"), who))
                except Exception as err:
                    out = f"error: {err}"
            elif name in tools:
                out = run_tool(tools[name], fn.get("arguments") or "", {"caller": caller_of(payload), "turnId": payload.get("turnId")})
            else:
                out = f"error: no tool named {name}"
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": out})
    else:
        reply = "I could not finish that within the steps I am allowed."
    mind.remember(who, payload, user_text, reply, surface=(payload.get("replyTo") or {}).get("channel", "factory"), channel_id=(payload.get("replyTo") or {}).get("channelId"))
    return reply


def deliver(factory: Factory, payload: dict, reply: str) -> None:
    """Reply on the channel the turn came from; a turn with nowhere to reply is reported in the result only."""
    to = payload.get("replyTo") if isinstance(payload.get("replyTo"), dict) else {}
    if to.get("channel") == "console" and payload.get("turnId"):
        factory.reply_console(str(payload["turnId"]), reply)
    elif to.get("channel") == "discord" and to.get("channelId"):
        factory.reply_discord(str(to["channelId"]), reply)


def answer_request(mind: Mind, payload: dict) -> str:
    """AM5: the console asks the agent, never the factory's own copy, for a person's conversations."""
    req = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    subject = req.get("subject") or caller_of(payload).get("actor") or "system"
    out = mind.conversations(str(subject), str(req.get("op", "list")), req.get("conversation"), int(req.get("limit") or 10))
    return json.dumps(out)


def handle(factory: Factory, soul: str, mind: Mind, tools: dict[str, Tool], payload: dict) -> str | None:
    if payload.get("type") == "approval":
        return None  # a decision for an action the agent asked for: the factory applies it, the loop has nothing to say
    reply = answer_request(mind, payload) if payload.get("kind") == "conversation-request" else converse(factory, soul, mind, tools, payload)
    deliver(factory, payload, reply)
    return reply


def main(factory: Factory | None = None) -> int:
    factory = factory or Factory()
    print("[runtime] waking up")
    try:
        config = factory.config()
    except Exception as err:  # FactoryError or an unreachable factory: with no configuration there is nothing to run
        write_result({"status": "failed", "output": {"error": f"no agent configuration: {getattr(err, 'status', type(err).__name__)}"}})
        return 1
    soul = str(config.get("soul") or "")
    try:
        mind = open_mind(config.get("memory") or {}, Path(os.environ.get("MEMORY_DIR", "/tmp/mind")))
    except ValueError as err:
        write_result({"status": "failed", "output": {"error": str(err)}})
        return 1
    loaded, problems = load_skills(config.get("skills") or [])
    tools = {t.name: t for t in loaded}
    for p in problems:
        print(f"[runtime] {p}", file=sys.stderr)
    last = None
    try:
        payload = factory.input()
        last = handle(factory, soul, mind, tools, payload)
        # A conversational agent stays warm to answer follow-ups without a cold start; the idle window is the factory's.
        warm = int(config.get("warmDownSeconds") or 0)
        deadline = time.time() + warm
        while warm and time.time() < deadline:
            factory.heartbeat()
            message = factory.next_message(min(20000, max(1, int((deadline - time.time()) * 1000))))
            if not message:
                continue
            nxt = message.get("payload")
            if isinstance(nxt, dict):
                reply = handle(factory, soul, mind, tools, nxt)
                last = reply if reply is not None else last
                deadline = time.time() + warm
    except Exception as err:  # a turn that cannot be answered is a failed run, reported, never a silent success
        mind.close()
        write_result({"status": "failed", "output": {"error": f"{type(err).__name__}: {err}"[:500]}})
        print(f"[runtime] failed: {err}", file=sys.stderr)
        return 1
    finally:
        mind.close()
    write_result({"status": "succeeded", "output": {"summary": last or "", "archetype": mind.archetype, "processed_at": datetime.now(timezone.utc).isoformat()}})
    print("[runtime] done")
    return 0
