/* Hermes Metrics — renderers, SSE stream, router, boot. */
"use strict";

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; renderAll(); }, 400);
}
function connectSSE(onReady) {
  const es = new EventSource("/events");
  es.addEventListener("hello", () => {
    streamState = "live";
    updateConnectionStatus();
    if (onReady) {
      const ready = onReady;
      onReady = null;
      ready();
    }
  });
  es.addEventListener("rec", ev => {
    let r;
    try {
      r = JSON.parse(ev.data);
      if (!isRecord(r)) throw new Error("record must be an object");
    } catch (error) {
      console.warn("Skipped invalid SSE record", error);
      const label = historyState === "stale"
        ? "live · invalid event skipped · stale history"
        : "live · invalid event skipped";
      setConnectionStatus(label, true, historyState === "stale");
      return;
    }
    if (!appendLiveRecord(r)) return;
    updateConnectionStatus();
    scheduleRender();
  });
  es.onerror = () => {
    streamState = "reconnecting";
    updateConnectionStatus();
  };
}

/* ---------- tiles ---------- */
const KPI_BUCKETS = 24;
function kpiBuckets(rs) {
  const [t0, t1] = curWin;
  const span = Math.max(t1 - t0, 1);
  const buckets = Array.from({ length: KPI_BUCKETS }, (_, i) => ({
    t: t0 + (i + 0.5) * span / KPI_BUCKETS,
    reqs: 0, errs: 0, durs: [], tpss: [], inTok: 0, outTok: 0, cacheTok: 0, roots: new Set(),
  }));
  for (const r of rs) {
    const i = Math.min(KPI_BUCKETS - 1, Math.max(0, Math.floor((r.ts - t0) / span * KPI_BUCKETS)));
    const b = buckets[i];
    if (REQUEST_KINDS.includes(r.kind)) {
      b.reqs++;
      if (r.duration_s > 0) b.durs.push(r.duration_s);
      if (r.tps > 0) b.tpss.push(r.tps);
      b.inTok += r.input_tokens || 0;
      b.outTok += r.output_tokens || 0;
      b.cacheTok += r.cache_read_tokens || 0;
    }
    if (r.kind === "error") b.errs++;
    const root = rootOf(r);
    if (root) b.roots.add(root);
  }
  return buckets;
}
/* KPI tile sparklines (clean-design): ~34px interactive canvases driven by
   the current window — requests/hour, median t/s + latency, tokens,
   cumulative conversations, cache-hit rate, errors. */
function renderKpiSparklines(rs) {
  const buckets = kpiBuckets(rs);
  const draw = (id, series, color, fmt, opts = {}) => {
    const cv = $(id);
    if (cv) canvasSparkline(cv, series, color, { ...opts, fmt });
  };
  draw("spark-req", buckets.map(b => [b.t, b.reqs]), "var(--s1)", v => `${v} req`);
  draw("spark-err", buckets.map(b => [b.t, b.errs]), "var(--critical)", v => `${v} err`);
  draw("spark-tps", buckets.filter(b => b.tpss.length).map(b => [b.t, median(b.tpss)]), "var(--s2)", v => `${fmt1(v)} t/s`);
  draw("spark-latency", buckets.filter(b => b.durs.length).map(b => [b.t, median(b.durs)]), "var(--s3)", v => fmtDuration(v));
  draw("spark-tok", buckets.map(b => [b.t, b.inTok + b.outTok]), "var(--s1)", v => fmtTok(v));
  const seen = new Set();
  draw("spark-conv", buckets.map(b => {
    for (const root of b.roots) seen.add(root);
    return [b.t, seen.size];
  }), "var(--s2)", v => `${v} convos`);
  draw("spark-cache", buckets.filter(b => b.inTok + b.cacheTok > 0).map(b => [b.t, Math.round(b.cacheTok / (b.inTok + b.cacheTok) * 100)]), "var(--s3)", v => `${v}%`);
  const pool = poolPressurePeak(rs, curWin[0], curWin[1]);
  draw("spark-pool", pool ? pool.samples.map(s => [s.ts, s.v]) : [], "var(--s1)", v => fmtTok(v));
}
function renderTiles(rs) {
  const reqs = rs.filter(r => REQUEST_KINDS.includes(r.kind));
  const errs = rs.filter(r => r.kind === "error");
  $("t-req").textContent = fmtInt(reqs.length);
  $("t-req-sub").textContent = windowLabel();
  $("t-err").textContent = fmtInt(errs.length);
  $("t-err-sub").textContent = errs.length ? "requires attention" : "no errors in selected range";
  $("t-err-sub").style.color = errs.length ? "var(--critical)" : "";
  $("t-latency").textContent = fmtDuration(median(reqs.map(r => r.duration_s).filter(v => v >= 0)));
  $("t-tps").textContent = fmt1(median(reqs.map(r => r.tps).filter(v => v > 0)));
  const inTok = reqs.reduce((a,r) => a + (r.input_tokens||0), 0);
  const outTok = reqs.reduce((a,r) => a + (r.output_tokens||0), 0);
  $("t-tok").textContent = fmtTok(inTok + outTok);
  $("t-tok-sub").textContent = `${fmtTok(inTok)} in · ${fmtTok(outTok)} out`;
  const roots = new Set(rs.map(r => r.parent_session_id || r.session_id).filter(Boolean));
  $("t-conv").textContent = fmtInt(roots.size);
  $("t-conv-sub").textContent = windowLabel();
  const cacheT = reqs.reduce((a,r) => a + (r.cache_read_tokens||0), 0);
  const promptT = cacheT + inTok;
  $("t-cache").textContent = promptT > 0 && cacheT > 0 ? Math.round(cacheT/promptT*100) + "%" : "–";
  $("t-cache-sub").textContent = cacheT > 0 ? `${fmtTok(cacheT)} cached of ${fmtTok(promptT)} prompt` : "share of prompt tokens (provider-reported)";
  const pressure = poolPressurePeak(rs, curWin[0], curWin[1]);
  if (pressure) {
    $("t-pool").textContent = Math.round(pressure.pct) + "%";
    $("t-pool").style.color = pressure.pct >= 100 ? "var(--critical)" : pressure.pct >= 85 ? "var(--warn)" : "";
    $("t-pool-sub").textContent = `${shortModelName(pressure.model)} ${fmtTok(pressure.peak)}/${fmtTok(pressure.cap)} at ${fmtTime(pressure.ts)}`;
  } else {
    $("t-pool").textContent = "\u2013";
    $("t-pool").style.color = "";
    $("t-pool-sub").textContent = "concurrent context vs loaded ctx";
  }
  renderKpiSparklines(rs);
}

