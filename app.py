#!/usr/bin/env python3
"""Hermes metrics dashboard — stdlib-only live LLM request metrics server.

Receives per-request metric records from `forwarder.py` instances (one per
machine running Hermes), stores them in sqlite, and serves a single-page
live dashboard over HTTP + Server-Sent Events.

Endpoints:
  GET  /                     dashboard page (static/index.html)
  GET  /static/<file>        static assets (benchmark.js, …)
  GET  /health               liveness probe
  POST /ingest               {"host": "...", "records": [...]}  (from forwarder)
  POST /ingest/hermes-webhook?host=<label>   one Hermes outbound-webhook
                             delivery (hooks.outbound in config.yaml), HMAC
                             verified, translated into the /ingest record shape
  GET  /api/recent?hours=24&limit=3000   recent records, newest last
  GET  /api/moa/summary?hours=1   MoA run aggregate for the desktop pane
                             (runs, per-voice calls/latency, aggregator,
                             p95 fan-out; available:false when no runs)
  GET  /api/findings?days=7   aggregated health-rule finding history (snapshots)
  GET  /api/hitl-events?since_h=24&limit=1000   recent hitl-v1 lifecycle events
  GET  /api/benchmark/samples
  GET  /api/benchmark/best
  POST /api/benchmark/mark
  GET  /api/env-mode         active Hermes env mode + available modes
  GET  /api/env-mode/preview?mode=…  proposed config diff (no write)
  POST /api/env-mode         apply mode {mode, confirm} (Mini + MBP sync)
  GET  /events               SSE stream of records as they arrive

Core dashboard is stdlib-only. Env-mode apply uses PyYAML (already on Mini/MBP).
"""
import argparse
import datetime
import hashlib
import hmac
import json
import math
import mimetypes
import os
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import benchmark
import harness_store
import env_mode
import health_rules
import hitl_events
import host_checks

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB = os.path.expanduser("~/.hermes/metrics/metrics.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  host TEXT,
  event TEXT,
  kind TEXT,
  session_id TEXT,
  parent_session_id TEXT,
  session_title TEXT,
  turn_id TEXT,
  api_request_id TEXT,
  platform TEXT,
  model TEXT,
  provider TEXT,
  duration_s REAL,
  tps REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  finish_reason TEXT,
  error TEXT,
  preset TEXT,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_records_ts ON records(ts);
CREATE INDEX IF NOT EXISTS idx_records_session ON records(session_id);

CREATE TABLE IF NOT EXISTS benchmark_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  host TEXT,
  usage TEXT,
  model TEXT,
  ctx_k INTEGER,
  parallel INTEGER,
  ttl TEXT,
  offload TEXT,
  hermes_knobs TEXT,
  tps REAL,
  p50_s REAL,
  vram_gb REAL,
  model_gb REAL,
  cpu_load REAL,
  mem_used_gb REAL,
  mem_total_gb REAL,
  power_w REAL,
  "yield" REAL,
  experiment TEXT,
  named INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_benchmark_ts ON benchmark_samples(ts);
CREATE INDEX IF NOT EXISTS idx_benchmark_usage_host ON benchmark_samples(usage, host);

CREATE TABLE IF NOT EXISTS benchmark_marks (
  host TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  ts REAL NOT NULL
);

-- Health-rule snapshots (health_rules.compute_findings run over the trailing
-- 6h every 30 min; see health_snapshot_loop). One row per finding, including
-- the sev="ok" "all passing" row, so history can show quiet stretches too.
CREATE TABLE IF NOT EXISTS health_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,          -- snapshot time
  window_hours REAL NOT NULL,
  rule TEXT NOT NULL,        -- e.g. "R4", "R11", "OK"
  sev TEXT NOT NULL,         -- crit|warn|info|ok
  text TEXT NOT NULL,
  action TEXT,
  beta INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_health_findings_ts ON health_findings(ts);
"""

# Added after the initial schema shipped; applied idempotently at startup.
MIGRATION_COLUMNS = {
    "ttft_s": "REAL",
    "tps_native": "REAL",
    "spec_accept_rate": "REAL",
    "device": "TEXT",
    "cost_usd": "REAL",
    "cpu_load": "REAL",
    "mem_used_gb": "REAL",
    "mem_total_gb": "REAL",
    # Idempotency key (see normalize); NULL on pre-migration rows, and SQLite
    # UNIQUE indexes allow multiple NULLs, so old rows never collide.
    "dedup_key": "TEXT",
    # Session identity beyond (usually NULL) titles — from state.db.source /
    # started_at, for source-based conversation labels.
    "session_source": "TEXT",
    "session_started_at": "REAL",
    # Visible assistant text length per API call (from the metrics hook).
    # 0 with finish_reason stop/length = empty/reasoning-only response (R13).
    "assistant_content_chars": "INTEGER",
    # Model that actually answered (from the metrics hook). For a call through
    # a router role alias, model is the alias and this is what it resolved to.
    "response_model": "TEXT",
    # Hermes profile that emitted the event (webhook payloads carry it); lets
    # the Ops Timeline name callers on hosts whose state.db it cannot read.
    "profile": "TEXT",
}

COLUMNS = [
    "ts", "host", "event", "kind", "session_id", "parent_session_id",
    "session_title", "turn_id", "api_request_id", "platform", "model",
    "provider", "duration_s", "tps", "input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
    "finish_reason", "error", "preset", "label",
] + list(MIGRATION_COLUMNS)

MAX_RECENT_LIMIT = 20000
DEFAULT_RECENT_LIMIT = 3000
DEFAULT_RECENT_HOURS = 24.0

MAX_BODY_BYTES = 1024 * 1024  # 1 MB cap on POST bodies
MAX_SSE_SUBSCRIBERS = 64
# Records older than this are pruned hourly; 0 disables. benchmark_samples are
# forever-retained by design and never pruned.
RETENTION_DAYS = float(os.environ.get("METRICS_RETENTION_DAYS", "30"))
# pool_status heartbeats (75% of volume, near-zero historical value) are
# pruned after this many hours; host_stats is downsampled to one row per host
# per 5 minutes beyond it.
HEARTBEAT_HOURS = float(os.environ.get("METRICS_HEARTBEAT_HOURS", "48"))
# Health-rule snapshots: every HEALTH_SNAPSHOT_INTERVAL_S the trailing
# HEALTH_SNAPSHOT_WINDOW_H of records is scored by health_rules and persisted
# (see health_snapshot_loop). METRICS_HEALTH_SNAPSHOTS=0 disables the thread.
HEALTH_SNAPSHOT_INTERVAL_S = 1800
HEALTH_SNAPSHOT_WINDOW_H = 6.0
HEALTH_SNAPSHOTS_ENABLED = os.environ.get("METRICS_HEALTH_SNAPSHOTS", "1") != "0"
# Dashboard-managed usage map (set via POST /api/usage-map); forwarders poll
# it hourly and prefer it over their local file.
USAGE_MAP_PATH = os.environ.get(
    "USAGE_MAP_FILE", os.path.expanduser("~/.hermes/metrics/usage-map.json")
)
APP_REVISION = ""  # filled in by main()


# ---------------------------------------------------------------------------
# Session names: id -> title/display_name from the Hermes state DBs (main +
# per-profile), read-only and best-effort. Cron session titles carry the job
# name. Cached briefly so the dashboard's 30s polling never hammers sqlite.

HERMES_DIR = Path(os.path.expanduser(os.environ.get("HERMES_DIR", "~/.hermes")))
SESSION_NAMES_TTL_S = 30.0
SESSION_NAMES_MAX_AGE_DAYS = 14.0
_session_names_cache = {"ts": 0.0, "data": {}}
_session_names_lock = threading.Lock()


def read_session_names(base_dir: Path, max_age_days: float = SESSION_NAMES_MAX_AGE_DAYS) -> dict:
    names = {}
    dbs = [base_dir / "state.db"] + sorted((base_dir / "profiles").glob("*/state.db"))
    cutoff = time.time() - max_age_days * 86400
    for db in dbs:
        if not db.is_file():
            continue
        try:
            conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
            try:
                rows = conn.execute(
                    "SELECT id, COALESCE(NULLIF(display_name, ''), NULLIF(title, '')) FROM sessions"
                    " WHERE started_at >= ? AND COALESCE(NULLIF(display_name, ''), NULLIF(title, '')) IS NOT NULL",
                    (cutoff,),
                ).fetchall()
            finally:
                conn.close()
        except sqlite3.Error:
            continue
        for sid, title in rows:
            if sid and title and sid not in names:
                names[sid] = title
    return names


ROUTER_URL = os.environ.get("MODEL_ROUTER_URL", "http://127.0.0.1:8867")
ROUTER_NOTES_PATH = Path.home() / ".hermes" / "model-router" / "notes.json"


def router_token() -> str:
    """Daemon bearer token (H1): $MODEL_ROUTER_TOKEN / $ROUTER_TOKEN env,
    else ~/.hermes/model-router/router.token. "" = daemon in legacy open
    mode (same resolution as the model-router plugin's router_core)."""
    for var in ("MODEL_ROUTER_TOKEN", "ROUTER_TOKEN"):
        val = os.environ.get(var, "").strip()
        if val:
            return val
    try:
        with open(Path.home() / ".hermes" / "model-router" / "router.token") as f:
            return f.read().strip()
    except OSError:
        return ""


def read_router_notes() -> dict:
    """Analysis/recommendation notes written by the model-router rollout events.

    The file lives beside the router's config and is the same document the
    router itself serves at GET /router/notes; we read it from disk (same
    machine) so the card works even while the router is down.
    """
    try:
        with open(ROUTER_NOTES_PATH) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"notes": []}
    except Exception as exc:
        return {"notes": [], "error": str(exc)}


def fetch_router_status() -> dict:
    """Proxy the loopback-only router status for the browser (LAN clients
    cannot reach 127.0.0.1:8867 themselves)."""
    import urllib.request
    headers = {}
    token = router_token()
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(ROUTER_URL + "/router/status", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.load(r)
    except Exception as exc:
        return {"error": str(exc)}


ROUTER_EXEC_LOG = Path.home() / ".hermes" / "logs" / "model-router-requests.jsonl"


def router_usage(since_h: float = 24.0) -> dict:
    """Aggregate the router's JSONL execution log per role.

    Same shape as `rolectl usage --json`: requests, errors, fallthroughs,
    retries, token totals, p50/p95 duration, and per-model resolution counts —
    plus a `degradations` feed (most recent 503s / fallthroughs / retries)
    for the moderator view.
    """
    cutoff = time.time() - since_h * 3600
    agg: dict = {}
    degradations: list = []
    try:
        f = open(ROUTER_EXEC_LOG)
    except FileNotFoundError:
        return {"since_h": since_h, "roles": {}, "degradations": []}
    with f:
        for line in f:
            try:
                e = json.loads(line)
                ts = time.mktime(time.strptime(e["ts"][:19], "%Y-%m-%dT%H:%M:%S"))
            except Exception:
                continue
            if ts < cutoff:
                continue
            r = e.get("role") or "(passthrough)"
            a = agg.setdefault(r, {"requests": 0, "errors": 0, "fallthroughs": 0,
                                   "retries": 0, "tokens_in": 0, "tokens_out": 0,
                                   "durations": [], "models": {}})
            a["requests"] += 1
            status = e.get("status") or 0
            reason = e.get("reason") or ""
            if status >= 400:
                a["errors"] += 1
            if "fallthrough" in reason:
                a["fallthroughs"] += 1
            if reason.endswith("-retry"):
                a["retries"] += 1
            if status >= 400 or "fallthrough" in reason or reason.endswith("-retry"):
                degradations.append({"ts": e.get("ts"), "role": r, "status": status,
                                     "reason": reason, "model": e.get("model")})
            u = e.get("usage") or {}
            a["tokens_in"] += u.get("prompt_tokens") or 0
            a["tokens_out"] += u.get("completion_tokens") or 0
            if e.get("duration_s") is not None:
                a["durations"].append(e["duration_s"])
            if e.get("model"):
                a["models"][e["model"]] = a["models"].get(e["model"], 0) + 1
    for a in agg.values():
        ds = sorted(a.pop("durations"))
        pick = lambda p: ds[min(len(ds) - 1, max(0, round(p / 100 * (len(ds) - 1))))] if ds else None
        a["p50_s"] = pick(50)
        a["p95_s"] = pick(95)
    return {"since_h": since_h, "roles": agg, "degradations": degradations[-25:]}


def session_names_cached() -> dict:
    with _session_names_lock:
        now = time.time()
        if now - _session_names_cache["ts"] > SESSION_NAMES_TTL_S:
            _session_names_cache["data"] = read_session_names(HERMES_DIR)
            _session_names_cache["ts"] = now
        return _session_names_cache["data"]


# ---------------------------------------------------------------------------
# Beta widgets: lifecycle state for experimental dashboard widgets. A review
# agent (hermes cron) appends bi-daily effectiveness reviews and eventually a
# final recommendation; the page then offers keep/delete, recorded here.
# NOTE to parallel agents: this block was clobbered once (dd12cbe) by a patch
# built from a stale copy — always start from current HEAD before editing.

BETA_WIDGETS_PATH = Path(os.path.expanduser(
    os.environ.get("BETA_WIDGETS_PATH", "~/.hermes/metrics/beta-widgets.json")))
_beta_widgets_lock = threading.Lock()


def read_beta_widgets() -> dict:
    try:
        data = json.loads(BETA_WIDGETS_PATH.read_text())
    except (OSError, ValueError):
        return {"widgets": {}}
    if not isinstance(data, dict) or not isinstance(data.get("widgets"), dict):
        return {"widgets": {}}
    return data


def record_beta_decision(widget_id: str, decision: str) -> dict:
    if decision not in ("keep", "delete"):
        raise ValueError("decision must be keep or delete")
    if not widget_id or not isinstance(widget_id, str):
        raise ValueError("id required")
    with _beta_widgets_lock:
        data = read_beta_widgets()
        widget = data.setdefault("widgets", {}).setdefault(widget_id, {})
        widget["status"] = "kept" if decision == "keep" else "deleted"
        widget["decision"] = {"choice": decision, "ts": time.time()}
        BETA_WIDGETS_PATH.parent.mkdir(parents=True, exist_ok=True)
        BETA_WIDGETS_PATH.write_text(json.dumps(data, indent=2))
        return data


def read_usage_map() -> dict:
    try:
        data = json.loads(Path(USAGE_MAP_PATH).read_text())
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def write_usage_map_entry(key: str, usage: str) -> dict:
    key = (key or "").strip()
    if not key:
        raise ValueError("model key is required")
    if usage not in benchmark.USAGE_HELP:
        raise ValueError(
            f"usage must be one of: {', '.join(sorted(benchmark.USAGE_HELP))}"
        )
    path = Path(USAGE_MAP_PATH)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = read_usage_map()
    data[key] = usage
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, path)
    return {key: usage}


def _git_revision() -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(BASE_DIR), "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=3, check=False)
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return ""


class BodyRejected(Exception):
    """POST body failed transport checks; carries an HTTP status code."""

    def __init__(self, code: int, message: str):
        super().__init__(message)
        self.code = code


def parse_recent_query(query: str, now: float = None) -> tuple:
    """Return validated (since, until, limit) values for /api/recent."""
    qs = parse_qs(query, keep_blank_values=True)
    current_time = time.time() if now is None else now

    raw_limit = qs.get("limit", [str(DEFAULT_RECENT_LIMIT)])[0]
    try:
        limit = int(raw_limit)
    except (TypeError, ValueError):
        raise ValueError("limit must be a positive integer") from None
    if limit <= 0:
        raise ValueError("limit must be a positive integer")
    limit = min(limit, MAX_RECENT_LIMIT)

    def finite_float(name: str, value: str) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be a finite number") from None
        if not math.isfinite(parsed):
            raise ValueError(f"{name} must be a finite number")
        return parsed

    if "to" in qs and "from" not in qs:
        raise ValueError("to requires from")

    if "from" in qs:
        since = finite_float("from", qs["from"][0])
        until = finite_float("to", qs.get("to", [str(current_time)])[0])
        if until <= since:
            raise ValueError("to must be greater than from")
    else:
        hours = finite_float(
            "hours", qs.get("hours", [str(DEFAULT_RECENT_HOURS)])[0]
        )
        if hours <= 0:
            raise ValueError("hours must be greater than zero")
        until = current_time
        since = until - hours * 3600
        if not math.isfinite(since):
            raise ValueError("hours is too large")

    return since, until, limit


def parse_exclude_kinds(query: str) -> list:
    """Validated comma-separated kind exclusions for /api/recent.

    Lets the dashboard fetch request history without pool_status/host_stats
    heartbeats crowding real records out of the row limit.
    """
    qs = parse_qs(query, keep_blank_values=True)
    raw = (qs.get("exclude", [""])[0] or "").strip()
    if not raw:
        return []
    kinds = [k.strip() for k in raw.split(",") if k.strip()]
    if len(kinds) > 12:
        raise ValueError("exclude supports at most 12 kinds")
    for k in kinds:
        if not re.fullmatch(r"[a-z_]+", k):
            raise ValueError(f"invalid kind in exclude: {k!r}")
    return kinds


# Twin-matching window for drop_router_twins: the hook record and the router
# exec-log line for one call land within a second or two of each other.
ROUTER_TWIN_WINDOW_S = 3.0


def drop_router_twins(records: list) -> list:
    """Drop router_request rows that duplicate a hook-emitted api row.

    A client that hits the model router WITH the metrics hook wired produces
    two rows per call: an api row (model = role alias, e.g. "hermes/main") and
    a router_request row (model = resolved model, label = role). The router
    row is the only trail for hook-less clients, so it must stay visible in
    that case; when the api twin exists, keeping both would double-count the
    call in every widget. Twin test: api.model == router_request.label, ts
    within ROUTER_TWIN_WINDOW_S, and equal output_tokens when both rows
    report them.
    """
    api_rows = [r for r in records if r.get("kind") == "api" and r.get("model")]
    if not api_rows:
        return records
    by_model = {}
    for r in api_rows:
        ts = r.get("ts")
        if isinstance(ts, (int, float)) and not isinstance(ts, bool):
            by_model.setdefault(r["model"], []).append(r)
    out = []
    for r in records:
        if r.get("kind") != "router_request":
            out.append(r)
            continue
        label = r.get("label")
        ts = r.get("ts")
        twins = by_model.get(label) or []
        twin = None
        for a in twins:
            ats = a.get("ts")
            if not isinstance(ts, (int, float)) or not isinstance(ats, (int, float)):
                continue
            if abs(ats - ts) > ROUTER_TWIN_WINDOW_S:
                continue
            a_out, r_out = a.get("output_tokens"), r.get("output_tokens")
            if (isinstance(a_out, (int, float)) and isinstance(r_out, (int, float))
                    and a_out != r_out):
                continue
            twin = a
            break
        if twin is None:
            out.append(r)
    return out


def parse_benchmark_query(query: str, now: float = None) -> tuple:
    """Return (since, until, limit, host, usage) for benchmark APIs."""
    since, until, limit = parse_recent_query(query, now=now)
    qs = parse_qs(query, keep_blank_values=True)
    host = (qs.get("host", [""])[0] or "").strip() or None
    usage = (qs.get("usage", [""])[0] or "").strip() or None
    return since, until, limit, host, usage


def normalize(rec: dict, host: str) -> dict:
    """Flatten a raw forwarder record into the records-table row shape."""
    event = rec.get("event") or ""
    usage = rec.get("usage") or {}
    if not isinstance(usage, dict):
        usage = {}
    provider = rec.get("provider")

    if event == "post_api_request":
        kind = "moa_turn" if provider == "moa" else "api"
    elif event == "api_request_error":
        kind = "error"
    elif event == "moa_reference":
        kind = "moa_ref"
    elif event == "moa_aggregator":
        kind = "moa_agg"
    elif event == "subagent_stop":
        kind = "subagent_stop"
    elif event == "host_stats":
        kind = "host_stats"
    elif event == "pool_status":
        kind = "pool_status"
    elif event in ("router_request", "clientgate_request"):
        # The forwarder flags status >= 400 (incl. 598 stream stalls) with
        # error_type/error_message; that is a failed call, same lane as a
        # hook-emitted api_request_error — not a slow successful request.
        kind = "error" if (rec.get("error_type") or rec.get("error_message")) else event
    else:
        kind = event or "unknown"

    duration = rec.get("api_duration")
    if duration is None:
        duration = rec.get("duration_s")
    if duration is None and rec.get("duration_ms") is not None:
        try:
            duration = float(rec["duration_ms"]) / 1000.0
        except (TypeError, ValueError):
            duration = None

    tps = rec.get("tps")
    out_tok = usage.get("output_tokens")
    if tps is None and duration and out_tok:
        try:
            tps = round(float(out_tok) / float(duration), 2)
        except (TypeError, ValueError, ZeroDivisionError):
            tps = None

    error = None
    if rec.get("error_type") or rec.get("error_message"):
        error = f"{rec.get('error_type') or ''}: {rec.get('error_message') or ''}".strip(": ")

    # Provider-side generation stats, when the provider populates them
    # (LM Studio: tokens/sec, TTFT, speculative-draft counts).
    stats = rec.get("stats") or usage.get("stats")
    ttft_s = tps_native = spec_rate = None
    if isinstance(stats, dict) and stats:
        ttft_s = stats.get("time_to_first_token")
        tps_native = stats.get("tokens_per_second")
        spec_total = stats.get("total_draft_tokens_count")
        spec_ok = stats.get("accepted_draft_tokens_count")
        if spec_total and spec_ok is not None:
            try:
                spec_rate = round(float(spec_ok) / float(spec_total), 4)
            except (TypeError, ValueError, ZeroDivisionError):
                pass

    session_id = rec.get("session_id") or ""
    parent_session_id = rec.get("parent_session_id")
    if event == "subagent_stop" and rec.get("child_session_id"):
        # Attribute the stop record to the child. Hermes sends the spawning
        # session as session_id (parent_session_id is empty), so it becomes
        # the parent.
        parent_session_id = parent_session_id or session_id or None
        session_id = rec["child_session_id"]

    row = {
        "ts": rec.get("ts") or time.time(),
        "host": rec.get("host") or host,
        "event": event,
        "kind": kind,
        "session_id": session_id,
        "parent_session_id": parent_session_id,
        "session_title": rec.get("session_title"),
        "turn_id": rec.get("turn_id"),
        "api_request_id": rec.get("api_request_id"),
        "platform": rec.get("platform"),
        "model": rec.get("model"),
        "provider": provider,
        "duration_s": duration,
        "tps": tps,
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "cache_read_tokens": usage.get("cache_read_tokens"),
        "cache_write_tokens": usage.get("cache_write_tokens"),
        "reasoning_tokens": usage.get("reasoning_tokens"),
        "finish_reason": rec.get("finish_reason"),
        "error": error,
        "preset": rec.get("preset"),
        "label": rec.get("label") or rec.get("child_role"),
        "ttft_s": ttft_s,
        "tps_native": tps_native,
        "spec_accept_rate": spec_rate,
        "device": rec.get("device"),
        "cost_usd": rec.get("session_cost_usd"),
        "cpu_load": rec.get("cpu_load"),
        "mem_used_gb": rec.get("mem_used_gb"),
        "mem_total_gb": rec.get("mem_total_gb"),
        "session_source": rec.get("session_source"),
        "profile": rec.get("profile"),
        "session_started_at": rec.get("session_started_at"),
        "assistant_content_chars": rec.get("assistant_content_chars"),
        "response_model": rec.get("response_model"),
    }
    if event == "harness_sample":
        # Harness passthrough: the collector's fingerprint class and raw
        # probe fields ride the published row so the /events SSE stream
        # can carry the full sample (store.insert ignores unknown keys).
        row["fp"] = rec.get("fp")
        row["prompt_class"] = rec.get("prompt_class")
        row["config"] = rec.get("config")
        row["tokens"] = rec.get("tokens")
        row["thermal"] = rec.get("thermal")
        row["swap_mb"] = rec.get("swap_mb")
    # Idempotency key: the forwarder is at-least-once (a batch is retried
    # until the dashboard acks it), so an ack lost after a successful insert
    # would otherwise duplicate rows. Hashing the full normalized row makes
    # exact re-deliveries collapse via the UNIQUE index on dedup_key. Two
    # genuinely identical records (e.g. same-second host_stats with identical
    # values) also collapse — accepted, they carry no extra information.
    row["dedup_key"] = hashlib.sha1(
        json.dumps(row, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    return row


# ---------------------------------------------------------------------------
# Hermes outbound-webhook ingest (POST /ingest/hermes-webhook)
#
# Push-based mirror of the forwarder's requests.jsonl tail: Hermes'
# hooks.outbound POSTs one lifecycle delivery per hook firing (see
# agent/outbound_webhooks.py in the Hermes fork), signed GitHub-style with
# HMAC-SHA256 over the raw body. translate_webhook() renders the delivery
# into the exact raw-record shape hooks/metrics-emit.py writes (and the
# forwarder ships), so normalize()/Store need no webhook-specific path.
# ---------------------------------------------------------------------------

WEBHOOK_SECRET_ENV = "HERMES_OUTBOUND_WEBHOOK_SECRET"
WEBHOOK_DELIVERY_CACHE_MAX = 2000

# Keys copied out of the delivery's `extra` for LLM request/error events —
# the same list hooks/metrics-emit.py uses, so both push paths produce
# identical records.
_WEBHOOK_RECORD_KEYS = (
    "task_id", "turn_id", "api_request_id", "platform",
    "model", "provider", "base_url", "api_mode",
    "api_call_count", "api_duration", "started_at", "ended_at",
    "finish_reason", "message_count", "response_model",
    "usage", "stats", "assistant_content_chars",
    "assistant_tool_call_count", "error_type", "error_message",
)

_WEBHOOK_SUBAGENT_KEYS = (
    "child_session_id", "child_role", "child_status",
    "child_summary", "duration_ms", "parent_turn_id",
)


def _hermes_env_value(name):
    """One KEY=value from $HERMES_HOME/.env (the file Hermes itself loads).

    Lets the dashboard share the webhook secret with the Hermes processes on
    this machine without duplicating it into the launchd plist. Env vars
    still win — this only runs when ``os.environ`` lacks the name."""
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    try:
        text = Path(home, ".env").read_text()
    except OSError:
        return ""
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#") and line.startswith(name + "="):
            return line[len(name) + 1:].strip().strip('"').strip("'")
    return ""


def webhook_secret():
    """The shared HMAC secret: env var first, then ~/.hermes/.env."""
    return os.environ.get(WEBHOOK_SECRET_ENV) or _hermes_env_value(WEBHOOK_SECRET_ENV)


# ---------------------------------------------------------------------------
# Write and ingest auth
#
# Dashboard writes (env-mode, usage map, marks, beta decisions) need the admin
# token. Browsers never hold it: the metrics-dashboard Hermes plugin does, and
# Hermes' session auth guards the plugin, so writes go through Hermes Desktop.
# /ingest senders each hold their own token, bound to the host labels they may
# report as (ingest-tokens.json stores only its sha256). auth_tokens.py issues
# both.
# ---------------------------------------------------------------------------

ADMIN_TOKEN_ENV = "METRICS_ADMIN_TOKEN"
ADMIN_WRITE_PATHS = ("/api/env-mode", "/api/usage-map", "/api/beta-widgets/decision",
                     "/api/benchmark/mark", "/api/harness/mark")
WRITE_VIA_PLUGIN = ("This page is read-only. Make changes from Hermes Desktop > Metrics "
                    "(the metrics-dashboard plugin).")
INGEST_AUTH_MODE = os.environ.get("METRICS_INGEST_AUTH", "warn")  # warn | enforce
INGEST_WARN_INTERVAL_S = 3600
_ingest_warned = {}


def _metrics_home():
    return Path(os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"), "metrics")


def admin_token():
    """$METRICS_ADMIN_TOKEN, else $HERMES_HOME/metrics/admin.token. "" = writes disabled."""
    tok = os.environ.get(ADMIN_TOKEN_ENV, "").strip()
    if tok:
        return tok
    try:
        return (_metrics_home() / "admin.token").read_text().strip()
    except OSError:
        return ""


def _bearer(header):
    return header[len("Bearer "):].strip() if header and header.startswith("Bearer ") else ""


def admin_write_problem(header):
    """None when the Authorization header carries the admin token, else (code, message)."""
    expected = admin_token()
    if not expected:
        return 503, "dashboard writes are disabled: no admin token is configured. " + WRITE_VIA_PLUGIN
    if not hmac.compare_digest(_bearer(header).encode("utf-8"), expected.encode("utf-8")):
        return 401, WRITE_VIA_PLUGIN
    return None


def ingest_token_hosts(token):
    """Host labels an ingest token may report as, or None for a missing/unknown token.
    Re-read per request so issuing or revoking needs no restart."""
    if not token:
        return None
    path = Path(os.environ.get("METRICS_INGEST_TOKENS") or _metrics_home() / "ingest-tokens.json")
    try:
        entries = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
    for sender, entry in entries.items():
        if hmac.compare_digest(str(entry.get("sha256", "")), digest):
            return set(entry.get("hosts") or [sender])
    return None


def ingest_auth_problem(header, host):
    """None when the bearer token may report as ``host``, else the reason."""
    hosts = ingest_token_hosts(_bearer(header))
    if hosts is None:
        return "missing or unknown ingest token"
    if host not in hosts:
        return "ingest token may not report as %r" % host
    return None


def warn_ingest_once(host, client, problem, now=None):
    """Log an unauthenticated ingest at most hourly per (host, problem), so a
    sender posting every 2 s does not flood the log in warn mode."""
    now = time.time() if now is None else now
    key = (host, problem)
    if now - _ingest_warned.get(key, 0) < INGEST_WARN_INTERVAL_S:
        return False
    _ingest_warned[key] = now
    print("ingest auth (%s mode): host=%r from=%s: %s" % (INGEST_AUTH_MODE, host, client, problem),
          file=sys.stderr, flush=True)
    return True


def verify_webhook_signature(secret, body, header):
    """GitHub-style ``sha256=<hex>`` HMAC over the raw body, constant-time.

    With no secret configured the endpoint runs unsigned (same trust posture
    as the plain /ingest on this LAN) and every delivery verifies."""
    if not secret:
        return True
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(
        secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header[len("sha256="):])


def _parse_webhook_ts(value):
    """Epoch seconds from a webhook timestamp: number or ISO-8601 (Z or
    offset; naive treated as UTC). None when unparseable."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.timestamp()
    return None


def translate_webhook(payload):
    """One outbound-webhook delivery -> a raw record in the forwarder shape
    (what normalize() accepts), or None when there is no event name.

    Deterministic in the payload: a retried delivery (same delivery_id,
    same body) translates to the identical record, so the records-table
    dedup_key collapses it even across a dashboard restart.
    """
    if not isinstance(payload, dict):
        return None
    event = payload.get("hook_event_name") or ""
    if not event:
        return None
    extra = payload.get("extra")
    if not isinstance(extra, dict):
        extra = {}

    rec = {
        # ended_at (when the API call finished) is the most faithful record
        # time; the delivery timestamp is the fallback (subagent_stop has no
        # ended_at).
        "ts": (_parse_webhook_ts(extra.get("ended_at"))
               or _parse_webhook_ts(payload.get("timestamp"))
               or time.time()),
        "event": event,
        "session_id": payload.get("session_id") or "",
        "parent_session_id": payload.get("parent_session_id"),
        "profile": payload.get("profile"),
    }

    if event in ("post_api_request", "api_request_error"):
        for key in _WEBHOOK_RECORD_KEYS:
            if key in extra:
                rec[key] = extra[key]
        # The error hook packs {"error": {"type", "message"}} — the flat
        # error_type/error_message keys metrics-emit looks for never actually
        # arrive, so unpack here (this closes a gap in the jsonl path, whose
        # error records carry no message).
        err = extra.get("error")
        if isinstance(err, dict):
            if rec.get("error_type") is None:
                rec["error_type"] = err.get("type")
            if rec.get("error_message") is None:
                rec["error_message"] = err.get("message")
    elif event == "subagent_stop":
        for key in _WEBHOOK_SUBAGENT_KEYS:
            if key in extra:
                rec[key] = extra[key]
    else:
        rec["extra_keys"] = sorted(extra.keys())
    return rec


class DeliveryDedupe:
    """Bounded memory of recently seen webhook delivery_ids (FIFO eviction).

    Hermes retries a delivery once on connection errors/5xx; the first POST
    may have succeeded server-side, so the retry must not double-insert.
    This cache short-circuits in-memory; the deterministic translation plus
    the records-table dedup_key is the cross-restart backstop."""

    def __init__(self, max_size=WEBHOOK_DELIVERY_CACHE_MAX):
        self._max = max_size
        self._order = deque()
        self._seen = set()

    def is_dup(self, delivery_id):
        """True when this delivery_id was already recorded; record it otherwise."""
        if not delivery_id:
            return False
        if delivery_id in self._seen:
            return True
        self._seen.add(delivery_id)
        self._order.append(delivery_id)
        while len(self._order) > self._max:
            self._seen.discard(self._order.popleft())
        return False


class Store:
    def __init__(self, db_path: str):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.db_path = db_path
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)
        self._conn.executescript(hitl_events.SCHEMA)
        self._conn.executescript(host_checks.SCHEMA)
        for col, typ in MIGRATION_COLUMNS.items():
            try:
                self._conn.execute(f"ALTER TABLE records ADD COLUMN {col} {typ}")
            except sqlite3.OperationalError:
                pass  # column already exists
        self._conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_records_dedup ON records(dedup_key)"
        )
        self._conn.commit()
        self._lock = threading.Lock()
        # model id -> device from the newest pool_status per model. LM Link gives
        # each loaded instance a unique id, so the served model names one device.
        self._pool = dict(self._conn.execute(
            "SELECT model, device FROM records WHERE kind = 'pool_status' "
            "GROUP BY model HAVING ts = MAX(ts)").fetchall())

    def insert(self, rows: list) -> list:
        placeholders = ",".join("?" for _ in COLUMNS)
        sql = f"INSERT OR IGNORE INTO records ({','.join(COLUMNS)}) VALUES ({placeholders})"
        out = []
        with self._lock:
            cur = self._conn.cursor()
            for row in rows:
                if row.get("kind") == "pool_status" and row.get("model"):
                    self._pool[row["model"]] = row.get("device")
                elif row.get("response_model") and not row.get("device"):
                    # Webhook rows and routed calls arrive without a device;
                    # resolve after dedup_key so re-deliveries still collapse.
                    row["device"] = self._pool.get(row["response_model"])
                cur.execute(sql, [row.get(c) for c in COLUMNS])
                if cur.rowcount:  # 0 = duplicate dedup_key, skipped
                    row["id"] = cur.lastrowid
                    out.append(row)
            self._conn.commit()
        return out

    def prune_older_than(self, cutoff: float) -> int:
        """Delete records with ts < cutoff (epoch seconds). Returns count."""
        with self._lock:
            cur = self._conn.execute("DELETE FROM records WHERE ts < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    def prune_kind_older_than(self, kind: str, cutoff: float) -> int:
        """Delete records of one kind with ts < cutoff. Returns count."""
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM records WHERE kind = ? AND ts < ?", (kind, cutoff))
            self._conn.commit()
        return cur.rowcount

    def downsample_host_stats(self, cutoff: float, bucket_s: int = 300) -> int:
        """Keep one host_stats row per host per bucket_s window before cutoff."""
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM records WHERE kind = 'host_stats' AND ts < ? AND id NOT IN ("
                "  SELECT MIN(id) FROM records WHERE kind = 'host_stats' AND ts < ? "
                "  GROUP BY host, CAST(ts / ? AS INTEGER))",
                (cutoff, cutoff, bucket_s))
            self._conn.commit()
        return cur.rowcount

    def recent(self, since: float, until: float, limit: int, exclude_kinds: list = None) -> list:
        clauses = ["ts >= ?", "ts <= ?"]
        args: list = [since, until]
        if exclude_kinds:
            placeholders = ",".join("?" for _ in exclude_kinds)
            clauses.append(f"kind NOT IN ({placeholders})")
            args.extend(exclude_kinds)
        args.append(limit)
        with self._lock:
            cur = self._conn.execute(
                f"SELECT id, {','.join(COLUMNS)} FROM records WHERE {' AND '.join(clauses)} "
                "ORDER BY ts DESC LIMIT ?", args)
            rows = cur.fetchall()
        keys = ["id"] + COLUMNS
        return [dict(zip(keys, r)) for r in reversed(rows)]

    def moa_rows(self, since: float = None, newest_first: bool = False,
                 limit: int = None) -> list:
        """MoA reference/aggregator rows (kinds moa_ref/moa_agg) for moa_summary.

        Default order is oldest-first by (ts, id) — id order preserves the
        voice order flatten_moa_turn wrote within a run. newest_first+limit
        scans the tail for the idle-state lineup fallback.
        """
        cols = ("id", "ts", "session_id", "kind", "preset", "label", "model",
                "provider", "duration_s")
        sql = (f"SELECT {','.join(cols)} FROM records "
               "WHERE kind IN ('moa_ref', 'moa_agg')")
        args: list = []
        if since is not None:
            sql += " AND ts >= ?"
            args.append(since)
        sql += " ORDER BY ts DESC, id DESC" if newest_first else " ORDER BY ts, id"
        if limit is not None:
            sql += " LIMIT ?"
            args.append(limit)
        with self._lock:
            rows = self._conn.execute(sql, args).fetchall()
        return [dict(zip(cols, r)) for r in rows]

    def count_records(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM records").fetchone()[0]

    def oldest_ts(self):
        with self._lock:
            return self._conn.execute("SELECT MIN(ts) FROM records").fetchone()[0]

    def list_benchmark_marks(self) -> list:
        with self._lock:
            rows = self._conn.execute(
                "SELECT host, label, ts FROM benchmark_marks ORDER BY ts DESC").fetchall()
        return [{"host": h, "label": l, "ts": t} for h, l, t in rows]

    def set_benchmark_mark(self, label: str, host: str = None) -> dict:
        label = (label or "").strip()
        if not label:
            raise ValueError("label is required")
        key = (host or "").strip() or "*"
        now = time.time()
        with self._lock:
            self._conn.execute(
                "INSERT INTO benchmark_marks(host, label, ts) VALUES(?,?,?) "
                "ON CONFLICT(host) DO UPDATE SET label=excluded.label, ts=excluded.ts",
                (key, label[:80], now),
            )
            self._conn.commit()
        return {"host": key, "label": label[:80], "ts": now}

    def clear_benchmark_mark(self, host: str = None) -> None:
        key = (host or "").strip() or "*"
        with self._lock:
            self._conn.execute("DELETE FROM benchmark_marks WHERE host = ?", (key,))
            self._conn.commit()

    def insert_benchmark(self, rows: list) -> list:
        cols = benchmark.BENCHMARK_COLUMNS
        quoted = [(f'"{c}"' if c == "yield" else c) for c in cols]
        placeholders = ",".join("?" for _ in cols)
        sql = f"INSERT INTO benchmark_samples ({','.join(quoted)}) VALUES ({placeholders})"
        out = []
        with self._lock:
            cur = self._conn.cursor()
            for row in rows:
                host = row.get("host") or ""
                row = dict(row)
                if not row.get("named") and (not row.get("experiment") or row.get("experiment") == "auto"):
                    mrow = cur.execute(
                        "SELECT label FROM benchmark_marks WHERE host IN (?, ?) "
                        "ORDER BY CASE host WHEN ? THEN 0 ELSE 1 END LIMIT 1",
                        (host, "*", host),
                    ).fetchone()
                    if mrow and mrow[0]:
                        row["experiment"] = mrow[0]
                        row["named"] = 1
                cur.execute(sql, [row.get(c) for c in cols])
                row["id"] = cur.lastrowid
                out.append(row)
            self._conn.commit()
        return out

    def benchmark_samples(
        self,
        since: float,
        until: float,
        limit: int,
        host: str = None,
        usage: str = None,
    ) -> list:
        clauses = ["ts >= ?", "ts <= ?"]
        args: list = [since, until]
        if host:
            clauses.append("host = ?")
            args.append(host)
        if usage:
            clauses.append("usage = ?")
            args.append(usage)
        args.append(limit)
        cols = benchmark.BENCHMARK_COLUMNS
        quoted = [(f'"{c}"' if c == "yield" else c) for c in cols]
        with self._lock:
            cur = self._conn.execute(
                f"SELECT id, {','.join(quoted)} FROM benchmark_samples "
                f"WHERE {' AND '.join(clauses)} ORDER BY ts DESC LIMIT ?",
                args,
            )
            rows = cur.fetchall()
        keys = ["id"] + cols
        return [dict(zip(keys, r)) for r in reversed(rows)]

    def insert_hitl(self, rows: list) -> list:
        cols = hitl_events.HITL_COLUMNS
        placeholders = ",".join("?" for _ in cols)
        sql = f"INSERT INTO hitl_events ({','.join(cols)}) VALUES ({placeholders})"
        out = []
        with self._lock:
            cur = self._conn.cursor()
            for row in rows:
                cur.execute(sql, [row.get(c) for c in cols])
                row["id"] = cur.lastrowid
                row["event"] = "hitl_event"  # SSE marker for the #/events page
                out.append(row)
            self._conn.commit()
        return out

    def hitl_recent(self, since: float, until: float, limit: int) -> list:
        cols = hitl_events.HITL_COLUMNS
        with self._lock:
            cur = self._conn.execute(
                f"SELECT id, {','.join(cols)} FROM hitl_events "
                "WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?",
                (since, until, limit))
            rows = cur.fetchall()
        keys = ["id"] + cols
        return [dict(zip(keys, r)) for r in reversed(rows)]

    def prune_hitl_older_than(self, cutoff: float) -> int:
        with self._lock:
            cur = self._conn.execute("DELETE FROM hitl_events WHERE ts < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    def insert_conformance(self, rows: list) -> int:
        cols = host_checks.COLUMNS
        with self._lock:
            self._conn.executemany(
                f"INSERT INTO conformance_results ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                [[r[c] for c in cols] for r in rows])
            self._conn.commit()
        return len(rows)

    def prune_conformance_older_than(self, cutoff: float) -> int:
        with self._lock:
            cur = self._conn.execute("DELETE FROM conformance_results WHERE ts < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    def insert_health_findings(self, rows: list) -> int:
        with self._lock:
            self._conn.executemany(
                "INSERT INTO health_findings (ts, window_hours, rule, sev, text, action, beta)"
                " VALUES (?,?,?,?,?,?,?)",
                [(r["ts"], r["window_hours"], r["rule"], r["sev"], r["text"],
                  r.get("action"), 1 if r.get("beta") else 0) for r in rows])
            self._conn.commit()
        return len(rows)

    def findings_since(self, since: float) -> list:
        keys = ("ts", "window_hours", "rule", "sev", "text", "action", "beta")
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {','.join(keys)} FROM health_findings "
                "WHERE ts >= ? ORDER BY ts, id", (since,)).fetchall()
        return [dict(zip(keys, r)) for r in rows]

    def prune_findings_older_than(self, cutoff: float) -> int:
        with self._lock:
            cur = self._conn.execute("DELETE FROM health_findings WHERE ts < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    def benchmark_best(self, since: float, until: float, limit: int = 5000) -> dict:
        rows = self.benchmark_samples(since, until, limit)
        best = benchmark.best_by_usage_host(rows)
        current_map = benchmark.current_by_usage_host(rows)
        current = list(current_map.values())
        current.sort(key=lambda r: (r.get("usage") or "", r.get("host") or ""))
        return {
            "best": best,
            "current": current,
            "usage_help": benchmark.USAGE_HELP,
        }


# ---------------------------------------------------------------------------
# MoA summary (GET /api/moa/summary)
#
# Source records: the forwarder tails ~/.hermes/metrics/moa-refs.jsonl (one
# compact line per MoA turn) and flatten_moa_turn emits one moa_ref record
# per voice plus one moa_agg record per run; all records of a run share the
# run's exact (session_id, ts). Full moa-traces/*.jsonl stay audit-only.

# Tail-scan size for the idle-state lineup fallback (the most recent run on
# record, any age, supplies the dimmed voice cards and preset name).
MOA_LINEUP_SCAN_ROWS = 200


def _moa_percentile(sorted_vals, p):
    """Index-pick percentile (same convention as router_usage)."""
    if not sorted_vals:
        return None
    return sorted_vals[min(len(sorted_vals) - 1,
                           max(0, round(p / 100 * (len(sorted_vals) - 1))))]


def _moa_run_key(row):
    return (row.get("session_id") or "", row.get("ts"))


def _moa_preset(rows):
    """Most recent non-null preset, or None when the records never carried one."""
    for row in reversed(rows):
        if row.get("preset"):
            return row["preset"]
    return None


def _moa_voice_rows(rows):
    """Per-voice aggregation over moa_ref rows, keyed by voice label.

    Roles (ref-a, ref-b, ...) are positional: assigned by first-seen row id,
    which matches the voice order flatten_moa_turn wrote within a run.
    """
    voices = {}
    for row in rows:
        if row.get("kind") != "moa_ref":
            continue
        label = row.get("label") or row.get("model") or "?"
        voice = voices.get(label)
        if voice is None:
            voice = voices[label] = {
                "label": label, "calls": 0, "durs": [],
                "model": None, "provider": None, "first_id": row.get("id") or 0,
            }
        voice["calls"] += 1
        if row.get("duration_s") is not None:
            voice["durs"].append(float(row["duration_s"]))
        if row.get("model"):
            voice["model"] = row["model"]
            voice["provider"] = row.get("provider")
    out = []
    for i, label in enumerate(sorted(voices, key=lambda l: voices[l]["first_id"])):
        voice = voices[label]
        role = "ref-%s" % chr(ord("a") + i) if i < 26 else "ref-%d" % (i + 1)
        durs = voice["durs"]
        out.append({
            "role": role,
            "label": label,
            "model": voice["model"],
            "provider": voice["provider"],
            "calls": voice["calls"],
            "avg_s": round(sum(durs) / len(durs), 2) if durs else None,
        })
    return out


def _moa_aggregator_row(rows):
    """Aggregator summary over moa_agg rows (latest identity, call count).

    avg_s is usually None: the moa-refs source has no aggregator latency
    (the aggregator streams inline), so the field stays honest instead of
    fabricating one from unrelated records.
    """
    aggs = [r for r in rows if r.get("kind") == "moa_agg"]
    if not aggs:
        return None
    latest = aggs[-1]  # rows arrive (ts, id)-ordered
    durs = [float(r["duration_s"]) for r in aggs
            if r.get("duration_s") is not None]
    return {
        "label": latest.get("label"),
        "model": latest.get("model"),
        "provider": latest.get("provider"),
        "calls": len(aggs),
        "avg_s": round(sum(durs) / len(durs), 2) if durs else None,
    }


def moa_summary(store: "Store", hours: float, now: float = None) -> dict:
    """Aggregate moa_ref/moa_agg records over the trailing window.

    available=False means no runs in the window; the payload then still
    carries the voice lineup / aggregator / preset of the most recent run on
    record (any age, plus last_run_ts) so the desktop pane can render its
    dimmed idle state instead of an empty box.
    """
    now = time.time() if now is None else now
    rows = store.moa_rows(since=now - hours * 3600)
    if not rows:
        tail = store.moa_rows(newest_first=True, limit=MOA_LINEUP_SCAN_ROWS)
        lineup = []
        if tail:
            latest_key = _moa_run_key(tail[0])
            lineup = [r for r in tail if _moa_run_key(r) == latest_key]
            lineup.reverse()  # back to id order = voice order within the run
        return {
            "available": False,
            "hours": hours,
            "runs": 0,
            "voices": _moa_voice_rows(lineup),
            "aggregator": _moa_aggregator_row(lineup),
            "preset": _moa_preset(lineup),
            "last_run_ts": tail[0].get("ts") if tail else None,
        }
    runs = {}
    for row in rows:
        runs.setdefault(_moa_run_key(row), []).append(row)
    fanouts = []
    for run_rows in runs.values():
        durs = [float(r["duration_s"]) for r in run_rows
                if r.get("kind") == "moa_ref" and r.get("duration_s") is not None]
        if durs:
            # Voices fan out in parallel, so the run's fan-out duration is
            # the slowest voice, not the sum.
            fanouts.append(max(durs))
    p95 = _moa_percentile(sorted(fanouts), 95)
    voices = _moa_voice_rows(rows)
    latest_run = runs[_moa_run_key(rows[-1])]  # rows are (ts, id)-ordered
    voices_live = len({r.get("label") or r.get("model") or "?"
                       for r in latest_run if r.get("kind") == "moa_ref"})
    return {
        "available": True,
        "hours": hours,
        "runs": len(runs),
        "voices_live": voices_live,
        "voices_total": len(voices),
        "voices": voices,
        "aggregator": _moa_aggregator_row(rows),
        "p95_fanout_s": round(p95, 2) if p95 is not None else None,
        "preset": _moa_preset(rows),
        "last_run_ts": rows[-1].get("ts"),
    }


class Broadcaster:
    def __init__(self):
        self._subs = set()
        self._lock = threading.Lock()

    def subscribe(self) -> "queue.Queue | None":
        # Capped: each subscriber holds a handler thread for the connection's
        # lifetime, so an unbounded count is a thread-exhaustion vector.
        with self._lock:
            if len(self._subs) >= MAX_SSE_SUBSCRIBERS:
                return None
            q = queue.Queue(maxsize=1000)
            self._subs.add(q)
        return q

    def unsubscribe(self, q) -> None:
        with self._lock:
            self._subs.discard(q)

    def publish(self, item) -> None:
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(item)
            except queue.Full:
                pass


class Handler(BaseHTTPRequestHandler):
    store: Store = None
    bus: Broadcaster = None
    webhook_dedupe: DeliveryDedupe = None
    harness: harness_store.HarnessStore = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet access log
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _read_raw_body(self) -> bytes:
        """Read the POST body with strict transport checks.

        Requiring an explicit application/json Content-Type forces a CORS
        preflight for cross-origin browser requests — closing the drive-by
        POST vector on these unauthenticated mutating endpoints without
        adding auth. Content-Length is validated and bounded so a negative
        or huge value cannot pin a handler thread or exhaust memory.
        """
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise BodyRejected(415, "Content-Type must be application/json")
        raw = self.headers.get("Content-Length")
        try:
            length = int(raw) if raw is not None else -1
        except (TypeError, ValueError):
            length = -1
        if length < 0:
            raise BodyRejected(400, "missing or invalid Content-Length")
        if length > MAX_BODY_BYTES:
            raise BodyRejected(413, "request body too large")
        return self.rfile.read(length) or b"{}"

    def _read_json_body(self) -> dict:
        """Read and parse a JSON POST body (transport checks in _read_raw_body)."""
        try:
            return json.loads(self._read_raw_body())
        except json.JSONDecodeError as exc:
            raise BodyRejected(400, f"invalid JSON: {exc}") from None

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            page = (BASE_DIR / "static" / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(page)
        elif parsed.path.startswith("/static/"):
            self._static(parsed.path[len("/static/"):])
        elif parsed.path == "/health":
            self._json({"status": "ok"})
        elif parsed.path == "/api/about":
            try:
                size = Path(self.store.db_path).stat().st_size
            except OSError:
                size = None
            self._json({
                "revision": APP_REVISION,
                "db_bytes": size,
                "records": self.store.count_records(),
                "oldest_ts": self.store.oldest_ts(),
                "retention_days": RETENTION_DAYS,
                "heartbeat_hours": HEARTBEAT_HOURS,
            })
        elif parsed.path == "/api/usage-map":
            self._json(read_usage_map())
        elif parsed.path == "/api/session-names":
            self._json(session_names_cached())
        elif parsed.path == "/api/beta-widgets":
            self._json(read_beta_widgets())
        elif parsed.path == "/api/router-notes":
            self._json(read_router_notes())
        elif parsed.path == "/api/router-status":
            self._json(fetch_router_status())
        elif parsed.path == "/api/router-usage":
            qs = parse_qs(parsed.query)
            try:
                since_h = float((qs.get("since_h") or ["24"])[0])
            except ValueError:
                self._json({"error": "since_h must be a number"}, 400)
                return
            self._json(router_usage(min(since_h, 24 * 30)))
        elif parsed.path == "/api/benchmark/marks":
            self._json({"marks": self.store.list_benchmark_marks()})
        elif parsed.path == "/api/recent":
            try:
                since, until, limit = parse_recent_query(parsed.query)
                exclude_kinds = parse_exclude_kinds(parsed.query)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
                return
            self._json({"records": drop_router_twins(
                self.store.recent(since, until, limit, exclude_kinds))})
        elif parsed.path == "/api/moa/summary":
            qs = parse_qs(parsed.query)
            try:
                hours = float((qs.get("hours") or ["1"])[0])
            except ValueError:
                self._json({"error": "hours must be a number"}, 400)
                return
            hours = min(720.0, max(0.1, hours))
            self._json(moa_summary(self.store, hours))
        elif parsed.path == "/api/findings":
            qs = parse_qs(parsed.query)
            try:
                days = int(float((qs.get("days") or ["7"])[0]))
            except ValueError:
                self._json({"error": "days must be a number"}, 400)
                return
            days = min(30, max(1, days))
            self._json(findings_report(self.store, days))
        elif parsed.path == "/api/harness/samples":
            qs = parse_qs(parsed.query)
            try:
                hours = float((qs.get("hours") or ["24"])[0])
                limit = int(float((qs.get("limit") or ["5000"])[0]))
            except ValueError:
                self._json({"error": "hours and limit must be numbers"}, 400)
                return
            self._json({"samples": self.harness.recent(hours=hours, limit=limit)})
        elif parsed.path == "/api/harness/best":
            qs = parse_qs(parsed.query)
            try:
                n = int(float((qs.get("n") or ["10"])[0]))
            except ValueError:
                self._json({"error": "n must be a number"}, 400)
                return
            self._json({"best": self.harness.best(n=n)})
        elif parsed.path == "/api/benchmark/samples":
            try:
                since, until, limit, host, usage = parse_benchmark_query(parsed.query)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
                return
            self._json({
                "samples": self.store.benchmark_samples(since, until, limit, host=host, usage=usage),
                "usage_help": benchmark.USAGE_HELP,
            })
        elif parsed.path == "/api/benchmark/best":
            try:
                since, until, limit, _, _ = parse_benchmark_query(parsed.query)
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
                return
            self._json(self.store.benchmark_best(since, until, limit))
        elif parsed.path == "/api/env-mode":
            try:
                self._json(env_mode.status())
            except Exception as exc:
                self._json({"error": str(exc)}, 500)
        elif parsed.path == "/api/env-mode/preview":
            qs = parse_qs(parsed.query)
            mode = (qs.get("mode") or [""])[0]
            try:
                self._json(env_mode.preview(mode))
            except ValueError as exc:
                self._json({"error": str(exc)}, 400)
            except FileNotFoundError as exc:
                self._json({"error": str(exc)}, 404)
            except Exception as exc:
                self._json({"error": str(exc)}, 500)
        elif parsed.path == "/api/hitl-events":
            qs = parse_qs(parsed.query)
            try:
                since_h = min(720.0, max(0.1, float((qs.get("since_h") or ["24"])[0])))
                limit = min(5000, max(1, int((qs.get("limit") or ["1000"])[0])))
            except (TypeError, ValueError):
                self._json({"error": "invalid since_h/limit"}, 400)
                return
            now = time.time()
            self._json({"events": self.store.hitl_recent(now - since_h * 3600, now, limit)})
        elif parsed.path == "/events":
            self._sse()
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/benchmark/mark", "/api/harness/mark", "/api/env-mode", "/ingest", "/api/usage-map", "/api/beta-widgets/decision", "/ingest/hermes-webhook"):
            self._json({"error": "not found"}, 404)
            return
        try:
            if parsed.path == "/ingest/hermes-webhook":
                # Raw body: the HMAC signs the exact bytes on the wire.
                self._ingest_hermes_webhook(parsed, self._read_raw_body())
                return
            payload = self._read_json_body()
        except BodyRejected as exc:
            self._json({"ok": False, "error": str(exc)}, exc.code)
            return
        if parsed.path in ADMIN_WRITE_PATHS:
            problem = admin_write_problem(self.headers.get("Authorization"))
            if problem:
                self._json({"ok": False, "error": problem[1]}, problem[0])
                return
        if parsed.path == "/api/beta-widgets/decision":
            try:
                result = record_beta_decision(payload.get("id"), payload.get("decision"))
            except ValueError as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
                return
            self._json({"ok": True, "widgets": result.get("widgets", {})})
            return
        if parsed.path == "/api/usage-map":
            try:
                result = write_usage_map_entry(
                    payload.get("model") or payload.get("key"), payload.get("usage") or "")
                self._json({"ok": True, "map": result})
            except ValueError as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
            return
        if parsed.path == "/api/harness/mark":
            fp = payload.get("fp")
            if not fp:
                self._json({"ok": False, "error": "fp is required"}, 400)
                return
            self.harness.mark(fp, payload.get("label") or "")
            self._json({"ok": True})
            return
        if parsed.path == "/api/benchmark/mark":
            try:
                if payload.get("clear"):
                    self.store.clear_benchmark_mark(payload.get("host"))
                    self._json({"ok": True, "cleared": True})
                    return
                mark = self.store.set_benchmark_mark(payload.get("label") or "", payload.get("host"))
                self._json({"ok": True, "mark": mark})
            except ValueError as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, 500)
            return
        if parsed.path == "/api/env-mode":
            mode = payload.get("mode") or ""
            confirm = payload.get("confirm") or ""
            print(f"env-mode apply attempt mode={mode!r} from={self.client_address[0]}",
                  file=sys.stderr, flush=True)
            try:
                result = env_mode.apply_mode(mode, confirm)
                print(f"env-mode apply result mode={mode!r} ok={result.get('ok')} "
                      f"partial={result.get('partial')}", file=sys.stderr, flush=True)
                code = 200 if result.get("ok") else 500
                self._json(result, code)
            except ValueError as exc:
                self._json({"ok": False, "error": str(exc)}, 400)
            except FileNotFoundError as exc:
                self._json({"ok": False, "error": str(exc)}, 404)
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)}, 500)
            return
        # /ingest
        host = payload.get("host") or "unknown"
        problem = ingest_auth_problem(self.headers.get("Authorization"), host)
        if problem:
            warn_ingest_once(host, self.client_address[0], problem)
            if INGEST_AUTH_MODE == "enforce":
                self._json({"ok": False, "error": problem}, 401)
                return
        try:
            raw = payload.get("records") or []
            metric_rows = []
            bench_rows = []
            hitl_rows = []
            harness_rows = []
            conformance_rows = []
            for rec in raw:
                if not isinstance(rec, dict):
                    continue
                if rec.get("event") == "benchmark_sample":
                    bench_rows.append(benchmark.normalize_benchmark_sample(rec, host))
                elif rec.get("event") == "harness_sample":
                    # Degenerate placeholder (empty-stream rep): skip entirely
                    # so it reaches neither the harness store nor the generic
                    # metric store. The store rejects these too (defense in
                    # depth against old collectors).
                    if (rec.get("tokens") in (0, None) and rec.get("tps") is None
                            and rec.get("ttft_s") is None):
                        continue
                    # Dedicated store AND the records path (so the SSE
                    # stream carries the sample) — mirror benchmark's
                    # dispatch shape, plus the extra publish below.
                    harness_rows.append(harness_store.normalize_sample(rec, host))
                    metric_rows.append(normalize(rec, host))
                elif rec.get("event") == "hitl_event":
                    hitl_rows.append(hitl_events.normalize_hitl_event(rec, host))
                elif rec.get("event") == "conformance_result":
                    # verified=0 when the sender may not report as this host (warn mode)
                    conformance_rows.extend(host_checks.normalize_results(rec, host, not problem))
                else:
                    metric_rows.append(normalize(rec, host))
            inserted = self.store.insert(metric_rows) if metric_rows else []
            bench_inserted = self.store.insert_benchmark(bench_rows) if bench_rows else []
            hitl_inserted = self.store.insert_hitl(hitl_rows) if hitl_rows else []
            conformance_ingested = self.store.insert_conformance(conformance_rows) if conformance_rows else 0
            for row in harness_rows:
                try:
                    self.harness.add(row)
                except ValueError as exc:
                    # degenerate placeholder — skip the row, keep the batch
                    print("harness ingest skipped: %s" % exc, flush=True)
                    harness_rows.remove(row)
            for row in inserted:
                self.bus.publish(row)
            for row in hitl_inserted:
                self.bus.publish(row)
            self._json({
                "ok": True,
                "ingested": len(inserted),
                "benchmark_ingested": len(bench_inserted),
                "hitl_ingested": len(hitl_inserted),
                "conformance_ingested": conformance_ingested,
                "harness_ingested": len(harness_rows),
            })
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            # Client-shaped problem; the forwarder should not retry this batch.
            self._json({"ok": False, "error": str(exc)}, 400)
        except Exception as exc:
            # Server-side failure (DB, disk) — distinct from a bad payload so
            # the forwarder's indefinite retry at least means something.
            self._json({"ok": False, "error": str(exc)}, 500)

    def _ingest_hermes_webhook(self, parsed, raw_body: bytes):
        """POST /ingest/hermes-webhook — one Hermes outbound-webhook delivery.

        HMAC-verified (when the shared secret is configured), deduped on
        delivery_id, translated into the forwarder record shape, and stored
        through the same normalize()/Store path as /ingest.
        """
        if not verify_webhook_signature(
                webhook_secret(), raw_body,
                self.headers.get("X-Hermes-Signature-256") or ""):
            self._json({"ok": False, "error": "invalid signature"}, 401)
            return
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError as exc:
            self._json({"ok": False, "error": f"invalid JSON: {exc}"}, 400)
            return
        delivery_id = payload.get("delivery_id") if isinstance(payload, dict) else None
        if self.webhook_dedupe.is_dup(delivery_id):
            # Hermes retried a delivery we already stored — ack it so the
            # sender stops, but do not double-insert.
            self._json({"ok": True, "ingested": 0, "deduped": True})
            return
        rec = translate_webhook(payload)
        if rec is None:
            self._json({"ok": False, "error": "missing hook_event_name"}, 400)
            return
        qs = parse_qs(parsed.query)
        host = (qs.get("host") or [""])[0].strip() or self.client_address[0]
        try:
            row = normalize(rec, host)
            inserted = self.store.insert([row])
        except Exception as exc:
            # Server-side failure (DB, disk) — 500 so Hermes retries once.
            self._json({"ok": False, "error": str(exc)}, 500)
            return
        for r in inserted:
            self.bus.publish(r)
        self._json({"ok": True, "ingested": len(inserted)})

    def _static(self, rel: str):
        # Only allow simple filenames under static/.
        name = Path(rel).name
        if not name or "/" in rel or "\\" in rel or name != Path(rel).name:
            self._json({"error": "not found"}, 404)
            return
        path = BASE_DIR / "static" / name
        if not path.is_file():
            self._json({"error": "not found"}, 404)
            return
        data = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if name.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif name.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _sse(self):
        q = self.bus.subscribe()
        if q is None:
            self._json({"error": "too many subscribers"}, 503)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            self.wfile.write(b"retry: 3000\nevent: hello\ndata: {}\n\n")
            self.wfile.flush()
            while True:
                try:
                    item = q.get(timeout=25)
                    data = json.dumps(item, default=str)
                    self.wfile.write(f"event: rec\ndata: {data}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.bus.unsubscribe(q)


def run_health_snapshot(store: "Store", now: float = None) -> int:
    """One snapshot pass: score the trailing window of records with the
    R1-R13 rules and persist one row per finding. Returns rows inserted.

    The beta rules (R11-R13) ride the beta-widget lifecycle: each only runs
    while its widget hasn't been deleted on the dashboard (same state
    /api/beta-widgets serves)."""
    now = time.time() if now is None else now
    records = store.recent(now - HEALTH_SNAPSHOT_WINDOW_H * 3600, now, MAX_RECENT_LIMIT)
    widgets = read_beta_widgets()["widgets"]
    widget = widgets.get("agent-loop-detector") or {}
    findings = health_rules.compute_findings(
        records, now, HEALTH_SNAPSHOT_WINDOW_H,
        beta_enabled=widget.get("status") != "deleted",
        beta_widgets=widgets)
    rows = [dict(f, ts=now, window_hours=HEALTH_SNAPSHOT_WINDOW_H) for f in findings]
    return store.insert_health_findings(rows)


def health_snapshot_loop(store: "Store") -> None:
    """30-min health-rule snapshotter (daemon thread), same in-process
    scheduling pattern as retention_loop."""
    while True:
        try:
            run_health_snapshot(store)
        except Exception as exc:
            print(f"health snapshots: pass failed: {exc}", file=sys.stderr, flush=True)
        time.sleep(HEALTH_SNAPSHOT_INTERVAL_S)


def findings_report(store: "Store", days: int, now: float = None) -> dict:
    """Aggregate health_findings for GET /api/findings over the last `days`
    local calendar days (today included), so `daily` buckets line up with
    calendar days oldest -> newest."""
    now = time.time() if now is None else now
    start_date = datetime.date.fromtimestamp(now) - datetime.timedelta(days=days - 1)
    since = time.mktime(start_date.timetuple())
    rows = store.findings_since(since)
    by_rule = {}
    for row in rows:
        entry = by_rule.setdefault(row["rule"], {
            "rule": row["rule"],
            "label": health_rules.RULE_LABELS.get(row["rule"], row["rule"]),
            "count": 0, "worst_sev": "ok", "days_fired": 0,
            "last_ts": None, "example_text": None, "example_action": None,
            "daily": [0] * days, "_days": set(),
        })
        entry["count"] += 1
        if health_rules.SEV_ORDER.get(row["sev"], 3) < health_rules.SEV_ORDER[entry["worst_sev"]]:
            entry["worst_sev"] = row["sev"]
        # rows arrive ts-ordered, so the last write is the most recent example
        entry["last_ts"] = row["ts"]
        entry["example_text"] = row["text"]
        entry["example_action"] = row["action"]
        idx = (datetime.date.fromtimestamp(row["ts"]) - start_date).days
        if 0 <= idx < days:
            entry["daily"][idx] += 1
            entry["_days"].add(idx)
    rules = []
    for entry in by_rule.values():
        entry["days_fired"] = len(entry.pop("_days"))
        rules.append(entry)
    rules.sort(key=lambda e: (-e["count"], e["rule"]))
    return {"days": days, "since": since, "total": len(rows), "rules": rules}


def retention_loop(store: "Store", days: float) -> None:
    """Hourly prune (daemon thread). Records go at `days`; pool_status
    heartbeats go much sooner (75% of volume, near-zero historical value) and
    host_stats is downsampled to one row per host per 5 minutes beyond
    HEARTBEAT_HOURS. benchmark_samples are forever-retained by design."""
    while True:
        now = time.time()
        try:
            deleted = store.prune_older_than(now - days * 86400)
            hitl_deleted = store.prune_hitl_older_than(now - days * 86400)
            findings_deleted = store.prune_findings_older_than(now - days * 86400)
            conformance_deleted = store.prune_conformance_older_than(
                now - host_checks.RETENTION_DAYS * 86400)
            pool_deleted = store.prune_kind_older_than(
                "pool_status", now - HEARTBEAT_HOURS * 3600)
            stats_deleted = store.downsample_host_stats(now - HEARTBEAT_HOURS * 3600)
            for label, count in (("records", deleted), ("pool_status", pool_deleted),
                                 ("host_stats", stats_deleted), ("hitl_events", hitl_deleted),
                                 ("health_findings", findings_deleted),
                                 ("conformance_results", conformance_deleted)):
                if count:
                    print(f"retention: pruned {count} {label}",
                          file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"retention: prune failed: {exc}", file=sys.stderr, flush=True)
        time.sleep(3600)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=int(os.environ.get("METRICS_PORT", "8899")))
    ap.add_argument("--bind", default=os.environ.get("METRICS_BIND", "127.0.0.1"),
                    help="comma-separated addresses; the first must bind, later ones "
                         "(e.g. the Tailscale address, up after boot) are retried")
    ap.add_argument("--db", default=os.environ.get("METRICS_DB", DEFAULT_DB))
    args = ap.parse_args()

    Handler.store = Store(args.db)
    Handler.harness = harness_store.HarnessStore(args.db)
    Handler.bus = Broadcaster()
    Handler.webhook_dedupe = DeliveryDedupe()
    if not webhook_secret():
        print("warning: %s not set (env or ~/.hermes/.env) — "
              "/ingest/hermes-webhook accepts UNSIGNED deliveries"
              % WEBHOOK_SECRET_ENV, file=sys.stderr, flush=True)
    global APP_REVISION
    APP_REVISION = _git_revision()
    if RETENTION_DAYS > 0:
        threading.Thread(
            target=retention_loop, args=(Handler.store, RETENTION_DAYS), daemon=True
        ).start()
    if HEALTH_SNAPSHOTS_ENABLED:
        threading.Thread(
            target=health_snapshot_loop, args=(Handler.store,), daemon=True
        ).start()
    if not admin_token():
        print("warning: no admin token (METRICS_ADMIN_TOKEN or ~/.hermes/metrics/admin.token) "
              "— dashboard writes are disabled; run auth_tokens.py admin-init",
              file=sys.stderr, flush=True)
    print(f"ingest auth mode: {INGEST_AUTH_MODE}", flush=True)
    addresses = [a.strip() for a in args.bind.split(",") if a.strip()]
    server = _serve(addresses[0], args.port)  # the first address must bind
    for addr in addresses[1:]:
        threading.Thread(target=_serve_when_up, args=(addr, args.port), daemon=True).start()
    print(f"hermes-metrics-dash db={args.db}", flush=True)
    server.serve_forever()


def _serve(addr, port):
    server = ThreadingHTTPServer((addr, port), Handler)
    server.daemon_threads = True
    print(f"hermes-metrics-dash listening on {addr}:{port}", flush=True)
    return server


def _serve_when_up(addr, port):
    """Bind an address that may not exist yet (Tailscale comes up after launchd
    starts us), retrying every 30 s, then serve on it."""
    while True:
        try:
            server = _serve(addr, port)
            break
        except OSError as exc:
            print(f"bind {addr}:{port} failed ({exc}); retrying in 30s", file=sys.stderr, flush=True)
            time.sleep(30)
    server.serve_forever()


if __name__ == "__main__":
    main()
