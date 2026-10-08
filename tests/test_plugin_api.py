import importlib.util
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLUGIN_API_PATH = ROOT / "plugin" / "dashboard" / "plugin_api.py"

try:
    import fastapi
    from fastapi.testclient import TestClient

    HAVE_FASTAPI = True
except ImportError:
    HAVE_FASTAPI = False


def load_plugin_api():
    spec = importlib.util.spec_from_file_location("metrics_dashboard_plugin_api", PLUGIN_API_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StubHandler(BaseHTTPRequestHandler):
    """Stand-in for app.py on the mini."""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._json({"status": "ok"})
        elif parsed.path == "/api/recent":
            self._json({"records": [{"kind": "api", "model": "m-a"}]})
        elif parsed.path == "/api/findings":
            self._json({"days": 7, "findings": []})
        elif parsed.path == "/api/moa/summary":
            self._json({"available": True, "runs": 1, "preset": "nvidia",
                        "voices": [], "aggregator": None, "p95_fanout_s": 9.5})
        elif parsed.path == "/api/usage-map":
            self._json({"m-a": "chat"})
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


class StubRouterHandler(BaseHTTPRequestHandler):
    """Stand-in for the model-router daemon (loopback HTTP fallback)."""

    last_reload_auth = None  # Authorization header seen on POST /router/reload

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/router/status":
            self._json({"roles": {"main": "m-a"}})
        elif parsed.path == "/router/notes":
            self._json({"notes": ["rolled main to m-a"]})
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/router/reload":
            type(self).last_reload_auth = self.headers.get("Authorization")
            self._json({"ok": True, "roles": ["main"]})
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


def start_stub(handler_cls):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


def closed_port_url():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return "http://127.0.0.1:%d" % port


ROUTER_CORE_STUB = '''
def status():
    return {"roles": {"main": "m-a", "fast": "m-b"}}


def notes():
    return {"notes": ["stub note"]}


def usage(role=None, since=None):
    return {"usage": {"main": {"requests": 3}}}


def health():
    return {"ok": True}
'''


@unittest.skipUnless(HAVE_FASTAPI, "fastapi not importable in this interpreter")
class PluginApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin_api = load_plugin_api()
        app = fastapi.FastAPI()
        app.include_router(cls.plugin_api.router)
        cls.client = TestClient(app)

    def setUp(self):
        self._env = {
            key: os.environ.get(key)
            for key in ("METRICS_DASH_URL", "METRICS_BACKEND", "HERMES_HOME",
                        "MODEL_ROUTER_URL", "MODEL_ROUTER_ALLOW_WRITE",
                        "MODEL_ROUTER_TOKEN", "ROUTER_TOKEN")
        }
        self._path_before = list(sys.path)
        sys.modules.pop("router_core", None)
        self.metrics_server, self.metrics_url = start_stub(StubHandler)
        os.environ["METRICS_DASH_URL"] = self.metrics_url

    def tearDown(self):
        self.metrics_server.shutdown()
        self.metrics_server.server_close()
        sys.modules.pop("router_core", None)
        sys.path[:] = self._path_before
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    # -- metrics routes -------------------------------------------------------

    def test_health_reports_backend_and_base_url(self):
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["available"])
        self.assertEqual(body["backend"], "http")
        self.assertEqual(body["source"], "http")
        self.assertEqual(body["base_url"], self.metrics_url)
        self.assertIsNone(body["path"])
        self.assertEqual(body["server"], {"status": "ok"})

    def test_recent_passthrough(self):
        resp = self.client.get("/recent", params={"hours": 2, "limit": 10})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["records"], [{"kind": "api", "model": "m-a"}])

    def test_findings_passthrough(self):
        resp = self.client.get("/findings")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["findings"], [])

    def test_moa_summary_passthrough(self):
        resp = self.client.get("/moa/summary", params={"hours": 2})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["available"])
        self.assertEqual(body["runs"], 1)
        self.assertEqual(body["preset"], "nvidia")

    def test_moa_summary_unreachable_degrades_cleanly(self):
        os.environ["METRICS_DASH_URL"] = closed_port_url()
        resp = self.client.get("/moa/summary")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertFalse(body["available"])
        self.assertIn("error", body)

    def test_usage_map_passthrough(self):
        resp = self.client.get("/usage-map")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"m-a": "chat"})

    def test_unreachable_mini_degrades_cleanly(self):
        os.environ["METRICS_DASH_URL"] = closed_port_url()
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 503)
        self.assertFalse(resp.json()["available"])

        resp = self.client.get("/recent")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertFalse(body["available"])
        self.assertEqual(body["records"], [])

    # -- /summary ---------------------------------------------------------------

    def test_summary_all_ok(self):
        resp = self.client.get("/summary")
        body = resp.json()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(body["available"])
        self.assertTrue(body["health"]["available"])
        self.assertEqual(body["health"]["data"]["backend"], "http")
        self.assertEqual(body["health"]["data"]["source"], "http")
        self.assertEqual(body["health"]["data"]["base_url"], self.metrics_url)
        self.assertEqual(body["health"]["data"]["server"], {"status": "ok"})
        self.assertTrue(body["recent_1h"]["available"])
        self.assertEqual(body["recent_1h"]["data"]["records"],
                         [{"kind": "api", "model": "m-a"}])

    def test_summary_unreachable_degrades_both_sections(self):
        os.environ["METRICS_DASH_URL"] = closed_port_url()
        resp = self.client.get("/summary")
        body = resp.json()
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(body["available"])
        self.assertFalse(body["health"]["available"])
        self.assertIn("error", body["health"])
        self.assertFalse(body["recent_1h"]["available"])
        self.assertEqual(body["recent_1h"]["records"], [])
        self.assertIn("error", body["recent_1h"])

    def test_summary_partial_failure_degrades_one_section(self):
        class HalfDeadHandler(StubHandler):
            def do_GET(self):
                if urllib.parse.urlparse(self.path).path == "/api/recent":
                    self._json({"error": "boom"}, 500)
                    return
                super().do_GET()

        half_server, half_url = start_stub(HalfDeadHandler)
        try:
            os.environ["METRICS_DASH_URL"] = half_url
            resp = self.client.get("/summary")
        finally:
            half_server.shutdown()
            half_server.server_close()
        body = resp.json()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(body["available"])  # health still resolved
        self.assertTrue(body["health"]["available"])
        self.assertFalse(body["recent_1h"]["available"])
        self.assertIn("error", body["recent_1h"])

    # -- local-file source surfacing ----------------------------------------------

    def test_health_and_summary_report_local_file_source(self):
        # No server anywhere + a local requests.jsonl => the plugin resolves
        # to LocalFileBackend and says so in /health and /summary.
        import metrics_core

        saved = (metrics_core.LOOPBACK_BASE_URL, metrics_core.REMOTE_BASE_URLS)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                metrics_core.LOOPBACK_BASE_URL = closed_port_url()
                metrics_core.REMOTE_BASE_URLS = [closed_port_url()]
                metrics_core._reset_base_url_cache()
                os.environ.pop("METRICS_DASH_URL", None)
                os.environ["HERMES_HOME"] = tmpdir
                requests_file = Path(tmpdir) / "metrics" / "requests.jsonl"
                requests_file.parent.mkdir(parents=True, exist_ok=True)
                requests_file.write_text(json.dumps({
                    "ts": time.time(), "event": "post_api_request",
                    "model": "m-local", "api_duration": 2.0,
                    "usage": {"output_tokens": 50},
                }) + "\n")

                resp = self.client.get("/health")
                body = resp.json()
                self.assertEqual(resp.status_code, 200)
                self.assertTrue(body["available"])
                self.assertEqual(body["backend"], "local-file")
                self.assertEqual(body["source"], "local-file")
                self.assertEqual(body["path"], str(requests_file))
                self.assertIsNone(body["base_url"])
                self.assertEqual(body["server"]["mode"], "local-file")

                resp = self.client.get("/summary")
                body = resp.json()
                self.assertEqual(resp.status_code, 200)
                self.assertTrue(body["available"])
                self.assertTrue(body["health"]["available"])
                self.assertEqual(body["health"]["data"]["source"], "local-file")
                self.assertEqual(body["health"]["data"]["path"], str(requests_file))
                recent = body["recent_1h"]
                self.assertTrue(recent["available"])
                self.assertEqual(
                    [r["model"] for r in recent["data"]["records"]], ["m-local"])
                self.assertEqual(recent["data"]["records"][0]["kind"], "api")
                self.assertEqual(recent["data"]["records"][0]["output_tokens"], 50)

                # Server-side computations degrade with a clear reason.
                resp = self.client.get("/findings")
                self.assertFalse(resp.json()["available"])
                self.assertIn("local-file", resp.json()["error"])
        finally:
            metrics_core.LOOPBACK_BASE_URL, metrics_core.REMOTE_BASE_URLS = saved
            metrics_core._reset_base_url_cache()

    # -- /router-view interop ---------------------------------------------------

    def _make_router_plugin_home(self, tmpdir):
        plugin_dir = Path(tmpdir) / "plugins" / "model-router"
        plugin_dir.mkdir(parents=True)
        (plugin_dir / "router_core.py").write_text(ROUTER_CORE_STUB)
        return tmpdir

    def test_router_view_via_router_core_import(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["HERMES_HOME"] = self._make_router_plugin_home(tmpdir)
            os.environ["MODEL_ROUTER_URL"] = closed_port_url()  # HTTP must not be used
            resp = self.client.get("/router-view")
        body = resp.json()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(body["available"])
        self.assertEqual(body["source"], "router_core")
        self.assertEqual(body["status"]["data"]["roles"]["main"], "m-a")
        self.assertEqual(body["notes"]["data"]["notes"], ["stub note"])
        self.assertTrue(body["usage"]["available"])
        # 1h map is the pane's "active" signal — same import, fresh window.
        self.assertTrue(body["usage_1h"]["available"])

    def test_router_view_http_fallback_when_router_core_missing(self):
        router_server, router_url = start_stub(StubRouterHandler)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                os.environ["HERMES_HOME"] = tmpdir  # no plugins/model-router
                os.environ["MODEL_ROUTER_URL"] = router_url
                resp = self.client.get("/router-view")
        finally:
            router_server.shutdown()
            router_server.server_close()
        body = resp.json()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(body["available"])
        self.assertEqual(body["source"], "http")
        self.assertEqual(body["status"]["data"]["roles"], {"main": "m-a"})
        self.assertEqual(body["notes"]["data"]["notes"], ["rolled main to m-a"])
        # The daemon has no usage endpoint — that section degrades alone.
        self.assertFalse(body["usage"]["available"])
        self.assertFalse(body["usage_1h"]["available"])

    def test_router_view_total_unavailable(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["HERMES_HOME"] = tmpdir
            os.environ["MODEL_ROUTER_URL"] = closed_port_url()
            resp = self.client.get("/router-view")
        body = resp.json()
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(body["available"])
        self.assertFalse(body["status"]["available"])
        self.assertFalse(body["notes"]["available"])

    def test_router_view_partial_failure_degrades_one_section(self):
        class HalfDeadRouterHandler(StubRouterHandler):
            def do_GET(self):
                if urllib.parse.urlparse(self.path).path == "/router/notes":
                    self._json({"error": "boom"}, 500)
                    return
                super().do_GET()

        router_server, router_url = start_stub(HalfDeadRouterHandler)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                os.environ["HERMES_HOME"] = tmpdir
                os.environ["MODEL_ROUTER_URL"] = router_url
                resp = self.client.get("/router-view")
        finally:
            router_server.shutdown()
            router_server.server_close()
        body = resp.json()
        self.assertTrue(body["available"])  # status still resolved
        self.assertTrue(body["status"]["available"])
        self.assertFalse(body["notes"]["available"])

    # -- /router-view write_enabled + /router-reload proxy ----------------------

    def test_router_view_write_gate_off_by_default(self):
        os.environ.pop("MODEL_ROUTER_ALLOW_WRITE", None)
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["HERMES_HOME"] = tmpdir
            os.environ["MODEL_ROUTER_URL"] = closed_port_url()
            resp = self.client.get("/router-view")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["write_enabled"])

    def test_router_view_write_gate_on(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.environ["HERMES_HOME"] = tmpdir
            os.environ["MODEL_ROUTER_URL"] = closed_port_url()
            os.environ["MODEL_ROUTER_ALLOW_WRITE"] = "1"
            resp = self.client.get("/router-view")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["write_enabled"])

    def test_router_reload_gate_off_is_403(self):
        os.environ.pop("MODEL_ROUTER_ALLOW_WRITE", None)
        resp = self.client.post("/router-reload")
        self.assertEqual(resp.status_code, 403)
        self.assertIn("MODEL_ROUTER_ALLOW_WRITE", resp.json()["detail"])

    def test_router_reload_proxies_with_token(self):
        StubRouterHandler.last_reload_auth = None
        router_server, router_url = start_stub(StubRouterHandler)
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                token_dir = Path(tmpdir) / "model-router"
                token_dir.mkdir()
                (token_dir / "router.token").write_text("sekret\n")
                os.environ["HERMES_HOME"] = tmpdir
                os.environ["MODEL_ROUTER_URL"] = router_url
                os.environ["MODEL_ROUTER_ALLOW_WRITE"] = "1"
                os.environ.pop("MODEL_ROUTER_TOKEN", None)
                os.environ.pop("ROUTER_TOKEN", None)
                resp = self.client.post("/router-reload")
        finally:
            router_server.shutdown()
            router_server.server_close()
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        self.assertEqual(StubRouterHandler.last_reload_auth, "Bearer sekret")

    def test_router_reload_daemon_down_is_503(self):
        os.environ["MODEL_ROUTER_URL"] = closed_port_url()
        os.environ["MODEL_ROUTER_ALLOW_WRITE"] = "1"
        resp = self.client.post("/router-reload")
        self.assertEqual(resp.status_code, 503)
        self.assertIn("router unreachable", resp.json()["detail"])


if __name__ == "__main__":
    unittest.main()
