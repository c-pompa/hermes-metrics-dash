import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "ingest.json"


def allocate_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_json(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return response.status, json.load(response)


class HttpSmokeTest(unittest.TestCase):
    def test_app_ingests_fixture_and_returns_recent_records(self):
        port = allocate_local_port()
        base_url = f"http://127.0.0.1:{port}"
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = Path(temp_dir) / "smoke.db"
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "app.py"),
                    "--bind",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--db",
                    str(db_path),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                deadline = time.monotonic() + 10
                while True:
                    if process.poll() is not None:
                        output = process.stdout.read()
                        self.fail(f"app.py exited before becoming healthy:\n{output}")
                    try:
                        health_status, health = get_json(base_url + "/health")
                        break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() >= deadline:
                            self.fail("app.py did not become healthy within 10 seconds")
                        time.sleep(0.05)

                self.assertEqual(health_status, 200)
                self.assertEqual(health, {"status": "ok"})

                fixture = FIXTURE_PATH.read_bytes()
                request = urllib.request.Request(
                    base_url + "/ingest",
                    data=fixture,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(request, timeout=2) as response:
                    ingest_status = response.status
                    ingest = json.load(response)

                self.assertEqual(ingest_status, 200)
                self.assertTrue(ingest.get("ok"))
                self.assertEqual(ingest.get("ingested"), 2)

                recent_status, recent = get_json(
                    base_url + "/api/recent?from=0&to=9999999999&limit=10"
                )
                self.assertEqual(recent_status, 200)
                self.assertEqual(len(recent["records"]), 2)
                self.assertEqual(
                    [record["kind"] for record in recent["records"]],
                    ["api", "error"],
                )
                self.assertEqual(
                    {record["host"] for record in recent["records"]},
                    {"smoke-host"},
                )
                self.assertEqual(recent["records"][0]["tps"], 10.0)
                self.assertEqual(
                    recent["records"][1]["error"],
                    "FixtureError: expected smoke-test record",
                )
                self.assertTrue(db_path.exists())
            finally:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate(timeout=5)
                self.assertIsNotNone(
                    process.returncode,
                    "app.py subprocess did not terminate cleanly",
                )


class HttpNewEndpointsTest(unittest.TestCase):
    """Smoke coverage for the redesign-round endpoints."""

    def setUp(self):
        self.port = allocate_local_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.temp_dir = tempfile.TemporaryDirectory()
        env = dict(os.environ)
        env["USAGE_MAP_FILE"] = str(Path(self.temp_dir.name) / "usage-map.json")
        env["METRICS_RETENTION_DAYS"] = "0"  # disable prune thread in tests
        env["METRICS_ADMIN_TOKEN"] = "test-admin-token"
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "app.py"),
                "--bind", "127.0.0.1",
                "--port", str(self.port),
                "--db", str(Path(self.temp_dir.name) / "smoke.db"),
            ],
            cwd=ROOT, env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.monotonic() + 10
        while True:
            if self.process.poll() is not None:
                self.fail(f"app.py exited early:\n{self.process.stdout.read()}")
            try:
                get_json(self.base_url + "/health")
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    self.fail("app.py did not become healthy within 10 seconds")
                time.sleep(0.05)

    def tearDown(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.communicate(timeout=5)
        self.temp_dir.cleanup()

    def post_json(self, path, payload, content_type="application/json"):
        request = urllib.request.Request(
            self.base_url + path,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": content_type,
                     "Authorization": "Bearer test-admin-token"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def test_about_reports_ops_fields(self):
        status, about = get_json(self.base_url + "/api/about")
        self.assertEqual(status, 200)
        for key in ("revision", "db_bytes", "records", "oldest_ts",
                    "retention_days", "heartbeat_hours"):
            self.assertIn(key, about)
        self.assertEqual(about["records"], 0)
        self.assertIsNone(about["oldest_ts"])

    def test_recent_exclude_kinds(self):
        now = time.time()
        records = [
            {"ts": now, "event": "post_api_request", "model": "m1",
             "api_duration": 1, "usage": {"output_tokens": 10}},
            {"ts": now, "event": "pool_status", "model": "m1", "device": "mini"},
            {"ts": now, "event": "host_stats", "cpu_load": 1.0},
        ]
        status, _ = self.post_json("/ingest", {"host": "t", "records": records})
        self.assertEqual(status, 200)

        status, all_recs = get_json(self.base_url + "/api/recent?hours=1")
        self.assertEqual(len(all_recs["records"]), 3)
        status, filtered = get_json(
            self.base_url + "/api/recent?hours=1&exclude=pool_status,host_stats")
        self.assertEqual([r["kind"] for r in filtered["records"]], ["api"])
        try:
            get_json(self.base_url + "/api/recent?hours=1&exclude=api%3Bdrop")
            self.fail("invalid exclude kind should return 400")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)

    def test_recent_drops_router_request_twins(self):
        """/api/recent drops a router_request row when its api twin (hook row
        with model == router role alias) is in the same window; router-only
        rows (hook-less clients) stay visible."""
        now = time.time()
        records = [
            # Hook row for a routed call (model = role alias).
            {"ts": now - 10, "event": "post_api_request", "model": "hermes/main",
             "api_duration": 5, "usage": {"input_tokens": 500, "output_tokens": 100}},
            # Router exec-log twin of that call — dropped (same label, ts within
            # 3s, same output_tokens).
            {"ts": now - 9.5, "event": "router_request", "label": "hermes/main",
             "model": "qwen3.8-27b-hermes", "duration_s": 5,
             "usage": {"input_tokens": 500, "output_tokens": 100}},
            # Router-only call from a hook-less client — kept.
            {"ts": now - 8, "event": "router_request", "label": "hermes/vision",
             "model": "gemma-4-26b-a4b-it", "duration_s": 3,
             "usage": {"output_tokens": 50}},
            # Same role but a different call (token mismatch) — kept.
            {"ts": now - 9.8, "event": "router_request", "label": "hermes/main",
             "model": "qwen3.8-27b-hermes", "duration_s": 6,
             "usage": {"output_tokens": 200}},
            # Same role, outside the twin window — kept.
            {"ts": now - 25, "event": "router_request", "label": "hermes/main",
             "model": "qwen3.8-27b-hermes", "duration_s": 7,
             "usage": {"output_tokens": 100}},
        ]
        status, _ = self.post_json("/ingest", {"host": "t", "records": records})
        self.assertEqual(status, 200)

        status, payload = get_json(self.base_url + "/api/recent?hours=1")
        self.assertEqual(status, 200)
        kinds = sorted(r["kind"] for r in payload["records"])
        self.assertEqual(kinds, ["api", "router_request", "router_request", "router_request"])
        kept_ts = sorted(r["ts"] for r in payload["records"])
        self.assertNotIn(round(now - 9.5, 6), [round(t, 6) for t in kept_ts])

    def test_usage_map_roundtrip_and_validation(self):
        status, empty = get_json(self.base_url + "/api/usage-map")
        self.assertEqual((status, empty), (200, {}))

        status, body = self.post_json(
            "/api/usage-map", {"model": "new-model-7b", "usage": "MoA ref"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        status, filled = get_json(self.base_url + "/api/usage-map")
        self.assertEqual(filled, {"new-model-7b": "MoA ref"})

        status, _ = self.post_json("/api/usage-map", {"model": "x", "usage": "bogus"})
        self.assertEqual(status, 400)
        # CSRF gate: non-JSON content type rejected on all POSTs
        status, _ = self.post_json(
            "/api/usage-map", {"model": "x", "usage": "loaded"},
            content_type="text/plain")
        self.assertEqual(status, 415)

    def test_benchmark_marks_listing(self):
        status, body = get_json(self.base_url + "/api/benchmark/marks")
        self.assertEqual((status, body), (200, {"marks": []}))
        status, body = self.post_json("/api/benchmark/mark", {"label": "exp-1"})
        self.assertEqual(status, 200)
        status, body = get_json(self.base_url + "/api/benchmark/marks")
        self.assertEqual(len(body["marks"]), 1)
        self.assertEqual(body["marks"][0]["label"], "exp-1")

    def test_moa_summary_endpoint(self):
        # No MoA records yet: idle payload, no lineup.
        status, body = get_json(self.base_url + "/api/moa/summary?hours=1")
        self.assertEqual(status, 200)
        self.assertFalse(body["available"])
        self.assertEqual(body["runs"], 0)
        self.assertEqual(body["voices"], [])

        # Ingest one MoA run in the raw forwarder shape (flatten_moa_turn
        # output): three moa_reference records + one moa_aggregator.
        now = time.time()
        base = {"ts": now, "session_id": "s-moa", "preset": "nvidia"}
        records = [
            dict(base, event="moa_reference", label=f"nvidia:voice-{i}",
                 model=f"voice-{i}", provider="nvidia", duration_s=dur)
            for i, dur in enumerate((10.0, 20.0, 30.0))
        ]
        records.append(dict(base, event="moa_aggregator",
                            label="nvidia:agg", model="agg-model",
                            provider="nvidia"))
        status, ingest = self.post_json("/ingest", {"host": "t", "records": records})
        self.assertEqual((status, ingest["ingested"]), (200, 4))

        status, body = get_json(self.base_url + "/api/moa/summary?hours=1")
        self.assertEqual(status, 200)
        self.assertTrue(body["available"])
        self.assertEqual(body["runs"], 1)
        self.assertEqual(body["preset"], "nvidia")
        self.assertEqual(body["voices_live"], 3)
        self.assertEqual([v["role"] for v in body["voices"]],
                         ["ref-a", "ref-b", "ref-c"])
        self.assertEqual(body["voices"][1]["avg_s"], 20.0)
        self.assertEqual(body["p95_fanout_s"], 30.0)
        self.assertEqual(body["aggregator"]["model"], "agg-model")

        try:
            get_json(self.base_url + "/api/moa/summary?hours=bogus")
            self.fail("non-numeric hours should return 400")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)


if __name__ == "__main__":
    unittest.main()
