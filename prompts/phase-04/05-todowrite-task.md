# Phase 04 — Tool parity — Prompt 05: TodoWrite + Task (+ NotebookEdit)

**When to run:** After Phase 04 Prompt 04 (`04-webfetch-websearch.md`) is committed.
**Estimated duration:** 5-7 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `05-todowrite-task`
<!-- END SESSION STARTUP -->

## Task

Implement `TodoWrite`, `Task` (subagent dispatch stub that will be fleshed out in Phase 06), and `NotebookEdit` — closing the Phase 04 tool set. Add the parity test suite covering all 11 tools. Mark Phase 04 ✅ in `COMPLETION-LOG.md`.

### Context

Remaining tools from `phases/PHASE-04-tool-parity.md`: TodoWrite (session-scoped, emits `session.update` events), Task (wrapper over subagent dispatch — Phase 06 provides the real subagent engine; here we wire the schema + dispatch interface with a minimal working path), NotebookEdit (parse `.ipynb` JSON, edit by id or index, preserve outputs unless `clear_outputs`). Also run a cross-tool **parity suite** that compares all 11 tool schemas against Claude Code's reference schemas.

### Steps

1. Fetch schemas via `context7`: TodoWrite, Task, NotebookEdit. Save fixtures under `test/fixtures/tools/claude-code-schemas/`.
2. Implement `engine/src/tools/todowrite.ts`:
   - Input schema: `{ todos: Array<{ content: string, status: "pending"|"in_progress"|"completed"|"cancelled", activeForm: string, id?: string }> }`.
   - Store in `ctx.session.state.todos` (extend `ToolContext` with `session: { state, update }` handle — add to `engine/src/tools/types.ts` if not present).
   - Replace the full list on each call (Claude Code semantics — it's not a delta tool; the model always sends the full list).
   - Emit a `session.update` event via `ctx.session.update({ todos })` which the session writer turns into the jellyclaw `session.update` event.
   - Validate: exactly one todo can be `in_progress` at a time (Claude Code invariant); throw `MultipleInProgress` otherwise.
   - Return `{ todos, count: todos.length }`.
3. Implement `engine/src/tools/task.ts`:
   - Input schema: `{ description: string, prompt: string, subagent_type: string }`.
   - At Phase 04 this is a thin wrapper that delegates to a `ctx.subagents.dispatch(...)` service. Define the service interface in `engine/src/subagents/types.ts` with `dispatch({ name, prompt, allowedTools }): Promise<{ summary, usage }>`.
   - Provide a stub implementation `engine/src/subagents/stub.ts` that throws `SubagentsNotImplemented` — Phase 06 replaces this.
   - Wire the `Task` tool to call `ctx.subagents.dispatch`. If the stub is in place, the tool returns a clear "subagent dispatch not wired — Phase 06 required" error with the intended design sketch in the error detail.
   - This is a deliberate partial — document it in `docs/tools.md` and TODO-mark.
4. Implement `engine/src/tools/notebook-edit.ts`:
   - Input schema: `{ notebook_path: string, cell_id?: string, cell_type?: "code"|"markdown", edit_mode?: "replace"|"insert"|"delete", new_source?: string, cell_number?: number }` — match Claude Code exactly (get schema from context7).
   - Parse `.ipynb` JSON (use `JSON.parse`, assert `nbformat === 4`).
   - Locate cell by `cell_id` if provided, else by `cell_number` (0-indexed).
   - `edit_mode: "replace"` — replace `source` of located cell; preserve `outputs` unless `clear_outputs: true` (extend schema if Claude Code's includes it — verify). If type changed, clear `outputs` and `execution_count`.
   - `edit_mode: "insert"` — insert a new cell after the located cell (or at the specified position if no cell_id).
   - `edit_mode: "delete"` — remove the cell.
   - Write atomically.
   - Write invariant: must have been Read in this session first.
   - Return `{ notebook_path, cell_count, modified_cell_id }`.
5. Register all three in `engine/src/tools/index.ts`.
6. Author `test/unit/tools/todowrite.test.ts`:
   - Full list replacement semantics.
   - Multiple in_progress rejected.
   - Emits `session.update` (assert via spy on `ctx.session.update`).
   - Empty list accepted (clears todos).
7. Author `test/unit/tools/task.test.ts`:
   - With stub subagents service: throws `SubagentsNotImplemented`.
   - With mock subagents service returning a summary: tool returns `{ summary, usage }`.
   - Schema validation rejects missing `subagent_type`.
8. Author `test/unit/tools/notebook-edit.test.ts`:
   - Fixture 3-cell notebook: replace cell 1 source, assert outputs preserved.
   - Insert new markdown cell after cell 2; cell_count becomes 4.
   - Delete cell 0; cell_count becomes 2.
   - `clear_outputs: true` wipes outputs.
   - Changing `cell_type` resets execution_count + outputs.
   - Non-v4 notebook rejected.
   - No prior Read → `NotebookEditRequiresRead`.
9. Author `test/unit/tools/parity.test.ts`:
   - Iterate all 11 registered tools.
   - For each, convert its Zod schema via `zod-to-json-schema`, compare to the corresponding fixture in `test/fixtures/tools/claude-code-schemas/<name>.json` via deep-equal.
   - Deliberate drift (if we add fields for jellyclaw-specific behavior like `run_in_background` on Bash) must be whitelisted in a `parity-allowed-drift.json` file with justification.
10. Update `docs/tools.md` with the full 11-tool matrix (Claude Code | OpenCode | jellyclaw).
11. Run `bun run --filter @jellyclaw/engine test && bun run --filter @jellyclaw/engine typecheck && bun run lint`. All green.
12. Update `COMPLETION-LOG.md`. Mark Phase 04 ✅.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/todowrite.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/task.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/notebook-edit.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/index.ts` — register the final three.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/types.ts` — extend `ToolContext` with `session`, `subagents`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/subagents/types.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/subagents/stub.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/tools/{todowrite,task,notebook-edit,parity}.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/claude-code-schemas/{todowrite,task,notebookedit}.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/parity-allowed-drift.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/tools.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — add `zod-to-json-schema`.
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — Phase 04 ✅.

### Verification

- All 11 tools registered (assert via `listTools().length === 11`): Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, NotebookEdit.
- Parity suite passes — every tool's schema deep-equals its Claude Code fixture, allowed drift explicitly documented.
- `bun run --filter @jellyclaw/engine test` exits 0.
- `bun run --filter @jellyclaw/engine typecheck` exits 0.
- `bun run lint` exits 0.
- `COMPLETION-LOG.md` shows Phase 04 ✅ with commit SHA and today's date, AND the "Foundation" group shows 5/7 done (00-04).

### Common pitfalls

- **TodoWrite as a delta tool.** It isn't — it replaces the whole list each call. Test this explicitly.
- **Multiple `in_progress` silently allowed.** Claude Code rejects this. Our handler must reject too.
- **NotebookEdit stripping outputs silently.** Preserve unless `clear_outputs: true`. Regression-test on a notebook with large outputs.
- **Parity drift explosion.** It's tempting to add extra fields. Resist. Every drift entry needs a justification in `parity-allowed-drift.json`.
- **Task tool silently succeeding with stub.** The stub must clearly error so downstream isn't surprised. Include the Phase 06 reference in the error message.
- **Changing `cell_type` without resetting `execution_count`.** A markdown cell shouldn't have an execution_count. Reset it.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `05-todowrite-task`
- Mark Phase 04 as ✅ Complete in `COMPLETION-LOG.md`.
<!-- END SESSION CLOSEOUT -->
