---
id: T3-12-agent-sdk-query-shape
tier: 3
title: "Expose a query() function matching @anthropic-ai/claude-agent-sdk shape"
scope:
  - "engine/src/sdk/query.ts"
  - "engine/src/sdk/query.test.ts"
  - "engine/src/sdk/types.ts"
  - "engine/src/sdk/index.ts"
  - "engine/src/index.ts"
  - "test/fixtures/sdk/basic-query.golden.jsonl"
depends_on_fix:
  - T3-11-expand-stream-json-init
tests:
  - name: query-import-succeeds
    kind: shell
    description: "top-level package exports `query` — `import { query } from '@jellyclaw/engine'` resolves"
    command: "bun run test engine/src/sdk/query -t query-import-succeeds"
    expect_exit: 0
    timeout_sec: 30
  - name: query-yields-sdkmessage-shape
    kind: shell
    description: "for-await over query({prompt}) yields objects with `type: 'system'|'assistant'|'user'|'result'` discriminator"
    command: "bun run test engine/src/sdk/query -t yields-sdkmessage"
    expect_exit: 0
    timeout_sec: 60
  - name: query-output-byte-compatible-with-sdk-fixtures
    kind: shell
    description: "messages emitted by query() match byte-for-byte (modulo uuid/session_id) the claude-agent-sdk fixture"
    command: "bun run test engine/src/sdk/query -t byte-compatible-with-sdk-fixtures"
    expect_exit: 0
    timeout_sec: 60
  - name: query-abort-via-signal
    kind: shell
    description: "AbortController.abort() during iteration causes the generator to return cleanly"
    command: "bun run test engine/src/sdk/query -t abort-via-signal"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 50
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 75
---

# T3-12 — `query()` function matching Agent SDK shape

