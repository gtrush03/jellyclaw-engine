# Phase 08 — Permission engine + hooks — Prompt 03: Rate limiter + secret scrubbing

**When to run:** After Phase 08 prompts 01 + 02 are ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 2–3 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 08.01 or 08.02 not ✅. -->
<!-- END paste -->

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/patches/003-secret-scrub-tool-results.patch` — what it changes in OpenCode. You will wire the engine side and make it dispatch-safe.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — the list of token/secret patterns that must be scrubbed from tool results before they reach the model.
3. Re-read Phase 08 phase doc — rate limiter is noted in "Risks + mitigations" (rate limiting browser ops implicitly).
4. Read Phase 07 MCP playwright config — browser tools are per-domain by URL, so rate limiter keys are derived from the URL path tools (`browser_navigate` input `url`).
5. Research common secret patterns worth scrubbing by default: AWS keys (`AKIA[0-9A-Z]{16}`), Anthropic keys (`sk-ant-[A-Za-z0-9_-]+`), OpenAI keys (`sk-[A-Za-z0-9]{20,}`), GitHub tokens (`ghp_[A-Za-z0-9]{36}`, `github_pat_[A-Za-z0-9_]+`), JWT (`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`), generic `Authorization: Bearer ...` headers, `password=...`, plus any values from `config.secrets` and any MCP server env values.

## Implementation task

Two linked systems: a per-domain **rate limiter** (for browser ops) and a **secret scrubber** applied to every tool result before it is streamed to the model or persisted to sessions.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/ratelimit/token-bucket.ts` — token-bucket implementation; config: `{ capacity, refillPerSecond }`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/ratelimit/registry.ts` — per-key limiter registry (key = domain/tool).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/ratelimit/policies.ts` — extract domain from known tool inputs (`mcp__playwright__browser_navigate.url`, etc.); policy config loader.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/security/scrub.ts` — secret scrubber; returns `{ scrubbed: string, hits: number }`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/security/secret-patterns.ts` — registry of built-in patterns + loader for user-extended patterns from config.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/security/apply-scrub.ts` — walker that traverses any JSON value (object, array, string) and scrubs strings in place.
- Wire scrubber into the tool-result emission path (after handler returns, before emit to event stream / session store / hooks).
- Wire rate limiter into `PreToolUse`: before executing a tool with a known domain policy, acquire a token; on empty bucket, emit `Notification` event + delay (async) or deny (configurable).
- Modify permission engine to call rate limiter as a post-hook, pre-execute step.
- Tests: `token-bucket.test.ts`, `ratelimit-policies.test.ts`, `scrub.test.ts`, `apply-scrub.test.ts`, `integration-scrub-e2e.test.ts`.
- Verify patch 003 is applied (re-use the pattern from Phase 06.03 sentinel check).

### Rate limiter semantics

- Config shape in `jellyclaw.json`:
  ```json
  {
    "rateLimits": {
      "browser": {
        "default": { "capacity": 5, "refillPerSecond": 1 },
        "perDomain": {
          "example.com": { "capacity": 10, "refillPerSecond": 2 }
        }
      }
    }
  }
  ```
- Policy resolver maps a tool call to a key:
  - `mcp__playwright__browser_navigate` → `browser:<hostname(url)>`.
  - `mcp__playwright__browser_click|type|snapshot` etc. → inherit domain from current page context (stored per session in engine state; fall back to previous `navigate` host).
  - Non-browser tools → no rate limiting (future-extensible).
- On empty bucket:
  - **Default behavior:** `await` refill up to a `maxWaitMs` (default 5 s); emit `Notification` "rate limited, waiting".
  - **`strict: true`** config: return a tool error `rate_limited` immediately.

### Secret scrubber semantics

- Scrubber runs on **every tool result** returned by a handler, BEFORE:
  - Emitting the `PostToolUse` event.
  - Passing to hooks.
  - Writing to session JSONL.
  - Returning to the model.
- Replacement policy: replace match with `[REDACTED:<type>]` where `<type>` is the pattern label (e.g. `[REDACTED:anthropic_api_key]`). This makes debugging easier than full redaction.
- Counter in `hits` is audit-logged per call so users notice.
- Tool **inputs** are NOT scrubbed (the model sent them; that's already in-context) — but inputs passed to `PreToolUse` hooks for MCP tools where the input might contain a pulled-from-env secret ARE scrubbed. Document this asymmetry.
- User-extended patterns: `config.secrets.patterns: [{ name: "my_api", regex: "MYAPI[A-Z0-9]+" }]`. Validate regex is non-anchored and non-backreffing (no catastrophic backtracking — bail out with warn if a pattern takes >50 ms to compile-test against 1 MB of 'a's).

### Scrubber performance budget

- Apply only to string nodes in the JSON tree.
- Skip strings < 8 chars (no secret fits).
- Short-circuit after first hit per string if `fast: true` (default `false` — prefer correctness; make it a config knob).
- Track total time per tool call; if > 100 ms, log a warn with the offending pattern so users know what's slow.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/ratelimit engine/src/security
bun run lint
```

