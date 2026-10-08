import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import session_deepdive as sd


SCHEMA = """
CREATE TABLE records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL, host TEXT, event TEXT, kind TEXT, session_id TEXT,
  model TEXT, platform TEXT, duration_s REAL, tps REAL,
  input_tokens INTEGER, output_tokens INTEGER, finish_reason TEXT, error TEXT
);
"""

NOW = time.time()
MODEL = "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5"


def make_db(sessions):
    """sessions: {sid: [(age_s_ago, in, out, fin), ...]}; returns db path."""
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    conn = sqlite3.connect(path)
    conn.execute(SCHEMA)
    for sid, calls in sessions.items():
        for age, tin, tout, fin in calls:
            conn.execute(
                "INSERT INTO records (ts, kind, session_id, model, platform,"
                " input_tokens, output_tokens, finish_reason) VALUES (?,?,?,?,?,?,?,?)",
                (NOW - age, "api", sid, MODEL, "desktop", tin, tout, fin))
    conn.commit()
    conn.close()
    return path


def long_tool_session(n=100, start_in=8000, step=100):
    """n tool_calls with varied-but-growing context, ending 2h ago."""
    calls = []
    tin = start_in
    for i in range(n):
        # Genuinely varied steps (like the real 20260728_181333 session):
        # mostly ~1k growth with periodic tiny and large steps, so the
        # uniformity discriminator must NOT fire.
        d = step + (i % 7) * 150
        if i % 6 == 5:
            d = 40
        elif i % 11 == 10:
            d = 3500
        tin += d
        calls.append((7200 + (n - i) * 45, tin, 300 + (i % 5) * 100, "tool_calls"))
    return calls


def uniform_loop_session(n=8):
    tin = 30000
    calls = []
    for i in range(n):
        tin += 600
        calls.append(((n - i) * 30, tin, 150, "tool_calls"))
    return calls


class LoopSignatureTests(unittest.TestCase):
    def test_uniform_trailing_calls_flag_loop(self):
        pts = [(0, 1000 + i * 600, 0, 0, 0, "tool_calls") for i in range(8)]
        sig = sd.loop_signature(pts)
        self.assertTrue(sig["is_loop"])
        self.assertEqual(sig["median"], 600)

    def test_varied_steps_do_not_flag(self):
        steps = [100, 900, 250, 1300, 400, 800, 19]
        pts = [(0, 1000, 0, 0, 0, "tool_calls")]
        for d in steps:
            pts.append((0, pts[-1][1] + d, 0, 0, 0, "tool_calls"))
        self.assertFalse(sd.loop_signature(pts)["is_loop"])

    def test_stop_finish_breaks_signature(self):
        pts = [(0, 1000 + i * 600, 0, 0, 0, "tool_calls") for i in range(7)]
        pts.append((0, 8000, 0, 0, 0, "stop"))
        self.assertFalse(sd.loop_signature(pts)["is_loop"])


class AnalyzeTests(unittest.TestCase):
    def setUp(self):
        self.db = make_db({"sess-loop": uniform_loop_session(),
                           "sess-long": long_tool_session()})
        self.addCleanup(os.unlink, self.db)

    def test_loop_session_verdict_and_recommendation(self):
        a = sd.deepdive(self.db, "sess-loop", NOW - 86400, NOW, names={})
        self.assertTrue(a["loop"]["is_loop"])
        self.assertIn("LOOP SIGNATURE", a["verdict"])
        self.assertIn("retry loop", a["recommendation"])

    def test_long_session_is_not_called_a_loop(self):
        a = sd.deepdive(self.db, "sess-long", NOW - 86400, NOW, names={})
        self.assertFalse(a["loop"]["is_loop"])
        self.assertEqual(a["calls"], 100)
        self.assertGreater(a["ratio"], 50)
        # ratio concern must carry the context-resend caveat
        self.assertTrue(any("inflates naturally" in c for c in a["concerns"]))
        self.assertFalse(a["active"])

    def test_guardrail_name_triggers_resume_recommendation(self):
        a = sd.deepdive(self.db, "sess-long", NOW - 86400, NOW,
                        names={"sess-long": "Resuming Session After Loop Guardrail Hit"})
        self.assertTrue(any("guardrail" in c for c in a["concerns"]))
        self.assertIn("HITL checkpoint", a["recommendation"])

    def test_render_template_slots(self):
        a = sd.deepdive(self.db, "sess-long", NOW - 86400, NOW, names={})
        md = sd.render_markdown(a, NOW)
        for slot in ("**Status:**", "**Shape:**", "**Tokens:**", "**Loop verdict:**",
                     "**Recommendation:**", "Session sess-long"):
            self.assertIn(slot, md)

    def test_active_session_recommendation(self):
        db = make_db({"sess-live": long_tool_session(n=30)})
        self.addCleanup(os.unlink, db)
        # last call 45*1s ago pattern → rewrite last call to now
        conn = sqlite3.connect(db)
        conn.execute("UPDATE records SET ts=? WHERE session_id='sess-live'", (NOW - 10,))
        conn.commit(); conn.close()
        a = sd.deepdive(db, "sess-live", NOW - 86400, NOW, names={})
        self.assertTrue(a["active"])
        self.assertIn("Still running", a["recommendation"])

    def test_candidate_sessions_respects_min_calls(self):
        cands = sd.candidate_sessions(self.db, NOW - 86400, limit=5)
        self.assertIn("sess-long", cands)
        self.assertNotIn("sess-loop", cands)  # only 8 calls < MIN_CALLS


if __name__ == "__main__":
    unittest.main()
