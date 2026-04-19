# Phase 07.5 — Chrome MCP — Prompt T0-02: Canonicalize MCP config

**When to run:** After `T0-01` ✅ in `COMPLETION-LOG.md`. STOP if T0-01 is not complete.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Research task

1. Re-read `phases/PHASE-07.5-chrome-mcp.md` Step 2.
2. Read `engine/src/cli/doctor.ts` lines 400–460. This is the ONLY production code path that references `~/.jellyclaw/mcp.json` + the `{servers: {name: cfg}}` shape. It is a drift we kill here.
3. Read `engine/scripts/mcp-list.ts` lines 20–80. Note it reads `~/.jellyclaw/jellyclaw.json` with `.mcp` as an OBJECT MAP, not an array — also drift.
4. Read `engine/src/config.ts:80-165`. The canonical shape is `JellyclawConfig.mcp: z.array(McpServerConfig).default([])`. This is the ONLY shape the runtime agent loop + `jellyclaw mcp list` + T0-01's loader agree on.
5. Read `engine/src/cli/mcp-cmd.ts` lines 60–210. Confirm it uses the array shape too.
6. Grep the whole repo for `~/.jellyclaw/mcp.json` and `servers:` (in MCP context). Tally every occurrence; each one gets fixed in this prompt.

## Implementation task

Eliminate the three conflicting MCP config shapes so every path — doctor, mcp-list CLI, engine/scripts, loader from T0-01 — agrees on one path (`<cwd>/jellyclaw.json` + `~/.jellyclaw/jellyclaw.json`) and one shape (`.mcp[]` array). Ship `engine/templates/mcp.default.json` as the canonical user-facing template and make `jellyclaw doctor` detect it.

This prompt does NOT: add Chrome anything, bump the Playwright pin, or ship the browser-launcher helper. Those are T1-01 and T1-02.

### Files to create/modify

- `engine/src/cli/doctor.ts` — rewrite the MCP-config check to use the T0-01 loader. Drop the `{servers:{…}}` shape reader.
- `engine/scripts/mcp-list.ts` — rewrite to use the T0-01 loader. Drop the object-map reader.
- `engine/templates/mcp.default.json` — **new.** Canonical template with explanatory comments (via `_comment` fields where JSON allows; or a sibling `.md` if not).
- `engine/src/cli/templates.ts` — **new.** Exports `getDefaultMcpTemplatePath()` + `readDefaultMcpTemplate()` for doctor + future init commands to reuse.
- `engine/src/cli/doctor.test.ts` — test the new MCP-config check.
- `docs/mcp.md` — strip the `~/.jellyclaw/mcp.json` reference (replace with `~/.jellyclaw/jellyclaw.json`).

### The canonical template

`engine/templates/mcp.default.json`:

```json
{
  "$schema": "https://jellyclaw.dev/schemas/jellyclaw.json",
  "mcp": [
    {
      "_comment": "Echo test server — safe to keep, illustrates stdio transport",
      "transport": "stdio",
      "name": "echo",
      "command": "bun",
      "args": ["./test/fixtures/mcp/echo-server.ts"]
    }
  ]
}
```

(Chrome entries land in T3-01 — not now.)

### Doctor check rewrite

`engine/src/cli/doctor.ts:411-432` currently reads `~/.jellyclaw/mcp.json` with a custom shape. Replace with:

```ts
import { loadMcpConfigs } from "./mcp-config-loader.js";
import { readDefaultMcpTemplate } from "./templates.js";

// …

const mcpConfigs = await loadMcpConfigs({ cwd: process.cwd() });
if (mcpConfigs.length === 0) {
  warn("no MCP servers configured");
  hint(`Copy the default template: cp ${templatePath()} ~/.jellyclaw/jellyclaw.json`);
} else {
  ok(`${mcpConfigs.length} MCP server(s) configured`);
  // reachability probe unchanged — uses the existing McpRegistry probe path
}
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/cli/doctor.test.ts
bun run lint
bun run build

# smoke
./engine/bin/jellyclaw doctor 2>&1 | grep -i mcp
./engine/bin/jellyclaw mcp list
bun run engine/scripts/mcp-list.ts
```

### Expected output

- `jellyclaw doctor` no longer reports "missing MCP config" false-positive when `~/.jellyclaw/jellyclaw.json` has `.mcp[]` entries
- `jellyclaw doctor` suggests the template path when no MCP configured
- `jellyclaw mcp list` agrees with `doctor` and with T0-01's loader
- `engine/scripts/mcp-list.ts` produces the same output as `jellyclaw mcp list`
- No code reference to `~/.jellyclaw/mcp.json` remains (grep the whole repo to confirm)

### Tests to add

- `engine/src/cli/doctor.test.ts`:
  - with `~/.jellyclaw/jellyclaw.json` empty `.mcp[]` → WARN + hint to copy template
  - with one MCP server configured → OK + name listed
  - with a malformed `jellyclaw.json` → doctor reports a clear error, does not crash

### Verification

```bash
bun run test                                               # full suite; expect: green or same-failures-as-before
bun run typecheck
bun run lint

# Ensure no stray references
grep -R "~/.jellyclaw/mcp.json" engine/ docs/ | grep -v node_modules  # expect: 0 hits
grep -R "servers:" engine/src/cli/doctor.ts                            # expect: 0 hits
```

### Common pitfalls

- **Don't break the `JellyclawConfig.mcp` zod schema.** It's already an array. The fix is one-way — kill the other shapes, don't try to accept both.
- **`$schema` references** in the template should be a placeholder URL; the actual schema doesn't exist yet. That's fine.
- **The template is READ at doctor runtime**, not bundled into `dist/`. Make sure `tsup` config includes `engine/templates/` in the published payload, or doctor will 404 after `npm publish`.
- **Don't touch `phases/` or `prompts/`** — those can stay with the old references; they're historical docs, not runtime code.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T0-02 ✅`.
2. Update `STATUS.md` to point at `T1-01`.
3. Print `DONE: T0-02`.

On fatal failure: `FAIL: T0-02 <reason>`.
