"""Write (admin token) and /ingest (per-host token) auth on the collector, the
auth_tokens.py CLI, and the metrics-dashboard plugin's authenticated relay."""
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import app

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "plugin"))
import metrics_core  # noqa: E402

try:
    import fastapi
    from fastapi.testclient import TestClient

    HAVE_FASTAPI = True
except ImportError:
    HAVE_FASTAPI = False

ENV_KEYS = ("METRICS_ADMIN_TOKEN", "METRICS_INGEST_TOKENS", "HERMES_HOME", "METRICS_DASH_URL")


class EnvCase(unittest.TestCase):
    """Isolates the auth env vars and gives each test an empty HERMES_HOME."""

    def setUp(self):
        self._env = {key: os.environ.get(key) for key in ENV_KEYS}
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["HERMES_HOME"] = self.tmp.name

    def tearDown(self):
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def write_tokens(self, entries):
        path = Path(self.tmp.name, "metrics", "ingest-tokens.json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            sender: {"sha256": hashlib.sha256(token.encode()).hexdigest(), "hosts": hosts}
            for sender, (token, hosts) in entries.items()}))


class AdminWriteTest(EnvCase):
    def test_no_token_configured_disables_writes(self):
        code, message = app.admin_write_problem("Bearer anything")
        self.assertEqual(code, 503)
        self.assertIn("Hermes Desktop", message)

    def test_wrong_or_missing_token_is_401_pointing_at_the_plugin(self):
        os.environ["METRICS_ADMIN_TOKEN"] = "right"
        for header in (None, "", "Bearer wrong", "right"):
            code, message = app.admin_write_problem(header)
            self.assertEqual(code, 401, header)
            self.assertEqual(message, app.WRITE_VIA_PLUGIN)

    def test_token_from_env_or_file(self):
        os.environ["METRICS_ADMIN_TOKEN"] = "right"
        self.assertIsNone(app.admin_write_problem("Bearer right"))
        del os.environ["METRICS_ADMIN_TOKEN"]
        path = Path(self.tmp.name, "metrics", "admin.token")
        path.parent.mkdir()
        path.write_text("from-file\n")
        self.assertIsNone(app.admin_write_problem("Bearer from-file"))


class IngestAuthTest(EnvCase):
    def test_token_may_report_only_as_its_hosts(self):
        self.write_tokens({"mini": ("tok-mini", ["mini", "mbp"])})
        self.assertIsNone(app.ingest_auth_problem("Bearer tok-mini", "mini"))
        self.assertIsNone(app.ingest_auth_problem("Bearer tok-mini", "mbp"))
        self.assertIn("may not report as", app.ingest_auth_problem("Bearer tok-mini", "winpc"))

    def test_missing_unknown_or_no_tokens_file(self):
        self.assertEqual(app.ingest_auth_problem("Bearer x", "mini"), "missing or unknown ingest token")
        self.write_tokens({"mini": ("tok-mini", ["mini"])})
        for header in (None, "Bearer other"):
            self.assertEqual(app.ingest_auth_problem(header, "mini"), "missing or unknown ingest token")

    def test_hosts_default_to_sender(self):
        self.write_tokens({"mbp": ("tok-mbp", [])})
        self.assertIsNone(app.ingest_auth_problem("Bearer tok-mbp", "mbp"))

    def test_warning_is_rate_limited_per_host_and_problem(self):
        app._ingest_warned.clear()
        self.addCleanup(app._ingest_warned.clear)
        self.assertTrue(app.warn_ingest_once("h", "1.2.3.4", "p", now=10**6))
        self.assertFalse(app.warn_ingest_once("h", "1.2.3.4", "p", now=10**6 + 1))
        self.assertTrue(app.warn_ingest_once("h2", "1.2.3.4", "p", now=10**6 + 1))
        self.assertTrue(app.warn_ingest_once("h", "1.2.3.4", "p", now=10**6 + app.INGEST_WARN_INTERVAL_S))


