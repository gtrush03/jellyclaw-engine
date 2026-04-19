---
phase: 02
name: "Config + provider layer"
duration: "2 days"
depends_on: [01]
blocks: [03, 04, 08, 10]
---

# Phase 02 — Config + provider layer

## Dream outcome

`jellyclaw` reads `jellyclaw.json` (repo-local) merged over `~/.jellyclaw/config.json` (user-global) merged over defaults, validated by Zod. The primary provider is **Anthropic direct** with prompt caching active on system prompts, tool schemas, and CLAUDE.md. **OpenRouter** is available as a secondary with a loud warning about its caching quirks. A 5xx, rate-limit, or timeout from the primary transparently swaps to the secondary within one retry, with the swap recorded in telemetry.

## Deliverables

- `engine/src/config/schema.ts` — Zod schema + inferred `JellyclawConfig` type
- `engine/src/config/loader.ts` — load + merge + validate
- `engine/src/providers/anthropic.ts` — Anthropic wrapper with caching headers
- `engine/src/providers/openrouter.ts` — OpenRouter wrapper with caching warning
- `engine/src/providers/router.ts` — fallback + credential rotation
- `engine/src/providers/types.ts` — shared provider interface
- Unit tests for schema + router (fault injection)
- `docs/providers.md` — caching rules, known OpenRouter bugs, selection matrix

## Step-by-step

### Step 1 — Define config schema
`engine/src/config/schema.ts`:
```ts
import { z } from "zod";

export const ProviderEntry = z.object({
  kind: z.enum(["anthropic", "openrouter"]),
  apiKey: z.string().min(10),
  model: z.string(),
  baseURL: z.string().url().optional(),
  maxOutputTokens: z.number().int().positive().default(8192),
  cache: z.boolean().default(true)
});

export const JellyclawConfig = z.object({
  providers: z.object({
    primary: ProviderEntry,
    secondary: ProviderEntry.optional()
  }),
  permissions: z.object({ mode: z.enum(["default","acceptEdits","bypassPermissions","plan"]).default("default") }).default({}),
  skills: z.object({ paths: z.array(z.string()).default(["~/.jellyclaw/skills", ".jellyclaw/skills", ".claude/skills"]) }).default({}),
  agents: z.object({ paths: z.array(z.string()).default(["~/.jellyclaw/agents", ".jellyclaw/agents", ".claude/agents"]) }).default({}),
  mcp: z.record(z.any()).default({}),
  hooks: z.record(z.any()).default({}),
  telemetry: z.object({ enabled: z.boolean().default(false), endpoint: z.string().optional() }).default({})
});
export type JellyclawConfig = z.infer<typeof JellyclawConfig>;
```

### Step 2 — Loader with precedence
`engine/src/config/loader.ts`:
```ts
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { JellyclawConfig } from "./schema.js";

const expand = (p: string) => p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
const readJson = (p: string) => existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};

export function loadConfig(cwd = process.cwd()) {
  const defaults = {};
  const global = readJson(expand("~/.jellyclaw/config.json"));
  const local = readJson(resolve(cwd, "jellyclaw.json"));
  const env = envOverrides();
  const merged = { ...defaults, ...global, ...local, ...env };
  return JellyclawConfig.parse(merged);
}

function envOverrides() {
  const o: any = { providers: {} };
  if (process.env.ANTHROPIC_API_KEY) o.providers.primary = { kind: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5" };
  if (process.env.OPENROUTER_API_KEY) o.providers.secondary = { kind: "openrouter", apiKey: process.env.OPENROUTER_API_KEY, model: process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.5" };
  return o;
}
```

### Step 3 — Provider interface
`engine/src/providers/types.ts`:
```ts
export interface ProviderRequest {
  system: string;
  messages: Array<{ role: "user"|"assistant"|"tool"; content: any }>;
  tools?: any[];
  maxOutputTokens: number;
  cacheBreakpoints?: Array<"system"|"tools"|"memory">;
}
export interface ProviderChunk { type: string; [k: string]: any; }
export interface Provider {
  name: "anthropic" | "openrouter";
  stream(req: ProviderRequest): AsyncIterable<ProviderChunk>;
}
```

