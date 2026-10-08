/**
 * context-v1 lab page — step-line growth + selected-session gauge.
 * Isolated from index.html / classic.html.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const lab = window.ContextLab;
  const LIMIT = 20000;
  if (!lab) {
    console.error("context-lab.js failed to load");
    return;
  }

  const RANGE_KEYS = ["1h", "6h", "12h", "24h"];
  let rangeKey = "6h";
  let selectedId = "";
  let groups = [];
  let abort = null;
  let usingMock = false;

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) {
      el.setAttribute(k, String(attrs[k]));
    });
    return el;
  }

  function bindHits(host, tip, hits, getTip) {
    if (!host || !tip || !hits.length) return;
    function show(hit, cx, cy) {
      host.classList.add("is-hovering");
      hits.forEach(function (el) { el.classList.toggle("is-on", el === hit); });
      const t = getTip(hit);
      tip.innerHTML = "<b>" + t.title + "</b><br/>" + t.meta;
      const rect = host.getBoundingClientRect();
      tip.style.left = (cx - rect.left) + "px";
      tip.style.top = (cy - rect.top) + "px";
      tip.classList.add("is-on");
    }
    function hide() {
      host.classList.remove("is-hovering");
      hits.forEach(function (el) { el.classList.remove("is-on"); });
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
        const id = hit.getAttribute("data-id");
        if (id) selectSession(id);
      });
    });
  }

  function defaultSelected(list) {
    if (!list.length) return "";
    let best = list[0];
    list.forEach(function (g) {
      if ((g.last && g.last.tokens) > (best.last && best.last.tokens || 0)) best = g;
    });
    return best.id;
  }

  function drawGauge(session) {
    const svg = document.getElementById("ctxGauge");
    const label = document.getElementById("ctxGaugeLabel");
    const meta = document.getElementById("ctxGaugeMeta");
    if (!svg) return;
    svg.replaceChildren();
    const g = lab.gaugeForSession(session);
    const cx = 110;
    const cy = 112;
    const r = 78;
    const onN = g.pct == null ? 0 : Math.max(0, Math.min(37, Math.round((g.pct / 100) * 37)));
    for (let i = 0; i < 52; i++) {
      const a = Math.PI + (i / 51) * Math.PI;
      const on = i < onN;
      const inner = on ? 64 : 66;
      svg.append(svgEl("line", {
        x1: cx + Math.cos(a) * inner,
        y1: cy + Math.sin(a) * inner,
        x2: cx + Math.cos(a) * r,
        y2: cy + Math.sin(a) * r,
        stroke: on ? (session && session.color) || "#3ee089" : "#3a3a3a",
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

  function drawChart(list, selId) {
    const svg = document.getElementById("ctxLabChart");
    if (!svg) return;
    svg.replaceChildren();
    const sel = list.filter(function (g) { return g.id === selId; })[0] || list[0];
    const allPts = [];
    list.forEach(function (g) {
      g.points.forEach(function (p) { allPts.push(p); });
    });
    const t0 = allPts.length ? Math.min.apply(null, allPts.map(function (p) { return p.ts; })) : 0;
    const t1 = allPts.length ? Math.max.apply(null, allPts.map(function (p) { return p.ts; })) : 1;
    const span = Math.max(t1 - t0, 1);
    const ymax = Math.max(1, Math.max.apply(null, allPts.map(function (p) { return p.tokens; })) * 1.08);
    const x = function (ts) { return 44 + ((ts - t0) / span) * 460; };
    const y = function (tok) { return 188 - (tok / ymax) * 160; };
    [1, 2, 3].forEach(function (i) {
      const v = ymax * i / 3;
      const yy = y(v);
      const t = svgEl("text", { x: 36, y: yy + 4, fill: "#6a6a6a", "font-size": 10, "text-anchor": "end" });
      t.textContent = lab.fmtTok(v);
      svg.append(t, svgEl("line", { x1: 44, y1: yy, x2: 504, y2: yy, stroke: "#222" }));
    });
    [0, 0.33, 0.66, 1].forEach(function (f) {
      const ts = t0 + span * f;
      const t = svgEl("text", { x: x(ts), y: 212, fill: "#7a7a7a", "font-size": 11, "text-anchor": "middle" });
      t.textContent = lab.fmtTime(ts);
      svg.append(t);
    });

    const hits = [];
    const ordered = list.slice().sort(function (a, b) {
      if (a.id === (sel && sel.id)) return 1;
      if (b.id === (sel && sel.id)) return -1;
      return 0;
    });
    ordered.forEach(function (g) {
      const primary = sel && g.id === sel.id;
      const grp = svgEl("g", {
        class: "ctx-series chart-hit" + (primary ? " is-primary" : ""),
        "data-id": g.id,
        role: "img",
      });
      const last = g.last || g.points[g.points.length - 1];
      const tip = lab.pointTip(g, last);
      grp.setAttribute("aria-label", tip.title + " · " + tip.meta);
      const d = lab.stepPath(g.points, x, y);
      grp.append(
        svgEl("path", { class: "hit", d: d, fill: "none", stroke: "transparent", "stroke-width": 12, "stroke-linejoin": "round" }),
        svgEl("path", {
          d: d,
          fill: "none",
          stroke: g.color,
          "stroke-width": primary ? 2.2 : 1.2,
          opacity: primary ? 1 : 0.35,
          "stroke-linejoin": "round",
        })
      );
      if (primary) {
        g.points.forEach(function (p) {
          grp.append(svgEl("circle", {
            class: "hit",
            cx: x(p.ts),
            cy: y(p.tokens),
            r: 8,
            fill: "transparent",
            "data-ts": p.ts,
          }));
        });
      }
      if (last) {
        grp.append(svgEl("circle", {
          cx: x(last.ts),
          cy: y(last.tokens),
          r: primary ? 3.4 : 2,
          fill: g.color,
        }));
      }
      g.compactions.forEach(function (c) {
        const mx = x(c.ts);
        const my = y(c.to);
        grp.append(svgEl("path", {
          d: "M" + (mx - 5) + " " + (my - 11) + " L" + (mx + 5) + " " + (my - 11) + " L" + mx + " " + (my - 3) + " Z",
          fill: "#3ee089",
          stroke: "#111",
          "stroke-width": 1,
        }));
      });
      g.errors.forEach(function (e) {
        const near = g.points.reduce(function (best, p) {
          return Math.abs(p.ts - e.ts) < Math.abs(best.ts - e.ts) ? p : best;
        }, g.points[0]);
        const ex = x(Math.min(Math.max(e.ts, t0), t1));
        const ey = y(near.tokens);
        const xmark = svgEl("g", { stroke: "#ef4444", "stroke-width": 2 });
        xmark.append(
          svgEl("line", { x1: ex - 4, y1: ey - 4, x2: ex + 4, y2: ey + 4 }),
          svgEl("line", { x1: ex - 4, y1: ey + 4, x2: ex + 4, y2: ey - 4 })
        );
        grp.append(xmark);
      });
      svg.append(grp);
      hits.push(grp);
    });

    bindHits(svg, document.getElementById("ctxLabTip"), hits, function (el) {
      const g = list.filter(function (s) { return s.id === el.getAttribute("data-id"); })[0];
      return lab.pointTip(g, g && g.last);
    });
    drawGauge(sel);
    document.getElementById("kpiSess").textContent = String(list.length);
    document.getElementById("kpiTok").textContent = sel && sel.last ? lab.fmtTok(sel.last.tokens) : "—";
    const drops = list.reduce(function (n, g) { return n + g.compactions.length; }, 0);
    document.getElementById("kpiDrop").textContent = String(drops);
  }

  function drawLegend(list, selId) {
    const root = document.getElementById("ctxLegend");
    if (!root) return;
    root.innerHTML = list.map(function (g) {
      const on = g.id === selId ? " is-on" : "";
      return "<button type=\"button\" class=\"" + on + "\" data-id=\"" + g.id + "\" aria-selected=\"" + (g.id === selId) + "\">" +
        "<i style=\"background:" + g.color + "\"></i>" + g.label + "</button>";
    }).join("");
    root.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { selectSession(b.getAttribute("data-id")); });
    });
  }

  function selectSession(id) {
    selectedId = id;
    drawLegend(groups, selectedId);
    drawChart(groups, selectedId);
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
    document.getElementById("ctxSub").textContent =
      rangeKey + " · step line · selected vs loaded ctx";
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
      document.getElementById("ctxFoot").textContent = records.length + " rows from /api/recent";
    } catch (err) {
      if (err && err.name === "AbortError") return;
      usingMock = true;
      records = lab.mockRecords(now);
      setChip(false, "mock sessions");
      document.getElementById("ctxFoot").textContent = "Using mock sessions — serve from :8899 for live /api/recent";
    }
    groups = lab.groupConversations(records, { from: win[0], to: win[1], limit: 6 });
    if (usingMock && !groups.length) {
      groups = lab.groupConversations(lab.mockRecords(now), { from: now - 8 * 3600, to: now, limit: 6 });
    }
    selectedId = defaultSelected(groups);
    drawLegend(groups, selectedId);
    drawChart(groups, selectedId);
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
