# Jellyclaw Provider Strategy

**Status:** Design doc, implemented in `engine/src/provider/`. Last reviewed: 2026-04-14.

This document is how jellyclaw routes model calls across LLM providers, why we pick one provider over another for the same logical model, how we handle prompt caching (which directly controls whether a session costs $0.40 or $4.00), and how we fail over without user-visible disruption.

The short version: **for Anthropic models we go direct**. For everything else we go through OpenRouter unless there's a specific reason to use the vendor SDK directly. The detailed version follows.

---

## 1. Why direct Anthropic and not OpenRouter-for-Claude

OpenRouter is an excellent aggregator for model diversity. It is not currently a good place to call Anthropic models through, because its prompt-caching integration is broken in two distinct ways:

- **Issue #1245** — OpenRouter's Anthropic routing silently drops `cache_control` breakpoints from the request in some code paths. The Anthropic backend accepts the request but charges base rates: no cache write, no cache read. For a 15k-token system prompt this is the difference between $0.045/call and $0.0045/call — a 10× markup.
- **Issue #17910** (opened 2026-03-17) — OAuth-provisioned accounts combined with `cache_control` return HTTP 400 outright. The request fails.

These are upstream bugs. We've contributed reproductions. Until they're resolved across all code paths and confirmed stable, jellyclaw routes Anthropic models directly to `api.anthropic.com`.

**Document this clearly to users.** When a user adds `openrouter/anthropic/claude-sonnet-4-5` as their model, jellyclaw emits a startup warning:

```
[provider] model openrouter/anthropic/claude-sonnet-4-5 will NOT use
           prompt caching (OpenRouter issue #1245). Expected cost
           impact: 4–10× compared to direct routing. Switch to
           anthropic/claude-sonnet-4-5 to use direct routing with
           full caching.
```

---

## 2. Model slug routing

Jellyclaw uses a namespaced slug scheme: `<provider>/<vendor>/<model>` or `<provider>/<model>` when unambiguous. The provider adapter resolves this to a concrete backend.

```ts
// engine/src/provider/route.ts
export function resolveProvider(modelSlug: string): ProviderTarget {
  const [head, ...rest] = modelSlug.split("/");
  const name = rest.join("/");

  // Explicit provider prefixes
  if (head === "anthropic") return { backend: "anthropic-direct", model: name };
  if (head === "openrouter") return { backend: "openrouter", model: name };
  if (head === "google" || head === "gemini") {
    // Prefer direct Google SDK; fall back to OpenRouter if no GOOGLE_API_KEY.
    return process.env.GOOGLE_API_KEY
      ? { backend: "google-direct", model: name }
      : { backend: "openrouter", model: `google/${name}` };
  }
  if (head === "groq") return { backend: "groq-direct", model: name };
  if (head === "cerebras") return { backend: "cerebras-direct", model: name };

  // Unprefixed Claude family → Anthropic direct.
  if (/^claude[-_]/i.test(modelSlug)) {
    return { backend: "anthropic-direct", model: modelSlug };
  }

  // Default fallback: OpenRouter.
  return { backend: "openrouter", model: modelSlug };
}
```

### Supported backends

| Backend | SDK | Used for | Caching |
|---|---|---|---|
| `anthropic-direct` | `@anthropic-ai/sdk` | Claude family (Opus, Sonnet, Haiku) | Full `cache_control` |
| `openrouter` | `@openrouter/ai-sdk-provider` | Qwen, DeepSeek, Llama (non-Groq), legacy | No caching |
| `google-direct` | `@google/genai` | Gemini, when `GOOGLE_API_KEY` set | Implicit caching when available |
| `groq-direct` | `groq-sdk` | Llama on Groq hardware | None, low latency |
| `cerebras-direct` | `@cerebras/cerebras_cloud_sdk` | Llama on Cerebras | None, ultra-low latency |

---

## 3. Prompt caching strategy (Anthropic direct)

Every Claude call goes out with up to **four** `cache_control` breakpoints, placed to maximize hit rate across the typical Genie session.

Order from most-stable to least-stable (caching requires stable prefix):

1. **System prompt** (always) — the agent persona, tool-use instructions, safety framing. Rarely changes within a session. `cache_control: { type: "ephemeral" }`.
2. **Tools list** (always, on first message) — JSON schemas for every tool the agent has. Stable for the session. Cached as part of the system-block once we bounce the first assistant turn off the cache writer.
3. **CLAUDE.md / project memory** (when present) — injected as a user-role message at the start of every turn. Stable across a session. Cached with `cache_control`.
4. **Most-recent-active skill body** (when one is loaded and >1024 tokens) — skill content that the agent is currently executing. Cached because the skill persists across many tool cycles inside one invocation.

Example shape of an outgoing request:

```ts
import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const response = await anthropic.messages.create({
  model: "claude-sonnet-4-5",
  max_tokens: 8192,
  system: [
    {
      type: "text",
      text: JELLYCLAW_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },           // breakpoint #1
    },
  ],
  tools: TOOLS_WITH_LAST_ENTRY_CACHED,                // breakpoint #2 on last tool
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: CLAUDE_MD_CONTENTS,
          cache_control: { type: "ephemeral" },       // breakpoint #3
        },
        ...(activeSkillBody && countTokens(activeSkillBody) > 1024
          ? [{
              type: "text",
              text: activeSkillBody,
              cache_control: { type: "ephemeral" },   // breakpoint #4
            }]
          : []),
        { type: "text", text: userMessage },
      ],
    },
    ...conversationHistory,
  ],
});
```

