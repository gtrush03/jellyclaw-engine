# Phase 10 — CLI + HTTP + library — Prompt 01: CLI entry point with full flag set

**When to run:** After Phase 09 is fully ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3–4 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if Phase 09 not fully ✅. -->
<!-- END paste -->

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10-cli-http.md`.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — public CLI surface.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/integration/GENIE-INTEGRATION.md` — Genie's dispatcher shells out to `claurst`/this CLI; the flags must be compatible with Genie's current call sites.
4. Use context7 to fetch `commander@^12` docs — subcommand nesting, option types, hidden commands.
5. Read Claude Code's `--help` output if reproducible; match flag names byte-for-byte where applicable (e.g. `--output-format stream-json|text|json`, `--permission-mode`, `--max-turns`, `--model`, `--resume`, `--continue`).
6. Read Phase 09 CLI stub at `engine/src/cli/sessions.ts` — your entry point needs to wire it in.

## Implementation task

Finalize the `jellyclaw` CLI at `engine/bin/jellyclaw` with the complete flag set and all subcommands.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw` — shebang stub that loads `dist/cli/main.js`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/main.ts` — Commander program definition and dispatch.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/run.ts` — `run` subcommand handler.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/resume.ts` — `resume` + `continue` subcommands (wrap Phase 09.02's resume helpers).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/doctor.ts` — environment diagnostics.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/config-cmd.ts` — `config show` / `config check`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/skills-cmd.ts`, `agents-cmd.ts`, `mcp-cmd.ts` — list subcommands.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/output.ts` — `stream-json`, `text`, `json` formatters.
- Modify `engine/package.json` — `"bin": { "jellyclaw": "bin/jellyclaw" }`.
- Tests: `cli-flags.test.ts`, `cli-output.test.ts`, `doctor.test.ts`, `run-smoke.test.ts`.

### `bin/jellyclaw` (exact)

```js
#!/usr/bin/env node
// Shim; everything lives in dist/cli/main.js.
import("../dist/cli/main.js").catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + "\n");
  process.exit(1);
});
```

`chmod +x engine/bin/jellyclaw`. Verify `engine/package.json` `"bin"` field points here.

### Full flag set for `run`

```
jellyclaw run [prompt]
  --model <id>                          # provider-agnostic model id
  --provider <primary|secondary>        # routes through Phase 02 provider strategy
  --mcp-config <path>                   # override MCP config path
  --permission-mode <default|acceptEdits|bypassPermissions|plan>
  --max-turns <n>
  --max-cost-usd <n>                    # fractional; engine aborts turn when cumulative >= threshold
  --output-format <stream-json|text|json>   # default: stream-json if !isTTY, text if TTY
  --session-id <id>                     # start with a specific session id (useful for HTTP-callers)
  --resume <id>                         # rehydrate
  --continue                            # newest-for-project
  --wish-id <id>                        # idempotency
  --append-system-prompt <text>         # concat to system prompt
  --allowed-tools <csv>                 # e.g. "Read,Grep,mcp__playwright__*"
  --disallowed-tools <csv>
  --add-dir <path>                      # extra cwd-like search dir (can repeat)
  --cwd <path>                          # run-as-if cwd
  --verbose
```

`prompt` is optional; if omitted AND stdin is piped, read stdin. If both missing → print help + exit 1.

### Subcommands

- `jellyclaw run [prompt]` (above)
- `jellyclaw resume <id> [prompt]` — sugar for `run --resume <id> [prompt]`.
- `jellyclaw continue [prompt]` — sugar for `run --continue [prompt]`.
- `jellyclaw serve [options]` — stub that delegates to Phase 10.02 (next prompt); OK to `throw` with `"implemented in 10.02"` placeholder for now.
- `jellyclaw sessions <list|search|show|rm>` — from Phase 09.02.
- `jellyclaw skills list` — from Phase 05 registry.
- `jellyclaw agents list` — from Phase 06 registry.
- `jellyclaw mcp list` — from Phase 07 registry (live tools).
- `jellyclaw config show [--redact]` — print effective merged config; redact secrets by default.
- `jellyclaw config check` — lint rules for conflicts; call into Phase 08.01 rule parser.
- `jellyclaw doctor` — diagnostics.

### `doctor` checks (all must pass → exit 0)

- Node `>= 20.6` (per `.nvmrc` or package engines).
- `opencode-ai` installed and matches pin.
- `patches/001-subagent-hook-fire.patch` sentinel found.
- `patches/002-bind-localhost-only.patch` sentinel found.
- `patches/003-secret-scrub-tool-results.patch` sentinel found.
- `~/.jellyclaw/` exists AND writable AND mode ≤ 0700.
- `ANTHROPIC_API_KEY` set (warn if missing; not fatal since secondary provider exists).
- Each configured MCP server: attempt connect with 5 s timeout; report reachable/unreachable.
- SQLite DB integrity check passes.

Output: pretty table, exit 0 iff all pass. On fail, exit 2 and print remediation hints.

### `stream-json` format

One JSON object per line:

```
{"type":"message_start","sessionId":"...","turn":1}
{"type":"text_delta","text":"Hello"}
{"type":"tool_use","id":"toolu_01","name":"Bash","input":{...}}
{"type":"tool_result","id":"toolu_01","content":"..."}
{"type":"message_stop","usage":{...},"cost_usd_cents":42}
```

Exactly matches the event envelope from Phase 03, one event per line. No pretty-printing.

### `text` format

Human-readable: streamed assistant text only. Tool events printed as `[tool: Bash] <input>` on stderr in `--verbose`.

### `json` format

Buffer entire run, emit one final JSON object with full transcript + usage + cost. Useful for batch scripts.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add commander@^12
bun run typecheck
bun run build
chmod +x engine/bin/jellyclaw
bun run test engine/src/cli
bun run lint
```

### Expected output

- `./dist/cli.js --help` lists every subcommand and the full run flags.
- `./dist/cli.js run "hello"` returns assistant output (smoke test from CLAUDE.md must pass).
- `./dist/cli.js doctor` prints a table.
- `./dist/cli.js --version` prints version from `package.json`.

### Tests to add

- `cli-flags.test.ts`:
  - `--output-format` rejects invalid values.
  - `--permission-mode plan` flows through to the engine.
  - `--resume` + `--continue` are mutually exclusive.
  - `--wish-id` with already-done wish → short-circuits and exits 0 with cached output.
  - stdin piping: `echo "hi" | jellyclaw run` reads stdin.
- `cli-output.test.ts`:
  - `stream-json` emits one JSON object per line; all parseable.
  - `json` emits one final object.
  - `text` omits tool events unless `--verbose`.
- `doctor.test.ts`:
  - Mock all checks → all-pass exit 0.
  - One check fails → exit 2 with remediation hint.
- `run-smoke.test.ts` — spawn the built CLI as a subprocess, run a trivial prompt, assert exit 0 and at least one event.

### Verification

```bash
bun run build
./engine/bin/jellyclaw --help                       # expect: full help
./engine/bin/jellyclaw --version                    # expect: version
./engine/bin/jellyclaw run "hello world"            # expect: assistant response
echo "hi" | ./engine/bin/jellyclaw run              # expect: reads stdin
./engine/bin/jellyclaw doctor                       # expect: table; exit 0 if healthy
./engine/bin/jellyclaw skills list                  # expect: loaded skills
./engine/bin/jellyclaw mcp list                     # expect: MCP tools
```

### Common pitfalls

- Commander's `action(async ...)` doesn't await by default — wrap in a helper that awaits and sets exit code.
- `--output-format` default: `process.stdout.isTTY ? "text" : "stream-json"`. Don't hard-code.
- Shebang `#!/usr/bin/env node` — must be the first line, no BOM.
- `--mutually-exclusive` in Commander: `--resume` + `--continue` → enforce in action handler explicitly; commander's `conflicts()` works for options.
- `--allowed-tools`: CSV parsing must preserve `mcp__server__tool` (double underscores) — split on `,` only, trim whitespace.
- `--add-dir` repeats: use `.option("--add-dir <path...>", ..., [])`.
- Piped stdin: detect `!process.stdin.isTTY` and `await streamToString(process.stdin)`; don't block on non-piped stdin.
- `process.exit` must be called ONLY from `main.ts` (per CLAUDE.md). Handlers throw typed errors; main maps to exit codes.
- `doctor` must never depend on having API keys — unreachable providers are warnings, not failures, except when explicitly set to `required`.
- Don't import engine code with side effects at module scope inside CLI — lazy-import in each subcommand so `--help` is snappy.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 10.01 ✅, next prompt = prompts/phase-10/02-http-server-hono.md. -->
<!-- END paste -->
