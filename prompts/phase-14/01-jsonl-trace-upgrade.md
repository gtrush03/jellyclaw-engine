# Phase 14 — Observability + tracing — Prompt 01: JSONL trace upgrade (full tool I/O + redaction)

**When to run:** Phase 10 marked ✅. Can run in parallel with Phase 13 (Phase 14 depends only on 10).
**Estimated duration:** 5-6 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `14`
- `<phase-name>` → `Observability + tracing`
- `<sub-prompt>` → `01-jsonl-trace-upgrade`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-14-observability.md` end to end — especially Steps 1, 5, 7 (trace layout, redaction, opt-in default).
2. Read `engine/SPEC.md` §11 (event stream) and §15 (security: secrets handling).
3. Skim the existing minimal trace writer in `engine/src/telemetry/` (created in Phase 10) — likely just appends raw events.
4. Skim `genie-2.0` trace writer at `dispatcher.mjs:222` for the field shape we want to keep compatible with downstream consumers.

## Implementation task

Upgrade `engine/src/telemetry/trace.ts` from a thin pass-through to a structured writer that captures:
- `turn.start` / `turn.end` envelopes per turn
- `tool.span.start` / `tool.span.end` with **full input AND output JSON** (after redaction)
- `llm.call.start` / `llm.call.end` with token counts, cache hit/miss, computed cost
- `subagent.span.start` / `subagent.span.end`

Redaction lives in a sibling module and is unit-tested with known-leak fixtures. Default `telemetry.enabled: false`; opt in via `jellyclaw.json` or `JELLYCLAW_TELEMETRY=1`.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/trace.ts` — primary writer
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/redact.ts` — pattern-based redactor
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/types.ts` — span schemas as Zod types
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/cost-table.ts` — model → $/M tokens lookup (Anthropic + OpenRouter)
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/telemetry/index.ts` — barrel export
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/telemetry/trace.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/telemetry/redact.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/leaks/{anthropic-key,openrouter-key,bearer-token,aws-key,private-key-block}.txt` — known-leak inputs
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/observability.md` — user-facing doc; data-leaving-machine inventory

### Trace file layout

`~/.jellyclaw/traces/<project_slug>/<session_id>.trace.jsonl`. One JSON object per line:

```json
{"v":1,"ts":1718000000123,"type":"turn.start","turn":3,"session_id":"01j3..."}
{"v":1,"ts":...,"type":"tool.span.start","span_id":"sp_01k...","tool":"Bash","input":{"command":"ls /tmp"}}
{"v":1,"ts":...,"type":"tool.span.end","span_id":"sp_01k...","tool":"Bash","duration_ms":42,"output":{"stdout":"…","stderr":"","exit_code":0},"ok":true}
{"v":1,"ts":...,"type":"llm.call.start","span_id":"sp_01k...","provider":"anthropic","model":"claude-sonnet-4-6","prompt_tokens_estimate":12345}
{"v":1,"ts":...,"type":"llm.call.end","span_id":"sp_01k...","input_tokens":12345,"output_tokens":234,"cache_read_tokens":11000,"cache_write_tokens":0,"cost_usd":0.0345,"duration_ms":2400}
{"v":1,"ts":...,"type":"subagent.span.start","span_id":"sp_01k...","subagent_type":"code-reviewer","prompt":"<redacted-or-truncated>"}
{"v":1,"ts":...,"type":"subagent.span.end","span_id":"sp_01k...","duration_ms":18200,"final_text_len":1200,"tools_used":4}
{"v":1,"ts":...,"type":"turn.end","turn":3,"duration_ms":21000}
```

`v:1` is the trace schema version — any breaking change increments it.

### Redaction patterns (must catch ALL of these)

```
sk-ant-[a-zA-Z0-9_-]{20,}        # Anthropic
sk-or-v1-[a-zA-Z0-9]{40,}         # OpenRouter
sk_(live|test)_[a-zA-Z0-9]{20,}   # Stripe
xai-[a-zA-Z0-9]{40,}              # xAI/Grok
xoxb-\d+-\d+-[a-zA-Z0-9]+         # Slack bot
ghp_[A-Za-z0-9]{36}               # GitHub PAT
github_pat_[A-Za-z0-9_]{82}       # fine-grained PAT
AKIA[0-9A-Z]{16}                  # AWS access key
ASIA[0-9A-Z]{16}                  # AWS STS
AIza[0-9A-Za-z\-_]{35}            # Google API
Bearer\s+[A-Za-z0-9._\-+/]{20,}   # generic bearer
-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END[^-]+-----  # PEM blocks
"authorization"\s*:\s*"[^"]+"     # JSON authorization headers (case-insensitive key)
```

