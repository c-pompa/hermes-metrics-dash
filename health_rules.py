#!/usr/bin/env python3
"""Server-side port of the dashboard's health rules R1-R13.

The live widget computes these client-side over the selected range
(static/compression.html: healthFindings(), analyse(), poolPressure(),
detectAgentLoop()). This module mirrors that logic so app.py can snapshot
findings into sqlite every 30 min and answer "how often did this fire this
week?" — the JS stays the live view; Python is the source of record for
history. Keep the two in sync: compression.html's constants block points here.
"""
import math
import time

# --- constants mirrored from static/compression.html (~lines 224-236) -------
# Load settings snapshot (2026-07-24): update both files when models are
# reloaded differently.
LOAD_SETTINGS = {
    "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5": {"gb": 18.23, "ctx": 103424, "parallel": 2},
    "supergemma4-26b-uncensored-mlx-v2":            {"gb": 14.23, "ctx": 64000,  "parallel": 1},
    "text-embedding-nomic-embed-text-v1.5":         {"gb": 0.08,  "ctx": 2048,   "parallel": None},
}
COMPACT_DROP_RATIO = 0.85   # next < 85% of prev → compaction
COMPACT_MIN_TOKENS = 4000   # …and at least this many tokens freed
# Hermes compression config mirrored for health checks (mini config.yaml +
# research profile as of 2026-07-25): summarizer model and trigger threshold.
COMPRESSION_SUMMARIZER = "supergemma4-26b-uncensored-mlx-v2"
COMPRESSION_THRESHOLD_TOKENS = 40000

# Short human labels per rule id, for the API and the weekly digest.
# Hover descriptions per rule id live in static/compression.html (RULE_DESCS)
# — keep the two in sync when adding or re-purposing a rule.
RULE_LABELS = {
    "OK": "all checks passing",
    "R1": "compression summarizer residency",
    "R2": "compression not firing",
    "R3": "context overflow forecast",
    "R4": "token waste / retry loop",
    "R5": "pool pressure peak",
    "R6": "parallel × p95 capacity",
    "R7": "host memory headroom",
    "R8": "error burst",
    "R9": "residency churn",
    "R10": "idle residency",
    "R11": "agent-loop detector (beta)",
    "R12": "guardrail-halt detector (beta)",
    "R13": "empty-response / reasoning burn (beta)",
}

SEV_ORDER = {"crit": 0, "warn": 1, "info": 2, "ok": 3}


def _to_fixed(x, digits):
    """JS Number.prototype.toFixed (round half away from zero)."""
    q = 10 ** digits
    rounded = math.floor(abs(x) * q + 0.5) / q
    if x < 0:
        rounded = -rounded
    return f"{rounded:.{digits}f}"


def fmt_tok(n):
    """Mirror of the JS fmtTok: 1643000 -> '1643k', 18000 -> '18k'."""
    if n >= 1000:
        return _to_fixed(n / 1000, 0 if n >= 10000 else 1) + "k"
    return str(math.floor(n + 0.5))


def fmt_time(ts):
    """Mirror of the JS fmtTime: local HH:MM."""
    return time.strftime("%H:%M", time.localtime(ts))


def short_model(m):
    return str(m or "?").replace("qwen3.6-35b-a3b-", "q35-") \
        .replace("-uncensored", "").replace("-mlx-v2", "")


# ---------------------------------------------------------------------------
# Analysis helpers (port of analyse()/poolDemand()/poolPressure()).

def pool_demand(reqs, t0, t1, samples):
    """Concurrent-context demand: each request occupies its input_tokens in
    the model's shared KV pool for its measured duration [ts-dur, ts]."""
    pts = []
    for i in range(samples + 1):
        t = t0 + (t1 - t0) / samples * i
        demand = 0
        sids = []
        for q in reqs:
            if q["start"] <= t <= q["end"]:
                demand += q["tok"]
                sids.append(q["sid"])
        pts.append({"ts": t, "val": demand,
                    "meta": {"active": len(sids), "sids": sorted(set(sids))}})
    return pts


