---
id: T3-05-memory-write-tool
tier: 3
title: "Add Memory tool for model-driven memory read/write/delete"
scope:
  - "engine/src/tools/memory.ts"
  - "engine/src/tools/memory.test.ts"
  - "engine/src/tools/index.ts"
  - "engine/src/agents/memory.ts"
depends_on_fix:
  - T3-04-auto-memory-read
tests:
  - name: memory-tool-registered
    kind: shell
    description: "listTools() contains Memory with the documented subcommand schema"
    command: "bun run test engine/src/tools/memory -t registered"
    expect_exit: 0
    timeout_sec: 30
  - name: memory-write-new-entry
    kind: shell
    description: "Memory { action: 'write', content } creates MEMORY.md atomically with the given content"
    command: "bun run test engine/src/tools/memory -t write-new-entry"
    expect_exit: 0
    timeout_sec: 30
  - name: memory-persists-across-sessions
    kind: shell
    description: "after Memory write, a fresh loadMemory() call returns the written content byte-for-byte"
    command: "bun run test engine/src/tools/memory -t persists-across-sessions"
    expect_exit: 0
    timeout_sec: 30
  - name: memory-delete-clears-file
    kind: shell
    description: "Memory { action: 'delete' } removes the file; subsequent loadMemory returns null"
    command: "bun run test engine/src/tools/memory -t delete-clears-file"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 40
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 60
---

# T3-05 — Memory tool for model-driven writes

## Context
Claude Code lets the model write to its own memory via a dedicated tool — that's how it accumulates durable preferences like "don't create branches unsolicited." T3-04 adds READ at session bootstrap; this prompt adds WRITE so the model can actually update memory during a session. Without this, memory is a human-only asset.

## Root cause (from audit)
- `engine/src/agents/memory.ts` (created in T3-04) exposes `loadMemory` / `memoryPath` but NO writer.
- `engine/src/tools/index.ts:40` lists no `Memory` tool.
- There's no established atomic-write pattern in this module; `engine/src/cli/credentials.ts:27` already demonstrates the tmp-then-rename idiom we must mirror.

## Fix — exact change needed
1. **Extend `engine/src/agents/memory.ts`** (delta on top of T3-04):
   ```ts
   export async function saveMemory(cwd: string, contents: string): Promise<void>;
   export async function deleteMemory(cwd: string): Promise<void>;
   ```
   - `saveMemory`: resolve via `memoryPath(cwd)`, create parent dirs with `mode: 0o700`, atomic write (`writeFile(tmp, ...)` → `chmod(tmp, 0o600)` → `rename(tmp, final)`).
   - `deleteMemory`: `unlink()` the file; swallow `ENOENT` (idempotent); propagate other errors.
2. **New tool `engine/src/tools/memory.ts`** with one input schema and a small action dispatcher:
   ```ts
   inputSchema: {
     type: "object",
     properties: {
       action: { type: "string", enum: ["read", "write", "append", "delete"] },
       content: { type: "string", description: "required for write/append; ignored for read/delete" }
     },
     required: ["action"],
     additionalProperties: false
   }
   ```
   Handler logic:
     - `read`: `await loadMemory(ctx.cwd)` → returns the string or `"(empty)"` if null.
     - `write`: `await saveMemory(ctx.cwd, input.content)` → returns `"memory updated (<bytes> bytes)"`.
     - `append`: `await loadMemory(ctx.cwd)` then `saveMemory(ctx.cwd, (prev ?? "") + "\n" + input.content)` → returns `"memory appended"`.
     - `delete`: `await deleteMemory(ctx.cwd)` → returns `"memory deleted"`.
   Guard: zod schema refines — when `action ∈ {write, append}`, `content` must be a non-empty string. When `action ∈ {read, delete}`, `content` must be absent.
3. **Register** in `engine/src/tools/index.ts`. Memory is classified as **side-effectful** — it does NOT go in `READ_ONLY_TOOLS` (writes mutate a user-scoped file). Normal permission rules apply.
4. **Permissions default policy.** No code change to `engine/src/permissions/engine.ts`. The default `ask` mode will prompt the user the first time; users can allowlist `Memory` in their jellyclaw.json if desired.
5. **Tests in `engine/src/tools/memory.test.ts`** (all tests use `JELLYCLAW_MEMORY_DIR` override + a per-test temp dir):
   - `registered` — assert `listTools().find(t => t.name === "Memory")` exists; schema byte-for-byte matches `test/fixtures/tools/claude-code-schemas/Memory.json`.
   - `write-new-entry` — call handler with `{ action: "write", content: "hello" }`; assert the file exists with mode `0o600` and content `"hello"`.
   - `persists-across-sessions` — write "alpha", then in a second simulated session call `loadMemory()` — assert `=== "alpha"`.
   - `delete-clears-file` — write, then delete, then assert `loadMemory()` returns `null` and the file does not exist.
   - One extra negative: `write` with empty `content` — zod validation rejects, handler returns `invalid_input` error (matches the existing loop error path).

## Acceptance criteria
- All 4 subcommands work end-to-end (maps to all four tests).
- Atomic writes: under a concurrency stress test (spawn 10 parallel `saveMemory` calls with different contents), the final file contents equal ONE of the inputs exactly — no partial / interleaved content.
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT add history / versioning — if the model overwrites, prior content is gone.
- Do NOT add a `list` subcommand — memory is one file, not a collection.
- Do NOT add a TUI `/memory` command — that's UI follow-up.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tools/memory
bun run test engine/src/agents/memory
```
