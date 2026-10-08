#!/usr/bin/env python3
"""hitl-v1 event forwarder — ships hitl-v1's lifecycle events to the metrics
dashboard.

hitl-v1 (HITTLE document OCR) publishes document/extraction/pipeline events on
its own SSE endpoint (http://127.0.0.1:8010/api/events). This forwarder
consumes that stream, wraps each event as a {"event": "hitl_event", ...}
record, and POSTs batches to the metrics dashboard's /ingest, which stores
them in the hitl_events table and rebroadcasts them on the dashboard SSE.

Note: hitl-v1's SSE data lines are the str() of a dict (Python repr) rather
than strict JSON, so parsing falls back to ast.literal_eval.

Stdlib only. Run via launchd; see a LaunchAgent like launchd/ai.hermes.metricsfwd.plist.
"""
import ast
import json
import os
import socket
import sys
import time
import urllib.request

HITL_SSE_URL = os.environ.get("HITL_SSE_URL", "http://127.0.0.1:8010/api/events")
DASH_URL = os.environ.get("METRICS_DASH_URL", "http://127.0.0.1:8899").rstrip("/")
HOST_LABEL = os.environ.get("METRICS_HOST_LABEL", socket.gethostname().split(".")[0])
BATCH_MAX = int(os.environ.get("HITL_BATCH_MAX", "100"))
FLUSH_SECONDS = float(os.environ.get("HITL_FLUSH_SECONDS", "5"))
RECONNECT_SECONDS = float(os.environ.get("HITL_RECONNECT_SECONDS", "5"))


def parse_data_line(data: str):
    """Parse one SSE data: payload — strict JSON first, then Python repr."""
    data = data.strip()
    if not data or data == "{}":
        return None
    try:
        obj = json.loads(data)
    except json.JSONDecodeError:
        try:
            obj = ast.literal_eval(data)
        except (ValueError, SyntaxError):
            return None
    return obj if isinstance(obj, dict) else None


def ingest_headers() -> dict:
    """JSON headers plus this sender's /ingest token ($METRICS_INGEST_TOKEN, else
    ~/.hermes/metrics/ingest.token, issued by auth_tokens.py on the collector).
    Read per send so a rotated token is picked up without a restart."""
    headers = {"Content-Type": "application/json"}
    token = os.environ.get("METRICS_INGEST_TOKEN", "").strip()
    if not token:
        try:
            with open(os.path.expanduser("~/.hermes/metrics/ingest.token")) as f:
                token = f.read().strip()
        except OSError:
            pass
    if token:
        headers["Authorization"] = "Bearer " + token
    return headers


def ship(records: list) -> bool:
    payload = json.dumps({"host": HOST_LABEL, "records": records}).encode("utf-8")
    req = urllib.request.Request(
        DASH_URL + "/ingest", data=payload, headers=ingest_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return 200 <= resp.status < 300
    except Exception as exc:
        print(f"ship failed ({len(records)} records): {exc}", file=sys.stderr, flush=True)
        return False


def stream_events():
    """Yield hitl_event records from hitl-v1's SSE stream."""
    with urllib.request.urlopen(HITL_SSE_URL, timeout=60) as resp:
        buf = b""
        for chunk in resp:
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.decode("utf-8", errors="replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = parse_data_line(line[len("data:"):])
                if payload is None:
                    continue
                event_type = payload.pop("type", None)
                if not event_type:
                    continue
                payload.pop("timestamp", None)  # wall-clock ts wins below
                yield {
                    "event": "hitl_event",
                    "ts": time.time(),
                    "type": event_type,
                    **payload,
                }


def main() -> None:
    print(f"hitl-forwarder up host={HOST_LABEL} {HITL_SSE_URL} -> {DASH_URL}", flush=True)
    pending: list = []
    last_flush = 0.0
    while True:
        try:
            for rec in stream_events():
                pending.append(rec)
                now = time.time()
                if pending and (len(pending) >= BATCH_MAX or now - last_flush >= FLUSH_SECONDS):
                    if ship(list(pending)):
                        pending.clear()
                    last_flush = now
            # stream ended cleanly — hitl-v1 closed; fall through to reconnect
        except Exception as exc:
            print(f"stream error: {exc} — reconnecting in {RECONNECT_SECONDS}s",
                  file=sys.stderr, flush=True)
        # Flush whatever arrived before the drop, then back off and reconnect.
        if pending and ship(list(pending)):
            pending.clear()
        time.sleep(RECONNECT_SECONDS)


if __name__ == "__main__":
    main()
