#!/usr/bin/env python3
"""Hermes environment mode profiles for the metrics dashboard.

Applies named config modes to Mini (and optionally MBP) Hermes config.yaml:
  - optimized-moa
  - single-model
  - restore-current
"""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import yaml

# Serializes apply_mode: the HTTP server is threaded, and concurrent applies
# (e.g. a double-click during the slow SSH sync) could interleave the
# read-modify-write of config.yaml and produce a config matching no mode.
_APPLY_LOCK = threading.Lock()

MODE_OPTIMIZED = "optimized-moa"
MODE_SINGLE = "single-model"
MODE_RESTORE = "restore-current"

MODES = (
    {"id": MODE_OPTIMIZED, "label": "Optimized MoA"},
    {"id": MODE_SINGLE, "label": "Single-model"},
    {"id": MODE_RESTORE, "label": "Restore current"},
)

MODE_IDS = {m["id"] for m in MODES}

MIN_CONTEXT_LENGTH = 64000
# MoA compression floor: how many trailing messages stay uncompressed.
PROTECT_LAST_N = 6
# Router-era MoA token budget for the MoA panel (refs + aggregator).
MOA_MAX_TOKENS = 4096
# Single-model and MoA modes run the same loop guard (unified 2026-08:
# long tool-heavy chains need the headroom in both modes).
SINGLE_MAX_TURNS = 150
MOA_MAX_TURNS = SINGLE_MAX_TURNS

DEFAULT_MBP_SSH = os.environ.get("ENV_MODE_MBP_SSH", "")
DEFAULT_MBP_CONFIG = os.environ.get("ENV_MODE_MBP_CONFIG", "~/.hermes/config.yaml")
DEFAULT_MBP_IDENTITY = os.environ.get(
    "ENV_MODE_MBP_IDENTITY",
    os.path.expanduser("~/.ssh/id_ed25519"),
)
DEFAULT_MINI_CONFIG = os.environ.get(
    "ENV_MODE_MINI_CONFIG", os.path.expanduser("~/.hermes/config.yaml")
)
DEFAULT_STATE_DIR = os.environ.get(
    "ENV_MODE_STATE_DIR", os.path.expanduser("~/.hermes/metrics/env-modes")
)
DEFAULT_BACKUP_ROOT = os.environ.get(
    "ENV_MODE_BACKUP_ROOT", os.path.expanduser("~/.hermes/backups")
)

SINGLE_MODEL_ID = "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5"
# Host-local LM Studio. Mini (primary agent) and MBP (fallback-only) both use
# loopback so each machine talks to its own LMS; do not hardcode the peer LAN IP.
SINGLE_BASE_URL = "http://127.0.0.1:1234/v1"

REMOTE_APPLY_SCRIPT = Path(__file__).resolve().parent / "scripts" / "env_mode_remote_apply.py"


def state_paths(state_dir: str | Path = None) -> Dict[str, Path]:
    root = Path(state_dir or DEFAULT_STATE_DIR)
    return {
        "root": root,
        "baseline": root / "baseline-config.snippet.json",
        "active": root / "active-mode.json",
    }


def ensure_state_dir(state_dir: str | Path = None) -> Dict[str, Path]:
    paths = state_paths(state_dir)
    paths["root"].mkdir(parents=True, exist_ok=True)
    return paths


def load_yaml(path: str | Path) -> dict:
    data = yaml.safe_load(Path(path).read_text()) or {}
    if not isinstance(data, dict):
        raise ValueError(f"config root must be a mapping: {path}")
    return data


