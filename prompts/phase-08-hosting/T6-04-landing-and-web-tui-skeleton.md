# Phase 08 Hosting — Prompt T6-04: Landing page + web-TUI skeleton

**When to run:** After T6-01 (Dockerfile + fly.toml) and T6-02 (Browserbase wiring). T5 prompts (HTTP MCP transport, auth seam, bun-sqlite) must be landed. This tier adds a public face — a static landing page plus a `/tui` route fronted by ttyd — so alpha users have something to click on.
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Agent 3 (TUI distribution) recommends shipping three things for alpha: npm, a single binary + curl installer, and a web-TUI at `https://jellyclaw.dev/tui`. The web-TUI is the marketing conversion surface — "click a link, sign in, try it" — and it's dead simple to stand up because `jellyclaw tui` already works as a real terminal app. [ttyd](https://github.com/tsl0922/ttyd) wraps any TTY program into a WebSocket → xterm.js browser session; we point it at `jellyclaw tui` and we're done.

Per Agent 3's § "Ship-this-for-v1-launch", this is **Tertiary** (Week 2+), but the SKELETON — a static landing page, the ttyd container layer, and the reverse-proxy routes — is a one-session job that unblocks marketing. The first demo video embed can come later; what matters now is that `https://<app>.fly.dev/` returns something George is willing to link to.

**Do NOT build the Tauri desktop shell.** Agent 3 explicitly killed it for v1 (`desktop/` stays stubbed). If you see tempting structure there, leave it alone.

## Research task

