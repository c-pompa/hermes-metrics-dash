"""A/B compare: summarize recent harness samples per config fingerprint.

Usage:
    python3 -m harness.ab <fpA> <fpB> --hours 3 [--base URL]

Fetches recent samples from the dashboard (mini), summarizes each
fingerprint, prints median tok/s + p95 TTFT overall and per prompt class,
and the tps delta (B - A). Deltas under ~10% tok/s should be treated as
noise until the sample count accumulates (see docs/HARNESS.md).
"""
import argparse
import json
import os
import statistics
import sys
import urllib.request

DEFAULT_BASE = os.environ.get("METRICS_DASH_URL", "http://127.0.0.1:8899")


def fetch(hours, base=DEFAULT_BASE):
    url = "%s/api/harness/samples?hours=%g&limit=5000" % (base.rstrip("/"), hours)
    with urllib.request.urlopen(url, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))["samples"]


def summarize(samples, fp):
    """Summarize samples for one fingerprint. None when no tps rows exist."""
    rows = [s for s in samples if s.get("fp") == fp and s.get("tps")]
    if not rows:
        return None
    by_cls = {}
    for s in rows:
        by_cls.setdefault(s.get("prompt_class") or "unknown", []).append(s)
    ttfts = sorted(max(0.0, float(s.get("ttft_s") or 0.0)) for s in rows)
    idx = min(len(ttfts), max(1, int(round(len(ttfts) * 0.95))) - 1)
    return {
        "fp": fp,
        "n": len(rows),
        "median_tps": round(statistics.median(float(s["tps"]) for s in rows), 2),
        "p95_ttft": round(ttfts[idx], 3),
        "by_class": {c: round(statistics.median(float(x["tps"]) for x in v), 2)
                     for c, v in sorted(by_cls.items())},
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("fps", nargs=2, metavar="FP", help="two fingerprints to compare")
    ap.add_argument("--hours", type=float, default=6.0, help="time window (default 6)")
    ap.add_argument("--base", default=DEFAULT_BASE, help="dashboard base URL")
    args = ap.parse_args(argv)

    try:
        samples = fetch(args.hours, args.base)
    except Exception as exc:  # noqa: BLE001 — CLI error path, keep the message
        print("error: could not fetch samples from %s: %s" % (args.base, exc),
              file=sys.stderr)
        return 2

    a_s = summarize(samples, args.fps[0])
    b_s = summarize(samples, args.fps[1])
    delta = None if not (a_s and b_s) else round(b_s["median_tps"] - a_s["median_tps"], 2)
    out = {"a": a_s, "b": b_s}

    print("\n=== A/B harness compare  (window: %.1fh via %s) ==="
          % (args.hours, args.base))

    def fmt(name, s):
        if not s:
            return "  %s: no samples with tps in window" % name
        pct = ""
        if s["n"] < 5:
            pct = "   (thin: treat deltas <~10%% as noise)"
        return "  %s: fp=%s n=%d median=%.2f tok/s p95ttft=%.3fs%s" % (
            name, s["fp"], s["n"], s["median_tps"], s["p95_ttft"], pct)

    print(fmt("A", a_s))
    for cls, v in (a_s or {}).get("by_class", {}).items():
        print("      %-12s %.2f tok/s" % (cls, v))
    print(fmt("B", b_s))
    for cls, v in (b_s or {}).get("by_class", {}).items():
        print("      %-12s %.2f tok/s" % (cls, v))

    if delta is None:
        print("\n  tps_delta: n/a (missing samples)")
    else:
        out["tps_delta"] = delta
        print("\n  tps_delta (B - A): %+.2f tok/s" % delta)

    print("\nJSON:")
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
