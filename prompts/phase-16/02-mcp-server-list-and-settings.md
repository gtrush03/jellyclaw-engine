# Phase 16 — Desktop App Polish — Prompt 02: MCP server list + settings

**When to run:** After 16.01 is marked done.
**Estimated duration:** 6–8 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with 16. Verify 16.01 checkbox is ticked before proceeding.

---

## Research task

Read:

1. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-16-desktop-polish.md` — step 2.
2. `/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md` — Settings panel layout.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §7 (MCP transports: stdio, http, sse; OAuth flow), §8 (skills — only for the palette preset), §11 (permissions DSL: `Tool(pattern)`, precedence), §13 (hooks settings), §15 (telemetry).
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — secrets redaction, keychain policy, permissions precedence (deny > ask > allow; project > user > defaults).
5. `/Users/gtrush/Downloads/jellyclaw-engine/engine/PROVIDER-STRATEGY.md` — why Anthropic-first (OpenRouter prompt-caching bugs upstream #1245 and #17910), the banner copy.
6. `/Users/gtrush/Downloads/jellyclaw-engine/engine/CVE-MITIGATION.md` — badge contents for About tab.
7. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/` — existing secrets plumbing.

Fetch via WebFetch:

- `https://v2.tauri.app/plugin/stronghold/` — password-less vault pattern; we'll use the Tauri stronghold plugin for keys (salt-derived key stored at `$APPCONFIG/stronghold.bin`).
- `https://v2.tauri.app/plugin/shell/` — `Shell::open` for OAuth redirects.
- `https://modelcontextprotocol.io/docs` — MCP transport matrix, OAuth 2.1 flow for HTTP servers.
- Context7: `react-hook-form/resolvers` — Zod integration.
- `https://github.com/microsoft/playwright-mcp` — confirm current version (0.0.41 at time of writing) + default CDP port 9222.

## Implementation task

Build a 6-tab **Settings** screen: **Providers**, **MCP Servers**, **Permissions**, **Hooks**, **Telemetry**, **About**. Every editable control persists to `~/Library/Application Support/jellyclaw-desktop/settings.json` (macOS) / `%APPDATA%\jellyclaw-desktop\settings.json` (Windows) / `~/.config/jellyclaw-desktop/settings.json` (Linux) AND mirrors to the engine's config via `PUT /v1/config`, which hot-reloads.

### Files to create/modify

```
desktop/src/screens/Settings.tsx
desktop/src/screens/settings/ProvidersTab.tsx
desktop/src/screens/settings/McpTab.tsx
desktop/src/screens/settings/PermissionsTab.tsx
desktop/src/screens/settings/HooksTab.tsx
desktop/src/screens/settings/TelemetryTab.tsx
desktop/src/screens/settings/AboutTab.tsx
desktop/src/components/settings/KeyInput.tsx       # redacted display + reveal
desktop/src/components/settings/McpAddWizard.tsx
desktop/src/components/settings/PermissionEditor.tsx
desktop/src/components/settings/HookRow.tsx
desktop/src/lib/secrets.ts                         # stronghold bridge
desktop/src/lib/settings-schema.ts                 # Zod schemas
desktop/src/lib/mcp-presets.ts                     # Playwright, filesystem, git, etc.
desktop/src-tauri/src/stronghold.rs                # setup
desktop/src-tauri/src/shell.rs                     # open_browser command
desktop/src-tauri/Cargo.toml                       # tauri-plugin-stronghold, tauri-plugin-shell
engine/src/http/routes/config.ts                   # GET/PUT /v1/config
engine/src/http/routes/mcp.ts                      # list/connect/disconnect/oauth
engine/src/http/routes/permissions.ts              # GET/PUT rules
engine/src/permissions/dsl.ts                      # validator exported
```

### Prerequisites check

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
ls engine/src/http/routes/
bun run typecheck
cd desktop && pnpm typecheck && cd -
```

### Step-by-step

**1. Dependencies.**

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm add @tauri-apps/plugin-stronghold @tauri-apps/plugin-shell \
         react-hook-form@^7 @hookform/resolvers@^3 zod@^3 \
         @radix-ui/react-tabs @radix-ui/react-switch @radix-ui/react-dialog \
         @tanstack/react-query@^5
```

