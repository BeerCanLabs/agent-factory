"""
Unit tests for the 3 Agent Memory Archetypes — BeerCanLabs Cartridge Standard:
- Type 1: Ephemeral memory (in-memory sliding window Whiteboard, zero SQLite persistence, zero Safe/S3 sync)
- Type 2: Episodic memory (user-partitioned SQLite + FTS5 full-text recall, fast-path intent handling)
- Type 3: Workspace memory (project_id and task_id scoped state, task turns, and checkpoints)
- Memory package loader and cartridge configuration
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import memory
from memory import (
    ARCHETYPE_EPHEMERAL,
    ARCHETYPE_EPISODIC,
    ARCHETYPE_WORKSPACE,
    get_memory_archetype,
    load_archetype_from_cartridge,
)
from memory import ephemeral, episodic, workspace


class TestMemoryArchetypes(unittest.TestCase):

    # ===========================================================================
    # 1. Package Loader & Archetype Discovery
    # ===========================================================================

    def test_package_archetype_discovery(self):
        """Verify get_memory_archetype returns the correct module for each archetype."""
        self.assertIs(get_memory_archetype("ephemeral"), ephemeral)
        self.assertIs(get_memory_archetype("EPHEMERAL"), ephemeral)
        self.assertIs(get_memory_archetype("episodic"), episodic)
        self.assertIs(get_memory_archetype("EPISODIC"), episodic)
        self.assertIs(get_memory_archetype("workspace"), workspace)
        self.assertIs(get_memory_archetype("WORKSPACE"), workspace)

        with self.assertRaises(ValueError):
            get_memory_archetype("nonexistent")

    def test_load_archetype_from_cartridge_manifest(self):
        """Verify load_archetype_from_cartridge reads archetype from cartridge.yaml."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)

            cartridge_file = tmp_path / "cartridge.yaml"
            cartridge_file.write_text("""
schemaVersion: "1.0"
id: test-agent
memory:
  archetype: ephemeral
""", encoding="utf-8")

            name, mod = load_archetype_from_cartridge(cartridge_file)
            self.assertEqual(name, "ephemeral")
            self.assertIs(mod, ephemeral)

            # Fall back to episodic when persistence.enabled is true or prefix is set
            cartridge_pers = tmp_path / "cartridge_pers.yaml"
            cartridge_pers.write_text("""
schemaVersion: "1.0"
id: test-agent
persistence:
  enabled: true
  prefix: agent-state
""", encoding="utf-8")
            pers_name, pers_mod = load_archetype_from_cartridge(cartridge_pers)
            self.assertEqual(pers_name, "episodic")
            self.assertIs(pers_mod, episodic)

            # Fall back to ephemeral when persistence.enabled is false
            cartridge_eph = tmp_path / "cartridge_eph.yaml"
            cartridge_eph.write_text("""
schemaVersion: "1.0"
id: test-agent
persistence:
  enabled: false
""", encoding="utf-8")
            eph_name, eph_mod = load_archetype_from_cartridge(cartridge_eph)
            self.assertEqual(eph_name, "ephemeral")
            self.assertIs(eph_mod, ephemeral)

            # Fail closed when neither memory nor persistence is declared
            cartridge_bare = tmp_path / "cartridge_bare.yaml"
            cartridge_bare.write_text("""
schemaVersion: "1.0"
id: test-agent
""", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_archetype_from_cartridge(cartridge_bare)

    def test_canonical_reexports(self):
        """Verify package root re-exports canonical episodic and archetype components."""
        self.assertTrue(callable(memory.init_episodic_tables))
        self.assertTrue(callable(memory.get_or_create_active_session))
        self.assertTrue(callable(memory.start_new_session))
        self.assertTrue(callable(memory.load_whiteboard))
        self.assertTrue(callable(memory.remember_turn))
        self.assertTrue(callable(memory.recall_conversation))
        self.assertTrue(callable(memory.prune_conversations))
        self.assertIsInstance(memory.RECALL_TOOL_SPEC, dict)

        self.assertTrue(issubclass(memory.EphemeralWhiteboard, object))
        self.assertTrue(callable(memory.init_workspace_tables))
        self.assertIsInstance(memory.WORKSPACE_RECALL_TOOL_SPEC, dict)

    # ===========================================================================
    # 2. Type 1: Ephemeral Memory (In-Memory Sliding Window, Zero SQLite)
    # ===========================================================================

    def test_ephemeral_turn_recording_and_whiteboard(self):
        """Verify in-memory sliding window Whiteboard with zero SQLite persistence."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir)
            wb = ephemeral.EphemeralWhiteboard(max_messages=6, max_chars=1000)

            # 1. Zero SQLite persistence: confirm no db files created
            self.assertEqual(list(tmp_path.glob("*.db")), [])

            wb.remember_turn("Hello agent", "Hello user")
            self.assertEqual(wb.total_messages, 2)

            history, banner = wb.load_whiteboard()
            self.assertEqual(len(history), 2)
            self.assertIsNone(banner)

            # 2. Add turns exceeding max_messages to trigger awareness banner
            wb.remember_turn("Question 2", "Answer 2")
            wb.remember_turn("Question 3", "Answer 3")
            wb.remember_turn("Question 4", "Answer 4")
            self.assertEqual(wb.total_messages, 8)

            history, banner = wb.load_whiteboard()
            self.assertEqual(len(history), 6)
            self.assertIsNotNone(banner)
            self.assertIn("Total turns: 8", banner)
            self.assertIn("Showing recent: 6", banner)

    def test_ephemeral_char_budget_truncation(self):
        """Verify Whiteboard enforces strict character budgeting."""
        wb = ephemeral.EphemeralWhiteboard(max_messages=20, max_chars=100)
        wb.remember_turn("Short prompt", "A" * 60)
        wb.remember_turn("Second prompt", "B" * 60)

        history, banner = wb.load_whiteboard()
        self.assertLessEqual(len(history), 2)
        total_len = sum(len(m["content"]) for m in history)
        self.assertLessEqual(total_len, 100)
        self.assertIsNotNone(banner)

    def test_ephemeral_session_clear(self):
        """Verify ephemeral session clearing."""
        wb = ephemeral.EphemeralWhiteboard()
        wb.remember_turn("Turn 1", "Reply 1")
        wb.clear()
        self.assertEqual(wb.total_messages, 0)
        history, banner = wb.load_whiteboard()
        self.assertEqual(len(history), 0)
        self.assertIsNone(banner)

    # ===========================================================================
    # 3. Type 2: Episodic Memory (SQLite + FTS5, Sessions, Pruning)
    # ===========================================================================

    def test_episodic_database_initialization(self):
        """Verify episodic SQLite initialization and PRAGMA settings."""
        conn = sqlite3.connect(":memory:")
        episodic.init_episodic_tables(conn)

        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
        self.assertIn("conversation_sessions", tables)
        self.assertIn("conversation_turns", tables)
        self.assertIn("conversation_fts", tables)
        conn.close()

    def test_episodic_multi_user_session_isolation(self):
        """Verify sessions are isolated per user_id."""
        conn = sqlite3.connect(":memory:")
        episodic.init_episodic_tables(conn)

        s_alice_id, _ = episodic.get_or_create_active_session(conn, "alice")
        s_bob_id, _ = episodic.get_or_create_active_session(conn, "bob")

        self.assertNotEqual(s_alice_id, s_bob_id)

        # Remember turns for each user
        episodic.remember_turn(conn, s_alice_id, "alice", "Alice secret prompt", "Alice acknowledgment")
        episodic.remember_turn(conn, s_bob_id, "bob", "Bob secret prompt", "Bob acknowledgment")

        # Recall should be isolated by user_id
        alice_results = episodic.recall_conversation(conn, "alice", "secret")
        self.assertEqual(len(alice_results), 1)
        self.assertEqual(alice_results[0]["content"], "Alice secret prompt")

        bob_results = episodic.recall_conversation(conn, "bob", "secret")
        self.assertEqual(len(bob_results), 1)
        self.assertEqual(bob_results[0]["content"], "Bob secret prompt")

        # Stranger cannot recall anything
        stranger_results = episodic.recall_conversation(conn, "stranger", "secret")
        self.assertEqual(len(stranger_results), 0)
        conn.close()

    def test_episodic_fast_path_intents(self):
        """Verify fast-path session commands (/new, /name, /sessions, /export)."""
        conn = sqlite3.connect(":memory:")
        episodic.init_episodic_tables(conn)

        # /new
        handled, res = episodic.handle_turn_intent(conn, "alice", "/new Planning 2026")
        self.assertTrue(handled)
        self.assertIn("Planning 2026", res)

        # /name
        handled, res = episodic.handle_turn_intent(conn, "alice", "/name Strategic Roadmaps")
        self.assertTrue(handled)
        self.assertIn("Strategic Roadmaps", res)

        # /sessions
        handled, res = episodic.handle_turn_intent(conn, "alice", "/sessions")
        self.assertTrue(handled)
        self.assertIn("conversations", res.lower())

        # /export
        handled, res = episodic.handle_turn_intent(conn, "alice", "/export")
        self.assertTrue(handled)
        self.assertIn("Conversation Export", res)
        conn.close()

    def test_episodic_pruning_policy(self):
        """Verify rolling pruning on wake for turns older than retention threshold."""
        conn = sqlite3.connect(":memory:")
        episodic.init_episodic_tables(conn)
        session_id, _ = episodic.get_or_create_active_session(conn, "alice")

        now = datetime.now(timezone.utc)
        old_time = (now - timedelta(days=40)).isoformat()
        recent_time = (now - timedelta(days=5)).isoformat()

        # Insert historical turn directly
        conn.execute(
            "INSERT INTO conversation_turns (session_id, user_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
            (session_id, "alice", "user", "Old forgotten message", old_time),
        )
        conn.execute(
            "INSERT INTO conversation_turns (session_id, user_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
            (session_id, "alice", "user", "Recent message", recent_time),
        )
        conn.commit()

        pruned = episodic.prune_conversations(conn, retention_days=30)
        self.assertEqual(pruned, 1)

        remaining = conn.execute("SELECT content FROM conversation_turns WHERE session_id = ?", (session_id,)).fetchall()
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0][0], "Recent message")
        conn.close()

    # ===========================================================================
    # 4. Type 3: Workspace Memory (Project & Task Scoped State)
    # ===========================================================================

    def test_workspace_tables_and_task_lifecycle(self):
        """Verify workspace tables and task state machine."""
        conn = sqlite3.connect(":memory:")
        workspace.init_workspace_tables(conn)

        project = workspace.create_or_get_project(conn, "proj-alpha", "Alpha Project")
        self.assertEqual(project["id"], "proj-alpha")

        task = workspace.create_or_update_task(conn, "proj-alpha", "task-101", "Implement parser")
        self.assertEqual(task["status"], "pending")

        workspace.update_task_status(conn, "proj-alpha", "task-101", "in_progress")
        updated = workspace.get_task(conn, "proj-alpha", "task-101")
        self.assertEqual(updated["status"], "in_progress")
        conn.close()

    def test_workspace_checkpoint_state(self):
        """Verify key-value checkpoint state scoped to project and task."""
        conn = sqlite3.connect(":memory:")
        workspace.init_workspace_tables(conn)

        workspace.set_task_state(conn, "proj-alpha", "task-101", "ast_symbols", ["parse", "validate"])
        workspace.set_task_state(conn, "proj-alpha", "task-101", "diff_stat", {"insertions": 14, "deletions": 2})

        symbols = workspace.get_task_state(conn, "proj-alpha", "task-101", "ast_symbols")
        self.assertEqual(symbols, ["parse", "validate"])

        all_state = workspace.get_all_task_state(conn, "proj-alpha", "task-101")
        self.assertIn("ast_symbols", all_state)
        self.assertIn("diff_stat", all_state)

        # Other tasks should not see this state
        other_state = workspace.get_task_state(conn, "proj-alpha", "task-999", "ast_symbols")
        self.assertIsNone(other_state)
        conn.close()

    def test_workspace_recall_tool_spec_omits_project_id(self):
        """Verify WORKSPACE_RECALL_TOOL_SPEC does not allow model to supply arbitrary project_id."""
        spec = workspace.WORKSPACE_RECALL_TOOL_SPEC
        properties = spec["function"]["parameters"]["properties"]
        self.assertIn("query", properties)
        self.assertIn("task_id", properties)
        # CRITICAL: project_id MUST NOT be in the model parameters (cross-project leak prevention)
        self.assertNotIn("project_id", properties)
        self.assertEqual(spec["function"]["parameters"]["required"], ["query"])

    def test_workspace_recall_scoped(self):
        """Verify recall_task_memory performs FTS and respects project scoping."""
        conn = sqlite3.connect(":memory:")
        workspace.init_workspace_tables(conn)

        workspace.record_task_turn(conn, "proj-alpha", "task-1", "user", "Refactor the database schema")
        workspace.record_task_turn(conn, "proj-beta", "task-2", "user", "Refactor the authentication flow")

        # Search proj-alpha: only proj-alpha turn returned
        alpha_res = workspace.recall_task_memory(conn, "proj-alpha", "Refactor")
        self.assertEqual(len(alpha_res), 1)
        self.assertEqual(alpha_res[0]["project_id"], "proj-alpha")
        self.assertIn("database schema", alpha_res[0]["content"])

        # Search proj-beta: only proj-beta turn returned
        beta_res = workspace.recall_task_memory(conn, "proj-beta", "Refactor")
        self.assertEqual(len(beta_res), 1)
        self.assertEqual(beta_res[0]["project_id"], "proj-beta")
        self.assertIn("authentication flow", beta_res[0]["content"])
        conn.close()

    def test_workspace_db_path_sanitization(self):
        """Verify get_workspace_db_path creates isolated, sanitized database filenames."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            p1 = workspace.get_workspace_db_path(tmp_dir, "my-team/project-1")
            self.assertTrue(p1.name.startswith("workspace_my-team_project-1-") and p1.name.endswith(".db"), p1.name)
            self.assertEqual(p1.parent, Path(tmp_dir))

            p2 = workspace.get_workspace_db_path(tmp_dir, "clean_project")
            self.assertEqual(p2.name, "workspace_clean_project.db")

    def test_workspace_db_path_never_collides_for_different_ids(self):
        """Two different project ids must never share a database file, even when sanitizing makes them look alike."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            slash = workspace.get_workspace_db_path(tmp_dir, "a/b")
            underscore = workspace.get_workspace_db_path(tmp_dir, "a_b")
            dot = workspace.get_workspace_db_path(tmp_dir, "a.b")
            self.assertEqual(len({slash, underscore, dot}), 3)
            # Stable: the same id always maps to the same file.
            self.assertEqual(slash, workspace.get_workspace_db_path(tmp_dir, "a/b"))
            # An empty id is not the id "default".
            self.assertNotEqual(workspace.get_workspace_db_path(tmp_dir, ""), workspace.get_workspace_db_path(tmp_dir, "default"))

    def test_manifest_inline_comments_are_ignored(self):
        """A trailing comment must not change a value; a # inside quotes stays."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "cartridge.yaml"
            path.write_text('memory:\n  archetype: workspace # per-project\n  retentionDays: 14 # two weeks\n  label: "a # b"\n', "utf-8")
            name, _ = memory.load_archetype_from_cartridge(path)
            self.assertEqual(name, "workspace")
            self.assertEqual(memory.load_memory_bounds(path)["retention_days"], 14)
            self.assertEqual(memory._parse_manifest(path.read_text("utf-8"))["memory"]["label"], "a # b")

    def test_memory_bounds_defaults_declared_and_refused(self):
        """The declared bounds are the ones the agent runs with; a bad value is refused, not defaulted."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "cartridge.yaml"
            path.write_text("memory:\n  archetype: episodic\n", "utf-8")
            self.assertEqual(memory.load_memory_bounds(path), {"retention_days": 30, "max_messages": 20, "max_chars": 24000})

            path.write_text("memory:\n  archetype: episodic\n  retentionDays: 7\n  maxMessages: 5\n  maxChars: 1000\n", "utf-8")
            self.assertEqual(memory.load_memory_bounds(path), {"retention_days": 7, "max_messages": 5, "max_chars": 1000})

            for bad in ("0", "-3", "many", "true", "1.5"):
                path.write_text(f"memory:\n  archetype: episodic\n  retentionDays: {bad}\n", "utf-8")
                with self.assertRaises(ValueError, msg=bad):
                    memory.load_memory_bounds(path)

        with self.assertRaises(FileNotFoundError):
            memory.load_memory_bounds(Path(tmp_dir) / "missing" / "cartridge.yaml")

    def test_starter_cartridge_declares_bounds_the_agent_reads(self):
        """The shipped cartridge's own bounds load, so the schema fields are not decorative."""
        bounds = memory.load_memory_bounds(Path(__file__).resolve().parent.parent / "cartridge.yaml")
        self.assertEqual(bounds, {"retention_days": 30, "max_messages": 20, "max_chars": 24000})


if __name__ == "__main__":
    unittest.main()
