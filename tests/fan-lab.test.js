"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const lab = require(path.resolve(__dirname, "..", "static/fan-lab.js"));

test("fanTurns drops empty moa_turns that stole no proposers", () => {
  const t = 1_700_000_000;
  const records = [
    { ts: t, kind: "moa_turn", session_id: "a", duration_s: 4, model: "nvidia" },
    { ts: t + 80, kind: "moa_turn", session_id: "a", duration_s: 5, model: "nvidia" },
    { ts: t + 1, kind: "moa_ref", session_id: "a", duration_s: 2, model: "glm" },
  ];
  const turns = lab.fanTurns(records, { from: t - 10, to: t + 100 });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].proposers.length, 1);
});

test("fanTurns groups proposers onto the nearest moa_turn", () => {
  const t = 1_700_000_000;
  const session = "sess-a";
  const records = [
    { ts: t, kind: "moa_turn", session_id: session, duration_s: 30, model: "nvidia", host: "mbp" },
    { ts: t + 1, kind: "moa_ref", session_id: session, duration_s: 12, model: "z-ai/glm-5.2", label: "nvidia:glm", host: "mbp", tps: 40 },
    { ts: t + 2, kind: "moa_ref", session_id: session, duration_s: 19, model: "minimaxai/minimax-m3", host: "mbp", tps: 22 },
    { ts: t + 3, kind: "moa_agg", session_id: session, model: "deepseek-v4-pro", host: "mbp" },
  ];
  const turns = lab.fanTurns(records, { from: t - 10, to: t + 40 });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].proposers.length, 2);
  assert.equal(turns[0].agg.model, "deepseek-v4-pro");
  assert.equal(turns[0].id, session);
});

test("held_s is the slowest proposer, not the facade turn duration", () => {
  const t = 1_700_000_000;
  const records = [
    { ts: t, kind: "moa_turn", session_id: "x", duration_s: 3.5, model: "nvidia" },
    { ts: t + 1, kind: "moa_ref", session_id: "x", duration_s: 27.7, model: "glm" },
    { ts: t + 2, kind: "moa_ref", session_id: "x", duration_s: 0.3, model: "flash" },
  ];
  const turns = lab.fanTurns(records, { from: t - 10, to: t + 40 });
  const calls = lab.fanCalls(turns[0]);
  const sum = lab.fanSummary(calls, turns[0]);
  assert.equal(sum.held_s, 27.7);
});

test("children without a subagent_stop at long duration are stuck", () => {
  const t = 1_700_000_000;
  const session = "sess-b";
  const records = [
    { ts: t, kind: "moa_turn", session_id: session, duration_s: 62, model: "nvidia", host: "mini" },
    { ts: t + 1, kind: "moa_ref", session_id: session, duration_s: 2, model: "flash", host: "mini", tps: 40 },
    {
      ts: t + 2, kind: "api", session_id: "child-1", parent_session_id: session,
      duration_s: 62, model: "web_fetch", label: "delegate_task", host: "mbp",
    },
    {
      ts: t + 3, kind: "api", session_id: "child-ok", parent_session_id: session,
      duration_s: 0.8, model: "read_file", host: "mbp",
    },
    {
      ts: t + 4, kind: "subagent_stop", session_id: "child-ok", parent_session_id: session,
      duration_s: 0.82, label: "leaf", host: "mbp",
    },
    {
      ts: t + 5, kind: "subagent_stop", session_id: "slow-leaf", parent_session_id: session,
      duration_s: 51.8, label: "leaf", host: "mini",
    },
  ];
  const turns = lab.fanTurns(records, { from: t - 10, to: t + 80 });
  const calls = lab.fanCalls(turns[0]);
  const stuck = calls.filter(function (c) { return c.stuck; });
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].label, "web_fetch");
  assert.equal(stuck[0].role, "delegate_task");
  assert.equal(calls.filter(function (c) { return c.kind === "subagent" && !c.stuck; }).length >= 1, true);
});

test("fanLayout puts proposers around the hub and stuck in a cluster; length tracks duration", () => {
  const calls = lab.fanLayout([
    { id: "p0", kind: "moa_ref", role: "proposer", duration_s: 2, stuck: false },
    { id: "p1", kind: "moa_ref", role: "proposer", duration_s: 10, stuck: false },
    { id: "s0", kind: "subagent", role: "delegate_task", duration_s: 62, stuck: true },
    { id: "s1", kind: "subagent", role: "delegate_task", duration_s: 62, stuck: true },
    { id: "t0", kind: "tool", role: "read_file", duration_s: 0.4, stuck: false },
  ]);
  assert.ok(Math.abs(calls[0].angle - calls[1].angle) > 0.5);
  assert.ok(Math.abs(calls[2].angle - calls[3].angle) < 1.2);
  assert.ok(calls[1].len > calls[0].len);
  assert.ok(calls[2].len > calls[4].len);
});

test("ok rays downsample; proposers and stuck always stay", () => {
  const calls = [];
  for (let i = 0; i < 6; i++) calls.push({ id: "p" + i, kind: "moa_ref", stuck: false, duration_s: 1 });
  for (let i = 0; i < 4; i++) calls.push({ id: "s" + i, kind: "subagent", stuck: true, duration_s: 62 });
  for (let i = 0; i < 200; i++) calls.push({ id: "t" + i, kind: "tool", stuck: false, duration_s: 0.3 });
  const kept = lab.capOkRays(calls, 40);
  assert.equal(kept.filter(function (c) { return c.kind === "moa_ref"; }).length, 6);
  assert.equal(kept.filter(function (c) { return c.stuck; }).length, 4);
  assert.equal(kept.filter(function (c) { return c.kind === "tool"; }).length, 40);
});

test("filters, tips, summary, and cap what-if keep the Widget Lab story", () => {
  const t = 1_700_000_000;
  const records = lab.mockRecords(t);
  const turns = lab.fanTurns(records, { from: t - 120, to: t + 10 });
  assert.equal(turns.length, 1);
  const calls = lab.fanCalls(turns[0]);
  const sum = lab.fanSummary(calls, turns[0]);
  assert.equal(sum.total, 190);
  assert.equal(sum.proposers, 8);
  assert.equal(sum.stuck, 14);
  assert.equal(sum.held_s, 62);
  assert.equal(lab.fanMatches(calls.find(function (c) { return c.kind === "moa_ref"; }), "proposer"), true);
  const stuck = calls.find(function (c) { return c.stuck; });
  assert.equal(lab.fanMatches(stuck, "stuck"), true);
  const tip = lab.fanTip(stuck);
  assert.match(tip.title, /web_fetch|delegate_task/);
  assert.match(tip.meta, /never returned/);
  const hub = lab.fanTip(null, sum);
  assert.match(hub.title, /aggregator/i);
  const what = lab.fanCapWhatIf(calls, 8);
  assert.equal(what.applicable, true);
  assert.ok(what.capped_s < what.held_s);
});
