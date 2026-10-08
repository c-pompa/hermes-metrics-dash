"""MBP-side harness collector daemon (plan Task 7).

Continuous loop — every N seconds (env ``HARNESS_INTERVAL``, default
:data:`DEFAULT_INTERVAL_S` = 300), with a ±:data:`JITTER` jitter on each
interval so restarts desynchronize:

1. Probe LM Studio (``/api/v0/models``, Task 2) for the model's state and
   runtime config.
2. Run the streaming benchmark suite (Task 3) ONLY when LM Studio reports the
   model ``loaded`` — an unloaded or missing model skips the bench and the push.
3. Take a host telemetry snapshot (Task 4): thermal, memory pressure, swap, power.
   A failed snapshot degrades to "no host keys" — the bench data still ships.
4. Stamp each bench sample with event/ts/model/fp/config/host (Tasks 1+2) and
   POST one ``harness_sample`` record per sample to the dashboard's ``/ingest``.

Crash-safe by construction: every leg degrades to a logged warning instead of
raising, so the loop never dies on a transient failure; a ``flock``-based
single-instance lock prevents two daemons from double-counting, and launchd's
``KeepAlive`` restarts a hard crash (the kernel releases the flock on exit).

Runs on the MBP under launchd; py3.9-compatible, stdlib only (the mini's
system python is 3.9 and nothing here may assume more).

Import styles: ``from harness import collector`` (package/tests) and plain
``python3 .../harness/collector.py`` (the launchd plist runs the file directly,
so a flat-import fallback is required — see the ``try/except ImportError``).
"""
import fcntl
import json
import os
import random
import time
import urllib.request

try:  # package context (tests import harness.collector)
    from . import bench, fingerprint, lmstudio, telemetry
except ImportError:  # script context (launchd runs this file directly)
    import bench, fingerprint, lmstudio, telemetry  # type: ignore  # noqa: F401

MODEL = "qwen3.8-27b-hermes"
HOST = "mbp"

# LM Studio server + dashboard ingest endpoint (METRICS_DASH_URL overrides).
LMS_BASE = lmstudio.BASE
DASH_URL = os.environ.get("METRICS_DASH_URL", "http://127.0.0.1:8899").rstrip("/") + "/ingest"

# Sampling cadence + shape of one suite.
DEFAULT_INTERVAL_S = 300   # every N seconds (env HARNESS_INTERVAL overrides)
REPEATS = 2                # bench repeats per prompt class (plan's suite shape)
JITTER = 0.2               # ±20% on each interval — desynchronize restarts
POST_TIMEOUT_S = 15        # ingest POST timeout, seconds

# Single-instance lock. Kept with the literal "~" (asserted on in tests);
# expanded to the real home only at acquire time.
LOCK_PATH = os.path.join("~", ".hermes", "metrics", "harness-collector.lock")

# Timing seam so no test ever sleeps for real.
_sleep = time.sleep

# Module-level seams — tests patch THESE attributes on harness.collector, so
# run_cycle() must call the module globals (never the underlying functions):
get_payload = lmstudio.get_models_payload   # Task 2 client (/api/v0/models)
run_suite = bench.run_suite                 # Task 3 benchmark suite
snapshot_fn = telemetry.snapshot            # Task 4 host telemetry


def model_state(payload):
    """Raw LM Studio state for :data:`MODEL` ('loaded'/'unloaded'/... or None).

    ``None`` covers both "probe returned something unreadable" and "model not
    in the list". Callers must treat ``None`` as *unknown*, never as unloaded.
    """
    if not isinstance(payload, dict):
        return None
    info = lmstudio.parse_model_info(payload, MODEL)
    if info is None:
        return None
    return info.get("state")


def is_loaded(payload):
    """True only when the probe positively reports state == 'loaded'."""
    return model_state(payload) == "loaded"


