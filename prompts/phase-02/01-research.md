# Phase 02 — Config + provider layer — Prompt 01: Research

**When to run:** After Phase 01 is marked ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3-4 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `02`
- `<phase-name>` → `Config + provider layer`
- `<sub-prompt>` → `01-research`
<!-- END SESSION STARTUP -->

## Task

Produce `engine/provider-research-notes.md` — the authoritative brief for the Anthropic-direct and OpenRouter providers. Cover the Anthropic Messages API deeply (streaming, tool use, extended thinking, cache_control breakpoint placement rules, beta headers) and OpenRouter's OpenAI-compatible surface (streaming, tool use via OpenAI schema, the two known caching regressions #1245 and #17910). Downstream prompts 02 and 03 author providers based only on your notes.

### Context

`engine/SPEC.md` §6 and §7 specify: Anthropic is default, cache_control breakpoints sit on `[system | tools | CLAUDE.md | top-K skills]` with TTLs of 1h/5m/5m/5m, and OpenRouter is opt-in with a warning. The @anthropic-ai/sdk pin is `^0.40.0` per SPEC §15 (installed in Phase 01). OpenRouter issues to cover: #1245 (cache_control silently dropped on Anthropic-via-OR), #17910 (OAuth-scoped tokens + cache_control → HTTP 400 since 2026-03-17).

### Steps

1. Fetch Anthropic Messages API documentation via `context7` MCP: resolve library id for `@anthropic-ai/sdk` and query docs for: `messages.stream`, `messages.create`, tool use schema, `cache_control`, `anthropic-beta` headers, extended thinking, token counting. Paste concrete snippets into the notes.
2. Document Anthropic streaming event types: `message_start`, `content_block_start`, `content_block_delta` (variants: `text_delta`, `input_json_delta`, `thinking_delta`), `content_block_stop`, `message_delta`, `message_stop`. Show a worked example of consuming a single tool_use turn end-to-end.
3. Document the four cache_control breakpoint slots per SPEC §7. For each slot: eligible content types, stability requirements (what must NOT change for a hit), minimum token size (1024 tokens for Sonnet/Opus, 2048 for Haiku — verify against current docs), and which beta header is required for 1h TTL (`extended-cache-ttl-2025-04-11` or the current equivalent — look this up, do not assume).
4. Document retry semantics: which status codes to retry (`429`, `5xx`, `ETIMEDOUT`, `ECONNRESET`), which NOT (`400`, `401`, `403`, `413`), recommended backoff (exponential with jitter, `Retry-After` header respected), total retry budget (3 attempts, 30s total).
5. Fetch OpenRouter documentation: `/chat/completions` endpoint, streaming format (OpenAI-compat SSE with `data: [DONE]`), tool calling schema (OpenAI function-calling), required headers (`Authorization`, `HTTP-Referer`, `X-Title`), provider routing header `OpenRouter-Provider-Slug`.
6. Issue #1245 deep-dive: summarize in 3 paragraphs. What the bug is (cache_control blocks silently stripped before proxying to Anthropic), observed symptoms (`cache_read_input_tokens` always 0, full re-billing), upstream status (open / closed / workaround), and implication for jellyclaw: **never emit cache_control on the OpenRouter path**.
7. Issue #17910 deep-dive: OAuth-scoped OpenRouter tokens + any `cache_control` field in the request → HTTP 400 since 2026-03-17. Implication: even if #1245 is fixed, we MUST strip cache_control when routing through OR with OAuth tokens.
8. Draft the `acknowledgeCachingLimits` config gate: a boolean that, when false (default), forbids using OR with a model whose ID starts with `anthropic/` unless the user passes a flag. This makes "I routed Claude through OR by accident and burned 10× budget" unreproducible.
9. Credential pooling: document `ANTHROPIC_API_KEY_1..N` env var pattern for round-robin on 429. Keep pooling off by default; enable only when >1 keys are present.
10. Write `engine/provider-research-notes.md`. Structure: (§1 Anthropic streaming) (§2 Anthropic tool use) (§3 Anthropic caching — breakpoint rules, beta headers, TTLs, size gates) (§4 Anthropic retry & errors) (§5 OpenRouter endpoint contract) (§6 OR tool use mapping) (§7 OR caching regressions #1245 + #17910) (§8 OR retry differences) (§9 Credential pooling) (§10 Decision: `acknowledgeCachingLimits` gate).

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/provider-research-notes.md` — the deliverable. Target 1000-1800 lines. Every claim has a source citation (Anthropic docs URL, OpenRouter docs URL, or GitHub issue URL).

### Verification

- File exists and has all 10 sections populated (no "TODO").
- At least one concrete SDK code snippet per provider, copy-pasteable.
- Each caching-related claim has a URL next to it.
- The `acknowledgeCachingLimits` gate has a concrete decision table in §10 (matrix of provider × model-vendor × gate-state → action).

### Common pitfalls

- **Assuming beta header names from memory.** The 1h TTL header name has changed at least once. Verify against current Anthropic docs via context7.
- **Confusing Anthropic cache_control with OpenAI's unrelated caching features.** They are different. Do not cross-pollinate.
- **Treating OR as "Anthropic-compatible."** It is OpenAI-compat for the chat/completions surface. Tool-use shapes differ. The cache_control situation is specifically broken.
- **Scope creep.** No code yet. This is notes only.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `02`
- `<phase-name>` → `Config + provider layer`
- `<sub-prompt>` → `01-research`
- Do NOT mark Phase 02 complete. Append a session-log row for the research deliverable.
<!-- END SESSION CLOSEOUT -->
