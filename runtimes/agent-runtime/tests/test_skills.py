"""Tests for skill loading, vendoring, and module precedence (A2)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from runtime.skills import load_skills, run_tool  # noqa: E402


class TestSkillVendoring(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.skills_dir = Path(self.tmp.name) / "skills"
        self.skills_dir.mkdir(parents=True)
        os.environ["SKILLS_DIR"] = str(self.skills_dir)

    def tearDown(self):
        self.tmp.cleanup()

    def test_vendored_package_is_importable_and_cleaned_up(self):
        folder = self.skills_dir / "with-vendor"
        (folder / "vendor" / "pkg").mkdir(parents=True)
        (folder / "skill.yaml").write_text("id: with-vendor\nversion: 1.0.0\nlanguage: python\nentry: entry.py\n")
        (folder / "vendor" / "pkg" / "__init__.py").write_text("VALUE = 'vendored_ok'\n")
        (folder / "entry.py").write_text(
            "import pkg\n"
            "def tools():\n"
            "    return [{'name': 'get_val', 'description': 'x', 'parameters': {}, 'handler': lambda a, c: pkg.VALUE}]\n"
        )
        before_modules = set(sys.modules)
        before_path = list(sys.path)

        tools, problems = load_skills([{"id": "with-vendor"}])
        self.assertEqual(problems, [])
        self.assertEqual(len(tools), 1)
        self.assertEqual(run_tool(tools[0], "{}", {}), "vendored_ok")

        # After load_skills, vendored modules must be removed from sys.modules and sys.path restored
        self.assertNotIn("pkg", sys.modules)
        self.assertEqual(sys.path, before_path)

    def test_skill_root_takes_precedence_over_vendored_module_collision(self):
        folder = self.skills_dir / "collision"
        (folder / "vendor").mkdir(parents=True)
        (folder / "skill.yaml").write_text("id: collision\nversion: 1.0.0\nlanguage: python\nentry: entry.py\n")
        # Same module name 'colliding' in both root and vendor
        (folder / "colliding.py").write_text("ORIGIN = 'root'\n")
        (folder / "vendor" / "colliding.py").write_text("ORIGIN = 'vendor'\n")
        (folder / "entry.py").write_text(
            "import colliding\n"
            "def tools():\n"
            "    return [{'name': 'check_origin', 'description': 'x', 'parameters': {}, 'handler': lambda a, c: colliding.ORIGIN}]\n"
        )

        tools, problems = load_skills([{"id": "collision"}])
        self.assertEqual(problems, [])
        self.assertEqual(len(tools), 1)
        # Root must take precedence because root is before vendor on sys.path
        self.assertEqual(run_tool(tools[0], "{}", {}), "root")
        self.assertNotIn("colliding", sys.modules)


if __name__ == "__main__":
    unittest.main()
