"""metrics_core — data layer for the metrics-dashboard Hermes plugin.

Stdlib-only and Python 3.9-compatible (this module may run inside the Hermes
backend on the mini, whose system python is 3.9 — no PEP 604 unions).

Thin-plugin/fat-core: ``dashboard/plugin_api.py`` and any future agent tools
are pure adapters over this module, so every surface shares one code path.

Backend seam
------------
All reads go through a small backend interface::

    recent(hours=1, limit=500) -> dict   # GET /api/recent, or the local JSONL
    moa_summary(hours=1) -> dict         # GET /api/moa/summary (server-only)
    findings() -> dict                   # GET /api/findings (server-only)
    usage_map() -> dict                  # GET /api/usage-map (server-only)
    health() -> dict                     # GET /health, or local-file liveness
    describe() -> dict                   # {"source": ...} + base_url/path

``HttpBackend`` talks to the standalone ``app.py`` server;
``LocalFileBackend`` reads the local pipeline file
(``$HERMES_HOME/metrics/requests.jsonl``) directly — the single-instance
mode, when no server is reachable. The later "fold app.py into the gateway"
phase adds a ``SqliteBackend`` reading ``~/.hermes/metrics/metrics.db``
directly; callers select it via ``METRICS_BACKEND=sqlite`` and never change
— see ``get_backend()``.

Backend selection (per call, env first) — see ``get_backend()``:

1. ``METRICS_BACKEND`` env (``http`` default / ``sqlite`` stub).
2. ``METRICS_DASH_URL`` env override — pinned HTTP, no fallback (THE way to
   configure a custom/Tailscale topology).
3. ``http://127.0.0.1:8899`` if something answers ``/health`` on the loopback
   port (i.e. we are on the mini, where app.py runs under launchd).
4. Each URL in ``REMOTE_BASE_URLS`` (overridable via ``METRICS_DASH_REMOTES``,
   a comma-separated list) is probed in order — Tailscale first, then legacy
   LAN — and the first that answers wins.
5. ``LocalFileBackend`` if the local pipeline file exists.
6. Otherwise the (failing) HTTP backend, so the error message is useful.

Steps 3–5 are probe-cached for 60s, so topology changes (the mini appears
or disappears, the local file appears) are picked up within ~60s and the
request path never stalls (all probe timeouts <= 0.5s).

Every failure raises :class:`MetricsUnavailable` — callers turn that into a
degraded payload; this module never hangs (all timeouts <= 3s).
"""

import abc
import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

LOOPBACK_BASE_URL = "http://127.0.0.1:8899"

# Remote candidate URLs, probed in order after loopback. Empty by default:
# to PIN an explicit source set METRICS_DASH_URL (skips all probing), and to
# add probe candidates set METRICS_DASH_REMOTES to a comma-separated list.
REMOTE_BASE_URLS = []

REQUEST_TIMEOUT_S = 3.0
LOOPBACK_PROBE_TIMEOUT_S = 0.5
BASE_URL_CACHE_TTL_S = 60.0

# Trailing-window read for the local JSONL: the same 2 MiB trick forwarder.py
# uses, scaled up when a large `limit` could span more than that.
LOCAL_READ_MIN_BYTES = 2000000
LOCAL_READ_BYTES_PER_RECORD = 4096


class MetricsUnavailable(RuntimeError):
    """The metrics server is unreachable or returned an unusable response."""


# ---------------------------------------------------------------------------
# Base URL resolution (module-level; the result is per-host and cheap)
# ---------------------------------------------------------------------------

_base_url_cache = None  # Optional[str]
_base_url_cache_at = 0.0
_auto_backend_cache = None  # Optional[MetricsBackend]
_auto_backend_cache_at = 0.0


def _probe_url(base_url):
    """True when an HTTP server answers on ``base_url`` (any response)."""
    try:
        with urllib.request.urlopen(
            base_url + "/health", timeout=LOOPBACK_PROBE_TIMEOUT_S
        ) as resp:
            resp.read()
        return True
    except urllib.error.HTTPError:
        # A server answered, just not with a 2xx — the port is owned locally.
        return True
    except Exception:
        return False


def _probe_loopback():
    """True when an HTTP server answers on the loopback dashboard port."""
    return _probe_url(LOOPBACK_BASE_URL)


