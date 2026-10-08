"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const htmlPath = path.resolve(__dirname, "..", "static", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
// The dashboard script was extracted from inline <script> into ordered
// modules under static/; concatenate them in the page's load order to get
// the same shared-scope program the inline script used to provide.
const MODULE_ORDER = ["util.js", "benchmark.js", "state.js", "tips.js", "charts.js", "fleet.js", "filters.js", "envmode.js", "main.js"];
const inlineSource = MODULE_ORDER
  .map((f) => fs.readFileSync(path.resolve(__dirname, "..", "static", f), "utf8"))
  .join("\n");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(records) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ records }),
  };
}

function findIn(root, sel) {
  const match = (node) => {
    if (sel.startsWith(".")) {
      const cls = sel.slice(1);
      return (node.className || "").split(/\s+/).includes(cls) || Boolean(node.__classes?.has(cls));
    }
    if (sel.startsWith("#")) return node.id === sel.slice(1);
    return (node.tagName || "").toLowerCase() === sel.toLowerCase();
  };
  const walk = (node) => {
    for (const child of node.children || []) {
      if (match(child)) return child;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(root);
}

function element(overrides = {}) {
  const listeners = new Map();
  const attributes = new Map();
  let textContent = "";
  let textWrites = 0;
  const el = {
    addEventListener(name, listener) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
    },
    classList: {
      add(...cs) { cs.forEach(c => el.__classes.add(c)); },
      remove(...cs) { cs.forEach(c => el.__classes.delete(c)); },
      toggle(c, force) {
        const want = force === undefined ? !el.__classes.has(c) : Boolean(force);
        if (want) el.__classes.add(c);
        else el.__classes.delete(c);
        return want;
      },
      contains(c) { return el.__classes.has(c); },
    },
    __classes: new Set(),
    children: [],
    clientWidth: 900,
    dataset: {},
    emit(name, event = {}) {
      for (const listener of listeners.get(name) || []) listener({ target: this, ...event });
    },
    focus() {
      this.focused = true;
    },
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 300 }),
    // Fake 2d canvas context: every method is a recorded no-op, property
    // sets are swallowed, and __calls lists what was invoked.
    getContext() {
      if (!this.__ctx) {
        const calls = [];
        this.__ctx = new Proxy({}, {
          get: (t, prop) => {
            if (prop === "__calls") return calls;
            return (...args) => { calls.push(prop); };
          },
          set: () => true,
        });
      }
      return this.__ctx;
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    hidden: false,
    innerHTML: "",
    listenerCount(name) {
      return (listeners.get(name) || []).length;
    },
    get textContent() {
      return textContent;
    },
    set textContent(value) {
      textWrites++;
      textContent = String(value);
    },
    get textWrites() {
      return textWrites;
    },
    open: false,
    appendChild(child) { el.children.push(child); return child; },
    querySelector(sel) { return findIn(el, sel) || element(); },
    querySelectorAll: () => [],
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    style: {},
    value: "",
    viewBox: { baseVal: { width: 900, height: 300 } },
    width: 300,
    height: 150,
    ...overrides,
  };
  return el;
}

function createHarness({ bootstrap = false, diagnosticState = {} } = {}) {
  const elements = new Map();
  const focusTargets = [];
  const diagnostics = new Map(
    ["pool", "moa", "host", "context", "efficiency", "variance", "guardrails", "conversations"].map(name => {
      const summary = element({ tagName: "SUMMARY" });
      const detail = element({
        dataset: { diagnostic: name },
        open: Boolean(diagnosticState[name]),
        children: [summary],
      });
      // Keep open assignment observable for auto-open tests (real <details>
      // fire "toggle" when .open flips; the harness mirrors that).
      let openVal = Boolean(diagnosticState[name]);
      Object.defineProperty(detail, "open", {
        get() { return openVal; },
        set(v) {
          const next = Boolean(v);
          if (next === openVal) return;
          openVal = next;
          detail.emit("toggle");
        },
        configurable: true,
      });
      return [name, detail];
    })
  );
  const fetches = [];
  const eventSources = [];
  const operations = [];
  const timers = new Map();
  let nextTimer = 1;

  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      eventSources.push(this);
      operations.push("sse");
    }

    addEventListener(name, listener) {
      this.listeners.set(name, listener);
    }

    emit(name, data = "") {
      const listener = this.listeners.get(name);
      if (listener) listener({ data });
    }
  }

  const body = element({ dataset: {} });
  const documentListeners = new Map();
  const document = {
    activeElement: null,
    body,
    documentElement: element({ dataset: {} }),
    createElement: (tag) => element({ tagName: tag }),
    addEventListener(name, listener) {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(listener);
    },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    querySelectorAll(selector) {
      if (selector === ".diagnostic") return [...diagnostics.values()];
      if (selector === "[data-focus-key]") return focusTargets;
      if (selector === ".help-btn") return [];
      return [];
    },
  };
  const context = vm.createContext({
    AbortController,
    Date,
    EventSource: FakeEventSource,
    Map,
    Set,
    URL,
    console: { warn() {} },
    document,
    fetch(url, options = {}) {
      const href = String(url);
      // Router card polls are likewise orthogonal to history/SSE ordering.
      if (href.includes("api/router-")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ loaded: {}, roles: [], notes: [] }),
        });
      }
      // Env-mode status/preview/apply are orthogonal to history/SSE ordering tests.
      if (href.includes("api/env-mode")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            active_mode: "restore-current",
            modes: [
              { id: "optimized-moa", label: "Optimized MoA" },
              { id: "single-model", label: "Single-model" },
              { id: "restore-current", label: "Restore current" },
            ],
            baseline_present: false,
            diff: [],
          }),
        });
      }
      operations.push("fetch");
      const pending = deferred();
      fetches.push({ options, pending, url });
      return pending.promise;
    },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    // Periodic refresh (e.g. the router card) is a no-op under the harness:
    // tests drive renders explicitly, so intervals never need to fire.
    setInterval() {
      return nextTimer++;
    },
    clearInterval() {},
    window: { addEventListener() {}, innerWidth: 1200, innerHeight: 800 },
  });

  let source = inlineSource;
  if (!bootstrap) {
    source = source.replace(
      /\n(?:refetch\(\)\.then\(connectSSE\)|startDashboard\(\));\s*$/,
      "\n"
    );
  }
  vm.runInContext(source, context, { filename: "dashboard-inline.js" });
  if (!bootstrap) {
    vm.runInContext("renderAll = () => {}; scheduleRender = () => {};", context);
  }

  return {
    context,
    diagnostics,
    document,
    elements,
    eventSources,
    fetches,
    focusTargets,
    operations,
    runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(callback => callback());
    },
    run(expression) {
      return vm.runInContext(expression, context);
    },
  };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function installRangeButtons(harness) {
  const group = harness.elements.get("rangesel");
  const preset = element({ dataset: { h: "6" } });
  const custom = element({ dataset: { h: "custom" } });
  preset.closest = () => preset;
  custom.closest = () => custom;
  preset.setAttribute("aria-pressed", "true");
  custom.setAttribute("aria-pressed", "false");
  custom.setAttribute("aria-expanded", "false");
  group.children = [preset, custom];
  harness.elements.set("custbtn", custom);
  return { custom, group, preset };
}

test("newer refetch wins when an older response resolves last", async () => {
  const harness = createHarness();

  const first = harness.run("refetch()");
  const second = harness.run("refetch()");
  // Each refetch issues a requests fetch plus a parallel telemetry fetch.
  assert.equal(harness.fetches.length, 4);

  harness.fetches[2].pending.resolve(response([{ id: 2, ts: 20, kind: "api" }]));
  await second;
  harness.fetches[0].pending.resolve(response([{ id: 1, ts: 10, kind: "api" }]));
  await first;

  assert.deepEqual(Array.from(harness.run("records.map(r => r.id)")), [2]);
});

test("SSE received during refetch survives history replacement and deduplicates", async () => {
  const harness = createHarness();
  harness.run("connectSSE()");
  const stream = harness.eventSources[0];
  stream.emit("hello");

  const loading = harness.run("refetch()");
  stream.emit("rec", JSON.stringify({ id: 2, ts: 20, kind: "api" }));
  harness.fetches[0].pending.resolve(
    response([
      { id: 1, ts: 10, kind: "api" },
      { id: 2, ts: 20, kind: "api" },
      null,
      "invalid",
    ])
  );
  await loading;

  assert.deepEqual(Array.from(harness.run("records.map(r => r.id)")), [1, 2]);
});

test("history and SSE reject null and non-object records", async () => {
  const harness = createHarness();
  harness.run("connectSSE()");
  const stream = harness.eventSources[0];

  const loading = harness.run("refetch()");
  harness.fetches[0].pending.resolve(
    response([null, 7, "bad", [], { id: 1, ts: 10, kind: "api" }])
  );
  await loading;
  stream.emit("rec", "null");
  stream.emit("rec", JSON.stringify("bad"));
  stream.emit("rec", JSON.stringify({ id: 2, ts: 20, kind: "api" }));

  assert.deepEqual(Array.from(harness.run("records.map(r => r.id)")), [1, 2]);
});

