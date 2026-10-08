/* Hermes Metrics — fleet strip (R1/N4/N14), health banner (N15), ops footer
   (N17), and the small meta fetches (about, benchmark marks) behind them.
   Reads the telemetry store (host_stats + pool_status), never the request feed. */
"use strict";

/* ---------- telemetry derivation helpers ---------- */
function latestHostStatsByHost() {
  const latest = new Map();
  for (const r of telemetry) {
    if (r.kind !== "host_stats" || !r.host) continue;
    const prev = latest.get(r.host);
    if (!prev || r.ts >= prev.ts) latest.set(r.host, r);
  }
  return latest;
}
function latestPoolByHost() {
  // Each host's newest pool snapshot (batches cluster within a minute):
  // host -> { ts, models: Map(model -> device) }.
  const byHost = new Map();
  for (const r of telemetry) {
    if (r.kind !== "pool_status" || !r.host || !r.model) continue;
    let entry = byHost.get(r.host);
    if (!entry) {
      entry = { ts: 0, models: new Map() };
      byHost.set(r.host, entry);
    }
    if (r.ts > entry.ts + 60) {
      entry.ts = r.ts;
      entry.models.clear();
    }
    if (r.ts >= entry.ts - 60) entry.models.set(r.model, r.device || "");
  }
  return byHost;
}
function modelLoadTimes() {
  // N14: "loaded since" per host+model from pool_status transitions. A model
  // present in the oldest observed snapshot has no visible load event, so its
  // since stays null and the chip renders "up ?".
  const byHost = new Map(); // host -> Map(30s bucket -> Set(models))
  for (const r of telemetry) {
    if (r.kind !== "pool_status" || !r.host || !r.model) continue;
    let snaps = byHost.get(r.host);
    if (!snaps) {
      snaps = new Map();
      byHost.set(r.host, snaps);
    }
    const bucket = Math.round(r.ts / 30);
    if (!snaps.has(bucket)) snaps.set(bucket, new Set());
    snaps.get(bucket).add(r.model);
  }
  const result = new Map(); // "host\0model" -> since (epoch) | null
  for (const [host, snaps] of byHost) {
    const buckets = [...snaps.keys()].sort((a, b) => a - b);
    let prev = null, prevBucket = 0;
    const since = new Map();
    for (const bucket of buckets) {
      const set = snaps.get(bucket);
      // Only diff contiguous observation (≤10 min apart): across a telemetry
      // gap an "appearance" proves nothing about a fresh load.
      if (prev && (bucket - prevBucket) * 30 <= 600) {
        for (const m of set) {
          if (!prev.has(m) && !since.has(m)) since.set(m, bucket * 30);
        }
      }
      prev = set;
      prevBucket = bucket;
    }
    const last = snaps.get(buckets[buckets.length - 1]);
    for (const m of last) result.set(host + "\0" + m, since.has(m) ? since.get(m) : null);
  }
  return result;
}

/* ---------- R1: fleet strip ---------- */
function renderFleet(rs) {
  const el = $("fleet");
  if (!el) return;
  const latest = latestHostStatsByHost();
  const pools = latestPoolByHost();
  const loadTimes = modelLoadTimes();
  const hosts = [...new Set([...latest.keys(), ...pools.keys()])].sort();
  const shown = hostFilter ? hosts.filter(h => h === hostFilter) : hosts;
  if (!shown.length) {
    el.innerHTML = `<div class="empty">no host telemetry yet — fleet cards appear with the first host_stats / pool_status heartbeats</div>`;
    return;
  }
  const tel = filteredTelemetry();
  const reqCounts = new Map();
  for (const r of rs) {
    if (!["api","moa_turn","moa_ref","moa_agg","error"].includes(r.kind)) continue;
    reqCounts.set(r.host, (reqCounts.get(r.host) || 0) + 1);
  }
  const rangeLabel = windowLabel().replace(/^last /, "");
  // Aligned CPU+RAM sample pairs per host for the dual sparkline (N4 port).
  const hostSeries = new Map();
  for (const host of shown) {
    const pairs = [];
    for (const r of tel) {
      if (r.kind !== "host_stats" || r.host !== host) continue;
      if (r.cpu_load != null && r.mem_used_gb != null) pairs.push([r.ts, r.cpu_load, r.mem_used_gb]);
    }
    const step = Math.max(1, Math.ceil(pairs.length / 60));
    const sampled = pairs.filter((_, i) => i % step === 0);
    hostSeries.set(host, {
      cpu: sampled.map(([t, v]) => [t, v]),
      ram: sampled.map(([t, , v]) => [t, v]),
    });
  }
  el.innerHTML = shown.map(host => {
    const stats = latest.get(host);
    const alive = stats != null && Date.now()/1000 - stats.ts < STALE_HOST_SECS;
    const memPct = stats && stats.mem_total_gb > 0 && stats.mem_used_gb != null
      ? Math.min(100, stats.mem_used_gb / stats.mem_total_gb * 100) : 0;
    const pool = pools.get(host);
    const chips = pool && pool.models.size
      ? [...pool.models.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([m, d]) => {
          const since = loadTimes.get(host + "\0" + m);
          const up = since != null ? fmtUptime(since) : "up ?";
          const name = m.length > 28 ? m.slice(0, 27) + "…" : m;
          return `<span class="chip mono" title="${esc(m)} — loaded ${esc(since != null ? fmtDateShort(since) : "before history")}">${esc(name)} <span class="dev">· ${esc(d || host)} · ${esc(up)}</span></span>`;
        }).join("")
      : `<span class="chip">no pool data</span>`;
    return `<div class="hostcard">
      <div class="hh"><span class="dot${alive ? "" : " stale"}" aria-hidden="true"></span><b>${esc(host)}</b><span class="age">${stats ? "last stats " + esc(fmtAgo(stats.ts)) : "no host stats"}</span></div>
      <div class="meters"><span class="meter">CPU <b>${stats && stats.cpu_load != null ? fmt1(stats.cpu_load) : "—"}</b></span><span class="meter">RAM <b>${stats && stats.mem_used_gb != null ? fmt1(stats.mem_used_gb) + "/" + fmt1(stats.mem_total_gb) + " GB" : "—"}</b></span><span class="meter">req ${esc(rangeLabel)} <b>${fmtInt(reqCounts.get(host) || 0)}</b></span></div>
      <canvas class="fleetspark" data-host="${esc(host)}" aria-hidden="true"></canvas>
      <div class="bar"><i style="width:${memPct.toFixed(0)}%"></i></div>
      <div class="models">${chips}</div>
    </div>`;
  }).join("");
  // Joint-hover dual sparkline per card (CPU + RAM on one canvas).
  for (const cv of el.querySelectorAll("canvas.fleetspark")) {
    const series = hostSeries.get(cv.dataset.host);
    if (!series) continue;
    canvasDualSparkline(cv,
      { name: "CPU", color: "var(--s1)", data: series.cpu, fmt: v => fmt1(v) },
      { name: "RAM", color: "var(--s2)", data: series.ram, fmt: v => `${fmt1(v)} GB` });
  }
}

