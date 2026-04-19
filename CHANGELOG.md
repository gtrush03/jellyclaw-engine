# Changelog

All notable changes to jellyclaw will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (Apr 15–19, 2026)
- feat(prompts): phase 07.5 + phase 08 hosting prompt trees (T3–T7 —
  HTTP/SSE MCP, Exa default web search, multi-tenant auth seam, SQLite
  swap, animation freeze screenshot, Fly.io deploy, Browserbase,
  GitHub Actions, landing page + T6-04 TUI redesign, vision + image-gen +
  frontend-design + design-iterator skills).
- feat(tui): T6-04 brand theme module — new `engine/src/tui/theme/`
  (brand, borders, density, typography, snapshots) with contrast tests;
  `use-history` + `use-slash-completion` hooks. Partial — input-box +
  status-bar still mid-wire from the crashed session.
- feat(deploy): full Fly.io stack — `Dockerfile`, `fly.toml`, `Caddyfile`,
  `web-tui/` (ttyd sidecar for browser-accessible TUI),
  `scripts/container-entrypoint.sh`, `scripts/deploy-fly.sh`,
  `.github/workflows/fly-deploy.yml` + `fly-staging.yml`,
  `docs/hosting/` (01-fly, 02-public-api, 03-tui-distribution,
  04-browser-in-cloud, 05-productization), `docs/deploy-secrets.md`,
  `docs/browserbase-setup.md`, `docs/chrome-setup.md`.
- feat(site): T6-04 landing page — `site/index.html`, css, js, assets
  (demo-frame.png, demo.cast, favicon.svg, hero.jpg, og-image.png,
  wordmark.svg), asciinema-player vendor drop, robots.txt, sitemap.xml,
  lighthouse-report.json, `engine/templates/mcp.default.json`.
- feat(engine): phase 99 unfucking + T6-04 wiring — new CLI modules
  (`chrome-autolaunch`, `mcp-config-loader`, `session-screenshot`,
  `templates`), `engine/src/db/` (sqlite better + bun drivers),
  `engine/src/server/auth/` (bearer, composite, multi-tenant providers,
  principal), `engine/src/server/routes/tui-handoff`, MCP registry
  HTTP/SSE tests, retires `engine/src/tools/websearch.ts` (delegated to
  Exa MCP per phase-08 T5-02).
- feat(dashboard): autobuild-v4 UI polish (ApprovalRow, NowCard,
  DoneFeed, UpNextList, StatusHeader, TierTrack, EscalationRow,
  bucketize, useUiState, useResetAction, ConfirmModal, AutobuildV4
  shell) + rig-control/runs API updates.
- feat(desktop): sidecar + Tauri capabilities refresh —
  `desktop/src-tauri/capabilities/default.json`, regenerated gen/schemas.
- feat(autobuild): dispatcher + jellyclaw-driver + prompt-parser
  updates; simple tmux orchestrator landed 42 prompts (T0–T4) under
  `scripts/autobuild-simple/run.sh`.
- test: phase 99 + T6-04 coverage — Playwright e2e for web-tui +
  landing, new chrome-demo-e2e + chrome-mcp integration tests, smoke
  harness updates, dashboard test refresh.
- chore(gitignore): ignore `.playwright-mcp/`, `engine/test-results/`,
  `test-results/`.
- docs: phase 07.5 chrome-mcp plan, phase 08 web-search + browser MCP
  plan, refreshed `docs/mcp.md`, `docs/playwright-setup.md` (0.0.70
  pin), `docs/tools.md` (11 tools).

### Added
- feat(tui): **JellyJelly brand redesign** — cyan-first deep-sea palette
  replaces generic purple (`#3BA7FF` Jelly Cyan primary, `#9E7BFF`
  Medusa Violet accent, `#FFB547` Amber Eye heartbeat, `#0A1020` Deep
  Ink bg); readable 9-letter JELLYCLAW stencil wordmark (5 rows,
  cyan→violet gradient via existing `textMuted`/`text` theme consumers,
  zero call-site changes); jellyfish spinner recolored with a per-frame
  amber heartbeat at pulse peak. Brand brief at
  `/Users/gtrush/Downloads/jellyclaw-brand-brief.md`. Patch-log entries
  at `patches/005-jellyclaw-wordmark.md` and
  `engine/src/tui/_vendored/_upstream-patches/jellyclaw-theme-brand-rebrand.patch`.
- feat(cli): **in-TUI API key capture + rotation**. First-run
  `jellyclaw tui` drops to a hidden-paste prompt when no
  `ANTHROPIC_API_KEY` is present; persists to
  `~/.jellyclaw/credentials.json` (file `0600`, dir `0700`, atomic
  rename). Subsequent launches read silently. New `jellyclaw key`
  subcommand rotates without exiting. New `engine/src/cli/credentials.ts`,
  `credentials-prompt.ts`, `key-cmd.ts`, `credentials.test.ts`
  (17 tests). Pino redact extended with `anthropicApiKey`,
  `openaiApiKey`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `token`,
  `credentials` (+ nested variants). Inline `/key` inside the
  vendored Solid TUI deferred to Phase 11+.
- feat(tui): phase 10.5 complete — interactive terminal TUI (`jellyclaw tui`)
  vendored from OpenCode, rebranded, bridged to the Phase 10.02 HTTP+SSE
  surface, themed purple, CLI-wrapped, documented, and recognized by the
  dashboard. The repo now honestly reports 21 phases (0–19 + 10.5).
