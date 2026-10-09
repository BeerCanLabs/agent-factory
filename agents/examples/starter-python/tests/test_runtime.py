import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import agent


class TestRuntime(unittest.TestCase):
    def test_agent_initialization(self):
        """Verify core agent startup, memory hydration, and result file generation."""
        with tempfile.TemporaryDirectory() as tmp_dir:
            mind_dir = Path(tmp_dir) / "mind"
            result_file = Path(tmp_dir) / "factory-result.json"

            os.environ["MEMORY_DIR"] = str(mind_dir)
            os.environ["FACTORY_RESULT_FILE"] = str(result_file)
            os.environ["FACTORY_INPUT"] = json.dumps({"message": "test alert", "service": "web-api", "event": "500-rate"})

            try:
                exit_code = agent.main()
                self.assertEqual(exit_code, 0)
                self.assertTrue(result_file.exists(), "factory-result.json must be written")

                result_data = json.loads(result_file.read_text("utf-8"))
                self.assertEqual(result_data["status"], "succeeded")
                self.assertEqual(result_data["output"]["archetype"], "episodic")
                self.assertIn("Processed alert for web-api", result_data["output"]["summary"])

                db_path = mind_dir / "starter_python_state.db"
                self.assertTrue(db_path.exists(), "starter_python_state.db must exist for episodic archetype")
            finally:
                os.environ.pop("MEMORY_DIR", None)
                os.environ.pop("FACTORY_RESULT_FILE", None)
                os.environ.pop("FACTORY_INPUT", None)

    def test_agent_initialization_ephemeral(self):
        """Verify agent execution with ephemeral archetype (no SQLite file generated)."""
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp_dir:
            mind_dir = Path(tmp_dir) / "mind"
            result_file = Path(tmp_dir) / "factory-result.json"

            os.environ["MEMORY_DIR"] = str(mind_dir)
            os.environ["FACTORY_RESULT_FILE"] = str(result_file)
            os.environ["FACTORY_INPUT"] = json.dumps({"message": "ephemeral ping", "service": "healthcheck"})

            try:
                with patch("agent.load_archetype_from_cartridge", return_value=("ephemeral", {})):
                    exit_code = agent.main()
                self.assertEqual(exit_code, 0)
                self.assertTrue(result_file.exists())

                result_data = json.loads(result_file.read_text("utf-8"))
                self.assertEqual(result_data["status"], "succeeded")
                self.assertEqual(result_data["output"]["archetype"], "ephemeral")
                self.assertIn("Ephemeral query processed", result_data["output"]["summary"])

                db_path = mind_dir / "starter_python_state.db"
                self.assertFalse(db_path.exists(), "ephemeral archetype must NOT create an episodic database")
            finally:
                os.environ.pop("MEMORY_DIR", None)
                os.environ.pop("FACTORY_RESULT_FILE", None)
                os.environ.pop("FACTORY_INPUT", None)

    def test_agent_initialization_workspace(self):
        """Verify agent execution with workspace archetype (project-partitioned SQLite)."""
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp_dir:
            mind_dir = Path(tmp_dir) / "mind"
            result_file = Path(tmp_dir) / "factory-result.json"

            os.environ["MEMORY_DIR"] = str(mind_dir)
            os.environ["FACTORY_RESULT_FILE"] = str(result_file)
            os.environ["FACTORY_INPUT"] = json.dumps({
                "message": "Implement feature X",
                "project_id": "proj-gamma",
                "task_id": "task-42"
            })

            try:
                with patch("agent.load_archetype_from_cartridge", return_value=("workspace", {})):
                    exit_code = agent.main()
                self.assertEqual(exit_code, 0)
                self.assertTrue(result_file.exists())

                result_data = json.loads(result_file.read_text("utf-8"))
                self.assertEqual(result_data["status"], "succeeded")
                self.assertEqual(result_data["output"]["archetype"], "workspace")
                self.assertIn("proj-gamma", result_data["output"]["summary"])

                workspace_db = mind_dir / "workspace_proj-gamma.db"
                self.assertTrue(workspace_db.exists(), "workspace_proj-gamma.db must exist for workspace archetype")
            finally:
                os.environ.pop("MEMORY_DIR", None)
                os.environ.pop("FACTORY_RESULT_FILE", None)
                os.environ.pop("FACTORY_INPUT", None)


if __name__ == "__main__":
    unittest.main()