test("host/time filters apply to request and telemetry stores independently", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [Date.now()/1000 - 100, Date.now()/1000 + 100];
    getWindow = () => curWin;
    hostFilter = "host-a";
    modelFilter = "chosen";
    convoFilter = { root: "root-a", label: "A" };
    records = [
      { id: 1, ts: Date.now()/1000, host: "host-a", kind: "api", model: "chosen", session_id: "root-a" },
      { id: 2, ts: Date.now()/1000, host: "host-a", kind: "api", model: "other", session_id: "root-a" },
      { id: 3, ts: Date.now()/1000, host: "host-a", kind: "api", model: "chosen", session_id: "root-b" },
      { id: 4, ts: Date.now()/1000, host: "host-b", kind: "api", model: "chosen", session_id: "root-a" }
    ];
    telemetry = [
      { id: 5, ts: Date.now()/1000, host: "host-a", kind: "host_stats" },
      { id: 6, ts: Date.now()/1000, host: "host-a", kind: "pool_status", model: "other", device: "gpu-a" },
      { id: 7, ts: Date.now()/1000, host: "host-b", kind: "pool_status", model: "remote", device: "gpu-b" },
      { id: 8, ts: Date.now()/1000 - 200, host: "host-a", kind: "pool_status", model: "old", device: "gpu-a" }
    ];
  `);

  // Requests: host, model, and conversation focus all apply.
  assert.deepEqual(
    Array.from(harness.run("filteredRecords().map(r => r.id)")),
    [1]
  );
  // Telemetry follows host/time only, so fleet + host diagnostics stay live.
  assert.deepEqual(
    Array.from(harness.run("filteredTelemetry().map(r => r.id)")),
    [5, 6]
  );
  assert.deepEqual(
    Array.from(harness.run("[...loadedNow(filteredTelemetry()).keys()]")),
    ["other"]
  );
});

test("dashboard opens SSE before starting initial history fetch", async () => {
  const harness = createHarness({ bootstrap: true });

  assert.equal(harness.operations[0], "sse");
  assert.deepEqual(harness.operations, ["sse"]);
  harness.eventSources[0].emit("hello");
  await settle();
  assert.equal(harness.operations[1], "fetch");
});

test("late SSE handshake refreshes fallback history to close the gap", () => {
  const harness = createHarness({ bootstrap: true });

  harness.runTimers();
  // The fallback refetch issues the requests fetch plus the telemetry fetch.
  assert.deepEqual(harness.operations, ["sse", "fetch", "fetch"]);
  harness.eventSources[0].emit("hello");

  assert.deepEqual(harness.operations, ["sse", "fetch", "fetch", "fetch", "fetch"]);
  assert.equal(harness.fetches[0].options.signal.aborted, true);
  assert.equal(harness.fetches[1].options.signal.aborted, true);
});

test("operations controls precede the workspaces in the sidebar layout", () => {
  const rail = html.indexOf('id="wsrail"');
  const topbar = html.indexOf('class="ws-topbar"');
  const cats = html.indexOf('id="wscats"');
  const summary = html.indexOf('id="operations-summary"');
  const workspaces = html.indexOf('class="ws-workspaces"');

  assert.ok(rail > 0, "sidebar rail is present");
  assert.ok(rail < topbar, "rail precedes the topbar controls");
  assert.ok(topbar < cats, "topbar controls precede the category tabs");
  assert.ok(cats < workspaces, "category tabs precede the workspaces");
  assert.ok(summary > workspaces, "overview workspace sits inside the workspace container");
  for (const id of ["searchfilter", "kindfilter", "errorsonly", "clearfilters"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const section of ["pool", "moa", "host", "context", "efficiency", "variance", "conversations"]) {
    assert.match(html, new RegExp(`<details[^>]+data-diagnostic="${section}"`));
  }
});

test("text, event kind, and errors-only filters compose and clear together", () => {
  const harness = createHarness();
  harness.run(`
    const now = Date.now()/1000;
    getWindow = () => [now - 10, now + 10];
    records = [
      { id: 1, ts: now, host: "mini", kind: "api", model: "gemma", session_id: "alpha", session_title: "Deploy" },
      { id: 2, ts: now, host: "winpc", kind: "error", model: "qwen", session_id: "beta", error: "CUDA exhausted" },
      { id: 3, ts: now, host: "mini", kind: "error", model: "gemma", session_id: "gamma", error: "timeout" }
    ];
    textFilter = "mini";
    kindFilter = "error";
    errorsOnly = true;
  `);

  assert.deepEqual(Array.from(harness.run("filteredRecords().map(r => r.id)")), [3]);
  harness.run("clearAllFilters()");
  assert.deepEqual(Array.from(harness.run("filteredRecords().map(r => r.id)")), [1, 2, 3]);
});

test("debounced search applies only the latest entered value", () => {
  const harness = createHarness();

  harness.run('queueTextFilter("gem"); queueTextFilter("gemma");');
  assert.equal(harness.run("textFilter"), "");
  harness.runTimers();
  assert.equal(harness.run("textFilter"), "gemma");
});

test("clear all cancels a pending debounced search", () => {
  const harness = createHarness();

  harness.run('queueTextFilter("stale query"); clearAllFilters();');
  harness.runTimers();

  assert.equal(harness.run("textFilter"), "");
});

test("opening Custom preserves the applied range until valid apply", () => {
  const harness = createHarness();
  const { custom, group, preset } = installRangeButtons(harness);
  const before = harness.run("JSON.stringify(rangeMode)");

  group.emit("click", { target: custom });
  assert.equal(harness.run("JSON.stringify(rangeMode)"), before);
  assert.equal(preset.getAttribute("aria-pressed"), "true");
  assert.equal(custom.getAttribute("aria-pressed"), "false");
  assert.equal(custom.getAttribute("aria-expanded"), "true");

  harness.run('$("custfrom").value = ""; $("custto").value = "";');
  harness.elements.get("custapply").emit("click");
  assert.equal(preset.getAttribute("aria-pressed"), "true");
  assert.equal(custom.getAttribute("aria-pressed"), "false");

  harness.run('$("custfrom").value = "2026-07-13T12:00"; $("custto").value = "2026-07-13T13:00";');
  harness.elements.get("custapply").emit("click");
  assert.equal(harness.run("rangeMode.type"), "custom");
  assert.equal(preset.getAttribute("aria-pressed"), "false");
  assert.equal(custom.getAttribute("aria-pressed"), "true");
  assert.equal(custom.getAttribute("aria-expanded"), "true");
});

test("missing custom range reports both fields without changing range or fetching", () => {
  const harness = createHarness();
  const from = harness.run('$("custfrom")');
  const to = harness.run('$("custto")');
  const apply = harness.elements.get("custapply");
  const before = harness.run("JSON.stringify(rangeMode)");

  from.value = "";
  to.value = "";
  apply.emit("click");

  assert.equal(harness.run("JSON.stringify(rangeMode)"), before);
  assert.equal(harness.fetches.length, 0);
  assert.equal(from.getAttribute("aria-invalid"), "true");
  assert.equal(to.getAttribute("aria-invalid"), "true");
  assert.match(harness.elements.get("custerror").textContent, /start and end/i);
});

test("partial correction revalidates both custom range fields immediately", () => {
  const harness = createHarness();
  const from = harness.run('$("custfrom")');
  const to = harness.run('$("custto")');

  from.value = "";
  to.value = "";
  harness.elements.get("custapply").emit("click");
  from.value = "2026-07-13T12:00";
  from.emit("input");

  assert.equal(from.getAttribute("aria-invalid"), "false");
  assert.equal(to.getAttribute("aria-invalid"), "true");
  assert.match(harness.elements.get("custerror").textContent, /end time/i);
});

test("identical custom range feedback is announced only once", () => {
  const harness = createHarness();
  const from = harness.run('$("custfrom")');
  const to = harness.run('$("custto")');
  const apply = harness.elements.get("custapply");

  from.value = "";
  to.value = "";
  apply.emit("click");
  const writes = harness.elements.get("custerror").textWrites;
  apply.emit("click");

  assert.equal(harness.elements.get("custerror").textWrites, writes);
});

test("invalid custom datetime marks only the offending field", () => {
  const harness = createHarness();
  const from = harness.run('$("custfrom")');
  const to = harness.run('$("custto")');

  from.value = "not-a-date";
  to.value = "2026-07-13T13:00";
  harness.elements.get("custapply").emit("click");

  assert.equal(harness.fetches.length, 0);
  assert.equal(from.getAttribute("aria-invalid"), "true");
  assert.equal(to.getAttribute("aria-invalid"), "false");
  assert.match(harness.elements.get("custerror").textContent, /valid start/i);
});

test("reversed custom range marks the end without changing range or fetching", () => {
  const harness = createHarness();
  const from = harness.run('$("custfrom")');
  const to = harness.run('$("custto")');
  const before = harness.run("JSON.stringify(rangeMode)");

  from.value = "2026-07-13T12:00";
  to.value = "2026-07-13T11:00";
  harness.elements.get("custapply").emit("click");

  assert.equal(harness.run("JSON.stringify(rangeMode)"), before);
  assert.equal(harness.fetches.length, 0);
  assert.equal(from.getAttribute("aria-invalid"), "false");
  assert.equal(to.getAttribute("aria-invalid"), "true");
  assert.match(harness.elements.get("custerror").textContent, /after start/i);
});

test("corrected custom range clears feedback, updates range, and fetches once", () => {
  const harness = createHarness();
  const from = harness.run('$("custfrom")');
  const to = harness.run('$("custto")');
  const apply = harness.elements.get("custapply");

  from.value = "2026-07-13T12:00";
  to.value = "2026-07-13T11:00";
  apply.emit("click");
  to.value = "2026-07-13T13:00";
  to.emit("input");

  assert.equal(harness.elements.get("custerror").textContent, "");
  assert.equal(from.getAttribute("aria-invalid"), "false");
  assert.equal(to.getAttribute("aria-invalid"), "false");

  apply.emit("click");
  assert.equal(harness.run("rangeMode.type"), "custom");
  assert.ok(harness.run("rangeMode.to > rangeMode.from"));
  // One refetch = requests fetch + parallel telemetry fetch.
  assert.equal(harness.fetches.length, 2);
});

test("exact local parser rejects a DST-gap-normalized datetime", { concurrency: false }, () => {
  const previousTimezone = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const harness = createHarness();
    assert.equal(harness.run('parseExactLocalDateTime("2026-03-08T02:30")'), null);
    assert.ok(Number.isFinite(harness.run('parseExactLocalDateTime("2026-03-08T03:30")')));
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  }
});

test("clearing the search chip cancels a pending debounced search", () => {
  const harness = createHarness();

  harness.run('textFilter = "active"; queueTextFilter("stale query"); clearFilter("text");');
  harness.runTimers();

  assert.equal(harness.run("textFilter"), "");
});

test("empty pool diagnostic suggests widening relevant filters", () => {
  const harness = createHarness();

  harness.run('hostFilter = ""; renderPool([]);');
  assert.match(harness.run('$("poolnow").innerHTML'), /widen the time range/i);

  harness.run('hostFilter = "mini"; renderPool([]);');
  assert.match(harness.run('$("poolnow").innerHTML'), /all hosts/i);
});

test("feed sorting remains deterministic as SSE records arrive", () => {
  const harness = createHarness();
  harness.run(`
    feedSort = { key: "tps", direction: "desc" };
    records = [
      { id: "b", ts: 20, kind: "api", tps: 30 },
      { id: "a", ts: 20, kind: "api", tps: 30 },
      { id: "c", ts: 10, kind: "api", tps: 10 }
    ];
  `);

  assert.deepEqual(
    Array.from(harness.run("sortedFeedRows(records).map(r => r.id)")),
    ["a", "b", "c"]
  );
  harness.run('appendLiveRecord({ id: "d", ts: 30, kind: "api", tps: 40 })');
  assert.deepEqual(
    Array.from(harness.run("sortedFeedRows(records).map(r => r.id)")),
    ["d", "a", "b", "c"]
  );
});

test("MoA association indexes 20k records by root and nearest time", () => {
  const harness = createHarness();

  const result = harness.run(`
    (() => {
      const turns = Array.from({ length: 10000 }, (_, i) => ({
        id: "t" + i, kind: "moa_turn", session_id: "root-" + i, ts: i * 10, duration_s: 5
      }));
      const refs = Array.from({ length: 10000 }, (_, i) => ({
        id: "r" + i, kind: "moa_ref", parent_session_id: "root-" + i, session_id: "child-" + i, ts: i * 10 + 2
      }));
      const started = Date.now();
      const associations = associateMoARecords(turns, refs);
      return {
        elapsedMs: Date.now() - started,
        matched: [...associations.values()].reduce((total, rows) => total + rows.length, 0),
        first: associations.get(turns[0])[0].id,
        last: associations.get(turns[turns.length - 1])[0].id
      };
    })()
  `);

  assert.equal(result.matched, 10000);
  assert.equal(result.first, "r0");
  assert.equal(result.last, "r9999");
  assert.ok(result.elapsedMs < 1000, `association exceeded budget: ${result.elapsedMs}ms`);
});

test("collapsed diagnostics render lazily with stable toggle listeners and persistent expansion", () => {
  const harness = createHarness({ diagnosticState: { pool: true } });
  const moa = harness.diagnostics.get("moa");
  harness.run('$("waterfall").innerHTML = "collapsed sentinel"; renderOpenDiagnostics([]);');

  assert.equal(harness.run('$("waterfall").innerHTML'), "collapsed sentinel");
  assert.equal(moa.listenerCount("toggle"), 1);

  harness.run("renderOpenDiagnostics([]); renderOpenDiagnostics([]);");
  assert.equal(moa.listenerCount("toggle"), 1);

  moa.open = true;
  assert.match(harness.run('$("waterfall").innerHTML'), /no MoA turns/i);
  harness.run("renderOpenDiagnostics([])");
  assert.equal(moa.open, true);
});

test("diagnostic chips summarize data and auto-open sections until user toggles", () => {
  const harness = createHarness({ diagnosticState: { pool: true } });
  const host = harness.diagnostics.get("host");
  const convos = harness.diagnostics.get("conversations");
  const moa = harness.diagnostics.get("moa");

  assert.ok(host.querySelector(".diagsum"), "chip injected at boot");
  assert.equal(host.open, false);

  harness.run(`
    const now = Date.now() / 1000;
    curWin = [now - 3600, now + 60];
    getWindow = () => curWin;
    records.length = 0;
    telemetry.length = 0;
    appendLiveRecord({ id: 1, ts: now - 10, kind: "host_stats", host: "mbp", cpu: 12, mem: 40 });
    appendLiveRecord({ id: 2, ts: now - 9, kind: "api", host: "mbp", model: "qwen", session_id: "r1", tps: 40 });
    appendLiveRecord({ id: 3, ts: now - 8, kind: "api", host: "mbp", model: "qwen", session_id: "r1", tps: 42 });
    refreshDiagnosticSummaries(filteredRecords());
  `);

  assert.equal(host.open, true, "host auto-opens when telemetry exists");
  assert.equal(convos.open, true, "conversations auto-open when roots exist");
  assert.equal(moa.open, false, "moa stays closed without turns");
  assert.match(host.querySelector(".diagsum").textContent, /1 hosts/);
  assert.match(convos.querySelector(".diagsum").textContent, /1 convos/);
  assert.ok(host.querySelector(".diagsum").classList.contains("has-data"));

  // Manual toggle locks the section closed for the rest of the session.
  harness.run(`diagnosticUserToggled.add("host");`);
  host.open = false;
  harness.run(`refreshDiagnosticSummaries(filteredRecords());`);
  assert.equal(host.open, false, "user-closed section stays closed");
});

test("guardrails diagnostic lists halts, blocks, and empty-response sessions", () => {
  const harness = createHarness({ diagnosticState: { guardrails: true } });

  harness.run(`
    renderGuardrails([
      { ts: 100, kind: "guardrail_halt", session_id: "20260730_231425_926af4", model: "hermes/main",
        error: "turn ended: reason=guardrail_halt after 21 api calls / 77 tool turns" },
      { ts: 99, kind: "guardrail_block", session_id: "20260730_231425_926af4", label: "read_file",
        error: "guardrail repeated_exact_failure_block: Blocked read_file" },
      { ts: 98, kind: "api", session_id: "20260730_231425_926af4", model: "m",
        finish_reason: "stop", assistant_content_chars: 0, output_tokens: 538, reasoning_tokens: 513 },
      { ts: 97, kind: "api", session_id: "20260730_231425_926af4", model: "m",
        finish_reason: "stop", assistant_content_chars: 0, output_tokens: 538, reasoning_tokens: 513 },
      // pure tool-call turn with 0 chars is NORMAL and must not count
      { ts: 96, kind: "api", session_id: "20260730_231425_926af4", model: "m",
        finish_reason: "tool_calls", assistant_content_chars: 0, output_tokens: 66, reasoning_tokens: 35 }
    ]);
  `);

  const html = harness.run('$("guardrails").innerHTML');
  assert.match(html, /1 halt · 1 block/);
  assert.match(html, /read_file/);
  assert.match(html, /guardrail_halt after 21 api calls/);
  assert.match(html, /Empty \/ reasoning-only responses/);
  // 2 empty finished calls out of 3 total (the tool_calls row excluded from empties)
  assert.match(html, /<td class="num">2<\/td>/);

  harness.run("renderGuardrails([])");
  assert.match(harness.run('$("guardrails").innerHTML'), /no guardrail events/i);
});

test("guardrails diagnostic chip counts events and empty-response sessions", () => {
  const harness = createHarness({ diagnosticState: { guardrails: true } });
  const guardrails = harness.diagnostics.get("guardrails");
  assert.ok(guardrails.querySelector(".diagsum"), "chip injected at boot");

  harness.run(`
    const now = Date.now() / 1000;
    curWin = [now - 3600, now + 60];
    getWindow = () => curWin;
    records.length = 0;
    telemetry.length = 0;
    appendLiveRecord({ id: 1, ts: now - 10, kind: "guardrail_halt", session_id: "s1", model: "m" });
    appendLiveRecord({ id: 2, ts: now - 9, kind: "api", session_id: "s2", model: "m",
      finish_reason: "stop", assistant_content_chars: 0, output_tokens: 100, reasoning_tokens: 95 });
    refreshDiagnosticSummaries(filteredRecords());
  `);

  assert.match(guardrails.querySelector(".diagsum").textContent, /1 events · 1 empty-resp/);
  assert.ok(guardrails.querySelector(".diagsum").classList.contains("has-data"));
});

test("20k chart records stay within deterministic SVG budget and preserve critical points", () => {
  const harness = createHarness();

  const result = harness.run(`
    (() => {
      curWin = [0, 20000];
      const rows = Array.from({ length: 20000 }, (_, i) => ({
        id: i, ts: i, kind: "api", model: "model-" + (i % 4), tps: i === 10000 ? 999999 : (i % 100)
      }));
      rows[123].kind = "error";
      rows[123].error = "<img src=x onerror=alert(1)>";
      const sampled = downsampleRecords(rows, SVG_POINT_LIMIT, ["tps"]);
      const started = Date.now();
      renderChart(rows);
      return {
        elapsedMs: Date.now() - started,
        sampledIds: sampled.map(row => row.id),
        renderedPoints: chartPts.length,
        svgLength: $("chart").innerHTML.length
      };
    })()
  `);

  assert.ok(result.renderedPoints <= harness.run("SVG_POINT_LIMIT"));
  assert.ok(result.sampledIds.includes(0));
  assert.ok(result.sampledIds.includes(19999));
  assert.ok(result.sampledIds.includes(123), "errors are preserved");
  assert.ok(result.sampledIds.includes(10000), "relevant extrema are preserved");
  assert.ok(result.svgLength < 500000, `SVG output too large: ${result.svgLength}`);
  assert.ok(result.elapsedMs < 1000, `20k render exceeded budget: ${result.elapsedMs}ms`);
});

test("retained ID set evicts stale IDs and permits safe reuse", () => {
  const harness = createHarness();

  const result = harness.run(`
    (() => {
      for (let id = 0; id <= MAXRECS; id++) appendLiveRecord({ id, ts: id, kind: "api" });
      const beforeReuse = {
        records: records.length,
        seen: seenIds.size,
        evicted: !seenIds.has(0)
      };
      const reused = appendLiveRecord({ id: 0, ts: MAXRECS + 1, kind: "api" });
      return { beforeReuse, reused, newest: records[records.length - 1].id, seen: seenIds.size };
    })()
  `);

  assert.equal(result.beforeReuse.records, 20000);
  assert.equal(result.beforeReuse.seen, 20000);
  assert.equal(result.beforeReuse.evicted, true);
  assert.equal(result.reused, true);
  assert.equal(result.newest, 0);
  assert.equal(result.seen, 20000);
});

test("waterfall rendering escapes hostile session and model values", () => {
  const harness = createHarness();
  harness.run(`
    renderWaterfall([
      { id: 1, kind: "moa_turn", session_id: "root", session_title: "<img src=x onerror=alert(1)>", model: "<script>x</script>", ts: 10, duration_s: 5 },
      { id: 2, kind: "moa_ref", parent_session_id: "root", session_id: "child", model: "<svg onload=alert(1)>", ts: 12, duration_s: 2 }
    ])
  `);
  const output = harness.run('$("waterfall").innerHTML');

  assert.doesNotMatch(output, /<img|<script|<svg/i);
  assert.match(output, /&lt;img|&lt;script|&lt;svg/i);
});

test("volume legend keeps real model names instead of aggregating Other", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 100];
    slotMap = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["model-" + i, i]));
    renderVolume(Array.from({ length: 9 }, (_, i) => ({
      id: i, ts: i + 1, kind: "api", model: "model-" + i, output_tokens: 10
    })));
  `);
  const legend = harness.run('$("vollegend").innerHTML');

  assert.doesNotMatch(legend, /class="aggregate-chip"/);
  assert.doesNotMatch(legend, />Other</);
  assert.match(legend, /data-model="model-8"/);
  assert.match(legend, /title="model-8"/);
});

