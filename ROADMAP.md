# Jellyclaw — Roadmap

> The post-v1.0 arc. What jellyclaw wants to be once the engine works.
> Read `MASTER-PLAN.md` first — that covers Phases 0–19, which get us to
> v1.0. This file picks up after that.

---

## Q2 2026 — jellyclaw 1.0

**Ship window:** late June / early July 2026.
**Milestones covered:** M1 (engine works) → M2 (Genie on jellyclaw) →
M3 (desktop ships).

**What ships.**
- Engine library and CLI on npm: `jellyclaw`, `@jellyclaw/core`.
- Homebrew tap: `brew install jellyclaw`.
- Tauri 2 desktop app: signed, notarized, auto-updating.
- Genie runs on jellyclaw by default. `GENIE_ENGINE=claurst` remains as
  a fallback flag for one more quarter, then is removed in 1.1.
- Anthropic direct provider is the documented default. OpenRouter works
  but prints a WARN on startup referencing the cache-miss bug.
- Stream-json byte-parity with Claude Code on the 5 golden prompts.
- 14 built-in tools at schema parity. Skills and subagents at behavior
  parity.
- MCP client with Playwright MCP `0.0.41` as the blessed example.

**What is intentionally not in 1.0.**
- Public GitHub release (held for Q4).
- Voice triggers in jelly-claw (Q3).
- Third-party skills registry (Q4).
- Mobile app.
- Plugin marketplace.

**1.0 success criteria.** George's production Genie workload has been
running on jellyclaw for ≥30 days with Claurst archived. Zero P0
regressions in that window. Desktop app has ≥10 non-George users.

---

## Q3 2026 — jellyclaw 1.5

**Ship window:** September 2026.
**Milestone covered:** M4 (jelly-claw AI).

**What ships.**
- **jelly-claw video-call integration.** The macOS Tauri app embeds
  jellyclaw as a sidecar. During a call, the user or a remote party can
  say `"Jelly, …"` and a jellyclaw agent fires against the live
  transcript.
- **Voice-trigger primitive.** Generic wake-word / push-to-talk surface
  so any embedding app (not just jelly-claw) can wire voice input to
  jellyclaw.
- **Overlay SDK.** React component library for rendering streaming
  agent output over a WebRTC video surface. Used by jelly-claw, released
  as `@jellyclaw/overlay` for third parties.
- **Transcript tool.** Built-in tool that reads from a diarized WebRTC
  transcript stream so agents can ground on "what was just said."
- **Session handoff.** Start a session on desktop, continue it in-call,
  finish it on desktop. Session IDs stable across surfaces.
- **Observability v2.** OTLP export into Honeycomb (or Grafana Cloud,
  pending Q2 decision). Per-call, per-agent traces.

**1.5 success criteria.** One real 2-party video call where a voice
trigger fires an agent that actually saves the user time (calendar
creation, follow-up draft, meeting notes). Latency: first token ≤ 3 s
from end of user utterance. Overlay renders ≤ 1 s after first token.

**Known risks.**
- WebRTC + LLM streaming both want the user's attention budget. Overlay
  design must not block the call.
- Transcript quality varies; agents need to tolerate noisy input.
- ASR costs. Budget needs a Q3 review.

---

## Q4 2026 — jellyclaw 2.0

**Ship window:** December 2026.
**Milestone covered:** M5 (public) — delayed from Phase 18 so we can ship
1.5 first and have a real story.

**What ships.**
- **Public GitHub repository.** Apache-2.0 (pending Q1 decision).
- **Landing page** at `jellyclaw.dev` with quickstart, conceptual docs,
  and a 2-minute video of the jelly-claw voice demo.
- **Community skills registry.** A searchable index of
  `.claude/skills/` -compatible packages. Hosted, not decentralized.
  Goal at launch: 50 skills, 20 of them non-George.
- **Plugin marketplace (alpha).** Tauri desktop app gains a plugins
  surface. Plugins are signed, sandboxed MCP servers. Initial set:
  Linear, Notion, Slack, GitHub, Calendar, Gmail.
- **Discord.** Target 200 builders by end of year.
- **Docs site.** Concept docs, reference docs, cookbook, migration
  guides (Claude Code → jellyclaw, Claurst → jellyclaw, OpenCode →
  jellyclaw).
- **First external release manager.** A non-George human who can cut a
  release. Probably part-time contract.

**2.0 success criteria.**
- ≥1 external contributor with a landed non-trivial PR.
- ≥1 blog post about jellyclaw that George did not ghostwrite.
- ≥5 skills in the registry authored by non-George humans.
- npm downloads ≥ 1,000 / week.
- Brew install reports ≥ 200 / month.

---

## 2027 and beyond

Speculative but directionally committed.

**Q1 2027 — Extensions.**
- **ACP client.** Integrate as a client of Anthropic's Agent
  Communication Protocol (or the de-facto successor that emerges). Let
  jellyclaw agents call and be called by other agent runtimes over a
  standard wire format.
- **Provider matrix.** Ollama local, Groq, Google Vertex, Bedrock. Each
  with a nightly test lane.
- **Prompt-cache dashboard.** Per-session cache-hit visualization in the
  desktop app so users can see where their money goes.

**Q2 2027 — Mobile.**
- **iOS app.** Read-only at first: browse sessions from desktop, approve
  pending permissions, view streaming output. Writing full prompts from
  mobile is explicitly a non-goal for v1 of mobile.
- **Android.** Follows iOS by a quarter.

**Q3 2027 — Enterprise.**
- **Team workspaces.** Shared skills, shared session history, SSO.
- **Audit log export.** SOC2-grade event trail. Hooks for SIEM ingest.
- **Self-hosted.** Docker Compose + Helm chart for the server
  component. No phone-home.
- **BYOK + BYO model.** Customers bring Anthropic keys or their own
  self-hosted endpoints; jellyclaw is the orchestration layer.
- **Commercial license / support tier.** Pricing TBD. Open-source core
  remains Apache-2.0.

**Q4 2027 — The long bet.**
- **jellyclaw as the default way people build Claude Code-compatible
  agents.** Not "an alternative to Claude Code" — the reference
  open-source implementation, with Anthropic's Claude Code as the
  commercial first-party.
- **Agents that outlive their sessions.** Persistent agents with
  scheduled triggers, webhooks, long-running memory. Today's "wish" is
  one-shot; 2028's agent is always-on.

---

## What we are not building

Explicit non-goals. Revisit annually.

- **Our own model.** Jellyclaw is an engine, not a model.
- **Our own tool runtime in a new language.** We thin-wrap OpenCode. If
  OpenCode dies, we re-evaluate — we do not rewrite preemptively.
- **A chat UI.** Desktop app shows agent output; it is not a chat
  product. ChatGPT, Claude.ai, and jelly-claw (for voice) fill that
  space.
- **A model router / inference product.** OpenRouter and others do
  this. Jellyclaw uses them.
- **VS Code extension.** Claude Code already does this well. If we ship
  editor integration it is via LSP or ACP, not a bespoke extension.

---

## How this roadmap changes

- Reviewed at the end of each quarter.
- Blockers that push items out by >30 days get called out in
  `STATUS.md`.
- New items enter only if they are forced by a downstream dependency or
  by customer pull that has been seen twice from different directions.
- Anything not on this roadmap that George wants to build should first
  become an issue on GitHub (once public) or a line in a dated note
  under `docs/ideas/` (pre-public). Ideas do not become roadmap items
  until they survive a quarter.