def pool_pressure(sessions):
    by_model = {}
    for sid, s in sessions.items():
        for p in s["points"]:
            if not p["model"]:
                continue
            by_model.setdefault(p["model"], []).append(
                {"start": p["ts"] - (p["dur"] or 0), "end": p["ts"],
                 "tok": p["tokens"], "sid": sid})
    out = []
    for model, reqs in by_model.items():
        if len(reqs) < 2:
            continue
        t0 = min(q["start"] for q in reqs)
        t1 = max(q["end"] for q in reqs)
        pts = pool_demand(reqs, t0, t1, 240)
        cap = (LOAD_SETTINGS.get(model) or {}).get("ctx")
        peak = max(pts, key=lambda p: p["val"])
        out.append({"model": model, "pts": pts, "cap": cap, "peak": peak})
    out.sort(key=lambda p: -(p["peak"]["val"] / (p["cap"] or 1e9)))
    return out


def analyse(records):
    """Group raw records into the structures the rules read. Records are
    dicts with the records-table column names (same shape /api/recent
    returns and the JS widget consumes)."""
    mem_series = {}   # host -> [{ts, used, total, cpu}]
    pool = {}         # device -> {model -> lastTs}
    pool_hist = {}    # "device|model" -> [ts, ...] for churn detection
    sessions = {}     # session_id -> {points, errors, model, platform}
    all_errors = []   # every error record, with or without a session
    guardrails = []   # guardrail_halt / guardrail_block records (agent.log tail)
    latest_pool_ts = 0.0

    for r in sorted(records, key=lambda x: x.get("ts") or 0):
        kind = r.get("kind")
        if kind == "host_stats" and r.get("mem_used_gb") is not None:
            mem_series.setdefault(r.get("host"), []).append({
                "ts": r.get("ts"), "used": r.get("mem_used_gb"),
                "total": r.get("mem_total_gb"), "cpu": r.get("cpu_load")})
        elif kind == "pool_status" and r.get("model") and r.get("device"):
            pool.setdefault(r["device"], {})[r["model"]] = r.get("ts")
            pool_hist.setdefault(r["device"] + "|" + r["model"], []).append(r.get("ts"))
            latest_pool_ts = max(latest_pool_ts, r.get("ts") or 0)
        elif kind == "api" and r.get("session_id") and r.get("input_tokens") is not None:
            s = sessions.setdefault(r["session_id"], {
                "points": [], "errors": [], "model": r.get("model"),
                "platform": r.get("platform")})
            s["points"].append({
                "ts": r.get("ts"), "tokens": r.get("input_tokens"),
                "out": r.get("output_tokens"), "dur": r.get("duration_s"),
                "tps": r.get("tps"), "model": r.get("model"),
                "fin": r.get("finish_reason"),
                "chars": r.get("assistant_content_chars"),
                "rt": r.get("reasoning_tokens")})
            s["model"] = r.get("model") or s["model"]
        elif kind in ("guardrail_halt", "guardrail_block"):
            guardrails.append({
                "ts": r.get("ts"), "kind": kind,
                "sid": r.get("session_id") or "", "model": r.get("model"),
                "tool": r.get("label"), "error": r.get("error") or ""})
        elif kind == "error":
            all_errors.append({
                "ts": r.get("ts"),
                "error": r.get("error") or r.get("event") or "error",
                "sid": r.get("session_id") or "", "model": r.get("model")})
            if r.get("session_id"):
                s = sessions.setdefault(r["session_id"], {
                    "points": [], "errors": [], "model": r.get("model"),
                    "platform": r.get("platform")})
                s["errors"].append({
                    "ts": r.get("ts"),
                    "error": r.get("error") or r.get("event") or "error",
                    "model": r.get("model"), "host": r.get("host"),
                    "turn": r.get("turn_id"), "req": r.get("api_request_id")})

    compactions = []
    for sid, s in sessions.items():
        s["compactions"] = []
        pts = s["points"]
        for i in range(1, len(pts)):
            prev, cur = pts[i - 1], pts[i]
            if (cur["tokens"] < prev["tokens"] * COMPACT_DROP_RATIO
                    and prev["tokens"] - cur["tokens"] >= COMPACT_MIN_TOKENS):
                ev = {"ts": cur["ts"], "sid": sid,
                      "before": prev["tokens"], "after": cur["tokens"]}
                s["compactions"].append(ev)
                compactions.append(ev)

    # Residency: models seen in the last 2 sampling intervals (~2 min slack)
    live = {}
    for device, models in pool.items():
        keep = [m for m, ts in models.items() if latest_pool_ts - (ts or 0) < 120]
        if keep:
            live[device] = keep
    return {"mem_series": mem_series, "live": live, "sessions": sessions,
            "compactions": compactions, "all_errors": all_errors,
            "guardrails": guardrails,
            "pool_hist": pool_hist, "pressure": pool_pressure(sessions)}