test("volume chart reclaims idle color slots so active models are not Other", () => {
  const harness = createHarness();
  const legend = harness.run(`
    curWin = [0, 100];
    slotMap = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["stale-" + i, i]));
    renderVolume([
      { id: 1, ts: 10, kind: "moa_ref", model: "qwen3.6-27b-uncensored-hauhaucs-aggressive", output_tokens: 3000 },
      { id: 2, ts: 20, kind: "moa_ref", model: "supergemma4-26b-uncensored-mlx-v2", output_tokens: 2000 },
      { id: 3, ts: 30, kind: "moa_turn", model: "test", output_tokens: 400 },
      { id: 4, ts: 40, kind: "moa_ref", model: "qwen3.6-35b-a3b-claude-4.6-opus-reasoning-distilled", output_tokens: 1500 }
    ]);
    $("vollegend").innerHTML;
  `);

  assert.doesNotMatch(legend, />Other</);
  assert.match(legend, /qwen3\.6-27b-uncensored-hauhaucs-aggressive/);
  assert.match(legend, /supergemma4-26b-uncensored-mlx-v2/);
  assert.match(legend, /qwen3\.6-35b-a3b-claude-4\.6-opus-reasoning-distilled/);
});

test("pressed controls keep visual and accessibility state synchronized", () => {
  const harness = createHarness();
  const button = element();
  harness.context.testButton = button;

  harness.run("setPressedState(testButton, true)");
  assert.equal(button.getAttribute("aria-pressed"), "true");

  harness.run("setPressedState(testButton, false)");
  assert.equal(button.getAttribute("aria-pressed"), "false");
});

