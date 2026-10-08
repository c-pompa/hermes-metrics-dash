"use strict";

// node --test coverage for the Pulse helpers in desktop-plugin/plugin.js.
// Hermes blob-loads plugin.js (relative imports do not resolve), so the
// functions live in a marked block there. This file extracts that block and
// evals it — one source of truth, no sibling copy, no window.* export.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const PLUGIN_JS = path.resolve(__dirname, "..", "desktop-plugin", "plugin.js");
const START = "/* pulse-helpers-start */";
const END = "/* pulse-helpers-end */";

function loadHelpers() {
  const src = fs.readFileSync(PLUGIN_JS, "utf8");
  const i = src.indexOf(START);
  const j = src.indexOf(END);
  assert.ok(i >= 0 && j > i, "plugin.js is missing pulse-helpers-start/end markers");
  const block = src.slice(i + START.length, j);
  const factory = new Function(
    "SPARK_N",
    "WINDOW_S",
    `"use strict";\n${block}\n` +
      "return { sparkBuckets, metricBuckets, relAge, newestApiTs, hourBusy, parseLastSeenTs, freshWithin };"
  );
  return factory(12, 3600);
}

const { sparkBuckets, metricBuckets, relAge, newestApiTs, hourBusy, parseLastSeenTs, freshWithin } = loadHelpers();

const NOW = 1_000_000;

test("sparkBuckets counts api records into 12 five-minute slots", () => {
  const records = [
    { kind: "api", ts: NOW - 100 },
    { kind: "api", ts: NOW - 5 * 60 },
    { kind: "api", ts: NOW - 3600 + 1 },
    { kind: "heartbeat", ts: NOW - 10 },
    { kind: "api", ts: NOW - 4000 },
  ];
  const buckets = sparkBuckets(records, NOW);
  assert.equal(buckets.length, 12);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 3);
  assert.equal(buckets[0], 1);
  assert.equal(buckets[11], 2);
});

test("sparkBuckets treats missing kind as api and clamps overflow", () => {
  const buckets = sparkBuckets([{ ts: NOW + 50 }, { ts: NOW - 3600 }], NOW);
  assert.equal(buckets[11], 1);
  assert.equal(buckets[0], 1);
});

test("sparkBuckets is all zeros when the hour is empty", () => {
  assert.deepEqual(sparkBuckets([], NOW), new Array(12).fill(0));
  assert.deepEqual(sparkBuckets([{ kind: "host_stats", ts: NOW }], NOW), new Array(12).fill(0));
});

test("sparkBuckets rejects non-finite now, n, windowS, and ts", () => {
  assert.deepEqual(sparkBuckets([{ kind: "api", ts: NOW }], NaN), new Array(12).fill(0));
  assert.equal(sparkBuckets([{ kind: "api", ts: NOW }], NOW, { n: 0 }).length, 12);
  assert.deepEqual(sparkBuckets([{ kind: "api", ts: NOW }], NOW, { windowS: 0 }), new Array(12).fill(0));
  assert.deepEqual(sparkBuckets([{ kind: "api", ts: Infinity }], NOW), new Array(12).fill(0));
});

test("metricBuckets sums output tokens per slot", () => {
  const records = [
    { kind: "api", ts: NOW - 100, output_tokens: 30 },
    { kind: "api", ts: NOW - 100, output_tokens: 40 },
    { kind: "api", ts: NOW - 600, completion_tokens: 15 },
    { kind: "heartbeat", ts: NOW - 10, output_tokens: 999 },
  ];
  const buckets = metricBuckets(records, NOW, "tokens");
  assert.equal(buckets.reduce((a, b) => a + b, 0), 85);
  assert.equal(buckets[11], 70);
  assert.equal(buckets[10], 15);
});

test("metricBuckets keeps the best t/s per slot", () => {
  const records = [
    { kind: "api", ts: NOW - 100, tps: 12 },
    { kind: "api", ts: NOW - 100, tps: 40 },
    { kind: "api", ts: NOW - 100, tokens_per_sec: 25 },
    // 100 tokens / 10s duration falls back to 10 t/s.
    { kind: "api", ts: NOW - 600, output_tokens: 100, duration_s: 10 },
  ];
  const buckets = metricBuckets(records, NOW, "tps");
  assert.equal(buckets[11], 40);
  assert.equal(buckets[10], 10);
});

test("metricBuckets 'requests' specialization matches sparkBuckets", () => {
  const records = [
    { kind: "api", ts: NOW - 100 },
    { kind: "api", ts: NOW - 600 },
  ];
  assert.deepEqual(metricBuckets(records, NOW, "requests"), sparkBuckets(records, NOW));
});

test("relAge formats seconds through days", () => {
  assert.equal(relAge(null, NOW), null);
  assert.equal(relAge(0, NOW), null);
  assert.equal(relAge(NOW - 10, NOW), "just now");
  assert.equal(relAge(NOW - 60, NOW), "1m ago");
  assert.equal(relAge(NOW - 12 * 60, NOW), "12m ago");
  assert.equal(relAge(NOW - 3600, NOW), "1h ago");
  assert.equal(relAge(NOW - 3 * 3600, NOW), "3h ago");
  assert.equal(relAge(NOW - 86400, NOW), "1d ago");
  assert.equal(relAge(NOW - 9 * 86400, NOW), "9d ago");
  assert.equal(relAge(NOW - 10, NaN), null);
});

test("newestApiTs ignores non-api, missing, and non-finite ts", () => {
  assert.equal(newestApiTs([]), null);
  assert.equal(newestApiTs([{ kind: "api" }]), null);
  assert.equal(
    newestApiTs([
      { kind: "api", ts: 10 },
      { kind: "heartbeat", ts: 99 },
      { kind: "api", ts: 40 },
      { kind: "api", ts: Infinity },
    ]),
    40
  );
});

test("hourBusy is true only when the hour has api requests", () => {
  assert.equal(hourBusy(null), false);
  assert.equal(hourBusy({ requests: 0 }), false);
  assert.equal(hourBusy({ requests: 3 }), true);
});

test("freshWithin is true only within the recency window", () => {
  assert.equal(freshWithin(null, NOW, 10), false);
  assert.equal(freshWithin(0, NOW, 10), false);
  assert.equal(freshWithin(NOW - 9, NOW, 10), true);
  assert.equal(freshWithin(NOW - 10, NOW, 10), true);
  assert.equal(freshWithin(NOW - 11, NOW, 10), false);
  // Default window is 10s.
  assert.equal(freshWithin(NOW - 5, NOW), true);
  // Non-finite inputs and future timestamps (clock skew) are never fresh.
  assert.equal(freshWithin(NOW - 5, NaN, 10), false);
  assert.equal(freshWithin(NaN, NOW, 10), false);
  assert.equal(freshWithin(NOW + 1, NOW, 10), false);
});

test("parseLastSeenTs rejects untrusted storage values", () => {
  const now = 1_700_000_000;
  assert.equal(parseLastSeenTs(now, now), now);
  assert.equal(parseLastSeenTs(String(now), now), now);
  assert.equal(parseLastSeenTs("Infinity", now), 0);
  assert.equal(parseLastSeenTs(NaN, now), 0);
  assert.equal(parseLastSeenTs(1e9, now), 0);
  assert.equal(parseLastSeenTs(now + 7200, now), 0);
  assert.equal(parseLastSeenTs(now + 0.5, now), 0);
  assert.equal(parseLastSeenTs("<script>", now), 0);
});
