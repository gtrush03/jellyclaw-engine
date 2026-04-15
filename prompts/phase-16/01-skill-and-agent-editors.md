# Phase 16 — Desktop App Polish — Prompt 01: Skill and agent editors

**When to run:** After Phase 15 is marked ✅ in `COMPLETION-LOG.md`. First prompt of Phase 16.
**Estimated duration:** 5–7 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with 16. Do not proceed unless Phase 15 is fully ✅ (all five 15.01–15.05 sub-prompts checked, signed `.dmg` produced, engine sidecar launches from the app).

---

## Research task

Read in order:

1. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-16-desktop-polish.md` — step 1 (Editors), acceptance criteria.
2. `/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md` — editor UX expectations, Obsidian & Gold palette.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` §8 (skills: search order, 1536-char description cap, 8 KB body cap, frontmatter schema, `$ARGUMENTS` substitution) and §13 (hooks — not edited here but referenced from the frontmatter `allowed_tools`).
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — what the UI must enforce visually (secret redaction on paste, allowlist hints).
5. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/parser.ts` + `registry.ts` — source of truth; reuse the same Zod schema in the UI.
6. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/04-core-ui-shell.md` — routing, theme tokens, query-client patterns.

Fetch via WebFetch (primary sources — always verify versions):

- `https://codemirror.net/docs/` — CodeMirror 6 setup, state/view separation, `Compartment` for dynamic reconfiguration.
- `https://github.com/codemirror/lang-markdown` — markdown parser, `frontMatter` nested parser for YAML.
- `https://github.com/codemirror/lang-yaml` — YAML support.
- Context7: `jonschlinkert/gray-matter` — frontmatter parse + stringify round-trip.
- `https://github.com/aeolun/react-diff-viewer-continued` — React 19 compatible diff renderer.
- `https://github.com/steveukx/git-js` — `simple-git` for versioned-skill history on the engine side.

## Implementation task

Build **Skill Editor** and **Agent Editor** screens that let a non-engineer edit `~/.jellyclaw/skills/<name>/SKILL.md` and `~/.jellyclaw/agents/<name>.md` safely, with a live preview of `$ARGUMENTS` substitution, a test-run sandbox, and a git-backed version history.

### Files to create/modify

- `desktop/src/screens/SkillEditor.tsx`
- `desktop/src/screens/AgentEditor.tsx`
- `desktop/src/components/editor/CodeMirror.tsx` — the shared view.
- `desktop/src/components/editor/useCodeMirror.ts` — hook.
- `desktop/src/components/editor/theme-obsidian-gold.ts` — port of the Obsidian & Gold palette (bg `#050505`, gold `#928466`, muted `#6f6550`) into a CodeMirror `EditorView.theme` + `HighlightStyle`.
- `desktop/src/components/editor/FrontmatterForm.tsx` — Zod-driven react-hook-form.
- `desktop/src/components/editor/DescriptionMeter.tsx` — live char-count.
- `desktop/src/components/editor/ArgumentsPreview.tsx` — `$ARGUMENTS` substitution preview.
- `desktop/src/components/editor/TestRunModal.tsx` — dry-run dispatcher.
- `desktop/src/components/editor/VersionHistory.tsx` — git log + diff.
- `desktop/src/components/editor/ConflictBanner.tsx` — on-disk mtime check.
- `desktop/src/components/editor/SkillPalette.tsx` — ⌘-Shift-P fuzzy finder.
- `desktop/src/lib/skills-api.ts` — HTTP client for engine endpoints.
- `desktop/src/hooks/useFileWatcher.ts` — subscribe to engine skill-change SSE stream.
- `engine/src/http/routes/skills.ts` — add `GET /v1/skills`, `GET /v1/skills/:id`, `PUT /v1/skills/:id`, `GET /v1/skills/:id/history`, `GET /v1/skills/:id/history/:sha`.
- `engine/src/http/routes/agents.ts` — same shape for agents.
- `engine/src/skills/history.ts` — wraps `simple-git` against `~/.jellyclaw/.git/` (lazy `git init` on first save).
- `engine/src/skills/dry-run.ts` — sandboxed dispatcher used by `POST /v1/runs {sandboxed: true}`.

