import unittest
from pathlib import Path
import tempfile

from session import empty_state, load_state, save_state, turn


class SessionTest(unittest.TestCase):
    def test_guides_then_recommends_the_cheaper_pass(self):
        state = empty_state()
        self.assertIn("skill", turn(state, "help"))
        self.assertIn("summarize", turn(state, "skill summarize"))
        self.assertIn("Recorded", turn(state, "case short | a long note | contains:brief"))
        self.assertIn("trial", turn(state, "models small, large"))
        self.assertIn("pass", turn(state, "trial small | short | a brief note | 0.20"))
        self.assertIn("pass", turn(state, "trial large | short | a brief note | 0.90"))
        reply = turn(state, "recommend")
        self.assertIn("small", reply)
        self.assertIn("have not changed the skill", reply)
        self.assertNotIn("long note", reply)

    def test_refuses_a_model_that_missed(self):
        state = empty_state()
        turn(state, "skill summarize")
        turn(state, "case short | note | equals:brief")
        turn(state, "models small, large")
        turn(state, "trial small | short | brief | 0.10")
        turn(state, "trial large | short | very long | 0.05")
        self.assertIn("small", turn(state, "recommend"))

    def test_session_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trainer-session.json"
            state = empty_state()
            turn(state, "skill summarize")
            save_state(path, state)
            loaded = load_state(path)
            self.assertEqual(loaded["skillId"], "summarize")


if __name__ == "__main__":
    unittest.main()
