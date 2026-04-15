# Providers

Reference for configuring jellyclaw's model providers: which one to pick, why
the defaults are what they are, and how to avoid billing yourself 4-10× too much
by accident.

## 1. Overview

jellyclaw ships with two provider backends:

- **Anthropic direct** (`provider: "anthropic"`) — default. Talks to
  `api.anthropic.com` via `@anthropic-ai/sdk`. Prompt caching works.
- **OpenRouter** (`provider: "openrouter"`) — secondary. Talks to
  `openrouter.ai/api/v1` via a raw `fetch` + SSE pipeline. Used when you need a
  model Anthropic doesn't serve (Gemini, Qwen, Llama, DeepSeek, etc.).

**Anthropic direct is the default because caching works.** For the Claude
family (Opus, Sonnet, Haiku) every session is structured around up to four
`cache_control` breakpoints that cut steady-state input cost by 85%+. Those
breakpoints are silently dropped or actively rejected on the OpenRouter-to-
Anthropic path (see §6), so routing Claude through OpenRouter is a 4-10× billing
blowup waiting to happen. For everything else, OpenRouter is fine and usually
the only option.

See [`../engine/SPEC.md`](../engine/SPEC.md) §6 for the full provider contract
and [`../engine/PROVIDER-STRATEGY.md`](../engine/PROVIDER-STRATEGY.md) for the
design rationale.

## 2. Selection matrix

| Model vendor              | Recommended provider          | Caching behavior                                   | Rationale                                                                                                                                                  |
|---------------------------|-------------------------------|----------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Anthropic (Claude family) | `anthropic`                   | Full `cache_control` (4 breakpoints, 5m + 1h TTL)  | Only path where jellyclaw's cache strategy actually fires. See [research-notes §3](../engine/provider-research-notes.md) and SPEC §7.                      |
| Google (Gemini)           | `openrouter`                  | None — `cache_control` stripped (§6)               | Anthropic SDK cannot serve Gemini. Google-direct is on the roadmap (see FAQ). Gemini has implicit server-side caching unrelated to `cache_control`.        |
| Qwen                      | `openrouter`                  | None — `cache_control` stripped                    | No first-party Qwen SDK integration in jellyclaw yet.                                                                                                      |
| Llama (Meta / Groq / Cerebras) | `openrouter`             | None — `cache_control` stripped                    | Groq/Cerebras-direct is on the roadmap. Today these all go through OR.                                                                                     |
| DeepSeek, Mistral, other  | `openrouter`                  | None — `cache_control` stripped                    | Default for the long tail.                                                                                                                                 |
| Anthropic (Claude family) via OR | **not recommended**    | None — stripped; blocked by gate by default        | Caching broken in transit (§6). Possible only with `acknowledgeCachingLimits: true` (§7). Use `--provider anthropic` instead.                              |

Resolution order (from SPEC §6.3):

1. `--provider` CLI flag
2. `provider` field in resolved config
3. Heuristic on model ID prefix (`claude-*` or `anthropic/*` → `anthropic`, else
   `openrouter`)
4. Hard default: `anthropic`

## 3. Caching matrix

What you get per-feature on each provider.

