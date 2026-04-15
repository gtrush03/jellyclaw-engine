# Phase 99 — Unfucking — Prompt 02: Real agent loop

**When to run:** After 99-01 (`adapter.ts` exists, tests green).
**Estimated duration:** ~120 minutes
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- Working API key: <REDACTED_API_KEY> -->
<!-- END SESSION STARTUP -->

---

## Pre-flight verification (DO THIS FIRST)

Confirm the tool registry and hook runner surfaces match this prompt's assumptions. Run:

```bash
bun -e 'import("./engine/src/tools/index.ts").then(m => console.log(m.listTools().map(t => t.name)))'
```

Expected output (Phase-04 built-ins):
```
[ "Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write" ]
```

Then sanity-check the single-hook runner shape:
```bash
bun -e 'import("./engine/src/hooks/registry.ts").then(m => console.log(Object.keys(m)))'
# Expect: HookRegistry, runHooks, runHooksWith, ...
```

If either command errors or returns unexpected names, STOP and re-read the actual source — the prompt's interface section below may be stale and needs updating before you build.

## Why this exists

We have an adapter (99-01) but no consumer. The legacy stub emits `[phase-0 stub]` text. This prompt builds the real agent loop generator that calls the provider, threads chunks through the adapter, and yields `AgentEvent`s for the RunManager to buffer.

This is Phase 99's most architecturally critical commit. **Get tool-calling right** — the loop must execute tools and feed results back into the next provider call. Without that, jellyclaw can't run a Bash command, which kills Genie usage.

## Files to read first

1. `engine/src/providers/anthropic.ts` — `stream(req, signal)` signature (line 135). Emits retryable errors as `Anthropic.APIError`; non-retryable ones abort the stream before any chunk is yielded.
2. `engine/src/providers/adapter.ts` (just built in 99-01).
3. `engine/src/providers/types.ts` — `ProviderRequest` shape. Note `messages: Anthropic.Messages.MessageParam[]` and `tools?: Anthropic.Messages.Tool[]`.
4. `engine/src/tools/index.ts` — `builtinTools`, `listTools()`, `getTool(name)`. **There is no `ToolRegistry` interface** — the registry surface is these three module exports.
5. `engine/src/tools/types.ts` — `Tool<I,O>` interface (line 88): `{ name, description, inputSchema, zodSchema, overridesOpenCode, handler(input, ctx): Promise<O> }`. `ToolContext` (line 29) requires `cwd, sessionId, readCache, abort, logger, permissions` and optional `session, subagents`. **There is no `ToolRegistry.execute(name, input)` method** — you call `getTool(name).handler(input, ctx)` yourself.
6. `engine/src/hooks/types.ts` — `HookEventKind` is one of: `SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, **`PreToolUse`**, **`PostToolUse`**, `SubagentStart`, `SubagentStop`, `PreCompact`, `Stop`, `Notification`. Note the **PascalCase** — NOT `tool.execute.before`/`tool.execute.after`. See `BLOCKING_EVENTS` for which can deny.
7. `engine/src/hooks/registry.ts` — `HookRegistry` class + `runHooks(opts: RunHooksOptions<K>)`. **The loop calls `runHooks`, not a `HookRunner.fire()` method.** `RunHooksOptions` (in `types.ts:287`) takes `{event, sessionId, hooks, audit?, logger?, ...}` where `hooks` is a `readonly CompiledHook[]` (get from `HookRegistry.hooksFor(event)`). Returns `HookRunResult<K>` with `decision: "allow"|"deny"|"modify"|"neutral"`.
8. `engine/src/permissions/types.ts` — `CompiledPermissions`, `ToolCall`, `PermissionDecision`, `AskHandler`. Gate entry point in `engine/src/permissions/engine.ts` — read it. The `PermissionService` on `ToolContext` (`tools/types.ts:79`) is the OTHER layer — key-based checks inside tools.
9. `engine/src/legacy-run.ts` — copy the seq/usage patterns; we'll delete it after this prompt.
10. `engine/src/events.ts` — event shapes. AgentEvent variants are dot-delimited (`tool.called`, not `tool_called`).

## Interface reality check

```ts
// Provider — already implemented. Do not redefine.
import { AnthropicProvider } from "../providers/anthropic.js";
// Adapter — from 99-01.
import { adaptChunk, adaptDone, createAdapterState } from "../providers/adapter.js";
// Tool registry — free functions, no class.
import { getTool, listTools } from "../tools/index.js";
import type { Tool, ToolContext } from "../tools/types.js";
// Hook dispatch — function + registry class.
import { HookRegistry, runHooks } from "../hooks/registry.js";
import type { HookEvent } from "../hooks/types.js";
// Permissions — see engine.ts there.
import { decidePermission } from "../permissions/engine.js"; // verify name in preflight
```

## Build

Create `engine/src/agents/loop.ts`:

```ts
export interface AgentLoopOptions {
  provider: Provider;                            // AnthropicProvider instance
  hooks: HookRegistry;                           // compiled HookRegistry
  permissions: CompiledPermissions;              // parsed from config
  askHandler?: AskHandler;                       // for `ask`-class rules
  model: string;
  systemPrompt?: string;
  prompt: string;
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  logger: Logger;
  toolContextExtras?: Partial<ToolContext>;      // tests inject stubs
  maxTurns?: number;                             // default 25
  maxBudgetUsd?: number;                         // default 5
  maxOutputTokens?: number;                      // default 4096
  now?: () => number;                            // injected clock (CLAUDE.md §6)
}

