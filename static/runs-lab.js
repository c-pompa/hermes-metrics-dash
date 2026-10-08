/**
 * runs-v1 lab helpers — live /api/recent → Widget Lab stacked ok/error bars.
 * UMD: browser as window.RunsLab, node via module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RunsLab = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function pad2(n) {
    return String(n).padStart(2, "0");
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

  function bucketSeconds(hours) {
    const h = Number(hours) || 6;
    if (h <= 1) return 300;
    if (h <= 6) return 1800;
    if (h <= 48) return 3600;
    return 86400;
  }

  function countsAsOk(r) {
    return r && (r.kind === "api" || r.kind === "moa_turn");
  }

  function countsAsError(r) {
    return r && r.kind === "error";
  }

  function bucketLabel(start, step) {
    const d = new Date(Number(start) * 1000);
    if (step >= 86400) {
      return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
    }
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function runsFromRecords(records, opts) {
    const o = opts || {};
    const from = Number(o.from) || 0;
    const to = Number(o.to) || 0;
    const host = o.host || "";
    const hours = Math.max((to - from) / 3600, 1 / 60);
    const step = bucketSeconds(hours);
    const aligned = Math.floor(from / step) * step;
    const buckets = [];
    for (let t = aligned; t < to; t += step) {
      buckets.push({
        start: t,
        end: t + step,
        ok: 0,
        errors: 0,
        label: bucketLabel(t, step),
      });
    }
    if (!buckets.length) {
      buckets.push({ start: from, end: to, ok: 0, errors: 0, label: bucketLabel(from, step) });
    }
    (records || []).forEach(function (r) {
      const ts = Number(r && r.ts) || 0;
      if (ts < from || ts > to) return;
      if (host && r.host !== host) return;
      let idx = Math.floor((ts - aligned) / step);
      if (idx < 0) idx = 0;
      if (idx >= buckets.length) idx = buckets.length - 1;
      if (countsAsError(r)) buckets[idx].errors += 1;
      else if (countsAsOk(r)) buckets[idx].ok += 1;
    });
    return buckets;
  }

  function runsKpis(buckets) {
    let ok = 0;
    let errors = 0;
    (buckets || []).forEach(function (b) {
      ok += Number(b.ok) || 0;
      errors += Number(b.errors) || 0;
    });
    const requests = ok + errors;
    const rate = requests ? (errors / requests) * 100 : 0;
    return {
      ok: ok,
      errors: errors,
      requests: requests,
      rate: rate,
    };
  }

  function runsBarTip(bucket) {
    const b = bucket || {};
    return {
      title: b.label || bucketLabel(b.start, (b.end || 0) - (b.start || 0) || 1800),
      meta: "Ok " + (Number(b.ok) || 0) + " · Errors " + (Number(b.errors) || 0),
    };
  }

  function hoursFromSpec(spec) {
    if (!spec || spec.type === "preset") return Number(spec && spec.hours) || 6;
    return 24;
  }

  return {
    parseRangeToken: parseRangeToken,
    parseHostToken: parseHostToken,
    windowForRange: windowForRange,
    bucketSeconds: bucketSeconds,
    countsAsOk: countsAsOk,
    countsAsError: countsAsError,
    runsFromRecords: runsFromRecords,
    runsKpis: runsKpis,
    runsBarTip: runsBarTip,
    hoursFromSpec: hoursFromSpec,
  };
});