| Feature                                 | Anthropic direct                                                                      | OpenRouter                                                        |
|-----------------------------------------|---------------------------------------------------------------------------------------|-------------------------------------------------------------------|
| Prompt caching — system block           | Yes. `cache_control: { type: "ephemeral", ttl: "1h" }` on last system block.          | No. `cache_control` stripped from outgoing body unconditionally.  |
| Prompt caching — tools array            | Yes. `cache_control` on the last tool; caches the entire prefix.                      | No. Stripped.                                                     |
| Prompt caching — CLAUDE.md (user turn)  | Yes. 5m TTL on the CLAUDE.md text block.                                              | No. Stripped.                                                     |
| Prompt caching — skills bundle          | Yes. 5m TTL on the skills-bundle text block.                                          | No. Stripped.                                                     |
| `cache_read_input_tokens` accounting    | Accurate. Sourced from Anthropic's own `usage` field on `message_start`.              | Unreliable — do not trust for budget math. See §6.                |
| `cache_creation_input_tokens` accounting| Accurate.                                                                             | Unreliable. OR's `prompt_tokens_details.cached_tokens` is 0 on our path anyway. |
| Rate-limit headers                      | Standard `Retry-After`, `anthropic-ratelimit-*-reset`.                                | Standard `Retry-After`. Also `X-Generation-Id` per attempt.       |
| Provider-initiated fallback             | No (single provider).                                                                 | Yes, between OR's downstream providers — disabled in jellyclaw's request body. |
| Error codes                             | 400/401/403/404/413/422/429/500/529.                                                  | Adds `402 payment_required` (credit exhausted). See §9.           |

### 3.1 `cache_control` content eligibility (Anthropic direct only)

Source: <https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching>
and [research-notes §3.1](../engine/provider-research-notes.md).

Eligible to carry `cache_control`:

- Any entry of `tools[]`.
- Any entry of `system[]` when system is structured (array of content blocks).
- `text`, `image`, `document`, `tool_use`, `tool_result` blocks inside
  `messages[].content[]`, for both `user` and `assistant` turns.

Not eligible: `thinking` blocks (implicitly cached with their parent turn),
sub-content like citations, empty text blocks.

### 3.2 Minimum cacheable token thresholds

From [research-notes §3.2](../engine/provider-research-notes.md). Below these
sizes, `cache_control` is silently ignored — the API returns no error, no
warning, and no cache entry is created.

| Model tier                                              | Min tokens to cache |
|---------------------------------------------------------|---------------------|
| Claude Mythos Preview / Opus 4.6 / Opus 4.5             | 4096                |
| Claude Sonnet 4.6                                       | 2048                |
| Sonnet 4.5 / Opus 4.1 / Opus 4 / Sonnet 4 / Sonnet 3.7  | 1024                |
| Claude Haiku 4.5                                        | 4096                |
| Claude Haiku 3.5                                        | 2048                |
| Claude Haiku 3                                          | 4096                |

Quote from Anthropic's docs:

> Shorter prompts cannot be cached, even if marked with `cache_control`. Any
> requests to cache fewer than this number of tokens will be processed without
> caching, and no error is returned.

jellyclaw probes system-prompt token count once at startup via
`client.messages.countTokens()` and logs a warning if your configured system
block sits below the threshold for your selected model.

### 3.3 Usage fields

On every Anthropic response (streaming: on the `message_start` event), the
`usage` object reports:

```json
"usage": {
  "input_tokens": 50,
  "output_tokens": 1,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 1800
}
```

- `cache_read_input_tokens`: prefix-before-breakpoint hit from cache.
- `cache_creation_input_tokens`: prefix-before-breakpoint being written this
  request.
- `input_tokens`: everything after the last breakpoint (always uncached).

Hit rate (jellyclaw's telemetry metric):

```
hitRate = cache_read / (cache_read + cache_creation + input_tokens)
```

Target in steady-state Genie usage: ≥85% on system+tools, ≥60% on CLAUDE.md
(SPEC §7). See [research-notes §3.8](../engine/provider-research-notes.md).

## 4. The four breakpoints

Anthropic allows at most 4 explicit `cache_control` breakpoints per request.
jellyclaw uses all four. Order from most-stable to least-stable, which is also
the order the API evaluates for hit-matching (see
[research-notes §3.4](../engine/provider-research-notes.md)):

| # | Slot              | What goes in it                                              | TTL       | Invalidates when...                                                            |
|---|-------------------|--------------------------------------------------------------|-----------|--------------------------------------------------------------------------------|
| 1 | `system`          | Agent persona, safety framing, tool-use framing.             | 1h (beta) | Persona text changes. Do not put timestamps or session IDs here.               |
| 2 | `tools` last      | Full tools array (everything up to and including last tool). | 5m        | Any tool added/removed, schema changed, or order shuffled.                     |
| 3 | `messages` user   | CLAUDE.md contents as a user-turn text block.                | 5m        | CLAUDE.md edited on disk mid-session, or a new session starts.                 |
| 4 | `messages` user   | Skills bundle (concatenated top-N skill bodies).             | 5m        | Skills ranking changes, a new skill loaded, or skill body edited on disk.      |

### 4.1 Invalidation hierarchy

From Anthropic's docs (quoted in
[research-notes §3.4](../engine/provider-research-notes.md)):