def build_sample(bench_result, fp, cfg, host_stats=None, now=None):
    """One ingest record: bench metrics + stamp + telemetry.

    ``bench_result`` is copied, never mutated; ``cfg`` goes through
    :func:`harness.fingerprint.normalize_config` before being JSON-encoded
    (volatility keys dropped, unknown levers as None). ``host_stats`` is
    merged last so telemetry can never clobber the bench metrics.
    """
    rec = dict(bench_result)
    if now is None:
        now = int(time.time())
    rec.update({
        "event": "harness_sample",
        "ts": int(now),
        "model": MODEL,
        "fp": fp,
        "config": json.dumps(fingerprint.normalize_config(cfg)),
        "host": HOST,
    })
    if host_stats:
        rec.update(host_stats)
    return rec


def _truncate(fd):
    """Empty the lock file; best-effort (the marker is cosmetic, never fatal)."""
    try:
        os.ftruncate(fd, 0)
        os.lseek(fd, 0, os.SEEK_SET)
    except OSError:
        pass


def acquire_lock(path=LOCK_PATH):
    """Best-effort single-instance flock; returns an open fd, or None.

    Holders write their pid for debugging (file truncated on each acquire).
    The truncate-then-lock order matters: ``flock`` is per open-file-descriptor,
    so a stale descriptor (same process, e.g. an unclosed reader) keeps its OFD
    over the *old* inode and is bypassed by fresh opens — truncating before the
    lock keeps such zombies harmless. The lock itself is released by
    ``os.close(fd)`` — or automatically when the process dies, so a stale pid
    file never blocks a restart. Missing parent dirs are created.
    """
    path = os.path.expanduser(str(path))
    parent = os.path.dirname(path)
    if parent:
        try:
            os.makedirs(parent, exist_ok=True)
        except OSError:
            return None
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    except OSError:
        return None
    _truncate(fd)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:           # another live holder (or lockfs quirk) -> we lose
        os.close(fd)
        return None
    try:
        _truncate(fd)         # clear any marker a previous holder left behind
        os.write(fd, str(os.getpid()).encode())   # best-effort pid marker
    except OSError:
        pass   # the lock itself is what matters; the pid line is cosmetic
    return fd


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


def _post(url, obj):
    """POST one JSON object to an ingest endpoint.

    Returns the decoded response body as a dict ({} when the body isn't
    JSON). Raises on any transport/HTTP failure.
    """
    data = json.dumps(obj).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers=ingest_headers())
    with urllib.request.urlopen(req, timeout=POST_TIMEOUT_S) as r:
        raw = r.read()
    try:
        reply = json.loads(raw.decode("utf-8") or "{}")
    except ValueError:
        return {}
    return reply if isinstance(reply, dict) else {}


def push(samples, url=None):
    """Best-effort sender: POST all records as one /ingest batch.

    The endpoint's contract is ``{"host": ..., "records": [...]}`` — a flat
    record POSTs fine (HTTP 200) but lands zero rows, so the batch envelope
    is the only shape the store actually accepts. A failed batch is logged
    and skipped, never raised — the dashboard being down for one cycle loses
    at most that cycle. Returns the number of records accepted (the server's
    ``harness_ingested`` count when it echoes one, else the batch size).
    """
    target = DASH_URL if url is None else url
    if not samples:
        return 0
    batch = []
    for s in samples:
        rec = dict(s)
        rec.setdefault("event", "harness_sample")
        if "ts" not in rec:
            rec["ts"] = int(time.time())
        batch.append(rec)
    envelope = {"host": HOST, "records": batch}
    try:
        reply = _post(target, envelope)
    except Exception as exc:   # noqa: BLE001 — best-effort by design
        print("push failed (%s): %s" % (target, exc), flush=True)
        return 0
    if reply.get("ok") is False:
        print("push rejected (%s): %s" % (target, reply.get("error")), flush=True)
        return 0
    accepted = reply.get("harness_ingested")
    if not isinstance(accepted, int):
        accepted = len(batch)   # server without the echo field
    if accepted != len(batch):
        print("push partially accepted (%s): %d/%d rows" % (target, accepted, len(batch)), flush=True)
    return accepted


