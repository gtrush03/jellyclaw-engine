---
phase: 16
name: "Desktop app polish"
duration: "5 days"
depends_on: [15]
blocks: [18]
---

# Phase 16 — Desktop app polish

## Dream outcome

Jellyclaw Desktop is a tool a non-engineer can use. Skills and agents are edited inline. MCP servers are configured with a form. Approval dialogs are clear. Updates install themselves. Crashes are reported. Linux `.AppImage` and Windows `.msi` ship alongside the `.dmg`.

## Deliverables

- Skill editor (Monaco) + live preview
- Agent editor
- MCP server list + add/edit/remove forms
- Settings screen (full)
- Approval modal for `PreToolUse` hooks (diff viewer for Edit/Write)
- Tauri auto-updater (code-signed release channel)
- Sentry crash reporting
- Linux `.AppImage` and Windows `.msi` builds
- Onboarding flow (first-run wizard)

## Step-by-step

### Step 1 — Editors
Embed Monaco. For skills: two-pane (frontmatter form + body markdown). For agents: similar. Save writes to `~/.jellyclaw/skills/<name>.md` or `~/.jellyclaw/agents/<name>.md`. File watcher (Phase 05) reloads engine.

### Step 2 — MCP form
List from config, add form with transport picker (stdio/http/sse), test-connect button (POST to engine `/mcp/test`).

### Step 3 — Approval modal
When engine emits `permission.request` event with `action: "ask"`, render a modal:
- For Bash: show command, decision buttons (Allow once / Allow always / Deny)
- For Edit/Write: show diff via `diff2html`
- For MCP tool: show input JSON
Response POSTed to `/permissions/:id`.

### Step 4 — Auto-update
`tauri-plugin-updater`. Host `latest.json` on Vercel or S3. Sign release artifacts.

### Step 5 — Sentry
`@sentry/tauri` (or `@sentry/browser` + Rust `sentry`). Scrub PII. Opt-in on first run.

### Step 6 — Linux/Windows builds
GitHub Actions matrix. Tauri produces `.AppImage` / `.msi`. Windows: code-signing cert (EV for SmartScreen).

### Step 7 — Onboarding
First-run wizard:
1. Welcome
2. Enter ANTHROPIC_API_KEY (optional OPENROUTER)
3. Pick permission mode default
4. Import skills from `.claude/skills/` if detected
5. Test wish: "write a hello.txt file"

### Step 8 — Accessibility
- Keyboard navigation through timeline
- ARIA labels
- High-contrast mode

### Step 9 — Localization stub
Wire `i18next` with English only; ready for translators later.

### Step 10 — Perf
Timeline virtualization with `react-virtuoso` for long sessions.

## Acceptance criteria

- [ ] Skill + agent editors round-trip without data loss
- [ ] MCP add/remove live-updates engine without restart
- [ ] Approval modal: Allow/Deny/Allow-always all functional
- [ ] Auto-updater installs a test release
- [ ] Sentry receives a forced crash
- [ ] Linux + Windows builds pass smoke tests
- [ ] First-run wizard completes end-to-end
- [ ] Long session (1000+ events) scrolls smoothly

## Risks + mitigations

- **Windows code-signing cost + hassle** → start with SmartScreen warning; plan EV cert post-launch.
- **Auto-update rollback** → maintain previous-version channel; document manual rollback.
- **Sentry privacy concerns** → opt-in, redact paths + prompts.

## Dependencies to install

```
@monaco-editor/react@^4
diff2html@^3
react-virtuoso@^4
@sentry/tauri@^latest
i18next@^23 react-i18next@^15
```

## Files touched

- `desktop/src/screens/{SkillEditor,AgentEditor,McpList,Settings,Onboarding}.tsx`
- `desktop/src/components/ApprovalModal.tsx`
- `desktop/src/components/Timeline.tsx` (virtualize)
- `desktop/src-tauri/src/updater.rs`
- `.github/workflows/desktop-build.yml` (matrix expand)
