/* Hermes Metrics — filter wiring, history refetch, feed sort, segmented controls. */
"use strict";

/* ---------- history refetch ----------
   Two lanes (R1/R7): the request window fetches with exclude=pool_status,
   host_stats so 20k rows hold deep request history, while a separate
   telemetry fetch keeps the fleet strip + host charts fed. The "show
   heartbeats" toggle (or an explicit heartbeat kind filter) restores the old
   combined feed with a single fetch. */
async function refetch() {
  const [a, b] = getWindow();
  const generation = ++refetchGeneration;
  const liveStart = liveSequence;
  if (activeHistoryRequest) activeHistoryRequest.abort();
  if (activeTelemetryRequest) activeTelemetryRequest.abort();
  const controller = new AbortController();
  activeHistoryRequest = controller;
  const includeHeartbeats = showHeartbeats || HEARTBEAT_KINDS.includes(kindFilter);
  const exclude = includeHeartbeats ? "" : "&exclude=pool_status,host_stats";
  historyState = "loading";
  updateConnectionStatus();
  try {
    const respPromise = fetch(
      `/api/recent?from=${a}&to=${b}&limit=${MAXRECS}${exclude}`,
      { signal: controller.signal }
    );
    // Telemetry runs in parallel: the fleet strip, host charts, and health
    // banner must not wait on (or share the fate of) the request history.
    if (!includeHeartbeats) fetchTelemetry(a, b, generation, liveStart);
    const resp = await respPromise;
    if (generation !== refetchGeneration) return;
    if (!resp.ok) {
      let message = `history request failed (${resp.status})`;
      try {
        const detail = await resp.json();
        if (detail.error) message = detail.error;
      } catch (e) {}
      throw new Error(message);
    }
    const payload = await resp.json();
    if (generation !== refetchGeneration) return;
    if (!Array.isArray(payload.records)) throw new Error("history response did not contain records");
    const liveDuringFetch = liveBuffer
      .filter(entry => entry.sequence > liveStart)
      .map(entry => entry.record);
    replaceRecords([...payload.records, ...liveDuringFetch]);
    if (includeHeartbeats) replaceTelemetry([...payload.records, ...liveDuringFetch]);
    renderAll();
    historyState = "ok";
    updateConnectionStatus();
    refreshOpsMeta();
  } catch (error) {
    if (generation !== refetchGeneration || error.name === "AbortError") return;
    console.warn("Unable to load dashboard history", error);
    renderAll();
    historyState = "stale";
    updateConnectionStatus();
  } finally {
    if (generation === refetchGeneration) activeHistoryRequest = null;
  }
}
async function fetchTelemetry(a, b, generation, liveStart) {
  const controller = new AbortController();
  activeTelemetryRequest = controller;
  // Always cover at least the trailing 24h so stale hosts stay visible (N15)
  // and load-uptime transitions (N14) have history even in short windows.
  const from = Math.min(a, b - 86400);
  try {
    const resp = await fetch(
      `/api/recent?from=${from}&to=${b}&limit=${MAXTELEMETRY}`,
      { signal: controller.signal }
    );
    if (generation !== refetchGeneration) return;
    if (!resp.ok) throw new Error(`telemetry request failed (${resp.status})`);
    const payload = await resp.json();
    if (generation !== refetchGeneration) return;
    if (!Array.isArray(payload.records)) throw new Error("telemetry response did not contain records");
    const liveDuringFetch = liveBuffer
      .filter(entry => entry.sequence > liveStart)
      .map(entry => entry.record);
    replaceTelemetry([...payload.records, ...liveDuringFetch]);
    scheduleRender();
  } catch (error) {
    if (error.name === "AbortError" || generation !== refetchGeneration) return;
    console.warn("Unable to load host telemetry", error);
  } finally {
    if (generation === refetchGeneration) activeTelemetryRequest = null;
  }
}
$("retryload").addEventListener("click", refetch);
$("hbtoggle").addEventListener("click", () => {
  showHeartbeats = !showHeartbeats;
  refetch();
});
$("csvexport").addEventListener("click", () => { exportFeedCsv(); });

