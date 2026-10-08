/* Hermes Metrics — SVG chart builders (speed, volume, host, context, efficiency). */
"use strict";

/* ---------- shared axis scaffold ----------
   Every chart gets the same viewBox, horizontal gridlines with end-anchored
   value labels, centered x tick labels, and a y=0 baseline. Per-chart padding,
   label offsets, tick sets, and (for log scales) a custom x keep each chart's
   existing visual output while deduplicating the scaffold. */
function makeAxes({ svg, W, H, pad, x0 = 0, x1 = 1, ymax = 1, xticks = [], yticks = [], fmtX = String, fmtY = String, x = null, fontSize = "10.5", xLabelY = null, yLabelDx = -7 }) {
  const { l: padL, r: padR, t: padT, b: padB } = pad;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  if (!x) x = v => padL + (v - x0) / (x1 - x0) * (W - padL - padR);
  const y = v => padT + (1 - v/ymax) * (H - padT - padB);
  let g = "";
  for (const v of yticks) {
    const yy = y(v);
    g += `<line x1="${padL}" y1="${yy}" x2="${W-padR}" y2="${yy}" stroke="var(--grid)" stroke-width="1"/>`
       + `<text x="${padL + yLabelDx}" y="${yy+4}" text-anchor="end" font-size="${fontSize}" fill="var(--ink-3)">${fmtY(v)}</text>`;
  }
  const labelY = xLabelY ?? (H - 6);
  for (const v of xticks) {
    g += `<text x="${x(v)}" y="${labelY}" text-anchor="middle" font-size="${fontSize}" fill="var(--ink-3)">${fmtX(v)}</text>`;
  }
  g += `<line x1="${padL}" y1="${y(0)}" x2="${W-padR}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>`;
  return { x, y, g, padL, padR, padT, padB };
}
function evenlySpaced(indices, count) {
  if (count <= 0 || !indices.length) return [];
  if (indices.length <= count) return indices;
  if (count === 1) return [indices[Math.floor(indices.length / 2)]];
  return Array.from({ length: count }, (_, i) =>
    indices[Math.round(i * (indices.length - 1) / (count - 1))]
  );
}
function downsampleRecords(source, limit, valueKeys = []) {
  if (source.length <= limit) return source.slice();
  const selected = new Set([0, source.length - 1]);
  const errors = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i].kind === "error") errors.push(i);
  }
  const extremaReserve = Math.min(valueKeys.length * 2, Math.max(0, limit - selected.size));
  const errorBudget = Math.max(0, limit - selected.size - extremaReserve);
  for (const index of evenlySpaced(errors, errorBudget)) selected.add(index);
  for (const key of valueKeys) {
    let minIndex = -1, maxIndex = -1, minValue = Infinity, maxValue = -Infinity;
    for (let i = 0; i < source.length; i++) {
      const value = Number(source[i][key]);
      if (!Number.isFinite(value)) continue;
      if (value < minValue) { minValue = value; minIndex = i; }
      if (value > maxValue) { maxValue = value; maxIndex = i; }
    }
    if (minIndex >= 0 && selected.size < limit) selected.add(minIndex);
    if (maxIndex >= 0 && selected.size < limit) selected.add(maxIndex);
  }
  const allIndices = Array.from({ length: source.length }, (_, i) => i);
  for (const index of evenlySpaced(allIndices, limit)) {
    if (selected.size >= limit) break;
    selected.add(index);
  }
  if (selected.size < limit) {
    for (let i = 0; i < source.length && selected.size < limit; i++) selected.add(i);
  }
  return [...selected].sort((a, b) => a - b).map(index => source[index]);
}
function setSvgContent(svg, id, title, description, content) {
  svg.innerHTML = `<title id="${id}-title">${esc(title)}</title><desc id="${id}-desc">${esc(description)}</desc>${content}`;
}
function activeChartIndex(chartId, count) {
  const activeIndex = Math.max(0, Math.min(chartRovingIndex.get(chartId) || 0, Math.max(count - 1, 0)));
  chartRovingIndex.set(chartId, activeIndex);
  return activeIndex;
}
function chartMarkAttributes(chartId, index, activeIndex, label, focusKey) {
  return `class="chart-mark" role="img" tabindex="${index === activeIndex ? "0" : "-1"}" data-chart-id="${chartId}" data-point-index="${index}" ${focusKeyAttribute("chart-point", focusKey)} aria-label="${esc(label)}"`;
}
function fmtTick(ts) {
  const span = curWin[1] - curWin[0];
  const d = new Date(ts*1000);
  return span > 36*3600
    ? d.toLocaleString([], {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"})
    : d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
}

/* ---------- chart (scatter over time, one y axis, per-mark tooltip) ---------- */
let chartPts = [];
let chartScale = null;    // last render's { x, y, t0, t1, W, H, pads } for pointer math
let chartSeries = [];     // last render's [{ model, color, points:[{ts,v,r}] }] for the crosshair
function metricValue(value, selectedMetric = metric) {
  if (selectedMetric === "output_tokens") return fmtTok(value);
  if (selectedMetric === "duration_s") return fmtDuration(value);
  return `${fmt1(value)} tokens per second`;
}
function requestPointLabel(r) {
  if (r.kind === "error") return `${r.model || "unknown model"}, failed request at ${fmtTime(r.ts)}: ${r.error || "no error message"}`;
  return `${r.model || "unknown model"}, ${metricLabel[metric]} ${metricValue(r[metric])}, ${fmtTime(r.ts)}, ${r.host || "unknown host"}`;
}
function renderRequestTip(best) {
  const r = best.r;
  return `<div class="t-model"><span class="msw" style="background:${colorFor(r.model)}"></span>${esc(r.model||"?")}</div>`
    + `<div class="row"><span>${esc(KINDNAME[r.kind]||r.kind)} · ${esc(r.host||"")}</span><b>${fmtTime(r.ts)}</b></div>`
    + `<div class="row"><span>tokens in / out</span><b>${fmtTok(r.input_tokens)} / ${fmtTok(r.output_tokens)}</b></div>`
    + (r.cache_read_tokens ? `<div class="row"><span>cache read</span><b>${fmtTok(r.cache_read_tokens)}</b></div>` : "")
    + (r.reasoning_tokens ? `<div class="row"><span>reasoning</span><b>${fmtTok(r.reasoning_tokens)}</b></div>` : "")
    + `<div class="row"><span>duration</span><b>${fmtDuration(r.duration_s)}</b></div>`
    + `<div class="row"><span>speed</span><b>${fmt1(r.tps)} tok/s</b></div>`
    // R4: ttft / native tps / spec-decode stay hidden unless a backend populates them.
    + (r.ttft_s ? `<div class="row"><span>TTFT</span><b>${fmt1(r.ttft_s)}s</b></div>` : "")
    + (r.tps_native ? `<div class="row"><span>native speed</span><b>${fmt1(r.tps_native)} tok/s</b></div>` : "")
    + (r.spec_accept_rate ? `<div class="row"><span>spec accept</span><b>${Math.round(r.spec_accept_rate*100)}%</b></div>` : "")
    + (r.device ? `<div class="row"><span>served by</span><b>${esc(r.device)}</b></div>` : "")
    + `<div class="row"><span>conversation</span><b>${esc(shortSess(r.session_title || r.session_id))}</b></div>`
    + (r.error ? `<div class="row"><span style="color:var(--critical)">error</span><b>${esc(String(r.error).slice(0,60))}</b></div>` : "");
}
function effectiveChartDomain() {
  const [w0, w1] = curWin;
  if (chartZoom && chartZoom[1] > w0 && chartZoom[0] < w1 && chartZoom[1] - chartZoom[0] > 0) {
    return [Math.max(w0, chartZoom[0]), Math.min(w1, chartZoom[1])];
  }
  return [w0, w1];
}
function setChartZoom(domain) {
  chartZoom = domain;
  const btn = $("chartzoomreset");
  if (btn) btn.hidden = !domain;
  writeHashState();
}
function renderChart(rs) {
  const svg = $("chart");
  const W = svg.clientWidth || 900, H = 260;
  // A zoom that no longer overlaps the window (range changed) auto-clears.
  if (chartZoom && (chartZoom[1] <= curWin[0] || chartZoom[0] >= curWin[1])) setChartZoom(null);
  const [t0, t1] = effectiveChartDomain();
  const zoomBtn = $("chartzoomreset");
  if (zoomBtn) zoomBtn.hidden = !chartZoom;
  const candidates = rs.filter(r =>
    r.kind === "error" || (REQUEST_KINDS.includes(r.kind) && r[metric] > 0)
  );
  const sampled = downsampleRecords(candidates, SVG_POINT_LIMIT, [metric]);
  const allModels = [...new Set(sampled.filter(r => r.kind !== "error").map(r => r.model).filter(Boolean))];
  const visible = r => !hiddenSeries.has(r.model || "?");
  const inDomain = r => r.ts >= t0 && r.ts <= t1;
  const pts = sampled.filter(r => r.kind !== "error" && visible(r) && inDomain(r));
  const errors = sampled.filter(r => r.kind === "error" && inDomain(r));
  const activeIndex = activeChartIndex("chart", pts.length + errors.length);
  const ymax = Math.max(1, ...pts.map(r => r[metric])) * 1.08;
  const axes = makeAxes({
    svg, W, H, pad: { l: 46, r: 12, t: 10, b: 22 }, x0: t0, x1: t1, ymax,
    xticks: Array.from({ length: 7 }, (_, i) => t0 + (t1-t0)*i/6),
    yticks: Array.from({ length: 5 }, (_, i) => ymax * i/4),
    fmtX: fmtTick,
    fmtY: v => metric === "duration_s" ? fmtDuration(v) : v >= 1000 ? fmtTok(v) : Math.round(v*10)/10,
  });
  const { x, y, padT, padB } = axes;
  chartScale = { x, y, t0, t1, W, H, padL: 46, padR: 12, padT, padB };
  let g = axes.g;
  // Regime markers (R6 + N16): env-mode changes redefine what "good" t/s is;
  // experiment marks tie config changes to the t/s they produced.
  const regimeMarkers = [];
  if (envModeStatus && Number(envModeStatus.active_mode_ts) >= t0 && Number(envModeStatus.active_mode_ts) <= t1) {
    regimeMarkers.push({ ts: Number(envModeStatus.active_mode_ts), label: `env → ${envModeStatus.active_mode || "?"}`, color: "var(--warn)", dash: "5 4" });
  }
  for (const mark of benchmarkMarks.slice(0, 6)) {  // API returns newest first
    const ts = Number(mark && mark.ts);
    if (Number.isFinite(ts) && ts >= t0 && ts <= t1) {
      regimeMarkers.push({ ts, label: `▼ ${mark.label || "mark"}`, color: "var(--s2)", dash: "2 3" });
    }
  }
  for (const m of regimeMarkers) {
    const mx = x(m.ts);
    const text = m.label.length > 34 ? m.label.slice(0, 33) + "…" : m.label;
    g += `<line x1="${mx.toFixed(1)}" y1="${padT}" x2="${mx.toFixed(1)}" y2="${y(0)}" stroke="${m.color}" stroke-width="1.5" stroke-dasharray="${m.dash}"/>`
       + `<text x="${(mx + 4).toFixed(1)}" y="${padT + 10}" font-size="10.5" fill="${m.color}" paint-order="stroke" stroke="var(--surface-1)" stroke-width="3">${esc(text)}</text>`;
  }
  // Group by model: a 2px line connects each model's successive requests so
  // progression over time is readable; dots stay as the per-request marks.
  // Each model is one <g class="series"> so feed-row hover can dim the rest.
  const byModel = new Map();
  for (const r of pts) {
    const key = r.model || "?";
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(r);
  }
  const activeModels = new Set(byModel.keys());
  ensureSlotsForModels(
    [...byModel.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([m]) => m),
    activeModels
  );
  chartPts = [];
  chartSeries = [];
  let labels = "";
  const labelable = [...byModel.entries()].sort((a,b) => b[1].length - a[1].length).slice(0,4).map(e => e[0]);
  for (const [m, list] of byModel) {
    list.sort((a,b) => a.ts - b.ts);
    const col = colorFor(m, activeModels);
    chartSeries.push({ model: m, color: col, points: list.map(r => ({ ts: r.ts, v: r[metric], r })) });
    const dimmed = chartHighlightModel && chartHighlightModel !== m;
    let sg = "";
    if (list.length > 1) {
      const path = list.map(r => `${x(r.ts).toFixed(1)},${y(r[metric]).toFixed(1)}`).join(" ");
      sg += `<polyline points="${path}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" opacity="0.8"/>`;
    }
    for (const r of list) {
      const cx = x(r.ts), cy = y(r[metric]);
      const index = chartPts.length;
      chartPts.push({ cx, cy, r });
      sg += `<circle ${chartMarkAttributes("chart", index, activeIndex, requestPointLabel(r), `request:${stableRecordKey(r)}`)} cx="${cx}" cy="${cy}" r="4" fill="${col}" stroke="var(--surface-1)" stroke-width="2"/>`;
    }
    g += `<g class="series" data-model="${esc(m)}"${dimmed ? ' opacity="0.15"' : ""}>${sg}</g>`;
    if (labelable.includes(m)) {
      const last = list[list.length - 1];
      const lx = x(last.ts), ly = Math.max(y(last[metric]) - 8, padT + 8);
      const anchor = lx > W - 170 ? "end" : "start";
      const tx = anchor === "start" ? lx + 7 : lx - 7;
      const name = m.length > 26 ? m.slice(0, 25) + "…" : m;
      labels += `<text x="${tx}" y="${ly}" text-anchor="${anchor}" font-size="10.5" fill="var(--ink-2)" paint-order="stroke" stroke="var(--surface-1)" stroke-width="3">${esc(name)}</text>`;
    }
  }
  // Failed requests: × marks along the baseline in the critical status color,
  // hoverable like any point (never colored as a series).
  for (const r of errors) {
    const cx = x(r.ts), cy = y(0) - 7;
    const index = chartPts.length;
    chartPts.push({ cx, cy, r });
    g += `<path ${chartMarkAttributes("chart", index, activeIndex, requestPointLabel(r), `request:${stableRecordKey(r)}`)} d="M${cx-4},${cy-4} L${cx+4},${cy+4} M${cx-4},${cy+4} L${cx+4},${cy-4}" stroke="var(--critical)" stroke-width="2" stroke-linecap="round"/>`;
  }
  g += labels;
  if (!pts.length) g += `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12.5" fill="var(--ink-3)">no requests in range</text>`;
  // Brush-selection rect + hover crosshair live above the marks (updated by
  // the pointer handlers below; rebuilt empty on each render).
  g += `<rect class="brushsel" style="display:none" aria-hidden="true"></rect>`
     + `<g class="crosshair" style="display:none" aria-hidden="true"></g>`;
  $("charttitle").textContent = metricLabel[metric] + " per request";
  setSvgContent(
    svg, "chart", $("charttitle").textContent,
    "Per-request metric over time, colored by model, with failed requests marked at the baseline.", g
  );
  // Legend chips are visibility toggles (clean-design): .off hides the series
  // from the chart without touching the dashboard-wide model filter.
  $("legend").innerHTML = allModels.map(m =>
    `<button class="chip mchip${hiddenSeries.has(m) ? " off" : ""}" type="button" data-model="${esc(m)}" ${focusKeyAttribute("chart-model", m)} aria-pressed="${!hiddenSeries.has(m)}" title="Toggle the ${esc(m)} series" style="border:0;padding:0"><span class="sw" style="background:${colorFor(m)}"></span>${esc(m)}</button>`).join("");
}
attachChartInspector("chartwrap", "tooltip", () => chartPts, renderRequestTip, false, { pointer: false });

/* ---------- main-chart pointer layer: crosshair + brush-to-zoom ----------
   Keyboard access stays with the inspector above (roving marks + focus tips);
   pointer input gets the demo's crosshair with per-series values and a
   drag-to-select zoom. Mouse-only brushing — touch keeps pan/keyboard paths. */
function chartSvgX(clientX) {
  const svg = $("chart");
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return (clientX - rect.left) * (vb.width / rect.width);
}
/* Shared SVG crosshair (main chart + context growth, P3b): vertical line,
   nearest-point dots per series, stacked value labels. view = { scale, series,
   fmt } where series = [{ model, color, points: [{ ts, v }] }]. */
function svgXFor(svgId, clientX) {
  const svg = $(svgId);
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  return (clientX - rect.left) * (vb.width / rect.width);
}
function hideSvgCrosshair(svgId) {
  const svg = $(svgId);
  const g = svg && svg.querySelector ? svg.querySelector(".crosshair") : null;
  if (g) g.style.display = "none";
}
function svgCrosshairFrame(view, sx) {
  const { y, t0, t1, W, H, padL, padR, padT, padB } = view.scale;
  if (sx < padL - 4 || sx > W - padR + 4) return null;
  const ts = t0 + (sx - padL) / (W - padL - padR) * (t1 - t0);
  const tol = (t1 - t0) / 40;
  const rows = [];
  for (const s of view.series) {
    let best = null, bestD = Infinity;
    for (const p of s.points) {
      const d = Math.abs(p.ts - ts);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best || bestD > tol) continue;
    const name = s.model.length > 24 ? s.model.slice(0, 23) + "…" : s.model;
    rows.push({ color: s.color, y: y(best.v), label: `${name} · ${view.fmt(best.v)}` });
  }
  // No nearby points still shows the bare line: the crosshair is synced
  // across charts, so a gap in one chart must not blank the shared marker.
  return { ts, rows, H, padT, padB, W, sx };
}
function svgCrosshairRender(g, frame) {
  if (!frame) { g.style.display = "none"; return; }
  let html = `<line x1="${frame.sx.toFixed(1)}" y1="${frame.padT}" x2="${frame.sx.toFixed(1)}" y2="${frame.H - frame.padB}"/>`;
  let ty = frame.padT + 10;
  for (const row of frame.rows) {
    const endAnchor = frame.sx > frame.W - 200;
    html += `<circle cx="${frame.sx.toFixed(1)}" cy="${row.y.toFixed(1)}" r="3.5" fill="${row.color}"/>`
      + `<text x="${(endAnchor ? frame.sx - 7 : frame.sx + 7).toFixed(1)}" y="${ty}" text-anchor="${endAnchor ? "end" : "start"}">${esc(row.label)}</text>`;
    ty += 12;
  }
  html += `<text class="chtime" x="${frame.sx.toFixed(1)}" y="${frame.H - 4}" text-anchor="middle">${esc(fmtTick(frame.ts))}</text>`;
  g.innerHTML = html;
  g.style.display = "block";
}
/* Synced crosshair registry: pointer hover on any attached time-domain
   chart computes a timestamp, and every registered chart draws its
   crosshair at that same ts. Tooltips stay per-chart (only the hovered
   chart shows one); only the vertical line syncs. */
const crosshairCharts = new Map();   // svgId -> getView
function svgXToTs(scale, sx) {
  return scale.t0 + (sx - scale.padL) / (scale.W - scale.padL - scale.padR) * (scale.t1 - scale.t0);
}
function svgTsToX(scale, ts) {
  return scale.padL + (ts - scale.t0) / (scale.t1 - scale.t0) * (scale.W - scale.padL - scale.padR);
}
function syncSvgCrosshairs(ts) {
  for (const [svgId, getView] of crosshairCharts) {
    const view = getView();
    if (!view || !view.scale) continue;
    const svg = $(svgId);
    const g = svg && svg.querySelector ? svg.querySelector(".crosshair") : null;
    if (!g) continue;
    svgCrosshairRender(g, svgCrosshairFrame(view, svgTsToX(view.scale, ts)));
  }
}
function hideAllSvgCrosshairs() {
  for (const svgId of crosshairCharts.keys()) hideSvgCrosshair(svgId);
}
function attachSvgCrosshair(wrapId, svgId, getView) {
  const wrap = $(wrapId);
  if (!wrap || wrap.dataset.crosshairBound) return;
  wrap.dataset.crosshairBound = "1";
  crosshairCharts.set(svgId, getView);
  wrap.addEventListener("pointermove", ev => {
    if (ev.pointerType === "touch") return;
    const view = getView();
    if (!view || !view.scale) return;
    syncSvgCrosshairs(svgXToTs(view.scale, svgXFor(svgId, ev.clientX)));
  });
  wrap.addEventListener("pointerleave", ev => {
    if (ev.pointerType !== "touch") hideAllSvgCrosshairs();
  });
}
function hideMainCrosshair() { hideAllSvgCrosshairs(); }
function updateMainCrosshair(clientX) {
  if (!chartScale) return;
  syncSvgCrosshairs(svgXToTs(chartScale, chartSvgX(clientX)));
}
let chartBrush = null;   // { x0, x1 } in viewBox units while dragging
function updateBrushRect() {
  const svg = $("chart");
  const rect = svg && svg.querySelector ? svg.querySelector(".brushsel") : null;
  if (!rect || !chartScale) return;
  if (!chartBrush) { rect.style.display = "none"; return; }
  const bx = Math.min(chartBrush.x0, chartBrush.x1), bw = Math.abs(chartBrush.x1 - chartBrush.x0);
  rect.setAttribute("x", bx.toFixed(1));
  rect.setAttribute("y", String(chartScale.padT));
  rect.setAttribute("width", bw.toFixed(1));
  rect.setAttribute("height", String(chartScale.H - chartScale.padT - chartScale.padB));
  rect.style.display = "block";
}
function attachMainChartInteractions() {
  const wrap = $("chartwrap");
  if (!wrap || wrap.dataset.mainBound) return;
  wrap.dataset.mainBound = "1";
  crosshairCharts.set("chart", () => ({ scale: chartScale, series: chartSeries, fmt: v => `${fmt1(v)} ${metricLabel[metric]}` }));
  wrap.addEventListener("pointermove", ev => {
    if (ev.pointerType === "touch") return;
    if (chartBrush) {
      chartBrush.x1 = chartSvgX(ev.clientX);
      updateBrushRect();
    }
    updateMainCrosshair(ev.clientX);
  });
  wrap.addEventListener("pointerleave", ev => {
    if (ev.pointerType !== "touch") hideMainCrosshair();
  });
  wrap.addEventListener("pointerdown", ev => {
    if (ev.pointerType !== "mouse" || ev.button !== 0 || !chartScale) return;
    chartBrush = { x0: chartSvgX(ev.clientX), x1: chartSvgX(ev.clientX) };
    if (wrap.setPointerCapture) {
      try { wrap.setPointerCapture(ev.pointerId); } catch (e) {}
    }
    updateBrushRect();
    ev.preventDefault();
  });
  wrap.addEventListener("pointerup", ev => {
    if (!chartBrush || !chartScale) return;
    const brush = chartBrush;
    chartBrush = null;
    updateBrushRect();
    const { t0, t1, padL, padR, W } = chartScale;
    const toTs = px => t0 + (px - padL) / (W - padL - padR) * (t1 - t0);
    let a = toTs(Math.min(brush.x0, brush.x1));
    let b = toTs(Math.max(brush.x0, brush.x1));
    if (b - a < (t1 - t0) * 0.02) return;   // a click, not a zoom drag
    a = Math.max(t0, a);
    b = Math.min(t1, b);
    if (b - a <= 0) return;
    setChartZoom([a, b]);
    renderChart(filteredRecords());
  });
  const reset = $("chartzoomreset");
  if (reset && !reset.dataset.bound) {
    reset.dataset.bound = "1";
    reset.addEventListener("click", () => {
      setChartZoom(null);
      renderChart(filteredRecords());
    });
  }
}
attachMainChartInteractions();

/* ---------- token volume (time bins stacked by model) ---------- */
let volBins = [];
function tokVal(r) { return volMode === "out" ? (r.output_tokens || 0) : (r.input_tokens || 0) + (r.output_tokens || 0); }
function volumeColor(model) { return colorFor(model); }
function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}
function volumeBinLabel(bin) {
  const models = [...bin.parts].reverse().map(([model, value]) => `${model} ${fmtTok(value)}`).join(", ");
  return `${fmtTime(bin.t)} to ${fmtTime(bin.t + bin.binSec)}, total ${fmtTok(bin.total)} tokens: ${models}`;
}
function renderVolumeTip(bin) {
  const rows = [...bin.parts].reverse().map(([m, v]) =>
    `<div class="row"><span><span class="msw" style="background:${volumeColor(m)}"></span>${esc(m.length > 30 ? m.slice(0,29) + "…" : m)}</span><b>${fmtTok(v)}</b></div>`).join("");
  return `<div class="t-model">${fmtTime(bin.t)} – ${fmtTime(bin.t + bin.binSec)}</div>`
    + rows + `<div class="row" style="margin-top:3px"><span>total</span><b>${fmtTok(bin.total)}</b></div>`;
}
function renderVolume(rs) {
  const svg = $("volchart");
  const W = svg.clientWidth || 900, H = 190;
  const [t0, t1] = curWin;
  const span = t1 - t0;
  const baseBinSec = span <= 2*3600 ? 120 : span <= 8*3600 ? 600 : span <= 36*3600 ? 1800
                   : span <= 8*86400 ? 7200 : 86400;
  const binSec = Math.max(baseBinSec, Math.ceil(span / MAX_VOLUME_BINS));
  const nbins = Math.ceil(span / binSec);
  const pts = rs.filter(r => REQUEST_KINDS.includes(r.kind) && tokVal(r) > 0);
  const volumeByModel = new Map();
  for (const r of pts) {
    const model = r.model || "?";
    volumeByModel.set(model, (volumeByModel.get(model) || 0) + tokVal(r));
  }
  const activeModels = new Set(volumeByModel.keys());
  const ranked = [...activeModels].sort((a, b) => (volumeByModel.get(b) - volumeByModel.get(a)) || a.localeCompare(b));
  ensureSlotsForModels(ranked, activeModels);
  const bins = Array.from({length: nbins}, () => new Map());
  for (const r of pts) {
    const i = Math.min(Math.floor((r.ts - t0) / binSec), nbins - 1);
    if (i < 0) continue;
    const model = r.model || "?";
    // Keep real model names — never fold into an opaque "Other" bucket.
    // Overflow models may share the muted --other color via colorFor(), but stay labeled.
    bins[i].set(model, (bins[i].get(model) || 0) + tokVal(r));
  }
  const totals = bins.map(b => [...b.values()].reduce((a,v) => a+v, 0));
  const activeIndex = activeChartIndex("volchart", bins.filter(bin => bin.size).length);
  const ymax = Math.max(1, ...totals) * 1.08;
  const axes = makeAxes({
    svg, W, H, pad: { l: 46, r: 12, t: 8, b: 22 }, x0: t0, x1: t1, ymax,
    xticks: Array.from({ length: 7 }, (_, i) => t0 + span*i/6),
    yticks: [1, 2, 3].map(i => ymax * i/3),
    fmtX: fmtTick, fmtY: fmtTok,
  });
  const { y, padL, padR } = axes;
  const plotW = W - padL - padR, barSlot = plotW / nbins;
  const barW = Math.max(barSlot - 2, 1.5);
  let g = axes.g;
  // Stable stacking order: color-slot order, then name — segments never reshuffle.
  const slotOf = m => { const s = slotMap[m]; return s == null || s < 0 ? 99 : s; };
  volBins = [];
  for (let i = 0; i < nbins; i++) {
    if (!bins[i].size) continue;
    const bx = padL + i * barSlot + (barSlot - barW) / 2;
    const parts = [...bins[i].entries()].sort((a,b) => slotOf(a[0]) - slotOf(b[0]) || a[0].localeCompare(b[0]));
    const total = [...parts].reduce((sum, [, value]) => sum + value, 0);
    const bin = {
      x0: bx - 1, x1: bx + barW + 1, cx: bx + barW / 2, cy: y(total),
      t: t0 + i * binSec, binSec, parts, total, binIndex: i
    };
    const pointIndex = volBins.length;
    let cum = 0;
    // One <g> per bin so hover can isolate it (dim the rest) — demo drawBars.
    let binG = "";
    parts.forEach(([m, v], idx) => {
      const yTop = y(cum + v), yBot = y(cum);
      const top = idx === parts.length - 1;
      const gap = top ? 0 : 2;                      /* 2px surface gap between segments */
      const h = Math.max(yBot - yTop - gap, 1);
      binG += top
        ? `<path ${chartMarkAttributes("volchart", pointIndex, activeIndex, volumeBinLabel(bin), `volume:${bin.t}`)} d="${roundedTopRect(bx, yTop, barW, h, 3)}" fill="${volumeColor(m)}"/>`
        : `<rect x="${bx}" y="${yTop + gap}" width="${barW}" height="${h}" fill="${volumeColor(m)}"/>`;
      cum += v;
    });
    g += `<g class="volbin" data-bin="${i}">${binG}</g>`;
    volBins.push(bin);
  }
  if (!volBins.length) g += `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12.5" fill="var(--ink-3)">no tokens in range</text>`;
  setSvgContent(
    svg, "volchart", "Token volume over time",
    "Token totals in time buckets, stacked and colored by model.", g
  );
  const models = [...new Set(bins.flatMap(bin => [...bin.keys()]))].sort((a,b) => slotOf(a) - slotOf(b) || a.localeCompare(b));
  $("vollegend").innerHTML = models.map(m =>
    `<button class="mchip${m === modelFilter ? " active" : ""}" type="button" data-model="${esc(m)}" ${focusKeyAttribute("volume-model", m)} aria-pressed="${m === modelFilter}" title="${esc(m)}"><span class="sw" style="background:${volumeColor(m)}"></span>${esc(m)}</button>`
  ).join("");
}
/* Per-bar hover emphasis (demo drawBars): the hovered bin stays solid, the
   rest dim via CSS classes on the svg root + bin groups. */
function setVolumeHoverBin(point) {
  const svg = $("volchart");
  if (!svg || !svg.querySelectorAll) return;
  const idx = point ? point.binIndex : -1;
  svg.classList.toggle("has-hover", idx >= 0);
  for (const g of svg.querySelectorAll(".volbin")) {
    g.classList.toggle("hover", Number(g.dataset.bin) === idx);
  }
}
attachChartInspector("volwrap", "voltip", () => volBins, renderVolumeTip, true, { onPoint: setVolumeHoverBin });

/* ---------- host resources (P3a: per-host dual joint-hover canvases) ----------
   The two static SVGs became one canvas per host carrying CPU + RAM with the
   fleet's joint-hover component. Canvases are focusable with an aria-label
   summary; latest values stay visible inline next to the host name. */
function hostColor(h, hosts) { return `var(${HOSTSLOTS[hosts.indexOf(h) % HOSTSLOTS.length]})`; }
function renderHosts(rs) {
  const recs = rs.filter(r => r.kind === "host_stats" && r.host);
  const hosts = [...new Set(recs.map(r => r.host))].sort();
  $("hostlegend").innerHTML = hosts.map(h =>
    `<span class="hchip"><span class="hsw" style="background:${hostColor(h, hosts)}"></span>${esc(h)}</span>`).join("");
  const el = $("hostres");
  if (!el) return;
  if (!hosts.length) {
    el.innerHTML = `<div class="empty">no host samples yet</div>`;
    return;
  }
  const seriesByHost = new Map();
  el.innerHTML = hosts.map(h => {
    const pairs = [];
    for (const r of recs) {
      if (r.host !== h) continue;
      if (r.cpu_load != null && r.mem_used_gb != null) pairs.push([r.ts, r.cpu_load, r.mem_used_gb]);
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const step = Math.max(1, Math.ceil(pairs.length / 120));
    const sampled = pairs.filter((_, i) => i % step === 0);
    seriesByHost.set(h, {
      cpu: sampled.map(([t, v]) => [t, v]),
      ram: sampled.map(([t, , v]) => [t, v]),
    });
    const lastRec = recs.filter(r => r.host === h).slice(-1)[0] || {};
    const label = lastRec.cpu_load != null
      ? `latest CPU ${fmt1(lastRec.cpu_load)} · RAM ${fmt1(lastRec.mem_used_gb)}/${fmt1(lastRec.mem_total_gb)} GB`
      : "no samples in range";
    return `<div class="hostres-row">
      <div class="hostres-head"><span class="hchip"><span class="hsw" style="background:${hostColor(h, hosts)}"></span>${esc(h)}</span><span class="hostres-latest">${esc(label)}</span></div>
      <canvas class="hostres-canvas" data-host="${esc(h)}" tabindex="0" role="img"
        aria-label="${esc(`CPU load and memory used over the selected range for ${h}; ${label}`)}"></canvas>
    </div>`;
  }).join("");
  for (const cv of el.querySelectorAll("canvas.hostres-canvas")) {
    const series = seriesByHost.get(cv.dataset.host);
    if (!series) continue;
    canvasDualSparkline(cv,
      { name: "CPU", color: "var(--s1)", data: series.cpu, fmt: v => fmt1(v) },
      { name: "RAM", color: "var(--s2)", data: series.ram, fmt: v => `${fmt1(v)} GB` });
  }
}

/* ---------- context growth (input tokens per call, line per conversation) ---------- */
let ctxPts = [];
let ctxScale = null;
let ctxSeries = [];
function renderCtx(rs) {
  const svg = $("ctxchart");
  const W = svg.clientWidth || 600, H = 220;
  const [t0, t1] = curWin;
  const pts = rs.filter(r => ["api","moa_turn"].includes(r.kind) && r.input_tokens > 0);
  const byConvo = new Map();
  for (const r of pts) {
    const root = r.parent_session_id || r.session_id;
    if (!byConvo.has(root)) byConvo.set(root, []);
    byConvo.get(root).push(r);
  }
  const convos = [...byConvo.entries()].sort((a,b) => Math.max(...b[1].map(r=>r.ts)) - Math.max(...a[1].map(r=>r.ts))).slice(0, 8);
  const perConversationLimit = Math.floor(SVG_POINT_LIMIT / Math.max(convos.length, 1));
  const renderedConvos = convos.map(([root, source], ci) => [
    root,
    downsampleRecords([...source].sort((a,b) => a.ts - b.ts), perConversationLimit, ["input_tokens"]),
    ci
  ]);
  const renderedCount = renderedConvos.reduce((total, [, list]) => total + list.length, 0);
  const activeIndex = activeChartIndex("ctxchart", renderedCount);
  const ymax = Math.max(1, ...pts.map(r => r.input_tokens)) * 1.08;
  const axes = makeAxes({
    svg, W, H, pad: { l: 48, r: 12, t: 10, b: 20 }, x0: t0, x1: t1, ymax,
    xticks: Array.from({ length: 5 }, (_, i) => t0 + (t1-t0)*i/4),
    yticks: [1, 2, 3].map(i => ymax * i/3),
    fmtX: fmtTick, fmtY: fmtTok, xLabelY: H - 5,
  });
  const { x, y } = axes;
  ctxScale = { x, y, t0, t1, W, H, padL: 48, padR: 12, padT: 10, padB: 20 };
  let g = axes.g;
  ctxPts = [];
  ctxSeries = [];
  renderedConvos.forEach(([root, list, ci]) => {
    const op = ci === 0 ? 0.95 : 0.45;  // newest conversation highlighted
    if (list.length > 1) {
      g += `<polyline points="${list.map(r => `${x(r.ts).toFixed(1)},${y(r.input_tokens).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--s1)" stroke-width="2" opacity="${op}" stroke-linejoin="round"/>`;
    }
    const label = list.length ? shortSess(list[0].session_title || root) : shortSess(root);
    ctxSeries.push({ model: label, color: "var(--s1)", points: list.map(r => ({ ts: r.ts, v: r.input_tokens, r })) });
    for (const r of list) {
      const cx = x(r.ts), cy = y(r.input_tokens);
      const index = ctxPts.length;
      ctxPts.push({ cx, cy, r });
      const pointLabel = `${shortSess(r.session_title || r.session_id)}, ${fmtTok(r.input_tokens)} input tokens, ${fmtTime(r.ts)}, ${r.model || "unknown model"}`;
      g += `<circle ${chartMarkAttributes("ctxchart", index, activeIndex, pointLabel, `context:${stableRecordKey(r)}`)} cx="${cx}" cy="${cy}" r="3.5" fill="var(--s1)" opacity="${op}" stroke="var(--surface-1)" stroke-width="2"/>`;
    }
    // Compaction markers, computed on the full record list so downsampling
    // can't hide a drop: context shrank >=15% and >=4k between calls.
    const full = [...byConvo.get(root)].sort((a, b) => a.ts - b.ts);
    for (let i = 1; i < full.length; i++) {
      const prev = full[i - 1], cur = full[i];
      if (cur.input_tokens < prev.input_tokens * 0.85 && prev.input_tokens - cur.input_tokens >= 4000) {
        const mx = x(cur.ts), my = y(cur.input_tokens);
        g += `<path d="M${(mx - 5).toFixed(1)} ${(my - 11).toFixed(1)} L${(mx + 5).toFixed(1)} ${(my - 11).toFixed(1)} L${mx.toFixed(1)} ${(my - 3).toFixed(1)} Z" fill="var(--good)" stroke="var(--surface-1)" stroke-width="1" opacity="${op}"><title>compaction ${fmtTok(prev.input_tokens)} \u2192 ${fmtTok(cur.input_tokens)} \u00b7 ${fmtTime(cur.ts)}</title></path>`;
      }
    }
  });
  // Failed requests: \u2715 at the conversation's nearest context level.
  const renderedRoots = new Map(renderedConvos.map(([root, list]) => [root, list]));
  for (const e of rs) {
    if (e.kind !== "error") continue;
    const eroot = e.parent_session_id || e.session_id;
    const list = renderedRoots.get(eroot);
    if (!list || !list.length) continue;
    let near = list[0];
    for (const r of list) if (Math.abs(r.ts - e.ts) < Math.abs(near.ts - e.ts)) near = r;
    const ex = x(Math.min(Math.max(e.ts, t0), t1)), ey = y(near.input_tokens);
    g += `<g stroke="var(--critical)" stroke-width="2" opacity="0.9"><line x1="${(ex - 4).toFixed(1)}" y1="${(ey - 4).toFixed(1)}" x2="${(ex + 4).toFixed(1)}" y2="${(ey + 4).toFixed(1)}"/><line x1="${(ex - 4).toFixed(1)}" y1="${(ey + 4).toFixed(1)}" x2="${(ex + 4).toFixed(1)}" y2="${(ey - 4).toFixed(1)}"/><title>${esc(e.error || "request failed")} \u00b7 ${fmtTime(e.ts)}</title></g>`;
  }
  if (!pts.length) g += `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12.5" fill="var(--ink-3)">no requests in range</text>`;
  // P3b: crosshair overlay (pointer), keyboard stays with the inspector marks.
  g += `<g class="crosshair" style="display:none" aria-hidden="true"></g>`;
  setSvgContent(
    svg, "ctxchart", "Context growth by conversation",
    "Input tokens per call over time, one line per recent conversation. Green triangles mark compactions; red crosses mark failed requests.", g
  );
}
attachChartInspector("ctxwrap", "ctxtip", () => ctxPts, best => {
  const r = best.r;
  return `<div class="t-model">${esc(shortSess(r.session_title || r.session_id))}</div>`
    + `<div class="row"><span>${fmtTime(r.ts)}</span><b>${esc((r.model||"?").slice(0,26))}</b></div>`
    + `<div class="row"><span>input tokens</span><b>${fmtTok(r.input_tokens)}</b></div>`
    + `<div class="row"><span>output</span><b>${fmtTok(r.output_tokens)}</b></div>`;
}, false, { pointer: false });
attachSvgCrosshair("ctxwrap", "ctxchart", () => ({ scale: ctxScale, series: ctxSeries, fmt: v => `${fmtTok(v)} in tok` }));

/* ---------- KV pool pressure (concurrent in-flight context vs loaded ctx) ---------- */
/* LM Studio doesn't stream load settings; these mirror `lms ps` (ctx = the KV
   pool shared by all parallel slots). Update when a model is reloaded with
   different settings. */
const MODEL_POOL_CAPS = {
  "qwen3.6-35b-a3b-uncensored-genesis-hermes-v5": { ctx: 103424, parallel: 2 },
  "supergemma4-26b-uncensored-mlx-v2": { ctx: 64000, parallel: 1 },
};
function shortModelName(m) {
  return String(m || "?").replace("qwen3.6-35b-a3b-", "q35-").replace("-uncensored", "").replace("-mlx-v2", "");
}
function poolRequestsByModel(rs) {
  // Each request holds input_tokens of KV for its duration [ts-dur, ts].
  const byModel = new Map();
  for (const r of rs) {
    if (!REQUEST_KINDS.includes(r.kind)) continue;
    if (!r.model || !(r.input_tokens > 0)) continue;
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push({ start: r.ts - (r.duration_s || 0), end: r.ts, tok: r.input_tokens });
  }
  return byModel;
}
function poolDemandSamples(reqs, t0, t1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + (t1 - t0) * i / n;
    let demand = 0, active = 0;
    for (const q of reqs) if (q.start <= t && t <= q.end) { demand += q.tok; active++; }
    out.push({ ts: t, v: demand, active });
  }
  return out;
}
function poolPressurePeak(rs, t0, t1) {
  // Worst peak-vs-cap across models with known caps; null when no such traffic.
  let worst = null;
  for (const [model, reqs] of poolRequestsByModel(rs)) {
    const cap = MODEL_POOL_CAPS[model]?.ctx;
    if (!cap || reqs.length < 2) continue;
    const samples = poolDemandSamples(reqs, t0, t1, 160);
    const peak = samples.reduce((a, s) => (s.v > a.v ? s : a), samples[0]);
    const pct = peak.v / cap * 100;
    if (!worst || pct > worst.pct) worst = { model, cap, peak: peak.v, ts: peak.ts, pct, samples };
  }
  return worst;
}
let kvScale = null;
let kvSeries = [];
function renderKv(rs) {
  const svg = $("kvchart");
  if (!svg) return;
  const W = svg.clientWidth || 600, H = 220;
  const [t0, t1] = curWin;
  const models = [...poolRequestsByModel(rs).entries()]
    .filter(([, reqs]) => reqs.length >= 2)
    .map(([model, reqs]) => {
      const cap = MODEL_POOL_CAPS[model]?.ctx || null;
      const samples = poolDemandSamples(reqs, t0, t1, 160);
      const peak = Math.max(...samples.map(s => s.v));
      return { model, cap, samples, peak, ratio: cap ? peak / cap : 0 };
    })
    .sort((a, b) => b.ratio - a.ratio || b.peak - a.peak)
    .slice(0, 2);
  const ymax = Math.max(1, ...models.flatMap(m => [m.peak, m.cap || 0])) * 1.12;
  const axes = makeAxes({
    svg, W, H, pad: { l: 48, r: 12, t: 10, b: 20 }, x0: t0, x1: t1, ymax,
    xticks: Array.from({ length: 5 }, (_, i) => t0 + (t1 - t0) * i / 4),
    yticks: [1, 2, 3].map(i => ymax * i / 3),
    fmtX: fmtTick, fmtY: fmtTok, xLabelY: H - 5,
  });
  const { x, y } = axes;
  kvScale = { x, y, t0, t1, W, H, padL: 48, padR: 12, padT: 10, padB: 20 };
  let g = axes.g;
  kvSeries = [];
  models.forEach((m, i) => {
    const color = i === 0 ? "var(--s1)" : "var(--s2)";
    if (m.cap) {
      const cy = y(m.cap);
      g += `<line x1="48" x2="${W - 12}" y1="${cy.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${color}" stroke-dasharray="3 5" opacity="0.5"/>`;
      g += `<text x="${W - 14}" y="${(cy - 4).toFixed(1)}" text-anchor="end" font-size="10.5" fill="${color}" opacity="0.85">${esc(shortModelName(m.model))} pool ${fmtTok(m.cap)}</text>`;
    }
    g += `<polyline points="${m.samples.map(s => `${x(s.ts).toFixed(1)},${y(s.v).toFixed(1)}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
    kvSeries.push({ model: shortModelName(m.model), color, points: m.samples.map(s => ({ ts: s.ts, v: s.v })) });
  });
  if (!models.length) g += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="12.5" fill="var(--ink-3)">no model traffic in range</text>`;
  g += `<g class="crosshair" style="display:none" aria-hidden="true"></g>`;
  setSvgContent(
    svg, "kvchart", "KV pool pressure",
    "Concurrent in-flight context per model over time against its loaded context pool.", g
  );
}
attachSvgCrosshair("kvwrap", "kvchart", () => ({ scale: kvScale, series: kvSeries, fmt: v => `${fmtTok(v)} in flight` }));

/* ---------- efficiency scatter (duration vs output, log-x, tok/s guides) ---------- */
let effPts = [];
function renderEff(rs) {
  const svg = $("effchart");
  const W = svg.clientWidth || 600, H = 220;
  const pts = downsampleRecords(
    rs.filter(r => REQUEST_KINDS.includes(r.kind) && r.duration_s > 0 && r.output_tokens > 0),
    SVG_POINT_LIMIT,
    ["duration_s", "output_tokens", "tps"]
  );
  const activeIndex = activeChartIndex("effchart", pts.length);
  if (!pts.length) {
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    setSvgContent(
      svg, "effchart", "Request efficiency",
      "Request duration versus output tokens, colored by model, with constant tokens-per-second guide curves.",
      `<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="12.5" fill="var(--ink-3)">no requests in range</text>`
    );
    effPts = [];
    return;
  }
  const xmin = Math.max(0.3, Math.min(...pts.map(r => r.duration_s)) * 0.8);
  const xmax = Math.max(...pts.map(r => r.duration_s)) * 1.3;
  const ymax = Math.max(...pts.map(r => r.output_tokens)) * 1.1;
  const lx = v => Math.log10(v);
  const pad = { l: 48, r: 12, t: 10, b: 20 };
  const logX = v => pad.l + (lx(v) - lx(xmin)) / (lx(xmax) - lx(xmin)) * (W - pad.l - pad.r);
  const axes = makeAxes({
    svg, W, H, pad, ymax, x: logX,
    xticks: [1, 3, 10, 30, 100, 300, 900].filter(t => t >= xmin && t <= xmax),
    yticks: [1, 2, 3].map(i => ymax * i/3),
    fmtX: fmtDuration, fmtY: fmtTok, xLabelY: H - 5,
  });
  const { x, y } = axes;
  let g = axes.g;
  // Constant-tok/s guide curves (y = tps · x)
  for (const tps of [10, 30, 60]) {
    const seg = [];
    for (let i = 0; i <= 30; i++) {
      const vx = xmin * Math.pow(xmax/xmin, i/30), vy = tps * vx;
      if (vy > ymax) break;
      seg.push(`${x(vx).toFixed(1)},${y(vy).toFixed(1)}`);
    }
    if (seg.length > 1) {
      g += `<polyline points="${seg.join(" ")}" fill="none" stroke="var(--grid)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
      const [ex, ey] = seg[seg.length-1].split(",");
      g += `<text x="${Math.min(Number(ex)+4, W-30)}" y="${Math.max(Number(ey)-4, 10)}" font-size="10" fill="var(--ink-3)">${tps}/s</text>`;
    }
  }
  effPts = [];
  for (const r of pts) {
    const cx = x(r.duration_s), cy = y(r.output_tokens);
    const index = effPts.length;
    effPts.push({ cx, cy, r });
    const label = `${r.model || "unknown model"}, ${fmt1(r.duration_s)} seconds, ${fmtTok(r.output_tokens)} output tokens, ${fmt1(r.tps)} tokens per second`;
    g += `<circle ${chartMarkAttributes("effchart", index, activeIndex, label, `efficiency:${stableRecordKey(r)}`)} cx="${cx}" cy="${cy}" r="4" fill="${colorFor(r.model)}" stroke="var(--surface-1)" stroke-width="2"/>`;
  }
  // P3c: hover enlarges the nearest point with an inline readout (overlay).
  g += `<g class="effhover" style="display:none" aria-hidden="true"></g>`;
  setSvgContent(
    svg, "effchart", "Request efficiency",
    "Request duration versus output tokens, colored by model, with constant tokens-per-second guide curves.", g
  );
}
attachChartInspector("effwrap", "efftip", () => effPts, best => {
  const r = best.r;
  return `<div class="t-model"><span class="msw" style="background:${colorFor(r.model)}"></span>${esc(r.model||"?")}</div>`
    + `<div class="row"><span>${esc(KINDNAME[r.kind]||r.kind)} · ${fmtTime(r.ts)}</span><b>${fmt1(r.tps)} tok/s</b></div>`
    + `<div class="row"><span>duration</span><b>${fmtDuration(r.duration_s)}</b></div>`
    + `<div class="row"><span>output</span><b>${fmtTok(r.output_tokens)}</b></div>`
    + (r.device ? `<div class="row"><span>served by</span><b>${esc(r.device)}</b></div>` : "");
}, false, { pointer: false });
/* P3c: efficiency hover — nearest-point hit test, enlarged dot + inline
   readout in the .effhover overlay (keyboard tips stay with the inspector). */
