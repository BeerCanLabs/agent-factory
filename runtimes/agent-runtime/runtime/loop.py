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
from zoneinfo import ZoneInfo
from pathlib import Path

from memory import episodic
from runtime.factory import Factory, FactoryError
from runtime.mind import Mind, is_scheduled_payload, open_mind
from runtime.relay import mark_unseen_delivered, pending_note, relay_tools
from runtime.skills import Tool, load_skills, log_tool_error, run_tool

MAX_ROUNDS = 6
MAX_USER_CHARS = 20000
# Helper/subagent run results store the model text under output.reply (sdlc-reviewer _reply_text).
MAX_HELPER_REPLY_CHARS = 20000
HELPER_REPLY_TRUNCATION = "\n… [truncated]"
DEFAULT_SOUL = "You are a helpful assistant."


def write_result(result: dict) -> None:
    path = Path(os.environ.get("FACTORY_RESULT_FILE", "/tmp/factory-result.json"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2), "utf-8")


def is_helper_payload(payload: dict) -> bool:
    """A spawn_subagent run: the factory sets input.subagent. Ordinary turns and smoke are not helpers."""
    sub = payload.get("subagent") if isinstance(payload, dict) else None
    return isinstance(sub, str) and bool(sub.strip())


def capped_helper_reply(text: str) -> str:
    """The full final assistant text, cut at MAX_HELPER_REPLY_CHARS with a visible truncation mark."""
    s = str(text)
    if len(s) <= MAX_HELPER_REPLY_CHARS:
        return s
    keep = max(0, MAX_HELPER_REPLY_CHARS - len(HELPER_REPLY_TRUNCATION))
    return s[:keep] + HELPER_REPLY_TRUNCATION


def caller_of(payload: dict) -> dict:
    """The person speaking, as the factory verified them (AM2). Conversations are keyed by `caller.actor`, never by channel."""
    c = payload.get("caller")
    return c if isinstance(c, dict) else {}


def who_of(payload: dict) -> str:
    """The notebook a turn belongs to: the verified person, else `system` for a wake the factory itself started (cron,
    schedule, queue or event: no person speaks). A person's message always carries the `caller` the factory set."""
    actor = caller_of(payload).get("actor")
    return str(actor) if isinstance(actor, str) and actor else "system"


def text_of(payload: dict) -> str:
    """The user text for this turn.

    A spawn_subagent run carries the parent's task in `prompt`. That field is the user
    message, and this never falls back to `wake` when a prompt is present. Ordinary
    turns still use message / content / raw_input, then `wake`.
    """
    if is_helper_payload(payload):
        prompt = payload.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return prompt[:MAX_USER_CHARS]
        for key in ("message", "content", "raw_input"):
            val = payload.get(key)
            if isinstance(val, str) and val.strip():
                return val[:MAX_USER_CHARS]
        return ""
    return str(payload.get("message") or payload.get("content") or payload.get("raw_input") or "wake")[:MAX_USER_CHARS]


def helper_system_soul(soul: str, payload: dict) -> str:
    """The system text for a helper run: `input.instructions` is the helper's brief.

    A configured soul is kept ahead of the brief when the two are different. Ordinary
    turns keep using `soul` (or DEFAULT_SOUL) unchanged.
    """
    configured = (soul or "").strip()
    if not is_helper_payload(payload):
        return configured or DEFAULT_SOUL
    instr = payload.get("instructions")
    brief = instr.strip() if isinstance(instr, str) and instr.strip() else ""
    if brief and configured and brief != configured:
        return f"{configured}\n\n{brief}"
    return brief or configured or DEFAULT_SOUL


def clock_line(tz_name: str | None = None) -> str:
    """The current time in the agent's configured IANA zone, else UTC."""
    if isinstance(tz_name, str) and tz_name.strip():
        try:
            zone = ZoneInfo(tz_name.strip())
            return datetime.now(zone).strftime(f"%A %Y-%m-%d %H:%M {tz_name.strip()}")
        except Exception:
            pass
    return datetime.now(timezone.utc).strftime("%A %Y-%m-%d %H:%M UTC")


def system_prompt(soul: str, payload: dict, pending: str = "", tz_name: str | None = None) -> str:
    caller = caller_of(payload)
    speaking = ""
    if caller.get("actor"):
        # A display name is typed by a person: one short plain line, never a way to add instructions.
        name = " ".join(str(caller.get("name") or caller["actor"]).split())[:60]
        speaking = f"\n\nYou are speaking with {name}."
    scheduled_note = ""
    if is_scheduled_payload(payload):
        scheduled_note = "\n\nThis is a scheduled background check. If nothing needs to be reported or said, respond with NO_REPLY."
    pending_note_text = f"\n\n{pending}" if pending else ""
    now = clock_line(tz_name)
    history_note = " Earlier user messages in history begin with [YYYY-MM-DD HH:MM UTC] showing when they were sent, and intermediate tool calls from completed past turns are omitted. Never prefix your own replies with a timestamp."
    return f"{helper_system_soul(soul, payload)}{speaking}{scheduled_note}{pending_note_text}\n\nIt is {now}.{history_note}"


