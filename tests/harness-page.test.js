"use strict";

// node --test coverage for the pure helpers of static/harness.js (Task 8).
// The page script keeps its numeric/format/row helpers in a marked
// /* __PURE_HELPERS__ */ block; we extract that blob and eval it verbatim,
// so the tests exercise exactly what ships in the browser file.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const src = fs.readFileSync(path.resolve(__dirname, "..", "static", "harness.js"), "utf8");
assert.ok(src.includes("/* __PURE_HELPERS__ */") && src.includes("/* __END_PURE_HELPERS__ */"),
  "static/harness.js must keep the marked __PURE_HELPERS__ block");
const block = src.split("/* __PURE_HELPERS__ */")[1].split("/* __END_PURE_HELPERS__ */")[0];
const H = eval("(function(){" + block +
  "; return { median, p95, fmt, fmtAge, deltaPct, deltaAbs, num, heatRamp," +
  " byClass, classStats, fpStats, fpMeta, tsOf, sampleKey, mergeRow };})()");

// The three checks from the plan (Task 8 spec).
test("median", () => assert.equal(H.median([1, 3, 2]), 2));
test("p95 upper", () => assert.equal(H.p95([1, 2, 100]), 100));
test("p95 empty safe", () => assert.equal(H.p95([]), null));

// median — even length averages the two middles; input order is irrelevant.
test("median averages an even-length list and sorts first", () => {
  assert.equal(H.median([1, 2, 3, 4]), 2.5);
  assert.equal(H.median([9, 1]), 5);
});

// p95 — nearest-rank on a full window; input order is irrelevant.
test("p95 uses the nearest-rank value on a full window", () => {
  const v = Array.from({ length: 20 }, (_, i) => i + 1);   // 1..20
  assert.equal(H.p95(v.slice().reverse()), 19);            // ceil(20*.95)-1 = idx 18
  assert.equal(H.p95([42]), 42);
});

// fmt — KPI number formatting.
test("fmt rounds >=100 to whole, truncates decimals otherwise", () => {
  assert.equal(H.fmt(12.345), "12.3");
  assert.equal(H.fmt(100, 1), "100");
  assert.equal(H.fmt(-2.56, 2), "-2.56");
});

test("fmt dashes null/undefined/NaN", () => {
  assert.equal(H.fmt(null), "—");
  assert.equal(H.fmt(undefined), "—");
  assert.equal(H.fmt(NaN), "—");
});

// fmtAge — header's last-sample-age copy.
test("fmtAge picks the right bucket", () => {
  assert.equal(H.fmtAge(59), "59s ago");
  assert.equal(H.fmtAge(89.4), "89s ago");      // < 90 stays in the second bucket
  assert.equal(H.fmtAge(120), "2m ago");        // minute bucket starts at 90s
  assert.equal(H.fmtAge(7200), "2h ago");       // hour bucket starts at 90m
  assert.equal(H.fmtAge(345600), "4d ago");     // day bucket starts at 48h
  assert.equal(H.fmtAge(null), "—");
});

// deltaPct / deltaAbs — KPI vs-yesterday chips.
test("deltaPct signs and formats the relative change", () => {
  assert.equal(H.deltaPct(10, 8), "+25%");
  assert.equal(H.deltaPct(4.6, 10), "-54%");
  assert.equal(H.deltaPct(2.6, 10), "-74%");
  assert.equal(H.deltaPct(2.56, 10), "-74.4%");
});

test("deltaPct dashes a missing reference", () => {
  assert.equal(H.deltaPct(null, 10), "—");
  assert.equal(H.deltaPct(10, null), "—");
});

// BUG (harness.js deltaPct): ref===0 slips past the guard — 1/0 = Infinity,
// fmt(Infinity) -> "—", and the "+" sign is prepended anyway => "+—%" renders
// as a broken chip in renderKpis. The guard should be `!ref` instead of
// `cur === 0`. Flagged to Task 6 (t_e834d805); once the guard is fixed this
// assertion turns green with no test change.
test("deltaPct dashes a zero reference (expects the Task-6 guard fix)", () => {
  assert.equal(H.deltaPct(10, 0), "—");
});

test("deltaAbs signs the absolute change with a decimal choice", () => {
  assert.equal(H.deltaAbs(50, 48), "+2");       // default dec=2 -> toFixed->round
  assert.equal(H.deltaAbs(48, 50), "-2");
  assert.equal(H.deltaAbs(1.5, 1.23), "+0.27");
  assert.equal(H.deltaAbs(4, 4), "±0");
  assert.equal(H.deltaAbs(null, 5), "—");
});

// num — defensive number coercion used by every stats helper.
test("num passes numbers through and maps null/undefined to null", () => {
  assert.equal(H.num("5"), 5);
  assert.equal(H.num(3), 3);
  assert.equal(H.num(null), null);
  assert.equal(H.num(undefined), null);
});

// heatRamp — the yield heatmap color scale endpoints.
test("heatRamp runs hot-red to accent-green", () => {
  assert.equal(H.heatRamp(0), "rgb(242,117,117)");
  assert.equal(H.heatRamp(1), "rgb(126,226,168)");
});

