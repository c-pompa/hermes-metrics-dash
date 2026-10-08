/**
 * speed-v1 lab page — tok/s / duration / output tokens with model isolation.
 * Isolated from index.html / classic.html.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const lab = window.SpeedLab;
  const LIMIT = 20000;
  if (!lab) {
    console.error("speed-lab.js failed to load");
    return;
  }

  const RANGE_KEYS = ["1h", "6h", "12h", "24h"];
  let rangeKey = "6h";
  let metric = "tps";
  let pin = "";
  let models = [];
  let allErrors = [];
  let winFrom = 0;
  let winTo = 1;
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

  function legend() {
    const root = document.getElementById("speedLegend");
    if (!root) return;
    const items = [{ short: "all", model: "", color: "#6a6a6a" }].concat(models);
    root.innerHTML = items.map(function (it) {
      const on = it.model === pin ? " is-on" : "";
      return "<button type=\"button\" class=\"" + on + "\" data-id=\"" + it.model + "\" aria-selected=\"" + (it.model === pin) + "\">" +
        "<i style=\"background:" + it.color + "\"></i>" + it.short + "</button>";
    }).join("");
    root.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        pin = b.getAttribute("data-id") || "";
        redraw();
      });
    });
  }

  function cards(shown) {
    const root = document.getElementById("speedCards");
    if (!root) return;
    root.innerHTML = shown.map(function (m) {
      const on = m.model === pin ? " is-on" : "";
      const lat = [m.p50 != null ? "p50 " + lab.fmtDuration(m.p50) : "", m.p95 != null ? "p95 " + lab.fmtDuration(m.p95) : ""]
        .filter(Boolean).join(" · ");
      return "<button type=\"button\" class=\"speed-card" + on + "\" data-id=\"" + m.model + "\">" +
        "<span class=\"speed-card-h\"><i style=\"background:" + m.color + "\"></i>" + m.short + "</span>" +
        "<b class=\"tabular\">" + m.n + " req · med " + lab.fmtMetric(metric, m.median) + "</b>" +
        "<span>" + lat + "</span></button>";
    }).join("");
    root.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        const id = b.getAttribute("data-id");
        pin = pin === id ? "" : id;
        redraw();
      });
    });
  }

  function draw() {
    const svg = document.getElementById("speedLabChart");
    if (!svg) return;
    svg.replaceChildren();
    const spec = lab.metricOf(metric);
    document.getElementById("speedTitle").textContent = spec.title;
    const errors = pin
      ? allErrors.filter(function (e) { return e.model === pin; })
      : allErrors;
    const shown = lab.isolateModels(models, pin);
    const t0 = winFrom || 0;
    const t1 = winTo || 1;
    const span = Math.max(t1 - t0, 1);
    let ymax = 1;
    shown.forEach(function (m) {
      (m.bins || []).forEach(function (b) {
        if (b.p75 > ymax) ymax = b.p75;
      });
      if (pin) {
        (m.points || []).forEach(function (p) {
          if (p.v > ymax) ymax = p.v;
        });
      }
    });
    ymax = ymax * 1.12;
    const x = function (ts) { return 48 + ((ts - t0) / span) * 640; };
    const y = function (v) { return 200 - (v / ymax) * 170; };
    const y0 = 200;
    if (!shown.length) {
      emptyText(svg, 360, 120, "no requests in range");
    } else {
      [1, 2, 3, 4].forEach(function (i) {
        const v = ymax * i / 4;
        const yy = y(v);
        const t = svgEl("text", { x: 40, y: yy + 4, fill: "#6a6a6a", "font-size": 10, "text-anchor": "end" });
        t.textContent = lab.fmtMetric(metric, v);
        svg.append(t, svgEl("line", { x1: 48, y1: yy, x2: 688, y2: yy, stroke: "#222" }));
      });
      [0, 0.5, 1].forEach(function (f) {
        const ts = t0 + span * f;
        const t = svgEl("text", { x: x(ts), y: 228, fill: "#7a7a7a", "font-size": 11, "text-anchor": "middle" });
        t.textContent = lab.fmtTime(ts);
        svg.append(t);
      });
    }

    const hits = [];
    const ordered = shown.slice().reverse();
    ordered.forEach(function (m) {
      const bins = m.bins || [];
      const grp = svgEl("g", { class: "ctx-series", "data-id": m.model, role: "img" });
      bins.forEach(function (b, i) {
        const x0 = x(b.t0);
        const x1 = x(b.t1);
        const yHi = y(b.p75);
        const yLo = y(b.p25);
        const h = Math.max(2, yLo - yHi);
        grp.append(svgEl("rect", {
          x: x0, y: yHi, width: Math.max(1, x1 - x0), height: h,
          fill: m.color, opacity: pin ? 0.28 : 0.22,
        }));
        grp.append(svgEl("line", {
          x1: x0, x2: x1, y1: y(b.median), y2: y(b.median),
          stroke: m.color, "stroke-width": 2.2, "stroke-linecap": "round",
        }));
        const hit = svgEl("rect", {
          class: "hit chart-hit",
          x: x0, y: Math.min(yHi, y(b.median) - 8),
          width: Math.max(4, x1 - x0),
          height: Math.max(h, 16),
          fill: "transparent",
          "data-id": m.model,
          "data-bin": i,
        });
        grp.append(hit);
        hits.push(hit);
      });
      if (pin) {
        (m.drawn || m.points || []).forEach(function (p, i) {
          const cx = x(p.ts);
          const cy = y(p.v);
          const hit = svgEl("circle", {
            class: "hit chart-hit",
            cx: cx, cy: cy, r: 7, fill: "transparent",
            "data-id": m.model, "data-i": i,
          });
          grp.append(hit);
          grp.append(svgEl("circle", { cx: cx, cy: cy, r: 2.4, fill: m.color, opacity: 0.9 }));
          hits.push(hit);
        });
      }
      grp.setAttribute("aria-label", m.short + " · " + m.n + " requests");
      svg.append(grp);
    });

    errors.forEach(function (e, i) {
      const cx = x(e.ts);
      const cy = y0 - 8;
      const g = svgEl("g", { class: "ctx-series chart-hit", "data-err": i, role: "img" });
      g.append(
        svgEl("line", { x1: cx - 4, y1: cy - 4, x2: cx + 4, y2: cy + 4, stroke: "#ef4444", "stroke-width": 2 }),
        svgEl("line", { x1: cx - 4, y1: cy + 4, x2: cx + 4, y2: cy - 4, stroke: "#ef4444", "stroke-width": 2 })
      );
      svg.append(g);
      hits.push(g);
    });

    bindHits(svg, document.getElementById("speedLabTip"), hits, function (el) {
      const errI = el.getAttribute("data-err");
      if (errI != null) return lab.errorTip(errors[Number(errI)]);
      const m = models.filter(function (x) { return x.model === el.getAttribute("data-id"); })[0];
      const binI = el.getAttribute("data-bin");
      if (binI != null) return lab.binTip(m, m && m.bins[Number(binI)], metric);
      const drawn = m && (m.drawn || m.points);
      return lab.speedTip(m, drawn && drawn[Number(el.getAttribute("data-i"))], metric);
    }, function (el) {
      const id = el.getAttribute("data-id");
      if (id) {
        pin = pin === id ? "" : id;
        redraw();
      }
    });

    let n = 0;
    let medVals = [];
    shown.forEach(function (m) {
      n += m.n;
      (m.points || []).forEach(function (p) { medVals.push(p.v); });
    });
    document.getElementById("speedN").textContent = String(n);
    document.getElementById("speedMed").textContent = lab.fmtMetric(metric, lab.median(medVals));
    document.getElementById("speedMedLabel").textContent = "median " + spec.label;
    document.getElementById("speedErr").textContent = String(errors.length);
    legend();
    cards(models);
  }

  function drawLanes() {
    const svg = document.getElementById("speedLaneChart");
    if (!svg) return;
    svg.replaceChildren();
    const spec = lab.metricOf(metric);
    const sub = document.getElementById("laneSub");
    if (sub) sub.textContent = rangeKey + " · " + spec.label + " · per-row y";
    const t0 = winFrom || 0;
    const t1 = winTo || 1;
    const span = Math.max(t1 - t0, 1);
    const lanes = lab.laneLayout(models, { rowH: 44, gap: 8 });
    const padTop = 6;
    const padBottom = 28;
    const labelW = 108;
    const rightW = 58;
    const chartL = labelW;
    const chartR = 720 - rightW;
    const chartW = chartR - chartL;
    const bodyH = lanes.length ? lanes[lanes.length - 1].y + lanes[lanes.length - 1].h : 44;
    const height = padTop + bodyH + padBottom;
    svg.setAttribute("viewBox", "0 0 720 " + height);
    svg.setAttribute("aria-label", "IQR lanes by model");

    if (!lanes.length) {
      emptyText(svg, 360, height / 2, "no requests in range");
      return;
    }

    const x = function (ts) { return chartL + ((Number(ts) - t0) / span) * chartW; };
    [0, 0.5, 1].forEach(function (f) {
      const ts = t0 + span * f;
      const t = svgEl("text", { x: x(ts), y: height - 8, fill: "#7a7a7a", "font-size": 11, "text-anchor": "middle" });
      t.textContent = lab.fmtTime(ts);
      svg.append(t);
    });

    const hits = [];
    lanes.forEach(function (lane, li) {
      const m = models[li];
      const y0 = padTop + lane.y;
      const y1 = y0 + lane.h;
      const ymax = lane.ymax * 1.08;
      const yv = function (v) { return y1 - 2 - (Number(v) / ymax) * (lane.h - 8); };
      const grp = svgEl("g", {
        class: "ctx-series" + (pin && pin === m.model ? " is-pinned" : ""),
        "data-id": m.model,
        role: "img",
      });
      grp.append(svgEl("rect", {
        class: "lane-bg",
        x: 0, y: y0, width: 720, height: lane.h, rx: 6,
        fill: pin && pin === m.model ? "rgba(255,255,255,0.045)" : "transparent",
      }));
      grp.append(svgEl("circle", { cx: 12, cy: y0 + lane.h / 2, r: 3.5, fill: m.color }));
      const label = svgEl("text", { x: 22, y: y0 + lane.h / 2 + 4, fill: "#d4d4d4", "font-size": 11 });
      label.textContent = m.short;
      grp.append(label);
      grp.append(svgEl("line", { x1: chartL, y1: y1 - 1, x2: chartR, y2: y1 - 1, stroke: "#222" }));

      const rowHit = svgEl("rect", {
        class: "hit chart-hit",
        x: 0, y: y0, width: chartL, height: lane.h,
        fill: "transparent",
        "data-id": m.model,
      });
      grp.append(rowHit);
      hits.push(rowHit);

      (m.bins || []).forEach(function (b, i) {
        const x0 = x(b.t0);
        const x1 = x(b.t1);
        const yHi = yv(b.p75);
        const yLo = yv(b.p25);
        const h = Math.max(2, yLo - yHi);
        grp.append(svgEl("rect", {
          x: x0, y: yHi, width: Math.max(1, x1 - x0), height: h,
          fill: m.color, opacity: 0.3,
        }));
        grp.append(svgEl("line", {
          x1: x0, x2: x1, y1: yv(b.median), y2: yv(b.median),
          stroke: m.color, "stroke-width": 2, "stroke-linecap": "round",
        }));
        const hit = svgEl("rect", {
          class: "hit chart-hit",
          x: x0, y: y0,
          width: Math.max(4, x1 - x0),
          height: lane.h,
          fill: "transparent",
          "data-id": m.model,
          "data-bin": i,
        });
        grp.append(hit);
        hits.push(hit);
      });

      const med = svgEl("text", {
        x: chartR + 8, y: y0 + lane.h / 2 + 4,
        fill: m.color, "font-size": 10.5, class: "tabular",
      });
      med.textContent = lab.fmtMetric(metric, m.median);
      grp.append(med);
      grp.setAttribute("aria-label", m.short + " · " + m.n + " requests · med " + lab.fmtMetric(metric, m.median));
      svg.append(grp);
    });

    bindHits(svg, document.getElementById("speedLaneTip"), hits, function (el) {
      const m = models.filter(function (x) { return x.model === el.getAttribute("data-id"); })[0];
      const binI = el.getAttribute("data-bin");
      if (binI != null && m) return lab.binTip(m, m.bins[Number(binI)], metric);
      return {
        title: (m && m.short) || "model",
        meta: (m ? m.n : 0) + " req · med " + lab.fmtMetric(metric, m && m.median),
      };
    }, function (el) {
      const id = el.getAttribute("data-id");
      if (id) {
        pin = pin === id ? "" : id;
        redraw();
      }
    });
  }

  function drawHeat() {
    const svg = document.getElementById("speedHeatChart");
    if (!svg) return;
    svg.replaceChildren();
    const spec = lab.metricOf(metric);
    const sub = document.getElementById("heatSub");
    if (sub) sub.textContent = rangeKey + " · " + spec.label + " · bright = high median";
    const t0 = winFrom || 0;
    const t1 = winTo || 1;
    const span = Math.max(t1 - t0, 1);
    const grid = lab.heatGrid(models, { steps: 24, from: t0, to: t1 });
    const padTop = 6;
    const padBottom = 28;
    const labelW = 108;
    const rowH = 26;
    const gap = 5;
    const chartL = labelW;
    const chartR = 712;
    const chartW = chartR - chartL;
    const bodyH = grid.rows.length ? grid.rows.length * (rowH + gap) - gap : rowH;
    const height = padTop + bodyH + padBottom;
    svg.setAttribute("viewBox", "0 0 720 " + height);
    svg.setAttribute("aria-label", "Median heatmap by model and time");

    if (!grid.rows.length) {
      emptyText(svg, 360, height / 2, "no requests in range");
      return;
    }

    const x = function (i) { return chartL + (i / grid.steps) * chartW; };
    const cw = Math.max(2, chartW / grid.steps - 2);
    [0, 0.5, 1].forEach(function (f) {
      const ts = t0 + span * f;
      const t = svgEl("text", {
        x: chartL + f * chartW, y: height - 8,
        fill: "#7a7a7a", "font-size": 11,
        "text-anchor": f === 0 ? "start" : f === 1 ? "end" : "middle",
      });
      t.textContent = lab.fmtTime(ts);
      svg.append(t);
    });

    const vmaxEl = document.getElementById("heatVmax");
    if (vmaxEl) vmaxEl.textContent = "max med " + lab.fmtMetric(metric, grid.vmax);

    const hits = [];
    grid.rows.forEach(function (row, ri) {
      const y0 = padTop + ri * (rowH + gap);
      const grp = svgEl("g", {
        class: "ctx-series" + (pin && pin === row.model ? " is-pinned" : ""),
        "data-id": row.model,
        role: "img",
      });
      grp.append(svgEl("rect", {
        class: "lane-bg",
        x: 0, y: y0 - 1, width: 720, height: rowH + 2, rx: 5,
        fill: pin && pin === row.model ? "rgba(255,255,255,0.045)" : "transparent",
      }));
      grp.append(svgEl("circle", { cx: 12, cy: y0 + rowH / 2, r: 3.5, fill: row.color }));
      const label = svgEl("text", { x: 22, y: y0 + rowH / 2 + 4, fill: "#d4d4d4", "font-size": 11 });
      label.textContent = row.short;
      grp.append(label);

      row.cells.forEach(function (c) {
        const xx = x(c.i) + 1;
        const fill = c.empty ? "#191919" : lab.heatFill(c.median, grid.vmax, row.color);
        grp.append(svgEl("rect", {
          class: "heat-cell",
          x: xx, y: y0, width: cw, height: rowH, rx: 2,
          fill: fill,
          stroke: c.empty ? "#242424" : "transparent",
        }));
        const hit = svgEl("rect", {
          class: "hit chart-hit cell",
          x: xx, y: y0, width: cw, height: rowH,
          fill: "transparent",
          "data-id": row.model,
          "data-bin": c.i,
          "data-empty": c.empty ? "1" : "0",
        });
        grp.append(hit);
        hits.push(hit);
      });

      grp.setAttribute("aria-label", row.short + " heatmap");
      svg.append(grp);
    });

    bindHits(svg, document.getElementById("speedHeatTip"), hits, function (el) {
      const m = models.filter(function (x) { return x.model === el.getAttribute("data-id"); })[0];
      if (el.getAttribute("data-empty") === "1") {
        return {
          title: (m && m.short) || "model",
          meta: "no requests · " + lab.fmtTime(t0 + (Number(el.getAttribute("data-bin")) + 0.5) * (span / grid.steps)),
        };
      }
      const bin = m && (m.bins || []).filter(function (b) { return String(b.i) === el.getAttribute("data-bin"); })[0];
      return lab.binTip(m, bin, metric);
    }, function (el) {
      const id = el.getAttribute("data-id");
      if (id) {
        pin = pin === id ? "" : id;
        redraw();
      }
    });
  }

  function redraw() {
    ["speedLabTip", "speedLaneTip", "speedHeatTip"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove("is-on");
    });
    ["speedLabChart", "speedLaneChart", "speedHeatChart"].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove("is-hovering");
    });
    draw();
    drawLanes();
    drawHeat();
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

  async function load() {
    const now = Date.now() / 1000;
    const win = lab.windowForRange(rangeKey, now);
    winFrom = win[0];
    winTo = win[1];
    document.getElementById("speedSub").textContent = rangeKey + " · IQR band · pin for dots";
    const laneSub = document.getElementById("laneSub");
    if (laneSub) laneSub.textContent = rangeKey + " · per-row y";
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
      document.getElementById("speedFoot").textContent = records.length + " rows from /api/recent";
    } catch (err) {
      if (err && err.name === "AbortError") return;
      usingMock = true;
      records = lab.mockRecords(now);
      setChip(false, "mock sessions");
      document.getElementById("speedFoot").textContent = "Using mock sessions — serve from :8899 for live /api/recent";
    }
    models = lab.speedModels(records, { from: win[0], to: win[1], metric: metric, pointLimit: 80 });
    allErrors = lab.speedErrors(records, { from: win[0], to: win[1] });
    if (usingMock && !models.length) {
      records = lab.mockRecords(now);
      models = lab.speedModels(records, { from: now - 8 * 3600, to: now, metric: metric });
      allErrors = lab.speedErrors(records, { from: now - 8 * 3600, to: now });
    }
    if (pin && !models.some(function (m) { return m.model === pin; })) pin = "";
    redraw();
  }

  function markNav(id) {
    document.querySelectorAll("[data-jump]").forEach(function (a) {
      a.classList.toggle("is-active", a.getAttribute("data-jump") === id);
    });
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
  document.querySelectorAll("[data-metric]").forEach(function (b) {
    b.addEventListener("click", function () {
      metric = b.getAttribute("data-metric") || "tps";
      document.querySelectorAll("[data-metric]").forEach(function (x) {
        const on = x === b;
        x.classList.toggle("is-on", on);
        x.setAttribute("aria-selected", String(on));
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
  if (!location.hash) writeHash(rangeKey);
  document.querySelectorAll("[data-range]").forEach(function (x) {
    x.classList.toggle("is-on", x.getAttribute("data-range") === rangeKey);
  });
  load();
})();
