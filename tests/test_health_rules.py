import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import app
import health_rules


ROOT = Path(__file__).resolve().parents[1]
NOW = 1_800_000_000.0  # fixed "now" for the rule unit tests
GEMMA = health_rules.COMPRESSION_SUMMARIZER  # ctx 64000, parallel 1
QWEN = "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5"  # ctx 103424, parallel 2


def api(ts, sid="s1", model="some-model", tokens=1000, out=100, dur=10, fin="stop",
        chars=None, rt=None):
    return {"kind": "api", "ts": ts, "session_id": sid, "model": model,
            "input_tokens": tokens, "output_tokens": out, "duration_s": dur,
            "finish_reason": fin, "platform": "mlx",
            "assistant_content_chars": chars, "reasoning_tokens": rt}


def guardrail_halt(ts, sid="s1", model="hermes/main"):
    return {"kind": "guardrail_halt", "ts": ts, "session_id": sid, "model": model,
            "error": "turn ended: reason=guardrail_halt after 21 api calls / 77 tool turns"}


def guardrail_block(ts, sid="s1", tool="read_file"):
    return {"kind": "guardrail_block", "ts": ts, "session_id": sid, "label": tool,
            "error": f"guardrail repeated_exact_failure_block: Blocked {tool}: the same "
                     "tool call failed 5 times with identical arguments."}


def pool_status(ts, model, device="mini"):
    return {"kind": "pool_status", "ts": ts, "model": model, "device": device}


def error(ts, sid=None, msg="boom"):
    return {"kind": "error", "ts": ts, "session_id": sid, "error": msg, "model": "m"}


def by_rule(findings, rule):
    return [f for f in findings if f["rule"] == rule]


class FormattingTests(unittest.TestCase):
    def test_fmt_tok_matches_js_k_format(self):
        self.assertEqual(health_rules.fmt_tok(1643000), "1643k")
        self.assertEqual(health_rules.fmt_tok(18000), "18k")
        self.assertEqual(health_rules.fmt_tok(45000), "45k")
        self.assertEqual(health_rules.fmt_tok(9500), "9.5k")
        self.assertEqual(health_rules.fmt_tok(600), "600")

    def test_short_model(self):
        self.assertEqual(health_rules.short_model(QWEN), "q35-genesis-hermes-v5")
        self.assertEqual(health_rules.short_model(GEMMA), "supergemma4-26b")


