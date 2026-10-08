/**
 * metrics-dashboard — Hermes web dashboard tab bundle (v0.6.0).
 *
 * Live LLM metrics in the official Hermes dashboard: a stat header (server
 * reachability, rolling avg output tok/s, requests + output tokens in the
 * last hour) over four sub-tabs — Overview (per-model breakdown), Findings,
 * Usage map, and Routing (model-router interop). Data comes from this
 * plugin's own backend namespace (/api/plugins/metrics-dashboard/) via
 * SDK.fetchJSON; the standalone app.py dashboard stays linked at the bottom.
 *
 * Plain IIFE classic script, no build step, no JSX (``h`` alias for
 * React.createElement). Pure helpers are exported for node --test via
 * window.__METRICS_PAGE_HELPERS__ (and module.exports under node).
 */
(function () {
  "use strict";

  const API = "/api/plugins/metrics-dashboard";
  const POLL_MS = 10000;

  // -------------------------------------------------------------------------
  // Pure helpers (no SDK/window dependencies — unit-tested under node).
  // The tok/s and per-model math mirror desktop-plugin/plugin.js exactly so
  // the chip, pane, and this tab always agree.
  // -------------------------------------------------------------------------

  // Tolerate both `{ records: [...] }` and bare `[...]` shapes.
  function recordsOf(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      if (Array.isArray(data.records)) return data.records;
      if (Array.isArray(data.items)) return data.items;
    }
    return [];
  }

  function outputTokensOf(r) {
    const v = r.output_tokens != null ? r.output_tokens
      : r.completion_tokens != null ? r.completion_tokens : r.tokens_out;
    return typeof v === "number" ? v : 0;
  }

  // tps can be null on LM Studio 0.4.x builds — fall back to out/duration.
  function tpsOf(r, out) {
    if (typeof r.tps === "number" && r.tps > 0) return r.tps;
    if (typeof r.tokens_per_sec === "number" && r.tokens_per_sec > 0) return r.tokens_per_sec;
    return r.duration_s > 0 && out > 0 ? out / r.duration_s : null;
  }

  function summarize(data) {
    const records = recordsOf(data).filter(function (r) {
      return r && (r.kind === "api" || r.kind === "router_request");
    });
    let tokens = 0;
    let tpsSum = 0;
    let tpsN = 0;
    const byModel = new Map();

    for (const r of records) {
      const out = outputTokensOf(r);
      tokens += out;
      const tps = tpsOf(r, out);
      if (tps) {
        tpsSum += tps;
        tpsN += 1;
      }

      const model = r.model || "unknown";
      const m = byModel.get(model) || { model: model, requests: 0, tokens: 0, tpsSum: 0, tpsN: 0 };
      m.requests += 1;
      m.tokens += out;
      if (tps) {
        m.tpsSum += tps;
        m.tpsN += 1;
      }
      byModel.set(model, m);
    }

    return {
      requests: records.length,
      tokens: tokens,
      avgTps: tpsN ? tpsSum / tpsN : null,
      models: Array.from(byModel.values()).sort(function (a, b) { return b.tokens - a.tokens; }),
    };
  }

  function modelAvgTps(m) {
    return m.tpsN ? m.tpsSum / m.tpsN : null;
  }

  function fmt(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function fmtTps(v) {
    return typeof v === "number" && isFinite(v) ? v.toFixed(1) : "—";
  }

  // Health section -> human label for the active metrics source.
  function sourceLabel(health) {
    if (!health || typeof health !== "object") return null;
    if (health.source === "local-file" || health.mode === "local-file") {
      return "local file " + (health.path || "");
    }
    return health.base_url || null;
  }

  // /api/findings payload: {days, since, total, rules: [...]}.
  function findingsRules(data) {
    return data && Array.isArray(data.rules) ? data.rules : [];
  }

  function findingsRuleType(id) {
    if (id === "R12" || id === "R13") return "log";
    if (id === "R11") return "beta";
    return "metric";
  }

  function fmtDeltaPts(d) {
    if (d == null || !isFinite(d) || Math.abs(d) < 0.05) return "—";
    return (d > 0 ? "+" : "\u2212") + Math.abs(d).toFixed(1);
  }

  function findingsCleanShare(data) {
    const rules = findingsRules(data);
    const days = Number(data && data.days) || 0;
    if (!rules.length || !days) return { pct: null, spark: [], deltaPts: null };
    let passSum = 0;
    for (let i = 0; i < rules.length; i++) {
      passSum += 1 - Math.min(1, (Number(rules[i].days_fired) || 0) / days);
    }
    const spark = [];
    for (let d = 0; d < days; d++) {
      let fired = 0;
      for (let i = 0; i < rules.length; i++) {
        if (((rules[i].daily || [])[d] || 0) > 0) fired += 1;
      }
      spark.push(1 - fired / rules.length);
    }
    const last = spark[spark.length - 1];
    const prev = spark.length > 1 ? spark[spark.length - 2] : last;
    return { pct: passSum / rules.length, spark: spark, deltaPts: last - prev };
  }

  function findingsRuleRows(data) {
    const rules = findingsRules(data);
    const days = Number(data && data.days) || 0;
    return rules.map(function (rule) {
      const daily = Array.isArray(rule.daily) ? rule.daily : [];
      const last = daily.length ? (daily[daily.length - 1] || 0) : 0;
      const prev = daily.length > 1 ? (daily[daily.length - 2] || 0) : last;
      const pass = days ? 1 - Math.min(1, (Number(rule.days_fired) || 0) / days) : 1;
      return {
        rule: rule.rule,
        name: rule.label || rule.rule,
        type: findingsRuleType(rule.rule),
        pass: pass,
        worst_sev: rule.worst_sev || "ok",
        count: rule.count || 0,
        days_fired: rule.days_fired || 0,
        deltaFires: last - prev,
        example_text: rule.example_text || "",
        example_action: rule.example_action || "",
        last_ts: rule.last_ts || null,
        daily: daily,
      };
    });
  }

  function findingsFiring(data) {
    return findingsRuleRows(data).filter(function (r) {
      return r.worst_sev === "crit" || r.worst_sev === "warn";
    });
  }

  function findingsSparkTip(i, spark) {
    const series = spark || [];
    const v = Number(series[i] || 0);
    return {
      title: (i + 1) + " / " + series.length,
      meta: (v * 100).toFixed(1) + "% clean",
    };
  }

  function modelKey(model) {
    const s = String(model || "").toLowerCase();
    const parts = s.split("/");
    return parts[parts.length - 1] || s;
  }

  // Exact trailing-id match: glm-5.3 must not swallow glm-5.3-flash.
  function modelMatches(model, spec) {
    if (model == null || spec == null || spec === "") return false;
    const m = String(model).toLowerCase();
    const s = String(spec).toLowerCase();
    if (m === s) return true;
    return modelKey(m) === modelKey(s);
  }

  function comparePresets() {
    return [
      {
        id: "qwen38",
        label: "Qwen3.8 · router vs main",
        left: { spec: "qwen/qwen3.8-27b", label: "router" },
        right: { spec: "qwen3.8-27b-hermes", label: "main" },
      },
      {
        id: "glm53",
        label: "GLM 5.3 · full vs lite",
        left: { spec: "z-ai/glm-5.3", label: "5.3" },
        right: { spec: "z-ai/glm-5.3-flash", label: "lite" },
      },
    ];
  }

  function shortModelLabel(spec) {
    if (!spec) return "—";
    return String(spec).split("/").pop();
  }

  function resolveComparePair(presets, pairId, customLeft, customRight) {
    const list = Array.isArray(presets) ? presets : [];
    if (pairId === "custom") {
      return {
        id: "custom",
        label: "Custom",
        left: { spec: customLeft || "", label: shortModelLabel(customLeft) },
        right: { spec: customRight || "", label: shortModelLabel(customRight) },
      };
    }
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === pairId) return list[i];
    }
    return list[0] || {
      id: "custom",
      label: "Custom",
      left: { spec: customLeft || "", label: shortModelLabel(customLeft) },
      right: { spec: customRight || "", label: shortModelLabel(customRight) },
    };
  }

  function laneStats(recs, spec) {
    const xs = recs.filter(function (r) { return modelMatches(r.model, spec); });
    let tpsSum = 0;
    let tpsN = 0;
    let err = 0;
    let cost = 0;
    let tok = 0;
    for (let i = 0; i < xs.length; i++) {
      const r = xs[i];
      if (r.kind === "error" || r.error) err += 1;
      const out = outputTokensOf(r);
      tok += out;
      const tps = tpsOf(r, out);
      if (tps) {
        tpsSum += tps;
        tpsN += 1;
      }
      if (typeof r.cost_usd === "number") cost += r.cost_usd;
    }
    return {
      requests: xs.length,
      avgTps: tpsN ? tpsSum / tpsN : null,
      errorRate: xs.length ? err / xs.length : null,
      costPer1k: tok > 0 ? (cost / tok) * 1000 : null,
    };
  }

  function comparePair(data, leftSpec, rightSpec) {
    const recs = recordsOf(data).filter(function (r) {
      return r && (r.kind === "api" || r.kind === "error" || r.kind === "router_request");
    });
    const left = laneStats(recs, leftSpec);
    const right = laneStats(recs, rightSpec);
    const total = recs.length;
    return {
      available: left.requests + right.requests > 0,
      leftShare: total ? left.requests / total : 0,
      rightShare: total ? right.requests / total : 0,
      left: left,
      right: right,
    };
  }

  function modelOptions(data) {
    const seen = {};
    const out = [];
    const recs = recordsOf(data);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!r || (r.kind !== "api" && r.kind !== "error" && r.kind !== "router_request")) continue;
      const m = r.model;
      if (!m || seen[m]) continue;
      seen[m] = true;
      out.push(m);
    }
    out.sort();
    return out;
  }

  function compareModelChoices(data, presets) {
    const seen = {};
    const live = modelOptions(data);
    for (let i = 0; i < live.length; i++) seen[live[i]] = true;
    const list = Array.isArray(presets) ? presets : [];
    for (let i = 0; i < list.length; i++) {
      if (list[i].left && list[i].left.spec) seen[list[i].left.spec] = true;
      if (list[i].right && list[i].right.spec) seen[list[i].right.spec] = true;
    }
    return Object.keys(seen).sort();
  }

  // /api/usage-map payload: flat {model: usage} dict — normalize to sorted rows.
  function usageMapEntries(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    return Object.keys(data)
      .filter(function (k) { return k !== "available" && k !== "error"; })
      .sort()
      .map(function (k) { return { model: k, usage: String(data[k]) }; });
  }

  // --- router-view payload (defensive-parsed; the sibling plugin's exact
  // shapes are its own contract) --------------------------------------------

  function roleEntries(status) {
    if (!status || typeof status !== "object") return [];
    const src = status.roles || status.resolutions || status.role_map || null;
    if (!src || typeof src !== "object" || Array.isArray(src)) return [];
    return Object.keys(src).map(function (role) {
      return { role: role, model: describeResolution(src[role]) };
    });
  }

  function describeResolution(val) {
    if (val == null) return "—";
    if (typeof val === "string") return val;
    if (typeof val === "object") {
      const v = val.model || val.live_model || val.resolved || val.current;
      if (v != null) return String(v);
      // Known resolution keys present but empty (e.g. strict role with no
      // live candidate) — render a dash, not raw JSON.
      if ("resolved" in val || "model" in val || "live_model" in val || "current" in val) return "—";
      return JSON.stringify(val);
    }
    return String(val);
  }

  function noteText(n) {
    if (typeof n === "string") return n;
    if (n && typeof n === "object") {
      const v = n.text || n.note || n.message;
      return v != null ? String(v) : JSON.stringify(n);
    }
    return String(n);
  }

  function notesOf(data) {
    const list = Array.isArray(data) ? data
      : (data && Array.isArray(data.notes) ? data.notes : []);
    return list.map(noteText);
  }

  function tsSeconds(r) {
    const v = r && r.ts;
    if (typeof v === "number" && isFinite(v)) return v > 1e12 ? v / 1000 : v;
    if (typeof v === "string" && v) {
      const n = Date.parse(v);
      return isFinite(n) ? n / 1000 : null;
    }
    return null;
  }

  function ingestTraffic(r) {
    return r && (r.kind === "api" || r.kind === "error" || r.kind === "moa_turn"
      || r.kind === "router_request");
  }

  const INGEST_BUCKETS = 12;
  const INGEST_BUCKET_S = 300;

  function ingestHour(data, now) {
    const recs = recordsOf(data);
    const sum = summarize(data);
    const nowSec = now != null ? now : Date.now() / 1000;
    const spark = [];
    for (let i = 0; i < INGEST_BUCKETS; i++) spark.push(0);
    let newest = null;
    let errors = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!ingestTraffic(r)) continue;
      if (r.kind === "error") errors += 1;
      const t = tsSeconds(r);
      if (t != null && (newest == null || t > newest)) newest = t;
      if (t == null) continue;
      const ago = nowSec - t;
      if (ago < 0 || ago >= INGEST_BUCKETS * INGEST_BUCKET_S) continue;
      const idx = INGEST_BUCKETS - 1 - Math.floor(ago / INGEST_BUCKET_S);
      if (idx >= 0 && idx < INGEST_BUCKETS) spark[idx] += 1;
    }
    return {
      live: sum.requests > 0,
      requests: sum.requests,
      avgTps: sum.avgTps,
      tokens: sum.tokens,
      errors: errors,
      spark: spark,
      newestTs: newest,
    };
  }

  function ingestDefaultPane(hour) {
    return hour && hour.live ? "live" : "empty";
  }

  function ingestSparkTip(spark, i) {
    const series = spark || [];
    const v = Number(series[i] || 0);
    const isLast = i === series.length - 1;
    const ago = (series.length - 1 - i) * 5;
    return {
      title: isLast ? "last 5 min" : ago + "–" + (ago + 5) + " min ago",
      meta: v + " request" + (v === 1 ? "" : "s") + (isLast ? " · now" : ""),
    };
  }

  function ingestFmtClock(sec) {
    if (sec == null || !isFinite(sec)) return "—";
    const d = new Date(sec * 1000);
    if (!isFinite(d.getTime())) return "—";
    const pad = function (n) { return (n < 10 ? "0" : "") + n; };
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function ingestFeed(data, limit) {
    const n = limit == null ? 8 : limit;
    const rows = recordsOf(data).filter(ingestTraffic).map(function (r) {
      const out = outputTokensOf(r);
      return {
        ts: tsSeconds(r),
        tsLabel: ingestFmtClock(tsSeconds(r)),
        host: r.host || "—",
        model: r.model || "unknown",
        kind: r.kind === "moa_turn" ? "moa" : r.kind,
        duration_s: typeof r.duration_s === "number" ? r.duration_s : null,
        tps: tpsOf(r, out),
        error: r.kind === "error" || !!r.error,
      };
    });
    rows.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    return rows.slice(0, n);
  }

  const INGEST_HOOKS_SNIPPET = "hooks:\n"
    + "  post_api_request: ~/.hermes/hooks/metrics-emit.py\n"
    + "  api_request_error: ~/.hermes/hooks/metrics-emit.py\n"
    + "  subagent_stop: ~/.hermes/hooks/metrics-emit.py";

  function ingestChipHost(source) {
    if (!source) return "mini:8899";
    try {
      const u = new URL(source);
      return u.host;
    } catch (e) {
      return String(source);
    }
  }

  // --- Widget Lab rework: router sankey → live traffic lanes ---------------
  // Lanes are model families (local / glm / qwen / nvidia), never DSv4
  // flash/pro tiers — desktop DSv4 is retired.
  const TRAFFIC_LANE_CLASSES = {
    local: "fill-sky-500/70", glm: "fill-violet-500/70",
    qwen: "fill-emerald-500/70", nvidia: "fill-amber-400",
    other: "fill-muted-foreground/40",
  };
  const TRAFFIC_LANE_DOTS = {
    local: "bg-sky-500/70", glm: "bg-violet-500/70",
    qwen: "bg-emerald-500/70", nvidia: "bg-amber-400",
    other: "bg-muted-foreground/40",
  };

  function trafficLaneOf(model) {
    const s = String(model || "").toLowerCase();
    if (s.indexOf("nvidia") !== -1) return "nvidia";
    if (s.indexOf("glm") !== -1) return "glm";
    if (s.indexOf("qwen") !== -1) return "qwen";
    if (s) return "local";
    return "other";
  }

  function trafficLanes(data) {
    const recs = recordsOf(data).filter(function (r) {
      return r && (r.kind === "api" || r.kind === "router_request");
    });
    const byLane = new Map();
    for (const r of recs) {
      const lane = trafficLaneOf(r.model);
      const out = outputTokensOf(r);
      const tps = tpsOf(r, out);
      const m = byLane.get(lane) ||
        { id: lane, requests: 0, tokens: 0, tpsSum: 0, tpsN: 0, errors: 0 };
      m.requests += 1;
      m.tokens += out;
      if (tps) { m.tpsSum += tps; m.tpsN += 1; }
      if (r.error) m.errors += 1;
      byLane.set(lane, m);
    }
    const lanes = [];
    byLane.forEach(function (m) {
      lanes.push(Object.assign({}, m, {
        share: recs.length ? m.requests / recs.length : 0,
        avgTps: m.tpsN ? m.tpsSum / m.tpsN : null,
      }));
    });
    lanes.sort(function (a, b) { return b.requests - a.requests; });
    return lanes;
  }

  function trafficLaneTip(lane) {
    let meta = lane.requests + " req · " + fmt(lane.tokens) + " out";
    if (lane.avgTps != null) meta += " · " + fmtTps(lane.avgTps) + " tok/s";
    if (lane.errors) meta += " · " + lane.errors + " err";
    return { title: lane.id + " · " + (lane.share * 100).toFixed(1) + "%", meta: meta };
  }

  // --- Widget Lab rework: context H2H → Compare pair dots ------------------
  // Per-metric dots on a shared 0..1 scale (larger side at the right edge) so
  // the two lanes of the active Compare pair read head-to-head.
  function h2hDots(diff, leftLabel, rightLabel) {
    if (!diff || !diff.left || !diff.right) return [];
    const rows = [
      ["requests", diff.left.requests, diff.right.requests,
        function (v) { return v + " req"; }],
      ["avg tok/s", diff.left.avgTps, diff.right.avgTps,
        function (v) { return v == null ? "—" : fmtTps(v); }],
      ["error rate", diff.left.errorRate, diff.right.errorRate,
        function (v) { return v == null ? "—" : (v * 100).toFixed(1) + "%"; }],
      ["cost / 1k out", diff.left.costPer1k, diff.right.costPer1k,
        function (v) { return v == null ? "—" : "$" + v.toFixed(4); }],
    ];
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const metric = rows[i][0];
      const fmtV = rows[i][3];
      const lv = typeof rows[i][1] === "number" && isFinite(rows[i][1])
        ? rows[i][1] : null;
      const rv = typeof rows[i][2] === "number" && isFinite(rows[i][2])
        ? rows[i][2] : null;
      const max = Math.max(lv || 0, rv || 0);
      out.push({
        metric: metric,
        left: lv == null ? null : {
          value: lv, pos: max ? lv / max : 0,
          tip: { title: metric + " · " + (leftLabel || "left"), meta: fmtV(lv) },
        },
        right: rv == null ? null : {
          value: rv, pos: max ? rv / max : 0,
          tip: { title: metric + " · " + (rightLabel || "right"), meta: fmtV(rv) },
        },
      });
    }
    return out;
  }

  const HELPERS = {
    recordsOf: recordsOf, outputTokensOf: outputTokensOf, tpsOf: tpsOf,
    summarize: summarize, modelAvgTps: modelAvgTps, fmt: fmt, fmtTps: fmtTps,
    findingsRules: findingsRules, findingsCleanShare: findingsCleanShare,
    findingsRuleRows: findingsRuleRows, findingsFiring: findingsFiring,
    findingsSparkTip: findingsSparkTip, findingsRuleType: findingsRuleType,
    fmtDeltaPts: fmtDeltaPts, modelMatches: modelMatches,
    modelOptions: modelOptions, comparePresets: comparePresets,
    comparePair: comparePair, resolveComparePair: resolveComparePair,
    compareModelChoices: compareModelChoices,
    ingestHour: ingestHour, ingestFeed: ingestFeed,
    ingestSparkTip: ingestSparkTip, ingestDefaultPane: ingestDefaultPane,
    ingestChipHost: ingestChipHost,
    trafficLaneOf: trafficLaneOf, trafficLanes: trafficLanes,
    trafficLaneTip: trafficLaneTip, h2hDots: h2hDots,
    usageMapEntries: usageMapEntries,
    roleEntries: roleEntries, describeResolution: describeResolution,
    noteText: noteText, notesOf: notesOf, sourceLabel: sourceLabel,
  };
  if (typeof window !== "undefined") window.__METRICS_PAGE_HELPERS__ = HELPERS;
  if (typeof module !== "undefined" && module.exports) module.exports = HELPERS;

  if (typeof window === "undefined" || !window.__HERMES_PLUGIN_SDK__) return;

  // -------------------------------------------------------------------------
  // Page (SDK components only)
  // -------------------------------------------------------------------------

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const React = SDK.React;
  const h = React.createElement;
  const {
    Card, CardHeader, CardTitle, CardContent,
    Badge, Tabs, TabsList, TabsTrigger,
  } = SDK.components;
  const { useState, useEffect } = SDK.hooks;
  const { cn, timeAgo } = SDK.utils;

  // Poll a plugin endpoint. State: {data, error, loading}. The interval is
  // cleared on unmount; callers render tabs conditionally so inactive tabs
  // never poll.
  function useEndpoint(path, pollMs) {
    const [state, setState] = useState({ data: null, error: null, loading: true });
    useEffect(function () {
      let cancelled = false;
      function load() {
        SDK.fetchJSON(API + path).then(function (data) {
          if (!cancelled) setState({ data: data, error: null, loading: false });
        }).catch(function (err) {
          if (!cancelled) {
            setState(function (prev) {
              return { data: prev.data, error: String(err && err.message || err), loading: false };
            });
          }
        });
      }
      load();
      const id = pollMs ? setInterval(load, pollMs) : null;
      return function () {
        cancelled = true;
        if (id) clearInterval(id);
      };
    }, [path, pollMs]);
    return state;
  }

  // Shared loading / error / unavailable wrappers.
  function StateCard(props) {
    return h(Card, null,
      h(CardContent, { className: cn("p-6 text-sm", props.tone || "text-muted-foreground") },
        props.children));
  }

  function guard(state, unavailableText) {
    if (state.loading && !state.data) return h(StateCard, null, "loading…");
    if (state.error && !state.data) {
      return h(StateCard, { tone: "text-destructive" }, "request failed: " + state.error);
    }
    if (state.data && state.data.available === false) {
      return h(StateCard, null,
        unavailableText + (state.data.error ? " — " + state.data.error : ""));
    }
    return null;
  }

  function StatCard(props) {
    return h(Card, null,
      h(CardHeader, { className: "pb-2" },
        h(CardTitle, { className: "text-xs font-medium text-muted-foreground" }, props.title)),
      h(CardContent, null,
        h("div", { className: "text-lg font-semibold" }, props.value),
        props.sub && h("div", { className: "mt-1 truncate text-xs text-muted-foreground" }, props.sub)));
  }

  function StatHeader(props) {
    const summary = props.summary;
    const health = summary && summary.health;
    const recent = summary && summary.recent_1h;
    const up = Boolean(health && health.available);
    const source = up ? sourceLabel(health.data) : null;
    const stats = recent && recent.available ? summarize(recent.data) : null;

    return h("div", { className: "grid grid-cols-2 gap-3 md:grid-cols-4" },
      h(StatCard, {
        title: "Server",
        value: h(Badge, { tone: up ? "success" : "destructive" }, up ? "reachable" : "unreachable"),
        sub: source || (health && health.error) || "…",
      }),
      h(StatCard, { title: "Avg output tok/s (1h)",
        value: stats && stats.avgTps != null ? fmtTps(stats.avgTps) : "—" }),
      h(StatCard, { title: "Requests (1h)", value: stats ? String(stats.requests) : "—" }),
      h(StatCard, { title: "Output tokens (1h)", value: stats ? fmt(stats.tokens) : "—" }));
  }

  function OverviewTab(props) {
    const [pane, setPane] = useState(null);
    const [sparkTip, setSparkTip] = useState(null);
    const [copied, setCopied] = useState(false);
    const recent = props.summary && props.summary.recent_1h;
    if (recent && !recent.available) {
      return h(StateCard, null,
        "recent records unavailable" + (recent.error ? " — " + recent.error : ""));
    }
    if (!recent) return h(StateCard, null, "loading…");
    const data = recent.data;
    const hour = ingestHour(data);
    const feed = ingestFeed(data, 8);
    const stats = summarize(data);
    const active = pane || ingestDefaultPane(hour);
    const health = props.summary && props.summary.health;
    const source = health && health.available ? sourceLabel(health.data) : null;
    const panes = [
      ["empty", "Empty"],
      ["live", "Live"],
    ];

    function copySnippet() {
      const done = function () {
        setCopied(true);
        setTimeout(function () { setCopied(false); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(INGEST_HOOKS_SNIPPET).then(done).catch(done);
      } else {
        done();
      }
    }

    function ingestSpark() {
      const spark = hour.spark;
      const w = 420;
      const ht = 72;
      const n = spark.length || 1;
      const bw = w / n;
      let max = 1;
      for (let i = 0; i < spark.length; i++) {
        if (spark[i] > max) max = spark[i];
      }
      return h("svg", {
        viewBox: "0 0 " + w + " " + ht,
        className: "h-20 w-full",
        role: "img",
        "aria-label": "Requests last hour in 5 minute buckets",
      }, spark.map(function (v, i) {
        const hBar = Math.max(2, (v / max) * (ht - 8));
        const tip = ingestSparkTip(spark, i);
        return h("rect", {
          key: i,
          x: i * bw + 2,
          y: ht - hBar,
          width: Math.max(4, bw * 0.55),
          height: hBar,
          rx: 2,
          className: i === spark.length - 1 ? "fill-emerald-500" : "fill-muted-foreground/40",
          role: "img",
          tabIndex: 0,
          "aria-label": tip.title + " · " + tip.meta,
          onMouseEnter: function () { setSparkTip(tip); },
          onMouseLeave: function () { setSparkTip(null); },
          onFocus: function () { setSparkTip(tip); },
          onBlur: function () { setSparkTip(null); },
        });
      }));
    }

    function emptyPane() {
      return h("div", { className: "flex flex-col gap-3" },
        h("div", null,
          h("div", { className: "text-sm font-medium" }, "Waiting for the first request"),
          h("p", { className: "mt-1 text-xs text-muted-foreground" },
            "Wire the three shell hooks. Records land in requests.jsonl, then this tab, the desktop chip, and the full dashboard.")),
        h("pre", {
          className: "overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs",
        }, INGEST_HOOKS_SNIPPET),
        h("div", null,
          h("button", {
            type: "button",
            className: "rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground",
            onClick: copySnippet,
          }, copied ? "Copied" : "Copy snippet")));
    }

    function livePane() {
      if (!hour.live) {
        return h("div", { className: "text-sm text-muted-foreground" },
          "No api records in the last hour");
      }
      return h("div", { className: "flex flex-col gap-4" },
        h("div", { className: "grid grid-cols-3 gap-3" },
          h("div", null,
            h("div", { className: "text-lg font-semibold tabular-nums" }, String(hour.requests)),
            h("div", { className: "text-xs text-muted-foreground" }, "requests / 1h")),
          h("div", null,
            h("div", { className: "text-lg font-semibold tabular-nums" }, fmtTps(hour.avgTps)),
            h("div", { className: "text-xs text-muted-foreground" }, "avg output tok/s")),
          h("div", null,
            h("div", { className: "text-lg font-semibold tabular-nums" }, fmt(hour.tokens)),
            h("div", { className: "text-xs text-muted-foreground" }, "output tokens"))),
        h("div", { className: "rounded-md border bg-muted/20 p-2" },
          h("div", { className: "mb-1 flex justify-between text-xs text-muted-foreground" },
            h("span", null, "Requests · 5 min buckets"),
            h("span", null, sparkTip ? sparkTip.title + " · " + sparkTip.meta
              : hour.errors + " error" + (hour.errors === 1 ? "" : "s") + " in window")),
          ingestSpark()),
        h("div", { className: "flex flex-col gap-1.5" },
          feed.length === 0
            ? h("div", { className: "text-xs text-muted-foreground" }, "No recent api/error rows")
            : feed.map(function (row, i) {
              const kindClass = row.kind === "error" ? "text-destructive"
                : row.kind === "moa" ? "text-emerald-600" : "text-muted-foreground";
              const dur = row.duration_s == null ? "—" : row.duration_s.toFixed(1) + "s";
              const tps = row.error ? "fail" : fmtTps(row.tps) + " t/s";
              const label = row.tsLabel + " · " + row.kind + " · " + row.model
                + " · " + row.host + " · " + dur + " · " + tps;
              return h("div", {
                key: (row.ts || i) + ":" + row.model + ":" + i,
                className: cn(
                  "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-md border px-2 py-1.5 text-xs",
                  i % 2 === 0 ? "border-border bg-muted/40" : "border-transparent",
                  "hover:border-border hover:bg-muted"
                ),
                role: "group",
                "aria-label": label,
              },
                h("div", { className: "flex min-w-0 flex-wrap items-baseline gap-x-2" },
                  h("span", { className: "w-16 shrink-0 tabular-nums text-muted-foreground" }, row.tsLabel),
                  h("span", { className: kindClass + " w-8 shrink-0" }, row.kind),
                  h("span", { className: "min-w-0" },
                    h("span", { className: "font-medium" }, row.model),
                    " ",
                    h("span", { className: "text-muted-foreground" }, row.host))),
                h("div", { className: "ml-auto flex shrink-0 items-baseline gap-3 tabular-nums" },
                  h("span", { className: "w-12 text-right text-muted-foreground" }, dur),
                  h("span", { className: "w-14 text-right" }, tps)));
            })),
        stats.models.length > 0 && h("table", { className: "w-full text-sm" },
          h("thead", null,
            h("tr", { className: "border-b text-left text-xs text-muted-foreground" },
              h("th", { className: "py-1 pr-2 font-medium" }, "model"),
              h("th", { className: "py-1 pr-2 text-right font-medium" }, "requests"),
              h("th", { className: "py-1 pr-2 text-right font-medium" }, "output tokens"),
              h("th", { className: "py-1 text-right font-medium" }, "avg tok/s"))),
          h("tbody", null,
            stats.models.map(function (m) {
              return h("tr", { key: m.model, className: "border-b last:border-0" },
                h("td", { className: "max-w-[16rem] truncate py-1.5 pr-2 font-mono text-xs" }, m.model),
                h("td", { className: "py-1.5 pr-2 text-right" }, String(m.requests)),
                h("td", { className: "py-1.5 pr-2 text-right" }, fmt(m.tokens)),
                h("td", { className: "py-1.5 text-right" }, fmtTps(modelAvgTps(m))));
            }))));
    }

    const liveTitle = hour.live ? "Live ingest" : "No api records";
    const liveSub = hour.live
      ? "last hour · " + hour.requests + " api records"
      : "last hour · metrics-dashboard";
    const newest = hour.newestTs != null ? timeAgo(hour.newestTs) : null;

    return h(Card, null,
      h(CardHeader, { className: "flex flex-row items-center justify-between gap-2 space-y-0" },
        h("div", { className: "min-w-0" },
          h(CardTitle, { className: "text-sm" }, active === "live" ? liveTitle : "No api records"),
          h("p", { className: "mt-0.5 text-xs text-muted-foreground" },
            active === "live" ? liveSub : "last hour · metrics-dashboard")),
        h("div", { className: "flex shrink-0 items-center gap-2" },
          h(Badge, { tone: hour.live && active === "live" ? "success" : "secondary" },
            hour.live && active === "live"
              ? "live · " + ingestChipHost(source)
              : "hooks not wired"),
          h("div", { className: "flex gap-1" },
            panes.map(function (pair) {
              const on = active === pair[0];
              return h("button", {
                key: pair[0],
                type: "button",
                className: cn(
                  "rounded-md px-2 py-1 text-xs",
                  on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
                ),
                "aria-pressed": on,
                onClick: function () { setPane(pair[0]); },
              }, pair[1]);
            })))),
      h(CardContent, { className: "flex flex-col gap-3" },
        active === "empty" ? emptyPane() : livePane(),
        active === "live" && newest && h("div", { className: "text-xs text-muted-foreground" },
          "Newest " + newest)));
  }

  const COMPARE_LS = "hermesMetricsComparePair";

  function readCompareState() {
    try {
      const raw = window.localStorage.getItem(COMPARE_LS);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function FindingsTab(props) {
    const state = useEndpoint("/findings", POLL_MS);
    const stored = readCompareState();
    const [pane, setPane] = useState("summary");
    const [sparkTip, setSparkTip] = useState(null);
    const [h2hTip, setH2hTip] = useState(null);
    const [pairId, setPairId] = useState(stored && stored.id || "glm53");
    const [customLeft, setCustomLeft] = useState(stored && stored.left || "z-ai/glm-5.3");
    const [customRight, setCustomRight] = useState(stored && stored.right || "z-ai/glm-5.3-flash");
    const blocked = guard(state, "findings unavailable");
    if (blocked) return blocked;
    const rules = findingsRules(state.data);
    if (rules.length === 0) {
      return h(StateCard, null, "no health-rule findings in the window");
    }
    const clean = findingsCleanShare(state.data);
    const rows = findingsRuleRows(state.data);
    const firing = findingsFiring(state.data);
    const days = Number(state.data && state.data.days) || rows[0] && rows[0].daily.length || 7;
    const recent = props.summary && props.summary.recent_1h;
    const recentData = recent && recent.available ? recent.data : null;
    const presets = comparePresets();
    const pair = resolveComparePair(presets, pairId, customLeft, customRight);
    const diff = comparePair(recentData, pair.left.spec, pair.right.spec);
    const choices = compareModelChoices(recentData, presets);
    const panes = [
      ["summary", "Summary"],
      ["firing", "Firing (" + firing.length + ")"],
      ["diff", "Compare"],
    ];

    function persistCompare(nextId, left, right) {
      try {
        window.localStorage.setItem(COMPARE_LS, JSON.stringify({
          id: nextId, left: left, right: right,
        }));
      } catch (e) { /* quota / private mode */ }
    }

    function passBar(pass) {
      const on = Math.round(pass * 16);
      return h("div", {
        className: "flex h-2 w-28 overflow-hidden rounded-full bg-muted",
        "aria-hidden": true,
      }, Array.from({ length: 16 }, function (_, i) {
        return h("span", {
          key: i,
          className: "flex-1 " + (i < on ? "bg-emerald-500/80" : "bg-muted-foreground/20"),
        });
      }));
    }

    function cleanSpark() {
      const spark = clean.spark;
      const w = 420;
      const ht = 72;
      const n = spark.length || 1;
      const bw = w / n;
      return h("svg", {
        viewBox: "0 0 " + w + " " + ht,
        className: "h-20 w-full",
        role: "img",
        "aria-label": "Clean share last " + n + " days",
      },
        h("line", {
          x1: 0, y1: ht - 0.9 * (ht - 8), x2: w, y2: ht - 0.9 * (ht - 8),
          stroke: "currentColor", strokeDasharray: "3 3", className: "text-muted-foreground/40",
        }),
        spark.map(function (v, i) {
          const hBar = Math.max(2, v * (ht - 8));
          const tip = findingsSparkTip(i, spark);
          return h("rect", {
            key: i,
            x: i * bw + 2,
            y: ht - hBar,
            width: Math.max(4, bw * 0.55),
            height: hBar,
            rx: 2,
            className: i === spark.length - 1 ? "fill-emerald-500" : "fill-muted-foreground/40",
            role: "img",
            tabIndex: 0,
            "aria-label": tip.title + " · " + tip.meta,
            onMouseEnter: function () { setSparkTip(tip); },
            onMouseLeave: function () { setSparkTip(null); },
            onFocus: function () { setSparkTip(tip); },
            onBlur: function () { setSparkTip(null); },
          });
        }));
    }

    function summaryPane() {
      const pct = clean.pct == null ? "—" : (clean.pct * 100).toFixed(1) + "%";
      const delta = fmtDeltaPts(clean.deltaPts == null ? null : clean.deltaPts * 100);
      return h("div", { className: "flex flex-col gap-4" },
        h("div", { className: "grid gap-4 md:grid-cols-[10rem_1fr]" },
          h("div", null,
            h("div", { className: "text-xs text-muted-foreground" }, "Clean share · " + days + "d"),
            h("div", { className: "text-2xl font-semibold tracking-tight" }, pct),
            h("div", { className: "mt-1" },
              h(Badge, { tone: (clean.deltaPts || 0) >= 0 ? "success" : "destructive" },
                delta + " pt vs prior day"))),
          h("div", { className: "rounded-md border bg-muted/20 p-2" },
            h("div", { className: "mb-1 flex justify-between text-xs text-muted-foreground" },
              h("span", null, "Clean share · last " + days + " days"),
              h("span", null, sparkTip ? sparkTip.title + " · " + sparkTip.meta : "threshold 90%")),
            cleanSpark())),
        h("table", { className: "w-full text-sm" },
          h("thead", null,
            h("tr", { className: "border-b text-left text-xs text-muted-foreground" },
              h("th", { className: "py-1 pr-2 font-medium" }, "Rule"),
              h("th", { className: "py-1 pr-2 font-medium" }, "Source"),
              h("th", { className: "py-1 pr-2 font-medium" }, "Clean"),
              h("th", { className: "py-1 text-right font-medium" }, "Δ fires"))),
          h("tbody", null,
            rows.map(function (r) {
              const dClass = r.deltaFires > 0 ? "text-destructive" : r.deltaFires < 0 ? "text-emerald-600" : "text-muted-foreground";
              return h("tr", { key: r.rule, className: "border-b last:border-0" },
                h("td", { className: "py-1.5 pr-2" },
                  h("div", { className: "font-mono text-xs" }, r.rule + " · " + r.name),
                  h("div", { className: "text-xs text-muted-foreground" },
                    r.count + "× · " + r.days_fired + "d" + (r.last_ts ? " · last " + timeAgo(r.last_ts) : ""))),
                h("td", { className: "py-1.5 pr-2" },
                  h(Badge, { tone: "secondary" }, r.type)),
                h("td", { className: "py-1.5 pr-2" },
                  h("div", { className: "flex items-center gap-2" },
                    passBar(r.pass),
                    h("span", { className: "tabular-nums text-xs" }, Math.round(r.pass * 100) + "%"))),
                h("td", { className: "py-1.5 text-right tabular-nums text-xs " + dClass },
                  r.deltaFires > 0 ? "+" + r.deltaFires : String(r.deltaFires)));
            }))));
    }

    function firingPane() {
      if (!firing.length) {
        return h("div", { className: "text-sm text-muted-foreground" },
          "No crit/warn rules in this window");
      }
      return h("div", { className: "flex flex-col gap-2" },
        h("p", { className: "text-xs text-muted-foreground" },
          firing.length + " rule" + (firing.length === 1 ? "" : "s") + " that moved the score"),
        firing.map(function (r) {
          return h("div", { key: r.rule, className: "rounded-md border p-2 text-sm" },
            h("div", { className: "flex items-center gap-2" },
              h("span", { className: "font-mono text-xs" }, r.rule),
              h(Badge, { tone: "destructive" }, r.worst_sev),
              h("span", { className: "truncate text-xs text-muted-foreground" }, r.name)),
            r.example_text && h("div", { className: "mt-1 text-xs" }, r.example_text),
            r.example_action && h("div", { className: "mt-0.5 text-xs text-muted-foreground" }, r.example_action),
            h("div", { className: "mt-1 text-xs text-muted-foreground" },
              r.count + "× · " + r.days_fired + "d" + (r.last_ts ? " · last " + timeAgo(r.last_ts) : "")));
        }));
    }

    function pickPair(id) {
      setPairId(id);
      persistCompare(id, customLeft, customRight);
    }

    function pickCustom(side, value) {
      const left = side === "left" ? value : customLeft;
      const right = side === "right" ? value : customRight;
      if (side === "left") setCustomLeft(value);
      else setCustomRight(value);
      setPairId("custom");
      persistCompare("custom", left, right);
    }

    function modelSelect(side, value) {
      return h("label", { className: "flex min-w-0 flex-col gap-0.5 text-xs text-muted-foreground" },
        side === "left" ? "Left" : "Right",
        h("select", {
          className: "max-w-full rounded-md border bg-background px-2 py-1 font-mono text-xs text-foreground",
          value: value,
          "aria-label": side === "left" ? "Left model" : "Right model",
          onChange: function (ev) { pickCustom(side, ev.target.value); },
        },
          (choices.length ? choices : [value || ""]).map(function (m) {
            return h("option", { key: m, value: m }, m);
          })));
    }

    function diffPane() {
      function pct(v) { return v == null ? "—" : (v * 100).toFixed(1) + "%"; }
      const chips = presets.concat([{ id: "custom", label: "Custom" }]);
      const empty = !diff.available
        ? "No traffic for " + (pair.left.label || pair.left.spec) + " vs " +
          (pair.right.label || pair.right.spec) + " in the last hour"
        : null;
      const pairs = [
        ["Lane", (diff.left.requests || 0) + " req", (diff.right.requests || 0) + " req"],
        ["Avg tok/s", fmtTps(diff.left.avgTps), fmtTps(diff.right.avgTps)],
        ["Error rate", pct(diff.left.errorRate), pct(diff.right.errorRate)],
        ["Cost / 1k out", diff.left.costPer1k == null ? "—" : "$" + diff.left.costPer1k.toFixed(4),
          diff.right.costPer1k == null ? "—" : "$" + diff.right.costPer1k.toFixed(4)],
        ["Share of 1h", pct(diff.leftShare), pct(diff.rightShare)],
      ];
      function h2hStrip() {
        const rows = h2hDots(diff, pair.left.label, pair.right.label);
        const w = 420, x0 = 88, x1 = w - 8, rh = 22, pad = 4;
        const ht = rows.length * rh + pad * 2;
        function dot(row, side, cy, cls, key) {
          const d = row[side];
          if (!d) return null;
          const cx = x0 + d.pos * (x1 - x0);
          return h("circle", {
            key: key, cx: cx, cy: cy, r: 4, className: cls,
            tabIndex: 0, role: "img", "aria-label": d.tip.title + " · " + d.tip.meta,
            onMouseEnter: function () { setH2hTip(d.tip); },
            onMouseLeave: function () { setH2hTip(null); },
            onFocus: function () { setH2hTip(d.tip); },
            onBlur: function () { setH2hTip(null); },
          });
        }
        return h("div", { className: "flex flex-col gap-1" },
          h("div", { className: "flex flex-wrap gap-3 text-xs text-muted-foreground" },
            h("span", { className: "flex items-center gap-1" },
              h("span", { className: "h-2 w-2 rounded-full bg-emerald-500" }), pair.left.label),
            h("span", { className: "flex items-center gap-1" },
              h("span", { className: "h-2 w-2 rounded-full bg-amber-500" }), pair.right.label),
            h("span", { className: "ml-auto" },
              h2hTip ? h2hTip.title + " · " + h2hTip.meta : "head-to-head · larger lane at the right edge")),
          h("svg", { viewBox: "0 0 " + w + " " + ht, style: { height: ht + "px" }, className: "w-full", role: "img", "aria-label": "Head-to-head dots for the active Compare pair" },
            rows.map(function (row, i) {
              const y = pad + i * rh + rh / 2;
              return h("g", { key: row.metric },
                h("text", { x: 0, y: y + 3, "font-size": 10, className: "fill-muted-foreground" }, row.metric),
                h("line", { x1: x0, y1: y, x2: x1, y2: y, stroke: "currentColor", strokeDasharray: "2 3", className: "text-border" }),
                dot(row, "left", y - 3, "fill-emerald-500", "lc" + i),
                dot(row, "right", y + 4, "fill-amber-500", "rc" + i));
            })));
      }
      return h("div", { className: "flex flex-col gap-3" },
        h("div", { className: "flex flex-wrap gap-1" },
          chips.map(function (p) {
            const on = pairId === p.id;
            return h("button", {
              key: p.id,
              type: "button",
              className: cn(
                "rounded-md px-2 py-1 text-xs",
                on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              ),
              "aria-pressed": on,
              onClick: function () { pickPair(p.id); },
            }, p.label);
          })),
        pairId === "custom" && h("div", { className: "grid gap-2 md:grid-cols-2" },
          modelSelect("left", customLeft),
          modelSelect("right", customRight)),
        empty
          ? h("div", { className: "text-sm text-muted-foreground" }, empty)
          : h("div", { className: "flex flex-col gap-2" },
            h("div", { className: "grid grid-cols-3 gap-2 text-xs text-muted-foreground" },
              h("span", null, pair.label),
              h("span", { className: "font-mono" }, pair.left.label),
              h("span", { className: "font-mono" }, pair.right.label)),
            h2hStrip(),
            pairs.map(function (row) {
              return h("div", { key: row[0], className: "grid grid-cols-3 gap-2 border-b py-1.5 text-sm last:border-0" },
                h("b", { className: "text-xs font-medium text-muted-foreground" }, row[0]),
                h("span", { className: "text-xs" }, row[1]),
                h("span", { className: "text-xs" }, row[2]));
            })));
    }

    return h(Card, null,
      h(CardHeader, { className: "flex flex-row items-center justify-between gap-2 space-y-0" },
        h(CardTitle, { className: "text-sm" }, "Findings · health rules"),
        h("div", { className: "flex gap-1" },
          panes.map(function (pair) {
            const on = pane === pair[0];
            return h("button", {
              key: pair[0],
              type: "button",
              className: cn(
                "rounded-md px-2 py-1 text-xs",
                on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              ),
              "aria-pressed": on,
              onClick: function () { setPane(pair[0]); },
            }, pair[1]);
          }))),
      h(CardContent, { className: "flex flex-col gap-3" },
        pane === "summary" && summaryPane(),
        pane === "firing" && firingPane(),
        pane === "diff" && diffPane()));
  }

  function UsageMapTab() {
    const state = useEndpoint("/usage-map", POLL_MS);
    const blocked = guard(state, "usage map unavailable");
    if (blocked) return blocked;
    const entries = usageMapEntries(state.data);
    if (entries.length === 0) {
      return h(StateCard, null, "usage map not set on the dashboard server");
    }
    return h(Card, null,
      h(CardHeader, null, h(CardTitle, { className: "text-sm" }, "Usage map (model → usage)")),
      h(CardContent, null,
        h("table", { className: "w-full text-sm" },
          h("tbody", null,
            entries.map(function (e) {
              return h("tr", { key: e.model, className: "border-b last:border-0" },
                h("td", { className: "max-w-[16rem] truncate py-1.5 pr-2 font-mono text-xs" }, e.model),
                h("td", { className: "py-1.5 text-right" },
                  h(Badge, { tone: "secondary" }, e.usage)));
            })))));
  }

  function RoutingTab(props) {
    const [laneTip, setLaneTip] = useState(null);
    const state = useEndpoint("/router-view", POLL_MS);
    if (state.loading && !state.data) return h(StateCard, null, "loading…");
    if (state.error && !state.data) {
      return h(StateCard, { tone: "text-destructive" }, "request failed: " + state.error);
    }
    const data = state.data || {};
    // Never an error state for a missing sibling plugin — muted card only.
    if (data.available !== true) {
      return h(StateCard, null, "model-router plugin unavailable");
    }
    const status = data.status && data.status.available ? data.status.data : null;
    const roles = roleEntries(status);
    const notes = data.notes && data.notes.available ? notesOf(data.notes.data) : [];
    const recent = props && props.summary && props.summary.recent_1h;
    const lanes = recent && recent.available ? trafficLanes(recent.data) : [];
    return h(Card, null,
      h(CardHeader, null,
        h(CardTitle, { className: "text-sm" }, "Routing (via " + (data.source || "?") + ")")),
      h(CardContent, { className: "flex flex-col gap-3" },
        h("div", { className: "rounded-md border bg-muted/20 p-2" },
          h("div", { className: "mb-1 flex justify-between gap-2 text-xs text-muted-foreground" },
            h("span", null, "Traffic lanes · model family"),
            h("span", { className: "truncate" },
              laneTip ? laneTip.title + " · " + laneTip.meta : "last hour")),
          lanes.length > 0
            ? h("svg", { viewBox: "0 0 420 24", className: "h-6 w-full", role: "img", "aria-label": "Traffic share by model family over the last hour" },
                (function () {
                  let x = 0;
                  return lanes.map(function (lane, i) {
                    const bw = Math.max(4, lane.share * 420);
                    const bx = x;
                    x += bw;
                    const tip = trafficLaneTip(lane);
                    return h("rect", {
                      key: lane.id + "-" + i, x: bx, y: 2,
                      width: Math.max(2, bw - 2), height: 20, rx: 3,
                      className: TRAFFIC_LANE_CLASSES[lane.id] ||
                        "fill-muted-foreground/40",
                      tabIndex: 0, role: "img",
                      "aria-label": tip.title + " · " + tip.meta,
                      onMouseEnter: function () { setLaneTip(tip); },
                      onMouseLeave: function () { setLaneTip(null); },
                      onFocus: function () { setLaneTip(tip); },
                      onBlur: function () { setLaneTip(null); },
                    });
                  });
                })())
            : h("div", { className: "text-xs text-muted-foreground" },
                "no api records in the recent window"),
          lanes.length > 0 && h("div", { className: "mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground" },
            lanes.map(function (lane) {
              return h("span", { key: lane.id, className: "flex items-center gap-1" },
                h("span", { className: "h-2 w-2 rounded-full " + (TRAFFIC_LANE_DOTS[lane.id] || "bg-muted-foreground/40") }),
                lane.id + " · " + Math.round(lane.share * 100) + "%");
            }))),
        roles.length > 0
          ? h("table", { className: "w-full text-sm" },
              h("tbody", null,
                roles.map(function (r) {
                  return h("tr", { key: r.role, className: "border-b last:border-0" },
                    h("td", { className: "py-1.5 pr-2 text-xs" }, r.role),
                    h("td", { className: "max-w-[16rem] truncate py-1.5 text-right font-mono text-xs" },
                      r.model));
                })))
          : h("div", { className: "text-sm text-muted-foreground" },
              status ? "no role resolutions reported" : "router status unavailable"),
        notes.length > 0 && h("div", { className: "flex flex-col gap-1" },
          h("div", { className: "text-xs font-medium text-muted-foreground" }, "router notes"),
          notes.slice(-5).map(function (n, i) {
            return h("div", { key: i, className: "truncate text-xs text-muted-foreground" }, "· " + n);
          }))));
  }

  const SUB_TABS = [
    ["overview", "Overview"],
    ["findings", "Findings"],
    ["usage-map", "Usage map"],
    ["routing", "Routing"],
  ];

  // The full dashboard lives on the metrics server itself — only offer the
  // link when this backend is actually talking to that server over HTTP.
  function FullDashLink(props) {
    const health = props.summary && props.summary.health;
    const d = health && health.available ? health.data : null;
    if (!d || d.source === "local-file" || d.mode === "local-file" || !d.base_url) {
      const note = d
        ? "Full dashboard lives on the metrics server — off-network right now (showing local data)"
        : "Full dashboard unavailable — metrics server unreachable";
      return h("div", null,
        h("span", { className: "text-sm text-muted-foreground" }, note));
    }
    return h("div", null,
      h("a", {
        className: "text-sm text-primary hover:underline",
        href: d.base_url,
        target: "_blank",
        rel: "noopener noreferrer",
      }, "Open full dashboard ↗"));
  }

  function MetricsPage() {
    const summary = useEndpoint("/summary", POLL_MS);

    return h("div", { className: "flex flex-col gap-4 p-4" },
      summary.error && !summary.data &&
        h(StateCard, { tone: "text-destructive" }, "summary poll failed: " + summary.error),
      h(StatHeader, { summary: summary.data }),
      h(Tabs, { defaultValue: "overview" }, function (active, setActive) {
        return h(React.Fragment, null,
          h(TabsList, null,
            SUB_TABS.map(function (pair) {
              return h(TabsTrigger, {
                key: pair[0],
                value: pair[0],
                active: active === pair[0],
                onClick: function () { setActive(pair[0]); },
              }, pair[1]);
            })),
          active === "overview" && h(OverviewTab, { summary: summary.data }),
          active === "findings" && h(FindingsTab, { summary: summary.data }),
          active === "usage-map" && h(UsageMapTab, null),
          active === "routing" && h(RoutingTab, { summary: summary.data }));
      }),
      h(FullDashLink, { summary: summary.data }));
  }

  window.__HERMES_PLUGINS__.register("metrics-dashboard", MetricsPage);
})();