def dump_yaml(path: str | Path, data: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = yaml.safe_dump(data, default_flow_style=False, sort_keys=False)
    # Atomic replace: a crash mid-write must not truncate the live config.
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def _ensure_context_length(model: dict) -> None:
    current = model.get("context_length")
    try:
        value = int(current) if current is not None else MIN_CONTEXT_LENGTH
    except (TypeError, ValueError):
        value = MIN_CONTEXT_LENGTH
    model["context_length"] = max(value, MIN_CONTEXT_LENGTH)


def baseline_snippet_from_config(cfg: dict) -> dict:
    """Capture the managed subset used by restore-current."""
    model = dict(cfg.get("model") or {})
    compression = dict(cfg.get("compression") or {})
    moa = dict(cfg.get("moa") or {})
    agent = dict(cfg.get("agent") or {})
    _ensure_context_length(model)
    return {
        "model": {
            "provider": model.get("provider", "lmstudio"),
            "default": model.get("default", "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5"),
            "base_url": model.get("base_url", "http://127.0.0.1:1234/v1"),
            "max_tokens": model.get("max_tokens", 8192),
            "context_length": model.get("context_length", MIN_CONTEXT_LENGTH),
        },
        "compression": {
            "threshold": compression.get("threshold", 0.5),
            "protect_last_n": compression.get("protect_last_n", PROTECT_LAST_N),
        },
        "moa": {
            "default_preset": moa.get("default_preset", "lan"),
            "max_tokens": moa.get("max_tokens", 2048),
        },
        "agent": {
            "max_turns": agent.get("max_turns", 150),
        },
        "moa_preset_test_max_tokens": (
            ((moa.get("presets") or {}).get("test") or {}).get("max_tokens")
        ),
    }


def seed_baseline_if_missing(
    cfg: dict, state_dir: str | Path = None, force: bool = False
) -> dict:
    paths = ensure_state_dir(state_dir)
    if paths["baseline"].exists() and not force:
        return json.loads(paths["baseline"].read_text())
    snippet = baseline_snippet_from_config(cfg)
    _ensure_context_length(snippet["model"])
    paths["baseline"].write_text(json.dumps(snippet, indent=2) + "\n")
    return snippet


def read_baseline(state_dir: str | Path = None) -> Optional[dict]:
    paths = state_paths(state_dir)
    if not paths["baseline"].exists():
        return None
    return json.loads(paths["baseline"].read_text())


def read_active_mode(state_dir: str | Path = None) -> str:
    paths = state_paths(state_dir)
    if not paths["active"].exists():
        return MODE_RESTORE
    try:
        data = json.loads(paths["active"].read_text())
        mode = data.get("mode")
        return mode if mode in MODE_IDS else MODE_RESTORE
    except (OSError, json.JSONDecodeError, TypeError):
        return MODE_RESTORE


def write_active_mode(mode: str, state_dir: str | Path = None) -> None:
    if mode not in MODE_IDS:
        raise ValueError(f"unknown mode: {mode}")
    paths = ensure_state_dir(state_dir)
    paths["active"].write_text(
        json.dumps({"mode": mode, "ts": time.time()}, indent=2) + "\n"
    )


def apply_mode_to_config(cfg: dict, mode: str, baseline: dict = None) -> dict:
    """Return a deep-copied config with the named mode applied.

    NOTE: scripts/env_mode_remote_apply.py delegates to this function (it is
    scp'd to the remote host alongside env_mode.py), so Mini and MBP cannot
    diverge.
    """
    if mode not in MODE_IDS:
        raise ValueError(f"unknown mode: {mode}")
    out = deepcopy(cfg)
    model = out.setdefault("model", {})
    compression = out.setdefault("compression", {})
    moa = out.setdefault("moa", {})
    agent = out.setdefault("agent", {})
    presets = moa.setdefault("presets", {})
    test_preset = presets.setdefault("test", {})

    if mode == MODE_OPTIMIZED:
        # Router-era MoA (2026-07-27): provider/model routing stays as
        # configured; the mode only enables the MoA panel with the router-role
        # `lan` preset (moa-ref-a/b/c + moa-agg via the model-router).
        compression["threshold"] = 0.4
        compression["protect_last_n"] = PROTECT_LAST_N
        moa["enabled"] = True
        moa["default_preset"] = "lan"
        moa["max_tokens"] = MOA_MAX_TOKENS
        agent["max_turns"] = MOA_MAX_TURNS
        _ensure_context_length(model)
        return out

    if mode == MODE_SINGLE:
        model["provider"] = "lmstudio"
        model["default"] = SINGLE_MODEL_ID
        model["base_url"] = SINGLE_BASE_URL
        agent["max_turns"] = SINGLE_MAX_TURNS
        _ensure_context_length(model)
        return out

    base = baseline or {}
    b_model = base.get("model") or {}
    b_comp = base.get("compression") or {}
    b_moa = base.get("moa") or {}
    b_agent = base.get("agent") or {}
    model["provider"] = b_model.get("provider", "lmstudio")
    model["default"] = b_model.get("default", "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5")
    model["base_url"] = b_model.get("base_url", "http://127.0.0.1:1234/v1")
    if "max_tokens" in b_model:
        model["max_tokens"] = b_model["max_tokens"]
    model["context_length"] = max(
        int(b_model.get("context_length") or MIN_CONTEXT_LENGTH),
        MIN_CONTEXT_LENGTH,
    )
    compression["threshold"] = b_comp.get("threshold", 0.5)
    compression["protect_last_n"] = b_comp.get("protect_last_n", PROTECT_LAST_N)
    moa["default_preset"] = b_moa.get("default_preset", "lan")
    moa["max_tokens"] = b_moa.get("max_tokens", 2048)
    if base.get("moa_preset_test_max_tokens") is not None:
        test_preset["max_tokens"] = base["moa_preset_test_max_tokens"]
    elif "max_tokens" not in test_preset:
        test_preset["max_tokens"] = moa["max_tokens"]
    agent["max_turns"] = b_agent.get("max_turns", 150)
    return out


def managed_paths(cfg: dict) -> Dict[str, Any]:
    """Subset of config keys managed by env modes, flattened for diffs."""
    model = cfg.get("model") or {}
    compression = cfg.get("compression") or {}
    moa = cfg.get("moa") or {}
    agent = cfg.get("agent") or {}
    test_preset = ((moa.get("presets") or {}).get("test") or {})
    return {
        "model.provider": model.get("provider"),
        "model.default": model.get("default"),
        "model.base_url": model.get("base_url"),
        "model.max_tokens": model.get("max_tokens"),
        "model.context_length": model.get("context_length"),
        "compression.threshold": compression.get("threshold"),
        "compression.protect_last_n": compression.get("protect_last_n"),
        "moa.default_preset": moa.get("default_preset"),
        "moa.max_tokens": moa.get("max_tokens"),
        "moa.presets.test.max_tokens": test_preset.get("max_tokens"),
        "agent.max_turns": agent.get("max_turns"),
    }


def diff_managed(before_cfg: dict, after_cfg: dict) -> List[Dict[str, Any]]:
    before = managed_paths(before_cfg)
    after = managed_paths(after_cfg)
    keys = sorted(set(before) | set(after))
    changes = []
    for key in keys:
        left = before.get(key)
        right = after.get(key)
        if left != right:
            changes.append({"path": key, "from": left, "to": right})
    return changes


def read_active_mode_detail(state_dir: str | Path = None) -> tuple:
    """Return (mode, ts) from the active-mode marker (ts None if unknown)."""
    paths = state_paths(state_dir)
    if not paths["active"].exists():
        return MODE_RESTORE, None
    try:
        data = json.loads(paths["active"].read_text())
        mode = data.get("mode")
        ts = data.get("ts")
        return (mode if mode in MODE_IDS else MODE_RESTORE), ts
    except (OSError, json.JSONDecodeError, TypeError):
        return MODE_RESTORE, None


def status(
    config_path: str | Path = None,
    state_dir: str | Path = None,
) -> dict:
    path = Path(config_path or DEFAULT_MINI_CONFIG)
    paths = state_paths(state_dir)
    mode, mode_ts = read_active_mode_detail(state_dir)
    return {
        "active_mode": mode,
        "active_mode_ts": mode_ts,
        "modes": list(MODES),
        "baseline_present": paths["baseline"].exists(),
        "config_path": str(path),
        "config_exists": path.exists(),
    }


def preview(
    mode: str,
    config_path: str | Path = None,
    state_dir: str | Path = None,
) -> dict:
    if mode not in MODE_IDS:
        raise ValueError(f"unknown mode: {mode}")
    path = Path(config_path or DEFAULT_MINI_CONFIG)
    cfg = load_yaml(path)
    baseline = read_baseline(state_dir)
    if mode == MODE_RESTORE and baseline is None:
        baseline = baseline_snippet_from_config(cfg)
    after = apply_mode_to_config(cfg, mode, baseline=baseline)
    return {
        "mode": mode,
        "diff": diff_managed(cfg, after),
        "active_mode": read_active_mode(state_dir),
    }


def backup_config(config_path: Path, mode: str, backup_root: str | Path = None) -> Path:
    root = Path(backup_root or DEFAULT_BACKUP_ROOT)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest_dir = root / f"{stamp}-env-mode-{mode}"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / "config.yaml"
    shutil.copy2(config_path, dest)
    return dest


def apply_mode(mode: str, confirm: str, **kwargs) -> dict:
    """Apply a mode, serialized against concurrent applies (see _APPLY_LOCK)."""
    with _APPLY_LOCK:
        return _apply_mode(mode, confirm, **kwargs)


def _apply_mode(
    mode: str,
    confirm: str,
    *,
    config_path: str | Path = None,
    state_dir: str | Path = None,
    backup_root: str | Path = None,
    sync_mbp: bool = True,
    restart_gateway: bool = True,
    mbp_ssh: str = None,
    mbp_config: str = None,
    runner: Callable = None,
) -> dict:
    """Apply a mode to Mini config, optionally sync MBP and restart gateway."""
    if mode not in MODE_IDS:
        raise ValueError(f"unknown mode: {mode}")
    if confirm != mode:
        raise ValueError("confirm must exactly match mode")

    path = Path(config_path or DEFAULT_MINI_CONFIG)
    if not path.exists():
        raise FileNotFoundError(f"config not found: {path}")

    cfg = load_yaml(path)
    ensure_state_dir(state_dir)
    baseline = seed_baseline_if_missing(cfg, state_dir=state_dir)
    after = apply_mode_to_config(cfg, mode, baseline=baseline)
    changes = diff_managed(cfg, after)
    backup = backup_config(path, mode, backup_root=backup_root)
    dump_yaml(path, after)
    write_active_mode(mode, state_dir=state_dir)

    result = {
        "ok": True,
        "mode": mode,
        "diff": changes,
        "backup": str(backup),
        "hosts": {"mini": {"ok": True, "path": str(path)}},
        "partial": False,
    }

    mbp_ssh = mbp_ssh or DEFAULT_MBP_SSH
    if sync_mbp and not mbp_ssh:
        result["hosts"]["mbp"] = {"ok": True, "skipped": "ENV_MODE_MBP_SSH not set"}
    elif sync_mbp:
        try:
            sync_result = sync_mode_to_mbp(
                mode,
                baseline=baseline,
                mbp_ssh=mbp_ssh,
                mbp_config=mbp_config or DEFAULT_MBP_CONFIG,
                runner=runner,
            )
            result["hosts"]["mbp"] = sync_result
        except Exception as exc:
            result["ok"] = False
            result["partial"] = True
            result["hosts"]["mbp"] = {"ok": False, "error": str(exc)}

    if restart_gateway:
        try:
            restart_mini_gateway(runner=runner)
            result["gateway_restart"] = {"ok": True}
        except Exception as exc:
            result["ok"] = False
            result["partial"] = True
            result["gateway_restart"] = {"ok": False, "error": str(exc)}

    return result


def sync_mode_to_mbp(
    mode: str,
    *,
    baseline: dict,
    mbp_ssh: str,
    mbp_config: str,
    mbp_identity: str = None,
    runner: Callable = None,
) -> dict:
    """SSH to MBP and run scripts/env_mode_remote_apply.py against its config."""
    run = runner or subprocess.run
    if not mbp_ssh:
        raise RuntimeError("no MBP SSH target: set ENV_MODE_MBP_SSH (user@host)")
    if not REMOTE_APPLY_SCRIPT.is_file():
        raise FileNotFoundError(f"missing remote apply script: {REMOTE_APPLY_SCRIPT}")

    remote_path = "/tmp/hermes-env-mode-remote-apply.py"
    remote_dir = "/tmp"
    ENV_MODE_FILE = Path(__file__).resolve()
    payload = json.dumps({"mode": mode, "baseline": baseline, "config": mbp_config})
    identity = mbp_identity or DEFAULT_MBP_IDENTITY
    ssh_base = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]
    if identity and Path(identity).is_file():
        ssh_base = ["-i", identity, "-o", "IdentitiesOnly=yes", *ssh_base]

    scp = run(
        ["scp", *ssh_base, str(REMOTE_APPLY_SCRIPT), str(ENV_MODE_FILE),
         f"{mbp_ssh}:{remote_dir}"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if scp.returncode != 0:
        err = (scp.stderr or scp.stdout or "").strip()
        raise RuntimeError(f"MBP scp failed: {err or scp.returncode}")

    # One remote argv string, shell-quoted: OpenSSH runs the remote command via
    # the user shell, so raw JSON braces break zsh ("parse error near `}'").
    remote_cmd = f"python3 {shlex.quote(remote_path)} {shlex.quote(payload)}"
    completed = run(
        ["ssh", *ssh_base, mbp_ssh, remote_cmd],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"MBP sync failed: {err or completed.returncode}")
    return {"ok": True, "ssh": mbp_ssh, "path": mbp_config, "identity": identity}


def restart_mini_gateway(runner: Callable = None) -> None:
    run = runner or subprocess.run
    uid = os.getuid()
    completed = run(
        ["launchctl", "kickstart", "-k", f"gui/{uid}/ai.hermes.gateway"],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if completed.returncode != 0:
        err = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"gateway restart failed: {err or completed.returncode}")
