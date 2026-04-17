import { useEffect, useMemo, useRef, useState } from 'react';
import { useRunLogPoll } from '@/hooks/useRunLogPoll';
import type { RunRecord, RunStatus } from '@/types';
import { cn } from '@/lib/cn';

export interface NowCardProps {
  run: RunRecord | null;
  rigOnline: boolean;
  onAbort: (runId: string) => void;
  onSkip: (runId: string) => void;
  onTell: (runId: string, message: string) => void;
  /**
   * Run id of the currently in-flight run. Separated from `run` because the
   * rig state keys runs by prompt id (`phase/slug`) — the row looks up by
   * id to know which SSE stream to attach.
   */
  runId?: string | null;
  /**
   * Human-readable prompt title from `/api/prompts`. Preferred over the
   * session-id-based fallback. Nullable because some runs (e.g. ad-hoc or
   * pre-boot) don't have a matching prompt row.
   */
  title?: string | null;
}

/**
 * Hero card for the currently-in-flight run. When `run` is null and
 * `rigOnline` is true, renders a muted "Idle — waiting for scheduler"
 * placeholder. When `run` is null and rig is offline, returns null — the
 * upstream <EmptyState /> handles the empty-page case.
 */
export function NowCard({
  run,
  rigOnline,
  onAbort,
  onSkip,
  onTell,
  runId,
  title,
}: NowCardProps) {
  if (!run) {
    if (!rigOnline) return null;
    return (
      <section aria-label="Current run">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-[color:var(--color-gold-bright)] mb-2 px-5">
          Now
        </h2>
        <div className="glass rounded-lg px-5 py-6 text-[12px] text-[color:var(--color-text-muted)] italic">
          Idle — waiting for scheduler.
        </div>
      </section>
    );
  }

  // Resolve the id we bind log-streaming + actions to. Prefer the explicit
  // prop; fall back to session_id (best-effort, may not match the route).
  const boundId = runId ?? run.session_id ?? null;
  const displayTitle = title ?? formatTitle(run);
  const elapsed = run.started_at ? formatElapsed(Date.now() - Date.parse(run.started_at)) : null;

  return (
    <section aria-label="Current run">
      <div className="flex items-baseline justify-between mb-2 px-5">
        <h2 className="font-mono text-[11px] uppercase tracking-[0.3em] text-[color:var(--color-gold-bright)]">
          Now
        </h2>
        {elapsed ? (
          <span className="font-mono text-[11px] tabular-nums text-[color:var(--color-text-muted)]">
            · {elapsed}
          </span>
        ) : null}
      </div>

      <div className="glass rounded-lg px-5 py-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[color:var(--color-gold-bright)] font-mono text-[13px]">▶</span>
          <span className="font-mono text-[12px] text-[color:var(--color-gold-bright)] shrink-0 truncate">
            {boundId ?? run.session_id}
          </span>
          <span className="text-[color:var(--color-text-muted)]/60 shrink-0">·</span>
          <span className="text-[12px] text-[color:var(--color-text)] truncate">{displayTitle}</span>
        </div>

        <PhaseDots status={run.status} />

        <LiveLogTail runId={boundId} status={run.status} />

        <RunActions
          runId={boundId}
          onAbort={onAbort}
          onSkip={onSkip}
          onTell={onTell}
        />
      </div>
    </section>
  );
}

function formatTitle(run: RunRecord): string {
  // Best-effort: derive a human title from session_id if nothing richer.
  const sid = run.session_id ?? '';
  const slug = sid.split('/').pop() ?? sid;
  return slug.replace(/^\d+-/, '').replace(/-/g, ' ');
}

const PHASE_DEFS: Array<{ key: string; label: string }> = [
  { key: 'spawn', label: 'spawn' },
  { key: 'work', label: 'work' },
  { key: 'self', label: 'self' },
  { key: 'test', label: 'test' },
  { key: 'commit', label: 'commit' },
];

function PhaseDots({ status }: { status: RunStatus }) {
  const activeIdx = resolveActiveIdx(status);
  const failed = status === 'failed' || status === 'escalated';

  return (
    <div
      className="flex items-center gap-4"
      role="group"
      aria-label={`phase timeline ${status}`}
    >
      {PHASE_DEFS.map((p, idx) => {
        const state: 'done' | 'active' | 'pending' | 'failed' =
          failed && idx === activeIdx
            ? 'failed'
            : idx < activeIdx
              ? 'done'
              : idx === activeIdx
                ? 'active'
                : 'pending';
        return <PhaseDot key={p.key} label={p.label} state={state} />;
      })}
    </div>
  );
}

