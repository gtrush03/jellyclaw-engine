# Architecture decisions

Short, dated rationales for the non-obvious choices baked into this dashboard. If you're about to replace one of these pieces, read the corresponding entry first.

## Hono over Express

Hono boots in milliseconds, ships a fraction of Express's dependency surface, and speaks the Web Fetch `Request`/`Response` API natively — which means the same handlers run under Node, Bun, and Cloudflare Workers without rewrites. For a dashboard that may eventually be packaged as a Bun single-file binary, that portability is free insurance. Express's middleware ecosystem is larger, but we need none of it: one static route, a few JSON endpoints, and an SSE stream.

## Vite over Next.js

The dashboard is a pure client-side SPA reading a local JSON/SSE API. There is no SEO, no SSR, no server-rendered auth, and no edge concerns — so Next.js's entire reason to exist is absent. Vite starts in under a second, hot-reloads instantly, and produces a plain `dist/` directory the Hono server can statically serve in one line. Choosing Next.js here would pay a 10× cold-start tax for features we will never use.

## @microsoft/fetch-event-source over native EventSource

Native `EventSource` has two problems: it can't send custom headers (blocking auth if we ever add it) and its reconnect behavior is silent and unthrottleable. `@microsoft/fetch-event-source` wraps `fetch()` so we get AbortController support, explicit reconnect policies with exponential backoff, a clean `onerror` hook, and can ship a "disconnected" badge in the UI when the connection dies. For a dashboard where staleness is a bug, robust reconnection matters.

## Tailwind v4

Tailwind v4's CSS-first `@theme` block lets us define the Obsidian & Gold palette (`--color-obsidian`, `--color-gold`, backdrop-blur tokens) once in CSS and have the JIT engine generate utilities automatically. No `tailwind.config.js`, no PostCSS plugin juggling, no separate `content` glob. The v4 engine is also ~10× faster than v3, which keeps HMR snappy as the UI grows.

## TanStack Query + Zustand split

**TanStack Query** owns anything that came from the server (prompts, progress, completion log). It handles caching, background refetch, retry, and — most importantly — lets the SSE handler call `queryClient.invalidateQueries()` to push a targeted refresh without manual state wiring.

**Zustand** owns purely-client state: the currently-selected prompt id, the command palette open flag, the copy-feedback toast. Keeping these out of Query prevents spurious re-renders and makes the server/client boundary obvious.

## No auth

The server binds to `127.0.0.1` only. Nothing on the local machine except processes running as the current user can reach it. Adding OAuth, API keys, or session cookies would be security theater on a loopback socket and a UX tax on every launch. If you later expose this behind Tailscale or Cloudflare Tunnel (see `docs/DEPLOYMENT.md`), add an auth layer *then* — not before.

## Port 5173 / 5174 split

5173 is Vite's default — swimming against that current breaks muscle memory for every frontend dev. 5174 is the next free port, adjacent in the mental model, and avoids the ports that other local tools squat on (3000 for Next/CRA, 8080 for generic servers, 4000 for Phoenix, 5000 for Flask/AirPlay on macOS). Both are explicit in `start.sh` and `stop.sh` so swapping them is one-line change if you ever have a conflict.

## Why no `pnpm-workspace.yaml`

A workspace file would force both packages to share a lockfile and hoist dependencies, which would (a) conflict with the frontend agent's existing `package.json` + lockfile, and (b) leak backend deps (`chokidar`, `hono`) into the frontend's resolution graph. Running two independent `install`s from `start.sh` is less elegant on paper but avoids a whole category of resolution bugs. Revisit if the two package trees grow very similar.
