"""Tests for app.py's /ingest/hermes-webhook endpoint: HMAC verification,
payload translation (outbound-webhook delivery -> forwarder record shape),
delivery_id dedupe, and an end-to-end signed POST against a live server."""

import hashlib
import hmac
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

import app

ROOT = Path(__file__).resolve().parents[1]

SECRET = "test-webhook-secret"


def sign(secret, body: bytes) -> str:
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return "sha256=" + digest


def make_payload(event="post_api_request", delivery_id="del-1", **extra):
    return {
        "hook_event_name": event,
        "tool_name": None,
        "tool_input": None,
        "session_id": "sess-1",
        "cwd": "/tmp",
        "extra": extra,
        "delivery_id": delivery_id,
        "timestamp": "2026-08-03T10:00:00Z",
    }


class VerifySignatureTests(unittest.TestCase):
    def test_valid_signature_accepted(self):
        body = b'{"a": 1}'
        self.assertTrue(app.verify_webhook_signature(SECRET, body, sign(SECRET, body)))

    def test_wrong_secret_rejected(self):
        body = b'{"a": 1}'
        self.assertFalse(
            app.verify_webhook_signature(SECRET, body, sign("other", body)))

    def test_tampered_body_rejected(self):
        body = b'{"a": 1}'
        self.assertFalse(
            app.verify_webhook_signature(SECRET, body + b"x", sign(SECRET, body)))

    def test_missing_or_malformed_header_rejected(self):
        body = b'{"a": 1}'
        self.assertFalse(app.verify_webhook_signature(SECRET, body, ""))
        self.assertFalse(app.verify_webhook_signature(SECRET, body, "deadbeef"))
        self.assertFalse(
            app.verify_webhook_signature(SECRET, body, sign(SECRET, body).upper()))

    def test_no_secret_configured_accepts_unsigned(self):
        self.assertTrue(app.verify_webhook_signature("", b"{}", ""))
        self.assertTrue(app.verify_webhook_signature(None, b"{}", None))


class ParseTsTests(unittest.TestCase):
    def test_iso_z(self):
        self.assertEqual(
            app._parse_webhook_ts("1970-01-01T00:00:10Z"), 10.0)

    def test_iso_offset_and_naive(self):
        self.assertEqual(
            app._parse_webhook_ts("1970-01-01T01:00:10+01:00"), 10.0)
        self.assertEqual(
            app._parse_webhook_ts("1970-01-01T00:00:10"), 10.0)

    def test_numbers_and_junk(self):
        self.assertEqual(app._parse_webhook_ts(42), 42.0)
        self.assertEqual(app._parse_webhook_ts(4.5), 4.5)
        self.assertIsNone(app._parse_webhook_ts(True))
        self.assertIsNone(app._parse_webhook_ts("not a date"))
        self.assertIsNone(app._parse_webhook_ts(None))


class TranslateWebhookTests(unittest.TestCase):
    def test_post_api_request_full(self):
        payload = make_payload(
            delivery_id="d1",
            task_id="t1", turn_id="tu1", api_request_id="ar1",
            platform="cli", model="m-a", provider="local",
            api_duration=2.0, started_at=1000.0, ended_at=1002.0,
            finish_reason="stop",
            usage={"input_tokens": 11, "output_tokens": 10,
                   "stats": {"tokens_per_second": 6.5}},
            assistant_content_chars=123,
        )
        rec = app.translate_webhook(payload)
        self.assertEqual(rec["event"], "post_api_request")
        self.assertEqual(rec["session_id"], "sess-1")
        self.assertEqual(rec["ts"], 1002.0)  # ended_at wins
        self.assertEqual(rec["model"], "m-a")
        self.assertEqual(rec["api_duration"], 2.0)
        self.assertEqual(rec["usage"]["output_tokens"], 10)
        # And it normalizes into the api kind with tps derived downstream.
        row = app.normalize(rec, "mbp")
        self.assertEqual(row["kind"], "api")
        self.assertEqual(row["output_tokens"], 10)
        self.assertEqual(row["tps"], 5.0)
        self.assertEqual(row["host"], "mbp")

    def test_ts_falls_back_to_delivery_timestamp(self):
        payload = make_payload(delivery_id="d2", model="m-a")
        rec = app.translate_webhook(payload)
        self.assertEqual(
            rec["ts"],
            app._parse_webhook_ts("2026-08-03T10:00:00Z"))

    def test_api_request_error_unpacks_error_dict(self):
        payload = make_payload(
            event="api_request_error", delivery_id="d3",
            model="m-a", provider="local", api_duration=0.5, ended_at=7.0,
            status_code=500,
            error={"type": "server_error", "message": "boom"},
        )
        rec = app.translate_webhook(payload)
        self.assertEqual(rec["error_type"], "server_error")
        self.assertEqual(rec["error_message"], "boom")
        row = app.normalize(rec, "mini")
        self.assertEqual(row["kind"], "error")
        self.assertEqual(row["error"], "server_error: boom")

    def test_subagent_stop(self):
        payload = make_payload(
            event="subagent_stop", delivery_id="d4",
            child_session_id="child-1", child_role="explorer",
            child_status="ok", duration_ms=2500,
        )
        rec = app.translate_webhook(payload)
        self.assertEqual(rec["event"], "subagent_stop")
        self.assertEqual(rec["child_session_id"], "child-1")
        self.assertEqual(rec["duration_ms"], 2500)
        row = app.normalize(rec, "mini")
        self.assertEqual(row["kind"], "subagent_stop")
        self.assertEqual(row["session_id"], "child-1")  # attributed to child
        self.assertEqual(row["duration_s"], 2.5)
        # Hermes sends the spawning session as session_id and no
        # parent_session_id; it must survive the swap to the child.
        self.assertEqual(row["parent_session_id"], "sess-1")

    def test_profile_is_recorded(self):
        payload = make_payload(delivery_id="d6", model="m-a")
        payload["profile"] = "coder"
        row = app.normalize(app.translate_webhook(payload), "mbp")
        self.assertEqual(row["profile"], "coder")

    def test_unknown_event_records_extra_keys(self):
        payload = make_payload(event="on_session_end", delivery_id="d5", foo=1)
        rec = app.translate_webhook(payload)
        self.assertEqual(rec["event"], "on_session_end")
        self.assertEqual(rec["extra_keys"], ["foo"])

    def test_missing_event_returns_none(self):
        self.assertIsNone(app.translate_webhook({"extra": {}}))
        self.assertIsNone(app.translate_webhook("not a dict"))

    def test_translation_is_deterministic_for_retries(self):
        payload = make_payload(delivery_id="d6", model="m-a", ended_at=9.0,
                               usage={"output_tokens": 3})
        self.assertEqual(app.translate_webhook(payload),
                         app.translate_webhook(dict(payload)))


