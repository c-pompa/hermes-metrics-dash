"""SQLite store for harness samples. Served by app.py alongside benchmark.py.

The collector (harness/collector.py) POSTs ``harness_sample`` records to
/ingest; app.py routes them here (dedicated table, shared metrics.db) while
also letting the row ride the records table so the /events SSE stream
carries it. Py3.9, stdlib only.
"""
import json
import sqlite3
import threading
import time

COLS = ("ts", "model", "fp", "config", "prompt_class", "ttft_s", "tps",
        "tokens", "thermal", "swap_mb", "host", "label")


def normalize_sample(rec: dict, host: str, now: float = None) -> dict:
    """Coerce a raw harness_sample record into a harness_samples row.

    The record's own ``host`` wins; the payload-level host is the fallback.
    ``config`` is stored as a canonical JSON string (dict or str both accepted).
    """
    ts = rec.get("ts")
    if ts is None:
        ts = now if now is not None else time.time()
    try:
        ts = float(ts)
    except (TypeError, ValueError):
        ts = float(now) if now is not None else time.time()
    config = rec.get("config")
    if isinstance(config, dict):
        config = json.dumps(config, sort_keys=True)
    row = {c: rec.get(c) for c in COLS}
    row["ts"] = ts
    row["config"] = config
    row["host"] = rec.get("host") or host
    return row


class HarnessStore:
    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._ensure()

    def _ensure(self):
        with sqlite3.connect(self.path) as con:
            con.execute("""CREATE TABLE IF NOT EXISTS harness_samples (
                ts REAL, model TEXT, fp TEXT, config TEXT, prompt_class TEXT,
                ttft_s REAL, tps REAL, tokens INTEGER,
                thermal TEXT, swap_mb INTEGER, host TEXT, label TEXT)""")
            con.execute("CREATE INDEX IF NOT EXISTS ix_harness_fp "
                        "ON harness_samples(fp, ts)")

    def add(self, s: dict):
        # Reject degenerate placeholders (empty-stream reps: no metrics, no
        # tokens). Defense in depth — the collector filters these too.
        if (s.get("tokens") in (0, None) and s.get("tps") is None
                and s.get("ttft_s") is None):
            raise ValueError("degenerate harness_sample rejected: no metrics, no tokens")
        vals = [s.get(c) for c in COLS]
        with self._lock, sqlite3.connect(self.path) as con:
            con.execute(
                "INSERT INTO harness_samples ({cols}) VALUES ({ph})".format(
                    cols=",".join(COLS), ph=",".join("?" * len(COLS))), vals)

    def recent(self, hours: float = 24, limit=5000) -> list:
        cut = time.time() - hours * 3600
        with self._lock, sqlite3.connect(self.path) as con:
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT * FROM harness_samples WHERE ts > ? ORDER BY ts LIMIT ?",
                (cut, limit)).fetchall()
            return [dict(r) for r in rows]

    def best(self, n=10) -> list:
        with self._lock, sqlite3.connect(self.path) as con:
            con.row_factory = sqlite3.Row
            rows = con.execute("""
                SELECT fp, prompt_class, COUNT(*) AS n,
                       AVG(tps) AS median_tps, AVG(ttft_s) AS avg_ttft
                FROM harness_samples WHERE tps IS NOT NULL
                GROUP BY fp, prompt_class ORDER BY median_tps DESC LIMIT ?""",
                (n,)).fetchall()
            return [dict(r) for r in rows]

    def mark(self, fp: str, label: str):
        with self._lock, sqlite3.connect(self.path) as con:
            con.execute("UPDATE harness_samples SET label=? WHERE fp=?",
                        (label, fp))

    def prune_older_than(self, cutoff: float) -> int:
        """Delete samples with ts < cutoff. Returns count."""
        with self._lock, sqlite3.connect(self.path) as con:
            cur = con.execute("DELETE FROM harness_samples WHERE ts < ?",
                              (cutoff,))
            con.commit()
            return cur.rowcount
