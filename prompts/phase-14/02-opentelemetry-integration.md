# Phase 14 — Observability + tracing — Prompt 02: OpenTelemetry + OpenLLMetry → Langfuse

**When to run:** After Prompt 01 of Phase 14 lands.
**Estimated duration:** 5-6 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `14`
- `<phase-name>` → `Observability + tracing`
- `<sub-prompt>` → `02-opentelemetry-integration`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-14-observability.md` Steps 2 (OpenTelemetry init), 3 (Langfuse exporter), 6 (Grafana dashboard JSON).
2. Read OpenLLMetry semantic conventions for GenAI: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read_input_tokens`, `gen_ai.response.finish_reason`. Source: Traceloop docs (use `mcp__plugin_compound-engineering_context7__resolve-library-id` → `query-docs` for "@traceloop/node-server-sdk").
3. Read Langfuse Node SDK docs for OTLP ingestion (`langfuse/web/otel/api/public/otel/v1/traces`).
4. Confirm whether George has a Langfuse account (self-hosted or cloud). If not, set `LANGFUSE_BASE_URL=https://cloud.langfuse.com` as default and add a setup note.

## Implementation task

Wire OpenTelemetry SDK + OpenLLMetry conventions into the engine. Every LLM call and every tool call becomes a span with proper attributes. Default exporter is `OTLP-http` to `http://localhost:4318/v1/traces` (i.e., a local collector OR Jaeger). When `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` are set, lazy-load the Langfuse exporter and additionally export there. Lazy-loading means the `langfuse` dep is a peer + optional, and `import()` happens only when keys are present.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/otel.ts` — SDK init, shutdown, helper `withSpan(name, attrs, fn)`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/langfuse.ts` — optional exporter, lazy-loaded
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/conventions.ts` — OpenLLMetry attribute constants
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/anthropic.ts` — wrap call in `withSpan`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/openrouter.ts` — same
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/dispatcher.ts` — wrap each tool call in `withSpan`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli.ts` — call `await initTelemetry()` early; `await shutdownTelemetry()` on exit
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — add deps:
  - `@opentelemetry/sdk-node@^0.54`
  - `@opentelemetry/exporter-trace-otlp-http@^0.54`
  - `@opentelemetry/api@^1.9`
  - `@traceloop/node-server-sdk@^0.11`
  - `langfuse@^3` as `peerDependenciesMeta.langfuse.optional = true`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/telemetry/otel.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/otel-jaeger.test.mjs` — gated `RUN_OTEL_INT=1`, requires local Jaeger

### `otel.ts` shape

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import * as traceloop from "@traceloop/node-server-sdk";

let sdk: NodeSDK | null = null;

export async function initTelemetry(cfg: { enabled: boolean; otlpEndpoint?: string; serviceName?: string; serviceVersion?: string }) {
  if (!cfg.enabled || sdk) return;
  const exporter = new OTLPTraceExporter({
    url: cfg.otlpEndpoint ?? "http://localhost:4318/v1/traces",
  });
  sdk = new NodeSDK({
    serviceName: cfg.serviceName ?? "jellyclaw",
    resource: resourceFromAttributes({ "service.version": cfg.serviceVersion ?? "0.0.0" }),
    traceExporter: exporter,
  });
  await sdk.start();
  // OpenLLMetry instrumentations (auto-instruments anthropic + openai SDKs if loaded)
  traceloop.initialize({ appName: "jellyclaw", disableBatch: false, exporter });

  // Optional Langfuse
  if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
    const { attachLangfuse } = await import("./langfuse.js");
    await attachLangfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
    });
  }
}

export async function shutdownTelemetry() {
  if (sdk) { await sdk.shutdown(); sdk = null; }
}
```

### `withSpan` helper attributes for LLM calls

```ts
import { trace, SpanKind } from "@opentelemetry/api";
const tracer = trace.getTracer("jellyclaw");

