"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const lab = require(path.resolve(__dirname, "..", "static", "memory-lab.js"));

test("kvModels stacks overlapping in-flight tokens vs loaded cap", () => {
  const t = 1_700_000_000;
  const qwen = "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5";
  const records = [
    { ts: t - 10, duration_s: 20, kind: "api", model: qwen, input_tokens: 50000 },
    { ts: t - 5, duration_s: 20, kind: "api", model: qwen, input_tokens: 50000 },
    { ts: t - 8, duration_s: 4, kind: "api", model: "supergemma4-26b-uncensored-mlx-v2", input_tokens: 12000 },
  ];
  const models = lab.kvModels(records, { from: t - 40, to: t, samples: 20 });
  assert.equal(models[0].short.indexOf("q35") >= 0 || models[0].model.indexOf("qwen") >= 0, true);
  assert.equal(models[0].cap, 103424);
  assert.ok(models[0].peak >= 90000);
  assert.ok(models[0].pct > 80);
  const tip = lab.kvSampleTip(models[0], models[0].samples.reduce((a, s) => (s.v > a.v ? s : a)));
  assert.match(tip.meta, /in flight|slots|%/);
  const g = lab.kvGauge(models[0]);
  assert.ok(g.pct > 80);
  assert.match(g.meta, /103/);
});

test("effModels groups duration vs output and builds {title, meta} tips", () => {
  const t = 1_700_000_000;
  const records = [
    { ts: t - 10, kind: "api", model: "qwen3.6-flash", duration_s: 2, output_tokens: 80, tps: 40 },
    { ts: t - 8, kind: "api", model: "qwen3.6-flash", duration_s: 3, output_tokens: 90, tps: 30 },
    { ts: t - 6, kind: "moa_turn", model: "nvidia-llama", duration_s: 12, output_tokens: 40, tps: 3.3 },
    { ts: t - 4, kind: "error", model: "qwen3.6-flash", duration_s: 9, output_tokens: 0, tps: 0 },
  ];
  const models = lab.effModels(records, { from: t - 20, to: t });
  assert.equal(models.length, 2);
  const qwen = models.find((m) => m.model.indexOf("qwen") >= 0);
  assert.equal(qwen.points.length, 2);
  const tip = lab.effTip(qwen, qwen.points[0]);
  assert.match(tip.title, /qwen/);
  assert.match(tip.meta, /t\/s/);
  const kpis = lab.effKpis(models);
  assert.equal(kpis.n, 3);
  assert.ok(kpis.medianTps > 0);
  assert.equal(kpis.slow, 1);
});

test("mockRecords plus hash window feed both widgets", () => {
  const now = 1_700_000_000;
  assert.equal(lab.parseRangeToken("#/range=6h").hours, 6);
  const win = lab.windowForRange("6h", now);
  assert.equal(win[1] - win[0], 6 * 3600);
  const records = lab.mockRecords(now);
  const kv = lab.kvModels(records, { from: now - 8 * 3600, to: now, samples: 16 });
  const eff = lab.effModels(records, { from: now - 8 * 3600, to: now });
  assert.equal(kv.length, 2);
  assert.equal(lab.capForModel("qwen3.6-flash"), 103424);
  assert.ok(eff.some((m) => m.points.some((p) => p.tps < 10)));
  assert.equal(lab.shortModelName("z-ai/glm-5.3-flash"), "glm-5.3-flash");
  const many = [];
  for (let i = 0; i < 200; i++) many.push({ i: i });
  assert.equal(lab.downsamplePoints(many, 20).length, 20);
  assert.equal(lab.downsamplePoints(many, 20)[0].i, 0);
  assert.equal(lab.downsamplePoints(many, 20)[19].i, 199);
});
