/**
 * Input history hook (T1-04).
 *
 * Persists the last 50 submitted prompts as JSON-Lines at
 * `~/.jellyclaw/history.jsonl`. The file is always written with mode `0o600`
 * (owner read/write only) since prompts can contain secrets pasted inline.
 * The containing directory is created with mode `0o700` for the same reason.
 *
 * Semantics:
 *   - Ring buffer of 50 entries — oldest drops off on overflow.
 *   - Duplicate suppression: pushing an entry equal to the current tail
 *     moves it to the tail position (no duplicate lines pile up).
 *   - Navigation is stateful: `prev()` walks from newest → oldest; `next()`
 *     walks the other direction and returns `undefined` when the cursor
 *     leaves the buffer (used by callers to clear the input).
 *   - Errors reading the file are swallowed silently — first-run users see
 *     an empty history rather than an error.
 *
 * `loadHistory` and `saveHistory` are exported as pure helpers so tests can
 * round-trip the on-disk format without driving the React hook.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { useCallback, useEffect, useRef, useState } from "react";

/** Ring-buffer size. Anything beyond this tail wins on `push`. */
export const MAX_HISTORY = 50;
/** File mode for the history file — owner rw only. */
export const HISTORY_FILE_MODE = 0o600;
/** Directory mode for `~/.jellyclaw` — owner rwx only. */
export const HISTORY_DIR_MODE = 0o700;
/** Absolute path to the on-disk history file. */
export const HISTORY_PATH = join(homedir(), ".jellyclaw", "history.jsonl");

export interface UseHistoryResult {
  /** Navigate to the previous (older) entry. `undefined` when at the tail. */
  prev: () => string | undefined;
  /** Navigate to the next (newer) entry. `undefined` when past the head. */
  next: () => string | undefined;
  /** Append an entry and persist. Empty / whitespace-only strings are ignored. */
  push: (text: string) => void;
  /** Current navigation cursor (`-1` when not navigating). */
  index: number;
  /** Number of entries currently held. */
  length: number;
}

/** Pure loader — used by the hook on mount and by tests directly. */
export async function loadHistory(path: string = HISTORY_PATH): Promise<string[]> {
  try {
    const content = await readFile(path, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed === "string") entries.push(parsed);
      } catch {
        // Skip malformed lines — survive partial file writes.
      }
    }
    return entries.slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

/** Pure saver — ensures 0600 perms even if the file already existed. */
export async function saveHistory(
  entries: readonly string[],
  path: string = HISTORY_PATH,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: HISTORY_DIR_MODE });

  const body = `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
  await writeFile(path, body, { mode: HISTORY_FILE_MODE });
  // A pre-existing file may have been created with looser perms; force 0600.
  await chmod(path, HISTORY_FILE_MODE);
}

/**
 * React hook for input history — loads on mount, persists on push.
 */
export function useHistory(): UseHistoryResult {
  const [entries, setEntries] = useState<string[]>([]);
  const [index, setIndex] = useState(-1);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void loadHistory().then(setEntries);
  }, []);

  const prev = useCallback((): string | undefined => {
    if (entries.length === 0) return undefined;
    const newIndex = index === -1 ? entries.length - 1 : Math.max(0, index - 1);
    setIndex(newIndex);
    return entries[newIndex];
  }, [entries, index]);

  const next = useCallback((): string | undefined => {
    if (index === -1) return undefined;
    const newIndex = index + 1;
    if (newIndex >= entries.length) {
      setIndex(-1);
      return undefined;
    }
    setIndex(newIndex);
    return entries[newIndex];
  }, [entries, index]);

  const push = useCallback(
    (text: string): void => {
      if (text.trim().length === 0) return;
      // Move-to-tail rather than accumulate duplicates.
      const deduped = entries.filter((e) => e !== text);
      const appended = [...deduped, text].slice(-MAX_HISTORY);
      setEntries(appended);
      setIndex(-1);
      void saveHistory(appended);
    },
    [entries],
  );

  return { prev, next, push, index, length: entries.length };
}