/* ---------- MoA turn waterfall ---------- */
function associateMoARecords(turns, refs) {
  const byRoot = new Map();
  const associations = new Map(turns.map(turn => [turn, []]));
  for (const turn of turns) {
    const root = rootOf(turn);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(turn);
  }
  for (const candidates of byRoot.values()) candidates.sort((a, b) => a.ts - b.ts);
  for (const record of refs) {
    const candidates = byRoot.get(rootOf(record)) || byRoot.get(record.session_id);
    if (!candidates?.length) continue;
    let low = 0, high = candidates.length;
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
function renderWaterfall(rs) {
  const turns = rs.filter(r => r.kind === "moa_turn" && r.duration_s > 0);
  const spark = $("moaspark");
  if (!turns.length) {
    $("waterfall").innerHTML = '<div class="empty">no MoA turns in range</div>';
    if (spark) spark.style.display = "none";   // P5 UI appears only with data
    return;
  }
  // P5a: per-turn total-duration sparkline above the turns (last 14 turns).
  if (spark) {
    spark.style.display = "";
    const series = turns.slice(-14).sort((a, b) => a.ts - b.ts).map(t => [t.ts, t.duration_s]);
    canvasSparkline(spark, series, "var(--s5)", {
      median: median(series.map(p => p[1])),
      fmt: v => fmtDuration(v),
    });
  }
  const refs = rs.filter(r => (r.kind === "moa_ref" || r.kind === "moa_agg"));
  // Index candidates by conversation root and binary-search nearest time.
  const byTurn = associateMoARecords(turns, refs);
  const shown = turns.slice(-6).reverse();
  $("waterfall").innerHTML = shown.map(t => {
    const mine = byTurn.get(t) || [];
    const props = mine.filter(r => r.kind === "moa_ref");
    const agg = mine.find(r => r.kind === "moa_agg");
    const total = t.duration_s;
    const maxRef = Math.max(0, ...props.map(r => r.duration_s || 0));
    const rows = props.sort((a,b) => (b.duration_s||0) - (a.duration_s||0)).map(r => `
      <div class="wrow tip-target" data-tip-scope="waterfall-row" data-tip-model="${esc(r.model||"?")}" data-tip-role="proposer"
        data-tip-duration="${Number(r.duration_s) || 0}" data-tip-tps="${Number(r.tps) || ""}" data-tip-turn="${esc(shortSess(t.session_title || t.session_id))}">
        <div class="wlab"><span class="msw" style="background:${colorFor(r.model)}"></span>${esc(r.model||"?")}</div>
        <div class="wtrack"><div class="wbar" style="left:0;width:${Math.min((r.duration_s||0)/total*100,100).toFixed(1)}%;background:${colorFor(r.model)}"></div></div>
        <div class="wval">${fmtDuration(r.duration_s)}${r.tps ? " · " + fmt1(r.tps) + " tok/s" : r.output_tokens === 0 ? " · failed" : ""}</div>
      </div>`).join("");
    const aggDur = Math.max(total - maxRef, 0);
    const aggModel = agg ? agg.model : "aggregator";
    const aggRow = `
      <div class="wrow tip-target" data-tip-scope="waterfall-row" data-tip-model="${esc(aggModel)}" data-tip-role="aggregator"
        data-tip-duration="${Number(aggDur) || 0}" data-tip-out="${Number(t.output_tokens) || 0}" data-tip-turn="${esc(shortSess(t.session_title || t.session_id))}">
        <div class="wlab"><span class="msw" style="background:${colorFor(aggModel)}"></span>${esc(aggModel)} <span class="chip">agg</span></div>
        <div class="wtrack"><div class="wbar" style="left:${(maxRef/total*100).toFixed(1)}%;width:${(aggDur/total*100).toFixed(1)}%;background:${colorFor(aggModel)}"></div></div>
        <div class="wval">~${fmtDuration(aggDur)} · ${fmtTok(t.output_tokens)} out</div>
      </div>`;
    // P5c: turn-head summary chips — fan-out (slowest proposer), aggregation
    // estimate, output tokens, total wall time.
    const chips = `<span class="wchip">fan-out <b>${fmtDuration(maxRef)}</b></span>`
      + `<span class="wchip">agg est <b>~${fmtDuration(aggDur)}</b></span>`
      + `<span class="wchip">out <b>${fmtTok(t.output_tokens)}</b></span>`
      + `<span class="wchip">total <b>${fmtDuration(total)}</b></span>`;
    return `<div class="wturn">
      <div class="whead tip-target" data-tip-scope="waterfall-turn" data-tip-title="${esc(shortSess(t.session_title || t.session_id))}"
        data-tip-time="${esc(fmtTime(t.ts))}" data-tip-preset="${esc(t.model||"?")}" data-tip-duration="${Number(total) || 0}">
        <b>${esc(shortSess(t.session_title || t.session_id))}</b>
        <span>${fmtTime(t.ts)} · preset ${esc(t.model||"?")}</span>${chips}</div>
      ${rows}${aggRow}
    </div>`;
  }).join("");
}
/* P5b: hovering a waterfall row isolates the call — siblings in that turn
   dim (CSS classes), the row highlights. Tooltips are untouched. */
let waterfallHover = null;
function clearWaterfallHover() {
  if (!waterfallHover) return;
  waterfallHover.turn.classList.remove("has-hover");
  waterfallHover.row.classList.remove("hover");
  waterfallHover.row.style.background = "";
  waterfallHover = null;
}
$("waterfall").addEventListener("pointerover", ev => {
  const row = ev.target && ev.target.closest ? ev.target.closest(".wrow") : null;
  const turn = row && row.closest ? row.closest(".wturn") : null;
  if (waterfallHover && waterfallHover.row === row) return;
  clearWaterfallHover();
  if (!row || !turn) return;
  waterfallHover = { turn, row };
  turn.classList.add("has-hover");
  row.classList.add("hover");
  row.style.background = "var(--grid)";
});
$("waterfall").addEventListener("pointerleave", clearWaterfallHover);

/* ---------- live pool strip (which models are loaded right now, and where) ---------- */
function loadedNow(rs) {
  // pool_status snapshots arrive every ~30s; anything older than 3 min is stale.
  const cutoff = Date.now()/1000 - 180;
  const map = new Map();
  for (const r of rs) {
    if (r.kind === "pool_status" && r.ts >= cutoff && r.model) map.set(r.model, r.device);
  }
  return map;
}
function renderPool(rs) {
  const pool = loadedNow(rs);
  if (!pool.size) {
    const guidance = hostFilter
      ? "No current pool data for the selected host. Try all hosts or widen the time range."
      : textFilter || kindFilter || errorsOnly
        ? "No current pool data matches active filters. Clear filters or widen the time range."
        : "No current pool data. Widen the time range to load a recent pool snapshot.";
    $("poolnow").innerHTML = `<div class="empty">${guidance}</div>`;
    return;
  }
  $("poolnow").innerHTML = `<span class="pool-now">pool now:</span>` +
    [...pool.entries()].sort().map(([m, d]) =>
      `<button class="chip mchip${m === modelFilter ? " active" : ""}" type="button" data-model="${esc(m)}" ${focusKeyAttribute("pool-model", m)} aria-pressed="${m === modelFilter}"><span class="msw" style="background:${colorFor(m)}"></span>${esc(m)}${d ? ` <span class="pool-dev">@ ${esc(d)}</span>` : ""}</button>`).join("");
}

/* ---------- per-model variance (range band · p25–p75 box · median tick · latest dot) ---------- */
const varianceStatsHtml = new Map();   // model -> default .vstats html (restored on hover-out)
function renderVariance(rs) {
  const pts = rs.filter(r => REQUEST_KINDS.includes(r.kind) && r[metric] > 0);
  $("vartitle").textContent = `${metricLabel[metric]} — min–max band, box p25–p75, | median, ● latest call`;
  const byModel = new Map();
  for (const r of pts) {
    const key = r.model || "?";
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key).push(r);
  }
  if (!byModel.size) { $("variance").innerHTML = '<div class="empty">no requests in range</div>'; return; }
  const stats = [...byModel.entries()].map(([m, list]) => {
    list.sort((a,b) => a.ts - b.ts);
    const vals = list.map(r => r[metric]);
    return { m, n: vals.length, min: Math.min(...vals), max: Math.max(...vals),
             p25: quantile(vals, 0.25), p75: quantile(vals, 0.75),
             med: median(vals), last: vals[vals.length - 1] };
  }).sort((a,b) => b.med - a.med).slice(0, 12);
  const gmax = Math.max(...stats.map(s => s.max)) * 1.04 || 1;
  const pc = v => (v / gmax * 100).toFixed(2) + "%";
  const fmtV = metric === "output_tokens" ? fmtTok : metric === "duration_s" ? fmtDuration : fmt1;
  const pool = loadedNow(filteredTelemetry());
  varianceStatsHtml.clear();
  $("variance").innerHTML = stats.map(s => {
    const defaultStats = `last <b>${fmtV(s.last)}</b> · med ${fmtV(s.med)} · ${fmtV(s.min)}–${fmtV(s.max)} · n ${s.n}`;
    varianceStatsHtml.set(s.m, defaultStats);
    const box = s.p75 > s.p25
      ? `<div class="vbox" style="left:${pc(s.p25)};width:${((s.p75 - s.p25) / gmax * 100).toFixed(2)};background:color-mix(in srgb, ${colorFor(s.m)} 18%, transparent);border-color:color-mix(in srgb, ${colorFor(s.m)} 45%, transparent)"></div>`
      : "";
    return `
    <div class="vrow tip-target" data-model="${esc(s.m)}"${pool.size && !pool.has(s.m) ? ' style="opacity:.55"' : ""}
      data-tip-scope="variance" data-tip-model="${esc(s.m)}" data-tip-metric="${esc(metricLabel[metric])}" data-tip-metric-kind="${esc(metric)}"
      data-tip-last="${Number(s.last) || 0}" data-tip-med="${Number(s.med) || 0}" data-tip-min="${Number(s.min) || 0}" data-tip-max="${Number(s.max) || 0}" data-tip-n="${Number(s.n) || 0}"
      data-vmin="${Number(s.min) || 0}" data-vmed="${Number(s.med) || 0}" data-vmax="${Number(s.max) || 0}" data-vlast="${Number(s.last) || 0}"
      data-tip-loaded="${pool.has(s.m) ? esc(pool.get(s.m) || "?") : ""}" data-tip-pool-active="${pool.size ? "1" : "0"}">
      <button class="vname" type="button" data-model="${esc(s.m)}" ${focusKeyAttribute("variance-model", s.m)} aria-pressed="${s.m === modelFilter}" aria-label="Filter by model ${esc(s.m)}"><span class="msw" style="background:${colorFor(s.m)}"></span>${esc(s.m)}${pool.has(s.m) ? "" : pool.size ? ' <span class="chip" style="font-size:9.5px">unloaded</span>' : ""}</button>
      <div class="vtrack">
        <div class="vband" style="left:${pc(s.min)};width:${(Math.max(s.max - s.min, 0) / gmax * 100).toFixed(2)}%"></div>
        ${box}
        <div class="vtick" style="left:${pc(s.med)}"></div>
        <div class="vdot" style="left:${pc(s.last)};background:${colorFor(s.m)}"></div>
      </div>
      <div class="vstats">${defaultStats}</div>
    </div>`;
  }).join("");
}
/* P6: hovering a variance row highlights it and prints the exact
   min/median/max/latest inline; the default stats restore on leave. */
let varianceHoverRow = null;
function clearVarianceHover() {
  if (!varianceHoverRow) return;
  const { row } = varianceHoverRow;
  row.classList.remove("hover");
  const statsEl = row.querySelector(".vstats");
  if (statsEl) statsEl.innerHTML = varianceStatsHtml.get(row.dataset.model) || "";
  varianceHoverRow = null;
}
$("variance").addEventListener("pointerover", ev => {
  const row = ev.target && ev.target.closest ? ev.target.closest(".vrow") : null;
  if (varianceHoverRow && varianceHoverRow.row === row) return;
  clearVarianceHover();
  if (!row || !row.dataset || row.dataset.tipScope !== "variance") return;
  varianceHoverRow = { row };
  row.classList.add("hover");
  const statsEl = row.querySelector(".vstats");
  if (statsEl) {
    const fmtV = metric === "output_tokens" ? fmtTok : metric === "duration_s" ? fmtDuration : fmt1;
    statsEl.textContent = `min ${fmtV(Number(row.dataset.vmin))} · med ${fmtV(Number(row.dataset.vmed))} · max ${fmtV(Number(row.dataset.vmax))} · last ${fmtV(Number(row.dataset.vlast))}`;
  }
});
$("variance").addEventListener("pointerleave", clearVarianceHover);

/* ---------- guardrails & empty responses (R12/R13) ---------- */
// Guardrail halts/blocks arrive as records tailed from agent.log
// (forwarder.py); empty-response stats are computed from api records —
// assistant_content_chars == 0 on a finished (non-tool_calls) turn, or
// reasoning tokens >= 90% of the completion. Mirrors health_rules R12/R13.
function emptyResponseStats(rs) {
  const byKey = new Map();
  for (const r of rs) {
    if (r.kind !== "api" || !r.session_id) continue;
    const key = r.session_id + "|" + (r.model || "?");
    const b = byKey.get(key) || { sid: r.session_id, model: r.model, calls: 0, empty: 0, burned: 0, lastTs: 0 };
    b.calls++;
    const rt = r.reasoning_tokens || 0, out = r.output_tokens || 0;
    if (r.assistant_content_chars === 0 && r.finish_reason !== "tool_calls" &&
        (r.finish_reason === "length" || r.finish_reason === "stop" || (out && rt >= 0.9 * out))) {
      b.empty++;
      b.burned += rt;
      b.lastTs = Math.max(b.lastTs, r.ts || 0);
    }
    byKey.set(key, b);
  }
  return [...byKey.values()].filter(b => b.empty > 0)
    .sort((a, b) => b.empty - a.empty || b.lastTs - a.lastTs);
}
function renderGuardrails(rs) {
  const el = $("guardrails");
  if (!el) return;
  const events = rs.filter(r => r.kind === "guardrail_halt" || r.kind === "guardrail_block")
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const empties = emptyResponseStats(rs);
  if (!events.length && !empties.length) {
    el.innerHTML = `<div class="empty">no guardrail events or empty responses in range</div>`;
    return;
  }
  let html = "";
  if (events.length) {
    const halts = events.filter(r => r.kind === "guardrail_halt").length;
    html += `<h3>Tool guardrails <span class="feed-meta">${halts} halt${halts === 1 ? "" : "s"} · ${events.length - halts} block${events.length - halts === 1 ? "" : "s"}</span></h3>
    <div class="scroll-x"><table><thead><tr><th>time</th><th>event</th><th>session</th><th>model / tool</th><th>detail</th></tr></thead><tbody>` +
    events.slice(0, 50).map(r => `<tr>
      <td class="feed-meta">${fmtTime(r.ts)}</td>
      <td>${r.kind === "guardrail_halt" ? "halt" : "block"}</td>
      <td class="feed-meta" title="${esc(r.session_id || "")}">${esc(shortSess(r.session_id))}</td>
      <td>${esc(r.kind === "guardrail_halt" ? (r.model || "?") : (r.label || "?"))}</td>
      <td class="feed-meta">${esc(r.error || "")}</td>
    </tr>`).join("") + `</tbody></table></div>`;
  }
  if (empties.length) {
    html += `<h3>Empty / reasoning-only responses <span class="feed-meta">0 visible chars on a finished turn — R13 fires at ≥2</span></h3>
    <div class="scroll-x"><table><thead><tr><th>session</th><th>model</th><th class="num">empty</th><th class="num">of calls</th><th class="num">reasoning burned</th><th>last</th></tr></thead><tbody>` +
    empties.slice(0, 20).map(b => `<tr>
      <td class="feed-meta" title="${esc(b.sid)}">${esc(shortSess(b.sid))}</td>
      <td>${esc(b.model || "?")}</td>
      <td class="num">${b.empty}</td>
      <td class="num">${b.calls}</td>
      <td class="num">${fmtTok(b.burned)}</td>
      <td class="feed-meta">${b.lastTs ? fmtTime(b.lastTs) : "–"}</td>
    </tr>`).join("") + `</tbody></table></div>`;
  }
  el.innerHTML = html;
}

/* ---------- conversations ---------- */
const openConvos = new Set();
/* R3: session titles are mostly NULL upstream, so cards fall back to the
   forwarder-enriched source + started_at ("tui · Jul 19 11:58") with a short
   session suffix — real identity without pretending there are titles. */
function convoLabel(rl, root) {
  const titled = rl.find(r => r.session_title && r.session_id === root)?.session_title;
  if (titled) return { title: titled, suffix: null };
  const sourced = rl.find(r => r.session_id === root && r.session_source) || rl.find(r => r.session_source);
  if (sourced) {
    const started = sourced.session_started_at ? fmtDateShort(sourced.session_started_at) : null;
    return {
      title: `${sourced.session_source}${started ? " · " + started : ""}`,
      suffix: "…" + String(root).slice(-6),
    };
  }
  return { title: shortSess(root), suffix: null };
}
function renderConvos(rs) {
  const byRoot = new Map();
  for (const r of rs) {
    if (!r.session_id) continue;
    const root = r.parent_session_id || r.session_id;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(r);
  }
  const roots = [...byRoot.entries()].sort((a,b) => Math.max(...b[1].map(r=>r.ts)) - Math.max(...a[1].map(r=>r.ts)));
  if (!roots.length) { $("convos").innerHTML = '<div class="empty">no conversations in range</div>'; return; }
  let html = "";
  const convoSeries = new Map();   // root -> { series, color } for P4 sparklines
  for (const [root, rl] of roots.slice(0, 40)) {
    const { title, suffix } = convoLabel(rl, root);
    const host = [...new Set(rl.map(r => r.host).filter(Boolean))].join(", ");
    const groups = new Map();  // (session|model|kind) -> agg
    for (const r of rl) {
      if (!["api","moa_turn","moa_ref","moa_agg","error"].includes(r.kind)) continue;
      const sub = r.session_id !== root;
      const key = `${sub ? r.session_id : ""}|${r.model||"?"}|${r.kind}`;
      if (!groups.has(key)) groups.set(key, { sub, sess: r.session_id, model: r.model||"?", kind: r.kind, n:0, inT:0, outT:0, durs:[], tpss:[], errs:0 });
      const gr = groups.get(key);
      gr.n++; gr.inT += r.input_tokens||0; gr.outT += r.output_tokens||0;
      if (r.duration_s > 0) gr.durs.push(r.duration_s);
      if (r.tps > 0) gr.tpss.push(r.tps);
      if (r.kind === "error") gr.errs++;
    }
    const inT = rl.reduce((a,r)=>a+(r.input_tokens||0),0), outT = rl.reduce((a,r)=>a+(r.output_tokens||0),0);
    // cost_usd is cumulative within a session: take each session's latest (max)
    // value, then sum across sessions for the true conversation total.
    const costBySession = new Map();
    for (const r of rl) {
      const sid = r.session_id || "?";
      costBySession.set(sid, Math.max(costBySession.get(sid) || 0, Number(r.cost_usd) || 0));
    }
    const convoCost = [...costBySession.values()].reduce((a, v) => a + v, 0);
    const nCalls = [...groups.values()].reduce((a,g)=>a+g.n,0);
    const open = openConvos.has(root);
    const rows = [...groups.values()].sort((a,b) => (a.sub?1:0)-(b.sub?1:0) || b.outT - a.outT).map(gr => `
      <tr class="${gr.sub ? "sub-sess" : ""}">
        <td class="model"><span class="msw" style="background:${colorFor(gr.model)}"></span>${gr.sub ? '<span class="chip">subagent</span> ' : ""}${esc(gr.model)}</td>
        <td>${kindChip(gr)}</td>
        <td class="num">${gr.n}</td>
        <td class="num">${fmtTok(gr.inT)}</td>
        <td class="num">${fmtTok(gr.outT)}</td>
        <td class="num">${fmtDuration(median(gr.durs))}</td>
        <td class="num">${fmt1(median(gr.tpss))}</td>
      </tr>`).join("");
    // Composition strip: each model's share of this conversation's output tokens.
    const byModelOut = new Map();
    for (const r of rl) {
      if (!["api","moa_turn","moa_ref"].includes(r.kind) || !(r.output_tokens > 0)) continue;
      const key = r.model || "?";
      byModelOut.set(key, (byModelOut.get(key) || 0) + r.output_tokens);
    }
    const outSum = [...byModelOut.values()].reduce((a,v) => a+v, 0);
    const strip = outSum > 0 ? `<div class="cbar">` + [...byModelOut.entries()].sort((a,b) => b[1]-a[1]).map(([m, v]) =>
      `<span style="width:${(v/outSum*100).toFixed(2)}%;background:${colorFor(m)}" title="${esc(m)}: ${fmtTok(v)} out (${Math.round(v/outSum*100)}%)"></span>`).join("") + `</div>` : "";
    // P4: per-conversation t/s sparkline from this root's request records,
    // colored by the conversation's dominant model.
    const tpsPts = [];
    for (const r of rl) {
      if (!["api","moa_turn","moa_ref"].includes(r.kind) || !(r.tps > 0)) continue;
      tpsPts.push([r.ts, r.tps]);
    }
    tpsPts.sort((a, b) => a[0] - b[0]);
    const topModel = outSum > 0 ? [...byModelOut.entries()].sort((a, b) => b[1] - a[1])[0][0] : "?";
    let sparkHtml = "";
    if (tpsPts.length >= 2) {
      const step = Math.max(1, Math.ceil(tpsPts.length / 60));
      convoSeries.set(root, { series: tpsPts.filter((_, i) => i % step === 0), color: colorFor(topModel) });
      sparkHtml = `<canvas class="convospark" data-root="${esc(root)}" aria-hidden="true"></canvas>`;
    }
    const focused = convoFilter && convoFilter.root === root;
    html += `<div class="convo${focused ? " focused" : ""}">
      <div class="convo-controls">
        <button type="button" class="head" data-root="${esc(root)}" ${focusKeyAttribute("convo-toggle", root)} aria-expanded="${open}">
          <span class="title">${esc(title)}</span>
          <span class="chip host">${esc(host)}</span>
          <span class="meta">${suffix ? `<span class="mono">${esc(suffix)}</span> · ` : ""}${nCalls} calls · ${fmtTok(inT)} in · ${fmtTok(outT)} out${(c => c > 0 ? ` · $${c.toFixed(4)}` : "")(convoCost)} · ${fmtTime(Math.max(...rl.map(r=>r.ts)))}</span>
        </button>
        <button class="chip focusbtn${focused ? " active" : ""}" type="button" data-root="${esc(root)}" data-label="${esc(title)}" ${focusKeyAttribute("convo-focus", root)} aria-pressed="${focused}">${focused ? `focused <span class="ico ico-x" aria-hidden="true"></span>` : "focus"}</button>
      </div>
      ${sparkHtml}
      ${strip}
      ${open ? `<div class="scroll-x"><table>
        <thead><tr><th>agent / model</th><th>kind</th><th class="num">calls</th><th class="num">in</th><th class="num">out</th><th class="num">med duration</th><th class="num">med tok/s</th></tr></thead>
        <tbody>${rows}</tbody></table></div>` : ""}
    </div>`;
  }
  $("convos").innerHTML = html;
  for (const cv of $("convos").querySelectorAll("canvas.convospark")) {
    const entry = convoSeries.get(cv.dataset.root);
    if (entry) canvasSparkline(cv, entry.series, entry.color, { fmt: v => `${fmt1(v)} t/s` });
  }
}
// One delegated listener for the whole conversation list (survives re-renders).
$("convos").addEventListener("click", ev => {
  const focusBtn = ev.target.closest(".focusbtn");
  if (focusBtn) {
    ev.stopPropagation();
    toggleConversationFilter(focusBtn);
    return;
  }
  const head = ev.target.closest(".head");
  if (!head || !head.dataset.root) return;
  const root = head.dataset.root;
  openConvos.has(root) ? openConvos.delete(root) : openConvos.add(root);
  renderAll();
});

/* ---------- live feed ---------- */
function kindChip(r) {
  const cls = r.kind === "error" ? "chip err" : "chip";
  return `<span class="${cls}">${esc(KINDNAME[r.kind] || r.kind)}</span>`;
}
function filtersAreActive() {
  return Boolean(hostFilter || textFilter || kindFilter || errorsOnly || convoFilter || modelFilter);
}
function emptyMessage(subject) {
  return filtersAreActive() ? `no ${subject} match active filters` : `no ${subject} in selected range`;
}
let feedBaselineKey = null;   // filter/sort/generation signature of the currently rendered tbody
let feedMaxRenderedId = -1;   // highest record id present in the tbody
let lastFeedRows = [];        // the currently visible rows — what CSV export serializes (N5)
function feedFiltersKey() {
  return JSON.stringify([
    hostFilter, textFilter, kindFilter, errorsOnly, showHeartbeats,
    convoFilter ? convoFilter.root : "", modelFilter || "",
    rangeMode.type, rangeMode.hours || 0, rangeMode.offset || 0,
    rangeMode.from || 0, rangeMode.to || 0, recordsGeneration
  ]);
}
/* R5: the serving device is a first-class pill; a model with no device is
   served remotely -> "cloud". */
function devicePill(r) {
  const serving = r.device || (r.model ? "cloud" : (r.host || "?"));
  const cls = r.device || !r.model ? "chip host" : "chip cloud";
  const title = r.device && r.host && r.device !== r.host ? ` title="host ${esc(r.host)}"` : "";
  return `<span class="${cls}"${title}>${esc(serving)}</span>`;
}
function feedRowHtml(r, kindCell) {
  const root = rootOf(r);
  const focusControl = root
    ? `<button class="chip feed-focus" type="button" data-root="${esc(root)}" data-label="${esc(r.session_title || "")}" ${focusKeyAttribute("feed", stableRecordKey(r))} aria-pressed="${Boolean(convoFilter && convoFilter.root === root)}" aria-label="${convoFilter && convoFilter.root === root ? "Clear" : "Focus"} conversation ${esc(r.session_title || shortSess(root))}" title="Filter by conversation ${esc(r.session_title || shortSess(root))}">focus</button>`
    : "";
  return `
    <tr class="tip-target" tabindex="-1" data-tip-scope="feed" data-tip-model="${esc(r.model||"?")}" data-tip-kind="${esc(KINDNAME[r.kind]||r.kind)}"
      data-tip-host="${esc(r.host||"?")}" data-tip-time="${esc(fmtTime(r.ts))}" data-tip-in="${esc(fmtTok(r.input_tokens))}"
      data-tip-out="${esc(fmtTok(r.output_tokens))}" data-tip-duration="${Number(r.duration_s) || 0}" data-tip-tps="${Number(r.tps) || 0}"
      ${r.ttft_s ? `data-tip-ttft="${Number(r.ttft_s)}" ` : ""}${r.tps_native ? `data-tip-native="${Number(r.tps_native)}" ` : ""}${r.spec_accept_rate ? `data-tip-spec="${Math.round(r.spec_accept_rate*100)}" ` : ""}data-tip-convo="${esc(shortSess(r.session_title || r.session_id))}"${r.error ? ` data-tip-error="${esc(String(r.error).slice(0,80))}"` : ""}
      data-root="${esc(root || "")}" data-label="${esc(r.session_title || "")}"${r.id != null ? ` data-record-id="${esc(String(r.id))}"` : ""}>
      <td>${fmtTime(r.ts)}</td>
      <td>${devicePill(r)}</td>
      <td>${kindCell != null ? kindCell : kindChip(r)}</td>
      <td class="model">
        ${focusControl} <span class="msw" style="background:${colorFor(r.model)}"></span>${esc(r.model||"?")}</td>
      <td class="num">${fmtTok(r.input_tokens)}</td>
      <td class="num">${fmtTok(r.output_tokens)}</td>
      <td class="num">${fmtDuration(r.duration_s)}${r.finish_reason === "length" ? ' <span class="trunc" title="finish_reason=length — hit output cap"><span class="ico ico-warn" aria-hidden="true"></span>trunc</span>' : ""}</td>
      <td class="num">${fmt1(r.tps)}</td>
    </tr>`;
}
/* N6: consecutive identical errors collapse into one ×N row (expandable). */
const expandedErrorGroups = new Set();
function errorSignature(r) {
  return [r.host || "", r.model || "", String(r.error || "")].join("\u0000");
}
function groupFeedRows(rows) {
  const items = [];
  for (const r of rows) {
    const prev = items[items.length - 1];
    if (r.kind === "error" && prev && prev.signature && prev.signature === errorSignature(r)) {
      prev.members.push(r);
      continue;
    }
    const signature = r.kind === "error" ? errorSignature(r) : null;
    items.push({ r, signature, key: signature ? signature + "\u0000" + stableRecordKey(r) : null, members: [r] });
  }
  // Expanded groups render their members as individual rows again.
  const expanded = [];
  for (const item of items) {
    if (item.members.length > 1 && expandedErrorGroups.has(item.key)) {
      for (const r of item.members) expanded.push({ r, signature: null, key: null, members: [r] });
    } else {
      expanded.push(item);
    }
  }
  return expanded;
}
function groupKindCell(item) {
  const n = item.members.length;
  return `<button type="button" class="chip err errgroup" data-gkey="${esc(item.key)}" aria-expanded="false" title="${n} identical consecutive errors — click to expand">error <span class="count">×${n}</span></button>`;
}
function renderFeed(rs) {
  const allRows = sortedFeedRows(rs);
  const rows = allRows.slice(0, FEED_LIMIT);
  lastFeedRows = rows;
  const items = groupFeedRows(rows);
  $("feedcount").textContent = `showing ${fmtInt(rows.length)} of ${fmtInt(allRows.length)}${allRows.length > FEED_LIMIT ? ` · limited to ${FEED_LIMIT}` : ""}`;
  const hb = $("hbtoggle");
  if (hb) {
    hb.textContent = showHeartbeats ? "hide heartbeats" : "show heartbeats";
    hb.setAttribute("aria-pressed", String(showHeartbeats));
  }
  for (const button of document.querySelectorAll("#feedwrap [data-sort]")) {
    const active = button.dataset.sort === feedSort.key;
    button.classList.toggle("active", active);
    button.closest("th").setAttribute(
      "aria-sort",
      active ? (feedSort.direction === "asc" ? "ascending" : "descending") : "none"
    );
    const label = button.textContent.replace(/\s[↑↓]$/, "");
    button.textContent = active ? `${label} ${feedSort.direction === "asc" ? "↑" : "↓"}` : label;
  }
  const tbody = $("feed");
  const defaultSort = feedSort.key === "ts" && feedSort.direction === "desc";
  const filtersKey = feedFiltersKey();
  const ungrouped = items.length === rows.length && expandedErrorGroups.size === 0;
  // Incremental path: same default view as the last render — prepend only
  // newly-arrived rows instead of rebuilding, so scroll position survives.
  // Grouped error runs and fresh errors always take the full-rebuild path.
  if (
    defaultSort && ungrouped && filtersKey === feedBaselineKey && rows.length
    && tbody.rows.length && tbody.rows[0].dataset.recordId != null
    && !rows.some(r => r.id == null)
  ) {
    const fresh = rows.filter(r => r.id > feedMaxRenderedId);
    if (fresh.every(r => r.kind !== "error")) {
      if (fresh.length) {
        const wrap = $("feedwrap");
        const heightBefore = tbody.scrollHeight;
        tbody.insertAdjacentHTML("afterbegin", fresh.map(r => feedRowHtml(r)).join(""));
        const addedHeight = tbody.scrollHeight - heightBefore;
        while (tbody.rows.length > FEED_LIMIT) tbody.deleteRow(-1);
        if (wrap.scrollTop > 0 && addedHeight > 0) wrap.scrollTop += addedHeight;
        feedMaxRenderedId = Math.max(feedMaxRenderedId, ...fresh.map(r => r.id));
      }
      return;
    }
  }
  // Full rebuild: any sort/filter/text change, a replaced history snapshot,
  // or records without server ids (their arrival can't be tracked by id).
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">${emptyMessage("records")}</td></tr>`;
    feedBaselineKey = null;
    feedMaxRenderedId = -1;
    return;
  }
  tbody.innerHTML = items.map(item => item.members.length > 1 ? feedRowHtml(item.members[0], groupKindCell(item)) : feedRowHtml(item.r)).join("");
  feedMaxRenderedId = rows.reduce((max, r) => (r.id != null && r.id > max ? r.id : max), -1);
  feedBaselineKey = defaultSort ? filtersKey : null;
}
/* N5: CSV export of the currently visible feed rows, fully client-side. */
const FEED_CSV_KEYS = ["host", "kind", "model", "device", "input_tokens", "output_tokens", "duration_s", "tps", "cost_usd", "finish_reason", "error", "session_id"];
function buildFeedCsv(rows) {
  const header = ["time_iso", ...FEED_CSV_KEYS].join(",");
  const lines = rows.map(r => [
    new Date((Number(r.ts) || 0) * 1000).toISOString(),
    ...FEED_CSV_KEYS.map(k => csvCell(r[k]))
  ].join(","));
  return [header, ...lines].join("\n") + "\n";
}
function exportFeedCsv() {
  const csv = buildFeedCsv(lastFeedRows);
  if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function" || typeof document.createElement !== "function") {
    return csv;   // test / non-browser environment: just build the payload
  }
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `hermes-feed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return csv;
}
function renderErrors(rs) {
  const allErrors = rs.filter(r => r.kind === "error").slice().sort((a, b) =>
    (Number(b.ts) || 0) - (Number(a.ts) || 0) || stableRecordKey(a).localeCompare(stableRecordKey(b))
  );
  const shown = allErrors.slice(0, ERROR_LIMIT);
  $("errorcount").textContent = `showing ${fmtInt(shown.length)} of ${fmtInt(allErrors.length)}${allErrors.length > ERROR_LIMIT ? ` · limited to ${ERROR_LIMIT}` : ""}`;
  if (!shown.length) {
    $("errorsfeed").innerHTML = `<div class="empty">${emptyMessage("errors")}</div>`;
    return;
  }
  $("errorsfeed").innerHTML = shown.map(r => `
    <div class="error-item tip-target" data-tip-scope="error" data-tip-model="${esc(r.model || "?")}" data-tip-host="${esc(r.host || "?")}"
      data-tip-time="${esc(fmtTime(r.ts))}" data-tip-convo="${esc(shortSess(r.session_title || r.session_id))}"
      data-tip-error="${esc(r.error || "request failed without an error message")}">
      <div><b>${fmtTime(r.ts)}</b> · ${esc(r.host || "?")} · ${esc(r.model || "?")} · ${esc(shortSess(r.session_title || r.session_id))}</div>
      <div class="message">${esc(r.error || "request failed without an error message")}</div>
    </div>`).join("");
}

/* ---------- top-level ---------- */
function renderCharts(rs) {
  renderChart(rs);
  renderVolume(rs);
}
const diagnosticElements = [...document.querySelectorAll(".diagnostic")];
function renderDiagnostic(detail, rs) {
  const name = detail.dataset.diagnostic;
  if (name === "pool") renderPool(filteredTelemetry());
  else if (name === "moa") renderWaterfall(rs);
  else if (name === "host") renderHosts(filteredTelemetry());
  else if (name === "context") renderCtx(rs);
  else if (name === "compression") renderKv(rs);
  else if (name === "efficiency") renderEff(rs);
  else if (name === "variance") renderVariance(rs);
  else if (name === "guardrails") renderGuardrails(rs);
  else if (name === "conversations") renderConvos(rs);
}
function renderOpenDiagnostics(rs) {
  for (const detail of diagnosticElements) {
    if (detail.open) renderDiagnostic(detail, rs);
  }
}
const diagnosticUserToggled = new Set();  // sections the user manually toggled this session
for (const detail of diagnosticElements) {
  const chip = document.createElement("span");
  chip.className = "diagsum";
  detail.querySelector("summary").appendChild(chip);
  detail.addEventListener("toggle", () => {
    if (detail.open) renderDiagnostic(detail, filteredRecords());
  });
  detail.querySelector("summary").addEventListener("click", () => {
    diagnosticUserToggled.add(detail.dataset.diagnostic);
  });
}
function diagnosticSummary(name, rs, telemetry) {
  const reqs = rs.filter(r => REQUEST_KINDS.includes(r.kind));
  switch (name) {
    case "pool": {
      const n = loadedNow(telemetry).size;
      return n ? [`${n} loaded`, true] : ["none loaded", false];
    }
    case "moa": {
      const n = rs.filter(r => r.kind === "moa_turn").length;
      return n ? [`${n} turns`, true] : ["no turns", false];
    }
    case "host": {
      const hosts = new Set(telemetry.filter(r => r.kind === "host_stats").map(r => r.host));
      return hosts.size ? [`${hosts.size} hosts`, true] : ["no stats", false];
    }
    case "context":
    case "efficiency":
      return reqs.length ? [`${reqs.length} calls`, true] : ["no calls", false];
    case "variance": {
      const models = new Set(reqs.map(r => r.model).filter(Boolean));
      return models.size ? [`${models.size} models`, true] : ["no calls", false];
    }
    case "guardrails": {
      const n = rs.filter(r => r.kind === "guardrail_halt" || r.kind === "guardrail_block").length;
      const e = emptyResponseStats(rs).length;
      const total = n + e;
      return total ? [`${n} events · ${e} empty-resp`, true] : ["none", false];
    }
    case "conversations": {
      const roots = new Set(reqs.map(r => rootOf(r)).filter(Boolean));
      return roots.size ? [`${roots.size} convos`, true] : ["no convos", false];
    }
  }
  return ["", false];
}
// Keep diagnostic summary chips current, and auto-open sections that have
// data so they're discoverable (until the user toggles them manually).
function refreshDiagnosticSummaries(rs) {
  const telemetry = filteredTelemetry();
  for (const detail of diagnosticElements) {
    const name = detail.dataset.diagnostic;
    const [text, hasData] = diagnosticSummary(name, rs, telemetry);
    const chip = detail.querySelector(".diagsum");
    if (chip) {
      chip.textContent = text;
      chip.classList.toggle("has-data", hasData);
    }
    if (hasData && !detail.open && !diagnosticUserToggled.has(name)) {
      detail.open = true;  // toggle listener renders the section
    }
  }
}
function renderAll() {
  const focusKey = captureFocusKey();
  const rs = filteredRecords();
  refreshHostOptions();
  renderFilterChips();
  renderFleet(rs);
  renderHealthBanner();
  renderTiles(rs);
  renderCharts(rs);
  renderModelStats(rs);
  renderErrors(rs);
  renderFeed(rs);
  renderOpenDiagnostics(rs);
  refreshDiagnosticSummaries(rs);
  renderOpsFooter();
  writeHashState();
  restoreFocusKey(focusKey);
}

/* ---------- router / resize / boot ---------- */
function syncRoute() {
  if (typeof location === "undefined") return;
  const hash = (location.hash || "#/").replace(/^#/, "");
  const path = hash.startsWith("/") ? hash : "/" + hash;
  const onBenchmark = path === "/benchmark" || path.startsWith("/benchmark/");
  const onEvents = path === "/events" || path.startsWith("/events/");
  const page = onEvents ? "events" : onBenchmark ? "benchmark" : "overview";
  const topnav = document.getElementById("topnav");
  if (topnav) {
    topnav.querySelectorAll("a").forEach((a) => {
      const active = a.dataset.nav === page;
      a.classList.toggle("on", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  const overview = document.getElementById("page-overview");
  const bench = document.getElementById("page-benchmark");
  const eventsPage = document.getElementById("page-events");
  if (page === "events") {
    if (window.HermesBenchmark) window.HermesBenchmark.hide();
    if (overview) overview.hidden = true;
    if (bench) bench.hidden = true;
    if (eventsPage) eventsPage.hidden = false;
    if (window.HermesEvents) window.HermesEvents.show();
    return;
  }
  if (window.HermesEvents) window.HermesEvents.hide();
  if (eventsPage) eventsPage.hidden = true;
  if (onBenchmark) {
    if (window.HermesBenchmark) window.HermesBenchmark.show();
    else {
      if (overview) overview.hidden = true;
      if (bench) bench.hidden = false;
    }
    return;
  }
  if (window.HermesBenchmark) {
    window.HermesBenchmark.hide();
  } else {
    if (overview) overview.hidden = false;
    if (bench) bench.hidden = true;
  }
  // N8: arriving on (or editing to) a param hash re-applies the view state.
  // Range changes need a new history window; anything else just re-renders.
  const rest = hashViewParams();
  if (rest != null && rest !== lastAppliedHash) {
    const rangeChanged = applyHashState();
    if (rangeChanged) refetch();
    else renderAll();
  }
}
let resizeRaf = 0;
window.addEventListener("resize", () => {
  if (resizeRaf) return;  // coalesce resize bursts into one render per frame
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    if ($("page-overview").hidden) return;  // benchmark page is up — nothing to redraw
    const rs = filteredRecords();
    renderCharts(rs);
    renderKpiSparklines(rs);   // canvas sparklines + fleet cards are width-sensitive
    renderFleet(rs);
    renderOpenDiagnostics(rs);
  });
});
/* ---------- model router card (presence-aware role aliases + service notes) ---------- */
async function loadRouterCard() {
  const rolesEl = $("routerroles"), notesEl = $("routernotes");
  if (!rolesEl || !notesEl) return;
  try {
    const s = await (await fetch("/api/router-status")).json();
    if (s.error || !s.roles) {
      rolesEl.innerHTML = `<div class="empty">Router unreachable: ${esc(s.error || "no role data")}</div>`;
      $("routermeta").textContent = "presence-aware aliases → live models";
    } else {
      const age = s.last_poll_age_s;
      $("routermeta").textContent =
        `${Object.keys(s.loaded || {}).length} models live · presence checked ${age == null ? "never" : age + "s ago"} · every ${s.poll_interval_s}s`;
      rolesEl.innerHTML = `<table style="width:100%;border-collapse:collapse">` +
        Object.entries(s.roles).sort().map(([role, v]) => {
          const res = v.resolved
            ? `<span class="chip mchip"><span class="msw" style="background:${colorFor(v.resolved)}"></span>${esc(v.resolved)}</span>`
            : `<span style="color:var(--ink-3)">offline — ${v.strict ? "voice skipped (strict)" : "falls back"}</span>`;
          return `<tr style="border-top:1px solid var(--grid)">` +
            `<td style="padding:4px 8px 4px 0;white-space:nowrap"><code>${esc(role)}</code>${v.strict ? ` <span class="feed-meta">strict</span>` : ""}</td>` +
            `<td style="padding:4px 0">${res}</td></tr>`;
        }).join("") + `</table>`;
    }
  } catch (e) {
    rolesEl.innerHTML = `<div class="empty">Router status unavailable (${esc(e.message)})</div>`;
  }
  try {
    const u = await (await fetch("/api/router-usage?since_h=24")).json();
    const usageEl = $("routerusage"), degEl = $("routerdegrade");
    const roles = Object.entries(u.roles || {}).sort((a, b) => b[1].requests - a[1].requests);
    if (!roles.length) {
      usageEl.innerHTML = `<div class="empty">No routed requests in the last 24h.</div>`;
    } else {
      usageEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums">
        <tr style="color:var(--ink-3);text-align:left"><th style="padding:2px 8px 2px 0">role</th><th>req</th><th>err</th><th>fallth.</th><th>retry</th><th>p50</th><th>p95</th><th>tokens in+out</th><th>resolved to</th></tr>` +
        roles.map(([name, a]) => {
          const models = Object.entries(a.models || {}).sort((x, y) => y[1] - x[1])
            .map(([m, n]) => `${n}× <span class="msw" style="background:${colorFor(m)}"></span>${esc(m)}`).join("<br>");
          return `<tr style="border-top:1px solid var(--grid)">
            <td style="padding:3px 8px 3px 0"><code>${esc(name)}</code></td>
            <td>${a.requests}</td>
            <td${a.errors ? ' style="color:var(--bad,#e66)"' : ""}>${a.errors}</td>
            <td>${a.fallthroughs}</td><td>${a.retries}</td>
            <td>${a.p50_s ?? "–"}s</td><td>${a.p95_s ?? "–"}s</td>
            <td>${a.tokens_in}+${a.tokens_out}</td>
            <td>${models}</td></tr>`;
        }).join("") + `</table>`;
    }
    const degs = u.degradations || [];
    degEl.innerHTML = !degs.length ? "" :
      `<div style="margin-top:8px"><span class="feed-meta">recent degradations (503 / fallthrough / retry)</span>` +
      degs.slice(-8).reverse().map(d =>
        `<div style="color:var(--ink-3);padding:2px 0">${esc(d.ts || "")} · <code>${esc(d.role)}</code> · ${d.status} ${esc(d.reason || "")}${d.model ? " → " + esc(d.model) : ""}</div>`).join("") + `</div>`;
  } catch (e) {
    $("routerusage").innerHTML = `<div class="empty">Usage unavailable (${esc(e.message)})</div>`;
  }
  try {
    const n = await (await fetch("/api/router-notes")).json();
    const notes = n.notes || [];
    notesEl.innerHTML = !notes.length
      ? `<div class="empty">No analysis notes yet.</div>`
      : notes.map(note => `
        <div style="border-top:1px solid var(--grid);padding:8px 0">
          <div><strong>${esc(note.title)}</strong>
            <span class="feed-meta">${esc(note.ts || "")}${note.kind ? " · " + esc(note.kind) : ""}</span></div>
          ${note.summary ? `<div style="margin:4px 0">${esc(note.summary)}</div>` : ""}
          ${(note.details || []).length
            ? `<ul style="margin:4px 0 0 18px;color:var(--ink-3)">${note.details.map(d => `<li>${esc(d)}</li>`).join("")}</ul>`
            : ""}
        </div>`).join("");
  } catch (e) {
    notesEl.innerHTML = `<div class="empty">Notes unavailable (${esc(e.message)})</div>`;
  }
}

function startDashboard() {
  wireContextTips();
  wireEnvModeControls();
  wireThemeToggle();
  syncRoute();
  loadRouterCard();
  setInterval(loadRouterCard, 30000);
  // Prefer a history snapshot after the SSE subscription is live. If the
  // handshake is slow, show fallback history, then refresh it once subscribed
  // so events from the fallback window cannot fall through a startup gap.
  const fallback = setTimeout(refetch, 1000);
  connectSSE(() => {
    clearTimeout(fallback);
    refetch();
  });
}
if (typeof window !== "undefined") window.addEventListener("hashchange", syncRoute);
startDashboard();