def run_cycle(now=None):
    """One sample cycle. Never raises; returns a summary for logging/tests:

      loaded         True / False (not 'loaded') / None (probe failed = unknown)
      samples_pushed records that reached the dashboard this cycle
    """
    summary = {"loaded": None, "samples_pushed": 0}

    try:
        payload = get_payload(LMS_BASE)
    except Exception as exc:   # noqa: BLE001 — probe down is a logged warning
        print("probe failed: %s" % exc, flush=True)
        return summary         # loaded stays None: unknown is not unloaded

    state = model_state(payload)
    summary["loaded"] = is_loaded(payload)
    if not summary["loaded"]:
        print("model %s state=%r — skipping bench this cycle"
              % (MODEL, state), flush=True)
        return summary

    cfg = lmstudio.parse_loaded_config(payload, MODEL)
    cfg["parallel"] = lmstudio.get_engine_parallel(MODEL)
    fp = fingerprint.fingerprint(cfg)

    try:
        host_stats = snapshot_fn()
    except Exception as exc:   # noqa: BLE001 — telemetry is decorative here
        print("telemetry failed: %s" % exc, flush=True)
        host_stats = {}

    try:
        samples = run_suite(MODEL, base=LMS_BASE, repeats=REPEATS)
    except Exception as exc:   # noqa: BLE001 — bench must not kill the loop
        print("bench failed: %s" % exc, flush=True)
        return summary

    # Degenerate reps (empty stream: tokens==0, no metrics) are placeholders
    # from bench's safe-degrade path — pushing them stores junk rows that
    # dilute every aggregate. Count them as failures instead.
    good = [s for s in samples
            if not (s.get("tokens") == 0 and s.get("tps") is None
                    and s.get("ttft_s") is None)]
    failed = len(samples) - len(good)
    if failed:
        print("skipping %d degenerate rep(s) (empty stream)" % failed, flush=True)

    records = [build_sample(s, fp, cfg, host_stats, now=now) for s in good]
    pushed = push(records)

    summary["samples_pushed"] = pushed
    summary["reps_failed"] = failed
    print("cycle done: fp=%s state=loaded pushed=%d/%d failed=%d"
          % (fp, pushed, len(good), failed), flush=True)
    return summary


def resolve_interval(explicit=None):
    """Seconds between cycles: explicit arg > env HARNESS_INTERVAL > default.

    Unparseable or non-positive values fall back to :data:`DEFAULT_INTERVAL_S`
    rather than spinning a hot loop.
    """
    if explicit is not None:
        try:
            v = float(explicit)
            if v > 0:
                return v
        except (TypeError, ValueError):
            pass
    raw = os.environ.get("HARNESS_INTERVAL")
    if raw:
        try:
            v = float(raw)
            if v > 0:
                return v
        except ValueError:
            print("bad HARNESS_INTERVAL %r — using default" % raw, flush=True)
    return float(DEFAULT_INTERVAL_S)


def _next_sleep(interval):
    """Interval with ±:data:`JITTER` uniform jitter (never negative)."""
    return max(0.0, interval + interval * JITTER * random.uniform(-1.0, 1.0))


def main(interval=None, lock_path=LOCK_PATH):
    """The daemon loop. Returns 0 (launchd's KeepAlive handles restarts)."""
    path = os.path.expanduser(str(lock_path))
    fd = acquire_lock(path)
    if fd is None:
        print("another harness collector holds %s — exiting" % path, flush=True)
        return 0

    iv = resolve_interval(interval)
    print("harness collector starting: pid=%d model=%s interval=%.0fs "
          "(jitter ±%.0f%%) dash=%s" % (os.getpid(), MODEL, iv, JITTER * 100,
                                        DASH_URL), flush=True)
    try:
        while True:
            run_cycle()
            _sleep(_next_sleep(iv))
    finally:
        os.close(fd)   # releases the flock (the kernel does this on exit too)
    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
