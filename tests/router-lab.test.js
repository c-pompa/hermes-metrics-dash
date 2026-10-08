"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const lab = require(path.resolve(__dirname, "..", "static", "router-lab.js"));

test("trafficLaneOf buckets families and never invents DSv4 flash/pro", () => {
  assert.equal(lab.trafficLaneOf("qwen/qwen3.8-27b"), "qwen");
  assert.equal(lab.trafficLaneOf("qwen3.8-27b-hermes"), "qwen");
  assert.equal(lab.trafficLaneOf("z-ai/glm-5.3"), "glm");
  assert.equal(lab.trafficLaneOf("nvidia/nvidia-nemotron-nano-9b-v2"), "nvidia");
  assert.equal(lab.trafficLaneOf("mlx-community/Qwen3.5-4B"), "qwen");
  assert.equal(lab.trafficLaneOf("Some/Local-Model"), "local");
  assert.equal(lab.trafficLaneOf(""), "other");
  assert.equal(lab.trafficLaneOf(null), "other");
  assert.notEqual(lab.trafficLaneOf("flash"), "flash");
  assert.notEqual(lab.trafficLaneOf("pro"), "pro");
});

test("trafficLanes shares, sort, host filter, empty", () => {
  const t = 1_700_000_000;
  const records = [
    { ts: t - 10, kind: "api", model: "z-ai/glm-5.3", output_tokens: 100, tps: 10, host: "mini" },
    { ts: t - 8, kind: "api", model: "z-ai/glm-5.3", output_tokens: 300, host: "mini" },
    { ts: t - 6, kind: "api", model: "qwen3.8-27b-hermes", output_tokens: 100, tps: 20, host: "mbp" },
    { ts: t - 4, kind: "api", model: "mistralai/mixtral", output_tokens: 5, host: "mini" },
    { ts: t - 2, kind: "error", model: "z-ai/glm-5.3", host: "mini" },
    { ts: t - 1, kind: "api", model: "nvidia/nvidia-nemotron-nano-9b-v2", output_tokens: 8, host: "cloud", error: "429" },
  ];
  const lanes = lab.trafficLanes(records, { from: t - 20, to: t });
  assert.deepEqual(lanes.map((l) => l.id), ["glm", "qwen", "local", "nvidia"]);
  assert.equal(lanes[0].requests, 2);
  assert.equal(lanes[0].tokens, 400);
  assert.equal(Math.round(lanes[0].share * 100), 40);
  assert.equal(lanes[0].avgTps, 10);
  assert.equal(lanes[3].fallback, true);
  assert.equal(lanes[3].errors, 1);
  const mini = lab.trafficLanes(records, { from: t - 20, to: t, host: "mini" });
  assert.deepEqual(mini.map((l) => l.id), ["glm", "local"]);
  assert.deepEqual(lab.trafficLanes(null), []);
  assert.deepEqual(lab.trafficLanes([{ kind: "error", model: "x" }]), []);
});

test("trafficLaneTip is {title, meta} with share and escalation", () => {
  const tip = lab.trafficLaneTip({
    id: "nvidia", requests: 4, tokens: 80, share: 0.06, avgTps: 18, errors: 1, fallback: true,
  });
  assert.match(tip.title, /nvidia/);
  assert.match(tip.title, /6%/);
  assert.match(tip.meta, /4 req/);
  assert.match(tip.meta, /escalation/);
  assert.match(tip.meta, /1 err/);
});

test("sankeyLayout stacks right nodes and emits ribbon paths", () => {
  const lanes = [
    { id: "glm", requests: 60, share: 0.6, color: "#8b7cff" },
    { id: "local", requests: 30, share: 0.3, color: "#8b8b8b" },
    { id: "nvidia", requests: 10, share: 0.1, color: "#e8c43a", fallback: true },
  ];
  const layout = lab.sankeyLayout(lanes);
  assert.equal(layout.nodes.length, 3);
  assert.ok(layout.nodes[0].h > layout.nodes[1].h);
  assert.ok(layout.nodes[1].h > layout.nodes[2].h);
  assert.ok(layout.nodes[1].y > layout.nodes[0].y);
  const leftSpan = layout.nodes[2].leftY + layout.nodes[2].leftH - layout.nodes[0].leftY;
  const rightSpan = layout.nodes[2].y + layout.nodes[2].h - layout.nodes[0].y;
  assert.ok(leftSpan < rightSpan);
  assert.match(layout.nodes[0].d, /^M/);
  assert.match(layout.nodes[0].d, /Z$/);
  assert.equal(layout.nodes[2].fallback, true);
  assert.equal(lab.sankeyLayout([]).nodes.length, 0);
});

