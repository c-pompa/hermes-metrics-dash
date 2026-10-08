#!/usr/bin/env python3
"""hitl-v1 event-feed helpers — table shape, severity/lane mapping.

hitl-v1 (HITTLE document OCR, mini :8010) publishes document/extraction/pipeline
lifecycle events on its own SSE stream. `hitl_forwarder.py` ships them here as
{"event": "hitl_event", ...} ingest records; this module flattens them into the
hitl_events table and classifies them for the #/events dashboard page.
"""
from __future__ import annotations

import time

HITL_COLUMNS = [
    "ts", "host", "type", "sev", "lane",
    "doc_id", "extraction_id", "template_id", "payload",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS hitl_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  host TEXT,
  type TEXT,
  sev TEXT,
  lane TEXT,
  doc_id TEXT,
  extraction_id TEXT,
  template_id TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_hitl_events_ts ON hitl_events(ts);
"""

SEVERITIES = ("ok", "info", "warn", "error")

# Lane = which hitl-v1 module produced the event (drives the topology lanes).
LANE_BY_PREFIX = {
    "pipeline": "orchestrator",
    "document": "documents",
    "extraction": "extraction",
    "webhook": "webhooks",
}

_ERROR_TYPES = {"extraction.failed", "extraction.rejected"}
_OK_TYPES = {
    "document.uploaded",
    "extraction.completed",
    "extraction.approved",
    "pipeline.start",
    "pipeline.complete",
}


def classify_sev(event_type: str, payload: str = "") -> str:
    """Map a hitl-v1 event type to a dashboard severity."""
    t = (event_type or "").lower()
    if t in _ERROR_TYPES or "failed" in t or "error" in t:
        return "error"
    if "failed" in payload.lower() or "ocerror" in payload.lower():
        return "error"
    if "warn" in t or "retry" in t or "timeout" in t:
        return "warn"
    if t in _OK_TYPES:
        return "ok"
    return "info"  # pipeline.stage_start / stage_complete and anything else


def classify_lane(event_type: str) -> str:
    prefix = (event_type or "").split(".", 1)[0].lower()
    return LANE_BY_PREFIX.get(prefix, "other")


def normalize_hitl_event(rec: dict, host: str) -> dict:
    """Flatten one forwarder hitl_event record into table row shape."""
    import json

    event_type = str(rec.get("type") or "unknown")
    try:
        ts = float(rec.get("ts") or rec.get("timestamp") or time.time())
    except (TypeError, ValueError):
        ts = time.time()
    payload = rec.get("payload")
    if payload is None:
        # Keep the raw extras (minus fields already lifted into columns) so the
        # page can show event details without a second lookup.
        extras = {k: v for k, v in rec.items()
                  if k not in ("event", "ts", "timestamp", "host", "type",
                               "doc_id", "extraction_id", "template_id", "sev")}
        payload = json.dumps(extras, default=str) if extras else ""
    sev = rec.get("sev")
    if sev not in SEVERITIES:
        sev = classify_sev(event_type, str(payload))
    return {
        "ts": ts,
        "host": rec.get("host") or host,
        "type": event_type,
        "sev": sev,
        "lane": rec.get("lane") or classify_lane(event_type),
        "doc_id": rec.get("doc_id") or "",
        "extraction_id": rec.get("extraction_id") or "",
        "template_id": rec.get("template_id") or "",
        "payload": payload,
    }