class DeliveryDedupeTests(unittest.TestCase):
    def test_first_seen_then_dup(self):
        dd = app.DeliveryDedupe(max_size=3)
        self.assertFalse(dd.is_dup("a"))
        self.assertTrue(dd.is_dup("a"))

    def test_empty_id_never_dups(self):
        dd = app.DeliveryDedupe(max_size=3)
        self.assertFalse(dd.is_dup(""))
        self.assertFalse(dd.is_dup(None))

    def test_fifo_eviction_bounded(self):
        dd = app.DeliveryDedupe(max_size=2)
        dd.is_dup("a")
        dd.is_dup("b")
        dd.is_dup("c")  # evicts "a"
        self.assertFalse(dd.is_dup("a"))  # forgotten -> seen as new
        self.assertTrue(dd.is_dup("c"))


# ---------------------------------------------------------------------------
# End-to-end against a live app.py subprocess
# ---------------------------------------------------------------------------

def allocate_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_json(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return response.status, json.load(response)


def post_raw(url, body: bytes, headers=None):
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json", **(headers or {})},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=2) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


class WebhookServerTest(unittest.TestCase):
    """Signed POSTs against a live server with the secret set."""

    @classmethod
    def setUpClass(cls):
        cls.port = allocate_local_port()
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.temp_dir = tempfile.TemporaryDirectory()
        env = dict(os.environ)
        env["HERMES_OUTBOUND_WEBHOOK_SECRET"] = SECRET
        env["HERMES_HOME"] = cls.temp_dir.name  # no real ~/.hermes/.env
        cls.process = subprocess.Popen(
            [sys.executable, str(ROOT / "app.py"),
             "--bind", "127.0.0.1", "--port", str(cls.port),
             "--db", str(Path(cls.temp_dir.name) / "wh.db")],
            cwd=ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.monotonic() + 10
        while True:
            if cls.process.poll() is not None:
                raise AssertionError(
                    "app.py exited early:\n" + cls.process.stdout.read())
            try:
                get_json(cls.base_url + "/health")
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    raise AssertionError("app.py did not become healthy")
                time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=5)
        cls.temp_dir.cleanup()

    def url(self):
        return self.base_url + "/ingest/hermes-webhook?host=mbp"

    def post(self, payload, secret=SECRET, sign_it=True):
        body = json.dumps(payload).encode()
        headers = {}
        if sign_it:
            headers["X-Hermes-Signature-256"] = sign(secret, body)
        return post_raw(self.url(), body, headers)

    def test_signed_delivery_lands_as_record(self):
        payload = make_payload(
            delivery_id="e2e-1", model="m-e2e", provider="local",
            api_duration=2.0, ended_at=time.time(),
            usage={"input_tokens": 5, "output_tokens": 10},
            finish_reason="stop")
        status, resp = self.post(payload)
        self.assertEqual(status, 200)
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["ingested"], 1)

        _, recent = get_json(self.base_url + "/api/recent?hours=1")
        matches = [r for r in recent["records"] if r.get("model") == "m-e2e"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["kind"], "api")
        self.assertEqual(matches[0]["host"], "mbp")
        self.assertEqual(matches[0]["output_tokens"], 10)

    def test_bad_signature_rejected(self):
        status, resp = self.post(
            make_payload(delivery_id="e2e-2", model="m-e2e"), secret="wrong")
        self.assertEqual(status, 401)
        self.assertFalse(resp["ok"])

    def test_unsigned_rejected_when_secret_configured(self):
        status, _ = self.post(
            make_payload(delivery_id="e2e-3", model="m-e2e"), sign_it=False)
        self.assertEqual(status, 401)

    def test_retried_delivery_deduped(self):
        payload = make_payload(
            delivery_id="e2e-4", model="m-e2e-dup", ended_at=time.time())
        status1, resp1 = self.post(payload)
        status2, resp2 = self.post(payload)
        self.assertEqual((status1, resp1["ingested"]), (200, 1))
        self.assertEqual((status2, resp2["ingested"]), (200, 0))
        self.assertTrue(resp2["deduped"])

        _, recent = get_json(self.base_url + "/api/recent?hours=1")
        matches = [r for r in recent["records"] if r.get("model") == "m-e2e-dup"]
        self.assertEqual(len(matches), 1)

    def test_missing_event_name_rejected(self):
        status, _ = self.post({"delivery_id": "e2e-5", "extra": {}})
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
