---
phase: 14
name: "Observability + tracing"
duration: "2 days"
depends_on: [10]
blocks: [18]
---

# Phase 14 — Observability + tracing

## Dream outcome

Every turn produces a JSONL trace capturing every tool call's inputs/outputs, a per-subagent breakdown, and a cost ledger. OpenTelemetry spans via OpenLLMetry let a developer view a single wish as a waterfall in Langfuse or Jaeger.

## Deliverables

- `engine/src/telemetry/trace.ts` — JSONL trace writer
- `engine/src/telemetry/otel.ts` — OpenTelemetry init + span helpers
- `engine/src/telemetry/langfuse.ts` — optional Langfuse exporter
- `engine/src/telemetry/cost.ts` — per-tool / per-subagent ledger
- `docs/observability.md`
- Example Grafana dashboard JSON

## Step-by-step

### Step 1 — Trace file layout
`~/.jellyclaw/traces/<project>/<session-id>.trace.jsonl`:
- `turn.start`
- `tool.span.start` / `tool.span.end` with full input/output (redacted config)
- `llm.call.start` / `llm.call.end` with tokens, cache hit, cost
- `subagent.span.*`
- `turn.end`

### Step 2 — OpenTelemetry
Init SDK:
```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { traceloopInit } from "@traceloop/node-server-sdk"; // OpenLLMetry
traceloopInit({ appName: "jellyclaw", disableBatch: false });
```
Wrap provider calls + tool calls in spans. Attributes per OpenLLMetry conventions (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`).

### Step 3 — Langfuse exporter (optional)
If `LANGFUSE_PUBLIC_KEY` set, also export to Langfuse. Lazy-load to avoid pulling in the dep when unused.

### Step 4 — Cost ledger
Per turn: map tool → { count, input_tokens, output_tokens, cost_usd }. Published in `cost.tick` event + written to ledger file.

### Step 5 — Redaction
Before persisting traces, redact `authorization`, `api_key`, `Bearer` tokens, path components matching common secret patterns. Unit-test the redactor with known-leak fixtures.

### Step 6 — Grafana dashboard
Export a JSON dashboard with panels:
- Turns/min
- p50/p95 turn latency
- Cost/turn
- Cache hit ratio (Anthropic only)
- Tool usage histogram
- Subagent depth distribution
Ship under `docs/observability/grafana.json`.

### Step 7 — Opt-in
Default `telemetry.enabled: false`. Users must opt in in `jellyclaw.json` or via env. Document the data that leaves the machine.

## Acceptance criteria

- [ ] Trace file written for every session when enabled
- [ ] OpenTelemetry spans visible in a local Jaeger
- [ ] Langfuse upload works when keys set
- [ ] Redaction catches tokens/keys (tested)
- [ ] Cost ledger matches provider billing within 1%
- [ ] Dashboard JSON imports cleanly in Grafana

## Risks + mitigations

- **PII leakage in traces** → redactor on every write; opt-in default off.
- **Performance overhead** → batch spans; keep per-turn overhead <5 ms.
- **Cost reconciliation drift** → cross-check nightly vs Anthropic Console export.

## Dependencies to install

```
@opentelemetry/sdk-node@^0.54
@traceloop/node-server-sdk@^0.11
langfuse@^3     # optional / peer
```

## Files touched

- `engine/src/telemetry/{trace,otel,langfuse,cost}.ts`
- `engine/src/telemetry/*.test.ts`
- `docs/observability.md`
- `docs/observability/grafana.json`
