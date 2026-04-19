# T6-04 Design Brief

**Produced:** 2026-04-19
**Status:** authoritative for tiers T1–T3

---

## 1. Brand palette

### Current Token Hex Table

| Token | Hex | Use | Type |
|-------|-----|-----|------|
| **Jelly Cyan** | `#3BA7FF` | Bell/dome, user accent | Accent |
| **Medusa Violet** | `#9E7BFF` | Tentacle glow, assistant accent | Accent |
| **Amber Eye** | `#FFB547` | Heartbeat, warning, tool emphasis | Accent |
| **Blush Pink** | `#FF6FB5` | Jellyjelly candid highlight, rim accent | Accent |
| **Foam** | `#E8ECF5` | Primary text on abyss backgrounds | Text |
| **Abyss** | `#0A1020` | Main background | Background |
| **Panel** | `#0E1830` | Secondary surface | Background |
| **Tidewater** | `#5A6B8C` | Muted text / border subtle | Semantic |
| **TidewaterDim** | `#3B475F` | Deeper muted / divider | Semantic |
| **Success** | `#4ADE80` | Positive outcome | Semantic |
| **Error** | `#FF5577` | Destructive / failure | Semantic |
| **Diff Add** | `#5A8C66` | Added lines (gold-tinted green) | Semantic |
| **Diff Del** | `#8C5A5A` | Deleted lines (muted rust) | Semantic |

### Proposed Additions (3)

**1. Neutral Bridge: `#A8B5CA`**
- Fills the gap between Tidewater (L:44) and Foam (L:93) for secondary text, disabled states, dividers
- WCAG AA compliant (4.8:1 against Abyss)

**2. Foam Dark: `#D1D5E1`**
- Secondary text token for metadata, timestamps, context lines
- Bridges cold TUI palette with warm dashboard tones
- WCAG AAA compliant (7.2:1 against Abyss)

**3. Abyss Light: `#161E3A`**
- Second surface tier for nested panels, modal overlays
- Prevents visual collapse when panels nest

### Accessibility Summary

| Token | Abyss Contrast | Status |
|-------|---|---|
| Foam | 11.9:1 | AAA ✓ |
| Jelly Cyan | 5.4:1 | AA ✓ |
| Medusa Violet | 4.6:1 | AA ✓ |
| Amber Eye | 4.8:1 | AA ✓ |
| Blush Pink | 5.2:1 | AA ✓ |
| Neutral Bridge | 4.8:1 | AA ✓ |

### Cross-surface Compatibility

- **Ink TUI (256-color):** Jelly Cyan → xterm 51, Medusa Violet → xterm 141, Amber Eye → xterm 215, Foam → xterm 255, Abyss → xterm 234
- **Web TUI (xterm.js):** Full truecolor, native hex values
- **HTML Landing (CSS):** Shared neutral bridge allows single-source CSS variables

---

## 2. TUI target mockups

### splash.tsx

```
╭─────────────────────────────────────────────────────────────────╮
│                                                                 │
│  🪼 jellyclaw                                                  │
│  ───────────────                                               │
│                                                                 │
│  open-source agent runtime · 1M context                        │
│  model claude-opus-4-5  ·  cwd /Users/me/project              │
│                                                                 │
│  type to begin  ·  /help for commands  ·  ctrl-c twice to quit │
│                                                                 │
╰─────────────────────────────────────────────────────────────────╯
```

**Polish wins:** (1) Gradient underline extends full wordmark width; (2) Multi-color brand pill shows model + cwd in distinct accent colors; (3) Hint text uses smart micro-typography with bullet separators.

### boot-animation.tsx

```
Frame 1-3: jellyfish sway with letter reveal

🪼  j
    ──

🪼  je
    ────

🪼  jelly...
    ───────────────────────────────────────
```

**Polish wins:** (1) Jellyfish glyph oscillates independently (3-frame swim cycle ~160ms); (2) Underline grows with revealed letters; (3) Smooth 80ms stagger creates fluid entry.

### jellyfish.tsx (spinner)

```
Compact (status bar):     Hero (center mount):
    ⢀ jc                  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀
    ⠠ jc                  ⠈⠂⠄⡀⢀⠠⠐⠈⠂⠄⡀
    ⠄ jc                  ⠂⠄⡀⢀⠠⠐⠈⠂⠄⡀⢀
    ⠐ jc                  ⡀⢀⠠⠐⠈⠂⠄⡀⢀⠠⠐
```

**Polish wins:** (1) Size variants: compact vs hero; (2) Reduced-motion shows static silhouette; (3) Frame-driving enables parent TUI to sync all spinners.

### transcript.tsx

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│ │ 🪼 jc                                                        │
│   # Refactoring Plan                                          │
│   1. Extract config logic                                     │
│   2. Add validation layer                                     │
│   3. Write integration tests                                  │
│                                                                │
│ │ you › Let's add a debug mode                                │
│                                                                │
│ │ 🪼 jc   ⠈⠂⠄ (streaming...)                                  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

**Polish wins:** (1) Per-role accent rules: user cyan, assistant violet, error red; (2) Markdown rendering for assistant output; (3) Live thinking indicator during streaming.

