# Changelog

All notable changes to jellyclaw will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial scaffolding and phase plans (Phase 0).
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
