# 004 — Playwright MCP version pin

**Not a code patch.** This note documents jellyclaw's dependency policy for the Playwright MCP server, which ships with the default `mcp.json` template.

## The pin

In `engine/templates/mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.41"]
    }
  }
}
```

The `@0.0.41` pin is deliberate and load-bearing.

## Why 0.0.41 specifically

Ecosystem scan (March–April 2026) surfaced a regression in `@playwright/mcp` versions after `0.0.41`:

- Several tool definitions (`browser_fill_form`, `browser_select_option`, `browser_run_code`, some `browser_tabs` variants) are missing from the server manifest in newer releases. Agents that depend on these tools — which includes every Genie recipe that drives web forms — silently fail with "tool not available."
- The dev team is tracking this as a definition-loading regression; no upstream fix has shipped as of this writing.
- `0.0.41` is the last version where the full tool surface is reliably present. It's stable, it works, and downgrading is a one-line change.

Until upstream cuts a fixed release with confirmed full-surface parity, jellyclaw pins to `0.0.41` in the default template. The verification runner (`engine/test/mcp-smoke.ts`) asserts that the expected tool list matches — if a user upgrades and tools go missing, CI catches it before a prompt does.

## How to override

Users who need a newer version (e.g., to pick up a new browser capability that only exists in later releases) can override in their personal config. The `mcp.json` in the user's config dir takes precedence over the template.

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
```

When overriding, run `jellyclaw doctor --mcp` to print the detected tool list and confirm the tools your recipes depend on are present. If any are missing, jellyclaw surfaces a `W/mcp:missing-tools` warning in the startup banner and in telemetry (if telemetry is opted in).

## When we unpin

We unpin under two conditions, both required:

1. Upstream releases a version that advertises a full superset of the 0.0.41 tool set.
2. Our smoke test passes against that version on macOS, Linux, and Windows CI.

When that happens, the `mcp.json` template will bump and this document will be updated with the new pin (not removed — we always pin, we just pin higher).

## Related

- `engine/test/mcp-smoke.ts` — the test that keeps us honest.
- `SECURITY.md` §3.4 — security rationale for pinning MCP dependencies in general.
- Upstream issue tracker: search `@playwright/mcp missing tool definitions` on the Microsoft/Playwright GitHub.
