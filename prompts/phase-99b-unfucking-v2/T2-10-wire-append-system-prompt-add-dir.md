---
id: T2-10-wire-append-system-prompt-add-dir
tier: 2
title: "Thread --append-system-prompt + --add-dir through to loop + path-taking tools"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/cli/run.test.ts"
  - "engine/src/agents/loop.ts"
  - "engine/src/tools/permissions.ts"
depends_on_fix: []
tests:
  - name: append-system-prompt-concatenated
    kind: shell
    description: "--append-system-prompt 'always say hi' appears verbatim in the systemPrompt passed to runAgentLoop"
    command: "bun run test engine/src/cli/run -t append-system-prompt-wired"
    expect_exit: 0
    timeout_sec: 30
  - name: add-dir-extends-allowed-cwds
    kind: shell
    description: "--add-dir /tmp/foo makes Read/Write/Glob/Grep accept /tmp/foo/** paths that would otherwise fail cwd escape"
    command: "bun run test engine/src/cli/run -t add-dir-extends-allowed-cwds"
    expect_exit: 0
    timeout_sec: 60
  - name: multiple-add-dir-flags-accumulate
    kind: shell
    description: "--add-dir /tmp/a --add-dir /tmp/b extends to both paths"
    command: "bun run test engine/src/cli/run -t add-dir-multiple"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 40
---

# T2-10 — Wire `--append-system-prompt` + `--add-dir`

## Context
Two paper-thin CLI features that users rely on: appending a session-specific instruction to the system prompt (think "always use metric units" for a data-analysis run) and expanding the set of directories the path-taking tools (Read, Write, Glob, Grep, Edit, MultiEdit, NotebookEdit) are allowed to touch. Both flags are parsed and dropped.

## Root cause (from audit)
- `engine/src/cli/run.ts:53` — `appendSystemPrompt?: string;` in `RunCliOptions`.
- `engine/src/cli/run.ts:56` — `addDir?: readonly string[];` (Commander repeatable-option).
- `engine/src/cli/run.ts:329-332` — the `void …` block. `options.appendSystemPrompt` and `options.addDir` are silently ignored.
- `engine/src/agents/loop.ts:132-135` — `systemPrompt` goes in verbatim; there is no downstream mechanism to append.
- `engine/src/tools/permissions.ts` — path tools use a CWD-escape check (see `selectArgString` at `engine/src/permissions/rules.ts:~140+` and `engine/src/tools/*.ts` handlers). The allowed roots come from `opts.cwd` only; there is no `additionalRoots` arg.

## Fix — exact change needed
1. **`engine/src/cli/run.ts:realRunFn` — append-system-prompt**:
   - After computing `soul` and (from T2-04) the skill injection block, concatenate the user's `--append-system-prompt` when non-empty:
     ```
     const sysParts = [soul, skillBlock, options.appendSystemPrompt].filter((x): x is string => typeof x === "string" && x.length > 0);
     const systemPrompt = sysParts.length > 0 ? sysParts.join("\n\n") : undefined;
     ```
   - Pass `systemPrompt` into `runAgentLoop({...})`. Ensure `undefined` is dropped via the existing spread pattern at `run.ts:152` (`...(soul !== null ? { systemPrompt: soul } : {})`).
2. **`engine/src/cli/run.ts:realRunFn` — add-dir**:
   - Normalise `options.addDir` to absolute paths via `path.resolve(process.cwd(), d)`. Reject any path with `..` or symlink traversal using `fs.realpathSync` and throw `ExitError(2, "--add-dir: path must exist and not traverse")` on failure.
   - Thread as `additionalRoots: readonly string[]` into `AgentLoopOptions` (add the field) and down into the `ToolContext` that path tools receive. The tool-context type already exists at `engine/src/tools/types.ts`; extend with `additionalRoots?: readonly string[]`.
3. **Path tools** (`engine/src/tools/read.ts`, `write.ts`, `glob.ts`, `grep.ts`, `edit.ts`, `notebook-edit.ts`): replace the single-cwd escape check with a helper `isWithinAllowedRoots(absPath, [cwd, ...additionalRoots])` (new export in `engine/src/tools/permissions.ts`). Allow iff the resolved absolute path starts with any allowed root (after both are normalised). This is a small, repeatable change — search for "cwd escape" comments and replace.
4. **Tests**:
   - `append-system-prompt-wired` — inject fake runFn; assert it receives `systemPrompt` containing the appended string. Edge case: with no soul and empty skill block, the append is the entire prompt.
   - `add-dir-extends-allowed-cwds` — create tmpdir `/tmp/jc-t2-10-<uuid>/`, run CLI with `--add-dir <tmpdir>` and a `Read` tool call for `<tmpdir>/file.txt` (pre-created). Assert success. Same call WITHOUT `--add-dir` returns a permission denial.
   - `add-dir-multiple` — two flags, two dirs, both accessible.
   - Traversal rejection — `--add-dir ../foo` or a symlink to `/etc` throws `ExitError` with a message containing "traverse" or "must exist".

## Acceptance criteria
- `append-system-prompt-concatenated` — appended text flows verbatim into the loop's system prompt (maps to test 1).
- `add-dir-extends-allowed-cwds` — additional roots accepted by path tools (maps to test 2).
- `multiple-add-dir-flags-accumulate` — repeatable flag works (maps to test 3).
- No `void appendSystemPrompt\|void addDir` string remains in `engine/src/cli/run.ts`.

## Out of scope
- Do NOT change how the soul is loaded. `loadSoul()` is already sound.
- Do NOT add `--system-prompt` (full replace). Only the append variant is in scope.
- Do NOT change MCP tool path handling — MCP tools manage their own paths via the server process.
- Do NOT touch `engine/src/permissions/**` — always-human-review scope. The path-root check lives in tools-layer helpers, which are fair game.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/cli/run engine/src/tools
grep -n "void appendSystemPrompt\|void addDir" engine/src/cli/run.ts && echo "STILL VOID" || echo "clean"
```
