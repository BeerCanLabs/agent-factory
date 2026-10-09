"""
Agent Memory Package — BeerCanLabs Cartridge Standard.

Standardizes the 3 Agent Memory Archetypes:
- Type 1: Ephemeral memory (in-memory sliding window Whiteboard, zero SQLite persistence, zero Safe/S3 sync)
- Type 2: Episodic memory (user-partitioned SQLite + FTS5 full-text recall, fast-path intent handling)
- Type 3: Workspace memory (project_id and task_id scoped state, task turns, and checkpoints)
"""

import os
from pathlib import Path
from typing import Any
import yaml

from . import ephemeral
from . import episodic
from . import workspace

# Archetype Constants
ARCHETYPE_EPHEMERAL = "ephemeral"
ARCHETYPE_EPISODIC = "episodic"
ARCHETYPE_WORKSPACE = "workspace"

SUPPORTED_ARCHETYPES = (
    ARCHETYPE_EPHEMERAL,
    ARCHETYPE_EPISODIC,
    ARCHETYPE_WORKSPACE,
)

_ARCHETYPE_MODULES = {
    ARCHETYPE_EPHEMERAL: ephemeral,
    ARCHETYPE_EPISODIC: episodic,
    ARCHETYPE_WORKSPACE: workspace,
}


def get_memory_archetype(name: str):
    """Retrieve the memory archetype module by name.

    Args:
        name: One of 'ephemeral', 'episodic', or 'workspace' (case-insensitive).

    Returns:
        The corresponding memory module.

    Raises:
        ValueError: If the archetype name is not recognized.
    """
    clean_name = (name or "").strip().lower()
    if clean_name not in _ARCHETYPE_MODULES:
        valid = ", ".join(f"'{a}'" for a in SUPPORTED_ARCHETYPES)
        raise ValueError(f"Unknown memory archetype '{name}'. Supported archetypes are: {valid}")
    return _ARCHETYPE_MODULES[clean_name]


def load_archetype_from_cartridge(cartridge_path: Path | str | None = None) -> tuple[str, Any]:
    """Inspect cartridge.yaml to determine and return the configured memory archetype.

    Defaults to 'episodic' if cartridge.yaml is absent or does not declare memory.archetype.
    """
    path = Path(cartridge_path) if cartridge_path else Path("cartridge.yaml")
    if not path.is_absolute() and not path.exists():
        # Search parents for cartridge.yaml
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "cartridge.yaml"
            if candidate.exists():
                path = candidate
                break

    archetype_name = ARCHETYPE_EPISODIC
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
            memory_conf = data.get("memory")
            if isinstance(memory_conf, dict):
                declared = memory_conf.get("archetype")
                if declared:
                    archetype_name = declared.strip().lower()
            elif isinstance(memory_conf, str):
                archetype_name = memory_conf.strip().lower()
        except Exception:
            pass

    return archetype_name, get_memory_archetype(archetype_name)


# Re-export canonical Type 2 Episodic functions for SM-castle / principal agent parity
from .episodic import (
    init_episodic_tables,
    get_or_create_active_session,
    start_new_session,
    rename_active_session,
    resume_session,
    list_sessions,
    export_conversations,
    handle_turn_intent,
    load_whiteboard,
    remember_turn,
    recall_conversation,
    prune_conversations,
    RECALL_TOOL_SPEC,
)

# Re-export Type 1 Ephemeral components
from .ephemeral import (
    EphemeralWhiteboard,
)

# Re-export Type 3 Workspace components
from .workspace import (
    init_workspace_tables,
    WORKSPACE_RECALL_TOOL_SPEC,
)

__all__ = [
    # Archetype constants & loader
    "ARCHETYPE_EPHEMERAL",
    "ARCHETYPE_EPISODIC",
    "ARCHETYPE_WORKSPACE",
    "SUPPORTED_ARCHETYPES",
    "get_memory_archetype",
    "load_archetype_from_cartridge",
    # Submodules
    "ephemeral",
    "episodic",
    "workspace",
    # Canonical Episodic API
    "init_episodic_tables",
    "get_or_create_active_session",
    "start_new_session",
    "rename_active_session",
    "resume_session",
    "list_sessions",
    "export_conversations",
    "handle_turn_intent",
    "load_whiteboard",
    "remember_turn",
    "recall_conversation",
    "prune_conversations",
    "RECALL_TOOL_SPEC",
    # Canonical Ephemeral API
    "EphemeralWhiteboard",
    # Canonical Workspace API
    "init_workspace_tables",
    "WORKSPACE_RECALL_TOOL_SPEC",
]
