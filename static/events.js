/* Hermes Events — live hitl-v1 event topology page (#/events).
   Self-contained: injects its own styles, backfills from /api/hitl-events,
   tails the dashboard SSE (/events) for rows marked event=="hitl_event".
   Exposes window.HermesEvents {show, hide} for the main.js router. */
(function () {
  "use strict";

  /* ── severity plumbing ── */
  const SEV_VAR = { ok: "--good", info: "--s1", warn: "--warn", error: "--critical" };
  const SEV_RANK = { info: 0, ok: 0, warn: 1, error: 2 };
  const SEV_ICON = { ok: '<span class="ico ico-check" aria-hidden="true"></span>', info: "·", warn: '<span class="ico ico-warn" aria-hidden="true"></span>', error: '<span class="ico ico-x" aria-hidden="true"></span>' };
  const TF_MS = { all: Infinity, "30s": 30e3, "1m": 60e3, "5m": 300e3 };
  const sevColor = (sev) => `var(${SEV_VAR[sev] || "--s1"})`;

  /* Canvas 2D cannot parse var()/color-mix() — resolve theme vars to concrete
     colors once per paint and add alpha by appending to #rrggbb. */
  function paints() {
    const cs = getComputedStyle(document.documentElement);
    const g = (v, fb) => (cs.getPropertyValue(v).trim() || fb);
    return {
      good: g("--good", "#0ca30c"), s1: g("--s1", "#4f7cf0"), s5: g("--s5", "#7a6d00"),
      warn: g("--warn", "#8a6300"), critical: g("--critical", "#e05c5c"),
      ink1: g("--ink-1", "#1c1c1a"), ink2: g("--ink-2", "#52514e"), ink3: g("--ink-3", "#82806f"),
      grid: g("--grid", "#efeee8"), surface: g("--surface-1", "#ffffff"),
    };
  }
  const SEV_PAINT = { ok: "good", info: "s1", warn: "warn", error: "critical" };
  const sevPaint = (sev, pal) => pal[SEV_PAINT[sev]] || pal.s1;
  function hexA(color, a) {
    if (/^#[0-9a-fA-F]{6}$/.test(color))
      return color + Math.round(a * 255).toString(16).padStart(2, "0");
    return color;
  }

  /* ── node metadata (from hitl-v1 source) ── */
  const NODE_INFO = {
    "routers/documents.py": {
      file: "hitl-v1 · app/routers/documents.py",
      desc: "Document ingest: SHA-256 hashed, immutable original, pages pre-rendered to PNG. Publishes document.uploaded after the DB insert lands.",
      events: ["document.uploaded"] },
    "routers/extraction.py": {
      file: "hitl-v1 · app/routers/extraction.py",
      desc: "Runs template regions against the local OCR model (cached per crop), records human corrections and approvals. Publishes lifecycle events after each DB status write.",
      events: ["extraction.completed", "extraction.failed", "extraction.approved", "extraction.rejected"] },
    "sqlite_orchestrator.py": {
      file: "hitl-v1 · app/orchestrator/sqlite_orchestrator.py",
      desc: "run_pipeline() drives the 6 stages (detect → extract → verify → highlight → fix → result) and publishes an event at every step; a stage exception short-circuits to PipelineResult(status=FAILED).",
      events: ["pipeline.start", "pipeline.stage_start", "pipeline.stage_complete", "pipeline.complete"] },
    "EVENTBUS": {
      file: "hitl-v1 · app/event_bus.py",
      desc: "In-memory async pub/sub singleton. publish() enqueues onto the SSE queue and fans out to subscribers via asyncio.gather — one publish becomes N deliveries.",
      events: ["asyncio.Queue → SSE", "subscriber callbacks"] },
    "hitl_forwarder.py": {
      file: "hermes-metrics-dash · hitl_forwarder.py (launchd)",
      desc: "Tails hitl-v1's SSE stream (:8010/api/events), batches events, and POSTs them to this dashboard's /ingest, where they land in the hitl_events table.",
      events: ["POST /ingest {event: hitl_event}"] },
    "this dashboard": {
      file: "hermes-metrics-dash · app.py",
      desc: "Stores events in sqlite (hitl_events) and rebroadcasts them on the dashboard SSE /events — which is what this very page is subscribed to.",
      events: ["GET /api/hitl-events (backfill)", "SSE event: rec (live)"] },
  };
  const LANES = ["routers/documents.py", "routers/extraction.py", "sqlite_orchestrator.py"];
  const LANE_ROLE = {
    "routers/documents.py": "uploads",
    "routers/extraction.py": "extract · approve · reject",
    "sqlite_orchestrator.py": "6-stage pipeline",
  };
  const LANE_FOR = { documents: LANES[0], extraction: LANES[1], orchestrator: LANES[2], webhooks: LANES[1], other: LANES[2] };

  /* ── multi-app support (app selector: all / hitl / llm) ── */
  function llmLanes() {
    const counts = {};
    for (const e of S.entries) if (e.app === "llm") counts[e.lane] = (counts[e.lane] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([h]) => h);
    return top.length ? top : ["mini", "mbp"];
  }
  function llmModels() {
    const counts = {};
    for (const e of S.entries) if (e.app === "llm" && e.model) counts[e.model] = (counts[e.model] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([m]) => m);
    return top.length ? top : ["LM Studio pool"];
  }
  function topoGroups() {
    const g = [];
    if (S.appFilter !== "llm") g.push({ id: "hitl", title: "hitl-v1 · EventBus", center: "EVENTBUS", lanes: LANES, consumers: ["hitl_forwarder.py", "this dashboard"] });
    if (S.appFilter !== "hitl") g.push({ id: "llm", title: "hermes · gateway :8642", center: "GATEWAY", lanes: llmLanes(), consumers: llmModels() });
    return g;
  }
  function mapLlmRecord(r) {
    const model = r.model || "?";
    let type, sev;
    if (r.kind === "error" || r.error) { type = `error · ${model}`; sev = "error"; }
    else if ((r.kind || "").startsWith("moa")) { type = `${r.kind} · ${model}`; sev = "info"; }
    else { type = `api · ${model}`; sev = "ok"; }
    return { t: (r.ts || Date.now() / 1000) * 1000, type, sev, lane: r.host || "?", app: "llm", model,
             payload: JSON.stringify({
               error: r.error || "", tps: r.tps, duration_s: r.duration_s,
               session: r.session_title || r.session_id || "", finish_reason: r.finish_reason || "",
             }) };
  }
  function nodeInfoFor(key) {
    if (NODE_INFO[key]) return NODE_INFO[key];
    if (key === "GATEWAY") return {
      file: "hermes gateway · :8642 + model-router",
      desc: "Every hermes LLM call routes through the gateway; the model-router picks a serving endpoint and notes degradations. Records arrive via the metrics forwarder.",
      events: ["api · <model>", "moa_reference/aggregator", "error · <model>"] };
    if (key === "LM Studio pool" || (key && !key.includes("/") && !key.includes("."))) {
      if (key === "LM Studio pool" || (S.entries.some((e) => e.app === "llm" && e.model === key)))
        return { file: "LM Studio / LM Link pool", desc: `Model endpoint serving inference (LM Studio or a linked llama.cpp peer). Requests for ${key} are routed here by the model-router.`, events: ["chat/completions"] };
      return { file: "hermes-agent host", desc: `${key} — machine running hermes. LLM requests originate here and are shipped by its metrics forwarder (post_api_request hook → requests.jsonl).`, events: ["api requests", "host_stats"] };
    }
    return NODE_INFO[key] || { file: key, desc: "", events: [] };
  }

  /* ── state ── */
  const S = {
    built: false, visible: false, es: null, raf: 0,
    entries: [],                       // {t(ms), type, sev, lane}
    evStats: new Map(),
    particles: [], pulses: [],
    laneFlash: {},                              // "groupId:laneIdx" -> {a, sev}
    busPulse: 0, busPulseColor: "#888",
    evCount: 0, deliveries: 0,
    lastSev: null, lastSevT: -1e9, lastEventT: 0,
    sevFilter: new Set(["ok", "info", "warn", "error"]),
    tf: "all", drillType: null, paused: false,
    hour: new Array(60).fill(null), hourMin: 0,
    hoverNode: null,
    appFilter: "all",
    laneFlashLlm: [],
  };

  const $ = (id) => document.getElementById(id);
  const fmtTime = (t) => {
    const d = new Date(t);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  };

  /* ── styles (dashboard theme vars, light/dark auto) ── */
  const CSS = `
  #hev-root { font-size: var(--fs-md); }
  #hev-root .hev-card { background: var(--surface-1); border: 1px solid var(--grid); border-radius: var(--radius); box-shadow: var(--card-shadow); }
  .hev-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--grid); }
  .hev-pill { font-size: var(--fs-xs); font-weight: 700; letter-spacing: .05em; padding: 3px 10px; border-radius: 999px; }
  .hev-pill.healthy { background: color-mix(in srgb, var(--good) 15%, transparent); color: var(--good); }
  .hev-pill.degraded { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
  .hev-pill.down { background: color-mix(in srgb, var(--critical) 18%, transparent); color: var(--critical); }
  .hev-pill.stale { background: var(--ring); color: var(--ink-3); }
  .hev-count { font-size: var(--fs-sm); color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .hev-body { display: flex; min-height: 0; }
  .hev-topo-wrap { flex: 1.3; position: relative; border-right: 1px solid var(--grid); min-width: 0; }
  .hev-topo-wrap canvas { display: block; width: 100%; }
  .hev-side { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .hev-strip { padding: 8px 12px 4px; border-bottom: 1px solid var(--grid); }
  .hev-strip .hev-lbl { font-size: var(--fs-xs); color: var(--ink-3); display: flex; justify-content: space-between; margin: 2px 0; }
  .hev-strip canvas { display: block; width: 100%; }
  .hev-tabs { display: flex; gap: 4px; padding: 6px 12px 0; }
  .hev-tab { font-size: var(--fs-xs); padding: 3px 10px; border: 1px solid var(--grid); border-bottom: none; border-radius: 7px 7px 0 0; cursor: pointer; color: var(--ink-3); background: none; }
  .hev-tab.active { color: var(--ink-1); border-color: var(--axis); background: color-mix(in srgb, var(--s1) 8%, transparent); }
  .hev-filters { display: flex; gap: 5px; padding: 7px 12px; align-items: center; flex-wrap: wrap; border-top: 1px solid var(--grid); }
  .hev-chip { font-size: var(--fs-xs); font-weight: 600; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--axis); cursor: pointer; opacity: .3; background: none; transition: opacity .15s; }
  .hev-chip.on { opacity: 1; }
  .hev-chip.ok { color: var(--good); } .hev-chip.info { color: var(--s1); }
  .hev-chip.warn { color: var(--warn); } .hev-chip.error { color: var(--critical); }
  .hev-tf { margin-left: auto; background: var(--surface-1); color: var(--ink-1); border: 1px solid var(--grid); border-radius: 7px; padding: 3px 7px; font-size: var(--fs-xs); }
  .hev-fltc { font-size: var(--fs-xs); color: var(--ink-3); }
  .hev-log { flex: 1; overflow-y: auto; padding: 6px 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: var(--fs-xs); line-height: 1.75; max-height: 150px; min-height: 150px; }
  .hev-le { display: flex; gap: 8px; border-left: 3px solid transparent; padding-left: 7px; margin-bottom: 1px; border-radius: 2px; }
  .hev-le .lt { color: var(--ink-3); flex-shrink: 0; }
  .hev-le.sev-info { border-color: var(--s1); } .hev-le.sev-info .lm { color: var(--s1); }
  .hev-le.sev-ok { border-color: var(--good); } .hev-le.sev-ok .lm { color: var(--good); }
  .hev-le.sev-warn { border-color: var(--warn); background: color-mix(in srgb, var(--warn) 8%, transparent); } .hev-le.sev-warn .lm { color: var(--warn); }
  .hev-le.sev-error { border-color: var(--critical); background: color-mix(in srgb, var(--critical) 8%, transparent); } .hev-le.sev-error .lm { color: var(--critical); }
  .hev-empty { color: var(--ink-3); font-style: italic; padding: 6px 0; }
  .hev-events { flex: 1; overflow-y: auto; max-height: 196px; min-height: 196px; padding: 6px 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: var(--fs-xs); display: none; }
  .hev-events table { width: 100%; border-collapse: collapse; }
  .hev-events th { text-align: left; color: var(--ink-3); font-weight: 600; padding: 3px 5px; border-bottom: 1px solid var(--grid); position: sticky; top: 0; background: var(--surface-1); }
  .hev-events td { padding: 3px 5px; border-bottom: 1px solid var(--grid); }
  .hev-events tr.hev-row { cursor: pointer; }
  .hev-events tr.hev-row:hover td { background: color-mix(in srgb, var(--s1) 8%, transparent); }
  .hev-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
  .hev-cnt { text-align: right; font-variant-numeric: tabular-nums; }
  .hev-ls { color: var(--ink-3); }
  .hev-back { color: var(--s1); cursor: pointer; display: inline-block; margin-bottom: 5px; }
  .hev-back:hover { text-decoration: underline; }
  .hev-drill { color: var(--s5); margin-bottom: 4px; }
  .hev-tt { position: absolute; pointer-events: none; background: var(--surface-1); border: 1px solid var(--s1); border-radius: 8px; padding: 6px 9px; font-size: var(--fs-xs); max-width: 250px; display: none; z-index: 5; box-shadow: var(--card-shadow); }
  .hev-tt b { color: var(--s1); display: block; }
  .hev-tt .h { color: var(--ink-3); font-size: var(--fs-xs); }
  .hev-details { display: none; border-top: 1px solid var(--grid); padding: 9px 12px; font-size: var(--fs-sm); }
  .hev-details.open { display: block; }
  .hev-details h4 { margin: 0 0 3px; font-size: var(--fs-md); color: var(--good); display: flex; gap: 8px; align-items: center; }
  .hev-details h4 .x { margin-left: auto; cursor: pointer; color: var(--ink-3); font-weight: 400; padding: 0 5px; }
  .hev-details h4 .x:hover { color: var(--critical); }
  .hev-details .f { color: var(--ink-3); font-size: var(--fs-xs); margin-bottom: 4px; }
  .hev-details .d { margin-bottom: 6px; color: var(--ink-2); }
  .hev-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .hev-evchip { font-size: var(--fs-xs); font-family: ui-monospace, Menlo, monospace; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); border-radius: 999px; padding: 1px 8px; }
  .hev-foot { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--grid); align-items: center; flex-wrap: wrap; }
  .hev-btn { background: var(--surface-1); color: var(--ink-1); border: 1px solid var(--grid); border-radius: 8px; padding: 4px 11px; font-size: var(--fs-xs); cursor: pointer; }
  .hev-btn:hover { border-color: var(--s1); }
  .hev-hint { font-size: var(--fs-xs); color: var(--ink-3); margin-left: auto; }
  .hev-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 10px; margin-top: 10px; }
  .hev-panel h3 { margin: 0 0 2px; font-size: var(--fs-md); }
  .hev-panel .n { color: var(--ink-3); font-size: var(--fs-xs); margin: 0 0 6px; }
  .hev-panel canvas { display: block; width: 100%; }
  /* widget section */
  .hev-wsec-head { display: flex; align-items: baseline; gap: 8px; margin: 14px 0 2px; flex-wrap: wrap; }
  .hev-wsec-head h3 { margin: 0; font-size: var(--fs-lg); color: var(--s5); }
  .hev-wsec-sub { color: var(--ink-3); font-size: var(--fs-xs); }
  .hev-wsec-head .hev-btn.editing { border-color: var(--s1); color: var(--s1); }
  .hev-panel { position: relative; padding: 10px 12px; }
  .hev-panel .hev-whide { display: none; position: absolute; top: 8px; right: 8px; width: 20px; height: 20px; border-radius: 50%; border: 1px solid var(--critical); color: var(--critical); background: var(--surface-1); font-size: 11px; line-height: 1; cursor: pointer; }
  .hev-wsec.editing .hev-panel .hev-whide { display: block; }
  .hev-wsec.editing .hev-panel { outline: 1px dashed var(--axis); }
  .hev-wbig { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .hev-wrow { display: flex; gap: 14px; margin: 4px 0 8px; flex-wrap: wrap; }
  .hev-wrow .w { min-width: 70px; }
  .hev-wrow .wl { font-size: var(--fs-xs); color: var(--ink-3); }
  .hev-trace { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: var(--fs-xs); }
  .hev-trace .tr-row { display: flex; align-items: center; gap: 6px; margin: 3px 0; }
  .hev-trace .tr-name { width: 150px; color: var(--ink-3); text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hev-trace .tr-wrap { flex: 1; height: 11px; position: relative; background: var(--ring); border-radius: 3px; }
  .hev-trace .tr-bar { position: absolute; top: 0; height: 100%; border-radius: 3px; }
  .hev-trace .tr-ms { width: 64px; flex-shrink: 0; font-variant-numeric: tabular-nums; }
  .hev-wempty { color: var(--ink-3); font-style: italic; padding: 12px 0; font-size: var(--fs-xs); }
  .hev-app { flex-shrink: 0; font-size: 9px; font-weight: 700; padding: 0 5px; border-radius: 999px; line-height: 1.7; }
  .hev-app.hitl { color: var(--good); border: 1px solid color-mix(in srgb, var(--good) 45%, transparent); }
  .hev-app.llm { color: var(--s2); border: 1px solid color-mix(in srgb, var(--s2) 45%, transparent); }
  .hev-le.hev-expandable { cursor: pointer; }
  .hev-le.hev-expandable:hover { background: color-mix(in srgb, var(--s1) 7%, transparent); }
  .hev-le.hev-expandable.open { border-left-width: 4px; }
  .hev-row-detail { margin: 1px 0 3px 18px; padding: 4px 8px; border-left: 2px solid var(--axis); font-size: var(--fs-xs); line-height: 1.5; }
  .hev-row-detail .hev-err-detail { color: var(--critical); word-break: break-word; }
  .hev-row-detail .hev-meta { color: var(--ink-3); }
  @media (max-width: 900px) { .hev-body { flex-direction: column; } .hev-topo-wrap { border-right: none; border-bottom: 1px solid var(--grid); } }
  `;

  /* ── DOM ── */
  function build(root) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    root.innerHTML = `
      <div class="hev-card">
        <div class="hev-head">
          <span class="hev-pill stale" id="hevPill">CONNECTING</span>
          <span class="hev-count" id="hevCount">0 events</span>
          <span class="hev-count" id="hevDel">0 delivered</span>
          <span class="hev-count" id="hevAge">no events yet</span>
          <span style="flex:1"></span>
          <label class="hev-count">app <select class="hev-tf" id="hevApp" style="margin-left:4px">
            <option value="all" selected>all apps</option>
            <option value="hitl">hitl-v1</option>
            <option value="llm">hermes / llm</option>
          </select></label>
          <label class="hev-count">backfill <select class="hev-tf" id="hevBackfill" style="margin-left:4px">
            <option value="1">1h</option><option value="24" selected>24h</option><option value="168">7d</option>
          </select></label>
          <button class="hev-btn" id="hevPause"><span class="ico ico-pause" aria-hidden="true"></span> pause feed</button>
        </div>
        <div class="hev-body">
          <div class="hev-topo-wrap">
            <canvas id="hevTopo" height="170"></canvas>
            <div class="hev-tt" id="hevTt"></div>
            <div class="hev-details" id="hevDetails"></div>
          </div>
          <div class="hev-side">
            <div class="hev-strip">
              <div class="hev-lbl"><span>past 60 min — worst severity per minute</span><span>−60m ← → now</span></div>
              <canvas id="hevHour" height="26"></canvas>
              <div class="hev-lbl"><span>events/sec — live</span><span id="hevEps">0 eps</span></div>
              <canvas id="hevEpsCv" height="14"></canvas>
            </div>
            <div class="hev-tabs">
              <button class="hev-tab active" data-tab="log">Log</button>
              <button class="hev-tab" data-tab="events">Events</button>
            </div>
            <div class="hev-filters" id="hevFilters">
              <button class="hev-chip ok on" data-sev="ok"><span class="ico ico-check" aria-hidden="true"></span> ok</button>
              <button class="hev-chip info on" data-sev="info">· info</button>
              <button class="hev-chip warn on" data-sev="warn"><span class="ico ico-warn" aria-hidden="true"></span> warning</button>
              <button class="hev-chip error on" data-sev="error"><span class="ico ico-x" aria-hidden="true"></span> error</button>
              <select class="hev-tf" id="hevTf">
                <option value="all">all time</option><option value="30s">last 30s</option>
                <option value="1m">last 1m</option><option value="5m">last 5m</option>
              </select>
              <span class="hev-fltc" id="hevFltC"></span>
            </div>
            <div class="hev-log" id="hevLog"></div>
            <div class="hev-events" id="hevEvents"></div>
          </div>
        </div>
        <div class="hev-foot">
          <span class="hev-hint">lanes = hitl-v1 modules · particles = live events · click a node for details</span>
        </div>
      </div>
      <div class="hev-wsec" id="hevWsec">
        <div class="hev-wsec-head">
          <h3>Industry view — how large teams monitor event-driven AI</h3>
          <span class="hev-wsec-sub">live widgets computed from the hitl_events stream</span>
          <span style="flex:1"></span>
          <select class="hev-tf" id="hevAdd" hidden></select>
          <button class="hev-btn" id="hevEdit"><span class="ico ico-edit" aria-hidden="true"></span> edit widgets</button>
        </div>
        <div id="hevWidgets" class="hev-grid2"></div>
      </div>`;

    root.querySelectorAll(".hev-tab").forEach((t) => (t.onclick = () => switchTab(t)));
    root.querySelectorAll(".hev-chip").forEach((ch) => (ch.onclick = () => {
      const sev = ch.dataset.sev;
      if (S.sevFilter.has(sev)) { S.sevFilter.delete(sev); ch.classList.remove("on"); }
      else { S.sevFilter.add(sev); ch.classList.add("on"); }
      renderLog();
    }));
    $("hevTf").onchange = (e) => { S.tf = e.target.value; renderLog(); };
    $("hevBackfill").onchange = () => backfill();
    $("hevApp").onchange = (e) => {
      S.appFilter = e.target.value;
      S.particles = []; S.pulses = [];
      layout();
      renderLog();
      if ($("hevEvents").style.display === "block") S.drillType ? renderDrill() : renderEvents();
      drawStrips(); drawWidgets();
    };
    $("hevPause").onclick = () => {
      S.paused = !S.paused;
      $("hevPause").innerHTML = S.paused ? '<span class="ico ico-play" aria-hidden="true"></span> resume feed' : '<span class="ico ico-pause" aria-hidden="true"></span> pause feed';
    };
    $("hevEvents").addEventListener("click", (e) => {
      const row = e.target.closest("tr.hev-row");
      if (row) { S.drillType = row.dataset.type; renderDrill(); return; }
      if (e.target.closest(".hev-back")) { S.drillType = null; renderEvents(); }
    });

    $("hevEdit").onclick = () => {
      S.editMode = !S.editMode;
      $("hevWsec").classList.toggle("editing", S.editMode);
      $("hevEdit").classList.toggle("editing", S.editMode);
      $("hevEdit").innerHTML = S.editMode ? '<span class="ico ico-check" aria-hidden="true"></span> done' : '<span class="ico ico-edit" aria-hidden="true"></span> edit widgets';
      refreshAddSelect();
    };
    $("hevAdd").onchange = (e) => {
      const id = e.target.value;
      if (!id) return;
      S.hiddenWidgets.delete(id); saveHidden(); buildWidgets(); refreshAddSelect();
      e.target.value = "";
    };
    buildWidgets();

    const cv = $("hevTopo");
    cv.addEventListener("pointermove", (e) => {
      const r = cv.getBoundingClientRect();
      const node = nodeAt(e.clientX - r.left, e.clientY - r.top);
      S.hoverNode = node;
      cv.style.cursor = node ? "pointer" : "default";
      const tt = $("hevTt");
      if (node) {
        tt.innerHTML = `<b>${node.label}</b>${nodeInfoFor(node.key).file}<br><span class="h">click to pin details below</span>`;
        tt.style.display = "block";
        tt.style.left = Math.min(e.clientX - r.left + 12, cv.clientWidth - 260) + "px";
        tt.style.top = (e.clientY - r.top + 10) + "px";
      } else tt.style.display = "none";
    });
    cv.addEventListener("pointerleave", () => { $("hevTt").style.display = "none"; S.hoverNode = null; });
    cv.addEventListener("click", (e) => {
      const r = cv.getBoundingClientRect();
      const node = nodeAt(e.clientX - r.left, e.clientY - r.top);
      if (node) showDetails(node.key, node.label);
    });
    addEventListener("resize", layout);
  }

  function switchTab(tab) {
    document.querySelectorAll("#hev-root .hev-tab").forEach((t) => t.classList.toggle("active", t === tab));
    const which = tab.dataset.tab;
    $("hevLog").style.display = which === "log" ? "" : "none";
    $("hevFilters").style.display = which === "log" ? "" : "none";
    $("hevEvents").style.display = which === "events" ? "block" : "none";
    if (which === "events") { S.drillType = null; renderEvents(); }
  }

  function showDetails(key, label) {
    const info = nodeInfoFor(key);
    const el = $("hevDetails");
    el.innerHTML = `
      <h4>${label} <span class="x" title="close"><span class="ico ico-x" aria-hidden="true"></span></span></h4>
      <div class="f">${info.file}</div>
      <div class="d">${info.desc}</div>
      <div class="hev-chips">${info.events.map((e) => `<span class="hev-evchip">${e}</span>`).join("")}</div>`;
    el.classList.add("open");
    el.querySelector(".x").onclick = () => el.classList.remove("open");
  }

  /* ── layout (canvas coords) ── */
  const L = {};
  function layout() {
    const cv = $("hevTopo");
    if (!cv) return;
    const dpr = Math.min(devicePixelRatio, 2);
    const w = cv.parentElement.clientWidth;
    const groups = topoGroups();
    const bandH = 150, bandGap = 8, topPad = 4;
    const H = topPad + groups.length * bandH + Math.max(0, groups.length - 1) * bandGap + 12;
    cv.width = w * dpr; cv.height = H * dpr;
    cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    L.W = w; L.H = H;
    L.leftX = 12; L.leftW = 148;
    L.busX = L.W * 0.52;
    L.rightX = L.W - 12 - 128;
    L.groups = groups.map((g, gi) => {
      const top = topPad + gi * (bandH + bandGap);
      const padV = top + 22;                       // group title row
      const area = bandH - 22 - 8;
      const laneH = Math.min(40, area / g.lanes.length);
      const laneY = g.lanes.map((_, i) => padV + laneH * i + laneH / 2 + (area - laneH * g.lanes.length) / 2);
      const consumers = g.consumers.map((name, ci) => ({
        name, y: padV + area * (g.consumers.length === 1 ? 0.5 : 0.18 + ci * 0.64),
      }));
      return { ...g, top, laneY, laneH, consumers, busTop: padV - 4, busBot: padV + area + 4 };
    });
    S.particles = []; S.pulses = [];               // geometry changed mid-flight
    for (const id of ["hevHour", "hevEpsCv"]) {
      const c = $(id);
      if (!c) continue;
      const cw = c.parentElement.clientWidth - 24;
      c.width = Math.max(50, cw) * dpr;
      c.height = (id === "hevHour" ? 26 : 14) * dpr;
      c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    L.stripW = $("hevHour") ? $("hevHour").width / Math.min(devicePixelRatio, 2) : 300;
    sizeWidgetCanvases();
    drawWidgets();
  }

  function nodeAt(px, py) {
    for (const g of L.groups || []) {
      for (let i = 0; i < g.lanes.length; i++)
        if (px >= L.leftX && px <= L.leftX + L.leftW && Math.abs(py - g.laneY[i]) <= 15)
          return { key: g.lanes[i], label: g.lanes[i] };
      if (px >= L.busX - 24 && px <= L.busX + 24 && py >= g.busTop && py <= g.busBot)
        return { key: g.id === "hitl" ? "EVENTBUS" : "GATEWAY", label: g.id === "hitl" ? "EventBus (hitl-v1)" : "hermes gateway" };
      for (const con of g.consumers)
        if (px >= L.rightX && px <= L.rightX + 128 && Math.abs(py - con.y) <= 14)
          return { key: con.name, label: con.name };
    }
    return null;
  }

  /* ── data ── */
  function appEntries() {
    return S.appFilter === "all" ? S.entries : S.entries.filter((e) => (e.app || "hitl") === S.appFilter);
  }

  function statsFor(list) {
    const m = new Map();
    for (const e of list) {
      const st = m.get(e.type) || { count: 0, worst: e.sev, last: 0 };
      st.count++; st.last = Math.max(st.last, e.t);
      if (SEV_RANK[e.sev] > SEV_RANK[st.worst]) st.worst = e.sev;
      m.set(e.type, st);
    }
    return m;
  }

  function pushEntry(e, live) {
    S.entries.unshift(e);
    if (S.entries.length > 1500) S.entries.pop();
    S.evCount++;
    $("hevCount").textContent = S.evCount + " events";
    if (SEV_RANK[e.sev] >= (SEV_RANK[S.lastSev] ?? -1) || Date.now() - S.lastSevT > 10e3) {
      S.lastSev = e.sev; S.lastSevT = Date.now();
    }
    S.lastEventT = Date.now();
    const st = S.evStats.get(e.type) || { count: 0, worst: e.sev, last: 0 };
    st.count++; st.last = e.t;
    if (SEV_RANK[e.sev] > SEV_RANK[st.worst]) st.worst = e.sev;
    S.evStats.set(e.type, st);
    const app = e.app || "hitl";
    const grp = (L.groups || []).find((g) => g.id === app);
    const laneIdx = grp ? (app === "hitl" ? grp.lanes.indexOf(LANE_FOR[e.lane] || LANES[2]) : grp.lanes.indexOf(e.lane)) : -1;
    if (live && !S.paused && grp && laneIdx >= 0) {
      noteEps();
      spawnParticle(grp, laneIdx, e);
      if (e.sev === "warn" || e.sev === "error") S.laneFlash[`${grp.id}:${laneIdx}`] = { a: 0.5, sev: e.sev };
      renderLog(true);
      if ($("hevEvents").style.display === "block") S.drillType ? renderDrill() : renderEvents();
    }
  }

  function spawnParticle(grp, laneIdx, e) {
    S.particles.push({
      grp, x: L.leftX + L.leftW + 6, y: grp.laneY[laneIdx], type: e.type, sev: e.sev,
      phase: "in", speed: 2.4 + Math.random() * 1.1,
    });
  }

  async function backfill() {
    const h = $("hevBackfill").value;
    try {
      const [hitlResp, llmResp] = await Promise.all([
        fetch(`/api/hitl-events?since_h=${h}&limit=1000`),
        fetch(`/api/recent?hours=${h}&limit=500`),
      ]);
      const hitlData = await hitlResp.json();
      const llmData = await llmResp.json();
      const hitlRows = (hitlData.events || []).map((r) => ({ t: r.ts * 1000, type: r.type, sev: r.sev, lane: r.lane,
        doc_id: r.doc_id, extraction_id: r.extraction_id, payload: r.payload, app: "hitl" }));
      const llmRows = (llmData.records || [])
        .filter((r) => r.kind && !["host_stats", "pool_status"].includes(r.kind))
        .map(mapLlmRecord);
      S.entries = []; S.evStats = new Map(); S.hour = new Array(60).fill(null);
      S.evCount = 0;
      const all = hitlRows.concat(llmRows).sort((a, b) => b.t - a.t);   // newest first
      for (const e of all) pushEntry(e, false);
      renderLog(); drawWidgets();
    } catch (err) {
      $("hevLog").innerHTML = `<div class="hev-empty">backfill failed: ${err} — is the forwarder running?</div>`;
    }
  }

  function connect() {
    if (S.es) return;
    const es = new EventSource("/events");
    S.es = es;
    es.addEventListener("rec", (msg) => {
      let row;
      try { row = JSON.parse(msg.data); } catch { return; }
      if (!row) return;
      if (row.event === "hitl_event") {
        pushEntry({ t: (row.ts || Date.now() / 1000) * 1000, type: row.type, sev: row.sev || "info",
                    lane: row.lane || "other", doc_id: row.doc_id, extraction_id: row.extraction_id,
                    payload: row.payload, app: "hitl" }, true);
        S.deliveries += 2;  // ingest + SSE rebroadcast
        $("hevDel").textContent = S.deliveries + " delivered";
        return;
      }
      if (!row.kind || ["host_stats", "pool_status"].includes(row.kind)) return;
      pushEntry(mapLlmRecord(row), true);
    });
    es.onerror = () => setPill("stale", "RECONNECTING");
  }

  function setPill(cls, text) {
    const p = $("hevPill");
    p.className = "hev-pill " + cls;
    p.textContent = text;
  }

  /* ── log / events views ── */
  function filteredEntries() {
    const cutoff = TF_MS[S.tf];
    const now = Date.now();
    return appEntries().filter((e) => S.sevFilter.has(e.sev) && (cutoff === Infinity || now - e.t <= cutoff));
  }

  /* log rows: hover tooltip + click-to-expand details */
  function entryDetails(e) {
    let p = {};
    try { p = JSON.parse(e.payload || "{}"); } catch { /* keep */ }
    const bits = [];
    if (p.error) bits.push(`<div class="hev-err-detail"><span class="ico ico-x" aria-hidden="true"></span> ${p.error}</div>`);
    const meta = [];
    if (p.tps) meta.push(`${p.tps} tok/s`);
    if (p.duration_s) meta.push(`${p.duration_s}s`);
    if (p.session) meta.push(`session ${p.session}`);
    if (p.finish_reason) meta.push(`finish: ${p.finish_reason}`);
    if (e.extraction_id) meta.push(`ext ${e.extraction_id}`);
    if (meta.length) bits.push(`<div class="hev-meta">${meta.join(" · ")}</div>`);
    return { tip: p.error || e.type, html: bits.join("") };
  }

  function wireRow(div, e) {
    const d = entryDetails(e);
    if (!d.html) { div.title = d.tip; return; }
    div.title = d.tip + " — click to expand";
    div.classList.add("hev-expandable");
    div.onclick = () => {
      const open = div.nextElementSibling && div.nextElementSibling.classList.contains("hev-row-detail");
      if (open) { div.nextElementSibling.remove(); div.classList.remove("open"); return; }
      const det = document.createElement("div");
      det.className = "hev-row-detail";
      det.innerHTML = d.html;
      div.after(det);
      div.classList.add("open");
    };
  }

  function renderLog() {
    const list = filteredEntries();
    $("hevFltC").textContent = `${list.length}/${appEntries().length}`;
    const el = $("hevLog");
    el.innerHTML = "";
    if (!list.length) { el.innerHTML = '<div class="hev-empty">no events match the current filters</div>'; return; }
    const frag = document.createDocumentFragment();
    for (const e of list.slice(0, 80)) {
      const div = document.createElement("div");
      div.className = "hev-le sev-" + e.sev;
      const idbit = e.doc_id ? ` · ${e.doc_id}` : "";
      const app = e.app || "hitl";
      div.innerHTML = `<span class="lt">${fmtTime(e.t)}</span><span class="hev-app ${app}">${app}</span><span class="lm">${SEV_ICON[e.sev]} ${e.type}${idbit}</span>`;
      wireRow(div, e);
      frag.appendChild(div);
    }
    el.appendChild(frag);
  }

  function renderEvents() {
    const rows = [...statsFor(appEntries()).entries()]
      .sort((a, b) => SEV_RANK[b[1].worst] - SEV_RANK[a[1].worst] || b[1].count - a[1].count);
    let html = `<table><tr><th></th><th>event</th><th style="text-align:right">count</th><th>last seen</th></tr>`;
    for (const [type, st] of rows)
      html += `<tr class="hev-row" data-type="${type}" title="click to see each occurrence">
        <td><span class="hev-dot" style="background:${sevColor(st.worst)}"></span></td>
        <td>${type}</td><td class="hev-cnt">${st.count}</td><td class="hev-ls">${fmtTime(st.last)}</td></tr>`;
    $("hevEvents").innerHTML = rows.length ? html + "</table>" : '<div class="hev-empty">no events yet</div>';
  }

  function renderDrill() {
    const type = S.drillType;
    const occ = appEntries().filter((e) => e.type === type);
    let html = `<span class="hev-back">← all events</span>
      <div class="hev-drill">${type} — ${occ.length} occurrence${occ.length === 1 ? "" : "s"}</div>`;
    $("hevEvents").innerHTML = html;
    for (const e of occ.slice(0, 80)) {
      const div = document.createElement("div");
      div.className = "hev-le sev-" + e.sev;
      div.innerHTML = `<span class="lt">${fmtTime(e.t)}</span><span class="lm">${SEV_ICON[e.sev]} ${e.sev}${e.doc_id ? " · " + e.doc_id : ""}</span>`;
      wireRow(div, e);
      $("hevEvents").appendChild(div);
    }
  }

  /* ── drawing ── */
  function pill(c, x, y, w, h, title, sub, color, glow) {
    const cs = getComputedStyle(document.documentElement);
    c.save();
    if (glow) { c.shadowColor = color; c.shadowBlur = 14 * glow; }
    c.fillStyle = cs.getPropertyValue("--surface-1");
    c.strokeStyle = color; c.lineWidth = 1.2;
    c.beginPath(); c.roundRect(x, y, w, h, 6); c.fill(); c.stroke();
    c.shadowBlur = 0;
    c.fillStyle = cs.getPropertyValue("--ink-1");
    c.font = "600 9px system-ui, sans-serif"; c.textAlign = "center";
    c.fillText(title, x + w / 2, y + h / 2 - (sub ? 2 : -3));
    if (sub) {
      c.fillStyle = cs.getPropertyValue("--ink-3");
      c.font = "8px system-ui, sans-serif";
      c.fillText(sub, x + w / 2, y + h / 2 + 9);
    }
    c.restore();
  }

  let epsBuckets = new Array(60).fill(0), epsT = 0, lastFrame = performance.now();
  function frame(now) {
    S.raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
    if (!S.visible || !L.W) return;
    const c = $("hevTopo").getContext("2d");
    const pal = paints();
    const sevP = (sev) => sevPaint(sev, pal);
    c.clearRect(0, 0, L.W, L.H);

    for (const g of L.groups || []) {
      // group title
      c.fillStyle = pal.ink3; c.font = "700 9px system-ui, sans-serif"; c.textAlign = "left";
      c.fillText(g.title.toUpperCase(), L.leftX, g.top + 10);

      for (let i = 0; i < g.lanes.length; i++) {
        const y = g.laneY[i];
        if (i % 2 === 0) { c.fillStyle = hexA(pal.ink3, 0.05); c.fillRect(6, y - g.laneH / 2, L.W - 12, g.laneH); }
        const isHover = S.hoverNode && S.hoverNode.key === g.lanes[i];
        if (isHover) { c.fillStyle = hexA(pal.s1, 0.08); c.fillRect(6, y - g.laneH / 2, L.W - 12, g.laneH); }
        const fl = S.laneFlash[`${g.id}:${i}`];
        if (fl && fl.a > 0) {
          const fcol = sevP(fl.sev);
          c.fillStyle = hexA(fcol, fl.a * 0.35);
          c.fillRect(6, y - g.laneH / 2, L.W - 12, g.laneH);
          c.globalAlpha = fl.a; c.strokeStyle = fcol; c.lineWidth = 1;
          c.strokeRect(6.5, y - g.laneH / 2 + 0.5, L.W - 13, g.laneH - 1);
          c.globalAlpha = 1;
        }
        c.strokeStyle = pal.grid; c.lineWidth = 1.3; c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(L.leftX + L.leftW + 6, y); c.lineTo(L.busX, y); c.stroke();
        c.setLineDash([]);
        for (const con of g.consumers) {
          c.strokeStyle = hexA(pal.s1, 0.22); c.lineWidth = 1;
          c.beginPath(); c.moveTo(L.busX, y);
          c.quadraticCurveTo((L.busX + L.rightX) / 2, (y + con.y) / 2, L.rightX, con.y);
          c.stroke();
        }
        const role = g.id === "hitl" ? LANE_ROLE[g.lanes[i]] : "hermes host";
        pill(c, L.leftX, y - 15, L.leftW, 30, g.lanes[i], role, pal.good, isHover ? 0.6 : 0);
      }

      const busHover = S.hoverNode && S.hoverNode.key === (g.id === "hitl" ? "EVENTBUS" : "GATEWAY");
      c.save();
      c.shadowColor = S.busPulseColor; c.shadowBlur = 18 * S.busPulse + 5 + (busHover ? 8 : 0);
      c.fillStyle = hexA(pal.warn, 0.16);
      c.strokeStyle = pal.warn; c.lineWidth = 1.3;
      c.beginPath(); c.roundRect(L.busX - 24, g.busTop, 48, g.busBot - g.busTop, 10); c.fill(); c.stroke();
      c.restore();
      c.fillStyle = pal.warn;
      c.font = "700 9px system-ui, sans-serif"; c.textAlign = "center";
      c.save(); c.translate(L.busX, (g.busTop + g.busBot) / 2); c.rotate(-Math.PI / 2);
      c.fillText(g.center, 0, 3); c.restore();

      for (const con of g.consumers) {
        const conHover = S.hoverNode && S.hoverNode.key === con.name;
        pill(c, L.rightX, con.y - 14, 128, 28, con.name, null, pal.s1, conHover ? 0.6 : 0);
      }
    }

    for (const pu of S.pulses) {
      c.globalAlpha = Math.max(0, pu.a);
      c.strokeStyle = pu.color; c.lineWidth = 1.8;
      c.beginPath(); c.arc(pu.x ?? L.busX, pu.y, pu.r, 0, Math.PI * 2); c.stroke();
      c.globalAlpha = 1;
    }

    for (const p of S.particles) {
      c.save();
      c.shadowColor = sevP(p.sev); c.shadowBlur = 8;
      c.fillStyle = sevP(p.sev);
      c.beginPath(); c.arc(p.x, p.y, p.sev === "error" ? 4.5 : 3.5, 0, Math.PI * 2); c.fill();
      c.restore();
      if (p.sev === "warn" || p.sev === "error") {
        c.fillStyle = pal.surface;
        if (p.sev === "warn") {
          c.font = "700 7px system-ui, sans-serif"; c.textAlign = "center";
          c.fillText("!", p.x, p.y + 2.5);
        } else {
          c.strokeStyle = pal.surface; c.lineWidth = 1.2;
          c.beginPath(); c.moveTo(p.x - 2, p.y - 2); c.lineTo(p.x + 2, p.y + 2);
          c.moveTo(p.x + 2, p.y - 2); c.lineTo(p.x - 2, p.y + 2); c.stroke();
        }
      }
      if (S.hoverNode || p.phase === "out") {
        c.fillStyle = pal.ink2;
        c.font = "8px ui-monospace, Menlo, monospace"; c.textAlign = "center";
        c.fillText(p.type, p.x, p.y - 7);
      }
    }

    // physics
    for (let i = S.particles.length - 1; i >= 0; i--) {
      const p = S.particles[i];
      if (p.phase === "in") {
        p.x += p.speed;
        if (p.x >= L.busX) {
          S.busPulse = 1; S.busPulseColor = sevP(p.sev);
          S.pulses.push({ r: 5, a: 0.8, color: sevP(p.sev), y: p.y });
          for (const con of p.grp.consumers)
            S.particles.push({ grp: p.grp, x: L.busX, y: p.y, ty: con.y, type: p.type, sev: p.sev, phase: "out", speed: p.speed * 0.92 });
          S.particles.splice(i, 1);
        }
      } else {
        p.x += p.speed;
        p.y += (p.ty - p.y) * 0.05;
        if (p.x >= L.rightX - 6) {
          S.pulses.push({ r: 3, a: 0.7, color: sevP(p.sev), y: p.ty, x: L.rightX });
          S.particles.splice(i, 1);
        }
      }
    }
    S.busPulse = Math.max(0, S.busPulse - dt * 2.2);
    for (const k of Object.keys(S.laneFlash)) S.laneFlash[k].a = Math.max(0, S.laneFlash[k].a - dt * 0.8);
    for (let i = S.pulses.length - 1; i >= 0; i--) {
      const pu = S.pulses[i]; pu.r += dt * 70; pu.a -= dt * 1.1;
      if (pu.a <= 0) S.pulses.splice(i, 1);
    }

    // eps bucket roll + strips once per second
    epsT += dt;
    if (epsT >= 1) {
      epsT -= 1;
      $("hevEps").textContent = epsBuckets[59] + " eps";
      epsBuckets.shift(); epsBuckets.push(0);
      drawStrips();
      drawWidgets();
      // status pill
      const sinceErr = Date.now() - S.lastSevT;
      const age = Date.now() - S.lastEventT;
      $("hevAge").textContent = S.lastEventT ? `last event ${Math.round(age / 1000)}s ago` : "no events yet";
      if (!S.lastEventT) setPill("stale", "WAITING");
      else if (age > 120e3) setPill("stale", "IDLE");
      else if (S.lastSev === "error" && sinceErr < 12e3) setPill("down", "DOWN");
      else if ((S.lastSev === "warn" && sinceErr < 12e3) || (S.lastSev === "error" && sinceErr < 25e3)) setPill("degraded", "DEGRADED");
      else setPill("healthy", "HEALTHY");
    }
  }

  function noteEps() { epsBuckets[59]++; }

  function drawStrips() {
    const pal = paints();
    const hc = $("hevHour").getContext("2d");
    const w = L.stripW;
    hc.clearRect(0, 0, w, 26);
    const bw = w / 60;
    // recompute from the app-filtered entries: worst severity per minute
    const hour = new Array(60).fill(null);
    const nowMin = Math.floor(Date.now() / 60000);
    for (const e of appEntries()) {
      const idx = 59 - (nowMin - Math.floor(e.t / 60000));
      if (idx < 0 || idx >= 60) continue;
      hour[idx] = hour[idx] && SEV_RANK[hour[idx]] >= SEV_RANK[e.sev] ? hour[idx] : e.sev;
    }
    for (let i = 0; i < 60; i++) {
      const sev = hour[i];
      hc.fillStyle = sev ? sevPaint(sev, pal) : hexA(pal.ink3, 0.14);
      const bh = sev ? 22 : 8;
      hc.fillRect(i * bw + 0.5, 24 - bh, Math.max(1, bw - 1.5), bh);
    }
    const ec = $("hevEpsCv").getContext("2d");
    ec.clearRect(0, 0, w, 14);
    const maxE = Math.max(3, ...epsBuckets);
    for (let i = 0; i < 60; i++) {
      const v = epsBuckets[i];
      if (!v) continue;
      const bh = (v / maxE) * 12;
      ec.fillStyle = hexA(pal.s5, 0.75);
      ec.fillRect(i * bw + 0.5, 13 - bh, Math.max(1, bw - 1.5), bh);
    }
  }

  /* ── widget registry ─────────────────────────────────────────────
     Each widget has a unique id. The edit button toggles edit mode:
     panels show a hide button, and hidden widgets can be re-added via the
     dropdown. Hidden ids persist in localStorage. */
  const LS_KEY = "hev.hiddenWidgets";
  S.hiddenWidgets = new Set(JSON.parse(localStorage.getItem(LS_KEY) || "[]"));
  S.editMode = false;

  function saveHidden() { localStorage.setItem(LS_KEY, JSON.stringify([...S.hiddenWidgets])); }

  function pct(sorted, p) {
    if (!sorted.length) return null;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[i];
  }

  function pipelineDurations() {
    const starts = new Map(), out = [];
    for (const e of [...appEntries()].reverse()) {  // oldest first
      if (e.type === "pipeline.start" && e.doc_id) starts.set(e.doc_id, e.t);
      else if (e.type === "pipeline.complete" && e.doc_id && starts.has(e.doc_id)) {
        out.push((e.t - starts.get(e.doc_id)) / 1000);
        starts.delete(e.doc_id);
      }
    }
    return out;
  }

  function latestTrace() {
    const byDoc = new Map();
    for (const e of appEntries()) {
      if (!e.doc_id || !e.type.startsWith("pipeline.stage")) continue;
      if (!byDoc.has(e.doc_id)) byDoc.set(e.doc_id, []);
      byDoc.get(e.doc_id).push(e);
    }
    let best = null, bestT = 0;
    for (const [doc, evs] of byDoc) {
      const t = Math.max(...evs.map((e) => e.t));
      if (t > bestT) { bestT = t; best = { doc, evs }; }
    }
    if (!best) return null;
    const stages = new Map();
    for (const e of best.evs.sort((a, b) => a.t - b.t)) {
      let stage = "?";
      try { stage = JSON.parse(e.payload || "{}").stage || "?"; } catch { /* keep */ }
      const rec = stages.get(stage) || {};
      if (e.type === "pipeline.stage_start") rec.start = e.t;
      else { rec.end = e.t; if (!rec.start) rec.start = e.t; }
      stages.set(stage, rec);
    }
    return { doc: best.doc, stages: [...stages.entries()] };
  }

  const WIDGETS = [
    {
      id: "sev-per-hour",
      title: "Events per hour by severity",
      note: "from the hitl_events table (backfill window)",
      h: 130,
      draw(panel, pal, W) {
        const c = panel.querySelector("canvas").getContext("2d");
        const H = 130;
        c.clearRect(0, 0, W, H);
        const nowH = Math.floor(Date.now() / 3600000);
        const buckets = new Array(24).fill(null).map(() => ({ ok: 0, info: 0, warn: 0, error: 0 }));
        for (const e of appEntries()) {
          const idx = 23 - (nowH - Math.floor(e.t / 3600000));
          if (idx >= 0 && idx < 24) buckets[idx][e.sev]++;
        }
        const maxV = Math.max(3, ...buckets.map((b) => b.ok + b.info + b.warn + b.error));
        const bw = W / 24;
        buckets.forEach((b, i) => {
          let y = H - 14;
          for (const sev of ["ok", "info", "warn", "error"]) {
            const h = (b[sev] / maxV) * (H - 30);
            if (h <= 0) continue;
            y -= h;
            c.fillStyle = sevPaint(sev, pal);
            c.fillRect(i * bw + 1, y, Math.max(1, bw - 2), h);
          }
        });
        c.fillStyle = pal.ink3; c.font = "9px system-ui";
        c.textAlign = "left"; c.fillText("−24h", 2, H - 3);
        c.textAlign = "right"; c.fillText("now", W - 2, H - 3);
      },
    },
    {
      id: "top-event-types",
      title: "Top event types",
      note: "occurrences in the current buffer",
      h: 130,
      draw(panel, pal, W) {
        const c = panel.querySelector("canvas").getContext("2d");
        const H = 130;
        c.clearRect(0, 0, W, H);
        const top = [...statsFor(appEntries()).entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 7);
        if (!top.length) { c.fillStyle = pal.ink3; c.font = "10px system-ui"; c.fillText("no events yet", 4, 20); return; }
        const maxC = Math.max(1, ...top.map(([, st]) => st.count));
        top.forEach(([type, st], i) => {
          const y = 6 + i * 17;
          c.fillStyle = pal.ink3; c.font = "9px ui-monospace, Menlo, monospace"; c.textAlign = "right";
          c.fillText(type.length > 26 ? type.slice(0, 25) + "…" : type, W * 0.52, y + 10);
          c.fillStyle = sevPaint(st.worst, pal);
          c.fillRect(W * 0.54, y + 2, (st.count / maxC) * (W * 0.38), 12);
          c.fillStyle = pal.ink2; c.textAlign = "left";
          c.fillText(String(st.count), W * 0.54 + (st.count / maxC) * (W * 0.38) + 4, y + 11);
        });
      },
    },
    {
      id: "event-throughput",
      title: "Event throughput — per minute",
      note: "event rate over the last 60 minutes",
      h: 130,
      draw(panel, pal, W) {
        const c = panel.querySelector("canvas").getContext("2d");
        const H = 130;
        c.clearRect(0, 0, W, H);
        const nowM = Math.floor(Date.now() / 60000);
        const counts = new Array(60).fill(0);
        for (const e of appEntries()) {
          const idx = 59 - (nowM - Math.floor(e.t / 60000));
          if (idx >= 0 && idx < 60) counts[idx]++;
        }
        const maxV = Math.max(3, ...counts);
        const bw = W / 60;
        counts.forEach((v, i) => {
          if (!v) return;
          const h = (v / maxV) * (H - 28);
          c.fillStyle = hexA(pal.s1, 0.8);
          c.fillRect(i * bw + 0.5, H - 14 - h, Math.max(1, bw - 1.5), h);
        });
        const total = counts.reduce((a, b) => a + b, 0);
        c.fillStyle = pal.ink3; c.font = "9px system-ui"; c.textAlign = "left";
        c.fillText(`${total} events/hr · ${(total / 60).toFixed(1)}/min avg`, 2, H - 3);
      },
    },
    {
      id: "pipeline-latency",
      title: "Pipeline latency — p50 / p95 / p99",
      note: "pipeline.start → pipeline.complete per document",
      h: 100,
      draw(panel, pal, W) {
        const durs = pipelineDurations();
        const stats = panel.querySelector("[data-wstats]");
        const c = panel.querySelector("canvas").getContext("2d");
        const H = 100;
        c.clearRect(0, 0, W, H);
        if (!durs.length) {
          stats.innerHTML = '<span class="hev-wempty">no completed pipeline runs in the buffer</span>';
          return;
        }
        const sorted = [...durs].sort((a, b) => a - b);
        const p50 = pct(sorted, 50), p95 = pct(sorted, 95), p99 = pct(sorted, 99);
        const fmt = (v) => (v == null ? "—" : v < 1 ? `${Math.round(v * 1000)}ms` : `${v.toFixed(1)}s`);
        stats.innerHTML = ["p50", "p95", "p99"].map((k, i) =>
          `<span class="w"><span class="hev-wbig" style="color:${[pal.good, pal.warn, pal.critical][i]}">${fmt([p50, p95, p99][i])}</span><br><span class="wl">${k} · n=${durs.length}</span></span>`).join("");
        const recent = durs.slice(-30);
        const maxV = Math.max(1, ...recent);
        const bw = W / 30;
        recent.forEach((v, i) => {
          const h = (v / maxV) * (H - 20);
          c.fillStyle = v >= p95 ? pal.critical : v >= p50 ? pal.warn : pal.good;
          c.fillRect(i * bw + 1, H - 6 - h, Math.max(1, bw - 2), h);
        });
      },
      extra: '<div class="hev-wrow" data-wstats></div>',
    },
    {
      id: "request-outcomes",
      title: "Extraction outcomes",
      note: "share of extraction.* lifecycle events",
      h: 110,
      draw(panel, pal, W) {
        const c = panel.querySelector("canvas").getContext("2d");
        const H = 110;
        c.clearRect(0, 0, W, H);
        const groups = [
          ["approved", "extraction.approved", pal.good],
          ["completed", "extraction.completed", pal.s1],
          ["failed", "extraction.failed", pal.critical],
          ["rejected", "extraction.rejected", pal.s5],
        ];
        const st = statsFor(appEntries());
        const counts = groups.map(([, t]) => st.get(t)?.count || 0);
        const total = counts.reduce((a, b) => a + b, 0);
        if (!total) { c.fillStyle = pal.ink3; c.font = "10px system-ui"; c.fillText("no extraction events yet", 4, 20); return; }
        let x = 4;
        const barY = 14, barH = 26, barW = W - 8;
        groups.forEach(([label, type, color], i) => {
          const w = (counts[i] / total) * barW;
          if (w <= 0) return;
          c.fillStyle = color;
          c.fillRect(x, barY, w, barH);
          x += w;
        });
        c.font = "9px system-ui"; c.textAlign = "left";
        let ly = barY + barH + 14;
        groups.forEach(([label, , color], i) => {
          c.fillStyle = color; c.fillRect(6, ly - 8, 8, 8);
          c.fillStyle = pal.ink2;
          c.fillText(`${label} ${counts[i]} (${Math.round((counts[i] / total) * 100)}%)`, 18, ly);
          ly += 13;
        });
      },
    },
    {
      id: "trace-waterfall",
      title: "Latest pipeline trace",
      note: "stage spans for the most recent document with pipeline events",
      html: true,
      draw(panel, pal) {
        const body = panel.querySelector("[data-wbody]");
        const trace = latestTrace();
        if (!trace || !trace.stages.length) {
          body.innerHTML = '<div class="hev-wempty">no pipeline stage events in the buffer</div>';
          return;
        }
        const spans = trace.stages.map(([stage, rec]) => ({
          stage, start: rec.start, dur: Math.max(0.05, ((rec.end || rec.start) - rec.start) / 1000),
        }));
        const t0 = Math.min(...spans.map((s) => s.start));
        const total = Math.max(...spans.map((s) => s.start - t0 + s.dur * 1000));
        const colors = { detect: pal.s1, extract: pal.good, verify: pal.warn, highlight: pal.s5, fix: pal.critical, result: pal.s1 };
        body.innerHTML = spans.map((s) => `
          <div class="tr-row">
            <span class="tr-name">${s.stage}</span>
            <span class="tr-wrap"><span class="tr-bar" style="left:${(((s.start - t0) / total) * 100).toFixed(1)}%;width:${Math.max(2, (s.dur * 1000 / total) * 100).toFixed(1)}%;background:${colors[s.stage] || pal.s1}"></span></span>
            <span class="tr-ms">${s.dur < 1 ? Math.round(s.dur * 1000) + " ms" : s.dur.toFixed(1) + " s"}</span>
          </div>`).join("") +
          `<div class="n" style="margin-top:4px">doc ${trace.doc} · ${spans.length} stages</div>`;
      },
    },
  ];

  function buildWidgets() {
    const wrap = $("hevWidgets");
    wrap.innerHTML = "";
    for (const w of WIDGETS) {
      if (S.hiddenWidgets.has(w.id)) continue;
      const panel = document.createElement("div");
      panel.className = "hev-card hev-panel";
      panel.dataset.wid = w.id;
      panel.innerHTML =
        `<button class="hev-whide" title="hide widget" aria-label="hide widget"><span class="ico ico-x" aria-hidden="true"></span></button><h3>${w.title}</h3><p class="n">${w.note}</p>` +
        (w.extra || "") +
        (w.html ? `<div class="hev-trace" data-wbody></div>` : `<canvas height="${w.h}" data-h="${w.h}" data-wbody></canvas>`);
      panel.querySelector(".hev-whide").onclick = () => {
        S.hiddenWidgets.add(w.id); saveHidden(); buildWidgets(); refreshAddSelect();
      };
      wrap.appendChild(panel);
    }
    if (!wrap.children.length)
      wrap.innerHTML = '<div class="hev-wempty">all widgets hidden — pick one from the dropdown to re-add it</div>';
    sizeWidgetCanvases();
    drawWidgets();
  }

  function refreshAddSelect() {
    const sel = $("hevAdd");
    const hidden = WIDGETS.filter((w) => S.hiddenWidgets.has(w.id));
    sel.hidden = !S.editMode || !hidden.length;
    sel.innerHTML = '<option value="">+ add widget…</option>' +
      hidden.map((w) => `<option value="${w.id}">${w.title}</option>`).join("");
  }

  function sizeWidgetCanvases() {
    const dpr = Math.min(devicePixelRatio, 2);
    document.querySelectorAll("#hevWidgets .hev-panel").forEach((panel) => {
      const cv = panel.querySelector("canvas");
      if (!cv) return;
      const w = panel.clientWidth - 24;
      const h = Number(cv.dataset.h) || 130;   // data-h, not the (rewritten) height attr
      cv.width = Math.max(50, w) * dpr; cv.height = h * dpr;
      cv.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    });
  }

  function drawWidgets() {
    const pal = paints();
    document.querySelectorAll("#hevWidgets .hev-panel").forEach((panel) => {
      const w = WIDGETS.find((x) => x.id === panel.dataset.wid);
      if (!w) return;
      const cv = panel.querySelector("canvas");
      const W = cv ? cv.width / Math.min(devicePixelRatio, 2) : 0;
      w.draw(panel, pal, W);
    });
  }

  /* ── public API ── */
  window.HermesEvents = {
    show() {
      const root = $("hev-root");
      if (!root) return;
      if (!S.built) { build(root); layout(); S.built = true; }
      S.visible = true;
      layout();
      backfill();
      connect();
      if (!S.raf) { lastFrame = performance.now(); S.raf = requestAnimationFrame(frame); }
    },
    hide() {
      S.visible = false;
      if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
      if (S.es) { S.es.close(); S.es = null; }
    },
    _internals: { S, pushEntry, noteEps },
  };
})();
