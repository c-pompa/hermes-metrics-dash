#!/usr/bin/env python3
"""Hermes metrics forwarder — tails local metric sources and ships them to the
metrics dashboard.

Sources (all best-effort; a missing file is simply skipped):
  ~/.hermes/metrics/requests.jsonl   written by the metrics-emit.py shell hook
                                     (post_api_request / api_request_error /
                                     subagent_stop events)
  ~/.hermes/metrics/moa-refs.jsonl   compact proposer/aggregator metrics
                                     written every MoA turn by the Hermes fork,
                                     independent of moa.save_traces

Full ~/.hermes/moa-traces/*.jsonl files are audit-only and not tailed, avoiding
double-counting and keeping message content out of the metrics pipeline.

Each record is enriched with this machine's host label and, when available,
the session's title + parent_session_id from ~/.hermes/state.db (read-only).
Byte offsets are persisted so restarts neither drop nor duplicate records.

Stdlib only. Run via launchd; see launchd/ plists.
"""
import contextlib
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.request
from collections import deque
from pathlib import Path

import benchmark

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
REQUESTS_FILE = HERMES_HOME / "metrics" / "requests.jsonl"
MOA_REFS_FILE = HERMES_HOME / "metrics" / "moa-refs.jsonl"
STATE_FILE = HERMES_HOME / "metrics" / ".forwarder-state.json"
STATE_DB = HERMES_HOME / "state.db"
USAGE_MAP_FILE = HERMES_HOME / "metrics" / "usage-map.json"
EXPERIMENT_FILE = HERMES_HOME / "metrics" / "active-experiment"
CONFIG_FILE = HERMES_HOME / "config.yaml"

DASH_URL = os.environ.get("METRICS_DASH_URL", "http://127.0.0.1:8899").rstrip("/")
HOST_LABEL = os.environ.get("METRICS_HOST_LABEL", socket.gethostname().split(".")[0])
POLL_SECONDS = float(os.environ.get("METRICS_POLL_SECONDS", "2"))
BATCH_MAX = 500
# Cap on the retry backlog: while the dashboard is down, collected records and
# periodic samples accumulate in `pending`; bound it (see trim_pending).
PENDING_MAX = 5000
HOST_STATS_SECONDS = float(os.environ.get("METRICS_HOST_STATS_SECONDS", "30"))
BENCHMARK_SECONDS = float(os.environ.get("METRICS_BENCHMARK_SECONDS", str(HOST_STATS_SECONDS)))
LMS_BIN = os.path.expanduser(os.environ.get("LMS_BIN", "~/.lmstudio/bin/lms"))


def sample_host_stats() -> dict:
    """CPU load + memory usage for this machine (macOS / Windows, stdlib only)."""
    rec = {"event": "host_stats", "ts": time.time()}
    try:
        rec["cpu_load"] = round(os.getloadavg()[0], 2)
    except (OSError, AttributeError):
        # Windows has no getloadavg — approximate from Win32_Processor LoadPercentage.
        try:
            out = subprocess.check_output(
                [
                    "powershell", "-NoProfile", "-Command",
                    "(Get-CimInstance Win32_Processor |"
                    " Measure-Object -Property LoadPercentage -Average).Average",
                ],
                timeout=8,
            ).decode().strip()
            pct = float(out)
            cores = os.cpu_count() or 1
            rec["cpu_load"] = round((pct / 100.0) * cores, 2)
        except Exception:
            pass
    try:
        total = int(subprocess.check_output(["sysctl", "-n", "hw.memsize"], timeout=5))
        vm = subprocess.check_output(["vm_stat"], timeout=5).decode()
        m = re.search(r"page size of (\d+)", vm)
        page = int(m.group(1)) if m else 16384
        pages = {}
        for line in vm.splitlines():
            mm = re.match(r"(Pages [a-z ]+?|Anonymous pages|File-backed pages):\s+(\d+)\.", line.strip())
            if mm:
                pages[mm.group(1)] = int(mm.group(2))
        used = (pages.get("Pages active", 0) + pages.get("Pages wired down", 0)
                + pages.get("Pages occupied by compressor", 0)) * page
        rec["mem_used_gb"] = round(used / 2**30, 2)
        rec["mem_total_gb"] = round(total / 2**30, 2)
    except Exception:
        try:
            out = subprocess.check_output(
                [
                    "powershell", "-NoProfile", "-Command",
                    "$o=Get-CimInstance Win32_OperatingSystem;"
                    "[math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1MB,2);"
                    "[math]::Round($o.TotalVisibleMemorySize/1MB,2)",
                ],
                timeout=8,
            ).decode().strip().splitlines()
            if len(out) >= 2:
                rec["mem_used_gb"] = float(out[0])
                rec["mem_total_gb"] = float(out[1])
        except Exception:
            pass
    return rec


