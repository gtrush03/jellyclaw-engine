# Phase 08 Hosting — Prompt T7-05: Skill system upgrades — cap raise + lazy mode + URL install

**When to run:** Can run standalone. Ideally before T7-03 and T7-04 so they ship at full size; but those two also work under the current caps (terse variants).
**Estimated duration:** 3–4 hours
**New session?** Yes.
**Model:** Claude Opus 4.7 (1M context).

## Dependencies

- None strict. Self-contained.
- Pairs with T7-03 + T7-04 — they both author substantive skill bodies that benefit from the raised caps.

## Context

George has real skills on his machine that jellyclaw silently drops today:

| Skill | Path | Body bytes | Fate today |
|---|---|---|---|
| `systematic-debugging` | `~/.claude/skills/systematic-debugging/SKILL.md` | 9744 B | REJECTED by parser (> 8 KB body cap) |
| `test-driven-development` | `~/.claude/skills/test-driven-development/SKILL.md` | 9736 B | REJECTED |
| `zhangxuefeng-perspective` | `~/.claude/skills/zhangxuefeng-perspective/SKILL.md` | 18826 B | REJECTED |
| `ubereats-order` | `~/.claude/skills/ubereats-order/SKILL.md` | ~6 KB + sub-skills | LOADS but siblings drop |

And several small skills that DO load but get silently dropped at injection time because the 1536 B block overflows. George built these skills; jellyclaw ignores them. That's the defect.

This prompt does three things:

1. **Raise the caps** to accommodate real-world skill sizes. Body cap 8 KB → 32 KB (4×). Injection cap 1536 B → 6144 B (4×).
2. **Add lazy injection mode.** A skill whose body is above a threshold (default: 2 KB) is NOT inlined in the system prompt — only its description is. The full body loads on demand via the existing Skill tool. This prevents the raised caps from just becoming a context-bloat lever. Small skills still inline (fast path); big skills lazy-load (cap-safe).
3. **Add URL-install.** `jellyclaw skills add <url>` downloads a SKILL.md from a URL (gist, github raw, any HTTPS) into `~/.jellyclaw/skills/<name>/SKILL.md` with a tiny provenance file (`_provenance.json` next to it) recording the URL and fetched_at timestamp. Supports `file://` for local testing.

No new dependencies. No breaking changes to the existing skill contract.

## Research task

1. Read `engine/src/skills/types.ts:31` — `SKILL_BODY_MAX_BYTES = 8 * 1024`. This is the constant to change. Surrounding code paths: `parser.ts:64-69` references it.
2. Read `engine/src/skills/inject.ts:29` — `DEFAULT_INJECTION_MAX_BYTES = 1536`. Widen to 6144.
3. Read `engine/src/skills/inject.ts` end-to-end — `buildSkillInjection()` greedy-packs skills under the cap. Lazy mode modifies: skills whose body exceeds a threshold don't consume their full body's bytes in the block — they only contribute their one-line description. The cap still applies to the rendered block. This is actually **already the case** — the block currently renders ONE LINE per skill regardless of body size. The real defect is that the inline body is NEVER included in the system prompt today; injection is already "lazy" in that sense. The Skill tool is the retrieval path. So the new work here is **keeping lazy mode behaviour explicit/documented** and surfacing it via a frontmatter flag (`lazy: true|false`, default `true` for bodies ≥ 2 KB).
4. Read `engine/src/skills/parser.ts:62-69` — the body-size check. When raising the cap, also read the body-bytes into the Skill object so the registry can decide inline-vs-lazy downstream. Currently the parser stores `body` as the string; byte-count on the fly with `Buffer.byteLength(body, "utf8")`. No schema change needed beyond the constant.
5. Read `engine/src/skills/types.ts:22-28` — `SkillFrontmatter` Zod schema. Adding an optional `lazy?: boolean` here. Zod allows `.optional()`.
6. Read `engine/src/skills/registry.ts` — the in-memory registry. Nothing structural to change; lazy mode is a presentation concern (inject.ts), not storage.
7. Read `engine/src/tools/skill.ts` — the Skill tool. Returns `{ content: skill.body }`. This is already the lazy-load mechanism. Verify it works on 32 KB bodies (likely fine — the tool result goes through `stringifyResult` in loop.ts which has its own cap, but `MAX_TOOL_RESULT_BYTES` in loop.ts is much larger than 32 KB; confirm with `grep MAX_TOOL_RESULT_BYTES engine/src/agents/loop.ts`).
8. Read `engine/src/cli/` — find how CLI subcommands wire up (e.g., `engine/src/cli/main.ts` or similar). `jellyclaw skills add <url>` is a new subcommand. Mirror the pattern of an existing one (maybe `jellyclaw skills list` if it exists, otherwise any other non-`run` subcommand).
9. Check `engine/src/skills/discovery.ts` — understand the roots: `~/.jellyclaw/skills`, `./.jellyclaw/skills`, `~/.claude/skills`, `./.claude/skills`. URL-install writes to the FIRST root (`~/.jellyclaw/skills/<name>/SKILL.md`) so it's available across all projects on the user's machine.
10. WebFetch one representative SKILL.md URL to use as a fixture. E.g., George has one locally — mirror its shape. For tests, use `file://` pointing at a repo-local fixture (`test/fixtures/skills/fetched-skill.md`).
11. Read `engine/src/skills/parser.test.ts` + `inject.test.ts` — understand existing test patterns so new cases match house style.
12. Read `package.json` → `"bin"` field to confirm the CLI entry point and how subcommands are registered.

