"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const lab = require(path.resolve(__dirname, "..", "static", "speed-lab.js"));

test("speedModels groups by model, switches metric, and builds {title, meta} tips", () => {
  const t = 1_700_000_000;
  const records = [
    { ts: t - 10, kind: "api", model: "z-ai/glm-5.3-flash", duration_s: 2, output_tokens: 80, tps: 40 },
    { ts: t - 8, kind: "api", model: "z-ai/glm-5.3-flash", duration_s: 4, output_tokens: 40, tps: 10 },
    { ts: t - 6, kind: "moa_turn", model: "moonshotai/kimi-k3", duration_s: 12, output_tokens: 24, tps: 2 },
    { ts: t - 4, kind: "error", model: "z-ai/glm-5.3-flash", duration_s: 9, output_tokens: 0, tps: 0 },
  ];
  const tps = lab.speedModels(records, { from: t - 20, to: t, metric: "tps" });
  assert.equal(tps.length, 2);
  assert.equal(tps[0].short, "glm-5.3-flash");
  assert.equal(tps[0].n, 2);
  assert.equal(tps[0].points[0].v, 40);
  const tip = lab.speedTip(tps[0], tps[0].points[0], "tps");
  assert.match(tip.title, /glm/);
  assert.match(tip.meta, /t\/s|40/);
  const dur = lab.speedModels(records, { from: t - 20, to: t, metric: "duration_s" });
  assert.equal(dur[0].points[0].v, 2);
  const out = lab.speedModels(records, { from: t - 20, to: t, metric: "output_tokens" });
  assert.equal(out[0].points[0].v, 80);
  const pinned = lab.isolateModels(tps, tps[0].model);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].n, 2);
});

test("speedErrors stay on the baseline and respect model pin", () => {
  const t = 1_700_000_000;
  const records = [
    { ts: t - 5, kind: "error", model: "z-ai/glm-5.3-flash", host: "mini", error: "timeout" },
    { ts: t - 3, kind: "error", model: "moonshotai/kimi-k3", host: "cloud", error: "rate limit" },
    { ts: t - 1, kind: "api", model: "z-ai/glm-5.3-flash", tps: 20, duration_s: 1, output_tokens: 20 },
  ];
  const all = lab.speedErrors(records, { from: t - 20, to: t });
  assert.equal(all.length, 2);
  const pinned = lab.speedErrors(records, { from: t - 20, to: t, model: "z-ai/glm-5.3-flash" });
  assert.equal(pinned.length, 1);
  const tip = lab.errorTip(pinned[0]);
  assert.match(tip.title, /failed/);
  assert.match(tip.meta, /timeout/);
});

test("speedBins is IQR per time bucket, not a polyline of raw requests", () => {
  const t0 = 1000;
  const t1 = 1000 + 3600;
  const points = [];
  for (let i = 0; i < 12; i++) {
    points.push({ ts: t0 + 60 + i * 10, v: 20 + i });
  }
  for (let i = 0; i < 8; i++) {
    points.push({ ts: t0 + 1800 + i * 10, v: 40 });
  }
  const bins = lab.speedBins(points, t0, t1, 12);
  assert.ok(bins.length >= 2);
  bins.forEach((b) => {
    assert.ok(b.p25 <= b.median);
    assert.ok(b.median <= b.p75);
    assert.ok(b.n >= 1);
  });
  const tip = lab.binTip({ short: "glm-flash" }, bins[0], "tps");
  assert.match(tip.title, /glm/);
  assert.match(tip.meta, /IQR/);
});

test("laneLayout gives each model its own row and local ymax", () => {
  const lanes = lab.laneLayout([
    { model: "a", short: "a", color: "#3ee089", n: 10, median: 30, bins: [{ p75: 40 }] },
    { model: "b", short: "b", color: "#e8c43a", n: 4, median: 2, bins: [{ p75: 3 }] },
  ], { rowH: 44, gap: 8 });
  assert.equal(lanes.length, 2);
  assert.equal(lanes[0].y, 0);
  assert.equal(lanes[1].y, 52);
  assert.equal(lanes[0].ymax, 40);
  assert.equal(lanes[1].ymax, 3);
});

test("heatGrid aligns empty buckets and scales fill by global median", () => {
  const models = [
    {
      model: "a", short: "a", color: "#3ee089",
      bins: [
        { i: 0, t0: 0, t1: 10, ts: 5, n: 4, p25: 10, median: 40, p75: 50 },
        { i: 2, t0: 20, t1: 30, ts: 25, n: 2, p25: 8, median: 20, p75: 22 },
      ],
    },
    {
      model: "b", short: "b", color: "#e8c43a",
      bins: [
        { i: 1, t0: 10, t1: 20, ts: 15, n: 1, p25: 2, median: 2, p75: 2 },
      ],
    },
  ];
  const grid = lab.heatGrid(models, { steps: 3 });
  assert.equal(grid.steps, 3);
  assert.equal(grid.rows.length, 2);
  assert.equal(grid.vmax, 40);
  assert.equal(grid.rows[0].cells.length, 3);
  assert.equal(grid.rows[0].cells[1].empty, true);
  assert.equal(grid.rows[0].cells[0].empty, false);
  assert.equal(grid.rows[0].cells[0].median, 40);
  const hi = lab.heatFill(40, 40, "#3ee089");
  const lo = lab.heatFill(2, 40, "#e8c43a");
  assert.match(hi, /^rgb\(/);
  assert.notEqual(hi, lo);
});

test("mockRecords plus hash window feed the speed chart", () => {
  const now = 1_700_000_000;
  assert.equal(lab.parseRangeToken("#/range=6h").hours, 6);
  assert.equal(lab.metricOf("output_tokens").label, "output tokens");
  const win = lab.windowForRange("6h", now);
  const records = lab.mockRecords(now);
  const models = lab.speedModels(records, { from: win[0], to: win[1], metric: "tps" });
  assert.ok(models.length >= 2);
  assert.ok(models[0].bins.length >= 1);
  assert.ok(models[0].drawn.length <= models[0].points.length);
  const errs = lab.speedErrors(records, { from: now - 8 * 3600, to: now });
  assert.equal(errs.length, 1);
  assert.equal(lab.shortModelName("z-ai/glm-5.3-flash"), "glm-5.3-flash");
});
