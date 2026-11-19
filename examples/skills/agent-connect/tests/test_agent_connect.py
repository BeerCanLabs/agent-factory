import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_connect as ac  # noqa: E402


def test_call_agent_returns_tagged_intent():
    tools = {t["name"]: t["handler"] for t in ac.tools()}
    out = tools["call_agent"]({"agent": "donna", "speaker": "dale"}, {})
    assert out.startswith("FACTORY_CALL_INTENT:")
    intent = json.loads(out.split(":", 1)[1])
    assert intent == {"action": "call", "agent": "donna", "speaker": "dale"}


def test_call_agent_uses_stamped_caller():
    tools = {t["name"]: t["handler"] for t in ac.tools()}
    out = tools["call_agent"]({"agent": "higgins"}, {"caller": {"actor": "user:dale.sackrider", "verified": True}})
    intent = json.loads(out.split(":", 1)[1])
    assert intent["speaker"] == "user:dale.sackrider"
    assert intent["agent"] == "higgins"


def test_ask_agent_dry_run():
    tools = {t["name"]: t["handler"] for t in ac.tools()}
    out = json.loads(tools["ask_agent"]({"agent": "donna", "message": "add lunch", "speaker": "dale", "dryRun": True}, {}))
    assert out["ok"] is True
    assert out["mode"] == "errand"
