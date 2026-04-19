import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { RunRecord } from "@/types";
import { useRunDetail, type RunDetail } from "@/hooks/useRunDetail";
import { cn } from "@/lib/cn";

export interface DoneDetailProps {
  run: RunRecord;
  /** Prompt id — the rig key this row is bound to. */
  runId: string;
}

const TMUX_TAIL = 200;

/**
 * Inline expansion panel for a DONE row. Shows:
 *   - Commit SHA (7ch mono, gold)
 *   - git-diff --stat synthesized client-side from the diff patch
 *   - Test results grid — chips green/red per test
 *   - Session journal — ordered tool-call list (from events.ndjson)
 *   - Collapsed "show log" revealing the last 200 tmux lines
 */
export function DoneDetail({ run, runId }: DoneDetailProps) {
  const { data, isLoading, isError, error } = useRunDetail(runId, true);
  const [logOpen, setLogOpen] = useState(false);

  const sha = run.commit_sha ?? data?.commit_sha ?? null;

  return (
    <div
      className="px-5 py-4 flex flex-col gap-4 border-t hairline bg-[color:var(--color-gold-faint)]/20"
      aria-label={`Run detail ${runId}`}
    >
      <div className="flex items-center gap-4 flex-wrap">
        <Label>commit</Label>
        <span className="font-mono text-[12px] tabular-nums text-[color:var(--color-gold-bright)]">
          {sha ? sha.slice(0, 7) : "—"}
        </span>
        {sha ? (
          <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
            {sha}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <div className="text-[12px] text-[color:var(--color-text-muted)] italic">
          Loading run detail…
        </div>
      ) : isError ? (
        <div className="text-[12px] text-[color:var(--color-danger)]">
          Failed to load: {error instanceof Error ? error.message : String(error)}
        </div>
      ) : data ? (
        <>
          <DiffStat diff={data.diff} />
          <TestGrid run={run} testResults={data.testResults} />
          <Journal events={data.events} run={run} />
          <LogToggle
            open={logOpen}
            onToggle={() => setLogOpen((v) => !v)}
            lines={data.log?.lines ?? []}
          />
        </>
      ) : null}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-text-muted)]">
      {children}
    </span>
  );
}

interface DiffStatResult {
  files: number;
  insertions: number;
  deletions: number;
  fileList: Array<{ path: string; plus: number; minus: number }>;
}

function parseDiffStat(diff: string): DiffStatResult {
  const out: DiffStatResult = {
    files: 0,
    insertions: 0,
    deletions: 0,
    fileList: [],
  };
  if (!diff) return out;
  const lines = diff.split(/\r?\n/);
  const perFile = new Map<string, { plus: number; minus: number }>();
  let currentFile: string | null = null;
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      currentFile = raw.startsWith("b/") ? raw.slice(2) : raw;
      if (currentFile === "/dev/null") currentFile = null;
      else if (currentFile && !perFile.has(currentFile)) {
        perFile.set(currentFile, { plus: 0, minus: 0 });
      }
      continue;
    }
    if (line.startsWith("---")) continue;
    if (line.startsWith("@@")) continue;
    if (!currentFile) continue;
    if (line.startsWith("+")) {
      out.insertions += 1;
      const fc = perFile.get(currentFile);
      if (fc) fc.plus += 1;
    } else if (line.startsWith("-")) {
      out.deletions += 1;
      const fc = perFile.get(currentFile);
      if (fc) fc.minus += 1;
    }
  }
  out.files = perFile.size;
  for (const [filePath, v] of perFile) {
    out.fileList.push({ path: filePath, plus: v.plus, minus: v.minus });
  }
  return out;
}

