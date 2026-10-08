"""Config fingerprinting for LM Studio runtime configs."""
import hashlib
import json

# Keys that participate in the fingerprint, in canonical order.
_FP_KEYS = ["context_length", "gpu_offload", "kv_quant",
            "flash_attention", "draft_model", "parallel"]
# Volatile keys documented as dropped (normalize_config whitelists _FP_KEYS).
_DROP_KEYS = ("wallclock", "ts", "pid")


def normalize_config(cfg):
    """Return a dict with only fingerprint-relevant keys, JSON-safe."""
    out = {}
    for k in _FP_KEYS:
        v = cfg.get(k)
        if v is None or v == "":
            v = "none" if k == "draft_model" else None
        out[k] = v
    return out


def fingerprint(cfg):
    """12-hex-char stable fingerprint of a config dict (order-independent)."""
    norm = normalize_config(cfg)
    blob = json.dumps(norm, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:12]
