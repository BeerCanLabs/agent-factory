import unittest
from pathlib import Path
import tempfile

from session import FactoryClient, empty_state, load_state, save_state, turn


class FakeFactory(FactoryClient):
    def __init__(self, cap=1):
        super().__init__(base_url="http://factory.test", run_id="run-1", token="run-token")
        self.cap = cap
        self.baselines = []
        self.runs = []
        self.recommended = False

    def account(self, skill_id):
        return {"skillId": skill_id, "capUsd": self.cap, "spentUsd": 0}

    def baseline(self, skill_id, cases):
        self.baselines.append((skill_id, cases))
        return {"skillId": skill_id, "cases": len(cases)}

    def run(self, skill_id, model, cost, outputs):
        self.runs.append({"model": model, "cost": cost, "outputs": outputs})
        passed = 1 if "brief" in outputs[0]["output"] else 0
        return {"passed": passed, "failed": 1 - passed, "costUsd": cost}

    def recommend(self, skill_id):
        self.recommended = True
        return {"skillId": skill_id, "recommendation": {"model": "small", "costUsd": 0.2}, "adopted": False}


class SessionTest(unittest.TestCase):
    def test_stops_when_the_skill_has_no_cap(self):
        factory = FakeFactory(cap=None)
        state = empty_state()
        reply = turn(state, "skill summarize", factory)
        self.assertIn("no training cap", reply)
        self.assertIn("Set a training cap", turn(state, "case short | note | contains:brief", factory))
        self.assertEqual(factory.baselines, [])

    def test_sends_score_and_recommendation_to_the_factory(self):
        factory = FakeFactory()
        state = empty_state()
        self.assertIn("skill", turn(state, "help", factory))
        self.assertIn("$1", turn(state, "skill summarize", factory))
        self.assertIn("Recorded", turn(state, "case short | a long note | contains:brief", factory))
        self.assertIn("factory has the scorecard", turn(state, "models small, large", factory))
        self.assertEqual(factory.baselines[0][0], "summarize")
        self.assertIn("scored", turn(state, "trial small | short | a brief note | 0.20", factory))
        self.assertIn("scored", turn(state, "trial large | short | a brief note | 0.90", factory))
        self.assertEqual([run["model"] for run in factory.runs], ["small", "large"])
        reply = turn(state, "recommend", factory)
        self.assertTrue(factory.recommended)
        self.assertIn("factory recommends `small`", reply)
        self.assertIn("have not changed the skill", reply)

    def test_session_round_trips(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trainer-session.json"
            state = empty_state()
            turn(state, "skill summarize", FakeFactory())
            save_state(path, state)
            self.assertEqual(load_state(path)["skillId"], "summarize")


if __name__ == "__main__":
    unittest.main()