/* ---------- feed sort ---------- */
function compareFeedRecords(a, b) {
  const { key, direction } = feedSort;
  let cmp;
  if (NUMERIC_SORTS.has(key)) {
    cmp = (Number(a[key]) || 0) - (Number(b[key]) || 0);
  } else {
    cmp = String(a[key] || "").localeCompare(String(b[key] || ""));
  }
  if (cmp) return direction === "asc" ? cmp : -cmp;
  if (key !== "ts" && a.ts !== b.ts) return (Number(b.ts) || 0) - (Number(a.ts) || 0);
  return stableRecordKey(a).localeCompare(stableRecordKey(b));
}
function sortedFeedRows(rs) {
  return rs
    .filter(r => r.kind !== "subagent_stop" && (showHeartbeats || !HEARTBEAT_KINDS.includes(r.kind)))
    .slice()
    .sort(compareFeedRecords);
}

/* ---------- filter state ---------- */
function refreshHostOptions() {
  const sel = $("hostsel");
  const hosts = [...new Set(records.map(r => r.host).filter(Boolean))].sort();
  const want = ['<option value="">all hosts</option>', ...hosts.map(h => `<option value="${esc(h)}">${esc(h)}</option>`)].join("");
  if (sel.dataset.built !== want) {
    sel.innerHTML = want;
    sel.dataset.built = want;
  }
  sel.value = hostFilter;
}
let lastFilterStatusKey = null;
function renderFilterChips() {
  const parts = [];
  const summaries = [];
  if (hostFilter) { summaries.push(`host ${hostFilter}`); parts.push(`<button class="chip fchip" type="button" data-clear="host" ${focusKeyAttribute("filter", "host")} title="Clear host filter">host: ${esc(hostFilter)} <span class="ico ico-x" aria-hidden="true"></span></button>`); }
  if (textFilter) { summaries.push(`search ${textFilter.slice(0, 32)}`); parts.push(`<button class="chip fchip" type="button" data-clear="text" ${focusKeyAttribute("filter", "text")} title="Clear search filter">search: ${esc(textFilter)} <span class="ico ico-x" aria-hidden="true"></span></button>`); }
  if (kindFilter) { summaries.push(`event ${KINDNAME[kindFilter] || kindFilter}`); parts.push(`<button class="chip fchip" type="button" data-clear="kind" ${focusKeyAttribute("filter", "kind")} title="Clear event filter">event: ${esc(KINDNAME[kindFilter] || kindFilter)} <span class="ico ico-x" aria-hidden="true"></span></button>`); }
  if (errorsOnly) { summaries.push("errors only"); parts.push(`<button class="chip fchip" type="button" data-clear="errors" ${focusKeyAttribute("filter", "errors")} title="Clear errors-only filter">errors only <span class="ico ico-x" aria-hidden="true"></span></button>`); }
  if (convoFilter) { summaries.push(`conversation ${(convoFilter.label || shortSess(convoFilter.root)).slice(0, 32)}`); parts.push(`<button class="chip fchip" type="button" data-clear="convo" ${focusKeyAttribute("filter", "convo")} title="Clear conversation filter">convo: ${esc(convoFilter.label || shortSess(convoFilter.root))} <span class="ico ico-x" aria-hidden="true"></span></button>`); }
  if (modelFilter) { summaries.push(`model ${modelFilter.slice(0, 32)}`); parts.push(`<button class="chip fchip" type="button" data-clear="model" ${focusKeyAttribute("filter", "model")} title="Clear model filter">model: ${esc(modelFilter.length > 34 ? modelFilter.slice(0,33) + "…" : modelFilter)} <span class="ico ico-x" aria-hidden="true"></span></button>`); }
  const markup = parts.join("");
  if ($("activefilters").innerHTML !== markup) $("activefilters").innerHTML = markup;
  const statusKey = JSON.stringify([hostFilter, textFilter, kindFilter, errorsOnly, convoFilter?.root || "", modelFilter || ""]);
  if (statusKey !== lastFilterStatusKey) {
    lastFilterStatusKey = statusKey;
    $("filterstatus").textContent = summaries.length ? `Filters: ${summaries.join("; ")}.` : "Filters cleared.";
  }
  $("clearfilters").disabled = !parts.length;
}
$("activefilters").addEventListener("click", ev => {
  const c = ev.target.closest("[data-clear]"); if (!c) return;
  clearFilterFromControl(c.dataset.clear);
});
function cancelPendingTextFilter() {
  if (textFilterTimer != null) {
    clearTimeout(textFilterTimer);
    textFilterTimer = null;
  }
}
function clearFilter(filter) {
  if (filter === "host") { hostFilter = ""; $("hostsel").value = ""; }
  else if (filter === "text") {
    cancelPendingTextFilter();
    textFilter = "";
    $("searchfilter").value = "";
  } else if (filter === "kind") { kindFilter = ""; $("kindfilter").value = ""; }
  else if (filter === "errors") { errorsOnly = false; $("errorsonly").checked = false; }
  else if (filter === "convo") convoFilter = null;
  else if (filter === "model") modelFilter = null;
}
function clearFilterFromControl(filter) {
  clearFilter(filter);
  renderAll();
  const targetId = {
    host: "hostsel", text: "searchfilter", kind: "kindfilter", errors: "errorsonly",
    convo: "searchfilter", model: "searchfilter"
  }[filter] || "searchfilter";
  $(targetId).focus({ preventScroll: true });
}
function clearAllFilters() {
  cancelPendingTextFilter();
  hostFilter = "";
  textFilter = "";
  kindFilter = "";
  errorsOnly = false;
  convoFilter = null;
  modelFilter = null;
  $("hostsel").value = "";
  $("searchfilter").value = "";
  $("kindfilter").value = "";
  $("errorsonly").checked = false;
  renderAll();
}
function textMatches(r) {
  if (!textFilter) return true;
  const searchable = [
    r.model, r.session_id, r.parent_session_id, r.session_title, r.error, r.host
  ].filter(value => value != null).join(" ").toLocaleLowerCase();
  return searchable.includes(textFilter.toLocaleLowerCase());
}
function queueTextFilter(value) {
  if (textFilterTimer != null) clearTimeout(textFilterTimer);
  textFilterTimer = setTimeout(() => {
    textFilterTimer = null;
    textFilter = value.trim();
    renderAll();
  }, 250);
}
function filteredRecords() {
  curWin = getWindow();
  return records.filter(r => {
    if (!inRange(r)) return false;
    if (!textMatches(r)) return false;
    if (kindFilter && r.kind !== kindFilter) return false;
    if (errorsOnly && r.kind !== "error") return false;
    // Machine telemetry lives in the telemetry store (see filteredTelemetry)
    // and no longer passes through here — heartbeats don't drive the feed.
    if (convoFilter && rootOf(r) !== convoFilter.root) return false;
    if (modelFilter && r.model !== modelFilter) return false;
    return true;
  });
}