### Prerequisites check

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
git status
ls desktop/src/screens/
ls ~/.jellyclaw/skills/ 2>/dev/null || echo "no skills dir yet — OK"
bun run typecheck
```

If `desktop/` is missing any Phase-15 route scaffolding, STOP and flag — this prompt assumes `App.tsx` already has a `<Router>` and the query-client is wired.

### Step-by-step

**1. Install dependencies.**

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm add @codemirror/state@^6 @codemirror/view@^6 @codemirror/commands@^6 \
         @codemirror/language@^6 @codemirror/lang-markdown@^6 @codemirror/lang-yaml@^6 \
         @codemirror/search@^6 @codemirror/autocomplete@^6 @lezer/highlight@^1 \
         gray-matter@^4 react-hook-form@^7 @hookform/resolvers@^3 zod@^3 \
         react-diff-viewer-continued@^4 cmdk@^1 fuse.js@^7
```

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add simple-git@^3
```

**2. Build the CodeMirror wrapper hook** (`useCodeMirror.ts`). Use a `Compartment` per language so `language === "yaml"` vs `"markdown"` can swap without tearing the view down:

```ts
import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { markdown } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { obsidianGoldTheme, obsidianGoldHighlight } from "./theme-obsidian-gold";

type Lang = "markdown" | "yaml";

export function useCodeMirror(opts: {
  value: string;
  onChange: (v: string) => void;
  language: Lang;
  readOnly?: boolean;
  onSave?: () => void;
  onDuplicate?: () => void;
  onPalette?: () => void;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());

  useEffect(() => {
    if (!host.current) return;
    const langExt = opts.language === "yaml"
      ? yamlFrontmatter({ content: markdown() })
      : markdown();

    const state = EditorState.create({
      doc: opts.value,
      extensions: [
        lineNumbers(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(obsidianGoldHighlight),
        obsidianGoldTheme,
        langCompartment.current.of(langExt),
        EditorState.readOnly.of(!!opts.readOnly),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
          { key: "Mod-s", preventDefault: true, run: () => { opts.onSave?.(); return true; } },
          { key: "Mod-d", preventDefault: true, run: () => { opts.onDuplicate?.(); return true; } },
          { key: "Mod-Shift-p", preventDefault: true, run: () => { opts.onPalette?.(); return true; } },
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
        EditorView.theme({ "&": { height: "100%" }, ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace)" } }),
      ],
    });

    view.current = new EditorView({ state, parent: host.current });
    return () => view.current?.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Controlled doc sync
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== opts.value) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: opts.value } });
    }
  }, [opts.value]);

  // Swap language without teardown
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const langExt = opts.language === "yaml"
      ? yamlFrontmatter({ content: markdown() })
      : markdown();
    v.dispatch({ effects: langCompartment.current.reconfigure(langExt) });
  }, [opts.language]);

  return { hostRef: host, view };
}
```

**3. Obsidian & Gold theme port** (`theme-obsidian-gold.ts`). Map CM6 highlight tags to the palette; this is the same palette used by the app shell so the editor feels native.

```ts
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

const GOLD = "#928466";
const MUTED = "#6f6550";
const IVORY = "#e8e3d6";
const BG = "#050505";

export const obsidianGoldTheme = EditorView.theme({
  "&": { backgroundColor: BG, color: IVORY },
  ".cm-content": { caretColor: GOLD },
  ".cm-cursor": { borderLeftColor: GOLD },
  ".cm-selectionBackground, ::selection": { backgroundColor: "#928466aa" },
  ".cm-activeLine": { backgroundColor: "#ffffff05" },
  ".cm-gutters": { backgroundColor: BG, color: MUTED, border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "#ffffff08" },
}, { dark: true });

