# Phase 02 — Config + provider layer — Prompt 02: Anthropic provider

**When to run:** After Phase 02 Prompt 01 (`01-research.md`) has produced `engine/provider-research-notes.md` and that session is committed.
**Estimated duration:** 5-7 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `02`
- `<phase-name>` → `Config + provider layer`
- `<sub-prompt>` → `02-anthropic-provider`
<!-- END SESSION STARTUP -->

## Task

Implement the Zod config schema + loader, the shared provider interface, and the **fully working** Anthropic provider (`engine/src/providers/anthropic.ts`). Not a stub — real SDK calls, real streaming, real cache_control placement on `[system | tools | CLAUDE.md | top-K skills]`, real retry on 5xx. Unit tests must assert cache breakpoint placement via a mocked SDK and must assert retry behavior. OpenRouter is the next prompt — do not touch it here. Do not mark Phase 02 complete yet.

### Context

Phase 01 installed `@anthropic-ai/sdk@^0.40.0` and `zod@^3.23`. `engine/provider-research-notes.md` specifies the cache breakpoint rules, beta headers, retry matrix, and size gates. `engine/SPEC.md` §7, §9 defines the config schema.

### Steps

1. Re-read `engine/provider-research-notes.md` sections 1-4 before writing code.
2. Author `engine/src/config/schema.ts` per `phases/PHASE-02-config-providers.md` Step 1 and SPEC §9. Use the SPEC shape (single `provider` + `model` + per-vendor nested configs), not the earlier phase-doc draft — SPEC is authoritative.
3. Author `engine/src/config/loader.ts` with resolution order: defaults ← `~/.jellyclaw/config.json` ← `<cwd>/.jellyclaw/config.json` ← env vars ← CLI flags. Expand `~`. Use `JSON.parse` with a try/catch that raises a typed `ConfigParseError` including the offending path. Validate at the end with `Config.parse(merged)`.
4. Author `engine/src/config/schema.test.ts`: (a) defaults populate when given `{}`; (b) unknown enum value → zod error; (c) `provider: "anthropic"` with missing API key env AND missing `anthropic.apiKey` field → distinct "missing credential" error from a separate `assertCredentials()` helper (zod itself can't enforce env-fallback semantics); (d) precedence: CLI > env > local > global > defaults verified by setting each layer differently and asserting the winning value.
5. Author `engine/src/providers/types.ts` with:
   ```ts
   export interface ProviderRequest {
     system: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } }>;
     messages: Anthropic.Messages.MessageParam[];
     tools?: Anthropic.Messages.Tool[];
     maxOutputTokens: number;
     model: string;
     thinking?: { type: "enabled"; budget_tokens: number };
     memory?: { claudeMd?: string; skills?: Array<{ name: string; body: string }> };
   }
   export interface ProviderChunk { type: string; [k: string]: unknown; }
   export interface Provider {
     readonly name: "anthropic" | "openrouter";
     stream(req: ProviderRequest, signal?: AbortSignal): AsyncIterable<ProviderChunk>;
     close?(): Promise<void>;
   }
   ```
6. Author `engine/src/providers/anthropic.ts`:
   - Constructor: `{ apiKey: string; baseURL?: string; clock?: () => number }`. No `new Date()` — inject clock per repo conventions.
   - Use `new Anthropic({ apiKey, baseURL })` from `@anthropic-ai/sdk`.
   - In `stream()`, construct the request. Apply `cache_control` breakpoints following SPEC §7:
     1. Last `system` block → `{ type: "ephemeral", ttl: "1h" }` with the `anthropic-beta` header for 1h TTL.
     2. Last `tools` entry → `{ type: "ephemeral", ttl: "5m" }`.
     3. If `memory.claudeMd` is present, inject as a leading user message block with `{ type: "ephemeral", ttl: "5m" }`.
     4. If `memory.skills` is present, take the top-N (default 12; parameterize) and inject as a subsequent block with `{ type: "ephemeral", ttl: "5m" }`. Cache_control sits on the LAST skill block only, not each.
   - Call `client.messages.stream({...})` and yield chunks by `stream.on("event", ...)` or by iterating `for await (const event of stream) { yield event }`. Pass `signal` through.
   - Retry wrapper: on `status in [429, 500, 502, 503, 504]` or `code in ["ECONNRESET", "ETIMEDOUT"]`, retry with exponential backoff starting at 500ms, max 3 attempts. Respect `Retry-After` header when present. Do NOT retry `400/401/403/413`.
   - Never log `apiKey`; ensure the logger redacts `apiKey`, `authorization`, `x-api-key`.
7. Author `engine/src/providers/cache-breakpoints.ts` — pure function `planBreakpoints(req) → req'` so it can be unit-tested in isolation from the SDK.
8. Author `engine/src/providers/anthropic.test.ts`:
   - Mock the SDK by passing a stubbed `fetch` via `baseURL` pointing to a local Vitest `http` server, OR by injecting a test-double client. Assert that the outgoing request body has cache_control on exactly the expected blocks.
   - Assert 1h TTL block has the `anthropic-beta` header set correctly (header name from research notes).
   - Fault injection: server returns 500 twice then 200 → stream completes with 2 retries logged.
   - Fault injection: server returns 401 → no retry, error bubbles.
   - Abort: caller aborts the signal mid-stream → stream ends, no unhandled promise rejection.
9. Author `engine/src/providers/cache-breakpoints.test.ts` with ≥8 cases: no system, single system, multi-chunk system, no tools, single tool, many tools, no memory, memory with N skills > top-K.
10. Run `bun run --filter @jellyclaw/engine test`. All green.
11. Export from `engine/src/providers/index.ts`: `{ AnthropicProvider, planBreakpoints, type Provider, type ProviderRequest, type ProviderChunk }`.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/config/schema.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/config/loader.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/config/schema.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/types.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/anthropic.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/anthropic.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/cache-breakpoints.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/cache-breakpoints.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/index.ts`

### Verification

- `bun run --filter @jellyclaw/engine typecheck` exits 0.
- `bun run --filter @jellyclaw/engine test` exits 0.
- Schema test demonstrates at least 6 valid + invalid fixtures.
- Cache-breakpoint test covers the 8+ cases enumerated.
- Anthropic provider test proves retry+abort+no-retry-on-4xx via mocks.
- No `any` introduced. No `console.log`. No `new Date()` in provider code.

### Common pitfalls

- **Placing cache_control on every system block.** Only the LAST chunk of the system array gets a breakpoint — Anthropic caches the entire prefix up to that point.
- **Putting cache_control on a volatile turn.** User messages rotate; never put breakpoints there except on the stable CLAUDE.md/skills injection blocks.
- **Minimum token size gate.** A block smaller than the vendor minimum silently skips caching. Log a `cache.skipped_small_block` telemetry event in that case; do not fail.
- **Beta-header drift.** Use the exact header value from `engine/provider-research-notes.md` §3. If the SDK version changed between research and implementation, re-verify.
- **Retry storms under rate limit.** Respect `Retry-After`. Do not exceed the 3-attempt / 30-second budget.
- **Leaking the request body into logs.** The logger config must never log full request bodies; only token counts + model + latency.
- **OpenRouter concerns bleeding in.** That's the next prompt. Do not import `openrouter.ts` from `anthropic.ts`.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `02`
- `<phase-name>` → `Config + provider layer`
- `<sub-prompt>` → `02-anthropic-provider`
- Do NOT mark Phase 02 complete. Only prompt 03 closes the phase. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