test("stable focus keys restore focus after dynamic controls are replaced", () => {
  const harness = createHarness();
  const previous = element({ dataset: { focusKey: "feed:request-7" } });
  const replacement = element({ dataset: { focusKey: "feed:request-7" } });
  harness.document.activeElement = previous;
  harness.focusTargets.push(replacement);

  const key = harness.run("captureFocusKey()");
  harness.run(`restoreFocusKey(${JSON.stringify(key)})`);

  assert.equal(key, "feed:request-7");
  assert.equal(replacement.focused, true);
});

test("connection and filter live regions deduplicate unchanged announcements", () => {
  const harness = createHarness();

  harness.run(`
    historyState = "ok";
    streamState = "live";
    updateConnectionStatus();
    updateConnectionStatus();
    hostFilter = "mini";
    renderFilterChips();
    renderFilterChips();
  `);
  const connectionLabel = harness.elements.get("connlabel");
  const filterStatus = harness.elements.get("filterstatus");

  assert.equal(connectionLabel.textWrites, 1);
  assert.equal(filterStatus.textWrites, 1);
});

test("valid SSE records do not rewrite unchanged connection status", () => {
  const harness = createHarness();
  harness.run('historyState = "ok"; streamState = "live"; updateConnectionStatus(); connectSSE();');
  const before = harness.elements.get("connlabel").textWrites;

  harness.eventSources[0].emit("rec", JSON.stringify({ id: 99, ts: 10, kind: "api" }));

  assert.equal(harness.elements.get("connlabel").textWrites, before);
});

test("feed rows retain table semantics and expose native conversation controls", () => {
  const harness = createHarness();
  harness.run(`
    renderFeed([{
      id: 7, ts: 10, kind: "api", model: "gemma",
      session_id: "root-7", session_title: "Deploy"
    }])
  `);
  const output = harness.run('$("feed").innerHTML');

  assert.doesNotMatch(output, /<tr[^>]+role="button"/);
  assert.match(output, /<button[^>]+class="[^"]*feed-focus[^"]*"[^>]+type="button"/);
  assert.match(output, /data-focus-key="feed:7"/);
  assert.match(output, /aria-label="Focus conversation Deploy"/);
});

test("all interactive charts render focusable, labelled marks without extra data nodes", () => {
  const harness = createHarness();
  const result = harness.run(`
    (() => {
      curWin = [0, 100];
      const row = {
        id: 7, ts: 10, kind: "api", model: "gemma", host: "mini",
        session_id: "root-7", input_tokens: 100, output_tokens: 50,
        duration_s: 5, tps: 10
      };
      renderChart([row]);
      renderVolume([row]);
      renderCtx([row]);
      renderEff([row]);
      return ["chart", "volchart", "ctxchart", "effchart"].map(id => $(id).innerHTML);
    })()
  `);

  for (const output of result) {
    assert.match(output, /tabindex="0"/);
    assert.match(output, /data-point-index="0"/);
    assert.match(output, /aria-label="[^"]+"/);
  }
});

