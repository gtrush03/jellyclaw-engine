# Phase 15 — Desktop App MVP — Prompt 04: Core UI shell (3-pane + Obsidian & Gold)

**When to run:** After prompt 03 is marked ✅ in Phase 15 Notes. Wish dispatch + SSE stream should be verified working against raw JSON.
**Estimated duration:** 8–10 hours
**New session?** Yes — start a fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `15` and `<name>` with `desktop-mvp`.

---

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/desktop/SPEC.md` — confirm the Obsidian & Gold tokens and the 3-pane layout ratios.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/shared/src/events.ts` — every variant we must visualize.
3. Re-read `desktop/src/state/useEngineStore.ts` and `desktop/src/hooks/useWish.ts` from prompt 03 — UI consumes these.
4. WebFetch:
   - `https://tailwindcss.com/blog/tailwindcss-v4` — `@theme` directive, CSS-first config, the vite plugin
   - `https://react.dev/blog/2024/12/05/react-19` — `useOptimistic`, Action functions, `useActionState`
   - `https://virtuoso.dev/` — `Virtuoso` and `followOutput="auto"` for autoscroll
   - `https://shiki.style/guide/install` — `createHighlighter`, custom themes
   - `https://sonner.emilkowal.ski/` — `Toaster` + `toast()` call patterns
5. Study the layout at `/Users/gtrush/Downloads/NYC/index.html` if present — same Obsidian & Gold family.

## Implementation task

Build the 3-pane desktop UI: Sidebar (260px) + Main timeline (flex) + Inspector (380px collapsible). Wire to the hooks from prompt 03. Render every event variant the spec defines, with gold-accented glass panels, a cost meter, virtualized timeline, and the wish input at the bottom. Approval modal is a stub (real hooks in Phase 16).

### Files to create/modify

- `desktop/src/styles.css` — full `@theme` token set + base reset + glass utilities
- `desktop/src/App.tsx` — 3-pane grid + providers (QueryClient, Toaster)
- `desktop/src/components/layout/Shell.tsx` — grid shell
- `desktop/src/components/sidebar/Sidebar.tsx` — sessions list, search, "New wish"
- `desktop/src/components/timeline/Timeline.tsx` — `Virtuoso` rendering `EventCard`
- `desktop/src/components/timeline/EventCard.tsx` — discriminated-union renderer
- `desktop/src/components/timeline/ToolCallCard.tsx` — collapsible tool call
- `desktop/src/components/timeline/ApprovalBanner.tsx` — Allow/Deny/Rewrite
- `desktop/src/components/timeline/ApprovalModal.tsx` — modal stub
- `desktop/src/components/inspector/Inspector.tsx` — selected event details
- `desktop/src/components/meter/CostMeter.tsx` — tier-colored progress
- `desktop/src/components/input/WishInput.tsx` — textarea + mic + attach + ⌘↵
- `desktop/src/lib/shiki.ts` — Shiki highlighter bootstrap with Obsidian theme
- `desktop/src/themes/obsidian-gold.json` — Shiki TextMate theme
- `desktop/src/hooks/useKeybinds.ts` — ⌘-/, ⌘-N (⌘-K deferred)

### Prerequisites check

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm ls react-virtuoso sonner shiki  # present
pnpm tauri dev &
sleep 10
# Confirm prompt 03's smoke test still logs AgentEvent JSON
```

### Step-by-step implementation

1. Replace `src/styles.css` with full theme tokens (below).
2. Write `Shell.tsx` using CSS grid.
3. Wrap `App.tsx` in `QueryClientProvider` + `<Toaster richColors theme="dark" />`.
4. Implement `Sidebar.tsx` — list from `useEngineStore(s => s.sessions)`; "New wish" calls `api.createSession` via mutation and sets `activeWishId`.
5. Implement `Timeline.tsx` — `Virtuoso` over `events`, `followOutput="auto"`, render `<EventCard event={e} />`.
6. Implement `EventCard.tsx` — switch on `event.type`, delegate to sub-components.
7. Implement `ToolCallCard.tsx` — collapsible, highlight args JSON with Shiki.
8. Implement `Inspector.tsx` — shows the clicked event's full JSON + timing + cost.
9. Implement `CostMeter.tsx` — gradient bar with tier colors.
10. Implement `WishInput.tsx` — textarea, `Cmd+Enter` to submit, emit dispatch.
11. Implement `useKeybinds.ts` for `⌘-N` (new wish) and `⌘-/` (focus input).
12. Wire `sonner` toasts: wish complete, wish errored, engine restarted, 80% budget warning (subscribe to store).

### Key code (React 19 + TSX — not stubs)

`desktop/src/styles.css`:

```css
@import "tailwindcss";

