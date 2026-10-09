"""
Unit tests for the 3 Agent Memory Archetypes — BeerCanLabs Cartridge Standard:
- Type 1: Ephemeral memory (in-memory sliding window Whiteboard, zero SQLite persistence, zero Safe/S3 sync)
- Type 2: Episodic memory (user-partitioned SQLite + FTS5 full-text recall, fast-path intent handling)
- Type 3: Workspace memory (project_id and task_id scoped state, task turns, and checkpoints)
- Memory package loader and cartridge configuration
"""

import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
import pytest

import memory
from memory import (
    ARCHETYPE_EPHEMERAL,
    ARCHETYPE_EPISODIC,
    ARCHETYPE_WORKSPACE,
    get_memory_archetype,
    load_archetype_from_cartridge,
)
from memory import ephemeral, episodic, workspace


# ===========================================================================
# 1. Package Loader & Archetype Discovery
# ===========================================================================


def test_package_archetype_discovery():
    """Verify get_memory_archetype returns the correct module for each archetype."""
    assert get_memory_archetype("ephemeral") is ephemeral
    assert get_memory_archetype("EPHEMERAL") is ephemeral
    assert get_memory_archetype("episodic") is episodic
    assert get_memory_archetype("EPISODIC") is episodic
    assert get_memory_archetype("workspace") is workspace
    assert get_memory_archetype("WORKSPACE") is workspace

    with pytest.raises(ValueError, match="Unknown memory archetype"):
        get_memory_archetype("nonexistent")


def test_load_archetype_from_cartridge_manifest(tmp_path):
    """Verify load_archetype_from_cartridge reads archetype from cartridge.yaml."""
    cartridge_file = tmp_path / "cartridge.yaml"
    cartridge_file.write_text("""
schemaVersion: "1.0"
id: test-agent
memory:
  archetype: ephemeral
""", encoding="utf-8")

    name, mod = load_archetype_from_cartridge(cartridge_file)
    assert name == "ephemeral"
    assert mod is ephemeral

    # Default to episodic when memory configuration is omitted
    cartridge_default = tmp_path / "cartridge_default.yaml"
    cartridge_default.write_text("""
schemaVersion: "1.0"
id: test-agent
""", encoding="utf-8")
    def_name, def_mod = load_archetype_from_cartridge(cartridge_default)
    assert def_name == "episodic"
    assert def_mod is episodic


def test_canonical_reexports():
    """Verify package root re-exports canonical episodic and archetype components."""
    assert callable(memory.init_episodic_tables)
    assert callable(memory.get_or_create_active_session)
    assert callable(memory.start_new_session)
    assert callable(memory.load_whiteboard)
    assert callable(memory.remember_turn)
    assert callable(memory.recall_conversation)
    assert callable(memory.prune_conversations)
    assert isinstance(memory.RECALL_TOOL_SPEC, dict)

    assert issubclass(memory.EphemeralWhiteboard, object)
    assert callable(memory.init_workspace_tables)
    assert isinstance(memory.WORKSPACE_RECALL_TOOL_SPEC, dict)


# ===========================================================================
# 2. Type 1: Ephemeral Memory (In-Memory Sliding Window, Zero SQLite)
# ===========================================================================


def test_ephemeral_turn_recording_and_whiteboard(tmp_path):
    """Verify in-memory sliding window Whiteboard with zero SQLite persistence."""
    wb = ephemeral.EphemeralWhiteboard(max_messages=6, max_chars=1000)

    # 1. Zero SQLite persistence: confirm no db files created
    assert list(tmp_path.glob("*.db")) == []

    wb.remember_turn("Hello agent", "Hello user")
    assert wb.total_messages == 2

    history, banner = wb.load_whiteboard()
    assert len(history) == 2
    assert history[0] == {"role": "user", "content": "Hello agent"}
    assert history[1] == {"role": "assistant", "content": "Hello user"}
    assert banner is None  # All messages shown, no banner needed


def test_ephemeral_sliding_window_message_budget():
    """Verify sliding window drops oldest messages and surfaces awareness banner."""
    wb = ephemeral.EphemeralWhiteboard(max_messages=4, max_chars=10000)
    for i in range(5):
        wb.remember_turn(f"User msg {i}", f"Assistant reply {i}")

    assert wb.total_messages == 10

    history, banner = wb.load_whiteboard()
    assert len(history) == 4
    assert history[0]["content"] == "User msg 3"
    assert history[-1]["content"] == "Assistant reply 4"

    assert banner is not None
    assert "Total turns: 10" in banner
    assert "Showing recent: 4 turns" in banner
    assert "Ephemeral Context" in banner


