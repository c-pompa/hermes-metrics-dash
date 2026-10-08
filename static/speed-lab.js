/**
 * speed-v1 lab helpers — output tok/s (or duration / output tokens) over time
 * with per-model isolation. UMD: window.SpeedLab / module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SpeedLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const COLORS = ["#3ee089", "#e8c43a", "#8b7cff", "#7ec8e3", "#d08a6a", "#cfcfcf"];
  const METRICS = [
    { key: "tps", label: "tok/s", title: "output tok/s per request" },
    { key: "duration_s", label: "duration", title: "duration per request" },
    { key: "output_tokens", label: "output tokens", title: "output tokens per request" },
  ];

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return String(Math.round(v));
  }

  function fmtTime(ts) {
    const d = new Date(Number(ts) * 1000);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function fmtDuration(s) {
    const v = Number(s) || 0;
    if (v < 10) return v.toFixed(1) + "s";
    if (v < 60) return Math.round(v) + "s";
    const m = Math.floor(v / 60);
    const rem = Math.round(v % 60);
    return m + "m " + rem + "s";
  }

  function fmtTps(v) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return n.toFixed(1);
  }

  function fmtMetric(metric, v) {
    if (metric === "duration_s") return fmtDuration(v);
    if (metric === "output_tokens") return fmtTok(v);
    return fmtTps(v);
  }

  function metricOf(key) {
    for (let i = 0; i < METRICS.length; i++) {
      if (METRICS[i].key === key) return METRICS[i];
    }
    return METRICS[0];
  }

  function shortModelName(m) {
    let s = String(m || "model");
    const slash = s.lastIndexOf("/");
    if (slash >= 0) s = s.slice(slash + 1);
    return s
      .replace("qwen3.6-35b-a3b-", "q35-")
      .replace("-uncensored", "")
      .replace("-mlx-v2", "")
      .replace("-genesis-hermes-v5", "");
  }

  function downsamplePoints(points, limit) {
    const list = points || [];
    const n = Math.max(2, Number(limit) || 80);
    if (list.length <= n) return list.slice();
    const out = [];
    const step = (list.length - 1) / (n - 1);
    for (let i = 0; i < n; i++) out.push(list[Math.round(i * step)]);
    return out;
  }

  function median(nums) {
    const a = (nums || []).filter(function (v) { return isFinite(v); }).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function quantile(nums, q) {
    const a = (nums || []).filter(function (v) { return isFinite(v); }).slice().sort(function (x, y) { return x - y; });
    if (!a.length) return null;
    const i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * q)));
    return a[i];
  }

  function countsAsSpeed(r) {
    return r && (r.kind === "api" || r.kind === "moa_turn" || r.kind === "moa_ref");
  }

  function pointValue(r, metric) {
    if (metric === "duration_s") return Number(r.duration_s) || 0;
    if (metric === "output_tokens") return Number(r.output_tokens) || 0;
    if (Number(r.tps) > 0) return Number(r.tps);
    const dur = Number(r.duration_s);
    const out = Number(r.output_tokens);
    return dur > 0 && out > 0 ? out / dur : 0;
  }

  function speedModels(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const metric = o.metric || "tps";
    const host = o.host || "";
    const by = new Map();
    (records || []).forEach(function (r) {
      if (!countsAsSpeed(r)) return;
      if (host && r.host !== host) return;
      const ts = Number(r.ts) || 0;
      if (from && ts < from) return;
      if (to && ts > to) return;
      const v = pointValue(r, metric);
      if (!(v > 0)) return;
      const model = r.model || "unknown";
      if (!by.has(model)) by.set(model, []);
      by.get(model).push({
        ts: ts,
        v: v,
        tps: pointValue(r, "tps"),
        duration_s: Number(r.duration_s) || 0,
        output_tokens: Number(r.output_tokens) || 0,
        host: r.host || "",
        kind: r.kind,
      });
    });
    const cap = Number(o.pointLimit) || 80;
    const list = [];
    by.forEach(function (points, model) {
      points.sort(function (a, b) { return a.ts - b.ts; });
      const values = points.map(function (p) { return p.v; });
      const durs = points.map(function (p) { return p.duration_s; }).filter(function (d) { return d > 0; });
      list.push({
        model: model,
        short: shortModelName(model),
        points: points,
        drawn: downsamplePoints(points, cap),
        bins: speedBins(points, from, to, Number(o.bins) || 24),
        n: points.length,
        median: median(values),
        p50: quantile(durs, 0.5),
        p95: quantile(durs, 0.95),
        color: "#3ee089",
      });
    });
    list.sort(function (a, b) { return b.n - a.n || a.model.localeCompare(b.model); });
    return list.slice(0, Number(o.modelLimit) || 6).map(function (m, i) {
      m.color = COLORS[i % COLORS.length];
      return m;
    });
  }

  function speedBins(points, t0, t1, n) {
    const lo = Number(t0) || 0;
    const hi = Number(t1) || 0;
    const steps = Math.max(6, Number(n) || 24);
    const span = hi - lo;
    if (!(span > 0) || !(points || []).length) return [];
    const buckets = [];
    for (let i = 0; i < steps; i++) buckets.push([]);
    (points || []).forEach(function (p) {
      let idx = Math.floor(((Number(p.ts) - lo) / span) * steps);
      if (idx < 0) idx = 0;
      if (idx >= steps) idx = steps - 1;
      buckets[idx].push(Number(p.v));
    });
    const out = [];
    const width = span / steps;
    for (let i = 0; i < steps; i++) {
      const vals = buckets[i];
      if (!vals.length) continue;
      out.push({
        i: i,
        t0: lo + i * width,
        t1: lo + (i + 1) * width,
        ts: lo + (i + 0.5) * width,
        n: vals.length,
        p25: quantile(vals, 0.25),
        median: median(vals),
        p75: quantile(vals, 0.75),
      });
    }
    return out;
  }

  function laneLayout(models, opts) {
    const o = opts || {};
    const rowH = Number(o.rowH) || 44;
    const gap = Number(o.gap) || 8;
    return (models || []).map(function (m, i) {
      let ymax = 1;
      (m.bins || []).forEach(function (b) {
        if (b.p75 > ymax) ymax = b.p75;
      });
      return {
        model: m.model,
        short: m.short,
        color: m.color,
        n: m.n,
        median: m.median,
        y: i * (rowH + gap),
        h: rowH,
        ymax: ymax,
      };
    });
  }

  function parseHex(hex) {
    let h = String(hex || "#888888").replace("#", "");
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return [
      parseInt(h.slice(0, 2), 16) || 0,
      parseInt(h.slice(2, 4), 16) || 0,
      parseInt(h.slice(4, 6), 16) || 0,
    ];
  }

  function heatFill(median, vmax, hex) {
    const t = vmax > 0 ? Math.max(0, Math.min(1, Number(median) / vmax)) : 0;
    const rgb = parseHex(hex);
    const bg = [18, 18, 18];
    return "rgb(" +
      Math.round(bg[0] + (rgb[0] - bg[0]) * t) + "," +
      Math.round(bg[1] + (rgb[1] - bg[1]) * t) + "," +
      Math.round(bg[2] + (rgb[2] - bg[2]) * t) + ")";
  }

  function heatGrid(models, opts) {
    const o = opts || {};
    let steps = Number(o.steps) || 0;
    (models || []).forEach(function (m) {
      (m.bins || []).forEach(function (b) {
        if (Number(b.i) + 1 > steps) steps = Number(b.i) + 1;
      });
    });
    if (steps < 1) steps = 24;
    const lo = Number(o.from);
    const hi = Number(o.to);
    const span = hi > lo ? hi - lo : 0;
    const width = span > 0 ? span / steps : 0;
    const rows = (models || []).map(function (m) {
      const byI = {};
      (m.bins || []).forEach(function (b) { byI[Number(b.i)] = b; });
      const cells = [];
      for (let i = 0; i < steps; i++) {
        const b = byI[i];
        if (b) {
          cells.push({
            i: i,
            empty: false,
            t0: b.t0, t1: b.t1, ts: b.ts,
            n: b.n, median: b.median, p25: b.p25, p75: b.p75,
          });
        } else {
          cells.push({
            i: i,
            empty: true,
            t0: span ? lo + i * width : 0,
            t1: span ? lo + (i + 1) * width : 0,
            ts: span ? lo + (i + 0.5) * width : 0,
            n: 0, median: 0, p25: 0, p75: 0,
          });
        }
      }
      return {
        model: m.model,
        short: m.short,
        color: m.color,
        cells: cells,
      };
    });
    let vmax = 0;
    rows.forEach(function (r) {
      r.cells.forEach(function (c) {
        if (!c.empty && c.median > vmax) vmax = c.median;
      });
    });
    return { rows: rows, steps: steps, vmax: vmax > 0 ? vmax : 1 };
  }

  function binTip(model, bin, metric) {
    const b = bin || {};
    const m = metricOf(metric);
    return {
      title: ((model && model.short) || "model") + " · " + (b.n || 0) + " req",
      meta: "med " + fmtMetric(m.key, b.median) + " · IQR " + fmtMetric(m.key, b.p25) + "–" + fmtMetric(m.key, b.p75) + " · " + fmtTime(b.ts),
    };
  }

  function speedErrors(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const host = o.host || "";
    const pin = o.model || "";
    const out = [];
    (records || []).forEach(function (r) {
      if (!r || r.kind !== "error") return;
      if (host && r.host !== host) return;
      if (pin && r.model !== pin) return;
      const ts = Number(r.ts) || 0;
      if (from && ts < from) return;
      if (to && ts > to) return;
      out.push({
        ts: ts,
        model: r.model || "unknown",
        short: shortModelName(r.model),
        host: r.host || "",
        error: r.error || "request failed without an error message",
      });
    });
    out.sort(function (a, b) { return a.ts - b.ts; });
    return out.slice(0, 80);
  }

  function speedTip(model, point, metric) {
    const p = point || {};
    const m = metricOf(metric);
    return {
      title: (model && model.short) || "model",
      meta: fmtMetric(m.key, p.v) + " · " + fmtDuration(p.duration_s) + " · " + fmtTok(p.output_tokens) + " out · " + fmtTime(p.ts),
    };
  }

  function errorTip(err) {
    const e = err || {};
    return {
      title: (e.short || "error") + " · failed",
      meta: (e.error || "no message") + " · " + (e.host || "") + " · " + fmtTime(e.ts),
    };
  }

  function isolateModels(models, pin) {
    if (!pin) return models || [];
    return (models || []).filter(function (m) { return m.model === pin; });
  }

  function mockRecords(now) {
    const t = Number(now) || Date.now() / 1000;
    const flash = "z-ai/glm-5.3-flash";
    const glm = "z-ai/glm-5.3";
    const kimi = "moonshotai/kimi-k3";
    const rows = [];
    for (let i = 0; i < 18; i++) {
      rows.push({
        ts: t - 7200 + i * 280,
        duration_s: 12 + (i % 5) * 3,
        kind: "api",
        model: flash,
        host: "cloud",
        input_tokens: 800 + i * 40,
        output_tokens: 180 + i * 20,
        tps: 28 + (i % 4) * 6,
      });
    }
    rows.push({
      ts: t - 900,
      duration_s: 48,
      kind: "api",
      model: flash,
      host: "cloud",
      input_tokens: 1200,
      output_tokens: 40,
      tps: 4.1,
    });
    for (let i = 0; i < 10; i++) {
      rows.push({
        ts: t - 5400 + i * 400,
        duration_s: 6 + i,
        kind: "api",
        model: glm,
        host: "cloud",
        input_tokens: 600,
        output_tokens: 90 + i * 15,
        tps: 32 + i,
      });
    }
    for (let i = 0; i < 6; i++) {
      rows.push({
        ts: t - 3600 + i * 500,
        duration_s: 40 + i * 8,
        kind: "api",
        model: kimi,
        host: "cloud",
        input_tokens: 400,
        output_tokens: 60,
        tps: 1.4 + i * 0.2,
      });
    }
    rows.push({
      ts: t - 1200,
      kind: "error",
      model: flash,
      host: "mini",
      error: "request failed without an error message",
    });
    return rows;
  }

  function parseRangeToken(raw) {
    let s = String(raw || "6h").trim();
    const hash = s.match(/range=([^&]+)/);
    if (hash) s = decodeURIComponent(hash[1]);
    if (s.charAt(0) === "#") s = s.slice(1);
    if (s.charAt(0) === "/") s = s.slice(1);
    const m = /^(\d+(?:\.\d+)?)(h|d)$/.exec(s);
    if (m) return { type: "preset", hours: Number(m[1]) * (m[2] === "d" ? 24 : 1) };
    return { type: "preset", hours: 6 };
  }

  function windowForRange(token, now) {
    const spec = token && typeof token === "object" && token.type ? token : parseRangeToken(token);
    const hours = Number(spec.hours) || 6;
    const t = Number(now);
    return [t - hours * 3600, t];
  }

  return {
    COLORS: COLORS,
    METRICS: METRICS,
    fmtTok: fmtTok,
    fmtTime: fmtTime,
    fmtDuration: fmtDuration,
    fmtTps: fmtTps,
    fmtMetric: fmtMetric,
    metricOf: metricOf,
    shortModelName: shortModelName,
    downsamplePoints: downsamplePoints,
    median: median,
    quantile: quantile,
    pointValue: pointValue,
    speedBins: speedBins,
    laneLayout: laneLayout,
    heatGrid: heatGrid,
    heatFill: heatFill,
    binTip: binTip,
    speedModels: speedModels,
    speedErrors: speedErrors,
    speedTip: speedTip,
    errorTip: errorTip,
    isolateModels: isolateModels,
    mockRecords: mockRecords,
    parseRangeToken: parseRangeToken,
    windowForRange: windowForRange,
  };
});
