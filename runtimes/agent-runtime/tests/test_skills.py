import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from runtime.skills import Tool, load_skills, run_tool


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


class TestToolErrorsAreLogged(unittest.TestCase):
    """GAP-262: a failing tool is logged on stderr, with known secret values masked, as well as told to the model."""

    def run_logged(self, handler, raw="{}"):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            out = run_tool(Tool("sdlc-conductor", "sdlc-on-event", "", {}, handler), raw, {})
        return out, err.getvalue()

    def test_an_exception_is_logged_with_its_type_and_place_and_still_returned(self):
        def boom(args, ctx):
            raise ValueError("event.type must be one of plan-submitted")

        out, log = self.run_logged(boom)
        self.assertEqual(out, "error: event.type must be one of plan-submitted")
        self.assertIn("[runtime] tool sdlc-conductor/sdlc-on-event failed: ValueError: event.type must be one of plan-submitted", log)
        self.assertIn("test_skills.py:", log)

    def test_bad_arguments_are_logged(self):
        self.assertIn("failed: arguments must be an object", self.run_logged(lambda a, c: "ok", "[1]")[1])
        self.assertIn("failed: JSONDecodeError", self.run_logged(lambda a, c: "ok", "{nope")[1])
        self.assertIn("arguments too large", self.run_logged(lambda a, c: "ok", "x" * 20001)[1])

    def test_a_result_that_reports_an_error_is_logged_and_a_good_one_is_not(self):
        out, log = self.run_logged(lambda a, c: '{"event": "story-ready", "action": "error", "reason": "GitHub 403"}')
        self.assertIn('"action": "error"', out)
        self.assertIn("failed: reported: GitHub 403", log)
        self.assertIn("failed: reported: error: no board", self.run_logged(lambda a, c: "error: no board")[1])
        self.assertEqual(self.run_logged(lambda a, c: '{"action": "started"}')[1], "")

    def test_the_run_token_and_credential_shapes_are_masked(self):
        run_token = "rt" + "-example-" + "7" * 12
        pat = "ghp" + "_" + "A1" * 12
        with mock.patch.dict(os.environ, {"FACTORY_RUN_TOKEN": run_token}):
            def leak(args, ctx):
                raise RuntimeError(f"401 at {run_token}; header Bearer {run_token}; pat {pat}")

            _, log = self.run_logged(leak)
        self.assertNotIn(run_token, log)
        self.assertNotIn(pat, log)
        self.assertIn("401 at ***", log)
