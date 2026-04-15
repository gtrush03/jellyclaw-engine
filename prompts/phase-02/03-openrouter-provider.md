# Phase 02 — Config + provider layer — Prompt 03: OpenRouter provider

**When to run:** After Phase 02 Prompt 02 (`02-anthropic-provider.md`) is committed.
**Estimated duration:** 4-5 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `02`
- `<phase-name>` → `Config + provider layer`
- `<sub-prompt>` → `03-openrouter-provider`
<!-- END SESSION STARTUP -->

## Task

Implement the OpenRouter provider (`engine/src/providers/openrouter.ts`) strictly for **non-Anthropic** models, and the provider router (`engine/src/providers/router.ts`) with primary-failover semantics. Enforce the `acknowledgeCachingLimits` config gate. Document the warnings. Close Phase 02 in `COMPLETION-LOG.md`.

### Context

Phase 02 Prompt 02 shipped the Anthropic provider, config schema, and shared `Provider` interface. `engine/provider-research-notes.md` §5-§10 specifies OR's endpoint, tool-call mapping, the #1245 + #17910 caching regressions, and the `acknowledgeCachingLimits` gate. Per `engine/SPEC.md` §6.2 and §6.3, an Anthropic model routed through OR MUST trigger a loud warning AND require the gate to be true.

### Steps

1. Re-read `engine/provider-research-notes.md` §5-§10 before writing code.
2. Author `engine/src/providers/openrouter.ts`:
   - Constructor: `{ apiKey: string; baseURL?: string; referer?: string; title?: string }`. Default baseURL: `https://openrouter.ai/api/v1`.
   - `stream(req, signal)` POSTs to `/chat/completions` with `stream: true`, `Accept: text/event-stream`, `Authorization: Bearer <apiKey>`, `HTTP-Referer`, `X-Title`.
   - Translate `ProviderRequest` → OpenAI-compatible body: `messages` flattened; `tools` mapped from Anthropic shape to OpenAI `{ type: "function", function: { name, description, parameters } }`; `system` prepended as `role: "system"` messages.
   - **Strip every `cache_control` field** from the outgoing body. Walk the body object and delete that key recursively. This avoids issue #17910 returning 400.
   - Consume SSE via `eventsource-parser`. For each `data:` line that is not `[DONE]`, JSON-parse the OpenAI `chat.completion.chunk` and translate to our `ProviderChunk` events shaped like `{ type: "content_block_delta", delta: { type: "text_delta", text } }` for text, and `{ type: "content_block_delta", delta: { type: "input_json_delta", partial_json } }` for tool-call argument streams. Mirror Anthropic's shape so downstream adapters do not branch.
   - Warning policy — print EXACTLY ONCE per process, to stderr via the logger:
     - If the resolved model ID starts with `anthropic/`, emit the §6.2 warning from SPEC verbatim ("[jellyclaw] OpenRouter provider active with an Anthropic model. Prompt caching is currently broken on this route (upstream issues #1245, #17910). Expect 4-10× higher token cost. Use --provider anthropic for full caching.").
     - For any other vendor, no warning.
   - Retry: same matrix as Anthropic (429 / 5xx / ECONN / ETIMEDOUT), 3 attempts, 30s budget, respects `Retry-After`.
3. Author `engine/src/providers/router.ts`:
   - `class ProviderRouter implements Provider` with `primary: Provider, secondary?: Provider`.
   - `stream()` yields from primary; on `shouldFailover(err)` AND `secondary` set, swap to secondary and log `provider.failover`.
   - `shouldFailover`: true for 429 / 5xx / ETIMEDOUT / ECONNRESET; false for 4xx other than 429 and for AbortError.
   - If the error was raised mid-stream after data was already emitted, DO NOT failover (avoid duplicate/interleaved output). Only failover on pre-stream errors or first-chunk errors. Add a test for this invariant.