> Hierarchy: `tools` → `system` → `messages`. Changes at each level invalidate
> that level and all subsequent levels.

| Change                     | Invalidates tools | system | messages |
|----------------------------|-------------------|--------|----------|
| Tool definitions change    | ✓                 | ✓      | ✓        |
| Web search toggle          |                   | ✓      | ✓        |
| Citations toggle           |                   | ✓      | ✓        |
| Speed setting              |                   | ✓      | ✓        |
| Tool choice                |                   |        | ✓        |
| Images                     |                   |        | ✓        |
| Thinking parameters        |                   |        | ✓        |

### 4.2 Placement rule

`cache_control` goes on the **last block of the stable prefix**. Everything
before and including that block is cached. Source:
<https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching>.

Concretely, for the user content array:

```
messages[0].content:
  [ CLAUDE.md            cache_control:5m,    <- breakpoint #3
    skills_bundle        cache_control:5m,    <- breakpoint #4
    user_text                               ] <- NOT cached (varies)
```

The `user_text` block is deliberately NOT marked, because caching a block whose
content changes every turn creates only misses.

### 4.3 Maximum breakpoints

Up to 4 explicit breakpoints per request. If you exceed 4 you get a 400 — see
[research-notes §3.5](../engine/provider-research-notes.md). jellyclaw's four
slots map 1:1 onto this limit; you cannot add a 5th from user config.

### 4.4 Lookback window

Anthropic matches against at most 20 prior cache positions per breakpoint
(counting the breakpoint itself as the first). See
[research-notes §3.7](../engine/provider-research-notes.md). jellyclaw does not
need to tune this — it's an upper bound on matching fuzziness that we benefit
from automatically.

## 5. The `anthropic-beta` header