/* ---------- control listeners ---------- */
$("hostsel").addEventListener("change", () => { hostFilter = $("hostsel").value; renderAll(); });
$("searchfilter").addEventListener("input", () => queueTextFilter($("searchfilter").value));
$("kindfilter").addEventListener("change", () => { kindFilter = $("kindfilter").value; renderAll(); });
$("errorsonly").addEventListener("change", () => { errorsOnly = $("errorsonly").checked; renderAll(); });
$("clearfilters").addEventListener("click", clearAllFilters);
for (const id of ["vollegend", "variance", "poolnow"]) {
  $(id).addEventListener("click", ev => {
    const c = ev.target.closest("[data-model]"); if (!c) return;
    modelFilter = modelFilter === c.dataset.model ? null : c.dataset.model;
    renderAll();
  });
}
/* Speed-chart legend chips toggle series visibility in the chart only
   (clean-design) — distinct from the dashboard-wide model filter above. */
$("legend").addEventListener("click", ev => {
  const c = ev.target.closest("[data-model]"); if (!c) return;
  const m = c.dataset.model;
  if (hiddenSeries.has(m)) hiddenSeries.delete(m);
  else hiddenSeries.add(m);
  renderChart(filteredRecords());
});
/* Feed row → series linking: hovering a feed row isolates its model's
   series in the speed chart by dimming the others. */
