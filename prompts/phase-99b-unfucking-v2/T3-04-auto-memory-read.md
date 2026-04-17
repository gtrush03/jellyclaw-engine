---
id: T3-04-auto-memory-read
tier: 3
title: "Auto-inject ~/.jellyclaw/projects/<hash>/memory/MEMORY.md into system prompt"
scope:
  - "engine/src/agents/memory.ts"
  - "engine/src/agents/memory.test.ts"
  - "engine/src/agents/loop.ts"
  - "engine/src/cli/run.ts"
  - "engine/src/server/routes/runs.ts"
depends_on_fix: []
tests:
  - name: memory-file-absent-no-injection
    kind: shell
    description: "no memory file present → system prompt is unchanged; no error thrown"
    command: "bun run test engine/src/agents/memory -t memory-file-absent"
    expect_exit: 0
    timeout_sec: 30
  - name: memory-file-present-injected
    kind: shell
    description: "memory file present → system prompt gains a '# Memory' block with the file contents"
    command: "bun run test engine/src/agents/memory -t memory-file-present"
    expect_exit: 0
    timeout_sec: 30
  - name: memory-path-uses-cwd-hash
    kind: shell
    description: "the resolved memory path is ~/.jellyclaw/projects/<sha256(cwd)[0:16]>/memory/MEMORY.md"
    command: "bun run test engine/src/agents/memory -t memory-path-uses-cwd-hash"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 45
---

# T3-04 — Auto-memory read on session start

## Context
Claude Code automatically reads `~/.claude/projects/<cwd-hash>/memory/MEMORY.md` at session start and injects it into the system prompt under a `# Memory` heading. This is how user preferences, project-specific facts, and accumulated context survive across sessions. Jellyclaw has no equivalent — every session starts cold.

## Root cause (from audit)
- `engine/src/agents/loop.ts:132-135` — `system` is built from `opts.systemPrompt` only. No memory injection happens.
- `engine/src/cli/run.ts` and `engine/src/server/routes/runs.ts` — the two callers that construct `AgentLoopOptions`. Neither reads a memory file.
- No helper module exists that maps `cwd → memory-file-path`.

## Fix — exact change needed
1. **New module `engine/src/agents/memory.ts`** exposing:
   ```ts
   /** SHA-256 of the absolute, normalized cwd, lowercased hex, first 16 chars. */
   export function projectHash(cwd: string): string;
   /** Resolved absolute path — DOES NOT check existence. */
   export function memoryPath(cwd: string): string;
   /** Read file if present; return null on ENOENT. Throws on other errors (unreadable file is surfaced — don't hide silently). */
   export async function loadMemory(cwd: string): Promise<string | null>;
   /** Format for injection. Matches Claude Code's observed shape. Null input → empty string. */
   export function formatMemoryBlock(contents: string | null): string;
   ```
   Format:
   ```
   # Memory
   <raw contents, trimmed>
   ```
   When input is `null` or all-whitespace, `formatMemoryBlock` returns the empty string — callers concatenate unconditionally.
2. **Inject in `engine/src/agents/loop.ts:132-140`.** Before the `const system: SystemBlock[] = …` assignment, call `await loadMemory(opts.cwd)` and concatenate its formatted block after `opts.systemPrompt` (separator: `\n\n`). Guard: if both are empty, `system` stays `[]`.
3. **CLI + server caller wiring.** Neither `engine/src/cli/run.ts` nor `engine/src/server/routes/runs.ts` needs changes — loading happens inside the loop. Add one log line via `opts.logger.info({ memoryBytes: contents?.length ?? 0 }, "auto-memory loaded")` at the read site.
4. **Path algorithm.** `projectHash(cwd)` uses `node:crypto` `createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16)`. `memoryPath(cwd)` returns `join(homedir(), ".jellyclaw", "projects", projectHash(cwd), "memory", "MEMORY.md")`.
5. **Test hooks.** The module reads `process.env.JELLYCLAW_MEMORY_DIR` as an override (same convention as `engine/src/cli/credentials.ts:49-55`). If set, `memoryPath()` uses `$JELLYCLAW_MEMORY_DIR/projects/<hash>/memory/MEMORY.md` instead of homedir. Document it in a module-level JSDoc.
6. **Tests in `engine/src/agents/memory.test.ts`:**
   - `memory-file-absent` — set `JELLYCLAW_MEMORY_DIR` to a temp dir, assert `loadMemory()` returns `null` and `formatMemoryBlock(null) === ""`.
   - `memory-file-present` — write a file to the temp dir at the expected path; assert `loadMemory()` returns the exact contents and `formatMemoryBlock` produces the `"# Memory\n<contents>"` form.
   - `memory-path-uses-cwd-hash` — call `memoryPath("/tmp/a")` and `memoryPath("/tmp/b")`; assert they differ in the hash segment and each hash is 16 lowercase hex chars.

## Acceptance criteria
- Absent memory file → no injection, no error (maps to `memory-file-absent-no-injection`).
- Present memory file → system prompt contains `"# Memory"` followed by contents (maps to `memory-file-present-injected`).
- Path algorithm matches spec (maps to `memory-path-uses-cwd-hash`).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT scan parent directories for memory files — only the exact cwd-hash path.
- Do NOT handle `@import` directives inside MEMORY.md — flat read only. (That's T4 polish.)
- Do NOT touch the write side — `T3-05-memory-write-tool` is the write prompt.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/memory
bun run test engine/src/agents/loop
```
