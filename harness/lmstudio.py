"""LM Studio probe: model state + runtime config, no third-party deps.

Two API surfaces on the LM Studio local server (default http://127.0.0.1:1234):

* ``/v1/models``   — OpenAI-compatible list of model ids (light, no runtime state).
* ``/api/v0/models`` — native list: per-model state, quantization and context
  lengths (richer; ``stats`` comes back empty in LM Studio 0.4.x, so we never
  rely on it).

All network calls go through :func:`_get_json` with a timeout; tests stub
``urllib.request.urlopen`` so nothing here touches the live network.
"""
import json
import os
import shutil
import subprocess
import urllib.request

BASE = "http://127.0.0.1:1234"
_LMS_CANDIDATES = (os.path.expanduser("~/.lmstudio/bin/lms"), "lms")


def _get_json(url, timeout=5):
    """GET ``url`` and JSON-decode the body. Raises on HTTP/network errors."""
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_models_payload(base=BASE):
    """Native /api/v0/models GET — per-model state/quant/context (richer than /v1)."""
    return _get_json(base.rstrip("/") + "/api/v0/models")


def list_models(base=BASE):
    """OpenAI-compatible /v1/models GET — model ids, in response order."""
    payload = _get_json(base.rstrip("/") + "/v1/models")
    return [m.get("id") for m in payload.get("data", []) if m.get("id")]


def parse_model_info(payload, model_id):
    """Pick one model's runtime info from a /api/v0/models payload.

    Returns None when the id is absent (caller must treat that as "unknown",
    never guess).
    """
    for m in payload.get("data", []):
        if m.get("id") == model_id:
            return {
                "state": m.get("state"),
                "quantization": m.get("quantization"),
                "max_context_length": m.get("max_context_length"),
                "loaded_context_length": m.get("loaded_context_length"),
            }
    return None


def parse_loaded_config(payload, model_id="qwen3.8-27b-hermes"):
    """Best-effort runtime config in fingerprint keys.

    Unknown levers stay None (never guessed); ``harness.fingerprint.normalize_config``
    maps a missing draft_model to "none" at fingerprint time. Safe for an absent
    model: returns all-None values rather than raising.
    """
    info = parse_model_info(payload, model_id) or {}
    return {
        "context_length": info.get("loaded_context_length"),
        "quantization": info.get("quantization"),
        "gpu_offload": None,       # not exposed by 0.4.x API; fill via lms if present
        "kv_quant": None,
        "flash_attention": None,
        "draft_model": None,
    }


def get_engine_parallel(model_id, timeout=10):
    """Read the model's parallel sessions from ``lms ps --json`` (cluster view).

    The HTTP /api/v0/models payload does not expose parallel (H-8), but the local
    ``lms`` CLI cluster view lists every resident model across nodes with a
    ``parallel`` field. Matches ``model_id`` exactly first — instance suffixes
    (``model:2``) are secondary loads, not the one that serves the identifier
    clients request; falls back to suffix instances (largest ``contextLength``)
    when no primary is resident. Returns None (never guesses) when the CLI is
    missing, errors, or the model is not resident.
    """
    lms = next((c for c in _LMS_CANDIDATES if shutil.which(c)), None)
    if lms is None:
        return None
    try:
        out = subprocess.run([lms, "ps", "--json"], capture_output=True,
                             text=True, timeout=timeout, check=True).stdout
        entries = json.loads(out)
    except Exception:   # noqa: BLE001 — probe must degrade to None, not raise
        return None
    if not isinstance(entries, list):
        return None
    primary = [e for e in entries if str(e.get("identifier", "")) == model_id]
    if primary:
        best = primary[0]
    else:
        best = None
        for e in entries:
            if str(e.get("identifier", "")).split(":")[0] != model_id:
                continue
            if best is None or (e.get("contextLength") or 0) > (best.get("contextLength") or 0):
                best = e
    if best is None:
        return None
    parallel = best.get("parallel")
    return int(parallel) if isinstance(parallel, (int, float)) else None
