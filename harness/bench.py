"""Streaming benchmark: TTFT and decode tok/s measured from chunk timestamps.

Hits the LM Studio OpenAI-compatible endpoint (``POST /v1/chat/completions``,
``stream: true``) and measures what LM Studio's own ``stats`` API can't give
us (empty in 0.4.x): first-token latency and decode rate, derived from the
arrival times of content chunks on our side.

All timing goes through :data:`NOW` (monkeypatchable in tests) and all
network I/O through ``urllib.request.urlopen`` — unit tests stub both, so
nothing here needs a live model. Stdlib only, py3.9-compatible (the collector
runs on the MBP).
"""
import json
import time
import urllib.request

BASE = "http://127.0.0.1:1234"

# Three probe classes covering the shapes our traffic actually has: a trivial
# tool call (TTFT-dominated), a long plain-text generation (decode-rate-
# dominated), and code output (mixed). Keep the strings stable — they are part
# of what makes repeats comparable across runs.
PROMPTS = {
    "short_tool": 'Reply with exactly one JSON object: {"ok": true}',
    "long_gen": "Write a 400-word plain-text summary of how a heat pump works.",
    "code_fix": "Write a Python function that dedupes a list of dicts by 'id'.",
}

# Timing seam: monotonic is right for deltas; tests patch this attribute.
NOW = time.monotonic


def chunk_stats(events):
    """events: [(\"t0\"|\"tok\", ts), ...] -> {ttft_s, tps, wall_s, tokens}.

    ``tok`` timestamps may be from any monotonic clock; only differences are
    used. Degenerate streams degrade to None instead of dividing by zero:

    * no tokens        -> ttft_s/tps/wall_s all None, tokens 0
    * a single token   -> ttft_s + wall_s set, tps None (no decode window)
    * zero-length gaps -> tokens counted, tps None
    """
    t0 = next((ts for k, ts in events if k == "t0"), None)
    toks = [ts for k, ts in events if k == "tok"]
    out = {"ttft_s": None, "tps": None, "wall_s": None,
           "tokens": len(toks)}
    if t0 is None or not toks:
        return out
    out["ttft_s"] = round(toks[0] - t0, 3)
    out["wall_s"] = round(toks[-1] - t0, 3)
    # Decode rate over the inter-token window only (TTFT is a separate metric):
    # one gap per *additional* token; degenerate cases stay None, not 0/inf.
    gaps = [b - a for a, b in zip(toks, toks[1:])]
    total = sum(gaps)
    if gaps and total > 0:
        out["tps"] = round(len(gaps) / total, 2)
    return out


def _parse_sse_line(line):
    """One raw SSE line -> (delta_text_or_None, usage_dict_or_None).

    Counts ``reasoning_content`` deltas as tokens too — reasoning models
    (qwen3.8-hermes et al.) spend most of their output there, and a
    content-only count reads a healthy stream as near-empty (ttft inflated
    by the whole reasoning phase, tps from a handful of answer tokens).
    """
    if not line.startswith("data:"):
        return None, None
    data = line[5:].strip()
    if not data or data == "[DONE]":
        return None, None
    try:
        obj = json.loads(data)
    except ValueError:
        return None, None   # keep going; a torn line is not the end of the stream
    delta = obj.get("choices", [{}])[0].get("delta", {}) \
        if obj.get("choices") else {}
    text = delta.get("content")
    if text is None:
        text = delta.get("reasoning_content")
    return text, obj.get("usage")


def run_once(model, prompt, base=BASE, timeout=420, max_tokens=512,
             temperature=0.2):
    """One streaming completion; returns chunk_stats + usage when present.

    Raises urllib/HTTP errors straight out — ``run_suite`` turns those into
    error-marked samples so one bad prompt doesn't abort the whole suite.
    """
    events = [("t0", NOW())]
    usage = None
    body = json.dumps({
        "model": model,
        "stream": True,
        "stream_options": {"include_usage": True},   # usage in the final chunk (OpenAI-compatible; 0.4.x honors it)
        "temperature": temperature,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            content, u = _parse_sse_line(line)
            if content:
                events.append(("tok", NOW()))
            if u:
                usage = u   # keep the latest (final) usage chunk
    out = chunk_stats(events)
    if usage:
        out["prompt_tokens"] = usage.get("prompt_tokens")
        out["completion_tokens"] = usage.get("completion_tokens")
    out["prompt_class"] = next(
        (k for k, v in PROMPTS.items() if v == prompt), "custom")
    return out


def run_suite(model, base=BASE, repeats=2):
    """Run every prompt class ``repeats`` times. Returns a list of samples —
    one dict per run, in prompt-class order.

    A failed request is recorded as a sample with ``error`` set and empty
    metrics rather than raised: the collector expects every suite to yield a
    full set of rows, and one transient 5xx shouldn't drop the other two
    classes from that cycle. The 1s settle gap keeps back-to-back runs from
    clustering thermally (visible on the dashboard's thermal chip).
    """
    samples = []
    for cls, prompt in PROMPTS.items():
        for _ in range(repeats):
            try:
                samples.append(run_once(model, prompt, base=base))
            except Exception as exc:   # noqa: BLE001 — suite must not die mid-run
                samples.append({"ttft_s": None, "tps": None, "wall_s": None,
                                "tokens": 0, "prompt_class": cls,
                                "error": "%s: %s" % (type(exc).__name__, exc)})
            time.sleep(1.0)   # settle; avoid thermal clustering
    return samples
