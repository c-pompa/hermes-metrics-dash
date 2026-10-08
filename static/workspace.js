/* Workspace layout controller for the overview page (#/).
   Owns: category switching (rail ⇄ tabs ⇄ workspaces), the right slide-out
   panel, the Filters popover, and the off-canvas rail on small screens.
   View state persists in localStorage only — filters.js owns the URL hash.
   Charts measure their containers at render time, so every visibility change
   (workspace switch, diagnostic toggle) triggers renderAll() to repaint. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const overview = $("page-overview");
  if (!overview) return;

  const CATS = ["overview", "fleet", "live", "routing", "memory", "conv"];
  const LABELS = { overview: "Overview", fleet: "Fleet", live: "Live ops", routing: "Routing & roles", memory: "Memory & KV", conv: "Conversations" };
  const LS_KEY = "hermesMetricsWorkspace";

  function repaint() {
    if (typeof renderAll === "function") renderAll();
  }

  /* ---------- category switching ---------- */
  function go(cat, skipRender) {
    if (!CATS.includes(cat)) cat = "overview";
    overview.querySelectorAll(".ws-nav a[data-cat]").forEach(a =>
      a.classList.toggle("on", a.dataset.cat === cat));
    const cats = $("wscats");
    if (cats) cats.querySelectorAll("button[data-cat]").forEach(b =>
      b.classList.toggle("on", b.dataset.cat === cat));
    overview.querySelectorAll(".workspace").forEach(w =>
      w.classList.toggle("on", w.dataset.ws === cat));
    const crumb = $("wscrumb");
    if (crumb) crumb.textContent = LABELS[cat] || "Overview";
    try { localStorage.setItem(LS_KEY, cat); } catch (e) {}
    if (!skipRender) repaint();
  }

  overview.querySelectorAll("[data-cat]").forEach(el => {
    el.addEventListener("click", ev => {
      ev.preventDefault();           // keep filters.js hash state untouched
      go(el.dataset.cat);
      railToggle(false);
    });
  });

  /* ---------- diagnostic <details> toggle → repaint charts ---------- */
  overview.querySelectorAll(".workspace details").forEach(d => {
    d.addEventListener("toggle", () => { if (d.open) repaint(); });
  });

  /* ---------- Filters popover ---------- */
  const popwrap = $("wsfilterwrap");
  const popbtn = $("wsfilterbtn");
  if (popwrap && popbtn) {
    popbtn.addEventListener("click", ev => {
      ev.stopPropagation();
      const open = popwrap.classList.toggle("open");
      popbtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", ev => {
      if (!popwrap.contains(ev.target)) {
        popwrap.classList.remove("open");
        popbtn.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- right slide-out panel ---------- */
  const panel = $("wspanel"), scrim = $("wsscrim");
  function panelOpen(open) {
    if (!panel) return;
    panel.classList.toggle("open", open);
    if (scrim) scrim.classList.toggle("on", open);
  }
  const actbtn = $("wsact");
  if (actbtn) actbtn.addEventListener("click", () => panelOpen(!panel.classList.contains("open")));
  const pclose = $("wspclose");
  if (pclose) pclose.addEventListener("click", () => panelOpen(false));
  if (scrim) scrim.addEventListener("click", () => { panelOpen(false); railToggle(false); });
  if (panel) {
    panel.querySelectorAll(".ws-tabs button[data-pane]").forEach(b => {
      b.addEventListener("click", () => {
        panel.querySelectorAll(".ws-tabs button").forEach(x => x.classList.toggle("on", x === b));
        panel.querySelectorAll(".ws-pane").forEach(p =>
          p.classList.toggle("on", p.dataset.pane === b.dataset.pane));
      });
    });
  }

  /* ---------- off-canvas rail (mobile) ---------- */
  const rail = $("wsrail"), ham = $("wsham");
  function railToggle(open) {
    if (!rail) return;
    rail.classList.toggle("open", open);
    if (scrim) scrim.classList.toggle("nav", open);
  }
  if (ham) ham.addEventListener("click", () => railToggle(!rail.classList.contains("open")));

  /* ---------- escape closes panel + rail ---------- */
  document.addEventListener("keydown", ev => {
    if (ev.key === "Escape") { panelOpen(false); railToggle(false); }
  });

  /* ---------- restore last workspace ---------- */
  let saved = "overview";
  try { saved = localStorage.getItem(LS_KEY) || "overview"; } catch (e) {}
  go(saved, true);   // no repaint here; main.js renders at boot
})();
