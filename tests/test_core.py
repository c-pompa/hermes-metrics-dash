import json
import tempfile
import unittest
from pathlib import Path

import app
import forwarder


class NormalizeTests(unittest.TestCase):
    def test_normalizes_api_usage_duration_tps_and_provider_stats(self):
        row = app.normalize(
            {
                "ts": 123.0,
                "event": "post_api_request",
                "session_id": "session-1",
                "provider": "local",
                "api_duration": 2,
                "usage": {
                    "input_tokens": 11,
                    "output_tokens": 10,
                    "cache_read_tokens": 3,
                    "stats": {
                        "time_to_first_token": 0.25,
                        "tokens_per_second": 6.5,
                        "total_draft_tokens_count": 8,
                        "accepted_draft_tokens_count": 6,
                    },
                },
            },
            "fallback-host",
        )

        self.assertEqual(row["kind"], "api")
        self.assertEqual(row["host"], "fallback-host")
        self.assertEqual(row["duration_s"], 2)
        self.assertEqual(row["tps"], 5.0)
        self.assertEqual(row["input_tokens"], 11)
        self.assertEqual(row["cache_read_tokens"], 3)
        self.assertEqual(row["ttft_s"], 0.25)
        self.assertEqual(row["tps_native"], 6.5)
        self.assertEqual(row["spec_accept_rate"], 0.75)

    def test_normalizes_error_and_subagent_records(self):
        error = app.normalize(
            {
                "ts": 124.0,
                "event": "api_request_error",
                "error_type": "TimeoutError",
                "error_message": "provider timed out",
            },
            "host-a",
        )
        stopped = app.normalize(
            {
                "ts": 125.0,
                "event": "subagent_stop",
                "session_id": "parent",
                "child_session_id": "child",
                "child_role": "researcher",
                "duration_ms": "1500",
            },
            "host-a",
        )

        self.assertEqual(error["kind"], "error")
        self.assertEqual(error["error"], "TimeoutError: provider timed out")
        self.assertEqual(stopped["kind"], "subagent_stop")
        self.assertEqual(stopped["session_id"], "child")
        self.assertEqual(stopped["parent_session_id"], "parent")
        self.assertEqual(stopped["label"], "researcher")
        self.assertEqual(stopped["duration_s"], 1.5)

    def test_normalizes_assistant_content_chars(self):
        row = app.normalize(
            {
                "ts": 126.0,
                "event": "post_api_request",
                "finish_reason": "stop",
                "assistant_content_chars": 0,
                "usage": {"input_tokens": 5, "output_tokens": 538,
                          "reasoning_tokens": 513},
            },
            "host-a",
        )
        self.assertEqual(row["kind"], "api")
        self.assertEqual(row["assistant_content_chars"], 0)
        self.assertEqual(row["reasoning_tokens"], 513)

    def test_normalizes_guardrail_records(self):
        halt = app.normalize(
            {
                "ts": 127.0,
                "event": "guardrail_halt",
                "session_id": "s1",
                "model": "hermes/main",
                "finish_reason": "guardrail_halt",
                "error_message": "turn ended: reason=guardrail_halt after 21 api calls / 77 tool turns",
            },
            "host-a",
        )
        block = app.normalize(
            {
                "ts": 128.0,
                "event": "guardrail_block",
                "session_id": "s1",
                "label": "read_file",
                "error_message": "guardrail repeated_exact_failure_block: Blocked read_file: …",
            },
            "host-a",
        )
        self.assertEqual(halt["kind"], "guardrail_halt")
        self.assertEqual(halt["error"],
                         "turn ended: reason=guardrail_halt after 21 api calls / 77 tool turns")
        self.assertEqual(halt["model"], "hermes/main")
        self.assertEqual(block["kind"], "guardrail_block")
        self.assertEqual(block["label"], "read_file")
        self.assertIn("repeated_exact_failure_block", block["error"])