test("chart inspectors expose details on keyboard focus and touch pointer input", () => {
  const harness = createHarness();
  const wrap = harness.elements.get("volwrap");
  const tip = harness.elements.get("voltip");
  harness.run(`
    volBins = [{
      cx: 10, cy: 10, t: 10, binSec: 60, binIndex: 0,
      parts: [["gemma", 100]], total: 100
    }];
  `);

  wrap.emit("focusin", { target: element({ dataset: { pointIndex: "0" } }) });
  assert.equal(tip.style.display, "block");
  assert.match(tip.innerHTML, /gemma/);

  tip.style.display = "none";
  wrap.emit("pointerdown", {
    clientX: 10,
    clientY: 10,
    pointerType: "touch",
    preventDefault() {},
  });
  assert.equal(tip.style.display, "block");

  wrap.emit("pointerleave", { pointerType: "touch" });
  assert.equal(tip.style.display, "block", "touch inspection remains pinned");

  wrap.emit("pointerdown", {
    clientX: 10,
    clientY: 10,
    pointerType: "touch",
  });
  assert.equal(tip.style.display, "none", "tapping the pinned value again dismisses inspection");
});

test("clearing a focused filter moves focus to its source or search fallback", () => {
  const harness = createHarness();
  const expectations = {
    host: "hostsel",
    text: "searchfilter",
    kind: "kindfilter",
    errors: "errorsonly",
    convo: "searchfilter",
    model: "searchfilter",
  };

  for (const [filter, targetId] of Object.entries(expectations)) {
    const target = harness.elements.get(targetId) || element();
    harness.elements.set(targetId, target);
    target.focused = false;
    harness.run(`clearFilterFromControl(${JSON.stringify(filter)})`);
    assert.equal(target.focused, true, `${filter} returns focus to ${targetId}`);
  }
});

test("each chart exposes one roving tab stop and arrow keys move it", () => {
  const harness = createHarness();
  const outputs = harness.run(`
    (() => {
      curWin = [0, 10000];
      const rows = [1000, 5000, 9000].map((ts, index) => ({
        id: index + 1, ts, kind: "api", model: "gemma", host: "mini",
        session_id: "root", input_tokens: 100 + index, output_tokens: 50 + index,
        duration_s: 5 + index, tps: 10 + index
      }));
      renderChart(rows);
      renderVolume(rows);
      renderCtx(rows);
      renderEff(rows);
      return ["chart", "volchart", "ctxchart", "effchart"].map(id => $(id).innerHTML);
    })()
  `);

  for (const output of outputs) {
    assert.equal((output.match(/tabindex="0"/g) || []).length, 1);
    assert.ok((output.match(/tabindex="-1"/g) || []).length >= 1);
  }

  const wrap = harness.elements.get("ctxwrap");
  const first = element({ dataset: { pointIndex: "0" } });
  const second = element({ dataset: { pointIndex: "1" } });
  first.setAttribute("tabindex", "0");
  second.setAttribute("tabindex", "-1");
  wrap.querySelectorAll = selector => selector === ".chart-mark" ? [first, second] : [];
  let prevented = 0;
  wrap.emit("keydown", {
    target: first,
    key: "ArrowRight",
    preventDefault() { prevented++; },
  });

  assert.equal(first.getAttribute("tabindex"), "-1");
  assert.equal(second.getAttribute("tabindex"), "0");
  assert.equal(second.focused, true);
  assert.equal(prevented, 1);
});

test("fmtDuration renders seconds below one minute and minutes above", () => {
  const harness = createHarness();
  const result = harness.run(`
    ({
      short: fmtDuration(12.34),
      minute: fmtDuration(125.67),
      nullish: fmtDuration(null)
    })
  `);
  assert.equal(result.short, "12.3s");
  assert.equal(result.minute, "2m 5.7s");
  assert.equal(result.nullish, "–");
});

test("variance and feed rows expose contextual tooltip metadata", () => {
  const harness = createHarness();
  harness.run(`
    metric = "duration_s";
    renderVariance([
      { id: 1, ts: 10, kind: "api", model: "gemma", duration_s: 44.1, tps: 10 }
    ]);
    renderFeed([{
      id: 2, ts: 12, kind: "api", model: "gemma", host: "mini",
      session_id: "root", duration_s: 90, tps: 8, input_tokens: 10, output_tokens: 5
    }]);
  `);
  const variance = harness.run('$("variance").innerHTML');
  const feed = harness.run('$("feed").innerHTML');

  assert.match(variance, /class="vrow tip-target"/);
  assert.match(variance, /data-tip-scope="variance"/);
  assert.match(feed, /class="tip-target"/);
  assert.match(feed, /data-tip-scope="feed"/);
  assert.match(feed, /1m 30\.0s/);
});

test("waterfall rows expose contextual tooltip metadata and formatted durations", () => {
  const harness = createHarness();
  harness.run(`
    renderWaterfall([
      { id: 1, kind: "moa_turn", session_id: "root", session_title: "Deploy", model: "test", ts: 10, duration_s: 125 },
      { id: 2, kind: "moa_ref", parent_session_id: "root", session_id: "child", model: "gemma", ts: 12, duration_s: 44.1, tps: 10, output_tokens: 20 }
    ])
  `);
  const output = harness.run('$("waterfall").innerHTML');
  assert.match(output, /data-tip-scope="waterfall-row"/);
  assert.match(output, /data-tip-scope="waterfall-turn"/);
  assert.match(output, /2m 5\.0s/);
  assert.match(output, /44\.1s/);
});

/* ---------- redesign coverage (R1/R3/R5/R6, N4–N8, N12–N17) ---------- */

test("refetch excludes heartbeat kinds by default and includes them when shown", async () => {
  const harness = createHarness();

  harness.run("refetch()");
  assert.ok(harness.fetches[0].url.includes("exclude=pool_status,host_stats"),
    `requests fetch excludes heartbeats: ${harness.fetches[0].url}`);

  harness.run("showHeartbeats = true; refetch();");
  assert.equal(harness.fetches.length, 3);   // req + telemetry, then single combined req
  const combined = harness.fetches[2];
  assert.ok(combined.url.includes("/api/recent"));
  assert.ok(!combined.url.includes("exclude="), `heartbeat view fetches everything: ${combined.url}`);
});

test("hidden heartbeats still fetch a telemetry window for the fleet strip", async () => {
  const harness = createHarness();

  const loading = harness.run("refetch()");
  harness.fetches[0].pending.resolve(response([{ id: 1, ts: 20, kind: "api" }]));
  await loading;

  const telemetryFetch = harness.fetches.find(f =>
    String(f.url).includes("/api/recent") && !String(f.url).includes("exclude="));
  assert.ok(telemetryFetch, "a non-excluded telemetry fetch was issued");
  telemetryFetch.pending.resolve(response([
    { id: 2, ts: 20, kind: "host_stats", host: "mini", cpu_load: 1 },
    { id: 3, ts: 20, kind: "pool_status", host: "mini", model: "gemma", device: "mini" },
    { id: 4, ts: 20, kind: "api" },   // request rows are dropped from the telemetry store
  ]));
  await settle();

  assert.deepEqual(Array.from(harness.run("telemetry.map(r => r.id)")), [2, 3]);
  assert.deepEqual(Array.from(harness.run("records.map(r => r.id)")), [1]);
});

test("SSE heartbeats route to telemetry, not the request window, unless shown", () => {
  const harness = createHarness();
  harness.run(`
    appendLiveRecord({ id: 1, ts: 10, kind: "api" });
    appendLiveRecord({ id: 2, ts: 11, kind: "host_stats", host: "mini" });
  `);
  assert.deepEqual(Array.from(harness.run("records.map(r => r.id)")), [1]);
  assert.deepEqual(Array.from(harness.run("telemetry.map(r => r.id)")), [2]);
  // Heartbeats do not drive the feed by default.
  assert.deepEqual(Array.from(harness.run("sortedFeedRows(records).map(r => r.id)")), [1]);

  harness.run(`
    showHeartbeats = true;
    appendLiveRecord({ id: 3, ts: 12, kind: "pool_status", host: "mini", model: "gemma" });
  `);
  assert.deepEqual(Array.from(harness.run("records.map(r => r.id)")), [1, 3]);
  assert.deepEqual(Array.from(harness.run("telemetry.map(r => r.id)")), [2, 3]);
  assert.deepEqual(Array.from(harness.run("sortedFeedRows(records).map(r => r.id)")), [3, 1]);
});

