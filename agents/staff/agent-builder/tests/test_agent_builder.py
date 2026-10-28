"""Tests for the Headless Agent Builder staff agent."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from session import (
    BuilderClient,
    empty_draft,
    empty_state,
    load_state,
    save_state,
    turn,
    clean_draft,
)


class FakeBuilderClient(BuilderClient):
    def __init__(self, should_fail_validation=False, should_fail_publish=False):
        super().__init__(base_url="http://factory.test", run_id="run-builder-123", token="mock-run-token")
        self.catalogs_called = 0
        self.validations: list[dict] = []
        self.publications: list[dict] = []
        self.should_fail_validation = should_fail_validation
        self.should_fail_publish = should_fail_publish

    def catalog(self) -> dict:
        self.catalogs_called += 1
        return {
            "ok": True,
            "archetypes": ["purpose-built", "personal-assistant", "team-member"],
            "skills": [
                {"id": "discord-progress", "name": "Discord Progress", "latestApproved": "1.0.0"},
                {"id": "tavily-search", "name": "Tavily Search", "latestApproved": "0.1.0"},
            ],
        }

    def validate(self, spec: dict) -> dict:
        self.validations.append(spec)
        if self.should_fail_validation:
            return {
                "ok": False,
                "status": 422,
                "error": "unknown_skill",
                "skill": "bad-skill",
                "message": 'skill "bad-skill" is not registered',
            }
        arch = spec.get("memory", {}).get("archetype")
        if not arch:
            return {
                "ok": False,
                "status": 422,
                "error": "archetype_required",
                "message": "memory.archetype is required (AM1)",
            }
        return {
            "ok": True,
            "valid": True,
            "adoptableSkills": [s.get("id") for s in spec.get("skills", [])],
        }

    def publish(self, spec: dict) -> dict:
        self.publications.append(spec)
        if self.should_fail_publish:
            return {
                "ok": False,
                "status": 409,
                "error": "agent_exists",
                "message": f"agent '{spec.get('id')}' already exists",
            }
        return {
            "ok": True,
            "agent": {
                "id": spec.get("id"),
                "name": spec.get("name"),
                "status": "PENDING_BUDGET",
                "owner": "alice",
            },
            "adoptions": spec.get("skills", []),
            "ledger": {"action": "AGENT_BUILT_BY_BUILDER"},
        }


class TestAgentBuilder(unittest.TestCase):
    def test_help_and_wake(self):
        client = FakeBuilderClient()
        state = empty_state()

        wake_reply = turn(state, "wake", client)
        self.assertIn("Agent Builder online", wake_reply)

        help_reply = turn(state, "help", client)
        self.assertIn("Agent Builder Commands:", help_reply)
        self.assertIn("catalog", help_reply)
        self.assertIn("validate", help_reply)
        self.assertIn("publish", help_reply)

    def test_catalog_inspection(self):
        client = FakeBuilderClient()
        state = empty_state()

        reply = turn(state, "catalog", client)
        self.assertEqual(client.catalogs_called, 1)
        self.assertIn("=== Factory Catalog ===", reply)
        self.assertIn("discord-progress", reply)
        self.assertIn("personal-assistant", reply)

    def test_interactive_configuration_drafting(self):
        client = FakeBuilderClient()
        state = empty_state()

        self.assertIn("set to: assistant-1", turn(state, "set id assistant-1", client))
        self.assertIn("set to: Assistant One", turn(state, "set name Assistant One", client))
        self.assertIn("set to: A helpful assistant", turn(state, "set description A helpful assistant", client))
        self.assertIn("set to: personal-assistant", turn(state, "set archetype personal-assistant", client))
        self.assertIn("Draft soul updated", turn(state, "set soul You are a helpful assistant.", client))
        self.assertIn("Added skill 'discord-progress@1.0.0'", turn(state, "add skill discord-progress 1.0.0", client))
        self.assertIn("Added skill 'tavily-search'", turn(state, "add skill tavily-search", client))
        self.assertIn("Added role 'Operator'", turn(state, "add role Operator discord-progress,tavily-search", client))

        draft = state["draft"]
        self.assertEqual(draft["id"], "assistant-1")
        self.assertEqual(draft["name"], "Assistant One")
        self.assertEqual(draft["description"], "A helpful assistant")
        self.assertEqual(draft["memory"]["archetype"], "personal-assistant")
        self.assertEqual(draft["soul"], "You are a helpful assistant.")
        self.assertEqual(len(draft["skills"]), 2)
        self.assertEqual(len(draft["roles"]), 1)

        # Test show / status
        status_reply = turn(state, "show", client)
        self.assertIn("=== Current Draft Agent Configuration ===", status_reply)
        self.assertIn("ID:          assistant-1", status_reply)
        self.assertIn("personal-assistant", status_reply)

        # Remove skill
        self.assertIn("Removed skill 'tavily-search'", turn(state, "remove skill tavily-search", client))
        self.assertEqual(len(state["draft"]["skills"]), 1)
        self.assertEqual(state["draft"]["skills"][0]["id"], "discord-progress")

    def test_validation_dry_run(self):
        client = FakeBuilderClient()
        state = empty_state()

        # Without archetype
        state["draft"]["id"] = "agent-x"
        reply = turn(state, "validate", client)
        self.assertIn("Validation failed [archetype_required]", reply)

        # With archetype
        state["draft"]["memory"]["archetype"] = "purpose-built"
        reply = turn(state, "validate", client)
        self.assertIn("Validation passed!", reply)
        self.assertTrue(state["lastValidation"]["valid"])

        # Forced failure
        failing_client = FakeBuilderClient(should_fail_validation=True)
        fail_reply = turn(state, "validate", failing_client)
        self.assertIn("Validation failed [unknown_skill]", fail_reply)

    def test_publishing_lifecycle(self):
        client = FakeBuilderClient()
        state = empty_state()
        state["draft"]["id"] = "builder-created-agent"
        state["draft"]["name"] = "Created Agent"
        state["draft"]["memory"]["archetype"] = "personal-assistant"
        state["draft"]["skills"] = [{"id": "discord-progress", "version": "1.0.0"}]

        reply = turn(state, "publish", client)
        self.assertIn("Agent 'builder-created-agent' successfully published in PENDING_BUDGET.", reply)
        self.assertIn("Owner: alice", reply)
        self.assertIn("Action: AGENT_BUILT_BY_BUILDER", reply)
        self.assertEqual(len(client.publications), 1)
        self.assertEqual(client.publications[0]["id"], "builder-created-agent")

        # Publish collision failure
        collision_client = FakeBuilderClient(should_fail_publish=True)
        fail_reply = turn(state, "publish", collision_client)
        self.assertIn("Publish failed [agent_exists]", fail_reply)

    def test_structured_json_payloads(self):
        client = FakeBuilderClient()
        state = empty_state()

        # Catalog op
        reply = turn(state, {"op": "catalog"}, client)
        self.assertIn("=== Factory Catalog ===", reply)

        # Set op
        reply = turn(state, {"op": "set", "fields": {"id": "json-agent", "name": "JSON Agent"}}, client)
        self.assertEqual(state["draft"]["id"], "json-agent")
        self.assertIn("Draft configuration updated.", reply)

        # Validate op with explicit spec
        reply = turn(state, {
            "op": "validate",
            "spec": {
                "id": "json-agent",
                "memory": {"archetype": "team-member"},
            }
        }, client)
        self.assertIn("Validation passed!", reply)

        # Publish op with explicit spec
        reply = turn(state, {
            "op": "publish",
            "spec": {
                "id": "json-agent",
                "memory": {"archetype": "team-member"},
            }
        }, client)
        self.assertIn("Agent 'json-agent' successfully published", reply)

    def test_state_persistence_round_trip(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "builder-session.json"
            state = empty_state()
            state["draft"]["id"] = "persisted-agent"
            state["draft"]["memory"]["archetype"] = "purpose-built"
            save_state(path, state)

            loaded = load_state(path)
            self.assertEqual(loaded["draft"]["id"], "persisted-agent")
            self.assertEqual(loaded["draft"]["memory"]["archetype"], "purpose-built")

    def test_clean_draft(self):
        draft = empty_draft()
        self.assertEqual(clean_draft(draft), {})

        draft["id"] = "clean-agent"
        draft["memory"]["archetype"] = "purpose-built"
        draft["skills"] = []
        cleaned = clean_draft(draft)
        self.assertEqual(cleaned, {"id": "clean-agent", "memory": {"archetype": "purpose-built"}})

    def test_unconfigured_client_error(self):
        # Empty client without env vars
        client = BuilderClient(base_url="", run_id="", token="")
        res = client.catalog()
        self.assertEqual(res.get("error"), "factory_unconfigured")


if __name__ == "__main__":
    unittest.main()
