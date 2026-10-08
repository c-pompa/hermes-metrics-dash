/* Hermes Metrics — unified contextual tooltips + accessible chart-point inspector. */
"use strict";

const WIDGET_HELP = {
  chart: "Per-request metric over time, colored by model. Failed requests appear as × marks on the baseline.",
  volume: "Token totals in each time bucket, stacked by model. Use output or in+out to compare prompt growth versus generation.",
  errors: "Most recent failed requests in the selected range, with host, model, and conversation context.",
  feed: "Sortable live request table. Use focus to filter the dashboard to one conversation.",
  waterfall: "Each MoA turn shows proposer bars in parallel, then the aggregator segment after the slowest proposer.",
  host: "Host telemetry sampled about every 30 seconds. CPU is 1-minute load; memory is used GB on each machine.",
  context: "Input tokens per call for recent conversations. Rising lines usually mean growing prompt context. Green ▼ marks a compaction (context shrank between calls); a red cross marks a failed request.",
  compression: "Tokens in flight simultaneously per model — every parallel slot shares one KV pool of the loaded context length, so requests fail when the combined line crosses the dashed cap.",
  efficiency: "Duration versus output tokens on a log-x axis. Dashed curves are constant tok/s guides.",
  variance: "Per-model spread for the selected metric: grey band is min–max, tick is median, dot is latest call.",
};
const TILE_HELP = {
  conn: "Live connection state between the dashboard, history fetch, and SSE stream.",
  err: "Count of failed LLM requests in the active time range and filters.",
  latency: "Median request duration across API, MoA turn, and MoA reference calls.",
  tps: "Median output tokens per second across successful requests.",
  req: "Number of API and MoA reference/turn requests in the active range.",
  tok: "Total input and output tokens summed across request records.",
  conv: "Distinct root conversations represented in the filtered records.",
  cache: "Provider-reported cache-read tokens as a share of total prompt tokens.",
  pool: "Peak concurrent in-flight context on the busiest model as a share of its loaded KV pool. Near 100% means concurrent requests can exceed the context window and fail.",
};

