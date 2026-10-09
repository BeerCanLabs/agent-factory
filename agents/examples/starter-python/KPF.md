# Key Product Flows (KPF) — BeerCanLabs Standard

This document is the single source of truth for user-facing flows supported by this repository.

---

## 1. Core Service Operation
- **Description:** Initializes memory according to declared archetype (Ephemeral, Episodic, Workspace), processes inbound wake turns, and records outputs to `/tmp/factory-result.json`.
- **Entry points:** `agent.py::main`, `agent.py::get_input_payload`, `agent.py::write_result`.
- **If it silently breaks:** Agent fails to start, loses turn context, or cannot process incoming alert/wake payloads.
- **Test status:** Automated (`tests/test_runtime.py::test_agent_initialization`).

## 2. Agent Triad & Governance Report
- **Description:** Generates a structured review table matching each agent skill to its required system, secret reference, and human-in-the-loop (HITL/hold) policy using standard library only.
- **Entry points:** CLI command `python3 tools/report_triad.py`, or `generate_triad_report` in `tools/report_triad.py`.
- **If it silently breaks:** Operators and AI reviewers will see incomplete, missing, or inaccurate skill, system, secret, and governance hold mappings.
- **Test status:** Automated (`tests/test_triad.py::TestTriadAndGovernance::test_triad_report_generation`).

## 3. Standard Agent Memory Archetypes
- **Description:** Provides three standardized agent memory archetypes (Ephemeral, Episodic, and Workspace) with fail-closed cartridge manifest loader, sliding-window budgeting, and FTS5 recall.
- **Entry points:** `memory/__init__.py::get_memory_archetype`, `memory/__init__.py::load_archetype_from_cartridge`, `memory.ephemeral`, `memory.episodic`, `memory.workspace`.
- **If it silently breaks:** Agents fail to maintain working conversation context, cannot recall historical turns via FTS5, lose project/task checkpoint state, or misconfigure memory persistence.
- **Test status:** Automated (`tests/test_memory_archetypes.py::TestMemoryArchetypes`).
