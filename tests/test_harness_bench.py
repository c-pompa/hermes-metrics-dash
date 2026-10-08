"""Failing-first tests for harness/bench.py (plan Task 3 — streaming benchmark).

Two unit layers, no live model or real network:
  * chunk_stats — pure timing math over ("t0"|"tok", ts) events.
  * run_once   — SSE parsing over a fake stream via monkeypatched urlopen;
    request URL/body are asserted, samples shaped for ingest.
"""
import json
import unittest

from harness.bench import PROMPTS, chunk_stats


def _line(obj):
    return ("data: " + json.dumps(obj) + "\n\n").encode()


def _chunk(text):
    return {"choices": [{"delta": {"content": text}, "index": 0}]}


class FakeStream:
    """Iterable of bytes mimicking a streaming http response body."""

    def __init__(self, lines):
        self._lines = list(lines)

    def __iter__(self):
        return iter(self._lines)


def _sse_response(lines):
    class R:
        def __enter__(self_inner):
            return FakeStream(lines)

        def __exit__(self_inner, *exc):
            return False

    return R()


class TestChunkStats(unittest.TestCase):
    def test_ttft_and_tps(self):
        # 4 content chunks, 1.0s apart, first token at t=0.8 (TTFT)
        events = [("t0", 0.0), ("tok", 0.8), ("tok", 1.8),
                  ("tok", 2.8), ("tok", 3.8)]
        s = chunk_stats(events)
        self.assertAlmostEqual(s["ttft_s"], 0.8, places=3)
        self.assertAlmostEqual(s["tps"], 1.0, places=2)   # 3 inter-token gaps of 1.0s
        self.assertEqual(s["tokens"], 4)

    def test_empty_stream(self):
        s = chunk_stats([("t0", 0.0)])
        self.assertEqual(s["tokens"], 0)
        self.assertIsNone(s["tps"])

    def test_single_token(self):
        s = chunk_stats([("t0", 1.0), ("tok", 2.5)])
        self.assertEqual(s["tokens"], 1)
        self.assertAlmostEqual(s["ttft_s"], 1.5, places=3)
        self.assertIsNone(s["tps"])   # no inter-token gap to divide by

    def test_zero_duration(self):
        # All tokens on one clock tick: no measurable decode window.
        s = chunk_stats([("t0", 1.0)] + [("tok", 2.0) for _ in range(3)])
        self.assertEqual(s["tokens"], 3)
        self.assertIsNone(s["tps"])


class _BenchCapture:
    """Captures the urlopen calls run_once makes for assertions/exceptions."""

    def __init__(self, handler):
        self.handler = handler
        self.requests = []

    def __call__(self, req, *a, **kw):
        self.requests.append(req)
        return self.handler(*a, **kw)