def sample_power_w():
    """Best-effort GPU package power in watts (NVIDIA). Returns None if unavailable."""
    try:
        out = subprocess.check_output(
            [
                "nvidia-smi",
                "--query-gpu=power.draw",
                "--format=csv,noheader,nounits",
            ],
            timeout=5,
        ).decode().strip()
        if not out:
            return None
        vals = []
        for line in out.splitlines():
            try:
                vals.append(float(line.strip()))
            except ValueError:
                pass
        if not vals:
            return None
        return round(sum(vals), 1)
    except Exception:
        return None


_ROLLING = None  # lazily-initialized {"offset": int, "samples": deque}


def _rolling_model_stats(window_s: float = 900.0) -> dict:
    """model -> {tps, p50_s} from recent local requests.jsonl (best-effort).

    Incremental: keeps its own byte offset into requests.jsonl and parses only
    new lines per tick, instead of re-reading the trailing 2 MB every 30 s.
    """
    global _ROLLING
    try:
        if not REQUESTS_FILE.exists():
            return {}
        if _ROLLING is None:
            _ROLLING = {"offset": None, "samples": deque()}
        state = _ROLLING
        size = REQUESTS_FILE.stat().st_size
        if state["offset"] is None:
            # First call: seed from the trailing 2 MB only (as before).
            state["offset"] = max(0, size - 2_000_000)
        elif size < state["offset"]:  # rotated/truncated
            state["offset"] = 0
            state["samples"].clear()
        if size > state["offset"]:
            with REQUESTS_FILE.open("rb") as f:
                f.seek(state["offset"])
                chunk = f.read(size - state["offset"])
            # Consume complete lines only; a trailing partial line (or the
            # partial first line after a mid-file seed) is left/skipped.
            nl = chunk.rfind(b"\n")
            if nl != -1:
                for rawline in chunk[:nl].split(b"\n"):
                    rawline = rawline.strip()
                    if not rawline:
                        continue
                    try:
                        rec = json.loads(rawline.decode("utf-8", errors="replace"))
                    except json.JSONDecodeError:
                        continue
                    ts = rec.get("ts") or 0
                    model = rec.get("model")
                    if not model:
                        continue
                    usage = rec.get("usage") or {}
                    duration = rec.get("api_duration")
                    if duration is None and rec.get("duration_ms") is not None:
                        try:
                            duration = float(rec["duration_ms"]) / 1000.0
                        except (TypeError, ValueError):
                            duration = None
                    out_tok = usage.get("output_tokens") if isinstance(usage, dict) else None
                    tps = rec.get("tps")
                    if tps is None and duration and out_tok:
                        try:
                            tps = float(out_tok) / float(duration)
                        except (TypeError, ValueError, ZeroDivisionError):
                            tps = None
                    state["samples"].append((ts, model, tps, duration))
                state["offset"] += nl + 1
        cutoff = time.time() - window_s
        samples = state["samples"]
        while samples and samples[0][0] < cutoff:
            samples.popleft()
        by_model = {}
        for ts, model, tps, duration in samples:
            bucket = by_model.setdefault(model, {"tps": [], "dur": []})
            if tps:
                bucket["tps"].append(float(tps))
            if duration:
                bucket["dur"].append(float(duration))
    except Exception:
        return {}
    out = {}
    for model, bucket in by_model.items():
        tps_vals = sorted(bucket["tps"])
        dur_vals = sorted(bucket["dur"])
        stats = {}
        if tps_vals:
            stats["tps"] = round(sum(tps_vals) / len(tps_vals), 2)
        if dur_vals:
            stats["p50_s"] = round(dur_vals[len(dur_vals) // 2], 2)
        if stats:
            out[model] = stats
    return out


def _link_device_names() -> tuple:
    """Return (local_name, {deviceIdentifier: deviceName}) from lms link status."""
    names, local_name = {}, HOST_LABEL
    try:
        link = json.loads(subprocess.check_output(
            [LMS_BIN, "link", "status", "--json"], timeout=10, stderr=subprocess.DEVNULL))
        for p in link.get("peers") or []:
            if p.get("deviceIdentifier"):
                names[p["deviceIdentifier"]] = p.get("deviceName") or p["deviceIdentifier"]
        local_name = link.get("deviceName") or HOST_LABEL
    except Exception:
        pass
    return local_name, names


# LM Link device-name substring -> metrics host label, first match wins.
# METRICS_LINK_LABELS overrides, e.g. "studio=studio,mini=mini,mbp=mbp".
LINK_LABELS = [pair.split("=", 1) for pair in os.environ.get(
    "METRICS_LINK_LABELS", "mini=mini,mbp=mbp,macbook=mbp").split(",") if "=" in pair]


def short_host_label(name: str) -> str:
    """Normalize LM Link device names to metrics host labels (LINK_LABELS)."""
    n = (name or "").strip()
    low = n.lower()
    for sub, label in LINK_LABELS:
        if sub.strip().lower() in low:
            return label.strip()
    return n or HOST_LABEL


def sample_benchmark_records() -> list:
    """Lean benchmark_sample per loaded LMS model across the LM Link pool.

    Local models get this machine's CPU/mem/power + Hermes knobs.
    Remote peers (e.g. WinPC seen from Mini/MBP) are included with host set to
    the serving device name so the Benchmark page covers all machines even when
    a peer has no metrics forwarder installed.
    """
    host_stats = sample_host_stats()
    power_w = sample_power_w()
    hermes_knobs = benchmark.read_hermes_knobs(CONFIG_FILE)
    experiment = benchmark.read_active_experiment(EXPERIMENT_FILE)
    usage_map = benchmark.load_usage_map(USAGE_MAP_FILE)
    rolling = _rolling_model_stats()
    local_name, peer_names = _link_device_names()
    try:
        loaded = json.loads(subprocess.check_output([LMS_BIN, "ps", "--json"], timeout=10, stderr=subprocess.DEVNULL))
    except Exception:
        return []
    if not isinstance(loaded, list):
        return []
    now = time.time()
    out = []
    seen = set()
    for entry in loaded:
        if not isinstance(entry, dict):
            continue
        model = entry.get("identifier") or entry.get("modelKey") or ""
        if not model:
            continue
        dev = entry.get("deviceIdentifier")
        if dev:
            serving = short_host_label(peer_names.get(dev, dev))
            is_local = False
        else:
            # Prefer METRICS_HOST_LABEL, still normalize hostname fallbacks.
            serving = short_host_label(HOST_LABEL or local_name)
            is_local = True
        key = (serving, model)
        if key in seen:
            continue
        seen.add(key)
        parallel = entry.get("parallel")
        try:
            parallel = int(parallel) if parallel is not None else 1
        except (TypeError, ValueError):
            parallel = 1
        model_gb = benchmark.model_gb_from_bytes(entry.get("sizeBytes"))
        ctx_k = benchmark.ctx_k_from_tokens(entry.get("contextLength") or entry.get("maxContextLength"))
        roll = rolling.get(model) or {} if is_local else {}
        rec = {
            "event": "benchmark_sample",
            "ts": now,
            "host": serving,
            "usage": benchmark.infer_usage(model, serving, usage_map),
            "model": model,
            "ctx_k": ctx_k,
            "parallel": parallel,
            "ttl": benchmark.ttl_label(entry.get("ttlMs")),
            "offload": entry.get("format") or "",
            "hermes_knobs": hermes_knobs if is_local else "",
            "tps": roll.get("tps"),
            "p50_s": roll.get("p50_s"),
            "vram_gb": None,
            "model_gb": model_gb,
            "cpu_load": host_stats.get("cpu_load") if is_local else None,
            "mem_used_gb": host_stats.get("mem_used_gb") if is_local else None,
            "mem_total_gb": host_stats.get("mem_total_gb") if is_local else None,
            "power_w": power_w if is_local else None,
            "experiment": experiment or "auto",
            "named": bool(experiment),
        }
        rec["yield"] = benchmark.compute_yield(
            rec["tps"], vram_gb=None, model_gb=model_gb, parallel=parallel
        )
        out.append(rec)
    return out


class DeviceMap:
    """model id -> serving device, polled from `lms ps --json`.

    LM Link routes a model id to whichever peer hosts it, so the machine that
    *made* the request (our host label) is not the machine that *served* it.
    A null deviceIdentifier means the model runs on this machine's LM Studio.
    """

    def __init__(self):
        self._map = {}
        self._polled = 0.0
        # Last good id -> name map. `lms link status` fails now and then while `lms ps`
        # still answers; starting from empty then recorded raw device ids and the host label.
        self._names, self._local_name = {}, HOST_LABEL

    def snapshot(self) -> dict:
        """Refresh (if stale) and return the model -> device map."""
        self.get("")
        return dict(self._map)

    def get(self, model: str):
        now = time.time()
        if now - self._polled > HOST_STATS_SECONDS:
            self._polled = now
            try:
                # id -> friendly name (`lms link status` knows every peer)
                try:
                    link = json.loads(subprocess.check_output(
                        [LMS_BIN, "link", "status", "--json"], timeout=10, stderr=subprocess.DEVNULL))
                    for p in link.get("peers") or []:
                        if p.get("deviceIdentifier"):
                            self._names[p["deviceIdentifier"]] = p.get("deviceName") or p["deviceIdentifier"]
                    self._local_name = link.get("deviceName") or self._local_name
                except Exception:
                    pass
                names, local_name = self._names, self._local_name
                out = subprocess.check_output([LMS_BIN, "ps", "--json"], timeout=10, stderr=subprocess.DEVNULL)
                self._map = {}
                for e in json.loads(out):
                    if not e.get("identifier"):
                        continue
                    dev = e.get("deviceIdentifier")
                    self._map[e["identifier"]] = names.get(dev, dev) if dev else local_name
            except Exception:
                pass  # keep last good map
        return self._map.get(model)


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(STATE_FILE)


class SessionInfo:
    """Best-effort session title / parent / cost lookup from state.db (read-only)."""

    def __init__(self):
        self._cache = {}

    def lookup(self, session_id: str) -> dict:
        if not session_id:
            return {}
        cached = self._cache.get(session_id)
        info = dict(cached) if cached else {}
        try:
            uri = f"file:{STATE_DB}?mode=ro"
            # `with` on sqlite3 is only a transaction context — closing keeps
            # the connection from leaking until refcount GC.
            with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=1.5)) as conn:
                if not cached:
                    row = conn.execute(
                        "SELECT title, parent_session_id FROM sessions WHERE id = ?",
                        (session_id,),
                    ).fetchone()
                    if row:
                        info = {"session_title": row[0], "parent_session_id": row[1]}
                        self._cache[session_id] = dict(info)
                # Cost is cumulative and changes every turn — always fresh.
                crow = conn.execute(
                    "SELECT estimated_cost_usd FROM sessions WHERE id = ?",
                    (session_id,),
                ).fetchone()
                if crow and crow[0] is not None:
                    info["session_cost_usd"] = crow[0]
        except Exception:
            pass
        return info