```bash
cd src-tauri
cargo add tauri-plugin-stronghold tauri-plugin-shell
```

Register plugins in `lib.rs`:

```rust
.plugin(tauri_plugin_stronghold::Builder::new(|password| {
    // deterministic salt derivation, see stronghold.rs
    argon2::hash_raw(password.as_bytes(), b"jellyclaw-salt-v1", &argon2::Config::default()).unwrap()
}).build())
.plugin(tauri_plugin_shell::init())
```

**2. `ProvidersTab.tsx`.**

Form fields:

- `anthropicApiKey` (required, stored in Stronghold, displayed as `sk-ant-api03-...****` with Reveal button, 10-second auto-hide)
- `openrouterApiKey` (optional, similarly stored)
- `providerPriority` toggle: `anthropic-first` (default, recommended) vs `openrouter-first`
- Test-connection button per key → `POST /v1/config/test-provider {provider, key}` → engine makes a trivial `messages.create` with `max_tokens: 1` and returns `{ ok, latencyMs, model }`.

Warning banner when `openrouter-first` is selected:

> OpenRouter's Anthropic proxy has intermittent prompt-caching bugs (upstream issues #1245, #17910) that may inflate token usage 10–100x. Anthropic-first is strongly recommended unless you need a non-Anthropic model for a specific task.

Keys round-trip through Stronghold, never through `localStorage`. The engine receives a short-lived session token (`POST /v1/auth/handshake {providerKeys}`) on every app start; keys are never written to `settings.json`.

**3. `McpTab.tsx`.**

List merged from `~/.jellyclaw/mcp.json` + project-local `.jellyclaw/mcp.json` via `GET /v1/mcp/servers`. Rows:

| Name | Transport | Status | Tool count | Actions |
| ---- | --------- | ------ | ---------- | ------- |
| badge: stdio / http / sse | dot: 🟢 connected, 🟡 connecting, 🔴 error, ⚪ disabled | integer | [Connect] [Disconnect] [Edit] [Delete] [OAuth] (HTTP only) |

Add-server wizard (`<McpAddWizard>`):

1. Paste npx command (`npx -y @scope/mcp-server --arg value`) OR URL (`https://mcp.example.com/sse`)
2. Parser detects transport: `npx|node|python|bun|...` → stdio; `https?://` ending `/sse` → sse; else http.
3. Preview parsed config JSON, let user tweak name/env.
4. Test-connect button → `POST /v1/mcp/servers/:name/connect` and wait for `connected` event over SSE.

Preset buttons below the "Add" button:

- Playwright (`npx @playwright/mcp@0.0.41 --cdp-endpoint=http://localhost:9222`)
- Filesystem (`npx -y @modelcontextprotocol/server-filesystem <cwd>`)
- Git (`uvx mcp-server-git --repository .`)
- Memory (`npx -y @modelcontextprotocol/server-memory`)

Definitions live in `lib/mcp-presets.ts` so Phase 17 can reuse them.

OAuth button (HTTP servers only): calls `POST /v1/mcp/oauth/:name/start` which returns `{ authorizeUrl, state }`. UI opens it via `@tauri-apps/plugin-shell` `openUrl(authorizeUrl)`. A tiny local HTTP listener (engine, port ephemeral) catches the callback, exchanges the code for tokens, and emits `mcp.oauth.complete` over SSE. The UI dismisses the modal on receipt.

**4. `PermissionsTab.tsx`.**

Two views: **Table view** (per-tool dropdown: Allow / Ask / Deny) and **Advanced** (raw DSL in CodeMirror with custom lezer-like validator).

DSL grammar (from SPEC §11):

```
rule       := action TOOL_PAT
action     := "allow" | "deny" | "ask"
TOOL_PAT   := TOOL "(" pattern ")"
TOOL       := "Bash" | "Read" | "Write" | "Edit" | "Grep" | "Glob" | "WebFetch" | "Task" | /mcp__[a-z0-9_-]+__[a-z0-9_-]+/
pattern    := glob-or-regex
```