export async function* runAgentLoop(opts: AgentLoopOptions): AsyncGenerator<AgentEvent>;
```

### Loop algorithm (revised against real interfaces)

```
1. Build initial ProviderRequest:
   - system = opts.systemPrompt ? [{type:"text", text: opts.systemPrompt}] : []
   - tools  = listTools().map(t => ({name: t.name, description: t.description, input_schema: t.inputSchema}))
   - messages = [{role:"user", content: opts.prompt}]
   - maxOutputTokens = opts.maxOutputTokens ?? 4096
2. Initialize AdapterState via createAdapterState({sessionId, model}).
3. readCache = new Set<string>();  // shared across turns for Read→Write invariant
4. For turn in 1..maxTurns:
   a. Collect events for this turn into a local `turnEvents: AgentEvent[]`, and `queuedTools: ToolCalledEvent[]`.
   b. Try: for await (chunk of provider.stream(req, signal)):
        for (ev of adaptChunk(state, chunk, now())):
          yield ev
          if (ev.type === "tool.called") queuedTools.push(ev)
          if (ev.type === "usage.updated" && ev.cost_usd > maxBudgetUsd): yield session.error{code:"budget_exceeded"}; return
   c. Catch abort: yield session.error{code:"aborted", recoverable:false}; return.
   d. Catch Anthropic.APIError: yield session.error{code:err.status?.toString() ?? "provider_error", message:err.message}; return.
   e. If queuedTools.length === 0:
        yield adaptDone(state, {turns: turn, duration_ms: now()-t0, now: now()}); return.
   f. Append assistant turn to messages: {role:"assistant", content: [...text blocks..., ...tool_use blocks from queuedTools]}.
      (Rebuild tool_use blocks from queuedTools: {type:"tool_use", id, name, input}.)
   g. toolResults: ContentBlockParam[] = []
      For each toolCall in queuedTools:
        i.   preEvent: HookEvent = {kind:"PreToolUse", payload:{sessionId, toolName, toolInput, callId:tool_id}}
             preResult = await runHooks({event:preEvent, sessionId, hooks: hooks.hooksFor(preEvent), logger})
             If preResult.decision === "deny":
               yield tool.error{tool_id, tool_name, code:"hook_denied", message:preResult.reason}
               toolResults.push({type:"tool_result", tool_use_id:tool_id, content:`hook denied: ${reason}`, is_error:true})
               continue
             If preResult.decision === "modify" and preResult.modified: toolInput = preResult.modified.toolInput
        ii.  permDecision = await decidePermission({call:{name,input:toolInput}, permissions, sessionId, askHandler, logger})
             If permDecision === "deny":
               yield permission.requested{...} ; yield permission.denied{...}; yield tool.error{code:"permission_denied"}
               toolResults.push({type:"tool_result", tool_use_id:tool_id, content:"permission denied", is_error:true})
               continue
             If permDecision === "ask" → treated as deny if no askHandler (see permissions/engine.ts).
        iii. tool = getTool(toolName); if !tool: yield tool.error{code:"unknown_tool"}; continue
             ctx: ToolContext = {cwd, sessionId, readCache, abort:signal, logger, permissions:keyBasedPermService, ...toolContextExtras}
             start = now()
             try { output = await tool.handler(validatedInput, ctx) }
             catch (err): yield tool.error{tool_id, tool_name, code:err.code ?? "tool_error", message:err.message}; toolResults.push({tool_use_id, content: err.message, is_error:true}); continue
             yield tool.result{tool_id, tool_name, output, duration_ms: now()-start}
             toolResults.push({type:"tool_result", tool_use_id:tool_id, content: JSON.stringify(output)})
        iv.  postEvent: HookEvent = {kind:"PostToolUse", payload:{sessionId, toolName, toolInput, toolResult:output, callId:tool_id, durationMs}}
             await runHooks({event:postEvent, sessionId, hooks:hooks.hooksFor(postEvent), logger}) // result ignored for allow; modify not supported
   h. Append {role:"user", content: toolResults} to messages.
