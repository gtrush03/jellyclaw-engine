---
phase: 04
name: "Tool parity with Claude Code"
duration: "3 days"
depends_on: [01, 02]
blocks: [06, 11, 12]
---

# Phase 04 — Tool parity

## Dream outcome

Every tool Claude Code ships — Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, TodoWrite, Task, NotebookEdit — is available in jellyclaw with identical input schemas and indistinguishable behavior on the Claude Code test corpus. Anything OpenCode is missing or different is implemented as an override tool that replaces OpenCode's version.

## Deliverables

- `engine/src/tools/index.ts` — tool registry
- `engine/src/tools/overrides/{bash,edit,notebook-edit,grep,glob,todo-write}.ts` — replacements where needed
- `engine/src/tools/parity.test.ts` — input-schema equivalence tests
- `docs/tools.md` — tool matrix: Claude Code vs OpenCode vs jellyclaw override
- Integration tests against live OpenCode server

## Tool audit (per-tool plan)

### Bash
- OpenCode has Bash. Gaps: (a) `run_in_background` flag, (b) output capture of long-running commands via PTY.
- Override: wrap OpenCode's Bash, add `/pty` endpoint client for background mode, return `{ pid, tailUrl }`.
- Block patterns: `rm -rf /`, `curl | sh`, `:(){ :|:& };:` — reject pre-execution.

### Read
- OpenCode Read supports range; Claude Code adds `offset`/`limit` and image/PDF/ipynb awareness. Verify equivalence; override only if gap.

### Write
- Invariant: refuse to overwrite without a prior Read in-session. Implement as wrapper that consults session cache.

### Edit
- Critical invariant: `old_string` must be **unique** in the file. Override enforces uniqueness + `replace_all` flag + preserves trailing newline. Add property-based tests.

### Glob
- Use `tinyglobby` (faster than `fast-glob`, smaller). Sort by mtime desc. Test on 10k-file tree.

### Grep
- Use `@vscode/ripgrep` binary. Support `content | files_with_matches | count` modes. Multiline flag, context lines, glob/type filters.

### WebFetch / WebSearch
- Passthrough to OpenCode if equivalent. If not, wrap `undici` fetch for WebFetch; WebSearch can be deferred (no first-class Claude Code parity required for MVP) — ship a stub that errors with "configure a search MCP".

### TodoWrite
- Store in session state; emit `session.update` event. Persist to transcript (Phase 09).

### Task
- Wrapper over subagent dispatch (Phase 06).

### NotebookEdit
- Custom: parse `.ipynb` JSON, edit cell by id or index, preserve outputs unless `--clear-outputs`.

## Step-by-step

### Step 1 — Tool registry
`engine/src/tools/index.ts` returns an array of `{ name, schema, handler, overridesOpenCode: boolean }`. Expose to OpenCode via its tool registration API.

### Step 2 — Port/override each tool
For each gap identified above, create a file in `overrides/` with a Zod input schema copied verbatim from Claude Code's public schema (documented in Anthropic docs).

### Step 3 — Parity tests
`parity.test.ts` iterates a fixture of `{ tool, input, expected }` triples recorded from Claude Code on a sandbox repo. Run jellyclaw's tool, diff the output.

### Step 4 — Safety rails
- Write + Edit: refuse paths outside cwd unless `--allow-outside-cwd`.
- Bash: timeout default 120 s, max 600 s.
- WebFetch: domain allowlist via config.

### Step 5 — Performance
Grep on 100k-file repo must return in <3 s for a common pattern. Benchmark with `hyperfine`.

## Acceptance criteria

- [ ] 11 tools registered, all schemas identical to Claude Code
- [ ] Parity fixture passes
- [ ] Edit uniqueness enforced (property test with 100 random files)
- [ ] Bash background returns a `pid` + tail URL; output tailable
- [ ] Grep benchmark under 3 s on 100k files
- [ ] NotebookEdit round-trips a fixture notebook with outputs preserved

## Risks + mitigations

- **Schema drift** — Anthropic updates Claude Code tools — → weekly schema diff job; snapshot + alert.
- **Ripgrep binary not found on user machines** → bundle via `@vscode/ripgrep` which ships prebuilt binaries.
- **tinyglobby edge cases** → fall back to `fast-glob` behind a flag.

## Dependencies to install

```
@vscode/ripgrep@^1.15
tinyglobby@^0.2
undici@^6
```

## Files touched

- `engine/src/tools/index.ts`
- `engine/src/tools/overrides/*.ts`
- `engine/src/tools/parity.test.ts`
- `test/fixtures/tools/*.json`
- `docs/tools.md`
