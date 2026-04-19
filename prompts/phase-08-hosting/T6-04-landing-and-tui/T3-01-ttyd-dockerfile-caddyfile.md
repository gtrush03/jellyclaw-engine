---
id: T3-01-ttyd-dockerfile-caddyfile
tier: 3
title: "ttyd Dockerfile stage + Caddyfile + modify T6-01 Dockerfile"
scope:
  - Dockerfile
  - Caddyfile
  - web-tui/Dockerfile.ttyd
  - web-tui/ttyd-args.sh
  - .dockerignore
depends_on_fix:
  - T2-03-landing-a11y-lighthouse-csp
tests:
  - name: dockerfile-lint
    kind: shell
    description: "hadolint passes (or warnings only) on Dockerfile"
    command: "bunx --bun hadolint Dockerfile || npx -y hadolint Dockerfile || docker run --rm -i hadolint/hadolint < Dockerfile"
    expect_exit: 0
    timeout_sec: 60
  - name: caddyfile-valid
    kind: shell
    description: "caddy validates the Caddyfile syntax"
    command: "docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile"
    expect_exit: 0
    timeout_sec: 60
  - name: dockerfile-grep-stages
    kind: shell
    description: "Dockerfile has ttyd-stage and installs caddy"
    command: |
      set -e
      grep -q "AS ttyd-stage" Dockerfile
      grep -q "COPY --from=ttyd-stage" Dockerfile
      grep -qE "(caddy|^ARG CADDY)" Dockerfile
    expect_exit: 0
    timeout_sec: 5
human_gate: false
max_turns: 40
max_cost_usd: 12
max_retries: 3
estimated_duration_min: 35
---

# T3-01 — ttyd Dockerfile + Caddyfile

## Context
The landing page is production-ready. The web TUI is the other half of
`https://jellyclaw.dev`: a ttyd-wrapped `jellyclaw tui` served behind Caddy.
The existing Dockerfile from T6-01 serves jellyclaw-serve on 8080. We need
to extend it — same image, three processes.

## Architecture
```
┌────────── single container (from T6-01 Dockerfile) ──────────┐
│                                                               │
│  Caddy :80   ←── reverse proxy, TLS at Fly edge               │
│    ├── /            → site/ (static landing)                  │
│    ├── /v1/*        → 127.0.0.1:8080 (jellyclaw-serve)        │
│    └── /tui/*       → 127.0.0.1:7681 (ttyd → jellyclaw tui)   │
│                                                               │
│  ttyd :7681  ←── one-time-password auth (T3-02 adds full auth)│
│  jellyclaw-serve :8080  (unchanged from T6-01)                │
└───────────────────────────────────────────────────────────────┘
```

## Work

### 1. `web-tui/Dockerfile.ttyd` (new file)
Stage that fetches the ttyd binary:
```dockerfile
# syntax=docker/dockerfile:1.7
FROM debian:12-slim AS ttyd-stage
ARG TTYD_VERSION=1.7.7
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) asset=ttyd.x86_64 ;; \
      arm64) asset=ttyd.aarch64 ;; \
      *) echo "unsupported arch: $TARGETARCH"; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}" \
         -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd
```
Confirm ttyd 1.7.7 exists (WebFetch
https://api.github.com/repos/tsl0922/ttyd/releases/latest if doubt).

### 2. Modify root `Dockerfile` (from T6-01)
Add:
1. A `FROM ... AS ttyd-stage` stage at the top (or include `web-tui/Dockerfile.ttyd`
   via a `# syntax=docker/dockerfile:1.7`-enabled `COPY --link` trick). Simplest:
   copy the ttyd-stage block inline into the root Dockerfile.
2. In the final runner stage:
   ```dockerfile
   COPY --from=ttyd-stage /usr/local/bin/ttyd /usr/local/bin/ttyd
   RUN apt-get update && apt-get install -y --no-install-recommends caddy tini \
       && rm -rf /var/lib/apt/lists/*
   COPY Caddyfile /etc/caddy/Caddyfile
   COPY site /srv/site
   COPY web-tui/ttyd-args.sh /usr/local/bin/ttyd-args.sh
   RUN chmod +x /usr/local/bin/ttyd-args.sh
   EXPOSE 80
   # Supervisor comes in T3-02 — for this prompt, keep the existing CMD but add a
   # TODO comment marking where the supervisor will replace it.
   ```

### 3. `Caddyfile` (new, repo root)
```caddy
{
    admin off
    auto_https off
    # Fly terminates TLS at the edge; we only serve HTTP inside the container.
}

:80 {
    encode zstd gzip

    # Static landing page
    @static {
        not path /v1/* /tui /tui/*
    }
    handle @static {
        root * /srv/site
        try_files {path} /index.html
        file_server
        header {
            X-Content-Type-Options nosniff
            X-Frame-Options DENY
            Referrer-Policy strict-origin-when-cross-origin
            Permissions-Policy "accelerometer=(), camera=(), geolocation=(), microphone=()"
        }
    }

    # jellyclaw-serve API
    handle /v1/* {
        reverse_proxy 127.0.0.1:8080
    }

    # Web TUI (ttyd)
    handle /tui* {
        reverse_proxy 127.0.0.1:7681
    }

    log {
        output stderr
        format console
        level INFO
    }
}
```

### 4. `web-tui/ttyd-args.sh` (invoked by supervisor in T3-02)
```bash
#!/usr/bin/env bash
# ttyd wrapper — configures flags for jellyclaw tui.
# Auth gate is added by T3-02 (credential flag or OTP handoff).
set -euo pipefail
exec /usr/local/bin/ttyd \
  --port 7681 \
  --interface 127.0.0.1 \
  --base-path /tui \
  --writable \
  --check-origin \
  --max-clients 10 \
  --terminal-type xterm-256color \
  --title-format "jellyclaw" \
  /usr/local/bin/jellyclaw tui
```
chmod +x.

### 5. `.dockerignore`
Add any new dirs not already ignored:
```
tmp/
.autobuild-simple/
prompts/
```
Ensure `site/` and `web-tui/` are NOT ignored (they need to be copied in).

## Acceptance criteria
- `docker build -f Dockerfile .` succeeds end-to-end (or, if no docker
  daemon available, `docker buildx build --progress=plain .` parses and
  plans without build errors for all stages).
- `caddy validate` passes.
- `hadolint Dockerfile` passes (warnings allowed, errors not).
- No change to jellyclaw-serve behavior.

## Out of scope
- Supervisor + entrypoint — T3-02.
- Auth gate for /tui — T3-02.
- E2E Playwright — T3-03.

## Verification the worker should self-run before finishing
```bash
hadolint Dockerfile || true
docker run --rm -v $(pwd)/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
test -x web-tui/ttyd-args.sh
echo "DONE: T3-01-ttyd-dockerfile-caddyfile"
```