Reuse `engine/src/permissions/dsl.ts`'s validator: export a pure `validateRule(line: string): { ok: true } | { ok: false; error: string }`. The CM6 editor calls it per line onChange and decorates invalid lines with a red underline via `linter` extension.

"Reset to Claude Code defaults" button → loads the 30-rule default set (Read/Glob allow, Edit/Write ask, Bash(rm*/sudo*) deny, etc. — ship the list in `engine/src/permissions/defaults.ts`).

Precedence explainer (static component below the editor):

> Precedence: **deny** > **ask** > **allow**. Scope: **project** > **user** > **defaults**. A `deny` in user settings overrides an `allow` in project settings.

Save → `PUT /v1/permissions/rules {rules: string[]}` → engine re-parses and hot-swaps.

**5. `HooksTab.tsx`.**

Shows the hooks from `~/.jellyclaw/settings.json` (SPEC §13 — `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`). Each row:

- Enable/disable toggle (persists as `"enabled": false` in the hook block)
- Matcher (read-only glob from the config)
- Command (inline editable via a mini CodeMirror in bash mode)
- "Test fire" → `POST /v1/hooks/test {hookType, mockInput}` runs the command with a synthetic payload and shows stdout/stderr/exit code in a modal.

Do NOT let the UI invent new hook types — only the 8 defined in SPEC §13. Unknown types in settings.json render greyed out with "Unknown hook type — edit JSON directly" hint.

**6. `TelemetryTab.tsx`.**

Single switch: "Send anonymous usage telemetry (errors + performance, no prompt text)" — **default OFF**. Below it, a `<pre>` showing an example payload so users see exactly what leaves the machine:

```json
{
  "event": "wish.dispatched",
  "duration_ms": 4123,
  "tool_calls": 5,
  "tokens_in": 12400,
  "tokens_out": 890,
  "error_kind": null,
  "os": "darwin-arm64",
  "version": "1.0.0",
  "anon_id": "stable-random-uuid-per-install"
}
```

Delete-all button → `DELETE /v1/telemetry/buffer` and clears the local buffer. Link to `docs/privacy.md` (Phase 18).

**7. `AboutTab.tsx`.**

- Desktop app version (from `package.json`)
- Engine version (from `GET /v1/version` — returns `{ engine, opencode, node }`)
- OpenCode upstream commit hash (same endpoint)
- CVE mitigations status badge — loads `GET /v1/security/mitigations` which surfaces the contents of `engine/CVE-MITIGATION.md` as a count of `{ mitigated: N, monitoring: M }`.
- Link to changelog, license, GitHub repo.

**8. Engine endpoints.**

```ts
// engine/src/http/routes/config.ts
router.get("/v1/config", async (_req, res) => res.json(await loadConfig()));
router.put("/v1/config", async (req, res) => {
  const parsed = ConfigSchema.parse(req.body);
  await saveConfig(parsed);
  await configEvents.emit("reload"); // triggers provider + MCP re-init
  res.json({ ok: true });
});

// engine/src/http/routes/mcp.ts
router.get("/v1/mcp/servers", listServers);
router.put("/v1/mcp/servers/:name", upsertServer);
router.delete("/v1/mcp/servers/:name", removeServer);
router.post("/v1/mcp/servers/:name/connect", connectServer);
router.post("/v1/mcp/servers/:name/disconnect", disconnectServer);
router.post("/v1/mcp/oauth/:name/start", startOAuth);
router.post("/v1/mcp/oauth/:name/callback", completeOAuth);

// engine/src/http/routes/permissions.ts
router.get("/v1/permissions/rules", listRules);
router.put("/v1/permissions/rules", async (req, res) => {
  const { rules } = z.object({ rules: z.array(z.string()) }).parse(req.body);
  for (const r of rules) validateRule(r); // throws on first bad
  await saveRules(rules);
  permissions.reload();
  res.json({ ok: true });
});
```

All writes emit SSE events so the UI re-queries without polling.

