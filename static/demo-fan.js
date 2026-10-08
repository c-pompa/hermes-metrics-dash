/**
 * fan-v1 lab page — MoA radial fan-out on live /api/recent.
 * Isolated from index.html / classic.html.
 */
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const lab = window.FanLab;
  const LIMIT = 20000;
  const EXCLUDE = "pool_status,host_stats,router_request";
  if (!lab) {
    console.error("fan-lab.js failed to load");
    return;
  }

  const RANGE_KEYS = ["1h", "6h", "12h", "24h"];
  let rangeKey = "6h";
  let filter = "all";
  let turns = [];
  let selected = 0;
  let calls = [];
  let summary = { total: 0, proposers: 0, stuck: 0, held_s: 0 };
  let source = "demo";
  let abort = null;
  let pinned = null;

  function svgEl(name, attrs) {
    const el = document.createElementNS(NS, name);
    Object.keys(attrs || {}).forEach(function (k) {
      el.setAttribute(k, String(attrs[k]));
    });
    return el;
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.classList.remove("is-on"); }, 2400);
  }

  function setChip(mode, msg) {
    const el = document.getElementById("liveChip");
    if (!el) return;
    el.className = mode === "mock" ? "chip" : "chip chip-mint";
    el.innerHTML = "<span class=\"live-dot\"></span> " + (msg || mode);
  }

  function recentUrl(from, to) {
    return "/api/recent?from=" + encodeURIComponent(from) +
      "&to=" + encodeURIComponent(to) +
      "&limit=" + LIMIT +
      "&exclude=" + EXCLUDE;
  }

  async function fetchJson(url, signal) {
    const resp = await fetch(url, { signal: signal });
    if (!resp.ok) throw new Error("http " + resp.status);
    return resp.json();
  }

  function pickBundle() {
    return turns[selected] || turns[0] || null;
  }

  function idleDetail() {
    return "Hover a ray — proposers, tools, and stuck children";
  }

  function showTip(call, clientX, clientY, g) {
    const svg = document.getElementById("fanSvg");
    const tip = document.getElementById("fanTip");
    const detail = document.getElementById("fanDetail");
    if (!svg || !tip) return;
    svg.classList.add("is-hovering");
    svg.querySelectorAll(".fan-hit").forEach(function (el) {
      el.classList.toggle("is-on", el === g);
    });
    const t = lab.fanTip(call, Object.assign({}, summary, {
      aggLabel: (pickBundle() && pickBundle().agg && (pickBundle().agg.model || pickBundle().agg.label)) || "moa",
    }));
    tip.innerHTML = "<b>" + t.title + "</b><br/>" + t.meta;
    const rect = svg.parentElement.getBoundingClientRect();
    tip.style.left = (clientX - rect.left) + "px";
    tip.style.top = (clientY - rect.top) + "px";
    tip.classList.add("is-on");
    if (detail) detail.innerHTML = "<b>" + t.title + "</b> · " + t.meta;
  }

  function hideTip() {
    if (pinned) return;
    const svg = document.getElementById("fanSvg");
    const tip = document.getElementById("fanTip");
    const detail = document.getElementById("fanDetail");
    if (svg) {
      svg.classList.remove("is-hovering");
      svg.querySelectorAll(".fan-hit.is-on").forEach(function (el) { el.classList.remove("is-on"); });
    }
    if (tip) tip.classList.remove("is-on");
    if (detail) detail.textContent = idleDetail();
  }

  function drawTurns() {
    const root = document.getElementById("fanTurns");
    if (!root) return;
    if (turns.length <= 1) {
      root.innerHTML = "";
      return;
    }
    root.innerHTML = turns.slice(0, 8).map(function (b, i) {
      const on = i === selected ? " is-on" : "";
      const stuck = (b.children || []).filter(function (c) { return c.stuck; }).length;
      const label = lab.shortSess(b.title || b.id);
      return "<button type=\"button\" class=\"" + on + "\" data-i=\"" + i + "\" aria-selected=\"" + (i === selected) + "\">" +
        "<i style=\"background:" + (stuck ? "#e8c43a" : "#3ee089") + "\"></i>" + label + "</button>";
    }).join("");
    root.querySelectorAll("button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selected = Number(btn.getAttribute("data-i")) || 0;
        rebuild();
      });
    });
  }

  function draw() {
    const svg = document.getElementById("fanSvg");
    const bundle = pickBundle();
    if (!svg) return;
    svg.replaceChildren();
    pinned = null;
    hideTip();
    const cx = lab.CX;
    const cy = lab.CY;
    const visible = calls.filter(function (c) { return lab.fanMatches(c, filter); });
    if (!visible.length) {
      const empty = svgEl("text", { x: cx, y: cy, fill: "#6a6a6a", "font-size": 13, "text-anchor": "middle" });
      empty.textContent = turns.length ? "no rays in this lens" : "no MoA turns in range";
      svg.append(empty);
    } else {
      visible.forEach(function (c) {
        const x2 = cx + Math.cos(c.angle) * c.len;
        const y2 = cy + Math.sin(c.angle) * c.len;
        const t = lab.fanTip(c, summary);
        const g = svgEl("g", {
          class: "fan-hit" + (c.stuck ? " is-stuck" : c.kind === "moa_ref" ? " is-prop" : ""),
          tabindex: "0",
          role: "img",
          "aria-label": t.title + " · " + t.meta,
        });
        const stroke = c.stuck ? "#e8c43a" : c.kind === "moa_ref" ? "#3ee089" : "#8a8a8a";
        g.append(
          svgEl("line", { class: "hit", x1: cx, y1: cy, x2: x2, y2: y2, stroke: "transparent", "stroke-width": 10 }),
          svgEl("line", {
            class: "ray",
            x1: cx, y1: cy, x2: x2, y2: y2,
            stroke: stroke,
            "stroke-width": c.stuck ? 1.35 : c.kind === "moa_ref" ? 1.5 : 1.05,
            opacity: c.stuck ? 1 : c.kind === "moa_ref" ? 0.9 : 0.55,
          }),
          svgEl("circle", {
            class: "dot",
            cx: x2, cy: y2,
            r: c.stuck ? 2.2 : c.kind === "moa_ref" ? 2 : 1.5,
            fill: c.stuck ? "#e8c43a" : c.kind === "moa_ref" ? "#3ee089" : "#cfcfcf",
          })
        );
        const onMove = function (e) {
          if (pinned && pinned !== g) return;
          showTip(c, e.clientX, e.clientY, g);
        };
        g.addEventListener("pointerenter", onMove);
        g.addEventListener("pointermove", onMove);
        g.addEventListener("pointerleave", function () { if (pinned !== g) hideTip(); });
        g.addEventListener("focus", function () {
          const bb = g.getBoundingClientRect();
          showTip(c, bb.left + bb.width / 2, bb.top, g);
        });
        g.addEventListener("blur", function () { if (pinned !== g) hideTip(); });
        g.addEventListener("click", function (e) {
          e.stopPropagation();
          if (pinned === g) { pinned = null; hideTip(); return; }
          pinned = g;
          showTip(c, e.clientX, e.clientY, g);
        });
        svg.append(g);
      });
    }

    const hubCopy = lab.fanHubCopy(summary);
    const hubTip = lab.fanTip(null, Object.assign({}, summary, {
      aggLabel: (bundle && bundle.agg && (bundle.agg.model || bundle.agg.label)) || "moa",
    }));
    const hub = svgEl("g", {
      class: "fan-hub",
      tabindex: "0",
      role: "img",
      "aria-label": hubTip.title + " · " + hubTip.meta,
    });
    const gold = summary.stuck > 0 ? "#e8c43a" : "#3ee089";
    const t1 = svgEl("text", { x: cx, y: cy - 4, fill: gold, "font-size": 10, "text-anchor": "middle", "font-weight": 650 });
    t1.textContent = hubCopy.top;
    const t2 = svgEl("text", { x: cx, y: cy + 10, fill: gold, "font-size": 10, "text-anchor": "middle", "font-weight": 650 });
    t2.textContent = hubCopy.bot;
    hub.append(
      svgEl("circle", { cx: cx, cy: cy, r: 34, class: "fan-center", fill: "#111", stroke: gold }),
      svgEl("circle", { cx: cx - 10, cy: cy - 14, r: 3, fill: gold }),
      t1,
      t2
    );
    const showHub = function (e) {
      pinned = null;
      svg.classList.remove("is-hovering");
      svg.querySelectorAll(".fan-hit.is-on").forEach(function (el) { el.classList.remove("is-on"); });
      const tip = document.getElementById("fanTip");
      const detail = document.getElementById("fanDetail");
      if (tip) {
        tip.innerHTML = "<b>" + hubTip.title + "</b><br/>" + hubTip.meta;
        const rect = svg.parentElement.getBoundingClientRect();
        const x = e.clientX != null ? e.clientX : hub.getBoundingClientRect().left + 40;
        const y = e.clientY != null ? e.clientY : hub.getBoundingClientRect().top;
        tip.style.left = (x - rect.left) + "px";
        tip.style.top = (y - rect.top) + "px";
        tip.classList.add("is-on");
      }
      if (detail) detail.innerHTML = "<b>" + hubTip.title + "</b> · " + hubTip.meta;
    };
    hub.addEventListener("pointerenter", showHub);
    hub.addEventListener("pointermove", showHub);
    hub.addEventListener("pointerleave", hideTip);
    hub.addEventListener("focus", showHub);
    hub.addEventListener("blur", hideTip);
    svg.append(hub);

    const sess = bundle ? lab.shortSess(bundle.title || bundle.id) : "—";
    document.getElementById("fanSess").textContent = "/ one turn · " + sess;
    document.getElementById("fanN").textContent = String(summary.total);
    document.getElementById("fanStuck").textContent = String(summary.stuck);
    document.getElementById("fanHeld").textContent = lab.fmtDuration(summary.held_s);
    const stuckChip = document.getElementById("stuckChip");
    if (stuckChip) {
      stuckChip.hidden = summary.stuck <= 0;
      stuckChip.textContent = summary.stuck + " never returned";
    }
    const headline = document.getElementById("fanHeadline");
    const sub = document.getElementById("fanSub");
    if (!turns.length) {
      headline.textContent = "No MoA turn in this window";
      sub.textContent = "Idle windows fall back to the last stored run, then to the Widget Lab mock.";
    } else if (summary.stuck) {
      headline.textContent = "One aggregator turn became " + summary.total + " calls";
      sub.textContent = "Proposers close in parallel. " + summary.stuck + " children never returned and held the aggregator open.";
    } else {
      headline.textContent = summary.proposers + " proposers finished in " + lab.fmtDuration(summary.held_s);
      sub.textContent = "No stuck delegate_task children on this turn. Gold rays appear when a child has no subagent_stop and runs past 45s.";
    }
    const capBtn = document.getElementById("fanCap");
    if (capBtn) {
      const what = lab.fanCapWhatIf(calls, 8);
      capBtn.disabled = !what.applicable;
      capBtn.title = what.applicable
        ? "Advisory: drop hung children, wall " + lab.fmtDuration(what.capped_s)
        : "No hung children over the cap of 8";
    }
  }

  function rebuild() {
    const bundle = pickBundle();
    calls = bundle ? lab.fanCalls(bundle, { okCap: lab.OK_RAY_CAP }) : [];
    summary = lab.fanSummary(calls, bundle);
    if (bundle && bundle.agg) {
      summary.aggLabel = bundle.agg.model || bundle.agg.label;
    }
    drawTurns();
    draw();
  }

  function applyRecords(records, mode, note) {
    source = mode;
    turns = lab.fanTurns(records);
    selected = 0;
    setChip(mode, note);
    rebuild();
  }

  async function load() {
    const now = Date.now() / 1000;
    const win = lab.windowForRange(rangeKey, now);
    if (abort) abort.abort();
    abort = new AbortController();
    const signal = abort.signal;
    try {
      const hours = lab.parseRangeToken(rangeKey).hours || 6;
      const payload = await fetchJson(recentUrl(win[0], win[1]), signal);
      let records = Array.isArray(payload.records) ? payload.records : [];
      let found = lab.fanTurns(records);
      let mode = "live";
      let note = "live · :8899";
      if (!found.length) {
        const moa = await fetchJson("/api/moa/summary?hours=" + encodeURIComponent(hours), signal);
        const last = Number(moa && moa.last_run_ts) || 0;
        if (last) {
          const around = await fetchJson(recentUrl(last - 300, last + 300), signal);
          records = Array.isArray(around.records) ? around.records : [];
          found = lab.fanTurns(records, { from: last - 300, to: last + 300 });
          if (found.length) {
            mode = "last";
            note = "live · last MoA";
          }
        }
      }
      if (!found.length) {
        applyRecords(lab.mockRecords(now), "mock", "mock turn");
        document.getElementById("fanFoot").textContent = "No MoA rows in range — Widget Lab mock (190 calls, 14 stuck)";
        return;
      }
      applyRecords(records, mode, note);
      const n = found.length;
      document.getElementById("fanFoot").textContent = mode === "last"
        ? "Last stored MoA run · " + n + " turn" + (n === 1 ? "" : "s") + " · Live ops waterfall is the live pane"
        : n + " MoA turn" + (n === 1 ? "" : "s") + " from /api/recent · " + rangeKey;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      applyRecords(lab.mockRecords(now), "mock", "mock turn");
      document.getElementById("fanFoot").textContent = "Using mock turn — serve from :8899 for live /api/recent";
    }
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
  document.querySelectorAll("[data-fan-filter]").forEach(function (b) {
    b.addEventListener("click", function () {
      filter = b.getAttribute("data-fan-filter") || "all";
      document.querySelectorAll("[data-fan-filter]").forEach(function (x) {
        const on = x === b;
        x.classList.toggle("is-on", on);
        x.setAttribute("aria-selected", String(on));
      });
      pinned = null;
      draw();
    });
  });
  document.getElementById("fanReplay").addEventListener("click", function () {
    const svg = document.getElementById("fanSvg");
    const rays = svg ? svg.querySelectorAll(".fan-hit") : [];
    if (!rays.length) {
      toast("No turn to replay");
      return;
    }
    rays.forEach(function (el, i) {
      el.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 420, delay: Math.min(i * 4, 600), easing: "ease-out", fill: "backwards" }
      );
    });
    toast("Replaying " + lab.shortSess((pickBundle() && pickBundle().id) || "turn"));
  });
  document.getElementById("fanCap").addEventListener("click", function () {
    const what = lab.fanCapWhatIf(calls, 8);
    if (!what.applicable) {
      toast("No hung children over the cap of 8");
      return;
    }
    toast("Advisory: cap at 8 → wall " + lab.fmtDuration(what.capped_s) + " (not written to config)");
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
