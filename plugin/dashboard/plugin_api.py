"""metrics-dashboard plugin — backend API routes.

Mounted at /api/plugins/metrics-dashboard/ by the Hermes backend (the
desktop app's ``hermes serve`` process). Thin adapter over ``metrics_core``;
plugin HTTP routes sit behind the dashboard's session-token auth middleware,
same as core routes — no auth is hand-rolled here.

Every route degrades instead of hanging: when the metrics server (the mini,
over LAN) or the model-router daemon is unreachable, routes return a JSON
payload with ``available: false`` (503 for ``/health``, 200 for the data
routes) after at most ~3s. ``metrics_core`` carries the timeouts.

Interop: ``/router-view`` prefers importing ``router_core`` from the sibling
``model-router`` plugin in-process (``$HERMES_HOME/plugins/model-router``,
resolved at call time) and falls back to the router daemon's loopback HTTP
(``$MODEL_ROUTER_URL``). Each section is wrapped independently so one failing
piece degrades only itself. Both plugins work standalone.

Live push: ``/events`` (WebSocket) streams new records to desktop clients so
the UI updates instantly instead of waiting for its 10s poll (the poll stays
as the fallback for remotes where the SDK socket is a no-op). This backend
owns no event source, so the handler tails the same ``metrics_core`` backend
the REST routes use — a short server-side poll with a timestamp watermark,
pushing only records the client has not seen yet (same pattern as the
upstream kanban plugin's ``/events``).
"""

import asyncio
import json
import logging
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse

log = logging.getLogger(__name__)

router = APIRouter()

# metrics_core lives in the plugin root (one level up) so it installs with
# the plugin and stays importable for both this module and tests.
_PLUGIN_DIR = str(Path(__file__).resolve().parents[1])
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

_ROUTER_TIMEOUT_S = 3.0
_ROUTER_DEFAULT_URL = "http://127.0.0.1:8867"


def _core():
    # Lazy import so this module loads in test contexts where the plugin dir
    # is only added to sys.path above, and so a broken metrics_core surfaces
    # per-request instead of killing plugin load.
    import metrics_core

    return metrics_core


# ---------------------------------------------------------------------------
# Metrics routes — thin wrappers over metrics_core
# ---------------------------------------------------------------------------

@router.get("/health")
def health():
    """Metrics-source reachability plus which backend/base URL is in use.

    ``source`` is ``"http"`` (with ``base_url``) or ``"local-file"`` (with
    ``path``) so the UI can label where the data actually comes from.
    """
    core = _core()
    try:
        backend = core.get_backend()
    except core.MetricsUnavailable as exc:
        return JSONResponse(
            status_code=503,
            content={"available": False, "backend": None, "source": None,
                     "base_url": None, "path": None, "error": str(exc)},
        )
    desc = _describe_backend(backend)
    try:
        server = backend.health()
    except Exception as exc:
        return JSONResponse(
            status_code=503,
            content=dict(desc, available=False, error=str(exc)),
        )
    return dict(desc, available=True, server=server)


def _describe_backend(backend):
    """Health-payload identity block: {"backend", "source", "base_url", "path"}."""
    try:
        desc = backend.describe()
    except Exception:
        desc = {"source": backend.name}
    return {
        "backend": backend.name,
        "source": desc.get("source", backend.name),
        "base_url": desc.get("base_url"),
        "path": desc.get("path"),
    }


@router.get("/recent")
def recent(
    hours: float = Query(1.0, ge=0.1, le=720.0),
    limit: int = Query(500, ge=1, le=5000),
):
    core = _core()
    try:
        return core.recent(hours=hours, limit=limit)
    except Exception as exc:
        return {"available": False, "records": [], "error": str(exc)}


@router.get("/moa/summary")
def moa_summary(hours: float = Query(1.0, ge=0.1, le=720.0)):
    """MoA run aggregate for the desktop pane's MoA section.

    ``available: false`` means no MoA runs in the window (idle state — the
    payload still carries the last known voice lineup and preset); a raised
    backend error degrades to ``available: false`` with an ``error`` key.
    """
    core = _core()
    try:
        return core.moa_summary(hours=hours)
    except Exception as exc:
        return {"available": False, "error": str(exc)}


