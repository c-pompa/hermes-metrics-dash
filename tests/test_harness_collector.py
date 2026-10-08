# tests/test_harness_collector.py
"""Unit tests for harness.collector (plan Task 7 — MBP collector daemon).

The sample cycle has four legs; every one is monkeypatched, so no test
touches the real system:

  * LM Studio probe    harness.collector.get_payload   (Task 2 client)
  * benchmark suite    harness.collector.run_suite     (Task 3, incl. urlopen)
  * host telemetry     harness.collector.snapshot_fn   (Task 4, incl. subprocess)
  * ingest push        harness.collector._post / urllib.request.urlopen

On top of the cycle: build_sample record shape, is_loaded gating (the bench
runs ONLY when LM Studio reports the model loaded), the single-instance flock
(tmpdir — no writes into a real ~/.hermes), the jittered-schedule math, and
main()'s loop with the sleep seam patched (no test ever sleeps for real).

Py3.9, stdlib only; repo convention `python3 -m unittest`.
"""
import json
import os
import tempfile
import unittest
from unittest import mock

import harness.collector as collector
from harness.fingerprint import fingerprint
from harness.lmstudio import parse_loaded_config


MODEL = "qwen3.8-27b-hermes"


def _canned(state="loaded"):
    """Canned /api/v0/models payload (shape per tests/test_harness_lmstudio)."""
    return {"object": "list", "data": [{
        "id": MODEL, "state": state, "quantization": "4_bit",
        "max_context_length": 262144, "loaded_context_length": 32768,
    }]}


def _bench_sample(cls="short_tool", tps=10.5, ttft_s=0.8):
    return {"ttft_s": ttft_s, "tps": tps, "wall_s": 1.2,
            "tokens": 73, "prompt_class": cls}


HOST_STATS = {"thermal": "nominal", "memory_pressure": "none",
              "mem_avail_mb": 4096, "swap_mb": 128, "power_source": "ac"}


class TestBuildSample(unittest.TestCase):
    def test_shape(self):
        with mock.patch.object(collector, "MODEL", MODEL), \
                mock.patch.object(collector, "HOST", "mbp"):
            s = collector.build_sample(_bench_sample(), "abc123def456",
                                       {"context_length": 32768},
                                       HOST_STATS, now=1750000000)
        self.assertEqual(s["event"], "harness_sample")
        self.assertEqual(s["ts"], 1750000000)
        self.assertEqual(s["model"], MODEL)
        self.assertEqual(s["fp"], "abc123def456")
        # config is the *normalized* fingerprint-keyed dict, JSON-encoded.
        self.assertEqual(json.loads(s["config"]), {
            "context_length": 32768, "gpu_offload": None, "kv_quant": None,
            "flash_attention": None, "draft_model": "none", "parallel": None})
        self.assertEqual(s["host"], "mbp")
        # bench metrics + host telemetry merged in.
        self.assertEqual(s["prompt_class"], "short_tool")
        self.assertAlmostEqual(s["tps"], 10.5)
        self.assertEqual(s["thermal"], "nominal")
        self.assertEqual(s["power_source"], "ac")

    def test_input_not_mutated(self):
        src = _bench_sample()
        collector.build_sample(src, "f" * 12, {}, HOST_STATS)
        for key in ("event", "ts", "model", "fp", "config", "host"):
            self.assertNotIn(key, src)

    def test_none_now_uses_real_clock(self):
        s = collector.build_sample(_bench_sample(), "f" * 12, {}, {})
        self.assertIsInstance(s["ts"], int)
        self.assertGreater(s["ts"], 1700000000)   # sanity: post-2023 wallclock


