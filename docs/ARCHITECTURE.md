# Architecture — hermes-metrics-dash

Developer-facing map of the fleet metrics pipeline: how records flow from
Hermes shell hooks on every machine into one SQLite store on the mini, and
how the plugin surfaces (web tab, desktop chip/pane, API routes) read them
back. For operator docs see `README.md` and `desktop-plugin/README.md`;
conventions and deploy cautions are in the README.

## System overview

Multi-machine is the native design: every host running Hermes emits metrics
locally and forwards them to a single server (the mini, `:8899`). There is
**one write path into one central DB**, and every record is host-labeled
(`METRICS_HOST_LABEL`, else the short hostname — `forwarder.py:55`).

```
 per machine (MBP, mini, winpc, …)                     mini
 ┌──────────────────────────────────┐
 │ hermes shell hooks (config.yaml) │
 │  └─ hooks/metrics-emit.py        │  append-only JSONL, one line/event
 │       ▼                          │
 │  ~/.hermes/metrics/requests.jsonl│
 │       ▼  (tailed, byte offsets)  │
 │  forwarder.py  (launchd          │  enrich: state.db session info,
 │   ai.hermes.metricsfwd)          │  `lms ps` device map, host label
 └───────┬──────────────────────────┘
         │ POST /ingest {"host", "records"}  (at-least-once, 2s tick)
         ▼
 ┌────────────────────────────────────────────────────────┐
 │ app.py  (launchd ai.hermes.metricsdash, :8899)         │
 │  normalize() → dedup_key → INSERT OR IGNORE            │
 │  ~/.hermes/metrics/metrics.db  (SQLite, WAL, 30d ret.) │
 │  static/ dashboard + SSE /events + /api/*              │
 └───────┬────────────────────────────────────────────────┘
         │ HTTP (loopback or LAN)
         ▼
 plugin surfaces: web tab, desktop chip/pane, /api/plugins/metrics-dashboard/*
         (or local-file read of requests.jsonl when no server answers)
```

## Store-and-forward coalescing

The forwarder's reliability mechanism — previously unnamed — is
**store-and-forward coalescing**: records accumulate ("store") in a retry
backlog while the server is down, are re-shipped in coalesced batches of up
to `BATCH_MAX=500` every `POLL_SECONDS=2`s ("forward"), and both sides
cooperate so that re-delivery is harmless. Three pieces:

**1. Persisted byte offsets** (`forwarder.py:48`,
`~/.hermes/metrics/.forwarder-state.json`, written atomically via tmp+replace
at `forwarder.py:413-417`). Each tailed file has a byte offset; new complete
lines are read from it (`read_new_lines`, `forwarder.py:466-493`). The state
is **committed only after the whole queue drains** (`forwarder.py:731-732`).
Crash or restart mid-outage → the forwarder re-reads from the last committed
offset → records may be re-delivered (at-least-once) → the server absorbs
the duplicates (piece 3). Rotation/truncation resets the offset to 0
(`size < offset`, `forwarder.py:473-474`) — post-rotation content is
re-read, again absorbed by dedup. First sight of `agent.log` seeds at EOF
(history is never backfilled, `forwarder.py:500+`).

**2. Capped retry backlog** (`PENDING_MAX = 5000`, `forwarder.py:60`;
`trim_pending`, `forwarder.py:672-693`). During an outage the in-memory
`pending` queue is the "store". When it exceeds the cap, periodic samples
(`host_stats` / `pool_status` / `benchmark_sample` — they go stale anyway)
are shed oldest-first, then the oldest records of any kind. Shed records
are **permanently lost** once offsets commit; each drop is logged to stderr.
That bounds the data-loss window of a long outage: at typical volumes,
roughly the newest 5000 records survive; everything older than the backlog
that never shipped is gone.

**3. Server-side idempotency** (`app.py:581-588`, `606`, `613-619`).
`normalize()` hashes the full normalized row (sha1) into `dedup_key`; a
`UNIQUE` index plus `INSERT OR IGNORE` makes **exact re-deliveries collapse**
(rowcount 0 = duplicate, skipped silently). This is what makes the
at-least-once ship loop safe end to end. Caveat: two genuinely identical
records also collapse — accepted, they carry no extra information.

Failure semantics in one line: single write path, one DB across machines,
host-labeled records; outages cost at most the backlog overflow, never
duplicates.

## Component map