test("conversation cards fall back to source + started date, then session id", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 2000000000];
    renderConvos([
      { id: 1, ts: 100, kind: "api", model: "gemma", session_id: "abc123def456", session_source: "tui", session_started_at: 1784382000, host: "mini" },
      { id: 2, ts: 200, kind: "api", model: "gemma", session_id: "titled-root", session_title: "Deploy fixes", host: "mini" },
      { id: 3, ts: 300, kind: "api", model: "gemma", session_id: "plain-root-xyz", host: "mini" }
    ]);
  `);
  const output = harness.run('$("convos").innerHTML');

  assert.match(output, /tui · /, "source + short date label");
  assert.match(output, /…def456/, "short session suffix");
  assert.match(output, /Deploy fixes/, "title wins when present");
  assert.match(output, /plain-root-xyz/, "raw session fallback without source or title");
});

test("consecutive identical errors collapse into one expandable feed row", () => {
  const harness = createHarness();
  harness.run(`
    renderFeed([
      { id: 1, ts: 100, kind: "api", model: "gemma", host: "mini", session_id: "r1" },
      { id: 2, ts: 200, kind: "error", model: "gemma", host: "mini", error: "boom", session_id: "r2" },
      { id: 3, ts: 300, kind: "error", model: "gemma", host: "mini", error: "boom", session_id: "r3" },
      { id: 4, ts: 400, kind: "error", model: "qwen", host: "mini", error: "boom", session_id: "r4" }
    ]);
  `);
  let output = harness.run('$("feed").innerHTML');

  assert.match(output, /error <span class="count">×2<\/span>/, "group shows ×N");
  assert.equal((output.match(/data-gkey=/g) || []).length, 1,
    "only the identical run groups; the qwen error stays its own row");

  harness.run(`
    expandedErrorGroups.add($("feed").innerHTML.match(/data-gkey="([^"]+)"/)[1]);
    renderFeed([
      { id: 1, ts: 100, kind: "api", model: "gemma", host: "mini", session_id: "r1" },
      { id: 2, ts: 200, kind: "error", model: "gemma", host: "mini", error: "boom", session_id: "r2" },
      { id: 3, ts: 300, kind: "error", model: "gemma", host: "mini", error: "boom", session_id: "r3" },
      { id: 4, ts: 400, kind: "error", model: "qwen", host: "mini", error: "boom", session_id: "r4" }
    ]);
  `);
  output = harness.run('$("feed").innerHTML');
  assert.equal((output.match(/data-gkey=/g) || []).length, 0, "expanded group renders members");
  assert.equal((output.match(/<tr /g) || []).length, 4, "all four rows visible after expand");
});

test("feed marks truncated completions and cloud-served rows", () => {
  const harness = createHarness();
  harness.run(`
    renderFeed([
      { id: 1, ts: 10, kind: "api", model: "gemma", host: "mini", duration_s: 5, finish_reason: "length" },
      { id: 2, ts: 20, kind: "api", model: "kimi-k2", host: "mini", duration_s: 31 },
      { id: 3, ts: 30, kind: "api", model: "qwen", host: "mini", device: "mini", duration_s: 2 }
    ]);
  `);
  const output = harness.run('$("feed").innerHTML');

  assert.equal((output.match(/ico-warn" aria-hidden="true"><\/span>trunc/g) || []).length, 1, "only finish_reason=length is marked");
  assert.match(output, /chip cloud">cloud</, "model without device renders the cloud pill");
  assert.match(output, /chip host">mini</, "device value wins when present");
});

test("CSV export serializes the visible feed rows client-side", () => {
  const harness = createHarness();
  const csv = harness.run(`
    buildFeedCsv([
      { ts: 1784382000, host: "mini", kind: "api", model: "gemma, pro", device: "mini", input_tokens: 10, output_tokens: 5, duration_s: 2.5, tps: 2, cost_usd: 0.001, finish_reason: "stop", session_id: "abc" },
      { ts: 1784382001, host: "mini", kind: "error", model: "qwen", error: 'say "hi"', session_id: "def" }
    ])
  `);
  const lines = csv.trim().split("\n");

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^time_iso,host,kind,model,device/);
  assert.ok(lines[1].includes('"gemma, pro"'), "comma values are quoted");
  assert.ok(lines[2].includes('"say ""hi"""'), "quotes are escaped");
});

test("redesign exposes fleet, banner, model stats, feed controls, and ops footer", () => {
  for (const id of ["fleet", "healthbanner", "modelstats", "hbtoggle", "csvexport", "opsfooter", "envbadge"]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} present in the page`);
  }
  assert.match(html, /<kbd>\/<\/kbd> search/, "keyboard shortcut hint in the header");
});

test("model stats strip summarizes speed, latency, cost, cache, and truncation per model", () => {
  const harness = createHarness();
  harness.run(`
    renderModelStats([
      { id: 1, ts: 1, kind: "api", model: "gemma", tps: 10, duration_s: 2, input_tokens: 100, cache_read_tokens: 50, output_tokens: 20, cost_usd: 0.01, session_id: "s1", finish_reason: "length", device: "mini" },
      { id: 2, ts: 2, kind: "api", model: "gemma", tps: 20, duration_s: 4, input_tokens: 100, cache_read_tokens: 50, output_tokens: 40, cost_usd: 0.02, session_id: "s1", device: "mini" },
      { id: 3, ts: 3, kind: "api", model: "kimi", tps: 5, duration_s: 30, output_tokens: 900, reasoning_tokens: 3100, session_id: "s2" }
    ]);
  `);
  const output = harness.run('$("modelstats").innerHTML');

  assert.match(output, /gemma/);
  assert.match(output, /2 req/);
  assert.match(output, /med <b>15\.0 t\/s<\/b>/);
  assert.match(output, /p50 3\.0s/);
  assert.match(output, /p95 3\.9s/, "interpolated p95 over the two samples");
  assert.match(output, /cache hit 50%/);
  assert.match(output, /1 truncated/);
  assert.match(output, /\$0\.02/, "per-session max cost, not a cumulative sum");
  assert.match(output, /kimi<\/span> · 1 req · cloud/);
  assert.match(output, /reasoning 3\.1k \/ output 900 tok/);
});

test("fleet strip renders liveness, meters, models, and load uptime", () => {
  const harness = createHarness();
  harness.run(`
    (() => {
      const now = Date.now()/1000;
      curWin = [now - 3600, now + 60];
      getWindow = () => curWin;
      // Complete pool batches (all loaded models per heartbeat, as forwarded):
      // gemma is loaded from before history; qwen appears mid-window (a load).
      telemetry = [
        { id: 1, ts: now - 100, kind: "pool_status", host: "mini", model: "gemma", device: "mini" },
        { id: 2, ts: now - 50, kind: "pool_status", host: "mini", model: "gemma", device: "mini" },
        { id: 3, ts: now - 50, kind: "pool_status", host: "mini", model: "qwen", device: "mini" },
        { id: 4, ts: now - 10, kind: "pool_status", host: "mini", model: "gemma", device: "mini" },
        { id: 5, ts: now - 10, kind: "pool_status", host: "mini", model: "qwen", device: "mini" },
        { id: 6, ts: now - 30, kind: "host_stats", host: "mini", cpu_load: 1.0, mem_used_gb: 9, mem_total_gb: 32 },
        { id: 7, ts: now - 5, kind: "host_stats", host: "mini", cpu_load: 1.5, mem_used_gb: 10, mem_total_gb: 32 },
        { id: 8, ts: now - 4000, kind: "host_stats", host: "winpc", cpu_load: 0.5 }
      ];
      records = [{ id: 9, ts: now - 20, kind: "api", host: "mini", model: "gemma" }];
      renderFleet(filteredRecords());
      renderHealthBanner();
    })()
  `);
  const fleet = harness.run('$("fleet").innerHTML');

  assert.match(fleet, /mini/);
  assert.match(fleet, /CPU <b>1\.5<\/b>/);
  assert.match(fleet, /10\.0\/32\.0 GB/);
  assert.match(fleet, /class="fleetspark"/, "dual-series sparkline canvas rendered");
  assert.match(fleet, /gemma <span class="dev">· mini · up \?<\/span>/, "model loaded before history shows up ?");
  assert.match(fleet, /qwen <span class="dev">· mini · up 1m<\/span>/, "observed load transition shows uptime");

  const banner = harness.run('$("healthbanner")');
  assert.equal(banner.hidden, false, "stale host raises the banner");
  assert.match(banner.innerHTML, /winpc/i);
  assert.match(banner.innerHTML, /healthdismiss/);
});

test("health banner dismissal hides it until the stale set changes", () => {
  const harness = createHarness();
  harness.run(`
    (() => {
      const now = Date.now()/1000;
      telemetry = [{ id: 1, ts: now - 4000, kind: "host_stats", host: "winpc", cpu_load: 1 }];
      renderHealthBanner();
    })()
  `);
  assert.equal(harness.run('$("healthbanner").hidden'), false);

  harness.run('dismissedHealthKey = "winpc"; renderHealthBanner();');
  assert.equal(harness.run('$("healthbanner").hidden'), true);

  harness.run(`
    telemetry.push({ id: 2, ts: Date.now()/1000 - 5000, kind: "host_stats", host: "mini" });
    renderHealthBanner();
  `);
  assert.equal(harness.run('$("healthbanner").hidden'), false, "a newly stale host re-raises the banner");
});

test("view state serializes to hash params and applies back", () => {
  const harness = createHarness();
  harness.run(`
    hostFilter = "mini"; kindFilter = "api"; textFilter = "gemma"; errorsOnly = true;
    modelFilter = "qwen"; rangeMode = { type: "preset", hours: 24 };
    feedSort = { key: "tps", direction: "asc" };
  `);
  const qs = harness.run("serializeViewState()");

  for (const part of ["host=mini", "kind=api", "q=gemma", "errors=1", "model=qwen", "range=24h", "sort=tps.asc"]) {
    assert.ok(qs.includes(part), `serialized ${part} in ${qs}`);
  }

  harness.run(`
    hostFilter = ""; kindFilter = ""; textFilter = ""; errorsOnly = false; modelFilter = null;
    rangeMode = { type: "preset", hours: 6 }; feedSort = { key: "ts", direction: "desc" };
    applyViewState(parseViewParams(${JSON.stringify(qs)}));
  `);
  assert.equal(harness.run("hostFilter"), "mini");
  assert.equal(harness.run("kindFilter"), "api");
  assert.equal(harness.run("textFilter"), "gemma");
  assert.equal(harness.run("errorsOnly"), true);
  assert.equal(harness.run("modelFilter"), "qwen");
  assert.equal(harness.run("rangeMode.hours"), 24);
  assert.equal(harness.run("feedSort.key"), "tps");
  assert.equal(harness.run("feedSort.direction"), "asc");

  // Plain routes carry no params; the benchmark route is untouched.
  assert.equal(harness.run('serializeViewState.call ? null : null'), null);
});

