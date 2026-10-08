"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const lab = require(path.resolve(__dirname, "..", "static", "widget-lab-hermes.js"));

test("stageMatchesFilter honors surface tags", () => {
  assert.equal(lab.stageMatchesFilter("all", "plugin dash"), true);
  assert.equal(lab.stageMatchesFilter("plugin", "plugin dash"), true);
  assert.equal(lab.stageMatchesFilter("desktop", "plugin dash"), false);
  assert.equal(lab.stageMatchesFilter("dash", "dash"), true);
  assert.equal(lab.stageMatchesFilter("live", "plugin dash live"), true);
  assert.equal(lab.stageMatchesFilter("rework", "plugin dash live"), false);
  assert.equal(lab.stageMatchesFilter("ready", "plugin dash ready"), true);
});

test("requestVolume lengths and peak/error math", () => {
  assert.equal(lab.requestVolume("24h").length, 24);
  assert.equal(lab.requestVolume("7d").length, 7);
  assert.equal(lab.requestVolume("30d").length, 30);
  const data = lab.requestVolume("24h");
  const peak = lab.peakIndex(data);
  assert.equal(peak, 15);
  assert.equal(data[peak], 780);
  assert.equal(lab.errorCount(780, peak, peak), Math.round(780 * 0.04));
  assert.equal(lab.errorCount(240, 0, peak), Math.round(240 * 0.035));
  assert.equal(lab.runBucketLabel("24h", 14), "14:00 – 15:00");
  assert.equal(lab.runBucketLabel("7d", 5), "Sat");
});

test("durationBins tail is 3.1% at 20s", () => {
  const bins = lab.durationBins();
  assert.equal(bins.length, 60);
  assert.equal(lab.cutPercent(bins, 20), "3.1");
  assert.equal(lab.savedHours(20), 41);
});

test("graphView remaps to Hermes tools and reweights", () => {
  const names = lab.graphTools().map((t) => t.name);
  assert.deepEqual(names, ["web_search", "web_fetch", "read_file", "execute_code", "delegate_task"]);
  const calls = lab.graphView("calls");
  assert.equal(calls.find((t) => t.hot).name, "execute_code");
  assert.equal(lab.graphView("latency").find((t) => t.hot).name, "delegate_task");
  assert.equal(lab.graphView("errors").find((t) => t.hot).name, "delegate_task");
});

test("routerFlows sum to 100% and mark pro as fallback", () => {
  const flows = lab.routerFlows();
  const share = flows.reduce((a, f) => a + f.share, 0);
  assert.ok(Math.abs(share - 1) < 1e-9);
  assert.equal(flows.filter((f) => f.fallback).map((f) => f.id).join(), "pro");
});

test("findingsRules and context fill", () => {
  assert.equal(lab.findingsRules().length, 5);
  assert.equal(lab.FAILED_FINDINGS.length, 5);
  const parts = lab.ctxParts();
  assert.equal(lab.ctxUsedPct(parts, 128000), 71);
});

test("costStacks highlight Saturday", () => {
  const sat = lab.costStacks().find((r) => r.day === "Sat");
  assert.equal(sat.highlight, true);
  assert.equal(lab.errorSteps().length, 14);
});

test("ingestHour and ingestFeed describe a live 1h window", () => {
  const hour = lab.ingestHour();
  assert.equal(hour.requests, 47);
  assert.equal(hour.spark.length, 12);
  assert.equal(hour.errors, 2);
  assert.equal(lab.ingestFmtTok(hour.tokens), "124.8k");
  assert.equal(lab.ingestFmtTps(hour.avgTps), "38.2");
  assert.equal(lab.ingestFmtTps(null), "—");
  const feed = lab.ingestFeed();
  assert.equal(feed.length, 5);
  assert.equal(feed.filter((r) => r.kind === "error").length, 1);
  assert.equal(feed[0].host, "mbp");
});