5. After maxTurns exceeded: yield session.error{code:"max_turns_exceeded"}; return.
```

### Critical behaviors

- **Event hook names are PascalCase, dot-less:** `PreToolUse`, `PostToolUse` — NOT `tool.execute.before`. The AgentEvent names ARE dot-delimited (`tool.called`); do not confuse the two taxonomies.
- **Tool registry has NO `.execute()` method.** Call `getTool(name)` → `tool.handler(input, ctx)`. Build `ToolContext` yourself; the `readCache: Set<string>` must persist across turns so Write's "read before overwrite" invariant works (see `tools/types.ts:34-38`).
- **Input validation:** before calling `handler`, run `tool.zodSchema.parse(input)`. On ZodError, emit `tool.error{code:"invalid_input"}` and continue the loop (feed error back as tool_result).
- **Abort:** `signal.aborted` mid-stream → catch in adapter loop, yield `session.error{code:'aborted'}`, return cleanly. Do NOT let `signal.reason` bubble as `finalStatus=failed` (RunManager treats clean return as success — see `run-manager.ts:142-145`).
- **Provider errors:** retryable errors are auto-retried inside `AnthropicProvider.stream()`; exhausted retries throw `Anthropic.APIError`. Catch it, map `.status` to `session.error.code`. Known quirk: status 400 with `cache_control.ttl` ordering error comes back when both `system` and `tools` are set — this is an open bug in `cache-breakpoints.ts`; flag it in tests but don't fix here.
- **Tool errors never throw out of the generator.** Catch synchronous + async errors, emit `tool.error`, feed synthetic error result back as `tool_result.is_error=true`.
- **Subagent dispatch:** if `toolName === "Task"`, the registered `taskTool` already handles dispatch via `ctx.subagents`. Do NOT special-case here — just inject a `SubagentService` (stub from `engine/src/subagents/stub.ts` is fine for Phase 99).
- **Budget accounting:** watch `usage.updated.cost_usd` emissions. If `cost_usd` is missing from adapter (pricing table not wired), skip the budget check rather than crashing.
- **PostToolUse is non-blocking by default** (and per `HookConfig.blocking=false` it fire-and-forgets). Don't await the result for decision purposes.

## Tests

Create `engine/src/agents/loop.test.ts`. Use a **stub provider** — never hit the real API in unit tests. Required scenarios:

1. **Stub provider, no tools:** stub yields Fixture A (text-only) chunks → assert events include `session.started, agent.message(final=false)×2, agent.message(final=true), usage.updated, session.completed`.
2. **Tool round-trip:** stub provider yields Fixture B (tool_use get_weather) on turn 1, then yields text on turn 2. Stub `get_weather` tool handler returns `{temp:"18C"}`. Assert events: `session.started, tool.called(get_weather), tool.result, agent.message(final), usage.updated, session.completed`. Assert messages array passed to second provider call contains `{role:"assistant", content:[{type:"tool_use",...}]}` and `{role:"user", content:[{type:"tool_result",tool_use_id:"toolu_01UM...",content:'{"temp":"18C"}'}]}`.
3. **Tool error:** stub tool handler throws `new Error("boom")`. Assert `tool.error{code:"tool_error",message:"boom"}` emitted, loop continues with `tool_result.is_error=true` fed back.
4. **Invalid input:** provider emits tool_use with partial_json that doesn't parse. Adapter already emits `tool.error{code:"invalid_input"}` (per 99-01); assert loop does NOT try to execute and still feeds a synthetic error result back.
5. **Permission denied:** inject `permissions` with a `deny` rule matching `Bash`. Stub provider requests Bash. Assert `permission.requested, permission.denied, tool.error{code:"permission_denied"}`, no execution.
6. **Hook deny (PreToolUse exit 2):** inject a `HookRegistry` with a hook that denies. Assert `tool.error{code:"hook_denied"}` and synthetic error fed back.
7. **Abort mid-stream:** abort signal triggered after first text delta. Assert `session.error{code:'aborted'}` and clean return (generator completes without throwing).
8. **Budget exceeded:** stub usage pushes `cost_usd > 0.01` with `maxBudgetUsd=0.01`. Assert `session.error{code:'budget_exceeded'}`.
9. **Max turns:** stub provider always emits a tool call. Assert loop stops at `maxTurns=3` with `session.error{code:'max_turns_exceeded'}`.
10. **Hook propagation order:** spy on `runHooks`. Assert `PreToolUse` fires before tool handler, `PostToolUse` fires after, for each tool, in declaration order.

Run: `bun test engine/src/agents/loop.test.ts`.

## Provider quirks to guard against

1. **SDK pre-accumulation in `message_start`:** the provider yields a `message_start` chunk with `message.content` already populated. The adapter ignores it but the loop MUST NOT try to read tool_use blocks from there — only from `tool.called` events emitted by the adapter.
2. **Cache breakpoint bug:** adding `tools` + `system` to `ProviderRequest` currently triggers HTTP 400 `cache_control.ttl` ordering. Until fixed, integration tests using the real provider must either (a) omit `system`, or (b) pass `cache: {enabled: false}` equivalent. Unit tests should stub the provider entirely.
3. **No `cost_usd` in adapter yet:** adapter emits `usage.updated` with token counts; `cost_usd` requires a pricing table that isn't wired in 99-01. The loop's budget check must handle `cost_usd === undefined` gracefully (skip check or derive from token×price).
4. **Anthropic SDK v0.40.x** (per `package.json`) — stream events include a nonstandard `caller: {type:"direct"}` field on `tool_use` blocks. Ignore it.

## Out of scope

- Don't wire into RunManager yet — that's prompt 03.
- Don't add LSP/MCP-specific tool behaviors that don't already exist.
- Don't change tool registry, hook runner, or permission gate APIs.
- Don't implement a pricing table for `cost_usd` — do it in a follow-up.

## Done when

- `bun test engine/src/agents/loop.test.ts` — green (≥10 tests)
- `bunx tsc --noEmit` — clean
- `bunx biome check engine/src/agents/loop.ts` — clean
- COMPLETION-LOG.md updated

<!-- BEGIN SESSION CLOSEOUT -->
<!-- Confirm no real network calls in tests (all stubs). Note any tool registry/hook surface assumptions in COMPLETION-LOG. -->
<!-- If decidePermission import name was wrong in preflight, document the real export name in COMPLETION-LOG so Prompt 03 doesn't repeat the mistake. -->
<!-- END SESSION CLOSEOUT -->
