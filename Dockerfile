# syntax=docker/dockerfile:1.7
#
# Root Dockerfile — produces the single image that runs on Fly.io.
# Three long-running processes share the container (supervisor wired in T3-02):
#   1. Caddy          :80    (reverse proxy + static file server for site/)
#   2. jellyclaw-serve :8080 (the engine HTTP API, unchanged from T6-01)
#   3. ttyd           :7681  (wraps `jellyclaw tui` for the web terminal)

# ---------- Stage 0 — ttyd-stage ----------
# Pulls the prebuilt ttyd binary for the target architecture.
# Mirrors web-tui/Dockerfile.ttyd verbatim — kept inline to keep the
# root build a single `docker build -f Dockerfile .` invocation.
FROM debian:12-slim AS ttyd-stage

ARG TTYD_VERSION=1.7.7
ARG TARGETARCH

# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) asset=ttyd.x86_64 ;; \
      arm64) asset=ttyd.aarch64 ;; \
      "") asset=ttyd.x86_64 ;; \
      *) echo "unsupported arch: $TARGETARCH"; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/${asset}" \
         -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# ---------- Stage 1 — builder ----------
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS builder

ENV NODE_ENV=production

# Install build tools for native modules (better-sqlite3).
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/engine

# Copy package files and install production deps
COPY engine/package.json engine/package-lock.json ./
RUN npm ci --no-audit --no-fund --prefer-offline --omit=dev

# Copy pre-built dist from local build (run `bun run build` before docker build)
COPY engine/dist ./dist
COPY engine/bin  ./bin

# ---------- Stage 2 — runner ----------
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS runner

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=8080 \
    JELLYCLAW_HOME=/data/jellyclaw

# Install tini (PID 1) and Caddy (reverse proxy).
# Caddy comes from the official Cloudsmith repo — Ubuntu Jammy's package
# universe does not ship caddy by default.
# hadolint ignore=DL3008,DL4006
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/*

# ttyd binary — produced by Stage 0 above.
COPY --from=ttyd-stage /usr/local/bin/ttyd /usr/local/bin/ttyd

# Non-root user. Playwright image ships with pwuser (uid 1000).
RUN mkdir -p /data/jellyclaw /srv/site \
    && chown -R pwuser:pwuser /data /srv/site

WORKDIR /app/engine

# Copy built artifacts + production node_modules from the builder
COPY --from=builder --chown=pwuser:pwuser /app/engine/dist         ./dist
COPY --from=builder --chown=pwuser:pwuser /app/engine/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /app/engine/package.json ./package.json
COPY --from=builder --chown=pwuser:pwuser /app/engine/bin          ./bin

# Caddy config + static landing page + ttyd wrapper + supervisor.
COPY Caddyfile /etc/caddy/Caddyfile
COPY site /srv/site
COPY web-tui/ttyd-args.sh /usr/local/bin/ttyd-args.sh
COPY scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint.sh
RUN chmod +x /usr/local/bin/ttyd-args.sh /usr/local/bin/container-entrypoint.sh

# Install bun for the TUI shim (engine/bin/jellyclaw uses bun to load vendored TSX).
# Symlink into /usr/local/bin so pwuser (non-root) can invoke it on PATH.
# hadolint ignore=DL4006
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
    && chmod 755 /root/.bun/bin/bun \
    && chmod -R a+rX /root/.bun \
    && /usr/local/bin/bun --version

# Symlink the CLI entrypoint so /usr/local/bin/jellyclaw works from anywhere
# (web-tui/ttyd-args.sh execs /usr/local/bin/jellyclaw tui).
RUN ln -sf /app/engine/bin/jellyclaw /usr/local/bin/jellyclaw \
    && chmod +x /app/engine/bin/jellyclaw

USER pwuser

# Caddy binds :80 in-container; Fly maps 443→80 at the edge.
# 8080 (jellyclaw-serve) and 7681 (ttyd) stay internal — not exposed.
EXPOSE 80

# tini is PID 1; it execs the supervisor which in turn forks
# jellyclaw-serve, ttyd, and Caddy. See scripts/container-entrypoint.sh.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/container-entrypoint.sh"]
