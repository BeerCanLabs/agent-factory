import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from runtime.skills import load_skills, run_tool


class TestSkills(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.skills_dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_load_skill_with_vendored_dependency(self):
        skill_dir = self.skills_dir / "my-skill"
        skill_dir.mkdir(parents=True)
        (skill_dir / "skill.yaml").write_text("entry: main.py\n", encoding="utf-8")

        vendor_dir = skill_dir / "vendor"
        vendor_dir.mkdir()
        (vendor_dir / "mylib.py").write_text("def answer(): return 42\n", encoding="utf-8")

        (skill_dir / "main.py").write_text(
            "import mylib\n"
            "def tools():\n"
            "    return [{\n"
            "        'name': 'get_answer',\n"
            "        'description': 'returns 42',\n"
            "        'parameters': {},\n"
            "        'handler': lambda args, ctx: str(mylib.answer())\n"
            "    }]\n",
            encoding="utf-8",
        )

        tools, problems = load_skills([{"id": "my-skill"}], skills_dir=str(self.skills_dir))
        self.assertEqual(problems, [])
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0].name, "get_answer")
        self.assertEqual(run_tool(tools[0], "{}", {}), "42")

    def test_skill_root_precedence_over_vendor(self):
        # A2: skill root comes before vendor in sys.path
        skill_dir = self.skills_dir / "precedence-skill"
        skill_dir.mkdir(parents=True)
        (skill_dir / "skill.yaml").write_text("entry: main.py\n", encoding="utf-8")

        vendor_dir = skill_dir / "vendor"
        vendor_dir.mkdir()
        (vendor_dir / "config.py").write_text("VAL = 'from_vendor'\n", encoding="utf-8")
        (skill_dir / "config.py").write_text("VAL = 'from_root'\n", encoding="utf-8")

        (skill_dir / "main.py").write_text(
            "import config\n"
            "def tools():\n"
            "    return [{\n"
            "        'name': 'get_val',\n"
            "        'description': 'gets config',\n"
            "        'parameters': {},\n"
            "        'handler': lambda args, ctx: config.VAL\n"
            "    }]\n",
            encoding="utf-8",
        )

        tools, problems = load_skills([{"id": "precedence-skill"}], skills_dir=str(self.skills_dir))
        self.assertEqual(problems, [])
        self.assertEqual(len(tools), 1)
        self.assertEqual(run_tool(tools[0], "{}", {}), "from_root")

    def test_vendored_module_collision_between_skills(self):
        # A2: A vendored top-level module whose name collides with one already loaded
        # from another skill fails that skill's load with a clear error.
        skill1_dir = self.skills_dir / "skill-1"
        skill1_dir.mkdir(parents=True)
        (skill1_dir / "skill.yaml").write_text("entry: main.py\n", encoding="utf-8")
        vendor1 = skill1_dir / "vendor"
        vendor1.mkdir()
        (vendor1 / "shared_util.py").write_text("TAG = 'one'\n", encoding="utf-8")
        (skill1_dir / "main.py").write_text(
            "import shared_util\n"
            "def tools():\n"
            "    return [{'name': 'tool1', 'description': 'desc', 'parameters': {}, 'handler': lambda a, c: shared_util.TAG}]\n",
            encoding="utf-8",
        )

        skill2_dir = self.skills_dir / "skill-2"
        skill2_dir.mkdir(parents=True)
        (skill2_dir / "skill.yaml").write_text("entry: main.py\n", encoding="utf-8")
        vendor2 = skill2_dir / "vendor"
        vendor2.mkdir()
        (vendor2 / "shared_util.py").write_text("TAG = 'two'\n", encoding="utf-8")
        (skill2_dir / "main.py").write_text(
            "import shared_util\n"
            "def tools():\n"
            "    return [{'name': 'tool2', 'description': 'desc', 'parameters': {}, 'handler': lambda a, c: shared_util.TAG}]\n",
            encoding="utf-8",
        )

        tools, problems = load_skills(
            [{"id": "skill-1"}, {"id": "skill-2"}],
            skills_dir=str(self.skills_dir),
        )
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0].name, "tool1")
        self.assertEqual(len(problems), 1)
        self.assertIn("skill-2", problems[0])
        self.assertIn("vendored module 'shared_util' collides with module from skill 'skill-1'", problems[0])


if __name__ == "__main__":
    unittest.main()