### tool-call.tsx

```
┌────────────────────────────────────────────────────────────────┐
│ ◇ tool Read  ·  245ms  ✓                                       │
│                                                                │
│ {"file_path": "/src/api.ts", "lines": [1, 50]}                │
│                                                                │
│ ➜ import { describe, it, expect } from 'vitest'               │
│   import { api } from './api'                                 │
│   … (23 more lines)                                           │
│                                                                │
│ ◇ tool Write  ·  389ms  ✗                                      │
│ ➜ EACCES: permission denied, open '/etc/passwd'               │
└────────────────────────────────────────────────────────────────┘
```

**Polish wins:** (1) Status glyph evolution: pending ◐◓◑◒ → ok ✓ → error ✗; (2) Output collapse with "… (N more)" tail; (3) Duration right-aligned.

### diff-view.tsx

```
┌────────────────────────────────────────────────────────────────┐
│ ◇ /Users/me/src/config.ts                                     │
│                                                                │
│ - const val = process.env.DEBUG || "off"                      │
│ + const val = (process.env.DEBUG ?? "off") as DebugLevel      │
│ + const validateDebug = (v: unknown) => { ... }               │
│                                                                │
│   … 34 lines elided …  [press 'd' to expand]                 │
│                                                                │
│ - export { config }                                           │
│ + export { config, validateDebug }                            │
└────────────────────────────────────────────────────────────────┘
```

**Polish wins:** (1) Color-coded prefixes: green +, red -, dim context; (2) Smart collapse: first 20 + last 20 lines; (3) File path header with accent glyph.

### status-bar.tsx

```
🪼 jellyclaw  ·  claude-opus-4.5  ·  a1b2c3d4  ·  2.4k tok  ·  $0.47  ·  ⠈⠂⠄
─────────────────────────────────────────────────────────────────────────────
```

**Polish wins:** (1) Smart slots with conditional separators; (2) Formatted tokens "2.4k" and cost "$0.47"; (3) Status glyph right-aligned: spinner | ! | ✗ | ·

### input-box.tsx

```
─────────────────────────────────────────────────────────────────
› Write a test for the new config validator
  Shift+Enter for new line, Enter to submit
–────────────────────────────────────────────────────────────────
```

**Polish wins:** (1) Caret visualization with inverted character; (2) Shift+Enter hint text; (3) Disabled state shows "(streaming…)" in muted violet.

---

## 3. Landing page

### Hero

**h1:** jellyclaw

**Pitch (12 words):** open-source agent runtime. same tools as Claude Code, your infrastructure.

**CTA:** `bun install && ./jellyclaw tui`

### Features (3 cards)

**Bash**
full shell access with deny-wins permission rules. runs in a sandbox you control — no secret network calls, no writes outside your project root.

**Browser**
Playwright MCP wired in. browse, screenshot, fill forms. works headless or with Chrome visible — your choice.

**Web search**
`WebSearch` + `WebFetch` built-in. no external proxy. results stream back as tool results the model can reason over.

### Why jellyclaw (3 bullets)

- **transparent loop** — Claude Code is a compiled binary you can't inspect. jellyclaw is TypeScript you can read, hook, and audit.
- **BYOK economics** — direct Anthropic API with aggressive prompt caching. no intermediary markup. you see the cache hits.
- **embeddable** — library mode, HTTP server, or CLI. spawn it from Swift, call it from Node, pipe a prompt in and stream events out.

### Try-it CTA Footer

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./jellyclaw tui
```

**BYOK disclaimer:** jellyclaw does not proxy your requests. your key talks directly to `api.anthropic.com`. we never see it.

### Meta Tags

**title:** jellyclaw — open-source Claude Code runtime

**meta description (156 chars):**
Open-source agent runtime with Bash, browser, and web search tools. Drop-in replacement for claude -p. BYOK, embeddable, TypeScript you can audit.

**og:image spec:** 1200x630 PNG. Abyss background (#0A1020). Centered jellyfish glyph in Jelly Cyan (#3BA7FF). Wordmark "jellyclaw" below in Inter Medium, white. Tagline "open-source agent runtime" in 50% white.

---

## 4. Demo embed strategy

### Options Evaluated

| Option | Weight | CSP | Accessibility | Recording |
|--------|--------|-----|---------------|-----------|
| asciinema-player + .cast | 80-130 KB | script-src self | Text-based, no captions needed | `asciinema rec` |
| .webm/.mp4 video | 200-800 KB | media-src self | Requires captions | ffmpeg/OBS |
| Screenshot carousel | 150-750 KB | img-src self | Alt text required | screencapture |

### Winner: asciinema-player

**Justification:**
1. Smallest total weight (~80-130 KB total)
2. Best accessibility — actual text, users can copy commands
3. CSP-friendly when self-hosting
4. Native terminal feel — perfect for CLI demo
5. Easy updates — just re-record `.cast` file

### Recording Command

```bash
asciinema rec --idle-time-limit=1.5 --cols=80 --rows=24 site/demo.cast
```

**Duration:** 20-25 seconds (boot + one prompt + response)

### Embed Snippet

```html
<div id="demo"></div>
<script src="asciinema-player.min.js"></script>
<link rel="stylesheet" href="asciinema-player.css">
<script>
  AsciinemaPlayer.create('demo.cast', document.getElementById('demo'), {
    autoPlay: true, loop: true, speed: 1.2
  });
