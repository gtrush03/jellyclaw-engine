# Rate limiting + secret scrubbing (Phase 08.03)

Two engine-wide controls landed in Phase 08.03. Both are configured via
`jellyclaw.json` and validated by `engine/src/config/schema.ts`.

## 1. Rate limiter

**Modules:** `engine/src/ratelimit/{token-bucket,registry,policies,index}.ts`.

Browser tools (`mcp__playwright__browser_*`) are rate-limited per
hostname to protect sites from runaway agent loops. A token bucket per
domain key refills continuously; empty bucket either awaits refill (up
to `maxWaitMs`) or — in `strict` mode — denies immediately.

```json
{
  "rateLimits": {
    "strict": false,
    "maxWaitMs": 5000,
    "browser": {
      "default":   { "capacity": 5,  "refillPerSecond": 1 },
      "perDomain": {
        "example.com": { "capacity": 10, "refillPerSecond": 2 }
      }
    }
  }
}
```

**Key derivation** (`ratelimit/policies.ts`):

| Tool | Key |
|---|---|
| `mcp__playwright__browser_navigate` | `browser:<hostname(input.url)>` |
| other `mcp__playwright__browser_*` | inherits `session.lastBrowserHost` — falls back to `browser:_unknown` |
| anything else | `null` — no rate limit |

Invalid URL → `{ key: null }` + warn log (don't block work on a malformed input).

**Semantics:**
- Refill is continuous: `tokens = min(capacity, tokens + elapsed_s * refillPerSecond)`.
- `acquire({ maxWaitMs, signal })` is cancellable via `AbortSignal`.
- Monotonic clock injected — no `Date.now()`, no DST pitfalls.
- Registry LRU-evicts least-recently-used keys when `maxKeys` (default 1000) is exceeded.

**Wiring (deferred to Phase 10):** the permission engine's pipeline
will call `rateLimitRegistry.get(key)?.acquire(...)` as a post-hook,
pre-execute step. Today the module is standalone — integration tests
exercise it via synthetic `ToolCall` fixtures.

## 2. Secret scrubber

**Modules:** `engine/src/security/{secret-patterns,scrub,apply-scrub,index}.ts`.

Every tool result is scrubbed **before** it reaches the event stream,
hooks, or session persistence. Scrubbing replaces matches with
`[REDACTED:<name>]` so debugging stays possible.

### Built-in patterns

12 patterns, ordered narrow-first so earlier specific hits consume
bytes a later broader pattern would match:

| name | coverage |
|---|---|
| `anthropic_api_key` | `sk-ant-...` |
| `openrouter_api_key` | `sk-or-...` |
| `openai_api_key` | `sk-...` / `sk-proj-...` |
| `aws_access_key_id` | `AKIA[0-9A-Z]{16}` |
| `github_pat_fine` | `github_pat_...` |
| `github_pat_legacy` | `ghp_` / `gho_` / `ghs_` / `ghu_` / `ghr_` |
| `stripe_live` / `stripe_test` | `sk_live_...` / `rk_test_...` |
| `slack_bot_token` | `xox[baprs]-...` |
| `jwt` | `eyJ...` three-segment |
| `authorization_bearer` | `Authorization: Bearer ...` (whole header) |
| `generic_password_assignment` | `password=value` assignments |

### User-extended patterns

```json
{
  "secrets": {
    "patterns": [
      { "name": "my_corp_key", "regex": "MYCORP[A-Z0-9]{16,}" }
    ],
    "minLength": 8,
    "fast": false
  }
}
```

**Guards applied at compile time:**
- ReDoS probe — each regex tested against 1 MB of `"a"`; > 50 ms rejected.
- Backreference scan — `\1..\9` rejected (catastrophic backtracking family).
- `/g` flag auto-added if the user omits it.
- Pattern name must be `snake_case` (`/^[a-z0-9_]+$/`).

Invalid patterns are **warnings, not fatal** — the engine boots with
the built-in set and logs which user patterns were dropped.

### Runtime literals

The minted `OPENCODE_SERVER_PASSWORD` and MCP server env values (from
Phase 07.01 credential strip) are merged into the pattern set at engine
boot via `mergePatterns(builtins, user, literals)`. One source of truth.

### JSON tree walk (`apply-scrub.ts`)

- Scrubs every string leaf. Numbers, booleans, null, undefined pass
  through.
- Clones objects/arrays — input never mutated.
- Depth cap (default 32) → `"[TRUNCATED]"` sentinel + `truncated: true`.
- Cycle-safe via `WeakSet` → `"[CYCLE]"` sentinel.
- Soft time budget (default 100 ms) → warn log, continues.
- Skips strings shorter than `minLength` (default 8).

### What is **not** scrubbed

- **Tool inputs.** The model sent them — they are already in-context.
  The one exception is `PreToolUse` hook payloads for MCP tools, where
  the tool input may have had env-sourced secrets substituted in.
- **Error stack traces passed to hooks.** These are engine-internal
  debug info the operator needs. (If a pattern does match inside a
  stack, that is a scrub-pipeline bug, not a feature — audit-log it.)
- **Pattern labels.** `[REDACTED:<name>]` uses the pattern's public
  name. Users who name a pattern `internal_aws_staging` will see that
  name in scrubbed output — don't encode secrets in pattern names.

### Sentinel

`scripts/verify-scrub-patch.ts` gates regressions on every opencode-ai
version bump. Two checks:

1. **Static:** `patches/003-secret-scrub-tool-results.design.md` still
   marked `STATUS: superseded`; both `engine/src/plugin/secret-scrub.ts`
   and `engine/src/security/index.ts` present; expected public surface
   exported.
2. **Dynamic:** `test/integration/scrub-e2e.test.ts` passes. The e2e
   test simulates a tool handler → scrub → three observers (event
   stream, hook payload, session log) and asserts no observer ever
   sees the raw secret.

Run: `bun run verify:scrub-patch`.