def _remote_base_urls():
    """Remote candidates to probe, in order. METRICS_DASH_REMOTES env
    (comma-separated) overrides the built-in list."""
    env = os.environ.get("METRICS_DASH_REMOTES", "").strip()
    if env:
        return [u.strip().rstrip("/") for u in env.split(",") if u.strip()]
    return REMOTE_BASE_URLS


def _probe_base_url():
    """Loopback first, then each remote candidate (first answer wins). Last
    resort is the first remote (unprobed) so a configured-but-down source
    still yields a useful URL for the error message."""
    if _probe_loopback():
        return LOOPBACK_BASE_URL
    remotes = _remote_base_urls()
    for url in remotes:
        if _probe_url(url):
            return url
    return remotes[0] if remotes else LOOPBACK_BASE_URL


def resolve_base_url():
    """Resolve the dashboard base URL: env override, else probe loopback then
    the configured remote candidates (first answer wins)."""
    env_url = os.environ.get("METRICS_DASH_URL", "").strip()
    if env_url:
        return env_url.rstrip("/")

    global _base_url_cache, _base_url_cache_at
    now = time.monotonic()
    if _base_url_cache is not None and now - _base_url_cache_at < BASE_URL_CACHE_TTL_S:
        return _base_url_cache
    _base_url_cache = _probe_base_url()
    _base_url_cache_at = now
    return _base_url_cache


def _reset_base_url_cache():
    """Clear the probe caches (base URL + auto backend). Exists for tests."""
    global _base_url_cache, _base_url_cache_at
    global _auto_backend_cache, _auto_backend_cache_at
    _base_url_cache = None
    _base_url_cache_at = 0.0
    _auto_backend_cache = None
    _auto_backend_cache_at = 0.0


# ---------------------------------------------------------------------------
# Backend seam
# ---------------------------------------------------------------------------

class MetricsBackend(abc.ABC):
    """Read interface every metrics backend implements."""

    name = "abstract"

    @abc.abstractmethod
    def recent(self, hours=1, limit=500):
        """Recent request records, newest last: ``{"records": [...]}``."""

    @abc.abstractmethod
    def findings(self):
        """Aggregated health-rule finding history."""

    @abc.abstractmethod
    def moa_summary(self, hours=1):
        """MoA run aggregate over the trailing window (server-only)."""

    @abc.abstractmethod
    def usage_map(self):
        """Dashboard-managed model -> usage map (``{}`` when unset)."""

    @abc.abstractmethod
    def health(self):
        """Liveness probe of the metrics store."""

    def describe(self):
        """Which source this backend reads (for health/summary payloads)."""
        return {"source": self.name}


class HttpBackend(MetricsBackend):
    """Reads the standalone ``app.py`` metrics server over HTTP."""

    name = "http"

    def __init__(self, base_url=None):
        # None => resolve at call time (env override, loopback probe, LAN).
        self._base_url = base_url

    def base_url(self):
        return self._base_url or resolve_base_url()

    def describe(self):
        return {"source": self.name, "base_url": self.base_url()}

    def _get(self, path, params=None):
        url = self.base_url() + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        try:
            with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_S) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except MetricsUnavailable:
            raise
        except Exception as exc:
            raise MetricsUnavailable(
                "metrics server unreachable at %s: %s" % (url, exc)
            )

    def recent(self, hours=1, limit=500):
        return self._get("/api/recent", {"hours": hours, "limit": limit})

    def findings(self):
        return self._get("/api/findings")

    def moa_summary(self, hours=1):
        return self._get("/api/moa/summary", {"hours": hours})

    def usage_map(self):
        return self._get("/api/usage-map")

    def health(self):
        return self._get("/health")


class SqliteBackend(MetricsBackend):
    """TODO(later phase): read ``~/.hermes/metrics/metrics.db`` directly.

    This is the drop-in for the "fold app.py into the gateway" phase: on the
    mini the plugin runs in the same process/host as the SQLite store, so the
    HTTP hop can be retired by selecting ``METRICS_BACKEND=sqlite``. Not
    implemented yet — every method raises so a mis-set env fails loudly at
    the route layer (degraded payload) instead of silently serving stale
    HTTP data.
    """

    name = "sqlite"

    def _todo(self):
        raise MetricsUnavailable(
            "SqliteBackend is not implemented yet; unset METRICS_BACKEND "
            "or use METRICS_BACKEND=http"
        )

    def recent(self, hours=1, limit=500):
        self._todo()

    def findings(self):
        self._todo()

    def moa_summary(self, hours=1):
        self._todo()

    def usage_map(self):
        self._todo()

    def health(self):
        self._todo()


