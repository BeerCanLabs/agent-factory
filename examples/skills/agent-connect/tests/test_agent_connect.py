import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agent_connect as ac  # noqa: E402


class AgentConnectTests(unittest.TestCase):
    def tools(self):
        return {t["name"]: t["handler"] for t in ac.tools()}

    def test_call_agent_returns_tagged_intent(self):
        out = self.tools()["call_agent"]({"agent": "donna", "speaker": "dale"}, {})
        self.assertTrue(out.startswith("FACTORY_CALL_INTENT:"))
        intent = json.loads(out.split(":", 1)[1])
        self.assertEqual(intent, {"action": "call", "agent": "donna", "speaker": "dale"})

    def test_call_agent_uses_stamped_caller(self):
        out = self.tools()["call_agent"](
            {"agent": "higgins"},
            {"caller": {"actor": "user:dale.sackrider", "verified": True}},
        )
        intent = json.loads(out.split(":", 1)[1])
        self.assertEqual(intent["speaker"], "user:dale.sackrider")
        self.assertEqual(intent["agent"], "higgins")

    def test_ask_agent_dry_run(self):
        out = json.loads(
            self.tools()["ask_agent"](
                {"agent": "donna", "message": "add lunch", "speaker": "dale", "dryRun": True},
                {},
            )
        )
        self.assertTrue(out["ok"])
        self.assertEqual(out["mode"], "errand")

    def test_child_speaker_is_refused(self):
        ctx = {"caller": {"actor": "user:kid", "relationship": "child"}}
        call = json.loads(self.tools()["call_agent"]({"agent": "donna", "speaker": "dale"}, ctx))
        self.assertEqual(call["error"], "child_restricted")
        ask = json.loads(self.tools()["ask_agent"]({"agent": "donna", "message": "hi", "speaker": "dale", "dryRun": True}, ctx))
        self.assertEqual(ask["error"], "child_restricted")


if __name__ == "__main__":
    unittest.main()