export const obsidianGoldHighlight = HighlightStyle.define([
  { tag: t.heading, color: GOLD, fontWeight: "600" },
  { tag: t.strong, color: IVORY, fontWeight: "700" },
  { tag: t.emphasis, color: IVORY, fontStyle: "italic" },
  { tag: t.keyword, color: GOLD },
  { tag: t.string, color: "#c9bfa6" },
  { tag: t.comment, color: MUTED, fontStyle: "italic" },
  { tag: t.meta, color: MUTED },
  { tag: [t.propertyName, t.attributeName], color: GOLD },
  { tag: t.link, color: "#c9bfa6", textDecoration: "underline" },
]);
```

**4. Skill browser sidebar.** List merges three sources with a badge per source:

- Global: `~/.jellyclaw/skills/` (writable)
- Project: `$PWD/.jellyclaw/skills/` (writable, present only when `engine.project` is set)
- Legacy: `.claude/skills/` (read-only — Genie compat, shown with a lock icon)

Call `GET /v1/skills` which returns `{ id, name, source: "global"|"project"|"legacy", description, path, size, updatedAt, writable }`. Cache via TanStack Query with `staleTime: 0` and an SSE subscription (`/v1/events?stream=skills`) that invalidates on `skill.changed`.

**5. Frontmatter form.** Use `gray-matter` to split YAML → `{ data, content }`. Render `data` as a form (name, description, trigger, allowed_tools: string[] with `Tool(pattern)` validation, model, mode), body as the CodeMirror editor below. On save, call `matter.stringify(content, data)` to reconstruct the file verbatim (preserves quoting and comments better than hand-rolled YAML).

```ts
import matter from "gray-matter";

export function splitSkill(raw: string) {
  const { data, content } = matter(raw);
  return { frontmatter: data as SkillFrontmatter, body: content };
}
export function joinSkill(fm: SkillFrontmatter, body: string) {
  return matter.stringify(body, fm);
}
```

**6. Description meter.** The engine enforces `description.length <= 1536` (chars, not bytes). Reuse the CostMeter tier tokens:

- 0–768: green (`#8ca074`)
- 769–1280: gold (`#928466`)
- 1281–1536: amber (`#c4964a`)
- 1537+: red (`#a85a4a`) + block save button

**7. `$ARGUMENTS` preview.** Split-pane: user types `sample args` in a textarea → preview pane renders the skill body with `$ARGUMENTS` literal-replaced. Match the engine's exact substitution semantics (string replace, not templating). Expose two modes: raw markdown source and rendered markdown via `marked` (already a shell dep).

**8. Test-run button.** Dispatches `POST /v1/runs` with:

```json
{
  "prompt": "/skill <name> <sample-args>",
  "sandboxed": true,
  "permissionMode": "ask",
  "maxSteps": 3
}
```

Opens a modal streaming the SSE timeline in a minimal view. On completion, show exit code, total tokens, elapsed ms. Engine-side the `sandboxed: true` flag forces `cwd: $TMPDIR/jellyclaw-sandbox-<uuid>`, disables network tools, and tears down the temp dir after the run.

**9. Version history.** Engine-side, lazy `git init` `~/.jellyclaw/` on first skill save; every `PUT /v1/skills/:id` commits with `skill(<id>): <short-sha-of-body>` via `simple-git`. Expose:

- `GET /v1/skills/:id/history` → `[{ sha, date, author, message }]` (last 50)
- `GET /v1/skills/:id/history/:sha` → the file content at that sha

UI uses `react-diff-viewer-continued` with `splitView: true` against the current working copy. Restore = `PUT /v1/skills/:id` with the historic content.

