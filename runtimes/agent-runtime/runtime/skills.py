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
import json
import os
import re
import sys
import traceback
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
    loaded_vendored: dict[str, str] = {}  # top-level vendored module -> skill id (A2)
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
            vendor_folder = root_folder / "vendor"

            # Check A2 collision for vendored top-level modules
            current_vendored: list[str] = []
            if vendor_folder.is_dir():
                for v_item in sorted(vendor_folder.iterdir()):
                    if v_item.name.startswith(".") or v_item.name == "__pycache__":
                        continue
                    mod_name = None
                    if v_item.is_file() and v_item.suffix == ".py":
                        mod_name = v_item.stem
                    elif v_item.is_dir():
                        mod_name = v_item.name
                    if mod_name:
                        if mod_name in loaded_vendored:
                            raise ValueError(
                                f"vendored module {mod_name!r} collides with module from skill {loaded_vendored[mod_name]!r}"
                            )
                        current_vendored.append(mod_name)

            name = f"skill_{sid.replace('-', '_')}"
            spec = importlib.util.spec_from_file_location(name, target, submodule_search_locations=[str(target.parent)] if target.name == "__init__.py" else None)
            if spec is None or spec.loader is None:
                raise ValueError("cannot load entry")
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            known = set(sys.modules)
            path_list, path_before = sys.path, list(sys.path)

            # A2 path precedence: skill root before vendor
            sys.path.append(str(root_folder))
            if vendor_folder.is_dir():
                sys.path.append(str(vendor_folder))
            try:
                spec.loader.exec_module(module)
            except BaseException:
                # A failed load leaves nothing of the skill: not the entry, and not its submodules.
                for gone in [m for m in sys.modules if m == spec.name or m.startswith(spec.name + ".")]:
                    sys.modules.pop(gone, None)
                raise  # policy: only Exception and SystemExit are a broken skill (below); KeyboardInterrupt still stops the runtime
            finally:
                # Its modules are judged while its folder is still on the path; then the path is put back as it was, whatever the
                # skill did to it (added its own folder again, inserted another).
                for added in set(sys.modules) - known:
                    if added == spec.name or added.startswith(spec.name + "."):
                        continue
                    mod = sys.modules[added]
                    origin = getattr(mod, "__file__", None)
                    # A namespace package has no file: it is the skill's own when every place it is found is in the folder.
                    places = [str(x) for x in getattr(mod, "__path__", [])] if origin is None else []
                    if (origin and root_folder in Path(origin).resolve().parents) or (places and all(root_folder in [Path(x).resolve(), *Path(x).resolve().parents] for x in places)):
                        del sys.modules[added]
                sys.path = path_list
                path_list[:] = path_before
                importlib.invalidate_caches()
                for place in [k for k in sys.path_importer_cache if k == str(root_folder) or k.startswith(str(root_folder) + os.sep) or k == str(vendor_folder) or k.startswith(str(vendor_folder) + os.sep)]:
                    del sys.path_importer_cache[place]
            for t in module.tools():
                name = str(t["name"])
                if name in seen or not re.match(r"^[A-Za-z0-9_-]{1,64}$", name):
                    problems.append(f"skill {sid}: tool name {name!r} is duplicated or invalid")
                    continue
                seen.add(name)
                tools.append(Tool(sid, name, str(t.get("description", "")), t.get("parameters") or {"type": "object", "properties": {}}, t["handler"]))

            for mod_name in current_vendored:
                loaded_vendored[mod_name] = sid
        except (Exception, SystemExit) as err:  # a broken skill (even one that exits at import) must not stop the agent answering
            problems.append(f"skill {sid}: {err}")
    return tools, problems


