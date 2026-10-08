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
  ~/.hermes/logs/agent.log           tool-guardrail events only: lines matching
                                     "Turn ended: reason=guardrail_halt" and
                                     tool errors carrying a guardrail block are
                                     parsed into guardrail_halt / guardrail_block
                                     records (first sight seeds at EOF — history
                                     is not backfilled)
  ~/.hermes/logs/model-router-requests.jsonl
                                     hermes-model-router exec log (one JSONL
                                     line per routed request: role, resolved
                                     model, status, duration_s, OpenAI-style
                                     token usage) -> router_request records.
                                     Rotates at 50 MB (.1/.2/.3 backups) —
                                     shrink resets the offset like any tail.
                                     First sight seeds at EOF: backfilling a
                                     possibly-50MB history would flood the
                                     pending backlog and get shed by
                                     trim_pending anyway.
  ~/.hermes/clientgate/clientgate-usage.jsonl
                                     clientgate per-client usage attribution
                                     (client key name, role, path, model,
                                     status, duration_ms, prompt/completion/
                                     total tokens) -> clientgate_request
                                     records, labelled with the client name.
                                     First sight seeds at EOF, as above.

Both router files close the audit gap from the model-router security review:
clients hitting the router daemon or the clientgate proxy directly never fire
the Hermes metrics hook, so they never reach requests.jsonl.

Full ~/.hermes/moa-traces/*.jsonl files are audit-only and not tailed, avoiding
double-counting and keeping message content out of the metrics pipeline.

Each record is enriched with this machine's host label and, when available,
the session's title + parent_session_id from ~/.hermes/state.db (read-only).
Byte offsets are persisted so restarts neither drop nor duplicate records.

Stdlib only. Run via launchd; see launchd/ plists.
"""
import contextlib
import datetime
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
import host_checks

HERMES_HOME = Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser()
REQUESTS_FILE = HERMES_HOME / "metrics" / "requests.jsonl"
MOA_REFS_FILE = HERMES_HOME / "metrics" / "moa-refs.jsonl"
AGENT_LOG_FILE = HERMES_HOME / "logs" / "agent.log"
ROUTER_REQUESTS_FILE = HERMES_HOME / "logs" / "model-router-requests.jsonl"
# install-clientgate.sh (hermes-model-router) absolutizes usage_log into ~/.hermes/logs
CLIENTGATE_USAGE_FILE = HERMES_HOME / "logs" / "clientgate-usage.jsonl"
STATE_FILE = HERMES_HOME / "metrics" / ".forwarder-state.json"
STATE_DB = HERMES_HOME / "state.db"
USAGE_MAP_FILE = HERMES_HOME / "metrics" / "usage-map.json"
EXPERIMENT_FILE = HERMES_HOME / "metrics" / "active-experiment"
CONFIG_FILE = HERMES_HOME / "config.yaml"

# Dashboard URL — override via METRICS_DASH_URL env (set it on every host
# that is not the dashboard host).
DASH_URL = os.environ.get("METRICS_DASH_URL", "http://127.0.0.1:8899").rstrip("/")
HOST_LABEL = os.environ.get("METRICS_HOST_LABEL", socket.gethostname().split(".")[0])
POLL_SECONDS = float(os.environ.get("METRICS_POLL_SECONDS", "2"))
BATCH_MAX = 500
# Cap on the retry backlog: while the dashboard is down, collected records and
# periodic samples accumulate in `pending`; bound it (see trim_pending).
PENDING_MAX = 5000
HOST_STATS_SECONDS = float(os.environ.get("METRICS_HOST_STATS_SECONDS", "30"))
BENCHMARK_SECONDS = float(os.environ.get("METRICS_BENCHMARK_SECONDS", str(HOST_STATS_SECONDS)))
# hermes-desktop-iac's conformance.yaml in a local checkout; unset = no host checks.
CONFORMANCE_STANDARD = os.environ.get("CONFORMANCE_STANDARD", "")
LMS_BIN = os.path.expanduser(os.environ.get("LMS_BIN", "~/.lmstudio/bin/lms"))
# Bot states are sent on change, and again this often so a reader can tell
# the state at any time from the records of the hour before it.
GATEWAY_RESEND_SECONDS = 3600


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


def sample_gateway_status(last: dict) -> list:
    """Chat-bot (gateway platform) connection changes, as gateway_status records.

    `last` maps "profile:platform" to (state, error, sent_at) and is updated in
    place. A gateway file outlives its process, so only running gateways with a
    live pid count; a bot that disappears from them is sent once as stopped. A
    platform last written by an earlier gateway process is stale.
    """
    now = time.time()
    current = {}
    for f in [HERMES_HOME / "gateway_state.json", *sorted(HERMES_HOME.glob("profiles/*/gateway_state.json"))]:
        try:
            st = json.loads(f.read_text())
            pid = int(st.get("pid") or 0)
            if st.get("gateway_state") != "running" or pid <= 0:
                continue
            os.kill(pid, 0)
        except (OSError, ValueError, TypeError, AttributeError):
            continue
        owner = "default" if f.parent == HERMES_HOME else f.parent.name
        for key, p in (st.get("platforms") or {}).items():
            if not isinstance(p, dict):
                continue
            profile, _, name = key.rpartition(":")
            state = "stale" if p.get("writer_pid") not in (None, pid) else p.get("state") or "unknown"
            error = (p.get("error_message") or "").split("\n")[0][:200] or None
            current[f"{profile or owner}:{name}"] = (state, error)
    for key in last:
        if key not in current and last[key][0] != "stopped":
            current[key] = ("stopped", None)
    out = []
    for key, (state, error) in current.items():
        prev = last.get(key)
        if prev and prev[:2] == (state, error) and now - prev[2] < GATEWAY_RESEND_SECONDS:
            continue
        last[key] = (state, error, now)
        out.append({"event": "gateway_status", "ts": now, "platform": key,
                    "label": state, "error_message": error})
    return out


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


