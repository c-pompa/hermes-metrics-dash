#!/usr/bin/env python3
"""Unit tests for Hermes env-mode profiles."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

import env_mode


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
        "target_ratio": 0.2,
    },
    "moa": {
        "default_preset": "test",
        "max_tokens": 2048,
        "presets": {
            "test": {
                "enabled": True,
                "max_tokens": 2048,
                "aggregator": {"provider": "lmstudio", "model": "keep-me"},
            }
        },
    },
    "agent": {"max_turns": 30, "verbose": False},
}


class EnvModeUnitTests(unittest.TestCase):
    def test_optimized_moa_changes_managed_knobs_only(self):
        after = env_mode.apply_mode_to_config(SAMPLE, env_mode.MODE_OPTIMIZED)
        self.assertEqual(after["compression"]["threshold"], 0.4)
        self.assertEqual(after["compression"]["protect_last_n"], env_mode.PROTECT_LAST_N)
        self.assertEqual(after["moa"]["max_tokens"], env_mode.MOA_MAX_TOKENS)
        self.assertEqual(after["moa"]["presets"]["test"]["max_tokens"],
                         SAMPLE["moa"]["presets"]["test"]["max_tokens"])
        self.assertEqual(after["model"]["provider"], "moa")
        self.assertEqual(after["moa"]["presets"]["test"]["aggregator"]["model"], "keep-me")
        self.assertGreaterEqual(after["model"]["context_length"], 64000)
        self.assertEqual(after["agent"]["max_turns"], env_mode.MOA_MAX_TURNS)

    def test_single_model_keeps_moa_block(self):
        after = env_mode.apply_mode_to_config(SAMPLE, env_mode.MODE_SINGLE)
        self.assertEqual(after["model"]["provider"], "lmstudio")
        self.assertEqual(after["model"]["default"], env_mode.SINGLE_MODEL_ID)
        self.assertEqual(after["model"]["base_url"], env_mode.SINGLE_BASE_URL)
        self.assertEqual(after["model"]["base_url"], "http://127.0.0.1:1234/v1")
        self.assertIn("presets", after["moa"])
        self.assertEqual(after["moa"]["presets"]["test"]["aggregator"]["model"], "keep-me")

    def test_single_model_raises_max_turns(self):
        after = env_mode.apply_mode_to_config(SAMPLE, env_mode.MODE_SINGLE)
        self.assertEqual(after["agent"]["max_turns"], env_mode.SINGLE_MAX_TURNS)

    def test_optimized_moa_resets_max_turns_after_single(self):
        single = env_mode.apply_mode_to_config(SAMPLE, env_mode.MODE_SINGLE)
        self.assertEqual(single["agent"]["max_turns"], env_mode.SINGLE_MAX_TURNS)
        after = env_mode.apply_mode_to_config(single, env_mode.MODE_OPTIMIZED)
        self.assertEqual(after["agent"]["max_turns"], env_mode.MOA_MAX_TURNS)

    def test_restore_uses_baseline(self):
        baseline = env_mode.baseline_snippet_from_config(SAMPLE)
        tuned = env_mode.apply_mode_to_config(SAMPLE, env_mode.MODE_OPTIMIZED)
        restored = env_mode.apply_mode_to_config(
            tuned, env_mode.MODE_RESTORE, baseline=baseline
        )
        self.assertEqual(restored["compression"]["threshold"], 0.5)
        self.assertEqual(restored["compression"]["protect_last_n"], 20)
        self.assertEqual(restored["moa"]["max_tokens"], 2048)
        self.assertEqual(restored["model"]["provider"], "moa")
        self.assertEqual(restored["agent"]["max_turns"], 30)

    def test_diff_lists_changed_paths(self):
        after = env_mode.apply_mode_to_config(SAMPLE, env_mode.MODE_OPTIMIZED)
        diff = env_mode.diff_managed(SAMPLE, after)
        paths = {row["path"] for row in diff}
        self.assertIn("compression.threshold", paths)
        self.assertIn("moa.max_tokens", paths)

    def test_apply_requires_confirm_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "config.yaml"
            cfg.write_text(yaml.safe_dump(SAMPLE))
            with self.assertRaises(ValueError):
                env_mode.apply_mode(
                    env_mode.MODE_OPTIMIZED,
                    "nope",
                    config_path=cfg,
                    state_dir=root / "state",
                    backup_root=root / "backups",
                    sync_mbp=False,
                    restart_gateway=False,
                )

    def test_apply_writes_config_and_active_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "config.yaml"
            cfg.write_text(yaml.safe_dump(SAMPLE))
            result = env_mode.apply_mode(
                env_mode.MODE_OPTIMIZED,
                env_mode.MODE_OPTIMIZED,
                config_path=cfg,
                state_dir=root / "state",
                backup_root=root / "backups",
                sync_mbp=False,
                restart_gateway=False,
            )
            self.assertTrue(result["ok"])
            written = yaml.safe_load(cfg.read_text())
            self.assertEqual(written["compression"]["threshold"], 0.4)
            self.assertEqual(env_mode.read_active_mode(root / "state"), env_mode.MODE_OPTIMIZED)
            self.assertTrue((root / "state" / "baseline-config.snippet.json").exists())

    def test_context_length_never_below_minimum(self):
        sample = json.loads(json.dumps(SAMPLE))
        sample["model"]["context_length"] = 1000
        after = env_mode.apply_mode_to_config(sample, env_mode.MODE_SINGLE)
        self.assertGreaterEqual(after["model"]["context_length"], 64000)

    def test_restart_gateway_uses_launchctl(self):
        calls = []

        def runner(cmd, **kwargs):
            calls.append(cmd)
            return mock.Mock(returncode=0, stdout="", stderr="")

        env_mode.restart_mini_gateway(runner=runner)
        self.assertEqual(calls[0][0], "launchctl")
        self.assertEqual(calls[0][1], "kickstart")

    def test_sync_uses_identity_file_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            identity = root / "id_ed25519"
            identity.write_text("dummy")
            script = root / "scripts" / "env_mode_remote_apply.py"
            script.parent.mkdir(parents=True)
            script.write_text("print('ok')\n")
            calls = []

            def runner(cmd, **kwargs):
                calls.append(cmd)
                return mock.Mock(returncode=0, stdout="OK", stderr="")

            with mock.patch.object(env_mode, "REMOTE_APPLY_SCRIPT", script):
                env_mode.sync_mode_to_mbp(
                    env_mode.MODE_OPTIMIZED,
                    baseline={},
                    mbp_ssh="user@host",
                    mbp_config="~/.hermes/config.yaml",
                    mbp_identity=str(identity),
                    runner=runner,
                )
            self.assertEqual(calls[0][0], "scp")
            self.assertIn("-i", calls[0])
            self.assertIn(str(identity), calls[0])
            self.assertIn("IdentitiesOnly=yes", calls[0])
            self.assertEqual(calls[1][0], "ssh")
            # Remote command must be one shell-quoted string (JSON-safe for zsh).
            remote_cmd = calls[1][-1]
            self.assertIsInstance(remote_cmd, str)
            self.assertTrue(remote_cmd.startswith("python3 "))
            self.assertIn("optimized-moa", remote_cmd)
            self.assertEqual(calls[1].count("user@host"), 1)

    def test_apply_without_an_mbp_target_skips_the_sync(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "config.yaml"
            cfg.write_text(yaml.safe_dump(SAMPLE))
            runner = mock.Mock()
            with mock.patch.object(env_mode, "DEFAULT_MBP_SSH", ""):
                result = env_mode.apply_mode(
                    env_mode.MODE_OPTIMIZED, env_mode.MODE_OPTIMIZED, config_path=cfg,
                    state_dir=root / "state", backup_root=root / "backups",
                    restart_gateway=False, runner=runner)
            self.assertEqual((result["ok"], result["partial"]), (True, False))
            self.assertIn("skipped", result["hosts"]["mbp"])
            runner.assert_not_called()

    def test_sync_without_an_mbp_target_fails_before_running_anything(self):
        runner = mock.Mock()
        with self.assertRaisesRegex(RuntimeError, "ENV_MODE_MBP_SSH"):
            env_mode.sync_mode_to_mbp(env_mode.MODE_OPTIMIZED, baseline={}, mbp_ssh="",
                                      mbp_config="~/.hermes/config.yaml", runner=runner)
        runner.assert_not_called()

    def test_status_does_not_write_state(self):
        # GET /api/env-mode is unauthenticated; the baseline is seeded by apply.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = root / "config.yaml"
            cfg.write_text(yaml.safe_dump(SAMPLE))
            state = root / "state"
            status = env_mode.status(config_path=cfg, state_dir=state)
            self.assertFalse(status["baseline_present"])
            self.assertFalse(state.exists())


if __name__ == "__main__":
    unittest.main()
