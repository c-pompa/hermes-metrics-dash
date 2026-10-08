#!/usr/bin/env python3
"""Session deep-dive analysis for the Hermes metrics dashboard.

Produces the standardized per-session breakdown (status / shape / tokens /
loop verdict / assessment / recommendation) for sessions captured in the
metrics DB — either on demand (--session) or for the top sessions of a
window (--top, used by health_weekly_digest.py).

Stdlib only and standalone apart from the records DB — copied to the mini
together with health_weekly_digest.py. Constants mirrored from
static/compression.html / health_rules.py — keep in sync.
"""

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.request

DEFAULT_DB = os.path.expanduser("~/.hermes/metrics/metrics.db")
DEFAULT_API = os.environ.get("METRICS_API", "http://127.0.0.1:8899")

# Sessions below this many api calls in the window are not deep-dived — the
# digest only analyzes once the job has captured enough runs to judge.
MIN_CALLS = 25

# Mirrored from static/compression.html LOAD_SETTINGS (2026-07-24 snapshot).
LOAD_SETTINGS = {
    "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5": {"gb": 18.23, "ctx": 103424, "parallel": 2},
    "supergemma4-26b-uncensored-mlx-v2": {"gb": 14.23, "ctx": 64000, "parallel": 1},
    "text-embedding-nomic-embed-text-v1.5": {"gb": 0.08, "ctx": 2048, "parallel": None},
}
ACTIVE_SLACK_S = 1800  # last call within 30 min → still running


# ---------------------------------------------------------------- formatting
def fmt_tok(n):
    if n >= 1_000_000:
        return "%.1fM" % (n / 1_000_000)
    if n >= 10_000:
        return "%.0fk" % (n / 1000)
    if n >= 1000:
        return "%.1fk" % (n / 1000)
    return str(int(round(n)))


def fmt_clock(ts):
    return time.strftime("%H:%M", time.localtime(ts))


def fmt_ago(ts, now):
    m = int((now - ts) / 60)
    if m < 60:
        return "%d min" % m
    return "%.1f h" % (m / 60)


def short_model(m):
    return (m or "?").replace("qwen3.6-35b-a3b-", "q35-").replace("-uncensored", "").replace("-mlx-v2", "")


# ---------------------------------------------------------------- data
def _connect_ro(db_path):
    return sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)


def load_session(db_path, sid_prefix, since):
    """api + error rows for one session (prefix match), oldest first."""
    conn = _connect_ro(db_path)
    try:
        api = conn.execute(
            "SELECT ts, input_tokens, output_tokens, duration_s, tps, finish_reason, model, platform"
            " FROM records WHERE kind='api' AND session_id LIKE ? AND ts >= ? ORDER BY ts",
            (sid_prefix + "%", since)).fetchall()
        errs = conn.execute(
            "SELECT ts, error, event FROM records WHERE kind='error'"
            " AND session_id LIKE ? AND ts >= ? ORDER BY ts",
            (sid_prefix + "%", since)).fetchall()
    finally:
        conn.close()
    return api, errs


def candidate_sessions(db_path, since, limit=3, min_calls=MIN_CALLS):
    """Sessions worth a deep-dive: most cumulative input tokens in the window
    among those with >= min_calls api calls."""
    conn = _connect_ro(db_path)
    try:
        rows = conn.execute(
            "SELECT session_id, COUNT(*) c, SUM(input_tokens) sin"
            " FROM records WHERE kind='api' AND session_id IS NOT NULL AND ts >= ?"
            " GROUP BY session_id HAVING c >= ? ORDER BY sin DESC LIMIT ?",
            (since, min_calls, limit)).fetchall()
    finally:
        conn.close()
    return [r[0] for r in rows]


def fetch_session_names(api_base):
    """id -> title from the local dashboard; {} if unreachable."""
    try:
        with urllib.request.urlopen(api_base + "/api/session-names", timeout=2) as res:
            return json.loads(res.read().decode())
    except Exception:
        return {}


