/**
 * memory-v1 lab page — KV occupancy area + efficiency scatter.
 * Isolated from index.html / classic.html.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const lab = window.MemoryLab;
  const LIMIT = 20000;
  if (!lab) {
    console.error("memory-lab.js failed to load");
    return;
  }

  const RANGE_KEYS = ["1h", "6h", "12h", "24h"];
  let rangeKey = "6h";
  let kvSel = "";
  let effSel = "";
  let kvList = [];
  let effList = [];
  let abort = null;
  let usingMock = false;

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) {
      el.setAttribute(k, String(attrs[k]));
    });
    return el;
  }

  function emptyText(svg, x, y, msg) {
    const t = svgEl("text", { x: x, y: y, fill: "#6a6a6a", "font-size": 12.5, "text-anchor": "middle" });
    t.textContent = msg;
    svg.append(t);
  }

  function bindHits(host, tip, hits, getTip, onPick) {
    if (!host || !tip || !hits.length) return;
    function seriesOf(hit) {
      return hit.closest ? (hit.closest(".ctx-series") || hit) : hit;
    }
    function show(hit, cx, cy) {
      host.classList.add("is-hovering");
      const series = seriesOf(hit);
      host.querySelectorAll(".ctx-series").forEach(function (el) {
        el.classList.toggle("is-on", el === series);
      });
      const t = getTip(hit);
      tip.innerHTML = "<b>" + t.title + "</b><br/>" + t.meta;
      const rect = (host.parentElement || host).getBoundingClientRect();
      tip.style.left = (cx - rect.left) + "px";
      tip.style.top = (cy - rect.top) + "px";
      tip.classList.add("is-on");
    }
    function hide() {
      host.classList.remove("is-hovering");
      host.querySelectorAll(".ctx-series").forEach(function (el) { el.classList.remove("is-on"); });
      tip.classList.remove("is-on");
    }
    hits.forEach(function (hit) {
      hit.setAttribute("tabindex", "0");
      const move = function (e) { show(hit, e.clientX, e.clientY); };
      hit.addEventListener("pointerenter", move);
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerleave", hide);
      hit.addEventListener("focus", function () {
        const bb = hit.getBoundingClientRect();
        show(hit, bb.left + bb.width / 2, bb.top);
      });
      hit.addEventListener("blur", hide);
      hit.addEventListener("click", function (e) {
        e.stopPropagation();
        if (onPick) onPick(hit);
      });
    });
  }

  function drawGauge(svgId, labelId, metaId, model) {
    const svg = document.getElementById(svgId);
    const label = document.getElementById(labelId);
    const meta = document.getElementById(metaId);
    if (!svg) return;
    svg.replaceChildren();
    const g = lab.kvGauge(model);
    const cx = 110;
    const cy = 112;
    const r = 78;
    const onN = g.pct == null ? 0 : Math.max(0, Math.min(37, Math.round((g.pct / 100) * 37)));
    const color = (model && model.color) || "#3ee089";
    for (let i = 0; i < 52; i++) {
      const a = Math.PI + (i / 51) * Math.PI;
      const on = i < onN;
      svg.append(svgEl("line", {
        x1: cx + Math.cos(a) * (on ? 64 : 66),
        y1: cy + Math.sin(a) * (on ? 64 : 66),
        x2: cx + Math.cos(a) * r,
        y2: cy + Math.sin(a) * r,
        stroke: on ? color : "#3a3a3a",
        "stroke-width": 3,
        "stroke-linecap": "round",
      }));
    }
    if (label) {
      label.innerHTML = g.pct == null
        ? "<b>—</b><span class=\"sub\">no cap</span>"
        : "<b>" + g.pct + "%</b><span class=\"sub\">of loaded ctx</span>";
    }
    if (meta) meta.textContent = g.meta;
  }

  function legend(rootId, items, selected, key, onPick) {
    const root = document.getElementById(rootId);
    if (!root) return;
    root.innerHTML = items.map(function (it) {
      const id = it[key];
      const on = id === selected ? " is-on" : "";
      return "<button type=\"button\" class=\"" + on + "\" data-id=\"" + id + "\" aria-selected=\"" + (id === selected) + "\">" +
        "<i style=\"background:" + it.color + "\"></i>" + it.short + "</button>";
    }).join("");
    root.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { onPick(b.getAttribute("data-id")); });
    });
  }

  function drawKv() {
    const svg = document.getElementById("kvLabChart");
    if (!svg) return;
    svg.replaceChildren();
    if (!kvList.length) {
      emptyText(svg, 260, 110, "no model traffic in range");
      drawGauge("kvGauge", "kvGaugeLabel", "kvGaugeMeta", null);
      document.getElementById("kvPeak").textContent = "—";
      document.getElementById("kvPct").textContent = "—";
      document.getElementById("kvModelsN").textContent = "0";
      legend("kvLegend", [], "", "model", function () {});
      return;
    }
    const sel = kvList.filter(function (m) { return m.model === kvSel; })[0] || kvList[0];
    const t0 = sel.samples.length ? sel.samples[0].ts : 0;
    const t1 = sel.samples.length ? sel.samples[sel.samples.length - 1].ts : 1;
    const span = Math.max(t1 - t0, 1);
    const ymax = Math.max(1, Math.max.apply(null, kvList.map(function (m) {
      return Math.max(m.peak, m.cap || 0);
    })) * 1.12);
    const x = function (ts) { return 44 + ((ts - t0) / span) * 460; };
    const y = function (v) { return 188 - (v / ymax) * 160; };
    [1, 2, 3].forEach(function (i) {
      const v = ymax * i / 3;
      const yy = y(v);
      const t = svgEl("text", { x: 36, y: yy + 4, fill: "#6a6a6a", "font-size": 10, "text-anchor": "end" });
      t.textContent = lab.fmtTok(v);
      svg.append(t, svgEl("line", { x1: 44, y1: yy, x2: 504, y2: yy, stroke: "#222" }));
    });
    [0, 0.5, 1].forEach(function (f) {
      const ts = t0 + span * f;
      const t = svgEl("text", { x: x(ts), y: 212, fill: "#7a7a7a", "font-size": 11, "text-anchor": "middle" });
      t.textContent = lab.fmtTime(ts);
      svg.append(t);
    });

    const ordered = kvList.slice().sort(function (a, b) {
      if (sel && a.model === sel.model) return 1;
      if (sel && b.model === sel.model) return -1;
      return 0;
    });
    const hits = [];
    ordered.forEach(function (m) {
      const primary = sel && m.model === sel.model;
      const grp = svgEl("g", { class: "ctx-series chart-hit", "data-id": m.model, role: "img" });
      const peakS = m.samples.reduce(function (a, s) { return s.v > a.v ? s : a; }, m.samples[0]);
      const tip = lab.kvSampleTip(m, peakS);
      grp.setAttribute("aria-label", tip.title + " · " + tip.meta);
      let line = "";
      let area = "";
      m.samples.forEach(function (s, i) {
        const cmd = (i ? "L" : "M") + x(s.ts) + "," + y(s.v);
        line += cmd;
        area += cmd;
      });
      if (m.samples.length) {
        const last = m.samples[m.samples.length - 1];
        const first = m.samples[0];
        area += " L" + x(last.ts) + ",188 L" + x(first.ts) + ",188 Z";
      }
      if (m.cap) {
        grp.append(svgEl("line", {
          x1: 44, x2: 504, y1: y(m.cap), y2: y(m.cap),
          stroke: m.color, "stroke-dasharray": "4 5", opacity: primary ? 0.85 : 0.25,
        }));
      }
      grp.append(
        svgEl("path", { d: area, fill: m.color, opacity: primary ? 0.16 : 0.05 }),
        svgEl("path", { class: "hit", d: line, fill: "none", stroke: "transparent", "stroke-width": 12 }),
        svgEl("path", { d: line, fill: "none", stroke: m.color, "stroke-width": primary ? 2.2 : 1.2, opacity: primary ? 1 : 0.4 })
      );
      if (peakS) {
        grp.append(svgEl("circle", { cx: x(peakS.ts), cy: y(peakS.v), r: primary ? 3.4 : 2, fill: m.color }));
      }
      svg.append(grp);
      hits.push(grp);
    });
    bindHits(svg, document.getElementById("kvLabTip"), hits, function (el) {
      const m = kvList.filter(function (x) { return x.model === el.getAttribute("data-id"); })[0];
      const peakS = m && m.samples.reduce(function (a, s) { return s.v > a.v ? s : a; }, m.samples[0]);
      return lab.kvSampleTip(m, peakS);
    }, function (el) {
      kvSel = el.getAttribute("data-id");
      drawKv();
    });
    drawGauge("kvGauge", "kvGaugeLabel", "kvGaugeMeta", sel);
    document.getElementById("kvPeak").textContent = sel ? lab.fmtTok(sel.peak) : "—";
    document.getElementById("kvPct").textContent = sel && sel.pct != null ? Math.round(sel.pct) + "%" : "—";
    document.getElementById("kvModelsN").textContent = String(kvList.length);
    legend("kvLegend", kvList, kvSel, "model", function (id) {
      kvSel = id;
      drawKv();
    });
  }

  function drawEff() {
    const svg = document.getElementById("effLabChart");
    if (!svg) return;
    svg.replaceChildren();
    const shown = effSel ? effList.filter(function (m) { return m.model === effSel; }) : effList;
    const pts = [];
    shown.forEach(function (m) {
      m.points.forEach(function (p) { pts.push(p); });
    });
    if (!pts.length) {
      emptyText(svg, 340, 120, "no requests in range");
      document.getElementById("effN").textContent = "0";
      document.getElementById("effMed").textContent = "—";
      document.getElementById("effSlow").textContent = "0";
      legend("effLegend", [{ short: "all", model: "", color: "#6a6a6a" }].concat(effList), effSel, "model", pickEff);
      return;
    }
    const xmin = Math.max(0.3, Math.min.apply(null, pts.map(function (p) { return p.duration_s; })) * 0.8);
    const xmax = Math.max.apply(null, pts.map(function (p) { return p.duration_s; })) * 1.3;
    const ymax = Math.max(1, Math.max.apply(null, pts.map(function (p) { return p.output_tokens; })) * 1.1);
    const lx = function (v) { return Math.log(Math.max(v, 0.2)) / Math.log(10); };
    const x = function (d) { return 48 + (lx(d) - lx(xmin)) / Math.max(lx(xmax) - lx(xmin), 0.01) * 610; };
    const y = function (v) { return 200 - (v / ymax) * 170; };
    [1, 2, 3].forEach(function (i) {
      const v = ymax * i / 3;
      const yy = y(v);
      const t = svgEl("text", { x: 40, y: yy + 4, fill: "#6a6a6a", "font-size": 10, "text-anchor": "end" });
      t.textContent = lab.fmtTok(v);
      svg.append(t, svgEl("line", { x1: 48, y1: yy, x2: 668, y2: yy, stroke: "#222" }));
    });
    [1, 3, 10, 30].filter(function (t) { return t >= xmin && t <= xmax; }).forEach(function (tick) {
      const tx = svgEl("text", { x: x(tick), y: 228, fill: "#7a7a7a", "font-size": 11, "text-anchor": "middle" });
      tx.textContent = tick + "s";
      svg.append(tx);
    });
    [10, 30, 60].forEach(function (tps) {
      const seg = [];
      for (let i = 0; i <= 24; i++) {
        const vx = xmin * Math.pow(xmax / xmin, i / 24);
        const vy = tps * vx;
        if (vy > ymax) break;
        seg.push([x(vx), y(vy)]);
      }
      if (seg.length < 2) return;
      let d = "M" + seg[0][0] + "," + seg[0][1];
      for (let i = 1; i < seg.length; i++) d += " L" + seg[i][0] + "," + seg[i][1];
      svg.append(svgEl("path", { d: d, fill: "none", stroke: "#3a3a3a", "stroke-dasharray": "4 4" }));
      const last = seg[seg.length - 1];
      const labEl = svgEl("text", { x: Math.min(last[0] + 4, 650), y: Math.max(last[1] - 4, 12), fill: "#6a6a6a", "font-size": 10 });
      labEl.textContent = tps + "/s";
      svg.append(labEl);
    });

    const hits = [];
    shown.forEach(function (m) {
      const grp = svgEl("g", { class: "ctx-series", "data-id": m.model, role: "img" });
      const drawn = m.drawn || m.points;
      m._drawn = drawn;
      drawn.forEach(function (p, i) {
        const hit = svgEl("circle", {
          class: "hit chart-hit",
          cx: x(p.duration_s),
          cy: y(p.output_tokens),
          r: 8,
          fill: "transparent",
          "data-id": m.model,
          "data-i": i,
        });
        grp.append(hit);
        grp.append(svgEl("circle", {
          cx: x(p.duration_s),
          cy: y(p.output_tokens),
          r: p.tps < 10 ? 3.4 : 2.2,
          fill: m.color,
          opacity: p.tps < 10 ? 1 : 0.85,
        }));
        hits.push(hit);
      });
      grp.setAttribute("aria-label", m.short + " · " + m.points.length + " requests");
      svg.append(grp);
    });
    bindHits(svg, document.getElementById("effLabTip"), hits, function (el) {
      const m = effList.filter(function (x) { return x.model === el.getAttribute("data-id"); })[0];
      const i = Number(el.getAttribute("data-i"));
      const drawn = m && (m._drawn || m.drawn || m.points);
      return lab.effTip(m, drawn && drawn[i]);
    }, function (el) {
      pickEff(el.getAttribute("data-id"));
    });
    const kpis = lab.effKpis(shown);
    document.getElementById("effN").textContent = String(kpis.n);
    document.getElementById("effMed").textContent = lab.fmtTps(kpis.medianTps);
    document.getElementById("effSlow").textContent = String(kpis.slow);
    legend("effLegend", [{ short: "all", model: "", color: "#6a6a6a" }].concat(effList), effSel, "model", pickEff);
  }

  function pickEff(id) {
    effSel = id || "";
    drawEff();
  }

  function rangeFromHash() {
    const spec = lab.parseRangeToken(location.hash || "#/range=6h");
    if (spec.hours === 1) return "1h";
    if (spec.hours === 12) return "12h";
    if (spec.hours === 24) return "24h";
    return "6h";
  }

  function writeHash(range) {
    const h = "#/range=" + range;
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }

  function setChip(ok, msg) {
    const el = document.getElementById("liveChip");
    if (!el) return;
    el.className = ok ? "chip chip-mint" : "chip";
    el.innerHTML = ok
      ? "<span class=\"live-dot\"></span> live · :8899"
      : "<span class=\"live-dot\"></span> " + (msg || "mock");
  }

  function markNav(id) {
    document.querySelectorAll("[data-jump]").forEach(function (a) {
      a.classList.toggle("is-active", a.getAttribute("data-jump") === id);
    });
  }

  async function load() {
    const now = Date.now() / 1000;
    const win = lab.windowForRange(rangeKey, now);
    document.getElementById("kvSub").textContent = rangeKey + " · occupancy vs loaded ctx";
    document.getElementById("effSub").textContent = rangeKey + " · duration vs output";
    if (abort) abort.abort();
    abort = new AbortController();
    const url = "/api/recent?from=" + encodeURIComponent(win[0]) +
      "&to=" + encodeURIComponent(win[1]) +
      "&limit=" + LIMIT +
      "&exclude=pool_status,host_stats";
    let records = [];
    usingMock = false;
    try {
      const resp = await fetch(url, { signal: abort.signal });
      if (!resp.ok) throw new Error("history " + resp.status);
      const payload = await resp.json();
      records = Array.isArray(payload.records) ? payload.records : [];
      setChip(true);
      document.getElementById("memFoot").textContent = records.length + " rows from /api/recent";
    } catch (err) {
      if (err && err.name === "AbortError") return;
      usingMock = true;
      records = lab.mockRecords(now);
      setChip(false, "mock sessions");
      document.getElementById("memFoot").textContent = "Using mock sessions — serve from :8899 for live /api/recent";
    }
    kvList = lab.kvModels(records, { from: win[0], to: win[1], samples: 48 });
    effList = lab.effModels(records, { from: win[0], to: win[1] });
    if (usingMock && !kvList.length) {
      records = lab.mockRecords(now);
      kvList = lab.kvModels(records, { from: now - 8 * 3600, to: now, samples: 48 });
      if (!effList.length) effList = lab.effModels(records, { from: now - 8 * 3600, to: now });
    }
    kvSel = kvList.length ? kvList[0].model : "";
    effSel = "";
    drawKv();
    drawEff();
  }

  document.querySelectorAll("[data-range]").forEach(function (b) {
    b.addEventListener("click", function () {
      rangeKey = RANGE_KEYS.indexOf(b.getAttribute("data-range")) >= 0 ? b.getAttribute("data-range") : "6h";
      writeHash(rangeKey);
      document.querySelectorAll("[data-range]").forEach(function (x) {
        x.classList.toggle("is-on", x === b);
      });
      load();
    });
  });
  document.querySelectorAll("[data-jump]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      const id = a.getAttribute("data-jump");
      const el = document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      markNav(id);
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  window.addEventListener("hashchange", function () {
    rangeKey = rangeFromHash();
    document.querySelectorAll("[data-range]").forEach(function (x) {
      x.classList.toggle("is-on", x.getAttribute("data-range") === rangeKey);
    });
    load();
  });

  rangeKey = rangeFromHash();
  if (!location.hash || location.hash === "#kv" || location.hash === "#efficiency") writeHash(rangeKey);
  document.querySelectorAll("[data-range]").forEach(function (x) {
    x.classList.toggle("is-on", x.getAttribute("data-range") === rangeKey);
  });
  load();
})();
