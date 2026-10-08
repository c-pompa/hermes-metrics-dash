import json
import math
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import app


ROOT = Path(__file__).resolve().parents[1]
INDEX_HTML = ROOT / "static" / "index.html"
FRONTEND_MODULES = ["util.js", "state.js", "tips.js", "charts.js", "filters.js", "envmode.js", "main.js"]


def frontend_source() -> str:
    """index.html markup + the extracted JS modules (post-extraction)."""
    parts = [INDEX_HTML.read_text(encoding="utf-8")]
    parts += [
        (ROOT / "static" / name).read_text(encoding="utf-8")
        for name in FRONTEND_MODULES
    ]
    return "\n".join(parts)


class RecentQueryTests(unittest.TestCase):
    def test_defaults_to_recent_day_and_default_limit(self):
        since, until, limit = app.parse_recent_query("", now=100_000.0)

        self.assertEqual((since, until, limit), (13_600.0, 100_000.0, 3_000))

    def test_caps_limit_at_server_maximum(self):
        _, _, limit = app.parse_recent_query("limit=999999", now=100_000.0)

        self.assertEqual(limit, 20_000)

    def test_rejects_invalid_and_non_positive_limits(self):
        for query in ("limit=nope", "limit=0", "limit=-1"):
            with self.subTest(query=query):
                with self.assertRaisesRegex(ValueError, "limit"):
                    app.parse_recent_query(query, now=100_000.0)

    def test_rejects_invalid_hours(self):
        for value in ("nope", "0", "-1", "nan", "inf", "1e308"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "hours"):
                    app.parse_recent_query(f"hours={value}", now=100_000.0)

    def test_rejects_invalid_explicit_range_values(self):
        for query, field in (
            ("from=nope&to=2", "from"),
            ("from=1&to=nope", "to"),
            ("from=nan&to=2", "from"),
            ("from=1&to=inf", "to"),
        ):
            with self.subTest(query=query):
                with self.assertRaisesRegex(ValueError, field):
                    app.parse_recent_query(query, now=100_000.0)

    def test_rejects_missing_from_and_reversed_ranges(self):
        for query in ("to=2", "from=2&to=2", "from=3&to=2"):
            with self.subTest(query=query):
                with self.assertRaises(ValueError):
                    app.parse_recent_query(query, now=100_000.0)

    def test_accepts_finite_explicit_range(self):
        since, until, limit = app.parse_recent_query(
            "from=10.5&to=20.5&limit=12", now=100_000.0
        )

        self.assertTrue(math.isfinite(since))
        self.assertEqual((since, until, limit), (10.5, 20.5, 12))


class RecentHttpValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp_dir = tempfile.TemporaryDirectory()
        app.Handler.store = app.Store(str(Path(cls.temp_dir.name) / "metrics.db"))
        app.Handler.bus = app.Broadcaster()
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        app.Handler.store._conn.close()
        cls.temp_dir.cleanup()

    def test_invalid_recent_queries_return_json_400_and_server_stays_healthy(self):
        queries = (
            "limit=nope",
            "limit=0",
            "limit=-1",
            "hours=nope",
            "hours=0",
            "from=nope&to=2",
            "from=1&to=nope",
            "from=2&to=1",
            "to=2",
        )
        for query in queries:
            with self.subTest(query=query):
                with self.assertRaises(urllib.error.HTTPError) as raised:
                    urllib.request.urlopen(
                        f"{self.base_url}/api/recent?{query}", timeout=2
                    )
                self.assertEqual(raised.exception.code, 400)
                payload = json.load(raised.exception)
                self.assertEqual(set(payload), {"error"})
                self.assertTrue(payload["error"])

        with urllib.request.urlopen(f"{self.base_url}/health", timeout=2) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.load(response), {"status": "ok"})


class DashboardHardeningContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = frontend_source()

    def test_history_fetch_exposes_loading_stale_and_retry_feedback(self):
        self.assertIn('id="retryload"', self.source)
        self.assertIn('"loading history…"', self.source)
        self.assertIn('"stale data — retry history"', self.source)
        self.assertIn("if (!resp.ok)", self.source)
        self.assertIn('addEventListener("click", refetch)', self.source)


if __name__ == "__main__":
    unittest.main()