class AuthTokensCliTest(EnvCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, str(ROOT / "auth_tokens.py"), *args],
                              env=dict(os.environ), capture_output=True, text=True, check=True)

    def test_admin_init_creates_private_token_once_and_never_prints_it(self):
        out = self.run_cli("admin-init").stdout
        path = Path(self.tmp.name, "metrics", "admin.token")
        token = path.read_text().strip()
        self.assertTrue(token)
        self.assertNotIn(token, out)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.run_cli("admin-init")
        self.assertEqual(path.read_text().strip(), token)

    def test_issue_list_revoke(self):
        out_path = Path(self.tmp.name, "ingest.token")
        out = self.run_cli("ingest-issue", "mini", "--hosts", "mini,mbp", "--out", str(out_path)).stdout
        token = out_path.read_text().strip()
        self.assertNotIn(token, out)
        self.assertEqual(stat.S_IMODE(out_path.stat().st_mode), 0o600)
        self.assertEqual(app.ingest_token_hosts(token), {"mini", "mbp"})

        printed = self.run_cli("ingest-issue", "mbp").stdout.strip()
        self.assertEqual(app.ingest_token_hosts(printed), {"mbp"})
        listing = self.run_cli("ingest-list").stdout
        self.assertIn("mini", listing)
        self.assertNotIn(token, listing)

        self.run_cli("ingest-revoke", "mini")
        self.assertIsNone(app.ingest_token_hosts(token))
        self.assertEqual(app.ingest_token_hosts(printed), {"mbp"})


