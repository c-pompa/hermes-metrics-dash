#!/usr/bin/env python3
"""Weekly health-findings digest for the Hermes metrics dashboard.

Reads the server-side `health_findings` snapshots (written by app.py every
30 min) for the trailing N days and writes a markdown digest to
docs/health-digest-<ISO year>-W<ISO week>.md.

Stdlib only and fully standalone — this file is copied to the mini on its
own, so it must not import anything from the repo root.
"""

import argparse
import os
import sqlite3
import sys
import time
from datetime import datetime

# Session deep-dives ship alongside this file in scripts/; optional — the
# digest still works (with a note) if session_deepdive.py wasn't deployed.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import session_deepdive
except ImportError:
    session_deepdive = None

DEFAULT_DB = os.path.expanduser("~/.hermes/metrics/metrics.db")
# Docs dir next to the repo checkout (parent of this scripts/ dir).
DEFAULT_OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "docs")

# Mirrored from health_rules.py / static/compression.html — keep in sync.
RULE_LABELS = {
    "R1": "compression summarizer not resident",
    "R2": "session over threshold, no compaction",
    "R3": "pool overflow forecast",
    "R4": "token waste / retry loop",
    "R5": "pool pressure peak",
    "R6": "parallel x p95 exceeds pool",
    "R7": "host memory headroom",
    "R8": "error burst (15 min)",
    "R9": "residency churn",
    "R10": "idle residency",
    "R11": "agent loop (beta)",
}

# Concrete optimization recommendations per rule. Deliberately specific —
# the digest recommends, humans act.
RECOMMENDATIONS = {
    "R1": "Load the summarizer model in LM Studio (or repoint agents.compression) — "
          "while it is missing, compactions fail as silent no-ops.",
    "R2": "Verify compression is actually firing for this profile — a session crossed "
          "the threshold and never compacted.",
    "R3": "A session is on track to overflow its pool — compact it proactively or shed "
          "parallel load before requests start failing.",
    "R4": "Inspect and kill the looping session — the Sigma-in:Sigma-out ratio shows "
          "tokens burned on retries for almost no output.",
    "R5": "Pool peaked at/over capacity — lower `parallel` for that model or raise its "
          "loaded ctx so concurrent sessions stop colliding.",
    "R6": "Fix the capacity math: parallel x p95 session exceeds the pool — lower "
          "parallel or raise the loaded ctx for that model.",
    "R7": "Host memory is nearly full — unload a model to free RAM before further "
          "model loads start failing.",
    "R8": "Investigate the error burst in the dashboard's error breakdown — repeated "
          "errors in 15 min usually means a model or host hiccup.",
    "R9": "Check TTL eviction settings and LM Link stability — the model is flapping "
          "in/out of the pool.",
    "R10": "Unload the idle model — it is holding RAM while serving no requests.",
    "R11": "Inspect the flagged session — it is likely an agent loop repeating the "
           "same probe; kill it and fix the prompt/tool wiring.",
}

SEV_ORDER = {"crit": 0, "warn": 1, "info": 2, "ok": 3}
# Fires-per-week at or above which a rule lands in "Act on these".
ACT_FIRES_THRESHOLD = 3


def local_day(ts):
    return time.strftime("%Y-%m-%d", time.localtime(ts))


def load_findings(db_path, since):
    """Return rows (ts, rule, sev, text, action); [] on any missing piece."""
    if not os.path.exists(db_path):
        return []
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    except sqlite3.Error:
        return []
    try:
        cur = conn.execute(
            "SELECT ts, rule, sev, text, action FROM health_findings WHERE ts >= ? ORDER BY ts",
            (since,),
        )
        return cur.fetchall()
    except sqlite3.Error:
        # Table missing (backend not deployed yet) or unreadable — not fatal.
        return []
    finally:
        conn.close()


def aggregate(rows):
    """Per-rule rollup: count, distinct local days, worst sev, latest example."""
    rules = {}
    for ts, rule, sev, text, action in rows:
        r = rules.setdefault(rule, {
            "rule": rule, "count": 0, "days": set(),
            "worst_sev": "ok", "last_ts": 0.0, "text": "", "action": "",
        })
        r["count"] += 1
        r["days"].add(local_day(ts))
        if SEV_ORDER.get(sev, 3) < SEV_ORDER.get(r["worst_sev"], 3):
            r["worst_sev"] = sev
        if ts >= r["last_ts"]:
            r["last_ts"] = ts
            r["text"] = text or ""
            r["action"] = action or ""
    out = sorted(rules.values(), key=lambda r: (-r["count"], r["rule"]))
    for r in out:
        r["days_fired"] = len(r["days"])
        r["label"] = RULE_LABELS.get(r["rule"], "")
    return out


def iso_week_name(now):
    iso = datetime.fromtimestamp(now).isocalendar()
    return "%04d-W%02d" % (iso[0], iso[1])


