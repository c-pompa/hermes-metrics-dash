# Widget Lab → Hermes metrics carry-over

Mock-data demos of the Widget Lab frames that fit this plugin. The usable set is carried over live on the Hermes plugin dashboard; the original mocks stay as-is.

**Open:** `/static/demo-usable.html` (plugin + :8899 usable set) · `/static/demo-widget-lab.html` (original mocks) · `/static/demo-fan.html#/range=6h` (fan-v1 live lab).

## Carry

| Widget Lab | Hermes mapping | Surface today | Data already in pipeline |
|---|---|---|---|
| Eval nightly-regression | Health-rule findings as pass bars + firing cases + selectable model compare (Qwen3.8 router vs main, GLM 5.3 vs lite, or custom). **Live on the plugin Findings tab** (`plugin/dashboard/dist/index.js`): Summary / Firing / Compare over `/findings` + `summary.recent_1h`. | Plugin **Findings** tab | `/findings`, R1–R13 |
| Traces empty | Empty ingest vs live 1h feed (Empty / Live toggle). **Live on the plugin Overview tab**: KPIs + 5-min spark + recent feed when `/recent` has api records; waiting copy + hooks snippet when it doesn't. | Plugin **Overview** | `/summary.recent_1h` |
| Fan Out | MoA proposers + stuck `delegate_task`. **Lab:** `/static/demo-fan.html#/range=6h` (fan-v1). Desktop MoA retired; Live ops waterfall stays. | Full dash **Live ops** (lab only) | `/api/recent`, `/moa/summary`, `subagent_stop` |
| Model Router sankey | **Lab:** `/static/demo-router.html#/range=6h` (router-v1). Widget Lab ribbons on live family lanes (local / glm / qwen / nvidia — never DSv4 flash/pro) plus `/api/router-usage` role bars. Plugin Routing tab already has the compact `trafficLanes()` bar. Overview Routing workspace not patched. | Plugin **Routing**; :8899 Routing & roles (lab) | `/api/recent`, `/api/router-usage`, `/api/router-status` |
| Runs stacked bars | Request volume vs errors. **Lab (live `/api`):** `/static/demo-runs.html#/range=6h` (runs-v1). Overview not patched yet. | Plugin sparkline, Overview tiles | `/recent` `kind=api\|error` |
| Alert rules + heatmap | Findings mute list + duration heatmap | Plugin Findings; heatmap is new on Overview | findings + `duration_s` |
| Timeout Ceiling | `duration_s` histogram; ceiling is a what-if | Full dashboard only | `duration_s` (no config write) |
| Context gauge + H2H | **H2H live in plugin Findings Compare**. Context *growth* lab: `/static/demo-context.html` (step lines + selected-session gauge vs `MODEL_POOL_CAPS`). Snapshot gauge still skipped as a 128k prompt-part pie — those parts are not in the pipeline. | Plugin **Findings** (Compare); lab for Overview Memory & KV | `input_tokens`, client `MODEL_POOL_CAPS` |
| KV pool + efficiency | **Lab:** `/static/demo-memory.html#/range=6h` (memory-v1). Occupancy area vs loaded ctx + duration×output scatter with tok/s guides. Overview not patched. | Overview Memory & KV (lab only) | `input_tokens` in-flight, `duration_s` / `output_tokens` / `tps` |
| Speed over time | **Lab:** `/static/demo-speed.html#/range=6h` (speed-v1). Shared-y IQR bands, `#lanes` small multiples, `#heat` median heatmap; pin for raw dots. Overview not patched. | Overview speed chart (lab only) | `tps`, `duration_s`, `output_tokens` |
| Tool call graph | Hermes tools + subagents | **Candidate** — not on plugin yet | guardrail tool names; no full tool spans |
| LLM cost + errors | Session `cost_usd` + error-rate step | Overview (plugin tab has no cost chart) | `cost_usd`, `api_request_error` |

Hover/click on every carry-over chart uses the same tip shape as MoA (`{title, meta}`): findings spark, ingest buckets, router lanes, request bars, rule sparks, duration heatmap, ceiling bins, context gauge ticks, h2h dots, tool nodes/edges, cost stacks, error steps. Helpers live in `static/widget-lab-hermes.js` (mock page) and `plugin/dashboard/dist/index.js` (live plugin).

**Live so far:** Eval → plugin Findings. Traces empty/active → plugin Overview. Router lanes → plugin Routing (compact bar); **router-v1 lab** on :8899. H2H dots → plugin Compare.
**Ready (not wired):** request volume, rules heatmap, cost + errors, Routing workspace patch.
**Later:** Fan Out radial patched onto Live ops, duration ceiling, tool graph.
Desktop MoA / DSv4 / Roles are retired. Original mocks stay at `/static/demo-widget-lab.html`.

## Skip

Deployments (prompt/eval versions), media control pills, views-by-language, playback + speaker. This plugin is LLM-ops telemetry, not a dubbing or prompt-eval product.

## Tests

```bash
node --test tests/widget-lab-hermes.test.js tests/memory-lab.test.js tests/context-lab.test.js tests/speed-lab.test.js tests/fan-lab.test.js tests/router-lab.test.js
node --check static/widget-lab-hermes.js static/demo-widget-lab.js static/memory-lab.js static/demo-memory.js static/speed-lab.js static/demo-speed.js static/fan-lab.js static/demo-fan.js static/router-lab.js static/demo-router.js
```