class CollectorHttpAuthTest(EnvCase):
    """app.py in a subprocess: writes and /ingest over HTTP in both modes."""

    def start(self, **env):
        sys.path.insert(0, str(ROOT / "tests"))
        from test_http_smoke import allocate_local_port, get_json
        port = allocate_local_port()
        self.base = "http://127.0.0.1:%d" % port
        full_env = dict(os.environ, METRICS_RETENTION_DAYS="0",
                        USAGE_MAP_FILE=str(Path(self.tmp.name, "usage-map.json")), **env)
        self.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "app.py"), "--bind", "127.0.0.1", "--port", str(port),
             "--db", str(Path(self.tmp.name, "auth.db"))],
            cwd=ROOT, env=full_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.addCleanup(self.stop)
        deadline = time.monotonic() + 10
        while True:
            if self.proc.poll() is not None:
                self.fail("app.py exited early:\n" + self.proc.stdout.read())
            try:
                get_json(self.base + "/health")
                return
            except OSError:
                if time.monotonic() >= deadline:
                    self.fail("app.py did not become healthy")
                time.sleep(0.05)

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
        try:
            return self.proc.communicate(timeout=5)[0]
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.communicate(timeout=5)[0]

    def post(self, path, payload, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(self.base + path, data=json.dumps(payload).encode(),
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                return resp.status, json.load(resp)
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    def test_enforce_mode(self):
        self.write_tokens({"mini": ("tok-mini", ["mini"])})
        self.start(METRICS_INGEST_AUTH="enforce")
        code, body = self.post("/api/usage-map", {"m": "chat"})
        self.assertEqual(code, 503)
        self.assertIn("Hermes Desktop", body["error"])

        record = {"records": [{"ts": time.time(), "event": "post_api_request", "model": "m"}]}
        self.assertEqual(self.post("/ingest", dict(record, host="mini"))[0], 401)
        self.assertEqual(self.post("/ingest", dict(record, host="mbp"), "tok-mini")[0], 401)
        self.assertEqual(self.post("/ingest", dict(record, host="mini"), "tok-mini")[0], 200)

    def test_conformance_results_record_whether_the_sender_was_verified(self):
        self.write_tokens({"mini": ("tok-mini", ["mini"])})
        self.start()
        record = {"host": "mini", "records": [{
            "event": "conformance_result", "ts": time.time(), "standard": {"name": "s", "rev": "abc1234"},
            "results": [{"rule": "role-jobs-loaded", "status": "fail", "value": "6 of 7", "evidence": ["x"]},
                        {"rule": "bogus", "status": "great"}]}]}
        self.assertEqual(self.post("/ingest", record, "tok-mini")[1]["conformance_ingested"], 1)
        self.assertEqual(self.post("/ingest", record)[1]["conformance_ingested"], 1)
        import sqlite3
        rows = sqlite3.connect(Path(self.tmp.name, "auth.db")).execute(
            "SELECT host, rule, status, value, evidence, standard_rev, verified FROM conformance_results"
            " ORDER BY id").fetchall()
        self.assertEqual(rows, [("mini", "role-jobs-loaded", "fail", "6 of 7", '["x"]', "abc1234", 1),
                                ("mini", "role-jobs-loaded", "fail", "6 of 7", '["x"]', "abc1234", 0)])

    def test_warn_mode_accepts_unsigned_and_logs_once(self):
        self.start(METRICS_ADMIN_TOKEN="adm")
        entry = {"model": "new-model-7b", "usage": "MoA ref"}
        self.assertEqual(self.post("/api/usage-map", entry, "wrong")[0], 401)
        self.assertEqual(self.post("/api/usage-map", entry, "adm")[0], 200)
        record = {"host": "mini", "records": [{"ts": time.time(), "event": "post_api_request"}]}
        self.assertEqual(self.post("/ingest", record)[0], 200)
        self.assertEqual(self.post("/ingest", record)[0], 200)
        log = self.stop()
        self.assertEqual(log.count("ingest auth (warn mode): host='mini'"), 1, log)


class WriteStubHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._json({"status": "ok"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.posts.append((self.path, self.headers.get("Authorization"), body))
        if self.headers.get("Authorization") == "Bearer adm":
            self._json({"ok": True})
        else:
            self._json({"ok": False, "error": "nope"}, 401)

    def _json(self, payload, code=200):
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class PluginRelayTest(EnvCase):
    def setUp(self):
        super().setUp()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), WriteStubHandler)
        self.server.posts = []
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        os.environ["METRICS_DASH_URL"] = "http://127.0.0.1:%d" % self.server.server_address[1]
        metrics_core._reset_base_url_cache()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        metrics_core._reset_base_url_cache()
        super().tearDown()

    def test_admin_post_sends_token_and_relays_status(self):
        with self.assertRaises(metrics_core.MetricsUnavailable):
            metrics_core.admin_post("/api/usage-map", {})
        os.environ["METRICS_ADMIN_TOKEN"] = "adm"
        self.assertEqual(metrics_core.admin_post("/api/usage-map", {"m": "chat"}), (200, {"ok": True}))
        self.assertEqual(self.server.posts[-1], ("/api/usage-map", "Bearer adm", {"m": "chat"}))
        os.environ["METRICS_ADMIN_TOKEN"] = "stale"
        self.assertEqual(metrics_core.admin_post("/api/usage-map", {})[0], 401)

    @unittest.skipUnless(HAVE_FASTAPI, "fastapi not importable in this interpreter")
    def test_plugin_write_route(self):
        spec = importlib.util.spec_from_file_location(
            "metrics_dashboard_plugin_api_auth", ROOT / "plugin" / "dashboard" / "plugin_api.py")
        plugin_api = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(plugin_api)
        api = fastapi.FastAPI()
        api.include_router(plugin_api.router)
        client = TestClient(api)

        self.assertEqual(client.post("/write/usage-map", json={}).status_code, 503)
        os.environ["METRICS_ADMIN_TOKEN"] = "adm"
        resp = client.post("/write/env-mode", json={"mode": "x"})
        self.assertEqual((resp.status_code, resp.json()), (200, {"ok": True}))
        self.assertEqual(self.server.posts[-1][0], "/api/env-mode")
        self.assertEqual(client.post("/write/ingest", json={}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