let effHoverIndex = -1;
function attachEffHover() {
  const wrap = $("effwrap");
  if (!wrap || wrap.dataset.effHoverBound) return;
  wrap.dataset.effHoverBound = "1";
  wrap.addEventListener("pointermove", ev => {
    if (ev.pointerType === "touch") return;
    const svg = $("effchart");
    const g = svg && svg.querySelector ? svg.querySelector(".effhover") : null;
    if (!g || !effPts.length) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const sx = (ev.clientX - rect.left) * (vb.width / rect.width);
    const sy = (ev.clientY - rect.top) * (vb.height / rect.height);
    let best = null, bestD = 30;
    for (const p of effPts) {
      const d = Math.hypot(p.cx - sx, p.cy - sy);
      if (d < bestD) { bestD = d; best = p; }
    }
    if (!best) {
      effHoverIndex = -1;
      g.style.display = "none";
      return;
    }
    effHoverIndex = effPts.indexOf(best);
    const r = best.r;
    const name = (r.model || "?").length > 22 ? (r.model || "?").slice(0, 21) + "…" : (r.model || "?");
    g.innerHTML = `<circle cx="${best.cx}" cy="${best.cy}" r="7" fill="${colorFor(r.model)}" stroke="var(--surface-1)" stroke-width="2"/>`
      + `<text x="${Math.min(best.cx + 9, 470)}" y="${Math.max(best.cy - 8, 10)}" font-size="10.5" font-weight="600" fill="var(--ink-1)" paint-order="stroke" stroke="var(--surface-1)" stroke-width="3">${esc(name)} · ${esc(fmt1(r.tps))} tok/s · ${esc(fmtDuration(r.duration_s))}</text>`;
    g.style.display = "block";
  });
  wrap.addEventListener("pointerleave", ev => {
    if (ev.pointerType === "touch") return;
    effHoverIndex = -1;
    const svg = $("effchart");
    const g = svg && svg.querySelector ? svg.querySelector(".effhover") : null;
    if (g) g.style.display = "none";
  });
}
attachEffHover();

