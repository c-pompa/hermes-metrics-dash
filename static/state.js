/* Hermes Metrics — shared state, constants, and record/color-slot plumbing. */
"use strict";

const SLOTS = ["--s1","--s2","--s3","--s4","--s5","--s6","--s7","--s8"];
const MAXRECS = 20000;
const MAXTELEMETRY = 30000;
const SVG_POINT_LIMIT = 1200;
const SERIES_POINT_LIMIT = 400;
const MAX_VOLUME_BINS = 240;
const FEED_LIMIT = 300;
const ERROR_LIMIT = 20;
const NUMERIC_SORTS = new Set(["ts", "input_tokens", "output_tokens", "duration_s", "tps"]);
const HOSTSLOTS = ["--s5","--s8","--s2","--s7"];
/* pool_status/host_stats heartbeats: out of the request window by default (R1/R7),
   routed to their own store so they feed the fleet strip + host charts instead. */
const HEARTBEAT_KINDS = ["pool_status", "host_stats"];
const STALE_HOST_SECS = 300;
const KINDNAME = { api:"api", moa_turn:"moa turn", moa_ref:"moa ref", moa_agg:"moa agg", error:"error", subagent_stop:"subagent", host_stats:"host stats", pool_status:"pool", router_request:"router" };
/* Kinds that count as LLM requests in the widgets (tiles, charts, variance,
   model stats). router_request is the model-router exec-log trail: the ONLY
   record for local-model calls from clients that hit :8867 without the
   metrics hook (forwarder.py flatten_router_request). Twin router rows (a
   hook-equipped caller also produced an api row for the same call) are
   dropped server-side in /api/recent and live in appendLiveRecord. */
const REQUEST_KINDS = ["api", "moa_turn", "moa_ref", "router_request"];
const ROUTER_TWIN_WINDOW_S = 3;
const metricLabel = { tps: "output tok/s", duration_s: "duration", output_tokens: "output tokens" };

let records = [];
let recordsGeneration = 0;  // bumped by replaceRecords so incremental views reflow on a fresh snapshot
let seenIds = new Set();
let liveSequence = 0;
let liveBuffer = [];
let refetchGeneration = 0;
let activeHistoryRequest = null;
let activeTelemetryRequest = null;
let telemetry = [];         // host_stats + pool_status, capped separately from requests
let rangeMode = { type: "preset", hours: 6 };
let hostFilter = "";
let textFilter = "";
let kindFilter = "";
let errorsOnly = false;
let showHeartbeats = false; // "show heartbeats" toggle: heartbeats join history + feed
let textFilterTimer = null;
let convoFilter = null;   // { root, label } — click a conversation's "focus" chip
let modelFilter = null;   // model id — click a legend chip or variance row
let curWin = [0, 0];
let metric = "tps";
let feedSort = { key: "ts", direction: "desc" };
let volMode = "out";
/* Speed-chart view state (clean-design ports): brush-zoom domain (absolute
   ts, clamped to the window at render), legend-toggled hidden series, and the
   feed-row → series highlight. */
let chartZoom = null;       // [t0, t1] | null
const hiddenSeries = new Set();
let chartHighlightModel = null;
const chartRovingIndex = new Map();

/* Meta state for the redesign: env-mode marker (R6), experiment marks (N16),
   ops footer (N17), health banner dismissal (N15). */
let envModeStatus = null;
let benchmarkMarks = [];
let aboutInfo = null;
let dismissedHealthKey = "";
let opsMetaFetchedAt = 0;