_USAGE_MAP_REMOTE = {"ts": 0.0, "map": {}}


def fetch_usage_map() -> dict:
    """Dashboard-managed usage map, refreshed hourly; falls back to the local
    file when the dashboard is unreachable. Lets operators classify new models
    from the UI (set usage) instead of editing files per host."""
    now = time.time()
    if now - _USAGE_MAP_REMOTE["ts"] > 3600:
        try:
            with urllib.request.urlopen(DASH_URL + "/api/usage-map", timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if isinstance(data, dict):
                    _USAGE_MAP_REMOTE["ts"] = now
                    _USAGE_MAP_REMOTE["map"] = {str(k): str(v) for k, v in data.items()}
        except Exception:
            _USAGE_MAP_REMOTE["ts"] = now  # don't hammer a down dashboard
    local = benchmark.load_usage_map(USAGE_MAP_FILE)
    local.update(_USAGE_MAP_REMOTE["map"])  # dashboard map wins
    return local


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
    usage_map = fetch_usage_map()
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
    """Best-effort session identity / parent / cost lookup from state.db
    (read-only). Titles are NULL for most TUI/CLI sessions, so source and
    started_at are fetched too — the dashboard labels conversations from
    whatever exists."""

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
                        "SELECT title, parent_session_id, source, started_at "
                        "FROM sessions WHERE id = ?",
                        (session_id,),
                    ).fetchone()
                    if row:
                        info = {
                            "session_title": row[0],
                            "parent_session_id": row[1],
                            "session_source": row[2],
                            "session_started_at": row[3],
                        }
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


def _tail_offset(stored, size: int, ino: int):
    """Resolve the stored tail position to a byte offset.

    *stored* is the persisted per-file position: current format is
    {"ino": st_ino, "offset": int}; legacy int offsets (pre-inode state files)
    are still accepted. Returns 0 when the file was rotated (renamed aside and
    recreated — the inode changes) or truncated (size shrinks below the stored
    offset). A spurious inode change just re-reads from 0 — app.py's dedup_key
    collapses exact redeliveries.
    """
    if isinstance(stored, dict):
        if stored.get("ino") != ino or size < stored.get("offset", 0):
            return 0
        return stored.get("offset", 0)
    offset = stored or 0
    return 0 if size < offset else offset


def read_new_lines(path: Path, state: dict, seed_eof: bool = False) -> list:
    """Return new complete lines from *path* since the stored offset.

    A missing file yields nothing and leaves no state, so it is retried every
    poll. Rotation/truncation restarts from the beginning of the new file (see
    _tail_offset). With seed_eof, first sight seeds at EOF instead of
    backfilling the whole file — used for large rotating logs whose history
    would flood the pending backlog (see trim_pending).
    """
    key = str(path)
    try:
        st = path.stat()
    except OSError:
        return []
    size, ino = st.st_size, st.st_ino
    stored = state.get(key)
    if stored is None:
        if seed_eof:
            state[key] = {"ino": ino, "offset": size}
            return []
        offset = 0
    else:
        offset = _tail_offset(stored, size, ino)
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
    state[key] = {"ino": ino, "offset": offset + nl + 1}
    return lines


