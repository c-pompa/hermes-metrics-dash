import json
import tempfile
import unittest
from pathlib import Path

import app


class BetaWidgetsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_path = app.BETA_WIDGETS_PATH
        app.BETA_WIDGETS_PATH = Path(self._tmp.name) / "beta-widgets.json"

    def tearDown(self):
        app.BETA_WIDGETS_PATH = self._orig_path
        self._tmp.cleanup()

    def test_missing_file_reads_empty(self):
        self.assertEqual(app.read_beta_widgets(), {"widgets": {}})

    def test_corrupt_file_reads_empty(self):
        app.BETA_WIDGETS_PATH.write_text("not json")
        self.assertEqual(app.read_beta_widgets(), {"widgets": {}})

    def test_decision_round_trip_preserves_reviews(self):
        seed = {"widgets": {"agent-loop-detector": {
            "status": "beta",
            "reviews": [{"date": "2026-07-27", "verdict": "promising"}],
            "final_analysis": "works",
        }}}
        app.BETA_WIDGETS_PATH.write_text(json.dumps(seed))
        data = app.record_beta_decision("agent-loop-detector", "keep")
        widget = data["widgets"]["agent-loop-detector"]
        self.assertEqual(widget["status"], "kept")
        self.assertEqual(widget["decision"]["choice"], "keep")
        self.assertEqual(widget["reviews"], seed["widgets"]["agent-loop-detector"]["reviews"])
        on_disk = json.loads(app.BETA_WIDGETS_PATH.read_text())
        self.assertEqual(on_disk["widgets"]["agent-loop-detector"]["status"], "kept")

    def test_delete_decision(self):
        data = app.record_beta_decision("agent-loop-detector", "delete")
        self.assertEqual(data["widgets"]["agent-loop-detector"]["status"], "deleted")

    def test_invalid_decision_rejected(self):
        with self.assertRaises(ValueError):
            app.record_beta_decision("agent-loop-detector", "maybe")
        with self.assertRaises(ValueError):
            app.record_beta_decision("", "keep")


if __name__ == "__main__":
    unittest.main()