/* ---------- unified contextual tooltips ---------- */
let contextTipPinned = false;
function hideContextTip(tip = $("contexttip")) {
  if (!tip) return;
  tip.style.display = "none";
  tip.hidden = true;
  tip.innerHTML = "";
  contextTipPinned = false;
}
function positionFixedTip(tip, clientX, clientY) {
  tip.hidden = false;
  tip.style.display = "block";
  const margin = 14;
  const width = tip.offsetWidth || 220;
  const height = tip.offsetHeight || 120;
  let left = clientX + margin;
  let top = clientY + margin;
  if (left + width > window.innerWidth - 8) left = Math.max(8, clientX - width - margin);
  if (top + height > window.innerHeight - 8) top = Math.max(8, clientY - height - margin);
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
function tipFromScope(el) {
  const scope = el.dataset.tipScope;
  if (scope === "tile") {
    const key = el.dataset.tipKey;
    const title = el.querySelector(".k")?.textContent || key;
    const value = el.querySelector(".v")?.textContent || "–";
    const sub = el.querySelector(".sub")?.textContent || "";
    return `<div class="t-model">${esc(title)}</div>`
      + `<div class="row"><span>current</span><b>${esc(value)}</b></div>`
      + (sub ? `<div class="tip-note">${esc(sub)}</div>` : "")
      + `<div class="tip-note">${esc(TILE_HELP[key] || "")}</div>`;
  }
  if (scope === "variance") {
    const fmtV = el.dataset.tipMetricKind === "output_tokens" ? fmtTok : fmtDuration;
    return `<div class="t-model"><span class="msw" style="background:${colorFor(el.dataset.tipModel)}"></span>${esc(el.dataset.tipModel || "?")}</div>`
      + `<div class="row"><span>metric</span><b>${esc(el.dataset.tipMetric || metricLabel[metric])}</b></div>`
      + `<div class="row"><span>latest</span><b>${fmtV(Number(el.dataset.tipLast))}</b></div>`
      + `<div class="row"><span>median</span><b>${fmtV(Number(el.dataset.tipMed))}</b></div>`
      + `<div class="row"><span>range</span><b>${fmtV(Number(el.dataset.tipMin))}–${fmtV(Number(el.dataset.tipMax))}</b></div>`
      + `<div class="row"><span>calls</span><b>${esc(el.dataset.tipN || "0")}</b></div>`
      + (el.dataset.tipLoaded ? `<div class="row"><span>loaded @</span><b>${esc(el.dataset.tipLoaded)}</b></div>`
        : el.dataset.tipPoolActive === "1" ? `<div class="tip-note">not currently loaded in pool</div>` : "");
  }
  if (scope === "waterfall-row") {
    return `<div class="t-model"><span class="msw" style="background:${colorFor(el.dataset.tipModel)}"></span>${esc(el.dataset.tipModel || "?")}</div>`
      + `<div class="row"><span>role</span><b>${esc(el.dataset.tipRole || "proposer")}</b></div>`
      + `<div class="row"><span>duration</span><b>${fmtDuration(Number(el.dataset.tipDuration))}</b></div>`
      + (el.dataset.tipTps ? `<div class="row"><span>speed</span><b>${fmt1(Number(el.dataset.tipTps))} tok/s</b></div>` : "")
      + (el.dataset.tipOut ? `<div class="row"><span>output</span><b>${fmtTok(Number(el.dataset.tipOut))}</b></div>` : "")
      + (el.dataset.tipTurn ? `<div class="tip-note">turn ${esc(el.dataset.tipTurn)}</div>` : "");
  }
  if (scope === "waterfall-turn") {
    return `<div class="t-model">${esc(el.dataset.tipTitle || "?")}</div>`
      + `<div class="row"><span>time</span><b>${esc(el.dataset.tipTime || "")}</b></div>`
      + `<div class="row"><span>preset</span><b>${esc(el.dataset.tipPreset || "?")}</b></div>`
      + `<div class="row"><span>total duration</span><b>${fmtDuration(Number(el.dataset.tipDuration))}</b></div>`
      + `<div class="tip-note">Proposers run in parallel; aggregator starts after the slowest proposer.</div>`;
  }
  if (scope === "feed") {
    return `<div class="t-model"><span class="msw" style="background:${colorFor(el.dataset.tipModel)}"></span>${esc(el.dataset.tipModel || "?")}</div>`
      + `<div class="row"><span>${esc(el.dataset.tipKind || "request")} · ${esc(el.dataset.tipHost || "")}</span><b>${esc(el.dataset.tipTime || "")}</b></div>`
      + `<div class="row"><span>tokens in / out</span><b>${esc(el.dataset.tipIn || "–")} / ${esc(el.dataset.tipOut || "–")}</b></div>`
      + `<div class="row"><span>duration</span><b>${fmtDuration(Number(el.dataset.tipDuration))}</b></div>`
      + `<div class="row"><span>speed</span><b>${fmt1(Number(el.dataset.tipTps))} tok/s</b></div>`
      // R4: only rendered when the backend populates them (never on LM Studio 0.4.x).
      + (el.dataset.tipTtft ? `<div class="row"><span>TTFT</span><b>${fmt1(Number(el.dataset.tipTtft))}s</b></div>` : "")
      + (el.dataset.tipNative ? `<div class="row"><span>native speed</span><b>${fmt1(Number(el.dataset.tipNative))} tok/s</b></div>` : "")
      + (el.dataset.tipSpec ? `<div class="row"><span>spec accept</span><b>${esc(el.dataset.tipSpec)}%</b></div>` : "")
      + (el.dataset.tipConvo ? `<div class="row"><span>conversation</span><b>${esc(el.dataset.tipConvo)}</b></div>` : "")
      + (el.dataset.tipError ? `<div class="row"><span style="color:var(--critical)">error</span><b>${esc(el.dataset.tipError)}</b></div>` : "");
  }
  if (scope === "error") {
    return `<div class="t-model">${esc(el.dataset.tipModel || "?")}</div>`
      + `<div class="row"><span>${esc(el.dataset.tipTime || "")}</span><b>${esc(el.dataset.tipHost || "")}</b></div>`
      + `<div class="row"><span>conversation</span><b>${esc(el.dataset.tipConvo || "?")}</b></div>`
      + `<div class="tip-note" style="color:var(--critical)">${esc(el.dataset.tipError || "request failed")}</div>`;
  }
  return null;
}
function shouldSkipContextTipTarget(target) {
  return Boolean(target.closest("button:not(.help-btn), [data-sort], summary, .seg, .help-btn, canvas"));
}
function attachPointerTip({ container, tip, selector = ".tip-target" }) {
  if (!container || !tip || container.dataset.tipBound) return;
  container.dataset.tipBound = "1";
  let pinnedTarget = null;
  function show(target, clientX, clientY) {
    const html = tipFromScope(target);
    if (!html) { hideContextTip(tip); return; }
    tip.innerHTML = html;
    positionFixedTip(tip, clientX, clientY);
  }
  container.addEventListener("pointermove", ev => {
    if (contextTipPinned && pinnedTarget && ev.pointerType === "touch") return;
    if (shouldSkipContextTipTarget(ev.target)) {
      if (!pinnedTarget) hideContextTip(tip);
      return;
    }
    const target = ev.target.closest(selector);
    if (!target) {
      if (!pinnedTarget) hideContextTip(tip);
      return;
    }
    if (ev.pointerType === "mouse") pinnedTarget = null;
    show(target, ev.clientX, ev.clientY);
  });
  container.addEventListener("pointerdown", ev => {
    if (shouldSkipContextTipTarget(ev.target)) return;
    const target = ev.target.closest(selector);
    if (!target || ev.pointerType === "mouse") return;
    if (pinnedTarget === target) {
      pinnedTarget = null;
      contextTipPinned = false;
      hideContextTip(tip);
      return;
    }
    pinnedTarget = target;
    contextTipPinned = true;
    show(target, ev.clientX, ev.clientY);
  });
  container.addEventListener("pointerleave", ev => {
    if (ev.pointerType === "mouse" && !pinnedTarget) hideContextTip(tip);
  });
  container.addEventListener("focusin", ev => {
    const target = ev.target.closest(selector);
    if (!target || shouldSkipContextTipTarget(ev.target)) return;
    const rect = target.getBoundingClientRect();
    show(target, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  container.addEventListener("focusout", () => {
    if (!pinnedTarget) hideContextTip(tip);
  });
}
function wireHelpTips() {
  const tip = $("contexttip");
  for (const btn of document.querySelectorAll(".help-btn")) {
    if (btn.dataset.helpBound) continue;
    btn.dataset.helpBound = "1";
    const show = ev => {
      const text = WIDGET_HELP[btn.dataset.help];
      if (!text) return;
      tip.innerHTML = `<div class="t-model">${esc(btn.getAttribute("aria-label") || "Help")}</div><div class="tip-note">${esc(text)}</div>`;
      positionFixedTip(tip, ev.clientX || 0, ev.clientY || 0);
    };
    btn.addEventListener("pointerenter", show);
    btn.addEventListener("focus", ev => {
      const rect = btn.getBoundingClientRect();
      show({ clientX: rect.right, clientY: rect.bottom });
    });
    btn.addEventListener("pointerleave", () => { if (!contextTipPinned) hideContextTip(tip); });
    btn.addEventListener("blur", () => { if (!contextTipPinned) hideContextTip(tip); });
  }
}
function wireContextTips() {
  if (document.body.dataset.contextTipsBound) return;
  document.body.dataset.contextTipsBound = "1";
  const tip = $("contexttip");
  attachPointerTip({ container: $("operations-summary"), tip });
  attachPointerTip({ container: $("variance"), tip });
  attachPointerTip({ container: $("waterfall"), tip });
  attachPointerTip({ container: $("feedwrap"), tip, selector: "#feed tr.tip-target" });
  attachPointerTip({ container: $("errorsfeed"), tip });
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") hideContextTip(tip);
  });
  wireHelpTips();
}

/* ---------- accessible chart inspection ---------- */
function attachChartInspector(wrapId, tipId, getPts, renderTip, axisOnly = false, opts = {}) {
  const { pointer = true, onPoint = null } = opts;
  const wrap = $(wrapId);
  const tip = $(tipId);
  let pointerPinned = false;
  let pinnedPoint = null;
  function show(point, clientX, clientY) {
    if (!point) { tip.style.display = "none"; return; }
    tip.innerHTML = renderTip(point);
    tip.style.display = "block";
    const svg = wrap.querySelector("svg");
    const svgRect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const wrapRect = wrap.getBoundingClientRect();
    const px = clientX ?? svgRect.left + point.cx / vb.width * svgRect.width;
    const py = clientY ?? svgRect.top + point.cy / vb.height * svgRect.height;
    let left = px - wrapRect.left + 14;
    const top = py - wrapRect.top + 10;
    if (left + 240 > wrapRect.width) left -= 260;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }
  function nearest(ev) {
    const svg = wrap.querySelector("svg"), rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const sx = (ev.clientX - rect.left) * (vb.width / rect.width);
    const sy = (ev.clientY - rect.top) * (vb.height / rect.height);
    let best = null, bestDistance = 576; // 24px radius gives touch a roughly 48px target.
    for (const p of getPts()) {
      const distance = (p.cx-sx)**2 + (axisOnly ? 0 : (p.cy-sy)**2);
      if (distance < bestDistance) { bestDistance = distance; best = p; }
    }
    return best;
  }
  if (pointer) {
    wrap.addEventListener("pointermove", ev => {
      if (ev.pointerType === "touch" && pointerPinned) return;
      if (ev.pointerType === "mouse") { pointerPinned = false; pinnedPoint = null; }
      const point = nearest(ev);
      if (onPoint) onPoint(point);
      show(point, ev.clientX, ev.clientY);
    });
    wrap.addEventListener("pointerdown", ev => {
      const point = nearest(ev);
      if (!point) {
        pointerPinned = false;
        pinnedPoint = null;
        tip.style.display = "none";
        return;
      }
      if (ev.pointerType !== "mouse" && pointerPinned && point === pinnedPoint) {
        pointerPinned = false;
        pinnedPoint = null;
        tip.style.display = "none";
        return;
      }
      pointerPinned = ev.pointerType !== "mouse";
      pinnedPoint = pointerPinned ? point : null;
      show(point, ev.clientX, ev.clientY);
    });
    wrap.addEventListener("pointerleave", ev => {
      if (!pointerPinned || ev.pointerType === "mouse") tip.style.display = "none";
      if (onPoint) onPoint(null);
    });
  }
  wrap.addEventListener("focusin", ev => {
    const index = Number(ev.target.dataset?.pointIndex);
    if (Number.isInteger(index)) {
      const point = getPts()[index];
      if (onPoint) onPoint(point || null);
      show(point);
    }
  });
  wrap.addEventListener("focusout", () => {
    if (!pointerPinned) tip.style.display = "none";
    if (onPoint) onPoint(null);
  });
  wrap.addEventListener("keydown", ev => {
    if (ev.key === "Escape") {
      pointerPinned = false;
      pinnedPoint = null;
      tip.style.display = "none";
      return;
    }
    const direction = {
      ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1
    }[ev.key];
    const marks = [...wrap.querySelectorAll(".chart-mark")];
    if (!marks.length || (direction == null && ev.key !== "Home" && ev.key !== "End")) return;
    const current = marks.indexOf(ev.target);
    if (current < 0) return;
    const next = ev.key === "Home" ? 0 : ev.key === "End" ? marks.length - 1
      : Math.max(0, Math.min(current + direction, marks.length - 1));
    ev.preventDefault();
    marks.forEach((mark, index) => mark.setAttribute("tabindex", index === next ? "0" : "-1"));
    const chartId = marks[next].dataset.chartId;
    if (chartId) chartRovingIndex.set(chartId, next);
    marks[next].focus({ preventScroll: true });
  });
}