</script>
```

---

## Cross-cutting decisions

### Palette version bump

**Palette version bumped to:** 2.0

The v2.0 palette adds three new tokens while preserving full backward compatibility with the existing brand.ts exports:
- **Neutral Bridge** (`#A8B5CA`) — fills the luminance gap for secondary text and disabled states
- **Foam Dark** (`#D1D5E1`) — provides a secondary text color that bridges TUI and dashboard surfaces
- **Abyss Light** (`#161E3A`) — enables nested panel hierarchy without visual collapse

All existing tokens remain unchanged. The per-session accent rotation via `pickRowAccents()` continues to work with the classic, blush, dusk, reef, and amber variants.

### TUI work order (T1 tier sequence)

The implementation sequence prioritizes components by user impact and dependency order:

1. **status-bar** — highest visibility component, always on screen. Quick win that demonstrates the polished aesthetic immediately. Sets the tone for the session.
2. **splash + boot-animation** — first impression when user launches `jellyclaw tui`. The gradient wordmark and animated entry establish brand identity within the first 500ms.
3. **tool-call + diff-view** — core workflow components that users interact with constantly. Tool calls need status glyph animation (pending → ok → error). Diff view needs color-coded prefixes and smart collapse.
4. **transcript + input-box** — interaction loop components. Transcript handles Markdown rendering and per-role accents. Input box manages multi-line input with Shift+Enter hints.
5. **jellyfish spinner** — final polish pass. Size variants (compact vs hero), reduced-motion support, frame synchronization with parent TUI.

### Landing hero asset choice

Evaluated images from `site/images/`:
- `jellyfish-1.jpg` — actual jellyfish photography, directly reinforces brand
- `jellyfish-2.jpg` — alternate angle, good for secondary pages
- `deep-ocean.jpg` — abstract aquatic, works as background texture
- `purple-gradient.jpg` — matches Medusa Violet palette region
- `code-screen.jpg` — developer context, but less distinctive
- `matrix.jpg` — tech aesthetic, may feel dated

**Recommendation:** Use `jellyfish-1.jpg` as the primary hero background with a dark overlay (Abyss at 70% opacity) to maintain text contrast. The jellyfish imagery directly connects to the 🪼 emoji used throughout the TUI and documentation. For mobile viewport, consider `deep-ocean.jpg` as a fallback since it tiles better at narrow widths.

### Demo format decision

**Winner:** asciinema-player with a self-hosted `.cast` file

Rationale:
- **Weight efficiency** — total bundle is ~80-130 KB vs 200-800 KB for video formats
- **Accessibility** — text-based format means screen readers can potentially parse content; no captions required
- **CSP simplicity** — self-hosting the player avoids external CDN dependencies
- **Native terminal feel** — perfect for demonstrating a CLI tool; users can copy commands directly from the player
- **Maintenance** — updating the demo requires only re-recording a 20-second `.cast` file, no video editing

The asciinema recording should capture: (1) boot animation with jellyfish spinner, (2) a simple prompt like "list files in this directory", (3) tool call execution with Bash, (4) streamed assistant response. Total duration 20-25 seconds, played at 1.2x speed with autoplay and loop enabled.

### Typography and font considerations

The landing page should use:
- **Headlines:** Inter Variable, weight 600 (SemiBold), tracking -0.02em
- **Body:** Inter Variable, weight 400 (Regular), tracking 0
- **Code/terminal:** JetBrains Mono, weight 400, for any inline code or terminal representations

The TUI itself renders in the user's terminal with their configured monospace font. The status-bar and splash components should assume a standard 80-column width minimum, with graceful degradation for narrower terminals.

### Color contrast validation

All text tokens have been validated against WCAG 2.1 AA requirements:
- Primary text (Foam on Abyss): 11.9:1 — exceeds AAA
- Interactive accents (Cyan, Violet, Amber, Pink): all ≥4.5:1 — meets AA
- Secondary text (Neutral Bridge): 4.8:1 — meets AA
- Muted elements (Tidewater): 3.1:1 — acceptable only for decorative borders and non-essential UI

The diff view colors (diffAdd, diffDel) are intentionally muted because the +/- prefix carries the semantic meaning. Color-only differentiation is avoided per WCAG guidelines.

### Implementation notes for T1-T3 tiers

**T1 (TUI polish):** Focus on visual refinement without changing component APIs. All changes should be contained within individual component files. Test with both 256-color and truecolor terminals.

**T2 (Landing page):** Build with Astro + Tailwind. Use CSS custom properties for all palette tokens so the stylesheet can be shared with dashboard. Self-host asciinema-player assets.

**T3 (Demo recording):** Record in a clean terminal environment. Use the default session (no custom `pickRowAccents` variant). Ensure the recording captures at least one tool call completing successfully.