# ---------------------------------------------------------------------------
# Local-file backend — single-instance mode (no app.py server anywhere)
# ---------------------------------------------------------------------------

def default_requests_path():
    """The local metrics pipeline file, resolved per call (HERMES_HOME may
    change between calls, e.g. in tests)."""
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    return os.path.join(home, "metrics", "requests.jsonl")


def _parse_ts(value):
    """Epoch seconds from a record ``ts``: number, numeric string, or ISO-8601
    (tz-aware or naive — naive is treated as UTC). None when unparseable."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            pass
        try:
            dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return dt.timestamp()
    return None


def _read_tail_lines(path, limit):
    """Complete lines from the tail of a JSONL file.

    Reads the trailing max(2 MiB, limit * 4 KiB) — the same trailing-window
    trick forwarder.py uses — and drops the first (possibly partial) line
    when the window starts mid-file.
    """
    window = max(LOCAL_READ_MIN_BYTES, int(limit) * LOCAL_READ_BYTES_PER_RECORD)
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        if size > window:
            f.seek(size - window)
        chunk = f.read()
    if size > window:
        nl = chunk.find(b"\n")
        chunk = chunk[nl + 1:] if nl != -1 else b""
    text = chunk.decode("utf-8", errors="replace")
    return [line for line in text.splitlines() if line.strip()]


def _normalize_local_record(rec, ts):
    """Flatten a raw hook-emitted line (see hooks/metrics-emit.py) into the
    same row shape the HTTP backend returns, so callers never see the
    difference. Mirrors app.py's ``normalize`` (kept deliberately smaller —
    only the fields the plugin surfaces use)."""
    event = rec.get("event") or ""
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
        # Same mapping as app.py normalize: status >= 400 (incl. 598 stream
        # stalls) is a failed call, not a slow successful request.
        kind = "error" if (rec.get("error_type") or rec.get("error_message")) else event
    else:
        kind = event or "unknown"

    usage = rec.get("usage")
    if not isinstance(usage, dict):
        usage = {}
    duration = rec.get("api_duration")
    if duration is None:
        duration = rec.get("duration_s")
    if duration is None and rec.get("duration_ms") is not None:
        try:
            duration = float(rec["duration_ms"]) / 1000.0
        except (TypeError, ValueError):
            duration = None
    out_tok = usage.get("output_tokens")
    tps = rec.get("tps")
    if tps is None and duration and out_tok:
        try:
            tps = round(float(out_tok) / float(duration), 2)
        except (TypeError, ValueError, ZeroDivisionError):
            tps = None
    error = None
    if rec.get("error_type") or rec.get("error_message"):
        error = ("%s: %s" % (rec.get("error_type") or "",
                             rec.get("error_message") or "")).strip(": ")

    return {
        "ts": ts,
        "event": event,
        "kind": kind,
        "session_id": rec.get("session_id") or "",
        "model": rec.get("model"),
        "provider": provider,
        "duration_s": duration,
        "tps": tps,
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": out_tok,
        "error": error,
    }


class LocalFileBackend(MetricsBackend):
    """Reads the local pipeline file (``$HERMES_HOME/metrics/requests.jsonl``)
    directly — the single-instance mode, when no app.py server answers on
    loopback or LAN.

    ``findings()`` and ``usage_map()`` are server-side computations and raise
    :class:`MetricsUnavailable` with a clear reason instead of fabricating
    data.
    """

    name = "local-file"

    def __init__(self, path=None):
        # None => resolve at call time (HERMES_HOME-aware).
        self._path = path

    def path(self):
        return self._path or default_requests_path()

    def describe(self):
        return {"source": self.name, "path": self.path()}

    def recent(self, hours=1, limit=500):
        path = self.path()
        if not os.path.exists(path):
            raise MetricsUnavailable("local metrics file not found: %s" % path)
        cutoff = time.time() - float(hours) * 3600.0
        records = []
        for raw in _read_tail_lines(path, limit):
            try:
                rec = json.loads(raw)
            except ValueError:
                continue  # tolerate bad/partial lines
            if not isinstance(rec, dict):
                continue
            ts = _parse_ts(rec.get("ts"))
            if ts is None or ts < cutoff:
                continue
            records.append(_normalize_local_record(rec, ts))
        # Append order is oldest-first; keep the newest `limit`, returned
        # oldest->newest like the HTTP backend ("newest last").
        records.sort(key=lambda row: row["ts"])
        return {"records": records[-int(limit):] if limit else records}

    def findings(self):
        raise MetricsUnavailable(
            "findings are computed by the dashboard server; "
            "unavailable in local-file mode"
        )

    def moa_summary(self, hours=1):
        raise MetricsUnavailable(
            "the MoA summary is computed by the dashboard server; "
            "unavailable in local-file mode"
        )

    def usage_map(self):
        raise MetricsUnavailable(
            "the usage map is managed by the dashboard server; "
            "unavailable in local-file mode"
        )

    def health(self):
        path = self.path()
        if not os.path.exists(path):
            raise MetricsUnavailable("local metrics file not found: %s" % path)
        return {"status": "ok", "mode": self.name, "path": path}


def get_backend():
    """Return the configured backend. Selection is per call, via env.

    Resolution order:

    1. ``METRICS_BACKEND``: ``http`` (default) or ``sqlite`` (stub, later phase).
    2. ``METRICS_DASH_URL`` env override — pinned HTTP, never falls back.
    3. Probe loopback, then each ``REMOTE_BASE_URLS`` candidate — first answer
       wins (HTTP).
    4. ``LocalFileBackend`` when the local pipeline file exists.
    5. Otherwise the (failing) HTTP backend, so the error message is useful.

    Steps 3–5 are cached for ``BASE_URL_CACHE_TTL_S`` and re-evaluated on
    expiry, so topology changes are picked up within ~60s.
    """
    kind = (os.environ.get("METRICS_BACKEND", "") or "http").strip().lower()
    if kind == "sqlite":
        return SqliteBackend()
    if kind != "http":
        raise MetricsUnavailable("unknown METRICS_BACKEND: %r" % kind)
    env_url = os.environ.get("METRICS_DASH_URL", "").strip()
    if env_url:
        return HttpBackend(env_url.rstrip("/"))
    return _resolve_auto_backend()


def _resolve_auto_backend():
    """Probe-based backend resolution when no env pins one (see get_backend)."""
    global _auto_backend_cache, _auto_backend_cache_at
    now = time.monotonic()
    if _auto_backend_cache is not None and now - _auto_backend_cache_at < BASE_URL_CACHE_TTL_S:
        return _auto_backend_cache
    if _probe_url(LOOPBACK_BASE_URL):
        backend = HttpBackend(LOOPBACK_BASE_URL)
    else:
        backend = None
        for url in _remote_base_urls():
            if _probe_url(url):
                backend = HttpBackend(url)
                break
        if backend is None:
            path = default_requests_path()
            backend = LocalFileBackend(path) if os.path.exists(path) else HttpBackend()
    _auto_backend_cache = backend
    _auto_backend_cache_at = now
    return backend


# ---------------------------------------------------------------------------
# Module-level convenience API — what plugin_api and future tools call
# ---------------------------------------------------------------------------

def recent(hours=1, limit=500):
    return get_backend().recent(hours=hours, limit=limit)


def findings():
    return get_backend().findings()


def moa_summary(hours=1):
    return get_backend().moa_summary(hours=hours)


def usage_map():
    return get_backend().usage_map()


def health():
    return get_backend().health()


def admin_token():
    """The collector's admin token: $METRICS_ADMIN_TOKEN, else
    $HERMES_HOME/metrics/admin.token (same resolution as app.py)."""
    tok = os.environ.get("METRICS_ADMIN_TOKEN", "").strip()
    if tok:
        return tok
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    try:
        with open(os.path.join(home, "metrics", "admin.token")) as f:
            return f.read().strip()
    except OSError:
        return ""


def admin_post(path, body):
    """POST a dashboard write to the collector with the admin token.

    Returns ``(status, payload)`` with the collector's own status and JSON so
    the caller can relay it. Raises MetricsUnavailable when the collector is
    unreachable or no admin token is configured on this machine."""
    token = admin_token()
    if not token:
        raise MetricsUnavailable(
            "no admin token on this machine (METRICS_ADMIN_TOKEN or "
            "~/.hermes/metrics/admin.token); run auth_tokens.py admin-init on the collector host")
    url = resolve_base_url() + path
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8") or "{}")
        except ValueError:
            return exc.code, {"ok": False, "error": "HTTP %d" % exc.code}
    except Exception as exc:
        raise MetricsUnavailable("metrics server unreachable at %s: %s" % (url, exc))
