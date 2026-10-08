/* Hermes Metrics — shared DOM + formatting helpers (loads first). */
"use strict";

/* Apply the stored theme before first paint; the toggle itself is wired in filters.js. */
try { document.documentElement.dataset.theme = localStorage.getItem("hermesMetricsTheme") || "auto"; } catch (e) {}

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtInt = n => n == null ? "–" : Number(n).toLocaleString();
const fmtTok = n => n == null ? "–" : n >= 1e6 ? (n/1e6).toFixed(1)+"M" : n >= 1e4 ? Math.round(n/1e3)+"k" : n >= 1e3 ? (n/1e3).toFixed(1)+"k" : String(n);
const fmt1 = n => n == null ? "–" : Number(n).toFixed(1);
function fmtDuration(seconds) {
  if (seconds == null) return "–";
  const tenths = Math.round(Number(seconds) * 10);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const minutes = Math.floor(tenths / 600);
  const remainder = (tenths % 600) / 10;
  return `${minutes}m ${remainder.toFixed(1)}s`;
}
const fmtTime = ts => new Date(ts*1000).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});
const median = a => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; };
/* Interpolated quantile over a numeric sample (p50/p95 latency per model). */
function quantile(values, q) {
  const a = values.filter(v => v != null && Number.isFinite(Number(v))).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return a[base + 1] !== undefined ? a[base] + rest * (a[base + 1] - a[base]) : a[base];
}
const fmtDateShort = ts => new Date(ts*1000).toLocaleString([], {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
const fmtDayShort = ts => new Date(ts*1000).toLocaleString([], {month:"short", day:"numeric"});
/* Relative age ("4s ago" / "18m ago" / "6h ago" / "3d ago"); null → "never". */
function fmtAgo(ts, now = Date.now()/1000) {
  if (ts == null) return "never";
  const s = Math.max(0, now - ts);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s/60)}m ago`;
  if (s < 129600) return `${Math.round(s/3600)}h ago`;
  return `${Math.round(s/86400)}d ago`;
}
/* Load uptime for model chips ("up 3d" / "up 5h" / "up 12m"). */
function fmtUptime(since, now = Date.now()/1000) {
  const s = Math.max(0, now - since);
  if (s < 3600) return `up ${Math.max(1, Math.round(s/60))}m`;
  if (s < 86400) return `up ${Math.round(s/3600)}h`;
  return `up ${Math.round(s/86400)}d`;
}
const fmtBytes = n => n == null ? "?" : n >= 1e9 ? (n/1e9).toFixed(1)+" GB" : n >= 1e6 ? Math.round(n/1e6)+" MB" : n >= 1e3 ? Math.round(n/1e3)+" kB" : n+" B";
/* Small dollar amounts: $0.42 / $0.31 / $0.003 — trims noise, keeps precision. */
const fmtCost = n => n == null || !(n > 0) ? "–" : "$" + (n >= 1 ? n.toFixed(2) : String(Number(n.toFixed(4))));
function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function shortSess(id) { return id ? String(id).slice(0, 22) : "?"; }
function setPressedState(control, pressed) {
  control.classList.toggle("on", pressed);
  control.setAttribute("aria-pressed", String(pressed));
}
function syncPressedGroup(group, activeControl) {
  for (const control of group.children) setPressedState(control, control === activeControl);
}
function focusKeyAttribute(scope, value) {
  return `data-focus-key="${esc(`${scope}:${value}`)}"`;
}
function captureFocusKey() {
  return document.activeElement?.dataset?.focusKey || null;
}
function restoreFocusKey(key) {
  if (!key) return false;
  const replacement = [...document.querySelectorAll("[data-focus-key]")]
    .find(control => control.dataset.focusKey === key);
  if (!replacement) return false;
  if (replacement.dataset.chartId) {
    const chartId = replacement.dataset.chartId;
    const marks = [...document.querySelectorAll(".chart-mark")]
      .filter(mark => mark.dataset.chartId === chartId);
    marks.forEach(mark => mark.setAttribute("tabindex", mark === replacement ? "0" : "-1"));
    chartRovingIndex.set(chartId, Number(replacement.dataset.pointIndex) || 0);
  }
  replacement.focus({ preventScroll: true });
  return true;
}

/* ---------- canvas helpers (clean-design demo ports) ----------
   Small interactive graphs: DPR-aware setup, CSS-var → rgb triplet, and two
   sparkline flavors (single series, dual series with joint hover). Hover
   state lives on the canvas element so re-renders rebind cleanly. */
function cssColorTriplet(color) {
  let value = color;
  if (typeof value === "string" && value.startsWith("var(")) {
    if (typeof getComputedStyle !== "function") return "130,128,111";
    value = getComputedStyle(document.documentElement).getPropertyValue(value.slice(4, -1)).trim();
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value || "");
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(value || "");
  if (rgb) return rgb[1].split(",").slice(0, 3).map(v => v.trim()).join(",");
  return "130,128,111";   // fallback: dim grey
}
function canvasSetup(cv) {
  if (!cv || typeof cv.getContext !== "function") return null;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  const dpr = Math.min(typeof devicePixelRatio === "number" ? devicePixelRatio : 1, 2);
  const rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: 300, height: 34 };
  const w = rect.width || 300, h = rect.height || 34;
  cv.width = Math.max(1, Math.round(w * dpr));
  cv.height = Math.max(1, Math.round(h * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}
function bindCanvasHover(cv) {
  if (cv.dataset.sparkBound) return;
  cv.dataset.sparkBound = "1";
  cv.addEventListener("pointermove", e => {
    const st = cv._sparkState;
    if (!st || !st.xs || !st.xs.length) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left;
    let best = -1, bestD = Infinity;
    st.xs.forEach((px, i) => { const d = Math.abs(px - x); if (d < bestD) { bestD = d; best = i; } });
    if (best !== st.hover) { st.hover = best; st.redraw(); }
  });
  cv.addEventListener("pointerleave", () => {
    const st = cv._sparkState;
    if (st && st.hover !== -1) { st.hover = -1; st.redraw(); }
  });
}
/* Single-series sparkline; series = [[ts, value], ...]. */
function canvasSparkline(cv, series, color, opts = {}) {
  const rgb = cssColorTriplet(color);
  const state = { hover: -1, xs: [], redraw: () => draw() };
  cv._sparkState = state;
  bindCanvasHover(cv);
  function draw() {
    const setup = canvasSetup(cv);
    if (!setup) return;
    const [ctx, w, h] = setup;
    ctx.clearRect(0, 0, w, h);
    state.xs = [];
    if (!series || series.length < 2) return;
    const pad = 3;
    const vals = series.map(p => p[1]);
    const min = opts.min != null ? opts.min : Math.min(...vals);
    const max = Math.max(...vals);
    const span = (max - min) || 1;
    const t0 = opts.t0 != null ? opts.t0 : series[0][0];
    const t1 = opts.t1 != null ? opts.t1 : series[series.length - 1][0];
    const tspan = (t1 - t0) || 1;
    const pts = series.map(([t, v]) => [pad + (t - t0) / tspan * (w - 2 * pad), h - pad - (v - min) / span * (h - 2 * pad)]);
    state.xs = pts.map(p => p[0]);
    if (opts.median != null) {
      const y = h - pad - (opts.median - min) / span * (h - 2 * pad);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y);
      ctx.strokeStyle = "rgba(130,128,111,.35)"; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.beginPath();
    pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
    ctx.strokeStyle = `rgba(${rgb},.9)`; ctx.lineWidth = 1.5; ctx.stroke();
    if (opts.fill !== false) {
      ctx.lineTo(pts[pts.length - 1][0], h); ctx.lineTo(pts[0][0], h); ctx.closePath();
      ctx.fillStyle = `rgba(${rgb},.10)`; ctx.fill();
    }
    if (state.hover >= 0 && state.hover < pts.length) {
      const [x, y] = pts[state.hover];
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.strokeStyle = "rgba(130,128,111,.3)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fillStyle = `rgba(${rgb},1)`; ctx.fill();
      ctx.fillStyle = `rgb(${cssColorTriplet("var(--ink-1)")})`; ctx.font = "600 10px system-ui";
      ctx.textAlign = state.hover > series.length * .7 ? "right" : "left";
      const label = opts.fmt ? opts.fmt(series[state.hover][1]) : String(series[state.hover][1]);
      ctx.fillText(label, x + (state.hover > series.length * .7 ? -6 : 6), Math.max(10, y - 6));
    }
  }
  draw();
}
/* Dual-series sparkline with a joint hover crosshair (fleet CPU + RAM). */
function canvasDualSparkline(cv, seriesA, seriesB) {
  const rgbA = cssColorTriplet(seriesA.color), rgbB = cssColorTriplet(seriesB.color);
  const state = { hover: -1, xs: [], redraw: () => draw() };
  cv._sparkState = state;
  bindCanvasHover(cv);
  function draw() {
    const setup = canvasSetup(cv);
    if (!setup) return;
    const [ctx, w, h] = setup;
    ctx.clearRect(0, 0, w, h);
    state.xs = [];
    const a = seriesA.data || [], b = seriesB.data || [];
    if (a.length < 2 && b.length < 2) return;
    const pad = 3;
    const all = a.concat(b);
    const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0]));
    const tspan = (t1 - t0) || 1;
    // Each series normalized to its own range — hover shows the real values.
    const project = (data) => {
      const vals = data.map(p => p[1]);
      const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
      return data.map(([t, v]) => [pad + (t - t0) / tspan * (w - 2 * pad), h - pad - (v - min) / span * (h - 2 * pad)]);
    };
    const ptsA = a.length >= 2 ? project(a) : [], ptsB = b.length >= 2 ? project(b) : [];
    state.xs = (ptsA.length ? ptsA : ptsB).map(p => p[0]);
    for (const [pts, rgb] of [[ptsA, rgbA], [ptsB, rgbB]]) {
      if (!pts.length) continue;
      ctx.beginPath();
      pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.strokeStyle = `rgba(${rgb},.9)`; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (state.hover >= 0) {
      const ref = ptsA.length ? ptsA : ptsB;
      const i = Math.min(state.hover, ref.length - 1);
      const x = ref[i][0];
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h);
      ctx.strokeStyle = "rgba(130,128,111,.3)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.font = "600 10px system-ui"; ctx.textAlign = "left";
      let ty = 10;
      for (const [cfg, pts, data, rgb] of [[seriesA, ptsA, a, rgbA], [seriesB, ptsB, b, rgbB]]) {
        if (!pts.length) continue;
        const j = Math.min(state.hover, pts.length - 1);
        ctx.beginPath(); ctx.arc(pts[j][0], pts[j][1], 3, 0, 7); ctx.fillStyle = `rgba(${rgb},1)`; ctx.fill();
        const label = `${cfg.name} ${cfg.fmt ? cfg.fmt(data[j][1]) : data[j][1]}`;
        ctx.fillStyle = `rgba(${rgb},1)`;
        ctx.fillText(label, Math.min(x + 6, w - 90), ty);
        ty += 12;
      }
    }
  }
  draw();
}


/* Interactive scatter with crosshair + brush-to-zoom (P2; same interaction
   kit as the SVG main chart). points = [{ t, y, color, label }].
   Rebinding-safe: repeated calls update the points and redraw instead of
   stacking listeners. Returns the state object ({ domain, hover, ... }). */
function canvasBrushScatter(cv, points, opts = {}) {
  if (!cv) return null;
  let st = cv._brushScatter;
  if (!st) {
    st = cv._brushScatter = { hover: -1, domain: null, brush: null, brushing: false, points: [], opts: {} };
    cv.addEventListener("pointermove", ev => {
      if (ev.pointerType === "touch") return;
      const view = scatterView(st);
      if (!view) return;
      const r = cv.getBoundingClientRect();
      const px = ev.clientX - r.left, py = ev.clientY - r.top;
      if (st.brushing) {
        st.brush[1] = px;
        st._draw();
        return;
      }
      let best = -1, bestD = 18;
      st.points.forEach((p, i) => {
        if (p.t < view.d0 || p.t > view.d1) return;
        const d = Math.hypot(px - view.X(p.t), py - view.Y(p.y));
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best !== st.hover) { st.hover = best; st._draw(); }
    });
    cv.addEventListener("pointerleave", () => {
      if (st.hover !== -1) { st.hover = -1; st._draw(); }
    });
    cv.addEventListener("pointerdown", ev => {
      if (ev.pointerType !== "mouse" || ev.button !== 0) return;
      const r = cv.getBoundingClientRect();
      st.brushing = true;
      st.brush = [ev.clientX - r.left, ev.clientX - r.left];
      if (cv.setPointerCapture) {
        try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
      }
      ev.preventDefault();
    });
    cv.addEventListener("pointerup", ev => {
      if (!st.brushing) return;
      st.brushing = false;
      const view = scatterView(st);
      const brush = st.brush;
      st.brush = null;
      if (!view) { st._draw(); return; }
      const r = cv.getBoundingClientRect();
      const scale = (r.width - view.padL - view.padR) || 1;
      const toT = px => view.d0 + (px - view.padL) / scale * (view.d1 - view.d0);
      let a = Math.min(...brush.map(toT)), b = Math.max(...brush.map(toT));
      if (b - a >= (view.d1 - view.d0) * 0.02) {
        a = Math.max(view.full[0], a);
        b = Math.min(view.full[1], b);
        if (b > a) {
          st.domain = [a, b];
          if (st.opts.onZoom) st.opts.onZoom(st.domain);
        }
      }
      st._draw();
    });
    cv.addEventListener("dblclick", () => {
      st.domain = null;
      if (st.opts.onReset) st.opts.onReset();
      st._draw();
    });
  }
  st.points = Array.isArray(points) ? points : [];
  st.opts = opts;
  st.fullDomain = st.points.length
    ? [Math.min(...st.points.map(p => p.t)), Math.max(...st.points.map(p => p.t))]
    : [0, 1];
  if (st.fullDomain[0] === st.fullDomain[1]) st.fullDomain[1] = st.fullDomain[0] + 1;
  // A zoom that no longer overlaps the data (range changed) auto-clears.
  if (st.domain && (st.domain[1] < st.fullDomain[0] || st.domain[0] > st.fullDomain[1])) st.domain = null;
  st._draw = () => drawBrushScatter(cv, st);
  st._draw();
  return st;
}
function scatterView(st) {
  const cv = st && st.cv;
  return st && st._view || null;
}
function drawBrushScatter(cv, st) {
  const setup = canvasSetup(cv);
  if (!setup) return;
  const [ctx, w, h] = setup;
  const padL = 34, padR = 8, padT = 8, padB = 16;
  const [fd0, fd1] = st.fullDomain;
  const [d0, d1] = st.domain || [fd0, fd1];
  const span = (d1 - d0) || 1;
  const visible = st.points.filter(p => p.t >= d0 && p.t <= d1);
  const ymax = Math.max(0.1, ...visible.map(p => p.y)) * 1.12;
  const X = t => padL + (t - d0) / span * (w - padL - padR);
  const Y = v => h - padB - v / ymax * (h - padT - padB);
  st._view = { d0, d1, full: [fd0, fd1], X, Y, padL, padR, padT, padB };
  ctx.clearRect(0, 0, w, h);
  ctx.font = "9px system-ui";
  const faint = cssColorTriplet("var(--ink-3)");
  ctx.fillStyle = `rgb(${faint})`;
  ctx.textAlign = "right";
  for (let g = 0; g <= 3; g++) {
    const v = ymax * g / 3, y = Y(v);
    ctx.strokeStyle = `rgba(${cssColorTriplet("var(--grid)")},1)`;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    ctx.fillText(st.opts.fmtY ? st.opts.fmtY(v) : v.toFixed(1), padL - 5, y + 3);
  }
  ctx.textAlign = "center";
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const t = d0 + span * i / ticks;
    ctx.fillText(st.opts.fmtX ? st.opts.fmtX(t) : String(Math.round(t)), X(t), h - 4);
  }
  st.points.forEach((p, i) => {
    if (p.t < d0 || p.t > d1) return;
    const dim = st.hover >= 0 && st.hover !== i;
    ctx.beginPath();
    ctx.arc(X(p.t), Y(p.y), st.hover === i ? 5 : 3, 0, 7);
    ctx.fillStyle = `rgba(${cssColorTriplet(p.color)},${dim ? 0.15 : 0.85})`;
    ctx.fill();
  });
  if (st.hover >= 0 && st.points[st.hover]) {
    const p = st.points[st.hover];
    ctx.fillStyle = `rgb(${cssColorTriplet("var(--ink-1)")})`;
    ctx.font = "600 10px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(p.label || `${p.y}`, Math.min(X(p.t) + 8, w - 150), Y(p.y) - 8);
  }
  if (st.brush) {
    const [a, b] = st.brush;
    const accent = cssColorTriplet("var(--s1)");
    ctx.fillStyle = `rgba(${accent},.12)`;
    ctx.fillRect(Math.min(a, b), padT, Math.abs(b - a), h - padT - padB);
    ctx.strokeStyle = `rgba(${accent},.5)`;
    ctx.strokeRect(Math.min(a, b), padT, Math.abs(b - a), h - padT - padB);
  }
}
