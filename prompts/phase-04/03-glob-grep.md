# Phase 04 — Tool parity — Prompt 03: Glob + Grep

**When to run:** After Phase 04 Prompt 02 (`02-edit.md`) is committed.
**Estimated duration:** 5-6 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `03-glob-grep`
<!-- END SESSION STARTUP -->

## Task

Implement `Glob` (tinyglobby-backed) and `Grep` (ripgrep-backed) with Claude Code parity, full flag support, and a <3s benchmark on a 100k-file tree. Do not mark Phase 04 complete.

### Context

`phases/PHASE-04-tool-parity.md` specifies: Glob uses `tinyglobby`, sorts by mtime desc, tests on 10k files; Grep uses `@vscode/ripgrep` binary, supports `content | files_with_matches | count` modes, multiline, context lines, glob/type filters; benchmark <3s on 100k files. Claude Code's Grep schema is rich — get the exact shape from Anthropic docs.

### Steps

1. Fetch schemas via `context7`: Glob and Grep. Save to `test/fixtures/tools/claude-code-schemas/{glob,grep}.json`.
2. Add dependencies to `engine/package.json`: `tinyglobby@^0.2`, `@vscode/ripgrep@^1.15`.
3. Implement `engine/src/tools/glob.ts`:
   - Input schema: `{ pattern: string, path?: string }`. Default `path` → `ctx.cwd`.
   - Use `tinyglobby` with `cwd: path, dot: false, absolute: true`.
   - Resolve results, `stat` each in parallel (bounded to e.g. 64-concurrency via a small queue), sort by `mtimeMs` descending.
   - Return `{ files: string[] }` — array of absolute paths.
   - Respect `.gitignore` by default (tinyglobby's `gitignore: true` option); document.
   - Refuse globs that escape `ctx.cwd` absolute boundaries (no `../../../..`-style patterns); validate.
4. Implement `engine/src/tools/grep.ts`:
   - Input schema matches Claude Code exactly: `{ pattern: string, path?: string, glob?: string, type?: string, output_mode?: "content"|"files_with_matches"|"count", "-i"?: boolean, "-n"?: boolean, "-A"?: number, "-B"?: number, "-C"?: number, context?: number, multiline?: boolean, head_limit?: number, offset?: number }`. Note the hyphenated keys — preserve them in the zod schema (`z.object({ "-A": z.number().optional() })`).
   - Shell out to the binary from `@vscode/ripgrep` at `rgPath`. Build argv:
     - `--json` for easy parsing when `output_mode === "content"`, else `--files-with-matches` or `--count` respectively.
     - `-i` → `--ignore-case`.
     - `-n` → default true in content mode; pass `--line-number` unless explicitly false.
     - `-A N` / `-B N` / `-C N` / `context N` → pass through.
     - `--multiline --multiline-dotall` when `multiline: true`.
     - `--glob <glob>` when provided.
     - `--type <type>` when provided.
     - `--max-count` limited by `head_limit` when applicable.
   - Never inject user input into shell — use `spawn` with argv array, not `exec`.
   - Parse ripgrep's `--json` lines into a typed result: `{ matches: Array<{ path, line_number, line, before?, after? }> }` or equivalent for the other output modes.
   - Apply `head_limit` and `offset` post-parse.
   - Truncate total output at 50,000 chars with "[truncated]" marker.
5. Register both in `engine/src/tools/index.ts`.
6. Author `test/unit/tools/glob.test.ts`:
   - Fixture directory with 10 files across 3 subdirs. `**/*.md` returns the 3 md files sorted by mtime desc.
   - `.gitignore` honored: a file listed in `.gitignore` is excluded by default.
   - Escape attempt `../../../etc/passwd` rejected.
7. Author `test/unit/tools/grep.test.ts`:
   - Fixture dir with 5 files: `foo.ts` has "hello" twice, `bar.ts` has "hello" once.
   - `output_mode: content, pattern: "hello"` → 3 matches.
   - `output_mode: files_with_matches` → 2 files.
   - `output_mode: count` → counts per file.
   - `-i` case-insensitive.
   - `-C 1` returns 1 line of context on each side.
   - `multiline: true` with a pattern spanning lines.
   - `type: "ts"` limits to TypeScript files only.
   - `head_limit: 1` limits to 1 match.
8. Author `test/perf/grep.bench.ts`:
   - Generate a 100k-file tree under `/tmp/jellyclaw-grep-bench/` (done once, cached by checking existence) with distributed string hits.
   - Run Grep with a common pattern. Assert wall-clock < 3000ms via `performance.now()`.
   - Gated by `BENCH=1` env var so CI doesn't always pay the cost.
9. Author `test/perf/glob.bench.ts` similarly: 10k-file tree, `**/*.md` glob < 500ms.
10. Run `bun run --filter @jellyclaw/engine test`. All green.
11. Run `BENCH=1 bun run --filter @jellyclaw/engine test test/perf` once, confirm benchmarks pass.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/glob.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/grep.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/index.ts` — register both.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/tools/{glob,grep}.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/perf/{glob,grep}.bench.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/claude-code-schemas/{glob,grep}.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — `tinyglobby`, `@vscode/ripgrep`.

### Verification

- Unit tests green.
- Schemas deep-equal fixtures.
- `BENCH=1` perf test: Grep < 3s on 100k files, Glob < 500ms on 10k files.
- `rgPath` from `@vscode/ripgrep` actually exists on disk at module load; assert in a post-install check.

### Common pitfalls

- **Shell-injection into rg.** Pass argv as an array, never concatenate into a shell string. `pattern` arrives from the model and may contain shell metachars.
- **ripgrep binary missing.** `@vscode/ripgrep` downloads a prebuilt binary on install; if the install ran offline, `rgPath` may be undefined. Fail loudly at tool-registration time with a fix hint ("run `bun install` with network").
- **tinyglobby not honoring `.gitignore` by default.** Versions vary; pin and verify. Test explicitly.
- **Sorting by `atime` instead of `mtime`.** Claude Code sorts by mtime desc. Verify.
- **rg JSON output chunked across reads.** Accumulate via a line buffer; a partial last line must not be parsed.
- **`head_limit` semantics.** It's a post-filter cap on output lines in content mode, NOT a cap on files searched. Confirm against Claude Code behavior.
- **Huge `-C` context causing OOM.** Cap `context` at 50. Document.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `03-glob-grep`
- Do NOT mark Phase 04 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
