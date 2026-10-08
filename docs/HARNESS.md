# Model Harness — qwen3.8-27b-hermes

Continuous, config-fingerprinted performance monitoring for the local
Qwen3.8-27b Hermes model, running on LM Studio on the MBP and streaming into
the metrics dashboard on the mini (`http://<dashboard-host>:8899`, Tailscale).

## What it does (one loop, every 5 min by default)

1. **Probe** LM Studio (`/api/v0/models`) for the model's state + runtime
   config (context length, quantization). `harness/lmstudio.py` (Task 2).
2. **Fingerprint** that config into a stable 12-hex `fp` identifying *which*
   runtime configuration produced the numbers. `harness/fingerprint.py` (Task 1).
3. **Benchmark** the model — streaming TTFT + decode tok/s across three prompt
   classes (`short_tool`, `long_gen`, `code_fix`), 2 repeats each.
   `harness/bench.py` (Task 3). Runs **only when LM Studio reports the model
   `loaded`** — an unloaded/missing model skips the bench and the push.
4. **Telemetry** host state: thermal level, memory pressure, swap, power
   source (`harness/telemetry.py`, Task 4) — context for why tok/s dips.
5. **Push** one `harness_sample` record per bench sample to the dashboard's
   `/ingest`; the dashboard page (`static/harness.html`, Task 6) and A/B
   runner (Task 9) consume them.

The collector is crash-safe: every leg degrades to a logged warning instead
of raising, so the loop never dies on a transient failure (LM Studio down,
dashboard unreachable, `vm_stat` glitch). A `flock` on
`~/.hermes/metrics/harness-collector.lock` keeps a single instance alive.

## Where to look (Task 9 live deployment)

- **Dashboard page:** `http://<dashboard-host>:8899/static/harness.html`
  (Tailscale; the dashboard is loopback-only on the mini — plain LAN is
  blocked). KPIs, tok/s + TTFT charts, per-fingerprint leaderboard (with
  `n` and labels), thermal/swap context.
- **API** (all on the dashboard, no auth — Tailscale trust model):
  - `GET /api/harness/samples?hours=N&limit=M` — recent raw samples
    (ts, fp, prompt_class, ttft_s, tps, tokens, thermal, swap_mb, host).
  - `GET /api/harness/best?n=N` — leaderboard rows grouped by fp × prompt
    class, ranked by mean tok/s.
  - `POST /api/harness/mark` — `{"fp": "<12-hex>", "label": "ctx32k-kvq8"}`
    names a fingerprint; the label rides every later sample for that fp.

## Files

| File | Role |
| --- | --- |
| `harness/fingerprint.py` | Task 1 — config → stable 12-hex fingerprint |
| `harness/lmstudio.py` | Task 2 — LM Studio probe client (stdlib) |
| `harness/bench.py` | Task 3 — streaming TTFT/tok/s benchmark suite |
| `harness/telemetry.py` | Task 4 — macOS thermal/memory/swap/power snapshot |
| `harness/collector.py` | Task 7 — daemon loop composing the above (this doc) |
| `harness/ab.py` | Task 9 — A/B compare runner (summarizes samples per fingerprint) |
| `launchd/ai.hermes.lmharness.plist` | MBP LaunchAgent template (this doc) |
| `tests/test_harness_*.py` | unit tests per module — all seams monkeypatched |

## Install on the collecting host (Task 9 — live)

The collector LaunchAgent is installed and running (`launchctl print
gui/$(id -u)/ai.hermes.lmharness` → `state = running`); the dashboard
serves `/static/harness.html` and the `/api/harness/*` endpoints above.