const rootOf = r => r.parent_session_id || r.session_id;
function getWindow() {
  if (rangeMode.type === "preset") {
    const now = Date.now()/1000;
    return [now - rangeMode.hours*3600, now];
  }
  if (rangeMode.type === "day") {
    const mid = new Date(); mid.setHours(0, 0, 0, 0);
    const start = mid.getTime()/1000 - rangeMode.offset*86400;
    return [start, rangeMode.offset === 0 ? Date.now()/1000 : start + 86400];
  }
  return [rangeMode.from, rangeMode.to];
}
function windowLabel() {
  if (rangeMode.type === "preset") return rangeMode.hours >= 24 ? `last ${rangeMode.hours/24}d` : `last ${rangeMode.hours}h`;
  if (rangeMode.type === "day") return rangeMode.offset === 0 ? "today" : "yesterday";
  return "custom range";
}
function inRange(r) { return r.ts >= curWin[0] && r.ts <= curWin[1] && (!hostFilter || r.host === hostFilter); }

/* ---------- model -> color slot (stable hues; reclaim idle slots for active models) ---------- */
let slotMap = {};
try {
  const stored = JSON.parse(localStorage.getItem("hermesMetricsSlots") || "{}");
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    // Keep only well-formed entries: non-empty model key, integer slot in palette range.
    for (const [model, slot] of Object.entries(stored)) {
      if (model && Number.isInteger(slot) && slot >= 0 && slot < SLOTS.length) slotMap[model] = slot;
    }
  }
} catch (e) {}
function persistSlotMap() {
  try { localStorage.setItem("hermesMetricsSlots", JSON.stringify(slotMap)); } catch (e) {}
}
function usedColorSlots() {
  return new Set(Object.values(slotMap).filter(s => s >= 0));
}
function reclaimIdleSlot(activeSet) {
  if (!activeSet || !activeSet.size) return -1;
  for (const [model, slot] of Object.entries(slotMap)) {
    if (slot >= 0 && !activeSet.has(model)) {
      delete slotMap[model];
      return slot;
    }
  }
  return -1;
}
function colorFor(model, activeSet) {
  if (!model) return "var(--other)";
  if (slotMap[model] >= 0) return `var(${SLOTS[slotMap[model]]})`;
  // Assign a free slot, or reclaim one held by a model not in the current window.
  // Also upgrades models previously stuck at -1 when a slot frees up.
  let free = SLOTS.findIndex((_, i) => !usedColorSlots().has(i));
  if (free < 0) free = reclaimIdleSlot(activeSet);
  if (free < 0 && activeSet && activeSet.has(model)) {
    // True overflow (>8 active models): hash into palette so labels stay real
    // and colors remain deterministic without a permanent -1 "Other" sticky state.
    let h = 0;
    for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
    free = h % SLOTS.length;
  }
  slotMap[model] = free;
  persistSlotMap();
  return free >= 0 ? `var(${SLOTS[free]})` : "var(--other)";
}
function ensureSlotsForModels(models, activeSet) {
  // Highest-volume / priority models first so they keep named colors under pressure.
  for (const model of models) colorFor(model, activeSet);
}