@router.get("/findings")
def findings():
    core = _core()
    try:
        return core.findings()
    except Exception as exc:
        return {"available": False, "error": str(exc)}


@router.get("/usage-map")
def usage_map():
    core = _core()
    try:
        return core.usage_map()
    except Exception as exc:
        return {"available": False, "error": str(exc)}


@router.get("/summary")
def summary():
    """Health + the last hour of request records in one payload, for the web
    dashboard tab's stat header (one poll instead of two).

    ``available`` is true when at least one section resolved; each section is
    ``{"available": true, "data": ...}`` or ``{"available": false, "error":
    ...}`` so a partial outage degrades only that section. The route always
    answers 200.
    """
    core = _core()
    payload = {"available": False}

    try:
        backend = core.get_backend()
        payload["health"] = {
            "available": True,
            "data": dict(_describe_backend(backend), server=backend.health()),
        }
        payload["available"] = True
    except Exception as exc:
        payload["health"] = {"available": False, "error": str(exc)}

    try:
        payload["recent_1h"] = {
            "available": True,
            "data": core.recent(hours=1, limit=500),
        }
        payload["available"] = True
    except Exception as exc:
        payload["recent_1h"] = {
            "available": False, "records": [], "error": str(exc),
        }

    return payload


# ---------------------------------------------------------------------------
# GET /router-view — interop with the sibling model-router plugin
# ---------------------------------------------------------------------------

def _router_core_getters():
    """Import the sibling plugin's core adapter. Raises ImportError when the
    model-router plugin is not installed on this HERMES_HOME."""
    hermes_home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    router_dir = os.path.join(hermes_home, "plugins", "model-router")
    if router_dir not in sys.path:
        sys.path.insert(0, router_dir)
    import router_core

    return "router_core", {
        "status": router_core.status,
        "notes": router_core.notes,
        "usage": router_core.usage,
        # Fresh 1h window drives the pane's "active" signal so it tracks
        # usage; the 24h map stays for per-role req/token stats.
        "usage_1h": lambda: router_core.usage(since="1h"),
    }


