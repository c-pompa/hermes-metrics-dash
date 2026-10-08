# tests/test_harness_lmstudio.py
"""Unit tests for harness.lmstudio — the LM Studio probe client.

Covers:
  * parse_model_info        — pick one model's runtime info from a payload.
  * parse_loaded_config     — normalize to fingerprint keys, unknowns stay None.
  * get_models_payload      — native /api/v0/models GET (network layer, stubbed).
  * list_models             — OpenAI-compatible /v1/models GET (network, stubbed).

No live network: the urllib opener is monkeypatched for every call that would
otherwise hit LM Studio. Py3.9, stdlib only.
"""
import json
import subprocess as sp_mod
import unittest
from unittest import mock

import harness.lmstudio as lmstudio_mod
from harness.lmstudio import (
    get_engine_parallel,
    list_models,
    get_models_payload,
    parse_model_info,
    parse_loaded_config,
)


# Canned /api/v0/models payload — the shape LM Studio 0.4.x actually returns
# (note: `stats` comes back empty in 0.4.x, so we never rely on it).
CANNED = {"object": "list", "data": [{
    "id": "qwen3.8-27b-hermes", "object": "model", "type": "llm",
    "state": "loaded",
    "quantization": "4_bit",
    "max_context_length": 262144,
    "loaded_context_length": 32768,
    "stats": {},  # LM Studio 0.4.x sends empty stats
}]}


class TestParse(unittest.TestCase):
    def test_parse_model_info(self):
        info = parse_model_info(CANNED, "qwen3.8-27b-hermes")
        self.assertEqual(info["state"], "loaded")
        self.assertEqual(info["quantization"], "4_bit")
        self.assertEqual(info["loaded_context_length"], 32768)

    def test_parse_model_info_ignores_other_models(self):
        payload = {"data": [
            CANNED["data"][0],
            {"id": "llama-90b", "state": "unloaded"},
        ]}
        self.assertEqual(parse_model_info(payload, "llama-90b")["state"], "unloaded")

    def test_missing_model_returns_none(self):
        self.assertIsNone(parse_model_info(CANNED, "nope"))

    def test_parse_loaded_config_defaults(self):
        cfg = parse_loaded_config(CANNED)
        self.assertEqual(cfg["context_length"], 32768)
        self.assertIsNone(cfg["gpu_offload"])  # unknown -> None, never guessed

    def test_parse_loaded_config_unknown_levers_stay_none(self):
        cfg = parse_loaded_config(CANNED)
        for key in ("gpu_offload", "kv_quant", "flash_attention", "draft_model"):
            self.assertIsNone(cfg[key])

    def test_parse_loaded_config_missing_model_is_safe(self):
        cfg = parse_loaded_config(CANNED, "nope")
        self.assertIsNone(cfg["context_length"])


class _FakeResponse:
    """Minimal stand-in for a urllib response object.

    Supports the context-manager protocol and .read() -> JSON bytes, which is
    all harness.lmstudio._get_json consumes. Keeps tests off the live network.
    """

    def __init__(self, payload):
        self._body = json.dumps(payload).encode()

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class TestProbeNetwork(unittest.TestCase):
    """Exercise the urlopen calls with a stubbed opener — never live."""

    def test_get_models_payload_builds_native_url(self):
        seen = {}

        def fake_urlopen(url, timeout=5):
            seen["url"] = url
            return _FakeResponse(CANNED)

        with mock.patch("harness.lmstudio.urllib.request.urlopen",
                        side_effect=fake_urlopen):
            payload = get_models_payload("http://192.0.2.20:1234/")

        self.assertEqual(seen["url"], "http://192.0.2.20:1234/api/v0/models")
        self.assertEqual(payload["data"][0]["id"], "qwen3.8-27b-hermes")

    def test_list_models_extracts_ids(self):
        v1 = {"object": "list", "data": [
            {"id": "qwen3.8-27b-hermes"},
            {"id": "llama-90b"},
        ]}

        def fake_urlopen(url, timeout=5):
            self.assertEqual(url, "http://127.0.0.1:1234/v1/models")
            return _FakeResponse(v1)

        with mock.patch("harness.lmstudio.urllib.request.urlopen",
                        side_effect=fake_urlopen):
            ids = list_models()  # default BASE -> http://127.0.0.1:1234

        self.assertEqual(ids, ["qwen3.8-27b-hermes", "llama-90b"])


class TestGetEngineParallel(unittest.TestCase):
    """H-8: parallel enters the fp via `lms ps --json`; primary instance wins."""

    def setUp(self):
        # Pretend the CLI is installed so these run on hosts (and CI) without LM Studio.
        which = mock.patch.object(lmstudio_mod.shutil, "which", return_value="/usr/local/bin/lms")
        which.start()
        self.addCleanup(which.stop)

    def _ps(self, entries):
        return mock.patch.object(
            lmstudio_mod.subprocess, "run",
            return_value=sp_mod.CompletedProcess([], 0, stdout=json.dumps(entries)))

    def test_prefers_primary_over_suffix_instances(self):
        """`model:2` siblings exist during JIT churn; the primary serves the id."""
        entries = [
            {"identifier": "qwen3.8-27b-hermes", "contextLength": 87040, "parallel": 1},
            {"identifier": "qwen3.8-27b-hermes:2", "contextLength": 87040, "parallel": 2},
        ]
        with self._ps(entries):
            self.assertEqual(get_engine_parallel("qwen3.8-27b-hermes"), 1)

    def test_falls_back_to_suffix_instance_without_primary(self):
        entries = [
            {"identifier": "qwen3.8-27b-hermes:2", "contextLength": 8192, "parallel": 4},
            {"identifier": "qwen3.8-27b-hermes:3", "contextLength": 87040, "parallel": 2},
        ]
        with self._ps(entries):
            self.assertEqual(get_engine_parallel("qwen3.8-27b-hermes"), 2)

    def test_absent_model_and_bad_cli_degrade_to_none(self):
        with self._ps([{"identifier": "other-model", "parallel": 3}]):
            self.assertIsNone(get_engine_parallel("qwen3.8-27b-hermes"))
        with mock.patch.object(lmstudio_mod.subprocess, "run",
                               side_effect=OSError("no lms")):
            self.assertIsNone(get_engine_parallel("qwen3.8-27b-hermes"))


if __name__ == "__main__":
    unittest.main()
