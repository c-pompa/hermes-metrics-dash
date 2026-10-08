/**
 * runs-v1 lab page — live /api/recent stacked ok/error bars.
 * Isolated from index.html / classic.html.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const mint = "#3ee089";
  const lab = window.RunsLab;
  const LIMIT = 20000;

  if (!lab) {
    console.error("runs-lab.js failed to load");
    return;
  }

  const RANGE_KEYS = ["1h", "6h", "12h", "24h", "7d", "today", "yesterday"];
  const HOST_KEYS = ["", "mbp", "mini"];

  let rangeKey = "6h";
  let hostKey = "";
  let abort = null;

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) {
      el.setAttribute(k, String(attrs[k]));
    });
    return el;
  }

  function hatchDefs(svg, id, color) {
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = svgEl("defs");
      svg.prepend(defs);
    }
    const p = svgEl("pattern", {
      id: id,
      width: 6,
      height: 6,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    p.append(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: color, "stroke-width": 1.6 }));
    defs.append(p);
  }

  function bindChartTip(host, tip, hits, getTip) {
    if (!host || !tip || !hits.length) return;
    function show(hit, clientX, clientY) {
      hits.forEach(function (el) { el.classList.toggle("is-on", el === hit); });
      const t = getTip(hit);
      tip.innerHTML = "<b>" + t.title + "</b><br/>" + t.meta;
      const rect = host.getBoundingClientRect();
      tip.style.left = (clientX - rect.left) + "px";
      tip.style.top = (clientY - rect.top) + "px";
      tip.classList.add("is-on");
    }
    function hide() {
      hits.forEach(function (el) { el.classList.remove("is-on"); });
      tip.classList.remove("is-on");
    }
    hits.forEach(function (hit) {
      hit.addEventListener("pointerenter", function (e) { show(hit, e.clientX, e.clientY); });
      hit.addEventListener("pointermove", function (e) { show(hit, e.clientX, e.clientY); });
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("focus", function () {
        const bb = hit.getBoundingClientRect();
        show(hit, bb.left + bb.width / 2, bb.top);
      });
      hit.addEventListener("blur", hide);
    });
  }

  function grainLabel(step) {
    if (step <= 300) return "5 min buckets";
    if (step <= 1800) return "30 min buckets";
    if (step <= 3600) return "hourly";
    return "daily";
  }

  function niceMax(n) {
    if (n <= 0) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(n)));
    const nrm = n / mag;
    const nice = nrm <= 1 ? 1 : nrm <= 2 ? 2 : nrm <= 5 ? 5 : 10;
    return nice * mag;
  }

  function rangeFromHash() {
    const raw = location.hash || "#/range=6h";
    const spec = lab.parseRangeToken(raw);
    const host = lab.parseHostToken(raw);
    let key = "6h";
    if (spec.type === "day") key = spec.offset === 1 ? "yesterday" : "today";
    else if (spec.hours === 1) key = "1h";
    else if (spec.hours === 6) key = "6h";
    else if (spec.hours === 12) key = "12h";
    else if (spec.hours === 24) key = "24h";
    else if (spec.hours === 168) key = "7d";
    else if (spec.hours) key = spec.hours + "h";
    return { range: key, host: host };
  }

  function writeHash(range, host) {
    let h = "#/range=" + range;
    if (host) h += "&host=" + encodeURIComponent(host);
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }

  function overviewHref(range, host) {
    let h = "/#/range=" + range;
    if (host) h += "&host=" + encodeURIComponent(host);
    return h;
  }

  function syncChips() {
    document.querySelectorAll("[data-range]").forEach(function (b) {
      const on = b.getAttribute("data-range") === rangeKey;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll("#hostSeg [data-host]").forEach(function (b) {
      const on = (b.getAttribute("data-host") || "") === hostKey;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    const live = overviewHref(rangeKey, hostKey);
    const nav = document.getElementById("navLive");
    const open = document.getElementById("openOverview");
    if (nav) nav.setAttribute("href", live);
    if (open) open.setAttribute("href", live);
  }

  function setChip(ok, msg) {
    const el = document.getElementById("liveChip");
    if (!el) return;
    el.classList.toggle("chip-mint", ok);
    el.innerHTML = ok
      ? '<span class="live-dot"></span> live · :8899'
      : '<span class="live-dot"></span> ' + (msg || "stale");
  }

  function fmtPct(n) {
    if (!n) return "0%";
    if (n < 0.1) return n.toFixed(2) + "%";
    if (n < 10) return n.toFixed(1) + "%";
    return Math.round(n) + "%";
  }

  function draw(buckets) {
    const svg = document.getElementById("runsChart");
    if (!svg) return;
    svg.innerHTML = "";
    hatchDefs(svg, "hatchRun", "#4a4a4a");
    const kpis = lab.runsKpis(buckets);
    const maxBar = buckets.reduce(function (m, b) {
      return Math.max(m, (Number(b.ok) || 0) + (Number(b.errors) || 0));
    }, 0);
    const max = niceMax(maxBar);
    const n = Math.max(buckets.length, 1);
    const w = 620 / n;
    const barW = Math.max(6, Math.min(22, w * 0.55));
    const hits = [];
    buckets.forEach(function (b, i) {
      const ok = Number(b.ok) || 0;
      const err = Number(b.errors) || 0;
      const hOk = (ok / max) * 170;
      const hErr = (err / max) * 170;
      const x = 44 + i * w + (w - barW) / 2;
      const g = svgEl("g", {
        class: "run-bar chart-hit",
        "data-i": i,
        tabindex: "0",
        role: "img",
      });
      const tip = lab.runsBarTip(b);
      g.setAttribute("aria-label", tip.title + " · " + tip.meta);
      g.append(
        svgEl("rect", {
          x: x,
          y: 190 - hOk,
          width: barW,
          height: Math.max(hOk, 0),
          fill: "url(#hatchRun)",
          rx: 2,
        }),
        svgEl("rect", {
          x: x,
          y: 190 - hOk - hErr,
          width: barW,
          height: Math.max(hErr, 0),
          fill: mint,
          rx: 2,
        }),
        svgEl("rect", {
          class: "hit",
          x: x,
          y: 190 - hOk - hErr,
          width: barW,
          height: Math.max(hOk + hErr, 8),
          fill: "transparent",
        })
      );
      svg.append(g);
      hits.push(g);
    });
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const nTick = (max / ticks) * t;
      const y = 190 - (nTick / max) * 170;
      const label = svgEl("text", { x: 36, y: y + 4, fill: "#6a6a6a", "font-size": 10, "text-anchor": "end" });
      label.textContent = nTick >= 1000 ? (nTick / 1000) + "k" : String(Math.round(nTick));
      svg.append(label, svgEl("line", { x1: 44, y1: y, x2: 670, y2: y, stroke: "#222" }));
    }
    const stride = n > 16 ? Math.ceil(n / 8) : n > 10 ? 2 : 1;
    buckets.forEach(function (b, i) {
      if (i % stride && i !== n - 1) return;
      const t = svgEl("text", {
        x: 44 + i * w + w / 2,
        y: 228,
        fill: "#7a7a7a",
        "font-size": 11,
        "text-anchor": "middle",
      });
      t.textContent = b.label;
      svg.append(t);
    });
    bindChartTip(svg.parentElement, document.getElementById("runsTip"), hits, function (el) {
      return lab.runsBarTip(buckets[Number(el.getAttribute("data-i"))]);
    });
    document.getElementById("kpiReq").textContent = String(kpis.requests);
    document.getElementById("kpiOk").textContent = String(kpis.ok);
    document.getElementById("kpiErr").textContent = String(kpis.errors);
    document.getElementById("kpiRate").textContent = fmtPct(kpis.rate);
  }

  async function load() {
    const now = Date.now() / 1000;
    const win = lab.windowForRange(rangeKey, now);
    const from = win[0];
    const to = win[1];
    const hours = Math.max((to - from) / 3600, 1 / 60);
    const step = lab.bucketSeconds(hours);
    const hostNote = hostKey ? hostKey : "all hosts";
    document.getElementById("runsSub").textContent =
      rangeKey + " · " + grainLabel(step) + " · " + hostNote;
    document.getElementById("runsFoot").textContent = "Fetching /api/recent…";
    if (abort) abort.abort();
    abort = new AbortController();
    const url = "/api/recent?from=" + encodeURIComponent(from) +
      "&to=" + encodeURIComponent(to) +
      "&limit=" + LIMIT +
      "&exclude=pool_status,host_stats";
    try {
      const resp = await fetch(url, { signal: abort.signal });
      if (!resp.ok) throw new Error("history request failed (" + resp.status + ")");
      const payload = await resp.json();
      const records = Array.isArray(payload.records) ? payload.records : [];
      const buckets = lab.runsFromRecords(records, { from: from, to: to, host: hostKey });
      draw(buckets);
      const kpis = lab.runsKpis(buckets);
      const truncated = records.length >= LIMIT ? " · hit " + LIMIT + " row cap" : "";
      document.getElementById("runsFoot").textContent =
        records.length + " rows fetched · " + kpis.requests + " stacked" + truncated;
      setChip(true);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.warn("runs-v1 fetch failed", err);
      draw([]);
      document.getElementById("runsFoot").textContent = "Could not load /api/recent — is :8899 up?";
      setChip(false, "stale");
    }
  }

  function applyState(range, host, skipWrite) {
    rangeKey = RANGE_KEYS.indexOf(range) >= 0 ? range : "6h";
    hostKey = HOST_KEYS.indexOf(host) >= 0 ? host : (host || "");
    if (!skipWrite) writeHash(rangeKey, hostKey);
    syncChips();
    load();
  }

  document.querySelectorAll("[data-range]").forEach(function (b) {
    b.addEventListener("click", function () {
      applyState(b.getAttribute("data-range"), hostKey);
    });
  });
  document.querySelectorAll("#hostSeg [data-host]").forEach(function (b) {
    b.addEventListener("click", function () {
      applyState(rangeKey, b.getAttribute("data-host") || "");
    });
  });
  window.addEventListener("hashchange", function () {
    const st = rangeFromHash();
    applyState(st.range, st.host, true);
  });

  const initial = rangeFromHash();
  if (!location.hash) writeHash(initial.range, initial.host);
  applyState(initial.range, initial.host, true);
})();
