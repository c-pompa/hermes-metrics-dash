"use strict";

// node --test coverage for the pure helpers exported by the web dashboard
// tab bundle (plugin/dashboard/dist/index.js). The bundle is a classic
// script; under node it skips the SDK registration path and exposes the
// helpers via module.exports.

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const helpers = require(path.resolve(
  __dirname, "..", "plugin", "dashboard", "dist", "index.js"
));

const {
  recordsOf, outputTokensOf, tpsOf, summarize, modelAvgTps,
  fmt, fmtTps, findingsRules, usageMapEntries,
  roleEntries, describeResolution, noteText, notesOf, sourceLabel,
  findingsCleanShare, findingsRuleRows, findingsFiring,
  findingsSparkTip, findingsRuleType, fmtDeltaPts,
  modelMatches, modelOptions, comparePresets, comparePair, resolveComparePair,
  ingestHour, ingestFeed, ingestSparkTip, ingestDefaultPane,
  trafficLaneOf, trafficLanes, trafficLaneTip, h2hDots,
} = helpers;

test("recordsOf tolerates bare arrays and wrapped shapes", () => {
  assert.deepEqual(recordsOf([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(recordsOf({ records: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(recordsOf({ items: [{ a: 2 }] }), [{ a: 2 }]);
  assert.deepEqual(recordsOf(null), []);
  assert.deepEqual(recordsOf({ available: false }), []);
});

test("outputTokensOf falls back across field spellings", () => {
  assert.equal(outputTokensOf({ output_tokens: 5 }), 5);
  assert.equal(outputTokensOf({ completion_tokens: 6 }), 6);
  assert.equal(outputTokensOf({ tokens_out: 7 }), 7);
  assert.equal(outputTokensOf({}), 0);
});

test("tpsOf prefers tps, then tokens_per_sec, then out/duration", () => {
  assert.equal(tpsOf({ tps: 12.5 }, 100), 12.5);
  assert.equal(tpsOf({ tps: null, tokens_per_sec: 9 }, 100), 9);
  assert.equal(tpsOf({ duration_s: 4 }, 100), 25);
  // tps can be null on LM Studio 0.4.x — missing duration yields null.
  assert.equal(tpsOf({ tps: null }, 100), null);
  assert.equal(tpsOf({ duration_s: 0 }, 100), null);
  assert.equal(tpsOf({ duration_s: 4 }, 0), null);
});

test("summarize aggregates only api records and sorts models by tokens", () => {
  const s = summarize({
    records: [
      { kind: "api", model: "m-a", output_tokens: 100, duration_s: 4 }, // 25 t/s
      { kind: "api", model: "m-a", output_tokens: 60, tps: 10 },
      { kind: "api", model: "m-b", output_tokens: 300, tps: 30 },
      { kind: "heartbeat" },
      { kind: "api", output_tokens: 40, tps: 5 }, // unknown model
    ],
  });
  assert.equal(s.requests, 4);
  assert.equal(s.tokens, 500);
  assert.equal(s.avgTps, (25 + 10 + 30 + 5) / 4);
  assert.deepEqual(s.models.map((m) => m.model), ["m-b", "m-a", "unknown"]);
  const ma = s.models.find((m) => m.model === "m-a");
  assert.equal(ma.requests, 2);
  assert.equal(ma.tokens, 160);
  assert.equal(modelAvgTps(ma), (25 + 10) / 2);
  // No usable tps anywhere => null averages, never NaN.
  const empty = summarize({ records: [{ kind: "api", model: "m-x" }] });
  assert.equal(empty.avgTps, null);
  assert.equal(modelAvgTps(empty.models[0]), null);
});

test("fmt compacts thousands and millions", () => {
  assert.equal(fmt(999), "999");
  assert.equal(fmt(1234), "1.2k");
  assert.equal(fmt(2500000), "2.5M");
});

test("fmtTps formats numbers and dashes the unusable", () => {
  assert.equal(fmtTps(12.34), "12.3");
  assert.equal(fmtTps(null), "—");
  assert.equal(fmtTps(NaN), "—");
});

test("findingsRules pulls the rules array defensively", () => {
  assert.deepEqual(findingsRules({ days: 7, rules: [{ rule: "R12" }] }), [{ rule: "R12" }]);
  assert.deepEqual(findingsRules({ available: false }), []);
  assert.deepEqual(findingsRules(null), []);
});

const FINDINGS_SAMPLE = {
  days: 7,
  total: 11,
  rules: [
    {
      rule: "R12",
      label: "guardrail-halt detector (beta)",
      count: 4,
      worst_sev: "warn",
      days_fired: 2,
      last_ts: 1700000000,
      example_text: "execute_code blocked · 3× this hour",
      example_action: "check path",
      daily: [0, 0, 0, 0, 0, 1, 3],
    },
    {
      rule: "R8",
      label: "error burst",
      count: 1,
      worst_sev: "info",
      days_fired: 1,
      daily: [0, 0, 0, 0, 0, 0, 1],
    },
    {
      rule: "R5",
      label: "pool pressure peak",
      count: 6,
      worst_sev: "crit",
      days_fired: 3,
      daily: [0, 0, 0, 1, 2, 2, 1],
    },
  ],
};

test("findingsCleanShare averages rule pass and builds a daily spark", () => {
  const empty = findingsCleanShare(null);
  assert.equal(empty.pct, null);
  assert.deepEqual(empty.spark, []);
  assert.equal(empty.deltaPts, null);

  const v = findingsCleanShare(FINDINGS_SAMPLE);
  // (5/7 + 6/7 + 4/7) / 3 = 15/21
  assert.ok(Math.abs(v.pct - 15 / 21) < 1e-9);
  assert.equal(v.spark.length, 7);
  assert.equal(v.spark[0], 1);
  assert.ok(Math.abs(v.spark[3] - 2 / 3) < 1e-9);
  assert.equal(v.spark[6], 0);
  assert.ok(Math.abs(v.deltaPts - (0 - 1 / 3)) < 1e-9);
});

test("findingsRuleRows map pass bars, type, and day-over-day fire delta", () => {
  const rows = findingsRuleRows(FINDINGS_SAMPLE);
  assert.equal(rows.length, 3);
  const r12 = rows.find((r) => r.rule === "R12");
  assert.equal(r12.type, "log");
  assert.ok(Math.abs(r12.pass - 5 / 7) < 1e-9);
  assert.equal(r12.deltaFires, 2);
  assert.equal(findingsRuleType("R5"), "metric");
  assert.equal(findingsRuleType("R13"), "log");
  assert.equal(fmtDeltaPts(1.24), "+1.2");
  assert.equal(fmtDeltaPts(-1.6), "−1.6");
  assert.equal(fmtDeltaPts(0), "—");
});

test("findingsFiring keeps crit/warn and drops ok/info", () => {
  const firing = findingsFiring(FINDINGS_SAMPLE);
  assert.deepEqual(firing.map((r) => r.rule), ["R12", "R5"]);
  assert.equal(findingsFiring({ rules: [] }).length, 0);
  const tip = findingsSparkTip(0, [0.923, 0.91]);
  assert.match(tip.title, /1 \/ 2/);
  assert.match(tip.meta, /92.3%/);
});

test("modelMatches is exact on the trailing id so glm-5.3 ≠ glm-5.3-flash", () => {
  assert.equal(modelMatches("z-ai/glm-5.3", "z-ai/glm-5.3"), true);
  assert.equal(modelMatches("z-ai/glm-5.3", "glm-5.3"), true);
  assert.equal(modelMatches("z-ai/glm-5.3-flash", "z-ai/glm-5.3"), false);
  assert.equal(modelMatches("qwen/qwen3.8-27b", "qwen3.8-27b"), true);
  assert.equal(modelMatches("qwen3.8-27b-hermes", "qwen/qwen3.8-27b"), false);
  assert.equal(modelMatches("qwen3.8-27b-hermes", "qwen3.8-27b-hermes"), true);
});

test("comparePresets exposes qwen3.8 router/main and glm 5.3/lite", () => {
  const presets = comparePresets();
  assert.deepEqual(presets.map(function (p) { return p.id; }), ["qwen38", "glm53"]);
  assert.equal(presets[0].left.spec, "qwen/qwen3.8-27b");
  assert.equal(presets[0].right.spec, "qwen3.8-27b-hermes");
  assert.equal(presets[1].left.spec, "z-ai/glm-5.3");
  assert.equal(presets[1].right.spec, "z-ai/glm-5.3-flash");
  assert.match(presets[1].right.label, /lite/i);
});

test("resolveComparePair returns a preset or a custom pair", () => {
  const presets = comparePresets();
  const qwen = resolveComparePair(presets, "qwen38");
  assert.equal(qwen.left.spec, "qwen/qwen3.8-27b");
  const custom = resolveComparePair(presets, "custom", "moonshotai/kimi-k3", "hermes/triage");
  assert.equal(custom.id, "custom");
  assert.equal(custom.left.spec, "moonshotai/kimi-k3");
  assert.equal(custom.right.spec, "hermes/triage");
  const fallback = resolveComparePair(presets, "nope");
  assert.equal(fallback.id, "qwen38");
});

test("comparePair splits selected models from recent records", () => {
  const empty = comparePair(null, "qwen/qwen3.8-27b", "qwen3.8-27b-hermes");
  assert.equal(empty.available, false);
  const diff = comparePair({
    records: [
      { kind: "api", model: "qwen/qwen3.8-27b", output_tokens: 100, tps: 40, duration_s: 2 },
      { kind: "api", model: "qwen3.8-27b-hermes", output_tokens: 80, tps: 20, duration_s: 4 },
      { kind: "error", model: "qwen3.8-27b-hermes", output_tokens: 0, error: "timeout" },
      { kind: "api", model: "z-ai/glm-5.3", output_tokens: 50, tps: 22 },
    ],
  }, "qwen/qwen3.8-27b", "qwen3.8-27b-hermes");
  assert.equal(diff.available, true);
  assert.equal(diff.left.requests, 1);
  assert.equal(diff.right.requests, 2);
  assert.equal(diff.left.avgTps, 40);
  assert.equal(diff.right.errorRate, 0.5);
  assert.ok(Math.abs(diff.leftShare - 1 / 4) < 1e-9);
  assert.ok(Math.abs(diff.rightShare - 2 / 4) < 1e-9);
});

test("comparePair treats glm-5.3-flash as the lite lane, not the full 5.3", () => {
  const diff = comparePair({
    records: [
      { kind: "api", model: "z-ai/glm-5.3", output_tokens: 10, tps: 10, cost_usd: 0.002 },
      { kind: "api", model: "z-ai/glm-5.3-flash", output_tokens: 20, tps: 40 },
      { kind: "api", model: "z-ai/glm-5.3-flash", output_tokens: 20, tps: 36 },
    ],
  }, "z-ai/glm-5.3", "z-ai/glm-5.3-flash");
  assert.equal(diff.left.requests, 1);
  assert.equal(diff.right.requests, 2);
  assert.equal(diff.right.avgTps, 38);
  assert.ok(Math.abs(diff.left.costPer1k - 0.2) < 1e-9);
});

test("modelOptions lists unique api/error models sorted", () => {
  assert.deepEqual(modelOptions(null), []);
  assert.deepEqual(modelOptions({
    records: [
      { kind: "api", model: "z-ai/glm-5.3-flash" },
      { kind: "pool_status", model: "qwen3.8-27b-hermes" },
      { kind: "error", model: "z-ai/glm-5.3" },
      { kind: "api", model: "z-ai/glm-5.3" },
    ],
  }), ["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]);
});

test("ingestHour is empty when there are no api records", () => {
  const hour = ingestHour(null);
  assert.equal(hour.live, false);
  assert.equal(hour.requests, 0);
  assert.equal(hour.errors, 0);
  assert.equal(hour.spark.length, 12);
  assert.ok(hour.spark.every(function (v) { return v === 0; }));
  assert.equal(hour.newestTs, null);
  assert.equal(ingestDefaultPane(hour), "empty");
});

test("ingestHour buckets last-hour traffic into 12 five-minute spark slots", () => {
  const now = 1700000000;
  const hour = ingestHour({
    records: [
      { kind: "api", model: "z-ai/glm-5.3", ts: now - 30, output_tokens: 100, tps: 20, host: "mini" },
      { kind: "api", model: "z-ai/glm-5.3", ts: now - 40, output_tokens: 50, tps: 22, host: "mbp" },
      { kind: "error", model: "z-ai/glm-5.3-flash", ts: now - 320, output_tokens: 0, error: "timeout", host: "mini", duration_s: 12 },
      { kind: "api", model: "kimi", ts: now - 3100, output_tokens: 10, tps: 5 },
      { kind: "pool_status", model: "qwen3.8-27b-hermes", ts: now - 10 },
    ],
  }, now);
  assert.equal(hour.live, true);
  assert.equal(hour.requests, 3);
  assert.equal(hour.errors, 1);
  assert.equal(hour.tokens, 160);
  assert.equal(hour.spark[11], 2);
  assert.equal(hour.spark[10], 1);
  assert.equal(hour.spark[1], 1);
  assert.equal(hour.newestTs, now - 30);
  assert.equal(ingestDefaultPane(hour), "live");
});

test("ingestFeed lists newest api/error/moa rows and skips pool_status", () => {
  const now = 1700000000;
  const feed = ingestFeed({
    records: [
      { kind: "pool_status", model: "x", ts: now, host: "mini" },
      { kind: "api", model: "glm", ts: now - 10, host: "mbp", duration_s: 2.1, tps: 40, output_tokens: 80 },
      { kind: "error", model: "flash", ts: now - 5, host: "mini", duration_s: 12, error: "fail" },
      { kind: "moa_turn", model: "flash", ts: now - 20, host: "winpc", duration_s: 6.2, tps: 31 },
    ],
  }, 8);
  assert.equal(feed.length, 3);
  assert.equal(feed[0].kind, "error");
  assert.equal(feed[0].model, "flash");
  assert.equal(feed[0].host, "mini");
  assert.equal(feed[1].kind, "api");
  assert.equal(feed[2].kind, "moa");
});

test("ingestSparkTip labels 5-min buckets from newest", () => {
  const now = ingestSparkTip([1, 2, 3], 2);
  assert.match(now.title, /last 5 min/);
  assert.match(now.meta, /3 request/);
  const older = ingestSparkTip([1, 2, 3], 0);
  assert.match(older.title, /10–15 min ago/);
  assert.match(older.meta, /1 request$/);
});

test("usageMapEntries normalizes the flat dict and drops envelope keys", () => {
  assert.deepEqual(usageMapEntries({ "m-b": "code", "m-a": "chat" }), [
    { model: "m-a", usage: "chat" },
    { model: "m-b", usage: "code" },
  ]);
  assert.deepEqual(usageMapEntries({ available: false, error: "down" }), []);
  assert.deepEqual(usageMapEntries({}), []);
  assert.deepEqual(usageMapEntries(null), []);
});

test("roleEntries resolves role -> live model across shapes", () => {
  assert.deepEqual(roleEntries({ roles: { main: "m-a", fast: { model: "m-b" } } }), [
    { role: "main", model: "m-a" },
    { role: "fast", model: "m-b" },
  ]);
  assert.deepEqual(roleEntries({ resolutions: { main: { live_model: "m-c" } } }), [
    { role: "main", model: "m-c" },
  ]);
  assert.deepEqual(roleEntries({ role_map: {} }), []);
  assert.deepEqual(roleEntries(null), []);
  assert.deepEqual(roleEntries({ roles: ["not", "a", "map"] }), []);
});

test("describeResolution handles strings, objects, and nulls", () => {
  assert.equal(describeResolution("m-a"), "m-a");
  assert.equal(describeResolution({ resolved: "m-b" }), "m-b");
  assert.equal(describeResolution({ current: "m-c" }), "m-c");
  assert.equal(describeResolution(null), "—");
  assert.equal(describeResolution({ candidates: ["m-x"], strict: true, resolved: null }), "—");
  assert.equal(describeResolution({ other: 1 }), '{"other":1}');
});

test("noteText / notesOf normalize string and object notes", () => {
  assert.equal(noteText("rolled main"), "rolled main");
  assert.equal(noteText({ text: "hi" }), "hi");
  assert.equal(noteText({ message: "yo" }), "yo");
  assert.deepEqual(notesOf({ notes: ["a", { note: "b" }] }), ["a", "b"]);
  assert.deepEqual(notesOf(["x"]), ["x"]);
  assert.deepEqual(notesOf(null), []);
});

test("sourceLabel labels http URLs and local-file mode", () => {
  assert.equal(sourceLabel({ source: "http", base_url: "http://192.0.2.10:8899" }),
    "http://192.0.2.10:8899");
  assert.equal(sourceLabel({ source: "local-file", path: "/home/u/.hermes/metrics/requests.jsonl" }),
    "local file /home/u/.hermes/metrics/requests.jsonl");
  // The local-file health() payload carries mode instead of source.
  assert.equal(sourceLabel({ mode: "local-file", path: "/x/requests.jsonl" }),
    "local file /x/requests.jsonl");
  assert.equal(sourceLabel({ source: "http" }), null);
  assert.equal(sourceLabel(null), null);
});

test("trafficLaneOf buckets model families, never DSv4 tiers", () => {
  assert.equal(trafficLaneOf("z-ai/glm-5.3"), "glm");
  assert.equal(trafficLaneOf("z-ai/glm-5.3-flash"), "glm");
  assert.equal(trafficLaneOf("qwen/qwen3.8-27b"), "qwen");
  assert.equal(trafficLaneOf("qwen3.8-27b-hermes"), "qwen");
  assert.equal(trafficLaneOf("nvidia/nvidia-nemotron-nano-9b-v2"), "nvidia");
  assert.equal(trafficLaneOf("Some/Local-Model"), "local");
  assert.equal(trafficLaneOf(""), "other");
  assert.equal(trafficLaneOf(null), "other");
});

test("trafficLanes buckets api records by family with shares and avg tps", () => {
  const data = { records: [
    { kind: "api", model: "z-ai/glm-5.3", output_tokens: 100, tps: 10 },
    { kind: "api", model: "z-ai/glm-5.3", output_tokens: 300 },
    { kind: "api", model: "qwen3.8-27b-hermes", output_tokens: 100, tokens_per_sec: 20 },
    { kind: "api", model: "mistralai/mixtral", output_tokens: 5 },
    { kind: "error", model: "z-ai/glm-5.3" },
  ] };
  const lanes = trafficLanes(data);
  assert.deepEqual(lanes.map(function (l) { return l.id; }), ["glm", "qwen", "local"]);
  assert.equal(lanes[0].requests, 2);
  assert.equal(lanes[0].tokens, 400);
  assert.equal(Math.round(lanes[0].share * 100), 50);
  assert.equal(lanes[0].avgTps, 10);
  assert.equal(lanes[1].avgTps, 20);
  const tip = trafficLaneTip(lanes[0]);
  assert.ok(tip.title.indexOf("glm ·") === 0, tip.title);
  assert.ok(tip.meta.indexOf("2 req") !== -1, tip.meta);
});

test("trafficLanes returns [] when there are no api records", () => {
  assert.deepEqual(trafficLanes({ records: [{ kind: "error", model: "x" }] }), []);
  assert.deepEqual(trafficLanes(null), []);
});

test("h2hDots scales each metric so the larger lane sits at 1.0", () => {
  const rows = h2hDots({
    left: { requests: 48, avgTps: 23.1, errorRate: 0, costPer1k: 0.0031 },
    right: { requests: 44, avgTps: 21.4, errorRate: 0.022, costPer1k: 0.0022 },
  }, "GLM 5.3", "lite");
  assert.equal(rows.length, 4);
  const req = rows[0];
  assert.equal(req.metric, "requests");
  assert.equal(req.left.pos, 1);
  assert.ok(req.right.pos < 1);
  assert.equal(req.left.tip.title, "requests · GLM 5.3");
  assert.equal(req.left.tip.meta, "48 req");
  assert.equal(rows[2].right.pos, 1);
  assert.equal(rows[3].left.tip.meta, "$0.0031");
});

test("h2hDots tolerates missing lanes and null metrics", () => {
  assert.deepEqual(h2hDots(null), []);
  assert.deepEqual(h2hDots({}), []);
  const rows = h2hDots({
    left: { requests: 10, avgTps: null, errorRate: null, costPer1k: null },
    right: { requests: null, avgTps: null, errorRate: null, costPer1k: null },
  });
  assert.equal(rows.length, 4);
  assert.equal(rows[0].right, null);
  assert.equal(rows[0].left.pos, 1);
  assert.equal(rows[1].left, null);
});