The default 5-minute TTL requires no beta opt-in. The 1-hour TTL (used on
breakpoint #1, the system block) requires the `extended-cache-ttl-2025-04-11`
beta header:

```
anthropic-beta: extended-cache-ttl-2025-04-11
```

jellyclaw's Anthropic provider **auto-sets this header** whenever any breakpoint
in the outgoing request body carries `ttl: "1h"`. You do not need to configure
it. The header string lives in a single constant:

```
engine/src/providers/anthropic-beta.ts:
  export const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-2025-04-11";
```

### 5.1 Cost tradeoff for 1h TTL

- **Write:** 2× base input token price (vs 1.25× for 5m writes).
- **Read:** 0.1× base — identical to 5m reads.

The 1h slot is worth it for the system prompt because that block is extremely
stable (changes only when the agent persona is edited) and survives across
Anthropic's 5m eviction window during idle pauses. For everything else
(tools, CLAUDE.md, skills), the default 5m TTL pays back faster. See
[research-notes §3.3](../engine/provider-research-notes.md) for the multi-
source confirmation of the header string.

Source: <https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching>.

## 6. Read this before using OpenRouter with a Claude model

If you run jellyclaw with `provider: "openrouter"` and a model like
`anthropic/claude-sonnet-4.6`, prompt caching does not work and you will be
billed somewhere between 4× and 10× what the same session would cost on
`provider: "anthropic"`. This is a current upstream problem in
OpenRouter's Anthropic proxy layer and in the Anthropic API's treatment of
OAuth-scoped tokens — it is not a jellyclaw bug, and there is no workaround
inside jellyclaw that would fix it.

The two open issues driving this:

- **Issue #1245** —
  <https://github.com/sst/opencode/issues/1245> (primary tracked issue in the
  opencode fork: *"Anthropic caching not really working via OpenRouter"*),
  with root cause upstream at
  <https://github.com/OpenRouterTeam/ai-sdk-provider/issues/35>. Independent
  reproductions in Zed
  (<https://github.com/zed-industries/zed/issues/52576>) and Pydantic AI
  (<https://github.com/pydantic/pydantic-ai/issues/4392>). `cache_control`
  objects in the outbound request are silently dropped before reaching
  Anthropic. The request returns 200, the prompt is billed at base rate, and
  `cache_read_input_tokens` stays 0 forever. Full detail in
  [research-notes §7.1](../engine/provider-research-notes.md).

- **Issue #17910** —
  <https://github.com/anomalyco/opencode/issues/17910> (*"bug: OAuth auth +
  cache_control ephemeral causes HTTP 400 on all Claude models since
  2026-03-17"*). OAuth-provisioned Anthropic tokens (used by OR's
  subscription routing) combined with any `cache_control` object now return
  HTTP 400 outright, as of 2026-03-17. Full detail in
  [research-notes §7.2](../engine/provider-research-notes.md).

**Never trust OpenRouter's `cache_read_input_tokens` or
`prompt_tokens_details.cached_tokens` for budget math on Anthropic models.
Cross-check against Anthropic's own billing where possible, or (easier) just
use `--provider anthropic` for Claude traffic.**

### 6.1 What jellyclaw does about it

Two defences, both unconditional on the OR path:

1. **Strip `cache_control` from the outgoing request body.** The OpenRouter
   provider walks the request object before serialization and deletes every
   `cache_control` key, recursively, including nested ones inside tool
   definitions and system blocks. This avoids the #17910 400. It also means OR
   never sees our cache breakpoints, so #1245 cannot silently billing-blow-up
   either — the worst case is plain uncached throughput at OR markup, not
   10× uncached throughput.
2. **Emit a one-time loud boot warning** when an `anthropic/*` model resolves
   via the OR provider. The warning (verbatim from SPEC §6.2):

   ```
   [jellyclaw] OpenRouter provider active with an Anthropic model.
               Prompt caching is currently broken on this route
               (upstream issues #1245, #17910). Expect 4-10× higher
               token cost. Use --provider anthropic for full caching.
   ```

   Emitted to stderr via the pino logger, exactly once per process, regardless
   of how many OR provider instances you construct. Non-Anthropic models
   routed through OR emit nothing — they're the reason OR exists.

### 6.2 Re-evaluation cadence

jellyclaw re-tests OR cache behavior quarterly. If two consecutive runs of the
probe script (`scripts/probe-or-cache.ts`) report
`cache_read_input_tokens > 0` on an expected cache hit, we start a new research
cycle — we do not flip the policy on one data point. See
[research-notes §7.5](../engine/provider-research-notes.md).

## 7. The `acknowledgeCachingLimits` gate

Because routing Claude through OR is a silent billing trap, jellyclaw blocks
that configuration by default. You must opt in explicitly.

### 7.1 Default behavior

`acknowledgeCachingLimits` defaults to `false`. When it's `false` and your
resolved provider is `openrouter` AND your resolved model vendor is
`anthropic`, jellyclaw refuses to dispatch any calls. You get this error at
config-load / CLI parse time (not at first model call):

```
[jellyclaw] Refusing to dispatch model 'anthropic/claude-sonnet-4.6'
            via the OpenRouter provider with caching disabled.

            Known problems on this route (see engine/provider-research-notes.md §7):
              * Issue #1245 — cache_control is silently stripped in transit.
                Result: cache_read_input_tokens stays 0. Typical cost
                impact: 4-10× higher billing vs direct Anthropic.
              * Issue #17910 — OAuth-authenticated OpenRouter accounts
                return HTTP 400 on any request with cache_control since
                2026-03-17.

            To proceed anyway, either:
              * switch to --provider anthropic (recommended), OR
              * set "acknowledgeCachingLimits": true in your jellyclaw
                config, OR
              * pass --acknowledge-caching-limits on the CLI.

Exit code: 4 (config validation failure).
```

### 7.2 Three ways to flip it

Pick one:

- **Config file** — add `"acknowledgeCachingLimits": true` at the top level of
  your `jellyclaw.json` (not under `cache` — it's a safety gate, not a cache
  knob).
- **Environment variable** — `JELLYCLAW_ACKNOWLEDGE_CACHING_LIMITS=1`.
- **CLI flag** — `--acknowledge-caching-limits`.

Any of the three is sufficient. CLI wins over env, env wins over config file.

### 7.3 Decision table

From [research-notes §10.3](../engine/provider-research-notes.md):

| Provider     | Model vendor | Gate      | Action                                                                                                                  |
|--------------|--------------|-----------|-------------------------------------------------------------------------------------------------------------------------|
| `anthropic`  | `anthropic`  | any       | **Proceed.** Full `cache_control`. Happy path.                                                                          |
| `anthropic`  | `other`      | any       | **Reject at config load.** Anthropic SDK cannot serve non-Anthropic models. Exit code 4.                                |
| `openrouter` | `other`      | any       | **Proceed.** `cache_control` stripped from body. No warning beyond the one-time OR banner.                              |
| `openrouter` | `anthropic`  | `false`   | **Reject at config load / CLI.** Print the hard-error text above. Exit code 4.                                          |
| `openrouter` | `anthropic`  | `true`    | **Proceed.** `cache_control` stripped. Emit the SPEC §6.2 warning once per process.                                     |

### 7.4 What the gate does not do

- It does not prevent an informed user with the flag set from making a bad
  choice. The whole point of an acknowledgement is that you've read the
  warning and decided to pay the cost anyway.
- It does not affect non-Anthropic OR routing. Gemini, Qwen, Llama, etc., all
  route through OR without touching the gate.
- It does not distinguish OR-via-API-key from OR-via-OAuth. OR does not expose
  which auth path a given key uses, so jellyclaw pessimistically assumes OAuth
  is in play and strips `cache_control` unconditionally. See
  [research-notes §10.6](../engine/provider-research-notes.md).

## 8. Credential pooling

Optional round-robin across multiple API keys for the same provider, to smooth
over per-key rate limits. **Off by default.** Activates automatically when
jellyclaw detects 2+ contiguous numbered env vars for a provider.

### 8.1 Env var pattern

```
ANTHROPIC_API_KEY_1=sk-ant-xxx
ANTHROPIC_API_KEY_2=sk-ant-yyy
ANTHROPIC_API_KEY_3=sk-ant-zzz
```

Resolution order (first match wins, from
[research-notes §9.1](../engine/provider-research-notes.md)):

1. Config file `providers.primary.apiKey` (single string) — if set, pooling off.
2. Environment `ANTHROPIC_API_KEY` (single) — if set, pooling off.
3. Environment `ANTHROPIC_API_KEY_1..N` scan (N stops at first gap).
   If ≥2 contiguous keys are found, pooling **on**.
4. If only `_1` is set (no `_2`), treated as single-key — pooling off.

Same pattern for OpenRouter: `OPENROUTER_API_KEY_1..N`. Pools are
**per-provider**; the router never mixes an Anthropic key with an OpenRouter
call.

### 8.2 Rotation policy

- **On success:** advance the pointer round-robin. Every call advances,
  regardless of whether it hit cache.
- **On 429 with `Retry-After`:** rotate to the next key immediately and retry
  the same call. If every key in the pool has been tried within the retry
  budget, the provider router falls over to the secondary provider (if
  configured).
- **On 401:** mark that specific key as dead for the process lifetime. Log a
  warning. Continue rotating through the remaining live keys.
- **On non-retryable errors (400, 403, 413):** do not rotate. It's a
  request-shape issue, not a key issue. Fail fast.

### 8.3 Telemetry

When pooling is active, each outbound call is tagged with `credentialSlot: N`
(1-indexed — never the key itself). Rotation events emit
`provider.credential.rotated` to the telemetry bus (opt-in per SPEC §12). Key
material is redacted by the pino logger's redact list.

## 9. Retry and failover

### 9.1 Retry budget (both providers, identical)

- **Max attempts per call:** 3 (initial + 2 retries).
- **Max wall time per call including backoffs:** 30 seconds.
- **Backoff:** exponential with full jitter. Base 250ms, cap 8s.
- **`Retry-After` header:** honored exactly when present (overrides backoff).

### 9.2 Retryability matrix

From [research-notes §4.2](../engine/provider-research-notes.md) and
[§8.1](../engine/provider-research-notes.md):

| Status / cause                     | Retry? | Notes                                                                 |
|------------------------------------|--------|-----------------------------------------------------------------------|
| `400` bad_request                  | No     | Client bug. Retrying loops.                                           |
| `401` authentication               | No     | Bad/expired key. Surface to user. (Credential pool marks dead.)       |
| `402` payment_required (OR only)   | No     | OR credit balance zero. Surface prominently.                          |
| `403` permission                   | No     | Account or region block.                                              |
| `404` not_found                    | No     | Usually a bad model ID.                                               |
| `413` request_too_large            | No     | Pre-flight size check should prevent.                                 |
| `422` unprocessable                | No     | Schema violation.                                                     |
| `429` rate_limit w/ `Retry-After`  | Yes    | Honor header exactly.                                                 |
| `429` rate_limit w/o header        | Yes    | Backoff 2s → 4s → 8s.                                                 |
| `500` api_error                    | Yes    | Transient.                                                            |
| `502` bad_gateway (OR)             | Yes    | Often downstream provider outage; safe to retry.                      |
| `503` service_unavailable          | Yes    | Transient.                                                            |
| `504` gateway_timeout              | Yes    | Transient.                                                            |
| `529` overloaded (Anthropic)       | Yes    | Anthropic overload. Backoff like 429-no-header.                       |
| `ETIMEDOUT`, `ECONNRESET`, `EPIPE` | Yes    | Network.                                                              |
| DNS / TLS failure                  | Yes    | Treated like network.                                                 |
| `AbortError`                       | No     | User cancelled. Propagate as-is. Never triggers failover.             |

### 9.3 ProviderRouter failover semantics

When both primary and secondary are configured, the router:

1. Begins streaming from the primary.
2. If an error is raised **before any chunk has been yielded to the consumer**,
   and `shouldFailover(err)` returns true, and a secondary is configured,
   switches to the secondary and starts streaming from it. Emits
   `provider.failover` telemetry.
3. If an error is raised **mid-stream after at least one chunk has already
   been yielded**, the router **does NOT fail over**. It surfaces the error to
   the consumer. Failing over mid-stream would produce duplicated or
   interleaved output — the user's session would see the first half of the
   answer from the primary and the whole answer from the secondary.
4. `shouldFailover` returns true for 429, 5xx, `ETIMEDOUT`, `ECONNRESET`, and
   false for all other 4xx and `AbortError`.

### 9.4 OR-specific notes

- **402 `payment_required`** is an OR-only code (OR users can run out of
  prepaid credit). Anthropic has no equivalent. Treated as fatal-non-retryable
  with a distinct user-facing message.
- **Multi-provider error aggregation.** When OR fails over internally between
  downstream providers, the final error body may aggregate errors from each.
  jellyclaw logs the raw body verbatim on OR failures.
- **`X-Generation-Id`** appears on every OR response and is captured per
  attempt — each retry is a separate generation in OR's billing.
- **Mid-stream errors** look different: Anthropic sends a structured SSE
  `event: error` frame; OR sends a final chunk with `finish_reason: "error"`
  and an `error` field in the JSON. jellyclaw's OR wrapper detects both.

See [research-notes §8](../engine/provider-research-notes.md).

## 10. Config reference

All config is validated with Zod at load time. Invalid config → exit code 4.
Precedence (first wins): CLI flag → env var → repo-local `jellyclaw.json` →
user-global `~/.jellyclaw/config.json` → compiled defaults.

### 10.1 Minimal Anthropic

The happy path. The `provider` field can be omitted — Anthropic is the hard
default.

```json
{
  "providers": {
    "primary": {
      "kind": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "model": "claude-sonnet-4-6"
    }
  }
}
```

### 10.2 Mixed — Anthropic primary, OpenRouter for non-Anthropic only

Routes Claude traffic directly to Anthropic with full caching, and only falls
back to OpenRouter when the model vendor isn't Anthropic (e.g. a user invokes
a Gemini or Qwen model). This is the recommended multi-vendor setup.

