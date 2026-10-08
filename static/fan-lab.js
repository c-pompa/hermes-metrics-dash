/**
 * fan-v1 lab helpers — MoA proposers + stuck delegate_task children.
 * Live records from /api/recent; mock fallback matches the Widget Lab turn.
 * UMD: window.FanLab / module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FanLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STUCK_S = 45;
  const OK_RAY_CAP = 80;
  const CAP_DEFAULT = 8;
  const CX = 260;
  const CY = 142;

  function pad2(n) {
    return String(n).padStart(2, "0");
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

  function shortSess(id) {
    const s = String(id || "");
    if (s.length <= 10) return s;
    return s.slice(-8);
  }

  function rootOf(r) {
    return (r && (r.parent_session_id || r.session_id)) || "";
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

  function inWindow(r, from, to) {
    const ts = Number(r && r.ts) || 0;
    if (from && ts < from) return false;
    if (to && ts > to) return false;
    return true;
  }

  function associateMoARecords(turns, refs) {
    const byRoot = new Map();
    const associations = new Map();
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      associations.set(turn, []);
      const root = rootOf(turn);
      if (!byRoot.has(root)) byRoot.set(root, []);
      byRoot.get(root).push(turn);
    }
    byRoot.forEach(function (candidates) {
      candidates.sort(function (a, b) { return a.ts - b.ts; });
    });
    for (let i = 0; i < refs.length; i++) {
      const record = refs[i];
      const candidates = byRoot.get(rootOf(record)) || byRoot.get(record.session_id);
      if (!candidates || !candidates.length) continue;
      let low = 0;
      let high = candidates.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (candidates[middle].ts < record.ts) low = middle + 1;
        else high = middle;
      }
      const before = low > 0 ? candidates[low - 1] : null;
      const after = low < candidates.length ? candidates[low] : null;
      const turn = !before ? after : !after ? before
        : Math.abs(before.ts - record.ts) <= Math.abs(after.ts - record.ts) ? before : after;
      if (turn && Math.abs(turn.ts - record.ts) < (turn.duration_s || 0) + 120) {
        associations.get(turn).push(record);
      }
    }
    return associations;
  }

  function isReturnedStop(r) {
    return r && r.kind === "subagent_stop";
  }

  function childKey(r) {
    return String((r && (r.session_id || r.child_session_id)) || "");
  }

  function fanTurns(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const list = records || [];
    const turns = list.filter(function (r) {
      return r && r.kind === "moa_turn" && Number(r.duration_s) > 0 && inWindow(r, from, to);
    }).slice().sort(function (a, b) { return a.ts - b.ts; });
    const refs = list.filter(function (r) {
      return r && (r.kind === "moa_ref" || r.kind === "moa_agg") && inWindow(r, from, to);
    });
    const byTurn = associateMoARecords(turns, refs);
    return turns.map(function (turn) {
      const mine = byTurn.get(turn) || [];
      const proposers = mine.filter(function (r) { return r.kind === "moa_ref"; });
      const agg = mine.filter(function (r) { return r.kind === "moa_agg"; })[0] || null;
      const kids = list.filter(function (r) {
        if (!r) return false;
        if (r === turn) return false;
        if (r.kind === "moa_ref" || r.kind === "moa_agg" || r.kind === "moa_turn") return false;
        const parent = r.parent_session_id;
        if (parent && parent === turn.session_id) return true;
        return false;
      });
      const stops = {};
      const pending = {};
      kids.forEach(function (r) {
        const key = childKey(r) || ("row-" + r.ts + "-" + (r.model || r.kind));
        if (isReturnedStop(r)) stops[key] = r;
        else if (!pending[key]) pending[key] = r;
      });
      const children = [];
      Object.keys(stops).forEach(function (key) {
        children.push({ record: stops[key], stuck: false, returned: true });
      });
      Object.keys(pending).forEach(function (key) {
        if (stops[key]) return;
        const r = pending[key];
        const dur = Number(r.duration_s) || 0;
        const stuck = r.stuck === true || dur >= STUCK_S;
        children.push({ record: r, stuck: stuck, returned: false });
      });
      return {
        turn: turn,
        id: turn.session_id || shortSess(turn.session_title),
        title: turn.session_title || turn.session_id,
        ts: turn.ts,
        proposers: proposers,
        agg: agg,
        children: children,
      };
    }).filter(function (b) {
      return (b.proposers && b.proposers.length) || (b.children && b.children.length);
    }).reverse();
  }

  function rayFromRecord(r, extra) {
    extra = extra || {};
    const stuck = extra.stuck === true;
    const proposer = r.kind === "moa_ref";
    const sub = r.kind === "subagent_stop" || extra.role === "delegate_task" || extra.kind === "subagent";
    let kind = extra.kind;
    if (!kind) {
      if (proposer) kind = "moa_ref";
      else if (stuck || sub) kind = "subagent";
      else kind = "tool";
    }
    const label = extra.label || r.label || r.model || kind;
    const role = extra.role || (proposer ? "proposer" : stuck ? "delegate_task" : (r.label || r.kind || "tool"));
    return {
      id: extra.id || r.id || (kind + "-" + (r.session_id || r.ts)),
      kind: kind,
      role: role,
      label: proposer ? (r.model || label) : label,
      host: r.host || "",
      duration_s: Number(r.duration_s) || 0,
      tps: r.tps == null ? null : Number(r.tps),
      status: stuck ? "stuck" : (r.kind === "error" ? "error" : "ok"),
      stuck: stuck,
      model: r.model,
      ts: r.ts,
    };
  }

  function fanCalls(bundle, opts) {
    const o = opts || {};
    const cap = o.okCap;
    if (!bundle) return [];
    const calls = [];
    (bundle.proposers || []).forEach(function (r, i) {
      calls.push(rayFromRecord(r, { id: "p" + i, kind: "moa_ref", role: "proposer", stuck: false }));
    });
    (bundle.children || []).forEach(function (ch, i) {
      const r = ch.record;
      if (ch.stuck) {
        calls.push(rayFromRecord(r, {
          id: "s" + i,
          kind: "subagent",
          role: r.label || "delegate_task",
          label: r.model || r.label || "web_fetch",
          stuck: true,
        }));
        return;
      }
      const sub = r.kind === "subagent_stop";
      calls.push(rayFromRecord(r, {
        id: (sub ? "k" : "t") + i,
        kind: sub ? "subagent" : "tool",
        role: r.label || r.kind,
        label: r.model || r.label || r.kind,
        stuck: false,
      }));
    });
    return fanLayout(cap == null ? calls : capOkRays(calls, cap));
  }

  function capOkRays(calls, limit) {
    const n = Math.max(0, Number(limit) || OK_RAY_CAP);
    const keep = [];
    const ok = [];
    (calls || []).forEach(function (c) {
      if (c.kind === "moa_ref" || c.stuck) keep.push(c);
      else ok.push(c);
    });
    if (ok.length <= n) return keep.concat(ok);
    const out = [];
    const step = (ok.length - 1) / Math.max(1, n - 1);
    const seen = {};
    for (let i = 0; i < n; i++) {
      const idx = n === 1 ? 0 : Math.round(i * step);
      if (seen[idx]) continue;
      seen[idx] = true;
      out.push(ok[idx]);
    }
    return keep.concat(out);
  }

  function fanRand(seed) {
    let x = seed || 42;
    return function () {
      x = (x * 16807) % 2147483647;
      return (x - 1) / 2147483646;
    };
  }

  function fanLayout(calls) {
    const list = (calls || []).map(function (c) { return Object.assign({}, c); });
    const proposers = list.filter(function (c) { return c.kind === "moa_ref"; });
    const stuck = list.filter(function (c) { return c.stuck; });
    const rest = list.filter(function (c) { return c.kind !== "moa_ref" && !c.stuck; });
    let maxDur = 1;
    list.forEach(function (c) {
      if (Number(c.duration_s) > maxDur) maxDur = Number(c.duration_s);
    });
    proposers.forEach(function (c, i) {
      const n = Math.max(proposers.length, 1);
      c.angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      c.len = 58 + (Number(c.duration_s) / maxDur) * 40;
    });
    stuck.forEach(function (c, i) {
      const n = Math.max(stuck.length - 1, 1);
      c.angle = -0.4 + (i / n) * 1.1;
      c.len = 70 + (Number(c.duration_s) / maxDur) * 70;
    });
    const rand = fanRand(42);
    rest.forEach(function (c) {
      c.angle = rand() * Math.PI * 2;
      c.len = 48 + (Number(c.duration_s) / maxDur) * 92;
    });
    return proposers.concat(stuck, rest);
  }

  function fanSummary(calls, bundle) {
    const list = calls || [];
    const turnDur = bundle && bundle.turn ? Number(bundle.turn.duration_s) : 0;
    let maxCall = 0;
    list.forEach(function (c) {
      if (Number(c.duration_s) > maxCall) maxCall = Number(c.duration_s);
    });
    return {
      total: list.length,
      proposers: list.filter(function (c) { return c.kind === "moa_ref"; }).length,
      stuck: list.filter(function (c) { return c.stuck; }).length,
      errors: list.filter(function (c) { return c.status === "error"; }).length,
      held_s: Math.max(turnDur, maxCall),
    };
  }

  function fanMatches(call, filter) {
    if (!call) return false;
    if (filter === "all" || !filter) return true;
    if (filter === "proposer") return call.kind === "moa_ref";
    if (filter === "stuck") return call.stuck === true;
    return true;
  }

  function fanTip(call, sum) {
    if (!call) {
      const s = sum || {};
      return {
        title: "aggregator · " + (s.aggLabel || "moa"),
        meta: (s.proposers || 0) + " proposers · " + (s.stuck || 0) + " stuck · " + fmtDuration(s.held_s || 0) + " wall",
      };
    }
    const dur = Number(call.duration_s) >= 10
      ? Math.round(call.duration_s) + "s"
      : Number(call.duration_s).toFixed(1) + "s";
    let extra;
    if (call.stuck) extra = "never returned";
    else if (call.status === "error") extra = "error";
    else extra = call.tps == null || !isFinite(Number(call.tps)) ? "ok" : fmtTps(call.tps) + " t/s";
    const title = call.kind === "moa_ref"
      ? "proposer · " + shortModelName(call.label || call.model)
      : call.role + " · " + (call.label || "") + (call.stuck ? " · stuck" : "");
    return {
      title: title,
      meta: (call.host || "host") + " · " + dur + " · " + extra,
      stuck: !!call.stuck,
    };
  }

  function fanHubCopy(sum) {
    const s = sum || {};
    if (s.stuck > 0) {
      return { top: s.stuck + " STUCK ON", bot: "children" };
    }
    return { top: String(s.proposers || 0), bot: "proposers" };
  }

  function fanCapWhatIf(calls, cap) {
    const n = Number(cap) || CAP_DEFAULT;
    const list = calls || [];
    const stuck = list.filter(function (c) { return c.stuck; });
    let held = 0;
    let nonStuck = 0;
    list.forEach(function (c) {
      const d = Number(c.duration_s) || 0;
      if (d > held) held = d;
      if (!c.stuck && d > nonStuck) nonStuck = d;
    });
    const applicable = stuck.length > n;
    const capped = applicable ? nonStuck : held;
    return {
      applicable: applicable,
      cap: n,
      held_s: held,
      capped_s: capped,
      saved_s: Math.max(0, held - capped),
    };
  }

  function mockRecords(now) {
    const t = Number(now) || Date.now() / 1000;
    const session = "8f2c";
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
    const rows = [{
      ts: t - 62,
      kind: "moa_turn",
      session_id: session,
      duration_s: 62,
      model: "nvidia",
      host: "mini",
      output_tokens: 640,
    }];
    proposers.forEach(function (p, i) {
      rows.push({
        ts: t - 61 + i * 0.05,
        kind: "moa_ref",
        session_id: session,
        duration_s: p.duration_s,
        model: p.model,
        label: p.model,
        host: p.host,
        tps: p.tps,
      });
    });
    rows.push({
      ts: t - 1,
      kind: "moa_agg",
      session_id: session,
      model: "deepseek-v4-flash",
      label: "aggregator · flash",
      host: "mini",
    });
    for (let i = 0; i < 14; i++) {
      rows.push({
        ts: t - 60 + i * 0.02,
        kind: "api",
        session_id: "stuck-" + i,
        parent_session_id: session,
        duration_s: 62,
        model: "web_fetch",
        label: "delegate_task",
        host: i % 2 ? "winpc" : "mbp",
      });
    }
    const tools = ["web_search", "read_file", "execute_code", "delegate_task"];
    const hosts = ["mbp", "mini", "winpc"];
    const rand = fanRand(42);
    for (let n = 0; n < 168; n++) {
      const r = rand();
      const tool = tools[n % tools.length];
      const child = "ok-" + n;
      const dur = Math.round((0.2 + r * 2.4) * 10) / 10;
      rows.push({
        ts: t - 50 + n * 0.01,
        kind: "api",
        session_id: child,
        parent_session_id: session,
        duration_s: dur,
        model: tool,
        label: tool,
        host: hosts[n % 3],
        tps: Math.round((12 + r * 40) * 10) / 10,
      });
      rows.push({
        ts: t - 49.5 + n * 0.01,
        kind: "subagent_stop",
        session_id: child,
        parent_session_id: session,
        duration_s: dur,
        label: "leaf",
        host: hosts[n % 3],
      });
    }
    return rows;
  }

  return {
    STUCK_S: STUCK_S,
    OK_RAY_CAP: OK_RAY_CAP,
    CAP_DEFAULT: CAP_DEFAULT,
    CX: CX,
    CY: CY,
    fmtTime: fmtTime,
    fmtDuration: fmtDuration,
    fmtTps: fmtTps,
    shortModelName: shortModelName,
    shortSess: shortSess,
    rootOf: rootOf,
    parseRangeToken: parseRangeToken,
    windowForRange: windowForRange,
    associateMoARecords: associateMoARecords,
    fanTurns: fanTurns,
    fanCalls: fanCalls,
    capOkRays: capOkRays,
    fanLayout: fanLayout,
    fanSummary: fanSummary,
    fanMatches: fanMatches,
    fanTip: fanTip,
    fanHubCopy: fanHubCopy,
    fanCapWhatIf: fanCapWhatIf,
    mockRecords: mockRecords,
  };
});