def converse(factory: Factory, soul: str, mind: Mind, tools: dict[str, Tool], payload: dict) -> str:
    who = who_of(payload)
    user_text = text_of(payload)
    owners = getattr(factory, "owners", None) or []
    memory_dir = getattr(factory, "memory_dir", None)
    pending = pending_note(who, memory_dir, owners) if memory_dir else ""
    fast = None if is_scheduled_payload(payload) else mind.fast_path(who, user_text)
    if fast is not None:
        return fast
    history, banner = mind.history(who, payload)
    tz_name = getattr(factory, "timezone", None)
    system = system_prompt(soul, payload, pending, tz_name if isinstance(tz_name, str) else None) + (f"\n\n{banner}" if banner else "")
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
                    log_tool_error(f"memory/{name}", f"{type(err).__name__}: {err}")
                    out = f"error: {err}"
            elif name in tools:
                out = run_tool(tools[name], fn.get("arguments") or "", {"caller": caller_of(payload), "turnId": payload.get("turnId")})
            else:
                log_tool_error(name[:64] or "(unnamed)", "the model called a tool that is not loaded")
                out = f"error: no tool named {name}"
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "content": out})
    else:
        reply = "I could not finish that within the steps I am allowed."
    mind.remember(who, payload, user_text, reply, surface=(payload.get("replyTo") or {}).get("channel", "factory"), channel_id=(payload.get("replyTo") or {}).get("channelId"))
    if pending and reply and not episodic.is_silent_reply(reply) and memory_dir:
        mark_unseen_delivered(who, memory_dir, owners)
    return reply


def deliver(factory: Factory, payload: dict, reply: str) -> bool:
    """Reply on the channel the turn came from; silent/no-reply turns suppress channel delivery (#345)."""
    if episodic.is_silent_reply(reply):
        return False
    to = payload.get("replyTo") if isinstance(payload.get("replyTo"), dict) else {}
    if to.get("channel") == "console" and payload.get("turnId"):
        factory.reply_console(str(payload["turnId"]), reply)
        return True
    elif to.get("channel") == "discord" and to.get("channelId"):
        factory.reply_discord(str(to["channelId"]), reply)
        return True
    return False


