"""Family message relay: Discord DM to the owner plus pending notes on their next turn."""
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from runtime.factory import Factory, FactoryError  # noqa: E402
from runtime.relay import (  # noqa: E402
    leave_message,
    load_pending,
    mark_unseen_delivered,
    pending_note,
    unseen_for,
)
from runtime.loop import system_prompt  # noqa: E402
from test_runtime import FakeFactory, PA, turn  # noqa: E402
from runtime import loop  # noqa: E402

DALE = "user:dale.sackrider"
STEPH = "user:stephaniesackrider"
DALE_DISCORD = "470400107028938752"
OWNERS = [
    {
        "actor": DALE,
        "name": "Dale",
        "aliases": [DALE, "cloudflare:dale.sackrider@gmail.com"],
        "discordUserIds": [DALE_DISCORD],
    }
]


class RelayStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mind = Path(self.tmp.name) / "mind"
        self.mind.mkdir()
        self.sent: list[tuple[str, str]] = []

    def tearDown(self):
        self.tmp.cleanup()

    def _send(self, user_id: str, content: str) -> dict:
        self.sent.append((user_id, content))
        return {"channelId": "dm-1", "messageId": "mid-1"}

    def test_family_message_is_stored_and_dm_is_attributed(self):
        out = leave_message(
            memory_dir=self.mind,
            owners=OWNERS,
            caller={"actor": STEPH, "name": "Stephanie", "relationship": "family"},
            content="Pick up the kids at 7.",
            send_dm=self._send,
            now=datetime(2026, 11, 19, 17, 18, tzinfo=timezone.utc),
        )
        self.assertTrue(out["ok"])
        self.assertTrue(out["stored"])
        self.assertEqual(out["discord"], {"ok": True, "channelId": "dm-1", "messageId": "mid-1"})
        self.assertEqual(self.sent, [(DALE_DISCORD, "Message from Stephanie: Pick up the kids at 7.")])
        pending = unseen_for("cloudflare:dale.sackrider@gmail.com", self.mind, OWNERS)
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["content"], "Pick up the kids at 7.")
        self.assertIn("Stephanie", pending_note(DALE, self.mind, OWNERS))
        self.assertEqual(pending_note(STEPH, self.mind, OWNERS), "")

    def test_non_family_caller_is_refused_and_sends_nothing(self):
        out = leave_message(
            memory_dir=self.mind,
            owners=OWNERS,
            caller={"actor": STEPH, "name": "Stephanie", "relationship": "owner"},
            content="hello",
            send_dm=self._send,
        )
        self.assertEqual(out["error"], "not_family")
        self.assertEqual(self.sent, [])
        self.assertEqual(load_pending(self.mind), [])

    def test_a_failed_dm_still_stores_the_pending_note(self):
        def fail(user_id: str, content: str):
            raise FactoryError(403, {"error": "forbidden"})

        out = leave_message(
            memory_dir=self.mind,
            owners=OWNERS,
            caller={"actor": STEPH, "name": "Stephanie", "relationship": "family"},
            content="Still tell him.",
            send_dm=fail,
        )
        self.assertTrue(out["ok"])
        self.assertTrue(out["stored"])
        self.assertFalse(out["discord"]["ok"])
        self.assertEqual(len(unseen_for(DALE, self.mind, OWNERS)), 1)

    def test_owner_turn_marks_unseen_messages_delivered_once(self):
        leave_message(
            memory_dir=self.mind,
            owners=OWNERS,
            caller={"actor": STEPH, "name": "Stephanie", "relationship": "family"},
            content="[TEST from Agent Factory] hi",
            send_dm=self._send,
        )
        self.assertTrue(pending_note(DALE, self.mind, OWNERS))
        marked = mark_unseen_delivered(DALE, self.mind, OWNERS, now=datetime(2026, 11, 19, 17, 20, tzinfo=timezone.utc))
        self.assertEqual(len(marked), 1)
        self.assertEqual(pending_note(DALE, self.mind, OWNERS), "")
        self.assertEqual(mark_unseen_delivered(DALE, self.mind, OWNERS), [])

    def test_system_prompt_includes_pending_note(self):
        prompt = system_prompt("Be helpful.", {"caller": {"actor": DALE, "name": "Dale"}}, "You have unseen messages.")
        self.assertIn("You are speaking with Dale.", prompt)
        self.assertIn("You have unseen messages.", prompt)