## Implementation task

Raise caps, formalize lazy mode via frontmatter, ship URL-install. Additive; zero breaking changes to existing skills.

### Files to create / modify

- **Modify** `engine/src/skills/types.ts`:
  - Change `SKILL_BODY_MAX_BYTES` from `8 * 1024` to `32 * 1024`. Add a comment explaining the historical reason (real skills like `zhangxuefeng-perspective` are ~19 KB).
  - Add `SKILL_LAZY_THRESHOLD_BYTES = 2 * 1024` — body bytes above this auto-lazy unless frontmatter overrides.
  - Extend `SkillFrontmatter` Zod schema with:
    ```ts
    lazy: z.boolean().optional(),
    ```
    Default semantics computed in `registry.ts` (below) — the raw frontmatter stays `undefined`, the registry computes `effective_lazy = frontmatter.lazy ?? (body_bytes > SKILL_LAZY_THRESHOLD_BYTES)`.
  - Add `body_bytes: number` to the `Skill` interface so downstream code doesn't recompute. Populated by the parser.

- **Modify** `engine/src/skills/parser.ts`:
  - Line 63: after computing `bodyBytes`, store it on the returned Skill object as `body_bytes: bodyBytes`.
  - Line 64-69: the cap check becomes `if (bodyBytes > SKILL_BODY_MAX_BYTES)` — same logic, just hits the new 32 KB ceiling.

- **Modify** `engine/src/skills/inject.ts`:
  - Line 29: `DEFAULT_INJECTION_MAX_BYTES` from `1536` to `6144`.
  - Update the inline doc comment explaining "injected description-only block" so maintainers understand this is always lazy (body only loads via Skill tool).
  - No behavioural change to the greedy-pack algorithm itself.

- **Modify** `engine/src/skills/inject.test.ts`:
  - Add a case that packs 10 realistic skills (mix of small + large), all with descriptions, and asserts all 10 fit under 6 KB.
  - Update any existing test that asserts `1536` as the default to read from the exported constant instead.

- **Modify** `engine/src/skills/parser.test.ts`:
  - Replace any test that expected rejection at 8193 B with one at 32769 B.
  - Add a new case: a 31 KB body parses successfully.
  - Add: a skill with `lazy: true` in frontmatter parses and the flag round-trips through the `Skill` object.
  - Add: a skill with `lazy: false` on a 10 KB body parses (user override).

- **Create** `engine/src/cli/skills-add.ts` — new command handler:
  ```ts
  // Minimal shape — the real file includes error handling, atomic write, existing-skill check.
  export async function skillsAddCommand(opts: {
    url: string;
    logger: Logger;
    now?: () => Date;
  }): Promise<{ name: string; path: string }> {
    // 1. Validate URL (https: or file:).
    // 2. Fetch body (fetch API for http(s); readFileSync for file://).
    //    Cap response at 64 KB; reject larger.
    // 3. Parse frontmatter ONLY to extract `name` — do NOT validate body caps here,
    //    let the next engine startup go through parseSkillFile() canonically.
    // 4. Write to `~/.jellyclaw/skills/<name>/SKILL.md` atomically:
    //      mkdir -p <dir>; write to .tmp; rename.
    // 5. Write `_provenance.json` with `{ url, fetched_at, sha256 }`.
    // 6. If the dir already exists, refuse (require explicit --force).
    // 7. Log the discovered name + path.
  }
  ```

