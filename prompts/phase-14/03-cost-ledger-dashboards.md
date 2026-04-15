# Phase 14 — Observability + tracing — Prompt 03: Cost ledger + local dashboard + Grafana export

**When to run:** After Prompts 01-02 of Phase 14 land.
**Estimated duration:** 4-5 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `14`
- `<phase-name>` → `Observability + tracing`
- `<sub-prompt>` → `03-cost-ledger-dashboards`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-14-observability.md` Steps 4 (cost ledger), 6 (Grafana dashboard).
2. Re-read the trace schema from Prompt 01 — the cost ledger derives from `llm.call.end` events.
3. Read Anthropic Usage API docs (`/v1/organizations/{org}/usage_report`) and OpenRouter `/api/v1/generation?id=<id>` for reconciliation. Use context7 if uncertain.
4. Skim `engine/src/telemetry/cost-table.ts` from Prompt 01 — this is the source of $/M-token rates.

## Implementation task

Three deliverables:
1. **Cost ledger** (`engine/src/telemetry/cost.ts`): per-session, per-tool, per-subagent rollups. Emits `cost.tick` event on the engine bus AND appends a row to `~/.jellyclaw/cost-ledger.jsonl`.
2. **Local dashboard** (`engine/src/server/dashboard.ts`): tiny HTTP server on `127.0.0.1:8934` serving a single static HTML page that fetches `/api/cost` + `/api/sessions` and renders 6 charts (turns/min, p50/p95 turn latency, cost/turn, Anthropic cache hit ratio, tool usage histogram, subagent depth distribution). No build step — single-file HTML with vanilla JS + a Chart.js CDN tag.
3. **Grafana dashboard JSON** (`docs/observability/grafana.json`) — importable; queries assume an OTel → Tempo or OTel → Loki+Prometheus stack and degrade gracefully (panels become "no data" rather than erroring).

Plus a reconciliation script `scripts/reconcile-cost.mjs` that compares ledger-computed cost vs Anthropic billed cost over a window and asserts <1% drift (per Phase 14 acceptance).

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/cost.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/dashboard.ts` — HTTP route handlers
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/dashboard.html` — single-file UI
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli.ts` — register `jellyclaw dashboard` command
- `/Users/gtrush/Downloads/jellyclaw-engine/scripts/reconcile-cost.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/observability/grafana.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/observability.md` — extend with dashboard + reconciliation sections
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/telemetry/cost.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/server/dashboard.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark Phase 14 ✅

### Cost ledger event + JSONL row schemas

```jsonc
// cost-ledger.jsonl row, one per llm.call.end:
{"ts":1718...,"session_id":"01j3...","turn":3,"provider":"anthropic","model":"claude-sonnet-4-6",
 "input_tokens":12345,"output_tokens":234,"cache_read_tokens":11000,"cache_write_tokens":0,
 "cost_usd":0.0345,"tool_name":null,"subagent_type":null}

// cost.tick event on engine bus, emitted at end of each turn:
{"type":"cost.tick","session_id":"01j3...","turn":3,
 "turn_cost_usd":0.0345,"session_cost_usd":0.412,
 "by_tool":{"Bash":0.0,"Read":0.0,"WebFetch":0.0},
 "by_subagent":{"code-reviewer":0.0123},
 "tokens":{"input":12345,"output":234,"cache_read":11000,"cache_write":0}}
```

### Dashboard endpoints

- `GET /api/sessions?since=<unix_ms>` → array of `{session_id, started_at, ended_at, turns, cost_usd, status, project}`
- `GET /api/cost?session_id=<id>` → `{by_tool:{}, by_subagent:{}, by_model:{}, timeline:[{ts, cumulative_usd}]}`
- `GET /api/metrics?bucket=5m&since=<unix_ms>` → `{turns_per_min:[], p50_ms:[], p95_ms:[], cache_hit_ratio:[], tool_hist:{}, subagent_depth_hist:{}}`
- `GET /` → serves `dashboard.html`

All endpoints read from `~/.jellyclaw/cost-ledger.jsonl` + the Prompt-01 trace files. No external DB. Pagination = none for now (file scan with `head -10000`).

### Grafana panels (6, in `grafana.json`)

1. **Turns/min** — `sum(rate(jellyclaw_turns_total[1m]))`
2. **p50/p95 turn latency** — histogram_quantile from `jellyclaw_turn_duration_ms_bucket`
3. **Cost / turn** — `sum(jellyclaw_cost_usd) / sum(jellyclaw_turns_total)`
4. **Cache hit ratio (Anthropic only)** — `sum(jellyclaw_cache_read_tokens) / sum(jellyclaw_input_tokens)` filtered `gen_ai_system="anthropic"`
5. **Tool usage histogram** — top-20 by `count(jellyclaw_tool_invocations) by (tool)`
6. **Subagent depth distribution** — histogram of `jellyclaw_subagent_depth`