| Component | Runs where | Role |
|---|---|---|
| `hooks/metrics-emit.py` | every host | Shell hook wired in `~/.hermes/config.yaml` (`hooks:` → `post_api_request`, `api_request_error`, `subagent_stop`). Appends one compact JSON line per event to `~/.hermes/metrics/requests.jsonl` (single `O_APPEND` write; never fails the turn — all errors exit 0). |
| `forwarder.py` | every host, launchd `ai.hermes.metricsfwd.*` | Tails `requests.jsonl`, `moa-refs.jsonl`, and guardrail lines in `~/.hermes/logs/agent.log`; enriches with session title/parent/cost from `~/.hermes/state.db` (read-only, `SessionInfo`, `forwarder.py:420`) and model→device from `lms ps --json` (`DeviceMap`, `forwarder.py:361`); ships via store-and-forward coalescing. |
| `app.py` | mini, launchd `ai.hermes.metricsdash`, `:8899` | Stdlib-only server + dashboard. `POST /ingest` → `normalize()` → SQLite (`metrics.db`, WAL). Retention: `METRICS_RETENTION_DAYS` (default 30, `app.py:168`), hourly prune (`app.py:1221`); `pool_status` pruned sooner, `host_stats` downsampled beyond `HEARTBEAT_HOURS`. Endpoints: `/health`, `/api/recent`, `/api/findings`, `/api/usage-map`, `/api/about`, `/api/session-names`, `/api/router-{notes,status,usage}`, `/api/benchmark/{samples,best,marks,mark}`, `/api/env-mode` (+`/preview`), `/api/hitl-events`, `/api/beta-widgets`, SSE `/events`, static dashboard. |
| `plugin/metrics_core.py` | any Hermes backend | Data layer / backend seam (see below). Stdlib-only, py3.9-compatible (runs on the mini's system python). |
| `plugin/dashboard/plugin_api.py` | any Hermes backend | FastAPI routes mounted at `/api/plugins/metrics-dashboard/`, behind the dashboard's session-token auth middleware. Every route degrades to `{"available": false}` instead of hanging (≤3s timeouts). |
| `plugin/dashboard/dist/index.js` | web dashboard | Tab bundle (plain IIFE, `window.__HERMES_PLUGIN_SDK__`, no build step). Manifest: tab `/metrics-dashboard` `after:analytics`, icon `BarChart3`. |
| `desktop-plugin/plugin.js` | desktop app | Statusbar chip (rolling tok/s) + right-sidebar pane (per-model stats, Routing & roles). Talks only to the plugin namespace via `ctx.rest`. |

Plugin route inventory (`plugin/dashboard/plugin_api.py`):

| Route | Source | Degrades to |
|---|---|---|
| `GET /health` | `backend.health()` + `describe()` | 503, `available:false` |
| `GET /recent?hours&limit` | `backend.recent()` | 200, `available:false`, empty `records` |
| `GET /summary` | health + `recent(hours=1, limit=500)` in one payload | per-section degradation, always 200 |
| `GET /findings` | `backend.findings()` | 200, `available:false` |
| `GET /usage-map` | `backend.usage_map()` | 200, `available:false` |
| `GET /router-view` | sibling `model-router` plugin: `router_core` import, else `$MODEL_ROUTER_URL` loopback HTTP | per-section degradation; `available:false` hides the UI section |

`/health` and `/summary` carry `source` (`"http"` + `base_url`, or
`"local-file"` + `path`) so UIs can label where data comes from.

## Backend selection & topology behavior

`metrics_core.get_backend()` resolves the data source per call:

```
METRICS_BACKEND env (http | sqlite-stub)
  → METRICS_DASH_URL env            (pinned HTTP, never falls back)
  → probe http://127.0.0.1:8899     (we are on the mini)
  → probe REMOTE_BASE_URLS in order   (Tailscale → legacy LAN; override via METRICS_DASH_REMOTES)
  → LocalFileBackend                (only if requests.jsonl exists)
  → failing HTTP backend            (nothing reachable, no file → useful error)
```

- Probes are 0.5s and the whole resolution is cached for
  `BASE_URL_CACHE_TTL_S = 60` (`metrics_core.py`), so topology flips — mini
  appears/disappears, local file appears — are picked up within ~60s with no
  restart. The request path never stalls (all timeouts ≤3s).
- **Single-instance (local-file) mode**: `LocalFileBackend` reads
  `$HERMES_HOME/metrics/requests.jsonl` directly (trailing max(2 MiB,
  limit × 4 KiB) window, tolerant of bad lines, tz-aware `ts` parsing) and
  flattens raw hook records into the exact `/api/recent` row shape
  (`metrics_core._normalize_local_record`, mirroring `app.py:478`), so every
  surface works identically regardless of source. It is **read-only — the
  plugin never writes the file**, so there is no double-counting with the
  forwarder, which keeps shipping to the server whenever one is reachable.
- Server-side computations stay unavailable in local-file mode:
  `findings()` and `usage_map()` raise `MetricsUnavailable` with a clear
  reason; routes render them as `available:false` sections.

## Deployment

| Component | MBP (workstation) | Mini |
|---|---|---|
| `hooks/metrics-emit.py` | yes, via `~/.hermes/config.yaml` | yes |
| `forwarder.py` (launchd) | yes, `ai.hermes.metricsfwd.mac` | yes, `ai.hermes.metricsfwd.mini` |
| `app.py` server | no (client of it) | yes, `ai.hermes.metricsdash` :8899 |
| plugin Python half | yes, desktop backend mounts routes | yes, so the tunneled web dashboard gets routes + tab |
| desktop JS half | yes | no (no desktop app) |

- Install both plugin halves with `./install-plugin.sh` (copies `plugin/` →
  `~/.hermes/plugins/metrics-dashboard/`, `desktop-plugin/plugin.js` →
  `~/.hermes/desktop-plugins/…`), then add `metrics-dashboard` to
  `plugins.enabled` in `config.yaml` and restart the backend. The official
  `hermes plugins install "<git-url>#plugin" --enable` installs the Python
  half **including the web dashboard tab** (everything under `plugin/`), but
  not the desktop half (`desktop-plugin/` lives outside `plugin/`).
- **Caveat**: launchd runs `forwarder.py` straight from this repo checkout —
  edits take effect on the next `launchctl kickstart -k`; stash any local
  changes before pulling (`git stash push/pop`).

## Extension points

- **New backend** (the planned fold-in): implement the `MetricsBackend`
  interface (`recent/findings/usage_map/health/describe`) reading
  `~/.hermes/metrics/metrics.db` directly in `SqliteBackend`
  (`metrics_core.py` — currently a loud stub), select via
  `METRICS_BACKEND=sqlite`. No route or UI changes needed.
- **New route**: add a thin `@router.get` in `plugin/dashboard/plugin_api.py`
  delegating to `metrics_core`; wrap in the same degraded-payload pattern and
  add a stub-server test in `tests/test_plugin_api.py`.
- **Record schema**: hook line (`hooks/metrics-emit.py`) → `app.py:478
  normalize()` → `/api/recent` row. Key fields: `ts` (epoch), `event` →
  `kind` (`api`, `moa_turn`, `error`, `subagent_stop`, `host_stats`,
  `pool_status`, …), `model`, `provider`, `duration_s` (from `api_duration` /
  `duration_s` / `duration_ms`), `tps` (fallback `output/duration`), tokens
  flattened from nested `usage` (`input_tokens`, `output_tokens`, …),
  `session_id`, `host`, `error`, `dedup_key`. Local-file mode reproduces this
  shape in `_normalize_local_record`; keep the two in sync when adding fields.
- **Testing**: stdlib `unittest` (`python3 -m unittest discover -s tests -p
  'test_*.py'` — run with system python3 *and* the hermes venv python, which
  has fastapi); stub HTTP servers (`tests/test_metrics_core.py`,
  `tests/test_plugin_api.py`) with env/monkeypatch pinning of
  `LOOPBACK_BASE_URL` / `REMOTE_BASE_URLS` / `HERMES_HOME` and
  `_reset_base_url_cache()`; `node --test` for JS helpers
  (`tests/page-helpers.test.js`); `node --check` for bundle syntax; py3.9
  grammar gate via `ast.parse(feature_version=(3, 9))`.

## Security posture

- `POST /ingest` is **unauthenticated** and the app.py server is CORS-open on
  the LAN — a documented limitation of the current phase (any LAN host can
  write metrics or read the dashboard). The later "fold app.py into the
  gateway" phase puts the pipeline behind the gateway's auth; until then the
  server binds an interface reachable only on the trusted LAN.
- Plugin backend routes (`/api/plugins/metrics-dashboard/*`) sit behind the
  Hermes dashboard's **session-token auth middleware**, same as core routes —
  no auth is hand-rolled in the plugin; the web tab's `fetchJSON` injects the
  token automatically.
- Backend resolution is **loopback-first**: on the mini the plugin reads the
  local server; elsewhere it crosses the LAN only to the known mini address
  (or an explicit `METRICS_DASH_URL`).
- The forwarder reads `state.db` read-only; `metrics-emit.py` never fails a
  turn and writes only append-only JSONL; local-file mode in the plugin never
  writes anything.
