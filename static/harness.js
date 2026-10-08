/* harness.js — Model Harness dashboard page (Task 6, clean rewrite).
 * Serves static/harness.html; pure helpers live in the marked block so
 * tests/harness-page.test.js can eval them standalone. */
(function () {
  'use strict';

/* __PURE_HELPERS__ */
  function median(arr) {
    if (!arr || !arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  // Nearest-rank p95: [1,2,100] -> 100 (ceil(3*.95)-1 = idx 2), not an
  // interpolated value — matches the plan's ab.py definition.
  function p95(arr) {
    if (!arr || !arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; });
    var i = Math.max(0, Math.ceil(s.length * 0.95) - 1);
    return s[i];
  }

  function fmt(v, dec) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var d = dec == null ? 1 : dec;
    if (Math.abs(v) >= 100 && d > 0) return Math.round(v).toString();
    return Number(v.toFixed(d)).toString();
  }

  function fmtAge(seconds) {
    if (seconds === null || !isFinite(seconds)) return "—";
    if (seconds < 90) return Math.max(0, Math.round(seconds)) + "s ago";
    if (seconds < 5400) return Math.round(seconds / 60) + "m ago";
    if (seconds < 172800) return fmt(seconds / 3600, 1) + "h ago";
    return fmt(seconds / 86400, 1) + "d ago";
  }

  function deltaPct(cur, ref) {
    if (cur == null || !ref || !isFinite(ref)) return "—";
    var d = (cur - ref) / Math.abs(ref) * 100;
    return (d > 0 ? "+" : "") + fmt(d, 1) + "%";
  }

  function deltaAbs(cur, ref, dec) {
    if (cur == null || ref == null) return "—";
    var d = cur - ref;
    if (d === 0) return "±0";
    var s = d > 0 ? "+" : "-";
    return s + fmt(Math.abs(d), dec == null ? 2 : dec);
  }

  function num(v) { return (v === null || v === undefined) ? null : Number(v); }

  // #f27575 -> #7ee2a8 ramp for the yield heatmap (t=0 worst .. t=1 best).
  function heatRamp(t) {
    var a = [242, 117, 117], b = [126, 226, 168];
    var c = a.map(function (x, i) { return Math.round(x + (b[i] - x) * t); });
    return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  }

  function byClass(samples, clsKey) {
    var map = {};
    (samples || []).forEach(function (s) {
      if (!s[clsKey]) return;
      (map[s[clsKey]] = map[s[clsKey]] || []).push(s);
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  // class -> {n, medianTps, p95Ttft} for TTFT-by-class and KPI context.
  function classStats(samples) {
    var out = {};
    byClass(samples, "prompt_class").forEach(function (rows) {
      var tps = rows.map(function (s) { return num(s.tps); }).filter(function (v) { return v != null && isFinite(v); });
      // p95 ttft is only meaningful with complete ttft coverage: one missing
      // value poisons the class metric, so an incomplete class reports null.
      var ttAll = rows.map(function (s) { return num(s.ttft_s); });
      var ttOk = ttAll.every(function (v) { return v != null && isFinite(v); });
      var tt = ttAll.filter(function (v) { return v != null && isFinite(v); });
      out[rows[0].prompt_class] = {
        n: rows.length,
        medianTps: tps.length ? median(tps) : null,
        p95Ttft: ttOk && tt.length ? p95(tt) : null,
      };
    });
    return out;
  }

  // fp -> {n, medianTps, avgTtft} across all classes, from raw samples.
  function fpStats(samples) {
    var map = {};
    (samples || []).forEach(function (s) {
      if (!s.fp) return;
      (map[s.fp] = map[s.fp] || []).push(s);
    });
    var out = {};
    Object.keys(map).forEach(function (fp) {
      var rows = map[fp];
      var tps = rows.map(function (s) { return num(s.tps); }).filter(function (v) { return v != null && isFinite(v); });
      var tt = rows.map(function (s) { return num(s.ttft_s); }).filter(function (v) { return v != null && isFinite(v); });
      out[fp] = {
        n: rows.length,
        medianTps: tps.length ? median(tps) : null,
        avgTtft: tt.length ? tt.reduce(function (a, b) { return a + b; }, 0) / tt.length : null,
      };
    });
    return out;
  }

  // fp -> {label, newestTs, host} for the leaderboard's meta columns.
  function fpMeta(samples) {
    var map = {};
    (samples || []).forEach(function (s) {
      if (!s.fp) return;
      var m = map[s.fp];
      if (!m || (s.ts && s.ts > m.newestTs)) {
        m = map[s.fp] = { label: s.label || "", newestTs: s.ts || 0, host: s.host || "" };
      } else if (s.label && !m.label) { m.label = s.label; }
    });
    return map;
  }

  function tsOf(s) {
    var t = s.ts;
    if (t == null) return 0;
    var n = Number(t);
    // Sample ts are unix seconds; tolerate pre-existing millis.
    if (n > 1e12) n /= 1000;
    return isFinite(n) ? n : 0;
  }

  // SSE row identity: same second + fp + class + tokens = the same bench run.
  function sampleKey(s) {
    return [Math.round(tsOf(s)), s.fp || "", s.prompt_class || "", num(s.tokens) || 0,
      fmt(num(s.tps), 2), fmt(num(s.ttft_s), 3)].join("|");
  }

  function mergeRow(rows, row) {
    var k = sampleKey(row);
    if (!rows.some(function (r) { return sampleKey(r) === k; })) rows.push(row);
    rows.sort(function (a, b) { return tsOf(a) - tsOf(b); });
  }

  /* __END_PURE_HELPERS__ */

  // ------------------------------------------------------------------------
  // Page wiring — Chart.js 4, SSE /events, 60s refresh. Matches the ids in
  // static/harness.html (chart-tps, chart-ttft, board-body, rangeSeg, ...).
  // ------------------------------------------------------------------------
  var C = {
    accent: "#7ee2a8", warn: "#f0b45a", hot: "#f27575",
    txt: "#e7ecf3", muted: "#8b96a8",
    grid: "rgba(255,255,255,0.07)", tpsFill: "rgba(126,226,168,0.12)"
  };

  var state = { hours: 24, samples: [], best: [], tpsChart: null, ttftChart: null };

  function $(id) { return document.getElementById(id); }
  function finite(v) { return v != null && isFinite(v); }

  function fetchJson(path, cb) {
    fetch(path).then(function (r) { return r.json(); })
      .then(function (d) { cb(d); })
      .catch(function () { /* transient — the 60s refresh retries */ });
  }
  // fp, label, host, thermal and prompt_class come from /ingest senders and
  // /api/harness/mark, so they are data, never markup.
  function esc(v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function postJson(path, body, cb) {
    fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (d) { cb(d); })
      .catch(function () {});
  }

  // muted -> accent hex mix for the TTFT bar scale (fastest class = accent).
  function mix(a, b, t) {
    var pa = [1, 3, 5].map(function (i) { return parseInt(a.substr(i, 2), 16); });
    var pb = [1, 3, 5].map(function (i) { return parseInt(b.substr(i, 2), 16); });
    return "#" + pa.map(function (v, i) {
      return ("0" + Math.round(v + (pb[i] - v) * t).toString(16)).slice(-2);
    }).join("");
  }

  function fmtHourDay(ms) {
    var d = new Date(ms);
    if (isNaN(d.getTime())) return "";
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  // Current window = last N hours; reference = the N hours before it.
  function curRef() {
    var cut = Date.now() / 1000 - state.hours * 3600;
    var cur = [], ref = [];
    state.samples.forEach(function (s) {
      if (tsOf(s) >= cut) cur.push(s); else ref.push(s);
    });
    return { cur: cur, ref: ref };
  }

  function setNum(id, v, unit) {
    var el = $(id);
    if (el) el.innerHTML = (v == null ? "—" : fmt(v, 1)) + "<small>" + unit + "</small>";
  }

  // delta chip into a .delta element; color flips per metric direction.
  function deltaHtml(el, cur, ref, goodWhenUp) {
    if (!el) return;
    var pct = deltaPct(cur, ref);
    if (pct === "—") { el.innerHTML = ""; return; }
    var d = deltaAbs(cur, ref, 2);
    if (d === "±0") { el.className = "delta"; el.innerHTML = "<b>±0</b> vs prev window"; return; }
    var up = d.charAt(0) === "+";
    var good = goodWhenUp ? up : !up;
    el.className = "delta " + (good ? "good" : "bad");
    el.innerHTML = "<b>" + (up ? "▲ " : "▼ ") + pct + "</b> vs prev window";
  }

  function medTps(rows) {
    var v = rows.map(function (s) { return num(s.tps); }).filter(finite);
    return v.length ? median(v) : null;
  }
  function p95Ttft(rows) {
    var v = rows.map(function (s) { return num(s.ttft_s); }).filter(finite);
    return v.length ? p95(v) : null;
  }
  function swapAvg(rows) {
    var v = rows.map(function (s) { return num(s.swap_mb); }).filter(finite);
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }

  function renderKpis() {
    var w = curRef(), cur = w.cur, ref = w.ref;
    var tpsC = medTps(cur), tpsR = medTps(ref);
    var ttC = p95Ttft(cur), ttR = p95Ttft(ref);
    var swC = swapAvg(cur), swR = swapAvg(ref);
    setNum("kpi-tps", tpsC, "tok/s");
    deltaHtml($("kpi-tps-d"), tpsC, tpsR, true);
    setNum("kpi-ttft", ttC, "s");
    deltaHtml($("kpi-ttft-d"), ttC, ttR, false);
    setNum("kpi-rate", cur.length / state.hours, "/h");
    deltaHtml($("kpi-rate-d"), cur.length / state.hours, ref.length / state.hours, true);
    setNum("kpi-swap", swC, "MB");
    deltaHtml($("kpi-swap-d"), swC, swR, false);
  }

  function renderHeader() {
    var now = Date.now() / 1000;
    var newest = null, newestTs = -Infinity;
    state.samples.forEach(function (s) {
      var t = tsOf(s);
      if (t > newestTs) { newestTs = t; newest = s; }
    });
    var live = $("live"), age = $("lastAge");
    if (!newest) {
      if (age) age.textContent = "no samples";
      if (live) live.classList.remove("on");
      return;
    }
    if (age) age.textContent = fmtAge(now - newestTs);
    if (live) live.classList.toggle("on", now - newestTs < 90);
    var thMap = { nominal: "ok", fair: "warn", serious: "hot", critical: "hot" };
    var th = String(newest.thermal || "").toLowerCase();
    if ($("therm")) $("therm").textContent = newest.thermal || "—";
    if ($("thermDot")) $("thermDot").className = "therm-dot " + (thMap[th] || "");
    if ($("fp")) $("fp").textContent = newest.fp || "—";
    if ($("fplabel")) $("fplabel").textContent = newest.label ? " · " + newest.label : "";
  }

  function renderCharts() {
    var box1 = $("chart-tps"), box2 = $("chart-ttft");
    if (!box1 || !box2) return;
    if (!window.Chart) {           // CDN blocked — CSS ::after explains it
      box1.className = box2.className = "empty-msg";
      return;
    }
    // tok/s time series (area line, linear ms x-axis — no date adapter needed)
    var pts = state.samples
      .filter(function (s) { return finite(num(s.tps)); })
      .map(function (s) { return { x: tsOf(s) * 1000, y: num(s.tps) }; })
      .sort(function (a, b) { return a.x - b.x; });
    if (state.tpsChart) state.tpsChart.destroy();
    state.tpsChart = new Chart(box1, {
      type: "line",
      data: { datasets: [{ data: pts, borderColor: C.accent,
        backgroundColor: C.tpsFill, fill: true, borderWidth: 2,
        pointRadius: 0, pointHitRadius: 8, tension: 0.25 }] },
      options: { animation: false,
        scales: {
          x: { type: "linear",
               ticks: { color: C.muted, maxTicksLimit: 6,
                        callback: function (v) { return fmtHourDay(v); } },
               grid: { color: C.grid } },
          y: { beginAtZero: true, ticks: { color: C.muted }, grid: { color: C.grid } } },
        plugins: { legend: { display: false },
          tooltip: { callbacks: {
            title: function (items) { return items.length ? fmtHourDay(items[0].parsed.x) : ""; },
            label: function (it) { return it.parsed.y.toFixed(1) + " tok/s"; } } } } }
    });
    // p50 TTFT by prompt class (horizontal bars, muted -> accent scale)
    var cls = byClass(state.samples, "prompt_class").map(function (rows) {
      var tt = rows.map(function (s) { return num(s.ttft_s); }).filter(finite);
      return { cls: rows[0].prompt_class, p50: tt.length ? median(tt) : null };
    }).filter(function (c) { return c.p50 != null; })
      .sort(function (a, b) { return a.p50 - b.p50; });
    var colors = cls.map(function (c, i) {
      return mix(C.accent, C.muted, cls.length > 1 ? i / (cls.length - 1) : 0);
    });
    if (state.ttftChart) state.ttftChart.destroy();
    state.ttftChart = new Chart(box2, {
      type: "bar",
      data: { labels: cls.map(function (c) { return c.cls; }),
        datasets: [{ data: cls.map(function (c) { return c.p50; }),
          backgroundColor: colors, borderRadius: 4 }] },
      options: { indexAxis: "y", animation: false,
        scales: { x: { beginAtZero: true, ticks: { color: C.muted },
                       grid: { color: C.grid } },
                  y: { ticks: { color: C.txt }, grid: { display: false } } },
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: function (it) {
            return it.parsed.x.toFixed(2) + " s p50"; } } } } }
    });
  }

  function renderBoard() {
    var tbody = $("board-body");
    if (!tbody) return;
    var stats = fpStats(state.samples);
    var meta = fpMeta(state.samples);
    var therm = {};
    state.samples.forEach(function (s) { if (s.fp && s.thermal) therm[s.fp] = s.thermal; });
    var list = Object.keys(stats).sort(function (a, b) {
      return (stats[b].medianTps || -1) - (stats[a].medianTps || -1);
    }).slice(0, 10);
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty">no samples yet — waiting for the collector</td></tr>';
      return;
    }
    var now = Date.now() / 1000;
    tbody.innerHTML = list.map(function (fp, i) {
      var m = meta[fp] || {}, st = stats[fp];
      var th = String(therm[fp] || "").toLowerCase();
      var bcls = th === "nominal" ? "ok" : (th === "fair" ? "warn" : (th ? "hot" : ""));
      return '<tr data-fp="' + esc(fp) + '"' + (i === 0 ? ' class="top"' : "") + ">" +
        "<td>" + (i + 1) + "</td>" +
        "<td><code>" + esc(fp) + "</code></td>" +
        '<td class="lbl-cell">' + (m.label ? esc(m.label) : "—") + "</td>" +
        "<td>" + fmt(st.medianTps, 1) + "</td>" +
        "<td>" + fmt(st.avgTtft, 2) + "</td>" +
        "<td>" + st.n + "</td>" +
        "<td>" + (therm[fp] ? '<span class="badge ' + bcls + '">' + esc(therm[fp]) + "</span>" : "—") + "</td>" +
        "<td>" + (m.host ? esc(m.host) : "—") + "</td>" +
        "<td>" + (m.newestTs ? fmtAge(now - m.newestTs) : "—") + "</td></tr>";
    }).join("");
    tbody.querySelectorAll("tr[data-fp]").forEach(function (tr) {
      tr.addEventListener("click", function () { starFp(tr.getAttribute("data-fp")); });
    });
  }

  // Click a leaderboard row -> prompt a label -> POST /api/harness/mark.
  function starFp(fp) {
    var meta = fpMeta(state.samples);
    var label = window.prompt("Label config " + fp + ":", (meta[fp] && meta[fp].label) || "");
    if (label === null) return;
    postJson("/api/harness/mark", { fp: fp, label: label }, function (d) {
      if (!d.ok) { window.alert(d.error || "label not saved"); return; }
      state.samples.forEach(function (s) { if (s.fp === fp) s.label = label; });
      renderHeader(); renderBoard();
    });
  }

  // Yield heatmap: fp x prompt_class -> median tps (median_tps from /best).
  function renderHeat() {
    var canvas = $("heat"), note = $("best-sub"), tip = $("tip");
    if (!canvas) return;
    var rows = state.best || [];
    if (!rows.length) {
      if (note) note.textContent = "no configs yet — run the bench suite on the MBP";
      return;
    }
    var fps = [], classes = [], cell = {}, mn = Infinity, mx = -Infinity;
    rows.forEach(function (r) {
      if (fps.indexOf(r.fp) === -1) fps.push(r.fp);
      if (classes.indexOf(r.prompt_class) === -1) classes.push(r.prompt_class);
      var v = num(r.median_tps);
      cell[r.fp + "|" + r.prompt_class] = { v: v, n: r.n };
      if (finite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
    });
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth || 600, H = canvas.clientHeight || 240;
    canvas.width = W * dpr; canvas.height = H * dpr;
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    var cw = W / fps.length, ch = H / classes.length;
    for (var i = 0; i < fps.length; i++) {
      for (var j = 0; j < classes.length; j++) {
        var c = cell[fps[i] + "|" + classes[j]];
        var t = c && finite(c.v) && mx > mn ? (c.v - mn) / (mx - mn) : null;
        ctx.fillStyle = t == null ? "rgba(255,255,255,0.05)" : heatRamp(t);
        ctx.fillRect(i * cw + 1, j * ch + 1, cw - 2, ch - 2);
      }
    }
    if (note) note.textContent = fps.length + " configs x " + classes.length +
      " classes - best " + fmt(mx, 1) + " tok/s";
    if (!tip) return;
    canvas.onmousemove = function (ev) {
      var rect = canvas.getBoundingClientRect();
      var i = Math.floor((ev.clientX - rect.left) / cw);
      var j = Math.floor((ev.clientY - rect.top) / ch);
      if (i < 0 || j < 0 || i >= fps.length || j >= classes.length) {
        tip.style.opacity = 0; return;
      }
      var c = cell[fps[i] + "|" + classes[j]];
      tip.innerHTML = "<b>" + esc(fps[i]) + "</b> · " + esc(classes[j]) + "\n" +
        (c && finite(c.v) ? c.v.toFixed(1) + " tok/s" : "no data") +
        " · n=" + (c ? c.n : 0);
      tip.style.left = ev.clientX + "px";
      tip.style.top = ev.clientY + "px";
      tip.style.opacity = 1;
    };
    canvas.onmouseleave = function () { tip.style.opacity = 0; };
  }

  function renderAll() {
    renderHeader(); renderKpis(); renderCharts(); renderBoard();
  }

  function loadAll() {
    fetchJson("/api/harness/samples?hours=" + state.hours * 2, function (d) {
      state.samples = (d && d.samples) || [];
      renderAll();
    });
    fetchJson("/api/harness/best?n=200", function (d) {
      state.best = (d && d.best) || [];
      renderHeat();
    });
  }

  function startSSE() {
    if (!window.EventSource) return;
    var es = new EventSource("/events");
    es.addEventListener("rec", function (ev) {
      var rec;
      try { rec = JSON.parse(ev.data); } catch (e) { return; }
      if (rec.event !== "harness_sample") return;
      mergeRow(state.samples, rec);   // in-place dedupe + ts sort
      renderAll();
    });
  }

  function boot() {
    var seg = $("rangeSeg");
    if (seg) {
      seg.querySelectorAll("button").forEach(function (b) {
        b.addEventListener("click", function () {
          state.hours = parseInt(b.getAttribute("data-h"), 10) || 24;
          seg.querySelectorAll("button").forEach(function (x) { x.classList.remove("on"); });
          b.classList.add("on");
          loadAll();
        });
      });
    }
    loadAll();
    startSSE();
    window.setInterval(loadAll, 60000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.HarnessPage = { state: state, renderAll: renderAll, loadAll: loadAll,
    mix: mix, fmtHourDay: fmtHourDay };
})();
