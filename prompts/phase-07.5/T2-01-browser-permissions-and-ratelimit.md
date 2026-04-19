# Phase 07.5 — Chrome MCP — Prompt T2-01: Browser autonomous allowlist + rate limit

**When to run:** After `T1-02` ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

**Design decision (locked by George, 2026-04-17):** All browser MCP tools run in FULLY AUTONOMOUS mode — no confirmation prompts, no ask-dialog, no carve-out for `browser_evaluate` / `browser_run_code` / `browser_file_upload`. This matches Claude Code's pattern for jellyclaw's usage: wildcard allowlist via `permissions.allow: ["mcp__playwright__*"]` + `defaultMode: "dontAsk"`. The ONLY safety gate is the rate limiter.

## Research task

1. Re-read `phases/PHASE-07.5-chrome-mcp.md` Step 5 (updated) and § 5 of `docs/CHROME-MCP-INTEGRATION-PLAN.md`.
2. Read `~/.claude/settings.json` as reference — note how Claude Code uses `"mcp__plugin_compound-engineering_pw__*"` in the allow array and `defaultMode: "dontAsk"` for autonomous operation. We mirror this pattern for jellyclaw.
3. Read `engine/src/permissions/` end-to-end — `engine.ts`, `rules.ts`, `types.ts`. Find how the default allow-list is seeded + how `defaultMode` interacts with explicit allow entries.
4. Read `engine/src/config/settings-loader.ts` — this loads `~/.jellyclaw/settings.json` (Claude-Code-compat). Confirm it supports wildcard allow patterns.
5. Read `engine/src/agents/loop.ts` around the permission gate (lines ~566-581) and MCP tool dispatch (lines ~617-680). Find where to insert the rate limiter.
6. Read `engine/src/ratelimit/` — `policies.ts`, `registry.ts`, `token-bucket.ts`. Match the existing pattern.

## Implementation task

Ship two changes:

1. **Default allowlist update** — `engine/src/permissions/rules.ts` gets a default pattern `mcp__playwright__*` marked `allow`. Same for `mcp__chrome-devtools__*` (covers T3-02 if it ever lands). No `ask` carve-outs — `browser_evaluate`, `browser_run_code`, `browser_file_upload` all run under `allow` like every other browser tool.
2. **Rate-limit bucket** — introduce `browser:60/min` burst 10 bucket in `engine/src/ratelimit/policies.ts`. Gates all `mcp__*__browser_*` calls AND `mcp__chrome-devtools__*`. On bucket exhaustion emit `tool.error code="rate_limited"`. This is the only safety on the browser path — pure runaway protection, not user confirmation.

This prompt does NOT add the E2E test (T2-02) or rewrite docs (T3-01).

### Files to modify

- `engine/src/permissions/rules.ts` — add default wildcard allow for browser MCP patterns
- `engine/src/ratelimit/policies.ts` — register `BROWSER_BUCKET` (60 req/min, burst 10)
- `engine/src/ratelimit/registry.ts` — wire consumption hook
- `engine/src/agents/loop.ts` — call rate limiter at the MCP dispatch branch (lines ~617-680)
- `engine/src/permissions/rules.test.ts` — test the wildcard allow
- `engine/src/ratelimit/policies.test.ts` — test the browser bucket
- `engine/src/agents/loop.test.ts` — integration test: 70 rapid browser tool calls → first 60 pass, next 10 return `rate_limited`

### Default allowlist addition

In `engine/src/permissions/rules.ts` (follow the existing seed pattern):

```ts
export const DEFAULT_ALLOW_PATTERNS: readonly string[] = [
  // …existing entries…
  "mcp__playwright__*",        // autonomous browser MCP (see Phase 07.5)
  "mcp__playwright-extension__*",
  "mcp__chrome-devtools__*",   // reserved for Phase 07.5 T3-02 if shipped
];
```

Ensure `decide()` treats wildcard matches identically to exact-name matches. If the existing matcher only does string-equals, extend it to handle `*` suffix (minimal glob: `mcp__playwright__*` matches `mcp__playwright__browser_navigate`). No regex — keep it a simple `startsWith(prefix)` after stripping the `*`.

### Rate-limit implementation

In `engine/src/ratelimit/policies.ts`:

```ts
export const BROWSER_BUCKET = {
  name: "browser",
  ratePerMin: 60,
  burst: 10,
} as const;

export const DEFAULT_POLICIES = [
  // …existing…
  BROWSER_BUCKET,
];
```

In `engine/src/agents/loop.ts` at the MCP dispatch branch — BEFORE the `mcp.callTool(...)` call:

