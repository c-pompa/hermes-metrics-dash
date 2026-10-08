import datetime
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugin"
sys.path.insert(0, str(PLUGIN_DIR))

import metrics_core  # noqa: E402


RECENT_PAYLOAD = {
    "records": [
        {"kind": "api", "model": "m-a", "output_tokens": 42, "tps": 12.5},
        {"kind": "heartbeat"},
    ]
}
FINDINGS_PAYLOAD = {"days": 7, "findings": [{"rule": "R12", "count": 3}]}
USAGE_MAP_PAYLOAD = {"m-a": "chat", "m-b": "code"}
MOA_SUMMARY_PAYLOAD = {
    "available": True,
    "runs": 2,
    "voices": [{"role": "ref-a", "model": "m-a", "provider": "nvidia",
                "calls": 2, "avg_s": 11.0}],
    "aggregator": {"model": "m-agg", "provider": "nvidia", "calls": 2,
                   "avg_s": None},
    "p95_fanout_s": 32.0,
    "preset": "nvidia",
}


class StubHandler(BaseHTTPRequestHandler):
    """Stand-in for app.py on the mini."""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        self.server.requests.append((parsed.path, parsed.query))
        if parsed.path == "/health":
            self.server.health_hits += 1
            self._json({"status": "ok"})
        elif parsed.path == "/api/recent":
            self._json(RECENT_PAYLOAD)
        elif parsed.path == "/api/findings":
            self._json(FINDINGS_PAYLOAD)
        elif parsed.path == "/api/moa/summary":
            self._json(MOA_SUMMARY_PAYLOAD)
        elif parsed.path == "/api/usage-map":
            self._json(USAGE_MAP_PAYLOAD)
        else:
            self._json({"error": "not found"}, 404)

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def start_stub():
    server = ThreadingHTTPServer(("127.0.0.1", 0), StubHandler)
    server.requests = []
    server.health_hits = 0
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def closed_port_url():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return "http://127.0.0.1:%d" % port


