/**
 * metrics-dashboard — Hermes desktop plugin (v0.5.0).
 * Live LLM metrics: a statusbar chip with rolling tokens/sec + ONE merged
 * pane ("Option G1" single-column layout, see hermes-dashboard-mockups.html):
 * Pulse header (Tiles+: idle compact; busy shows KPI tiles + sparkline +
 * per-model rows, height animates on quiet↔busy). The retired model-router
 * Roles/MoA/Notes/DSv4 sections were removed — the model-router desktop
 * plugin owns that surface now.
 *
 * Data now comes from this plugin's own backend namespace
 * (/api/plugins/metrics-dashboard/) via ctx.rest — no more raw fetch() to a
 * CORS-open LAN endpoint and no install-time DEFAULT_API sed-patch. The
 * dashboard server URL is configured server-side (METRICS_DASH_URL env on
 * the Hermes backend; see plugin/metrics_core.py). The footer's "reload
 * config" action probes the backend's /router-view interop route and POSTs
 * the gated /router-reload proxy.
 *
 * INSTALL: run ./install-plugin.sh at the repo root (copies both halves),
 * then add metrics-dashboard to plugins.enabled in ~/.hermes/config.yaml and
 * restart the desktop app.
 *
 * ctx.storage keys this plugin reads:
 *   dashboardUrl       — where the footer's "dashboard ↗" action points
 *                        (default http://192.0.2.10:8899)
 *   g1MetricsCollapsed — '1' collapses the "Metrics" section
 *   g1LastSeenTs       — unix seconds of the newest api record this pane has
 *                        seen (survives idle hours so "last request" can
 *                        still render). Untrusted plugin storage: validated
 *                        on read and write by parseLastSeenTs (finite unix
 *                        seconds, not in the far past/future).
 *
 * Live updates: a WebSocket to the backend's /events stream (ctx.socket)
 * pushes new records as they land; the 10s poll stays as the fallback for
 * OAuth remotes where ctx.socket is a no-op, and backs off to 60s once a
 * frame confirms the socket is live. Socket frames and poll responses merge
 * through ONE path (mergePayload), so the two sources never double-append.
 * Plain ESM, loaded uncompiled — jsx() calls only, no JSX syntax.
 */

import { atom, cn, haptic, host, queryClient, Tip, useQuery, useValue } from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'metrics-dashboard'
const POLL_MS = 10_000 // poll cadence until a socket frame confirms live push
const LIVE_POLL_MS = 60_000 // backed-off fallback cadence once the socket is live
const WINDOW_S = 3600 // matches the /recent ?hours=1 window
const SPARK_N = 12 // 5-minute buckets across WINDOW_S
const REVEAL_MS = 220 // quiet↔busy + section expand/collapse (enter)
const REVEAL_EXIT_MS = 160 // collapse/exit — faster than enter so swaps clear
const BAR_MS = 400 // token-share bar width settle on poll refresh
const FRESH_S = 10 // pulse window: a status dot pulses only while a request landed <= this many seconds ago
const MAX_RECORDS = 500 // matches the /recent ?limit=500 cap
const RECENT_KEY = [ID, 'recent']
const ROUTER_VIEW_KEY = [ID, 'router-view']
// Last-resort fallback for the "dashboard ↗" link when neither the
// storage['dashboardUrl'] override nor the backend-resolved /health base_url
// is available. The real source is resolved by metrics_core (env → probe).
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:8899'

// Semantic colors: the desktop theme is not guaranteed to define success/
// error vars, so each var() carries a hex fallback (green/red/grey dots,
// "no live model" text). Everything else uses the theme's --ui-* classes.
const DOT_LIVE = 'var(--ui-success, #30a46c)'
const DOT_DOWN = 'var(--ui-error, #e5484d)'

// Tolerate both `{ records: [...] }` and bare `[...]` shapes.
function recordsOf(data) {
  if (Array.isArray(data)) {
    return data
  }

  return data?.records ?? data?.items ?? []
}

// Records carry no row id, so identity is a content fingerprint: the same
// record arriving from the poll window and a pushed frame collapses into one.
// Both are serialized by the same backend from the same dicts, so key order
// is stable across the two paths.
function recordKey(r) {
  return JSON.stringify(r)
}

