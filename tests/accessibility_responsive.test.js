"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const html = fs.readFileSync(
  path.resolve(__dirname, "..", "static", "index.html"),
  "utf8"
);
// JS patterns now live in the extracted modules; assert against the
// concatenated frontend source (markup + all scripts).
const source =
  html +
  "\n" +
  ["util.js", "benchmark.js", "state.js", "tips.js", "charts.js", "fleet.js", "filters.js", "envmode.js", "main.js"]
    .map((f) => fs.readFileSync(path.resolve(__dirname, "..", "static", f), "utf8"))
    .join("\n");

test("controls expose labels, grouped state, focus, and live feedback", () => {
  assert.match(source, /<label[^>]*for="custfrom"[^>]*>/);
  assert.match(source, /<label[^>]*for="custto"[^>]*>/);
  for (const group of ["rangesel", "metricsel", "volmode"]) {
    assert.match(
      html,
      new RegExp(`id="${group}"[^>]+role="group"[^>]+aria-label=`)
    );
  }
  assert.match(source, /:focus-visible/);
  assert.match(source, /id="conn"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.doesNotMatch(source, /id="activefilters"[^>]+aria-live=/);
  assert.match(source, /id="filterstatus"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(source, /aria-pressed=/);
});

test("dynamic clickable content uses controls or complete keyboard behavior", () => {
  assert.match(source, /function captureFocusKey\(/);
  assert.match(source, /function restoreFocusKey\(/);
  assert.match(source, /function renderAll\(\)\s*\{[^}]*captureFocusKey\(\)/s);
  assert.match(source, /function renderAll\(\)[\s\S]*restoreFocusKey\(focusKey\)/);
  assert.match(source, /class="[^"]*mchip[^"]*"[^>]*type="button"/);
  assert.match(source, /class="[^"]*fchip[^"]*"[^>]*type="button"/);
  assert.match(source, /class="[^"]*vname[^"]*"[^>]*type="button"/);
  assert.match(source, /class="[^"]*focusbtn[^"]*"[^>]*type="button"/);
  assert.match(source, /<tr[^>]*data-root=/);
  assert.doesNotMatch(source, /<tr[^>]+role="button"/);
  assert.match(source, /class="[^"]*feed-focus[^"]*"[^>]*type="button"/);
  assert.match(source, /<button[^>]+class="head"[^>]+aria-expanded=/);
  assert.match(source, /data-focus-key=/);
});

test("every SVG chart has a meaningful title and description contract", () => {
  for (const id of ["chart", "volchart", "ctxchart", "effchart"]) {
    assert.match(
      html,
      new RegExp(`<svg[^>]+id="${id}"[^>]+role="(?:img|group)"[^>]+aria-labelledby="${id}-title ${id}-desc"`)
    );
    assert.match(source, new RegExp(`<title id="${id}-title">[^<]+</title>`));
    assert.match(source, new RegExp(`<desc id="${id}-desc">[^<]+</desc>`));
  }
});

test("interactive chart marks support keyboard, pointer, touch, and screen readers", () => {
  for (const id of ["chart", "volchart", "ctxchart", "effchart"]) {
    assert.match(source, new RegExp(`<svg[^>]+id="${id}"[^>]+role="group"`));
  }
  assert.match(source, /function attachChartInspector\(/);
  assert.match(source, /addEventListener\("focusin"/);
  assert.match(source, /addEventListener\("pointermove"/);
  assert.match(source, /addEventListener\("pointerdown"/);
  assert.match(source, /addEventListener\("keydown"/);
  assert.match(source, /ArrowRight/);
  assert.match(source, /tabindex="\$\{index === activeIndex \? "0" : "-1"\}"/);
  assert.match(source, /data-point-index=[^>]+aria-label=/);
});

test("tablet and mobile contracts preserve sticky controls, tables, and touch targets", () => {
  assert.match(source, /@media\s*\(max-width:\s*900px\)/);
  assert.match(source, /@media\s*\(max-width:\s*640px\)/);
  assert.match(source, /\.controls\s*\{[^}]*position:\s*sticky/s);
  assert.match(source, /\.scroll-x\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(source, /\.scroll-x\s+table\s*\{[^}]*min-width:/s);
  assert.match(source, /thead th\s*\{[^}]*position:\s*sticky/s);
  for (const selector of ["#hostsel", "#kindfilter", "#searchfilter", ".toggle", "button.vname"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      html,
      new RegExp(`${escaped}\\s*\\{[^}]*min-height:\\s*44px`, "s"),
      `${selector} has an explicit 44px mobile target`
    );
  }
  assert.match(
    html,
    /<label class="control toggle">[^<]*<input id="errorsonly" type="checkbox">[^<]*errors only<\/label>/,
    "the 44px errors-only label wraps its checkbox"
  );
  assert.match(source, /prefers-reduced-motion:\s*reduce/);
  assert.match(source, /\.wrow\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(source, /\.vrow\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test("wide tables stay contained by responsive grid cards", () => {
  assert.match(
    html,
    /@media\s*\(max-width:\s*1050px\)\s*\{\s*\.cols\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s
  );
  assert.match(source, /\.cols\s*>\s*\*\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(source, /\.card\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/s);
  assert.match(
    html,
    /\.scroll-x\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*max-width:\s*100%/s
  );
  assert.match(source, /\.scroll-x\s+table\s*\{[^}]*min-width:\s*720px/s);
});
