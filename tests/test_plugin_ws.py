"""Tests for the metrics-dashboard plugin's /events WebSocket: the pure
diff/watermark helper (diff_records) and the streaming endpoint itself."""

import importlib.util
import json
import os
import socket
import threading
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


def rec(ts, model="m-a", **extra):
    row = {"ts": ts, "kind": "api", "model": model}
    row.update(extra)
    return row


@unittest.skipUnless(HAVE_FASTAPI, "fastapi not importable in this interpreter")
class DiffRecordsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin_api = load_plugin_api()

    def diff(self, state, records):
        return self.plugin_api.diff_records(state, records)

    def test_first_batch_is_all_new_and_primes_watermark(self):
        state, new = self.diff(None, [rec(1), rec(2)])
        self.assertEqual(new, [rec(1), rec(2)])
        self.assertEqual(state["ts"], 2.0)
        # Only records AT the watermark ts are fingerprinted.
        self.assertEqual(len(state["sent"]), 1)

    def test_repeated_batch_yields_nothing(self):
        state, _ = self.diff(None, [rec(1), rec(2)])
        state, new = self.diff(state, [rec(1), rec(2)])
        self.assertEqual(new, [])
        self.assertEqual(state["ts"], 2.0)

    def test_only_newer_records_are_emitted(self):
        state, _ = self.diff(None, [rec(1)])
        state, new = self.diff(state, [rec(1), rec(2), rec(3)])
        self.assertEqual(new, [rec(2), rec(3)])
        self.assertEqual(state["ts"], 3.0)

    def test_same_timestamp_tie_emitted_once(self):
        a = rec(5, model="m-a")
        b = rec(5, model="m-b")
        state, new = self.diff(None, [a])
        self.assertEqual(new, [a])
        # A second record landing at the watermark ts must not be dropped...
        state, new = self.diff(state, [a, b])
        self.assertEqual(new, [b])
        # ...but must not repeat either.
        state, new = self.diff(state, [a, b])
        self.assertEqual(new, [])

    def test_record_without_ts_always_emitted_never_watermarks(self):
        tsless = {"kind": "host_stats"}
        state, new = self.diff(None, [tsless])
        self.assertEqual(new, [tsless])
        self.assertIsNone(state)  # no timestamped record seen: no watermark

        state, _ = self.diff(None, [rec(1)])
        state, new = self.diff(state, [rec(1), tsless])
        self.assertEqual(new, [tsless])
        self.assertEqual(state["ts"], 1.0)

    def test_empty_batch_keeps_state(self):
        state, _ = self.diff(None, [rec(2)])
        state, new = self.diff(state, [])
        self.assertEqual(new, [])
        self.assertEqual(state["ts"], 2.0)

    def test_out_of_order_batch_still_tracks_max_ts(self):
        state, new = self.diff(None, [rec(3), rec(1)])
        self.assertEqual(state["ts"], 3.0)
        # ts=1 is below the watermark: not re-emitted next round.
        state, new = self.diff(state, [rec(3), rec(1)])
        self.assertEqual(new, [])


# -- WS endpoint --------------------------------------------------------------

STUB_RECORDS = []  # mutated by tests; read by the stub server thread


class StubHandler(BaseHTTPRequestHandler):
    """Stand-in for app.py on the mini, serving a mutable record list."""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/health":
            self._json({"status": "ok"})
        elif parsed.path == "/api/recent":
            self._json({"records": list(STUB_RECORDS)})
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
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, "http://127.0.0.1:%d" % server.server_address[1]


def closed_port_url():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return "http://127.0.0.1:%d" % port


@unittest.skipUnless(HAVE_FASTAPI, "fastapi not importable in this interpreter")
class EventStreamTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plugin_api = load_plugin_api()
        app = fastapi.FastAPI()
        app.include_router(cls.plugin_api.router)
        cls.client = TestClient(app)

    def setUp(self):
        self._env = {key: os.environ.get(key)
                     for key in ("METRICS_DASH_URL", "METRICS_BACKEND")}
        self.metrics_server, self.metrics_url = start_stub()
        os.environ["METRICS_DASH_URL"] = self.metrics_url
        del STUB_RECORDS[:]
        STUB_RECORDS.extend([rec(1), rec(2)])
        # Fast tail ticks keep the streaming tests quick.
        self._poll_s = self.plugin_api._EVENT_STREAM_POLL_S
        self.plugin_api._EVENT_STREAM_POLL_S = 0.05

    def tearDown(self):
        self.plugin_api._EVENT_STREAM_POLL_S = self._poll_s
        self.metrics_server.shutdown()
        self.metrics_server.server_close()
        for key, value in self._env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_initial_frame_pushes_current_window(self):
        with self.client.websocket_connect("/events") as ws:
            frame = ws.receive_json()
        self.assertTrue(frame["available"])
        self.assertEqual(frame["records"], [rec(1), rec(2)])

    def test_pushes_only_new_records(self):
        with self.client.websocket_connect("/events") as ws:
            first = ws.receive_json()
            self.assertEqual(first["records"], [rec(1), rec(2)])
            STUB_RECORDS.append(rec(3, model="m-b"))
            second = ws.receive_json()
        self.assertTrue(second["available"])
        self.assertEqual(second["records"], [rec(3, model="m-b")])

    def test_multiple_clients_each_get_the_stream(self):
        with self.client.websocket_connect("/events") as ws1, \
                self.client.websocket_connect("/events") as ws2:
            frame1 = ws1.receive_json()
            frame2 = ws2.receive_json()
        self.assertEqual(frame1["records"], [rec(1), rec(2)])
        self.assertEqual(frame2["records"], [rec(1), rec(2)])

    def test_source_down_degrades_to_unavailable_frame(self):
        os.environ["METRICS_DASH_URL"] = closed_port_url()
        with self.client.websocket_connect("/events") as ws:
            frame = ws.receive_json()
        self.assertFalse(frame["available"])
        self.assertEqual(frame["records"], [])
        self.assertIn("error", frame)


if __name__ == "__main__":
    unittest.main()
