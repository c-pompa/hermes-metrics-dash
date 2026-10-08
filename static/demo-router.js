/**
 * router-v1 lab page — live family sankey + role usage bars.
 * Isolated from index.html / classic.html.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const lab = window.RouterLab;
  const LIMIT = 20000;
  if (!lab) {
    console.error("router-lab.js failed to load");
    return;
  }

  const RANGE_KEYS = ["1h", "6h", "12h", "24h"];
  const HOST_KEYS = ["", "mbp", "mini"];

  let rangeKey = "6h";
  let hostKey = "";
  let pin = "";
  let lanes = [];
  let roles = [];
  let status = [];
  let degradations = [];
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

  function rangeFromHash() {
    const raw = location.hash || "#/range=6h";
    const spec = lab.parseRangeToken(raw);
    const host = lab.parseHostToken(raw);
    let key = "6h";
    if (spec.hours === 1) key = "1h";
    else if (spec.hours === 12) key = "12h";
    else if (spec.hours === 24) key = "24h";
    else if (spec.hours === 6) key = "6h";
    else if (spec.hours) key = spec.hours <= 24 ? spec.hours + "h" : "24h";
    return { range: RANGE_KEYS.indexOf(key) >= 0 ? key : "6h", host: host };
  }

  function writeHash(range, host) {
    let h = "#/range=" + range;
    if (host) h += "&host=" + encodeURIComponent(host);
    if (location.hash !== h) history.replaceState(null, "", location.pathname + location.search + h);
  }

  function routingHref(range, host) {
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
    const live = routingHref(rangeKey, hostKey);
    const nav = document.getElementById("navLive");
    const open = document.getElementById("openRouting");
    if (nav) nav.setAttribute("href", live);
    if (open) open.setAttribute("href", live);
  }

  function setChip(ok, msg) {
    const el = document.getElementById("liveChip");
    if (!el) return;
    el.className = ok ? "chip chip-mint" : "chip";
    el.innerHTML = ok
      ? "<span class=\"live-dot\"></span> live · :8899"
      : "<span class=\"live-dot\"></span> " + (msg || "mock");
  }

  function legend() {
    const root = document.getElementById("laneLegend");
    if (!root) return;
    const items = [{ id: "", label: "all", color: "#6a6a6a" }].concat(lanes.map(function (l) {
      return { id: l.id, label: l.id, color: l.color };
    }));
    root.innerHTML = items.map(function (it) {
      const on = it.id === pin ? " is-on" : "";
      return "<button type=\"button\" class=\"" + on + "\" data-id=\"" + it.id + "\" aria-selected=\"" + (it.id === pin) + "\">" +
        "<i class=\"swatch\" style=\"background:" + it.color + "\"></i>" + it.label + "</button>";
    }).join("");
    root.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () {
        const id = b.getAttribute("data-id") || "";
        pin = pin === id ? "" : id;
        redraw();
      });
    });
  }

  function drawSankey() {
    const svg = document.getElementById("sankey");
    if (!svg) return;
    svg.replaceChildren();
    const layout = lab.sankeyLayout(lanes);
    if (!layout.nodes.length) {
      emptyText(svg, 260, 90, "no api records in range");
      return;
    }
    svg.append(svgEl("rect", {
      x: layout.x0 - 3,
      y: layout.leftY,
      width: 4,
      height: Math.max(4, layout.leftH),
      fill: "#cfcfcf",
      rx: 1,
    }));

    const hits = [];
    layout.nodes.forEach(function (node) {
      const lane = lanes.filter(function (l) { return l.id === node.id; })[0];
      const dim = pin && pin !== node.id;
      const grp = svgEl("g", {
        class: "ctx-series flow chart-hit" + (pin && pin === node.id ? " is-pinned" : ""),
        "data-id": node.id,
        role: "img",
      });
      const tip = lab.trafficLaneTip(lane);
      grp.setAttribute("aria-label", tip.title + " · " + tip.meta);
      grp.append(svgEl("path", {
        d: node.d,
        fill: node.color,
        opacity: node.fallback ? 0.95 : (dim ? 0.18 : 0.58),
      }));
      const label = svgEl("text", {
        x: layout.x1 + 12,
        y: node.y + node.h / 2 + 4,
        fill: node.fallback ? "#e8c43a" : "#d0d0d0",
        "font-size": 12,
      });
      label.textContent = node.label;
      grp.append(label);
      const hit = svgEl("path", {
        class: "hit",
        d: node.d,
        fill: "transparent",
        "data-id": node.id,
      });
      grp.append(hit);
      svg.append(grp);
      hits.push(grp);
    });

    bindHits(svg, document.getElementById("sankeyTip"), hits, function (el) {
      const id = el.getAttribute("data-id");
      const lane = lanes.filter(function (l) { return l.id === id; })[0];
      return lab.trafficLaneTip(lane);
    }, function (el) {
      const id = el.getAttribute("data-id") || "";
      pin = pin === id ? "" : id;
      redraw();
    });
  }

  function drawRoles() {
    const svg = document.getElementById("roleChart");
    if (!svg) return;
    svg.replaceChildren();
    const shown = roles;
    const layout = lab.roleBarLayout(shown, { width: 680, rowH: 34, gap: 8, labelW: 168, rightW: 92 });
    const height = Math.max(80, (layout.length ? layout[layout.length - 1].y + layout[layout.length - 1].h : 34) + 8);
    svg.setAttribute("viewBox", "0 0 680 " + height);
    if (!shown.length) {
      emptyText(svg, 340, height / 2, "no routed requests in range");
      return;
    }
    const hits = [];
    layout.forEach(function (bar, i) {
      const row = shown[i];
      const grp = svgEl("g", {
        class: "ctx-series chart-hit",
        "data-i": i,
        role: "img",
      });
      const tip = lab.roleTip(row);
      grp.setAttribute("aria-label", tip.title + " · " + tip.meta);
      grp.append(svgEl("rect", {
        class: "lane-bg",
        x: 0, y: bar.y, width: 680, height: bar.h, rx: 6,
        fill: "transparent",
      }));
      const name = svgEl("text", { x: 8, y: bar.y + bar.h / 2 + 4, fill: "#d4d4d4", "font-size": 11 });
      name.textContent = row.role;
      grp.append(name);
      grp.append(svgEl("rect", {
        x: bar.barX, y: bar.y + 8, width: Math.max(6, bar.barW - 4), height: bar.h - 16, rx: 5,
        fill: bar.color, opacity: 0.7,
      }));
      const n = svgEl("text", {
        x: 672, y: bar.y + bar.h / 2 + 4,
        fill: "#c8c8c8", "font-size": 11, class: "tabular", "text-anchor": "end",
      });
      n.textContent = row.requests + " · " + lab.fmtPct(row.share);
      grp.append(n);
      const hit = svgEl("rect", {
        class: "hit",
        x: 0, y: bar.y, width: 680, height: bar.h,
        fill: "transparent",
        "data-i": i,
      });
      grp.append(hit);
      svg.append(grp);
      hits.push(grp);
    });
    bindHits(svg, document.getElementById("roleTip"), hits, function (el) {
      return lab.roleTip(shown[Number(el.getAttribute("data-i"))]);
    });
  }

  function drawStatus() {
    const root = document.getElementById("statusRoles");
    if (!root) return;
    if (!status.length) {
      root.innerHTML = "<div class=\"empty\">router status unavailable</div>";
      return;
    }
    root.innerHTML = "<table><thead><tr><th>role</th><th>live model</th></tr></thead><tbody>" +
      status.map(function (r) {
        const live = r.resolved
          ? "<span class=\"chip\"><i class=\"swatch\" style=\"background:" + (lab.LANE_STYLE[r.lane] || lab.LANE_STYLE.other).color + "\"></i>" + r.model + "</span>"
          : "<span class=\"muted\">offline" + (r.strict ? " — voice skipped (strict)" : " — falls back") + "</span>";
        return "<tr><td><code>" + r.role + "</code>" + (r.strict ? " <span class=\"feed-meta\">strict</span>" : "") + "</td><td>" + live + "</td></tr>";
      }).join("") + "</tbody></table>";
  }

  function drawDeg() {
    const root = document.getElementById("roleDeg");
    if (!root) return;
    if (!degradations.length) {
      root.innerHTML = "";
      return;
    }
    root.innerHTML = "<div class=\"feed-meta\">recent degradations (503 / fallthrough / retry)</div>" +
      degradations.slice(-8).reverse().map(function (d) {
        return "<div>" + (d.ts || "") + " · <code>" + (d.role || "") + "</code> · " +
          (d.status || "") + " " + (d.reason || "") +
          (d.model ? " → " + lab.shortModelName(d.model) : "") + "</div>";
      }).join("");
  }

  function redraw() {
    legend();
    drawSankey();
    drawRoles();
    drawStatus();
    drawDeg();
  }

  function applyKpis(kpis, insight) {
    document.getElementById("routerN").textContent = String(kpis.requests);
    document.getElementById("routerSub").textContent =
      "requests / " + rangeKey + (hostKey ? " · " + hostKey : "");
    document.getElementById("routerTrend").textContent = insight;
    document.getElementById("routerTrend").style.color = kpis.nvidiaShare >= 0.1 ? "#e8c43a" : "#3ee089";
    document.getElementById("kpiTop").textContent = kpis.topId ? lab.fmtPct(kpis.topShare) : "—";
    document.getElementById("kpiTopLabel").textContent = kpis.topId ? "landed on " + kpis.topId : "top lane";
    document.getElementById("kpiCost").textContent = lab.fmtCost(kpis.blended);
    document.getElementById("kpiNv").textContent = lab.fmtPct(kpis.nvidiaShare);
  }

  async function load() {
    const now = Date.now() / 1000;
    const win = lab.windowForRange(rangeKey, now);
    const hours = Math.max((win[1] - win[0]) / 3600, 1 / 60);
    document.getElementById("roleSub").textContent = rangeKey + " · router execution log";
    if (abort) abort.abort();
    abort = new AbortController();
    const recentUrl = "/api/recent?from=" + encodeURIComponent(win[0]) +
      "&to=" + encodeURIComponent(win[1]) +
      "&limit=" + LIMIT +
      "&exclude=pool_status,host_stats";
    const usageUrl = "/api/router-usage?since_h=" + encodeURIComponent(Math.min(hours, 24 * 30));
    usingMock = false;
    let records = [];
    let usage = { roles: {}, degradations: [] };
    let statusPayload = null;
    try {
      const resp = await fetch(recentUrl, { signal: abort.signal });
      if (!resp.ok) throw new Error("history " + resp.status);
      const payload = await resp.json();
      records = Array.isArray(payload.records) ? payload.records : [];
      setChip(true);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      usingMock = true;
      records = lab.mockRecords(now);
      setChip(false, "mock lanes");
    }
    try {
      const resp = await fetch(usageUrl, { signal: abort.signal });
      if (resp.ok) usage = await resp.json();
      else if (usingMock) usage = lab.mockUsage();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (usingMock) usage = lab.mockUsage();
    }
    try {
      const resp = await fetch("/api/router-status", { signal: abort.signal });
      if (resp.ok) statusPayload = await resp.json();
      else if (usingMock) statusPayload = lab.mockStatus();
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (usingMock) statusPayload = lab.mockStatus();
    }

    lanes = lab.trafficLanes(records, { from: win[0], to: win[1], host: hostKey });
    if (usingMock && !lanes.length) {
      records = lab.mockRecords(now);
      lanes = lab.trafficLanes(records);
    }
    const kpis = lab.routerKpis(lanes, records, { from: win[0], to: win[1], host: hostKey });
    applyKpis(kpis, lab.routerInsight(lanes));
    roles = lab.roleRows(usage);
    degradations = Array.isArray(usage.degradations) ? usage.degradations : [];
    status = lab.statusRoles(statusPayload);
    if (pin && !lanes.some(function (l) { return l.id === pin; })) pin = "";
    const truncated = records.length >= LIMIT ? " · hit " + LIMIT + " row cap" : "";
    document.getElementById("routerFoot").textContent = usingMock
      ? "Using mock lanes — serve from :8899 for live /api/recent"
      : records.length + " rows from /api/recent" + truncated;
    document.getElementById("roleFoot").textContent = roles.length
      ? roles.length + " roles · " + degradations.length + " degradations"
      : (usingMock ? "mock role log" : "no routed requests in this window");
    redraw();
  }

  function markNav(id) {
    document.querySelectorAll("[data-jump]").forEach(function (a) {
      a.classList.toggle("is-active", a.getAttribute("data-jump") === id);
    });
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
    const st = rangeFromHash();
    applyState(st.range, st.host, true);
  });

  const initial = rangeFromHash();
  if (!location.hash) writeHash(initial.range, initial.host);
  applyState(initial.range, initial.host, true);
})();