def read_new_text_lines(path: Path, state: dict) -> list:
    """Plain-text variant of read_new_lines for agent.log (not JSONL).

    On first sight the offset seeds at EOF: the log's history is not
    backfilled, only lines written after the forwarder starts tailing.
    """
    key = str(path)
    try:
        st = path.stat()
    except OSError:
        return []
    size, ino = st.st_size, st.st_ino
    stored = state.get(key)
    if stored is None:
        state[key] = {"ino": ino, "offset": size}
        return []
    offset = _tail_offset(stored, size, ino)
    if size == offset:
        return []
    with path.open("rb") as f:
        f.seek(offset)
        chunk = f.read(size - offset)
    nl = chunk.rfind(b"\n")
    if nl == -1:
        return []
    state[key] = {"ino": ino, "offset": offset + nl + 1}
    return [ln.decode("utf-8", errors="replace")
            for ln in chunk[:nl].split(b"\n") if ln.strip()]


_LOG_TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),(\d{3})")
_LOG_SESSION_RE = re.compile(r"^\S+ \S+ [A-Z]+ \[([^\]]+)\]")
# agent.conversation_loop: Turn ended: reason=guardrail_halt model=hermes/main
#   api_calls=21/150 budget=21/150 tool_turns=77 ... session=<sid>
_GUARD_HALT_RE = re.compile(
    r"Turn ended: reason=guardrail_halt model=(\S+)"
    r" api_calls=(\d+)/\d+ .*?tool_turns=(\d+)")
# agent.tool_executor: Tool read_file returned error (0.00s): {"error":
#   "Blocked read_file: ...", "guardrail": {"action": "block", "code": "..."}}
# NOTE: hermes truncates long log lines, so the JSON tail (incl. the code
# value) is often cut mid-string — the regexes below tolerate that.
_GUARD_BLOCK_RE = re.compile(
    r"Tool (\S+) returned error .*?\"guardrail\":\s*\{\s*\"action\":\s*\"block\"")
_GUARD_CODE_FULL_RE = re.compile(r"\"code\":\s*\"([A-Za-z0-9_]+)\"")
_GUARD_CODE_PREFIX_RE = re.compile(r"\"code\":\s*\"([A-Za-z0-9_]+)")
_GUARD_BLOCK_MSG_RE = re.compile(r"\{\"error\":\s*\"((?:[^\"\\]|\\.)*)\"")


def _log_ts(line: str):
    m = _LOG_TS_RE.match(line)
    if not m:
        return None
    try:
        dt = datetime.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")
        return dt.timestamp() + int(m.group(2)) / 1000.0
    except ValueError:
        return None


def parse_agent_log_line(line: str):
    """One agent.log line -> a guardrail_halt / guardrail_block record, or None.

    Only guardrail events are extracted; everything else in the log (including
    message content) stays out of the metrics pipeline.
    """
    halt = _GUARD_HALT_RE.search(line)
    block = None if halt else _GUARD_BLOCK_RE.search(line)
    if not halt and not block:
        return None
    ts = _log_ts(line)
    if ts is None:
        return None
    sid_m = _LOG_SESSION_RE.match(line)
    sid = sid_m.group(1) if sid_m else ""
    if halt:
        model, api_calls, tool_turns = halt.group(1), halt.group(2), halt.group(3)
        return {
            "event": "guardrail_halt", "ts": ts, "session_id": sid,
            "model": model, "finish_reason": "guardrail_halt",
            "error_message": f"turn ended: reason=guardrail_halt after "
                             f"{api_calls} api calls / {tool_turns} tool turns",
        }
    tool = block.group(1)
    # The code value may survive intact, truncated to a prefix, or be cut
    # entirely — degrade gracefully ("re…" reads as a truncated code).
    code_m = _GUARD_CODE_FULL_RE.search(line)
    if code_m:
        code = code_m.group(1)
    else:
        code_m = _GUARD_CODE_PREFIX_RE.search(line)
        code = code_m.group(1) + "…" if code_m else "block"
    msg_m = _GUARD_BLOCK_MSG_RE.search(line)
    msg = msg_m.group(1)[:160] if msg_m else ""
    return {
        "event": "guardrail_block", "ts": ts, "session_id": sid,
        "label": tool,
        "error_message": f"guardrail {code}: {msg}" if msg else f"guardrail {code}",
    }


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


def _iso_ts(value):
    """Router/clientgate ts ("2026-08-02T10:03:42+0200", %z format) -> epoch.

    Both writers stamp with time.strftime("%Y-%m-%dT%H:%M:%S%z"). Returns None
    for anything unparseable; callers fall back to time.time().
    """
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%S%z").timestamp()
    except (ValueError, TypeError):
        return None


