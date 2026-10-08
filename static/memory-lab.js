/**
 * memory-v1 lab helpers — KV pool occupancy + efficiency scatter.
 * UMD: browser as window.MemoryLab, node via module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MemoryLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const COLORS = ["#3ee089", "#e8c43a", "#8b7cff", "#7ec8e3", "#cfcfcf", "#d08a6a"];
  const MODEL_POOL_CAPS = {
    "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5": { ctx: 103424, parallel: 2 },
    "supergemma4-26b-uncensored-mlx-v2": { ctx: 64000, parallel: 1 },
  };

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
    return Math.round(v) + "s";
  }

  function fmtTps(v) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return n.toFixed(1);
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

  function capForModel(model) {
    const m = String(model || "");
    if (MODEL_POOL_CAPS[m]) return MODEL_POOL_CAPS[m].ctx;
    const keys = Object.keys(MODEL_POOL_CAPS);
    for (let i = 0; i < keys.length; i++) {
      if (m.indexOf(keys[i]) !== -1 || keys[i].indexOf(m) !== -1) return MODEL_POOL_CAPS[keys[i]].ctx;
    }
    if (/qwen/i.test(m)) return MODEL_POOL_CAPS["qwen3.6-35b-a3b-uncensored-genesis-hermes-v5"].ctx;
    if (/gemma|supergemma/i.test(m)) return MODEL_POOL_CAPS["supergemma4-26b-uncensored-mlx-v2"].ctx;
    return null;
  }

  function countsAsKv(r) {
    return r && (r.kind === "api" || r.kind === "moa_turn" || r.kind === "moa_ref");
  }

  function poolRequestsByModel(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const host = o.host || "";
    const by = new Map();
    (records || []).forEach(function (r) {
      if (!countsAsKv(r)) return;
      if (host && r.host !== host) return;
      if (!r.model || !(Number(r.input_tokens) > 0)) return;
      const end = Number(r.ts) || 0;
      const start = end - (Number(r.duration_s) || 0);
      if (to && start > to) return;
      if (from && end < from) return;
      if (!by.has(r.model)) by.set(r.model, []);
      by.get(r.model).push({ start: start, end: end, tok: Number(r.input_tokens) });
    });
    return by;
  }

  function poolDemandSamples(reqs, t0, t1, n) {
    const out = [];
    const steps = Math.max(8, Number(n) || 40);
    for (let i = 0; i <= steps; i++) {
      const t = t0 + (t1 - t0) * i / steps;
      let demand = 0;
      let active = 0;
      for (let j = 0; j < reqs.length; j++) {
        const q = reqs[j];
        if (q.start <= t && t <= q.end) {
          demand += q.tok;
          active += 1;
        }
      }
      out.push({ ts: t, v: demand, active: active });
    }
    return out;
  }

  function kvModels(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const samplesN = Number(o.samples) || 40;
    const list = [];
    poolRequestsByModel(records, o).forEach(function (reqs, model) {
      if (reqs.length < 1) return;
      const cap = capForModel(model);
      const samples = poolDemandSamples(reqs, from, to, samplesN);
      let peak = 0;
      let peakTs = from;
      samples.forEach(function (s) {
        if (s.v > peak) {
          peak = s.v;
          peakTs = s.ts;
        }
      });
      list.push({
        model: model,
        short: shortModelName(model),
        cap: cap,
        samples: samples,
        peak: peak,
        peakTs: peakTs,
        pct: cap ? (peak / cap) * 100 : null,
        color: "#3ee089",
      });
    });
    list.sort(function (a, b) {
      return (b.pct || 0) - (a.pct || 0) || b.peak - a.peak;
    });
    return list.slice(0, 4).map(function (m, i) {
      m.color = COLORS[i % COLORS.length];
      return m;
    });
  }

  function kvSampleTip(model, sample) {
    const s = sample || {};
    const cap = model && model.cap;
    const pct = cap && s.v ? Math.round((s.v / cap) * 100) : null;
    return {
      title: (model && model.short) + " · in flight",
      meta: fmtTok(s.v) + " · " + (s.active || 0) + " slots" + (pct == null ? "" : " · " + pct + "% of cap") + " · " + fmtTime(s.ts),
    };
  }

  function kvGauge(model) {
    if (!model) return { pct: null, used: 0, cap: null, title: "no model", meta: "pick a model" };
    const cap = model.cap;
    const used = model.peak;
    const pct = cap ? Math.round((used / cap) * 100) : null;
    return {
      pct: pct,
      used: used,
      cap: cap,
      title: model.short,
      meta: cap ? fmtTok(used) + " peak / " + fmtTok(cap) + " pool" : fmtTok(used) + " peak · no loaded-ctx cap",
    };
  }

  function effModels(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const host = o.host || "";
    const by = new Map();
    (records || []).forEach(function (r) {
      if (!countsAsKv(r)) return;
      if (host && r.host !== host) return;
      const ts = Number(r.ts) || 0;
      if (from && ts < from) return;
      if (to && ts > to) return;
      if (!(Number(r.duration_s) > 0) || !(Number(r.output_tokens) > 0)) return;
      const model = r.model || "unknown";
      if (!by.has(model)) by.set(model, []);
      const dur = Number(r.duration_s);
      const out = Number(r.output_tokens);
      const tps = Number(r.tps) > 0 ? Number(r.tps) : out / dur;
      by.get(model).push({ ts: ts, duration_s: dur, output_tokens: out, tps: tps, host: r.host || "" });
    });
    const list = [];
    by.forEach(function (points, model) {
      list.push({ model: model, short: shortModelName(model), points: points, color: "#3ee089" });
    });
    list.sort(function (a, b) { return b.points.length - a.points.length; });
    const cap = Number(o.pointLimit) || 80;
    return list.slice(0, 6).map(function (m, i) {
      m.color = COLORS[i % COLORS.length];
      m.drawn = downsamplePoints(m.points, cap);
      return m;
    });
  }

  function effTip(model, point) {
    const p = point || {};
    return {
      title: (model && model.short) || "model",
      meta: fmtDuration(p.duration_s) + " · " + fmtTok(p.output_tokens) + " out · " + fmtTps(p.tps) + " t/s",
    };
  }

  function median(nums) {
    const a = nums.slice().sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    const mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function effKpis(models) {
    const pts = [];
    (models || []).forEach(function (m) {
      m.points.forEach(function (p) { pts.push(p); });
    });
    const tps = pts.map(function (p) { return p.tps; });
    const slow = pts.filter(function (p) { return p.tps < 10; }).length;
    return {
      n: pts.length,
      medianTps: median(tps),
      slow: slow,
    };
  }

  function mockRecords(now) {
    const t = Number(now) || Date.now() / 1000;
    const qwen = "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5";
    const gemma = "supergemma4-26b-uncensored-mlx-v2";
    const rows = [];
    for (let i = 0; i < 8; i++) {
      rows.push({
        ts: t - 2400 + i * 220,
        duration_s: 18 + (i % 3) * 4,
        kind: "api",
        model: qwen,
        host: "mini",
        input_tokens: 42000 + i * 4000,
        output_tokens: 120 + i * 30,
        tps: 38 - i * 2,
      });
    }
    rows.push({
      ts: t - 900,
      duration_s: 22,
      kind: "api",
      model: qwen,
      host: "mini",
      input_tokens: 51000,
      output_tokens: 80,
      tps: 3.6,
    });
    for (let i = 0; i < 5; i++) {
      rows.push({
        ts: t - 1800 + i * 300,
        duration_s: 6 + i,
        kind: "api",
        model: gemma,
        host: "mbp",
        input_tokens: 8000 + i * 1500,
        output_tokens: 200 + i * 40,
        tps: 28 + i,
      });
    }
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
    MODEL_POOL_CAPS: MODEL_POOL_CAPS,
    fmtTok: fmtTok,
    fmtTime: fmtTime,
    fmtDuration: fmtDuration,
    fmtTps: fmtTps,
    shortModelName: shortModelName,
    capForModel: capForModel,
    downsamplePoints: downsamplePoints,
    kvModels: kvModels,
    kvSampleTip: kvSampleTip,
    kvGauge: kvGauge,
    effModels: effModels,
    effTip: effTip,
    effKpis: effKpis,
    mockRecords: mockRecords,
    parseRangeToken: parseRangeToken,
    windowForRange: windowForRange,
  };
});