class StoreTests(unittest.TestCase):
    def test_recent_filters_limits_and_returns_oldest_first(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        store = app.Store(str(Path(temp_dir.name) / "metrics.db"))
        self.addCleanup(store._conn.close)
        store.insert(
            [
                app.normalize(
                    {"ts": ts, "event": "post_api_request", "model": model},
                    "test-host",
                )
                for ts, model in [(10.0, "old"), (20.0, "middle"), (30.0, "new")]
            ]
        )

        rows = store.recent(since=10.0, until=30.0, limit=2)

        self.assertEqual([row["model"] for row in rows], ["middle", "new"])
        self.assertEqual([row["ts"] for row in rows], [20.0, 30.0])
        self.assertTrue(all(isinstance(row["id"], int) for row in rows))


class RoutedDeviceTests(unittest.TestCase):
    """A call through a role alias names its served model in response_model;
    the store resolves the device from the pool snapshot, on any ingest path."""

    def _store(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        store = app.Store(str(Path(temp_dir.name) / "metrics.db"))
        self.addCleanup(store._conn.close)
        return store, str(Path(temp_dir.name) / "metrics.db")

    def _api(self, ts, **kw):
        return app.normalize(dict({"ts": ts, "event": "post_api_request", "model": "hermes/main"}, **kw), "mbp")

    def test_routed_call_gets_device_of_served_model(self):
        store, _ = self._store()
        store.insert([
            app.normalize({"ts": 1.0, "event": "pool_status", "model": "qwen", "device": "host-a"}, "mini"),
            self._api(2.0, response_model="qwen"),
            self._api(3.0, response_model="hosted-model"),
            self._api(4.0, response_model="qwen", device="WinPC"),
        ])
        rows = [r for r in store.recent(0, 10, 10) if r["kind"] == "api"]
        self.assertEqual([r["response_model"] for r in rows], ["qwen", "hosted-model", "qwen"])
        self.assertEqual([r["device"] for r in rows], ["host-a", None, "WinPC"])

    def test_latest_pool_snapshot_survives_restart(self):
        store, path = self._store()
        store.insert([
            app.normalize({"ts": 1.0, "event": "pool_status", "model": "qwen", "device": "host-b"}, "mini"),
            app.normalize({"ts": 5.0, "event": "pool_status", "model": "qwen", "device": "host-a"}, "mini"),
        ])
        reopened = app.Store(path)
        self.addCleanup(reopened._conn.close)
        reopened.insert([self._api(6.0, response_model="qwen")])
        rows = [r for r in reopened.recent(0, 10, 10) if r["kind"] == "api"]
        self.assertEqual(rows[0]["device"], "host-a")


class ForwarderTailingTests(unittest.TestCase):
    def test_partial_line_remains_unconsumed_until_newline_arrives(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "requests.jsonl"
            first = {"event": "post_api_request", "model": "first"}
            second = {"event": "post_api_request", "model": "second"}
            first_line = json.dumps(first).encode("utf-8") + b"\n"
            second_line = json.dumps(second).encode("utf-8")
            path.write_bytes(first_line + second_line[:12])
            state = {}

            self.assertEqual(forwarder.read_new_lines(path, state), [first])
            self.assertEqual(state[str(path)]["offset"], len(first_line))
            self.assertEqual(forwarder.read_new_lines(path, state), [])
            self.assertEqual(state[str(path)]["offset"], len(first_line))

            with path.open("ab") as stream:
                stream.write(second_line[12:] + b"\n")

            self.assertEqual(forwarder.read_new_lines(path, state), [second])
            self.assertEqual(state[str(path)]["offset"], path.stat().st_size)

    def test_truncation_restarts_tailing_from_beginning(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "requests.jsonl"
            path.write_text('{"event":"old"}\n', encoding="utf-8")
            # Legacy int offsets (pre-inode state files) are still honored.
            state = {str(path): 10_000}
            replacement = {"event": "replacement"}
            path.write_text(json.dumps(replacement) + "\n", encoding="utf-8")

            self.assertEqual(forwarder.read_new_lines(path, state), [replacement])
            self.assertEqual(state[str(path)]["offset"], path.stat().st_size)

    def test_rename_rotation_detected_even_when_new_file_is_larger(self):
        # Size-shrink heuristics miss rename-rotation when the fresh file
        # already grew past the old offset; the inode check catches it.
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "requests.jsonl"
            path.write_text('{"event":"old"}\n', encoding="utf-8")
            state = {}
            self.assertEqual(forwarder.read_new_lines(path, state),
                             [{"event": "old"}])

            path.replace(Path(temp_dir) / "requests.jsonl.1")
            fresh = {"event": "fresh-after-rotation", "model": "a-longer-line"}
            path.write_text(json.dumps(fresh) + "\n", encoding="utf-8")

            self.assertEqual(forwarder.read_new_lines(path, state), [fresh])


class AgentLogGuardrailTests(unittest.TestCase):
    HALT_LINE = ("2026-07-31 14:11:10,512 INFO [20260730_231425_926af4] "
                 "agent.conversation_loop: Turn ended: reason=guardrail_halt "
                 "model=hermes/main api_calls=21/150 budget=21/150 "
                 "tool_turns=77 last_msg_role=assistant response_len=252 "
                 "session=20260730_231425_926af4")
    # Real agent.log truncates long lines mid-JSON — the code value is cut.
    BLOCK_LINE_TRUNCATED = (
        "2026-07-31 17:30:49,706 WARNING [20260730_231425_926af4] "
        "agent.tool_executor: Tool read_file returned error (0.00s): "
        '{"error": "Blocked read_file: the same tool call failed 5 times '
        'with identical arguments. Stop retrying it unchanged; change '
        'strategy or explain the blocker.", "guardrail": {"action": "block"')
    BLOCK_LINE_FULL = BLOCK_LINE_TRUNCATED + ', "code": "repeated_exact_failure_block"}}'

    def test_parses_guardrail_halt_line(self):
        rec = forwarder.parse_agent_log_line(self.HALT_LINE)
        self.assertEqual(rec["event"], "guardrail_halt")
        self.assertEqual(rec["session_id"], "20260730_231425_926af4")
        self.assertEqual(rec["model"], "hermes/main")
        self.assertEqual(rec["finish_reason"], "guardrail_halt")
        self.assertIn("21 api calls / 77 tool turns", rec["error_message"])
        self.assertGreater(rec["ts"], 0)

    def test_parses_block_line_with_full_code(self):
        rec = forwarder.parse_agent_log_line(self.BLOCK_LINE_FULL)
        self.assertEqual(rec["event"], "guardrail_block")
        self.assertEqual(rec["label"], "read_file")
        self.assertIn("repeated_exact_failure_block", rec["error_message"])
        self.assertIn("Blocked read_file", rec["error_message"])

    def test_parses_block_line_truncated_by_log_rotation_of_content(self):
        rec = forwarder.parse_agent_log_line(self.BLOCK_LINE_TRUNCATED)
        self.assertEqual(rec["event"], "guardrail_block")
        self.assertEqual(rec["label"], "read_file")
        # no code survived the truncation — still a usable record
        self.assertIn("guardrail block", rec["error_message"])

    def test_ignores_unrelated_log_lines(self):
        self.assertIsNone(forwarder.parse_agent_log_line(
            "2026-07-31 17:30:49,706 INFO [abc] agent.conversation_loop: "
            "Turn ended: reason=stop model=hermes/main api_calls=3/150"))
        self.assertIsNone(forwarder.parse_agent_log_line("not a log line"))

    def test_text_tailer_seeds_at_eof_then_tails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "agent.log"
            path.write_text("historical line\n", encoding="utf-8")
            state = {}
            # First sight: history is skipped, offset seeds at EOF.
            self.assertEqual(forwarder.read_new_text_lines(path, state), [])
            self.assertEqual(state[str(path)]["offset"], path.stat().st_size)
            with path.open("a", encoding="utf-8") as stream:
                stream.write("new line one\nnew line two\n")
            self.assertEqual(forwarder.read_new_text_lines(path, state),
                             ["new line one", "new line two"])
            # Rotation (shrink) restarts from the beginning.
            path.write_text("after rotation\n", encoding="utf-8")
            self.assertEqual(forwarder.read_new_text_lines(path, state),
                             ["after rotation"])


class MoAFlatteningTests(unittest.TestCase):
    def test_flattens_references_and_aggregator_without_message_content(self):
        records = forwarder.flatten_moa_turn(
            {
                "ts": 456.0,
                "session_id": "session-moa",
                "preset": "balanced",
                "input_messages": [{"content": "secret input"}],
                "references": [
                    {
                        "label": "critic",
                        "model": "ref-model",
                        "provider": "local",
                        "duration_s": 1.25,
                        "usage": {"output_tokens": 7},
                        "stats": {"tokens_per_second": 5.6},
                        "output": "secret reference output",
                    }
                ],
                "aggregator": {
                    "label": "synthesizer",
                    "model": "agg-model",
                    "provider": "local",
                    "output": "secret aggregate output",
                },
            }
        )

        self.assertEqual(len(records), 2)
        reference, aggregator = records
        self.assertEqual(reference["event"], "moa_reference")
        self.assertEqual(reference["usage"], {"output_tokens": 7})
        self.assertEqual(reference["stats"], {"tokens_per_second": 5.6})
        self.assertEqual(aggregator["event"], "moa_aggregator")
        self.assertEqual(aggregator["model"], "agg-model")
        for record in records:
            self.assertNotIn("input_messages", record)
            self.assertNotIn("output", record)

    def test_omits_aggregator_without_model(self):
        records = forwarder.flatten_moa_turn(
            {
                "session_id": "session-moa",
                "references": [],
                "aggregator": {"label": "missing-model"},
            }
        )

        self.assertEqual(records, [])


class MoASummaryTests(unittest.TestCase):
    NOW = 1_000_000.0
    REFS = [("nvidia:glm", "glm-5.2"), ("nvidia:mm", "minimax-m3"),
            ("nvidia:ds", "ds-v4-flash")]

    def _store(self):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        store = app.Store(str(Path(temp_dir.name) / "metrics.db"))
        self.addCleanup(store._conn.close)
        return store

    def _turn(self, ts, session_id, preset, ref_durations):
        """One moa-refs.jsonl line (the real schema, minus message content)."""
        return {
            "ts": ts,
            "session_id": session_id,
            "preset": preset,
            "references": [
                {
                    "label": label,
                    "model": model,
                    "provider": "nvidia",
                    "duration_s": duration,
                    "usage": {"input_tokens": 10, "output_tokens": 5},
                }
                for (label, model), duration in zip(self.REFS, ref_durations)
            ],
            "aggregator": {
                "label": "nvidia:ds-pro",
                "model": "ds-v4-pro",
                "provider": "nvidia",
            },
        }

    def _insert_turn(self, store, turn):
        return store.insert(
            [
                app.normalize(rec, "test-host")
                for rec in forwarder.flatten_moa_turn(turn)
            ]
        )

    def _two_run_store(self):
        store = self._store()
        self._insert_turn(
            store, self._turn(self.NOW - 100, "s-1", "nvidia", [10.0, 20.0, 30.0]))
        self._insert_turn(
            store, self._turn(self.NOW - 50, "s-2", "nvidia", [12.0, 22.0, 32.0]))
        return store

    def test_empty_store_is_unavailable_without_lineup(self):
        summary = app.moa_summary(self._store(), 1, now=self.NOW)

        self.assertFalse(summary["available"])
        self.assertEqual(summary["runs"], 0)
        self.assertEqual(summary["voices"], [])
        self.assertIsNone(summary["aggregator"])
        self.assertIsNone(summary["preset"])
        self.assertIsNone(summary["last_run_ts"])

    def test_active_window_aggregates_runs_voices_and_fanout(self):
        summary = app.moa_summary(self._two_run_store(), 1, now=self.NOW)

        self.assertTrue(summary["available"])
        self.assertEqual(summary["runs"], 2)
        self.assertEqual(summary["voices_live"], 3)
        self.assertEqual(summary["voices_total"], 3)
        self.assertEqual(summary["preset"], "nvidia")
        self.assertEqual(summary["last_run_ts"], self.NOW - 50)
        voices = summary["voices"]
        self.assertEqual([v["role"] for v in voices], ["ref-a", "ref-b", "ref-c"])
        self.assertEqual([v["calls"] for v in voices], [2, 2, 2])
        self.assertEqual(voices[0]["label"], "nvidia:glm")
        self.assertEqual(voices[0]["model"], "glm-5.2")
        self.assertEqual(voices[0]["provider"], "nvidia")
        self.assertEqual(voices[0]["avg_s"], 11.0)
        self.assertEqual(voices[2]["avg_s"], 31.0)
        # Fan-out per run is the slowest voice; p95 of [30, 32] picks 32.
        self.assertEqual(summary["p95_fanout_s"], 32.0)
        agg = summary["aggregator"]
        self.assertEqual(agg["model"], "ds-v4-pro")
        self.assertEqual(agg["provider"], "nvidia")
        self.assertEqual(agg["calls"], 2)
        # The moa-refs source carries no aggregator latency — no fabrication.
        self.assertIsNone(agg["avg_s"])

    def test_idle_window_falls_back_to_latest_run_lineup(self):
        store = self._store()
        # Both runs older than the window; the older one inserted second to
        # prove the lineup picks by ts, not row id.
        self._insert_turn(
            store, self._turn(self.NOW - 4000, "s-1", "nvidia", [10.0, 20.0, 30.0]))
        self._insert_turn(
            store, self._turn(self.NOW - 7200, "s-0", "nvidia", [1.0, 2.0, 3.0]))

        summary = app.moa_summary(store, 1, now=self.NOW)

        self.assertFalse(summary["available"])
        self.assertEqual(summary["runs"], 0)
        self.assertEqual(summary["preset"], "nvidia")
        self.assertEqual(summary["last_run_ts"], self.NOW - 4000)
        self.assertEqual([v["role"] for v in summary["voices"]],
                         ["ref-a", "ref-b", "ref-c"])
        self.assertEqual([v["calls"] for v in summary["voices"]], [1, 1, 1])
        self.assertEqual(summary["aggregator"]["model"], "ds-v4-pro")

    def test_window_excludes_older_runs(self):
        store = self._two_run_store()  # runs at NOW-100 and NOW-50
        self._insert_turn(
            store, self._turn(self.NOW - 5000, "s-0", "nvidia", [1.0, 2.0, 3.0]))

        one_hour = app.moa_summary(store, 1, now=self.NOW)
        two_hours = app.moa_summary(store, 2, now=self.NOW)

        self.assertEqual(one_hour["runs"], 2)
        self.assertEqual([v["calls"] for v in one_hour["voices"]], [2, 2, 2])
        self.assertEqual(two_hours["runs"], 3)
        self.assertEqual([v["calls"] for v in two_hours["voices"]], [3, 3, 3])
        self.assertEqual(two_hours["aggregator"]["calls"], 3)

    def test_preset_is_none_when_records_lack_one(self):
        store = self._store()
        self._insert_turn(
            store, self._turn(self.NOW - 10, "s-1", None, [5.0, 6.0, 7.0]))

        summary = app.moa_summary(store, 1, now=self.NOW)

        self.assertTrue(summary["available"])
        self.assertIsNone(summary["preset"])


class RouterSourceTests(unittest.TestCase):
    # Real schema from hermes-model-router router.py do_POST + exec_log.
    ROUTER_LINE = {
        "role": "hermes/main",
        "model": "qwen3-32b-mlx",
        "status": 200,
        "reason": "live",
        "path": "/v1/chat/completions",
        "duration_s": 2.5,
        "usage": {"prompt_tokens": 120, "completion_tokens": 50,
                  "total_tokens": 170},
        "ts": "2026-08-02T10:03:42+0200",
    }

    def test_flattens_router_request(self):
        rec = forwarder.flatten_router_request(self.ROUTER_LINE)

        self.assertEqual(rec["event"], "router_request")
        self.assertEqual(rec["label"], "hermes/main")
        self.assertEqual(rec["model"], "qwen3-32b-mlx")
        self.assertEqual(rec["duration_s"], 2.5)
        self.assertEqual(rec["usage"],
                         {"input_tokens": 120, "output_tokens": 50})
        self.assertNotIn("error_type", rec)
        # ISO ts is converted to epoch seconds, not passed through as a string.
        self.assertIsInstance(rec["ts"], float)
        self.assertGreater(rec["ts"], 0)

    def test_flattens_router_503_as_error_record(self):
        rec = forwarder.flatten_router_request(
            {"role": "hermes/main", "model": None, "status": 503,
             "reason": "no-live-candidate", "path": "/v1/chat/completions",
             "ts": "2026-08-02T10:03:42+0200"})

        self.assertEqual(rec["event"], "router_request")
        self.assertIsNone(rec["model"])
        self.assertEqual(rec["usage"], {})
        self.assertEqual(rec["error_type"], "http_503")
        self.assertIn("no-live-candidate", rec["error_message"])

    def test_router_record_lands_in_generic_records_table_shape(self):
        # app.normalize must accept the new event without an accept-list change.
        row = app.normalize(
            forwarder.flatten_router_request(self.ROUTER_LINE), "mini")

        self.assertEqual(row["event"], "router_request")
        self.assertEqual(row["kind"], "router_request")
        self.assertEqual(row["label"], "hermes/main")
        self.assertEqual(row["model"], "qwen3-32b-mlx")
        self.assertEqual(row["duration_s"], 2.5)
        self.assertEqual(row["input_tokens"], 120)
        self.assertEqual(row["output_tokens"], 50)
        self.assertEqual(row["tps"], 20.0)
        self.assertIsInstance(row["ts"], float)

    def test_router_error_record_normalizes_to_error_kind(self):
        # A stalled stream (router logs 598) or any HTTP >= 400 must land in
        # the error lane, not count as a slow successful router_request.
        rec = forwarder.flatten_router_request(
            {"role": "", "model": "cerebras_qwen3-coder-reap-25b-a3b",
             "status": 598, "reason": "passthrough",
             "path": "/v1/chat/completions", "duration_s": 600.02,
             "ts": "2026-09-27T13:58:44-0500"})
        self.assertEqual(rec["error_type"], "http_598")

        row = app.normalize(rec, "mini")

        self.assertEqual(row["kind"], "error")
        self.assertIn("598", row["error"])
        self.assertEqual(row["model"], "cerebras_qwen3-coder-reap-25b-a3b")
        self.assertEqual(row["duration_s"], 600.02)

    def test_iso_ts_parsing(self):
        self.assertAlmostEqual(
            forwarder._iso_ts("1970-01-01T01:00:00+0100"), 0.0)
        self.assertEqual(forwarder._iso_ts(123.5), 123.5)
        self.assertIsNone(forwarder._iso_ts("not a timestamp"))
        self.assertIsNone(forwarder._iso_ts(None))


class ClientgateSourceTests(unittest.TestCase):
    # Real schema from hermes-model-router clientgate.py _proxy + log_usage.
    CLIENTGATE_LINE = {
        "client": "open-webui",
        "role": "chat",
        "method": "POST",
        "path": "/v1/chat/completions",
        "model": "hermes/main",
        "status": 200,
        "duration_ms": 2500.0,
        "prompt_tokens": 120,
        "completion_tokens": 50,
        "total_tokens": 170,
        "ts": "2026-08-02T10:03:42+0200",
    }

    def test_flattens_clientgate_request_attributed_to_client(self):
        rec = forwarder.flatten_clientgate_request(self.CLIENTGATE_LINE)

        self.assertEqual(rec["event"], "clientgate_request")
        self.assertEqual(rec["label"], "open-webui")
        self.assertEqual(rec["model"], "hermes/main")
        self.assertEqual(rec["duration_ms"], 2500.0)
        self.assertEqual(rec["usage"],
                         {"input_tokens": 120, "output_tokens": 50})
        self.assertNotIn("error_type", rec)

    def test_flattens_clientgate_error_status(self):
        rec = forwarder.flatten_clientgate_request(
            dict(self.CLIENTGATE_LINE, status=502, prompt_tokens=None,
                 completion_tokens=None))

        self.assertEqual(rec["error_type"], "http_502")
        self.assertIn("open-webui", rec["error_message"])
        self.assertEqual(rec["usage"], {})

    def test_clientgate_record_lands_in_generic_records_table_shape(self):
        row = app.normalize(
            forwarder.flatten_clientgate_request(self.CLIENTGATE_LINE), "mini")

        self.assertEqual(row["event"], "clientgate_request")
        self.assertEqual(row["kind"], "clientgate_request")
        self.assertEqual(row["label"], "open-webui")
        self.assertEqual(row["duration_s"], 2.5)  # duration_ms / 1000
        self.assertEqual(row["input_tokens"], 120)
        self.assertEqual(row["output_tokens"], 50)


class RouterTailingTests(unittest.TestCase):
    def test_missing_file_is_skipped_and_retried(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "model-router-requests.jsonl"
            state = {}

            self.assertEqual(forwarder.read_new_lines(path, state, seed_eof=True),
                             [])
            self.assertNotIn(str(path), state)  # no offset committed; retried

    def test_first_sight_seeds_at_eof_then_tails(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "model-router-requests.jsonl"
            historical = {"role": "old", "model": "m1", "status": 200}
            path.write_text(json.dumps(historical) + "\n", encoding="utf-8")
            state = {}

            # History is not backfilled (file can be 50 MB pre-rotation).
            self.assertEqual(forwarder.read_new_lines(path, state, seed_eof=True),
                             [])
            self.assertEqual(state[str(path)]["offset"], path.stat().st_size)

            new = {"role": "hermes/main", "model": "m2", "status": 200}
            with path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(new) + "\n")
            self.assertEqual(forwarder.read_new_lines(path, state, seed_eof=True),
                             [new])

    def test_rotation_restarts_from_beginning_of_new_file(self):
        # router.py rotates by renaming the log aside; the tailer sees the
        # inode change and restarts at offset 0 (same handling as agent.log).
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "model-router-requests.jsonl"
            old = {"role": "old", "model": "m1", "status": 200}
            path.write_text(json.dumps(old) + "\n", encoding="utf-8")
            state = {}
            forwarder.read_new_lines(path, state, seed_eof=True)

            path.replace(Path(temp_dir) / "model-router-requests.jsonl.1")
            fresh = {"role": "hermes/main", "model": "m2", "status": 200}
            path.write_text(json.dumps(fresh) + "\n", encoding="utf-8")

            self.assertEqual(forwarder.read_new_lines(path, state, seed_eof=True),
                             [fresh])
            self.assertEqual(state[str(path)]["offset"], path.stat().st_size)

    def test_default_behavior_without_seed_eof_unchanged(self):
        # requests.jsonl keeps its backfill-from-offset-0 semantics.
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "requests.jsonl"
            rec = {"event": "post_api_request", "model": "m1"}
            path.write_text(json.dumps(rec) + "\n", encoding="utf-8")
            state = {}

            self.assertEqual(forwarder.read_new_lines(path, state), [rec])


if __name__ == "__main__":
    unittest.main()
