"""Adopted skills (SK3, SK4). Python only: that is the current implementation (docs/SKILLS.md), not a design limit.

The factory's image build (SK4) places each adopted skill's folder at `/opt/factory/skills/<id>/`, pinned to the version
the factory recorded, and lists them in `/opt/factory/skills.json`. The runtime loads only the skills the agent's
configuration lists, never whatever else is in the folder. A skill's `skill.yaml` names its `entry` module; the module defines `tools()`, a list of
`{"name", "description", "parameters", "handler"}` where `handler(arguments: dict, context: dict) -> str`. The entry is a
file, a module or a package inside the skill folder; the folder is importable, nothing else is installed (standard library only).
A skill reaches only the routes the agent's policy grants: the gatekeeper-egress decides, not this loader.
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys
from pathlib import Path

ENTRY = re.compile(r"^entry:\s*([^\s#]+)", re.MULTILINE)
SAFE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
MAX_ARGUMENT_CHARS = 20000
MAX_RESULT_CHARS = 20000


class Tool:
    def __init__(self, skill: str, name: str, description: str, parameters: dict, handler):
        self.skill, self.name, self.description, self.parameters, self.handler = skill, name, description, parameters, handler

    def spec(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


def load_skills(adopted: list[dict], skills_dir: str | None = None, reserved: set[str] | None = None) -> tuple[list[Tool], list[str]]:
    """The tools of the skills the factory says this agent has adopted, and what could not be loaded (never fatal)."""
    root = Path(skills_dir or os.environ.get("SKILLS_DIR", "/opt/factory/skills"))
    tools: list[Tool] = []
    problems: list[str] = []
    seen: set[str] = set(reserved or ())  # a skill cannot shadow the archetype's own tools
    for item in adopted or []:
        sid = str(item.get("id", ""))
        if not SAFE_ID.match(sid):
            problems.append(f"skill id {sid!r} is not valid")
            continue
        folder = root / sid
        manifest = folder / "skill.yaml"
        try:
            entry = ENTRY.search(manifest.read_text("utf-8"))
            if not entry:
                raise ValueError("no entry in skill.yaml")
            named = entry.group(1)
            # `entry` is a path inside the skill folder or a dotted module (docs/SKILLS.md section 1).
            relative = named if named.endswith(".py") else named.replace(".", "/") + ".py"
            target = (folder / relative).resolve()
            # A dotted entry may name a package (`entry: tavily_search` with `tavily_search/__init__.py`), which SK1 accepts.
            if not named.endswith(".py") and not target.exists():
                target = (folder / named.replace(".", "/") / "__init__.py").resolve()
            if folder.resolve() not in target.parents:
                raise ValueError("entry leaves the skill folder")
            # The skill's own folder is importable while it loads, so its modules can import each other at the top of the
            # entry. It is last on the path (it never shadows the standard library or the runtime) and is taken off again, with
            # the modules it brought, so two skills never share a module and one cannot replace another's. Standard library
            # only otherwise: nothing is installed for a skill (docs/SKILLS.md).
            root_folder = folder.resolve()
            name = f"skill_{sid.replace('-', '_')}"
            spec = importlib.util.spec_from_file_location(name, target, submodule_search_locations=[str(target.parent)] if target.name == "__init__.py" else None)
            if spec is None or spec.loader is None:
                raise ValueError("cannot load entry")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            known = set(sys.modules)
            sys.path.append(str(root_folder))
            try:
                spec.loader.exec_module(module)
            except BaseException:
                sys.modules.pop(spec.name, None)
                raise
            finally:
                try:
                    sys.path.remove(str(root_folder))
                except ValueError:
                    pass
                for added in set(sys.modules) - known:
                    origin = getattr(sys.modules[added], "__file__", None)
                    if added != spec.name and not added.startswith(spec.name + ".") and origin and root_folder in Path(origin).resolve().parents:
                        del sys.modules[added]
            for t in module.tools():
                name = str(t["name"])
                if name in seen or not re.match(r"^[A-Za-z0-9_-]{1,64}$", name):
                    problems.append(f"skill {sid}: tool name {name!r} is duplicated or invalid")
                    continue
                seen.add(name)
                tools.append(Tool(sid, name, str(t.get("description", "")), t.get("parameters") or {"type": "object", "properties": {}}, t["handler"]))
        except Exception as err:  # a broken skill must not stop the agent answering
            problems.append(f"skill {sid}: {err}")
    return tools, problems


def run_tool(tool: Tool, raw_arguments: str, context: dict) -> str:
    if len(raw_arguments or "") > MAX_ARGUMENT_CHARS:
        return "error: arguments too large"
    try:
        import json

        args = json.loads(raw_arguments) if raw_arguments else {}
        if not isinstance(args, dict):
            return "error: arguments must be an object"
        return str(tool.handler(args, context))[:MAX_RESULT_CHARS]
    except Exception as err:
        return f"error: {err}"[:2000]
