/**
 * Integration tests — hit the live backend at 127.0.0.1:5174.
 *
 * PRECONDITION: the backend must be running. Launch with:
 *
 *   cd dashboard/server && PORT=5174 npm run dev
 *
 * Or start the whole dashboard stack (which also starts the backend):
 *
 *   cd dashboard && ./start.sh
 *
 * These tests read from the real jellyclaw-engine repo (20 phases, ~63 prompts)
 * and assert the backend shape matches the frontend's expectations.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  PromptsListResponseSchema,
  PromptDetailSchema,
  PhasesListResponseSchema,
  StatusSchema,
} from '../../src/lib/api-validation.js';

const API = process.env.JC_API_BASE ?? 'http://127.0.0.1:5174/api';

async function waitForBackend(retries = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${API}/prompts-health`);
      if (res.ok) return;
    } catch {
      // keep retrying
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`backend did not come up at ${API} within ${retries * delayMs}ms`);
}

beforeAll(async () => {
  await waitForBackend();
}, 30_000);

describe('GET /api/prompts', () => {
  it('returns the envelope with the prompts list', async () => {
    const res = await fetch(`${API}/prompts`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = PromptsListResponseSchema.parse(body);
    expect(parsed.count).toBeGreaterThan(0);
    expect(parsed.prompts.length).toBe(parsed.count);
    // We expect something in the 60–80 range based on the current repo.
    expect(parsed.prompts.length).toBeGreaterThanOrEqual(60);
  });
});

describe('GET /api/prompts/:phase/:slug', () => {
  it('returns an assembled prompt with startup + completion templates embedded', async () => {
    // Use a prompt we know exists.
    const res = await fetch(`${API}/prompts/phase-01/01-research`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = PromptDetailSchema.parse(body);
    expect(parsed.assembled.length).toBeGreaterThan(200);
    // The assembler stitches the startup + closeout templates with `---` dividers
    // surrounding the body.
    expect(parsed.assembled).toContain('---');
  });

  it('returns 404 for non-existent prompts', async () => {
    const res = await fetch(`${API}/prompts/phase-00/99-does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/phases', () => {
  it('returns 20 phases', async () => {
    const res = await fetch(`${API}/phases`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = PhasesListResponseSchema.parse(body);
    expect(parsed.count).toBe(20);
    expect(parsed.phases.length).toBe(20);
    // First should be phase "00", last "19".
    const first = parsed.phases[0];
    const last = parsed.phases[parsed.phases.length - 1];
    expect(first?.phase).toBe('00');
    expect(last?.phase).toBe('19');
  });
});

describe('GET /api/status', () => {
  it('returns a valid status snapshot', async () => {
    const res = await fetch(`${API}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = StatusSchema.parse(body);
    expect(parsed.progressPercent).toBeGreaterThanOrEqual(0);
    expect(parsed.progressPercent).toBeLessThanOrEqual(100);
    expect(Array.isArray(parsed.blockers)).toBe(true);
    expect(typeof parsed.phaseStatus).toBe('object');
  });
});

describe('GET /api/events (SSE)', () => {
  it('emits a heartbeat event within 30s', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${API}/events`, {
      signal: ctrl.signal,
      headers: { Accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    // Read the first event (better-sse pushes an immediate heartbeat on connect).
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 30_000;

    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('event: heartbeat')) {
          expect(buf).toContain('event: heartbeat');
          return;
        }
      }
      throw new Error('no heartbeat event received within 30s');
    } finally {
      ctrl.abort();
      reader.releaseLock();
    }
  }, 35_000);
});