1. Read `docs/hosting/03-tui-distribution.md` — focus on §"Ship-this-for-v1-launch" and any §"Web-TUI" section. Agent 3 names ttyd + xterm.js as the stack.
2. Read `docs/hosting/01-fly-deployment.md` — Dockerfile + fly.toml from T6-01 is the base we're extending. Our new image must still expose port 8080 for jellyclaw-serve AND port 80 for the reverse-proxied external surface.
3. Read `docs/hosting/05-productization.md` if it mentions landing-page copy — use Agent 5's pitch verbatim if available; otherwise pull 2–3 sentences of copy from `README.md` or `engine/SPEC.md` § Goals.
4. `ls /Users/gtrush/Downloads/jellyclaw-engine/site/` — confirm it exists. Per earlier investigation it's mostly empty (`css/`, `images/`, `js/` subdirs are empty stubs). You are filling it.
5. Check `engine/src/cli/tui.ts` exists and `jellyclaw tui` runs. Confirm it's a standard TTY app (reads stdin, writes stdout). If it's not TTY-friendly (e.g. requires a real terminal attached), STOP and `FAIL: T6-04 jellyclaw tui not ttyd-compatible — <diagnosis>`.
6. WebFetch `https://github.com/tsl0922/ttyd/releases` — find the latest stable release. Agent 4 used `7.7.x` family in their investigations; verify there's no newer LTS-tagged release.
7. Decide reverse proxy: **Caddy** or **Nginx**. Pick Caddy — simpler config, built-in automatic HTTPS (though Fly terminates TLS at the edge so we don't need that), much shorter Caddyfile than an nginx.conf. One file, readable by a non-SRE.
8. Read `engine/src/server/auth.ts` (touched by T5-03) to understand how the bearer-token auth seam works — we need to gate `/tui/*` with the same seam, not a fresh auth impl.

## Implementation task

### Files to create / modify

- **Create** `site/index.html` — hand-written HTML/CSS (no framework, no JS dependencies). Three sections:
  1. **Hero**: `<h1>jellyclaw</h1>`, one-line pitch (pull from `engine/SPEC.md` § 2 Goals: "drop-in replacement for Claude Code, embeddable, Anthropic-direct with aggressive caching, OpenCode execution substrate"), CTA button linking to `/tui`.
  2. **Features**: three cards — Bash (filesystem + shell via tools), Browser (Browserbase hosted MCP — link to docs), Web-search (webfetch tool). Each card is 2 sentences.
  3. **CTA footer**: `<a href="/tui">Try it in your browser →</a>` + small print "alpha — bring your own Anthropic key (BYOK) for the unmetered path".
  Inline `<style>` block, no external CSS. Page weight < 30 KB total. Use system font stack (no Google Fonts — CSP + speed).
  Include a placeholder `<video>` or `<div class="demo-placeholder">` in the hero; if a static `.mp4` of the Bentley demo exists anywhere (`grep -r "bentley" docs/ || find . -name "*.mp4"`), link it; otherwise leave the placeholder with a `TODO: embed demo video`.

- **Create** `site/css/style.css` — optional split if the `<style>` block gets > 100 lines. Otherwise keep inline.

- **Create** `web-tui/Dockerfile.ttyd` — a stage that installs ttyd and wraps `jellyclaw tui`. Reference design:
  ```dockerfile
  FROM debian:12-slim AS ttyd-stage
  ARG TTYD_VERSION=1.7.7
  RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64" -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && rm -rf /var/lib/apt/lists/*
  ```
  Note: ttyd binary is a single static executable for x86_64; if Fly hardware is arm64 swap for `ttyd.aarch64`. Fly `shared-cpu-2x` is x86_64 per Agent 1 — use `ttyd.x86_64`.

- **Modify** the T6-01 `Dockerfile` — add two new stages BEFORE the final runner:
  1. `ttyd-stage` (from above): gets the ttyd binary.
  2. In the final runner stage, `COPY --from=ttyd-stage /usr/local/bin/ttyd /usr/local/bin/ttyd`.
  3. Install Caddy in the runner: `RUN apt-get update && apt-get install -y --no-install-recommends caddy && rm -rf /var/lib/apt/lists/*` (Playwright base image already has apt, so this is ~20 MB added).
  4. Copy in `Caddyfile` and `site/` tree.
  5. Change the runner `CMD` from "just run jellyclaw-serve" to a small supervisor that launches all three (jellyclaw-serve on 8080, ttyd on 7681, Caddy on 80). Use `tini` as PID 1 with a tiny inline supervisor script `scripts/container-entrypoint.sh`.

- **Create** `Caddyfile` at repo root:
  ```caddy
  {
    # Fly terminates TLS at the edge; we speak plain HTTP internally.
    auto_https off
    admin off
  }

  :80 {
    # /v1/* → jellyclaw-serve
    handle /v1/* {
      reverse_proxy 127.0.0.1:8080
    }

    # /tui/* → ttyd (bearer-token gated — see tui-auth snippet below)
    handle /tui* {
      # Require a Bearer token matching JELLYCLAW_TOKEN.
      # Caddy's basicauth is too weak; we use @requires_token matcher + respond.
      @has_token header Authorization "Bearer {$JELLYCLAW_TOKEN}"
      handle @has_token {
        reverse_proxy 127.0.0.1:7681
      }
      handle {
        respond "401 — Authorization: Bearer <token> required. See /v1/health for health." 401
      }
    }

    # Everything else → static site
    handle {
      root * /srv/site
      file_server
      try_files {path} /index.html
    }
  }
  ```
  Note: Caddy does not support `{$ENV}` interpolation in matchers directly for header values in all versions — if this variant doesn't work, fall back to `header_regexp Authorization "^Bearer (TOKEN_VALUE)$"` with TOKEN_VALUE substituted at container-start time via the entrypoint script.

- **Create** `scripts/container-entrypoint.sh`:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail

  : "${JELLYCLAW_TOKEN:?JELLYCLAW_TOKEN must be set}"
  : "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"

  # Substitute JELLYCLAW_TOKEN into the Caddyfile at boot.
  envsubst < /etc/caddy/Caddyfile.template > /etc/caddy/Caddyfile

  # Supervisor: start three children, forward signals, die if any exits.
  node /app/engine/dist/cli/main.js serve \
    --host 127.0.0.1 --port 8080 \
    --i-know-what-im-doing \
    --auth-token "$JELLYCLAW_TOKEN" &
  SERVE_PID=$!

  # ttyd binds loopback; Caddy gates external access.
  ttyd --port 7681 --interface 127.0.0.1 \
    --writable \
    --once=false \
    node /app/engine/dist/cli/main.js tui &
  TTYD_PID=$!

  caddy run --config /etc/caddy/Caddyfile &
  CADDY_PID=$!

  # Wait on any child; exit if one dies so Fly restarts the Machine.
  wait -n "$SERVE_PID" "$TTYD_PID" "$CADDY_PID"
  EXIT=$?
  kill "$SERVE_PID" "$TTYD_PID" "$CADDY_PID" 2>/dev/null || true
  exit "$EXIT"
  ```
  `chmod +x` after creation. Note jellyclaw-serve now binds 127.0.0.1 instead of 0.0.0.0 — Caddy is the only external surface. Agent 1's `--i-know-what-im-doing` gate still requires the flag because we're not on loopback in the "no reverse proxy" sense, but security-wise Caddy is the boundary.

- **Modify** `fly.toml` (light touch): `internal_port` changes from 8080 → 80 because Caddy is now the edge. Everything else stays.

- **Move** the `site/index.html` into the image at `/srv/site/index.html` and the `Caddyfile.template` (not `Caddyfile` directly — the entrypoint substitutes) into `/etc/caddy/Caddyfile.template`. Add these `COPY` directives to the Dockerfile.

### Files NOT to touch

- `desktop/` — Agent 3 is killing it. Leave the stub.
- `engine/src/cli/tui.ts` — ttyd wraps it as-is.
- The Browserbase stanza from T6-02 — irrelevant to this tier.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Build the new multi-stage image
docker build -t jellyclaw:web .
docker images jellyclaw:web --format "{{.Size}}"   # expect ≤ 1.9 GB (Playwright + Caddy + ttyd)

# Smoke: run the container on :80 locally with a known token
CID=$(docker run -d --rm \
  -e ANTHROPIC_API_KEY="sk-ant-smoke-placeholder" \
  -e JELLYCLAW_TOKEN="smoke-token-abc" \
  -p 8080:80 jellyclaw:web)   # map host 8080 → container 80 to avoid needing sudo
sleep 6

# Landing page
curl --fail --silent http://127.0.0.1:8080/ | head -40 | grep -q "jellyclaw" || {
  echo "landing page failed"; docker logs "$CID"; docker stop "$CID"; exit 1; }

# jellyclaw-serve route (auth required — should 401 without Bearer)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/v1/health   # expect 200 (mounted before auth)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/v1/sessions # expect 401

# TUI gate — must 401 without token, 200 with
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/tui/   # expect 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer smoke-token-abc" http://127.0.0.1:8080/tui/   # expect 200

docker stop "$CID"
```

### Acceptance criteria

1. `site/index.html` exists, is self-contained (no external JS/CSS/fonts), renders 3 sections (hero / features / CTA), and links `/tui` from the CTA. File size < 30 KB.
2. `Caddyfile` (or `Caddyfile.template` + entrypoint substitution) correctly routes:
   - `/` → static site
   - `/v1/*` → jellyclaw-serve on 127.0.0.1:8080
   - `/tui/*` → ttyd on 127.0.0.1:7681, gated by `Authorization: Bearer $JELLYCLAW_TOKEN`
3. The updated `Dockerfile` builds a single image with Playwright + Node + jellyclaw + ttyd + Caddy, final size ≤ 1.9 GB.
4. `scripts/container-entrypoint.sh` starts three children under tini, exits if any die, forwards signals.
5. `fly.toml` `internal_port = 80` (Caddy is the edge).
6. Smoke test in the shell block above passes: landing 200, `/v1/health` 200 no-auth, `/v1/sessions` 401 no-auth, `/tui/` 401 no-auth, `/tui/` 200 with correct Bearer.
7. `jellyclaw tui` still works standalone from the CLI (ttyd wrapping doesn't regress it).

### Tests to add

- `test/integration/web-tui-smoke.test.ts` — env-gated `JELLYCLAW_WEB_TUI_TEST=1`:
  - docker build the image
  - run + curl the four routes above
  - assert the expected status codes
  Treat this as skipped-by-default in CI; George runs it manually before cutting a deploy.

### Common pitfalls

- **ttyd binds a TTY — it needs `--writable` and a command that doesn't immediately exit.** If `jellyclaw tui` reads stdin via the raw-mode API, confirm that ttyd's PTY handling is compatible. A quick test: `ttyd --writable --once=false bash` should give you a working shell in a browser tab before you swap `bash` for `jellyclaw tui`.
- **Do not expose ttyd on a public port.** ttyd ships auth options but its HTTP gating is weak. Bind loopback (`--interface 127.0.0.1`) and gate externally via Caddy.
- **Caddy `{$ENV}` interpolation quirks.** Depending on Caddy version, in-Caddyfile env substitution works for some directives and not others. The safe pattern is to `envsubst` the Caddyfile at container start (shown in `container-entrypoint.sh`). Do NOT commit a Caddyfile with the raw token baked in.
- **The token-matcher in Caddy should check for `Bearer <full-token>` exactly.** A common bug: matching just the token body lets an attacker send `Authorization: <token>` (no `Bearer `) and bypass the check. Test both forms.
- **Do not regress `/v1/health`'s no-auth mount.** It must stay before the auth middleware inside jellyclaw-serve, AND Caddy must not require a token for it. Easiest: put the `/v1/health` matcher BEFORE the generic `/v1/*` matcher in the Caddyfile, with no auth gate.
- **Static site `try_files` order.** Caddy's `try_files {path} /index.html` emulates SPA-style fallback. For this minimal landing that's overkill — just `file_server` is enough. But leaving `try_files` doesn't break anything.
- **Image size budget.** Playwright base is ~1.5 GB, jellyclaw layer ~300 MB (T6-01), ttyd ~2 MB, Caddy ~40 MB, site ~30 KB. Total ~1.85 GB. If you go over 2 GB, investigate — something is copying too much.
- **The `handle` block order in Caddy matters** — first match wins within a route. `/v1/*` must come before the generic `handle { … }` catch-all.
- **`desktop/` temptation** — do not rebuild the Tauri shell. Agent 3 explicitly kills it.
- **Do not ship a demo video the user hasn't given you.** The `<video>` slot must be a clearly-labeled placeholder unless you found an `.mp4` in the repo via `find`.

## Verification checklist

- [ ] `docker build -t jellyclaw:web .` succeeds.
- [ ] All four smoke routes return the expected status codes.
- [ ] `site/index.html` renders cleanly in a browser (open the file directly to eyeball it).
- [ ] Token substitution in Caddyfile is via `envsubst`, not hardcoded.
- [ ] Image size ≤ 1.9 GB.
- [ ] `bun run test && bun run typecheck` still pass (no engine regressions).
- [ ] `fly.toml` `internal_port` updated to `80`.
- [ ] No changes to `desktop/`.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T6-04 ✅` with final image size + the four smoke-route status codes.
2. Print `DONE: T6-04` on success, `FAIL: T6-04 <reason>` on fatal failure.