**10. Agents.** Same component tree, different frontmatter schema (`name, description, mode: plan|build|review, model, tools: string[], prompt: string`). The body IS the system prompt; no `$ARGUMENTS` preview (agents don't take them) — replace that pane with a "dispatch as one-shot wish" tester.

**11. Conflict detection.** When loading, server returns `etag: <sha256>(file)`. On save, include `If-Match: <etag>`. If mismatch, engine returns 412; UI shows `<ConflictBanner />` with "Overwrite / Reload / View diff".

**12. Keyboard shortcuts.** Already wired via `useCodeMirror` options. The palette (`⌘-Shift-P`) opens a `cmdk` command menu over all skills/agents + common actions (Save, Duplicate, New skill, Toggle preview, Run test).

### Engine endpoints (new)

```ts
// engine/src/http/routes/skills.ts
router.get("/v1/skills", listSkills);
router.get("/v1/skills/:id", getSkill); // sets ETag
router.put("/v1/skills/:id", async (req, res) => {
  const etag = req.headers["if-match"];
  if (etag && currentEtag(req.params.id) !== etag) return res.status(412).send({ error: "conflict" });
  await writeSkill(req.params.id, req.body.content);
  await history.commit(req.params.id, req.body.message ?? "edit from desktop");
  res.status(200).send({ ok: true, etag: newEtag(req.params.id) });
});
router.get("/v1/skills/:id/history", listCommits);
router.get("/v1/skills/:id/history/:sha", showAtSha);
```

### Tests to add

- Vitest unit: `splitSkill` round-trip preserves YAML comments and quotes.
- Vitest unit: description meter tier function.
- Engine integration: save → `GET /history` returns 1 commit.
- Playwright component test for `<SkillEditor>`: mount with mocked TanStack client, type into body, observe debounced save fires once, observe description meter turns red at 1537 chars.
- Playwright E2E: open editor, edit skill, save, hot-reload observed in engine stdout log within 1s.

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm typecheck && pnpm test && pnpm lint
pnpm tauri dev
# In app: /skills → pick one → change description to 1537 chars → observe red + disabled save
# Edit body → ⌘-S → watch engine log: "skill reloaded: <id>"
# Click Test → modal streams timeline → completes with non-zero tokens
# Click History → pick an earlier commit → Diff view renders → Restore → confirm
```

### Common pitfalls

- **CodeMirror workers.** CM6 has no workers (unlike Monaco). Do not add one — the bundle is small and WebView2/WebKitGTK both choke on blob: worker URLs inside `tauri://localhost`.
- **`gray-matter` ESM.** It's CJS; Vite will complain under SSR mode. Add `optimizeDeps.include: ["gray-matter"]` to `vite.config.ts`.
- **YAML frontmatter highlighting.** `@codemirror/lang-yaml` exports `yamlFrontmatter({ content: markdown() })` — this is what wraps a YAML header above a markdown body. Using plain `markdown()` will render the frontmatter as plain text with dashed rules.
- **1536 is characters, not UTF-8 bytes.** A description with 768 emoji is at the cap even though it's ~3 KB.
- **Legacy `.claude/skills/` paths** contain a mix of flat `<id>.md` and nested `<id>/SKILL.md`. The list endpoint must handle both.
- **gray-matter mutates input** when `stringify` is called twice with the same data reference. Always pass `{ ...frontmatter }`.
- **Git history on a huge `.jellyclaw/` dir** is fine — the repo is tiny. Do NOT add the user's `sessions/` JSONL files to the repo (add to `.gitignore` via `simple-git.raw(["config", "..."])` on `git init`).
- **WebKitGTK text cursor flicker.** CM6's `drawSelection()` fixes it; without it, Linux users see a doubled caret.
- **Watcher echo.** Engine SSE `skill.changed` fires after every UI save. Tag requests with `X-Client-Id: desktop-<sessionId>`; engine excludes that id when broadcasting.

### Why this matters

Skills are how non-engineers extend the agent. If editing them requires `vim` on a markdown file, we lose every designer, PM, and domain expert who would otherwise author a useful skill. The editor is the difference between "jellyclaw is a library" and "jellyclaw is a product." Version history + conflict detection + test-run turn skill authoring from a guessing game into a tight loop.

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with 16. Mark sub-prompt 16.01 complete. Phase 16 status 🔄. Commit with `docs: phase 16.01 skill + agent editors`. Next prompt: `prompts/phase-16/02-mcp-server-list-and-settings.md`.

Do **not** mark Phase 16 ✅ yet — only prompt 05 does that.