# [BETA] loop signature: >=6 trailing calls, all finish=tool_calls, strictly
# growing context in near-identical steps (each within 45% of the median, or
# 250 tok), no step over 4k. Returns {"steps", "med"} or None.
def detect_agent_loop(s):
    pts = s["points"][-8:]
    if len(pts) < 6:
        return None
    if not all(p["fin"] == "tool_calls" for p in pts):
        return None
    deltas = [pts[i]["tokens"] - pts[i - 1]["tokens"] for i in range(1, len(pts))]
    if any(d <= 0 or d > 4000 for d in deltas):
        return None
    med = sorted(deltas)[len(deltas) // 2]
    if not all(abs(d - med) <= max(med * 0.45, 250) for d in deltas):
        return None
    return {"steps": len(deltas), "med": med}


# [BETA] empty-response signature: assistant_content_chars == 0 on a call that
# did NOT end in tool_calls (a pure tool-call turn legitimately has 0 visible
# chars). Pathological when the turn ended (finish stop/length) with nothing
# visible, or when reasoning tokens are ~all of the completion (>=90%) — the
# model burned its budget thinking and answered with air. Born from session
# 20260730_231425_926af4 (7 empty stop calls, "healed empty non-final message"
# sanitizer warnings on every subsequent API call). Returns the matching
# points, or an empty list.
def detect_empty_responses(s):
    out = []
    for p in s["points"]:
        if p.get("chars") != 0 or p["fin"] == "tool_calls":
            continue
        rt = p.get("rt") or 0
        comp = p.get("out") or 0
        if p["fin"] in ("length", "stop") or (comp and rt >= 0.9 * comp):
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# Health rules (port of healthFindings()). Each finding carries its evidence
# in the text so a reader never has to trust a bare verdict.

def compute_findings(records, now, window_hours, beta_enabled=True, beta_widgets=None):
    """Run R1-R13 over `records` (records-table row dicts) as of `now`
    (epoch seconds) for a window of `window_hours`. Returns a list of
    {"rule", "sev", "text", "action", "beta"} dicts, severity-sorted; when
    nothing fires, a single sev="ok" finding leads.

    `beta_enabled` is the master switch for the beta rules (R11-R13) and
    stands in for the JS agent-loop-detector lifecycle check. `beta_widgets`
    is the raw widgets dict from /api/beta-widgets; R12 and R13 additionally
    honor their own per-widget keep/delete state (widget ids
    guardrail-halt-detector / empty-response-detector) — a missing entry
    means enabled, matching the client-side convention.
    """
    findings = []

    def add(rule, sev, text, action=None, beta=False):
        findings.append({"rule": rule, "sev": sev, "text": text,
                         "action": action, "beta": beta})

    def widget_on(widget_id):
        w = (beta_widgets or {}).get(widget_id) or {}
        return w.get("status") != "deleted"

    a = analyse(records)
    live_models = {}  # ordered set, like the JS Set built from A.live
    for models in a["live"].values():
        for m in models:
            live_models.setdefault(m)

    # R1 — compression summarizer must be resident, or compactions silently
    # no-op (the 2026-07-24 outage mode).
    if live_models and COMPRESSION_SUMMARIZER not in live_models:
        add("R1", "crit",
            f"compression summarizer {short_model(COMPRESSION_SUMMARIZER)} is not loaded in the pool",
            "load it (or repoint agents.compression) — compactions will fail as silent no-ops")

    for sid, s in a["sessions"].items():
        pts = s["points"]
        if not pts:
            continue
        last = pts[-1]
        if now - last["ts"] > 1800:
            continue  # only currently-active sessions
        cap = (LOAD_SETTINGS.get(s["model"]) or {}).get("ctx")
        # R2 — sessions past the compression threshold with no compaction yet.
        if last["tokens"] >= COMPRESSION_THRESHOLD_TOKENS and not s["compactions"]:
            sev = "crit" if cap and last["tokens"] >= cap * 0.7 else "warn"
            add("R2", sev,
                f"session {sid[:24]}… at {fmt_tok(last['tokens'])} tok "
                f"(threshold {fmt_tok(COMPRESSION_THRESHOLD_TOKENS)}) with 0 compactions",
                "verify compression is firing for this profile")
        # R3 — overflow forecast from recent growth (needs >=3 points, positive slope).
        if cap and len(pts) >= 3:
            recent = pts[-5:]
            dt = recent[-1]["ts"] - recent[0]["ts"]
            dtok = recent[-1]["tokens"] - recent[0]["tokens"]
            if dt > 60 and dtok > 0:
                eta_min = (cap * 0.95 - last["tokens"]) / (dtok / dt) / 60
                if 0 < eta_min < 45:
                    add("R3", "warn",
                        f"session {sid[:24]}… growing {fmt_tok(dtok / dt * 60)} tok/min — "
                        f"reaches {fmt_tok(cap)} pool in ~{math.floor(eta_min + 0.5)} min",
                        "expect compression or errors soon")
        # R4 — token waste: huge input for almost no output = a retry/failure loop.
        tot_in = sum(p["tokens"] for p in pts)
        tot_out = sum(p["out"] or 0 for p in pts)
        if tot_in > 200000 and tot_out > 0 and tot_in / tot_out > 50:
            add("R4", "warn",
                f"session {sid[:24]}… burned Σin {fmt_tok(tot_in)} for Σout {fmt_tok(tot_out)} "
                f"({math.floor(tot_in / tot_out + 0.5)}:1)",
                "check for a retry loop")
        # R13 [BETA] — empty/reasoning-only responses: 0 visible chars on a
        # finished turn, or reasoning tokens ~= the whole completion. Born from
        # session 20260730_231425_926af4 (empty stop calls + a sanitizer
        # "healed empty non-final message" warning on every later call).
        if beta_enabled and widget_on("empty-response-detector"):
            empties = detect_empty_responses(s)
            if len(empties) >= 2:
                burned = sum(p.get("rt") or 0 for p in empties)
                fins = sorted({p["fin"] or "?" for p in empties})
                add("R13", "crit" if len(empties) >= 5 else "warn",
                    f"session {sid[:24]}… returned {len(empties)} empty responses "
                    f"(0 chars, finish={'/'.join(fins)}; burned {fmt_tok(burned)} "
                    f"reasoning tokens)",
                    "the model is thinking without answering — check reasoning "
                    "budget / sanitizer healing loop",
                    beta=True)

    # R12 [BETA] — guardrail-halt detector: hermes's tool guardrails blocked a
    # repeated identical failing tool call and then ended the turn
    # (reason=guardrail_halt). Signal comes from guardrail_halt /
    # guardrail_block records tailed out of agent.log by forwarder.py.
    if beta_enabled and widget_on("guardrail-halt-detector"):
        halts_by_sid = {}
        codes_by_sid = {}
        for g in a["guardrails"]:
            if g["kind"] == "guardrail_halt":
                halts_by_sid.setdefault(g["sid"], []).append(g)
            else:
                codes_by_sid.setdefault(g["sid"], []).append(g)
        for sid, halts in halts_by_sid.items():
            blocks = codes_by_sid.get(sid) or []
            tools = sorted({b["tool"] for b in blocks if b["tool"]})
            last = halts[-1]
            detail = f"; blocked tool(s): {', '.join(tools)}" if tools else ""
            add("R12", "crit" if len(halts) >= 3 else "warn",
                f"guardrail halted session {(sid or '?')[:24]}… "
                f"{len(halts)}× (last at {fmt_time(last['ts'])}{detail})",
                "the agent repeated an identical failing tool call until the "
                "guardrail ended the turn — inspect the session",
                beta=True)

    # R11 [BETA] — agent-loop detector: born from session 20260725_214717_a544de,
    # which repeated the same probes for 45 min (uniform ~600-tok steps, every
    # call finish=tool_calls). Uniformity of growth is the discriminator —
    # normal agent work varies its step sizes.
    if beta_enabled:
        for sid, s in a["sessions"].items():
            pts = s["points"]
            if not pts:
                continue
            if now - pts[-1]["ts"] > 1800:
                continue
            loop = detect_agent_loop(s)
            if loop:
                add("R11", "warn",
                    f"possible agent loop: {sid[:24]}… — {loop['steps'] + 1} consecutive "
                    f"tool_calls, uniform +{fmt_tok(loop['med'])}/step",
                    "inspect the session — it is likely repeating the same probe",
                    beta=True)

    # R5 — pool pressure peak.
    worst = next((p for p in a["pressure"] if p["cap"]), None)
    if worst:
        pct = worst["peak"]["val"] / worst["cap"] * 100
        if pct >= 100:
            add("R5", "crit",
                f"{short_model(worst['model'])} pool overflowed: {fmt_tok(worst['peak']['val'])}"
                f"/{fmt_tok(worst['cap'])} at {fmt_time(worst['peak']['ts'])}",
                "lower parallel, shrink sessions, or raise ctx")
        elif pct >= 85:
            add("R5", "warn",
                f"{short_model(worst['model'])} pool peaked at {_to_fixed(pct, 0)}% "
                f"({fmt_tok(worst['peak']['val'])}/{fmt_tok(worst['cap'])})",
                "watch concurrent sessions on this model")

    # R6 — capacity math: parallel × p95 session peak vs the pool.
    peaks_by_model = {}
    for sid, s in a["sessions"].items():
        if not s["model"] or not s["points"]:
            continue
        peaks_by_model.setdefault(s["model"], []).append(
            max(p["tokens"] for p in s["points"]))
    for model, peaks in peaks_by_model.items():
        cfg = LOAD_SETTINGS.get(model)
        if not cfg or not cfg.get("ctx") or not cfg.get("parallel") or len(peaks) < 3:
            continue
        p95 = sorted(peaks)[math.floor((len(peaks) - 1) * 0.95)]
        if cfg["parallel"] * p95 > cfg["ctx"]:
            add("R6", "warn",
                f"{short_model(model)}: parallel {cfg['parallel']} × p95 session {fmt_tok(p95)} "
                f"= {fmt_tok(cfg['parallel'] * p95)} > pool {fmt_tok(cfg['ctx'])}",
                "lower parallel or raise loaded ctx")

    # R7 — host memory headroom.
    for host, pts in a["mem_series"].items():
        last = pts[-1]
        if not last["total"]:
            continue
        pct = last["used"] / last["total"] * 100
        text = (f"{host} memory at {_to_fixed(pct, 0)}% "
                f"({_to_fixed(last['used'], 1)}/{_to_fixed(last['total'], 0)} GB)")
        if pct >= 97:
            add("R7", "crit", text, "model loads will fail; unload something")
        elif pct >= 90:
            add("R7", "warn", text)

    # R8 — error burst in the last 15 minutes.
    recent_errs = [e for e in a["all_errors"] if now - e["ts"] < 900]
    if len(recent_errs) >= 3:
        add("R8", "warn", f"{len(recent_errs)} errors in the last 15 min",
            "see error breakdown / events table")

    # R9 — residency churn: repeated gaps in a model's pool_status trail.
    for key, tss in a["pool_hist"].items():
        if len(tss) < 5:
            continue
        gaps = sum(1 for i in range(1, len(tss)) if tss[i] - tss[i - 1] > 180)
        if gaps >= 2:
            device, model = key.split("|", 1)
            add("R9", "warn",
                f"{short_model(model)} flapped in/out of the pool {gaps}× on {device}",
                "check TTL eviction or LM Link stability")

    # R10 — idle residency (only judged on longer ranges).
    if window_hours >= 6:
        for m in live_models:
            cfg = LOAD_SETTINGS.get(m) or {}
            if m not in peaks_by_model and (cfg.get("gb") or 0) > 5:
                add("R10", "info",
                    f"{short_model(m)} loaded ({cfg['gb']} GB) but served no requests in range",
                    "unload if idle persists")

    findings.sort(key=lambda f: SEV_ORDER[f["sev"]])
    if not any(f["sev"] in ("crit", "warn") for f in findings):
        findings.insert(0, {
            "rule": "OK", "sev": "ok",
            "text": "all health checks passing — compression, pool pressure, "
                    "capacity math, memory, errors, residency",
            "action": None, "beta": False})
    return findings
