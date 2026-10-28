"""Interview and operations logic for the Headless Agent Builder staff agent.

The Agent Builder guides human operators holding `agents.create` through inspecting
catalogs, drafting configuration agents, performing dry-run validations, and
publishing agents into PENDING_BUDGET on the shared runtime via the run-scoped
endpoint `POST /api/v1/runs/:id/builder`.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
import urllib.error
import urllib.request


HELP = """\
Agent Builder Commands:
  help                                  Show this help guide
  catalog                               List approved skills and memory archetypes
  show | status                         Show current draft agent configuration
  reset                                 Reset current draft configuration

Configuration drafting:
  set id <id>                           Set agent ID (letters, digits, dash, underscore)
  set name <name>                       Set display name
  set description <text>                Set description
  set archetype <arch>                  Set archetype: purpose-built, personal-assistant, team-member
  set soul <text>                       Set system prompt / soul instructions
  add skill <id> [version]              Add skill from catalog to candidate agent
  remove skill <id>                     Remove skill from candidate agent
  add role <name> <s1,s2,...>           Add RBAC role mapping to skills (use * for all)

Actions:
  validate                              Dry-run validate draft with the factory
  publish                               Publish agent to factory in PENDING_BUDGET

You can also submit structured JSON payloads with {"op": "catalog"|"validate"|"publish", ...}.
"""


def empty_draft() -> dict:
    return {
        "id": None,
        "name": None,
        "description": None,
        "soul": None,
        "memory": {"archetype": None},
        "skills": [],
        "roles": [],
    }


def empty_state() -> dict:
    return {
        "draft": empty_draft(),
        "lastValidation": None,
        "published": None,
    }


def load_state(path: Path) -> dict:
    if path.exists():
        try:
            data = json.loads(path.read_text("utf-8"))
            if isinstance(data, dict):
                if "draft" not in data:
                    data["draft"] = empty_draft()
                return data
        except (json.JSONDecodeError, OSError):
            pass
    return empty_state()


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2), "utf-8")


class BuilderClient:
    """Calls the run-scoped /api/v1/runs/:id/builder endpoint using the injected run token."""

    def __init__(self, base_url: str | None = None, run_id: str | None = None, token: str | None = None):
        self.base_url = (base_url if base_url is not None else os.environ.get("FACTORY_URL", "")).rstrip("/")
        self.run_id = run_id if run_id is not None else os.environ.get("FACTORY_RUN_ID", "")
        self.token = token if token is not None else os.environ.get("FACTORY_RUN_TOKEN", "")

    def _request(self, body: dict) -> dict:
        if not self.base_url or not self.run_id or not self.token:
            return {
                "ok": False,
                "error": "factory_unconfigured",
                "message": "FACTORY_URL, FACTORY_RUN_ID, or FACTORY_RUN_TOKEN not set in environment",
            }

        url = f"{self.base_url}/api/v1/runs/{self.run_id}/builder"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=data,
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.token}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                raw = res.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8")
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {}
            if "error" not in parsed:
                parsed["error"] = f"http_{err.code}"
            parsed["status"] = err.code
            return parsed
        except urllib.error.URLError as err:
            return {"ok": False, "error": "network_error", "message": str(err)}

    def catalog(self) -> dict:
        return self._request({"op": "catalog"})

    def validate(self, spec: dict) -> dict:
        return self._request({"op": "validate", "spec": spec})

    def publish(self, spec: dict) -> dict:
        return self._request({"op": "publish", "spec": spec})


def clean_draft(draft: dict) -> dict:
    """Strips unset or empty fields so the spec matches schema expectations."""
    clean: dict = {}
    if draft.get("id"):
        clean["id"] = draft["id"]
    if draft.get("name"):
        clean["name"] = draft["name"]
    if draft.get("description"):
        clean["description"] = draft["description"]
    if draft.get("soul"):
        clean["soul"] = draft["soul"]

    mem = draft.get("memory")
    if isinstance(mem, dict) and mem.get("archetype"):
        clean["memory"] = {k: v for k, v in mem.items() if v is not None}

    skills = draft.get("skills")
    if isinstance(skills, list) and len(skills) > 0:
        clean["skills"] = skills

    roles = draft.get("roles")
    if isinstance(roles, list) and len(roles) > 0:
        clean["roles"] = roles

    return clean


def format_catalog(data: dict) -> str:
    lines = ["=== Factory Catalog ==="]
    archetypes = data.get("archetypes", ["purpose-built", "personal-assistant", "team-member"])
    lines.append(f"Supported Memory Archetypes: {', '.join(archetypes)}")

    skills = data.get("skills", [])
    if skills:
        lines.append(f"\nApproved Skills ({len(skills)}):")
        for s in skills:
            sid = s.get("id", "")
            name = s.get("name") or sid
            latest = s.get("latestApproved") or "latest"
            lines.append(f"  - {sid} (latest: {latest}) — {name}")
    else:
        lines.append("\nNo approved skills registered in factory.")

    lines.append("\nUse `set archetype <arch>` and `add skill <id>` to configure your draft.")
    return "\n".join(lines)


def format_draft(draft: dict) -> str:
    lines = ["=== Current Draft Agent Configuration ==="]
    lines.append(f"ID:          {draft.get('id') or '<unset>'}")
    lines.append(f"Name:        {draft.get('name') or '<unset>'}")
    lines.append(f"Description: {draft.get('description') or '<unset>'}")

    mem = draft.get("memory") if isinstance(draft.get("memory"), dict) else {}
    lines.append(f"Archetype:   {mem.get('archetype') or '<unset>'}")

    soul = draft.get("soul")
    if soul:
        first_line = soul.strip().split("\n")[0]
        preview = first_line[:60] + "..." if len(first_line) > 60 else first_line
        lines.append(f"Soul:        \"{preview}\" ({len(soul)} chars)")
    else:
        lines.append("Soul:        <unset>")

    skills = draft.get("skills") or []
    if skills:
        lines.append(f"Skills ({len(skills)}):")
        for s in skills:
            ver = s.get("version", "latest")
            lines.append(f"  - {s.get('id')}@{ver}")
    else:
        lines.append("Skills:      none")

    roles = draft.get("roles") or []
    if roles:
        lines.append(f"Roles ({len(roles)}):")
        for r in roles:
            sk_map = r.get("skills", {})
            lines.append(f"  - {r.get('name')}: {list(sk_map.keys())}")
    else:
        lines.append("Roles:       none")

    lines.append("==========================================")
    return "\n".join(lines)


def format_validation(res: dict) -> str:
    if res.get("valid") or res.get("ok"):
        adopts = res.get("adoptableSkills", [])
        msg = "Validation passed! Candidate agent specification is valid and ready to publish."
        if adopts:
            msg += f"\nAdoptable skills confirmed: {', '.join(adopts)}"
        return msg
    err = res.get("error", "unknown_error")
    msg = res.get("message", "Validation failed")
    detail = []
    if res.get("skill"):
        detail.append(f"skill='{res['skill']}'")
    if res.get("role"):
        detail.append(f"role='{res['role']}'")
    suffix = f" ({', '.join(detail)})" if detail else ""
    return f"Validation failed [{err}]{suffix}: {msg}"


def turn(state: dict, message_or_payload: str | dict, client: BuilderClient) -> str:
    """Processes an operator message or structured command against the builder state."""
    payload: dict | None = None
    text_input = ""

    if isinstance(message_or_payload, dict):
        payload = message_or_payload
    else:
        text_input = str(message_or_payload).strip()
        if text_input.startswith("{") and text_input.endswith("}"):
            try:
                parsed = json.loads(text_input)
                if isinstance(parsed, dict):
                    payload = parsed
            except json.JSONDecodeError:
                payload = None

    # Structured payload processing
    if payload is not None:
        op = payload.get("op")
        if op == "catalog":
            res = client.catalog()
            if not res.get("ok", True) and "error" in res:
                return f"Catalog error [{res.get('error')}]: {res.get('message', '')}"
            return format_catalog(res)

        if op == "validate":
            spec = payload.get("spec") or clean_draft(state["draft"])
            res = client.validate(spec)
            state["lastValidation"] = res
            return format_validation(res)

        if op == "publish":
            spec = payload.get("spec") or clean_draft(state["draft"])
            res = client.publish(spec)
            if res.get("ok"):
                state["published"] = res
                agent = res.get("agent", {})
                adopts = res.get("adoptions", [])
                ledger_act = res.get("ledger", {}).get("action", "AGENT_BUILT_BY_BUILDER")
                return (
                    f"Agent '{agent.get('id', spec.get('id'))}' successfully published in PENDING_BUDGET.\n"
                    f"Owner: {agent.get('owner', 'caller')}\n"
                    f"Skills adopted: {len(adopts)}\n"
                    f"Action: {ledger_act}"
                )
            return f"Publish failed [{res.get('error')}]: {res.get('message', '')}"

        if op == "set":
            patch = payload.get("draft") or payload.get("fields") or {}
            for k, v in patch.items():
                if k in state["draft"]:
                    state["draft"][k] = v
            return "Draft configuration updated.\n" + format_draft(state["draft"])

        if op == "reset":
            state["draft"] = empty_draft()
            state["lastValidation"] = None
            state["published"] = None
            return "Draft configuration reset."

        if "spec" in payload and not op:
            state["draft"] = payload["spec"]
            return "Draft spec loaded.\n" + format_draft(state["draft"])

    # Conversational / text command processing
    cmd = text_input.lower()

    if cmd in ("help", "?"):
        return HELP

    if cmd == "catalog":
        res = client.catalog()
        if not res.get("ok", True) and "error" in res:
            return f"Catalog error [{res.get('error')}]: {res.get('message', '')}"
        return format_catalog(res)

    if cmd in ("show", "status"):
        return format_draft(state["draft"])

    if cmd == "reset":
        state["draft"] = empty_draft()
        state["lastValidation"] = None
        state["published"] = None
        return "Draft configuration reset."

    if cmd.startswith("set id "):
        val = text_input[7:].strip()
        state["draft"]["id"] = val
        return f"Draft agent id set to: {val}"

    if cmd.startswith("set name "):
        val = text_input[9:].strip()
        state["draft"]["name"] = val
        return f"Draft agent name set to: {val}"

    if cmd.startswith("set description "):
        val = text_input[16:].strip()
        state["draft"]["description"] = val
        return f"Draft agent description set to: {val}"

    if cmd.startswith("set archetype "):
        val = text_input[14:].strip()
        if not isinstance(state["draft"].get("memory"), dict):
            state["draft"]["memory"] = {}
        state["draft"]["memory"]["archetype"] = val
        return f"Draft memory archetype set to: {val}"

    if cmd.startswith("set soul "):
        val = text_input[9:].strip()
        state["draft"]["soul"] = val
        return f"Draft soul updated ({len(val)} characters)."

    if cmd.startswith("add skill "):
        parts = text_input[10:].strip().split()
        if not parts:
            return "Usage: add skill <skill_id> [version]"
        skill_id = parts[0]
        version = parts[1] if len(parts) > 1 else None
        item: dict = {"id": skill_id}
        if version:
            item["version"] = version
        if not isinstance(state["draft"].get("skills"), list):
            state["draft"]["skills"] = []
        state["draft"]["skills"] = [s for s in state["draft"]["skills"] if s.get("id") != skill_id]
        state["draft"]["skills"].append(item)
        ver_text = f"@{version}" if version else ""
        return f"Added skill '{skill_id}{ver_text}' to draft."

    if cmd.startswith("remove skill "):
        skill_id = text_input[13:].strip()
        if isinstance(state["draft"].get("skills"), list):
            state["draft"]["skills"] = [s for s in state["draft"]["skills"] if s.get("id") != skill_id]
        return f"Removed skill '{skill_id}' from draft."

    if cmd.startswith("add role "):
        # e.g. add role Operator discord-progress,tavily
        rest = text_input[9:].strip()
        parts = rest.split(maxsplit=1)
        if len(parts) < 2:
            return "Usage: add role <role_name> <skill1,skill2,...>"
        role_name = parts[0]
        skill_names = [s.strip() for s in parts[1].split(",") if s.strip()]
        skill_dict = {sk: {"allow": ["*"]} for sk in skill_names}
        if not isinstance(state["draft"].get("roles"), list):
            state["draft"]["roles"] = []
        state["draft"]["roles"] = [r for r in state["draft"]["roles"] if r.get("name") != role_name]
        state["draft"]["roles"].append({"name": role_name, "skills": skill_dict})
        return f"Added role '{role_name}' with skills: {', '.join(skill_names)}"

    if cmd == "validate":
        spec = clean_draft(state["draft"])
        res = client.validate(spec)
        state["lastValidation"] = res
        return format_validation(res)

    if cmd == "publish":
        spec = clean_draft(state["draft"])
        res = client.publish(spec)
        if res.get("ok"):
            state["published"] = res
            agent = res.get("agent", {})
            adopts = res.get("adoptions", [])
            ledger_act = res.get("ledger", {}).get("action", "AGENT_BUILT_BY_BUILDER")
            return (
                f"Agent '{agent.get('id', spec.get('id'))}' successfully published in PENDING_BUDGET.\n"
                f"Owner: {agent.get('owner', 'caller')}\n"
                f"Skills adopted: {len(adopts)}\n"
                f"Action: {ledger_act}"
            )
        return f"Publish failed [{res.get('error')}]: {res.get('message', '')}"

    if cmd in ("wake", ""):
        return "Agent Builder online. Type `help` for instructions, or `catalog` to view available skills and archetypes."

    return f"Unrecognized command: '{text_input}'. Type `help` for available commands."