class RelayLoop(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.mind = Path(self.tmp.name) / "mind"
        self.result = Path(self.tmp.name) / "result.json"
        os.environ["MEMORY_DIR"] = str(self.mind)
        os.environ["FACTORY_RESULT_FILE"] = str(self.result)
        os.environ["SKILLS_DIR"] = str(Path(self.tmp.name) / "skills")
        self.fakes = []

    def tearDown(self):
        for f in self.fakes:
            f.stop()
        for k in ("MEMORY_DIR", "FACTORY_RESULT_FILE", "SKILLS_DIR"):
            os.environ.pop(k, None)
        self.tmp.cleanup()

    def test_family_turn_dms_the_owner_and_the_next_owner_turn_sees_it_once(self):
        config = {**PA, "owners": OWNERS}
        calls = {"n": 0}

        def model(messages, tools):
            names = {t["function"]["name"] for t in (tools or []) if isinstance(t, dict) and t.get("function")}
            self.assertIn("relay_message_to_owner", names)
            system = messages[0]["content"]
            calls["n"] += 1
            if "tell dale" in messages[-1]["content"].lower() and "tool" not in {m.get("role") for m in messages}:
                return {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "r1",
                            "type": "function",
                            "function": {
                                "name": "relay_message_to_owner",
                                "arguments": json.dumps({"content": "[TEST from Agent Factory] Stephanie relay test"}),
                            },
                        }
                    ],
                }
            if any(m.get("role") == "tool" for m in messages):
                return {"role": "assistant", "content": "I sent Dale a Discord DM and stored the message."}
            if "unseen messages" in system or "From Stephanie" in system:
                return {"role": "assistant", "content": "Stephanie left a test message from Agent Factory for you."}
            return {"role": "assistant", "content": "Nothing pending."}

        family = {
            "message": "tell dale: [TEST from Agent Factory] Stephanie relay test",
            "caller": {"actor": STEPH, "name": "Stephanie", "relationship": "family"},
            "turnId": "t-family",
            "replyTo": {"channel": "console"},
        }
        owner1 = turn("any messages?", actor=DALE)
        owner1["caller"] = {"actor": DALE, "name": "Dale", "relationship": "owner"}
        owner2 = turn("anything else?", actor=DALE)
        owner2["caller"] = {"actor": DALE, "name": "Dale", "relationship": "owner"}
        owner2["turnId"] = "t3"

        fake = FakeFactory(config, [family], model)
        self.fakes.append(fake)
        self.assertEqual(loop.main(Factory(fake.env())), 0)
        dm_open = [r for r in fake.requests if r[1] == "/discord/users/@me/channels"]
        dm_post = [r for r in fake.requests if r[1].startswith("/discord/channels/") and r[1].endswith("/messages")]
        self.assertEqual(len(dm_open), 1, fake.requests)
        self.assertEqual(dm_open[0][2], {"recipient_id": DALE_DISCORD})
        self.assertEqual(len(dm_post), 1)
        self.assertIn("Message from Stephanie:", dm_post[0][2]["content"])
        self.assertIn("[TEST from Agent Factory] Stephanie relay test", dm_post[0][2]["content"])

        # Second run, still warm-path separate wakes: owner is told once, then not again.
        fake2 = FakeFactory(config, [owner1], model)
        self.fakes.append(fake2)
        # Reuse the same mind dir so pending notes persist.
        self.assertEqual(loop.main(Factory(fake2.env())), 0)
        owner_replies = [r[2]["content"] for r in fake2.requests if r[1].endswith("/reply")]
        self.assertTrue(any("Stephanie" in c and "test" in c.lower() for c in owner_replies), owner_replies)

        fake3 = FakeFactory(config, [owner2], model)
        self.fakes.append(fake3)
        self.assertEqual(loop.main(Factory(fake3.env())), 0)
        later = [r[2]["content"] for r in fake3.requests if r[1].endswith("/reply")]
        self.assertEqual(later, ["Nothing pending."])


if __name__ == "__main__":
    unittest.main()
