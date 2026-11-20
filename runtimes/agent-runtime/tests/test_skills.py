import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from runtime.skills import MAX_LOG_CHARS, Tool, load_skills, log_tool_error, run_tool


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

    def test_identical_vendored_files_in_two_skills_do_not_collide(self):
        # The SDLC story-breaker and DoR checker both vendor the same repo data and sibling package at one version.
        for i in (1, 2):
            d = self.skills_dir / f"same-{i}"
            (d / "vendor" / "repo" / "shared").mkdir(parents=True)
            (d / "vendor" / "repo" / "shared" / "rules.yaml").write_text("a: 1\n", encoding="utf-8")
            (d / "vendor" / "sibling").mkdir()
            (d / "vendor" / "sibling" / "__init__.py").write_text("TAG = 'same'\n", encoding="utf-8")
            (d / "skill.yaml").write_text("entry: main.py\n", encoding="utf-8")
            (d / "main.py").write_text(
                "import sibling\n"
                "def tools():\n"
                f"    return [{{'name': 'tool{i}', 'description': 'd', 'parameters': {{}}, 'handler': lambda a, c: sibling.TAG}}]\n",
                encoding="utf-8",
            )
        tools, problems = load_skills([{"id": "same-1"}, {"id": "same-2"}], skills_dir=str(self.skills_dir))
        self.assertEqual(problems, [])
        self.assertEqual([t.name for t in tools], ["tool1", "tool2"])
        self.assertEqual([run_tool(t, "{}", {}) for t in tools], ["same", "same"])
        (self.skills_dir / "same-2" / "vendor" / "repo" / "shared" / "rules.yaml").write_text("a: 2\n", encoding="utf-8")
        _, problems = load_skills([{"id": "same-1"}, {"id": "same-2"}], skills_dir=str(self.skills_dir))
        self.assertIn("vendored module 'repo' collides with module from skill 'same-1'", problems[0])



class TestToolErrorsAreLogged(unittest.TestCase):
    """GAP-254: a failing tool is logged on stderr, with known secret values masked, as well as told to the model."""

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

    def test_a_token_straddling_the_cut_is_masked_as_text_and_as_a_json_reason(self):
        run_token = "rt" + "-example-" + "ABCDEFGHIJKLMNOPQRSTUV"
        with mock.patch.dict(os.environ, {"FACTORY_RUN_TOKEN": run_token}):
            for cut in (300, MAX_LOG_CHARS):
                pad = "x" * (cut - 60)
                _, text = self.run_logged(lambda a, c: f"error: {pad}{run_token} tail")
                _, reason = self.run_logged(lambda a, c: json.dumps({"action": "error", "reason": pad + run_token}))
                for log in (text, reason):
                    self.assertNotIn(run_token[:8], log)
                    self.assertLessEqual(len(log.strip()), MAX_LOG_CHARS)
            # A text already cut short ends in the start of the token.
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                log_tool_error("s/t", "x" * 50 + run_token[:12])
            self.assertNotIn(run_token[:8], err.getvalue())
            self.assertTrue(err.getvalue().strip().endswith("***"))

    def test_common_credential_shapes_are_masked(self):
        secret = "S3cr3t" + "Value" + "9876"
        jwt = "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxIn0" + "." + "abcDEF123_-"
        pem = "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIEow" + secret + "\n-----END RSA " + "PRIVATE KEY-----"
        rows = {
            "query": f"GET /x?access_token={secret}&page=2",
            "json": json.dumps({"token": secret}),
            "aws": f"aws_secret_access_key={secret}",
            "jwt": f"session {jwt} refused",
            "userinfo": f"https://bot:{secret}@db.example.com/x",
            "password": f"password: {secret}",
            "authorization": f"Authorization: Basic {secret}",
            "pem": f"key {pem} bad",
        }
        for name, leak in rows.items():
            with self.subTest(name):
                def boom(args, ctx, leak=leak):
                    raise RuntimeError(leak)

                _, log = self.run_logged(boom)
                self.assertNotIn(secret, log)
                self.assertNotIn(jwt, log)
                self.assertIn("***", log)
        self.assertIn("page=2", self.run_logged(lambda a, c: (_ for _ in ()).throw(RuntimeError(rows["query"])))[1])

    def test_the_label_is_masked_too(self):
        pat = "ghp" + "_" + "B2" * 12
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            log_tool_error(f"unknown/{pat}", "no such tool")
        self.assertNotIn(pat, err.getvalue())
        self.assertIn("unknown/***", err.getvalue())


    def test_masking_is_fast_on_long_input_on_both_paths(self):
        import time
        run_token = "rt" + "-example-" + "ABCDEFGHIJKLMNOPQRSTUV"
        words = "a" * 200_000
        with mock.patch.dict(os.environ, {"FACTORY_RUN_TOKEN": run_token}):
            started = time.monotonic()
            _, reported = self.run_logged(lambda a, c: f"error: {words}")

            def boom(args, ctx):
                raise RuntimeError(words + "token_" * 20_000 + run_token)

            _, raised = self.run_logged(boom)
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.0)
        for log in (reported, raised):
            self.assertLessEqual(len(log.strip()), MAX_LOG_CHARS)
            self.assertNotIn(run_token[:8], log)

    def test_a_cookie_is_masked_and_ordinary_names_are_not(self):
        sid = "s3ss10n" + "Value" + "77"
        _, log = self.run_logged(lambda a, c: f"error: 401 with Cookie: session={sid}; repo BeerCanLabs/task-scheduler")
        self.assertNotIn(sid, log)
        for name in ("BeerCanLabs/task-scheduler", "acme/risk-analysis", "acme/kiosk-frontend", "acme/Disk-Cleanup-tool"):
            self.assertIn(name, self.run_logged(lambda a, c, n=name: f"error: cannot open {n}")[1])
        key = "sk" + "-" + "proj" + "A1b2C3d4E5f6G7h8"
        self.assertNotIn(key, self.run_logged(lambda a, c: f"error: bad key {key}")[1])

class ChildSpeakerToolGuard(unittest.TestCase):
    def test_child_speaker_cannot_call_or_ask_agents(self):
        called = {"n": 0}

        def handler(args, ctx):
            called["n"] += 1
            return "should-not-run"

        ctx = {"caller": {"actor": "user:kid", "relationship": "child"}}
        for name in ("ask_agent", "call_agent"):
            out = json.loads(run_tool(Tool("agent-connect", name, "", {}, handler), '{"agent": "donna"}', ctx))
            self.assertEqual(out["error"], "child_restricted")
        self.assertEqual(called["n"], 0)
        # Adults still reach the tool. A family caller is not restricted here.
        out = run_tool(
            Tool("agent-connect", "ask_agent", "", {}, handler),
            '{"agent": "donna"}',
            {"caller": {"actor": "user:parent", "relationship": "family"}},
        )
        self.assertEqual(out, "should-not-run")
        self.assertEqual(called["n"], 1)

if __name__ == "__main__":
    unittest.main()