def _router_http_getters():
    """Fallback: the router daemon's loopback HTTP. The daemon exposes no
    usage endpoint, so that section reports itself unavailable."""
    base = os.environ.get("MODEL_ROUTER_URL", _ROUTER_DEFAULT_URL).rstrip("/")

    def _get(path):
        headers = {}
        token = _router_token()
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, headers=headers)
        with urllib.request.urlopen(req, timeout=_ROUTER_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _usage_unavailable():
        raise RuntimeError("usage is only available via the router_core import")

    return "http", {
        "status": lambda: _get("/router/status"),
        "notes": lambda: _get("/router/notes"),
        "usage": _usage_unavailable,
        "usage_1h": _usage_unavailable,
    }


@router.get("/router-view")
def router_view():
    """Router status + notes + usage in one payload for the desktop pane.

    ``available`` is true when at least one section resolved; each section is
    ``{"available": bool, "data": ...}`` or ``{"available": false, "error":
    ...}`` so a partial outage degrades only that section. ``write_enabled``
    mirrors the router's MODEL_ROUTER_ALLOW_WRITE gate (read from this
    process's env — exactly what router_core._require_write checks) so the
    pane can render gated actions disabled instead of failing a POST.
    """
    try:
        source, getters = _router_core_getters()
    except ImportError:
        source, getters = _router_http_getters()

    payload = {"available": False, "source": source,
               "write_enabled": os.environ.get("MODEL_ROUTER_ALLOW_WRITE") == "1"}
    for key, getter in getters.items():
        try:
            payload[key] = {"available": True, "data": getter()}
            payload["available"] = True
        except Exception as exc:
            payload[key] = {"available": False, "error": str(exc)}
    return payload


def _router_token():
    """Daemon bearer token, same resolution as router_core._token:
    $MODEL_ROUTER_TOKEN / $ROUTER_TOKEN env, else
    $HERMES_HOME/model-router/router.token. "" = legacy open mode."""
    for var in ("MODEL_ROUTER_TOKEN", "ROUTER_TOKEN"):
        tok = os.environ.get(var, "").strip()
        if tok:
            return tok
    hermes_home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    try:
        with open(os.path.join(hermes_home, "model-router", "router.token")) as f:
            return f.read().strip()
    except OSError:
        return ""


@router.post("/router-reload")
def router_reload():
    """Proxy the router daemon's POST /router/reload (loopback, bearer token
    via _router_token) for the G1 pane's "reload config" footer action.

    Enforces the same MODEL_ROUTER_ALLOW_WRITE=1 gate as the router plugin's
    own /admin/reload — the gate is a client-side posture (the daemon's
    endpoint itself is not gated), so it must be re-checked here: gate off is
    a 403 with the reason. Daemon down is a 503; a daemon error answer
    (bad config on reload, bad token) is a 502 with the daemon's message.
    """
    if os.environ.get("MODEL_ROUTER_ALLOW_WRITE") != "1":
        raise HTTPException(
            status_code=403,
            detail="router writes are disabled — set MODEL_ROUTER_ALLOW_WRITE=1 "
                   "in the backend environment to enable")
    base = os.environ.get("MODEL_ROUTER_URL", _ROUTER_DEFAULT_URL).rstrip("/")
    headers = {"Content-Type": "application/json"}
    token = _router_token()
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(base + "/router/reload", data=b"{}",
                                 headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_ROUTER_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read())
            msg = body.get("error") or body
        except Exception:
            msg = exc.reason
        raise HTTPException(status_code=502,
                            detail="router reload failed: HTTP %d %s" % (exc.code, msg))
    except Exception as exc:
        raise HTTPException(status_code=503,
                            detail="router unreachable at %s: %s" % (base, exc))


# ---------------------------------------------------------------------------
# Dashboard writes — the only way to make them. The collector requires its
# admin token on these routes; this backend holds it, and Hermes' session auth
# guards this route, so a write needs a Hermes login (web dashboard or Desktop).
# ---------------------------------------------------------------------------

_WRITE_PATHS = {
    "env-mode": "/api/env-mode",
    "usage-map": "/api/usage-map",
    "beta-widgets/decision": "/api/beta-widgets/decision",
    "benchmark/mark": "/api/benchmark/mark",
    "harness/mark": "/api/harness/mark",
}


@router.post("/write/{name:path}")
def write(name: str, body: dict = Body(default_factory=dict)):
    """Relay one dashboard write to the collector with the admin token. The
    collector's status and JSON come back unchanged; unreachable collector or
    missing token is a 503."""
    if name not in _WRITE_PATHS:
        raise HTTPException(status_code=404, detail="unknown write %r" % name)
    core = _core()
    try:
        code, payload = core.admin_post(_WRITE_PATHS[name], body)
    except core.MetricsUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return JSONResponse(payload, status_code=code)


# ---------------------------------------------------------------------------
# WebSocket: /events — instant record push, layered over the client's poll
# ---------------------------------------------------------------------------

# Internal tail interval for the WS loop. Each tick is a metrics_core read —
# usually an HTTP/LAN round trip to app.py, not a local DB read — so this
# stays well above kanban's 0.3s SQLite tail.
_EVENT_STREAM_POLL_S = 2.0

# The stream mirrors what the desktop pane/chip poll: /recent?hours=1&limit=500.
_EVENT_STREAM_HOURS = 1
_EVENT_STREAM_LIMIT = 500


def _ws_upgrade_authorized(ws):
    """Authorize a WebSocket upgrade by delegating to the dashboard's canonical
    WS auth gate (``hermes_cli.web_server._ws_auth_ok``) — the same pattern the
    upstream kanban plugin uses. The HTTP routes above sit behind the
    dashboard's session-token middleware, but that middleware does not cover
    WS upgrades, so this endpoint checks the query-string credential
    (``?token=`` / ``?ticket=`` / ``?internal=``) itself; the desktop SDK
    assembles it.

    Imported lazily so this module still loads in test contexts where the
    dashboard ``web_server`` module isn't importable (the bare-FastAPI test
    harness); there we accept so the tail loop stays testable.
    """
    try:
        from hermes_cli import web_server as _web_server
    except ImportError:
        # hermes_cli is absent only in the bare-FastAPI test harness. Fail-open
        # is scoped to this metrics stream (it mirrors session-authed REST
        # data, never anything more sensitive) and is logged so a production
        # miss is not silent. Any OTHER import-time error in web_server now
        # propagates (fail-closed) instead of silently opening the upgrade.
        log.warning(
            "metrics WS auth: hermes_cli not importable — accepting upgrade "
            "(test harness?)")
        return True
    return bool(_web_server._ws_auth_ok(ws))


def _record_fingerprint(rec):
    """Stable content identity for one record. Records carry no row id, so the
    watermark dedupes same-timestamp ties by content."""
    return json.dumps(rec, sort_keys=True, default=str)


def _record_ts(rec):
    """Numeric ``ts`` of a record, else None (bool excluded — it is an int)."""
    ts = rec.get("ts")
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return None
    return float(ts)


def diff_records(state, records):
    """Pure watermark diff: ``(state, batch) -> (new_state, new_records)``.

    ``records`` is one ``/recent`` batch (oldest -> newest). ``state`` is
    ``None`` (first call — every record is new, which doubles as the client's
    initial sync frame) or ``{"ts": float, "sent": [fingerprint, ...]}`` where
    ``sent`` holds the fingerprints of already-emitted records AT the
    watermark timestamp, so a record landing in the same second as the
    watermark is not dropped. Records without a numeric ``ts`` are always
    emitted and never advance the watermark (the client dedupes repeats by
    the same content fingerprint).
    """
    prev_ts = state["ts"] if state else None
    prev_sent = set(state["sent"]) if state else set()
    new = []
    max_ts = prev_ts
    for rec in records:
        ts = _record_ts(rec)
        if prev_ts is None or ts is None or ts > prev_ts:
            new.append(rec)
        elif ts == prev_ts and _record_fingerprint(rec) not in prev_sent:
            new.append(rec)
        if ts is not None and (max_ts is None or ts > max_ts):
            max_ts = ts
    if max_ts is None:
        # No timestamped record ever seen — nothing to watermark on.
        return None, new
    sent = [_record_fingerprint(r) for r in records if _record_ts(r) == max_ts]
    return {"ts": max_ts, "sent": sent}, new


@router.websocket("/events")
async def stream_events(ws: WebSocket):
    # Browsers can't set Authorization on a WS upgrade, so the credential
    # rides in the query string (the desktop SDK assembles it).
    if not _ws_upgrade_authorized(ws):
        await ws.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    core = _core()
    state = None      # diff_records watermark; None = not primed
    available = None  # last pushed availability; None = nothing pushed yet
    try:
        while True:
            try:
                payload = await asyncio.to_thread(
                    core.recent, _EVENT_STREAM_HOURS, _EVENT_STREAM_LIMIT)
                if payload.get("available") is False:
                    raise RuntimeError(
                        payload.get("error") or "metrics source unavailable")
                state, new_records = diff_records(state, payload.get("records") or [])
                # Push on the first tick (initial sync / liveness signal) and
                # whenever there are unseen records; stay quiet otherwise.
                if available is not True or new_records:
                    await ws.send_json({"available": True, "records": new_records})
                available = True
            except WebSocketDisconnect:
                raise
            except Exception as exc:
                # Degrade, don't die: tell the client once per transition and
                # keep tailing — the source may come back.
                if available is not False:
                    await ws.send_json(
                        {"available": False, "records": [], "error": str(exc)})
                available = False
                # Re-prime on recovery so records written while the source
                # was down are not skipped.
                state = None
            # The client never sends; awaiting a receive purely detects
            # disconnects and doubles as the tail interval (a bare sleep
            # would leak the loop for dead connections when no new records
            # ever trigger a send).
            try:
                await asyncio.wait_for(
                    ws.receive_text(), timeout=_EVENT_STREAM_POLL_S)
            except asyncio.TimeoutError:
                pass
    except WebSocketDisconnect:
        return
    except asyncio.CancelledError:
        # Normal shutdown path (see kanban): process exit cancels the
        # websocket task while it waits between tail ticks; without this
        # clause Uvicorn surfaces the cancellation as an application
        # traceback. Quiet it.
        return
    except Exception as exc:  # defensive: never crash the backend worker
        log.warning("metrics event stream error: %s", exc)
        try:
            await ws.close()
        except Exception:
            pass
