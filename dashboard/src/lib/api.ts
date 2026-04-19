import type {
  Phase,
  Prompt,
  PromptDetail,
  RigProcessStatus,
  RigState,
  SessionLogEntry,
  Status,
} from "@/types";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`${res.status} ${res.statusText}: ${detail || path}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Backend envelope shapes (what the server actually emits on the wire).
// Kept local to this file — only api.ts is allowed to speak these.
// ---------------------------------------------------------------------------

interface RawPrompt {
  id: string;
  phase: string; // "01" / "10.5" / "99b-unfucking-v2"
  subPrompt: string;
  title: string;
  whenToRun: string | null;
  duration: string | null;
  newSession: string | null;
  model: string | null;
  filePath: string;
  status: "not-started" | "in-progress" | "complete";
  // --- Optional autobuild-frontmatter passthrough (only present on
  //     phase-99b-unfucking-v2 prompts). Must flow through the normalizer. ---
  tier?: 0 | 1 | 2 | 3 | 4;
  scope?: string[];
  tests?: unknown[];
  depends_on_fix?: string[];
  human_gate?: boolean;
  max_turns?: number;
  max_cost_usd?: number;
  max_retries?: number;
  estimated_duration_min?: number;
}

interface RawPromptDetail extends RawPrompt {
  assembled: string;
}

interface RawPhase {
  phase: string;
  name: string;
  duration: string;
  depends_on: number[];
  blocks: number[];
  promptCount: number;
  promptsCompleted: number;
  status: "not-started" | "in-progress" | "complete";
}

interface RawSessionLogRow {
  date: string;
  sessionNumber: string;
  phase: string;
  subPrompt: string;
  outcome: string;
}

interface RawStatus {
  lastUpdated: string | null;
  currentPhase: string | null;
  progressPercent: number;
  testsPassing: number;
  testsFailing: number;
  burnRateTotal: string | null;
  blockers: string[];
  phaseStatus: Record<string, "not-started" | "in-progress" | "complete">;
  sessionLog: RawSessionLogRow[];
}

interface PromptsEnvelope {
  prompts: RawPrompt[];
  count: number;
}

interface PhasesEnvelope {
  phases: RawPhase[];
  count: number;
}

// ---------------------------------------------------------------------------
// Normalizers — convert wire shape → frontend types. Only place that does this.
// ---------------------------------------------------------------------------

function normalizePrompt(p: RawPrompt): Prompt {
  return {
    id: p.id,
    // Numeric phase for back-compat with existing components that expect a
    // number (legacy phase grid). Non-numeric suffixes like "99b-…" silently
    // collapse to 99 here — that's why we ALSO keep the raw `phaseId`.
    phase: Number.parseInt(p.phase, 10),
    phaseId: p.phase,
    subPrompt: p.subPrompt,
    title: p.title,
    whenToRun: p.whenToRun ?? "",
    duration: p.duration ?? "",
    // Backend `newSession` is a nullable string like "yes"/"no" — coerce to bool.
    newSession: p.newSession != null && /^(y|yes|true|1)$/i.test(p.newSession.trim()),
    model: p.model ?? "",
    filePath: p.filePath,
    status: p.status,
    // Pass-through the autobuild rig fields — previously dropped here, which
    // is why `<TierProgressTrack>` always rendered 0/0 and `PromptCard` never
    // showed tier badges on phase-99b prompts.
    tier: p.tier,
    scope: p.scope,
    tests: p.tests as Prompt["tests"],
    depends_on_fix: p.depends_on_fix,
    human_gate: p.human_gate,
    max_turns: p.max_turns,
    max_cost_usd: p.max_cost_usd,
    max_retries: p.max_retries,
    estimated_duration_min: p.estimated_duration_min,
  };
}

function normalizePromptDetail(p: RawPromptDetail): PromptDetail {
  return {
    ...normalizePrompt(p),
    // PromptViewer reads `.body` — point it at the assembled prompt.
    body: p.assembled,
    rawBody: p.assembled,
  };
}

function normalizePhase(p: RawPhase): Phase {
  return {
    phase: Number.parseInt(p.phase, 10),
    phaseId: p.phase,
    name: p.name,
    duration: p.duration,
    dependsOn: p.depends_on,
    blocks: p.blocks,
    promptCount: p.promptCount,
    promptsCompleted: p.promptsCompleted,
    status: p.status,
  };
}

function normalizeSessionLog(r: RawSessionLogRow): SessionLogEntry {
  const sessionNum = Number.parseInt(r.sessionNumber, 10);
  const phaseNum = Number.parseInt(r.phase, 10);
  return {
    date: r.date,
    session: Number.isFinite(sessionNum) ? sessionNum : 0,
    phase: Number.isFinite(phaseNum) ? phaseNum : 0,
    subPrompt: r.subPrompt,
    outcome: r.outcome,
  };
}

function normalizeStatus(s: RawStatus): Status {
  const currentPhase = s.currentPhase != null ? Number.parseInt(s.currentPhase, 10) : 0;
  // Convert "$42.10" (or plain "42.10") to a number.
  const burnRate = s.burnRateTotal
    ? Number.parseFloat(s.burnRateTotal.replace(/[^0-9.\-]/g, "")) || 0
    : 0;
  // Keep the 3-state enum record — PhaseItem/Header use it.
  const phaseStatus: Record<number, "not-started" | "in-progress" | "complete"> = {};
  for (const [key, val] of Object.entries(s.phaseStatus)) {
    const k = Number.parseInt(key, 10);
    if (Number.isFinite(k)) phaseStatus[k] = val;
  }
  return {
    lastUpdated: s.lastUpdated ?? "",
    currentPhase: Number.isFinite(currentPhase) ? currentPhase : 0,
    progressPercent: s.progressPercent,
    testsPassing: s.testsPassing,
    testsFailing: s.testsFailing,
    burnRateTotal: burnRate,
    blockers: s.blockers,
    phaseStatus,
    sessionLog: s.sessionLog.map(normalizeSessionLog),
  };
}

// ---------------------------------------------------------------------------
// Public API — hooks call these, they return already-normalized shapes.
// ---------------------------------------------------------------------------

export const api = {
  async prompts(): Promise<Prompt[]> {
    const env = await request<PromptsEnvelope>("/prompts");
    return env.prompts.map(normalizePrompt);
  },
  async prompt(id: string): Promise<PromptDetail> {
    // Backend route is /api/prompts/:phase/:slug (two path segments).
    // Splitting here — NOT encodeURIComponent on the composite id, which would
    // turn the slash into %2F and 404.
    const [phase, slug] = id.split("/");
    if (!phase || !slug) throw new Error(`Invalid prompt id: ${id}`);
    const raw = await request<RawPromptDetail>(
      `/prompts/${encodeURIComponent(phase)}/${encodeURIComponent(slug)}`,
    );
    return normalizePromptDetail(raw);
  },
  async phases(): Promise<Phase[]> {
    const env = await request<PhasesEnvelope>("/phases");
    return env.phases.map(normalizePhase);
  },
  async status(): Promise<Status> {
    const raw = await request<RawStatus>("/status");
    return normalizeStatus(raw);
  },
  /**
   * Autobuild rig snapshot. Backend emits the shape described in `RigState`
   * (see `src/types.ts`). No normalization is needed because the schema is
   * native — we round-trip it as-is.
   */
  async runs(): Promise<RigState> {
    return request<RigState>("/runs");
  },
  /**
   * Dispatch an operator action on a run (abort / approve / retry / skip).
   * Response shape is informational — we only care that it 2xxs.
   */
  async runAction(
    runId: string,
    action: "abort" | "approve" | "retry" | "skip" | "approve-anyway",
    body?: Record<string, unknown>,
  ): Promise<{ ok: true } | Record<string, unknown>> {
    const [phase, slug] = runId.split("/");
    if (!phase || !slug) throw new Error(`Invalid run id: ${runId}`);
    return request(`/runs/${encodeURIComponent(phase)}/${encodeURIComponent(slug)}/action`, {
      method: "POST",
      body: JSON.stringify({ action, ...(body ?? {}) }),
    });
  },
  /**
   * Autobuild rig process supervision — backed by the sibling `rig-control.ts`
   * route. Returns `{running, pid, since, log_path?}`. When the route is
   * missing (older server), the request throws and the caller should treat
   * the rig as "unknown" — `useRigProcess` falls back to `rig_process` from
   * the main /runs snapshot.
   */
  async rigRunning(): Promise<RigProcessStatus> {
    return request<RigProcessStatus>("/rig/running");
  },
  /**
   * Start the autobuild rig daemon.
   *   - 200 → `{running: true, pid, since}`
   *   - 409 → already running (we surface this as a toast in the mutation hook)
   */
  async rigStart(): Promise<RigProcessStatus> {
    return request<RigProcessStatus>("/rig/start", { method: "POST" });
  },
  async rigStop(): Promise<RigProcessStatus & { stopped_at?: string }> {
    return request("/rig/stop", { method: "POST" });
  },
  /** One-shot tick — runs a single scheduler pass regardless of daemon state. */
  async rigTick(): Promise<Record<string, unknown>> {
    return request("/rig/tick", { method: "POST" });
  },
  /**
   * Wipe `.autobuild/state.json` back to an empty skeleton and remove every
   * per-session directory under `.autobuild/sessions/`. `.autobuild/queue.json`
   * is preserved on purpose — after reset, pressing Start replays the same queue.
   *
   * Rejects with 409 when the rig is running; callers must stop the rig first.
   */
  async rigReset(): Promise<{ ok: true; reset_at: string }> {
    // Must send an explicit `{}` body. The server treats a JSON content-type
    // with an empty body as malformed and 400s (bad_request). A curl without
    // Content-Type works; a browser fetch always sets one through `request()`.
    return request("/rig/reset", { method: "POST", body: JSON.stringify({}) });
  },
};

export const SSE_URL = `${BASE}/events`;

/** SSE endpoint for per-run log tailing (opened lazily by `useRunLog`).
 *
 * Run ids are the rig's choice. Legacy ids looked like `phase/slug`; current
 * autobuild ids look like `T0-02-serve-reads-credentials` (no slash). We
 * encode the whole id as a single path segment — any `/` inside becomes
 * `%2F`, which the server's `RunIdParam` regex then rejects (by design — ids
 * shouldn't contain slashes). */
export function runEventsUrl(runId: string): string {
  const trimmed = runId.trim();
  if (trimmed.length === 0) throw new Error(`Invalid run id: ${runId}`);
  return `${BASE}/runs/${encodeURIComponent(trimmed)}/events`;
}