// The ONE record merge/dedupe path — poll responses and socket frames both
// funnel through mergePayload, so the two sources can never double-append.
// Dedupe, sort oldest->newest, then trim to the ?hours=1 window (anchored at
// the newest record's own ts, not the client clock) and the ?limit=500 cap.
function mergeRecords(existing, incoming) {
  const byKey = new Map()
  for (const r of existing) byKey.set(recordKey(r), r)
  for (const r of incoming) byKey.set(recordKey(r), r) // incoming wins ties
  const merged = [...byKey.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  const newest = merged.length ? merged[merged.length - 1].ts ?? 0 : 0
  return merged.filter(r => (r.ts ?? 0) >= newest - WINDOW_S).slice(-MAX_RECORDS)
}

// Normalize + merge any /recent-shaped payload (poll response or socket
// frame). prev == null means a full-window replace (the poll is authoritative
// for what aged out); otherwise delta-merge the frame over the cached list.
function mergePayload(prev, payload) {
  if (!payload || payload.available === false) {
    return payload
  }
  const incoming = recordsOf(payload)
  if (prev && incoming.length === 0) {
    return prev
  }
  return { ...payload, records: mergeRecords(recordsOf(prev), incoming) }
}

function summarize(data) {
  const records = recordsOf(data).filter(r => r.kind === 'api' || r.kind === 'router_request')
  let tokens = 0
  let tpsSum = 0
  let tpsN = 0
  const byModel = new Map()

  for (const r of records) {
    const out = r.output_tokens ?? r.completion_tokens ?? r.tokens_out ?? 0
    tokens += out

    // tps can be null on LM Studio 0.4.x builds — fall back to out/duration.
    const tps = (typeof r.tps === 'number' && r.tps > 0)
      ? r.tps
      : (typeof r.tokens_per_sec === 'number' && r.tokens_per_sec > 0)
        ? r.tokens_per_sec
        : (r.duration_s > 0 && out > 0 ? out / r.duration_s : null)
    if (tps) {
      tpsSum += tps
      tpsN += 1
    }

    const model = r.model ?? 'unknown'
    const m = byModel.get(model) ?? { model, requests: 0, tokens: 0, tpsSum: 0, tpsN: 0 }
    m.requests += 1
    m.tokens += out

    if (typeof tps === 'number' && tps > 0) {
      m.tpsSum += tps
      m.tpsN += 1
    }

    byModel.set(model, m)
  }

  const models = [...byModel.values()].sort((a, b) => b.tokens - a.tokens)
  return {
    requests: records.length,
    tokens,
    avgTps: tpsN ? tpsSum / tpsN : null,
    // KPI strip's "best t/s": the fastest per-model average in the window.
    bestTps: models.reduce(
      (best, m) => (m.tpsN ? Math.max(best, m.tpsSum / m.tpsN) : best), 0) || null,
    newestTs: newestApiTs(records),
    models
  }
}

function fmt(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

// The three selectable metrics for the busy-state bar chart. The KPI tiles
// double as the selector; `kpi` is the tile's headline value and `label` is
// both the tile caption and the bar-chart axis label.
const METRICS = {
  requests: { label: 'requests', kpi: (s) => String(s.requests) },
  tokens: { label: 'output tok', kpi: (s) => fmt(s.tokens) },
  tps: { label: 'best t/s', kpi: (s) => (s.bestTps ? s.bestTps.toFixed(1) : '—') }
}
const validMetric = (m) => (m === 'tokens' || m === 'tps' ? m : 'requests')

// Pulse helpers live IN this file (not a sibling module). Hermes disk
// plugins are blob-imported; relative `./pulse-helpers.js` does not resolve.
// tests/pulse-helpers.test.js extracts this marked block and evals it so
// there is one source of truth and no window.* export.
/* pulse-helpers-start */
// metricBuckets buckets request records (api + router_request — the router
// exec log is the only trail for hook-less local-model calls) over the window
// and aggregates a chosen metric per slot: 'requests' counts, 'tokens' sums
// output tokens, 'tps' keeps the best (max) t/s. sparkBuckets is the
// 'requests' specialization.
function metricBuckets(records, now, metric, opts) {
  const nRaw = opts && opts.n != null ? opts.n : SPARK_N
  const n = Number.isFinite(nRaw) && nRaw >= 1 ? Math.floor(nRaw) : SPARK_N
  const wRaw = opts && opts.windowS != null ? opts.windowS : WINDOW_S
  if (!(wRaw > 0) || !Number.isFinite(wRaw) || !Number.isFinite(now)) {
    return new Array(n).fill(0)
  }
  const width = wRaw / n
  const start = now - wRaw
  const out = new Array(n).fill(0)
  for (const r of records || []) {
    if (r.kind && r.kind !== 'api' && r.kind !== 'router_request') continue
    const ts = r.ts
    if (typeof ts !== 'number' || !Number.isFinite(ts)) continue
    if (ts < start) continue
    let i = Math.floor((ts - start) / width)
    if (i < 0) i = 0
    if (i >= n) i = n - 1
    if (metric === 'tokens') {
      out[i] += r.output_tokens ?? r.completion_tokens ?? r.tokens_out ?? 0
    } else if (metric === 'tps') {
      const tok = r.output_tokens ?? r.completion_tokens ?? r.tokens_out ?? 0
      const tps = (typeof r.tps === 'number' && r.tps > 0)
        ? r.tps
        : (typeof r.tokens_per_sec === 'number' && r.tokens_per_sec > 0)
          ? r.tokens_per_sec
          : (r.duration_s > 0 && tok > 0 ? tok / r.duration_s : null)
      if (tps) out[i] = Math.max(out[i], tps)
    } else {
      out[i] += 1
    }
  }
  return out
}

function sparkBuckets(records, now, opts) {
  return metricBuckets(records, now, 'requests', opts)
}

function relAge(ts, now) {
  if (ts == null || ts <= 0) return null
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return null
  const s = Math.max(0, now - ts)
  if (s < 45) return 'just now'
  if (s < 90) return '1m ago'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 5400) return '1h ago'
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  const d = Math.round(s / 86400)
  return d === 1 ? '1d ago' : `${d}d ago`
}

function newestApiTs(records) {
  let newest = 0
  for (const r of records || []) {
    if (r.kind && r.kind !== 'api' && r.kind !== 'router_request') continue
    const ts = r.ts
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > newest) newest = ts
  }
  return newest || null
}

