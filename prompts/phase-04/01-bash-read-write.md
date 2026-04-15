# Phase 04 — Tool parity — Prompt 01: Bash + Read + Write

**When to run:** After Phase 03 is marked ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 6-8 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `01-bash-read-write`
<!-- END SESSION STARTUP -->

## Task

Implement the `Bash`, `Read`, and `Write` tools with exact Claude Code parity. Each lives at `engine/src/tools/<name>.ts`, is registered in `engine/src/tools/index.ts`, has unit tests in `test/unit/tools/<name>.test.ts`, and has input schemas matching Claude Code's published schemas byte-for-byte. Do not mark Phase 04 complete — the remaining four prompts close the phase.

### Context

`phases/PHASE-04-tool-parity.md` enumerates gaps vs. OpenCode. `engine/SPEC.md` §8 lists built-in tools; §14 specifies sandboxing (cwd jail, domain denylist for webfetch, etc.). Authoritative Claude Code input schemas live in Anthropic's public documentation — use `context7` MCP to fetch them.

### Steps

1. Fetch Claude Code tool schemas from Anthropic docs via `context7`. Resolve the `anthropic` / `claude-code` library id; query for "tool input schemas Bash Read Write". Paste each schema into a fixture file `test/fixtures/tools/claude-code-schemas/{bash,read,write}.json`.
2. Author `engine/src/tools/types.ts` with:
   ```ts
   export interface Tool<I = unknown, O = unknown> {
     name: string;
     description: string;
     inputSchema: JsonSchema;
     zodSchema: z.ZodType<I>;
     overridesOpenCode: boolean;
     handler: (input: I, ctx: ToolContext) => Promise<O>;
   }
   export interface ToolContext {
     cwd: string;
     sessionId: string;
     readCache: Set<string>;       // absolute paths read this session
     abort: AbortSignal;
     logger: Logger;
     permissions: PermissionService;
   }
   ```
3. Implement `engine/src/tools/bash.ts`:
   - Input schema: `{ command: string, description?: string, timeout?: number, run_in_background?: boolean }`. Default timeout 120000ms, max 600000ms.
   - Block patterns (pre-exec regex scan, reject with typed error): `rm -rf /` (and variants like `rm -rf /*`, `rm -rf $HOME`), `curl ... | sh`, `wget ... | sh`, fork bombs `:(){ :|:& };:`, `dd if=... of=/dev/sd*`.
   - Default: spawn via `child_process.spawn(cmd, { shell: "/bin/bash", cwd: ctx.cwd, signal: ctx.abort, timeout })`. Capture stdout + stderr, return `{ stdout, stderr, exit_code }`, truncate each at 30,000 chars (configurable) with a trailing "[truncated N chars]".
   - `run_in_background: true`: spawn detached, write stdout+stderr to `~/.jellyclaw/bash-bg/<pid>.log`, return `{ pid, tail_url: "file://..." }` immediately. Do NOT await exit.
   - Refuse `cd ..` escapes above `ctx.cwd` unless config grants `bash: allow` in permissions.
   - Sanitize env: pass a whitelist (PATH, HOME, USER, LANG, TERM, TMPDIR, SHELL) rather than `process.env` wholesale; never pass `ANTHROPIC_API_KEY` or similar.
