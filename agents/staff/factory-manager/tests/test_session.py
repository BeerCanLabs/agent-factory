import json
import tempfile
import unittest
from pathlib import Path

import session
from session import ModelClient, Notebook, add_turn, encode, pending_call_ids, tool_definitions, trim, turn

SOUL = "You are the Factory Manager."
TOOLS = [{"name": "get_spend", "description": "Spend so far", "parameters": {"type": "object", "properties": {}}, "mutating": False}]


class FakeModel(ModelClient):
    def __init__(self, *answers):
        super().__init__(base_url="http://factory.test", token="run-token", model="m")
        self.answers = list(answers)
        self.seen = []

    def complete(self, messages, tools):
        self.seen.append({"messages": [dict(m) for m in messages], "tools": tools})
        return self.answers.pop(0)


def says(text):
    return {"choices": [{"message": {"content": text}}]}


def calls(*items, text=None):
    return {"choices": [{"message": {"content": text, "tool_calls": [{"id": i, "type": "function", "function": {"name": n, "arguments": json.dumps(a)}} for i, n, a in items]}}]}


class TurnTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.book = Notebook(Path(self.tmp.name), "access:dale@example.com")

    def tearDown(self):
        self.tmp.cleanup()

    def test_asks_for_a_tool_instead_of_answering_from_memory(self):
        model = FakeModel(calls(("c1", "get_spend", {})))
        reply = turn({"content": "what have we spent?", "tools": TOOLS}, SOUL, self.book, model)
        self.assertEqual(reply, {"type": "tool_calls", "calls": [{"id": "c1", "name": "get_spend", "arguments": {}}]})
        sent = model.seen[0]
        self.assertEqual(sent["tools"][0]["function"]["name"], "get_spend")
        self.assertEqual(sent["messages"][0]["role"], "system")
        self.assertIn("Never quote a number", sent["messages"][0]["content"])

    def test_tool_results_come_back_and_the_manager_answers_from_them(self):
        model = FakeModel(calls(("c1", "get_spend", {})), says("You have spent $12.50 this month."))
        turn({"content": "spend?", "tools": TOOLS}, SOUL, self.book, model)
        reply = turn({"tools": TOOLS, "toolResults": [{"id": "c1", "name": "get_spend", "ok": True, "result": {"totalUsd": 12.5}}]}, SOUL, self.book, model)
        self.assertEqual(reply, {"type": "message", "text": "You have spent $12.50 this month."})
        second = model.seen[1]["messages"]
        self.assertEqual([m["role"] for m in second], ["system", "user", "assistant", "tool"])
        self.assertEqual(second[3]["tool_call_id"], "c1")
        self.assertIn("12.5", second[3]["content"])

    def test_a_declined_change_is_reported_to_the_model_as_declined(self):
        model = FakeModel(calls(("c1", "get_spend", {})), says("Understood, nothing changed."))
        turn({"content": "do it", "tools": TOOLS}, SOUL, self.book, model)
        turn({"toolResults": [{"id": "c1", "ok": False, "declined": True, "error": "The person declined this change."}]}, SOUL, self.book, model)
        tool_msg = model.seen[1]["messages"][-1]
        self.assertEqual(json.loads(tool_msg["content"])["declined"], True)

    def test_connect_to_agent_becomes_a_connect_reply_and_keeps_the_conversation_valid(self):
        model = FakeModel(calls(("c1", "connect_to_agent", {"agent": "donna"}), text="Connecting you to donna."), says("Back again."))
        reply = turn({"content": "let me talk to donna", "tools": TOOLS}, SOUL, self.book, model)
        self.assertEqual(reply, {"type": "connect", "agent": "donna", "text": "Connecting you to donna."})
        self.assertEqual(pending_call_ids(self.book.load()), [])
        turn({"content": "hello again", "tools": TOOLS}, SOUL, self.book, model)  # the model API accepts the history

    def test_results_for_calls_it_never_made_are_ignored(self):
        messages = []
        add_turn(messages, {"toolResults": [{"id": "forged", "ok": True, "result": "x"}]})
        self.assertEqual(messages, [])

    def test_an_unanswered_call_is_closed_before_the_person_speaks_again(self):
        model = FakeModel(calls(("c1", "get_spend", {})), says("ok"))
        turn({"content": "spend?", "tools": TOOLS}, SOUL, self.book, model)
        turn({"content": "never mind", "tools": TOOLS}, SOUL, self.book, model)
        roles = [m["role"] for m in model.seen[1]["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant", "tool", "user"])

    def test_without_words_or_results_it_introduces_itself_and_spends_nothing(self):
        model = FakeModel()
        reply = turn({"tools": TOOLS}, SOUL, self.book, model)
        self.assertIn("Factory Manager", reply["text"])
        self.assertEqual(model.seen, [])

    def test_model_failures_become_plain_words_not_a_crash(self):
        for error, expect in [("budget_exceeded", "budget"), ("route_not_allowed", "models route"), ("factory_unconfigured", "no model")]:
            reply = turn({"content": "hi", "tools": []}, SOUL, Notebook(Path(self.tmp.name), "x" + error), FakeModel({"error": error}))
            self.assertEqual(reply["type"], "message")
            self.assertIn(expect, reply["text"])

    def test_conversations_are_kept_per_person(self):
        model = FakeModel(says("a"), says("b"))
        turn({"content": "hi", "tools": []}, SOUL, Notebook(Path(self.tmp.name), "person-1"), model)
        turn({"content": "hi", "tools": []}, SOUL, Notebook(Path(self.tmp.name), "person-2"), model)
        self.assertEqual(len(model.seen[1]["messages"]), 2)  # system + this person's one message only