test("hover tip helpers cover every carry-over chart", () => {
  const spark = lab.findingsSpark();
  assert.equal(spark.length, 14);
  const last = lab.findingsSparkTip(13, spark);
  assert.match(last.title, /14 \/ 14/);
  assert.match(last.meta, /92.3%/);

  const hour = lab.ingestHour();
  const now = lab.ingestSparkTip(hour, hour.spark.length - 1);
  assert.match(now.title, /last 5 min/);
  assert.match(now.meta, /3 requests|now/);

  const flash = lab.routerFlowTip(lab.routerFlows()[0], 184);
  assert.match(flash.title, /flash/);
  assert.match(flash.meta, /61%/);
  const pro = lab.routerFlowTip(lab.routerFlows()[3], 184);
  assert.match(pro.meta, /escalation/);

  const run = lab.runBarTip("24h", 15);
  assert.match(run.title, /15:00/);
  assert.match(run.meta, /Ok/);
  assert.match(run.meta, /Errors/);

  const cells = lab.heatCells();
  assert.equal(cells.length, 7 * 24);
  const worst = cells.find((c) => c.worst);
  assert.equal(worst.day, "Thu");
  assert.equal(worst.hour, 15);
  const heat = lab.heatTip(worst);
  assert.match(heat.title, /Thu 15:00/);
  assert.match(heat.meta, /worst/);

  const bins = lab.durationBins();
  const past = lab.durationBinTip(bins, 20, 20);
  assert.match(past.title, /20–21s/);
  assert.match(past.meta, /past ceiling/);
  const under = lab.durationBinTip(bins, 8, 20);
  assert.equal(/past ceiling/.test(under.meta), false);

  const sys = lab.ctxPartTip(lab.ctxParts()[0], 128000);
  assert.match(sys.title, /system prompt/);
  assert.match(sys.meta, /23/);

  const dots = lab.h2hDots();
  assert.equal(dots.length, 180);
  const worstDot = dots.find((d) => d.worst);
  assert.ok(worstDot);
  const h2h = lab.h2hDotTip(worstDot);
  assert.match(h2h.title, /#402/);
  assert.match(h2h.meta, /flash/);
  assert.match(h2h.meta, /pro would/);

  const node = lab.graphNodeTip(lab.graphView("calls").find((t) => t.hot), "calls");
  assert.match(node.title, /execute_code/);
  assert.match(node.meta, /err/);

  const sat = lab.costDayTip(lab.costStacks().find((r) => r.day === "Sat"));
  assert.match(sat.title, /Sat/);
  assert.match(sat.meta, /\$/);

  const err = lab.errorStepTip(6, lab.errorSteps());
  assert.match(err.meta, /%/);
  assert.match(err.meta, /above alert/);

  const rule = lab.alertRules()[0];
  const sparkTip = lab.alertSparkTip(rule);
  assert.match(sparkTip.title, /R5/);
  assert.match(sparkTip.meta, /Firing/);
});

test("fanOutCalls is a 190-call MoA turn with 14 stuck fetches", () => {
  const calls = lab.fanOutCalls();
  const sum = lab.fanOutSummary(calls);
  assert.equal(sum.total, 190);
  assert.equal(sum.proposers, 8);
  assert.equal(sum.stuck, 14);
  assert.ok(sum.errors >= 1);
  assert.equal(calls.filter((c) => c.stuck).every((c) => c.label === "web_fetch"), true);
  assert.equal(lab.fanOutMatches(calls[0], "proposer"), true);
  assert.equal(lab.fanOutMatches(calls[0], "stuck"), false);
  const stuck = calls.find((c) => c.stuck);
  assert.equal(lab.fanOutMatches(stuck, "stuck"), true);
  const tip = lab.fanOutTip(stuck);
  assert.match(tip.title, /web_fetch/);
  assert.match(tip.meta, /never returned/);
  const hub = lab.fanOutTip(null);
  assert.match(hub.title, /aggregator/);
});