- **Create** `engine/src/cli/skills-add.test.ts` — vitest cases:
  - `file:// URL round-trips` (uses `test/fixtures/skills/fetched-skill.md`).
  - `refuses if target dir exists`.
  - `--force overwrites`.
  - `rejects non-https http://` (security — no cleartext fetches).
  - `rejects body > 64 KB`.
  - `writes _provenance.json with url + fetched_at`.

- **Modify** whatever registers subcommands — likely `engine/src/cli/main.ts` or `engine/src/cli/args.ts` (grep for the `run` subcommand registration): add `jellyclaw skills add <url> [--force]`. If no `skills` parent command exists, add one and nest `add` under it so future `skills list` / `skills remove` fit naturally.

- **Create** `test/fixtures/skills/fetched-skill.md`:
  ```markdown
  ---
  name: example-fetched
  description: Example skill for the URL-install test fixture. Does nothing.
  ---

  Body of the example-fetched skill. Short.
  ```

- **Update** `docs/skills.md`:
  - Body cap section: update `8 KB` → `32 KB`.
  - New section "Lazy mode":
    > Skills whose body exceeds 2 KB are lazy by default — only the description lands in the system prompt; the full body loads on demand via the Skill tool. Override with `lazy: true/false` in frontmatter. Small skills inline fast; big skills stay cap-safe.
  - New section "Installing from a URL":
    ````markdown
    ## Installing from a URL

    ```bash
    jellyclaw skills add https://gist.github.com/alice/abcd/raw/foo/SKILL.md
    jellyclaw skills add file:///tmp/my-local-skill.md         # for testing
    jellyclaw skills add <url> --force                         # overwrite existing
    ```

    Skills install to `~/.jellyclaw/skills/<name>/SKILL.md`. Provenance
    (`_provenance.json`) records the source URL and fetch time.
    ````

- **Update** `COMPLETION-LOG.md` — append `08.T7-05 ✅` with the final cap numbers and list of George's 4 real skills that NOW load.

### Files NOT to touch

