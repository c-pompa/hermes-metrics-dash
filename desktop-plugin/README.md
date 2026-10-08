# metrics-dashboard — Hermes plugin (desktop + backend)

A [Hermes](https://github.com/NousResearch/hermes-agent) plugin with two halves
sharing one id (`metrics-dashboard`):

- **Backend half** (`../plugin/`, installed to `~/.hermes/plugins/metrics-dashboard/`):
  FastAPI routes mounted at `/api/plugins/metrics-dashboard/` —
  `GET /recent`, `/findings`, `/usage-map`, `/health`, `/summary`, and
  `/router-view` (interop with the sibling `model-router` plugin; degrades to
  hidden when the router is absent or down; also carries the router's
  `write_enabled` gate flag), `POST /router-reload` (gated proxy for the
  daemon's `/router/reload`, same `MODEL_ROUTER_ALLOW_WRITE=1` posture as the
  router plugin's own write routes), plus `WS /events` pushing new
  records for instant desktop updates. The data layer (`metrics_core.py`)
  talks to this repo's `app.py` server over HTTP when one is reachable, and
  otherwise falls back to reading the local pipeline file directly — see
  [Topology behavior](#topology-behavior).
- **Desktop half** (`plugin.js`, installed to
  `~/.hermes/desktop-plugins/metrics-dashboard/`):
  - **Statusbar chip** (bottom-right): rolling tokens/sec. Click to open the
    full dashboard. Shows `metrics down` when unreachable.
  - **`metrics` pane** (right sidebar): the merged "G1" single-column
    layout. Collapsible sections, top to bottom: **Metrics** (status dot in
    the header — pulsing green while the hour is busy; idle is a compact
    last-seen line; a busy hour fades in the KPI tiles, 1h request
    sparkline, and per-model token-share rows, then collapses them when the
    hour goes quiet), **Roles** (fleet KPI tiles; active roles sort first
    by 24h traffic and stack role name / scrollable model id / stats / a
    token-share bar vs the fleet total; idle roles compress to one line),
    **MoA**, and **Notes (N)** (border-bottom list rows — kind + date +
    a 2-line-clamped title/summary, day separators, collapsed by default).
    Motion: 220ms ease-out enter / 160ms ease-in exit on all Reveals,
    rotating section chevrons, staggered row enters, and eased share-bar
    widths — all skipped under `prefers-reduced-motion`. The Roles/Notes
    sections hide themselves when the model-router plugin is unavailable;
    the header reads `metrics · model router` when the interop payload is
    up. When both plugins are enabled this pane is the shared column — the
    model-router desktop half suppresses its own pane. The footer carries
    the `gateway · model · live/polling` status line plus **reload config**
    (visible when router interop is up; disabled with the
    `MODEL_ROUTER_ALLOW_WRITE=1` hint while the backend gate is off) and
    **dashboard ↗**.

The desktop half talks only to the backend namespace via `ctx.rest` — the
CORS-open LAN endpoint is no longer needed by the plugin. Live updates ride
`ctx.socket` to the backend's `WS /events` stream (new records pushed as they
land); the 10s poll stays as the fallback for remotes where `ctx.socket` is a
no-op, and backs off to 60s while the socket is live. Both sources merge
through one dedupe path, so records never double-append.

## Topology behavior

The backend half picks its data source per call, in this order:

1. `METRICS_BACKEND` env (`http` default; `sqlite` is a documented stub).
2. `METRICS_DASH_URL` env — pinned HTTP, never falls back.
3. Loopback `:8899` when it answers (the plugin runs on the dashboard host).
4. Each `METRICS_DASH_REMOTES` URL (comma-separated) when it answers.
5. **Local-file mode**: read `~/.hermes/metrics/requests.jsonl` (the file the
   `metrics-emit.py` hook writes) directly — the single-instance mode, no
   server needed. Only used when the file exists; otherwise the backend stays
   HTTP so the error message points at the unreachable server.

- **Single-instance users** get the chip, pane, dashboard tab, `/recent`,
  `/health`, and `/summary` straight from the local file. Records are
  flattened to the same shape the HTTP API returns, so every surface works
  identically.
- **Switching is automatic**: steps 3–5 are probe-cached for ~60s, so when
  the mini/app.py appears or disappears (or the local file appears), the
  plugin flips HTTP ↔ local-file within a minute. No restart needed.
- **What stays unavailable in local-file mode**: `/findings` and
  `/usage-map` are server-side computations — they degrade to
  `{"available": false}` with a clear reason. The Roles/Notes sections are
  unaffected (they come from the sibling model-router plugin).
- `/health` and `/summary` report the active source (`"source": "http"` +
  `base_url`, or `"source": "local-file"` + `path`); the web tab's Server
  card shows it.

## Requirements

1. The Hermes desktop app, built from source with local disk-plugin support
   (`~/.hermes/desktop-plugins/` scanning).
2. A reachable `hermes-metrics-dash` server (this repo's `app.py`) from
   wherever the Hermes *backend* runs.

## Install

From the repo root:

```bash
./install-plugin.sh
```

then the manual steps it prints:

1. Add `metrics-dashboard` to `plugins.enabled` in `~/.hermes/config.yaml`.
2. Restart the Hermes desktop app (the backend mounts plugin routes at
   startup; the desktop half hot-loads on its own).

If the desktop connects to a **remote** Hermes backend (e.g. the mini), run
the installer against that host's `HERMES_HOME` too — `plugin_api.py` must
be importable by the backend the desktop is actually talking to.

## Troubleshooting — don't see the plugin?

Walk this checklist top to bottom; each step is the most common miss:

1. **Python half enabled?** `plugins.enabled` in `~/.hermes/config.yaml`
   must contain `metrics-dashboard`. Hermes refuses to import user plugin
   Python without this (security gate). After editing, restart the desktop
   app — routes mount only at backend startup.
2. **Right process restarted?** The routes live in the desktop app's
   `hermes serve` backend, **not** the launchd platform gateway
   (`ai.hermes.gateway`). Restart the desktop app itself.
3. **Backend route live?** From a shell on the backend host:
   `curl localhost:<serve-port>/api/plugins/metrics-dashboard/health`
   should return JSON (find the port via
   `lsof -iTCP -sTCP:LISTEN -P | grep hermes`). 404 = step 1/2 missed;
   503 or `"available": false` = the plugin is fine but the dashboard
   **server** is unreachable — check the dashboard host (`app.py` on
   `:8899`) and LAN/VPN.
4. **Desktop half loaded?** ⌘K → **Reload desktop plugins**, then
   **Settings → Plugins** — `Metrics` must be toggled on. The folder name
   `~/.hermes/desktop-plugins/metrics-dashboard/` must match the plugin id
   exactly.
5. **Chip shows `metrics down`?** The desktop half loaded but its backend
   calls fail — that's steps 1–3.
6. **No "Roles"/"Notes" sections?** Expected when the sibling
   `model-router` plugin is absent/disabled or the router daemon is down —
   the sections hide themselves by design. Check
   `/api/plugins/metrics-dashboard/router-view` → `"available"`.
7. **Connected to a remote backend?** The Python half must be installed and
   enabled on *that* machine's `~/.hermes` too — each backend mounts its own
   routes.

## Configure

- Server URL: `METRICS_DASH_URL` env on the Hermes backend (rarely needed —
  the per-host default handles mbp vs mini).
- Backend selection seam: `METRICS_BACKEND=http` (default); `sqlite` is a
  documented stub for the later "fold app.py into the gateway" phase.
- "Open full dashboard" link target: `ctx.storage` key `dashboardUrl`
  (default `http://127.0.0.1:8899`), e.g. in the app's devtools console:
  `hermes.plugin.metrics-dashboard.dashboardUrl` — set via the plugin
  storage API or by editing localStorage directly.
- Pane section collapse states persist in `ctx.storage` keys
  `g1MetricsCollapsed`, `g1RolesCollapsed`, `g1NotesCollapsed` (Notes
  defaults to collapsed), and `g1MoaCollapsed`. `g1LastSeenTs` stores the
  newest api-record timestamp so idle copy can still say “last request 3h
  ago” (`parseLastSeenTs` rejects non-finite / out-of-range values). The
  retired `routingCollapsed` key is read once to seed
  `g1RolesCollapsed`.

## Motion in the desktop pane

Disk plugins **can** animate. There is no motion library on the import map
(`framer-motion` / `gsap` will not resolve). The supported paths:

1. **CSS transitions on the plugin DOM** — Tailwind utilities
   (`transition-colors`, `duration-200`) or inline `style` (`opacity`,
   `transform`, `grid-template-rows`). This pane’s `Reveal` uses **inline
   styles only**: stay mounted at `0fr` while closed, animate to `1fr` on
   open, skip the first paint so a reload of a busy pane does not replay.
   Unmounting on hide makes the next show a first paint and kills the enter.
   Disk plugins are blob-loaded (no sidecar CSS). We do **not** inject
   `<style>` into `document.head` — that leaks across unload/reload.
2. **Bundled in-tree plugins** may add a `.css` import; disk plugins cannot.
   `@keyframes` would require an inline `<style>` in the pane tree, which
   this pane does not need.
3. **SDK primitives that already move** — `Skeleton` (`animate-pulse`),
   `GlyphSpinner` / `Loader`, `DecodeText` (scramble). Import from
   `@hermes/plugin-sdk`.
4. **`haptic(intent)`** — tactile, not visual. Intents include `open`,
   `close`, `tap`, `success`. This pane fires `open`/`close` on quiet↔busy
   (wrapped so a missing `web-haptics` bridge cannot crash the pane).

Hermes sets `transition-duration: 0.01ms !important` under
`prefers-reduced-motion: reduce` (macOS Reduce motion). Honor that; do not
fight it. Do not depend on undocumented app keyframe classes
(`thread-jump-in`, etc.) — they are not part of the plugin SDK.

## Uninstall

```bash
./install-plugin.sh --uninstall
```

then remove `metrics-dashboard` from `plugins.enabled` and restart the app.

## Note on the live pipeline

`forwarder.py` (launchd `ai.hermes.metricsfwd`) is executed straight from
this repo checkout — edits to it take effect on the next launchd restart.
The plugin work does not touch `app.py`, `forwarder.py`, or the launchd
plists.
