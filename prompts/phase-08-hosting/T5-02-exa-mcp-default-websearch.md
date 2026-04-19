# Phase 08 Hosting — Prompt T5-02: Wire Exa MCP as default WebSearch

**When to run:** After T5-01 ✅ lands. Depends on http MCP transport being verified.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

`engine/src/tools/websearch.ts` today is a stub that throws `WebSearchNotConfiguredError` — Claude Code's model expects a `WebSearch` tool to exist so we register a placeholder, but actually calling it gives the agent a loud "configure a search MCP" error. This is a parity gap: Claude Code ships real web search; jellyclaw does not. OpenCode solved this by wiring Exa MCP (they ship it as the default). We mirror that.

With T5-01 done, HTTP MCP works. Exa exposes a Streamable-HTTP MCP at `https://mcp.exa.ai/mcp`. Once it's in `engine/templates/mcp.default.json` with `_disabled: false`, every `jellyclaw run` auto-loads it and `mcp__exa__web_search_exa` shadows the stub. The model calls it, gets real results, done.

This prompt:
1. Flips the Exa entry T5-01 added to `mcp.default.json` from disabled to enabled (gated on `EXA_API_KEY` env var so it gracefully no-ops when the user hasn't set a key).
2. Deletes the WebSearch stub from `builtinTools` so there's no confusion when a user hasn't configured Exa — the tool simply isn't advertised.
3. Deletes `WebSearchNotConfiguredError` from `engine/src/tools/types.ts` — no longer needed.
4. Updates `engine/src/tools/index.ts` exports accordingly.
5. Updates `docs/tools.md` and `docs/mcp.md` to document the new default.
6. Updates the tool-parity test to reflect the WebSearch removal.

## Research task

1. Read `engine/src/tools/websearch.ts` in full — understand every export to prune.
2. Read `engine/src/tools/index.ts:32,58,102-106` — three places import from `./websearch.js`. All three need to move.
3. Read `engine/src/tools/types.ts` — locate `WebSearchNotConfiguredError`. Check if anything OUTSIDE `websearch.ts` imports it (grep the repo).
4. Read `test/unit/tools/parity.test.ts` if it exists, or `engine/src/tools/index.test.ts` — whichever tracks the list of built-in tools. You're removing `WebSearch` from the expected list.
5. Read `engine/templates/mcp.default.json` as updated by T5-01 — you flip one `_disabled` flag, and you may need to tighten the env-var handling.
6. Read `engine/src/cli/mcp-config-loader.ts` — confirm how `_disabled` is stripped and whether the loader performs env-var substitution on values like `${EXA_API_KEY}`. If it does NOT, you must gate this entry with "if `EXA_API_KEY` unset, skip silently."
7. Re-read `docs/CHROME-MCP-INTEGRATION-PLAN.md` § 2 for the Exa endpoint + tool-surface confirmation (`mcp__exa__web_search_exa` is the expected tool name).

## Implementation task

Scope: replace the WebSearch stub with the Exa MCP as the default provider. When `EXA_API_KEY` is present, WebSearch "just works" via MCP. When it isn't, the tool is simply not advertised to the model (cleaner than throwing at call-time). Delete the stub code + error class; update the tool registry; refresh docs + tests.

### Files to create / modify

- `engine/templates/mcp.default.json` — flip Exa entry `_disabled: false`; add loader-level gating on `EXA_API_KEY`.
- `engine/src/cli/mcp-config-loader.ts` — add a "skip if required env var missing" pass (only for entries carrying a reserved `_requires_env` marker). Small, additive — no breaking change to existing configs.
- `engine/src/tools/websearch.ts` — **DELETE** (or convert to a 5-line file that just re-exports a doc comment pointing at Exa MCP, if other modules still reference the path during the deprecation window — prefer delete).
- `engine/src/tools/types.ts` — remove `WebSearchNotConfiguredError`.
- `engine/src/tools/index.ts` — drop `websearchTool` import + registry entry; drop the re-export block at lines 102-106.
- `engine/src/tools/index.test.ts` — remove WebSearch from the expected built-in tool list.
- `test/unit/tools/parity.test.ts` (if it exists) — update expected Claude-Code-parity list: `WebSearch` is no longer a built-in; it comes via MCP now.
- `docs/tools.md` — WebSearch section: "Provided by the default Exa MCP. Set `EXA_API_KEY` in your environment to enable."
- `docs/mcp.md` — Defaults section: document the Exa entry.
- `COMPLETION-LOG.md` — append entry.

### Loader change — `_requires_env` gate

Add a minimal, orthogonal marker so template entries that need a secret can no-op cleanly:

```json
{
  "_comment": "Default — Exa WebSearch via Streamable-HTTP MCP. Set EXA_API_KEY to enable.",
  "_requires_env": ["EXA_API_KEY"],
  "transport": "http",
  "name": "exa",
  "url": "https://mcp.exa.ai/mcp",
  "headers": { "Authorization": "Bearer ${EXA_API_KEY}" }
}
```

In `mcp-config-loader.ts`, after the `_disabled` filter:

```ts
// Skip entries whose required env vars aren't set. Lets the default
// template ship active-by-default for users who have the key, silent
// for users who don't — no error, no stub.
const requiresEnv = (entry as { _requires_env?: string[] })._requires_env;
if (Array.isArray(requiresEnv)) {
  const missing = requiresEnv.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.debug({ server: entry.name, missing }, "mcp: skipping entry — required env var(s) unset");
    continue;
  }
}
// Strip the marker before zod-parsing.
delete (entry as { _requires_env?: unknown })._requires_env;
```

Then env-var substitution on `headers` values — if the loader doesn't already support `${VAR}`, add a simple pass:

```ts
function expandEnv(v: string): string {
  return v.replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => process.env[k] ?? "");
}
// apply to every value in entry.headers
```

### Tool registry pruning

In `engine/src/tools/index.ts`:

```ts
// REMOVE these two lines:
import { websearchTool } from "./websearch.js";
// ...
  websearchTool as Tool<unknown, unknown>,   // remove from builtinTools array
// REMOVE the re-export block at 102-106:
export {
  _resetWebSearchWarning,
  emitWebSearchRegistrationWarning,
  websearchTool,
} from "./websearch.js";
```

Delete `engine/src/tools/websearch.ts` and `engine/src/tools/websearch.test.ts` (if present — check with `ls engine/src/tools/websearch*`).

In `engine/src/tools/types.ts`, remove:

```ts
export class WebSearchNotConfiguredError extends Error { ... }
```

Any place that imports `WebSearchNotConfiguredError` — grep and drop those imports.

### Parity test update

`test/unit/tools/parity.test.ts` (or wherever the Claude-Code-parity list lives) must drop `"WebSearch"` from the expected-present list. Add a comment line:

```ts
// WebSearch intentionally absent from builtinTools — provided via
// the default Exa MCP instead. See docs/tools.md and T5-02.
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/tools/
bun run test engine/src/cli/mcp-config-loader.test.ts
bun run test test/unit/tools/parity.test.ts 2>/dev/null || echo "parity test path differs — find + update"
bun run lint
bun run build

# Smoke 1 — without EXA_API_KEY: no WebSearch advertised, no error.
unset EXA_API_KEY
echo "list your available tools and tell me if you have WebSearch" | \
  /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw run \
    --output-format stream-json --permission-mode bypassPermissions --max-turns 3 2>&1 | \
  grep -iE "websearch|tools" | head -10
# Expect: NO mention of a WebSearch tool in the tool list

# Smoke 2 — with EXA_API_KEY: Exa MCP loads, model uses mcp__exa__web_search_exa
export EXA_API_KEY="your-key-here"   # substitute real key
echo "search the web for 'anthropic claude 4.7 release date' and tell me the date" | \
  /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw run \
    --output-format stream-json --permission-mode bypassPermissions --max-turns 5 2>&1 | \
  grep -E "mcp:|exa|web_search" | head -20
# Expect: "mcp: connected server=exa tools=N" AND a tool_use for mcp__exa__web_search_exa
```

### Expected output

- `WebSearch` no longer appears in the built-in tool list (`listTools()` length decreased by 1).
- With `EXA_API_KEY` unset: jellyclaw starts cleanly, MCP registry logs show 0 user-MCP servers auto-started, no stub tool.
- With `EXA_API_KEY` set: `mcp__exa__web_search_exa` is registered and callable; model actually fetches real results.
- `WebSearchNotConfiguredError` is gone from the codebase (grep returns zero matches outside docs / CHANGELOG).
- `docs/tools.md` explains the new WebSearch path.
- Parity test passes (WebSearch no longer asserted in built-ins).

### Tests to add / update

- `engine/src/tools/index.test.ts`: `builtinTools` count drops by 1; `WebSearch` no longer in names.
- `engine/src/cli/mcp-config-loader.test.ts`: new case — entry with `_requires_env: ["MISSING_VAR"]` is skipped; entry with a set var keeps flowing.
- `engine/src/cli/mcp-config-loader.test.ts`: new case — `headers` values with `${VAR}` are expanded.
- `test/unit/tools/parity.test.ts` (or equivalent): WebSearch removed from the expected-present list.

### Common pitfalls

- **Don't break the no-EXA_API_KEY flow.** The MOST COMMON user state is "key not set" — that must be graceful (silent skip, zero error). The `_requires_env` gate is the load-bearing piece; test it explicitly.
- **Env-var substitution must NOT leak the unset case.** If `${EXA_API_KEY}` expands to empty string and the loader keeps the entry, the Authorization header becomes literal `"Bearer "` and Exa will 401 — confusing. The `_requires_env` gate short-circuits before that happens. Order matters: gate first, then substitute.
- **Don't also delete `webfetchTool`.** `WebFetch` is a DIFFERENT tool (fetches a specific URL). It stays as-is. Only `WebSearch` is being re-routed through MCP.
- **Watch for downstream imports of `WebSearchNotConfiguredError`.** Grep: `rg "WebSearchNotConfiguredError"` — drop every import site. If a doc example mentions it, update the doc.
- **Don't add Exa as a hard dependency.** It's configured via MCP, reached via HTTP — there is NO `npm install exa-client`. The only npm footprint is the `_requires_env` gate + existing http transport from T5-01.
- **Keep the template shape loader-backward-compatible.** `_requires_env` is an underscore-prefixed marker like `_disabled` and `_comment` — pre-existing configs without it keep working unchanged. If anyone's running a custom `mcp-config-loader` fork, this is purely additive.
- **Emit a one-time info log when Exa loads.** `info` level (not debug): `mcp: Exa WebSearch enabled via EXA_API_KEY`. Gives operators visibility.

## Closeout

1. Update `COMPLETION-LOG.md` with `08.T5-02 ✅` — file counts, whether the live Exa smoke passed.
2. Print `DONE: T5-02`.

On fatal failure: `FAIL: T5-02 <reason>`.