class HealthRuleTests(unittest.TestCase):
    def test_empty_records_yield_all_passing_ok(self):
        findings = health_rules.compute_findings([], NOW, 6)
        self.assertEqual(len(findings), 1)
        self.assertEqual(findings[0]["rule"], "OK")
        self.assertEqual(findings[0]["sev"], "ok")
        self.assertIn("all health checks passing", findings[0]["text"])

    def test_r1_summarizer_not_resident_is_crit(self):
        records = [pool_status(NOW - 30, QWEN)]
        findings = health_rules.compute_findings(records, NOW, 1)
        r1 = by_rule(findings, "R1")
        self.assertEqual(len(r1), 1)
        self.assertEqual(r1[0]["sev"], "crit")
        self.assertIn("supergemma4-26b is not loaded", r1[0]["text"])

    def test_r1_quiet_when_summarizer_loaded(self):
        records = [pool_status(NOW - 30, GEMMA)]
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R1"), [])

    def test_r2_warn_and_crit_by_pool_fraction(self):
        # unknown model (no ctx) -> plain warn
        warn = by_rule(health_rules.compute_findings(
            [api(NOW - 10, model="m-x", tokens=45000)], NOW, 1), "R2")
        self.assertEqual(warn[0]["sev"], "warn")
        self.assertIn("0 compactions", warn[0]["text"])
        # known model past 70% of its ctx -> crit
        crit = by_rule(health_rules.compute_findings(
            [api(NOW - 10, model=GEMMA, tokens=46000)], NOW, 1), "R2")
        self.assertEqual(crit[0]["sev"], "crit")

    def test_r2_quiet_after_compaction(self):
        records = [
            api(NOW - 200, model="m-x", tokens=60000),
            api(NOW - 10, model="m-x", tokens=5000),  # compaction drop
        ]
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R2"), [])

    def test_r3_overflow_forecast(self):
        records = [
            api(NOW - 300, model=GEMMA, tokens=40000),
            api(NOW - 200, model=GEMMA, tokens=42000),
            api(NOW - 100, model=GEMMA, tokens=44000),
            api(NOW - 10, model=GEMMA, tokens=46000),
        ]
        r3 = by_rule(health_rules.compute_findings(records, NOW, 1), "R3")
        self.assertEqual(len(r3), 1)
        self.assertEqual(r3[0]["sev"], "warn")
        self.assertIn("tok/min", r3[0]["text"])
        self.assertIn("reaches 64k pool", r3[0]["text"])

    def test_r4_retry_loop_regression_91_to_1(self):
        # Real-world case: session burned Σin 1643k for Σout 18k (91:1).
        records = [
            api(NOW - 30, sid="20260728_014430_d932c8", tokens=548000, out=6000),
            api(NOW - 20, sid="20260728_014430_d932c8", tokens=548000, out=6000),
            api(NOW - 10, sid="20260728_014430_d932c8", tokens=547000, out=6000),
        ]
        r4 = by_rule(health_rules.compute_findings(records, NOW, 1), "R4")
        self.assertEqual(len(r4), 1)
        self.assertEqual(r4[0]["sev"], "warn")
        self.assertIn("burned Σin 1643k for Σout 18k (91:1)", r4[0]["text"])
        self.assertEqual(r4[0]["action"], "check for a retry loop")

    def test_r4_quiet_for_normal_ratio(self):
        records = [api(NOW - 10, tokens=250000, out=10000)]  # 25:1
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R4"), [])

    def test_r5_pool_pressure_regression_90_percent_peak(self):
        # Two overlapping sessions whose combined demand peaks at 90% of the
        # gemma pool (57600 / 64000).
        records = [
            api(NOW - 110, sid="sa", model=GEMMA, tokens=30000, dur=100),
            api(NOW - 100, sid="sb", model=GEMMA, tokens=27600, dur=100),
        ]
        r5 = by_rule(health_rules.compute_findings(records, NOW, 1), "R5")
        self.assertEqual(len(r5), 1)
        self.assertEqual(r5[0]["sev"], "warn")
        self.assertIn("pool peaked at 90%", r5[0]["text"])

    def test_r6_parallel_times_p95_exceeds_pool(self):
        records = [
            api(NOW - 60, sid=f"s{i}", model=QWEN, tokens=60000, dur=1)
            for i in range(3)
        ]
        r6 = by_rule(health_rules.compute_findings(records, NOW, 1), "R6")
        self.assertEqual(len(r6), 1)
        self.assertEqual(r6[0]["sev"], "warn")
        self.assertIn("parallel 2 × p95 session 60k = 120k > pool 103k", r6[0]["text"])

    def test_r7_memory_regression_15_of_16_gb(self):
        records = [{"kind": "host_stats", "ts": NOW - 10, "host": "mini",
                    "mem_used_gb": 15.0, "mem_total_gb": 16, "cpu_load": 2.0}]
        r7 = by_rule(health_rules.compute_findings(records, NOW, 1), "R7")
        self.assertEqual(len(r7), 1)
        self.assertEqual(r7[0]["sev"], "warn")
        self.assertIn("mini memory at 94% (15.0/16 GB)", r7[0]["text"])

    def test_r7_crit_at_97_percent(self):
        records = [{"kind": "host_stats", "ts": NOW - 10, "host": "mini",
                    "mem_used_gb": 15.6, "mem_total_gb": 16, "cpu_load": 2.0}]
        r7 = by_rule(health_rules.compute_findings(records, NOW, 1), "R7")
        self.assertEqual(r7[0]["sev"], "crit")

    def test_r8_error_burst(self):
        records = [error(NOW - 100), error(NOW - 50), error(NOW - 10)]
        r8 = by_rule(health_rules.compute_findings(records, NOW, 1), "R8")
        self.assertEqual(len(r8), 1)
        self.assertIn("3 errors in the last 15 min", r8[0]["text"])

    def test_r8_quiet_below_three(self):
        records = [error(NOW - 100), error(NOW - 50)]
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R8"), [])

    def test_r9_residency_churn(self):
        tss = [NOW - 1000, NOW - 900, NOW - 500, NOW - 400, NOW - 50]  # 2 gaps > 180s
        records = [pool_status(ts, GEMMA) for ts in tss]
        r9 = by_rule(health_rules.compute_findings(records, NOW, 1), "R9")
        self.assertEqual(len(r9), 1)
        self.assertIn("flapped in/out of the pool 2× on mini", r9[0]["text"])

    def test_r10_idle_residency_only_on_long_windows(self):
        records = [
            pool_status(NOW - 30, GEMMA),
            pool_status(NOW - 30, QWEN),
            api(NOW - 20, model=GEMMA, tokens=1000),  # gemma is used, qwen idle
        ]
        long_window = by_rule(health_rules.compute_findings(records, NOW, 6), "R10")
        self.assertEqual(len(long_window), 1)
        self.assertEqual(long_window[0]["sev"], "info")
        self.assertIn("q35-genesis-hermes-v5 loaded (18.23 GB)", long_window[0]["text"])
        short_window = by_rule(health_rules.compute_findings(records, NOW, 1), "R10")
        self.assertEqual(short_window, [])

    def _loop_records(self, fin="tool_calls", step=600):
        return [
            api(NOW - (7 - i) * 60, sid="loop-session", tokens=2000 + i * step,
                out=50, fin=fin)
            for i in range(7)
        ]

    def test_r11_agent_loop_positive(self):
        r11 = by_rule(health_rules.compute_findings(self._loop_records(), NOW, 1), "R11")
        self.assertEqual(len(r11), 1)
        self.assertEqual(r11[0]["sev"], "warn")
        self.assertTrue(r11[0]["beta"])
        self.assertIn("possible agent loop", r11[0]["text"])
        self.assertIn("7 consecutive tool_calls, uniform +600/step", r11[0]["text"])

    def test_r11_negative_varied_finish_reasons(self):
        records = self._loop_records()
        records[3]["finish_reason"] = "stop"
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R11"), [])

    def test_r11_negative_nonuniform_steps(self):
        records = self._loop_records()
        records[5]["input_tokens"] += 2000  # break step uniformity
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R11"), [])

    def test_r11_suppressed_when_beta_disabled(self):
        findings = health_rules.compute_findings(
            self._loop_records(), NOW, 1, beta_enabled=False)
        self.assertEqual(by_rule(findings, "R11"), [])

    # ---- R12: guardrail-halt detector (beta) ----

    def test_r12_guardrail_halt_fires_with_block_evidence(self):
        records = [guardrail_halt(NOW - 60), guardrail_block(NOW - 61, tool="read_file")]
        r12 = by_rule(health_rules.compute_findings(records, NOW, 6), "R12")
        self.assertEqual(len(r12), 1)
        self.assertEqual(r12[0]["sev"], "warn")
        self.assertTrue(r12[0]["beta"])
        self.assertIn("guardrail halted session s1", r12[0]["text"])
        self.assertIn("read_file", r12[0]["text"])

    def test_r12_crit_at_three_halts(self):
        records = [guardrail_halt(NOW - 60 - i * 100) for i in range(3)]
        r12 = by_rule(health_rules.compute_findings(records, NOW, 6), "R12")
        self.assertEqual(r12[0]["sev"], "crit")
        self.assertIn("3×", r12[0]["text"])

    def test_r12_quiet_without_halt_records(self):
        records = [guardrail_block(NOW - 60)]  # blocks alone don't fire
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 6), "R12"), [])

    def test_r12_suppressed_when_widget_deleted(self):
        records = [guardrail_halt(NOW - 60)]
        findings = health_rules.compute_findings(
            records, NOW, 6,
            beta_widgets={"guardrail-halt-detector": {"status": "deleted"}})
        self.assertEqual(by_rule(findings, "R12"), [])
        findings = health_rules.compute_findings(records, NOW, 6, beta_enabled=False)
        self.assertEqual(by_rule(findings, "R12"), [])

    # ---- R13: empty-response / reasoning burn (beta) ----

    def _empty_records(self, n, fin="stop"):
        # n empty finished calls + one normal call, shaped like the
        # 20260730_231425_926af4 incident rows.
        records = [api(NOW - 60 - i * 30, fin=fin, out=538, chars=0, rt=513)
                   for i in range(n)]
        records.append(api(NOW - 10, fin="stop", chars=217, rt=104))
        return records

    def test_r13_fires_on_repeated_empty_finished_calls(self):
        r13 = by_rule(health_rules.compute_findings(self._empty_records(2), NOW, 1), "R13")
        self.assertEqual(len(r13), 1)
        self.assertEqual(r13[0]["sev"], "warn")
        self.assertTrue(r13[0]["beta"])
        self.assertIn("2 empty responses", r13[0]["text"])
        self.assertIn("finish=stop", r13[0]["text"])

    def test_r13_crit_at_five_empty_calls(self):
        r13 = by_rule(health_rules.compute_findings(self._empty_records(5), NOW, 1), "R13")
        self.assertEqual(r13[0]["sev"], "crit")

    def test_r13_quiet_for_single_empty_call(self):
        self.assertEqual(
            by_rule(health_rules.compute_findings(self._empty_records(1), NOW, 1), "R13"), [])

    def test_r13_ignores_pure_tool_call_turns(self):
        # assistant_content_chars=0 with finish=tool_calls is NORMAL.
        records = [api(NOW - 60 - i * 30, fin="tool_calls", chars=0, rt=100)
                   for i in range(6)]
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R13"), [])

    def test_r13_ignores_pre_migration_rows_without_chars(self):
        records = [api(NOW - 60 - i * 30, fin="stop", chars=None, rt=513) for i in range(3)]
        self.assertEqual(by_rule(health_rules.compute_findings(records, NOW, 1), "R13"), [])

    def test_r13_reasoning_dominance_signature(self):
        # finish is neither stop nor length, but reasoning is ~the whole
        # completion on a 0-char turn.
        records = [api(NOW - 60 - i * 30, fin="content_filter", chars=0, out=530, rt=513)
                   for i in range(2)]
        r13 = by_rule(health_rules.compute_findings(records, NOW, 1), "R13")
        self.assertEqual(len(r13), 1)

    def test_r13_suppressed_when_widget_deleted(self):
        findings = health_rules.compute_findings(
            self._empty_records(3), NOW, 1,
            beta_widgets={"empty-response-detector": {"status": "deleted"}})
        self.assertEqual(by_rule(findings, "R13"), [])
        findings = health_rules.compute_findings(
            self._empty_records(3), NOW, 1, beta_enabled=False)
        self.assertEqual(by_rule(findings, "R13"), [])

    def test_findings_sorted_crit_first(self):
        records = [
            pool_status(NOW - 30, QWEN),                       # R1 crit
            {"kind": "host_stats", "ts": NOW - 10, "host": "mini",
             "mem_used_gb": 15.0, "mem_total_gb": 16, "cpu_load": 2.0},  # R7 warn
        ]
        findings = health_rules.compute_findings(records, NOW, 1)
        self.assertEqual([f["rule"] for f in findings], ["R1", "R7"])