class TestModelState(unittest.TestCase):
    def test_loaded(self):
        self.assertTrue(collector.is_loaded(_canned("loaded")))

    def test_unloaded(self):
        self.assertFalse(collector.is_loaded(_canned("unloaded")))

    def test_missing_model(self):
        self.assertFalse(collector.is_loaded({"data": []}))

    def test_non_dict_payload_safe(self):
        self.assertFalse(collector.is_loaded(None))

    def test_model_state_reports_raw_state(self):
        self.assertEqual(collector.model_state(_canned("unloaded")), "unloaded")


class TestRunCycle(unittest.TestCase):
    """Every leg patched; assert what ran and what was lost per failure mode."""

    def setUp(self):
        self._patches = [
            mock.patch.object(collector, "get_payload",
                              return_value=_canned("loaded")),
            mock.patch.object(collector, "run_suite",
                              return_value=[_bench_sample(),
                                            _bench_sample(cls="long_gen")]),
            mock.patch.object(collector, "snapshot_fn",
                              return_value=dict(HOST_STATS)),
            mock.patch.object(collector, "_post"),
            mock.patch.object(collector, "HOST", "mbp"),
            mock.patch.object(collector, "LMS_BASE", "http://lms-test:1"),
        ]
        for p in self._patches:
            p.start()
        self.get_payload = self._patches[0].start()
        self.run_suite = self._patches[1].start()
        self.snapshot = self._patches[2].start()
        self.post = self._patches[3].start()
        # deterministic fp: parallel comes from the cluster probe, stub it.
        self.get_parallel = mock.patch.object(
            collector.lmstudio, "get_engine_parallel", return_value=2).start()
        self.addCleanup(self.get_parallel.stop)

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def test_cycle_loaded_pushes_all_samples(self):
        summary = collector.run_cycle(now=1750000000)
        self.assertTrue(summary["loaded"])
        self.assertEqual(summary["samples_pushed"], 2)
        # bench ran with the configured model + base + repeats.
        self.assertEqual(self.run_suite.call_args[0][0], MODEL)
        kw = self.run_suite.call_args[1]
        self.assertEqual(kw["base"], "http://lms-test:1")
        self.assertEqual(kw["repeats"], collector.REPEATS)
        # probe used the same base.
        self.assertEqual(self.get_payload.call_args[0], ("http://lms-test:1",))
        # one ingest POST (batch envelope), every bench sample stamped +
        # fingerprinted inside records[].
        self.assertEqual(self.post.call_count, 1)
        # get_engine_parallel is stubbed so the expected fp is deterministic
        # regardless of what the live LM Studio cluster reports.
        base_cfg = parse_loaded_config(_canned("loaded"), MODEL)
        base_cfg["parallel"] = self.get_parallel.return_value
        expected_fp = fingerprint(base_cfg)
        envelope = self.post.call_args[0][1]   # _post(url, obj)
        self.assertEqual(envelope["host"], "mbp")
        records = envelope["records"]
        self.assertEqual(len(records), 2)
        for rec in records:
            self.assertEqual(rec["event"], "harness_sample")
            self.assertEqual(rec["ts"], 1750000000)
            self.assertRegex(rec["fp"], r"^[0-9a-f]{12}$")
            self.assertEqual(rec["fp"], expected_fp)
            self.assertEqual(rec["host"], "mbp")

    def test_cycle_filters_degenerate_placeholders(self):
        """Empty-stream reps (tokens 0, no metrics) are counted as failures,
        never pushed — they used to land as junk rows in sqlite (H-6)."""
        bad = _bench_sample()
        bad.update(tokens=0, tps=None, ttft_s=None)
        self.run_suite.return_value = [_bench_sample(), bad, bad]
        summary = collector.run_cycle(now=1750000000)
        self.assertEqual(summary["samples_pushed"], 1)
        self.assertEqual(summary["reps_failed"], 2)
        records = self.post.call_args[0][1]["records"]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["tokens"], _bench_sample()["tokens"])

    def test_cycle_not_loaded_skips_bench(self):
        self.get_payload.return_value = _canned("unloaded")
        summary = collector.run_cycle()
        self.assertFalse(summary["loaded"])
        self.run_suite.assert_not_called()
        self.post.assert_not_called()

    def test_cycle_probe_error_skips_everything(self):
        self.get_payload.side_effect = RuntimeError("lms down")
        summary = collector.run_cycle()
        self.assertIsNone(summary["loaded"])   # unknown state ≠ unloaded, but still no bench
        self.run_suite.assert_not_called()
        self.post.assert_not_called()

    def test_cycle_telemetry_failure_still_benches(self):
        self.snapshot.side_effect = RuntimeError("no vm_stat")
        summary = collector.run_cycle(now=1750000000)
        self.assertEqual(summary["samples_pushed"], 2)
        rec = self.post.call_args[0][1]["records"][0]
        self.assertNotIn("thermal", rec)   # host keys dropped, bench data kept

    def test_cycle_bench_error_no_push(self):
        self.run_suite.side_effect = RuntimeError("bench boom")
        summary = collector.run_cycle()
        self.post.assert_not_called()
        self.assertEqual(summary["samples_pushed"], 0)

    def test_cycle_push_error_does_not_raise(self):
        self.post.side_effect = RuntimeError("dashboard down")
        summary = collector.run_cycle()   # must not raise (crash-safe)
        self.assertEqual(summary["samples_pushed"], 0)


