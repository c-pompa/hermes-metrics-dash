# tests/test_harness_store.py
"""Unit + app-level tests for the mini-side harness sample store (plan Task 5).

harness_store is a small companion module to benchmark.py: it owns the
harness_samples table shape, one normalize function, and a temp-db-friendly
HarnessStore. app.py reuses the same module for its own routes.

The plan's fixture used a hardcoded ts=1727300000 (Sept 2024) with a
recent(hours=1) window — that pair can never match, so the fixture stamps
the real wallclock instead. Every assertion in the plan is preserved as-is.

The app-level tests boot `python3 app.py --db <tmp>` (same pattern as
test_http_smoke) and monkeypatch Handler.harness onto a temp HarnessStore, so
no real ~/.hermes/metrics DB is touched. Py3.9, stdlib only.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from harness_store import HarnessStore, normalize_sample


class TestHarnessStore(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = HarnessStore(os.path.join(self.tmp, "h.db"))

    def _sample(self, **kw):
        base = {"ts": time.time(), "model": "qwen3.8-27b-hermes",
                "fp": "abc123def456", "config": '{"context_length":32768}',
                "prompt_class": "long_gen", "ttft_s": 0.4, "tps": 22.5,
                "tokens": 400, "thermal": "nominal", "swap_mb": 0,
                "host": "mbp"}
        base.update(kw)
        return base

    def test_insert_and_fetch(self):
        self.store.add(self._sample())
        rows = self.store.recent(hours=1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["fp"], "abc123def456")

    def test_best_per_prompt_class(self):
        self.store.add(self._sample(fp="fast1", tps=30.0))
        self.store.add(self._sample(fp="fast1", tps=32.0))
        self.store.add(self._sample(fp="slow1", tps=20.0))
        best = self.store.best(n=3)
        self.assertEqual(best[0]["fp"], "fast1")
        self.assertEqual(best[0]["median_tps"], 31.0)

    def test_marks(self):
        self.store.add(self._sample(fp="fast1"))
        self.store.mark("fast1", "baseline-4bit-q8kv")
        rows = self.store.recent(hours=1)
        self.assertEqual(rows[0]["label"], "baseline-4bit-q8kv")

    def test_recent_time_window(self):
        self.store.add(self._sample(fp="old", ts=time.time() - 3 * 3600))
        self.store.add(self._sample(fp="new"))
        rows = self.store.recent(hours=1)
        self.assertEqual([r["fp"] for r in rows], ["new"])

    def test_recent_limit(self):
        self.store.add(self._sample(fp="a"))
        self.store.add(self._sample(fp="b"))
        self.assertEqual(len(self.store.recent(hours=1, limit=1)), 1)

    def test_best_null_tps_skipped(self):
        self.store.add(self._sample(fp="ghost", tps=None))
        self.assertEqual(self.store.best(n=3), [])

    def test_degenerate_placeholder_rejected(self):
        """H-6 defense in depth: a row with no metrics AND no tokens must
        raise ValueError, not land as junk in sqlite."""
        for bad in ({"tokens": 0, "tps": None, "ttft_s": None},
                    {"tokens": None, "tps": None, "ttft_s": None}):
            with self.assertRaises(ValueError):
                self.store.add(self._sample(**bad))
        rows = self.store.recent(hours=1)
        self.assertEqual(rows, [])

    def test_normalize_sample_types_and_defaults(self):
        row = normalize_sample(
            {"ts": "1727300000", "model": "m", "fp": "f" * 12,
             "config": {"context_length": 8192}, "prompt_class": "long_gen",
             "ttft_s": 0.4, "tps": 22.5, "tokens": 400},
            host="webhost", now=1727300000,
        )
        self.assertEqual(row["ts"], 1727300000.0)
        self.assertEqual(json.loads(row["config"]), {"context_length": 8192})
        self.assertIn("tps", row) and self.assertEqual(row["tokens"], 400)
        # the record's own host wins; payload host is the fallback.
        self.assertEqual(row["host"], "webhost")
        row2 = normalize_sample(
            {"ts": time.time(), "model": "m", "fp": "f" * 12,
             "prompt_class": None}, host="mbp", now=1727300000)
        self.assertEqual(row2["host"], "mbp")
        self.assertIsNone(row2["prompt_class"])

    def test_prune_older_than(self):
        self.store.add(self._sample(fp="old", ts=time.time() - 72 * 3600))
        self.store.add(self._sample(fp="new"))
        pruned = self.store.prune_older_than(time.time() - 24 * 3600)
        self.assertEqual(pruned, 1)
        self.assertEqual([r["fp"] for r in self.store.recent(hours=96)],
                         ["new"])


def _allocate_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _get_json(url):
    with urllib.request.urlopen(url, timeout=5) as response:
        return response.status, json.load(response)


def _post_json(url, payload):
    request = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer test-admin-token"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


def _sample_rec(**kw):
    base = {"event": "harness_sample", "ts": time.time(),
            "model": "qwen3.8-27b-hermes", "fp": "cafe01beef01",
            "config": {"context_length": 32768},
            "prompt_class": "long_gen", "ttft_s": 0.4, "tps": 21.5,
            "tokens": 380, "thermal": "nominal", "swap_mb": 12}
    base.update(kw)
    return base


class TestHarnessAppApi(unittest.TestCase):
    """app.py routes over a real temp DB; Handler.harness is monkeypatched
    onto a per-test store (test_http_smoke pattern)."""

    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    _tmp = None
    _process = None

    @classmethod
    def setUpClass(cls):
        import app as app_mod
        cls.app_mod = app_mod
        cls._tmp = tempfile.TemporaryDirectory()
        cls.port = _allocate_local_port()
        env = dict(os.environ)
        env["METRICS_RETENTION_DAYS"] = "0"  # disable prune thread in tests
        env["METRICS_ADMIN_TOKEN"] = "test-admin-token"
        cls._process = subprocess.Popen(
            [sys.executable, "app.py", "--bind", "127.0.0.1",
             "--port", str(cls.port),
             "--db", os.path.join(cls._tmp.name, "harness-smoke.db")],
            cwd=cls.ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.monotonic() + 15
        while True:
            if cls._process.poll() is not None:
                cls.fail("app.py exited early:\n" + cls._process.stdout.read())
            try:
                _get_json(f"http://127.0.0.1:{cls.port}/health")
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    cls.fail("app.py did not become healthy within 15 seconds")
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        if cls._process and cls._process.poll() is None:
            cls._process.terminate()
        try:
            if cls._process:
                cls._process.communicate(timeout=5)
        except Exception:
            if cls._process:
                cls._process.kill()
                cls._process.communicate(timeout=5)
        if cls._tmp:
            cls._tmp.cleanup()

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.store = HarnessStore(os.path.join(self.tmp, "unit.db"))
        # The app's real Handler.harness points at its own temp metrics.db;
        # patch the class attribute so every handler instance uses ours.
        self._orig = self.app_mod.Handler.harness
        self.app_mod.Handler.harness = self.store

    def tearDown(self):
        self.app_mod.Handler.harness = self._orig

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def test_ingest_harness_sample_roundtrip(self):
        status, ingest = _post_json(
            self.base + "/ingest", {"host": "mbp",
                                    "records": [_sample_rec()]})
        self.assertEqual(status, 200)
        self.assertTrue(ingest.get("ok"))
        self.assertEqual(ingest.get("harness_ingested"), 1)

        status, body = _get_json(self.base + "/api/harness/samples?hours=1")
        self.assertEqual(status, 200)
        samples = body["samples"]
        self.assertEqual(len(samples), 1)
        row = samples[0]
        # config JSON-decoded server-side for the dashboard.
        self.assertEqual(row["fp"], "cafe01beef01")
        self.assertEqual(row["prompt_class"], "long_gen")
        self.assertEqual(json.loads(row["config"]), {"context_length": 32768})
        self.assertEqual(row["host"], "mbp")

        status, body = _get_json(self.base + "/api/harness/best?n=5")
        self.assertEqual(status, 200)
        self.assertEqual(len(body["best"]), 1)
        self.assertEqual(body["best"][0]["fp"], "cafe01beef01")
        self.assertEqual(body["best"][0]["prompt_class"], "long_gen")

    def test_ingest_skips_degenerate_harness_placeholder(self):
        """H-6: an empty-stream rep in a batch is dropped server-side; valid
        rows in the same envelope still land."""
        bad = _sample_rec()
        bad.update(tokens=0, tps=None, ttft_s=None)
        status, ingest = _post_json(
            self.base + "/ingest", {"host": "mbp",
                                    "records": [_sample_rec(), bad]})
        self.assertEqual(status, 200)
        self.assertTrue(ingest.get("ok"))
        self.assertEqual(ingest.get("harness_ingested"), 1)
        status, body = _get_json(self.base + "/api/harness/samples?hours=1")
        # DB is shared across this test class — assert only that the valid
        # row landed and the placeholder did not add a second one.
        self.assertEqual(len(body["samples"]), 2)  # roundtrip + mark + 1 new
        self.assertEqual(sum(1 for s in body["samples"]
                             if s["tokens"] in (0, None)
                             and s["tps"] is None), 0)

    def test_samples_validation_and_bogus_hours(self):
        status, body = _get_json(
            self.base + "/api/harness/samples?hours=1&limit=2")
        self.assertEqual(status, 200)
        self.assertIn("samples", body)

    def test_best_validation(self):
        # non-numeric hours / n are rejected, like the other windowed APIs.
        try:
            _get_json(self.base + "/api/harness/samples?hours=bogus")
            self.fail("non-numeric hours should return 400")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)

    def test_mark_roundtrip_and_validation(self):
        status, ingest = _post_json(
            self.base + "/ingest", {"host": "mbp",
                                    "records": [_sample_rec()]})
        self.assertEqual(ingest.get("harness_ingested"), 1)

        status, body = _post_json(self.base + "/api/harness/mark",
                                  {"fp": "cafe01beef01",
                                   "label": "baseline-4bit-q8kv"})
        self.assertEqual(status, 200)
        self.assertTrue(body.get("ok"))

        status, body = _get_json(self.base + "/api/harness/samples?hours=1")
        self.assertEqual(body["samples"][0]["label"], "baseline-4bit-q8kv")

        # missing fp is a client error.
        status, body = _post_json(self.base + "/api/harness/mark", {})
        self.assertEqual(status, 400)

    def test_sse_carries_harness_sample(self):
        """Task 6's live path: the /events SSE stream must carry the inserted
        sample (event: rec, event field = harness_sample)."""
        got = {}

        def reader():
            request = urllib.request.Request(self.base + "/events")
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    for raw in response:
                        line = raw.decode("utf-8", "replace").strip()
                        if not line.startswith("data:"):
                            continue
                        payload = json.loads(line[len("data:"):].strip())
                        if isinstance(payload, dict) \
                                and payload.get("event") == "harness_sample":
                            got["payload"] = payload
                            return
            except Exception:
                pass

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()
        time.sleep(0.5)  # let the stream open+subscribe before ingest
        _post_json(self.base + "/ingest", {"host": "mbp",
                                           "records": [_sample_rec()]})
        thread.join(timeout=10)
        self.assertIn("payload", got, "no harness_sample SSE frame observed")
        self.assertEqual(got["payload"]["fp"], "cafe01beef01")


if __name__ == "__main__":
    unittest.main()