```json
{
  "providers": {
    "primary": {
      "kind": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "model": "claude-opus-4-6"
    },
    "secondary": {
      "kind": "openrouter",
      "apiKey": "${OPENROUTER_API_KEY}",
      "model": "google/gemini-2.0-flash"
    }
  }
}
```

The ProviderRouter uses the secondary only on primary failover (see §9.3) or
when the resolved model ID is explicitly non-Anthropic.

### 10.3 OpenRouter for Claude, gate flipped (NOT RECOMMENDED)

Only include this config if you have a specific reason to route Claude through
OR and you have read §6 in full. You are opting into 4-10× higher billing in
exchange for OR's attribution or a team-shared key. There is no jellyclaw
feature this unlocks that direct Anthropic does not already provide.

```json
{
  "providers": {
    "primary": {
      "kind": "openrouter",
      "apiKey": "${OPENROUTER_API_KEY}",
      "model": "anthropic/claude-sonnet-4.6"
    }
  },
  "acknowledgeCachingLimits": true
}
```

On boot, jellyclaw will emit the §6.1 warning exactly once and strip
`cache_control` from every outgoing request. Your
`cache_read_input_tokens` will be 0 on every call.

## 11. Pitfalls

Common mistakes, in rough order of how often they cost people money:

- **Routing Claude through OpenRouter.** The headline problem. See §6. If you
  find yourself setting `acknowledgeCachingLimits: true`, stop and ask whether
  you actually need it.