function setChartHighlight(model) {
  const next = model || null;
  if (next === chartHighlightModel) return;
  chartHighlightModel = next;
  renderChart(filteredRecords());
}
$("feedwrap").addEventListener("pointerover", ev => {
  const tr = ev.target && ev.target.closest ? ev.target.closest("tr[data-tip-model]") : null;
  setChartHighlight(tr ? tr.dataset.tipModel : null);
});
$("feedwrap").addEventListener("pointerleave", () => setChartHighlight(null));
function toggleConversationFilter(control) {
  if (!control || !control.dataset.root) return;
  convoFilter = convoFilter && convoFilter.root === control.dataset.root ? null
    : { root: control.dataset.root, label: control.dataset.label || null };
  renderAll();
}
$("feed").addEventListener("click", ev => {
  const groupBtn = ev.target.closest(".errgroup");
  if (groupBtn) {
    expandedErrorGroups.add(groupBtn.dataset.gkey);
    renderFeed(filteredRecords());
    return;
  }
  toggleConversationFilter(ev.target.closest(".feed-focus"));
});
$("feedwrap").addEventListener("click", ev => {
  const button = ev.target.closest("[data-sort]");
  if (!button) return;
  const key = button.dataset.sort;
  feedSort = feedSort.key === key
    ? { key, direction: feedSort.direction === "asc" ? "desc" : "asc" }
    : { key, direction: NUMERIC_SORTS.has(key) ? "desc" : "asc" };
  renderFeed(filteredRecords());
});
$("rangesel").addEventListener("click", ev => {
  const b = ev.target.closest("button"); if (!b) return;
  if (b.dataset.h === "custom") {
    // Prefill with the current window, then wait for apply.
    const [a, z] = getWindow();
    const toLocal = ts => { const d = new Date(ts*1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,16); };
    if (!$("custfrom").value) $("custfrom").value = toLocal(a);
    if (!$("custto").value) $("custto").value = toLocal(z);
    $("custrange").classList.add("show");
    $("custbtn").setAttribute("aria-expanded", "true");
    return;
  }
  syncPressedGroup($("rangesel"), b);
  $("custrange").classList.remove("show");
  $("custbtn").setAttribute("aria-expanded", "false");
  rangeMode = b.dataset.day != null
    ? { type: "day", offset: Number(b.dataset.day) }
    : { type: "preset", hours: Number(b.dataset.h) };
  setCustomRangeFeedback("");
  refetch();
});
function setCustomRangeFeedback(message, invalidFrom = false, invalidTo = false) {
  const fromState = String(invalidFrom);
  const toState = String(invalidTo);
  if ($("custfrom").getAttribute("aria-invalid") !== fromState) {
    $("custfrom").setAttribute("aria-invalid", fromState);
  }
  if ($("custto").getAttribute("aria-invalid") !== toState) {
    $("custto").setAttribute("aria-invalid", toState);
  }
  if ($("custerror").textContent !== message) $("custerror").textContent = message;
}
function parseExactLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = [
    match[1], match[2], match[3], match[4], match[5], match[6] || "0"
  ].map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, second, 0);
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
  ) return null;
  return date.getTime() / 1000;
}
function readCustomRange() {
  const fromValue = $("custfrom").value;
  const toValue = $("custto").value;
  if (!fromValue && !toValue) {
    setCustomRangeFeedback("Choose a start and end time.", true, true);
    return null;
  }
  if (!fromValue) {
    setCustomRangeFeedback("Choose a start time.", true, false);
    return null;
  }
  if (!toValue) {
    setCustomRangeFeedback("Choose an end time.", false, true);
    return null;
  }
  const from = parseExactLocalDateTime(fromValue);
  const to = parseExactLocalDateTime(toValue);
  if (from === null && to === null) {
    setCustomRangeFeedback("Enter valid start and end times.", true, true);
    return null;
  }
  if (from === null) {
    setCustomRangeFeedback("Enter a valid start time.", true, false);
    return null;
  }
  if (to === null) {
    setCustomRangeFeedback("Enter a valid end time.", false, true);
    return null;
  }
  if (to <= from) {
    setCustomRangeFeedback("End time must be after start time.", false, true);
    return null;
  }
  setCustomRangeFeedback("");
  return { from, to };
}
for (const id of ["custfrom", "custto"]) {
  $(id).addEventListener("input", readCustomRange);
}
$("custapply").addEventListener("click", () => {
  const range = readCustomRange();
  if (!range) return;
  rangeMode = { type: "custom", from: range.from, to: range.to };
  syncPressedGroup($("rangesel"), $("custbtn"));
  refetch();
});
$("metricsel").addEventListener("click", ev => {
  const b = ev.target.closest("button"); if (!b) return;
  metric = b.dataset.m;
  syncPressedGroup($("metricsel"), b);
  renderAll();
});
$("volmode").addEventListener("click", ev => {
  const b = ev.target.closest("button"); if (!b) return;
  volMode = b.dataset.v;
  syncPressedGroup($("volmode"), b);
  renderAll();
});
function wireThemeToggle() {
  const sel = $("themesel");
  if (!sel) return;
  const current = document.documentElement.dataset.theme || "auto";
  const active = [...sel.children].find(b => b.dataset.theme === current);
  if (active) syncPressedGroup(sel, active);
  sel.addEventListener("click", ev => {
    const b = ev.target.closest("button[data-theme]");
    if (!b) return;
    document.documentElement.dataset.theme = b.dataset.theme;
    try { localStorage.setItem("hermesMetricsTheme", b.dataset.theme); } catch (e) {}
    syncPressedGroup(sel, b);
    renderAll();   // canvas sparklines + chart colors derive from theme vars
  });
}