test("env-mode status feeds the header badge and chart marker state", async () => {
  const harness = createHarness();
  await harness.run("refreshEnvModeStatus()");

  assert.equal(harness.run("envModeStatus && envModeStatus.active_mode"), "restore-current");
  assert.equal(harness.elements.get("envbadge-mode").textContent, "Restore current");
  assert.equal(harness.elements.get("envmode-active").textContent, "Restore current");
});

test("speed chart draws env-mode and experiment markers inside the window", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 100];
    envModeStatus = { active_mode: "single-model", active_mode_ts: 50 };
    benchmarkMarks = [{ host: "*", label: "distill-v2", ts: 70 }, { host: "*", label: "outside", ts: 700 }];
    renderChart([{ id: 1, ts: 10, kind: "api", model: "gemma", tps: 10 }]);
  `);
  const output = harness.run('$("chart").innerHTML');

  assert.match(output, /env → single-model/);
  assert.match(output, /▼ distill-v2/);
  assert.doesNotMatch(output, /outside/, "out-of-window marks are skipped");
});

test("ops footer renders about metadata and SSE state", () => {
  const harness = createHarness();
  harness.run(`
    aboutInfo = { revision: "c01a299", db_bytes: 43000000, records: 155023, oldest_ts: 1783000000, retention_days: 30, heartbeat_hours: 48 };
    historyState = "ok"; streamState = "live";
    renderOpsFooter();
  `);
  const output = harness.run('$("opsfooter").innerHTML');

  assert.match(output, /c01a299/);
  assert.match(output, /43 MB/);
  assert.match(output, /155,023 records/);
  assert.match(output, /retention: 30d requests \/ 48h heartbeats/);
  assert.match(output, /sse live/);
});

/* ---------- clean-design ports: brush zoom, series toggles, highlight, KPI sparklines ---------- */

test("brush drag zooms the speed chart and reset restores the window", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 100];
    getWindow = () => curWin;
    records = [
      { id: 1, ts: 10, kind: "api", model: "gemma", tps: 10 },
      { id: 2, ts: 30, kind: "api", model: "gemma", tps: 20 },
      { id: 3, ts: 90, kind: "api", model: "gemma", tps: 15 }
    ];
    renderChart(filteredRecords());
  `);
  assert.equal(harness.run("chartZoom"), null);

  const wrap = harness.elements.get("chartwrap");
  wrap.emit("pointerdown", { clientX: 146, pointerId: 1, pointerType: "mouse", button: 0, preventDefault() {} });
  wrap.emit("pointermove", { clientX: 400, pointerType: "mouse" });
  wrap.emit("pointerup", { clientX: 400, pointerType: "mouse" });

  const zoom = Array.from(harness.run("chartZoom") || []);
  assert.equal(zoom.length, 2, "brush set a zoom domain");
  assert.ok(zoom[0] > 5 && zoom[0] < 20, `zoom start ≈ 11.9, got ${zoom[0]}`);
  assert.ok(zoom[1] > 35 && zoom[1] < 50, `zoom end ≈ 42, got ${zoom[1]}`);
  assert.equal(harness.elements.get("chartzoomreset").hidden, false, "reset button appears");
  assert.ok(harness.run("serializeViewState()").includes("zoom="), "zoom joins the URL state");

  // The re-rendered chart uses the zoomed domain for its axis ticks.
  const zoomed = harness.run('$("chart").innerHTML');
  assert.doesNotMatch(zoomed, /no requests in range/, "points survive inside the zoom");

  harness.elements.get("chartzoomreset").emit("click");
  assert.equal(harness.run("chartZoom"), null);
  assert.equal(harness.elements.get("chartzoomreset").hidden, true);

  // A tiny drag is a click, not a zoom.
  wrap.emit("pointerdown", { clientX: 200, pointerId: 2, pointerType: "mouse", button: 0, preventDefault() {} });
  wrap.emit("pointerup", { clientX: 203, pointerType: "mouse" });
  assert.equal(harness.run("chartZoom"), null);
});

test("legend chips toggle series visibility without touching the model filter", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 100];
    getWindow = () => curWin;
    records = [
      { id: 1, ts: 10, kind: "api", model: "gemma", tps: 10 },
      { id: 2, ts: 20, kind: "api", model: "gemma", tps: 12 },
      { id: 3, ts: 30, kind: "api", model: "qwen", tps: 20 },
      { id: 4, ts: 40, kind: "api", model: "qwen", tps: 22 }
    ];
    renderChart(filteredRecords());
  `);
  const before = harness.run('$("chart").innerHTML');
  assert.equal((before.match(/<polyline/g) || []).length, 2);

  const legend = harness.elements.get("legend");
  const chip = { dataset: { model: "gemma" } };
  legend.emit("click", { target: { closest: () => chip } });

  assert.ok(harness.run("hiddenSeries.has('gemma')"));
  assert.equal(harness.run("modelFilter"), null, "chart toggle is not the dashboard filter");
  const after = harness.run('$("chart").innerHTML');
  assert.equal((after.match(/<polyline/g) || []).length, 1, "hidden series leaves the chart");
  const legendHtml = harness.run('$("legend").innerHTML');
  assert.match(legendHtml, /mchip off/, "toggled chip gets the off state");
  assert.match(legendHtml, /aria-pressed="false"/);

  legend.emit("click", { target: { closest: () => chip } });
  assert.ok(!harness.run("hiddenSeries.has('gemma')"), "second click restores the series");
});

test("hovering a feed row dims the other series in the speed chart", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 100];
    getWindow = () => curWin;
    records = [
      { id: 1, ts: 10, kind: "api", model: "gemma", host: "mini", tps: 10, session_id: "r1" },
      { id: 2, ts: 20, kind: "api", model: "gemma", host: "mini", tps: 12, session_id: "r1" },
      { id: 3, ts: 30, kind: "api", model: "qwen", host: "mini", tps: 20, session_id: "r2" },
      { id: 4, ts: 40, kind: "api", model: "qwen", host: "mini", tps: 22, session_id: "r2" }
    ];
    renderChart(filteredRecords());
  `);
  const feedwrap = harness.elements.get("feedwrap");
  feedwrap.emit("pointerover", { target: { closest: () => ({ dataset: { tipModel: "gemma" } }) } });

  assert.equal(harness.run("chartHighlightModel"), "gemma");
  const dimmed = harness.run('$("chart").innerHTML');
  assert.match(dimmed, /<g class="series" data-model="qwen" opacity="0\.15">/);
  assert.doesNotMatch(dimmed, /data-model="gemma" opacity/, "the hovered series stays solid");

  feedwrap.emit("pointerleave");
  assert.equal(harness.run("chartHighlightModel"), null);
});

test("KPI tiles carry interactive sparklines fed by window data", () => {
  for (const id of ["spark-req", "spark-err", "spark-tps", "spark-latency", "spark-tok", "spark-conv", "spark-cache"]) {
    assert.match(html, new RegExp(`<canvas class="kspark" id="${id}"`), `#${id} in the tile markup`);
  }
  const harness = createHarness();
  harness.run(`
    curWin = [0, 100];
    getWindow = () => curWin;
    renderTiles([
      { id: 1, ts: 10, kind: "api", model: "gemma", tps: 10, duration_s: 2, input_tokens: 100, cache_read_tokens: 40, output_tokens: 50, session_id: "r1" },
      { id: 2, ts: 30, kind: "api", model: "gemma", tps: 20, duration_s: 4, input_tokens: 100, cache_read_tokens: 40, output_tokens: 60, session_id: "r1" },
      { id: 3, ts: 70, kind: "api", model: "qwen", tps: 30, duration_s: 1, input_tokens: 50, output_tokens: 40, session_id: "r2" }
    ]);
  `);
  for (const id of ["spark-req", "spark-tps", "spark-conv", "spark-cache"]) {
    const ctx = harness.elements.get(id).getContext();
    assert.ok(ctx.__calls.length > 0, `${id} drew on the 2d context`);
    assert.ok(ctx.__calls.includes("setTransform"), `${id} set up its transform`);
  }
  assert.ok(harness.elements.get("spark-req").getContext().__calls.includes("stroke"), "series line stroked");
  assert.equal(harness.elements.get("spark-req").dataset.sparkBound, "1", "hover listener bound once");
});

