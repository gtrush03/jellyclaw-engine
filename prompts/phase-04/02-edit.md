# Phase 04 — Tool parity — Prompt 02: Edit

**When to run:** After Phase 04 Prompt 01 (`01-bash-read-write.md`) is committed.
**Estimated duration:** 4-5 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `02-edit`
<!-- END SESSION STARTUP -->

## Task

Implement the `Edit` tool at `engine/src/tools/edit.ts` with exact Claude Code parity, including the load-bearing **unique-match invariant** for `old_string` and the `replace_all` flag. Author property-based tests. Do not mark Phase 04 complete.

### Context

Claude Code's Edit tool is the most semantically-tight tool in the stack. Its invariants:
- `old_string` must occur EXACTLY ONCE in the file, unless `replace_all: true`.
- `new_string` must differ from `old_string`.
- Indentation from the Read tool's line-number prefixes must not be pasted into `old_string`.
- Trailing newline at EOF is preserved.
- Must have been Read first (session cache invariant, same as Write).

### Steps

1. Fetch Claude Code's Edit input schema via `context7` MCP into `test/fixtures/tools/claude-code-schemas/edit.json`.
2. Implement `engine/src/tools/edit.ts`:
   - Input schema: `{ file_path: string, old_string: string, new_string: string, replace_all?: boolean (default false) }`.
   - Preconditions:
     - `file_path` absolute and within `ctx.cwd` unless override.
     - `ctx.readCache.has(resolve(file_path))` or throw `EditRequiresRead`.
     - File exists (Edit never creates — that's Write).
     - `old_string !== new_string` or throw `NoOpEdit`.
   - Load file as UTF-8.
   - Count occurrences of `old_string`. If `replace_all: false`:
     - 0 matches → throw `NoMatch` with a diagnostic including the first 120 chars of `old_string` and a hint "old_string not found — did you include line-number prefix or wrong indentation?".
     - >1 matches → throw `AmbiguousMatch { count }` with diagnostic "old_string matches N times; either make it more unique by adding surrounding context, or pass replace_all: true".
     - exactly 1 → proceed.
   - Replace.
   - Preserve EOF newline: if original file ends with `\n` and result does not, append `\n`. If original does NOT end with `\n` and result does, trim one trailing `\n` (rare — only if the edit spanned EOF).
   - Atomic write: `.jellyclaw.tmp` + rename.
   - Return `{ file_path, occurrences_replaced, diff_preview: string }` — `diff_preview` is a 6-line unified diff generated via a tiny diff helper (use `diff` npm package, add to `engine/package.json`).
3. Implement `engine/src/tools/edit-diagnostics.ts`:
   - Pure helper `explainMissingMatch(content, oldString): string` that inspects the file to guess why — whitespace mismatch? Line-number prefix accidentally included? Different line-endings (`\r\n` vs `\n`)? Returns human-readable hints for the caller.
   - Exported separately so it's unit-testable without I/O.
4. Register Edit in `engine/src/tools/index.ts`.
5. Author `test/unit/tools/edit.test.ts`:
   - Happy path: unique match → single replacement.
   - 0 matches → `NoMatch` with diagnostic.
   - 2 matches without `replace_all` → `AmbiguousMatch { count: 2 }`.
   - 2 matches with `replace_all: true` → both replaced.
   - `old_string === new_string` → `NoOpEdit`.
   - No prior Read → `EditRequiresRead`.
   - EOF newline preserved.
   - CRLF file: `old_string` with `\n` only matches nothing; diagnostic correctly explains line-ending mismatch.
   - Indentation bug: `old_string` with a leading `"1\t"` (line-number prefix accidentally copied) — diagnostic identifies and points to Read-output-prefix gotcha.
   - Atomic: simulate rename failure mid-write, assert original file intact.
6. Author a property-based test `test/unit/tools/edit.property.test.ts`:
   - Use `fast-check` (add to devDependencies).
   - Property: for any random string `s`, any substring `o` of `s` at a unique position, any `n` such that `n !== o`, Edit replaces `o` with `n` and the result equals `s.replace(o, n)`.
   - Property: if `o` occurs `k` times with `k >= 2`, Edit throws `AmbiguousMatch { count: k }` without `replace_all`.
   - Run 100 iterations (fast-check default).
7. Author `test/unit/tools/edit-diagnostics.test.ts`:
   - CRLF detection, leading line-number prefix detection, whitespace-only mismatch detection, and "genuinely absent" case each return appropriate hints.
8. Run `bun run --filter @jellyclaw/engine test`. All green.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/edit.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/edit-diagnostics.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/index.ts` — register Edit.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/tools/edit.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/tools/edit.property.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/tools/edit-diagnostics.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/claude-code-schemas/edit.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — add `diff`, `fast-check` (dev).

### Verification

- All tests pass including 100-iteration property test.
- `edit.ts` zod schema deep-equals the fixed Claude Code schema (via `zodToJsonSchema`).
- Ambiguous match diagnostic includes the count and the `replace_all` hint.
- EOF newline invariant preserved across all test fixtures.

### Common pitfalls

- **Regex-based replacement.** Do NOT use `.replace(regex, ...)` — use `indexOf` counting and `split`/`join`. `old_string` may contain regex metacharacters.
- **Counting occurrences via `split`.** `s.split(o).length - 1` is the count. Correct and avoids regex pitfalls.
- **Unicode length vs code-point confusion.** The count should be based on substring occurrences; JavaScript's `split`/`indexOf` works on UTF-16 code units. That matches Claude Code's behavior. Do not switch to grapheme clusters.
- **Diagnostic leaks.** `explainMissingMatch` must NOT return the entire file content — redact to a 200-char window around the expected location.
- **Replace_all with empty `old_string`.** Must be rejected — infinite match.
- **Property test flakiness.** Seed fast-check deterministically (`fc.assert(..., { seed: 42 })`) for reproducible CI runs.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `02-edit`
- Do NOT mark Phase 04 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