4. Author `engine/src/providers/gate.ts` exposing `enforceCachingGate(config, model): void`:
   - If `config.provider === "openrouter"` AND `model.startsWith("anthropic/")` AND `config.acknowledgeCachingLimits !== true` → throw `CachingGateError` with message directing the user to set `acknowledgeCachingLimits: true` or pass `--provider anthropic`.
   - Extend `config/schema.ts` to add `acknowledgeCachingLimits: z.boolean().default(false)` at the top level.
5. Author tests:
   - `engine/src/providers/openrouter.test.ts` — mock fetch/SSE to assert: body has NO `cache_control` anywhere; tool schema translation is correct; Anthropic-model warning emitted exactly once across multiple instantiations; non-Anthropic model emits nothing.
   - `engine/src/providers/router.test.ts` — fault injection matching `phases/PHASE-02-config-providers.md` Step 8: 500-on-primary → secondary yields; 401-on-primary → error, no fallback; mid-stream error → error, no fallback; no secondary → error.
   - `engine/src/providers/gate.test.ts` — matrix (provider × model-prefix × gate) expected outcomes.
6. Author `engine/src/providers/credential-pool.ts` (round-robin on `ANTHROPIC_API_KEY_1..N`, off by default, enabled only when >1 keys detected). Unit test.
7. Update `engine/src/providers/index.ts` exports: `{ OpenRouterProvider, ProviderRouter, enforceCachingGate }`.
8. Write `docs/providers.md` per `phases/PHASE-02-config-providers.md` Step 9 — caching matrix table, selection rules, pitfalls, the two OR issues with URLs, the credential pool design, the gate.
9. Run `bun run --filter @jellyclaw/engine test && bun run --filter @jellyclaw/engine typecheck && bun run lint`. All green.
10. Update `COMPLETION-LOG.md`. Mark Phase 02 ✅.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/openrouter.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/openrouter.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/router.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/router.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/gate.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/gate.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/credential-pool.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/credential-pool.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/index.ts` — re-export updates.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/config/schema.ts` — add `acknowledgeCachingLimits`.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/providers.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — Phase 02 ✅.

### Verification

- All test files pass; total count ≥ 25 tests across Phase 02.
- `grep -r 'cache_control' engine/src/providers/openrouter.ts` shows only the STRIPPING logic (e.g. a `stripCacheControl` helper), never an emission.
- Booting with `provider: openrouter, model: anthropic/claude-sonnet-4.5, acknowledgeCachingLimits: false` → `CachingGateError` thrown.
- Booting with same config but `acknowledgeCachingLimits: true` → no throw, warning emitted once to stderr.
- `docs/providers.md` has URLs to both GitHub issues and a clear "never trust OR cache_read_input_tokens" recommendation.
- `COMPLETION-LOG.md` shows Phase 02 ✅ with commit SHA and today's date.

### Common pitfalls

- **Leaving a `cache_control` block in the OR body.** Causes HTTP 400. Strip recursively, including nested blocks in tool definitions and in system chunks. Add a test that constructs a request WITH cache_control and asserts zero survive after translation.
- **Failing over mid-stream.** Produces duplicated or interleaved output. The router must track "has any chunk been yielded" and refuse to failover after that point.
- **Printing the warning multiple times.** Use a module-level `let warned = false` guard. Add a test that constructs two OpenRouter instances and asserts the logger received the warning once.
- **Tool schema mismatch.** Anthropic's `tools: [{ name, description, input_schema }]` → OpenAI's `tools: [{ type: "function", function: { name, description, parameters } }]`. Translation must preserve `required` and nested `properties`.
- **Forgetting `HTTP-Referer` / `X-Title`.** OR rate-limits harder on requests without attribution. Use `https://github.com/gtrush03/jellyclaw-engine` and `jellyclaw` as defaults.
- **Router swallowing AbortError.** Abort must propagate as-is, not trigger failover.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `02`
- `<phase-name>` → `Config + provider layer`
- `<sub-prompt>` → `03-openrouter-provider`
- Mark Phase 02 as ✅ Complete in `COMPLETION-LOG.md`.
<!-- END SESSION CLOSEOUT -->