class SnapshotStoreTests(unittest.TestCase):
    def test_run_health_snapshot_inserts_findings(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        store = app.Store(str(Path(temp_dir.name) / "metrics.db"))
        self.addCleanup(store._conn.close)
        store.insert([
            app.normalize(
                {"ts": NOW - 10, "event": "post_api_request", "session_id": "loop",
                 "model": "m", "api_duration": 1,
                 "usage": {"input_tokens": 300000, "output_tokens": 2000}},
                "test-host"),
        ])

        inserted = app.run_health_snapshot(store, now=NOW)
        rows = store.findings_since(NOW - 3600)

        self.assertEqual(inserted, len(rows))
        self.assertGreaterEqual(inserted, 1)
        rules = {row["rule"] for row in rows}
        self.assertIn("R4", rules)  # 150:1 in/out ratio
        for row in rows:
            self.assertEqual(row["ts"], NOW)
            self.assertEqual(row["window_hours"], app.HEALTH_SNAPSHOT_WINDOW_H)
            self.assertIn(row["sev"], ("crit", "warn", "info", "ok"))

    def test_prune_findings_older_than(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        store = app.Store(str(Path(temp_dir.name) / "metrics.db"))
        self.addCleanup(store._conn.close)
        store.insert_health_findings([
            {"ts": 100.0, "window_hours": 6.0, "rule": "R7", "sev": "warn",
             "text": "old", "action": None, "beta": False},
            {"ts": 200.0, "window_hours": 6.0, "rule": "R7", "sev": "warn",
             "text": "new", "action": None, "beta": False},
        ])
        self.assertEqual(store.prune_findings_older_than(150.0), 1)
        self.assertEqual([r["text"] for r in store.findings_since(0.0)], ["new"])


def allocate_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def get_json(url):
    with urllib.request.urlopen(url, timeout=2) as response:
        return response.status, json.load(response)


class FindingsEndpointTest(unittest.TestCase):
    """HTTP coverage for GET /api/findings (test_http_smoke.py style)."""

    def setUp(self):
        self.port = allocate_local_port()
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "smoke.db"
        env = dict(os.environ)
        env["METRICS_RETENTION_DAYS"] = "0"    # no prune thread
        env["METRICS_HEALTH_SNAPSHOTS"] = "0"  # no snapshot thread; rows inserted directly
        env["BETA_WIDGETS_PATH"] = str(Path(self.temp_dir.name) / "beta-widgets.json")
        self.process = subprocess.Popen(
            [
                sys.executable, str(ROOT / "app.py"),
                "--bind", "127.0.0.1",
                "--port", str(self.port),
                "--db", str(self.db_path),
            ],
            cwd=ROOT, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        deadline = time.monotonic() + 10
        while True:
            if self.process.poll() is not None:
                self.fail(f"app.py exited early:\n{self.process.stdout.read()}")
            try:
                get_json(self.base_url + "/health")
                break
            except (OSError, urllib.error.URLError):
                if time.monotonic() >= deadline:
                    self.fail("app.py did not become healthy within 10 seconds")
                time.sleep(0.05)

    def tearDown(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.communicate(timeout=5)
        self.temp_dir.cleanup()

    def insert_findings(self, rows):
        # Direct writer alongside the server's WAL-mode connection.
        conn = sqlite3.connect(str(self.db_path))
        try:
            conn.executemany(
                "INSERT INTO health_findings (ts, window_hours, rule, sev, text, action, beta)"
                " VALUES (?,?,?,?,?,?,?)", rows)
            conn.commit()
        finally:
            conn.close()

    def test_findings_aggregation_contract(self):
        now = time.time()
        self.insert_findings([
            (now - 86400, 6.0, "R4", "warn", "older example", "old action", 0),
            (now, 6.0, "R4", "crit", "recent example", "recent action", 0),
            (now, 6.0, "R7", "info", "mem note", None, 0),
        ])

        status, body = get_json(self.base_url + "/api/findings?days=7")
        self.assertEqual(status, 200)
        self.assertEqual(body["days"], 7)
        self.assertEqual(body["total"], 3)
        self.assertIsInstance(body["since"], float)
        self.assertEqual(len(body["rules"]), 2)

        # sorted by count desc
        r4, r7 = body["rules"]
        self.assertEqual(r4["rule"], "R4")
        self.assertEqual(r4["label"], "token waste / retry loop")
        self.assertEqual(r4["count"], 2)
        self.assertEqual(r4["worst_sev"], "crit")
        self.assertEqual(r4["days_fired"], 2)
        self.assertEqual(r4["example_text"], "recent example")
        self.assertEqual(r4["example_action"], "recent action")
        self.assertEqual(r4["last_ts"], now)
        self.assertEqual(r4["daily"], [0, 0, 0, 0, 0, 1, 1])

        self.assertEqual(r7["rule"], "R7")
        self.assertEqual(r7["count"], 1)
        self.assertEqual(r7["worst_sev"], "info")
        self.assertEqual(r7["days_fired"], 1)
        self.assertIsNone(r7["example_action"])
        self.assertEqual(sum(r7["daily"]), 1)
        self.assertEqual(len(r7["daily"]), 7)

    def test_findings_days_clamped_and_validated(self):
        status, body = get_json(self.base_url + "/api/findings?days=99")
        self.assertEqual(body["days"], 30)
        status, body = get_json(self.base_url + "/api/findings?days=0")
        self.assertEqual(body["days"], 1)
        status, body = get_json(self.base_url + "/api/findings")
        self.assertEqual(body["days"], 7)
        self.assertEqual(body["total"], 0)
        self.assertEqual(body["rules"], [])
        try:
            get_json(self.base_url + "/api/findings?days=abc")
            self.fail("non-numeric days should return 400")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)


if __name__ == "__main__":
    unittest.main()