### Expected output

- All tests green.
- E2E scrub test: run a mock tool returning `"my key is sk-ant-abc123xyz"`; observe event stream contains `[REDACTED:anthropic_api_key]`.
- Rate limit test: 10 rapid navigates → 6th onward delayed; with `strict: true` they fail.

### Tests to add

- `token-bucket.test.ts`:
  - Capacity enforcement; refill over time (with a fake clock).
  - `acquire` returns immediately if tokens available; waits otherwise.
  - `tryAcquire` returns boolean.
- `ratelimit-policies.test.ts`:
  - `browser_navigate` to `https://example.com/foo` → key `browser:example.com`.
  - Subsequent `browser_click` inherits key from session state.
  - Unknown tools → no key (passthrough).
- `scrub.test.ts`:
  - Each built-in pattern: positive and negative cases.
  - Multiple secrets in one string; all replaced.
  - User-extended pattern loaded from config.
  - Catastrophic regex detected and rejected at load time.
- `apply-scrub.test.ts`:
  - Nested object: strings inside arrays/objects scrubbed; numbers/booleans untouched.
  - Circular reference safety (cap depth; warn).
- `integration-scrub-e2e.test.ts`:
  - Register a mock tool that returns a payload containing a GitHub token.
  - Run a turn; assert the event stream, session JSONL, and hook payloads all have the token replaced.
  - Assert the audit log records `hits: 1`.

### Verification

```bash
bun run test engine/src/ratelimit engine/src/security   # expect: green
bun run typecheck && bun run lint

# Patch sentinel check (reuse pattern from Phase 06.03)
bun run tsx scripts/verify-scrub-patch.ts
# expect: prints "patches/003-secret-scrub-tool-results.patch applied"

# Smoke:
cat > /tmp/leak-tool.ts <<'EOF'
// mock tool that returns a fake AWS key
EOF
./dist/cli.js run "call the mock-leak tool"
# expect: assistant sees "[REDACTED:aws_access_key_id]" not the raw key
```

### Common pitfalls

- **Order matters:** scrub BEFORE event emit. If you scrub after, the event stream leaks; consumers (including Genie) never see unscrubbed data.
- Regex ReDoS: never accept user patterns without a compile-time smoke test against pathological strings.
- Don't scrub tool _inputs_ (inputs came from the model, already in context) except where noted.
- Rate limit waits must be cancellable — if the engine is aborted mid-wait, release the `await` immediately.
- Token-bucket refill: use monotonic clock (`performance.now()`), not wall clock — DST / time jumps corrupt buckets.
- Config hot-reload: if `jellyclaw.json` changes at runtime (future), pattern changes should NOT retroactively re-scrub stored sessions — document that.
- User-visible labels in `[REDACTED:...]`: don't accidentally leak a secret's _label_ that reveals a surprising pattern name (e.g. `internal_aws_staging` in label). Users are responsible for naming — document this.
- Do not scrub inside error stack traces passed to hooks — those are engine-internal debug info the user needs to see (but still audit-log if a pattern matches stack text; that's a leak bug).
- MCP env values (from Phase 07.01 credential-strip) are secrets too — merge their values into this scrubber's runtime pattern set at engine boot. One source of truth.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: Phase 08 fully ✅, next prompt = prompts/phase-09/01-sqlite-schema-and-storage.md. -->
<!-- END paste -->