def read_new_lines(path: Path, state: dict) -> list:
    """Return new complete lines from *path* since the stored offset."""
    key = str(path)
    try:
        size = path.stat().st_size
    except OSError:
        return []
    offset = state.get(key, 0)
    if size < offset:  # rotated/truncated
        offset = 0
    if size == offset:
        return []
    with path.open("rb") as f:
        f.seek(offset)
        chunk = f.read(size - offset)
    # Only consume up to (and including) the last complete line; a trailing
    # partial line stays unconsumed for the next poll.
    nl = chunk.rfind(b"\n")
    if nl == -1:
        return []
    lines = []
    for rawline in chunk[:nl].split(b"\n"):
        if not rawline.strip():
            continue
        try:
            lines.append(json.loads(rawline.decode("utf-8")))
        except Exception:
            continue  # corrupt line; skip (offset still advances past it)
    state[key] = offset + nl + 1
    return lines


def flatten_moa_turn(rec: dict) -> list:
    """One moa-trace turn record -> per-reference + aggregator metric records.

    Deliberately drops input_messages / output text — metrics only.
    """
    out = []
    base = {"ts": rec.get("ts"), "session_id": rec.get("session_id"),
            "preset": rec.get("preset")}
    for ref in rec.get("references") or []:
        out.append({
            **base,
            "event": "moa_reference",
            "label": ref.get("label"),
            "model": ref.get("model"),
            "provider": ref.get("provider"),
            "duration_s": ref.get("duration_s"),
            "usage": ref.get("usage") or {},
            "stats": ref.get("stats"),
        })
    agg = rec.get("aggregator") or {}
    if agg.get("model"):
        out.append({
            **base,
            "event": "moa_aggregator",
            "label": agg.get("label"),
            "model": agg.get("model"),
            "provider": agg.get("provider"),
        })
    return out