```ts
if (toolName.startsWith("mcp__") && /^mcp__[a-z0-9-]+__browser_/.test(toolName)) {
  const allowed = await rateLimiter.take("browser");
  if (!allowed) {
    yield { type: "tool.error", session_id, ts: now(), seq: nextSeq(),
            tool: toolName, tool_id: callId,
            code: "rate_limited",
            message: "browser: 60 req/min (burst 10) limit hit — back off and retry" };
    continue;
  }
}
```

The rate-limiter is also the match for `mcp__chrome-devtools__*` tools. Pattern: any tool name starting with `mcp__` whose third segment starts with `browser_` OR whose namespace is `chrome-devtools` (since its tools don't have the `browser_` prefix). Use this regex:

```ts
const BROWSER_RATE_LIMITED = /^mcp__([a-z0-9-]+)__(browser_|performance_|lighthouse_|take_|navigate_|list_|close_|select_|new_|get_network_)/;
```

Simpler alternative: match `/^mcp__(playwright|playwright-extension|chrome-devtools)__/`. Take whichever the code style prefers.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/permissions/
bun run test engine/src/ratelimit/
bun run test engine/src/agents/loop.test.ts
bun run lint
bun run build
```

### Expected output

- `jellyclaw run` with a model calling `mcp__playwright__browser_evaluate` proceeds WITHOUT a permission prompt. No `permission.requested` / `permission.granted` events for browser tools. (These events may still appear for OTHER tools; verify only browser tools are autonomous.)
- `browser_run_code`, `browser_file_upload`, `browser_navigate`, `browser_click` — all autonomous. Zero confirmation.
- 70 rapid `browser_navigate` calls in a burst window → first 60 succeed, next 10 yield `tool.error code="rate_limited"`. Bucket refills at 1/sec.
- Non-browser tools (Bash, etc.) unchanged — still follow their existing permission posture.
- No regression in existing Bash carve-out or any other permission behavior.

### Tests to add

- `engine/src/permissions/rules.test.ts`:
  - `mcp__playwright__browser_navigate` → allow under any `--permission-mode`
  - `mcp__playwright__browser_evaluate` → allow (NOT ask; the carve-out was removed)
  - `mcp__playwright__browser_run_code` → allow
  - `mcp__playwright__browser_file_upload` → allow
  - `mcp__chrome-devtools__lighthouse_audit` → allow (wildcard handles it even though T3-02 is deferred)
  - `mcp__some-other-server__foo` → default behavior (not auto-allowed by this patch)
  - Bash still respects existing rules
- `engine/src/ratelimit/policies.test.ts`:
  - `BROWSER_BUCKET` starts with 10 burst tokens
  - Refill rate is 1 token per second
  - Non-browser tool names don't consume from the bucket
- `engine/src/agents/loop.test.ts`:
  - 70 back-to-back `browser_navigate` calls yield exactly 60 successes + 10 `rate_limited` errors
  - After 10s wait, next call succeeds again (bucket refilled)

### Verification

```bash
bun run test                    # full suite — no regressions
bun run typecheck
bun run lint

# Autonomous-mode smoke (requires Chrome running per T1-02 + MCP config per T0-01)
echo "use browser_evaluate to return document.title of https://example.com" | \
  ./engine/bin/jellyclaw run --output-format stream-json --max-turns 3
# Expect: NO permission.requested event for the browser_evaluate call
# Expect: tool.called → tool.result with the page title
```

### Common pitfalls

- **Do NOT keep the carve-out from earlier drafts.** George explicitly locked autonomous mode. `browser_evaluate` and `browser_run_code` must match the wildcard and proceed without confirmation.
- **Don't hardcode specific tool names in the permission rule.** The wildcard `mcp__playwright__*` is the contract. Adding specific names makes the list stale every time Microsoft adds a browser_* tool.
- **Keep Bash carve-out if it exists.** George's autonomous mode is for the BROWSER. Bash safety is a separate decision; don't touch it.
- **Rate limit must live in the agent loop tool-dispatch branch**, not the provider wrapper. Matches where the permission gate lives in practice (Agent 2 investigation confirmed).
- **Emit `tool.error`, not `permission.denied`, for rate-limit.** Distinct event types in `engine/src/events.ts`. Do not collapse them.
- **Burst 10 is deliberate.** Pure 60/min linear rate would deny the model the first 2-3 rapid calls of a session. Burst gives headroom; refill keeps the long-run bound.
- **Don't forget tracking for `mcp__playwright-extension__*`.** The extension-bridge flow uses a different server name; make sure the wildcard + the rate-limit regex cover it.
- **Don't wrap the rate limiter in a permission decision.** They're two layers; rate limit is runaway protection, permission is authorization. Keep them separate.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T2-01 ✅`.
2. Update `STATUS.md` to point at `T2-02`.
3. Print `DONE: T2-01`.

On fatal failure: `FAIL: T2-01 <reason>`.