class MetricsCoreTest(unittest.TestCase):
    def setUp(self):
        self._env = {
            key: os.environ.get(key)
            for key in ("METRICS_DASH_URL", "METRICS_DASH_REMOTES", "METRICS_BACKEND", "HERMES_HOME")
        }
        self._loopback = metrics_core.LOOPBACK_BASE_URL
        self._remotes = metrics_core.REMOTE_BASE_URLS
        metrics_core._reset_base_url_cache()
        self.server = start_stub()
        self.base_url = "http://127.0.0.1:%d" % self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        metrics_core.LOOPBACK_BASE_URL = self._loopback
        metrics_core.REMOTE_BASE_URLS = self._remotes
        metrics_core._reset_base_url_cache()
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    # -- endpoint mapping ---------------------------------------------------

    def test_recent_maps_endpoint_and_params(self):
        os.environ["METRICS_DASH_URL"] = self.base_url
        result = metrics_core.recent(hours=2, limit=50)
        self.assertEqual(result, RECENT_PAYLOAD)
        path, query = self.server.requests[-1]
        self.assertEqual(path, "/api/recent")
        params = urllib.parse.parse_qs(query)
        self.assertEqual(params["hours"], ["2"])
        self.assertEqual(params["limit"], ["50"])

    def test_findings_maps_endpoint(self):
        os.environ["METRICS_DASH_URL"] = self.base_url
        self.assertEqual(metrics_core.findings(), FINDINGS_PAYLOAD)
        self.assertEqual(self.server.requests[-1][0], "/api/findings")

    def test_moa_summary_maps_endpoint_and_params(self):
        os.environ["METRICS_DASH_URL"] = self.base_url
        result = metrics_core.moa_summary(hours=2)
        self.assertEqual(result, MOA_SUMMARY_PAYLOAD)
        path, query = self.server.requests[-1]
        self.assertEqual(path, "/api/moa/summary")
        self.assertEqual(urllib.parse.parse_qs(query)["hours"], ["2"])

    def test_usage_map_maps_endpoint(self):
        os.environ["METRICS_DASH_URL"] = self.base_url
        self.assertEqual(metrics_core.usage_map(), USAGE_MAP_PAYLOAD)
        self.assertEqual(self.server.requests[-1][0], "/api/usage-map")

    def test_health_maps_endpoint(self):
        os.environ["METRICS_DASH_URL"] = self.base_url
        self.assertEqual(metrics_core.health(), {"status": "ok"})
        self.assertEqual(self.server.requests[-1][0], "/health")

    # -- base URL resolution --------------------------------------------------

    def test_env_override_wins_and_skips_probe(self):
        os.environ["METRICS_DASH_URL"] = self.base_url + "/"
        metrics_core.LOOPBACK_BASE_URL = closed_port_url()
        metrics_core.REMOTE_BASE_URLS = [closed_port_url()]
        self.assertEqual(metrics_core.resolve_base_url(), self.base_url)
        self.assertEqual(self.server.health_hits, 0)

    def test_loopback_preferred_when_it_answers(self):
        os.environ.pop("METRICS_DASH_URL", None)
        metrics_core.LOOPBACK_BASE_URL = self.base_url
        metrics_core.REMOTE_BASE_URLS = [closed_port_url()]
        self.assertEqual(metrics_core.resolve_base_url(), self.base_url)

    def test_lan_fallback_when_loopback_dead(self):
        os.environ.pop("METRICS_DASH_URL", None)
        metrics_core.LOOPBACK_BASE_URL = closed_port_url()
        metrics_core.REMOTE_BASE_URLS = [self.base_url]
        self.assertEqual(metrics_core.resolve_base_url(), self.base_url)

    def test_loopback_probe_result_is_cached(self):
        os.environ.pop("METRICS_DASH_URL", None)
        metrics_core.LOOPBACK_BASE_URL = self.base_url
        metrics_core.REMOTE_BASE_URLS = [closed_port_url()]
        metrics_core.resolve_base_url()
        metrics_core.resolve_base_url()
        self.assertEqual(self.server.health_hits, 1)

    # -- degradation -----------------------------------------------------------

    def test_unreachable_server_raises_metrics_unavailable(self):
        os.environ["METRICS_DASH_URL"] = closed_port_url()
        with self.assertRaises(metrics_core.MetricsUnavailable):
            metrics_core.recent()
        with self.assertRaises(metrics_core.MetricsUnavailable):
            metrics_core.findings()
        with self.assertRaises(metrics_core.MetricsUnavailable):
            metrics_core.usage_map()
        with self.assertRaises(metrics_core.MetricsUnavailable):
            metrics_core.health()

    # -- backend seam -----------------------------------------------------------

    def _pin_dead_http(self, tmpdir):
        """No metrics server anywhere; HERMES_HOME pointed at tmpdir."""
        metrics_core.LOOPBACK_BASE_URL = closed_port_url()
        metrics_core.REMOTE_BASE_URLS = [closed_port_url()]
        os.environ.pop("METRICS_DASH_URL", None)
        os.environ["HERMES_HOME"] = tmpdir
        metrics_core._reset_base_url_cache()

    def _write_requests_file(self, tmpdir, lines):
        path = Path(tmpdir) / "metrics" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(line + "\n" for line in lines))
        return str(path)

    def test_get_backend_defaults_to_http(self):
        # With no env override, no reachable server, and no local file, the
        # default stays the HTTP backend (so the error message is useful).
        os.environ.pop("METRICS_BACKEND", None)
        with tempfile.TemporaryDirectory() as tmpdir:
            self._pin_dead_http(tmpdir)
            backend = metrics_core.get_backend()
        self.assertIsInstance(backend, metrics_core.HttpBackend)
        self.assertEqual(backend.name, "http")

    def test_sqlite_backend_is_a_loud_stub(self):
        os.environ["METRICS_BACKEND"] = "sqlite"
        backend = metrics_core.get_backend()
        self.assertIsInstance(backend, metrics_core.SqliteBackend)
        with self.assertRaises(metrics_core.MetricsUnavailable):
            backend.health()

    def test_unknown_backend_raises(self):
        os.environ["METRICS_BACKEND"] = "carrier-pigeon"
        with self.assertRaises(metrics_core.MetricsUnavailable):
            metrics_core.get_backend()

    # -- backend selection ordering ----------------------------------------------

    def test_selection_env_url_pins_http_even_with_local_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["HERMES_HOME"] = tmpdir
            self._write_requests_file(
                tmpdir, [json.dumps({"ts": time.time(), "event": "post_api_request"})])
            os.environ["METRICS_DASH_URL"] = self.base_url
            backend = metrics_core.get_backend()
        self.assertIsInstance(backend, metrics_core.HttpBackend)
        self.assertEqual(backend.base_url(), self.base_url)

    def test_selection_loopback_wins(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self._pin_dead_http(tmpdir)
            metrics_core.LOOPBACK_BASE_URL = self.base_url
            backend = metrics_core.get_backend()
        self.assertIsInstance(backend, metrics_core.HttpBackend)
        self.assertEqual(backend.base_url(), self.base_url)

    def test_selection_lan_when_loopback_dead(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self._pin_dead_http(tmpdir)
            metrics_core.REMOTE_BASE_URLS = [self.base_url]
            backend = metrics_core.get_backend()
        self.assertIsInstance(backend, metrics_core.HttpBackend)
        self.assertEqual(backend.base_url(), self.base_url)

    def test_selection_local_file_when_no_server(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self._pin_dead_http(tmpdir)
            path = self._write_requests_file(
                tmpdir, [json.dumps({"ts": time.time(), "event": "post_api_request"})])
            backend = metrics_core.get_backend()
            self.assertIsInstance(backend, metrics_core.LocalFileBackend)
            self.assertEqual(backend.path(), path)
            self.assertEqual(backend.describe(), {"source": "local-file", "path": path})

    def test_selection_stays_http_when_nothing_available(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self._pin_dead_http(tmpdir)  # no requests.jsonl under tmpdir
            backend = metrics_core.get_backend()
            self.assertIsInstance(backend, metrics_core.HttpBackend)
            with self.assertRaises(metrics_core.MetricsUnavailable) as ctx:
                backend.recent()
            self.assertIn("unreachable", str(ctx.exception))

    def test_auto_backend_resolution_is_cached(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self._pin_dead_http(tmpdir)
            self._write_requests_file(
                tmpdir, [json.dumps({"ts": time.time(), "event": "post_api_request"})])
            first = metrics_core.get_backend()
            # A server appearing inside the TTL window is not picked up yet.
            metrics_core.LOOPBACK_BASE_URL = self.base_url
            self.assertIs(metrics_core.get_backend(), first)
            self.assertIsInstance(first, metrics_core.LocalFileBackend)

    def test_topology_change_pickup_after_cache_expiry(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            self._pin_dead_http(tmpdir)
            self._write_requests_file(
                tmpdir, [json.dumps({"ts": time.time(), "event": "post_api_request"})])
            ttl = metrics_core.BASE_URL_CACHE_TTL_S
            metrics_core.BASE_URL_CACHE_TTL_S = 0.0  # every call re-resolves
            try:
                self.assertIsInstance(
                    metrics_core.get_backend(), metrics_core.LocalFileBackend)
                # The mini appears on loopback -> HTTP on the next resolution.
                metrics_core.LOOPBACK_BASE_URL = self.base_url
                backend = metrics_core.get_backend()
                self.assertIsInstance(backend, metrics_core.HttpBackend)
                self.assertEqual(backend.base_url(), self.base_url)
            finally:
                metrics_core.BASE_URL_CACHE_TTL_S = ttl

    # -- local-file backend --------------------------------------------------------

    def test_local_file_recent_parses_filters_and_flattens(self):
        now = time.time()
        lines = [
            json.dumps({"ts": now - 10, "event": "post_api_request", "model": "m-a",
                        "api_duration": 4.0,
                        "usage": {"input_tokens": 5, "output_tokens": 100}}),
            "not json at all",
            json.dumps(["a", "list"]),
            json.dumps({"ts": now - 7200, "event": "post_api_request",
                        "model": "m-old"}),  # outside the 1h window
            json.dumps({"event": "post_api_request", "model": "m-no-ts"}),
            json.dumps({"ts": now - 5, "event": "post_api_request", "model": "m-b",
                        "provider": "moa", "usage": {"output_tokens": 50}}),
            json.dumps({"ts": now - 1, "event": "api_request_error", "model": "m-a",
                        "error_type": "Timeout", "error_message": "boom"}),
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_requests_file(tmpdir, lines)
            records = metrics_core.LocalFileBackend(path).recent(hours=1, limit=500)["records"]
        self.assertEqual(len(records), 3)
        # Newest last — the same contract as the HTTP backend.
        self.assertEqual([r["model"] for r in records], ["m-a", "m-b", "m-a"])
        first = records[0]
        self.assertEqual(first["kind"], "api")
        self.assertEqual(first["output_tokens"], 100)
        self.assertEqual(first["duration_s"], 4.0)
        self.assertEqual(first["tps"], 25.0)
        moa = records[1]
        self.assertEqual(moa["kind"], "moa_turn")
        self.assertIsNone(moa["tps"])  # no duration -> no tps fallback
        err = records[2]
        self.assertEqual(err["kind"], "error")
        self.assertEqual(err["error"], "Timeout: boom")

    def test_local_file_router_error_maps_to_error_kind(self):
        # Same mapping as app.py normalize: a router_request carrying
        # error_type/error_message (status >= 400, e.g. a 598 stream stall)
        # is a failed call, not a slow successful request.
        now = time.time()
        lines = [
            json.dumps({"ts": now - 2, "event": "router_request",
                        "model": "m-local", "duration_s": 600.0}),
            json.dumps({"ts": now - 1, "event": "router_request",
                        "model": "m-local", "duration_s": 600.0,
                        "error_type": "http_598",
                        "error_message": "router returned 598"}),
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_requests_file(tmpdir, lines)
            records = metrics_core.LocalFileBackend(path).recent(hours=1, limit=500)["records"]
        self.assertEqual([r["kind"] for r in records], ["router_request", "error"])
        self.assertEqual(records[1]["error"], "http_598: router returned 598")

    def test_local_file_recent_honors_limit_with_newest(self):
        now = time.time()
        lines = [
            json.dumps({"ts": now - i, "event": "post_api_request", "model": "m-%d" % i})
            for i in range(5, 0, -1)  # oldest first, as appended
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_requests_file(tmpdir, lines)
            records = metrics_core.LocalFileBackend(path).recent(hours=1, limit=2)["records"]
        self.assertEqual([r["model"] for r in records], ["m-2", "m-1"])

    def test_local_file_recent_accepts_tz_aware_iso_timestamps(self):
        now = time.time()
        aware = datetime.datetime.fromtimestamp(now - 5, datetime.timezone.utc)
        lines = [
            json.dumps({"ts": aware.isoformat().replace("+00:00", "Z"),
                        "event": "post_api_request", "model": "m-zulu"}),
            json.dumps({"ts": aware.isoformat(),
                        "event": "post_api_request", "model": "m-aware"}),
            json.dumps({"ts": "2020-01-01T00:00:00+00:00",
                        "event": "post_api_request", "model": "m-ancient"}),
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_requests_file(tmpdir, lines)
            records = metrics_core.LocalFileBackend(path).recent(hours=1, limit=500)["records"]
        self.assertEqual([r["model"] for r in records], ["m-zulu", "m-aware"])

    def test_local_file_recent_empty_and_missing_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_requests_file(tmpdir, [])
            backend = metrics_core.LocalFileBackend(path)
            self.assertEqual(backend.recent(), {"records": []})
            missing = metrics_core.LocalFileBackend(str(Path(tmpdir) / "nope.jsonl"))
            with self.assertRaises(metrics_core.MetricsUnavailable):
                missing.recent()

    def test_local_file_health_and_server_side_sections(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = self._write_requests_file(
                tmpdir, [json.dumps({"ts": time.time(), "event": "post_api_request"})])
            backend = metrics_core.LocalFileBackend(path)
            info = backend.health()
            self.assertEqual(info["status"], "ok")
            self.assertEqual(info["mode"], "local-file")
            self.assertEqual(info["path"], path)
            with self.assertRaises(metrics_core.MetricsUnavailable) as ctx:
                backend.findings()
            self.assertIn("local-file", str(ctx.exception))
            with self.assertRaises(metrics_core.MetricsUnavailable):
                backend.usage_map()
            with self.assertRaises(metrics_core.MetricsUnavailable) as ctx:
                backend.moa_summary()
            self.assertIn("local-file", str(ctx.exception))
            missing = metrics_core.LocalFileBackend(str(Path(tmpdir) / "nope.jsonl"))
            with self.assertRaises(metrics_core.MetricsUnavailable):
                missing.health()


if __name__ == "__main__":
    unittest.main()