class HelpersTest(unittest.TestCase):
    def test_trim_never_starts_on_a_tool_result(self):
        msgs = []
        for i in range(30):
            msgs += [{"role": "user", "content": str(i)}, {"role": "assistant", "content": None, "tool_calls": [{"id": f"c{i}"}]}, {"role": "tool", "tool_call_id": f"c{i}", "content": "{}"}]
        out = trim(msgs)
        self.assertLessEqual(len(out), session.MAX_MESSAGES)
        self.assertEqual(out[0]["role"], "user")

    def test_tool_definitions_keep_only_well_formed_tools(self):
        defs = tool_definitions([{"name": "a", "description": "d", "parameters": {"type": "object", "properties": {}}}, {"nope": 1}, "x"])
        self.assertEqual([d["function"]["name"] for d in defs], ["a"])

    def test_the_model_client_without_a_run_token_refuses_to_call_anything(self):
        self.assertEqual(ModelClient(base_url="", token="", model="").complete([], []), {"error": "factory_unconfigured"})


class ReplyEncodingTest(unittest.TestCase):
    def test_a_plain_answer_goes_as_plain_text_so_the_factory_can_footnote_it(self):
        self.assertEqual(encode({"type": "message", "text": "About ten dollars."}), "About ten dollars.")

    def test_protocol_replies_go_as_json(self):
        self.assertEqual(json.loads(encode({"type": "connect", "agent": "donna"})), {"type": "connect", "agent": "donna"})
        self.assertEqual(json.loads(encode({"type": "tool_calls", "calls": []}))["type"], "tool_calls")

    def test_an_answer_that_reads_as_protocol_is_wrapped_so_words_cannot_act(self):
        text = '{"type":"connect","agent":"rosie"}'
        wrapped = json.loads(encode({"type": "message", "text": text}))
        self.assertEqual(wrapped, {"type": "message", "text": text})


class HistorySizeTest(unittest.TestCase):
    def test_old_turns_are_dropped_when_the_history_is_too_large_but_the_newest_turn_is_kept_whole(self):
        big = "x" * 20_000
        msgs = []
        for i in range(6):
            msgs += [{"role": "user", "content": str(i)}, {"role": "assistant", "content": None, "tool_calls": [{"id": f"c{i}"}]}, {"role": "tool", "tool_call_id": f"c{i}", "content": big}]
        out = trim(msgs)
        self.assertLessEqual(sum(len(json.dumps(m)) for m in out), session.MAX_HISTORY_CHARS + 25_000)
        self.assertEqual(out[0]["role"], "user")
        self.assertEqual(out[-1]["tool_call_id"], "c5")
        self.assertEqual(len(trim(msgs[:3])), 3)


class SourceRulesTest(unittest.TestCase):
    def test_no_provider_or_cloud_sdk_and_no_static_credential(self):
        source = "\n".join((Path(__file__).parent.parent / f).read_text("utf-8") for f in ("agent.py", "session.py"))
        for banned in ("import boto3", "import anthropic", "import openai", "API_KEY", "FACTORY_TOKEN"):
            self.assertNotIn(banned, source)


if __name__ == "__main__":
    unittest.main()