class TestPush(unittest.TestCase):
    class _Resp:
        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def test_push_posts_batch_envelope_to_ingest(self):
        seen = []

        def fake(req, timeout=15):
            seen.append(req)
            return self._Resp()

        with mock.patch("harness.collector.urllib.request.urlopen",
                        side_effect=fake):
            collector.push([_bench_sample(), _bench_sample(cls="long_gen")],
                           url="http://dash-test/ingest")

        # One POST, batch envelope {"host", "records": [...]} — a flat record
        # gets HTTP 200 from /ingest but silently inserts zero rows.
        self.assertEqual(len(seen), 1)
        req = seen[0]
        self.assertEqual(req.full_url, "http://dash-test/ingest")
        payload = json.loads(req.data.decode())
        self.assertEqual(payload["host"], collector.HOST)
        self.assertEqual(len(payload["records"]), 2)
        for rec in payload["records"]:
            self.assertEqual(rec["event"], "harness_sample")
        classes = [rec["prompt_class"] for rec in payload["records"]]
        self.assertEqual(classes, ["short_tool", "long_gen"])

    def test_push_counts_server_accepted_rows(self):
        class _Resp:
            data = json.dumps({"ok": True, "harness_ingested": 1,
                               "ingested": 1}).encode()

            def read(self):
                return self.data

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        with mock.patch("harness.collector.urllib.request.urlopen",
                        return_value=_Resp()):
            sent = collector.push([_bench_sample(), _bench_sample(cls="long_gen")],
                                  url="http://dash-test/ingest")
        self.assertEqual(sent, 1)   # server echoed 1 row accepted, not 2

    def test_push_uses_timeout(self):
        seen = {}

        def fake(req, **kw):
            seen.update(kw)
            return self._Resp()

        with mock.patch("harness.collector.urllib.request.urlopen",
                        side_effect=fake):
            collector.push([_bench_sample()], url="http://dash-test/ingest")

        self.assertEqual(seen.get("timeout"), collector.POST_TIMEOUT_S)


class TestSingleInstance(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "metrics", "harness-collector.lock")

    def test_acquire_writes_pid(self):
        fd = collector.acquire_lock(self.path)
        self.assertIsNotNone(fd)
        try:
            with open(self.path) as f:
                self.assertEqual(f.read().strip(), str(os.getpid()))
        finally:
            os.close(fd)

    def test_second_holder_refused(self):
        fd1 = collector.acquire_lock(self.path)
        self.assertIsNotNone(fd1)
        try:
            self.assertIsNone(collector.acquire_lock(self.path))
        finally:
            os.close(fd1)

    def test_reacquirable_after_release(self):
        # flock releases on close — the dead-process case needs no deletion.
        fd = collector.acquire_lock(self.path)
        self.assertIsNotNone(fd)
        os.close(fd)
        self.assertIsNotNone(collector.acquire_lock(self.path))

    def test_default_path_lives_under_hermes_home(self):
        self.assertIn(os.path.join("~", ".hermes"), collector.LOCK_PATH)