export async function llmSpan<T>(provider: "anthropic" | "openrouter", model: string, fn: (span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan("llm.call", { kind: SpanKind.CLIENT,
    attributes: { "gen_ai.system": provider, "gen_ai.request.model": model } }, async (span) => {
    try {
      const out = await fn(span);
      // After call: set usage attrs from result
      // span.setAttribute("gen_ai.usage.input_tokens", out.usage.input_tokens) etc.
      return out;
    } catch (e) { span.recordException(e); span.setStatus({ code: 2 }); throw e; }
    finally { span.end(); }
  });
}
```

Tool span uses `tracer.startActiveSpan("tool.call", { attributes: { "jellyclaw.tool.name": name } })`.

### Setup commands (Langfuse + local OTLP collector)

```bash
# Local Jaeger (one container) for dev OTLP receiving
docker run -d --name jaeger \
  -p 16686:16686 \   # UI
  -p 4318:4318 \     # OTLP HTTP
  jaegertracing/all-in-one:1.62
open http://localhost:16686

# Langfuse cloud account (one-time, manual): create at https://cloud.langfuse.com,
# generate a project key pair, then:
echo 'LANGFUSE_PUBLIC_KEY=pk-lf-...' >> ~/.jellyclaw/.env
echo 'LANGFUSE_SECRET_KEY=sk-lf-...' >> ~/.jellyclaw/.env
echo 'LANGFUSE_BASE_URL=https://cloud.langfuse.com' >> ~/.jellyclaw/.env

# Self-hosted Langfuse alternative
docker run -d --name langfuse-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:15
docker run -d --name langfuse \
  -p 3000:3000 \
  -e DATABASE_URL=postgresql://postgres:postgres@host.docker.internal:5432/postgres \
  -e NEXTAUTH_SECRET=$(openssl rand -hex 32) \
  -e SALT=$(openssl rand -hex 32) \
  -e NEXTAUTH_URL=http://localhost:3000 \
  langfuse/langfuse:3
open http://localhost:3000
```

### Engine boot wiring

```ts
// engine/src/cli.ts (early)
import { initTelemetry, shutdownTelemetry } from "./telemetry/otel.js";
await initTelemetry({
  enabled: cfg.telemetry.enabled,
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
  serviceName: "jellyclaw",
  serviceVersion: pkg.version,
});
process.on("beforeExit", () => shutdownTelemetry());
```

### Shell commands (smoke)

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add @opentelemetry/sdk-node@^0.54 @opentelemetry/exporter-trace-otlp-http@^0.54 \
        @opentelemetry/api@^1.9 @traceloop/node-server-sdk@^0.11
bun add --optional langfuse@^3
bun run build
# 1. Send a span to local Jaeger
JELLYCLAW_TELEMETRY=1 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces \
  ./dist/cli.js run "say hi" --session-id otel-smoke-1
sleep 2
open "http://localhost:16686/search?service=jellyclaw"
# 2. Send to Langfuse
JELLYCLAW_TELEMETRY=1 \
  LANGFUSE_PUBLIC_KEY=$LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY=$LANGFUSE_SECRET_KEY \
  ./dist/cli.js run "list /tmp" --session-id otel-smoke-2
open https://cloud.langfuse.com   # observe trace
# 3. Per-turn overhead measurement
hyperfine --runs 5 \
  './dist/cli.js run "say hi"' \
  'JELLYCLAW_TELEMETRY=1 ./dist/cli.js run "say hi"'
```

### Expected output

- A trace named `jellyclaw` appears in Jaeger UI with child spans `llm.call`, `tool.call`, `subagent.call`.
- Each `llm.call` span carries OpenLLMetry attributes (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`).
- Langfuse cloud shows the same trace under the project, with cost auto-derived (Langfuse natively understands OpenLLMetry attrs).
- Per-turn overhead with telemetry on: <5 ms wall vs off (hyperfine).
- `langfuse` package not loaded when keys absent (verify with `node --inspect-brk` heap snapshot OR `process.memoryUsage()` before/after).

### Tests to add

- `test/unit/telemetry/otel.test.ts`: `initTelemetry({enabled:false})` no-ops; `enabled:true` starts SDK; double init is idempotent; shutdown is awaitable.
- `test/unit/telemetry/conventions.test.ts`: attribute constants match OpenLLMetry spec strings exactly.
- `test/integration/otel-jaeger.test.mjs` (`RUN_OTEL_INT=1`): boots a temporary Jaeger container, runs a tiny wish, polls Jaeger HTTP API for the trace, asserts ≥1 span with expected attrs.

### Verification

```bash
bun run test:unit -- telemetry --reporter=verbose
# Integration (skipped on CI unless explicitly enabled):
RUN_OTEL_INT=1 bun run test:integration -- otel-jaeger
# Confirm Langfuse import is lazy:
node -e "
  process.env.JELLYCLAW_TELEMETRY='1'; delete process.env.LANGFUSE_PUBLIC_KEY;
  import('./dist/telemetry/otel.mjs').then(async m=>{
    await m.initTelemetry({enabled:true});
    const loaded=Object.keys(require.cache||{}).some(k=>k.includes('langfuse'));
    console.log('langfuse loaded =', loaded);   // → false
  });
"
```

### Common pitfalls

- **`@traceloop/node-server-sdk` initialization order:** must run AFTER provider SDKs are imported but BEFORE the first call. Solution: lazy-import provider modules inside the engine's `run()` and `init()` telemetry first in `cli.ts`. If you import providers at top-of-file, instrumentation misses them.
- **Multiple OTLP collectors:** if both Langfuse and Jaeger are configured, you need TWO span processors, not two SDK instances. Use `MultiSpanProcessor` or two `BatchSpanProcessor`s registered against the same SDK.
- **Langfuse OTLP endpoint format:** `https://cloud.langfuse.com/api/public/otel/v1/traces` (note `api/public/otel/v1/traces`). Plus auth via Basic header `base64(public:secret)`. The `langfuse` Node SDK wraps this; if you go raw OTLP, set `headers: {Authorization: 'Basic ' + ...}`.
- **Span IDs not matching trace.jsonl `span_id`:** the JSONL `span_id` from Prompt 01 is jellyclaw-internal (KSUID/ULID). OTel spans have their own 16-byte trace + 8-byte span IDs. Carry both: set OTel attribute `jellyclaw.span_id = <internal>` to allow correlation.
- **Performance regression on cold start:** OTel SDK init takes ~80ms. For one-shot CLI invocations that's a 10% wall hit. Make `initTelemetry` truly conditional on `enabled` — even importing `@opentelemetry/sdk-node` at top-level adds ~30ms of module load. Use dynamic `await import()`.
- **Don't forget `shutdownTelemetry()`** on `SIGTERM` and `SIGINT` too, or batched spans get dropped.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `14`
- `<phase-name>` → `Observability + tracing`
- `<sub-prompt>` → `02-opentelemetry-integration`
- Do NOT mark Phase 14 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