Variables: `$session`, `$project`, `$model`. Time-range default: `last 24h`.

These metric names imply a Prometheus exporter; if you don't have one running, the panels show "no data" gracefully — that's acceptable for v1. Add a `TODO` to ship a Prometheus exporter in Phase 19.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run build
# Boot dashboard
./dist/cli.js dashboard --port 8934 &
sleep 1 && curl -s http://127.0.0.1:8934/api/sessions | head -c 500
open http://127.0.0.1:8934/
# Generate some traffic to populate ledger
for i in 1 2 3; do
  JELLYCLAW_TELEMETRY=1 ./dist/cli.js run "say hi $i" --session-id ledger-test-$i
done
wc -l ~/.jellyclaw/cost-ledger.jsonl   # ≥3
# Reconciliation against Anthropic billing (manual, requires admin key)
ANTHROPIC_ADMIN_API_KEY=$ANTHROPIC_ADMIN_API_KEY \
  node scripts/reconcile-cost.mjs --since "2026-04-13T00:00:00Z" --until "2026-04-14T00:00:00Z"
# Should print: ledger=$X, billed=$Y, drift=Z% (<1% required)
# Import Grafana dashboard
# Grafana UI → Dashboards → Import → upload docs/observability/grafana.json
```

### Expected output

- `~/.jellyclaw/cost-ledger.jsonl` accumulates one row per LLM call.
- Dashboard at `http://127.0.0.1:8934/` renders all 6 charts; refreshes every 5s.
- `cost.tick` event observable on the engine bus (subscriber test asserts).
- Reconciliation drift <1% over a 24h window with real Anthropic traffic.
- `docs/observability/grafana.json` validates: `jq -e '.panels | length == 6' docs/observability/grafana.json`.

### Tests to add

- `test/unit/telemetry/cost.test.ts` — feed 100 fixture `llm.call.end` events, assert per-tool/per-subagent rollups, assert `cost.tick` schema, assert ledger JSONL well-formed.
- `test/unit/server/dashboard.test.ts` — boot in-process, fixtures preloaded, hit `/api/sessions`, `/api/cost?session_id=…`, `/api/metrics`, assert response schemas.
- `test/integration/dashboard-e2e.test.mjs` (`RUN_DASHBOARD=1`) — runs 3 wishes against msw, opens dashboard, asserts charts populated (Playwright assertion on canvas count).

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run test:unit -- cost dashboard --reporter=verbose
RUN_DASHBOARD=1 bun run test:integration -- dashboard-e2e
# Schema check on Grafana JSON:
jq -e '.title and .panels and (.panels | length == 6) and .templating' docs/observability/grafana.json
# Final: mark Phase 14 ✅ in COMPLETION-LOG.md per closeout (this is the last prompt of Phase 14).
```

This is the FINAL prompt of Phase 14 — mark Phase 14 ✅ in `COMPLETION-LOG.md` per the closeout template.

### Common pitfalls

- **Cost-table accuracy:** Anthropic prices change. The reconciliation drift will spike the day after a price change. Build a `RATES_AS_OF` check into `reconcile-cost.mjs` that warns if `Date.now() - rates_as_of > 30 days`.
- **Cache hit ratio computation:** `cache_read_tokens / input_tokens` is the wrong denominator for the headline number — `cache_read_tokens` is already INSIDE `input_tokens`. The right ratio is `cache_read / (cache_read + cache_write + uncached_input)`. Get this right or the dashboard lies.
- **Subagent cost double-counting:** every subagent LLM call already lands in the ledger as its own row. The parent's `by_subagent` rollup must SUM child rows, not add them on top of the parent's own cost. Test with a fixture that has 2 levels of nesting.
- **Dashboard SSE vs polling:** Chart.js + 5s polling is fine for v1. Don't reach for SSE/WebSockets — adds 200 lines for no UX benefit at this volume.
- **Ledger file growth:** at ~30 wishes/day × ~10 LLM calls/wish = 300 rows/day. After a year that's ~110k rows / ~30MB. `head -10000` for the dashboard is fine; for reconciliation use a streaming reader (`createInterface` over `createReadStream`).
- **Grafana JSON schema versioning:** the JSON format changes between Grafana 10/11/12. Author against Grafana 11 schema (`"schemaVersion": 39`). Document the minimum Grafana version in `docs/observability.md`.
- **Bind dashboard to 127.0.0.1, never 0.0.0.0.** This dashboard exposes session data; don't make it network-reachable by accident.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `14`
- `<phase-name>` → `Observability + tracing`
- `<sub-prompt>` → `03-cost-ledger-dashboards`
- This IS the final prompt of Phase 14. Mark Phase 14 ✅, bump the progress bar.
<!-- END SESSION CLOSEOUT -->