**9. Zod schema (`lib/settings-schema.ts`).**

```ts
export const SettingsSchema = z.object({
  providers: z.object({
    anthropic: z.object({ keyHandle: z.string() }),        // handle into stronghold
    openrouter: z.object({ keyHandle: z.string() }).optional(),
    priority: z.enum(["anthropic-first", "openrouter-first"]).default("anthropic-first"),
  }),
  mcp: z.record(z.string(), McpServerSchema),
  permissions: z.object({
    rules: z.array(z.string()),
    mode: z.enum(["ask", "allow-read", "yolo"]).default("ask"),
  }),
  hooks: z.record(z.string(), z.array(HookBlockSchema)).optional(),
  telemetry: z.object({ enabled: z.boolean().default(false) }),
});
```

Use `zodResolver(SettingsSchema)` with `react-hook-form`. On submit, diff against the server state and only PUT the changed subtree.

### Tests to add

- Vitest: `validateRule` accepts/rejects a fixture set of 20 rules.
- Vitest: preset-parser handles `npx`, `uvx`, URL forms.
- Engine integration: put-rule → get-rule round-trip, bad rule returns 400.
- Playwright CT: ProvidersTab — paste key → redacted display → Reveal → 10s auto-hide.
- Playwright CT: McpTab — add via wizard → preset click → preview JSON matches.
- Playwright E2E: edit a permission rule → dispatch a matching wish → confirm engine respects the new rule (look for `permission.denied` event with matching rule).

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm typecheck && pnpm test
pnpm tauri dev
# Settings → Providers → paste Anthropic key → Test → latency < 500ms
# Settings → MCP → preset Playwright → wizard → Test-connect → tool count > 0
# Settings → Permissions → add `deny Bash(rm -rf *)` → save
# Dispatch wish "delete the dist folder with rm -rf"
# Timeline shows permission.denied with rule "deny Bash(rm -rf *)"
```

### Common pitfalls

- **Stronghold requires a password.** We derive one deterministically from the device UUID + salt so the user never sees a prompt. This is "trust the device, not the cloud" — document in privacy.md.
- **Secrets in `settings.json`.** The settings file must NEVER contain raw keys — only handles. Add a schema-level refinement that rejects strings starting with `sk-`.
- **Reload storms.** Every `PUT /v1/config` triggers provider + MCP re-init. Debounce UI saves at 500ms, or use explicit "Save" buttons per tab.
- **OAuth localhost listener.** The engine opens an ephemeral port; on Linux, selinux/apparmor may block. Fallback to a manual "paste code" flow if the callback doesn't fire in 30s.
- **Playwright MCP port conflict.** CDP port 9222 collides with Chrome-debug sessions. The preset should write `--cdp-endpoint=http://localhost:9223` if 9222 is occupied (detect via a quick TCP probe before writing config).
- **Permissions DSL is scope-aware.** `Bash(rm*)` globs differently from `Bash(/^rm/)` (regex, with `/.../` delimiter). The editor needs syntax hints for both.
- **MCP stdio servers leak child processes** if the engine crashes mid-request. The engine's process manager (Phase 15.02) owns cleanup; UI only sends requests, never `SIGTERM`s directly.
- **Radix tabs + react-hook-form.** Switching tabs unmounts form fields by default. Use `FormProvider` at the root of `<Settings>` so state persists across tabs.
- **Windows Credential Manager row limit** is ~2.5KB per value. Stronghold on top of a file is fine — don't try to map 1:1 to Credential Manager.

### Why this matters

Settings is where trust is won or lost. A user who sees a redacted key, a clear permissions precedence explanation, a visible telemetry opt-out, and a CVE badge trusts the tool. A user who sees a monolithic JSON blob and a "probably safe" yolo default does not. Every tab is a contract.

---

## Session closeout

Paste `COMPLETION-UPDATE-TEMPLATE.md` with `<NN>=16`. Mark 16.02 complete, Phase 16 still 🔄. Commit `docs: phase 16.02 settings + mcp`. Next: `prompts/phase-16/03-approval-modal-and-steer-input.md`.
