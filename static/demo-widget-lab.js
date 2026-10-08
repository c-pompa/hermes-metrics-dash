(() => {
  const NS = "http://www.w3.org/2000/svg";
  const mint = "#3ee089";
  const gold = "#e8c43a";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function svgEl(name, attrs = {}) {
    const el = document.createElementNS(NS, name);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, String(v)));
    return el;
  }

  function hatchDefs(svg, id = "hatch", color = "#3a3a3a") {
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = svgEl("defs");
      svg.prepend(defs);
    }
    const p = svgEl("pattern", {
      id,
      width: 6,
      height: 6,
      patternUnits: "userSpaceOnUse",
      patternTransform: "rotate(45)",
    });
    p.append(svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: color, "stroke-width": 1.6 }));
    defs.append(p);
    return defs;
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("is-on");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("is-on"), 2400);
  }

  document.querySelectorAll("[data-toast]").forEach((btn) => {
    btn.addEventListener("click", () => toast(btn.dataset.toast));
  });

  document.getElementById("copySnippet")?.addEventListener("click", async () => {
    const text = document.getElementById("snippet").innerText;
    try {
      await navigator.clipboard.writeText(text);
      toast("Snippet copied");
    } catch {
      toast("Copy failed — select the snippet manually");
    }
  });

  function bindChartTip(host, tip, hits, getTip, isolateEl) {
    if (!host || !tip || !hits.length) return { clearPin() {} };
    const dim = isolateEl || host;
    let pinned = null;
    function show(hit, clientX, clientY) {
      dim.classList.add("is-hovering");
      hits.forEach((el) => el.classList.toggle("is-on", el === hit));
      const t = getTip(hit);
      tip.innerHTML = `<b>${t.title}</b><br/>${t.meta}`;
      const rect = host.getBoundingClientRect();
      tip.style.left = `${clientX - rect.left}px`;
      tip.style.top = `${clientY - rect.top}px`;
      tip.classList.add("is-on");
    }
    function hide() {
      if (pinned) return;
      dim.classList.remove("is-hovering");
      hits.forEach((el) => el.classList.remove("is-on"));
      tip.classList.remove("is-on");
    }
    hits.forEach((hit) => {
      if (!hit.hasAttribute("tabindex")) hit.setAttribute("tabindex", "0");
      const move = (e) => {
        if (pinned && pinned !== hit) return;
        show(hit, e.clientX, e.clientY);
      };
      hit.addEventListener("pointerenter", move);
      hit.addEventListener("pointermove", move);
      hit.addEventListener("pointerleave", () => {
        if (pinned !== hit) hide();
      });
      hit.addEventListener("focus", () => {
        const bb = hit.getBoundingClientRect();
        show(hit, bb.left + bb.width / 2, bb.top);
      });
      hit.addEventListener("blur", () => {
        if (pinned !== hit) hide();
      });
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pinned === hit) {
          pinned = null;
          hide();
          return;
        }
        pinned = hit;
        show(hit, e.clientX, e.clientY);
      });
    });
    return {
      clearPin() {
        pinned = null;
        hide();
      },
    };
  }

  const lab = window.HermesWidgetLab;
  if (!lab) {
    console.error("widget-lab-hermes.js failed to load");
    return;
  }

  (function ingestWidget() {
    const hour = lab.ingestHour();
    const feed = lab.ingestFeed();
    const spark = document.getElementById("ingestSpark");
    const list = document.getElementById("ingestFeed");
    if (spark) {
      const max = Math.max.apply(null, hour.spark);
      const w = 420 / hour.spark.length;
      const hits = [];
      hour.spark.forEach((v, i) => {
        const h = (v / max) * 52;
        const bar = svgEl("rect", {
          class: "chart-hit",
          x: 8 + i * w,
          y: 62 - h,
          width: w * 0.55,
          height: Math.max(h, 2),
          rx: 2,
          fill: i === hour.spark.length - 1 ? mint : "rgba(62,224,137,0.45)",
          "data-i": i,
          role: "img",
        });
        const t = lab.ingestSparkTip(hour, i);
        bar.setAttribute("aria-label", t.title + " · " + t.meta);
        spark.append(bar);
        hits.push(bar);
      });
      bindChartTip(spark.parentElement, document.getElementById("ingestTip"), hits, (el) => {
        return lab.ingestSparkTip(hour, Number(el.getAttribute("data-i")));
      }, spark);
    }
    if (list) {
      list.innerHTML = feed.map((r) => {
        const kindClass = r.kind === "error" ? "kind-err" : r.kind === "moa_turn" ? "kind-moa" : "kind-api";
        const tps = lab.ingestFmtTps(r.tps);
        return `<div class="ingest-row">
          <span class="dim">${r.ts}</span>
          <span class="${kindClass}">${r.kind === "moa_turn" ? "moa" : r.kind}</span>
          <span><b>${r.model}</b> <span class="dim">${r.host}</span></span>
          <span class="tabular dim">${r.duration_s.toFixed(1)}s</span>
          <span class="tabular">${r.kind === "error" ? "fail" : tps + " t/s"}</span>
        </div>`;
      }).join("");
    }
    const req = document.getElementById("ingestReq");
    const tpsEl = document.getElementById("ingestTps");
    const tok = document.getElementById("ingestTok");
    if (req) req.textContent = String(hour.requests);
    if (tpsEl) tpsEl.textContent = lab.ingestFmtTps(hour.avgTps);
    if (tok) tok.textContent = lab.ingestFmtTok(hour.tokens);

    function showIngest(id) {
      document.querySelectorAll("[data-ingest-tab]").forEach((x) => {
        const on = x.dataset.ingestTab === id;
        x.classList.toggle("is-on", on);
        x.setAttribute("aria-selected", on);
      });
      const empty = document.getElementById("ingestEmpty");
      const live = document.getElementById("ingestLive");
      if (empty) empty.hidden = id !== "empty";
      if (live) live.hidden = id !== "live";
      const title = document.getElementById("ingestTitle");
      const sub = document.getElementById("ingestSub");
      const chip = document.getElementById("ingestChip");
      if (id === "live") {
        if (title) title.textContent = "Live ingest";
        if (sub) sub.textContent = `last hour · ${hour.requests} api records · WS /events`;
        if (chip) {
          chip.className = "chip chip-mint";
          chip.innerHTML = `<span class="live-dot"></span> live · mini:8899`;
        }
      } else {
        if (title) title.textContent = "No api records";
        if (sub) sub.textContent = "last hour · metrics-dashboard";
        if (chip) {
          chip.className = "chip muted-chip";
          chip.textContent = "hooks not wired";
        }
      }
    }
    document.querySelectorAll("[data-ingest-tab]").forEach((b) => {
      b.addEventListener("click", () => showIngest(b.dataset.ingestTab));
    });
  })();

  function currentFilter() {
    return document.querySelector(".filter.is-on")?.dataset.filter || "all";
  }

  function applyFilter(f) {
    document.querySelectorAll(".filter").forEach((b) => b.classList.toggle("is-on", b.dataset.filter === f));
    document.querySelectorAll(".stage").forEach((s) => {
      s.style.display = lab.stageMatchesFilter(f, s.dataset.kind) ? "" : "none";
    });
  }

  document.querySelectorAll(".filter").forEach((btn) => {
    btn.addEventListener("click", () => applyFilter(btn.dataset.filter));
  });

  const links = [...document.querySelectorAll(".nav a")];
  const stages = links.map((a) => document.querySelector(a.getAttribute("href")));
  links.forEach((a) => {
    a.addEventListener("click", () => {
      const stage = document.querySelector(a.getAttribute("href"));
      if (!stage) return;
      if (!lab.stageMatchesFilter(currentFilter(), stage.dataset.kind)) {
        applyFilter("all");
      }
    });
  });
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        if (getComputedStyle(e.target).display === "none") return;
        links.forEach((l) => l.classList.toggle("is-active", l.getAttribute("href") === `#${e.target.id}`));
      });
    },
    { rootMargin: "-40% 0px -50% 0px" }
  );
  stages.forEach((s) => s && io.observe(s));

  /* Findings (Eval adapted) */
  (function findingsWidget() {
    const svg = document.getElementById("evalSpark");
    const tbody = document.querySelector("#evalTable tbody");
    if (!svg || !tbody) return;
    hatchDefs(svg, "hatchFail", "#4a4a4a");
    const runs = lab.findingsSpark();
    const w = 420 / runs.length;
    const hits = [];
    runs.forEach((r, i) => {
      const h = r * 90;
      const x = i * w + 8;
      const bar = svgEl("rect", {
        class: "chart-hit",
        x,
        y: 100 - h,
        width: w * 0.55,
        height: h,
        fill: i === runs.length - 1 ? mint : "url(#hatchFail)",
        rx: 2,
        opacity: i === runs.length - 1 ? 1 : 0.85,
        "data-i": i,
        role: "img",
      });
      const t = lab.findingsSparkTip(i, runs);
      bar.setAttribute("aria-label", t.title + " · " + t.meta);
      svg.append(bar);
      hits.push(bar);
    });
    const line = runs
      .map((r, i) => `${i ? "L" : "M"}${i * w + 18},${100 - r * 90}`)
      .join(" ");
    svg.append(svgEl("path", { d: line, fill: "none", stroke: "#d8d8d8", "stroke-width": 1.4 }));
    svg.append(svgEl("line", { x1: 0, y1: 100 - 0.9 * 90, x2: 420, y2: 100 - 0.9 * 90, stroke: "#555", "stroke-dasharray": "3 3" }));
    bindChartTip(svg.parentElement, document.getElementById("evalTip"), hits, (el) => {
      return lab.findingsSparkTip(Number(el.getAttribute("data-i")), runs);
    }, svg);

    tbody.innerHTML = lab.findingsRules()
      .map((row) => {
        const on = Math.round(row.pass * 16);
        const segs = Array.from({ length: 16 }, (_, i) => `<i class="${i < on ? "" : "off"}"></i>`).join("");
        const dClass = row.delta.startsWith("−") || row.delta.startsWith("-") ? "delta-neg" : row.delta === "—" ? "" : "delta-pos";
        return `<tr>
          <td style="font-family:var(--mono);font-size:12px">${row.rule} · ${row.name}</td>
          <td><span class="tag tag-${row.cls}">${row.type}</span></td>
          <td><div style="display:flex;align-items:center;gap:8px"><div class="bar-track">${segs}</div><span class="tabular">${Math.round(row.pass * 100)}%</span></div></td>
          <td class="${dClass} tabular">${row.delta}</td>
        </tr>`;
      })
      .join("");

    document.querySelectorAll("[data-eval-tab]").forEach((b) => {
      b.addEventListener("click", () => showEvalTab(b.dataset.evalTab));
    });
    document.getElementById("openFailed")?.addEventListener("click", () => {
      showEvalTab("cases");
      toast("5 firing findings");
    });

    const caseList = document.getElementById("caseList");
    if (caseList) {
      caseList.innerHTML = lab.FAILED_FINDINGS.map(
        (c) => `<div class="case-row"><b>${c.id}</b><span>${c.note}</span><span class="chip">${c.eval}</span></div>`
      ).join("");
    }
    const diffGrid = document.getElementById("evalDiffGrid");
    if (diffGrid) {
      diffGrid.innerHTML = [
        ["Lane", "flash-first", "pro share 6% · climbing"],
        ["Avg tok/s", "flash 38.2", "pro 22.4 · harder turns"],
        ["Error rate", "1.1%", "4.8% · nvidia timeouts"],
        ["Cost / 1k out", "$0.0021", "$0.018 · 8.6×"],
        ["Holds without pro", "61%", "should stay ≥ 70%"],
      ]
        .map(
          ([k, a, b]) =>
            `<div class="diff-row"><b>${k}</b><span>${a}</span><span>${b}</span></div>`
        )
        .join("");
    }

    function showEvalTab(id) {
      document.querySelectorAll("[data-eval-tab]").forEach((x) => {
        const on = x.dataset.evalTab === id;
        x.classList.toggle("is-on", on);
        x.setAttribute("aria-selected", on);
      });
      ["summary", "cases", "diff"].forEach((pane) => {
        const el = document.getElementById(`eval${pane[0].toUpperCase()}${pane.slice(1)}`);
        if (el) el.hidden = pane !== id;
      });
    }
  })();

  /* MoA fan-out */
  (function fanOut() {
    const svg = document.getElementById("fanSvg");
    const tip = document.getElementById("fanTip");
    const detail = document.getElementById("fanDetail");
    if (!svg || !tip) return;
    const cx = 260;
    const cy = 142;
    const calls = lab.fanOutCalls();
    const idleDetail = detail ? detail.innerHTML : "";
    let pinned = null;

    function tipHtml(call) {
      const t = lab.fanOutTip(call);
      return `<b>${t.title}</b><br/>${t.meta}`;
    }

    function showTip(call, clientX, clientY, g) {
      svg.classList.add("is-hovering");
      svg.querySelectorAll(".fan-hit").forEach((el) => el.classList.toggle("is-on", el === g));
      tip.innerHTML = tipHtml(call);
      const rect = svg.parentElement.getBoundingClientRect();
      tip.style.left = `${clientX - rect.left}px`;
      tip.style.top = `${clientY - rect.top}px`;
      tip.classList.add("is-on");
      const t = lab.fanOutTip(call);
      if (detail) detail.innerHTML = `<b>${t.title}</b> · ${t.meta}`;
    }

    function hideTip() {
      if (pinned) return;
      svg.classList.remove("is-hovering");
      svg.querySelectorAll(".fan-hit.is-on").forEach((el) => el.classList.remove("is-on"));
      tip.classList.remove("is-on");
      if (detail) detail.innerHTML = idleDetail;
    }

    calls.forEach((c) => {
      const x2 = cx + Math.cos(c.angle) * c.len;
      const y2 = cy + Math.sin(c.angle) * c.len;
      const hot = c.stuck;
      const proposer = c.kind === "moa_ref";
      const t = lab.fanOutTip(c);
      const g = svgEl("g", {
        class: "fan-hit" + (hot ? " is-stuck" : proposer ? " is-prop" : ""),
        "data-id": c.id,
        "data-fan": hot ? "stuck" : proposer ? "proposer" : "ok",
        tabindex: "0",
        role: "img",
        "aria-label": t.title + " · " + t.meta,
      });
      const stroke = hot ? gold : proposer ? mint : "#8a8a8a";
      g.append(
        svgEl("line", { class: "hit", x1: cx, y1: cy, x2, y2, stroke: "transparent", "stroke-width": 10 }),
        svgEl("line", {
          class: "ray",
          x1: cx,
          y1: cy,
          x2,
          y2,
          stroke,
          "stroke-width": hot ? 1.35 : proposer ? 1.5 : 1.05,
          opacity: hot ? 1 : proposer ? 0.9 : 0.55,
        }),
        svgEl("circle", {
          class: "dot",
          cx: x2,
          cy: y2,
          r: hot ? 2.2 : proposer ? 2 : 1.5,
          fill: hot ? gold : proposer ? mint : "#cfcfcf",
        })
      );
      const onMove = (e) => {
        if (pinned && pinned !== g) return;
        showTip(c, e.clientX, e.clientY, g);
      };
      g.addEventListener("pointerenter", onMove);
      g.addEventListener("pointermove", onMove);
      g.addEventListener("pointerleave", () => {
        if (pinned !== g) hideTip();
      });
      g.addEventListener("focus", () => {
        const bb = g.getBoundingClientRect();
        showTip(c, bb.left + bb.width / 2, bb.top, g);
      });
      g.addEventListener("blur", () => {
        if (pinned !== g) hideTip();
      });
      g.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pinned === g) {
          pinned = null;
          hideTip();
          return;
        }
        pinned = g;
        showTip(c, e.clientX, e.clientY, g);
      });
      svg.append(g);
    });

    const hubTip = lab.fanOutTip(null);
    const hub = svgEl("g", {
      class: "fan-hub",
      tabindex: "0",
      role: "img",
      "aria-label": hubTip.title + " · " + hubTip.meta,
    });
    const t1 = svgEl("text", { x: cx, y: cy - 4, fill: gold, "font-size": 10, "text-anchor": "middle", "font-weight": 650 });
    t1.textContent = "14 STUCK ON";
    const t2 = svgEl("text", { x: cx, y: cy + 10, fill: gold, "font-size": 10, "text-anchor": "middle", "font-weight": 650 });
    t2.textContent = "web_fetch";
    hub.append(
      svgEl("circle", { cx, cy, r: 34, class: "fan-center", fill: "#111", stroke: gold }),
      svgEl("circle", { cx: cx - 10, cy: cy - 14, r: 3, fill: gold }),
      t1,
      t2
    );
    const showHub = (e) => {
      pinned = null;
      svg.classList.remove("is-hovering");
      svg.querySelectorAll(".fan-hit.is-on").forEach((el) => el.classList.remove("is-on"));
      tip.innerHTML = tipHtml(null);
      const rect = svg.parentElement.getBoundingClientRect();
      const x = e.clientX != null ? e.clientX : hub.getBoundingClientRect().left + 40;
      const y = e.clientY != null ? e.clientY : hub.getBoundingClientRect().top;
      tip.style.left = `${x - rect.left}px`;
      tip.style.top = `${y - rect.top}px`;
      tip.classList.add("is-on");
      if (detail) detail.innerHTML = `<b>${hubTip.title}</b> · ${hubTip.meta}`;
    };
    hub.addEventListener("pointerenter", showHub);
    hub.addEventListener("pointermove", showHub);
    hub.addEventListener("pointerleave", hideTip);
    hub.addEventListener("focus", showHub);
    hub.addEventListener("blur", hideTip);
    svg.append(hub);

    function applyFilter(f) {
      document.querySelectorAll("#fanFilter [data-fan-filter]").forEach((b) => {
        const on = b.dataset.fanFilter === f;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-selected", on);
      });
      svg.querySelectorAll(".fan-hit").forEach((g) => {
        const kind = g.getAttribute("data-fan");
        g.style.display = f === "all" || kind === f ? "" : "none";
      });
      pinned = null;
      hideTip();
    }
    document.querySelectorAll("#fanFilter [data-fan-filter]").forEach((b) => {
      b.addEventListener("click", () => applyFilter(b.dataset.fanFilter));
    });

    document.getElementById("fanReplay")?.addEventListener("click", () => {
      const hits = [...svg.querySelectorAll(".fan-hit")].filter((g) => g.style.display !== "none");
      if (reduced || typeof gsap === "undefined") {
        toast("Turn 8f2c · 190 calls");
        return;
      }
      gsap.fromTo(hits, { opacity: 0 }, { opacity: 1, stagger: 0.005, duration: 0.45, ease: "power2.out" });
      toast("Replaying turn 8f2c");
    });
  })();

  /* DSv4 sankey */
  (function sankey() {
    const svg = document.getElementById("sankey");
    if (!svg) return;
    const layout = [
      { y: 18, h: 78, color: "#5a5a5a" },
      { y: 102, h: 28, color: "#6a6a6a" },
      { y: 134, h: 12, color: "#7a7a7a" },
      { y: 148, h: 10, color: gold },
    ];
    const flows = lab.routerFlows();
    const x0 = 90;
    const x1 = 340;
    const hits = [];
    flows.forEach((flow, i) => {
      const f = layout[i];
      const y0 = 40 + i * 2;
      const d = `M${x0},${y0 + f.h * 0.15} C ${x0 + 90},${y0 + f.h * 0.15} ${x1 - 90},${f.y} ${x1},${f.y} L${x1},${f.y + f.h} C ${x1 - 90},${f.y + f.h} ${x0 + 90},${y0 + f.h} ${x0},${y0 + f.h} Z`;
      const path = svgEl("path", {
        d,
        fill: f.color,
        opacity: f.color === gold ? 0.95 : 0.55,
        class: "flow chart-hit",
        "data-i": i,
        role: "img",
      });
      const tip = lab.routerFlowTip(flow, 184);
      path.setAttribute("aria-label", tip.title + " · " + tip.meta);
      svg.append(path);
      hits.push(path);
      const t = svgEl("text", { x: x1 + 12, y: f.y + f.h / 2 + 4, fill: f.color === gold ? gold : "#d0d0d0", "font-size": 12 });
      t.textContent = flow.label;
      svg.append(t);
    });
    svg.append(svgEl("rect", { x: x0 - 3, y: 40, width: 4, height: 118, fill: "#cfcfcf", rx: 1 }));
    bindChartTip(svg.parentElement, document.getElementById("sankeyTip"), hits, (el) => {
      return lab.routerFlowTip(flows[Number(el.getAttribute("data-i"))], 184);
    }, svg);
  })();

  /* Request volume */
  function drawRuns(key = "24h") {
    const svg = document.getElementById("runsChart");
    if (!svg) return;
    svg.innerHTML = "";
    hatchDefs(svg, "hatchRun", "#4a4a4a");
    const data = lab.requestVolume(key);
    const max = 800;
    const w = 620 / data.length;
    const peak = lab.peakIndex(data);
    const hits = [];
    data.forEach((v, i) => {
      const esc = lab.errorCount(v, i, peak);
      const completed = Math.max(0, v - esc);
      const hComp = (completed / max) * 170;
      const hEsc = (esc / max) * 170;
      const x = 44 + i * w;
      const barW = Math.max(8, w * 0.55);
      const g = svgEl("g", {
        class: "run-bar chart-hit",
        "data-i": i,
        tabindex: "0",
        role: "img",
      });
      const t = lab.runBarTip(key, i);
      g.setAttribute("aria-label", t.title + " · " + t.meta);
      g.append(
        svgEl("rect", {
          x,
          y: 190 - hComp,
          width: barW,
          height: hComp,
          fill: i === peak ? "#7a7a7a" : "url(#hatchRun)",
          rx: 2,
        }),
        svgEl("rect", {
          x,
          y: 190 - hComp - hEsc,
          width: barW,
          height: Math.max(hEsc, 0),
          fill: mint,
          rx: 2,
        }),
        svgEl("rect", {
          class: "hit",
          x,
          y: 190 - hComp - hEsc,
          width: barW,
          height: Math.max(hComp + hEsc, 8),
          fill: "transparent",
        })
      );
      svg.append(g);
      hits.push(g);
    });
    [0, 200, 400, 600, 800].forEach((n) => {
      const y = 190 - (n / 800) * 170;
      const t = svgEl("text", { x: 36, y: y + 4, fill: "#6a6a6a", "font-size": 10, "text-anchor": "end" });
      t.textContent = n;
      svg.append(t, svgEl("line", { x1: 44, y1: y, x2: 670, y2: y, stroke: "#222" }));
    });
    const labels = key === "24h"
      ? ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00", "NOW"]
      : key === "7d"
        ? ["M", "T", "W", "T", "F", "S", "S"]
        : ["1", "8", "15", "22", "30"];
    labels.forEach((lb, i) => {
      const t = svgEl("text", { x: 44 + (i * 620) / (labels.length - 1), y: 228, fill: "#7a7a7a", "font-size": 11, "text-anchor": "middle" });
      t.textContent = lb;
      svg.append(t);
    });

    bindChartTip(svg.parentElement, document.getElementById("runsTip"), hits, (el) => {
      return lab.runBarTip(key, Number(el.getAttribute("data-i")));
    }, svg);
  }
  drawRuns();
  document.querySelectorAll("#runsRange button").forEach((b) => {
    b.addEventListener("click", () => {
      b.parentElement.querySelectorAll("button").forEach((x) => x.classList.remove("is-on"));
      b.classList.add("is-on");
      drawRuns(b.dataset.range);
    });
  });

  /* Health rules + heatmap */
  (function alerts() {
    const root = document.getElementById("alertRules");
    if (!root) return;
    const rules = lab.alertRules();
    root.innerHTML = rules
      .map((r, i) => {
        const d = r.spark.map((y, j) => `${j ? "L" : "M"}${8 + j * 10},${24 - y}`).join(" ");
        const stroke = r.status === "Firing" ? mint : "#8a8a8a";
        const chip =
          r.status === "Firing" ? "chip-red" : r.status === "Ok" ? "chip-ok" : "muted-chip";
        const tip = lab.alertSparkTip(r);
        return `<div class="alert-row" data-alert-row="${i}" tabindex="0" role="img" aria-label="${tip.title} · ${tip.meta}">
        <div><h4>${r.name}</h4><p>${r.meta}</p></div>
        <svg width="72" height="28" viewBox="0 0 72 28" aria-hidden="true"><path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.4"/></svg>
        <span class="chip ${chip}">${r.status}</span>
        <button class="toggle toggle-mint ${r.on ? "is-on" : ""}" data-alert="${i}" aria-pressed="${r.on}" aria-label="Toggle ${r.name}"><i></i></button>
      </div>`;
      })
      .join("");
    bindChartTip(root.closest(".widget") || root, document.getElementById("alertTip"), [...root.querySelectorAll("[data-alert-row]")], (el) => {
      return lab.alertSparkTip(rules[Number(el.getAttribute("data-alert-row"))]);
    }, root);
    root.querySelectorAll("[data-alert]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        btn.classList.toggle("is-on");
        const on = btn.classList.contains("is-on");
        btn.setAttribute("aria-pressed", on);
        const chip = btn.previousElementSibling;
        if (!on) {
          chip.textContent = "Muted";
          chip.className = "chip muted-chip";
        } else if (btn.dataset.alert === "0") {
          chip.textContent = "Firing";
          chip.className = "chip chip-red";
        } else {
          chip.textContent = "Ok";
          chip.className = "chip chip-ok";
        }
      });
    });

    const heat = document.getElementById("heatmap");
    const cells = lab.heatCells();
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const hits = [];
    days.forEach((d) => {
      const labEl = document.createElement("span");
      labEl.textContent = d;
      heat.append(labEl);
      cells.filter((c) => c.day === d).forEach((c) => {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.tabIndex = 0;
        const g = Math.round(30 + c.v * 180);
        cell.style.background = c.worst ? "#f4f4f4" : `rgb(${20 + c.v * 40}, ${g}, ${70 + c.v * 80})`;
        const t = lab.heatTip(c);
        cell.setAttribute("aria-label", t.title + " · " + t.meta);
        cell._heat = c;
        heat.append(cell);
        hits.push(cell);
      });
    });
    bindChartTip(heat.closest(".panel") || heat, document.getElementById("heatTip"), hits, (el) => {
      return lab.heatTip(el._heat);
    }, heat);
  })();

  /* Duration ceiling */
  (function timeout() {
    const svg = document.getElementById("hist");
    const range = document.getElementById("ceilRange");
    if (!svg || !range) return;
    const bins = lab.durationBins();
    const max = Math.max(...bins);
    function paint(cut) {
      svg.innerHTML = "";
      const hits = [];
      bins.forEach((v, i) => {
        const h = (v / max) * 84;
        const bar = svgEl("rect", {
          class: "chart-hit",
          x: 8 + i * 8.4,
          y: 92 - h,
          width: 6.4,
          height: Math.max(h, 2),
          fill: i >= cut ? gold : "#6a6a6a",
          rx: 1,
          "data-i": i,
          role: "img",
        });
        const t = lab.durationBinTip(bins, i, cut);
        bar.setAttribute("aria-label", t.title + " · " + t.meta);
        svg.append(bar);
        hits.push(bar);
      });
      const x = 8 + cut * 8.4;
      svg.append(svgEl("line", { x1: x, y1: 8, x2: x, y2: 96, stroke: gold, "stroke-width": 1.2 }));
      const ceilTxt = svgEl("text", { x: x + 8, y: 20, fill: gold, "font-size": 11, "font-weight": 650 });
      ceilTxt.textContent = `${cut}s · ceiling`;
      svg.append(ceilTxt);
      const t0 = svgEl("text", { x: 8, y: 108, fill: "#7a7a7a", "font-size": 10 });
      t0.textContent = "0 s";
      const t1 = svgEl("text", { x: 250, y: 108, fill: "#7a7a7a", "font-size": 10 });
      t1.textContent = "10";
      const t2 = svgEl("text", { x: 500, y: 108, fill: "#7a7a7a", "font-size": 10, "text-anchor": "end" });
      t2.textContent = "60 s";
      svg.append(t0, t1, t2);
      bindChartTip(svg.parentElement, document.getElementById("histTip"), hits, (el) => {
        return lab.durationBinTip(bins, Number(el.getAttribute("data-i")), Number(range.value));
      }, svg);
    }
    const ticks = document.querySelector(".ticks");
    ticks.innerHTML = Array.from({ length: 31 }, () => "<i></i>").join("");

    function apply(v) {
      const cut = Number(v);
      paint(cut);
      const pct = lab.cutPercent(bins, cut);
      document.getElementById("cutPct").textContent = `${pct}%`;
      document.getElementById("cutChip").textContent = `${cut} s · ${pct}% would cut`;
      document.getElementById("ceilLabel").textContent = `${cut} s`;
      document.getElementById("savedHrs").textContent = `${lab.savedHours(cut)} h`;
      document.getElementById("setCeil").textContent = `Preview ${cut} s`;
      const showCut = document.getElementById("showCut");
      if (showCut) {
        showCut.textContent = `Show the ${pct}%`;
        showCut.dataset.toast = `Showing ${pct}% of requests past the ceiling`;
      }
      const pctPos = ((cut - 4) / (60 - 4)) * 100;
      document.getElementById("ceilKnob").style.left = `calc(${pctPos}% + 8px)`;
    }
    apply(20);
    range.addEventListener("input", (e) => apply(e.target.value));
    document.getElementById("setCeil").onclick = () => toast(`Advisory only — ${range.value}s is not written to config`);
    document.getElementById("searchToggle").onclick = function () {
      this.classList.toggle("is-on");
      this.setAttribute("aria-pressed", this.classList.contains("is-on"));
    };
  })();

  /* Context gauge + flash/pro dots */
  (function context() {
    const svg = document.getElementById("gauge");
    if (!svg) return;
    const cx = 140;
    const cy = 128;
    const r = 92;
    const parts = lab.ctxParts();
    const used = parts.reduce((a, p) => a + p.tokens, 0);
    let tick = 0;
    let assigned = 0;
    const gaugeHits = [];
    parts.forEach((p, pi) => {
      const n = pi === parts.length - 1 ? 37 - assigned : Math.max(1, Math.round((p.tokens / used) * 37));
      assigned += n;
      const g = svgEl("g", {
        class: "chart-hit",
        "data-i": pi,
        tabindex: "0",
        role: "img",
      });
      const tip = lab.ctxPartTip(p, 128000);
      g.setAttribute("aria-label", tip.title + " · " + tip.meta);
      for (let k = 0; k < n && tick < 37; k++, tick++) {
        const a = Math.PI + (tick / 51) * Math.PI;
        g.append(
          svgEl("line", {
            class: "hit",
            x1: cx + Math.cos(a) * 74,
            y1: cy + Math.sin(a) * 74,
            x2: cx + Math.cos(a) * r,
            y2: cy + Math.sin(a) * r,
            stroke: "transparent",
            "stroke-width": 8,
            "stroke-linecap": "round",
          }),
          svgEl("line", {
            x1: cx + Math.cos(a) * 78,
            y1: cy + Math.sin(a) * 78,
            x2: cx + Math.cos(a) * r,
            y2: cy + Math.sin(a) * r,
            stroke: mint,
            "stroke-width": 3.2,
            "stroke-linecap": "round",
          })
        );
      }
      svg.append(g);
      gaugeHits.push(g);
    });
    for (; tick < 52; tick++) {
      const a = Math.PI + (tick / 51) * Math.PI;
      svg.append(
        svgEl("line", {
          x1: cx + Math.cos(a) * 80,
          y1: cy + Math.sin(a) * 80,
          x2: cx + Math.cos(a) * r,
          y2: cy + Math.sin(a) * r,
          stroke: "#3a3a3a",
          "stroke-width": 3.2,
          "stroke-linecap": "round",
        })
      );
    }
    const z0 = svgEl("text", { x: 48, y: 142, fill: "#6a6a6a", "font-size": 11 });
    z0.textContent = "0";
    const z1 = svgEl("text", { x: 214, y: 142, fill: "#6a6a6a", "font-size": 11 });
    z1.textContent = "128k";
    svg.append(z0, z1);
    bindChartTip(svg.parentElement, document.getElementById("gaugeTip"), gaugeHits, (el) => {
      return lab.ctxPartTip(parts[Number(el.getAttribute("data-i"))], 128000);
    }, svg);

    const partsRoot = document.getElementById("ctxParts");
    if (partsRoot) {
      partsRoot.innerHTML = parts
        .map((p, i) => {
          const t = lab.ctxPartTip(p, 128000);
          return `<div class="chart-hit" data-ctx="${i}" tabindex="0" role="img" aria-label="${t.title} · ${t.meta}"><span><i class="swatch" style="background:${p.color}"></i>${p.label}</span><b class="tabular">${(p.tokens / 1000).toFixed(1)}k</b></div>`;
        })
        .join("");
      bindChartTip(partsRoot.closest(".widget") || partsRoot, document.getElementById("ctxTip"), [...partsRoot.querySelectorAll("[data-ctx]")], (el) => {
        return lab.ctxPartTip(parts[Number(el.getAttribute("data-ctx"))], 128000);
      }, partsRoot);
    }

    const dots = document.getElementById("deltaDots");
    const series = lab.h2hDots();
    const hits = [];
    series.forEach((d) => {
      const g = svgEl("g", {
        class: "chart-hit",
        "data-i": d.i,
        tabindex: "0",
        role: "img",
      });
      const t = lab.h2hDotTip(d);
      g.setAttribute("aria-label", t.title + " · " + t.meta);
      g.append(
        svgEl("circle", { class: "hit", cx: d.x, cy: d.y, r: 8, fill: "transparent" }),
        svgEl("circle", {
          cx: d.x,
          cy: d.y,
          r: d.worst ? 3.2 : 1.7,
          fill: d.worst ? gold : d.win ? mint : "#5a5a5a",
          opacity: 0.9,
        })
      );
      dots.append(g);
      hits.push(g);
    });
    dots.append(svgEl("line", { x1: 180, y1: 8, x2: 180, y2: 110, stroke: mint, "stroke-width": 1.5 }));
    const a = svgEl("text", { x: 8, y: 118, fill: "#6a6a6a", "font-size": 10 });
    a.textContent = "flash faster";
    const b = svgEl("text", { x: 352, y: 118, fill: "#6a6a6a", "font-size": 10, "text-anchor": "end" });
    b.textContent = "needed pro";
    dots.append(a, b);
    bindChartTip(dots.parentElement, document.getElementById("deltaTip"), hits, (el) => {
      return lab.h2hDotTip(series[Number(el.getAttribute("data-i"))]);
    }, dots);
  })();

  /* Tool graph */
  (function graph() {
    const svg = document.getElementById("graphSvg");
    if (!svg) return;

    function drawGraph(mode) {
      svg.replaceChildren();
      const tools = lab.graphView(mode);
      const ys = [28, 78, 128, 178, 228];
      const sx = 130;
      const sy = 140;
      svg.append(svgEl("rect", { x: 40, y: 112, width: 160, height: 56, rx: 12, fill: "#151515", stroke: mint }));
      const s1 = svgEl("text", { x: 56, y: 134, fill: "#fff", "font-size": 13, "font-family": "IBM Plex Mono, monospace" });
      s1.textContent = "dialectic · flash";
      const s2 = svgEl("text", { x: 56, y: 152, fill: "#8a8a8a", "font-size": 11 });
      s2.textContent = "role · 3.1k req";
      svg.append(s1, s2);
      const hits = [];
      tools.forEach((t, i) => {
        const y = ys[i];
        const d = `M${sx + 70},${sy} C 250,${sy} 280,${y + 22} 330,${y + 22}`;
        const g = svgEl("g", {
          class: "chart-hit",
          "data-i": i,
          tabindex: "0",
          role: "img",
        });
        const tip = lab.graphNodeTip(t, mode);
        g.setAttribute("aria-label", tip.title + " · " + tip.meta);
        g.append(
          svgEl("path", { class: "hit", d, fill: "none", stroke: "transparent", "stroke-width": 12 }),
          svgEl("path", {
            class: "edge",
            d,
            fill: "none",
            stroke: t.hot ? mint : "#4a4a4a",
            "stroke-width": t.hot ? 2 : 1.4,
            "stroke-dasharray": t.hot ? "5 4" : "0",
          }),
          svgEl("rect", { x: 330, y, width: 310, height: 44, rx: 12, fill: "#151515", stroke: t.hot ? mint : "#2a2a2a" }),
          svgEl("circle", { cx: 348, cy: y + 22, r: 4, fill: t.hot ? mint : "#6a6a6a" })
        );
        const n = svgEl("text", { x: 360, y: y + 18, fill: "#fff", "font-size": 13, "font-family": "IBM Plex Mono, monospace" });
        n.textContent = t.name;
        const m = svgEl("text", { x: 360, y: y + 34, fill: "#8a8a8a", "font-size": 11 });
        m.textContent = t.meta;
        g.append(n, m);
        g.append(svgEl("rect", { x: 548, y: y + 12, width: 78, height: 20, rx: 8, fill: t.hot ? "rgba(62,224,137,0.12)" : "#1a1a1a", stroke: t.hot ? mint : "#333" }));
        const bt = svgEl("text", { x: 587, y: y + 26, fill: t.hot ? mint : "#8a8a8a", "font-size": 10, "text-anchor": "middle" });
        bt.textContent = t.badge;
        g.append(bt);
        svg.append(g);
        hits.push(g);
      });
      bindChartTip(svg.parentElement, document.getElementById("graphTip"), hits, (el) => {
        return lab.graphNodeTip(tools[Number(el.getAttribute("data-i"))], mode);
      }, svg);
    }

    drawGraph("calls");
    document.querySelectorAll("#graphTabs [data-graph-tab]").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#graphTabs [data-graph-tab]").forEach((x) => {
          const on = x === b;
          x.classList.toggle("is-on", on);
          x.setAttribute("aria-selected", on);
        });
        drawGraph(b.dataset.graphTab);
      });
    });
  })();

  /* Cost + errors */
  (function cost() {
    const svg = document.getElementById("costChart");
    if (!svg) return;
    hatchDefs(svg, "hatchCost", "#5a5a5a");
    const stacks = lab.costStacks();
    const costHits = [];
    stacks.forEach((row, i) => {
      const x = 28 + i * 42;
      let y = 128;
      const colors = row.highlight ? [mint, mint, mint] : ["#6a6a6a", "url(#hatchCost)", "#3a3a3a"];
      const g = svgEl("g", {
        class: "chart-hit",
        "data-i": i,
        tabindex: "0",
        role: "img",
      });
      const tip = lab.costDayTip(row);
      g.setAttribute("aria-label", tip.title + " · " + tip.meta);
      row.layers.forEach((h, j) => {
        if (!h) return;
        y -= h;
        g.append(svgEl("rect", { x, y, width: 22, height: h, fill: colors[j], rx: j === 2 || (row.highlight && j === 0) ? 3 : 0 }));
      });
      const t = svgEl("text", { x: x + 11, y: 146, fill: "#7a7a7a", "font-size": 10, "text-anchor": "middle" });
      t.textContent = row.day;
      g.append(t);
      svg.append(g);
      costHits.push(g);
    });
    bindChartTip(svg.parentElement, document.getElementById("costTip"), costHits, (el) => {
      return lab.costDayTip(stacks[Number(el.getAttribute("data-i"))]);
    }, svg);

    const err = document.getElementById("errorChart");
    const steps = lab.errorSteps();
    const coords = steps.map((v, i) => [12 + i * 25, 120 - v * 1.7]);
    let d = `M${coords[0][0]},${coords[0][1]}`;
    coords.forEach((p, i) => {
      if (!i) return;
      d += ` H${p[0]} V${p[1]}`;
    });
    err.append(
      svgEl("rect", { x: 150, y: 12, width: 70, height: 100, fill: mint, opacity: 0.12 }),
      svgEl("line", { x1: 12, y1: 70, x2: 350, y2: 70, stroke: mint, "stroke-dasharray": "4 4" }),
      svgEl("path", { d, fill: "none", stroke: "#e8e8e8", "stroke-width": 1.6 })
    );
    const errHits = [];
    coords.forEach((p, i) => {
      const g = svgEl("g", {
        class: "chart-hit",
        "data-i": i,
        tabindex: "0",
        role: "img",
      });
      const t = lab.errorStepTip(i, steps);
      g.setAttribute("aria-label", t.title + " · " + t.meta);
      g.append(
        svgEl("circle", { class: "hit", cx: p[0], cy: p[1], r: 9, fill: "transparent" }),
        svgEl("circle", { cx: p[0], cy: p[1], r: i === 6 ? 4 : 3, fill: i === 6 ? mint : "#e8e8e8" })
      );
      err.append(g);
      errHits.push(g);
    });
    const al = svgEl("text", { x: 16, y: 66, fill: mint, "font-size": 10 });
    al.textContent = "alert > 2%";
    err.append(al);
    ["14:00", "14:20", "14:40", "15:00", "NOW"].forEach((lb, i) => {
      const t = svgEl("text", { x: 20 + i * 80, y: 136, fill: "#7a7a7a", "font-size": 10 });
      t.textContent = lb;
      err.append(t);
    });
    bindChartTip(err.parentElement, document.getElementById("errTip"), errHits, (el) => {
      return lab.errorStepTip(Number(el.getAttribute("data-i")), steps);
    }, err);
  })();

  function motion() {
    if (reduced || typeof gsap === "undefined") return;
    if (typeof ScrollTrigger !== "undefined") {
      gsap.registerPlugin(ScrollTrigger);
    }
    gsap.utils.toArray(".widget").forEach((el, i) => {
      gsap.from(el, {
        opacity: 0,
        y: 28,
        duration: 0.7,
        ease: "power3.out",
        delay: (i % 3) * 0.05,
        scrollTrigger: { trigger: el, start: "top 86%" },
      });
    });
    gsap.from(".flow", { opacity: 0, x: -12, stagger: 0.08, duration: 0.8, ease: "power3.out", scrollTrigger: { trigger: "#sankey", start: "top 80%" } });
    gsap.from(".fan-hit", { opacity: 0, stagger: 0.004, duration: 0.55, ease: "power2.out", scrollTrigger: { trigger: "#fanSvg", start: "top 80%" } });
    document.querySelectorAll(".btn").forEach((b) => {
      b.addEventListener("pointerenter", () => gsap.to(b, { y: -1, duration: 0.18, ease: "power2.out" }));
      b.addEventListener("pointerleave", () => gsap.to(b, { y: 0, duration: 0.18, ease: "power2.out" }));
    });
  }
  motion();
})();