@theme {
  --color-bg:             #050505;
  --color-surface:        rgba(15, 15, 15, 0.6);
  --color-surface-hover:  rgba(22, 22, 22, 0.75);
  --color-gold:           #928466;
  --color-gold-bright:    #c4b080;
  --color-gold-subtle:    rgba(146, 132, 102, 0.2);
  --color-gold-border:    rgba(146, 132, 102, 0.15);
  --color-text:           #e8e6e1;
  --color-text-muted:     #6b6760;
  --color-danger:         #b54a3a;
  --color-warn:           #c18b3b;
  --color-ok:             #6a8a5c;
  --radius-card: 14px;
  --blur-glass: 40px;
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
}

html, body, #root { height: 100%; background: var(--color-bg); color: var(--color-text); font-family: var(--font-sans); }
::selection { background: var(--color-gold-subtle); color: var(--color-gold-bright); }

@utility glass {
  background: var(--color-surface);
  backdrop-filter: blur(var(--blur-glass));
  -webkit-backdrop-filter: blur(var(--blur-glass));
  border: 1px solid var(--color-gold-border);
  border-radius: var(--radius-card);
}
@utility glass-hover { @apply glass; &:hover { background: var(--color-surface-hover); } }
```

`desktop/src/components/layout/Shell.tsx`:

```tsx
import { PropsWithChildren, useState } from "react";
import { Sidebar } from "@/components/sidebar/Sidebar";
import { Timeline } from "@/components/timeline/Timeline";
import { Inspector } from "@/components/inspector/Inspector";
import { WishInput } from "@/components/input/WishInput";
import { CostMeter } from "@/components/meter/CostMeter";

export function Shell({ children }: PropsWithChildren) {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  return (
    <div className="h-screen grid bg-[var(--color-bg)] text-[var(--color-text)]"
         style={{ gridTemplateColumns: `260px 1fr ${inspectorOpen ? "380px" : "0px"}` }}>
      <aside className="border-r border-[var(--color-gold-border)] overflow-hidden"><Sidebar /></aside>
      <main className="flex flex-col overflow-hidden">
        <header className="h-10 px-4 flex items-center justify-between border-b border-[var(--color-gold-border)]">
          <span className="text-xs uppercase tracking-[0.2em] text-[var(--color-gold)]">Jellyclaw</span>
          <CostMeter />
          <button onClick={() => setInspectorOpen((v) => !v)}
                  className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-gold)]">
            {inspectorOpen ? "hide inspector" : "show inspector"}
          </button>
        </header>
        <div className="flex-1 overflow-hidden"><Timeline /></div>
        <div className="border-t border-[var(--color-gold-border)] p-3"><WishInput /></div>
      </main>
      {inspectorOpen && <aside className="border-l border-[var(--color-gold-border)] overflow-hidden"><Inspector /></aside>}
      {children}
    </div>
  );
}
```

`desktop/src/components/timeline/Timeline.tsx`:

```tsx
import { Virtuoso } from "react-virtuoso";
import { useEngineStore } from "@/state/useEngineStore";
import { EventCard } from "./EventCard";

export function Timeline() {
  const events = useEngineStore((s) => s.events);
  return (
    <Virtuoso
      data={events}
      followOutput="auto"
      increaseViewportBy={{ top: 400, bottom: 400 }}
      itemContent={(i, e) => <div className="px-6 py-2"><EventCard event={e} index={i} /></div>}
      className="h-full"
    />
  );
}
```

`desktop/src/components/timeline/EventCard.tsx`:

```tsx
import type { AgentEvent } from "@jellyclaw/shared";
import { ToolCallCard } from "./ToolCallCard";
import { ApprovalBanner } from "./ApprovalBanner";

