#!/usr/bin/env python3
"""Infra benchmark helpers — lean samples, yield, usage tagging."""
from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path
from typing import Any, Optional

BENCHMARK_COLUMNS = [
    "ts", "host", "usage", "model", "ctx_k", "parallel", "ttl", "offload",
    "hermes_knobs", "tps", "p50_s", "vram_gb", "model_gb", "cpu_load",
    "mem_used_gb", "mem_total_gb", "power_w", "yield", "experiment", "named",
]

USAGE_HELP = {
    "deriver": "Honcho deriver / summary / dream path — heavy text jobs.",
    "dialectic": "Honcho dialectic LLM — needs native OpenAI tool_calls.",
    "aggregator": "Hermes MoA aggregator / compression.",
    "MoA ref": "Mixture-of-Agents reference proposer.",
    "embeddings": "Embedding endpoint for search / Honcho vectors.",
    "loaded": "Model is loaded; no specific stack role mapped yet.",
}


def resource_gb(vram_gb: Optional[float], model_gb: Optional[float]) -> Optional[float]:
    for value in (vram_gb, model_gb):
        if value is not None and value > 0:
            return float(value)
    return None


def compute_yield(
    tps: Optional[float],
    vram_gb: Optional[float] = None,
    model_gb: Optional[float] = None,
    parallel: Optional[int] = None,
) -> Optional[float]:
    """Resource yield: tps ÷ (resource_gb × parallel). Higher is better."""
    if tps is None or not math.isfinite(float(tps)) or float(tps) <= 0:
        return None
    gb = resource_gb(vram_gb, model_gb)
    try:
        slots = int(parallel) if parallel and int(parallel) > 0 else 1
    except (TypeError, ValueError):
        slots = 1
    if gb is None:
        return None
    denom = gb * slots
    if denom <= 0:
        return None
    return round(float(tps) / denom, 4)


def ttl_label(ttl_ms: Any) -> str:
    if ttl_ms is None:
        return "pinned"
    try:
        ms = int(ttl_ms)
    except (TypeError, ValueError):
        return "off"
    if ms <= 0:
        return "pinned"
    if ms >= 3_600_000:
        return f"{ms // 3_600_000}h"
    if ms >= 60_000:
        return f"{ms // 60_000}m"
    return f"{ms // 1000}s"


def ctx_k_from_tokens(context_length: Any) -> Optional[int]:
    try:
        tokens = int(context_length)
    except (TypeError, ValueError):
        return None
    if tokens <= 0:
        return None
    return max(1, int(round(tokens / 1000.0)))


def model_gb_from_bytes(size_bytes: Any) -> Optional[float]:
    try:
        n = int(size_bytes)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return round(n / (1024 ** 3), 2)


def load_usage_map(path: Path) -> dict:
    try:
        data = json.loads(path.read_text())
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): str(v) for k, v in data.items()}


def infer_usage(model: str, host: str, usage_map: Optional[dict] = None) -> str:
    usage_map = usage_map or {}
    if model in usage_map:
        return usage_map[model]
    key = f"{host}:{model}"
    if key in usage_map:
        return usage_map[key]
    mid = (model or "").lower()
    if "embed" in mid or "nomic" in mid:
        return "embeddings"
    if "supergemma" in mid:
        return "dialectic"
    if "35b" in mid or "distill" in mid:
        return "aggregator"
    if "27b" in mid or "qwen3.6-27" in mid:
        host_l = (host or "").lower()
        if "pomp" in host_l:
            return "deriver"
        return "MoA ref"
    return "loaded"


def read_hermes_knobs(config_path: Path) -> str:
    """Best-effort lean knobs from config.yaml without requiring PyYAML."""
    try:
        text = config_path.read_text()
    except Exception:
        return ""
    parts = []
    for key in ("max_turns", "max_tokens"):
        m = re.search(rf"(?m)^\s*{key}:\s*(\d+)\s*$", text)
        if m:
            short = "turns" if key == "max_turns" else "tok"
            parts.append(f"{short}={m.group(1)}")
    return " · ".join(parts)


def read_active_experiment(path: Path) -> str:
    try:
        label = path.read_text().strip()
    except Exception:
        return ""
    return label[:80]


def normalize_benchmark_sample(rec: dict, host: str) -> dict:
    """Flatten a forwarder benchmark_sample into table row shape."""
    tps = rec.get("tps")
    vram_gb = rec.get("vram_gb")
    model_gb = rec.get("model_gb")
    parallel = rec.get("parallel")
    try:
        parallel_i = int(parallel) if parallel is not None else None
    except (TypeError, ValueError):
        parallel_i = None
    y = rec.get("yield")
    if y is None:
        y = compute_yield(tps, vram_gb=vram_gb, model_gb=model_gb, parallel=parallel_i)
    experiment = (rec.get("experiment") or "").strip()
    named = bool(rec.get("named"))
    if experiment and experiment not in ("auto", "—", "-"):
        named = True
    elif not experiment:
        experiment = "auto"
        named = False
    return {
        "ts": float(rec.get("ts") or time.time()),
        "host": rec.get("host") or host,
        "usage": rec.get("usage") or "loaded",
        "model": rec.get("model") or "",
        "ctx_k": rec.get("ctx_k"),
        "parallel": parallel_i,
        "ttl": rec.get("ttl") or "",
        "offload": rec.get("offload") or "",
        "hermes_knobs": rec.get("hermes_knobs") or "",
        "tps": tps,
        "p50_s": rec.get("p50_s"),
        "vram_gb": vram_gb,
        "model_gb": model_gb,
        "cpu_load": rec.get("cpu_load"),
        "mem_used_gb": rec.get("mem_used_gb"),
        "mem_total_gb": rec.get("mem_total_gb"),
        "power_w": rec.get("power_w"),
        "yield": y,
        "experiment": experiment,
        "named": 1 if named else 0,
    }


def best_by_usage_host(rows: list[dict]) -> list[dict]:
    """Highest yield per (usage, host); skips null yields."""
    winners: dict[tuple, dict] = {}
    for row in rows:
        y = row.get("yield")
        if y is None:
            continue
        key = (row.get("usage") or "loaded", row.get("host") or "")
        prev = winners.get(key)
        if prev is None or float(y) > float(prev.get("yield") or 0):
            winners[key] = row
    out = list(winners.values())
    out.sort(key=lambda r: (-float(r.get("yield") or 0), r.get("usage") or "", r.get("host") or ""))
    return out


def current_by_usage_host(rows: list[dict]) -> dict[tuple, dict]:
    """Latest sample per (usage, host)."""
    latest: dict[tuple, dict] = {}
    for row in sorted(rows, key=lambda r: float(r.get("ts") or 0)):
        key = (row.get("usage") or "loaded", row.get("host") or "")
        latest[key] = row
    return latest
