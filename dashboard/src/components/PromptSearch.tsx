import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChangeEvent } from "react";

export type PromptStatus = "not-started" | "in-progress" | "complete";

export interface SearchablePrompt {
  id: string;
  phaseName: string;
  title: string;
  whenToRun: string;
  status: PromptStatus;
}

export interface PromptSearchHandle {
  focus: () => void;
  clear: () => void;
}

export interface PromptSearchProps {
  prompts: ReadonlyArray<SearchablePrompt>;
  onResults: (results: ReadonlyArray<SearchablePrompt>) => void;
  className?: string;
  placeholder?: string;
}

/**
 * Tiny fuzzy matcher: returns a score in [0,1] if all chars of `query` appear
 * in `target` in order, weighted by density + start-of-word bonus. Returns -1 otherwise.
 * Fuse.js-free.
 */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.includes(q)) {
    // Exact substring gets a strong score, boosted if at start of a word
    const idx = t.indexOf(q);
    const wordStart = idx === 0 || /\s|[-_/]/.test(t[idx - 1] ?? "");
    return 0.9 + (wordStart ? 0.1 : 0);
  }

  let ti = 0;
  let matches = 0;
  let lastMatch = -1;
  let gapPenalty = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === ch) {
        found = j;
        break;
      }
    }
    if (found === -1) return -1;
    if (lastMatch !== -1) gapPenalty += found - lastMatch - 1;
    lastMatch = found;
    ti = found + 1;
    matches++;
  }
  const density = matches / (matches + gapPenalty);
  return Math.max(0.05, Math.min(0.85, density));
}

function scorePrompt(query: string, p: SearchablePrompt): number {
  if (!query) return 1;
  const s1 = fuzzyScore(query, p.title);
  const s2 = fuzzyScore(query, p.phaseName);
  const s3 = fuzzyScore(query, p.whenToRun);
  return Math.max(s1, s2 * 0.85, s3 * 0.7);
}

const STATUS_FILTERS: ReadonlyArray<{ id: PromptStatus | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "not-started", label: "Not started" },
  { id: "in-progress", label: "In progress" },
  { id: "complete", label: "Complete" },
];

export const PromptSearch = forwardRef<PromptSearchHandle, PromptSearchProps>(
  function PromptSearch(
    { prompts, onResults, className = "", placeholder = "Search prompts…" },
    ref,
  ) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [query, setQuery] = useState<string>("");
    const [statusFilter, setStatusFilter] = useState<PromptStatus | "all">("all");

    useImperativeHandle(
      ref,
      () => ({
        focus: () => inputRef.current?.focus(),
        clear: () => {
          setQuery("");
          setStatusFilter("all");
        },
      }),
      [],
    );

    const filtered = useMemo(() => {
      const byStatus =
        statusFilter === "all"
          ? prompts
          : prompts.filter((p) => p.status === statusFilter);
      if (!query.trim()) return byStatus;
      return byStatus
        .map((p) => ({ p, score: scorePrompt(query.trim(), p) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p);
    }, [prompts, query, statusFilter]);

    // Propagate results upward
    const lastResultsRef = useRef<ReadonlyArray<SearchablePrompt> | null>(null);
    if (lastResultsRef.current !== filtered) {
      lastResultsRef.current = filtered;
      queueMicrotask(() => onResults(filtered));
    }

    const handleChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
      setQuery(e.target.value);
    }, []);

    return (
      <div
        className={`sticky top-0 z-10 flex flex-col gap-2 px-3 py-2 ${className}`}
        style={{
          background: "rgba(5, 5, 5, 0.8)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(146,132,102,0.15)",
        }}
      >
        <label className="relative block">
          <span className="sr-only">Search prompts</span>
          <svg
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
          >
            <circle cx="7" cy="7" r="5" fill="none" stroke="#928466" strokeWidth="1.4" />
            <path d="M11 11 L14 14" stroke="#928466" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            inputMode="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={handleChange}
            placeholder={placeholder}
            className="w-full rounded-lg py-1.5 pl-8 pr-16 text-sm outline-none transition-colors"
            style={{
              background: "rgba(146,132,102,0.05)",
              border: "1px solid rgba(146,132,102,0.25)",
              color: "#e8e6e1",
              fontFamily: "Inter, ui-sans-serif",
            }}
          />
          <kbd
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-[10px]"
            style={{
              color: "rgba(232,230,225,0.5)",
              background: "rgba(146,132,102,0.08)",
              border: "1px solid rgba(146,132,102,0.2)",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          >
            ⌘K
          </kbd>
        </label>

        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setStatusFilter(f.id)}
                className="rounded-full px-2.5 py-0.5 text-[10px] uppercase tracking-wider transition-all"
                style={{
                  background: active
                    ? "rgba(146,132,102,0.2)"
                    : "rgba(146,132,102,0.04)",
                  color: active ? "#d4bf8f" : "rgba(232,230,225,0.55)",
                  border: active
                    ? "1px solid rgba(146,132,102,0.6)"
                    : "1px solid rgba(146,132,102,0.15)",
                }}
                aria-pressed={active}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);

export default PromptSearch;