- **Putting timestamps, session IDs, or user identity in the system block.**
  Any change in the system block invalidates breakpoints 1-4 (see the
  hierarchy in §4.1). Keep the system block to agent persona + tool-use
  framing only. Anything that changes per-session goes in the user turn.
- **Shuffling tool order between calls.** The tools cache breakpoint is on the
  last tool, but the cache key is the full byte-prefix of the tools array in
  order. A non-deterministic tool list (e.g. from an `Object.entries()` over
  an unsorted map) gives you a 0% hit rate without any error. Sort tools
  deterministically.
- **Quoting CLAUDE.md into the system block.** CLAUDE.md belongs in the user
  turn as breakpoint #3, not in `system`. Putting it in `system` makes
  breakpoint #1 invalidate every time CLAUDE.md changes, which negates the
  1h TTL.
- **Editing CLAUDE.md or skill files mid-session.** The next call is a cache
  miss at breakpoints #3 and #4 (and a fresh write is billed). This is
  unavoidable by design — jellyclaw does not try to fingerprint partial
  changes. Accept the cost.
- **Relying on OpenRouter's cache accounting for budget math.** Even on
  paths where OR does forward `cache_control` to Anthropic, OR's
  `prompt_tokens_details.cached_tokens` does not reliably reflect what
  Anthropic actually billed. Cross-check against Anthropic's own dashboard
  or use `--provider anthropic`.
