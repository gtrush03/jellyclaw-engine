# dashboard/ structure

This directory hosts a local-only dashboard that helps you step through the jellyclaw engine-build prompts without context-switching between Warp, Finder, and a text editor. It is **two apps in one folder**, wired together by `start.sh`.

## Layout

```
dashboard/
├── package.json              # frontend (React + Vite) — owned by frontend agent
├── vite.config.ts            # frontend build config — owned by frontend agent
├── tsconfig.json             # frontend TS config — owned by frontend agent
├── index.html                # Vite entry — owned by frontend agent
├── src/                      # React app source — owned by frontend agent
├── public/                   # static assets — owned by frontend agent
│
├── server/                   # backend (Hono + chokidar + SSE)
│   ├── package.json          # OWN dependencies, OWN scripts — separate install
│   └── …                     # owned by backend agent
│
├── start.sh                  # THE launcher — installs deps, runs both
├── stop.sh                   # kills everything tied to this dashboard
├── scripts/
│   └── dev-restart.sh        # stop + start in one command
├── launchd/
│   └── com.jellyclaw.dashboard.plist   # optional macOS auto-start
├── docs/
│   ├── ARCHITECTURE.md
│   └── DEPLOYMENT.md
├── DECISIONS.md              # architecture rationale
├── README.md                 # user-facing docs
├── ROOT.md                   # you are here
└── .gitignore
```

## Why two package.json files?

The frontend needs the dashboard directory as its Vite root (so `index.html`, `src/`, `public/` all sit at the root Vite expects). The backend is a separate Node process with a different dependency tree (Hono, chokidar, tsx) that has no business polluting the frontend bundle. Keeping `server/package.json` isolated lets each side evolve independently and keeps `dashboard/dist/` clean.

**We deliberately did NOT create a `pnpm-workspace.yaml`** at the dashboard root — see `DECISIONS.md` for the reasoning. `start.sh` orchestrates the two by running `pnpm install` (or `npm install`) in each directory on first boot.

## How it runs

- `start.sh` is the **only** entry point you should use day-to-day.
- Backend binds `127.0.0.1:5174` (API + SSE).
- Frontend binds `127.0.0.1:5173` (Vite dev server).
- Frontend proxies `/api/*` and `/sse/*` to the backend via `vite.config.ts`.
- Ctrl-C in the start terminal kills both processes cleanly.

## Who edits what

| Path                       | Owner            |
|----------------------------|------------------|
| `dashboard/src/**`         | frontend agent   |
| `dashboard/server/**`      | backend agent    |
| `start.sh`, `stop.sh`, `scripts/**`, `launchd/**`, `docs/**`, `README.md`, `ROOT.md`, `DECISIONS.md`, `.gitignore` | launcher agent (this file set) |

If you're unsure, don't touch — open an issue in `COMPLETION-LOG.md` instead.