class TestRunOnce(unittest.TestCase):
    def setUp(self):
        import harness.bench as bench

        self._mod = bench
        self._old_urlopen = bench.urllib.request.urlopen

    def tearDown(self):
        self._mod.urllib.request.urlopen = self._old_urlopen

    def _patch(self, resp_or_exc):
        if isinstance(resp_or_exc, Exception):
            def boom(*a, **kw):
                raise resp_or_exc

            self._mod.urllib.request.urlopen = _BenchCapture(boom)
        else:
            def ok(*a, **kw):
                return resp_or_exc

            self._mod.urllib.request.urlopen = _BenchCapture(ok)
        return self._mod.urllib.request.urlopen

    def test_stream_metrics_and_request_shape(self):
        # Fake stream: 3 content chunks, usage in the final empty chunk,
        # then [DONE]. The fake stream is iterated in order.
        lines = [
            _line(_chunk("a")),
            _line(_chunk("b")),
            _line(_chunk("c")),
            _line({"choices": [], "usage": {"prompt_tokens": 5,
                                            "completion_tokens": 3}}),
            b"data: [DONE]\n\n",
        ]

        self._patch(_sse_response(lines))

        # Patch the module clock seam: t0, then one tick per content chunk
        # (wall = 1.8s window; first token 0.8s in -> ttft 0.8, tps ~2).
        ticks = iter([100.0, 100.8, 101.3, 101.8])
        self._old_now = self._mod.NOW
        self._mod.NOW = lambda: next(ticks)
        try:
            s = self._mod.run_once("qwen3.8-27b-hermes", PROMPTS["short_tool"],
                                   base="http://127.0.0.1:1234/")
        finally:
            self._mod.NOW = self._old_now

        self.assertEqual(s["tokens"], 3)
        self.assertAlmostEqual(s["ttft_s"], 0.8, places=1)   # 100.8 - 100.0
        self.assertAlmostEqual(s["tps"], 2.0, places=1)      # 3 toks / 2.0s window
        self.assertAlmostEqual(s["wall_s"], 1.8, places=1)   # last token - t0
        self.assertEqual(s["prompt_class"], "short_tool")
        self.assertEqual(s.get("completion_tokens"), 3)
        self.assertEqual(s.get("prompt_tokens"), 5)

        # Request assertions (the capture object replaced urlopen).
        cap = self._mod.urllib.request.urlopen
        if hasattr(cap, "requests") and cap.requests:
            r = cap.requests[0]
        else:
            self.fail("urlopen was not captured")
        self.assertEqual(r.full_url, "http://127.0.0.1:1234/v1/chat/completions")
        body = json.loads(r.data.decode())
        self.assertTrue(body["stream"])
        self.assertEqual(body["model"], "qwen3.8-27b-hermes")
        self.assertEqual(body["messages"], [{"role": "user",
                                             "content": PROMPTS["short_tool"]}])

    def test_reasoning_content_counts_as_tokens(self):
        # Reasoning models stream delta.reasoning_content before any
        # delta.content; a content-only count reads the stream near-empty.
        def _rchunk(text):
            return {"choices": [{"delta": {"reasoning_content": text},
                                 "index": 0}]}

        lines = [
            _line(_rchunk("think")),
            _line(_rchunk("ing")),
            _line(_chunk("ok")),
            _line({"choices": [], "usage": {"prompt_tokens": 5,
                                            "completion_tokens": 3}}),
            b"data: [DONE]\n\n",
        ]
        self._patch(_sse_response(lines))
        ticks = iter([200.0, 200.4, 200.8, 201.2])
        self._old_now = self._mod.NOW
        self._mod.NOW = lambda: next(ticks)
        try:
            s = self._mod.run_once("qwen3.8-27b-hermes",
                                   PROMPTS["short_tool"],
                                   base="http://127.0.0.1:1234/")
        finally:
            self._mod.NOW = self._old_now

        self.assertEqual(s["tokens"], 3)
        self.assertAlmostEqual(s["ttft_s"], 0.4, places=1)
        self.assertAlmostEqual(s["tps"], 2.5, places=1)   # 2 gaps of 0.4s

    def test_empty_stream_sample(self):
        # No content chunks at all — usage-only final chunk then [DONE].
        lines = [
            _line({"choices": [], "usage": {"prompt_tokens": 4,
                                            "completion_tokens": 0}}),
            b"data: [DONE]\n\n",
        ]

        self._patch(_sse_response(lines))
        self._old_now = self._mod.NOW
        self._mod.NOW = lambda: 50.0   # only t0 ever fires (no content chunk)
        try:
            s = self._mod.run_once("qwen3.8-27b-hermes", "some custom prompt")
        finally:
            self._mod.NOW = self._old_now

        self.assertEqual(s["tokens"], 0)
        self.assertIsNone(s["tps"])
        self.assertIsNone(s.get("ttft_s"))
        self.assertIsNone(s["wall_s"])   # no tokens landed — nothing to time
        self.assertEqual(s["prompt_class"], "custom")

    def test_upstream_error_propagates(self):
        import urllib.error

        self._patch(urllib.error.HTTPError(
            "http://127.0.0.1:1234/v1/chat/completions", 503,
            "nope", None, None))   # type: ignore[arg-type]  (pyright wants headers; None is a valid runtime value)

        self._old_now = self._mod.NOW
        self._mod.NOW = lambda: 0.0   # t0 only; the error fires before any chunk
        try:
            with self.assertRaises(urllib.error.HTTPError):
                self._mod.run_once("qwen3.8-27b-hermes", "x")
        finally:
            self._mod.NOW = self._old_now


if __name__ == "__main__":
    unittest.main()