- feat(tui): docs + dashboard phase 10.5 recognition (Phase 10.5 Prompt 04).
  Polished `docs/tui.md` (env-var matrix, CLI flags, running recipes, exit
  codes, vendor upgrade procedure); widened the dashboard phase-parsing
  regexes in `dashboard/server/src/lib/log-parser.ts` (`PHASE_CHECK_RE` +
  `sectionRe` now accept `\d+(?:\.\d+)?`, decimal ids skip zero-padding) and
  `dashboard/src/hooks/useSSE.ts` (`phase-\d{2}(?:\.\d+)?/…`); flipped
  `20 → 21` denominators across dashboard READMEs / smoke / healthcheck /
  integration-checklist / future-polish; bumped `COMPLETION-LOG.md`
  progress `11/20 (55%)` → `12/21 (57%)`; closed Phase 10.5 in STATUS /
  COMPLETION-LOG / MASTER-PLAN / `phases/PHASE-10.5-tui.md`; added a short
  "Interactive TUI" paragraph to top-level `README.md`.
- feat(tui): live render loop + embedded server spawn (Phase 10.5 Prompt 03).
  `engine/src/tui/render-loop.ts` renders streaming tokens, tool-call cards,
  permission prompts, session sidebar, slash-command palette, and diff
  viewer. `engine/src/cli/tui.ts` `launchTui()` picks a random free port on
  `127.0.0.1`, mints a Bearer token, boots the engine HTTP server
  in-process, and spawns the TUI with `JELLYCLAW_SERVER_URL` +
  `JELLYCLAW_SERVER_TOKEN` + `JELLYCLAW_TUI` + `JELLYCLAW_REDUCED_MOTION` +
  `JELLYCLAW_BRAND_GLYPH` + `NO_COLOR` passthrough. SIGINT/SIGTERM forwards
  with a 3 s grace, then SIGKILL; on exit the HTTP server shuts down,
  SQLite WAL flushes, the port releases, and the process exits with the
  TUI's own code (0/1/2/124/130/143). New CLI surface: `jellyclaw tui
  [--cwd] [--session] [--continue] [--model] [--permission-mode
  default|acceptEdits|bypassPermissions|plan] [--theme jellyclaw|opencode]
  [--no-spinner] [--ascii]` + `jellyclaw attach <url> [--token]` + `bun run
  tui:vendored` escape hatch.
- feat(tui): add jellyfish theme + spinner (Phase 10.5 Prompt 02). Ships
  `jellyclaw.json` purple-primary theme (`#B78EFF` / `#D4BFFF` / `#8B5CF6` /
  `#5B4B7A`, terminal-default background), a two-variant jellyfish spinner
  (compact 7-col × 10-frame + hero 3-line × 8-frame, seamless loop, color at
  render time), and a `supports-emoji` util driving the `🪼` → `◉` brand-glyph
  fallback. `DEFAULT_THEME` flips to `"jellyclaw"`; `JELLYCLAW_REDUCED_MOTION`
  is honored alongside `NO_COLOR` / `CLAUDE_CODE_DISABLE_ANIMATIONS` / non-TTY /
  `--ascii` to collapse the spinner to a static frame. Bundled theme count
  33 → 34.
- feat(tui): vendor OpenCode TUI + SDK adapter (Phase 10.5 Prompt 01). OpenCode's
  Solid + OpenTUI TUI subtree lands at `engine/src/tui/_vendored/` pinned to
  upstream SHA `1f279cd2c8719601c72eff071dd69c58cda93219`, with a thin
  SDK-shaped adapter bridging to jellyclaw's Phase 10.02 HTTP + SSE server
  (Bearer auth, dotted ↔ snake_case event translation). New CLI entry points:
  `jellyclaw tui` and `jellyclaw attach <url>`. MIT attribution preserved at
  `engine/src/tui/_vendored/LICENSE.vendored`. See [`docs/tui.md`](docs/tui.md).
- Initial scaffolding and phase plans (Phase 0).

### Fixed
- fix(deps): remove `_vendored` from bun workspaces (fixes 42 GB OOM on install).
  Including the vendored OpenCode monorepo subtree as a workspace root pulled
  its full dep graph into jellyclaw's `bun install`, triggering OOM kills on
  16 GB machines. The vendored tree is now a plain subtree, not a workspace.
- Repo layout: `engine/`, `agents/`, `skills/`, `patches/`, `phases/`, `integration/`,
  `desktop/`, `docs/`, `scripts/`, `test/`.
- TypeScript strict config, Biome lint + format, Vitest suite, tsup bundler.
- Public library API skeleton: `run()`, `createEngine()`, `AgentEvent` discriminated union
  with 15 variants defined in `engine/src/events.ts`.
- Provider skeletons for Anthropic direct (with `cache_control` strategy notes) and
  OpenRouter (with caching-limitation warnings).
- Zod config schema for `jellyclaw.json` in `engine/src/config.ts`.
- CVE-22812 mitigation stack documented in `engine/CVE-MITIGATION.md`.
- Issue #5894 subagent hook patch plan recorded in `patches/` (to land in Phase 2).
- Day-1 bootstrap guide in `scripts/day-1.md`.
- Environment dev-setup helper in `scripts/setup.sh`.

### Planned (Phase 1+)
- Pin OpenCode to a specific commit, vendor patches via `patch-package`.
- Wire the OpenCode HTTP server + SDK for session streaming.
- Implement provider router + Anthropic cache breakpoints.
- Implement MCP client surface.
- Land CVE-22812 defense: path-traversal filter, shell-arg sanitizer, prompt-injection
  heuristics, subagent hook patch.

[Unreleased]: https://github.com/gtrush03/jellyclaw-engine/compare/HEAD
