"""Interview for the Personal Trainer.

The cartridge remembers the conversation. The factory scores trials, charges the skill
training account, and chooses the model. This module does not grade outputs.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

HELP = (
    "I train one skill at a time. I will not change its instructions.\n"
    "Tell me the skill id (`skill summarize`). I will check that the skill has a training cap.\n"
    "Then give a case (`case short | a long note | contains:brief`) and the models "
    "(`models small, large`).\n"
    "After each pinned run, report the output (`trial small | short | a brief note | 0.20`). "
    "I send a finished model to the factory to score and to charge the skill.\n"
    "Say `recommend` for the factory's cheapest model that passed. I do not deploy it."
)


def empty_state() -> dict:
    return {"skillId": None, "capped": False, "cases": [], "models": [], "pending": {}, "posted": False}


def load_state(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text("utf-8"))
    return empty_state()


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2), "utf-8")


class FactoryClient:
    """Posts training ops to this run's control-plane URL with the run token.

    That is the same channel a cartridge uses for its input and result. There is no
    provider host and no static API token. A missing run token cannot score.
    """

    def __init__(self, base_url: str | None = None, run_id: str | None = None, token: str | None = None):
        self.base_url = (base_url if base_url is not None else os.environ.get("FACTORY_URL", "")).rstrip("/")
        self.run_id = run_id if run_id is not None else os.environ.get("FACTORY_RUN_ID", "")
        self.token = token if token is not None else os.environ.get("FACTORY_RUN_TOKEN", "")

    def _request(self, body: dict) -> dict:
        if not self.base_url or not self.run_id or not self.token:
            return {"error": "factory_unconfigured"}
        req = urllib.request.Request(
            f"{self.base_url}/api/v1/runs/{self.run_id}/training",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"content-type": "application/json", "authorization": f"Bearer {self.token}"},
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
            parsed["error"] = parsed.get("error") or f"http_{err.code}"
            parsed["status"] = err.code
            return parsed

    def account(self, skill_id: str) -> dict:
        return self._request({"op": "account", "skillId": skill_id})

    def baseline(self, skill_id: str, cases: list) -> dict:
        return self._request({"op": "baseline", "skillId": skill_id, "cases": cases})

    def run(self, skill_id: str, model: str, cost: float, outputs: list) -> dict:
        return self._request({"op": "run", "skillId": skill_id, "model": model, "costUsd": cost, "outputs": outputs})

    def recommend(self, skill_id: str) -> dict:
        return self._request({"op": "recommend", "skillId": skill_id})


def _parse_assertion(text: str) -> dict | None:
    if text.startswith("contains:"):
        return {"contains": text[len("contains:") :]}
    if text.startswith("equals:"):
        return {"equals": text[len("equals:") :]}
    if text.startswith("matches:"):
        return {"matches": text[len("matches:") :]}
    return None


def _refuse(result: dict) -> str | None:
    error = result.get("error")
    if not error:
        return None
    if error == "factory_unconfigured":
        return "This run has no factory URL or run token, so I cannot score. I will not call a model provider myself."
    if error in {"training_budget_required", "training_budget_exceeded"}:
        return "The skill's training account cannot pay for that. Raise the cap, or stop. I will not score it myself."
    if error == "training_no_winner":
        return "The factory has no model that passed every case. I will not pick one locally."
    return f"The factory refused that ({error})."


def turn(state: dict, message: str, factory: FactoryClient | None = None) -> str:
    client = factory if factory is not None else FactoryClient()
    text = (message or "").strip()
    if not text or text.lower() in {"help", "wake"}:
        return HELP

    if text.lower() == "status":
        cap = "set" if state.get("capped") else "missing"
        return (
            f"Skill: {state.get('skillId') or '(none)'}. Training cap: {cap}. "
            f"Cases: {len(state['cases'])}. Models: {', '.join(state['models']) or '(none)'}."
        )

    if text.lower().startswith("skill "):
        skill_id = text.split(None, 1)[1].strip()
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", skill_id):
            return "A skill id is kebab-case, like summarize or ticket-triage."
        account = client.account(skill_id)
        refused = _refuse(account)
        if refused:
            return refused
        state["skillId"] = skill_id
        state["cases"] = []
        state["models"] = []
        state["pending"] = {}
        state["posted"] = False
        if not account.get("capUsd"):
            state["capped"] = False
            return (
                f"`{skill_id}` has no training cap, so I will stop. "
                f"Set one with PUT /api/v1/skills/{skill_id}/training-account and tell me the skill again."
            )
        state["capped"] = True
        return f"We are training `{skill_id}`. The training cap is ${account['capUsd']}. Give me the first case."

    if not state.get("capped"):
        return "Set a training cap on the skill and tell me the skill id again. I will not collect cases before that."

    if text.lower().startswith("case "):
        parts = [p.strip() for p in text.split(" ", 1)[1].split("|")]
        if len(parts) != 3:
            return "A case looks like `case short | a long note | contains:brief`."
        assertion = _parse_assertion(parts[2])
        if not assertion:
            return "End the case with contains:..., equals:..., or matches:..."
        state["cases"] = [c for c in state["cases"] if c["name"] != parts[0]]
        state["cases"].append({"name": parts[0], "input": parts[1], **assertion})
        state["pending"] = {}
        state["posted"] = False
        return f"Recorded case `{parts[0]}`. Add another case, or list models with `models small, large`."

    if text.lower().startswith("models "):
        if not state["cases"]:
            return "Add a case before choosing models. The scorecard has to exist first."
        models = [m.strip() for m in text.split(None, 1)[1].split(",") if m.strip()]
        if len(models) < 2:
            return "Name at least two models, separated by commas."
        saved = client.baseline(state["skillId"], state["cases"])
        refused = _refuse(saved)
        if refused:
            return refused
        state["models"] = models
        state["pending"] = {}
        state["posted"] = True
        return "The factory has the scorecard. Report each output: `trial <model> | <case> | <output> | <cost>`."

    if text.lower().startswith("trial "):
        if not state.get("posted"):
            return "List the models first so I can store the scorecard on the factory."
        parts = [p.strip() for p in text.split(" ", 1)[1].split("|")]
        if len(parts) != 4:
            return "A trial looks like `trial small | short | a brief note | 0.20`."
        model, name, output, cost_text = parts
        if model not in state["models"]:
            return f"`{model}` is not in the model list."
        if not any(c["name"] == name for c in state["cases"]):
            return f"There is no case named `{name}`."
        try:
            cost = float(cost_text)
        except ValueError:
            return "The cost has to be a number of dollars."
        bucket = state["pending"].setdefault(model, {})
        if name in bucket:
            return f"I already have `{name}` for `{model}`."
        bucket[name] = {"output": output, "cost": cost}
        missing = [c["name"] for c in state["cases"] if c["name"] not in bucket]
        if missing:
            return f"Holding `{model}` / `{name}` for the factory. Still need: {', '.join(missing)}."
        result = client.run(
            state["skillId"],
            model,
            round(sum(item["cost"] for item in bucket.values()), 6),
            [{"name": case["name"], "output": bucket[case["name"]]["output"]} for case in state["cases"]],
        )
        refused = _refuse(result)
        if refused:
            del state["pending"][model]
            return refused
        return (
            f"The factory scored `{model}`: {result['passed']} passed, {result['failed']} failed, "
            f"${result['costUsd']:.4f} posted to the skill. Say `recommend` when every model is in."
        )

    if text.lower() == "recommend":
        if not state.get("skillId") or not state.get("posted"):
            return "There is no scorecard on the factory yet."
        choice = client.recommend(state["skillId"])
        refused = _refuse(choice)
        if refused:
            return refused
        rec = choice["recommendation"]
        return (
            f"The factory recommends `{rec['model']}` for `{state['skillId']}` at ${rec['costUsd']:.4f}. "
            "I have not changed the skill. Accepting it is a new skill version, and a person admits that version."
        )

    return "I didn't catch that. Say `help` for the steps: skill, case, models, trial."
