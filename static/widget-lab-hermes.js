/**
 * Pure helpers for the Widget Lab → Hermes metrics carry-over demos.
 * UMD: browser as window.HermesWidgetLab, node via module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HermesWidgetLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function stageMatchesFilter(filter, surfaces) {
    if (filter === "all") return true;
    const set = String(surfaces || "").split(/\s+/).filter(Boolean);
    return set.indexOf(filter) !== -1;
  }

  function peakIndex(data) {
    if (!data.length) return -1;
    let idx = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i] > data[idx]) idx = i;
    }
    return idx;
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function runBucketLabel(range, i) {
    if (range === "24h") {
      return pad2(i) + ":00 – " + pad2((i + 1) % 24) + ":00";
    }
    if (range === "7d") {
      return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i] || "Day " + (i + 1);
    }
    return "Day " + (i + 1);
  }

  function requestVolume(range) {
    if (range === "7d") return [420, 510, 480, 390, 620, 700, 540];
    if (range === "30d") {
      return Array.from({ length: 30 }, function (_, i) {
        return 300 + Math.round(180 * Math.sin(i / 4) + (i % 5) * 20);
      });
    }
    return [
      240, 210, 180, 160, 190, 230, 280, 360, 420, 480, 510, 560,
      600, 640, 712, 780, 740, 680, 620, 560, 500, 430, 380, 320,
    ];
  }

  function errorCount(volume, i, peak) {
    return Math.round(Number(volume) * (i === peak ? 0.04 : 0.035));
  }

  function durationBins() {
    const head = Array.from({ length: 20 }, function (_, s) {
      const z = (s - 8) / 4.5;
      return Math.max(1, Math.round(150 * Math.exp(-0.5 * z * z)));
    });
    const headSum = head.reduce(function (a, b) { return a + b; }, 0);
    const tailSum = Math.round((headSum * 3.1) / 96.9);
    const weights = Array.from({ length: 40 }, function (_, i) {
      return Math.exp(-i / 8);
    });
    const wsum = weights.reduce(function (a, b) { return a + b; }, 0);
    let allocated = 0;
    const tail = weights.map(function (w, i) {
      if (i === weights.length - 1) return Math.max(0, tailSum - allocated);
      const v = Math.round((w / wsum) * tailSum);
      allocated += v;
      return v;
    });
    return head.concat(tail);
  }

  function cutPercent(bins, cut) {
    const total = bins.reduce(function (a, b) { return a + b; }, 0);
    if (!total) return "0.0";
    const tail = bins.slice(Number(cut)).reduce(function (a, b) { return a + b; }, 0);
    return ((tail / total) * 100).toFixed(1);
  }

  function savedHours(cut) {
    return Math.round(13 + (60 - Number(cut)) * 0.7);
  }

  function graphTools() {
    return [
      { name: "web_search", calls: 2140, p50ms: 890, err: 1.2 },
      { name: "web_fetch", calls: 1680, p50ms: 1420, err: 2.1 },
      { name: "read_file", calls: 4820, p50ms: 48, err: 0.2 },
      { name: "execute_code", calls: 960, p50ms: 2400, err: 3.8 },
      { name: "delegate_task", calls: 420, p50ms: 8100, err: 4.6 },
    ];
  }

  function graphView(mode) {
    const tools = graphTools();
    let key = "calls";
    if (mode === "latency") key = "p50ms";
    else if (mode === "errors") key = "err";
    const ranked = tools
      .map(function (t, i) { return Object.assign({}, t, { i: i }); })
      .sort(function (a, b) { return b[key] - a[key]; });
    const hotName = ranked[0].name;
    return tools.map(function (t) {
      let meta;
      let badge;
      const p50 = t.p50ms >= 1000
        ? (t.p50ms / 1000).toFixed(1) + " s"
        : t.p50ms + " ms";
      if (mode === "latency") {
        meta = t.calls.toLocaleString() + " calls";
        badge = "p50 " + p50;
      } else if (mode === "errors") {
        meta = t.calls.toLocaleString() + " · p50 " + p50;
        badge = t.err + "% err";
      } else {
        meta = t.calls.toLocaleString() + " · p50 " + p50;
        badge = t.err + "% err";
      }
      const hot = mode === "calls" ? t.name === "execute_code" : t.name === hotName;
      return Object.assign({}, t, { meta: meta, badge: badge, hot: hot });
    });
  }

  function routerFlows() {
    return [
      { id: "flash", label: "flash  61%", share: 0.61, color: "#5a5a5a" },
      { id: "local", label: "local  22%", share: 0.22, color: "#6a6a6a" },
      { id: "nvidia", label: "nvidia  11%", share: 0.11, color: "#7a7a7a" },
      { id: "pro", label: "pro  6%", share: 0.06, color: "#e8c43a", fallback: true },
    ];
  }

  function findingsRules() {
    return [
      { rule: "R12", name: "guardrail_halt", type: "log", pass: 0.97, delta: "+1.2", cls: "metric" },
      { rule: "R13", name: "empty_response", type: "metric", pass: 0.88, delta: "−1.6", cls: "metric" },
      { rule: "R1", name: "tps_drop", type: "metric", pass: 0.94, delta: "+3.8", cls: "metric" },
      { rule: "R5", name: "error_spike", type: "metric", pass: 0.91, delta: "+0.4", cls: "metric" },
      { rule: "R8", name: "pool_pressure", type: "metric", pass: 1, delta: "—", cls: "regex" },
    ];
  }

  const FAILED_FINDINGS = [
    { id: "R12", eval: "guardrail_halt", note: "execute_code blocked · 3× this hour" },
    { id: "R13", eval: "empty_response", note: "reasoning-only reply · dialectic" },
    { id: "R1", eval: "tps_drop", note: "flash 12 t/s → 4.1 t/s on mini" },
    { id: "R5", eval: "error_spike", note: "api_request_error on winpc · nvidia" },
    { id: "R12", eval: "guardrail_halt", note: "read_file path outside workspace" },
  ];

  function ctxParts() {
    return [
      { label: "system prompt", tokens: 23100, color: "#3ee089" },
      { label: "tool results", tokens: 39700, color: "#8a8a8a" },
      { label: "conversation", tokens: 20500, color: "#5a5a5a" },
      { label: "user input", tokens: 7900, color: "#3a3a3a" },
    ];
  }

  function ctxUsedPct(parts, cap) {
    const used = parts.reduce(function (a, p) { return a + p.tokens; }, 0);
    return Math.round((used / cap) * 100);
  }

  function costStacks() {
    return [
      { day: "Tue", layers: [70, 28, 10] },
      { day: "Wed", layers: [74, 26, 12] },
      { day: "Thu", layers: [80, 30, 10] },
      { day: "Fri", layers: [86, 32, 12] },
      { day: "Sat", layers: [96, 0, 0], highlight: true },
      { day: "Sun", layers: [40, 18, 8] },
      { day: "Mon", layers: [36, 16, 8] },
    ];
  }

  function errorSteps() {
    return [8, 8, 9, 10, 12, 18, 48, 50, 50, 22, 16, 14, 12, 12];
  }

  function ingestHour() {
    return {
      requests: 47,
      avgTps: 38.2,
      tokens: 124800,
      errors: 2,
      spark: [2, 3, 1, 4, 6, 5, 8, 7, 9, 6, 4, 3],
      source: "http://192.0.2.10:8899",
      newestAgo: "4s",
    };
  }

  function ingestFeed() {
    return [
      { ts: "15:48:12", host: "mbp", model: "deepseek-v4-flash", kind: "api", out: 842, duration_s: 2.1, tps: 41.2 },
      { ts: "15:47:58", host: "mini", model: "deepseek-v4-flash", kind: "api", out: 1204, duration_s: 3.4, tps: 36.8 },
      { ts: "15:47:41", host: "mbp", model: "qwen3-coder", kind: "api", out: 2106, duration_s: 8.9, tps: 22.1 },
      { ts: "15:47:22", host: "winpc", model: "deepseek-v4-pro", kind: "error", out: 0, duration_s: 12.0, tps: null },
      { ts: "15:46:55", host: "mini", model: "deepseek-v4-flash", kind: "moa_turn", out: 640, duration_s: 6.2, tps: 31.4 },
    ];
  }

  function ingestFmtTok(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function ingestFmtTps(v) {
    return typeof v === "number" && isFinite(v) ? v.toFixed(1) : "—";
  }

  function fanRand(seed) {
    let x = seed;
    return function () {
      x = (x * 16807) % 2147483647;
      return (x - 1) / 2147483646;
    };
  }

  function fanOutCalls() {
    const rand = fanRand(42);
    const proposers = [
      { model: "deepseek-v4-flash", host: "mini", duration_s: 1.4, tps: 44.2 },
      { model: "deepseek-v4-flash", host: "mbp", duration_s: 1.8, tps: 38.1 },
      { model: "qwen3-coder", host: "mbp", duration_s: 2.6, tps: 22.0 },
      { model: "glm-4.5", host: "mini", duration_s: 2.1, tps: 28.4 },
      { model: "deepseek-v4-flash", host: "winpc", duration_s: 1.9, tps: 36.0 },
      { model: "deepseek-v4-pro", host: "mini", duration_s: 3.4, tps: 18.2 },
      { model: "qwen3-coder", host: "mini", duration_s: 2.9, tps: 19.5 },
      { model: "deepseek-v4-flash", host: "mbp", duration_s: 1.6, tps: 41.0 },
    ];
    const calls = proposers.map(function (p, i) {
      return {
        id: "p" + i,
        kind: "moa_ref",
        role: "proposer",
        label: p.model,
        host: p.host,
        duration_s: p.duration_s,
        tps: p.tps,
        status: "ok",
        stuck: false,
        angle: (i / 8) * Math.PI * 2 - Math.PI / 2,
        len: 58 + i * 2,
      };
    });
    for (let i = 0; i < 14; i++) {
      calls.push({
        id: "s" + i,
        kind: "subagent",
        role: "delegate_task",
        label: "web_fetch",
        host: i % 2 ? "winpc" : "mbp",
        duration_s: 62,
        tps: null,
        status: "stuck",
        stuck: true,
        angle: -0.4 + (i / 14) * 1.1,
        len: 70 + i * 5,
      });
    }
    const tools = ["web_search", "read_file", "execute_code", "delegate_task"];
    const hosts = ["mbp", "mini", "winpc"];
    let n = 0;
    while (calls.length < 190) {
      const r = rand();
      const tool = tools[n % tools.length];
      calls.push({
        id: "t" + n,
        kind: n % 7 === 0 ? "subagent" : "tool",
        role: tool,
        label: tool,
        host: hosts[n % 3],
        duration_s: Math.round((0.2 + r * 2.4) * 10) / 10,
        tps: Math.round((12 + r * 40) * 10) / 10,
        status: n % 41 === 0 ? "error" : "ok",
        stuck: false,
        angle: r * Math.PI * 2,
        len: 48 + rand() * 92,
      });
      n += 1;
    }
    return calls;
  }

  function fanOutSummary(calls) {
    const list = calls || [];
    return {
      total: list.length,
      proposers: list.filter(function (c) { return c.kind === "moa_ref"; }).length,
      stuck: list.filter(function (c) { return c.stuck; }).length,
      errors: list.filter(function (c) { return c.status === "error"; }).length,
      held_s: 62,
    };
  }

  function fanOutMatches(call, filter) {
    if (filter === "all") return true;
    if (filter === "proposer") return call.kind === "moa_ref";
    if (filter === "stuck") return call.stuck === true;
    return true;
  }

  function fanOutTip(call) {
    if (!call) {
      return { title: "aggregator · flash", meta: "8 proposers · 14 stuck · 62s wall" };
    }
    const dur = call.duration_s >= 10
      ? Math.round(call.duration_s) + "s"
      : Number(call.duration_s).toFixed(1) + "s";
    let extra;
    if (call.stuck) extra = "never returned";
    else if (call.status === "error") extra = "error";
    else extra = call.tps == null ? "ok" : Number(call.tps).toFixed(1) + " t/s";
    const title = call.kind === "moa_ref"
      ? "proposer · " + call.label
      : call.role + " · " + call.label + (call.stuck ? " · stuck" : "");
    return { title: title, meta: call.host + " · " + dur + " · " + extra, stuck: !!call.stuck };
  }

  function findingsSpark() {
    return [0.88, 0.89, 0.875, 0.9, 0.91, 0.9, 0.92, 0.905, 0.93, 0.91, 0.925, 0.91, 0.94, 0.923];
  }

  function findingsSparkTip(i, spark) {
    const series = spark || findingsSpark();
    const v = Number(series[i] || 0);
    return {
      title: (i + 1) + " / " + series.length,
      meta: (v * 100).toFixed(1) + "% clean",
    };
  }

  function ingestSparkTip(hour, i) {
    const spark = (hour && hour.spark) || [];
    const v = Number(spark[i] || 0);
    const isLast = i === spark.length - 1;
    const ago = (spark.length - 1 - i) * 5;
    return {
      title: isLast ? "last 5 min" : ago + "–" + (ago + 5) + " min ago",
      meta: v + " request" + (v === 1 ? "" : "s") + (isLast ? " · now" : ""),
    };
  }

  function routerFlowTip(flow, total) {
    const share = Number(flow && flow.share) || 0;
    const n = Math.round(share * Number(total || 0));
    const pct = Math.round(share * 100);
    let meta = pct + "% · " + n + " req";
    if (flow && flow.fallback) meta += " · escalation";
    return { title: (flow && (flow.id || flow.label)) || "lane", meta: meta };
  }

  function runBarTip(range, i) {
    const data = requestVolume(range);
    const peak = peakIndex(data);
    const v = Number(data[i] || 0);
    const err = errorCount(v, i, peak);
    return {
      title: runBucketLabel(range, i),
      meta: "Ok " + Math.max(0, v - err) + " · Errors " + err,
    };
  }

  function heatCells() {
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const rand = fanRand(9);
    const cells = [];
    days.forEach(function (d, di) {
      for (let h = 0; h < 24; h++) {
        const biz = h >= 9 && h <= 18 && di < 5;
        let v = biz ? 0.45 + rand() * 0.5 : 0.15 + rand() * 0.25;
        const worst = di === 3 && h === 15;
        if (worst) v = 1;
        cells.push({
          day: d,
          hour: h,
          v: v,
          p50: 0.6 + v * 3.2,
          worst: worst,
        });
      }
    });
    return cells;
  }

  function heatTip(cell) {
    const p50 = Number(cell && cell.p50).toFixed(1);
    return {
      title: cell.day + " " + pad2(cell.hour) + ":00",
      meta: "p50 " + p50 + "s" + (cell.worst ? " · worst" : ""),
    };
  }

  function durationBinTip(bins, i, cut) {
    const v = Number((bins && bins[i]) || 0);
    let meta = v + " request" + (v === 1 ? "" : "s");
    if (i >= Number(cut)) meta += " · past ceiling";
    return { title: i + "\u2013" + (i + 1) + "s", meta: meta };
  }

  function ctxPartTip(part, cap) {
    const tokens = Number(part && part.tokens) || 0;
    const k = (tokens / 1000).toFixed(1);
    const pct = cap ? Math.round((tokens / cap) * 100) : 0;
    return { title: part.label, meta: k + "k · " + pct + "%" };
  }

  function h2hDots() {
    const rand = fanRand(21);
    const dots = [];
    for (let i = 0; i < 180; i++) {
      const x = 20 + rand() * 320;
      const g = Math.exp(-Math.pow((x - 200) / 70, 2));
      const y = 60 + (rand() - 0.5) * 70 * g;
      const win = y < 60;
      const flash = win ? 1.2 + (60 - y) / 40 : 2.0 + (y - 60) / 20;
      const pro = win ? flash + 0.4 : Math.max(0.6, flash - (y - 60) / 25);
      dots.push({
        i: i,
        x: x,
        y: y,
        win: win,
        turn: 300 + i,
        flash_s: Math.round(flash * 10) / 10,
        pro_s: Math.round(pro * 10) / 10,
        worst: false,
      });
    }
    let worstI = 0;
    for (let i = 1; i < dots.length; i++) {
      if (dots[i].y > dots[worstI].y) worstI = i;
    }
    dots[worstI].worst = true;
    dots[worstI].turn = 402;
    dots[worstI].flash_s = 4.8;
    dots[worstI].pro_s = 2.1;
    return dots;
  }

  function h2hDotTip(dot) {
    return {
      title: "turn #" + dot.turn + (dot.worst ? " · worst" : ""),
      meta: "flash " + Number(dot.flash_s).toFixed(1) + "s · pro would " + Number(dot.pro_s).toFixed(1) + "s",
    };
  }

  function graphNodeTip(tool) {
    return {
      title: tool.name,
      meta: (tool.meta || "") + (tool.badge ? " · " + tool.badge : ""),
    };
  }

  function costDayTip(row) {
    const stacks = costStacks();
    const grand = stacks.reduce(function (a, r) {
      return a + r.layers.reduce(function (x, y) { return x + y; }, 0);
    }, 0);
    const sum = (row.layers || []).reduce(function (a, b) { return a + b; }, 0);
    const usd = grand ? (sum / grand) * 18.4 : 0;
    return {
      title: row.day + (row.highlight ? " · cloud spike" : ""),
      meta: "$" + usd.toFixed(2),
    };
  }

  function errorStepTip(i, steps) {
    const series = steps || errorSteps();
    const raw = Number(series[i] || 0);
    const pct = (raw / 10).toFixed(1);
    const start = 14 * 60;
    const min = start + Math.round((i / Math.max(1, series.length - 1)) * 80);
    return {
      title: pad2(Math.floor(min / 60) % 24) + ":" + pad2(min % 60),
      meta: pct + "%" + (raw / 10 > 2 ? " · above alert" : " · under 2%"),
    };
  }

  function alertRules() {
    return [
      { id: "R5", name: "R5 error spike", meta: "> 2% · 5 min", status: "Firing", on: true, spark: [8, 9, 10, 12, 18, 16] },
      { id: "R-p95", name: "p95 duration", meta: "> 4 s · 15 min", status: "Ok", on: true, spark: [10, 11, 10, 12, 11, 10] },
      { id: "R-cost", name: "cost / hour", meta: "> $4 · 1 h", status: "Ok", on: true, spark: [9, 10, 11, 10, 12, 11] },
      { id: "R1", name: "R1 tps drop", meta: "< 8 t/s · 10 min", status: "Ok", on: true, spark: [12, 12, 12, 11, 12, 12] },
      { id: "R12", name: "R12 guardrail", meta: "≥ 3 halts · 1 h", status: "Muted", on: false, spark: [8, 9, 8, 10, 9, 8] },
      { id: "R13", name: "R13 empty reply", meta: "≥ 3 · 1 h", status: "Muted", on: false, spark: [7, 12, 8, 14, 9, 11] },
    ];
  }

  function alertSparkTip(rule) {
    const spark = (rule && rule.spark) || [];
    const last = spark.length ? spark[spark.length - 1] : 0;
    return {
      title: (rule && (rule.id || rule.name)) || "rule",
      meta: (rule && rule.status ? rule.status : "Ok") + " · last " + last,
    };
  }

  return {
    stageMatchesFilter: stageMatchesFilter,
    peakIndex: peakIndex,
    runBucketLabel: runBucketLabel,
    requestVolume: requestVolume,
    errorCount: errorCount,
    durationBins: durationBins,
    cutPercent: cutPercent,
    savedHours: savedHours,
    graphTools: graphTools,
    graphView: graphView,
    routerFlows: routerFlows,
    findingsRules: findingsRules,
    FAILED_FINDINGS: FAILED_FINDINGS,
    ctxParts: ctxParts,
    ctxUsedPct: ctxUsedPct,
    costStacks: costStacks,
    errorSteps: errorSteps,
    ingestHour: ingestHour,
    ingestFeed: ingestFeed,
    ingestFmtTok: ingestFmtTok,
    ingestFmtTps: ingestFmtTps,
    fanOutCalls: fanOutCalls,
    fanOutSummary: fanOutSummary,
    fanOutMatches: fanOutMatches,
    fanOutTip: fanOutTip,
    findingsSpark: findingsSpark,
    findingsSparkTip: findingsSparkTip,
    ingestSparkTip: ingestSparkTip,
    routerFlowTip: routerFlowTip,
    runBarTip: runBarTip,
    heatCells: heatCells,
    heatTip: heatTip,
    durationBinTip: durationBinTip,
    ctxPartTip: ctxPartTip,
    h2hDots: h2hDots,
    h2hDotTip: h2hDotTip,
    graphNodeTip: graphNodeTip,
    costDayTip: costDayTip,
    errorStepTip: errorStepTip,
    alertRules: alertRules,
    alertSparkTip: alertSparkTip,
  };
});
