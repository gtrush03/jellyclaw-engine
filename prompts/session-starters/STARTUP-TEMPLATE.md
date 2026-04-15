# Session startup — read this first

You are working on the **jellyclaw-engine** project at `/Users/gtrush/Downloads/jellyclaw-engine/`.

**Before doing anything else:**

1. Read these orientation files IN ORDER:
   - `/Users/gtrush/Downloads/jellyclaw-engine/README.md` — what this project is
   - `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` — the 20-phase plan
   - `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — current status (what's done, what's next, blockers)
   - `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md` — daily status
   - `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-<NN>-<name>.md` — the phase you're working on (read fully)

2. Verify environment:
   - `cd /Users/gtrush/Downloads/jellyclaw-engine && pwd` — confirm cwd
   - `git status` — see any uncommitted work from the previous session
   - `bun --version` — confirm Bun is installed (>=1.1)
   - `node --version` — confirm Node >=20.6
   - `cat .env.example` — see what env vars are needed
   - `ls dist/` — see if engine is built

3. Confirm current state matches expectations:
   - Current phase (per COMPLETION-LOG.md): should be Phase <NN>
   - Previous phase(s): should be marked ✅ in COMPLETION-LOG.md
   - Open blockers: check the Blockers & decisions section

4. If anything looks unexpected (wrong current phase, missing files from previous phase, uncommitted conflicts), STOP and report to the user. Do not proceed.

5. If state matches expectations, proceed with the task below.

---