# ---------------------------------------------------------------- analysis
def loop_signature(points):
    """Mirror of the R11 beta detector (compression.html detectAgentLoop) on
    the trailing 8 calls. Deltas are computed regardless of finish reasons so
    the verdict can still describe step variance when a `stop` broke the run.
    Returns dict(is_loop, deltas, median, steps)."""
    pts = points[-8:]
    deltas = [pts[i][1] - pts[i - 1][1] for i in range(1, len(pts))]
    if len(pts) < 6 or any(p[5] != "tool_calls" for p in pts):
        return {"is_loop": False, "deltas": deltas, "median": 0, "steps": 0}
    if any(d <= 0 or d > 4000 for d in deltas):
        return {"is_loop": False, "deltas": deltas, "median": 0, "steps": 0}
    med = sorted(deltas)[len(deltas) // 2]
    ok = all(abs(d - med) <= max(med * 0.45, 250) for d in deltas)
    return {"is_loop": ok, "deltas": deltas, "median": med, "steps": len(deltas)}


def analyze(api_rows, err_rows, sid, name, now):
    """Deterministic session breakdown. api_rows: tuples from load_session."""
    a = {"sid": sid, "name": name or "no name recorded", "calls": len(api_rows)}
    if not api_rows:
        a["empty"] = True
        return a
    first, last = api_rows[0], api_rows[-1]
    tot_in = sum(r[1] or 0 for r in api_rows)
    tot_out = sum(r[2] or 0 for r in api_rows)
    tool_calls = sum(1 for r in api_rows if r[5] == "tool_calls")
    peak_in = max(r[1] or 0 for r in api_rows)
    model = last[6]
    a.update({
        "empty": False,
        "first_ts": first[0], "last_ts": last[0],
        "span_h": (last[0] - first[0]) / 3600,
        "active": now - last[0] < ACTIVE_SLACK_S,
        "last_finish": last[5],
        "model": model, "platform": last[7],
        "tot_in": tot_in, "tot_out": tot_out,
        "ratio": (tot_in / tot_out) if tot_out else None,
        "avg_in": tot_in / len(api_rows),
        "tool_pct": tool_calls / len(api_rows) * 100,
        "peak_in": peak_in,
        "errors": len(err_rows),
        "error_samples": [(e[0], (e[1] or e[2] or "error")) for e in err_rows[-3:]],
        "loop": loop_signature(api_rows),
    })
    cap = (LOAD_SETTINGS.get(model) or {}).get("ctx")
    a["pool_pct"] = (peak_in / cap * 100) if cap else None

    # Assessment + recommendation — deterministic decision tree, most
    # specific signal first. The template recommends, humans act.
    concerns, rec = [], None
    if a["loop"]["is_loop"]:
        concerns.append("trailing calls match the uniform-probe loop signature "
                        "(%d consecutive tool_calls, ~+%s/step)" % (a["loop"]["steps"], fmt_tok(a["loop"]["median"])))
        rec = "Likely a genuine retry loop — inspect and kill the session, then fix the prompt/tool wiring."
    if a["errors"]:
        concerns.append("%d error%s recorded (latest: %s)" % (
            a["errors"], "" if a["errors"] == 1 else "s", a["error_samples"][-1][1][:120]))
    if a["pool_pct"] and a["pool_pct"] >= 85:
        concerns.append("single-handedly consumed up to %.0f%% of the %s pool (peak %s/%s)" % (
            a["pool_pct"], short_model(model), fmt_tok(peak_in), fmt_tok(cap)))
        pool_rec = ("Capacity risk while it ran — lower `parallel` or raise loaded ctx on %s, "
                    "or cap sessions of this size." % short_model(model))
    else:
        pool_rec = None
    if a["ratio"] and a["ratio"] > 50 and not a["loop"]["is_loop"]:
        concerns.append("Σin:Σout %.0f:1 — but this inflates naturally on tool-heavy sessions "
                        "(full context resent per call; avg %s in/call ≈ its working context)" % (
                            a["ratio"], fmt_tok(a["avg_in"])))
    if a["tool_pct"] >= 90 and a["calls"] >= 100:
        concerns.append("long autonomous run: %d calls, %.0f%% tool_calls" % (a["calls"], a["tool_pct"]))
    lname = (a["name"] or "").lower()
    if "guardrail" in lname or "resum" in lname:
        concerns.append("session name suggests it was resumed after a guardrail hit, then ran "
                        "%d further calls" % a["calls"])
        rec = rec or ("Resumed-after-guardrail sessions that run 100+ further tool calls are the "
                      "pattern to cap — consider a HITL checkpoint on resume in the profile config.")
    rec = rec or pool_rec
    if rec is None:
        rec = ("Still running — watch pool pressure and verify compression keeps up."
               if a["active"] else
               "No action needed — guardrails behaved; file under 'aware' unless the output "
               "wasn't worth the tokens.")
    a["concerns"] = concerns
    a["recommendation"] = rec
    if a["loop"]["is_loop"]:
        a["verdict"] = ("LOOP SIGNATURE — %d consecutive tool_calls in uniform ~+%s steps" % (
            a["loop"]["steps"], fmt_tok(a["loop"]["median"])))
    elif a["loop"]["deltas"]:
        ds = a["loop"]["deltas"]
        a["verdict"] = ("no uniform-loop signature — trailing steps varied (%s…%s tok)%s" % (
            fmt_tok(min(ds)), fmt_tok(max(ds)),
            ", ended on %s" % a["last_finish"] if a["last_finish"] == "stop" else ""))
    else:
        a["verdict"] = "no uniform-loop signature (too few trailing tool_calls to judge)"
    return a


# ---------------------------------------------------------------- template
def render_markdown(a, now):
    """The standardized deep-dive block. Fixed slots — same shape every time,
    so week-over-week reports are comparable at a glance."""
    if a.get("empty"):
        return "### Session %s\n\nNo api calls in window.\n" % a["sid"]
    status = ("ACTIVE (last call %s ago)" % fmt_ago(a["last_ts"], now)) if a["active"] else \
             ("finished %s ago (last call %s, finish=%s)" % (
                 fmt_ago(a["last_ts"], now), fmt_clock(a["last_ts"]), a["last_finish"]))
    lines = [
        "### Session %s — %s" % (a["sid"], a["name"]),
        "",
        "- **Status:** %s · %d error%s" % (status, a["errors"], "" if a["errors"] == 1 else "s"),
        "- **Shape:** %d calls over %.1fh (%s→%s) · %.0f%% tool_calls · %s · context peak %s" % (
            a["calls"], a["span_h"], fmt_clock(a["first_ts"]), fmt_clock(a["last_ts"]),
            a["tool_pct"], short_model(a["model"]), fmt_tok(a["peak_in"])),
        "- **Tokens:** Σin %s · Σout %s (%.0f:1) · avg %s in/call" % (
            fmt_tok(a["tot_in"]), fmt_tok(a["tot_out"]), a["ratio"] or 0, fmt_tok(a["avg_in"])),
        "- **Loop verdict:** %s" % a["verdict"],
    ]
    if a["pool_pct"]:
        lines.append("- **Pool impact:** peak %s = %.0f%% of %s ctx single-handedly" % (
            fmt_tok(a["peak_in"]), a["pool_pct"], short_model(a["model"])))
    if a["concerns"]:
        lines.append("- **Concerns:**")
        lines += ["  %d. %s" % (i + 1, c) for i, c in enumerate(a["concerns"])]
    lines.append("- **Recommendation:** %s" % a["recommendation"])
    lines.append("")
    return "\n".join(lines) + "\n"


def deepdive(db_path, sid_prefix, since, now, names=None):
    names = names if names is not None else fetch_session_names(DEFAULT_API)
    api, errs = load_session(db_path, sid_prefix, since)
    full_sid = sid_prefix
    if api:
        # load_session matched by prefix; recover the full id from the DB.
        conn = _connect_ro(db_path)
        try:
            row = conn.execute(
                "SELECT DISTINCT session_id FROM records WHERE session_id LIKE ? LIMIT 1",
                (sid_prefix + "%",)).fetchone()
            if row:
                full_sid = row[0]
        finally:
            conn.close()
    name = names.get(full_sid) or names.get(sid_prefix)
    return analyze(api, errs, full_sid, name, now)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Per-session deep-dive analysis.")
    ap.add_argument("--db", default=DEFAULT_DB, help="metrics sqlite DB (default %(default)s)")
    ap.add_argument("--api", default=DEFAULT_API, help="dashboard base URL for session names")
    ap.add_argument("--days", type=float, default=7, help="trailing window in days (default 7)")
    ap.add_argument("--session", help="session id (or unique prefix) to analyze")
    ap.add_argument("--top", type=int, default=0,
                    help="analyze the top N sessions by cumulative input tokens (>= %d calls)" % MIN_CALLS)
    ap.add_argument("--out", help="write markdown here instead of stdout")
    args = ap.parse_args(argv)

    now = time.time()
    since = now - args.days * 86400
    if not os.path.exists(args.db):
        print("metrics DB not found at %s" % args.db, file=sys.stderr)
        return 1
    if not args.session and not args.top:
        ap.error("give --session <id> or --top N")

    names = fetch_session_names(args.api)
    sids = [args.session] if args.session else candidate_sessions(args.db, since, args.top)
    blocks = []
    for sid in sids:
        a = deepdive(args.db, sid, since, now, names)
        blocks.append(render_markdown(a, now))
    md = "\n".join(blocks)
    if args.out:
        with open(args.out, "w") as f:
            f.write(md)
        print("wrote %s (%d session%s)" % (args.out, len(blocks), "" if len(blocks) == 1 else "s"))
    else:
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