function hourBusy(summary) {
  return !!(summary && summary.requests > 0)
}

// Recency gate for the pulse: true only while `ts` is within `windowS`
// seconds of `now` (and not in the future). Decoupled from hourBusy — an
// hour-window "busy" keeps the dot green, but it only PULSES while a request
// is fresh. Future timestamps (clock skew) and non-finite inputs are not
// fresh. windowS defaults to 10.
function freshWithin(ts, now, windowS) {
  if (ts == null || ts <= 0) return false
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return false
  const win = Number.isFinite(windowS) && windowS > 0 ? windowS : 10
  const age = now - ts
  return age >= 0 && age <= win
}

// ctx.storage is renderer-local and attacker-writable via devtools. Accept
// only finite integer unix seconds after ~2001-09-09 (1e9) and not more
// than one hour ahead of `now` (clock skew). Anything else → 0 (idle copy
// falls back to "no requests this hour").
function parseLastSeenTs(raw, now) {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n !== Math.trunc(n)) return 0
  const clock = typeof now === 'number' && Number.isFinite(now) ? now : Date.now() / 1000
  if (n <= 1e9 || n > clock + 3600) return 0
  return n
}
/* pulse-helpers-end */

function reduceMotion() {
  return typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
}

// web-haptics is absent on some remotes / browser shells; never let a
// missing bridge take down the pane.
function safeHaptic(intent) {
  try {
    haptic(intent)
  } catch {
    /* ignore */
  }
}

