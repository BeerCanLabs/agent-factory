"""Interview state for the Personal Trainer. No model call lives here: the factory scores on the skill account."""

from __future__ import annotations

import json
import re
from pathlib import Path

HELP = (
    "I train one skill at a time. I will not change its instructions.\n"
    "Tell me the skill id (`skill summarize`), then a case "
    "(`case short | a long note | contains:brief`), then the models to compare (`models small, large`).\n"
    "After each pinned run, report the output (`trial small | short | a brief note | 0.20`).\n"
    "Say `recommend` when you want the cheapest model that passed every case. "
    "I do not deploy it. Say `status` to see where we are."
)


def empty_state() -> dict:
    return {"skillId": None, "cases": [], "models": [], "trials": {}}


def load_state(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text("utf-8"))
    return empty_state()


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2), "utf-8")


def _parse_assertion(text: str) -> dict | None:
    if text.startswith("contains:"):
        return {"contains": text[len("contains:") :]}
    if text.startswith("equals:"):
        return {"equals": text[len("equals:") :]}
    if text.startswith("matches:"):
        return {"matches": text[len("matches:") :]}
    return None


def _passes(output: str, case: dict) -> bool:
    if "equals" in case and output != case["equals"]:
        return False
    if "contains" in case and case["contains"] not in output:
        return False
    if "matches" in case:
        try:
            if re.search(case["matches"], output) is None:
                return False
        except re.error:
            return False
    return any(k in case for k in ("equals", "contains", "matches"))


def recommend(state: dict) -> dict | None:
    winners = []
    for model, trial in state["trials"].items():
        if trial["failed"] == 0 and trial["passed"] == len(state["cases"]) and state["cases"]:
            winners.append({"model": model, "costUsd": trial["costUsd"]})
    if not winners:
        return None
    return min(winners, key=lambda w: w["costUsd"])


def turn(state: dict, message: str) -> str:
    text = (message or "").strip()
    if not text or text.lower() in {"help", "wake"}:
        return HELP

    if text.lower() == "status":
        return (
            f"Skill: {state['skillId'] or '(none)'}. "
            f"Cases: {len(state['cases'])}. Models: {', '.join(state['models']) or '(none)'}. "
            f"Trials: {len(state['trials'])}."
        )

    if text.lower().startswith("skill "):
        skill_id = text.split(None, 1)[1].strip()
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill_id):
            return "A skill id is kebab-case, like summarize or ticket-triage."
        state["skillId"] = skill_id
        state["cases"] = []
        state["trials"] = {}
        return f"We are training `{skill_id}`. Give me the first case. A case is a name, an input, and one check."

    if text.lower().startswith("case "):
        if not state["skillId"]:
            return "Name the skill first: `skill summarize`."
        parts = [p.strip() for p in text.split(" ", 1)[1].split("|")]
        if len(parts) != 3:
            return "A case looks like `case short | a long note | contains:brief`."
        assertion = _parse_assertion(parts[2])
        if not assertion:
            return "End the case with contains:..., equals:..., or matches:..."
        state["cases"] = [c for c in state["cases"] if c["name"] != parts[0]]
        state["cases"].append({"name": parts[0], "input": parts[1], **assertion})
        state["trials"] = {}
        return f"Recorded case `{parts[0]}`. Add another case, or list models with `models small, large`."

    if text.lower().startswith("models "):
        if not state["cases"]:
            return "Add a case before choosing models. The scorecard has to exist first."
        models = [m.strip() for m in text.split(None, 1)[1].split(",") if m.strip()]
        if len(models) < 2:
            return "Name at least two models, separated by commas."
        state["models"] = models
        return (
            "Run each model pinned on these cases, then report each output: "
            "`trial <model> | <case> | <output> | <cost>`."
        )

    if text.lower().startswith("trial "):
        if not state["models"]:
            return "List the models before reporting a trial."
        parts = [p.strip() for p in text.split(" ", 1)[1].split("|")]
        if len(parts) != 4:
            return "A trial looks like `trial small | short | a brief note | 0.20`."
        model, name, output, cost_text = parts
        if model not in state["models"]:
            return f"`{model}` is not in the model list."
        case = next((c for c in state["cases"] if c["name"] == name), None)
        if not case:
            return f"There is no case named `{name}`."
        try:
            cost = float(cost_text)
        except ValueError:
            return "The cost has to be a number of dollars."
        trial = state["trials"].setdefault(model, {"passed": 0, "failed": 0, "costUsd": 0.0, "seen": []})
        if name in trial["seen"]:
            return f"I already have `{name}` for `{model}`."
        trial["seen"].append(name)
        trial["costUsd"] = round(trial["costUsd"] + cost, 6)
        if _passes(output, case):
            trial["passed"] += 1
            verdict = "pass"
        else:
            trial["failed"] += 1
            verdict = "fail"
        missing = [c["name"] for c in state["cases"] if c["name"] not in trial["seen"]]
        if missing:
            return f"`{model}` / `{name}` is a {verdict}. Still need: {', '.join(missing)}."
        return f"`{model}` finished: {trial['passed']} passed, {trial['failed']} failed, ${trial['costUsd']:.4f}. Say `recommend` when every model is in."

    if text.lower() == "recommend":
        if not state["skillId"] or not state["cases"]:
            return "There is no scorecard yet."
        choice = recommend(state)
        if not choice:
            return "No model passed every case. Bring another trial, or tighten the case only if the check was wrong. I will not rewrite the skill."
        return (
            f"Recommend `{choice['model']}` for `{state['skillId']}` at ${choice['costUsd']:.4f} per pass of this scorecard. "
            "I have not changed the skill. Accepting it is a new skill version, and a person admits that version. "
            "Agents that later adopt it pay for it from their own budget."
        )

    return "I didn't catch that. Say `help` for the four steps: skill, case, models, trial."