class TestSchedule(unittest.TestCase):
    def test_resolve_interval_from_env(self):
        with mock.patch.dict(os.environ, {"HARNESS_INTERVAL": "60"}):
            self.assertEqual(collector.resolve_interval(), 60.0)

    def test_resolve_interval_explicit_wins(self):
        with mock.patch.dict(os.environ, {"HARNESS_INTERVAL": "60"}):
            self.assertEqual(collector.resolve_interval(45), 45.0)

    def test_resolve_interval_bad_value_falls_back(self):
        with mock.patch.dict(os.environ, {"HARNESS_INTERVAL": "soon"}):
            self.assertEqual(collector.resolve_interval(),
                             collector.DEFAULT_INTERVAL_S)

    def test_next_sleep_jitter_bounds(self):
        with mock.patch.object(collector, "JITTER", 0.5), \
                mock.patch.object(collector, "random") as rnd:
            rnd.uniform.side_effect = lambda a, b: 1.0   # max +jitter
            self.assertAlmostEqual(collector._next_sleep(100), 150)
            rnd.uniform.side_effect = lambda a, b: -1.0  # max -jitter
            self.assertAlmostEqual(collector._next_sleep(100), 50)

    def test_zero_jitter_is_exact(self):
        with mock.patch.object(collector, "JITTER", 0.0), \
                mock.patch.object(collector, "random") as rnd:
            rnd.uniform.side_effect = lambda a, b: 0.0
            self.assertEqual(collector._next_sleep(300), 300)


class _Stop(Exception):
    """Sentinel to end main()'s loop inside a test."""


class TestMain(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "lock")
        self._patches = [
            mock.patch.object(collector, "get_payload",
                              return_value=_canned("loaded")),
            mock.patch.object(collector, "run_suite",
                              return_value=[_bench_sample()]),
            mock.patch.object(collector, "snapshot_fn",
                              return_value=dict(HOST_STATS)),
            mock.patch.object(collector, "_post"),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()

    def test_lock_contention_exits_zero_without_cycles(self):
        held = collector.acquire_lock(self.path)   # we hold it
        self.assertIsNotNone(held)
        try:
            rc = collector.main(lock_path=self.path)   # must not block/loop
        finally:
            os.close(held)
        self.assertEqual(rc, 0)

    def test_loop_cycles_and_sleeps(self):
        get_payload = collector.get_payload   # module attr is the started mock
        sleeps = []

        def fake_sleep(sec):
            sleeps.append(sec)
            if len(sleeps) >= 3:
                raise _Stop()

        with mock.patch.object(collector, "_sleep", side_effect=fake_sleep):
            with self.assertRaises(_Stop):
                collector.main(interval=10, lock_path=self.path)

        self.assertEqual(len(sleeps), 3)
        for s in sleeps:
            self.assertGreater(s, 0)   # real random jitter; loose bound here
        self.assertGreaterEqual(get_payload.call_count, 3)   # a cycle per loop

    def test_main_releases_lock_after_run(self):
        def fake_sleep(sec):
            raise _Stop()   # stop after the first cycle

        with mock.patch.object(collector, "_sleep", side_effect=fake_sleep):
            try:
                collector.main(interval=1, lock_path=self.path)
            except _Stop:
                pass
        # finally-block must have closed the fd (released the flock).
        self.assertIsNotNone(collector.acquire_lock(self.path))


if __name__ == "__main__":
    unittest.main()
