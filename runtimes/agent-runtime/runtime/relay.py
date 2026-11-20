"""Family message relay: a proactive Discord DM to the agent's owner, plus pending notes
the owner is told about the next time they talk to the agent.

Pending notes live in the agent's mind volume (not in a per-caller notebook), so a
message left during a family member's turn is visible on the owner's later turn.
Discord delivery goes only through gatekeeper-egress (`Factory.send_discord_dm`).
"""
from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from runtime.factory import Factory, FactoryError
from runtime.skills import Tool

MAX_CONTENT = 1500
DISCORD_ID = re.compile(r"^\d{15,32}$")
FILE_NAME = "pending-messages.json"

RELAY_TOOL_SPEC = {
    "name": "relay_message_to_owner",
    "description": (
        "Leave a message for the agent's owner: immediately send them a Discord DM "
        "attributed to the current caller (for example 'Message from Stephanie: ...') "
        "and store it so they are reminded the next time they talk to you. "
        "Use this when a family member asks you to pass a message to the owner."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "The message to deliver, in the sender's own words."},
        },
        "required": ["content"],
    },
}


def _path(memory_dir: Path) -> Path:
    return Path(memory_dir) / FILE_NAME


def load_pending(memory_dir: Path) -> list[dict]:
    path = _path(memory_dir)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def save_pending(memory_dir: Path, items: list[dict]) -> None:
    path = _path(memory_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def owner_aliases(owners: list[dict]) -> set[str]:
    out: set[str] = set()
    for owner in owners:
        actor = owner.get("actor")
        if isinstance(actor, str) and actor:
            out.add(actor)
        for alias in owner.get("aliases") or []:
            if isinstance(alias, str) and alias:
                out.add(alias)
    return out


def unseen_for(who: str, memory_dir: Path, owners: list[dict]) -> list[dict]:
    aliases = owner_aliases(owners)
    if not who or who not in aliases:
        return []
    return [m for m in load_pending(memory_dir) if m.get("deliveredAt") is None and _recipient_matches(m, aliases)]


def _recipient_matches(msg: dict, aliases: set[str]) -> bool:
    recipient = msg.get("recipientActor")
    if isinstance(recipient, str) and recipient in aliases:
        return True
    for alias in msg.get("recipientAliases") or []:
        if isinstance(alias, str) and alias in aliases:
            return True
    return False


def pending_note(who: str, memory_dir: Path, owners: list[dict]) -> str:
    items = unseen_for(who, memory_dir, owners)
    if not items:
        return ""
    lines = [
        "You have unseen messages to tell this caller about now. Mention each one, attributed to the sender, then continue. "
        "They will be marked delivered after you reply."
    ]
    for m in items:
        sender = m.get("fromName") or m.get("fromActor") or "someone"
        when = m.get("createdAt") or ""
        body = str(m.get("content") or "")
        lines.append(f"- From {sender} at {when}: {body}")
    return "\n".join(lines)


def mark_unseen_delivered(who: str, memory_dir: Path, owners: list[dict], now: datetime | None = None) -> list[str]:
    aliases = owner_aliases(owners)
    if not who or who not in aliases:
        return []
    stamp = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    items = load_pending(memory_dir)
    marked: list[str] = []
    changed = False
    for m in items:
        if m.get("deliveredAt") is None and _recipient_matches(m, aliases):
            m["deliveredAt"] = stamp
            marked.append(str(m.get("id") or ""))
            changed = True
    if changed:
        save_pending(memory_dir, items)
    return marked


def _attribute(content: str, name: str) -> str:
    text = content.strip()
    prefix = f"Message from {name}:"
    if text.lower().startswith(prefix.lower()):
        return text[:1900]
    return f"{prefix} {text}"[:1900]


def _owner(owners: list[dict]) -> dict | None:
    for owner in owners:
        if isinstance(owner, dict) and owner.get("actor"):
            return owner
    return None


def leave_message(
    *,
    memory_dir: Path,
    owners: list[dict],
    caller: dict,
    content: str,
    send_dm: Callable[[str, str], dict] | None,
    now: datetime | None = None,
) -> dict:
    owner = _owner(owners)
    if not owner:
        return {"ok": False, "error": "no_owner", "message": "this agent has no owner to receive a message"}
    relationship = caller.get("relationship")
    if relationship != "family":
        return {"ok": False, "error": "not_family", "message": "only a family caller may relay a message to the owner"}
    text = str(content or "").strip()
    if not text:
        return {"ok": False, "error": "empty", "message": "the message is empty"}
    text = text[:MAX_CONTENT]
    sender_name = " ".join(str(caller.get("name") or "a family member").split())[:60] or "a family member"
    sender_actor = str(caller.get("actor") or "")
    item = {
        "id": f"pm_{uuid.uuid4().hex[:12]}",
        "recipientActor": owner["actor"],
        "recipientAliases": list(owner.get("aliases") or [owner["actor"]]),
        "fromActor": sender_actor,
        "fromName": sender_name,
        "content": text,
        "createdAt": (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "deliveredAt": None,
        "discord": None,
    }
    items = load_pending(memory_dir)
    items.append(item)
    save_pending(memory_dir, items)

    attributed = _attribute(text, sender_name)
    dm: dict[str, Any] = {"ok": False}
    user_ids = [u for u in (owner.get("discordUserIds") or []) if isinstance(u, str) and DISCORD_ID.match(u)]
    if not user_ids:
        dm = {"ok": False, "error": "no_discord_id", "message": "the owner has no Discord user id on file"}
    elif send_dm is None:
        dm = {"ok": False, "error": "no_discord", "message": "Discord is not available on this run"}
    else:
        last_err = "discord_failed"
        for user_id in user_ids:
            try:
                sent = send_dm(user_id, attributed)
                dm = {"ok": True, "channelId": sent.get("channelId"), "messageId": sent.get("messageId")}
                break
            except FactoryError as err:
                last_err = f"discord_failed:{err.status}"
            except Exception as err:
                last_err = f"discord_failed:{type(err).__name__}"
        if not dm.get("ok"):
            dm = {"ok": False, "error": last_err, "message": "the Discord DM could not be sent; the message is stored for the next conversation"}
    item["discord"] = dm
    save_pending(memory_dir, items)
    return {"ok": True, "id": item["id"], "stored": True, "discord": dm, "attributed": attributed}


def relay_tools(factory: Factory, memory_dir: Path, owners: list[dict]) -> list[Tool]:
    def send_dm(user_id: str, content: str) -> dict:
        return factory.send_discord_dm(user_id, content)

    def handler(args: dict, context: dict) -> str:
        caller = context.get("caller") if isinstance(context.get("caller"), dict) else {}
        result = leave_message(
            memory_dir=memory_dir,
            owners=owners,
            caller=caller,
            content=str(args.get("content") or ""),
            send_dm=send_dm if factory.discord_base else None,
        )
        return json.dumps(result)

    return [Tool("runtime", RELAY_TOOL_SPEC["name"], RELAY_TOOL_SPEC["description"], RELAY_TOOL_SPEC["parameters"], handler)]