export function EventCard({ event, index }: { event: AgentEvent; index: number }) {
  switch (event.type) {
    case "text_delta":
      return <p className="font-sans text-[15px] leading-relaxed">
               {event.text}<span className="ml-0.5 animate-pulse text-[var(--color-gold)]">▍</span>
             </p>;
    case "thinking_delta":
      return <p className="italic text-[var(--color-text-muted)] text-sm">{event.text}</p>;
    case "tool_call_start":
    case "tool_call_end":
      return <ToolCallCard event={event} />;
    case "subagent_start":
      return <div className="pl-4 border-l-2 border-[var(--color-gold-subtle)]">
               <span className="text-xs uppercase tracking-widest text-[var(--color-gold)]">→ subagent: {event.name}</span>
             </div>;
    case "subagent_end":
      return <div className="pl-4 border-l-2 border-[var(--color-gold-subtle)] text-xs text-[var(--color-text-muted)]">
               ← {event.name} ({event.summary})
             </div>;
    case "approval_request":
      return <ApprovalBanner event={event} />;
    case "error":
      return <div className="glass p-3 border-[var(--color-danger)] text-[var(--color-danger)]">
               <strong>error:</strong> {event.message}
             </div>;
    default:
      return null;
  }
}
```

`desktop/src/components/timeline/ToolCallCard.tsx`:

```tsx
import { useState, useEffect } from "react";
import { getHighlighter } from "@/lib/shiki";
import type { AgentEvent } from "@jellyclaw/shared";

export function ToolCallCard({ event }: { event: AgentEvent }) {
  const [open, setOpen] = useState(false);
  const [html, setHtml] = useState("");
  const isStart = event.type === "tool_call_start";

  useEffect(() => {
    if (!open) return;
    const payload = isStart ? (event as any).args : (event as any).result;
    (async () => {
      const hl = await getHighlighter();
      setHtml(hl.codeToHtml(JSON.stringify(payload, null, 2),
        { lang: "json", theme: "obsidian-gold" }));
    })();
  }, [open]);

  return (
    <div className="glass my-2 overflow-hidden">
      <button onClick={() => setOpen((v) => !v)}
              className="w-full flex items-center justify-between px-4 py-2 text-left">
        <span className="text-[var(--color-gold)] font-mono text-sm">
          {isStart ? "▶" : "◼"} {(event as any).tool_name}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {(event as any).duration_ms ? `${(event as any).duration_ms}ms` : ""}
          {(event as any).cost_usd ? ` · $${(event as any).cost_usd.toFixed(4)}` : ""}
        </span>
      </button>
      {open && <div className="px-4 pb-3 text-sm" dangerouslySetInnerHTML={{ __html: html }} />}
    </div>
  );
}
```

`desktop/src/components/meter/CostMeter.tsx`:

```tsx
import { useEngineStore } from "@/state/useEngineStore";
import { useMemo } from "react";

export function CostMeter() {
  const total = useEngineStore((s) => s.totalCostUsd);
  const budget = 5;
  const pct = Math.min(100, (total / budget) * 100);
  const color = useMemo(() => {
    if (pct < 50)  return "var(--color-ok)";
    if (pct < 80)  return "var(--color-gold)";
    if (pct < 95)  return "var(--color-warn)";
    return "var(--color-danger)";
  }, [pct]);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-[var(--color-text-muted)]">${total.toFixed(3)} / ${budget}</span>
      <div className="w-32 h-1 rounded bg-[var(--color-gold-subtle)] overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
```

`desktop/src/components/input/WishInput.tsx`:

```tsx
import { useRef, useState, useTransition } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useEngineStore } from "@/state/useEngineStore";
import { toast } from "sonner";

export function WishInput() {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const { engineUrl, authToken, setActive } = useEngineStore();

  const dispatch = useMutation({
    mutationFn: async (prompt: string) => {
      if (!engineUrl || !authToken) throw new Error("engine not ready");
      return api.createSession(engineUrl, authToken, { prompt, turnsMax: 20, costMaxUsd: 5 });
    },
    onSuccess: (s) => { setActive(s.id); setText(""); toast.success("wish dispatched"); },
    onError: (e) => toast.error(`dispatch failed: ${(e as Error).message}`),
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); start(() => dispatch.mutate(text)); }}>
      <textarea ref={ref} value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dispatch.mutate(text); } }}
        rows={3} placeholder="Make a wish…  (⌘↵ to submit)"
        className="w-full glass px-4 py-3 font-sans text-[15px] resize-none focus:outline-none focus:border-[var(--color-gold)] disabled:opacity-60"
        disabled={pending || dispatch.isPending} />
      <div className="flex items-center justify-between mt-2 text-xs text-[var(--color-text-muted)]">
        <div className="flex gap-3">
          <button type="button" className="hover:text-[var(--color-gold)]">🎤 voice</button>
          <button type="button" className="hover:text-[var(--color-gold)]">📎 attach</button>
        </div>
        <span>⌘↵ submit</span>
      </div>
    </form>
  );
}
```

`desktop/src/lib/shiki.ts`:

```ts
import { createHighlighter, type Highlighter } from "shiki";
import theme from "@/themes/obsidian-gold.json";