## Context
`@anthropic-ai/claude-agent-sdk` exposes an idiomatic TypeScript API:
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
for await (const msg of query({ prompt: "hello" })) { /* … */ }
```
Genie and every other consumer built against this SDK. Jellyclaw's `runAgentLoop` in `engine/src/agents/loop.ts:111` is close in spirit (async generator, streaming) but emits our internal `AgentEvent` shape — not the SDK's `SDKMessage`. A consumer can't swap `claude` → `jellyclaw` with a one-line change.

## Root cause (from audit)
- `engine/src/index.ts` — the barrel that re-exports the public surface — has no `query` export.
- `engine/src/agents/loop.ts:111` — `runAgentLoop` yields `AgentEvent`, not `SDKMessage`. The Claude Code stream-json writer at `engine/src/cli/output-claude-stream-json.ts` has the field knowledge but operates on NDJSON stdout — not a typed generator.
- No `engine/src/sdk/` directory exists.
- T3-11 updates stream-json to match Claude's real shape — this prompt depends on that because `SDKMessage` shape mirrors the stream-json frame shape.

## Fix — exact change needed
1. **Create `engine/src/sdk/types.ts`** mirroring the SDK's public types byte-for-byte. Import from the SDK package if we add it as a peerDep (zero-cost types). Otherwise declare locally matching `@anthropic-ai/claude-agent-sdk@^1`:
   ```ts
   export type SDKMessage =
     | { type: "system"; subtype: "init"; session_id: string; model: string; cwd: string; tools: string[]; permissionMode: string; apiKeySource: string; claude_code_version: string; uuid: string; mcp_servers: unknown[]; slash_commands: string[]; agents: unknown[]; skills: unknown[]; plugins: unknown[]; output_style: string; cache_creation: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number }; }
     | { type: "assistant"; message: { id: string; type: "message"; role: "assistant"; model: string; content: unknown[]; stop_reason: string | null; stop_sequence: string | null }; parent_tool_use_id: string | null; session_id: string; uuid: string; }
     | { type: "user";      message: { role: "user"; content: unknown[] }; parent_tool_use_id: string | null; session_id: string; uuid: string; }
     | { type: "result";    subtype: "success" | "error"; is_error: boolean; result: string; session_id: string | null; uuid: string; duration_ms?: number; num_turns?: number; total_cost_usd?: number; stop_reason?: string; usage?: unknown; modelUsage?: unknown; permission_denials?: unknown[]; terminal_reason?: string; };

   export interface QueryOptions {
     readonly prompt: string | AsyncIterable<{ type: "user"; message: { role: "user"; content: string } }>;
     readonly options?: {
       readonly model?: string;
       readonly cwd?: string;
       readonly allowedTools?: readonly string[];
       readonly disallowedTools?: readonly string[];
       readonly permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
       readonly abortController?: AbortController;
       readonly maxTurns?: number;
       readonly systemPrompt?: string;
       readonly resume?: string;
     };
   }
   export interface Query extends AsyncGenerator<SDKMessage, void, void> {
     interrupt(): Promise<void>;
   }
   ```
2. **New `engine/src/sdk/query.ts`:**
   ```ts
   export function query(args: QueryOptions): Query;
   ```
   Internally:
   - Build `AgentLoopOptions` from `QueryOptions` (map fields: `prompt`, `cwd`, `systemPrompt`, `maxTurns`, `model`, `signal`).
   - Spawn `runAgentLoop(...)` from `engine/src/agents/loop.ts`.
   - Adapt each `AgentEvent` → `SDKMessage` using the SAME mapping rules as `ClaudeStreamJsonWriter` (post-T3-11). The cleanest implementation: extract the event-to-frame mapping from `output-claude-stream-json.ts` into a pure function `mapEventToSdkMessage(ev, state): SDKMessage | null` and reuse it in both the writer AND here. Move shared logic to `engine/src/sdk/event-mapper.ts`.
   - Expose `interrupt()`: calls `args.options?.abortController?.abort()` and returns when the next yield completes.
3. **Barrel export `engine/src/sdk/index.ts`:**
   ```ts
   export { query } from "./query.js";
   export type { QueryOptions, Query, SDKMessage } from "./types.js";
   ```
4. **Top-level public re-export `engine/src/index.ts`:**
   ```ts
   export { query } from "./sdk/index.js";
   export type { SDKMessage, QueryOptions, Query } from "./sdk/index.js";
   ```
5. **Prompt input as `AsyncIterable`.** Support the SDK's streaming-input mode: when `prompt` is an `AsyncIterable<{type:"user",...}>`, concatenate the emitted user messages as the loop's priorMessages + prompt (last user message becomes the active prompt). If the iterable yields multiple, forward them as multi-turn user inputs.
6. **Golden fixture** — `test/fixtures/sdk/basic-query.golden.jsonl` is the expected message sequence for a fixed stub provider that returns `"hi there"`. Tests assert every emitted message matches the fixture by shape (modulo uuid/session_id).
7. **Tests in `engine/src/sdk/query.test.ts`:**
   - `query-import-succeeds` — `import { query } from "../../index.js"`; assert `typeof query === "function"`.
   - `yields-sdkmessage` — drive a stub provider; collect all yielded messages; assert every one has a valid `type` discriminator.
   - `byte-compatible-with-sdk-fixtures` — read the golden fixture; assert sequence matches.
   - `abort-via-signal` — pass an `AbortController`; call `abort()` mid-stream; assert the generator returns (doesn't throw).

## Acceptance criteria
- Public surface `query()` importable from `@jellyclaw/engine` (maps to `query-import-succeeds`).
- Yields `SDKMessage`-shaped objects (maps to `query-yields-sdkmessage-shape`).
- Output byte-compatible with claude-agent-sdk fixtures (maps to `query-output-byte-compatible-with-sdk-fixtures`).
- Abort works (maps to `query-abort-via-signal`).
- `bun run typecheck` + `bun run lint` clean.
- Existing `ClaudeStreamJsonWriter` tests still pass — the event-mapper extraction must not regress stream-json output.

## Out of scope
- Do NOT implement the SDK's MCP transport negotiation — scope is the message shape.
- Do NOT expose `canUseTool` callback — that's a Claude Code feature; ours is declarative via permissions engine.
- Do NOT rename internal `AgentEvent` — keep that internal; the adapter is the boundary.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/sdk/query
bun run test engine/src/cli/output-claude-stream-json
node --input-type=module -e "import { query } from './engine/src/index.ts'; console.log(typeof query);"
```