4. Implement `engine/src/tools/read.ts`:
   - Input schema: `{ file_path: string, offset?: number, limit?: number, pages?: string }` — match Claude Code's extended schema that supports `pages` for PDFs.
   - Reject relative paths (require absolute; mimic Claude Code's behavior).
   - Dispatch by extension:
     - `.ipynb` → parse JSON, return all cells with outputs, respecting offset/limit over cell count.
     - `.pdf` → use `pdfjs-dist` (add to `engine/package.json`) to extract text per page; respect `pages` range string (`"1-5"` etc.). Max 20 pages per call; error if unspecified and PDF >10 pages.
     - Images (`.png .jpg .jpeg .gif .webp`) → return `{ type: "image", source: { type: "base64", media_type, data } }` for the model to ingest as vision.
     - Default text: read UTF-8, `offset`/`limit` are 1-indexed line numbers, return cat-n formatted `"${lineNo}\t${content}"` (Claude Code compat), default first 2000 lines.
   - Populate `ctx.readCache` with `resolve(file_path)` on success.
   - Empty-file warning: prepend a system reminder message rather than silent empty string.
5. Implement `engine/src/tools/write.ts`:
   - Input schema: `{ file_path: string, content: string }`.
   - **Invariant: must have been Read in this session first.** Consult `ctx.readCache`. If the target path is not present AND the file exists on disk, refuse with `WriteRequiresRead` error. If the file does not exist, allow (creating new files is fine).
   - Refuse paths outside `ctx.cwd` unless config allows `--allow-outside-cwd`.
   - Atomic write: write to `<path>.jellyclaw.tmp` then `rename` (preserves partial-write safety).
   - Preserve trailing newline behavior: if the existing file ends in `\n` and the new content does not, refuse with a `TrailingNewlineMismatch` warning unless the user forces it via an override (or just auto-preserve — match Claude Code; verify via fixture).
6. Register all three in `engine/src/tools/index.ts`. Expose `listTools()` that returns the registry array.
7. Author `test/unit/tools/bash.test.ts`:
   - Happy path: `echo hello` returns `{ stdout: "hello\n", stderr: "", exit_code: 0 }`.
   - Timeout: `sleep 5` with `timeout: 100` returns exit with `TimeoutError`.
   - Block: `rm -rf /` rejected pre-exec.
   - Background: returns pid + tail_url; log file gets data within 500ms.
   - Env scrub: a test command `env | grep ANTHROPIC` returns empty even when the parent process has the var set.
   - Truncation: stdout > 30000 chars is truncated with marker.
8. Author `test/unit/tools/read.test.ts`:
   - Fixture text file: offset/limit correct, 1-indexed.
   - Fixture notebook (`test/fixtures/tools/sample.ipynb`): cells + outputs returned.
   - Fixture PDF (2 pages) + 20-page PDF: `pages: "1-2"` works; 20-page without pages errors.
   - Fixture image: base64 data URL returned with correct media_type.
   - Empty file: reminder message included.
   - Populates `readCache` post-call.
9. Author `test/unit/tools/write.test.ts`:
   - Refuses overwrite without prior Read — error thrown.
   - Allows create when file does not exist.
   - Atomic: mid-write crash leaves the original file intact (simulate by spying on `rename`).
   - Trailing newline preservation.
   - Outside-cwd refused without flag.
10. Run `bun run --filter @jellyclaw/engine test`. All green.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/types.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/bash.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/read.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/write.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/index.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/tools/{bash,read,write}.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/claude-code-schemas/{bash,read,write}.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/sample.ipynb`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/sample.pdf`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/tools/sample.png`

### Verification

- Each tool's Zod schema matches the paired `claude-code-schemas/*.json` fixture (assert via `zodToJsonSchema` deep-equal test).
- `bun run --filter @jellyclaw/engine test` exits 0.
- Bash background: after 1 second, the log file contains expected output.
- Read on a 20-page PDF without `pages` throws; with `pages: "1-5"` returns 5 pages of text.
- Write without prior Read throws `WriteRequiresRead`.

### Common pitfalls

- **Block pattern bypass.** `echo 'rm -rf /' | bash` or `bash -c 'rm -rf /'` also needs to be blocked. Flatten the command via a light tokenizer before regex-matching; or run the scan against the full shell invocation string.
- **Path traversal in write/read.** Use `path.resolve(ctx.cwd, input.file_path)` then `startsWith(ctx.cwd + path.sep)` check. Not string `includes`.
- **Notebook output preservation.** Do NOT strip outputs unless explicitly asked. Claude Code keeps them.
- **PDF text extraction memory.** `pdfjs-dist` can balloon RAM on big PDFs; enforce `pages` on >10-page PDFs.
- **Atomic rename on Windows.** Not a concern yet (macOS/Linux only per SPEC), but note in TODO.
- **Env whitelist incomplete.** Missing `LANG` or `TERM` breaks Unicode output on some tools. The whitelist must include at least PATH, HOME, USER, LANG, LC_ALL, TERM, TMPDIR, SHELL, PWD.
- **Reading a file that was modified since prior Read.** Write should optionally check mtime and refuse if the cache is stale. Log as `write.stale_read` but allow the write (match Claude Code behavior — verify).

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `04`
- `<phase-name>` → `Tool parity`
- `<sub-prompt>` → `01-bash-read-write`
- Do NOT mark Phase 04 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