### Step 4 — Anthropic wrapper
`engine/src/providers/anthropic.ts` — use `@anthropic-ai/sdk`, apply `cache_control: { type: "ephemeral" }` on the last block of `system`, `tools`, and the memory (CLAUDE.md) block. Set `anthropic-beta` header for any needed beta features. Emit chunks passthrough.

### Step 5 — OpenRouter wrapper
`engine/src/providers/openrouter.ts` — POST to `https://openrouter.ai/api/v1/chat/completions` with `stream: true`. Attach `HTTP-Referer` + `X-Title`. On first call, log once:
```
[jellyclaw] OpenRouter provider selected. Caching on OpenRouter is unreliable (known silent cache misses, incorrect cache_read_input_tokens accounting). Prefer Anthropic direct.
```

### Step 6 — Router + fallback
`engine/src/providers/router.ts`:
```ts
export class ProviderRouter implements Provider {
  constructor(private primary: Provider, private secondary?: Provider) {}
  name = "router" as any;
  async *stream(req: ProviderRequest) {
    try { yield* this.primary.stream(req); }
    catch (e) {
      if (!shouldFallback(e) || !this.secondary) throw e;
      telemetry.emit("provider.failover", { from: this.primary.name, to: this.secondary.name, reason: String(e) });
      yield* this.secondary.stream(req);
    }
  }
}
function shouldFallback(e: any) {
  const s = e?.status ?? 0;
  return s === 429 || (s >= 500 && s < 600) || e?.code === "ETIMEDOUT";
}
```

### Step 7 — Credential pool (optional rotation)
Support `ANTHROPIC_API_KEY_1..N` — round-robin on `429`. Document in `docs/providers.md`.

### Step 8 — Tests
- `schema.test.ts` — accepts valid, rejects missing keys, rejects unknown enum.
- `router.test.ts` — fault-inject: primary throws 500 → secondary yields → result merged; primary throws 401 → no fallback; no secondary configured → error propagates.
- `anthropic.test.ts` — mock fetch, assert `cache_control` breakpoints placed on last system/tools block.
- `openrouter.test.ts` — assert warning logged exactly once.

Run `pnpm --filter @jellyclaw/engine test`. Expected: all green.

### Step 9 — Docs
`docs/providers.md` — caching matrix:
| feature | Anthropic direct | OpenRouter |
|---|---|---|
| Prompt caching (system) | yes, ephemeral | partial, unreliable |
| Prompt caching (tools) | yes | partial |
| Cache read accounting | accurate | sometimes wrong |
| Rate limit headers | standard | standard |
Recommendation: primary = Anthropic, secondary = OpenRouter for reach, never rely on OR caching in budget math.

## Acceptance criteria

- [ ] `loadConfig()` returns a validated `JellyclawConfig` from any combo of global/local/env
- [ ] Unit tests for schema + router pass
- [ ] Anthropic provider sets `cache_control` correctly (asserted via mock fetch)
- [ ] OpenRouter provider logs caching warning exactly once per process
- [ ] Fault injection: 500 on primary → secondary serves the stream
- [ ] No fallback on 401/403/400

## Risks + mitigations

- **OpenRouter silent cache miss** → never trust OR `cache_read_input_tokens` in cost ledger; cross-check against Anthropic billing when possible.
- **Anthropic beta header drift** → centralize in `engine/src/providers/anthropic-beta.ts` constant.
- **Config precedence surprises** → document order in `docs/providers.md` and print effective config with `jellyclaw config show`.

## Dependencies to install

```
@anthropic-ai/sdk@^0.32
undici@^6  # for fetch with keep-alive
```

## Files touched

- `engine/src/config/schema.ts`, `engine/src/config/loader.ts`
- `engine/src/providers/{types,anthropic,openrouter,router}.ts`
- `engine/src/providers/*.test.ts`
- `docs/providers.md`