test("blendedCost uses per-session max cost_usd, not per-row sum", () => {
  const t = 1000;
  const records = [
    { ts: t, kind: "api", session_id: "s1", cost_usd: 0.01 },
    { ts: t + 1, kind: "api", session_id: "s1", cost_usd: 0.03 },
    { ts: t + 2, kind: "api", session_id: "s2", cost_usd: 0.01 },
  ];
  const v = lab.blendedCost(records, { from: t - 1, to: t + 3 });
  assert.ok(Math.abs(v - 0.04 / 3) < 1e-9);
  assert.equal(lab.blendedCost([{ kind: "api" }]), null);
});

test("routerKpis + insight flag nvidia share as escalation analog", () => {
  const lanes = [
    { id: "nvidia", requests: 12, share: 0.4 },
    { id: "glm", requests: 10, share: 0.33 },
    { id: "local", requests: 8, share: 0.27 },
  ];
  const kpis = lab.routerKpis(lanes, []);
  assert.equal(kpis.requests, 30);
  assert.equal(kpis.topId, "nvidia");
  assert.equal(kpis.nvidiaShare, 0.4);
  assert.match(lab.routerInsight(lanes), /nvidia is taking/);
  assert.match(lab.routerInsight([{ id: "local", share: 0.8, requests: 8 }]), /local is holding/);
  assert.match(lab.routerInsight([]), /No api/);
});

test("roleRows sort by requests and isolate by family pin", () => {
  const rows = lab.roleRows({
    roles: {
      coder: { requests: 3, errors: 0, fallthroughs: 0, models: { "z-ai/glm-5.3": 3 }, p50_s: 2 },
      main: { requests: 10, errors: 1, fallthroughs: 2, models: { "qwen/qwen3.8-27b": 10 }, p50_s: 1.4 },
    },
  });
  assert.equal(rows[0].role, "main");
  assert.equal(rows[0].lane, "qwen");
  assert.equal(rows[0].topModel, "qwen/qwen3.8-27b");
  const tip = lab.roleTip(rows[0]);
  assert.equal(tip.title, "main");
  assert.match(tip.meta, /10 req/);
  assert.match(tip.meta, /qwen3.8-27b/);
  const pinned = lab.isolateRoles(rows, "glm");
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].role, "coder");
});

test("roleBarLayout and statusRoles degrade empty payloads", () => {
  const rows = lab.roleRows(lab.mockUsage());
  const bars = lab.roleBarLayout(rows, { width: 680 });
  assert.equal(bars.length, rows.length);
  assert.ok(bars[0].barW >= bars[1].barW);
  assert.deepEqual(lab.statusRoles(null), []);
  const st = lab.statusRoles(lab.mockStatus());
  assert.equal(st.filter((r) => r.role === "voice")[0].resolved, false);
  assert.equal(st.filter((r) => r.role === "main")[0].lane, "qwen");
  assert.equal(lab.describeResolution({ resolved: null, strict: true }), "—");
});

test("mockRecords cover all four live families", () => {
  const recs = lab.mockRecords(1_700_000_000);
  const ids = lab.trafficLanes(recs).map((l) => l.id).sort();
  assert.deepEqual(ids, ["glm", "local", "nvidia", "qwen"]);
  assert.ok(lab.parseRangeToken("#/range=1h").hours === 1);
  assert.equal(lab.parseHostToken("#/range=6h&host=mini"), "mini");
  const win = lab.windowForRange("6h", 1000);
  assert.equal(win[1] - win[0], 6 * 3600);
});