def test_ephemeral_char_budget_trimming():
    """Verify character budgeting trims messages exceeding max_chars."""
    wb = ephemeral.EphemeralWhiteboard(max_messages=10, max_chars=50)
    wb.add_message("user", "Short 1")
    wb.add_message("assistant", "A" * 40)
    wb.add_message("user", "B" * 20)

    history, banner = wb.load_whiteboard()
    # "B"*20 is 20 chars; "A"*40 is 40 chars -> 60 chars exceeds 50 char limit
    assert len(history) == 1
    assert history[0]["content"] == "B" * 20
    assert banner is not None


def test_ephemeral_clear_and_transcript():
    """Verify clearing and exporting ephemeral session."""
    wb = ephemeral.EphemeralWhiteboard()
    wb.remember_turn("ping", "pong")
    transcript = wb.export_transcript()
    assert "# Ephemeral Conversation Transcript" in transcript
    assert "ping" in transcript
    assert "pong" in transcript

    wb.clear()
    assert wb.total_messages == 0
    empty_history, _ = wb.load_whiteboard()
    assert empty_history == []


def test_ephemeral_module_registry():
    """Verify module-level multi-session ephemeral functions."""
    ephemeral.clear_all_sessions()
    ephemeral.remember_turn("session-a", "user A", "reply A")
    ephemeral.remember_turn("session-b", "user B", "reply B")

    hist_a, _ = ephemeral.load_whiteboard("session-a")
    hist_b, _ = ephemeral.load_whiteboard("session-b")

    assert len(hist_a) == 2
    assert hist_a[0]["content"] == "user A"
    assert len(hist_b) == 2
    assert hist_b[0]["content"] == "user B"

    ephemeral.clear_session("session-a")
    cleared_a, _ = ephemeral.load_whiteboard("session-a")
    assert len(cleared_a) == 0

    ephemeral.clear_all_sessions()
    assert ephemeral.list_active_sessions() == []


# ===========================================================================
# 3. Type 2: Episodic Memory (User-Partitioned SQLite + FTS5)
# ===========================================================================


@pytest.fixture
def episodic_db(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "episodic_state.db"))
    conn.execute("PRAGMA journal_mode=WAL;")
    episodic.init_episodic_tables(conn)
    yield conn
    conn.close()


def test_episodic_session_continuity_and_isolation(episodic_db):
    """Verify continuous active session per user and strict user isolation."""
    s1, name1 = episodic.get_or_create_active_session(episodic_db, "user_1")
    assert s1.startswith("s_")
    assert name1 is None

    # Repeated calls return the same active session
    s1_repeat, _ = episodic.get_or_create_active_session(episodic_db, "user_1")
    assert s1 == s1_repeat

    # User 2 gets an isolated session
    s2, _ = episodic.get_or_create_active_session(episodic_db, "user_2")
    assert s1 != s2

    episodic.remember_turn(episodic_db, s1, "user_1", "User1 private unique note", "Reply 1")
    episodic.remember_turn(episodic_db, s2, "user_2", "User2 private distinct memo", "Reply 2")

    u1_wb, _ = episodic.load_whiteboard(episodic_db, "user_1", s1)
    u2_wb, _ = episodic.load_whiteboard(episodic_db, "user_2", s2)

    assert len(u1_wb) == 2
    assert u1_wb[0]["content"] == "User1 private unique note"
    assert len(u2_wb) == 2
    assert u2_wb[0]["content"] == "User2 private distinct memo"

    # User 2 cannot recall User 1's unique note
    recalled = episodic.recall_conversation(episodic_db, "user_2", "unique note")
    assert len(recalled) == 0


