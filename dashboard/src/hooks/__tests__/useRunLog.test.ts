/**
 * Unit tests for the pure pieces of `useRunLog`.
 *
 * The hook itself needs React + a DOM to mount. The two bug surfaces we care
 * about — URL construction and frame decoding — are pure functions, and
 * previously these were *both* broken:
 *
 *   1. `runEventsUrl` split the id on `/` and threw for real autobuild ids
 *      like `T0-02-serve-reads-credentials`. Result: hook opened no socket.
 *   2. The onmessage branch filtered server-emitted `log-line` events out
 *      because the client only accepted `log`/`message`. Server has since
 *      been aligned to `log`, but we pin the accepted event names here so
 *      a future rename on either side trips a test.
 *
 * No new deps: runs as a pure-node vitest, same `tests/unit/**` style.
 */
import { describe, it, expect } from 'vitest';
import { runEventsUrl } from '../../lib/api';
import { decideRunLogFrame } from '../useRunLog';

describe('runEventsUrl', () => {
  it('builds /api/runs/:id/events for a slash-less autobuild id', () => {
    const u = runEventsUrl('T0-02-serve-reads-credentials');
    expect(u).toBe('/api/runs/T0-02-serve-reads-credentials/events');
  });

  it('encodes reserved characters in the id segment', () => {
    // A run id containing a dot is legal per the server's regex; spaces
    // would be rejected server-side but we still must not throw in the
    // client helper — construct a valid URL and let the server say 400.
    const u = runEventsUrl('run.with.dots');
    expect(u).toBe('/api/runs/run.with.dots/events');
  });

  it('throws on empty id rather than building a malformed URL', () => {
    expect(() => runEventsUrl('')).toThrow();
    expect(() => runEventsUrl('   ')).toThrow();
  });
});

describe('decideRunLogFrame', () => {
  it('appends the line when event is `log` with JSON { line } payload', () => {
    const d = decideRunLogFrame({
      event: 'log',
      data: JSON.stringify({
        runId: 'T0-02',
        line: 'hello world',
        at: '2026-04-17T10:00:00Z',
      }),
    });
    expect(d).toEqual({ kind: 'append', line: 'hello world' });
  });

  it('passes replay frames through (replay flag does not gate emission)', () => {
    const d = decideRunLogFrame({
      event: 'log',
      data: JSON.stringify({ runId: 'T0-02', line: 'seed-1', replay: true }),
    });
    expect(d).toEqual({ kind: 'append', line: 'seed-1' });
  });

  it('falls back to raw text when data is not JSON', () => {
    const d = decideRunLogFrame({ event: 'log', data: 'raw plain line' });
    expect(d).toEqual({ kind: 'append', line: 'raw plain line' });
  });

  it('accepts the default `message` event name for forward-compat', () => {
    const d = decideRunLogFrame({ event: 'message', data: 'x' });
    expect(d).toEqual({ kind: 'append', line: 'x' });
  });

  it('ignores heartbeat frames and unknown event names', () => {
    expect(decideRunLogFrame({ event: 'heartbeat', data: '' })).toEqual({
      kind: 'ignore',
    });
    // This was the canary: the server USED to emit `log-line`. A future
    // accidental rename on either side must trip here.
    expect(decideRunLogFrame({ event: 'log-line', data: '{}' })).toEqual({
      kind: 'ignore',
    });
    expect(decideRunLogFrame({ event: 'status', data: 'x' })).toEqual({
      kind: 'ignore',
    });
  });

  it('ignores frames with no data', () => {
    expect(decideRunLogFrame({ event: 'log' })).toEqual({ kind: 'ignore' });
    expect(decideRunLogFrame({ event: 'log', data: '' })).toEqual({
      kind: 'ignore',
    });
  });

  it('survives malformed JSON by emitting the raw data verbatim', () => {
    const d = decideRunLogFrame({ event: 'log', data: '{not-json' });
    expect(d).toEqual({ kind: 'append', line: '{not-json' });
  });
});