function PhaseDot({
  label,
  state,
}: {
  label: string;
  state: 'done' | 'active' | 'pending' | 'failed';
}) {
  const symbol = state === 'done' ? '✓' : state === 'active' ? '●' : state === 'failed' ? '✕' : '○';
  const color =
    state === 'done'
      ? 'var(--color-gold)'
      : state === 'active'
        ? 'var(--color-gold-bright)'
        : state === 'failed'
          ? '#ff5757'
          : 'var(--color-text-muted)';
  return (
    <span
      className={cn(
        'flex items-center gap-1 font-mono text-[11px]',
        state === 'active' && 'pulse-glow motion-reduce:animate-none',
      )}
      style={{ color }}
    >
      <span aria-hidden="true">{symbol}</span>
      <span className="uppercase tracking-[0.15em] text-[10px]">{label}</span>
    </span>
  );
}

function resolveActiveIdx(status: RunStatus): number {
  switch (status) {
    case 'queued':
      return -1;
    case 'spawning':
      return 0;
    case 'prompting':
    case 'working':
    case 'completion_detected':
      return 1;
    case 'testing':
      return 3;
    case 'passed':
    case 'complete':
      return 4;
    case 'retrying':
      return 0;
    case 'failed':
    case 'escalated':
      return 1;
    default:
      return -1;
  }
}

