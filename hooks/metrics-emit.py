#!/usr/bin/env python3
"""Hermes shell hook: append per-LLM-request metrics to ~/.hermes/metrics/requests.jsonl.

Wired to the ``post_api_request``, ``api_request_error`` and ``subagent_stop``
events via the ``hooks:`` block in ~/.hermes/config.yaml. Receives the hook
payload as JSON on stdin ({hook_event_name, session_id, ..., extra: {...}})
and writes one compact JSON line per event. A separate forwarder tails the
file and ships records to the metrics dashboard — this script must stay fast
and never fail the turn (any error exits 0 silently).
"""
import json
import os
import sys
import time


def main() -> None:
    payload = json.load(sys.stdin)
    event = payload.get("hook_event_name") or ""
    extra = payload.get("extra") or {}

    rec = {
        "ts": time.time(),
        "event": event,
        "session_id": payload.get("session_id") or "",
        "parent_session_id": payload.get("parent_session_id"),
    }

    if event in ("post_api_request", "api_request_error"):
        for key in (
            "task_id", "turn_id", "api_request_id", "platform",
            "model", "provider", "base_url", "api_mode",
            "api_call_count", "api_duration", "started_at", "ended_at",
            "finish_reason", "message_count", "response_model",
            "usage", "stats", "assistant_content_chars",
            "assistant_tool_call_count", "error_type", "error_message",
        ):
            if key in extra:
                rec[key] = extra[key]
        usage = rec.get("usage") or {}
        dur = rec.get("api_duration")
        out_tok = usage.get("output_tokens") if isinstance(usage, dict) else None
        if dur and out_tok:
            rec["tps"] = round(out_tok / dur, 2)
    elif event == "subagent_stop":
        for key in (
            "child_session_id", "child_role", "child_status",
            "child_summary", "duration_ms", "parent_turn_id",
        ):
            if key in extra:
                rec[key] = extra[key]
    else:
        rec["extra_keys"] = sorted(extra.keys())

    line = json.dumps(rec, ensure_ascii=False, default=str) + "\n"
    path = os.path.expanduser("~/.hermes/metrics/requests.jsonl")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Single O_APPEND write keeps concurrent emitters (parallel subagents)
    # from interleaving within a record.
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, line.encode("utf-8"))
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
