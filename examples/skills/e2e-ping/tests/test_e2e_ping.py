import unittest

import e2e_ping


class E2ePingTests(unittest.TestCase):
    def test_one_tool_returns_the_code(self):
        tools = e2e_ping.tools()
        self.assertEqual([t["name"] for t in tools], ["e2e_ping_code"])
        self.assertEqual(tools[0]["handler"]({}, {}), "PING-OK-7c1f4e92")

    def test_it_loads_the_way_the_runtime_loads_it(self):
        import sys
        from pathlib import Path

        root = Path(__file__).resolve().parents[4] / "runtimes" / "agent-runtime"
        if not root.exists():
            self.skipTest("run from the factory repository")
        sys.path.insert(0, str(root))
        try:
            from runtime.skills import load_skills, run_tool

            loaded, problems = load_skills([{"id": "e2e-ping"}], skills_dir=str(Path(__file__).resolve().parents[2]))
        finally:
            sys.path.remove(str(root))
        self.assertEqual(problems, [])
        self.assertEqual(run_tool(loaded[0], "{}", {}), "PING-OK-7c1f4e92")


if __name__ == "__main__":
    unittest.main()