function LiveLogTail({
  runId,
  status,
}: {
  runId: string | null;
  status: RunStatus;
}) {
  const enabled = runId !== null && isActiveStatus(status);
  // 500ms poll of /api/runs/:id — isolates the live terminal from the rest
  // of the page so only the log re-renders, not the whole card.
  const { lines, connected, lineCount } = useRunLogPoll(runId, enabled, 500);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // The dispatcher's tmux log is one giant buffer with embedded ANSI escapes
  // + BEL-delimited warp-notify events (`]777;notify;warp://cli-agent;{…}\x07`).
  // Split those out into human-readable per-event rows so the user can see
  // "Read", "Bash", "Edit" etc. as they happen.
  const tail = useMemo(() => {
    const rows: string[] = [];
    for (const raw of lines) {
      for (const frag of splitLogFragment(raw)) {
        const pretty = prettifyLogRow(frag);
        if (pretty) rows.push(pretty);
      }
    }
    return rows.slice(-300);
  }, [lines]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Respect prefers-reduced-motion — jump instantly, no smooth tween.
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [tail]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-[color:var(--color-text-muted)]">
        <span>Live · tmux log</span>
        <span className="tabular-nums">
          {connected ? '● LIVE · polls 500ms' : enabled ? '○ connecting…' : '— idle'}
          {' · '}
          {tail.length} event{tail.length === 1 ? '' : 's'}
          {lineCount > 1 ? ` · ${lineCount} log lines` : ''}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="rounded-md border hairline bg-[color:var(--color-bg)] px-3 py-2 font-mono text-[11px] leading-[1.5] text-[color:var(--color-text)] overflow-y-auto min-h-[280px] max-h-[420px]"
        aria-live="polite"
        aria-label="Live log tail"
      >
        {tail.length === 0 ? (
          <span className="italic text-[color:var(--color-text-muted)]">
            {enabled
              ? connected
                ? 'Connected — waiting for output…'
                : 'Connecting to log stream…'
              : 'Log stream not active.'}
          </span>
        ) : (
          tail.map((line, i) => (
            <div
              key={`${i}-${line.slice(0, 16)}`}
              className="whitespace-pre-wrap break-all"
            >
              {line || '\u00a0'}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// Strip CSI SGR color codes (but NOT OSC sequences — those carry the
// warp-notify JSON payload we actually want to parse).
const CSI_SGR_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

function splitLogFragment(raw: string): string[] {
  // BEL (\x07) terminates each warp-notify; newlines separate normal output.
  // Split on both; drop empties.
  const parts = raw.split(/[\u0007\n]+/);
  return parts.filter((p) => p.trim().length > 0);
}

/**
 * Turn a raw tmux fragment into a readable one-liner. Warp-notify events
 * become `✓ Read` / `→ prompt_submit` etc.; plain text is stripped of ANSI
 * color codes and passed through.
 *
 * CRITICAL: the OSC sequence that wraps a warp-notify is `\u001b]…\u0007`.
 * We must parse the JSON *before* stripping the OSC wrapper — otherwise a
 * greedy "strip everything between ESC and BEL" regex eats the JSON too and
 * every row becomes empty (the bug that made the live log show 0 lines).
 */
function prettifyLogRow(frag: string): string | null {
  // Try warp-notify FIRST, before any ANSI stripping.
  const warp = frag.match(/warp:\/\/cli-agent;(\{[^\u0007]*?\})/);
  if (warp && warp[1]) {
    try {
      const obj = JSON.parse(warp[1]) as Record<string, unknown>;
      const event = typeof obj.event === 'string' ? obj.event : '?';
      const tool = typeof obj.tool_name === 'string' ? obj.tool_name : undefined;
      if (event === 'tool_complete' && tool) return `✓ ${tool}`;
      if (event === 'tool_start' && tool) return `▶ ${tool}`;
      if (event === 'session_start') return '● session_start';
      if (event === 'session_end') return '○ session_end';
      if (event === 'prompt_submit') return '→ prompt_submit';
      return `· ${event}`;
    } catch {
      // fall through — render as raw (post-ANSI-strip)
    }
  }
  // Plain text path: strip the OSC wrapper + SGR color codes, then display.
  const cleaned = frag
    .replace(/\u001b\][^\u0007]*\u0007?/g, '') // OSC sequences (any content)
    .replace(CSI_SGR_RE, '')
    .trim();
  return cleaned || null;
}

function isActiveStatus(s: RunStatus): boolean {
  return (
    s === 'spawning' ||
    s === 'prompting' ||
    s === 'working' ||
    s === 'completion_detected' ||
    s === 'testing' ||
    s === 'retrying'
  );
}

function RunActions({
  runId,
  onAbort,
  onSkip,
  onTell,
}: {
  runId: string | null;
  onAbort: (runId: string) => void;
  onSkip: (runId: string) => void;
  onTell: (runId: string, message: string) => void;
}) {
  const [tellOpen, setTellOpen] = useState(false);
  const [tellValue, setTellValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (tellOpen) inputRef.current?.focus();
  }, [tellOpen]);

  if (!runId) return null;

  const submitTell = () => {
    const msg = tellValue.trim();
    if (!msg) return;
    onTell(runId, msg);
    setTellValue('');
    setTellOpen(false);
  };

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <GhostButton onClick={() => onAbort(runId)} aria-label="Abort current run">
        abort
      </GhostButton>
      <GhostButton onClick={() => onSkip(runId)} aria-label="Skip current run">
        skip
      </GhostButton>
      {!tellOpen ? (
        <GhostButton onClick={() => setTellOpen(true)} aria-label="Send a message to the worker">
          tell…
        </GhostButton>
      ) : (
        <div className="flex items-center gap-1 flex-1 min-w-[200px]">
          <input
            ref={inputRef}
            value={tellValue}
            onChange={(e) => setTellValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitTell();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setTellOpen(false);
                setTellValue('');
              }
            }}
            placeholder="message for worker…"
            className="flex-1 min-w-0 rounded-md bg-[color:var(--color-bg)] border border-[color:var(--color-gold-subtle)] px-2 py-1 font-mono text-[11px] text-[color:var(--color-text)] outline-none focus:border-[color:var(--color-gold)]"
            aria-label="Message for worker"
          />
          <GhostButton onClick={submitTell}>send</GhostButton>
          <GhostButton
            onClick={() => {
              setTellOpen(false);
              setTellValue('');
            }}
          >
            cancel
          </GhostButton>
        </div>
      )}
    </div>
  );
}

function GhostButton({
  onClick,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2.5 py-1 border border-[color:var(--color-gold-subtle)] text-[11px] font-mono uppercase tracking-[0.15em] text-[color:var(--color-text-muted)] hover:text-[color:var(--color-gold-bright)] hover:border-[color:var(--color-gold)] transition-colors"
      {...rest}
    >
      {children}
    </button>
  );
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) {
    const rs = s % 60;
    return rs === 0 ? `${m}m` : `${m}m ${rs}s`;
  }
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