test("volume bins render as isolatable groups and model stats show latency whiskers", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 100];
    renderVolume([
      { id: 1, ts: 10, kind: "api", model: "gemma", output_tokens: 10 },
      { id: 2, ts: 20, kind: "api", model: "qwen", output_tokens: 20 }
    ]);
    renderModelStats([
      { id: 1, ts: 1, kind: "api", model: "gemma", tps: 10, duration_s: 2, device: "mini", session_id: "s1" },
      { id: 2, ts: 2, kind: "api", model: "gemma", tps: 20, duration_s: 8, device: "mini", session_id: "s1" }
    ]);
  `);
  const vol = harness.run('$("volchart").innerHTML');
  assert.match(vol, /<g class="volbin" data-bin="/, "bins grouped for hover isolation");

  const stats = harness.run('$("modelstats").innerHTML');
  assert.match(stats, /class="latplot"/, "latency dot-whisker rendered");
  assert.match(stats, /<circle[^>]+r="3.5" fill=/, "p50 dot present");
});

/* ---------- ops-sections pass (P1–P6) ---------- */

test("P1: benchmark Current rows carry inline t/s sparklines and honest unmeasured states", () => {
  const harness = createHarness();
  harness.run(`
    (() => {
      const b = window.HermesBenchmark._internals;
      b.STATE.current = [
        { usage: "aggregator", host: "mini", model: "m-one", ctx_k: 64, parallel: 1, model_gb: 19.8, tps: 45.4, ts: 100, yield: 2.29 },
        { usage: "loaded", host: "mini", model: "m-two", ts: 90 }
      ];
      b.STATE.samples = [
        { usage: "aggregator", host: "mini", model: "m-one", tps: 40, ts: 10, yield: 2.0 },
        { usage: "aggregator", host: "mini", model: "m-one", tps: 45.4, ts: 100, yield: 2.29 }
      ];
      b.renderCurrent();
    })()
  `);
  const output = harness.run('$("bmCurrentTable").innerHTML');

  assert.match(output, /class="bm-curspark"/, "sparkline canvas in the measured row");
  assert.match(output, /no measurements yet/, "unmeasured row gets the honest state");
  assert.match(output, /bm-setusage/, "set-usage affordance intact on the fallback row");
});

test("P2: samples scatter brushes a new domain and double-click resets", () => {
  const harness = createHarness();
  harness.context.samplePts = [
    { t: 0, y: 1.0, color: "#111111", label: "a" },
    { t: 25, y: 2.0, color: "#111111", label: "b" },
    { t: 50, y: 1.5, color: "#111111", label: "c" },
    { t: 75, y: 2.2, color: "#111111", label: "d" },
    { t: 100, y: 1.2, color: "#111111", label: "e" },
  ];
  harness.run('canvasBrushScatter($("bmScatter"), samplePts, {})');
  const cv = harness.elements.get("bmScatter");

  assert.equal(harness.run('$("bmScatter")._brushScatter.domain'), null);
  cv.emit("pointerdown", { clientX: 100, pointerId: 1, pointerType: "mouse", button: 0, preventDefault() {} });
  cv.emit("pointermove", { clientX: 500, pointerType: "mouse" });
  cv.emit("pointerup", { clientX: 500, pointerType: "mouse" });

  const domain = Array.from(harness.run('$("bmScatter")._brushScatter.domain') || []);
  assert.equal(domain.length, 2, "brush committed a zoom domain");
  assert.ok(domain[0] > 3 && domain[0] < 15, `domain start ≈ 7.7, got ${domain[0]}`);
  assert.ok(domain[1] > 48 && domain[1] < 62, `domain end ≈ 54, got ${domain[1]}`);

  cv.emit("dblclick");
  assert.equal(harness.run('$("bmScatter")._brushScatter.domain'), null, "double-click resets the domain");
});

test("P3a: host resources render a dual joint-hover canvas per host", () => {
  const harness = createHarness();
  harness.run(`
    (() => {
      const now = Date.now()/1000;
      curWin = [now - 3600, now + 60];
      getWindow = () => curWin;
      telemetry = [
        { id: 1, ts: now - 40, kind: "host_stats", host: "mini", cpu_load: 1.0, mem_used_gb: 9, mem_total_gb: 32 },
        { id: 2, ts: now - 10, kind: "host_stats", host: "mini", cpu_load: 1.5, mem_used_gb: 10, mem_total_gb: 32 },
        { id: 3, ts: now - 20, kind: "host_stats", host: "mbp", cpu_load: 0.5, mem_used_gb: 17, mem_total_gb: 24 },
        { id: 4, ts: now - 5, kind: "host_stats", host: "mbp", cpu_load: 0.8, mem_used_gb: 17.1, mem_total_gb: 24 }
      ];
      renderHosts(filteredTelemetry());
    })()
  `);
  const output = harness.run('$("hostres").innerHTML');

  assert.equal((output.match(/class="hostres-canvas"/g) || []).length, 2, "one canvas per host");
  assert.match(output, /aria-label="CPU load and memory used[^"]*mini/);
  assert.match(output, /latest CPU 1\.5 · RAM 10\.0\/32\.0 GB/);
});

test("P5: waterfall turns show summary chips and rows isolate on hover", () => {
  const harness = createHarness();
  harness.run(`
    renderWaterfall([
      { id: 1, kind: "moa_turn", session_id: "root", session_title: "Deploy", model: "test", ts: 10, duration_s: 125, output_tokens: 1100 },
      { id: 2, kind: "moa_ref", parent_session_id: "root", session_id: "c1", model: "gemma", ts: 12, duration_s: 44.1, tps: 10, output_tokens: 20 },
      { id: 3, kind: "moa_ref", parent_session_id: "root", session_id: "c2", model: "qwen", ts: 12, duration_s: 20, tps: 5 },
      { id: 4, kind: "moa_agg", parent_session_id: "root", session_id: "c3", model: "agg", ts: 60, duration_s: 10 }
    ]);
  `);
  const output = harness.run('$("waterfall").innerHTML');

  assert.match(output, /fan-out <b>44\.1s<\/b>/, "fan-out chip = slowest proposer");
  assert.match(output, /agg est <b>~1m 20\.9s<\/b>/, "aggregation estimate chip");
  assert.match(output, /out <b>1\.1k<\/b>/, "output tokens chip");
  assert.match(output, /total <b>2m 5\.0s<\/b>/, "total chip");
  assert.ok(harness.elements.get("moaspark").getContext().__calls.length > 0,
    "P5a turn-latency sparkline drew");

  const wrap = harness.elements.get("waterfall");
  const turn = element();
  const row = element();
  row.closest = sel => (sel === ".wturn" ? turn : null);
  wrap.emit("pointerover", { target: { closest: sel => (sel === ".wrow" ? row : null) } });
  assert.ok(turn.classList.contains("has-hover"), "turn gets the dimming class");
  assert.ok(row.classList.contains("hover"), "row gets the highlight class");
  assert.equal(row.style.background, "var(--grid)");

  wrap.emit("pointerleave");
  assert.ok(!turn.classList.contains("has-hover"), "hover clears on leave");
  assert.ok(!row.classList.contains("hover"));
});

test("P6: variance rows gain a p25–p75 box and click-to-filter gesture", () => {
  const harness = createHarness();
  harness.run(`
    metric = "tps";
    renderVariance([
      { id: 1, ts: 1, kind: "api", model: "gemma", tps: 10 },
      { id: 2, ts: 2, kind: "api", model: "gemma", tps: 20 },
      { id: 3, ts: 3, kind: "api", model: "gemma", tps: 30 },
      { id: 4, ts: 4, kind: "api", model: "gemma", tps: 40 }
    ]);
  `);
  const output = harness.run('$("variance").innerHTML');

  assert.match(output, /class="vbox"/, "p25–p75 box layer present");
  assert.match(output, /data-model="gemma"/, "row carries the model for click-to-filter");

  const variance = harness.elements.get("variance");
  const row = { dataset: { model: "gemma", tipScope: "variance", vmin: "10", vmed: "25", vmax: "40", vlast: "40" }, closest: () => null };
  variance.emit("click", { target: { closest: () => row } });
  assert.equal(harness.run("modelFilter"), "gemma");
  variance.emit("click", { target: { closest: () => row } });
  assert.equal(harness.run("modelFilter"), null, "second click toggles the filter off");
});

test("P4: conversation cards carry a per-conversation t/s sparkline", () => {
  const harness = createHarness();
  harness.run(`
    curWin = [0, 1000];
    renderConvos([
      { id: 1, ts: 100, kind: "api", model: "gemma", tps: 10, session_id: "root-1", session_title: "Deploy", host: "mini" },
      { id: 2, ts: 200, kind: "api", model: "gemma", tps: 12, session_id: "root-1", session_title: "Deploy", host: "mini" },
      { id: 3, ts: 300, kind: "api", model: "gemma", tps: 14, session_id: "root-1", session_title: "Deploy", host: "mini" }
    ]);
  `);
  const output = harness.run('$("convos").innerHTML');

  assert.match(output, /class="convospark" data-root="root-1"/, "sparkline canvas in the conversation card");

  harness.run('renderConvos([{ id: 9, ts: 100, kind: "error", model: "gemma", session_id: "root-2", host: "mini" }])');
  assert.doesNotMatch(harness.run('$("convos").innerHTML'), /convospark/, "no sparkline without a t/s series");
});
