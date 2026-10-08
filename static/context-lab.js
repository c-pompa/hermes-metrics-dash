/**
 * context-v1 lab helpers — per-conversation input_tokens as step lines.
 * UMD: browser as window.ContextLab, node via module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ContextLab = api;
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

  function sessionLabel(r) {
    const title = r && r.session_title;
    if (title && String(title).trim()) return String(title).trim().slice(0, 22);
    const id = (r && (r.session_id || r.parent_session_id)) || "";
    if (id) return String(id).slice(-12);
    return "session";
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

  function stepPath(points, x, y) {
    if (!points || !points.length) return "";
    let d = "M" + x(points[0].ts) + "," + y(points[0].tokens);
    for (let i = 1; i < points.length; i++) {
      d += " H" + x(points[i].ts) + " V" + y(points[i].tokens);
    }
    return d;
  }

  function isCompaction(prev, cur) {
    if (!prev || !cur) return false;
    return cur.tokens < prev.tokens * 0.85 && prev.tokens - cur.tokens >= 4000;
  }

  function groupConversations(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const host = o.host || "";
    const limit = Number(o.limit) || 6;
    const by = new Map();
    (records || []).forEach(function (r) {
      const ts = Number(r && r.ts) || 0;
      if (from && ts < from) return;
      if (to && ts > to) return;
      if (host && r.host !== host) return;
      const kind = r.kind;
      const root = r.parent_session_id || r.session_id || "session";
      if (!by.has(root)) {
        by.set(root, { id: root, label: sessionLabel(r), model: r.model || "", points: [], errors: [] });
      }
      const g = by.get(root);
      if (kind === "error") {
        g.errors.push({ ts: ts, error: r.error || "request failed" });
        return;
      }
      if (kind !== "api" && kind !== "moa_turn") return;
      if (!(Number(r.input_tokens) > 0)) return;
      g.model = r.model || g.model;
      if (!g.label || g.label === "session") g.label = sessionLabel(r);
      g.points.push({ ts: ts, tokens: Number(r.input_tokens), model: r.model || g.model });
    });
    const groups = [];
    by.forEach(function (g) {
      g.points.sort(function (a, b) { return a.ts - b.ts; });
      g.compactions = [];
      for (let i = 1; i < g.points.length; i++) {
        if (isCompaction(g.points[i - 1], g.points[i])) {
          g.compactions.push({
            ts: g.points[i].ts,
            from: g.points[i - 1].tokens,
            to: g.points[i].tokens,
          });
        }
      }
      g.last = g.points.length ? g.points[g.points.length - 1] : null;
      g.newest = g.last ? g.last.ts : 0;
      if (g.points.length) groups.push(g);
    });
    groups.sort(function (a, b) { return b.newest - a.newest; });
    return groups.slice(0, limit).map(function (g, i) {
      g.color = COLORS[i % COLORS.length];
      return g;
    });
  }

  function pointTip(session, point) {
    const s = session || {};
    const p = point || {};
    const compact = (s.compactions || []).some(function (c) { return c.ts === p.ts; });
    const extra = compact ? "compaction" : "ok";
    return {
      title: (s.label || "session") + " · " + (p.model || s.model || "model").replace(/-uncensored.*$/, ""),
      meta: fmtTok(p.tokens) + " in · " + fmtTime(p.ts) + " · " + extra,
    };
  }

  function gaugeForSession(session) {
    if (!session || !session.last) {
      return { pct: null, used: 0, cap: null, title: "no session", meta: "pick a conversation" };
    }
    const used = session.last.tokens;
    const cap = capForModel(session.last.model || session.model);
    const pct = cap ? Math.round((used / cap) * 100) : null;
    return {
      pct: pct,
      used: used,
      cap: cap,
      title: session.label,
      meta: cap
        ? fmtTok(used) + " / " + fmtTok(cap) + " loaded ctx"
        : fmtTok(used) + " in · no loaded-ctx cap",
    };
  }

  function mockRecords(now) {
    const t = Number(now) || Date.now() / 1000;
    const qwen = "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5";
    const gemma = "supergemma4-26b-uncensored-mlx-v2";
    return [
      { ts: t - 7200, kind: "api", session_id: "sess_fat", session_title: "dialectic", model: qwen, host: "mini", input_tokens: 18000 },
      { ts: t - 6100, kind: "api", session_id: "sess_fat", session_title: "dialectic", model: qwen, host: "mini", input_tokens: 31000 },
      { ts: t - 4800, kind: "api", session_id: "sess_fat", session_title: "dialectic", model: qwen, host: "mini", input_tokens: 54000 },
      { ts: t - 3600, kind: "api", session_id: "sess_fat", session_title: "dialectic", model: qwen, host: "mini", input_tokens: 82000 },
      { ts: t - 2400, kind: "api", session_id: "sess_fat", session_title: "dialectic", model: qwen, host: "mini", input_tokens: 21000 },
      { ts: t - 1800, kind: "api", session_id: "sess_fat", session_title: "dialectic", model: qwen, host: "mini", input_tokens: 39000 },
      { ts: t - 900, kind: "error", session_id: "sess_fat", session_title: "dialectic", model: qwen, host: "mini", input_tokens: 0, error: "timeout" },
      { ts: t - 5000, kind: "api", session_id: "sess_router", session_title: "router-debug", model: gemma, host: "mbp", input_tokens: 4200 },
      { ts: t - 3200, kind: "api", session_id: "sess_router", session_title: "router-debug", model: gemma, host: "mbp", input_tokens: 9100 },
      { ts: t - 1100, kind: "api", session_id: "sess_router", session_title: "router-debug", model: gemma, host: "mbp", input_tokens: 14800 },
      { ts: t - 1400, kind: "api", session_id: "sess_thin", session_title: "", model: gemma, host: "mbp", input_tokens: 80 },
      { ts: t - 400, kind: "api", session_id: "sess_thin", session_title: "", model: gemma, host: "mbp", input_tokens: 210 },
    ];
  }

  function parseRangeToken(raw) {
    let s = String(raw || "6h").trim();
    const hash = s.match(/range=([^&]+)/);
    if (hash) s = decodeURIComponent(hash[1]);
    if (s.charAt(0) === "#") s = s.slice(1);
    if (s.charAt(0) === "/") s = s.slice(1);
    if (s === "today") return { type: "day", offset: 0 };
    if (s === "yesterday") return { type: "day", offset: 1 };
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
    const t = Number(now);
    if (spec.type === "day") {
      const d = new Date(t * 1000);
      d.setHours(0, 0, 0, 0);
      const start = d.getTime() / 1000 - (spec.offset || 0) * 86400;
      const end = spec.offset === 0 ? t : start + 86400;
      return [start, end];
    }
    const hours = Number(spec.hours) || 6;
    return [t - hours * 3600, t];
  }

  return {
    COLORS: COLORS,
    MODEL_POOL_CAPS: MODEL_POOL_CAPS,
    fmtTok: fmtTok,
    fmtTime: fmtTime,
    sessionLabel: sessionLabel,
    capForModel: capForModel,
    stepPath: stepPath,
    isCompaction: isCompaction,
    groupConversations: groupConversations,
    pointTip: pointTip,
    gaugeForSession: gaugeForSession,
    mockRecords: mockRecords,
    parseRangeToken: parseRangeToken,
    parseHostToken: parseHostToken,
    windowForRange: windowForRange,
  };
});
