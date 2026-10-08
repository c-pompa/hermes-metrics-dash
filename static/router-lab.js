/**
 * router-v1 lab helpers — live family lanes + role usage.
 * UMD: window.RouterLab / module.exports.
 *
 * Lanes are model families (local / glm / qwen / nvidia), never DSv4
 * flash/pro. Same buckets as plugin trafficLanes().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RouterLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const LANE_STYLE = {
    local: { color: "#8b8b8b", fallback: false },
    glm: { color: "#8b7cff", fallback: false },
    qwen: { color: "#3ee089", fallback: false },
    nvidia: { color: "#e8c43a", fallback: true },
    other: { color: "#6a6a6a", fallback: false },
  };

  function pad2(n) {
    return String(n).padStart(2, "0");
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

  function parseHostToken(raw) {
    const s = String(raw || "");
    const m = s.match(/(?:^|[?&#])host=([^&]+)/);
    if (!m) return "";
    const host = decodeURIComponent(m[1]);
    return host === "all" ? "" : host;
  }

  function windowForRange(token, now) {
    const spec = token && typeof token === "object" && token.type
      ? token
      : parseRangeToken(token);
    const hours = Number(spec.hours) || 6;
    const t = Number(now);
    return [t - hours * 3600, t];
  }

  function hoursFromSpec(spec) {
    if (spec && typeof spec === "object" && spec.hours) return Number(spec.hours) || 6;
    return parseRangeToken(spec).hours || 6;
  }

  function trafficLaneOf(model) {
    const s = String(model || "").toLowerCase();
    if (s.indexOf("nvidia") !== -1) return "nvidia";
    if (s.indexOf("glm") !== -1) return "glm";
    if (s.indexOf("qwen") !== -1) return "qwen";
    if (s) return "local";
    return "other";
  }

  function laneStyle(id) {
    return LANE_STYLE[id] || LANE_STYLE.other;
  }

  function inWindow(r, opts) {
    const o = opts || {};
    const ts = Number(r && r.ts) || 0;
    if (o.from && ts < o.from) return false;
    if (o.to && ts > o.to) return false;
    if (o.host && r.host !== o.host) return false;
    return true;
  }

  function trafficLanes(records, opts) {
    const recs = (records || []).filter(function (r) {
      return r && r.kind === "api" && inWindow(r, opts);
    });
    const byLane = {};
    recs.forEach(function (r) {
      const id = trafficLaneOf(r.model);
      const out = Number(r.output_tokens) || 0;
      let tps = Number(r.tps) || 0;
      if (!tps) {
        const dur = Number(r.duration_s);
        tps = dur > 0 && out > 0 ? out / dur : 0;
      }
      const m = byLane[id] || {
        id: id,
        requests: 0,
        tokens: 0,
        tpsSum: 0,
        tpsN: 0,
        errors: 0,
        costSum: 0,
        costN: 0,
      };
      m.requests += 1;
      m.tokens += out;
      if (tps) {
        m.tpsSum += tps;
        m.tpsN += 1;
      }
      if (r.error) m.errors += 1;
      if (typeof r.cost_usd === "number" && isFinite(r.cost_usd)) {
        m.costSum += r.cost_usd;
        m.costN += 1;
      }
      byLane[id] = m;
    });
    const lanes = Object.keys(byLane).map(function (id) {
      const m = byLane[id];
      const style = laneStyle(id);
      return {
        id: id,
        requests: m.requests,
        tokens: m.tokens,
        errors: m.errors,
        share: recs.length ? m.requests / recs.length : 0,
        avgTps: m.tpsN ? m.tpsSum / m.tpsN : null,
        color: style.color,
        fallback: style.fallback,
      };
    });
    lanes.sort(function (a, b) { return b.requests - a.requests; });
    return lanes;
  }

  function fmtTok(n) {
    const v = Number(n) || 0;
    if (v >= 1000000) return (v / 1000000).toFixed(1) + "M";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    return String(Math.round(v));
  }

  function fmtTps(v) {
    const n = Number(v);
    if (!isFinite(n)) return "—";
    return n.toFixed(1);
  }

  function fmtPct(share) {
    const n = Number(share);
    if (!isFinite(n) || n <= 0) return "0%";
    const pct = n * 100;
    if (pct < 1) return pct.toFixed(1) + "%";
    return Math.round(pct) + "%";
  }

  function fmtCost(v) {
    if (v == null || !isFinite(v)) return "—";
    if (v === 0) return "$0";
    if (v < 0.0001) return "$" + v.toFixed(6);
    return "$" + v.toFixed(4);
  }

  function fmtDuration(s) {
    const v = Number(s);
    if (!isFinite(v)) return "—";
    if (v < 10) return v.toFixed(1) + "s";
    if (v < 60) return Math.round(v) + "s";
    const m = Math.floor(v / 60);
    const rem = Math.round(v % 60);
    return m + "m " + rem + "s";
  }

  function trafficLaneTip(lane) {
    const l = lane || {};
    let meta = (Number(l.requests) || 0) + " req · " + fmtTok(l.tokens) + " out";
    if (l.avgTps != null) meta += " · " + fmtTps(l.avgTps) + " tok/s";
    if (l.errors) meta += " · " + l.errors + " err";
    if (l.fallback) meta += " · escalation";
    return {
      title: (l.id || "lane") + " · " + fmtPct(l.share),
      meta: meta,
    };
  }

  function ribbonPath(x0, y0, h0, x1, y1, h1) {
    const c = (x1 - x0) * 0.42;
    return "M" + x0 + "," + y0 +
      " C " + (x0 + c) + "," + y0 + " " + (x1 - c) + "," + y1 + " " + x1 + "," + y1 +
      " L" + x1 + "," + (y1 + h1) +
      " C " + (x1 - c) + "," + (y1 + h1) + " " + (x0 + c) + "," + (y0 + h0) + " " + x0 + "," + (y0 + h0) +
      " Z";
  }

  function sankeyLayout(lanes, opts) {
    const o = opts || {};
    const W = o.width || 520;
    const H = o.height || 180;
    const x0 = o.x0 == null ? 90 : o.x0;
    const x1 = o.x1 == null ? 340 : o.x1;
    const padT = o.padT == null ? 16 : o.padT;
    const padB = o.padB == null ? 10 : o.padB;
    const gap = o.gap == null ? 6 : o.gap;
    const minH = o.minH == null ? 10 : o.minH;
    const list = (lanes || []).slice();
    const n = list.length;
    if (!n) {
      return { width: W, height: H, x0: x0, x1: x1, leftY: padT, leftH: 0, nodes: [] };
    }
    const usable = Math.max(minH, H - padT - padB - Math.max(0, n - 1) * gap);
    const total = list.reduce(function (s, l) { return s + (Number(l.requests) || 0); }, 0) || 1;
    let heights = list.map(function (l) {
      return Math.max(minH, (Number(l.requests) || 0) / total * usable);
    });
    let sumH = heights.reduce(function (a, b) { return a + b; }, 0);
    if (sumH > usable) {
      const scale = usable / sumH;
      heights = heights.map(function (h) { return h * scale; });
      sumH = usable;
    }
    let y = padT;
    const stemH = Math.min(52, Math.max(28, usable * 0.38));
    let leftHeights = list.map(function (l) {
      return Math.max(4, (Number(l.requests) || 0) / total * stemH);
    });
    let leftSum = leftHeights.reduce(function (a, b) { return a + b; }, 0);
    if (leftSum > stemH) {
      const scale = stemH / leftSum;
      leftHeights = leftHeights.map(function (h) { return h * scale; });
      leftSum = stemH;
    }
    let leftY = padT + Math.max(0, (usable - leftSum) / 2);
    const stemTop = leftY;
    const nodes = list.map(function (lane, i) {
      const h = heights[i];
      const lh = leftHeights[i];
      const node = {
        id: lane.id,
        label: lane.id + "  " + fmtPct(lane.share),
        color: lane.color || laneStyle(lane.id).color,
        fallback: !!lane.fallback,
        y: y,
        h: h,
        leftY: leftY,
        leftH: lh,
        d: ribbonPath(x0, leftY, lh, x1, y, h),
        i: i,
      };
      y += h + gap;
      leftY += lh;
      return node;
    });
    return {
      width: W,
      height: H,
      x0: x0,
      x1: x1,
      leftY: stemTop,
      leftH: leftSum,
      nodes: nodes,
    };
  }

  function blendedCost(records, opts) {
    const bySess = {};
    let n = 0;
    (records || []).forEach(function (r) {
      if (!r || r.kind !== "api") return;
      if (!inWindow(r, opts)) return;
      n += 1;
      if (typeof r.cost_usd !== "number" || !isFinite(r.cost_usd)) return;
      const sid = r.session_id || ("anon:" + n);
      const prev = bySess[sid];
      bySess[sid] = prev == null ? r.cost_usd : Math.max(prev, r.cost_usd);
    });
    const keys = Object.keys(bySess);
    if (!n || !keys.length) return null;
    let total = 0;
    keys.forEach(function (k) { total += bySess[k]; });
    return total / n;
  }

  function routerKpis(lanes, records, opts) {
    const list = lanes || [];
    const requests = list.reduce(function (s, l) { return s + (Number(l.requests) || 0); }, 0);
    const top = list[0] || null;
    const nv = list.filter(function (l) { return l.id === "nvidia"; })[0] || null;
    return {
      requests: requests,
      topId: top ? top.id : "",
      topShare: top ? top.share : 0,
      nvidiaShare: nv ? nv.share : 0,
      blended: blendedCost(records, opts),
      lanes: list.length,
    };
  }

  function routerInsight(lanes) {
    const list = lanes || [];
    if (!list.length) return "No api records in this window";
    const nv = list.filter(function (l) { return l.id === "nvidia"; })[0];
    if (nv && nv.share >= 0.1) {
      return "nvidia is taking " + fmtPct(nv.share) + " — local/glm-first is not holding";
    }
    const top = list[0];
    return top.id + " is holding the window at " + fmtPct(top.share);
  }

  function shortModelName(m) {
    let s = String(m || "");
    const slash = s.lastIndexOf("/");
    if (slash >= 0) s = s.slice(slash + 1);
    return s
      .replace("qwen3.6-35b-a3b-", "q35-")
      .replace("-uncensored", "")
      .replace("-mlx-v2", "")
      .replace("-genesis-hermes-v5", "") || "—";
  }

  function describeResolution(val) {
    if (val == null) return "—";
    if (typeof val === "string") return val;
    if (typeof val === "object") {
      const v = val.model || val.live_model || val.resolved || val.current;
      if (v != null) return String(v);
      if ("resolved" in val || "model" in val || "live_model" in val || "current" in val) return "—";
      return JSON.stringify(val);
    }
    return String(val);
  }

  function roleRows(usage) {
    const src = (usage && usage.roles) || {};
    const rows = Object.keys(src).map(function (name) {
      const a = src[name] || {};
      const models = Object.keys(a.models || {}).map(function (m) {
        return { model: m, n: Number(a.models[m]) || 0 };
      }).sort(function (x, y) { return y.n - x.n; });
      const top = models[0] || null;
      return {
        role: name,
        requests: Number(a.requests) || 0,
        errors: Number(a.errors) || 0,
        fallthroughs: Number(a.fallthroughs) || 0,
        retries: Number(a.retries) || 0,
        p50_s: a.p50_s,
        p95_s: a.p95_s,
        tokens_in: Number(a.tokens_in) || 0,
        tokens_out: Number(a.tokens_out) || 0,
        topModel: top ? top.model : "",
        topN: top ? top.n : 0,
        models: models,
        lane: trafficLaneOf(top ? top.model : ""),
      };
    }).sort(function (a, b) { return b.requests - a.requests; });
    const total = rows.reduce(function (s, r) { return s + r.requests; }, 0) || 1;
    rows.forEach(function (r) { r.share = r.requests / total; });
    return rows;
  }

  function roleTip(row) {
    const r = row || {};
    let meta = (Number(r.requests) || 0) + " req";
    if (r.errors) meta += " · " + r.errors + " err";
    if (r.fallthroughs) meta += " · " + r.fallthroughs + " fallthrough";
    if (r.p50_s != null) meta += " · p50 " + fmtDuration(r.p50_s);
    if (r.topModel) meta += " · " + shortModelName(r.topModel);
    return { title: r.role || "role", meta: meta };
  }

  function isolateRoles(rows, pin) {
    if (!pin) return rows || [];
    return (rows || []).filter(function (r) { return r.lane === pin; });
  }

  function roleBarLayout(rows, opts) {
    const o = opts || {};
    const W = o.width || 680;
    const rowH = o.rowH || 36;
    const gap = o.gap == null ? 8 : o.gap;
    const labelW = o.labelW || 128;
    const rightW = o.rightW || 72;
    const list = rows || [];
    const maxReq = list.reduce(function (m, r) { return Math.max(m, Number(r.requests) || 0); }, 1);
    const chartW = Math.max(40, W - labelW - rightW);
    return list.map(function (r, i) {
      const barW = Math.max(6, (Number(r.requests) || 0) / maxReq * chartW);
      return {
        i: i,
        y: i * (rowH + gap),
        h: rowH,
        labelW: labelW,
        barX: labelW,
        barW: barW,
        rightX: W - rightW + 8,
        color: (LANE_STYLE[r.lane] || LANE_STYLE.other).color,
      };
    });
  }

  function statusRoles(status) {
    if (!status || typeof status !== "object") return [];
    const src = status.roles || status.resolutions || status.role_map || null;
    if (!src || typeof src !== "object" || Array.isArray(src)) return [];
    return Object.keys(src).sort().map(function (role) {
      const val = src[role];
      const model = describeResolution(val);
      const strict = !!(val && typeof val === "object" && val.strict);
      return {
        role: role,
        model: model,
        resolved: model !== "—",
        strict: strict,
        lane: trafficLaneOf(model === "—" ? "" : model),
      };
    });
  }

  function mockRecords(now) {
    const t = Number(now) || Date.now() / 1000;
    const rows = [];
    const local = "mlx-community/Llama-3.2-3B";
    const glm = "z-ai/glm-5.3";
    const qwen = "qwen/qwen3.8-27b";
    const nv = "nvidia/nvidia-nemotron-nano-9b-v2";
    function push(n, model, host, tps, out, cost, err) {
      for (let i = 0; i < n; i++) {
        rows.push({
          ts: t - 200 - i * 90,
          kind: "api",
          model: model,
          host: host,
          output_tokens: out + i,
          tps: tps,
          duration_s: 4 + (i % 3),
          cost_usd: cost,
          session_id: "sess-" + model.slice(-4) + "-" + Math.floor(i / 4),
          error: err || undefined,
        });
      }
    }
    push(18, local, "mini", 42, 80, 0, "");
    push(12, glm, "cloud", 28, 120, 0.004, "");
    push(8, qwen, "mini", 22, 90, 0, "");
    push(3, nv, "cloud", 18, 40, 0.012, "");
    rows.push({
      ts: t - 80,
      kind: "api",
      model: nv,
      host: "cloud",
      output_tokens: 12,
      tps: 9,
      duration_s: 6,
      cost_usd: 0.012,
      session_id: "sess-esc",
      error: "rate limit",
    });
    rows.push({
      ts: t - 40,
      kind: "error",
      model: glm,
      host: "cloud",
      error: "upstream 503",
    });
    return rows;
  }

  function mockUsage() {
    return {
      since_h: 6,
      roles: {
        main: {
          requests: 22, errors: 0, fallthroughs: 1, retries: 0,
          tokens_in: 48000, tokens_out: 9100, p50_s: 2.4, p95_s: 6.1,
          models: { "qwen/qwen3.8-27b": 14, "mlx-community/Qwen3.5-4B": 8 },
        },
        router: {
          requests: 11, errors: 1, fallthroughs: 2, retries: 1,
          tokens_in: 12000, tokens_out: 2400, p50_s: 1.1, p95_s: 3.4,
          models: { "z-ai/glm-5.3": 9, "nvidia/nvidia-nemotron-nano-9b-v2": 2 },
        },
        coder: {
          requests: 6, errors: 0, fallthroughs: 0, retries: 0,
          tokens_in: 8000, tokens_out: 3100, p50_s: 3.2, p95_s: 7.8,
          models: { "z-ai/glm-5.3": 6 },
        },
      },
      degradations: [
        { ts: "2026-09-16T05:12:01", role: "router", status: 503, reason: "fallthrough", model: "nvidia/nvidia-nemotron-nano-9b-v2" },
      ],
    };
  }

  function mockStatus() {
    return {
      roles: {
        main: { resolved: "qwen/qwen3.8-27b", strict: false },
        router: { resolved: "z-ai/glm-5.3", strict: false },
        coder: { resolved: "z-ai/glm-5.3", strict: true },
        voice: { resolved: null, strict: true },
      },
      loaded: { "qwen/qwen3.8-27b": true, "z-ai/glm-5.3": true },
      last_poll_age_s: 4,
      poll_interval_s: 15,
    };
  }

  return {
    LANE_STYLE: LANE_STYLE,
    parseRangeToken: parseRangeToken,
    parseHostToken: parseHostToken,
    windowForRange: windowForRange,
    hoursFromSpec: hoursFromSpec,
    trafficLaneOf: trafficLaneOf,
    trafficLanes: trafficLanes,
    trafficLaneTip: trafficLaneTip,
    sankeyLayout: sankeyLayout,
    ribbonPath: ribbonPath,
    blendedCost: blendedCost,
    routerKpis: routerKpis,
    routerInsight: routerInsight,
    shortModelName: shortModelName,
    describeResolution: describeResolution,
    roleRows: roleRows,
    roleTip: roleTip,
    isolateRoles: isolateRoles,
    roleBarLayout: roleBarLayout,
    statusRoles: statusRoles,
    mockRecords: mockRecords,
    mockUsage: mockUsage,
    mockStatus: mockStatus,
    fmtTok: fmtTok,
    fmtTps: fmtTps,
    fmtPct: fmtPct,
    fmtCost: fmtCost,
    fmtDuration: fmtDuration,
    pad2: pad2,
  };
});
