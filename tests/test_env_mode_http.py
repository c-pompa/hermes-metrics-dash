#!/usr/bin/env python3
"""HTTP smoke tests for /api/env-mode confirm gate and apply against fixtures."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]

SAMPLE = {
    "model": {
        "provider": "moa",
        "default": "test",
        "base_url": "moa://local",
        "max_tokens": 8192,
        "context_length": 64000,
    },
    "compression": {
        "enabled": True,
        "threshold": 0.5,
        "protect_last_n": 20,
    },
    "moa": {
        "default_preset": "test",
        "max_tokens": 2048,
        "presets": {"test": {"enabled": True, "max_tokens": 2048}},
    },
    "agent": {"max_turns": 30},
}


def allocate_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_json(url):
    with urllib.request.urlopen(url, timeout=3) as response:
        return response.status, json.load(response)


def post_json(url, payload):
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": "Bearer test-admin-token"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {"error": body}
        return err.code, data


class EnvModeHttpSmokeTest(unittest.TestCase):
    def test_env_mode_get_preview_and_confirm_gate(self):
        port = allocate_local_port()
        base_url = f"http://127.0.0.1:{port}"
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            cfg = root / "config.yaml"
            cfg.write_text(yaml.safe_dump(SAMPLE))
            state = root / "state"
            backups = root / "backups"
            db_path = root / "smoke.db"
            env = os.environ.copy()
            env.update(
                {
                    "ENV_MODE_MINI_CONFIG": str(cfg),
                    "ENV_MODE_STATE_DIR": str(state),
                    "ENV_MODE_BACKUP_ROOT": str(backups),
                    "ENV_MODE_MBP_SSH": "skip@invalid",
                    "METRICS_ADMIN_TOKEN": "test-admin-token",
                }
            )
            process = subprocess.Popen(
                [
                    sys.executable,
                    str(ROOT / "app.py"),
                    "--bind",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--db",
                    str(db_path),
                ],
                cwd=ROOT,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                deadline = time.monotonic() + 10
                while True:
                    if process.poll() is not None:
                        output = process.stdout.read()
                        self.fail(f"app.py exited before healthy:\n{output}")
                    try:
                        get_json(base_url + "/health")
                        break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() >= deadline:
                            self.fail("app.py did not become healthy")
                        time.sleep(0.05)

                status_code, status = get_json(base_url + "/api/env-mode")
                self.assertEqual(status_code, 200)
                self.assertIn("active_mode", status)
                self.assertEqual(len(status["modes"]), 3)

                preview_code, preview = get_json(
                    base_url + "/api/env-mode/preview?mode=optimized-moa"
                )
                self.assertEqual(preview_code, 200)
                paths = {row["path"] for row in preview["diff"]}
                self.assertIn("compression.threshold", paths)

                bad_code, bad = post_json(
                    base_url + "/api/env-mode",
                    {"mode": "optimized-moa", "confirm": "nope"},
                )
                self.assertEqual(bad_code, 400)
                self.assertIn("confirm", (bad.get("error") or "").lower())

                # Avoid live SSH/gateway: apply via module path is covered in
                # unit tests. Here we only assert the HTTP confirm gate + GET.
                written = yaml.safe_load(cfg.read_text())
                self.assertEqual(written["compression"]["threshold"], 0.5)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)


if __name__ == "__main__":
    unittest.main()
