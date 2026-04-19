# Phase 07.5 — Chrome MCP — Prompt T1-01: Bump @playwright/mcp 0.0.41 → 0.0.70

**When to run:** After `T0-02` ✅ in `COMPLETION-LOG.md`. STOP if T0-02 is not complete.
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Research task

1. Re-read `phases/PHASE-07.5-chrome-mcp.md` Step 3.
2. Read `patches/004-playwright-mcp-pin.md` in full. Note every "missing tool" claim — every one must be re-verified against v0.0.70.
3. Read `package.json` line 68 — current pin is `@playwright/mcp@0.0.41` in ROOT devDependencies. Read `engine/package.json` — Playwright MCP is NOT present there, which means it does NOT ship with `npm install @jellyclaw/engine`. We fix that here.
4. Use `context7` MCP via the `mcp__plugin_compound-engineering_context7__query-docs` tool to fetch current `@playwright/mcp` docs (query: "playwright mcp CLI flags and tools list"). Cross-check against what you find.
5. WebFetch `https://registry.npmjs.org/@playwright/mcp/latest` to confirm the CURRENT npm-registered version. If the version has advanced past 0.0.70 by the time this runs, pin to the current `latest` but document the specific version in the patch doc.
6. WebFetch `https://github.com/microsoft/playwright-mcp/releases/tag/v0.0.70` (or whichever you pin to) and read the release notes.
7. Read `test/fixtures/mcp/playwright.test-config.json` and `test/integration/playwright-mcp.test.ts:37-228` — these are the regression gate. Nothing in them should need to change; if something does, the pin is breaking and you stop with FAIL.
8. Read `docs/playwright-setup.md` so you know what user-facing docs already mention the 0.0.41 pin.

## Implementation task

Move `@playwright/mcp` from root `package.json` devDep to `engine/package.json` regular dep. Bump the pin from `0.0.41` to `^0.0.70` (or newer if npm `latest` has moved). Rewrite `patches/004-playwright-mcp-pin.md` with current receipts + a Chrome Web Store extension subsection. Verify tool parity against the existing integration-test fixture.

This prompt does NOT: add Chrome-launch helper, ship docs, wire permissions. Those are T1-02 / T3-01 / T2-01.

### Files to create/modify

- `package.json` — remove `@playwright/mcp` from devDependencies
- `engine/package.json` — add `@playwright/mcp: ^0.0.70` (or current latest) to dependencies
- `patches/004-playwright-mcp-pin.md` — rewrite with 2026-04 receipts
- `bun.lock` and `engine/bun.lock` (if it exists) — regenerate via `bun install`
- `test/fixtures/mcp/playwright.test-config.json` — if it pins `@playwright/mcp@0.0.41`, update to match

### Patch-doc rewrite skeleton

`patches/004-playwright-mcp-pin.md` should now say (template, adapt to what you actually find):

```markdown
# Patch 004 — `@playwright/mcp` version pin

**Status:** Active pin.
**Current pin:** `^0.0.70` (previously `0.0.41`, bumped 2026-04-17 in T1-01).
**Location:** `engine/package.json` (moved from root `package.json:68` devDeps in this bump).

## Why we pin at all

The Microsoft `@playwright/mcp` server ships weekly releases. Between 0.0.41 and 0.0.70,
two potentially breaking changes landed:

- **v0.0.64 (2026-02-06):** default browser profile changed from persistent to in-memory.
  Mitigation: our integration test at `test/integration/playwright-mcp.test.ts` uses
  `--user-data-dir` explicitly; tests continue to pass.
- **v0.0.67 / 0.0.68 (2026-02-14):** `--no-sandbox` flag was renamed to
  `--no-chromium-sandbox` then reverted. Our test fixture does not use this flag.

## Tool parity verified against 0.0.70

Core tool names — unchanged from 0.0.41:
<list verbatim from `bun run engine/scripts/mcp-list.ts` output against v0.0.70>

## Chrome Web Store extension — new path added in v0.0.67

Microsoft shipped the "Playwright MCP Bridge" extension on the Chrome Web Store
(ID `mmlmfjhmonkocbjadbfplnigmagldckm`). With the `--extension` flag,
the MCP server connects to the user's real Chrome (default profile, real logins)
without exposing `--remote-debugging-port`. See `docs/chrome-setup.md`.

## Verification receipts (2026-04-17)

- npm registry: <paste from `curl https://registry.npmjs.org/@playwright/mcp/latest`>
- GitHub release: <paste top entry from `gh api repos/microsoft/playwright-mcp/releases`>
- Bundled Playwright dep: `playwright@<version>` per the npm manifest `dependencies`.