/* ---------- keyboard shortcuts (N7) ---------- */
function isTypingTarget(t) {
  return Boolean(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
}
function anyDialogOpen() {
  const env = $("envmode-dialog"), bm = $("bmmark-dialog");
  return Boolean((env && env.open) || (bm && bm.open));
}
function moveFeedFocus(delta) {
  const rows = [...document.querySelectorAll("#feed tr[tabindex]")];
  if (!rows.length) return;
  const current = rows.indexOf(document.activeElement);
  const next = current < 0 ? 0 : Math.max(0, Math.min(current + delta, rows.length - 1));
  rows[next].focus();
}
document.addEventListener("keydown", ev => {
  if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const overview = $("page-overview");
  if (!overview || overview.hidden) return;   // benchmark page has its own flow
  if (ev.key === "/" && !isTypingTarget(ev.target)) {
    ev.preventDefault();
    $("searchfilter").focus();
    return;
  }
  if (isTypingTarget(ev.target) || anyDialogOpen()) return;
  if (ev.key === "e") {
    errorsOnly = !errorsOnly;
    $("errorsonly").checked = errorsOnly;
    renderAll();
  } else if (ev.key === "j" || ev.key === "k") {
    ev.preventDefault();
    moveFeedFocus(ev.key === "j" ? 1 : -1);
  }
});

/* ---------- URL state (N8) ----------
   Filters/sort/range serialize into the hash as #/host=…&kind=…&range=… so a
   view is a paste-able link. #/ and #/benchmark keep working: anything that
   doesn't parse as params is treated as a plain route. */
function serializeViewState() {
  const parts = [];
  const put = (k, v) => parts.push(`${k}=${encodeURIComponent(v)}`);
  if (hostFilter) put("host", hostFilter);
  if (kindFilter) put("kind", kindFilter);
  if (textFilter) put("q", textFilter);
  if (errorsOnly) put("errors", "1");
  if (modelFilter) put("model", modelFilter);
  if (convoFilter) put("convo", convoFilter.root);
  if (rangeMode.type === "preset") {
    put("range", `${rangeMode.hours}h`);
  } else if (rangeMode.type === "day") {
    put("range", rangeMode.offset === 0 ? "today" : "yesterday");
  }
  if (feedSort.key !== "ts" || feedSort.direction !== "desc") put("sort", `${feedSort.key}.${feedSort.direction}`);
  if (chartZoom) put("zoom", `${Math.round(chartZoom[0])}-${Math.round(chartZoom[1])}`);
  return parts.join("&");
}
function parseViewParams(search) {
  const params = {};
  for (const pair of String(search || "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
  }
  return params;
}
function applyViewState(params) {
  hostFilter = params.host || "";
  kindFilter = params.kind || "";
  textFilter = params.q || "";
  errorsOnly = params.errors === "1";
  modelFilter = params.model || null;
  convoFilter = params.convo ? { root: params.convo, label: null } : null;
  if (params.sort) {
    const [key, dir] = params.sort.split(".");
    if (key) feedSort = { key, direction: dir === "asc" ? "asc" : "desc" };
  }
  if (params.zoom) {
    const zm = params.zoom.split("-").map(Number);
    chartZoom = zm.length === 2 && zm.every(Number.isFinite) && zm[1] > zm[0] ? [zm[0], zm[1]] : null;
  } else {
    chartZoom = null;
  }
  const zoomBtn = $("chartzoomreset");
  if (zoomBtn) zoomBtn.hidden = !chartZoom;
  let rangeChanged = false;
  if (params.range) {
    let next = null;
    if (params.range === "today") next = { type: "day", offset: 0 };
    else if (params.range === "yesterday") next = { type: "day", offset: 1 };
    else {
      const m = /^(\d+(?:\.\d+)?)(h|d)$/.exec(params.range);
      if (m) next = { type: "preset", hours: Number(m[1]) * (m[2] === "d" ? 24 : 1) };
    }
    if (next) {
      rangeChanged = JSON.stringify(next) !== JSON.stringify(rangeMode);
      rangeMode = next;
    }
  }
  syncViewControls();
  return rangeChanged;
}
function syncViewControls() {
  if ($("hostsel")) $("hostsel").value = hostFilter;
  if ($("searchfilter")) $("searchfilter").value = textFilter;
  if ($("kindfilter")) $("kindfilter").value = kindFilter;
  if ($("errorsonly")) $("errorsonly").checked = errorsOnly;
  const group = $("rangesel");
  if (group && group.children) {
    let matched = null;
    for (const b of group.children) {
      if (!b.dataset) continue;
      const isMatch = (rangeMode.type === "preset" && b.dataset.h != null && Number(b.dataset.h) === rangeMode.hours)
        || (rangeMode.type === "day" && b.dataset.day != null && Number(b.dataset.day) === rangeMode.offset);
      if (isMatch) matched = b;
    }
    if (matched) syncPressedGroup(group, matched);
  }
}
let lastAppliedHash = null;
function hashViewParams() {
  // The portion after "#/" when it carries view params (not a plain route).
  if (typeof location === "undefined") return null;
  const hash = (location.hash || "").replace(/^#/, "");
  if (!hash.startsWith("/")) return null;
  const rest = hash.slice(1);
  if (rest === "" || rest === "benchmark" || rest.startsWith("benchmark/")) return null;
  if (rest === "events" || rest.startsWith("events/")) return null;  // events route owns the hash
  return rest;
}
function applyHashState() {
  const rest = hashViewParams();
  if (rest == null || rest === lastAppliedHash) return false;
  lastAppliedHash = rest;
  return applyViewState(parseViewParams(rest));
}
function writeHashState() {
  if (typeof location === "undefined" || typeof history === "undefined" || !history.replaceState) return;
  const hash = (location.hash || "#/").replace(/^#/, "");
  if (hash.startsWith("/benchmark")) return;   // the benchmark route owns the hash
  if (hash.startsWith("/events")) return;      // the events route owns the hash
  const qs = serializeViewState();
  const target = qs ? `#/${qs}` : "#/";
  lastAppliedHash = qs;
  if (location.hash === target) return;
  history.replaceState(null, "", target);
}