- **Assuming your 800-token system prompt is cached.** Below the per-model
  minimum (§3.2), `cache_control` is silently ignored. No warning, no error,
  no cache entry. Ensure your system block is over threshold for your chosen
  model.
- **Expecting provider failover to recover mid-stream.** The router only fails
  over on errors raised **before the first chunk is yielded** (see §9.3). If
  a 503 hits halfway through an answer, that answer ends with an error and
  the user re-prompts. This is deliberate — the alternative is duplicated
  output.

## 12. FAQ

**Why is Anthropic direct the default?**
Because prompt caching works on that path and is broken on every other path
today (see §6). A typical Genie session hits 85%+ cache read rate on Anthropic
direct. The same session via OpenRouter hits 0%. The cost difference is
4-10×.

**Can I switch to OpenRouter for Claude?**
Yes, with `acknowledgeCachingLimits: true` (see §7). You will pay 4-10× more
per session and lose cache-read accounting. Unless you have a specific
organizational reason to route through OR, don't.

**Does jellyclaw support Bedrock or Vertex?**
No, not yet. Bedrock / Vertex Claude routing is tracked as future work — see
[research-notes Appendix B](../engine/provider-research-notes.md) and
PROVIDER-STRATEGY §8. The Anthropic cache API is only fully supported on
direct `api.anthropic.com` today; Bedrock and Vertex have partial support with
subtle differences that haven't been audited. When we add them, they land as a
distinct provider kind alongside `anthropic` and `openrouter`.

