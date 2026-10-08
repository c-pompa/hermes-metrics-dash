"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const lab = require(path.resolve(__dirname, "..", "static", "context-lab.js"));

test("sessionLabel never falls back to ?", () => {
  assert.equal(lab.sessionLabel({ session_id: "abc-20260915_1" }), "c-20260915_1");
  assert.equal(lab.sessionLabel({ session_title: "dialectic", session_id: "x" }), "dialectic");
  assert.equal(lab.sessionLabel({}), "session");
});

test("stepPath holds tokens until the next call then jumps", () => {
  const d = lab.stepPath(
    [{ ts: 0, tokens: 10 }, { ts: 5, tokens: 20 }, { ts: 9, tokens: 8 }],
    function (t) { return t * 2; },
    function (v) { return v; }
  );
  assert.equal(d, "M0,10 H10 V20 H18 V8");
  assert.equal(lab.stepPath([], function (t) { return t; }, function (v) { return v; }), "");
});

test("groupConversations ranks newest first and marks compaction", () => {
  const now = 1_700_000_000;
  const records = [
    { ts: now - 400, kind: "api", session_id: "fat", model: "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5", input_tokens: 40000 },
    { ts: now - 200, kind: "api", session_id: "fat", model: "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5", input_tokens: 80000 },
    { ts: now - 80, kind: "api", session_id: "fat", model: "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5", input_tokens: 12000 },
    { ts: now - 50, kind: "error", session_id: "fat", model: "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5", input_tokens: 0, error: "timeout" },
    { ts: now - 30, kind: "api", session_id: "thin", session_title: "brief", model: "supergemma4-26b-uncensored-mlx-v2", input_tokens: 210 },
    { ts: now - 90000, kind: "api", session_id: "old", model: "x", input_tokens: 9 },
  ];
  const groups = lab.groupConversations(records, { from: now - 1000, to: now, limit: 6 });
  assert.equal(groups[0].label, "brief");
  const fat = groups.find((g) => g.id === "fat");
  assert.ok(fat);
  assert.equal(fat.points.length, 3);
  assert.equal(fat.compactions.length, 1);
  assert.equal(fat.errors.length, 1);
  assert.equal(groups.some((g) => g.id === "old"), false);
});

test("pointTip and gaugeForSession match Widget Lab {title, meta}", () => {
  const groups = lab.groupConversations([
    { ts: 10, kind: "api", session_id: "fat", model: "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5", input_tokens: 51600 },
  ], { from: 0, to: 20, limit: 4 });
  const tip = lab.pointTip(groups[0], groups[0].points[0]);
  assert.match(tip.title, /fat/);
  assert.match(tip.meta, /51.6k/);
  const g = lab.gaugeForSession(groups[0]);
  assert.equal(g.cap, 103424);
  assert.ok(g.pct > 40 && g.pct < 60);
  assert.match(g.meta, /103/);
  const none = lab.gaugeForSession(null);
  assert.equal(none.pct, null);
});