def test_episodic_fast_path_intents(episodic_db):
    """Verify pre-LLM fast path commands (/new, /name, /resume, /sessions, /export)."""
    s1, _ = episodic.get_or_create_active_session(episodic_db, "dale")
    episodic.remember_turn(episodic_db, s1, "dale", "discussing factory architecture", "Factory looks good.")

    # 1. /name
    handled, msg = episodic.handle_turn_intent(episodic_db, "dale", '/name "factory-v2"')
    assert handled is True
    assert "factory-v2" in msg

    # 2. /new
    handled, msg = episodic.handle_turn_intent(episodic_db, "dale", "/new sprint-planning")
    assert handled is True
    assert "sprint-planning" in msg

    s2, name2 = episodic.get_or_create_active_session(episodic_db, "dale")
    assert s2 != s1
    assert name2 == "sprint-planning"
    episodic.remember_turn(episodic_db, s2, "dale", "sprint tasks", "assigned")

    # 3. /sessions
    handled, msg = episodic.handle_turn_intent(episodic_db, "dale", "/sessions")
    assert handled is True
    assert "factory-v2" in msg
    assert "sprint-planning" in msg

    # 4. /resume
    handled, msg = episodic.handle_turn_intent(episodic_db, "dale", "/resume factory-v2")
    assert handled is True
    assert "factory-v2" in msg
    resumed_id, resumed_name = episodic.get_or_create_active_session(episodic_db, "dale")
    assert resumed_id == s1
    assert resumed_name == "factory-v2"

    # 5. /export
    handled, msg = episodic.handle_turn_intent(episodic_db, "dale", "/export")
    assert handled is True
    assert "# Conversation Export" in msg
    assert "factory-v2" in msg


def test_episodic_recall_with_fts5_and_fallback(episodic_db):
    """Verify full-text recall with SQLite FTS5."""
    s1, _ = episodic.get_or_create_active_session(episodic_db, "dale")
    episodic.remember_turn(
        episodic_db,
        s1,
        "dale",
        "Let's configure the Dead-Letter Queue for SQS",
        "DLQ maxReceiveCount set to 3.",
    )
    episodic.remember_turn(episodic_db, s1, "dale", "Next, update CloudFront distributions", "Done.")

    results = episodic.recall_conversation(episodic_db, "dale", "dead-letter queue")
    assert len(results) > 0
    assert any("Dead-Letter Queue" in r["content"] for r in results)


def test_episodic_pruning_retention(episodic_db):
    """Verify rolling retention prunes turns older than retention_days."""
    s1, _ = episodic.get_or_create_active_session(episodic_db, "dale")
    ancient = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    cur = episodic_db.execute(
        "INSERT INTO conversation_turns (session_id, user_id, surface, role, content, timestamp) VALUES (?, 'dale', 'discord', 'user', 'old note', ?)",
        (s1, ancient),
    )
    t_id = cur.lastrowid
    episodic_db.execute("INSERT INTO conversation_fts (content, turn_id, session_id, user_id) VALUES ('old note', ?, ?, 'dale')", (str(t_id), s1))
    episodic_db.commit()

    episodic.remember_turn(episodic_db, s1, "dale", "fresh turn", "fresh reply")

    pruned = episodic.prune_conversations(episodic_db, retention_days=30)
    assert pruned == 1

    wb, _ = episodic.load_whiteboard(episodic_db, "dale", s1)
    assert len(wb) == 2
    assert wb[0]["content"] == "fresh turn"


# ===========================================================================
# 4. Type 3: Workspace Memory (Project & Task Scoped State)
# ===========================================================================


@pytest.fixture
def workspace_db(tmp_path):
    conn = sqlite3.connect(str(tmp_path / "workspace_state.db"))
    conn.execute("PRAGMA journal_mode=WAL;")
    workspace.init_workspace_tables(conn)
    yield conn
    conn.close()


def test_workspace_project_and_task_lifecycle(workspace_db):
    """Verify project and task creation, state updates, and listing."""
    proj = workspace.create_or_get_project(
        workspace_db,
        project_id="proj-agent-factory",
        name="Agent Factory Core",
        description="Core control plane and runtime",
        metadata={"repo": "BeerCanLabs/agent-factory"},
    )
    assert proj["id"] == "proj-agent-factory"
    assert proj["name"] == "Agent Factory Core"

    # Task creation
    task = workspace.create_or_update_task(
        workspace_db,
        project_id="proj-agent-factory",
        task_id="tsk-01",
        title="Implement Gatekeeper Ingress",
        status="in_progress",
        context={"priority": "high", "spec": "INV-A1"},
    )
    assert task["id"] == "tsk-01"
    assert task["status"] == "in_progress"

    # Fetch task
    fetched = workspace.get_task(workspace_db, "proj-agent-factory", "tsk-01")
    assert fetched is not None
    assert fetched["context"]["priority"] == "high"

    # Update status and complete task
    success = workspace.update_task_status(
        workspace_db,
        "proj-agent-factory",
        "tsk-01",
        status="completed",
        result={"pr": "https://github.com/BeerCanLabs/agent-factory/pull/42"},
    )
    assert success is True

    completed = workspace.get_task(workspace_db, "proj-agent-factory", "tsk-01")
    assert completed["status"] == "completed"
    assert completed["result"]["pr"] == "https://github.com/BeerCanLabs/agent-factory/pull/42"