def answer_request(mind: Mind, payload: dict) -> str:
    """AM5: the console asks the agent, never the factory's own copy, for a person's conversations. Only a request the
    factory built (`factoryKind`) is one, so a person's message cannot ask for another person's conversations; an admin's
    request names its subject, anyone else's is about themselves."""
    asker = caller_of(payload).get("actor")
    if not isinstance(asker, str) or not asker:
        return json.dumps({"error": "a conversation request needs a verified asker"})
    req = payload.get("request") if isinstance(payload.get("request"), dict) else {}
    subject = req.get("subject") if isinstance(req.get("subject"), str) and req.get("subject") else asker
    try:
        limit = int(req.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    op = req.get("op") if req.get("op") in ("list", "turns") else "list"
    conversation = req.get("conversation") if isinstance(req.get("conversation"), str) else None
    return json.dumps(mind.conversations(subject, op, conversation, limit))


def handle(factory: Factory, soul: str, mind: Mind, tools: dict[str, Tool], payload: dict) -> str | None:
    # `factoryKind` is set by the factory and removed from anything a person sends, so only the factory can make one.
    kind = payload.get("factoryKind")
    if kind == "approval":
        # GAP-259: the answer to a decision the agent asked for (a decision hold) names the event the agent handles, in the
        # factory's own words; the decider's notes stay out of the model's view. Any other decision the factory applies.
        if not (isinstance(payload.get("requestKey"), str) and isinstance(payload.get("event"), dict)):
            return None  # a decision for an action the agent asked for: the factory applies it, the loop has nothing to say
        return converse(factory, soul, mind, tools, {"message": str(payload.get("message") or ""), "event": payload["event"]})
    if kind == "smoke":
        if payload.get("smoke") == "skill" or payload.get("action"):
            action = str(payload.get("action") or "")
            tool = tools.get(action) or tools.get(action.replace("-", "_"))
            if tool is None:
                raise RuntimeError(f"smoke action {action!r} is not loaded")
            args = dict(payload.get("input") or {})
            out = run_tool(tool, json.dumps(args), {"caller": {}, "turnId": payload.get("turnId"), "smoke": True, "dryRun": bool(payload.get("dryRun"))})
            if out.startswith("error:"):
                raise RuntimeError(out)
            return out
        else:
            answer = factory.complete([{"role": "system", "content": system_prompt(soul, {})}, {"role": "user", "content": text_of(payload)}], None)
            reply = str(answer.get("content") or "")
            if not reply.strip():
                raise RuntimeError("empty smoke reply")
            return reply
    reply = answer_request(mind, payload) if kind == "conversation-request" else converse(factory, soul, mind, tools, payload)
    deliver(factory, payload, reply)
    return reply


def main(factory: Factory | None = None) -> int:
    factory = factory or Factory()
    print("[runtime] waking up")
    try:
        config = factory.config()
    except Exception as err:  # FactoryError or an unreachable factory: with no configuration there is nothing to run
        reason = f"no agent configuration: {getattr(err, 'status', type(err).__name__)}"
        print(f"[runtime] {reason}", file=sys.stderr)
        write_result({"status": "failed", "output": {"error": reason}})
        return 1
    soul = str(config.get("soul") or "")
    try:
        mind = open_mind(config.get("memory") or {}, Path(os.environ.get("MEMORY_DIR", "/tmp/mind")))
    except ValueError as err:
        print(f"[runtime] {err}", file=sys.stderr)
        write_result({"status": "failed", "output": {"error": str(err)}})
        return 1
    memory_dir = Path(os.environ.get("MEMORY_DIR", "/tmp/mind"))
    factory.memory_dir = memory_dir
    factory.owners = config.get("owners") if isinstance(config.get("owners"), list) else []
    factory.timezone = config.get("timezone") if isinstance(config.get("timezone"), str) else None
    relayed = relay_tools(factory, memory_dir, factory.owners)
    reserved = {spec["function"]["name"] for spec, _ in mind.tools()} | {t.name for t in relayed}
    loaded, problems = load_skills(config.get("skills") or [], reserved=reserved)
    tools = {t.name: t for t in [*loaded, *relayed]}
    for p in problems:
        print(f"[runtime] {p}", file=sys.stderr)
    turns = 0
    last_reply = None
    is_smoke = False
    is_helper = False
    try:
        payload = factory.input()
        is_smoke = payload.get("factoryKind") == "smoke"
        is_helper = is_helper_payload(payload)
        last_reply = handle(factory, soul, mind, tools, payload)
        turns += 1
        # A conversational agent stays warm to answer follow-ups without a cold start; the idle window is the factory's.
        is_background = is_scheduled_payload(payload)
        warm = 0 if (is_smoke or is_background) else int(config.get("warmDownSeconds") or 0)
        deadline = time.time() + warm
        while warm and time.time() < deadline:
            factory.heartbeat()
            asked = time.time()
            try:
                message = factory.next_message(min(20000, max(1, int((deadline - time.time()) * 1000))))
            except FactoryError as err:
                if err.status in (401, 409, 410):
                    break
                raise
            if not message:
                if time.time() - asked < 0.05:
                    time.sleep(0.25)  # an answer that comes back at once is not a reason to spin
                continue
            if isinstance(message, dict) and (message.get("id") == "done" or (isinstance(message.get("payload"), dict) and message["payload"].get("done"))):
                break
            nxt = message.get("payload")
            if isinstance(nxt, dict):
                try:
                    handle(factory, soul, mind, tools, nxt)
                except Exception as err:  # one person's message must not end the others' turns
                    print(f"[runtime] a turn failed: {type(err).__name__}", file=sys.stderr)
                    try:
                        deliver(factory, nxt, "I could not process that message.")
                    except Exception:
                        pass
                turns += 1
                deadline = time.time() + warm
    except Exception as err:  # a turn that cannot be answered is a failed run, reported, never a silent success
        mind.close()
        write_result({"status": "failed", "output": {"error": f"{type(err).__name__}: {err}"[:500]}})
        print(f"[runtime] failed: {err}", file=sys.stderr)
        return 1
    finally:
        mind.close()
    output: dict = {
        "summary": f"handled {turns} turn(s)",
        "archetype": mind.archetype,
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    if not is_smoke and last_reply is not None and episodic.is_silent_reply(last_reply):
        output["silent"] = True
    if is_smoke and last_reply is not None:
        output["reply"] = last_reply
    elif is_helper and last_reply is not None:
        # Parent skills (sdlc-reviewer 1.3.0 _reply_text) read result.reply. Smoke already
        # stored it; ordinary conversational runs still do not (they deliver on the channel).
        output["reply"] = capped_helper_reply(last_reply)
    write_result({"status": "succeeded", "output": output})
    print("[runtime] done")
    return 0