- `engine/src/skills/watcher.ts` — chokidar watch is unchanged by caps.
- `engine/src/skills/substitution.ts` — body template substitution is unaffected.
- `engine/src/tools/skill.ts` — the Skill tool already returns `body` verbatim; no change needed. Confirm the `MAX_TOOL_RESULT_BYTES` in loop.ts is > 32 KB (it's 64 KB in current code; confirm with grep).

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

bun install
bun run typecheck
bun run lint
bun run test engine/src/skills/
bun run test engine/src/cli/skills-add.test.ts
bun run build

# Smoke — URL install via file:// fixture.
rm -rf /tmp/jc-skills-smoke && mkdir -p /tmp/jc-skills-smoke
HOME_OVERRIDE=/tmp/jc-skills-smoke HOME=/tmp/jc-skills-smoke \
  ./dist/cli.js skills add "file://$(pwd)/test/fixtures/skills/fetched-skill.md"
ls -la /tmp/jc-skills-smoke/.jellyclaw/skills/example-fetched/
cat /tmp/jc-skills-smoke/.jellyclaw/skills/example-fetched/_provenance.json
# Expect:
#   SKILL.md
#   _provenance.json  with {"url":"file://...","fetched_at":"...","sha256":"..."}

# Smoke — George's real skills now load.
for skill in systematic-debugging test-driven-development zhangxuefeng-perspective ubereats-order; do
  p="$HOME/.claude/skills/$skill/SKILL.md"
  if [ -f "$p" ]; then
    echo "--- $skill ($(wc -c < "$p") bytes) ---"
  else
    echo "--- $skill — not present on this machine, skipping ---"
  fi
done

LOG_LEVEL=debug ./dist/cli.js run --max-turns 1 "list your skills" 2>&1 | \
  grep -iE "skill.*(loaded|shadowed|failed)|Available skills" | head -30
# Expect: NO "skill failed to load" warnings for the four real skills.
# Expect: all four names appear in the Available skills block (or via the Skill tool on demand).
```

### Expected output

- `SKILL_BODY_MAX_BYTES = 32 * 1024` in `engine/src/skills/types.ts`. Parser rejects only above that. George's 4 real skills parse without error.
- `DEFAULT_INJECTION_MAX_BYTES = 6144` in `engine/src/skills/inject.ts`. With 10 realistic skills loaded, all 10 lines land in the injection block (verified by new test).
- `lazy` field on frontmatter is optional, default computed from body_bytes. `Skill.body_bytes` populated by parser.
- `jellyclaw skills add <url>` works for `https://` and `file://`. Rejects `http://`. Writes `SKILL.md` + `_provenance.json`. Errors cleanly on existing-target without `--force`.
- `docs/skills.md` updated with new sections. No stale references to `8 KB`.
- All existing tests pass; new tests added for each behaviour above.
- Net change: ~200 LOC across types/parser/inject + ~150 LOC for `skills-add` + tests + docs.

### Tests to add

- `engine/src/skills/parser.test.ts`:
  - 31 KB body parses.
  - 33 KB body throws SkillLoadError (at the new cap).
  - `lazy: true` round-trips; `lazy: false` round-trips; unset means undefined.
  - `body_bytes` on the returned Skill matches `Buffer.byteLength(body, "utf8")`.
- `engine/src/skills/inject.test.ts`:
  - 10 realistic skills all fit under 6144.
  - Injection cap constant is now 6144 (regression guard).
- `engine/src/skills/registry.test.ts`:
  - A fixture dir with a 19 KB body loads (simulates `zhangxuefeng-perspective`).
- `engine/src/cli/skills-add.test.ts`:
  - See the case list above (file://, --force, http:// rejection, 64 KB cap, provenance file).

### Common pitfalls

- **Do not raise caps without lazy mode.** Raising to 32 KB and inlining all bodies bloats the system prompt. The current injection strategy is ALREADY description-only — good — but formalize this in the code comment so a future contributor doesn't "helpfully" inline the bodies. Add a linked docstring in `inject.ts` explaining the contract.
- **`body_bytes` is UTF-8 bytes, not chars.** The whole cap pipeline is byte-based; keep it that way to avoid multi-byte surprises in Chinese skills like `zhangxuefeng-perspective`. `Buffer.byteLength(str, "utf8")`.
- **Zod `.optional()` + strict objects.** If `SkillFrontmatter` uses `.strict()`, adding `lazy` means older skills without the field must still parse (they will — `.optional()` allows it). Confirm no `.strict()` is set, or if it is, that new fields are grandfathered in.
- **URL-install on `http://` is a security hole.** Only `https://` and `file://`. If a future corporate environment needs `http://` (dev-only), require a `--insecure` flag AND a warning log line. Default must be refuse.
- **Atomic write.** Write to `<dir>/SKILL.md.tmp`, fsync, rename. Otherwise a crash mid-fetch leaves a half-written skill that fails parser and the user wonders why.
- **Existing-target handling.** `~/.jellyclaw/skills/<name>/` already exists → refuse without `--force`. Never silently overwrite. The `_provenance.json` is the audit trail; overwriting without --force destroys it.
- **Name conflicts across roots.** If `example-fetched` already exists in `./.jellyclaw/skills/` (project-scoped), installing to `~/.jellyclaw/skills/` (user-scoped) creates a shadow — the project version wins per existing registry rules. Document this in `docs/skills.md`: URL-install goes to user scope; project skills override it.
- **SHA256 in provenance.** Hash the exact bytes fetched (not the Buffer object). Write as hex string. Keeps it human-readable. A user inspecting `_provenance.json` should be able to see "what did I download" at a glance.
- **Response size cap.** 64 KB cap on fetch. A hostile URL could stream infinite data otherwise. Implement with a length-tracking read (`response.body.getReader()` loop + abort on over-cap) — do NOT `response.text()` first and check length after; that materializes the full body into memory.
- **Do NOT automatically reload the registry after install.** The `jellyclaw skills add` subcommand is a one-shot CLI — write the file and exit. The next `jellyclaw run` picks it up via normal discovery. Auto-reload requires coupling to a running daemon and is out of scope.
- **CLI flag hygiene.** `--force` should be boolean. Use the same arg parser the rest of the CLI uses (likely commander or manual zod). Mirror existing style.
- **Backward compatibility for tests asserting specific cap numbers.** Find every test that bakes in `8192` or `1536`; update them to read from the exported constant. If a test depends on `body too large: 9000 bytes, exceeds cap of 8192`, it'll break — replace with a 33 KB case against the new cap.
- **The `Skill tool` body return ceiling.** Confirm `MAX_TOOL_RESULT_BYTES` in loop.ts is ≥ 32 KB. If it's smaller, 32 KB skills truncate when loaded via the Skill tool — a silent regression. Add a cross-file assertion in a test: `expect(MAX_TOOL_RESULT_BYTES).toBeGreaterThanOrEqual(SKILL_BODY_MAX_BYTES)`.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T7-05 ✅` with the final cap numbers (body: 32 KB, injection: 6144 B, lazy threshold: 2 KB), confirmation that all 4 of George's real skills now parse, and the skills-add subcommand's happy-path + error-path coverage.
2. Print `DONE: T7-05` on success, `FAIL: T7-05 <reason>` on fatal failure.
