---
id: T3-02-add-ask-user-question-tool
tier: 3
title: "Add AskUserQuestion tool that pauses run for a user reply"
scope:
  - "engine/src/tools/ask-user-question.ts"
  - "engine/src/tools/ask-user-question.test.ts"
  - "engine/src/tools/index.ts"
  - "engine/src/agents/loop.ts"
  - "engine/src/permissions/types.ts"
depends_on_fix:
  - T2-06-permission-mode-wiring
tests:
  - name: ask-user-question-registered
    kind: shell
    description: "listTools() contains AskUserQuestion and its schema matches the Claude Code fixture"
    command: "bun run test engine/src/tools/ask-user-question -t registered"
    expect_exit: 0
    timeout_sec: 30
  - name: ask-tool-emits-permission-requested
    kind: shell
    description: "calling AskUserQuestion emits permission.requested{kind:ask} and blocks until askHandler resolves"
    command: "bun run test engine/src/tools/ask-user-question -t blocks-on-ask-handler"
    expect_exit: 0
    timeout_sec: 30
  - name: ask-tool-returns-user-answer
    kind: shell
    description: "askHandler resolution of {answer:'yes, ship it'} surfaces as the tool_result content"
    command: "bun run test engine/src/tools/ask-user-question -t returns-answer"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 40
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 60
---

# T3-02 — Add `AskUserQuestion` tool

## Context
Claude Code ships a first-class `AskUserQuestion` tool the model calls when it needs clarification ("which database schema did you mean — v1 or v2?"). Jellyclaw has the plumbing for permission `ask` (the `AskHandler` type at `engine/src/permissions/types.ts` + its wiring in the TUI + the dashboard modal) but no model-invocable tool that uses it. The model has no way to pause and ask — it guesses or loops.

## Root cause (from audit)
- `engine/src/tools/index.ts:40` — `listTools()` returns 12 built-ins; `AskUserQuestion` is not among them.
- `engine/src/permissions/types.ts` defines `AskHandler = (call, ctx) => Promise<"allow" | "deny">`. The signature returns a binary decision — it has no data channel for a free-text answer.
- `engine/src/agents/loop.ts:358-367` emits `permission.requested` on every tool call. The dashboard + TUI already render a modal for this event — we need to piggy-back.

## Fix — exact change needed
1. **Widen `AskHandler` result.** In `engine/src/permissions/types.ts` add a new branch:
   ```ts
   export type AskHandlerResult =
     | "allow" | "deny"
     | { readonly kind: "answer"; readonly text: string };
   export type AskHandler = (call: ToolCall, ctx: AskHandlerContext) => Promise<AskHandlerResult>;
   ```
   Update `engine/src/permissions/engine.ts:124-141` `invokeAsk()` to pass through the `answer` variant untouched — but only for `AskUserQuestion`. For every OTHER tool, `"answer"` still collapses to `"deny"` (do not accidentally turn every `ask` into a data channel).
2. **New tool `engine/src/tools/ask-user-question.ts`:**
   ```ts
   inputSchema: {
     type: "object",
     properties: {
       question: { type: "string", description: "The question to ask the user." },
       options: { type: "array", items: { type: "string" }, description: "Optional multiple-choice options." }
     },
     required: ["question"],
     additionalProperties: false
   }
   ```
   Handler: build a `ToolCall { name: "AskUserQuestion", input }`, call `ctx.permissions` → the engine's `askHandler`, await the result. If result is `{ kind: "answer", text }`, return `text` as the tool output (string). If `"allow"` or `"deny"`, return the string `"<no answer — request was <decision>>"`.
3. **Permission rule default.** `AskUserQuestion` must NOT be in `READ_ONLY_TOOLS` (it needs user attention) and must NOT be in `EDIT_TOOLS`. Add it to a new `Set` `INTERACTIVE_TOOLS` exported from `engine/src/permissions/types.ts`, and in `engine/src/permissions/engine.ts` treat any tool in `INTERACTIVE_TOOLS` as ALWAYS going through the ask path (skip deny-rule match for this one tool — it has no side effects beyond "render the question").
4. **Loop wiring.** No code change in `engine/src/agents/loop.ts:311-524` — the existing tool handler pipeline already routes through `decide()`. The only adjustment: when the handler returns the `answer` text, it's passed verbatim to `stringifyResult` at `loop.ts:521` which already handles strings.
5. **Tests in `engine/src/tools/ask-user-question.test.ts`:**
   - `registered` — assert `listTools().some(t => t.name === "AskUserQuestion")` and the JSON Schema matches `test/fixtures/tools/claude-code-schemas/AskUserQuestion.json` (create this fixture from Anthropic's published schema).
   - `blocks-on-ask-handler` — stub an `askHandler` that returns a pending promise; assert the loop's tool handler awaits it before emitting `tool.result`.
   - `returns-answer` — stub `askHandler` returning `{ kind: "answer", text: "ship it" }`; assert `tool.result.output === "ship it"`.

## Acceptance criteria
- `listTools()` includes `AskUserQuestion` (maps to `ask-user-question-registered`).
- Calling it emits `permission.requested` with the widened payload (maps to `ask-tool-emits-permission-requested`).
- User's answer round-trips to the model as `tool_result` content (maps to `ask-tool-returns-user-answer`).
- TUI `PermissionModal` and dashboard already consume `permission.requested` — no changes needed there for this prompt; a follow-up UI prompt can add a text-input affordance.

## Out of scope
- Do NOT change the TUI `<PermissionModal>` to add a textbox — that's a T4 polish prompt.
- Do NOT change the dashboard permission flow — it already surfaces `permission.requested`.
- Do NOT add structured options rendering — this prompt ships the tool; option rendering is UI polish.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tools/ask-user-question
bun run test engine/src/permissions/engine
```