/* ---------- N15: health banner (dismissible; reappears when the stale set changes) ---------- */
function staleHosts() {
  const now = Date.now()/1000;
  const stale = [];
  for (const [host, stats] of latestHostStatsByHost()) {
    if (now - stats.ts > STALE_HOST_SECS) stale.push({ host, ts: stats.ts });
  }
  return stale.sort((a, b) => a.host.localeCompare(b.host));
}
function renderHealthBanner() {
  const el = $("healthbanner");
  if (!el) return;
  const stale = staleHosts();
  const key = stale.map(s => s.host).join(",");
  if (!stale.length || key === dismissedHealthKey) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  const names = stale.map(s => `${esc(s.host)} (${esc(fmtAgo(s.ts))})`).join(", ");
  el.innerHTML = `<span><span class="ico ico-warn" aria-hidden="true"></span> <b>Stale host${stale.length > 1 ? "s" : ""}</b> — no host stats from ${names} (forwarder down or box asleep). Requests still accepted from other hosts.</span>`
    + `<button type="button" class="dismiss" id="healthdismiss" aria-label="Dismiss stale host warning"><span class="ico ico-x" aria-hidden="true"></span></button>`;
}
{
  const banner = $("healthbanner");
  if (banner) banner.addEventListener("click", ev => {
    if (!ev.target || !ev.target.closest || !ev.target.closest("#healthdismiss")) return;
    dismissedHealthKey = staleHosts().map(s => s.host).join(",");
    renderHealthBanner();
  });
}

/* ---------- N17: ops footer ---------- */
function renderOpsFooter() {
  const el = $("opsfooter");
  if (!el) return;
  const sse = streamState === "live" ? "sse live"
    : streamState === "reconnecting" ? "sse reconnecting…"
    : historyState === "ok" ? "sse connecting…"
    : "loading…";
  const stale = historyState === "stale" ? " · stale history" : "";
  if (!aboutInfo) {
    el.textContent = sse + stale;
    return;
  }
  const parts = [];
  if (aboutInfo.revision) parts.push(`<span>dash <span class="mono">${esc(aboutInfo.revision)}</span></span>`);
  parts.push(`<span>db ${esc(fmtBytes(aboutInfo.db_bytes))} · ${esc(fmtInt(aboutInfo.records))} records · oldest ${esc(aboutInfo.oldest_ts ? fmtDayShort(aboutInfo.oldest_ts) : "?")}</span>`);
  if (aboutInfo.retention_days != null) {
    parts.push(`<span>retention: ${esc(String(aboutInfo.retention_days))}d requests / ${esc(String(aboutInfo.heartbeat_hours ?? "?"))}h heartbeats</span>`);
  }
  parts.push(`<span>${esc(sse + stale)}</span>`);
  el.innerHTML = parts.join("");
}

/* ---------- meta fetches: /api/about (N17) + /api/benchmark/marks (N16) ---------- */
async function refreshAbout() {
  try {
    const resp = await fetch("/api/about", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    aboutInfo = await resp.json();
    renderOpsFooter();
  } catch (e) { /* footer keeps its previous state */ }
}
async function refreshMarks() {
  try {
    const resp = await fetch("/api/benchmark/marks", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    const marks = Array.isArray(payload.marks) ? payload.marks : [];
    if (JSON.stringify(marks) !== JSON.stringify(benchmarkMarks)) {
      benchmarkMarks = marks;
      scheduleRender();
    }
  } catch (e) { /* chart markers keep their previous state */ }
}
/* Called after each successful history refetch; throttled so range surfing
   doesn't hammer the tiny meta endpoints. */
function refreshOpsMeta(force = false) {
  const now = Date.now()/1000;
  if (!force && now - opsMetaFetchedAt < 30) return;
  opsMetaFetchedAt = now;
  refreshAbout();
  refreshMarks();
}
