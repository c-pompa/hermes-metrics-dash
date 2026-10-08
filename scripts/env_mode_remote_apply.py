#!/usr/bin/env python3
"""Apply a Hermes env-mode patch on a remote host.

Usage:
  python3 env_mode_remote_apply.py '{"mode":"optimized-moa","baseline":{...},"config":"~/.hermes/config.yaml"}'

Delegates all patch logic to env_mode.apply_mode_to_config. sync_mode_to_mbp
scp's env_mode.py next to this script before running it, so Mini and MBP share
one implementation (no more mirrored branches to keep in sync).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import time
from pathlib import Path

import yaml

# env_mode.py ships alongside this script (same /tmp dir on the remote host);
# in a repo checkout it sits one level up (scripts/ vs repo root).
_HERE = str(Path(__file__).resolve().parent)
_UP = str(Path(__file__).resolve().parent.parent)
for _p in (_HERE, _UP):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import env_mode  # noqa: E402


def apply(mode: str, baseline: dict, config_path: Path) -> None:
    cfg = yaml.safe_load(config_path.read_text()) or {}
    patched = env_mode.apply_mode_to_config(cfg, mode, baseline or {})

    # Backup before overwrite (Mini side does this in env_mode.backup_config).
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup_dir = (
        Path.home() / ".hermes" / "backups" / f"{stamp}-env-mode-{mode}-remote"
    )
    backup_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(config_path, backup_dir / "config.yaml")

    # Atomic replace: a crash mid-write must not truncate the live config.
    tmp = config_path.with_name(config_path.name + ".tmp")
    tmp.write_text(yaml.safe_dump(patched, default_flow_style=False, sort_keys=False))
    os.replace(tmp, config_path)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("expected one JSON payload argument")
    payload = json.loads(sys.argv[1])
    path = Path(payload["config"]).expanduser()
    apply(payload["mode"], payload.get("baseline") or {}, path)
    print("OK")


if __name__ == "__main__":
    main()