/* ---------- data plumbing ---------- */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function replaceRecords(nextRecords) {
  const nextSeen = new Set();
  const valid = [];
  for (const record of nextRecords) {
    if (!isRecord(record)) continue;
    if (record.id != null) {
      if (nextSeen.has(record.id)) continue;
      nextSeen.add(record.id);
    }
    valid.push(record);
  }
  records = valid.slice(-MAXRECS);
  recordsGeneration++;
  seenIds = new Set(records.map(r => r.id).filter(id => id != null));
}
function isRouterTwin(record, existing) {
  /* Live-push twin guard (mirrors app.py drop_router_twins): a router_request
     duplicates an already-stored api row when api.model == router label, ts
     within ROUTER_TWIN_WINDOW_S, and output tokens agree when both report.
     The forwarder POSTs one collect() batch with hook rows before router
     rows, so the api twin is always already in the store when this runs. */
  if (record.kind !== "router_request" || !record.label) return false;
  const ts = Number(record.ts);
  if (!Number.isFinite(ts)) return false;
  for (let i = existing.length - 1; i >= 0; i--) {
    const a = existing[i];
    const ats = Number(a.ts);
    if (!Number.isFinite(ats) || ats < ts - ROUTER_TWIN_WINDOW_S - 1) break;
    if (a.kind !== "api" || a.model !== record.label) continue;
    if (Math.abs(ats - ts) > ROUTER_TWIN_WINDOW_S) continue;
    const aOut = a.output_tokens, rOut = record.output_tokens;
    if (typeof aOut === "number" && typeof rOut === "number" && aOut !== rOut) continue;
    return true;
  }
  return false;
}
function appendLiveRecord(record) {
  if (!isRecord(record)) return false;
  // Twin router rows are dropped before the live buffer so a later refetch
  // (which replays liveBuffer over server-deduped history) never re-adds one.
  if (isRouterTwin(record, records)) return false;
  liveSequence++;
  liveBuffer.push({ sequence: liveSequence, record });
  if (liveBuffer.length > MAXRECS) liveBuffer = liveBuffer.slice(-MAXRECS);
  if (record.id != null) {
    if (seenIds.has(record.id)) return false;
    seenIds.add(record.id);
  }
  if (HEARTBEAT_KINDS.includes(record.kind)) {
    // Heartbeats always feed the telemetry store (fleet strip, host charts,
    // uptime); they only enter the request window when explicitly shown.
    telemetry.push(record);
    if (telemetry.length > MAXTELEMETRY) telemetry.splice(0, telemetry.length - MAXTELEMETRY);
    if (!showHeartbeats) return true;
  }
  records.push(record);
  if (records.length > MAXRECS) {
    const evicted = records.splice(0, records.length - MAXRECS);
    for (const old of evicted) {
      if (old.id != null) seenIds.delete(old.id);
    }
  }
  return true;
}
function replaceTelemetry(nextRecords) {
  const seen = new Set();
  const valid = [];
  for (const record of nextRecords) {
    if (!isRecord(record) || !HEARTBEAT_KINDS.includes(record.kind)) continue;
    if (record.id != null) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
    }
    valid.push(record);
  }
  telemetry = valid.slice(-MAXTELEMETRY);
}
/* Telemetry in the current window + host filter; conversation/model focus
   intentionally does not apply, so fleet and host diagnostics stay live. */
function filteredTelemetry() {
  return telemetry.filter(r => r.ts >= curWin[0] && r.ts <= curWin[1] && (!hostFilter || r.host === hostFilter));
}
function stableRecordKey(r) {
  if (r.id != null) return String(r.id);
  return [r.ts || 0, r.host || "", r.kind || "", r.model || "", r.session_id || "", r.error || ""].join("\u0000");
}

/* ---------- connection status ---------- */
let lastConnectionStatus = "";
function setConnectionStatus(label, live = false, retry = false) {
  const statusKey = `${label}\u0000${live}\u0000${retry}`;
  if (statusKey === lastConnectionStatus) return false;
  lastConnectionStatus = statusKey;
  $("conn").classList.toggle("live", live);
  $("conn").setAttribute("aria-busy", String(label.includes("loading") || label.includes("connecting")));
  $("connlabel").textContent = label;
  $("retryload").hidden = !retry;
  return true;
}
let historyState = "loading";
let streamState = "connecting";
function updateConnectionStatus() {
  if (historyState === "loading") {
    setConnectionStatus("loading history…");
  } else if (historyState === "stale") {
    const label = streamState === "live"
      ? "live · stale data — retry history"
      : "stale data — retry history";
    setConnectionStatus(label, streamState === "live", true);
  } else if (streamState === "live") {
    setConnectionStatus("live", true);
  } else if (streamState === "reconnecting") {
    setConnectionStatus("reconnecting…");
  } else {
    setConnectionStatus("history loaded — connecting…");
  }
  // The ops footer (N17) mirrors the same SSE/history state.
  if (typeof renderOpsFooter === "function") renderOpsFooter();
}