function DiffStat({ diff }: { diff: string | undefined }) {
  const stat = useMemo(() => parseDiffStat(diff ?? ""), [diff]);

  if (!diff) {
    return (
      <div className="flex flex-col gap-1">
        <Label>diff</Label>
        <span className="font-mono text-[11px] text-[color:var(--color-text-muted)] italic">
          Diff patch not exposed via the current API. See the commit SHA.
        </span>
      </div>
    );
  }

  if (stat.files === 0) {
    return (
      <div className="flex flex-col gap-1">
        <Label>diff</Label>
        <span className="font-mono text-[11px] text-[color:var(--color-text-muted)] italic">
          No files changed.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3 flex-wrap">
        <Label>diff</Label>
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
          {stat.files} file{stat.files === 1 ? "" : "s"} changed
        </span>
        <span className="font-mono text-[11px] tabular-nums" style={{ color: "#5fb75f" }}>
          +{stat.insertions}
        </span>
        <span className="font-mono text-[11px] tabular-nums" style={{ color: "#ff5757" }}>
          -{stat.deletions}
        </span>
      </div>
      <ul className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pr-2">
        {stat.fileList.slice(0, 30).map((f) => (
          <li key={f.path} className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
            <span className="flex-1 min-w-0 truncate text-[color:var(--color-text)]">{f.path}</span>
            <span style={{ color: "#5fb75f" }}>+{f.plus}</span>
            <span style={{ color: "#ff5757" }}>-{f.minus}</span>
          </li>
        ))}
        {stat.fileList.length > 30 ? (
          <li className="font-mono text-[11px] text-[color:var(--color-text-muted)] italic">
            + {stat.fileList.length - 30} more files…
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function TestGrid({ run, testResults }: { run: RunRecord; testResults: RunDetail["testResults"] }) {
  const counts = run.tests;
  const items = testResults ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3 flex-wrap">
        <Label>tests</Label>
        <span className="font-mono text-[11px] tabular-nums" style={{ color: "#5fb75f" }}>
          {counts.passed} passed
        </span>
        {counts.failed > 0 ? (
          <span className="font-mono text-[11px] tabular-nums" style={{ color: "#ff5757" }}>
            {counts.failed} failed
          </span>
        ) : null}
        {counts.pending > 0 ? (
          <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
            {counts.pending} pending
          </span>
        ) : null}
        <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
          · {counts.total} total
        </span>
      </div>
      {items.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((t, i) => (
            <TestChip key={`${i}-${t.name}`} result={t} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TestChip({ result }: { result: NonNullable<RunDetail["testResults"]>[number] }) {
  const passed = result.status === "passed";
  const failed = result.status === "failed";
  const color = passed ? "#5fb75f" : failed ? "#ff5757" : "var(--color-text-muted)";
  return (
    <span
      className="rounded-md px-2 py-0.5 font-mono text-[10px] tabular-nums border"
      style={{ color, borderColor: color }}
      title={result.message ?? result.name}
    >
      {result.name}
    </span>
  );
}

function Journal({ events, run }: { events: RunDetail["events"]; run: RunRecord }) {
  const list = events ?? [];
  if (list.length === 0) {
    // Synthesize a minimal journal from retry_history + final status.
    const retries = run.retry_history;
    if (retries.length === 0) {
      return (
        <div className="flex flex-col gap-1">
          <Label>session journal</Label>
          <span className="font-mono text-[11px] text-[color:var(--color-text-muted)] italic">
            Journal not exposed via the current API.
          </span>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <Label>session journal</Label>
        <ol className="flex flex-col gap-1 list-decimal pl-5 font-mono text-[11px] text-[color:var(--color-text-muted)]">
          {retries.map((r) => (
            <li key={`${r.attempt}-${r.ts}`}>
              retry #{r.attempt} — {r.reason_code}: {r.reason_detail}
            </li>
          ))}
        </ol>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Label>session journal</Label>
      <ol className="flex flex-col gap-1 list-decimal pl-5 font-mono text-[11px] text-[color:var(--color-text-muted)] max-h-56 overflow-y-auto pr-2">
        {list.map((ev, i) => (
          <li key={`${i}-${ev.ts}`}>
            <span className="text-[color:var(--color-gold)]">{ev.kind}</span>
            {ev.tool ? <span> · {ev.tool}</span> : null}
            {ev.detail ? <span> — {ev.detail}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function LogToggle({
  open,
  onToggle,
  lines,
}: {
  open: boolean;
  onToggle: () => void;
  lines: string[];
}) {
  const tail = useMemo(() => lines.slice(-TMUX_TAIL), [lines]);
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="self-start flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.15em] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] transition-colors"
      >
        {open ? (
          <>
            <ChevronUp className="w-3 h-3" /> hide log
          </>
        ) : (
          <>
            <ChevronDown className="w-3 h-3" /> show log ({tail.length})
          </>
        )}
      </button>
      <div
        className={cn(
          "rounded-md border hairline bg-[color:var(--color-bg)] px-3 py-2 font-mono text-[10px] leading-[1.5] text-[color:var(--color-text-muted)] overflow-auto transition-[max-height,opacity] duration-200 ease-out motion-reduce:transition-opacity",
          open ? "max-h-[420px] opacity-100" : "max-h-0 opacity-0 pointer-events-none",
        )}
      >
        {tail.map((line, i) => (
          <div key={`${i}-${line.slice(0, 16)}`} className="whitespace-pre-wrap break-words">
            {line}
          </div>
        ))}
        {tail.length === 0 ? <span className="italic">No log output.</span> : null}
      </div>
    </div>
  );
}
