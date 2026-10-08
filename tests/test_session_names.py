import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

import app


def _make_state_db(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, display_name TEXT, started_at REAL)"
    )
    conn.executemany("INSERT INTO sessions VALUES (?, ?, ?, ?)", rows)
    conn.commit()
    conn.close()


class SessionNamesTests(unittest.TestCase):
    def test_reads_titles_from_main_and_profile_dbs(self):
        now = time.time()
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            _make_state_db(base / "state.db", [
                ("cron_a_1", "X Bookmarks Analysis Pipeline · Jul 25", None, now - 60),
                ("untitled_1", None, None, now - 60),
                ("blank_1", "", "", now - 60),
                ("old_1", "Ancient", None, now - 90 * 86400),
            ])
            _make_state_db(base / "profiles" / "research" / "state.db", [
                ("desk_1", "Development Plan Progress #9", None, now - 60),
                ("disp_1", "title", "Display Wins", now - 60),
            ])
            names = app.read_session_names(base)
        self.assertEqual(names["cron_a_1"], "X Bookmarks Analysis Pipeline · Jul 25")
        self.assertEqual(names["desk_1"], "Development Plan Progress #9")
        self.assertEqual(names["disp_1"], "Display Wins")
        self.assertNotIn("untitled_1", names)
        self.assertNotIn("blank_1", names)
        self.assertNotIn("old_1", names)

    def test_missing_dbs_return_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(app.read_session_names(Path(tmp) / "nope"), {})


if __name__ == "__main__":
    unittest.main()