// Height + fade for quiet↔busy and section expand/collapse.
//
// Stay mounted while closed: unmounting on hide made the next show a first
// paint, which skipped the enter (idle→busy and section expand never moved).
// First paint still matches `show` so a reload of a busy pane does not replay.
//
// Motion is inline styles only. Disk plugins are blob-loaded (no sidecar CSS).
// Injecting <style> into document.head would leak across plugin unload/reload
// and is the wrong layer when the same values already live on the node.
// Honor prefers-reduced-motion here: Hermes also zeros transition-duration
// globally, but we must not depend on that remaining true.
function Reveal({ show, children }) {
  const skip = useRef(true)
  const [open, setOpen] = useState(!!show)
  const reduce = reduceMotion()
  // Asymmetric timing: enter eases out over REVEAL_MS, exit is shorter with
  // ease-in. Where two Reveals swap (one section closing as another opens),
  // the outgoing block is
  // mostly gone before the incoming one grows, instead of both fighting for
  // height at the same rate.
  const dur = reduce ? '0ms' : `${open ? REVEAL_MS : REVEAL_EXIT_MS}ms`
  const ease = open ? 'ease-out' : 'ease-in'

  useLayoutEffect(() => {
    if (skip.current) {
      skip.current = false
      setOpen(!!show)
      return
    }
    if (!show) {
      setOpen(false)
      return
    }
    let cancelled = false
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) setOpen(true)
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(id)
    }
  }, [show])

  return jsx('div', {
    'data-open': open ? '1' : '0',
    'aria-hidden': open ? undefined : true,
    style: {
      display: 'grid',
      gridTemplateRows: open ? '1fr' : '0fr',
      transition: `grid-template-rows ${dur} ${ease}`
    },
    children: jsx('div', {
      style: { overflow: 'hidden', minHeight: 0 },
      children: jsx('div', {
        style: {
          opacity: open ? 1 : 0,
          transform: open ? 'translateY(0)' : 'translateY(8px)',
          transition: `opacity ${reduce ? '0ms' : open ? '180ms' : '120ms'} ${ease}, transform ${dur} ${ease}`
        },
        children
      })
    })
  })
}

// Colored status dot. Background cross-fades instead of snapping when the
// state flips; `pulse` runs a slow opacity loop while live. @keyframes are
// off-limits here (inline styles only — see Reveal), so the pulse rides the
// Web Animations API, guarded: a shell without el.animate or a
// prefers-reduced-motion user just gets a steady dot.
function StatusDot({ color, pulse, className }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!pulse || !el || typeof el.animate !== 'function' || reduceMotion()) return
    const anim = el.animate(
      [{ opacity: 1 }, { opacity: 0.35 }, { opacity: 1 }],
      { duration: 2000, iterations: Infinity, easing: 'ease-in-out' }
    )
    return () => anim.cancel()
  }, [pulse])
  return jsx('span', {
    ref,
    className,
    style: { background: color, transition: 'background 300ms ease-out' }
  })
}

function BarChart({ values, now, metric }) {
  const [hover, setHover] = useState(null)
  const w = 228
  const h = 28
  const max = Math.max(1, ...values)
  const n = values.length
  const bw = w / n
  const width = WINDOW_S / n
  const start = now - WINDOW_S
  const clock = (t) =>
    new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const val = (v) =>
    metric === 'tokens' ? fmt(v) : metric === 'tps' ? v.toFixed(1) : String(v)
  const label =
    hover == null
      ? `${METRICS[metric].label} / 5 min · last hour`
      : `${clock(start + hover * width)}–${clock(start + (hover + 1) * width)} · ${val(values[hover])} ${METRICS[metric].label}`
  return jsx(Tip, {
    label,
    children: jsx('svg', {
      className: 'h-7 w-full',
      viewBox: `0 0 ${w} ${h}`,
      preserveAspectRatio: 'none',
      'aria-hidden': true,
      onMouseLeave: () => setHover(null),
      children: values.map((v, i) => {
        const hgt = (v / max) * (h - 6)
        return jsx('rect', {
          key: i,
          x: i * bw + 1,
          y: h - 3 - hgt,
          width: Math.max(1, bw - 2),
          height: hgt,
          rx: 1,
          fill: 'var(--ui-accent, currentColor)',
          onMouseEnter: () => setHover(i)
        })
      })
    })
  })
}

// A /recent response can be a 200 with available:false (mini unreachable) —
// treat that the same as a transport error.
function isDown(data, isError) {
  return isError || (data != null && data.available === false)
}

// --- Router interop helpers -------------------------------------------------
// /router-view payload (backend plugin/dashboard/plugin_api.py):
//   { available, source, status: {...}, usage: {...}, usage_1h: {...}, notes: {...} }
// Only `available` is consumed here (header title + footer "reload config");
// status/usage/notes exist for the model-router plugin's own surfaces.

function routerSections(rv) {
  // Only the availability flag is consumed now (header title + footer
  // "reload config"); the retired Roles/MoA/Notes sections no longer render.
  const up = !!(rv && rv.available === true)
  return { up }
}

// ---------------------------------------------------------------------------