// byClass — sample rows -> per-class buckets (sorted keys).
test("byClass groups rows and sorts class keys", () => {
  const out = H.byClass([
    { prompt_class: "long" }, { prompt_class: "short" },
    { prompt_class: "code" }, { prompt_class: "long" }, {},
  ], "prompt_class");
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], [{ prompt_class: "code" }]);   // sorted keys: code, long, short
  assert.equal(out[1][0].prompt_class, "long");    // short -> long order
  assert.equal(out[2][0].prompt_class, "short");
});

// classStats — TTFT-by-class chart source: median tps + p95 ttft per class.
test("classStats computes n / medianTps / p95Ttft per class", () => {
  const out = H.classStats([
    { prompt_class: "code", tps: 30, ttft_s: 0.5 },
    { prompt_class: "code", tps: 10, ttft_s: 0.9 },
    { prompt_class: "code", tps: null, ttft_s: 4 },   // failed run: counted in n only
    { prompt_class: "short", tps: 40, ttft_s: 0.2 },
    { prompt_class: "short", tps: null, ttft_s: null }, // both null -> nulls
  ]);
  assert.equal(out.code.n, 3);
  assert.equal(out.code.medianTps, 20);          // median([10,30])
  assert.equal(out.code.p95Ttft, 4);             // nearest-rank of [0.5,0.9,4]
  assert.equal(out.short.n, 2);
  assert.equal(out.short.medianTps, 40);         // single finite value survives the filter
  assert.equal(out.short.p95Ttft, null);         // no finite ttft at all
});

// fpStats — config leaderboard rows built client-side from raw samples.
test("fpStats aggregates per fingerprint", () => {
  const out = H.fpStats([
    { fp: "a".repeat(12), tps: 10, ttft_s: 0.5 },
    { fp: "a".repeat(12), tps: 30, ttft_s: 0.6 },
    { fp: "a".repeat(12), tps: null, ttft_s: null },
    { fp: "b".repeat(12), tps: 5, ttft_s: 2 },
    { ts: 1 },                                    // fp-less row ignored
  ]);
  const a = out["a".repeat(12)];
  assert.equal(a.n, 3);
  assert.equal(a.medianTps, 20);                  // median([10,30])
  assert.equal(a.avgTtft, 0.55);                  // avg([0.5,0.6])
  assert.equal(out["b".repeat(12)].n, 1);
});

// fpMeta — newest label/host/ts per fingerprint for the leaderboard meta.
test("fpMeta tracks the newest row's metadata", () => {
  const out = H.fpMeta([
    { fp: "x", ts: 100, label: "old", host: "mbp" },
    { fp: "x", ts: 200, label: "new", host: "mbp" },   // newer wins outright
    { fp: "y", ts: 50, label: null, host: "mini" },
    { fp: "y", ts: 60, label: null, host: "mini" },   // replacement row keeps the empty label
  ]);
  assert.equal(out.x.newestTs, 200);
  assert.equal(out.x.label, "new");
  assert.equal(out.y.newestTs, 60);
  assert.equal(out.y.label, "");
});

test("fpMeta backfills an empty label from an older row", () => {
  const out = H.fpMeta([
    { fp: "y", ts: 50, label: null, host: "mini" },
    { fp: "y", ts: 60, label: null, host: "mini" },   // newer replaces -> empty label
    { fp: "y", ts: 40, label: "keep", host: "mini" }, // older row backfills it
  ]);
  assert.equal(out.y.newestTs, 60);
  assert.equal(out.y.label, "keep");
});

// tsOf — unix seconds with a millis tolerance; the chart x-axis depends on it.
test("tsOf tolerates millisecond timestamps", () => {
  assert.equal(H.tsOf({ ts: 1700000000 }), 1700000000);
  assert.equal(H.tsOf({ ts: 1700000000 * 1000 }), 1700000000);
  assert.equal(H.tsOf({}), 0);
});

// sampleKey — SSE dedupe identity (floor-second + fp + class + tokens + metrics).
test("sampleKey is stable across runs of the same bench", () => {
  const a = H.sampleKey({ ts: 1700000000.9, fp: "f", prompt_class: "c", tokens: 123, tps: 20.456, ttft_s: 0.1234 });
  const b = H.sampleKey({ ts: 1700000001.2, fp: "f", prompt_class: "c", tokens: 123, tps: 20.4567, ttft_s: 0.12345 });
  assert.equal(a, b);                             // same second -> same run
  const c = H.sampleKey({ ts: 1700000002, fp: "f", prompt_class: "c", tokens: 124, tps: 20.4567, ttft_s: 0.123 });
  assert.notEqual(a, c);                          // different second/tokens/metrics -> new row
});

// mergeRow — the SSE feed's append path: dedupes and keeps ts order.
test("mergeRow appends unseen rows, skips duplicates, sorts by ts", () => {
  const mk = (t) => ({ event: "harness_sample", ts: t, fp: "f", prompt_class: "c", tokens: 1, tps: 20.4567, ttft_s: 0.123 });
  const rows = [mk(300)];
  H.mergeRow(rows, mk(100));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((s) => s.ts), [100, 300]);
  H.mergeRow(rows, mk(100));                      // duplicate second -> no new row
  assert.equal(rows.length, 2);
});