Breakpoint #2 (tools) uses the trick of attaching `cache_control` to the **last** tool definition in the array — Anthropic's API interprets that as a cache boundary covering all tools.

### Cache hit telemetry

`response.usage` fields `cache_creation_input_tokens` and `cache_read_input_tokens` are logged per call and rolled up per session. A session dashboard shows `cacheHitRate = cache_read / (cache_read + cache_creation + non_cached_input)`. Target: >85% across a typical session.

---

## 4. Retry / failover ladder

Every model call is wrapped in the retry ladder. Errors are classified:

- **Retryable transient** (5xx, 429 without Retry-After, connection reset): retry path.
- **Rate limited** (429 with Retry-After): honor the header, then retry path.
- **Fatal client error** (400 with bad request, 401, 403): no retry, surface to user.
- **Unknown**: treated as fatal.

Retry path:

1. Wait 250ms, retry once on the **same backend**.
2. If still failing, wait 750ms, retry on the same backend one more time.
3. If still failing, switch to the **sticky fallback backend** (next in priority list for that model). Mark the session as "on fallback" for 10 minutes — subsequent calls go straight to the fallback without retrying primary.
4. On every fallback activation emit `provider.fallback.engaged` to the telemetry bus and print a single-line status to stderr.
5. After 10 minutes sticky window, probe primary with a tiny request (`max_tokens: 1`, cached prefix) on the next call. If it succeeds, unstick.
6. If fallback also fails, the request is written to the **dead-letter queue** (`$XDG_STATE_HOME/jellyclaw/dead-letter/`) and the user sees `E/provider: all backends exhausted (see logs)`.

Fallback priority table (configurable in `engine/config/provider-fallback.json`):

```json
{
  "claude-sonnet-4-5":   ["anthropic-direct",   "openrouter"],
  "claude-opus-4-6":     ["anthropic-direct",   "openrouter"],
  "gemini-2.0-flash":    ["google-direct",      "openrouter"],
  "qwen3-coder":         ["openrouter",         "cerebras-direct"],
  "llama-3.3-70b":       ["groq-direct",        "cerebras-direct", "openrouter"]
}
```

---

## 5. Example: OpenRouter via `@openrouter/ai-sdk-provider`

```ts
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText } from "ai";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  // Do NOT pass cache_control — OpenRouter drops/breaks it (issues
  // #1245, #17910). The provider adapter strips cache_control on
  // outbound OpenRouter calls to avoid HTTP 400s.
});

const result = await generateText({
  model: openrouter("qwen/qwen3-coder"),
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ],
});
```

The provider adapter layer (`engine/src/provider/openrouter.ts`) does the cache_control stripping centrally so feature code can't accidentally trip the bug.

---

## 6. Cost attribution

Every model call produces a `CostLedgerEntry`:

```ts
interface CostLedgerEntry {
  sessionId: string;
  parentCallId?: string;        // set when this call is inside a subagent
  toolCallId?: string;          // set when triggered by a tool/plan step
  backend: BackendName;
  model: string;
  usage: {
    input: number;
    output: number;
    cache_read: number;
    cache_creation: number;
  };
  pricing: {                    // resolved at call time from pricing table
    input: number;              // $/MTok
    output: number;
    cache_read: number;
    cache_creation: number;
  };
  costUsd: number;              // computed
  latencyMs: number;
  ts: number;
}
```

Ledger entries are appended to `$XDG_STATE_HOME/jellyclaw/sessions/<id>/cost.ndjson` and rolled up in the session summary. Subagent costs inherit `parentCallId` so the desktop shell can render a tree view: "this planning step cost $0.12, of which $0.08 was the research subagent."

Pricing tables live in `engine/config/pricing.json`, keyed by `backend:model`. They're updated by a weekly cron that scrapes vendor pricing pages; stale entries >30 days old emit a warning on startup.

---

## 7. What we are not doing (explicitly)

- **No client-side token counting for billing.** Reported usage from the provider is authoritative.
- **No "smart routing"** that chooses a cheap model for easy turns and an expensive model for hard turns. Model choice is the user's; we route the chosen model to the right backend.
- **No caching across providers.** Anthropic's cache is Anthropic's cache. Switching backends is a cache miss.
- **No automatic model substitution** under provider outage (e.g., "Claude is down, use GPT-4 for this turn"). This violates user expectation. Fallback is always to a backend serving *the same model*, not a different model.

---

## 8. Open questions

- When Anthropic ships a Bedrock-compatible cache API, we should add Bedrock as a sticky fallback for Claude models in enterprise deployments.
- OpenRouter's caching bugs may land a fix before we can upstream our workaround. Re-evaluate quarterly.
- Gemini's implicit caching (no `cache_control` needed, caches automatically above some threshold) should be measured in practice before we document hit-rate expectations.