```bash
# 1. One-shot smoke before daemonizing (expect: a 12-hex fp, then ttft/tps):
python3 -c "from harness import collector; \
cfg = __import__('harness.lmstudio', fromlist=['lmstudio']).parse_loaded_config(
    __import__('harness.lmstudio', fromlist=['lmstudio']).get_models_payload(),
    'qwen3.8-27b-hermes'); \
print(__import__('harness.fingerprint', fromlist=['fingerprint']).fingerprint(cfg)); \
print(__import__('harness.bench', fromlist=['bench']).run_once('qwen3.8-27b-hermes',
    __import__('harness.bench', fromlist=['bench']).PROMPTS['short_tool']))"

# 2. Install the LaunchAgent (run FROM A TERMINAL — launchctl from
#    Hermes-managed processes fails with "141: Reentrancy avoided"):
sed "s|<mbp-user>|\$USER|" launchd/ai.hermes.lmharness.plist \
  > ~/Library/LaunchAgents/ai.hermes.lmharness.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.hermes.lmharness.plist
launchctl print gui/$(id -u)/ai.hermes.lmharness | grep -E "state|pid"
# expected: state = running and a pid

# 3. Verify end-to-end on the dashboard side:
curl -s 'http://<dashboard-host>:8899/api/harness/samples?hours=0.5&limit=5' \
  | python3 -m json.tool | head -30   # fresh ts, non-null tps, host "mbp"
curl -s http://<dashboard-host>:8899/health
```

### The A/B / optimize loop (Task 9)

Compare two runtime configurations via their fingerprints:

```bash
# 1. Baseline — note the current fp (all recent samples share it):
curl -s 'http://<dashboard-host>:8899/api/harness/samples?hours=1' | python3 -m json.tool

# 2. Change ONE lever in LM Studio (context length, KV quant, flash
#    attention, draft model) — one at a time; the collector picks up the new
#    fp automatically on its next cycle (~5 min).

# 3. Compare: median tok/s + p95 TTFT overall and per prompt class, plus
#    the delta:
python3 -m harness.ab <fpA> <fpB> --hours 6 [--base http://<dashboard-host>:8899]

# 4. Label the winner for the leaderboard (it keeps the name):
curl -X POST http://<dashboard-host>:8899/api/harness/mark \
  -d '{"fp": "<fp>", "label": "ctx32k-kvq8-fa-on"}'
```

Reading the output: each config's `n` is its sample count — with 2 repeats
× 3 classes per cycle, **treat deltas under ~10% tok/s as noise until `n`
accumulates across cycles** (the leaderboard shows `n` for exactly this).
Zero-content reasoning streams (all completion tokens in
`reasoning_content`) land as `tps: null` rows and are excluded from the
medians — that is a model-behavior fact worth its own note, not a bug.

### Tuning knobs (env, settable in the plist's `EnvironmentVariables`)

| Env | Default | Meaning |
| --- | --- | --- |
| `HARNESS_INTERVAL` | 300 | seconds between full suites (unparseable values fall back to the default) |
| `METRICS_DASH_URL` | `http://127.0.0.1:8899` | dashboard base; the collector posts to `<base>/ingest` |
| `LMSTUDIO_BASE` | — | *not read by the collector yet* — LM Studio base is `http://127.0.0.1:1234` in `harness/lmstudio.py` |

Each interval gets a ±20% jitter so restarts desynchronize. Logs land in
`~/.hermes/logs/harness-collector.{log,err.log}` (plist config).

### Uninstall

```bash
launchctl bootout gui/$(id -u)/ai.hermes.lmharness
rm ~/Library/LaunchAgents/ai.hermes.lmharness.plist
```

## Tests (no live calls — every seam monkeypatched)

```bash
python3 -m unittest tests.test_harness_fingerprint \
  tests.test_harness_lmstudio tests.test_harness_bench \
  tests.test_harness_telemetry tests.test_harness_collector -v
```

`test_harness_collector.py` covers: sample shape + non-mutation of inputs,
the loaded/unloaded/unknown gating, per-leg failure isolation (probe down →
skip everything; telemetry down → bench still ships without host keys; push
down → logged, not raised), the flock single-instance lock (tmpdir only —
tests never write into a real `~/.hermes`), the interval/jitter math, and
`main()`'s loop with the sleep seam patched (no test ever sleeps for real).

## Status / known edges

- `gpu_offload`/`kv_quant`/`flash_attention` are not exposed by LM Studio
  0.4.x's `/api/v0/models` — they stay `None` in the fingerprint until a
  version that reports them (the fp is stable per what *is* reported).
- `parse_loaded_config` reads `loaded_context_length`; a model that is loaded
  but reports no context length fingerprints with an all-None config.
- The collector is py3.9-compatible (mini's system python) and stdlib-only;
  it imports `bench`/`fingerprint`/`lmstudio`/`telemetry` flat when run as a
  script (the plist's entry point) and relatively under the `harness.` package.