# GAP-254: a tool that fails is logged (the container's stderr), not only told to the model. The line (the label too) is
# cut to MASK_WINDOW characters, masked whole, then cut to MAX_LOG_CHARS: the run token by value, including a cut-off end
# of it, and anything shaped like a credential. Every pattern is bounded, so masking is linear in the (bounded) input.
# Arguments and results are never logged whole. (RT2: the runtime reads named variables only, so a bound secret is masked
# by its shape, not by its value.)
CREDENTIAL_SHAPES = re.compile(
    r"-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----.*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)"  # a PEM private key, even cut off
    r"|(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*"  # a JWT
    r"|(?i:bearer|token|basic)\s{1,8}[A-Za-z0-9._~+/=-]{8,}"
    # Provider tokens, case-sensitive and starting a word, so `task-scheduler` or `risk-analysis` are left alone.
    r"|(?<![A-Za-z0-9])(?:github_pat_\w{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{12,})",
    re.DOTALL,
)
# `password: x`, `?access_token=x`, `"token": "x"`, `aws_secret_access_key=x`, `Authorization: Basic x`, `Cookie: x`:
# the name stays.
CREDENTIAL_SETTING = re.compile(
    r"""(?i)([A-Za-z0-9_.-]{0,64}(?:token|secret|password|passwd|api[_-]?key|authorization|private[_-]?key|access[_-]?key|credential|cookie|session)[A-Za-z0-9_.-]{0,64}["']?\s{0,8}[:=]\s{0,8}["']?)"""
    r"""(?:(?:bearer|basic|token)\s{1,8})?[^\s"'&,;}\]]+"""
)
URL_USERINFO = re.compile(r"(?i)(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}://)[^/\s@]{1,256}@")
MAX_LOG_CHARS = 1000
MASK_WINDOW = 4 * MAX_LOG_CHARS


def _mask(text: str) -> str:
    token = os.environ.get("FACTORY_RUN_TOKEN") or ""
    if len(token) >= 8:
        text = text.replace(token, "***")
        # Text cut short (here or before it reached the runtime) can end in the start of the token.
        for n in range(len(token) - 1, 7, -1):
            if text.endswith(token[:n]):
                text = text[:-n] + "***"
                break
    text = CREDENTIAL_SHAPES.sub("***", text)
    text = CREDENTIAL_SETTING.sub(lambda m: m.group(1) + "***", text)
    return URL_USERINFO.sub(lambda m: m.group(1) + "***@", text)


def log_tool_error(label: str, what: str) -> None:
    head = f"[runtime] tool {label} failed: {what}"[: MASK_WINDOW * 2]
    line = " ".join(head.split())[:MASK_WINDOW]
    print(_mask(line)[:MAX_LOG_CHARS], file=sys.stderr, flush=True)


def _where(err: BaseException) -> str:
    frames = traceback.extract_tb(err.__traceback__)
    if not frames:
        return ""
    last = frames[-1]
    return f" at {Path(last.filename).name}:{last.lineno} in {last.name}"


def _reported_error(out: str) -> str | None:
    """A result in which the tool itself reports failure: `error: ...` text, or a JSON object with `error` or `action: error`."""
    head = out.lstrip()
    if head.lower().startswith("error:"):
        return head  # masked whole, then cut short, by log_tool_error
    if head.startswith("{"):
        try:
            obj = json.loads(out)
        except ValueError:
            return None
        if isinstance(obj, dict) and (obj.get("action") == "error" or obj.get("error")):
            return str(obj.get("reason") or obj.get("error") or "error")
    return None


def run_tool(tool: Tool, raw_arguments: str, context: dict) -> str:
    label = f"{tool.skill}/{tool.name}"
    if len(raw_arguments or "") > MAX_ARGUMENT_CHARS:
        log_tool_error(label, f"arguments too large ({len(raw_arguments)} characters)")
        return "error: arguments too large"
    try:
        args = json.loads(raw_arguments) if raw_arguments else {}
        if not isinstance(args, dict):
            log_tool_error(label, "arguments must be an object")
            return "error: arguments must be an object"
        out = str(tool.handler(args, context))[:MAX_RESULT_CHARS]
    except Exception as err:
        log_tool_error(label, f"{type(err).__name__}: {err}{_where(err)}")
        return f"error: {err}"[:2000]
    reported = _reported_error(out)
    if reported is not None:
        log_tool_error(label, f"reported: {reported}")
    return out
