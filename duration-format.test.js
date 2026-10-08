const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const util = fs.readFileSync(`${__dirname}/static/util.js`, "utf8");
const source = util.match(/function fmtDuration\(seconds\) \{[\s\S]*?\n\}/)?.[0];

test("formats durations below one minute as seconds", () => {
  assert.ok(source, "fmtDuration helper is defined");
  const context = {};
  vm.runInNewContext(source, context);

  assert.equal(context.fmtDuration(12.34), "12.3s");
  assert.equal(context.fmtDuration(null), "–");
});

test("formats durations of at least one minute as minutes and seconds", () => {
  assert.ok(source, "fmtDuration helper is defined");
  const context = {};
  vm.runInNewContext(source, context);

  assert.equal(context.fmtDuration(60), "1m 0.0s");
  assert.equal(context.fmtDuration(125.67), "2m 5.7s");
  assert.equal(context.fmtDuration(59.96), "1m 0.0s");
});
