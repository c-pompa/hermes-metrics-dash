/* Hermes Metrics — Infra Benchmark page (#/benchmark) */
(function () {
  const USAGE_ORDER = ["deriver", "dialectic", "aggregator", "MoA ref", "embeddings", "loaded"];
  const STATE = {
    samples: [],
    best: [],
    current: [],
    usageHelp: {},
    hours: 168,
    filtersVisible: true,
    sortKey: "ts",
    sortDir: "desc",
    filters: { q: "", host: "", usage: "", exp: "", yieldMin: "" },
    cat: "all",
    pollTimer: null,
  };

  /* $ and esc come from util.js (loaded before this script). */
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(Number(ts) * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtYield(y) {
    if (y == null || Number.isNaN(Number(y))) return "—";
    return Number(y).toFixed(2);
  }
  function resourceGb(r) {
    if (r.vram_gb != null && r.vram_gb > 0) return Number(r.vram_gb);
    if (r.model_gb != null && r.model_gb > 0) return Number(r.model_gb);
    return null;
  }
  function knobsLine(r) {
    const bits = [];
    if (r.ctx_k != null) bits.push(`ctx ${r.ctx_k}k`);
    if (r.parallel != null) bits.push(`parallel ${r.parallel}`);
    if (r.ttl) bits.push(`TTL ${r.ttl}`);
    if (r.offload) bits.push(r.offload);
    if (r.cpu_load != null) bits.push(`CPU ${r.cpu_load}`);
    if (r.mem_used_gb != null) bits.push(`mem ${r.mem_used_gb}/${r.mem_total_gb || "?"}`);
    if (r.power_w != null) bits.push(`power ${r.power_w}W`);
    else bits.push("power —");
    return bits.join(" · ");
  }
  function sameSetup(a, b) {
    if (!a || !b) return false;
    return a.model === b.model
      && String(a.ctx_k) === String(b.ctx_k)
      && String(a.parallel) === String(b.parallel)
      && String(a.ttl || "") === String(b.ttl || "");
  }

  async function loadData() {
    const q = `hours=${STATE.hours}&limit=5000`;
    const [samplesRes, bestRes] = await Promise.all([
      fetch(`/api/benchmark/samples?${q}`).then((r) => r.json()),
      fetch(`/api/benchmark/best?${q}`).then((r) => r.json()),
    ]);
    STATE.samples = samplesRes.samples || [];
    STATE.best = bestRes.best || [];
    STATE.current = bestRes.current || [];
    STATE.usageHelp = bestRes.usage_help || samplesRes.usage_help || {};
    render();
  }

  function currentMap() {
    const m = new Map();
    for (const row of STATE.current) m.set(`${row.usage}||${row.host}`, row);
    return m;
  }

  /* R2: lead with Current — what's loaded now per usage × host, with the
     latest measurement and its age. Honest blanks where nothing was measured;
     t/s per W renders only when a sample carries power_w.
     P1: each row carries an inline interactive t/s sparkline built from that
     usage+host's benchmark_samples history. */
  function currentSparkSeries(row) {
    const usage = row.usage || "loaded", host = row.host || "";
    const pts = [];
    for (const s of STATE.samples) {
      if ((s.usage || "loaded") !== usage || (s.host || "") !== host) continue;
      const tps = Number(s.tps);
      if (!Number.isFinite(tps) || tps <= 0 || s.ts == null) continue;
      pts.push([Number(s.ts), tps]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    const step = Math.max(1, Math.ceil(pts.length / 60));
    return pts.filter((_, i) => i % step === 0);
  }
  function renderCurrent() {
    const rows = STATE.current.slice().sort((a, b) => {
      const ua = USAGE_ORDER.indexOf(a.usage || "loaded");
      const ub = USAGE_ORDER.indexOf(b.usage || "loaded");
      return (ua < 0 ? 99 : ua) - (ub < 0 ? 99 : ub)
        || String(a.host || "").localeCompare(String(b.host || ""));
    });
    const table = $("bmCurrentTable");
    const honest = $("bmHonest");
    if (!rows.length) {
      table.innerHTML = `<tbody><tr><td class="bm-empty">No live setups reported yet — forwarders emit a snapshot every ~30s once models are loaded.</td></tr></tbody>`;
      honest.hidden = true;
      return;
    }
    const anyPower = rows.some((r) => r.power_w != null && Number(r.power_w) > 0);
    const head = ["Usage", "Host", "Model", "Ctx", "∥", "GB", "Last t/s", "t/s trend", "t/s per GB"]
      .concat(anyPower ? ["t/s per W"] : [])
      .concat(["Measured"]);
    const now = Date.now() / 1000;
    let unmeasured = 0;
    const sparkSeries = new Map();   // "usage\0host" -> [[ts, tps], ...]
    const body = rows.map((r) => {
      const gb = resourceGb(r);
      const tps = r.tps != null && Number(r.tps) > 0 ? Number(r.tps) : null;
      if (tps == null) unmeasured++;
      const age = r.ts != null ? now - Number(r.ts) : null;
      const stale = age != null && age > 600;
      const usageCell = (r.usage || "loaded") === "loaded"
        ? `<i>${esc(r.usage || "loaded")}</i> <button type="button" class="bm-setusage" data-model="${esc(r.model || "")}" title="Classify ${esc(r.model || "this model")} into a usage role">set usage →</button>`
        : esc(r.usage);
      const key = `${r.usage || "loaded"}\0${r.host || ""}`;
      const series = currentSparkSeries(r);
      sparkSeries.set(key, series);
      const sparkCell = series.length >= 2
        ? `<canvas class="bm-curspark" data-key="${esc(key)}" aria-hidden="true"></canvas>`
        : `<span class="bm-nomeas">no measurements yet</span>`;
      return `<tr${stale ? ' class="bm-stale-row"' : ""}>
        <td>${usageCell}</td>
        <td>${esc(r.host || "?")}</td>
        <td class="bm-model-cell"><span class="bm-model-id" tabindex="0">${esc(r.model || "?")}</span><span class="bm-tip">${esc(r.model || "?")}</span></td>
        <td>${r.ctx_k != null ? esc(r.ctx_k) + "k" : "?"}</td>
        <td>${r.parallel ?? "?"}</td>
        <td>${gb != null ? esc(gb) : "?"}</td>
        <td>${tps != null ? `<b>${esc(r.tps)}</b>` : "—"}</td>
        <td class="bm-sparkcell">${sparkCell}</td>
        <td>${tps != null && gb ? fmtYield(tps / gb) : "—"}</td>
        ${anyPower ? `<td>${tps != null && Number(r.power_w) > 0 ? fmtYield(tps / Number(r.power_w)) : "—"}</td>` : ""}
        <td class="mono">${age != null ? esc(fmtAgo(Number(r.ts))) : "never"}${stale ? ' <span class="bm-stale">stale</span>' : ""}</td>
      </tr>`;
    }).join("");
    table.innerHTML = `<thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${body}</tbody>`;
    for (const cv of table.querySelectorAll("canvas.bm-curspark")) {
      const series = sparkSeries.get(cv.dataset.key) || [];
      canvasSparkline(cv, series, "var(--s2)", {
        median: median(series.map(p => p[1])),
        fmt: v => `${fmt1(v)} t/s`,
      });
    }
    if (unmeasured > 0) {
      honest.hidden = false;
      honest.innerHTML = `<b>No measured t/s yet for ${unmeasured} of ${rows.length} setup${rows.length === 1 ? "" : "s"}.</b> t/s, yield, and per-GB figures populate only when real requests flow through a loaded model.`;
    } else {
      honest.hidden = true;
      honest.innerHTML = "";
    }
  }

  /* P2: samples over time — yield per sample, colored by model, with the
     shared crosshair + brush-zoom kit (drag zooms, double-click resets). */
  function renderScatter() {
    const cv = $("bmScatter");
    if (!cv) return;
    const meta = $("bmScatterMeta");
    let pts = [];
    for (const r of STATE.samples) {
      const y = Number(r.yield);
      if (!Number.isFinite(y) || y <= 0 || r.ts == null) continue;
      pts.push({
        t: Number(r.ts), y,
        color: colorFor(r.model || "?"),
        label: `${(r.model || "?").length > 26 ? (r.model || "?").slice(0, 25) + "…" : r.model || "?"} · yield ${fmtYield(y)} · ${r.host || "?"} · ${fmtAgo(Number(r.ts))}`,
      });
    }
    pts.sort((a, b) => a.t - b.t);
    const step = Math.max(1, Math.ceil(pts.length / 2000));
    if (step > 1) pts = pts.filter((_, i) => i % step === 0);
    if (!pts.length) {
      const setup = canvasSetup(cv);
      if (setup) setup[0].clearRect(0, 0, setup[1], setup[2]);
      if (meta) meta.textContent = "no measured yields in this range — yield populates when real requests flow";
      return;
    }
    const idleText = "hover for values · drag to zoom · double-click to reset";
    if (meta && !meta.dataset.zoomed) meta.textContent = idleText;
    canvasBrushScatter(cv, pts, {
      fmtY: v => v.toFixed(1),
      fmtX: v => fmtAgo(v),
      onZoom: () => {
        if (meta) {
          meta.dataset.zoomed = "1";
          meta.textContent = "zoomed — double-click to reset";
        }
      },
      onReset: () => {
        if (meta) {
          delete meta.dataset.zoomed;
          meta.textContent = idleText;
        }
      },
    });
  }

  /* N11: classify a model out of the fallback "loaded" usage without SSH —
     POSTs the dashboard-managed usage map the forwarders poll. */
  function openUsageMenu(btn) {
    const menu = $("bmUsageMenu");
    const model = btn.dataset.model || "";
    const choices = USAGE_ORDER.filter((u) => u !== "loaded");
    menu.innerHTML = `<div class="bm-usage-menu-title">Set usage for <span class="mono">${esc(model.length > 42 ? model.slice(0, 41) + "…" : model)}</span></div>`
      + choices.map((u) => `<button type="button" data-usage="${esc(u)}" data-model="${esc(model)}">${esc(u)}</button>`).join("")
      + `<div class="bm-usage-menu-msg" role="status" aria-live="polite"></div>`;
    const rect = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, (window.innerWidth || 800) - 230)) + "px";
    menu.style.top = (rect.bottom + (window.scrollY || 0) + 4) + "px";
    menu.hidden = false;
  }
  async function postUsageMap(model, usage) {
    const resp = await fetch("/api/usage-map", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, usage }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.ok === false) throw new Error(data.error || `HTTP ${resp.status}`);
  }

  function renderCats() {
    // Always show known categories even if empty? Prefer only those with data + all.
    const extra = [...new Set(STATE.best.concat(STATE.current).map((r) => r.usage).filter(Boolean))]
      .filter((u) => !USAGE_ORDER.includes(u));
    const allCats = ["all", ...USAGE_ORDER, ...extra].filter((u, i, arr) => arr.indexOf(u) === i);
    const present = new Set(["all", ...STATE.best.map((b) => b.usage), ...STATE.current.map((c) => c.usage)]);
    const shown = allCats.filter((c) => present.has(c) || c === "all");
    $("bmCats").innerHTML = shown.map((c) =>
      `<button type="button" role="tab" data-cat="${esc(c)}" class="${STATE.cat === c ? "on" : ""}" aria-selected="${STATE.cat === c}">${esc(c)}</button>`
    ).join("");
  }

  function renderBest() {
    const cur = currentMap();
    const byUsage = new Map();
    for (const row of STATE.best) {
      const u = row.usage || "loaded";
      if (!byUsage.has(u)) byUsage.set(u, []);
      byUsage.get(u).push(row);
    }
    // Ensure usages that only have current still appear
    for (const row of STATE.current) {
      const u = row.usage || "loaded";
      if (!byUsage.has(u)) byUsage.set(u, []);
    }
    const order = [...USAGE_ORDER, ...[...byUsage.keys()].filter((u) => !USAGE_ORDER.includes(u))];
    let html = "";
    for (const usage of order) {
      if (!byUsage.has(usage)) continue;
      if (STATE.cat !== "all" && STATE.cat !== usage) continue;
      const rows = byUsage.get(usage);
      const help = STATE.usageHelp[usage] || "Stack role for this sample.";
      const bestY = rows.reduce((m, r) => Math.max(m, Number(r.yield) || 0), 0);
      html += `<div class="bm-usage-group" data-cat="${esc(usage)}">
        <div class="bm-usage-head">
          <h3><span class="bm-help">${esc(usage)}<span class="bm-tip"><b>${esc(usage)}</b>${esc(help)}</span></span></h3>
          <span class="bm-meta">${rows.length} host${rows.length === 1 ? "" : "s"}${bestY ? ` · best yield ${fmtYield(bestY)}` : ""}</span>
        </div>
        <div class="bm-tiles">`;
      const hosts = new Set([...rows.map((r) => r.host), ...STATE.current.filter((c) => c.usage === usage).map((c) => c.host)]);
      for (const host of hosts) {
        const best = rows.find((r) => r.host === host) || null;
        const live = cur.get(`${usage}||${host}`) || null;
        const show = best || live;
        if (!show) continue;
        const y = best ? best.yield : live.yield;
        const gb = resourceGb(best || live);
        const par = (best || live).parallel || 1;
        const tip = best && best.tps != null && gb
          ? `Example: ${best.tps} ÷ (${gb} × ${par}) ≈ ${fmtYield(y)}`
          : "Higher resource yield = more tokens per resource unit.";
        const match = best && live && sameSetup(best, live);
        html += `<div class="bm-tile">
          <div class="bm-k">${esc(host)}</div>
          <div class="bm-yield-block" tabindex="0">
            <div class="bm-yield-label">Best resource yield</div>
            <div class="bm-yield">${fmtYield(y)}</div>
            <div class="bm-tip"><b>What ${fmtYield(y)} means</b>Best efficiency for ${esc(host)} in <b>${esc(usage)}</b>.<br><br>Formula: <code>t/s ÷ (resource_GB × parallel)</code><br>${esc(tip)}</div>
          </div>
          <div class="bm-row-label">Best knobs (copy these)</div>
          <div class="bm-model" title="${esc((best || live).model)}">${esc((best || live).model)}</div>
          <div class="bm-sub">${esc(knobsLine(best || live))}${(best || live).hermes_knobs ? `<br>Hermes: ${esc((best || live).hermes_knobs)}` : ""}</div>
          <div class="bm-current">
            <span class="bm-status ${match ? "match" : "diff"}">${match ? "Current = best" : (live ? "Current ≠ best" : "No current sample")}</span><br>
            ${live ? `Live now: ctx <code>${esc(live.ctx_k != null ? live.ctx_k + "k" : "—")}</code> · parallel <code>${esc(live.parallel ?? "—")}</code> · yield ${fmtYield(live.yield)}` : "Waiting for live snapshot…"}
            ${!match && best && live && Number(best.ctx_k) !== Number(live.ctx_k) ? `<div class="bm-diff">Diff: ctx ${esc(live.ctx_k)}k vs best ${esc(best.ctx_k)}k</div>` : ""}
          </div>
        </div>`;
      }
      html += `</div></div>`;
    }
    if (!html) html = `<div class="bm-empty">No benchmark samples yet. Forwarders emit lean snapshots every ~${30}s once models are loaded.</div>`;
    $("bmBest").innerHTML = html;
  }

  function filteredSorted() {
    const f = STATE.filters;
    let rows = STATE.samples.filter((r) => {
      const search = `${r.model || ""} ${r.hermes_knobs || ""} ${r.experiment || ""} ${r.host || ""} ${r.usage || ""}`.toLowerCase();
      if (f.q && !search.includes(f.q.toLowerCase())) return false;
      if (f.host && r.host !== f.host) return false;
      if (f.usage && r.usage !== f.usage) return false;
      if (f.exp === "named" && !r.named) return false;
      if (f.exp === "auto" && r.named) return false;
      if (f.yieldMin && !(Number(r.yield) >= Number(f.yieldMin))) return false;
      return true;
    });
    const key = STATE.sortKey;
    const dir = STATE.sortDir === "asc" ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      let av = a[key]; let bv = b[key];
      if (av == null) av = key === "ts" || typeof bv === "number" ? -Infinity : "";
      if (bv == null) bv = key === "ts" || typeof av === "number" ? -Infinity : "";
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
    return rows;
  }

  function renderTable() {
    const hosts = [...new Set(STATE.samples.map((r) => r.host).filter(Boolean))].sort();
    const usages = [...new Set(STATE.samples.map((r) => r.usage).filter(Boolean))].sort();
    $("bmHost").innerHTML = `<option value="">All</option>` + hosts.map((h) =>
      `<option value="${esc(h)}" ${STATE.filters.host === h ? "selected" : ""}>${esc(h)}</option>`).join("");
    $("bmUsage").innerHTML = `<option value="">All</option>` + usages.map((u) =>
      `<option value="${esc(u)}" ${STATE.filters.usage === u ? "selected" : ""}>${esc(u)}</option>`).join("");

    const rows = filteredSorted();
    $("bmShown").textContent = String(rows.length);
    $("bmTotal").textContent = String(STATE.samples.length);
    const chips = [];
    if (STATE.filters.q) chips.push(`search “${STATE.filters.q}”`);
    if (STATE.filters.host) chips.push(STATE.filters.host);
    if (STATE.filters.usage) chips.push(STATE.filters.usage);
    if (STATE.filters.exp) chips.push(STATE.filters.exp);
    if (STATE.filters.yieldMin) chips.push(`yield ≥ ${STATE.filters.yieldMin}`);
    $("bmChips").innerHTML = chips.map((c) => `<span class="bm-chip">${esc(c)}</span>`).join(" ");
    $("bmSortLabel").textContent = `Sort: ${STATE.sortKey} ${STATE.sortDir === "asc" ? "↑" : "↓"}`;

    document.querySelectorAll("#bmTable th.sortable").forEach((th) => {
      const active = th.dataset.key === STATE.sortKey;
      th.classList.remove("sorted-asc", "sorted-desc");
      if (active) th.classList.add(STATE.sortDir === "asc" ? "sorted-asc" : "sorted-desc");
      th.setAttribute("aria-sort", active ? (STATE.sortDir === "asc" ? "ascending" : "descending") : "none");
    });

    const body = rows.map((r) => {
      const y = Number(r.yield);
      const yClass = y >= 0.5 ? "bm-good" : "bm-bad";
      const help = STATE.usageHelp[r.usage] || "Stack role for this sample.";
      const res = r.vram_gb != null ? `${r.vram_gb}G` : (r.model_gb != null ? `${r.model_gb}G*` : "—");
      return `<tr>
        <td class="mono">${esc(fmtTime(r.ts))}</td>
        <td>${esc(r.host)}</td>
        <td class="bm-usage-cell"><span class="bm-tag" tabindex="0">${esc(r.usage)}</span><span class="bm-tip"><b>${esc(r.usage)}</b>${esc(help)}</span></td>
        <td class="bm-model-cell"><span class="bm-model-id" tabindex="0">${esc(r.model)}</span><span class="bm-tip">${esc(r.model)}</span></td>
        <td>${r.ctx_k != null ? esc(r.ctx_k) + "k" : "—"}</td>
        <td>${r.parallel ?? "—"}</td>
        <td>${esc(r.ttl || "—")}</td>
        <td>${esc(r.offload || "—")}</td>
        <td class="mono">${esc(r.hermes_knobs || "—")}</td>
        <td>${r.tps != null ? esc(r.tps) : "—"}</td>
        <td>${r.p50_s != null ? esc(r.p50_s) + "s" : "—"}</td>
        <td title="VRAM if known, else model file GB (* )">${esc(res)}</td>
        <td>${r.cpu_load ?? "—"}</td>
        <td>${r.mem_used_gb != null ? `${esc(r.mem_used_gb)}/${esc(r.mem_total_gb ?? "?")}` : "—"}</td>
        <td>${r.power_w != null ? esc(r.power_w) + "W" : "—"}</td>
        <td class="${yClass}">${fmtYield(r.yield)}</td>
        <td><span class="bm-tag ${r.named ? "exp" : ""}">${esc(r.experiment || "auto")}</span></td>
      </tr>`;
    }).join("");
    $("bmTbody").innerHTML = body || `<tr><td colspan="17" class="bm-empty">No rows match these filters.</td></tr>`;
  }

  function render() {
    renderCurrent();
    renderScatter();
    renderCats();
    renderBest();
    renderTable();
  }

  function bind() {
    $("bmCurrentCard").addEventListener("click", (ev) => {
      const btn = ev.target.closest(".bm-setusage");
      if (btn) openUsageMenu(btn);
    });
    $("bmUsageMenu").addEventListener("click", async (ev) => {
      const opt = ev.target.closest("button[data-usage]");
      if (!opt) return;
      const menu = $("bmUsageMenu");
      const msg = menu.querySelector(".bm-usage-menu-msg");
      opt.disabled = true;
      try {
        await postUsageMap(opt.dataset.model, opt.dataset.usage);
        if (msg) msg.textContent = `saved “${opt.dataset.usage}” — forwarders pick up the new map within an hour`;
        setTimeout(() => { menu.hidden = true; }, 1500);
        loadData().catch(console.error);
      } catch (ex) {
        if (msg) msg.textContent = String(ex.message || ex);
        opt.disabled = false;
      }
    });
    document.addEventListener("click", (ev) => {
      const menu = $("bmUsageMenu");
      if (menu.hidden) return;
      if (ev.target.closest("#bmUsageMenu") || ev.target.closest(".bm-setusage")) return;
      menu.hidden = true;
    });
    $("bmCats").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-cat]");
      if (!b) return;
      STATE.cat = b.dataset.cat;
      render();
    });
    $("bmToggleFilters").addEventListener("click", () => {
      STATE.filtersVisible = !STATE.filtersVisible;
      $("bmFilters").classList.toggle("hidden", !STATE.filtersVisible);
      $("bmToggleFilters").textContent = STATE.filtersVisible ? "Hide filters" : "Show filters";
      $("bmToggleFilters").classList.toggle("on", STATE.filtersVisible);
      const active = Object.values(STATE.filters).filter(Boolean).length;
      $("bmFilterHint").textContent = STATE.filtersVisible
        ? "Search, host, usage, experiment, min yield"
        : (active ? `${active} filter${active === 1 ? "" : "s"} still active (hidden)` : "Filters hidden");
    });
    ["bmQ", "bmHost", "bmUsage", "bmExp", "bmYieldMin"].forEach((id) => {
      $(id).addEventListener("input", syncFilters);
      $(id).addEventListener("change", syncFilters);
    });
    $("bmClear").addEventListener("click", () => {
      STATE.filters = { q: "", host: "", usage: "", exp: "", yieldMin: "" };
      $("bmQ").value = "";
      $("bmExp").value = "";
      $("bmYieldMin").value = "";
      STATE.sortKey = "ts";
      STATE.sortDir = "desc";
      render();
    });
    $("bmTable").querySelector("thead").addEventListener("click", (ev) => {
      const th = ev.target.closest("th.sortable");
      if (!th) return;
      const key = th.dataset.key;
      if (STATE.sortKey === key) {
        STATE.sortDir = STATE.sortDir === "asc" ? "desc" : "asc";
      } else {
        STATE.sortKey = key;
        STATE.sortDir = "asc";
      }
      renderTable();
    });
    $("bmHours").addEventListener("click", (ev) => {
      const b = ev.target.closest("button[data-h]");
      if (!b) return;
      STATE.hours = Number(b.dataset.h);
      [...$("bmHours").querySelectorAll("button")].forEach((x) => x.classList.toggle("on", x === b));
      loadData().catch(console.error);
    });
    const markDialog = $("bmmark-dialog");
    const markInput = $("bmmark-label");
    const markError = $("bmmark-error");
    const markConfirm = $("bmmark-confirm");
    async function submitMark() {
      const label = markInput.value.trim();
      if (!label) {
        markError.textContent = "Enter an experiment label first.";
        markInput.focus();
        return;
      }
      markConfirm.disabled = true;
      markError.textContent = "";
      try {
        const resp = await fetch("/api/benchmark/mark", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
        markDialog.close();
        loadData().catch(console.error);
      } catch (ex) {
        markError.textContent = String(ex.message || ex);
      } finally {
        markConfirm.disabled = false;
      }
    }
    $("bmMark").addEventListener("click", () => {
      markError.textContent = "";
      markInput.value = "";
      markDialog.showModal();
      markInput.focus();
    });
    markConfirm.addEventListener("click", submitMark);
    markInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitMark();
      }
    });
    $("bmRefresh").addEventListener("click", () => loadData().catch(console.error));
  }

  function syncFilters() {
    STATE.filters.q = $("bmQ").value.trim();
    STATE.filters.host = $("bmHost").value;
    STATE.filters.usage = $("bmUsage").value;
    STATE.filters.exp = $("bmExp").value;
    STATE.filters.yieldMin = $("bmYieldMin").value;
    renderTable();
  }

  window.HermesBenchmark = {
    show() {
      $("page-overview").hidden = true;
      $("page-benchmark").hidden = false;
      document.body.dataset.page = "benchmark";
      if (!STATE._bound) { bind(); STATE._bound = true; }
      loadData().catch(console.error);
      // The SSE stream carries metric records only, not benchmark samples —
      // poll lightly while this page is visible instead. Cleared on navigate-away.
      if (!STATE.pollTimer) {
        STATE.pollTimer = setInterval(() => loadData().catch(console.error), 30000);
      }
    },
    hide() {
      $("page-benchmark").hidden = true;
      $("page-overview").hidden = false;
      document.body.dataset.page = "overview";
      if (STATE.pollTimer) {
        clearInterval(STATE.pollTimer);
        STATE.pollTimer = null;
      }
    },
  };
  // Test/debug handle — the runtime suite drives these directly.
  window.HermesBenchmark._internals = { STATE, renderCurrent, renderScatter };
})();
