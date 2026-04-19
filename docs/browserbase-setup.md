# Browserbase setup for jellyclaw hosted

Browserbase provides cloud-hosted Chrome instances accessible via MCP (Model Context Protocol). This guide walks through setting up Browserbase as your browser backend for jellyclaw.

## Setup steps

1. **Sign up** at https://www.browserbase.com and copy your `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`.

2. **Set Fly secrets** on your jellyclaw app:
   ```bash
   fly secrets set \
     BROWSERBASE_API_KEY=bb_live_… \
     BROWSERBASE_PROJECT_ID=proj_… \
     --app jellyclaw-prod
   ```

3. **Enable the Browserbase stanza** in your `jellyclaw.json` (or `engine/templates/mcp.default.json` if you're templating from it): flip `_disabled: true` to `_disabled: false`.

4. **Create a Context** (per-user persistent login state) via Browserbase's interactive session UI. See https://docs.browserbase.com/features/contexts for details. Save the returned `ctx_…` ID.

5. **Use the Context on a request**:
   ```bash
   curl -N https://<your-app>.fly.dev/v1/sessions \
     -H "Authorization: Bearer $JELLYCLAW_TOKEN" \
     -H "Content-Type: application/json" \
     -H "x-browserbase-context: ctx_abc123" \
     -d '{"prompt":"navigate to gmail.com and tell me my last 3 subject lines"}'
   ```

6. **Verify** the agent resumed your Context by inspecting the Browserbase dashboard's session replay for that run.

## Local development (Playwright path unchanged)

For self-hosted / laptop mode, keep using `scripts/jellyclaw-chrome.sh` + the Playwright stanza. Browserbase is optional.

## Failure modes

- **Missing `BROWSERBASE_API_KEY`**: jellyclaw fails to start the MCP server with a typed error. Fix: set the secret.
- **Malformed `x-browserbase-context` header**: 400 from `/v1/sessions`. Fix: send a valid Context ID (8-128 alphanumeric chars, underscores, or hyphens).
- **Browserbase 5xx**: surfaced as `tool.error code="upstream_unavailable"`.

## Header reference

| Header | Direction | Description |
|--------|-----------|-------------|
| `x-browserbase-context` | Client → jellyclaw | Per-request Context ID (optional). Lowercase per HTTP convention. |
| `X-Browserbase-Context-Id` | jellyclaw → Browserbase | Outbound header to Browserbase MCP. Populated from `x-browserbase-context`. |
| `Authorization` | jellyclaw → Browserbase | Bearer token with `BROWSERBASE_API_KEY`. |
| `X-Browserbase-Project` | jellyclaw → Browserbase | Project ID from `BROWSERBASE_PROJECT_ID`. |
