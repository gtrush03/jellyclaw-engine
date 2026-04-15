# Warp Quick Links — Jellyclaw Engine

**Bookmark this file.** Every clickable path into the project.

## Start here (read in order)

- [MASTER-PLAN.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md) — the load-bearing doc
- [COMPLETION-LOG.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md) — live checklist with ✅ progress
- [STATUS.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md) — daily status
- [ROADMAP.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/ROADMAP.md) — Q2 2026 → 2027+

## Prompt system

- [prompts/README.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/README.md) — how the prompt system works
- [prompts/DEPENDENCY-GRAPH.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/DEPENDENCY-GRAPH.md) — which prompts block which
- [STARTUP-TEMPLATE.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md)
- [COMPLETION-UPDATE-TEMPLATE.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md)

## Phase entry points (open the first prompt of each phase)

| Phase | Name | First prompt |
|---|---|---|
| 00 | Scaffolding | [verify-scaffolding](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-00/01-verify-scaffolding.md) |
| 01 | OpenCode pinning | [research](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-01/01-research.md) |
| 02 | Config + provider | [research](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-02/01-research.md) |
| 03 | Event stream adapter | [research-and-types](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-03/01-research-and-types.md) |
| 04 | Tool parity | [bash-read-write](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-04/01-bash-read-write.md) |
| 05 | Skills | [discovery-and-loader](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-05/01-discovery-and-loader.md) |
| 06 | Subagents + hook patch | [subagent-definitions](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-06/01-subagent-definitions.md) |
| 07 | MCP client | [mcp-client-stdio](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-07/01-mcp-client-stdio.md) |
| 08 | Permission + hooks | [permission-modes](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-08/01-permission-modes.md) |
| 09 | Session persistence | [sqlite-schema](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-09/01-sqlite-schema-and-storage.md) |
| 10 | CLI + HTTP + library | [cli-entry-point](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-10/01-cli-entry-point.md) |
| 11 | Testing harness | [vitest-setup](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-11/01-vitest-setup-and-unit-tests.md) |
| 12 | Genie integration | [dispatcher-refactor](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-12/01-dispatcher-refactor.md) |
| 13 | Make jellyclaw default | [default-flip-and-shadow](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-13/01-default-flip-and-shadow.md) |
| 14 | Observability | [jsonl-trace-upgrade](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-14/01-jsonl-trace-upgrade.md) |
| 15 | Desktop MVP | [tauri-2-scaffolding](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/01-tauri-2-scaffolding.md) |
| 16 | Desktop polish | [skill-and-agent-editors](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-16/01-skill-and-agent-editors.md) |
| 17 | jelly-claw app | [reconcile-two-engines](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-17/01-reconcile-two-engines.md) |
| 18 | Open-source release | [docs-site-and-landing](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-18/01-docs-site-and-landing.md) |
| 19 | Post-launch | [weekly-upstream-rebase](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-19/01-weekly-upstream-rebase.md) |

## Specs & design

- [engine/SPEC.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md) — 21-section engine spec
- [engine/SECURITY.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md)
- [engine/CVE-MITIGATION.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/engine/CVE-MITIGATION.md)
- [engine/PROVIDER-STRATEGY.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/engine/PROVIDER-STRATEGY.md)
- [desktop/SPEC.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md)
- [docs/ARCHITECTURE.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/docs/ARCHITECTURE.md)

## Integration docs

- [integration/GENIE-INTEGRATION.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/integration/GENIE-INTEGRATION.md)
- [integration/JELLY-CLAW-APP-INTEGRATION.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/integration/JELLY-CLAW-APP-INTEGRATION.md)
- [integration/AUDIT.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/integration/AUDIT.md)
- [integration/BRIDGE-DESIGN.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/integration/BRIDGE-DESIGN.md)

## Patches

- [patches/README.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/patches/README.md)
- [001-subagent-hook-fire.patch](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/patches/001-subagent-hook-fire.patch) — fixes OpenCode #5894
- [002-bind-localhost-only.patch](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/patches/002-bind-localhost-only.patch) — CVE-22812 mitigation
- [003-secret-scrub-tool-results.patch](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/patches/003-secret-scrub-tool-results.patch)

## Testing

- [test/TESTING.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/test/TESTING.md)
- [test/canonical-wishes.json](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/test/canonical-wishes.json)

## Scripts

- [scripts/setup.sh](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/scripts/setup.sh)
- [scripts/day-1.md](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/scripts/day-1.md)
- [scripts/migrate-from-claurst.sh](warp://action/open_file?path=/Users/gtrush/Downloads/jellyclaw-engine/scripts/migrate-from-claurst.sh)

## Open whole repo

- [Open jellyclaw-engine in Warp](warp://action/open_path?path=/Users/gtrush/Downloads/jellyclaw-engine)
