# Phase 07.5 — Chrome MCP — Prompt T0-01: Wire MCP into the run path

**When to run:** First prompt of Phase 07.5. No dependencies beyond Phase 07 already being ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 2–3 hours
**New session?** Yes — always start a fresh Claude Code session per prompt.
**Model:** Claude Opus 4.6 (1M context).

You are resuming the jellyclaw-engine project at `/Users/gtrush/Downloads/jellyclaw-engine/`. Read `CLAUDE.md` in the repo root first. This is part of Phase 07.5 — Chrome MCP. The `scripts/autobuild-simple/run.sh` rig will poll your tmux pane for a final `DONE: T0-01` line on success or `FAIL: T0-01 <reason>` on fatal error — you must emit one of those as the last thing you print.

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-07.5-chrome-mcp.md` in full.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/run.ts` lines 120–370. Note specifically:
   - Line 137-140: the `ANTHROPIC_API_KEY` env-only check that ignores `~/.jellyclaw/credentials.json`
   - Line 172-181: the commented-out `// TODO(T2-05): Load MCP config from settings.json` block leaving `mcp` as `undefined`
   - Line 350: where `runAgentLoop` is invoked — `mcp` is already a parameter, just always undefined
   - Line 355-362: `finally` block where `mcp?.stop()` would fire if `mcp` were defined
3. Read `engine/src/server/run-manager.ts` lines 580–640. Grep the whole file for `mcp` / `McpRegistry` — note that it has zero MCP references today (opportunity to fix once).
4. Read `engine/src/cli/credentials.ts` in full — `loadCredentials()` and `defaultCredentialsPath()` are ready to reuse.
5. Read `engine/src/cli/mcp-cmd.ts` lines 60–220 for the reference implementation of config loading + McpRegistry construction — we will extract this into a shared loader.
6. Read `engine/src/config.ts` lines 80–200 for the `McpServerConfig` + `JellyclawConfig.mcp` zod schemas — this is the canonical config shape.

## Implementation task

Close the long-standing papercut where `jellyclaw run` advertises an `--mcp-config` flag (`engine/src/cli/main.ts:95`), parses it, then silently discards it. After this prompt lands, the CLI will load MCP server configs from three merged sources, instantiate `McpRegistry`, start servers, pass the registry to `runAgentLoop`, and clean up in `finally`. Mirror the fix into the HTTP `serve` path (`server/run-manager.ts`).

This prompt does NOT: bump the Playwright MCP version, ship a default template, canonicalize the multi-shape config drift, or add Chrome anything. Those are T0-02 / T1-01 / T1-02.

### Files to create/modify

- `engine/src/cli/mcp-config-loader.ts` — **new.** Exports `loadMcpConfigs(opts: { mcpConfig?: string; configDir?: string; cwd: string }): Promise<McpServerConfig[]>`. Resolution order: explicit `--mcp-config <path>` > `<cwd>/jellyclaw.json` > `~/.jellyclaw/jellyclaw.json`. Merge strategy: first-write-wins by server `name`. Returns `[]` if no sources exist.
- `engine/src/cli/run.ts` — replace the env-only `ANTHROPIC_API_KEY` check at 137-140 with `loadCredentials()` + `selectAuth()`. Replace the commented-out TODO block at 172-181 with real instantiation.
- `engine/src/server/run-manager.ts` — thread `mcp` through `RunManagerFactoryOptions` and pass to `runAgentLoop` at line ~609-622.
- `engine/src/cli/mcp-config-loader.test.ts` — unit tests for the loader.
- `engine/src/cli/run.test.ts` — integration test verifying creds+MCP wiring does NOT regress a no-MCP run.

### Loader semantics

- If `--mcp-config` is passed and the file doesn't exist → throw `ExitError(4, "mcp config not found: <path>")`.
- If `--mcp-config` is passed and the JSON is invalid → propagate zod error, exit 4.
- If a server with the same `name` appears in multiple sources, the earliest (CLI flag > cwd > home) wins; log a WARN via `logger.warn` naming all sources.
- Empty `.mcp[]` array anywhere is a no-op, not an error.
- Never mutate the input configs.

### Credential wiring (the co-landed bug fix)

Replace the env-only check at `engine/src/cli/run.ts:137-140` with:

```ts
const creds = await loadCredentials();
const auth = selectAuth(creds, parseRole(opts));
if (auth.kind === "none") {
  throw new ExitError(1,
    "jellyclaw: no credentials. Run `jellyclaw auth login` or `jellyclaw key set`."
  );
}
// pass auth to AnthropicProvider:
const provider = new AnthropicProvider({ auth, logger });
```

Imports to add to `run.ts`:
```ts
import { loadCredentials } from "./credentials.js";
import { selectAuth, parseRole } from "../providers/subscription-auth.js";
```

### MCP wiring

Replace `engine/src/cli/run.ts:172-181` with:

```ts
const mcpConfigs = await loadMcpConfigs({
  mcpConfig: opts.mcpConfig,
  configDir: opts.configDir,
  cwd,
});
let mcp: McpRegistry | undefined;
if (mcpConfigs.length > 0) {
  mcp = new McpRegistry({ logger });
  try {
    await mcp.start(mcpConfigs);
  } catch (err) {
    logger.warn({ err }, "one or more MCP servers failed to start; continuing without them");
    // Keep `mcp` around — registry handles per-server failure with retry/backoff.
  }
}
```

`runAgentLoop(..., { mcp, ... })` already accepts the param (see `engine/src/agents/loop.ts:989-1025`) — nothing downstream changes.

### server/run-manager.ts mirror

`RunManager` (`engine/src/server/run-manager.ts:~609-622`) constructs a `runAgentLoop` call. Add `mcp?: McpRegistry` to the factory options type at the top of the file, plumb it through, pass it to `runAgentLoop`. The `jellyclaw serve` subcommand at `engine/src/cli/serve.ts` constructs the RunManager — load MCP there too via `loadMcpConfigs`, same as `run.ts`.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck                          # must stay green
bun run test engine/src/cli/mcp-config-loader.test.ts
bun run test engine/src/cli/run.test.ts
bun run lint
bun run build
```

### Expected output

- `jellyclaw run --help` still lists `--mcp-config <path>` (unchanged)
- `JELLYCLAW_TEST_DRY=1 jellyclaw run "hi"` with `~/.jellyclaw/jellyclaw.json` empty `.mcp[]` → session.completed (no regression)
- `JELLYCLAW_TEST_DRY=1 jellyclaw run "hi" --mcp-config /nonexistent` → exits 4 with `mcp config not found`
- With the existing `~/.jellyclaw/jellyclaw.json` that George has (echo stdio server) → at session startup, stderr logs `mcp: starting 1 server(s)` then `mcp: server "echo" ready` then the agent receives `mcp__echo__*` tools in its tool list
- `jellyclaw serve` startup log includes the same MCP bootstrap messages
- `engine/src/cli/run.ts` no longer references `process.env.ANTHROPIC_API_KEY` directly — env access happens only via `loadCredentials()` which also checks env as a fallback

### Tests to add

- `engine/src/cli/mcp-config-loader.test.ts`:
  - returns `[]` when no sources exist
  - loads `<cwd>/jellyclaw.json` when present
  - loads `~/.jellyclaw/jellyclaw.json` when present
  - merges both with CLI-flag winning on collisions; WARN logged
  - explicit `--mcp-config <path>` override
  - throws on nonexistent `--mcp-config`
  - zod validation error on malformed JSON
- `engine/src/cli/run.test.ts`:
  - succeeds with creds on disk + no env var
  - succeeds with env var + no creds file (back-compat)
  - fails with neither
  - with one MCP server configured, session.started logs the server as ready
  - with a failing MCP server, run does NOT abort — warns and continues

### Verification

```bash
bun run test engine/src/cli/mcp-config-loader.test.ts      # expect: green
bun run test engine/src/cli/run.test.ts                    # expect: green
bun run typecheck                                           # expect: 0 errors
bun run lint                                                # expect: 0 errors

# Live smoke (will use real Anthropic creds from ~/.jellyclaw/credentials.json):
echo "say hello in one word" | ./engine/bin/jellyclaw run --output-format stream-json --max-turns 1
# expect: session.started → agent.message → session.completed, exit 0
```

### Common pitfalls

- **Don't delete `process.env.ANTHROPIC_API_KEY` as a fallback.** `loadCredentials()` already checks env as a secondary source — preserve that back-compat so CI doesn't break.
- **Don't drop the `mcp?.stop()` in finally.** Even if `mcp` was never instantiated, the optional-chain is harmless — but a future refactor might forget it.
- **Don't hard-fail on a single misbehaving MCP server.** The registry has retry/backoff — let it. A borked `~/.jellyclaw/jellyclaw.json` entry shouldn't brick `jellyclaw run`.
- **Resist the urge to canonicalize the config shape.** T0-02 does that. This prompt only closes the loading + credential gaps.
- **The `serve` path uses a different session-manager flow.** Don't just copy-paste `run.ts` code into `serve.ts`; follow the RunManager factory pattern that's already there.
- **Remember the zod schema already validates `.mcp[]` entries.** Your loader shouldn't re-validate — let `JellyclawConfig.parse()` raise if the file is malformed.

## Closeout

On success:
1. Update `COMPLETION-LOG.md` with a `07.5.T0-01 ✅` entry (match the existing format under Phase 07 entries).
2. Update `STATUS.md` current-phase/current-prompt to point at `T0-02`.
3. Print `DONE: T0-01` as the final line.

On fatal failure that cannot be resolved: print `FAIL: T0-01 <reason>` and stop. Do NOT commit, do NOT create a branch.
