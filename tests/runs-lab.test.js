"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const lab = require(path.resolve(__dirname, "..", "static", "runs-lab.js"));

test("parseRangeToken reads dashboard hash tokens", () => {
  assert.deepEqual(lab.parseRangeToken("6h"), { type: "preset", hours: 6 });
  assert.deepEqual(lab.parseRangeToken("7d"), { type: "preset", hours: 168 });
  assert.equal(lab.parseRangeToken("#/range=6h&host=mini").hours, 6);
  assert.equal(lab.parseRangeToken("today").type, "day");
  assert.equal(lab.parseRangeToken("yesterday").offset, 1);
  assert.equal(lab.parseHostToken("#/range=6h&host=mini"), "mini");
  assert.equal(lab.parseHostToken("#/range=6h&host=all"), "");
  assert.equal(lab.parseHostToken("#/range=6h"), "");
});

test("bucketSeconds picks grain from window length", () => {
  assert.equal(lab.bucketSeconds(1), 300);
  assert.equal(lab.bucketSeconds(6), 1800);
  assert.equal(lab.bucketSeconds(24), 3600);
  assert.equal(lab.bucketSeconds(168), 86400);
});

test("runsFromRecords stacks api vs error in the window and host filter", () => {
  const now = 1700000000;
  const records = [
    { ts: now - 100, kind: "api", host: "mini" },
    { ts: now - 90, kind: "error", host: "mini" },
    { ts: now - 80, kind: "api", host: "mbp" },
    { ts: now - 10000, kind: "api", host: "mini" },
    { ts: now - 50, kind: "pool_status", host: "mini" },
  ];
  const win = lab.windowForRange("1h", now);
  const all = lab.runsFromRecords(records, { from: win[0], to: win[1] });
  const kpis = lab.runsKpis(all);
  assert.equal(kpis.ok, 2);
  assert.equal(kpis.errors, 1);
  assert.equal(kpis.requests, 3);
  const mini = lab.runsFromRecords(records, { from: win[0], to: win[1], host: "mini" });
  assert.equal(lab.runsKpis(mini).ok, 1);
  assert.equal(lab.runsKpis(mini).errors, 1);
  assert.ok(all.length >= 2);
  const last = all[all.length - 1];
  const tip = lab.runsBarTip(last);
  assert.match(tip.title, /:/);
  assert.match(tip.meta, /Ok/);
  assert.match(tip.meta, /Errors/);
});