def test_workspace_isolation_and_listing(workspace_db):
    """Verify project and task strict isolation."""
    workspace.create_or_update_task(workspace_db, "project-alpha", "task-1", title="Alpha Task")
    workspace.create_or_update_task(workspace_db, "project-beta", "task-1", title="Beta Task")

    alpha_tasks = workspace.list_tasks(workspace_db, "project-alpha")
    beta_tasks = workspace.list_tasks(workspace_db, "project-beta")

    assert len(alpha_tasks) == 1
    assert alpha_tasks[0]["title"] == "Alpha Task"
    assert len(beta_tasks) == 1
    assert beta_tasks[0]["title"] == "Beta Task"


def test_workspace_turns_and_whiteboard(workspace_db):
    """Verify task execution reasoning turns and task whiteboard budgeting."""
    workspace.create_or_update_task(workspace_db, "project-sm", "task-eng", title="Build Dockerfile")
    for i in range(8):
        workspace.record_task_turn(
            workspace_db,
            "project-sm",
            "task-eng",
            role="user" if i % 2 == 0 else "assistant",
            content=f"Turn step {i}",
            metadata={"step": i},
        )

    history, banner = workspace.load_task_whiteboard(
        workspace_db,
        "project-sm",
        "task-eng",
        max_messages=4,
    )
    assert len(history) == 4
    assert history[0]["content"] == "Turn step 4"
    assert history[-1]["content"] == "Turn step 7"

    assert banner is not None
    assert "Workspace Context: Project 'project-sm' | Task 'task-eng'" in banner
    assert "recall_workspace_task" in banner


def test_workspace_state_checkpointing(workspace_db):
    """Verify key-value checkpointing per project and task."""
    workspace.set_task_state(workspace_db, "proj-1", "task-1", "current_step", 3)
    workspace.set_task_state(workspace_db, "proj-1", "task-1", "changed_files", ["agent.py", "Dockerfile"])

    step = workspace.get_task_state(workspace_db, "proj-1", "task-1", "current_step")
    files = workspace.get_task_state(workspace_db, "proj-1", "task-1", "changed_files")
    assert step == 3
    assert files == ["agent.py", "Dockerfile"]

    all_state = workspace.get_all_task_state(workspace_db, "proj-1", "task-1")
    assert all_state["current_step"] == 3
    assert all_state["changed_files"] == ["agent.py", "Dockerfile"]

    # Delete key
    assert workspace.delete_task_state(workspace_db, "proj-1", "task-1", "current_step") is True
    assert workspace.get_task_state(workspace_db, "proj-1", "task-1", "current_step") is None


def test_workspace_recall_and_pruning(workspace_db):
    """Verify workspace FTS5 recall and turn pruning retention."""
    workspace.create_or_update_task(workspace_db, "proj-ops", "task-deploy", title="Deploy ECS")
    workspace.record_task_turn(
        workspace_db,
        "proj-ops",
        "task-deploy",
        role="assistant",
        content="Configured ALB target group health checks for ECS Fargate.",
    )

    results = workspace.recall_task_memory(workspace_db, "proj-ops", "health checks")
    assert len(results) > 0
    assert "target group health checks" in results[0]["content"]

    # Pruning
    ancient = (datetime.now(timezone.utc) - timedelta(days=60)).isoformat()
    cur = workspace_db.execute(
        "INSERT INTO workspace_turns (project_id, task_id, role, content, timestamp) VALUES ('proj-ops', 'task-deploy', 'user', 'old log', ?)",
        (ancient,),
    )
    t_id = cur.lastrowid
    workspace_db.execute("INSERT INTO workspace_fts (content, turn_id, project_id, task_id) VALUES ('old log', ?, 'proj-ops', 'task-deploy')", (str(t_id),))
    workspace_db.commit()

    pruned = workspace.prune_workspace(workspace_db, retention_days=30)
    assert pruned == 1