def collect(state: dict, sessions: SessionInfo, devices: DeviceMap) -> list:
    records = []
    for rec in read_new_lines(REQUESTS_FILE, state):
        rec.update(sessions.lookup(rec.get("session_id") or ""))
        records.append(rec)
    # Metrics-lite MoA records: written by the fork on EVERY MoA turn,
    # independent of moa.save_traces (preset editors kept rewriting the moa:
    # config block and dropping that flag, which silently killed the old
    # trace-dir source). Full traces in moa-traces/ are audit-only now — the
    # forwarder no longer tails them, to avoid double-counting turns that
    # land in both files.
    for turn in read_new_lines(MOA_REFS_FILE, state):
        for rec in flatten_moa_turn(turn):
            rec.update(sessions.lookup(rec.get("session_id") or ""))
            records.append(rec)
    for rec in records:
        model = rec.get("model")
        if model and "device" not in rec:
            dev = devices.get(model)
            if dev:
                rec["device"] = dev
    return records


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


def trim_pending(pending: list) -> list:
    """Bound the retry backlog during a dashboard outage.

    Periodic samples (host_stats / pool_status / benchmark_sample) go stale
    anyway, so they are shed oldest-first before any request/error records.
    Dropped records are lost for good once offsets commit — logged on stderr.
    """
    if len(pending) <= PENDING_MAX:
        return pending
    overflow = len(pending) - PENDING_MAX
    periodic = {"host_stats", "pool_status", "benchmark_sample"}
    out = []
    dropped = 0
    for rec in pending:
        if dropped < overflow and rec.get("event") in periodic:
            dropped += 1
            continue
        out.append(rec)
    if len(out) > PENDING_MAX:
        extra = len(out) - PENDING_MAX
        out = out[extra:]
        dropped += extra
    print(f"dashboard unreachable: dropped {dropped} oldest queued records "
          f"(backlog over {PENDING_MAX})", file=sys.stderr, flush=True)
    return out