/* ---------- model stats strip under the speed chart (N2/N3/N12/N13) ----------
   Per model in the current window: request count, median t/s, p50/p95 duration,
   summed session cost, prompt-cache hit rate (cache_read ÷ input tokens),
   truncation count, and the reasoning/output token split. */
function renderModelStats(rs) {
  const el = $("modelstats");
  if (!el) return;
  const byModel = new Map();
  for (const r of rs) {
    if (!REQUEST_KINDS.includes(r.kind)) continue;
    const key = r.model || "?";
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(r);
  }
  if (!byModel.size) { el.innerHTML = ""; return; }
  const stats = [...byModel.entries()].map(([m, list]) => {
    const tpss = list.map(r => r.tps).filter(v => v > 0);
    const durs = list.map(r => r.duration_s).filter(v => v > 0);
    const inTok = list.reduce((a, r) => a + (r.input_tokens || 0), 0);
    const cacheTok = list.reduce((a, r) => a + (r.cache_read_tokens || 0), 0);
    const reasoning = list.reduce((a, r) => a + (r.reasoning_tokens || 0), 0);
    const outTok = list.reduce((a, r) => a + (r.output_tokens || 0), 0);
    const trunc = list.filter(r => r.finish_reason === "length").length;
    // cost_usd is cumulative within a session: take each session's latest
    // (max) value, then sum — same convention as the conversation cards.
    const costBySession = new Map();
    for (const r of list) {
      const sid = r.session_id || "?";
      costBySession.set(sid, Math.max(costBySession.get(sid) || 0, Number(r.cost_usd) || 0));
    }
    const cost = [...costBySession.values()].reduce((a, v) => a + v, 0);
    const cloud = list.every(r => !r.device);
    return {
      m, n: list.length, medTps: median(tpss),
      p50: quantile(durs, 0.5), p95: quantile(durs, 0.95),
      cost, cachePct: inTok > 0 && cacheTok > 0 ? cacheTok / inTok * 100 : null,
      reasoning, outTok, trunc, cloud,
    };
  }).sort((a, b) => b.n - a.n || a.m.localeCompare(b.m)).slice(0, 8);
  // Shared scale for the latency dot-and-whisker rows (demo latency plot):
  // filled dot = p50, whisker + hollow dot = p95, comparable across models.
  const latMax = Math.max(0, ...stats.map(s => s.p95 || s.p50 || 0)) * 1.06 || 1;
  const latplot = s => {
    if (s.p50 == null) return "";
    const X = v => Math.min(196, 2 + (v / latMax) * 194);
    const col = colorFor(s.m);
    const p95 = s.p95 != null && s.p95 > s.p50 ? s.p95 : null;
    return `<div class="latplot"><svg viewBox="0 0 200 12" aria-hidden="true">`
      + `<line x1="2" y1="6" x2="198" y2="6" stroke="var(--grid)" stroke-width="1"/>`
      + (p95 ? `<line x1="${X(s.p50).toFixed(1)}" y1="6" x2="${X(p95).toFixed(1)}" y2="6" stroke="${col}" stroke-width="3" opacity="0.4" stroke-linecap="round"/>` : "")
      + `<circle cx="${X(s.p50).toFixed(1)}" cy="6" r="3.5" fill="${col}"/>`
      + (p95 ? `<circle cx="${X(p95).toFixed(1)}" cy="6" r="3.5" fill="var(--surface-1)" stroke="${col}" stroke-width="1.5"/>` : "")
      + `</svg></div>`;
  };
  el.innerHTML = stats.map(s => {
    const head = `<span class="m">${esc(s.m.length > 30 ? s.m.slice(0, 29) + "…" : s.m)}</span> · ${s.n} req${s.cloud ? " · cloud" : ""}${s.medTps != null ? ` · med <b>${fmt1(s.medTps)} t/s</b>` : ""}`;
    const lat = [s.p50 != null ? `p50 ${fmtDuration(s.p50)}` : "", s.p95 != null ? `p95 ${fmtDuration(s.p95)}` : ""].filter(Boolean).join(" · ");
    const line2 = [lat ? `<span class="lat">${lat}</span>` : "", s.cost > 0 ? esc(fmtCost(s.cost)) : ""].filter(Boolean).join(" · ");
    const quality = [];
    if (s.cachePct != null) quality.push(`cache hit ${Math.round(s.cachePct)}%`);
    if (s.trunc) quality.push(`${s.trunc} truncated`);
    const lines = [line2,
      quality.length ? `<span class="lat">${quality.join(" · ")}</span>` : "",
      s.reasoning > 0 ? `<span class="lat">reasoning ${fmtTok(s.reasoning)} / output ${fmtTok(s.outTok)} tok</span>` : "",
    ].filter(Boolean);
    return `<div class="modelstat">${head}${lines.length ? "<br>" + lines.join("<br>") : ""}${latplot(s)}</div>`;
  }).join("");
}