## Smoke test

```
bun run engine/scripts/mcp-list.ts --config test/fixtures/mcp/playwright.test-config.json
# Expect: playwright server ready; tools include browser_navigate, browser_snapshot, etc.
```

Run before merging any future bump.
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Move the dep
# 1) edit root package.json to remove @playwright/mcp from devDependencies
# 2) edit engine/package.json to add @playwright/mcp@^0.0.70 to dependencies

bun install

# Verify install
bun pm ls @playwright/mcp
# Confirm: listed under engine/, not root

# Tool-parity smoke
JELLYCLAW_PW_MCP_TEST=1 bun run test test/integration/playwright-mcp.test.ts
# Expect: green (the test already instantiates @playwright/mcp with --cdp-endpoint 9333)

# Typecheck + build
bun run typecheck
bun run build
bun run lint
```

### Expected output

- `@playwright/mcp` resolves via npm to `^0.0.70` (or newer latest)
- The gated integration test at `test/integration/playwright-mcp.test.ts` passes with no changes to the test code itself
- `bun run engine/scripts/mcp-list.ts --config test/fixtures/mcp/playwright.test-config.json` lists every tool the patch doc promises
- `patches/004-playwright-mcp-pin.md` reflects current reality with verifiable receipts
- Nothing in `engine/src/` changes — this is a dep-graph bump, not a code change

### Tests to add

None new. The existing `test/integration/playwright-mcp.test.ts` is the regression gate. If it goes red, the bump is unsafe — STOP and FAIL.

### Verification

```bash
# Full test suite — the existing tests are the gate
JELLYCLAW_PW_MCP_TEST=1 bun run test
# Expect: no new failures relative to pre-bump baseline (snapshot that baseline before starting)

# Confirm @playwright/mcp ships via engine package
cat engine/package.json | jq '.dependencies["@playwright/mcp"]'
# Expect: "^0.0.70" (or current latest)

cat package.json | jq '.devDependencies["@playwright/mcp"] // "MOVED"'
# Expect: "MOVED"

# Confirm patch-doc receipts are fresh
grep "2026-04" patches/004-playwright-mcp-pin.md
# Expect: at least one 2026-04 datestamp
```

### Common pitfalls

- **Don't skip the `bun install` step.** Lockfile needs regeneration; stale locks will resolve to 0.0.41 again.
- **If the integration test goes red, don't patch the test — revert the bump and FAIL.** The test exists exactly to catch this regression.
- **Check both `bun.lock` AND `engine/bun.lock`.** If the monorepo uses workspaces, both may need regen.
- **npm registry `latest` may have moved past 0.0.70.** Pin to whatever `latest` actually resolves to at run time, and document that exact version in the patch doc. `^0.0.70` accepts patch-bumps but not minor — keep the `^` for flexibility.
- **Do NOT ship the Chrome Web Store extension.** Users install it; we just document. You can't `npm install` a Web Store extension.
- **Do NOT change `test/integration/playwright-mcp.test.ts` internals** — it's already shaped right. If it needs updating because of a real 0.0.70 API change, that's a separate prompt, not this one.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T1-01 ✅`.
2. Update `STATUS.md` to point at `T1-02`.
3. Print `DONE: T1-01`.

On fatal failure (e.g., integration test goes red): `FAIL: T1-01 integration test regression: <paste failing assertion>`.
