import type {
  Phase,
  Prompt,
  PromptDetail,
  SessionLogEntry,
  Status,
} from '@/types';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let detail = '';
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
  phase: string; // zero-padded string "01"
  subPrompt: string;
  title: string;
  whenToRun: string | null;
  duration: string | null;
  newSession: string | null;
  model: string | null;
  filePath: string;
  status: 'not-started' | 'in-progress' | 'complete';
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
  status: 'not-started' | 'in-progress' | 'complete';
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
  phaseStatus: Record<string, 'not-started' | 'in-progress' | 'complete'>;
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
    phase: Number.parseInt(p.phase, 10),
    subPrompt: p.subPrompt,
    title: p.title,
    whenToRun: p.whenToRun ?? '',
    duration: p.duration ?? '',
    // Backend `newSession` is a nullable string like "yes"/"no" — coerce to bool.
    newSession: p.newSession != null && /^(y|yes|true|1)$/i.test(p.newSession.trim()),
    model: p.model ?? '',
    filePath: p.filePath,
    status: p.status,
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
  const currentPhase =
    s.currentPhase != null ? Number.parseInt(s.currentPhase, 10) : 0;
  // Convert "$42.10" (or plain "42.10") to a number.
  const burnRate = s.burnRateTotal
    ? Number.parseFloat(s.burnRateTotal.replace(/[^0-9.\-]/g, '')) || 0
    : 0;
  // Keep the 3-state enum record — PhaseItem/Header use it.
  const phaseStatus: Record<number, 'not-started' | 'in-progress' | 'complete'> = {};
  for (const [key, val] of Object.entries(s.phaseStatus)) {
    const k = Number.parseInt(key, 10);
    if (Number.isFinite(k)) phaseStatus[k] = val;
  }
  return {
    lastUpdated: s.lastUpdated ?? '',
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
    const env = await request<PromptsEnvelope>('/prompts');
    return env.prompts.map(normalizePrompt);
  },
  async prompt(id: string): Promise<PromptDetail> {
    // Backend route is /api/prompts/:phase/:slug (two path segments).
    // Splitting here — NOT encodeURIComponent on the composite id, which would
    // turn the slash into %2F and 404.
    const [phase, slug] = id.split('/');
    if (!phase || !slug) throw new Error(`Invalid prompt id: ${id}`);
    const raw = await request<RawPromptDetail>(
      `/prompts/${encodeURIComponent(phase)}/${encodeURIComponent(slug)}`,
    );
    return normalizePromptDetail(raw);
  },
  async phases(): Promise<Phase[]> {
    const env = await request<PhasesEnvelope>('/phases');
    return env.phases.map(normalizePhase);
  },
  async status(): Promise<Status> {
    const raw = await request<RawStatus>('/status');
    return normalizeStatus(raw);
  },
};

export const SSE_URL = `${BASE}/events`;