**Does jellyclaw support Google-direct, Groq-direct, or Cerebras-direct?**
Not yet. Today every non-Anthropic vendor goes through OpenRouter. Native
SDKs for Google (Gemini), Groq, and Cerebras are on the roadmap (see
`PROVIDER-STRATEGY.md` §2). Until they ship, you can still call those models
via `provider: "openrouter"` — `cache_control` is stripped, but Gemini's
implicit server-side caching (when available) still applies.

**How do I reset a credential pool after a key dies?**
Restart the process. Dead keys stay dead for the process lifetime by design —
the assumption is that if a 401 came back, the key was revoked or mistyped,
and retrying it within the same process will keep failing and burning latency
on every rotation. On restart, jellyclaw re-reads every `*_API_KEY_N` env var
and re-validates them all.

**What happens if I set both `ANTHROPIC_API_KEY` and `ANTHROPIC_API_KEY_1..N`?**
The single `ANTHROPIC_API_KEY` wins and pooling is off (see §8.1). If you
want pooling, remove the single-key env var.

**Is caching on by default?**
Yes, on the Anthropic path. Every jellyclaw call builds the four-breakpoint
request shape automatically. There is no flag to turn caching off on
Anthropic direct — you'd have to bypass the provider entirely. On the
OpenRouter path, caching is always off (breakpoints are stripped), regardless
of any config.

**Will jellyclaw warn me if my system prompt is too short to cache?**
Yes. On first load jellyclaw runs `countTokens()` on the system block and
emits a warning if it's under the per-model minimum from §3.2. The warning
does not block the run; the system block just won't create a cache entry.

**Can I use a different beta header for 1h TTL?**
No. The header string is pinned in
`engine/src/providers/anthropic-beta.ts` as a single constant and auto-set
when any breakpoint carries `ttl: "1h"`. If Anthropic rotates the header
name in the future, we update the constant in one place. See
[research-notes §3.3](../engine/provider-research-notes.md) for the
multi-source confirmation of the current value.

**What happens when the primary provider is down?**
The router fails over to the secondary (if configured) on pre-stream errors
only — see §9.3. If mid-stream, the current call errors and the user
re-prompts. If no secondary is configured, the call errors. There is no
dead-letter queue in Phase 02; that lands later in the pipeline.