let hl: Highlighter | null = null;
export async function getHighlighter() {
  if (hl) return hl;
  hl = await createHighlighter({ themes: [theme as any], langs: ["json", "ts", "bash", "md"] });
  return hl;
}
```

`desktop/src/themes/obsidian-gold.json` (abbreviated — full TextMate JSON in the commit):

```json
{
  "name": "obsidian-gold", "type": "dark",
  "colors": { "editor.background": "#050505", "editor.foreground": "#e8e6e1" },
  "tokenColors": [
    { "scope": ["string"],                    "settings": { "foreground": "#c4b080" } },
    { "scope": ["keyword","storage.type"],    "settings": { "foreground": "#928466" } },
    { "scope": ["comment"],                   "settings": { "foreground": "#6b6760", "fontStyle": "italic" } },
    { "scope": ["constant.numeric","constant.language"], "settings": { "foreground": "#b54a3a" } },
    { "scope": ["support.type","entity.name"], "settings": { "foreground": "#e8e6e1" } }
  ]
}
```

`desktop/src/App.tsx`:

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { qc } from "@/lib/queryClient";
import { Shell } from "@/components/layout/Shell";
import { useEngineUrl } from "@/hooks/useEngineUrl";
import { useKeybinds } from "@/hooks/useKeybinds";

export default function App() {
  useEngineUrl();     // bootstrap engine URL into store
  useKeybinds();
  return (
    <QueryClientProvider client={qc}>
      <Toaster theme="dark" richColors position="bottom-right" />
      <Shell />
    </QueryClientProvider>
  );
}
```

### Tests to add

- `desktop/src/components/timeline/EventCard.test.tsx` — snapshot every event variant
- `desktop/src/components/meter/CostMeter.test.tsx` — tier color at 0, 49, 50, 79, 80, 94, 95, 100%
- `desktop/src/components/input/WishInput.test.tsx` — ⌘↵ triggers mutation, textarea clears on success
- Visual: a manual screenshot in `desktop/tests/screenshots/timeline-smoke.png` compared against a baseline

### Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm typecheck
pnpm test
pnpm tauri dev
# Click "New wish", type "hello", ⌘↵.
# Expect: streaming text appears in gold-accented cards in the timeline.
# Cost meter ticks up. Click a tool-call card → JSON expands with syntax highlight.
# Click inspector toggle → pane hides/reveals.
```

### Common pitfalls

- **Tailwind v4 does not support `tailwind.config.js`.** All theme tokens live in `@theme {}` inside a CSS file imported after `@import "tailwindcss";`.
- **Virtuoso `followOutput="auto"` only autoscrolls when the user is near the bottom** — this is correct behavior; don't force scroll or users can't read history.
- **Shiki ships ~2MB of WASM.** Import lazily inside `getHighlighter` (not at module top) and cache.
- **`dangerouslySetInnerHTML` with Shiki output is safe** because Shiki outputs sanitized HTML from structured tokens — but if you ever interpolate user text into the pre-highlight source, escape first.
- **`useMutation` in React Query v5 is synchronous-return**; `mutateAsync` returns a promise. Prefer `mutate` + `onSuccess/onError` for this UI.
- **Z-index & backdrop-blur collaborate poorly on Windows WebView2.** Test on Windows before Phase 16 if you care.
- **`useTransition` wraps `dispatch.mutate(...)` which is fire-and-forget** — the pending flag reflects React transition, not the mutation. Both flags (`pending || dispatch.isPending`) should gate the disabled state.

### Why this matters

This is the *surface* users actually see — the gold-on-obsidian aesthetic is the brand, and a fumbled event renderer (missing tool-call duration, no cost meter, laggy scroll) makes Jellyclaw feel like a prototype rather than a product. Virtualization and deliberate tier colors are what make the difference between "works for 3 events" and "works for a 4-hour coding session with 40k events."

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md` with `<NN>` = `15`, sub-prompt = `04-core-ui-shell`.

Only `05-macos-dmg-build-and-sign.md` marks Phase 15 ✅. Update Notes with `04-core-ui-shell ✅`.