Each match → `***REDACTED:<kind>***`. Apply BEFORE writing to disk; never log the raw value, even at trace level.

### Opt-in gate

`engine/src/config.ts` Zod schema gets a new section:
```ts
telemetry: z.object({
  enabled: z.boolean().default(false),
  trace_dir: z.string().default("~/.jellyclaw/traces"),
  redact: z.boolean().default(true),
  max_tool_input_bytes: z.number().default(64_000),     // truncate huge inputs
  max_tool_output_bytes: z.number().default(256_000),
}).default({}),
```
Env var override: `JELLYCLAW_TELEMETRY=1` flips `enabled` regardless of file. Document both.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run build
bun run test:unit -- telemetry
# Manual smoke
JELLYCLAW_TELEMETRY=1 ./dist/cli.js run "list files in /tmp" --session-id smoke-1
ls -la ~/.jellyclaw/traces/*/smoke-1.trace.jsonl
head -5 ~/.jellyclaw/traces/*/smoke-1.trace.jsonl
# Redaction smoke
echo 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz123456' \
  | node -e "import('./dist/telemetry/redact.mjs').then(m=>{let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(m.redact(s)))})"
```

### Expected output

- Trace files render valid JSONL — every line parses, every `span_id` opens before it closes.
- Redactor catches 100% of fixtures in `test/fixtures/leaks/` (test asserts).
- Tool input/output truncation kicks in at the configured byte cap with a `[truncated N bytes]` marker.
- Cost field on `llm.call.end` matches expected within 1% for fixture token counts vs `cost-table.ts`.
- `telemetry.enabled: false` → no trace files written, no perf overhead measurable (>5ms per turn = bug).

### Tests to add

- `test/unit/telemetry/trace.test.ts` (10 cases): turn lifecycle, span pairing, write atomicity, truncation, opt-in gate, env var override, schema validation per line, version bump, error-on-write tolerated.
- `test/unit/telemetry/redact.test.ts` (12 cases): one per pattern above + a negative test asserting the string `"hello world"` is unchanged + a fixture-replay test reading every file in `test/fixtures/leaks/`.

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run test:unit -- telemetry --reporter=verbose
# Trace lint
JELLYCLAW_TELEMETRY=1 ./dist/cli.js run "smoke" --session-id smoke
node -e "require('fs').readFileSync(require('os').homedir()+'/.jellyclaw/traces/default/smoke.trace.jsonl','utf8').trim().split('\n').forEach((l,i)=>{try{JSON.parse(l)}catch(e){console.error('bad line',i,l);process.exit(1)}});console.log('jsonl ok')"
```

### Common pitfalls

- **Async write ordering:** if you fire-and-forget `appendFile`, two spans may interleave bytes mid-line. Use a write queue (single in-flight write, queue the rest) or `appendFileSync` (acceptable since traces are off the hot path).
- **Tool output can be 10MB+** (e.g., a `Read` of a large file). Truncation MUST happen pre-redact OR you spend 200ms regexing 10MB of nothing. Order: truncate → redact → write.
- **Cost table drift:** Anthropic and OpenRouter prices change. Source `cost-table.ts` from a single dated constant block at the top with a `RATES_AS_OF: "2026-04-14"` comment; add a TODO + a `bun run scripts/refresh-cost-table.mjs` that queries Anthropic's pricing endpoint when it lands.
- **`session_id` collisions across projects:** include `project_slug` in the path so two projects can't overwrite each other's session traces.
- **Redactor on JSON values vs keys:** the `"authorization": "..."` pattern must match the value, not just the key. Test both `{"authorization":"Bearer xyz"}` and `Authorization: Bearer xyz` HTTP-style.
- **`telemetry.enabled: false` must REALLY be free.** No file handles opened, no JSON.stringify of large objects on the hot path. Gate the entire writer behind a single `if (!enabled) return;` at function entry.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `14`
- `<phase-name>` → `Observability + tracing`
- `<sub-prompt>` → `01-jsonl-trace-upgrade`
- Do NOT mark Phase 14 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