def _openai_usage(prompt_tokens, completion_tokens) -> dict:
    """OpenAI-style token counts -> the input/output names app.normalize reads."""
    usage = {}
    if isinstance(prompt_tokens, int):
        usage["input_tokens"] = prompt_tokens
    if isinstance(completion_tokens, int):
        usage["output_tokens"] = completion_tokens
    return usage


def flatten_router_request(rec: dict) -> dict:
    """One model-router exec-log line -> a router_request record.

    Source schema (hermes-model-router router.py do_POST / exec_log):
    {role, model, status, reason, path, duration_s, usage?, ts} where usage is
    OpenAI-style {prompt_tokens, completion_tokens, total_tokens, ...}. The
    role lands in `label`; usage is renamed to the hook's input/output names
    so app.normalize needs no change. HTTP >= 400 becomes an error record.
    """
    usage = rec.get("usage")
    out = {
        "event": "router_request",
        "ts": _iso_ts(rec.get("ts")) or time.time(),
        "label": rec.get("role") or None,
        "model": rec.get("model"),
        "duration_s": rec.get("duration_s"),
        "usage": _openai_usage(
            usage.get("prompt_tokens"), usage.get("completion_tokens")
        ) if isinstance(usage, dict) else {},
    }
    status = rec.get("status")
    if isinstance(status, int) and status >= 400:
        out["error_type"] = f"http_{status}"
        reason = rec.get("reason") or ""
        out["error_message"] = (
            f"router returned {status} for role {rec.get('role') or '?'}"
            f" on {rec.get('path') or '?'}" + (f" ({reason})" if reason else "")
        )
    return out


def flatten_clientgate_request(rec: dict) -> dict:
    """One clientgate usage-log line -> a clientgate_request record.

    Source schema (hermes-model-router clientgate.py _proxy / log_usage):
    {client, role, method, path, model, status, duration_ms, prompt_tokens,
    completion_tokens, total_tokens, ts}. The per-client key name lands in
    `label`; tokens are renamed like flatten_router_request. HTTP >= 400
    becomes an error record.
    """
    out = {
        "event": "clientgate_request",
        "ts": _iso_ts(rec.get("ts")) or time.time(),
        "label": rec.get("client") or None,
        "model": rec.get("model") or None,
        "duration_ms": rec.get("duration_ms"),
        "usage": _openai_usage(rec.get("prompt_tokens"), rec.get("completion_tokens")),
    }
    status = rec.get("status")
    if isinstance(status, int) and status >= 400:
        out["error_type"] = f"http_{status}"
        out["error_message"] = (
            f"clientgate returned {status} for client {rec.get('client') or '?'}"
            f" on {rec.get('path') or '?'}"
        )
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
    # Tool-guardrail events live only in agent.log (never in requests.jsonl) —
    # tail it for guardrail halts / blocks so the dashboard can alert on them.
    for line in read_new_text_lines(AGENT_LOG_FILE, state):
        rec = parse_agent_log_line(line)
        if rec:
            rec.update(sessions.lookup(rec.get("session_id") or ""))
            records.append(rec)
    # Router daemon exec log: clients hitting :8867 directly never fire the
    # Hermes metrics hook, so this is their only trail (seed at EOF — the file
    # can hold 50 MB of history and rotates with .1/.2/.3 backups).
    for line in read_new_lines(ROUTER_REQUESTS_FILE, state, seed_eof=True):
        rec = flatten_router_request(line)
        rec.update(sessions.lookup(rec.get("session_id") or ""))
        records.append(rec)
    # clientgate per-client usage attribution (same audit gap, edge proxy).
    for line in read_new_lines(CLIENTGATE_USAGE_FILE, state, seed_eof=True):
        rec = flatten_clientgate_request(line)
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
    periodic = {"host_stats", "pool_status", "benchmark_sample", "conformance_result"}
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
    last_conformance = 0.0
    gateway_last: dict = {}
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
            pending.extend(sample_gateway_status(gateway_last))
        if now - last_benchmark >= BENCHMARK_SECONDS:
            last_benchmark = now
            pending.extend(sample_benchmark_records())
        if CONFORMANCE_STANDARD and now - last_conformance >= host_checks.INTERVAL_S:
            last_conformance = now
            try:
                pending.append(host_checks.run(HOST_LABEL, Path(CONFORMANCE_STANDARD).expanduser()))
            except Exception as exc:  # unreadable standard: skip this round, keep forwarding
                print(f"host checks skipped: {exc}", file=sys.stderr, flush=True)
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
