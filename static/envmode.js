/* Hermes Metrics — env-mode preview/apply modal flow. */
"use strict";

let envModePending = null;

function envModeLabel(id, modes) {
  const hit = (modes || []).find((m) => m.id === id);
  return hit ? hit.label : id;
}

function renderEnvModeBadge(status) {
  const previousTs = envModeStatus && envModeStatus.active_mode_ts;
  envModeStatus = status;   // R6: the chart reads active_mode_ts for its marker
  const active = document.getElementById("envmode-active");
  const label = envModeLabel(status.active_mode, status.modes) || status.active_mode || "unknown";
  if (active) active.textContent = label;
  const headerBadge = document.getElementById("envbadge-mode");
  if (headerBadge) headerBadge.textContent = label;
  const sel = document.getElementById("envmodesel");
  if (!sel) return;
  for (const btn of sel.querySelectorAll("button[data-mode]")) {
    const on = btn.dataset.mode === status.active_mode;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }
  // A mode change moves the chart marker — repaint once it lands.
  if (status.active_mode_ts !== previousTs && typeof scheduleRender === "function") scheduleRender();
}

async function refreshEnvModeStatus() {
  try {
    const resp = await fetch("/api/env-mode", { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const status = await resp.json();
    renderEnvModeBadge(status);
    return status;
  } catch (err) {
    const active = document.getElementById("envmode-active");
    if (active) active.textContent = "unavailable";
    const headerBadge = document.getElementById("envbadge-mode");
    if (headerBadge) headerBadge.textContent = "unavailable";
    return null;
  }
}

function renderEnvModeDiff(diff) {
  const list = document.getElementById("envmode-diff");
  if (!list) return;
  if (!diff || !diff.length) {
    list.innerHTML = `<li class="empty">No managed keys would change.</li>`;
    return;
  }
  list.innerHTML = diff.map((row) => {
    const from = row.from == null ? "∅" : String(row.from);
    const to = row.to == null ? "∅" : String(row.to);
    return `<li><span class="path">${esc(row.path)}</span><span class="from">${esc(from)}</span><span class="to">${esc(to)}</span></li>`;
  }).join("");
}

function syncEnvModeApplyEnabled() {
  const input = document.getElementById("envmode-confirm");
  const apply = document.getElementById("envmode-apply");
  if (!input || !apply || !envModePending) return;
  apply.disabled = input.value.trim() !== envModePending.id;
}

async function openEnvModeDialog(modeId) {
  const dialog = document.getElementById("envmode-dialog");
  const err = document.getElementById("envmode-error");
  const input = document.getElementById("envmode-confirm");
  const apply = document.getElementById("envmode-apply");
  const hint = document.getElementById("envmode-confirm-hint");
  const lead = document.getElementById("envmode-dlg-lead");
  if (!dialog) return;
  if (err) err.textContent = "";
  if (input) input.value = "";
  if (apply) {
    apply.disabled = true;
    apply.textContent = "Apply";
  }
  try {
    const resp = await fetch(`/api/env-mode/preview?mode=${encodeURIComponent(modeId)}`, { cache: "no-store" });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    envModePending = { id: modeId, diff: data.diff || [] };
    if (hint) hint.textContent = modeId;
    if (lead) {
      lead.textContent = `Apply ${modeId} on Mini + MBP configs, then restart the Mini gateway. Type the mode id to confirm.`;
    }
    renderEnvModeDiff(envModePending.diff);
    syncEnvModeApplyEnabled();
    dialog.showModal();
    if (input) input.focus();
  } catch (ex) {
    if (err) err.textContent = String(ex.message || ex);
    envModePending = { id: modeId, diff: [] };
    if (hint) hint.textContent = modeId;
    renderEnvModeDiff([]);
    dialog.showModal();
  }
}

async function applyEnvMode() {
  if (!envModePending) return;
  const err = document.getElementById("envmode-error");
  const apply = document.getElementById("envmode-apply");
  const dialog = document.getElementById("envmode-dialog");
  const input = document.getElementById("envmode-confirm");
  const mode = envModePending.id;
  const confirm = (input && input.value.trim()) || "";
  if (confirm !== mode) {
    if (err) err.textContent = "Typed confirm must exactly match the mode id.";
    return;
  }
  if (apply) {
    apply.disabled = true;
    apply.textContent = "Applying…";
  }
  if (err) err.textContent = "";
  try {
    const resp = await fetch("/api/env-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, confirm }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      const detail = data.error || (data.partial ? "Partial apply — check hosts / gateway." : `HTTP ${resp.status}`);
      const hostErr = data.hosts && data.hosts.mbp && data.hosts.mbp.error;
      throw new Error(hostErr ? `${detail} (${hostErr})` : detail);
    }
    await refreshEnvModeStatus();
    if (dialog && dialog.open) dialog.close();
  } catch (ex) {
    if (err) err.textContent = String(ex.message || ex);
    if (apply) {
      apply.textContent = "Apply";
      syncEnvModeApplyEnabled();
    }
  }
}

function wireEnvModeControls() {
  const sel = document.getElementById("envmodesel");
  const input = document.getElementById("envmode-confirm");
  const apply = document.getElementById("envmode-apply");
  if (sel) {
    sel.addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-mode]");
      if (!btn) return;
      openEnvModeDialog(btn.dataset.mode);
    });
  }
  if (input) {
    input.addEventListener("input", syncEnvModeApplyEnabled);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        applyEnvMode();
      }
    });
  }
  if (apply) apply.addEventListener("click", applyEnvMode);
  refreshEnvModeStatus();
}
