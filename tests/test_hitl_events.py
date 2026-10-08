"""Tests for the hitl-v1 event feed: hitl_events mapping, forwarder parsing,
and an end-to-end ingest → backfill round-trip through app.py."""
import json
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
sys.path.insert(0, str(ROOT))

import hitl_events  # noqa: E402
import hitl_forwarder  # noqa: E402


def allocate_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class HitlMappingTest(unittest.TestCase):
    def test_severity_classification(self):
        self.assertEqual(hitl_events.classify_sev("extraction.failed"), "error")
        self.assertEqual(hitl_events.classify_sev("extraction.rejected"), "error")
        self.assertEqual(hitl_events.classify_sev("PipelineResult(status=FAILED)"), "error")
        self.assertEqual(hitl_events.classify_sev("document.uploaded"), "ok")
        self.assertEqual(hitl_events.classify_sev("extraction.completed"), "ok")
        self.assertEqual(hitl_events.classify_sev("extraction.approved"), "ok")
        self.assertEqual(hitl_events.classify_sev("pipeline.complete"), "ok")
        self.assertEqual(hitl_events.classify_sev("pipeline.stage_complete"), "info")
        self.assertEqual(hitl_events.classify_sev("pipeline.stage_start"), "info")

    def test_lane_classification(self):
        self.assertEqual(hitl_events.classify_lane("pipeline.complete"), "orchestrator")
        self.assertEqual(hitl_events.classify_lane("document.uploaded"), "documents")
        self.assertEqual(hitl_events.classify_lane("extraction.failed"), "extraction")
        self.assertEqual(hitl_events.classify_lane("webhook.test"), "webhooks")
        self.assertEqual(hitl_events.classify_lane("something.else"), "other")

    def test_normalize_defaults_and_extras(self):
        row = hitl_events.normalize_hitl_event(
            {"event": "hitl_event", "type": "extraction.completed",
             "doc_id": "d1", "extraction_id": "e1", "status": "needs_review"}, "mini")
        self.assertEqual(row["host"], "mini")
        self.assertEqual(row["sev"], "ok")
        self.assertEqual(row["lane"], "extraction")
        self.assertEqual(row["doc_id"], "d1")
        # Non-column extras are preserved in payload for the detail views.
        self.assertIn("needs_review", row["payload"])
        self.assertGreater(row["ts"], 0)

    def test_explicit_sev_passthrough(self):
        row = hitl_events.normalize_hitl_event(
            {"event": "hitl_event", "type": "verify.low_confidence", "sev": "warn"}, "mini")
        self.assertEqual(row["sev"], "warn")


class HitlForwarderParseTest(unittest.TestCase):
    def test_parses_python_repr_and_json(self):
        # hitl-v1's SSE writes str(dict), not strict JSON.
        repr_line = "{'type': 'extraction.failed', 'timestamp': 1.0, 'doc_id': 'x', 'error': 'boom'}"
        json_line = '{"type": "pipeline.complete", "doc_id": "x", "pass_rate": 0.9}'
        for line in (repr_line, json_line):
            payload = hitl_forwarder.parse_data_line(line)
            self.assertIsInstance(payload, dict)
            self.assertIn("type", payload)
        self.assertEqual(
            hitl_forwarder.parse_data_line(repr_line)["type"], "extraction.failed")
        self.assertEqual(
            hitl_forwarder.parse_data_line(json_line)["pass_rate"], 0.9)

    def test_rejects_empty_and_garbage(self):
        self.assertIsNone(hitl_forwarder.parse_data_line("{}"))
        self.assertIsNone(hitl_forwarder.parse_data_line(""))
        self.assertIsNone(hitl_forwarder.parse_data_line("not json ["))


class HitlIngestRoundTripTest(unittest.TestCase):
    def test_ingest_then_backfill(self):
        port = allocate_local_port()
        base = f"http://127.0.0.1:{port}"
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.Popen(
                [sys.executable, str(ROOT / "app.py"), "--bind", "127.0.0.1",
                 "--port", str(port), "--db", str(Path(tmp) / "t.db")],
                cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if proc.poll() is not None:
                        self.fail("app.py exited early:\n" + proc.stdout.read())
                    try:
                        urllib.request.urlopen(base + "/health", timeout=2)
                        break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() > deadline:
                            self.fail("app.py did not become healthy")
                        time.sleep(0.1)
                body = json.dumps({"host": "mini", "records": [
                    {"event": "hitl_event", "ts": time.time(), "type": "document.uploaded", "doc_id": "d1"},
                    {"event": "hitl_event", "ts": time.time(), "type": "extraction.failed",
                     "doc_id": "d1", "extraction_id": "e9", "error": "OCRError"},
                    {"event": "api", "ts": time.time(), "model": "m", "kind": "api"},  # ignored by hitl path
                ]}).encode()
                req = urllib.request.Request(base + "/ingest", data=body,
                                             headers={"Content-Type": "application/json"})
                with urllib.request.urlopen(req, timeout=5) as resp:
                    result = json.load(resp)
                self.assertTrue(result["ok"])
                self.assertEqual(result["hitl_ingested"], 2)
                with urllib.request.urlopen(base + "/api/hitl-events?since_h=1", timeout=5) as resp:
                    events = json.load(resp)["events"]
                self.assertEqual(len(events), 2)
                by_type = {e["type"]: e for e in events}
                self.assertEqual(by_type["document.uploaded"]["sev"], "ok")
                self.assertEqual(by_type["extraction.failed"]["sev"], "error")
                self.assertEqual(by_type["extraction.failed"]["lane"], "extraction")
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()


if __name__ == "__main__":
    unittest.main()