def main() -> None:
    sessions = SessionInfo()
    devices = DeviceMap()
    pending: list = []
    pending_state: dict = None
    committed = load_state()
    last_host_stats = 0.0
    last_benchmark = 0.0
    print(f"forwarder up host={HOST_LABEL} -> {DASH_URL}", flush=True)
    while True:
        if not pending:
            trial_state = dict(committed)
            pending = collect(trial_state, sessions, devices)
            pending_state = trial_state
        now = time.time()
        if now - last_host_stats >= HOST_STATS_SECONDS:
            last_host_stats = now
            pending.append(sample_host_stats())
            # Live pool snapshot: which models are loaded, and where. Lets the
            # dashboard distinguish "loaded right now" from historical records.
            for model, dev in devices.snapshot().items():
                pending.append({"event": "pool_status", "ts": time.time(),
                                "model": model, "device": dev})
        if now - last_benchmark >= BENCHMARK_SECONDS:
            last_benchmark = now
            pending.extend(sample_benchmark_records())
        if pending:
            pending = trim_pending(pending)
            batch = pending[:BATCH_MAX]
            if ship(batch):
                pending = pending[BATCH_MAX:]
                if not pending:
                    committed = pending_state
                    save_state(committed)
            # on failure: retry same batch next tick, offsets uncommitted
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
