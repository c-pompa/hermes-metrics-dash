# hermes-metrics-dash

Built for [Hermes Agent](https://github.com/NousResearch/hermes-agent) by [Nous Research](https://nousresearch.com).

Live per-request LLM metrics for a Hermes fleet: tokens, duration, and
tokens/sec for every request, grouped per conversation per agent/model —
including subagents (delegate_task) and MoA proposer/aggregator calls.

**Dashboard:** `http://<dashboard-host>:8899` (loopback by default; see `METRICS_BIND`)

Architecture notes are in `docs/ARCHITECTURE.md`; the LM Studio harness is in
`docs/HARNESS.md`.

## How data flows

```
hermes-agent (Mac TUI / mini gateway)
  ├─ post_api_request / api_request_error / subagent_stop shell hooks
  │    → ~/.hermes/hooks/metrics-emit.py → ~/.hermes/metrics/requests.jsonl
  ├─ every MoA turn → ~/.hermes/metrics/moa-refs.jsonl (always-on compact
  │    proposer/aggregator metrics from the Hermes fork)
  ├─ tool-guardrail events → ~/.hermes/logs/agent.log (guardrail block /
  │    "Turn ended: reason=guardrail_halt" lines; tail-only, parsed into
  │    guardrail_block / guardrail_halt records, history not backfilled)
  └─ moa.save_traces → ~/.hermes/moa-traces/<session>.jsonl (optional,
       audit-only full traces; not tailed by this dashboard)
            │
   forwarder.py (launchd, per machine) — tails requests.jsonl,
   moa-refs.jsonl and agent.log (guardrail lines only), enriches with
   session title/parent from state.db,
   and POSTs batches to the dashboard
            │
   app.py on mini :8899 — sqlite (~/.hermes/metrics/metrics.db) + SSE
            │
   static/index.html — live feed, per-conversation per-model grouping,
   tok/s / duration / output-token charts
```

## Overview layout (sidebar workspace)

The `#/` overview uses a sidebar-workspace layout (`static/workspace.css` +
`static/workspace.js`): left nav rail, category tabs (Overview · Fleet ·
Live ops · Routing & roles · Memory & KV · Conversations), collapsible
diagnostic `<details>` inside each workspace, and a right slide-out panel
(router analysis notes + role usage). Workspace selection persists in
`localStorage["hermesMetricsWorkspace"]` (never the URL hash — `filters.js`
owns that). Every workspace/collapse toggle calls `renderAll()` because the
SVG/canvas charts measure their containers at render time.

Themes: Light / Dark / **Hermes** / Auto. Hermes redefines the same CSS vars
(`html[data-theme="hermes"]` in `index.html`) with the compression.html
palette + fonts (`hermes-*.woff2`, `hermes-bg.jpg`), so charts pick it up
with no JS changes. The previous stacked layout is frozen at
`/static/classic.html` (linked in the rail footer) until the new layout is
proven.

## Infra Benchmark

Hash route: `http://<dashboard-host>:8899/#/benchmark`

Lean forever-retained LMS/Hermes/host samples (`benchmark_samples`) for comparing
setups by **resource yield** (`t/s ÷ (resource_GB × parallel)`), grouped by usage
(deriver, dialectic, aggregator, MoA ref, embeddings).

- Forwarders emit `benchmark_sample` on the host-stats interval (`lms ps` + CPU/mem).
  Federated LM Link peers (e.g. a Windows GPU box) are included even without a local forwarder.
- Optional: `~/.hermes/metrics/usage-map.json` and `active-experiment`
- Mark via UI or `POST /api/benchmark/mark` `{"label":"…"}`
- Windows-native CPU/mem/power: on the Windows host run
  `scripts/windows-forwarder.ps1 -Install -Start -DashUrl http://<dashboard-host>:8899`.


## Host conformance checks

With `CONFORMANCE_STANDARD` set to a local `hermes-desktop-iac/conformance.yaml`, the
forwarder checks its host against that standard every 5 minutes (`host_checks.py`) and
sends one `conformance_result` record: the host finds itself in `hosts:` by
`METRICS_HOST_LABEL`, runs each `host_rules` check whose `applies_to` matches its roles or
OS, and reports `pass`, `warn`, `fail` or `na` per rule, with up to 5 lines of evidence.
A host not in `hosts:` reports `unclassified`. Unset, the forwarder runs no checks.

- Checks are read-only: the install stamp against the checkout's `origin/main`, `launchctl
  print` per role job, a loopback-only HTTP probe, and config key names (never values).
  A check kind it cannot run reports as failing, never as passing.
- The collector stores results in `conformance_results` (14 days). `verified` is 1 only
  when the sender's ingest token may report as that host, so in warn mode an unsigned
  result is kept but marked unverified.
- The standard comes from the host's own checkout, so pull it to pick up new rules; the
  result carries the checkout's commit as `standard.rev`.
- Needs PyYAML in the forwarder's Python. Try it by hand:
  `python3 host_checks.py mbp ~/git-repos/internal-repos/hermes-desktop-iac/conformance.yaml`.

The Operations plugin's Conformance tab reads the table.

## Desktop plugin

`desktop-plugin/` — a Hermes desktop app disk plugin that surfaces this
dashboard inside the app: a statusbar chip with rolling t/s plus a `metrics`
pane with per-model stats. One file, no build step:

    cd desktop-plugin && ./install.sh http://YOUR_DASHBOARD_HOST:8899

See `desktop-plugin/README.md` for manual install and configuration.

## Hermes-side configuration (both machines)

- `~/.hermes/config.yaml`:
  - `hooks:` → `post_api_request` / `api_request_error` / `subagent_stop`
    all run `~/.hermes/hooks/metrics-emit.py`; `hooks_auto_accept: true`
  - `moa.save_traces: true` is optional and produces audit-only traces; MoA
    metrics do not depend on it.
  - `dashboard.show_token_analytics: true` (unlocks Hermes' own token/cost
    analytics pages — separate from this dashboard)
- Fork patch (in a Hermes fork's FORK_CHANGELOG.md): MoA
  writes an always-on compact record to `~/.hermes/metrics/moa-refs.jsonl`
  every MoA turn, including per-reference `duration_s`.

## Deploy

Install the hook on every machine that runs Hermes before enabling the three
hook events in `~/.hermes/config.yaml`:

    mkdir -p ~/.hermes/hooks
    cp hooks/metrics-emit.py ~/.hermes/hooks/metrics-emit.py
    chmod +x ~/.hermes/hooks/metrics-emit.py

Dashboard host (dashboard + forwarder; the plist templates use a `<user>`
placeholder):

    rsync -a --delete app.py env_mode.py forwarder.py benchmark.py host_checks.py hooks/ static/ scripts/ launchd/ docs/ <user>@<dashboard-host>:hermes-metrics-dash/
    ssh <user>@<dashboard-host> '
      mkdir -p ~/.hermes/hooks
      cp ~/hermes-metrics-dash/hooks/metrics-emit.py ~/.hermes/hooks/metrics-emit.py
      chmod +x ~/.hermes/hooks/metrics-emit.py
      cd ~/hermes-metrics-dash
      sed "s|<user>|$USER|" launchd/ai.hermes.metricsdash.plist > ~/Library/LaunchAgents/ai.hermes.metricsdash.plist
      sed "s|<user>|$USER|" launchd/ai.hermes.metricsfwd.plist > ~/Library/LaunchAgents/ai.hermes.metricsfwd.plist
      launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.metricsdash.plist
      launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.metricsfwd.plist'

Other Macs (forwarder only; set `METRICS_DASH_URL` in the plist to the
dashboard host first):

    sed "s|<user>|$USER|" launchd/ai.hermes.metricsfwd.plist > ~/Library/LaunchAgents/ai.hermes.metricsfwd.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.metricsfwd.plist

Restart after code changes: `launchctl kickstart -k gui/$(id -u)/ai.hermes.metricsdash`
(and `.metricsfwd` respectively).

## Health findings history & weekly digest

The compression page's Health & Recommendations rules (R1–R13) are also run
server-side every 30 min and persisted to the `health_findings` table, so
warnings outlive the browser tab (`METRICS_HEALTH_SNAPSHOTS=0` disables).

**Where it appears**

- Health Trends card on the compression page — 7-day rollup per rule, backed
  by `GET /api/findings?days=7`. Hover "how this works" in the card header
  for the short version of this section.
- Weekly digest on the dashboard host: `~/hermes-metrics-dash/docs/health-digest-<ISO week>.md`
  — rule rollup (act-on vs aware-only) plus standardized session deep-dives
  (status / shape / tokens / loop verdict / pool impact / concerns /
  recommendation) for the top 3 sessions by cumulative input tokens
  (≥25 api calls in the window).

**Triggering**

- Automatic: snapshots every 30 min (in the dashboard process); digest
  on whatever schedule you give `scripts/health_weekly_digest.py` (cron or a
  launchd job, e.g. `ai.hermes.healthdigest`).
- Manual digest: `cd ~/hermes-metrics-dash && /usr/bin/python3 scripts/health_weekly_digest.py`
  (on the dashboard host; `--days N`, `--deepdives N`, `--out PATH` to override).
- Force the scheduled job now: `launchctl kickstart gui/$(id -u)/ai.hermes.healthdigest`
- One session on demand: `/usr/bin/python3 scripts/session_deepdive.py --session <id-or-prefix> --days 1`

**Logs & raw data** (all on the mini)

- `~/.hermes/logs/healthdigest.log` / `.err.log` — digest job output.
- `~/.hermes/logs/metricsdash.err.log` — snapshot failures + retention pruning.
- Raw history: `health_findings` table in `~/.hermes/metrics/metrics.db`
  (30-day retention, same as records).

## Operations filters

Use the Host, Search, Event, and Range controls together to narrow the live and
historical views. Click a model legend or a conversation's focus chip for a
focused view; click it again or use **clear all** to reset filters.

## Record kinds

| kind | source | meaning |
|---|---|---|
| `api` | post_api_request hook | one LLM request (main agent or subagent session) |
| `moa_turn` | post_api_request hook (provider `moa`) | a full MoA facade turn; usage = aggregator's, duration = fan-out + aggregation |
| `moa_ref` | moa-refs.jsonl | one MoA proposer call: its own model, tokens, duration_s, tok/s |
| `moa_agg` | moa-refs.jsonl | which real model acted as aggregator that turn |
| `error` | api_request_error hook | failed request with duration + error text |
| `guardrail_halt` | agent.log tail | turn ended `reason=guardrail_halt` (tool guardrail stopped a repeated identical failing call); error text carries api-call / tool-turn counts |
| `guardrail_block` | agent.log tail | single tool call blocked by the guardrail; `label` = tool, error text carries the guardrail code when the log line wasn't truncated |
| `subagent_stop` | subagent_stop hook | child-session completion, links child → parent |
| `host_stats` | forwarder sampling (~30s) | per-machine CPU load + memory used/total |

Records are also stamped with `device` (which LM Link peer actually served the
model, via `lms ps/link status --json`), `cost_usd` (session's cumulative
estimated cost from state.db), and — when the provider populates them —
`ttft_s` / `tps_native` / `spec_accept_rate` from the response `stats` object
(LM Studio 0.4.x REST currently sends an empty `stats`; the fork passes it
through so these light up automatically on builds that fill it in).

Subagent grouping: records carry `parent_session_id` (enriched from
state.db), and the UI nests those sessions under their root conversation.

## Environment mode toggles

Overview controls include three **Env mode** buttons that patch Hermes
`config.yaml` on Mini and MBP, then restart the Mini gateway only:

| Mode | Effect |
|---|---|
| `optimized-moa` | MoA `test` with tighter compression (`threshold=0.4`, `protect_last_n=10`, `moa.max_tokens=1024`); `agent.max_turns=30` |
| `single-model` | Acting agent → host-local LM Studio 35B distill (`127.0.0.1:1234`); `agent.max_turns=90`; MoA block kept for restore. Mini is primary; MBP local gateway/model only if Mini is unavailable. |
| `restore-current` | Restore frozen baseline snapshot under `~/.hermes/metrics/env-modes/` |

Apply flow: preview diff → type the exact mode id → POST `/api/env-mode`.
Writes need the admin token (see "Write and ingest auth" below); the
:8899 page is read-only and points to Hermes Desktop > Metrics. Optional env overrides: `ENV_MODE_MBP_SSH`, `ENV_MODE_MBP_CONFIG`,
`ENV_MODE_MBP_IDENTITY` (default `~/.ssh/id_ed25519`); `ENV_MODE_MBP_SSH` (`user@host`) is required for MBP sync,
`ENV_MODE_MINI_CONFIG`, `ENV_MODE_STATE_DIR`, `ENV_MODE_BACKUP_ROOT`.
The first applied mode seeds the restore baseline from the live Mini config,
captured before that mode's changes. `GET /api/env-mode` writes nothing.

## Operational assumptions and limits

- Write and ingest auth. `--bind` / `METRICS_BIND` is a comma-separated list
  (default `127.0.0.1`; e.g. `127.0.0.1,<tailscale-ip>` for loopback
  plus Tailscale). An address that is not up yet (Tailscale after boot) is
  retried every 30 s. This is no longer a trusted LAN service, but reads are
  still unauthenticated and responses still send
  `Access-Control-Allow-Origin: *`, so do not bind `0.0.0.0` or expose it
  beyond loopback and Tailscale.
  - Dashboard writes (`/api/env-mode`, `/api/usage-map`,
    `/api/beta-widgets/decision`, `/api/benchmark/mark`, `/api/harness/mark`)
    need `Authorization: Bearer <admin token>`, from `METRICS_ADMIN_TOKEN` or
    `~/.hermes/metrics/admin.token` (create it with `./auth_tokens.py admin-init`).
    With no token they return 503. Only the metrics-dashboard plugin holds it: its
    `POST /api/plugins/metrics-dashboard/write/<name>` routes sit behind Hermes
    session auth (web dashboard or Hermes Desktop) and relay to the collector.
  - `POST /ingest` takes a per-sender token tied to the host labels it may
    report as: `./auth_tokens.py ingest-issue mini --hosts mini,mbp --out
    ~/.hermes/metrics/ingest.token`. For another machine, run it without
    `--out` and pipe stdout to that machine's `~/.hermes/metrics/ingest.token`
    (mode 0600). Senders read `METRICS_INGEST_TOKEN` or that file on each post.
    Only sha256 digests are stored (`ingest-tokens.json`, re-read per request;
    `ingest-list`, `ingest-revoke <sender>`). `METRICS_INGEST_AUTH=warn` (the
    default) accepts unsigned posts and logs each (host, problem) at most hourly
    to stderr; `enforce` rejects them with 401.
  - `/ingest/hermes-webhook` keeps its own HMAC secret.
- Metrics retention is unbounded: SQLite has no automatic pruning. Monitor
  `~/.hermes/metrics/metrics.db` and implement an external retention policy if
  disk growth matters.
- The launchd plists contain hard-coded interpreter, checkout, user, and log
  paths for the current hosts. Review and edit those paths before deployment
  under another account or checkout location.

## Widget Lab carry-over demos

`static/demo-widget-lab.html` (linked from the overview rail) is a mock-data
gallery of the Widget Lab frames that fit this plugin: findings, empty ingest,
MoA fan-out and the other carry-over charts (hover points/lines for values), DSv4 role router, request volume, health-rule heatmap, duration
ceiling, context + flash/pro, tool graph, cost + errors. Mapping and skip list:
`docs/WIDGET-LAB-CARRY.md`. Isolated labs (not on Overview yet):
`/static/demo-runs.html` (request volume), `/static/demo-context.html`
(context growth), `/static/demo-memory.html` (KV pool + efficiency),
`/static/demo-speed.html` (tok/s isolation: IQR bands, lanes, heatmap),
`/static/demo-fan.html` (MoA radial fan-out), and `/static/demo-router.html`
(live role router: family sankey + role usage).

## Compression & Memory page

`static/compression.html` (linked from the top nav) is a self-contained page over
the same `/api/recent` endpoint: per-machine RAM vs capacity (`host_stats`),
KV-pool pressure (concurrent in-flight context per model vs its loaded ctx),
per-session context growth with compaction (▼) and error (cross) markers, and
LM Link model residency. Model size/ctx/parallel are a `LOAD_SETTINGS` constant
in the file — update it when models are reloaded with different settings.

## Roadmap — more detail

1. **Failed compression attempts** — currently only successful compactions are
   visible (as token drops between consecutive api records). The "Compression
   summary failed" events live only in the agent logs; teaching `forwarder.py`
   to emit a `compression` event from the hooks pipeline would let the page
   show attempts vs. successes directly.
2. **True KV cache memory** — model weight sizes are static constants;
   LM Studio doesn't report actual KV allocation. A tiny sampler hitting
   `lms ps` on an interval could stream real per-model footprints.
3. **Cross-links** — click-a-session on the compression page → jump to that
   conversation in the overview's convo view.