export default {
  id: ID, // must match the folder name
  name: 'Metrics Dashboard',
  register(ctx) {
    const storage = ctx.storage
    // G1 section collapse state, persisted per section.
    const g1MetricsCollapsed = atom(storage.get('g1MetricsCollapsed', '0') === '1')
    const g1LastSeenTs = atom(parseLastSeenTs(storage.get('g1LastSeenTs', '0')))
    const g1Metric = atom(validMetric(storage.get('g1Metric', 'requests')))
    // Resolved metrics-source base URL from the backend's /health, so the
    // footer "dashboard ↗" link follows whatever source the backend resolved
    // (env → probe → …) instead of a hardcoded default. An explicit
    // storage['dashboardUrl'] still wins. Refreshed lazily + on a slow timer
    // so a topology change (mini appears/disappears) is reflected within a
    // few minutes.
    const dashboardBaseUrl = atom('')

    function refreshDashboardUrl() {
      ctx.rest('/health')
        .then(h => {
          if (h && h.available && h.base_url) dashboardBaseUrl.set(h.base_url)
        })
        .catch(() => { /* keep the last known value / fall back */ })
    }

    function dashboardUrl() {
      return storage.get('dashboardUrl', '') || dashboardBaseUrl.get() || DEFAULT_DASHBOARD_URL
    }

    refreshDashboardUrl()
    // SDK has no top-level teardown hook (ctx exposes register/socket disposers
    // only), so the periodic URL refresh simply idles for the plugin's lifetime.
    setInterval(refreshDashboardUrl, 5 * 60 * 1000)

    function fetchRecent() {
      // Full-window replace — the poll is authoritative for what aged out.
      return ctx.rest('/recent?hours=1&limit=500').then(data => mergePayload(null, data))
    }

    function fetchRouterView() {
      return ctx.rest('/router-view')
    }

    // G1 footer "reload config": POSTs the backend's /router-reload proxy
    // (daemon POST /router/reload). The write gate lives server-side; a 403
    // means MODEL_ROUTER_ALLOW_WRITE is off on the backend.
    function reloadRouterConfig() {
      return ctx.rest('/router-reload', { method: 'POST' })
        .then(out => {
          host.notify({
            kind: 'success',
            message: `router config reloaded — ${(out?.roles ?? []).length} roles live`
          })
          queryClient.invalidateQueries({ queryKey: ROUTER_VIEW_KEY })
        })
        .catch(err => {
          const msg = String(err?.message ?? err ?? '')
          if (/403|ALLOW_WRITE|writes are disabled/i.test(msg)) {
            host.notify({
              kind: 'warning',
              message: 'router writes are gated off',
              detail: 'set MODEL_ROUTER_ALLOW_WRITE=1 on the backend to enable'
            })
          } else {
            host.notifyError(err, 'router reload failed')
          }
        })
    }

    // Instant-updates channel: the backend's /events stream pushes only
    // records the client has not seen (server-side watermark tail over the
    // same metrics source /recent reads). Frames merge into the shared
    // RECENT_KEY cache through the same mergePayload path the poll uses, so
    // the UI re-renders immediately and nothing double-appends. ctx.socket is
    // a no-op on OAuth remotes — the poll above stays the fallback there.
    // Once any frame arrives the socket is confirmed live and the poll backs
    // off to LIVE_POLL_MS; an unavailable frame (metrics source down) drops
    // back to the fast cadence so recovery shows promptly.
    const socketLive = atom(false)

    function onEventsFrame(data) {
      if (!data || typeof data !== 'object') {
        return
      }
      socketLive.set(data.available !== false)
      queryClient.setQueryData(RECENT_KEY, prev => mergePayload(prev, data))
    }

    // ctx.socket returns a disposer; the SDK has no top-level teardown hook, so
    // the socket lives for the plugin's lifetime (the backend reclaims it).
    ctx.socket('/events', onEventsFrame)

    function MetricsChip() {
      const live = useValue(socketLive)
      const { data, isError } = useQuery({
        queryKey: RECENT_KEY,
        queryFn: fetchRecent,
        refetchInterval: live ? LIVE_POLL_MS : POLL_MS,
        retry: false
      })

      const down = isDown(data, isError)
      const s = !down && data ? summarize(data) : null

      return jsx(Tip, {
        label: down
          ? 'metrics dashboard unreachable'
          : s
            ? `${s.requests} requests · ${fmt(s.tokens)} tokens (1h) — click to open dashboard`
            : 'metrics — loading…',
        children: jsxs('button', {
          className: cn(
            'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] transition-colors',
            down
              ? 'text-(--ui-text-quaternary)'
              : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          type: 'button',
          onClick: () => { void ctx.os.openExternal(dashboardUrl()) },
          children: [
            jsx('svg', {
              className: 'size-3',
              viewBox: '0 0 16 16',
              fill: 'currentColor',
              'aria-hidden': true,
              children: jsx('path', { d: 'M9 1 3 9h4l-1 6 6-8H8z' })
            }),
            jsx('span', {
              children: down ? 'metrics down' : s?.avgTps ? `${s.avgTps.toFixed(1)} t/s` : '…'
            })
          ]
        })
      })
    }

    // --- G1 pane building blocks ---------------------------------------------

    // Collapsible section shell: ▸/▾ header + body, same toggle idiom the
    // retired RouterSection used. Collapse state persists via ctx.storage.
    function Section({ title, collapsed, onToggle, first, children }) {
      return jsxs('div', {
        className: cn(!first && 'border-t border-(--ui-stroke-secondary) pt-2'),
        children: [
          jsxs('button', {
            className: 'flex w-full items-center gap-1 text-left font-medium hover:text-foreground',
            type: 'button',
            'aria-expanded': !collapsed,
            onClick: onToggle,
            children: [
              // One glyph rotating in sync with the Reveal below it, instead
              // of a ▸/▾ character swap — header and body move as one gesture.
              jsx('span', {
                className: 'text-(--ui-text-quaternary)',
                style: {
                  display: 'inline-block',
                  transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                  transition: reduceMotion()
                    ? undefined
                    : `transform ${collapsed ? REVEAL_EXIT_MS : REVEAL_MS}ms ${collapsed ? 'ease-in' : 'ease-out'}`
                },
                children: '▸'
              }),
              jsx('span', { children: title })
            ]
          }),
          jsx(Reveal, {
            show: !collapsed,
            children: jsx('div', { className: 'mt-1 flex flex-col gap-1', children })
          })
        ]
      })
    }

    function Kpi({ value, label, active, onSelect }) {
      return jsxs('button', {
        type: 'button',
        onClick: onSelect,
        'aria-pressed': active,
        className: 'flex-1 rounded border px-2 py-1 text-left',
        style: {
          cursor: 'pointer',
          borderColor: active ? 'var(--ui-success, #30a46c)' : 'var(--ui-stroke-secondary)',
          opacity: active ? 1 : 0.55
        },
        children: [
          // tabular-nums so a 9→10 tick on poll does not shimmer the layout.
          jsx('div', {
            className: 'text-sm font-medium tabular-nums',
            style: active ? { color: 'var(--ui-success, #30a46c)' } : undefined,
            children: value
          }),
          jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: label
          })
        ]
      })
    }

    function ModelRow({ m, totalTokens }) {
      const share = totalTokens > 0
        ? Math.min(100, Math.max(2, Math.round((100 * m.tokens) / totalTokens)))
        : 0
      return jsxs('div', {
        className: 'border-b border-(--ui-stroke-secondary) py-1 last:border-0',
        children: [
          jsxs('div', {
            className: 'flex items-baseline justify-between gap-2',
            children: [
              jsx('span', { className: 'truncate font-mono text-xs', children: m.model }),
              jsx('span', {
                className: 'shrink-0 text-xs text-(--ui-text-tertiary)',
                children: [
                  `${m.requests} req · ${fmt(m.tokens)} tok`,
                  m.tpsN ? ` · ${(m.tpsSum / m.tpsN).toFixed(1)} t/s` : ''
                ].join('')
              })
            ]
          }),
          // Token-share bar under the model name (G1 mockup). Width settles
          // instead of teleporting when a poll shifts the shares.
          jsx('div', {
            className: 'mt-0.5 h-1 overflow-hidden rounded bg-(--ui-stroke-secondary)',
            children: jsx('div', {
              className: 'h-full rounded bg-(--ui-accent)',
              style: {
                width: `${share}%`,
                transition: reduceMotion() ? undefined : `width ${BAR_MS}ms ease-out`
              }
            })
          })
        ]
      })
    }

    function MetricsPane() {
      const gateway = useValue(host.state.gateway)
      const model = useValue(host.state.model)
      const live = useValue(socketLive)
      const metricsCollapsed = useValue(g1MetricsCollapsed)
      const lastSeen = useValue(g1LastSeenTs)
      const metricSel = useValue(g1Metric)
      const { data, isError, error } = useQuery({
        queryKey: RECENT_KEY,
        queryFn: fetchRecent,
        refetchInterval: live ? LIVE_POLL_MS : POLL_MS,
        retry: false
      })
      const routerView = useQuery({
        queryKey: ROUTER_VIEW_KEY,
        queryFn: fetchRouterView,
        refetchInterval: POLL_MS,
        retry: false
      })
      const down = isDown(data, isError)
      // summarize() walks up to MAX_RECORDS records and sorts per model — the
      // most expensive derivation in the pane. Memoize it so the ticker (and
      // any unrelated re-render) doesn't re-run it; it only changes when the
      // record set or the down/error state flips.
      const s = useMemo(() => (!down && data ? summarize(data) : null), [down, data])
      const busy = hourBusy(s)
      const nowSec = Date.now() / 1000
      const lastLabel = relAge(s?.newestTs || lastSeen, nowSec)
      // Pulse only while a request is fresh (<= FRESH_S ago), decoupled from
      // the hour-window `busy`: the dot stays green for the whole hour but
      // stops pulsing ~10s after the newest request.
      const activeNow = !down && freshWithin(s?.newestTs, nowSec, FRESH_S)
      // metricBuckets() is the second MAX_RECORDS walk in the render path.
      // Buckets are 5-minute wide, so re-bucketing every 15s is visually
      // identical to doing it every 1s — snap "now" to a 15s grid and memoize
      // so the ticker doesn't recompute it each second.
      const bucketNow = Math.floor(nowSec / 15) * 15
      const barValues = useMemo(
        () => metricBuckets(recordsOf(data), bucketNow, metricSel),
        [data, bucketNow, metricSel]
      )

      // Adaptive ticker: 1s while a request is fresh (the pulse + "just now"
      // label need sub-second freshness), else a lazy 30s — the "last request
      // Xm ago" label only changes per minute, so re-rendering an idle pane
      // 60x/min to advance it was pure waste. Re-keying on activeNow flips the
      // cadence the moment a socket frame lands (activeNow goes true) or the
      // request ages out of the pulse window.
      const [, setTick] = useState(0)
      useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), activeNow ? 1000 : 30_000)
        return () => clearInterval(id)
      }, [activeNow])
      const rv = routerSections(routerView.data)
      useEffect(() => {
        const ts = parseLastSeenTs(s?.newestTs)
        if (ts && ts > g1LastSeenTs.get()) {
          g1LastSeenTs.set(ts)
          storage.set('g1LastSeenTs', String(ts))
        }
      }, [s?.newestTs])

      const busyHaptic = useRef(null)
      useEffect(() => {
        if (busyHaptic.current == null) {
          busyHaptic.current = busy
          return
        }
        if (busyHaptic.current === busy) return
        busyHaptic.current = busy
        safeHaptic(busy ? 'open' : 'close')
      }, [busy])

      const toggle = (a, key, current) => () => {
        const next = !current
        a.set(next)
        storage.set(key, next ? '1' : '0')
      }

      return jsxs('div', {
        className: 'flex h-full flex-col gap-2 p-3 text-sm',
        children: [
          jsx('div', {
            className: 'font-medium',
            children: rv.up ? 'metrics · model router' : 'metrics'
          }),
          jsxs('div', {
            className: 'min-h-0 flex-1 overflow-y-auto',
            children: [
              jsx(Section, {
                // Status dot lives in the header itself — "last hour" was
                // repeated three times (title, status line, sparkline
                // caption); the caption keeps the window, the dot carries
                // busy/idle/down, and the old status row's line is freed.
                title: jsxs('span', {
                  className: 'flex items-center gap-1.5',
                  children: [
                    jsx(StatusDot, {
                      color: down ? DOT_DOWN : busy ? DOT_LIVE : 'var(--ui-text-quaternary)',
                      pulse: activeNow,
                      className: 'h-1.5 w-1.5 shrink-0 rounded-full'
                    }),
                    jsx('span', { children: 'Metrics' })
                  ]
                }),
                collapsed: metricsCollapsed,
                onToggle: toggle(g1MetricsCollapsed, 'g1MetricsCollapsed', metricsCollapsed),
                first: true,
                children: [
                  down
                    ? jsx('div', {
                        className: 'text-xs text-(--ui-text-tertiary)',
                        children: `dashboard unreachable: ${error?.message ?? data?.error ?? 'unknown error'}`
                      })
                    : jsxs('div', {
                        className: 'flex flex-col gap-1',
                        children: [
                          jsx(Reveal, {
                            show: !busy,
                            children: jsxs('span', {
                              className: 'flex min-w-0 flex-wrap items-baseline gap-x-1.5',
                              children: [
                                jsx('span', {
                                  className: 'font-medium text-(--ui-text-secondary)',
                                  children: 'idle'
                                }),
                                jsx('span', {
                                  className: 'text-xs text-(--ui-text-tertiary)',
                                  children: lastLabel
                                    ? `last request ${lastLabel}`
                                    : 'no requests this hour'
                                })
                              ]
                            })
                          }),
                          jsx(Reveal, {
                            show: busy && !!s,
                            children: s
                              ? jsxs('div', {
                                  className: 'flex flex-col gap-1',
                                  children: [
                                    jsxs('div', {
                                      className: 'flex gap-1.5',
                                      children: Object.keys(METRICS).map(key =>
                                        jsx(Kpi, {
                                          key,
                                          value: METRICS[key].kpi(s),
                                          label: METRICS[key].label,
                                          active: metricSel === key,
                                          onSelect: () => {
                                            g1Metric.set(key)
                                            storage.set('g1Metric', key)
                                          }
                                        }))
                                    }),
                                    jsx(BarChart, {
                                      values: barValues,
                                      now: bucketNow,
                                      metric: metricSel
                                    }),
                                    jsx('div', {
                                      className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
                                      children: `${METRICS[metricSel].label} / 5 min · last hour`
                                    }),
                                    s.models.length > 0
                                      ? jsx('div', {
                                          children: s.models.map(m =>
                                            jsx(ModelRow, { m, totalTokens: s.tokens, key: m.model }))
                                        })
                                      : null
                                  ]
                                })
                              : null
                          })
                        ]
                      })
                ]
              }),
            ]
          }),
          // Footer: connection meta + actions. The gateway line lived
          // mid-scroll inside the Metrics section, where it read as data —
          // it's status, so it sits with the buttons. Labels are short
          // enough that nothing wraps at 260px (the gateway name here also
          // replaces the old "open full dashboard (name)" parenthetical).
          jsxs('div', {
            className: 'mt-auto flex flex-col gap-1',
            children: [
              jsx('div', {
                className: 'truncate text-[0.6875rem] text-(--ui-text-quaternary)',
                children: `gateway: ${gateway} · model: ${model || '—'} · ${live ? 'live' : 'polling'}`
              }),
              jsxs('div', {
                className: 'flex items-center gap-3',
                children: [
                  // "reload" only when router interop is up; disabled with
                  // the gate hint when the backend reports writes gated off.
                  rv.up
                    ? routerView.data?.write_enabled === true
                      ? jsx('button', {
                          className: 'shrink-0 whitespace-nowrap text-xs text-(--ui-accent) hover:underline',
                          type: 'button',
                          onClick: () => void reloadRouterConfig(),
                          children: 'reload config'
                        })
                      : jsx(Tip, {
                          label: 'set MODEL_ROUTER_ALLOW_WRITE=1 on the backend to enable',
                          children: jsx('button', {
                            className: 'cursor-default whitespace-nowrap text-xs text-(--ui-text-quaternary)',
                            type: 'button',
                            disabled: true,
                            children: 'reload config'
                          })
                        })
                    : null,
                  jsx('button', {
                    className: 'shrink-0 whitespace-nowrap text-xs text-(--ui-accent) hover:underline',
                    type: 'button',
                    onClick: () => { void ctx.os.openExternal(dashboardUrl()) },
                    children: 'dashboard ↗'
                  })
                ]
              })
            ]
          })
        ]
      })
    }

    ctx.register({
      id: 'pane',
      area: 'panes',
      title: 'metrics',
      data: { placement: 'right', width: '260px' },
      render: () => jsx(MetricsPane, {})
    })

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 131,
      render: () => jsx(MetricsChip, {})
    })
  }
}