def render_digest(rules, days, now, total, source_note=None, deepdives_md=None):
    week = iso_week_name(now)
    since = now - days * 86400
    lines = [
        "# Health Digest — %s" % week,
        "",
        "Generated: %s · window: last %d day%s (%s → %s)" % (
            time.strftime("%Y-%m-%d %H:%M local", time.localtime(now)),
            days, "" if days == 1 else "s",
            local_day(since), local_day(now),
        ),
    ]
    if source_note:
        lines.append("\n_%s_" % source_note)
    if not total:
        lines += [
            "",
            "No findings recorded in the last %d day%s — all health checks passing "
            "(or snapshots not yet deployed)." % (days, "" if days == 1 else "s"),
            "",
        ]
        return "\n".join(lines) + "\n"

    lines += [
        "",
        "Total findings: %d across %d rule%s." % (total, len(rules), "" if len(rules) == 1 else "s"),
        "",
        "## Summary",
        "",
        "| rule | label | fires | days fired | worst severity |",
        "|------|-------|------:|-----------:|----------------|",
    ]
    for r in rules:
        lines.append("| %s | %s | %d | %d | %s |" % (
            r["rule"], r["label"], r["count"], r["days_fired"], r["worst_sev"]))

    act = [r for r in rules if r["count"] >= ACT_FIRES_THRESHOLD or r["worst_sev"] == "crit"]
    aware = [r for r in rules if r not in act]

    lines += ["", "## Act on these", ""]
    if act:
        for r in act:
            lines.append("### %s — %s (%d fire%s, %d day%s, worst: %s)" % (
                r["rule"], r["label"], r["count"], "" if r["count"] == 1 else "s",
                r["days_fired"], "" if r["days_fired"] == 1 else "s", r["worst_sev"]))
            if r["text"]:
                lines.append("> %s" % r["text"])
            if r["action"]:
                lines.append("→ %s" % r["action"])
            lines.append("")
            rec = RECOMMENDATIONS.get(r["rule"],
                                      "Recurring finding — investigate the latest occurrence above.")
            lines.append("**Recommendation:** %s" % rec)
            lines.append("")
    else:
        lines.append("Nothing this week — no rule fired %d+ times and nothing crit." % ACT_FIRES_THRESHOLD)
        lines.append("")

    lines += ["## Aware, no action needed", ""]
    if aware:
        for r in aware:
            entry = "- **%s — %s** (%d fire%s, %d day%s, worst: %s)" % (
                r["rule"], r["label"], r["count"], "" if r["count"] == 1 else "s",
                r["days_fired"], "" if r["days_fired"] == 1 else "s", r["worst_sev"])
            if r["text"]:
                entry += ": %s" % r["text"]
            lines.append(entry)
    else:
        lines.append("None.")
    lines.append("")
    if deepdives_md:
        lines += ["## Session deep-dives", "",
                  "Standardized breakdowns for the week's biggest sessions "
                  "(status / shape / tokens / loop verdict / concerns / recommendation).", ""]
        lines.append(deepdives_md)
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Weekly health-findings digest.")
    ap.add_argument("--db", default=DEFAULT_DB, help="metrics sqlite DB (default %(default)s)")
    ap.add_argument("--days", type=int, default=7, help="trailing window in days (default 7)")
    ap.add_argument("--out", default=None, help="output path (default docs/health-digest-<ISO week>.md)")
    ap.add_argument("--deepdives", type=int, default=3,
                    help="per-session deep-dives for the top N sessions (0 disables; "
                         "needs session_deepdive.py alongside this script)")
    args = ap.parse_args(argv)

    now = time.time()
    out_path = args.out or os.path.join(
        DEFAULT_OUT_DIR, "health-digest-%s.md" % iso_week_name(now))

    rows = load_findings(args.db, now - args.days * 86400)
    source_note = None
    if not rows and not os.path.exists(args.db):
        source_note = "metrics DB not found at %s" % args.db
    elif not rows:
        source_note = "no health_findings rows in window (table empty or not yet created)"
    rules = aggregate(rows)

    deepdives_md = None
    if args.deepdives and session_deepdive and os.path.exists(args.db):
        since = now - args.days * 86400
        names = session_deepdive.fetch_session_names(session_deepdive.DEFAULT_API)
        blocks = []
        for sid in session_deepdive.candidate_sessions(args.db, since, args.deepdives):
            a = session_deepdive.deepdive(args.db, sid, since, now, names)
            blocks.append(session_deepdive.render_markdown(a, now))
        if blocks:
            deepdives_md = "\n".join(blocks)

    digest = render_digest(rules, args.days, now, len(rows), source_note, deepdives_md)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w") as f:
        f.write(digest)
    print("wrote %s (%d findings, %d rules)" % (out_path, len(rows), len(rules)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
