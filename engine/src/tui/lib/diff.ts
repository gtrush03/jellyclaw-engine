/**
 * Unified diff computation for TUI diff viewer (T3-07).
 *
 * Wraps the `diff` library to produce a simple array of DiffLine objects
 * suitable for rendering in the TUI.
 */

import { diffLines } from "diff";

export interface DiffLine {
  readonly kind: "add" | "del" | "ctx";
  readonly text: string;
}

/**
 * Compute a unified diff between two strings.
 *
 * @param oldText - The original text.
 * @param newText - The modified text.
 * @param contextLines - Number of context lines around changes (default 3).
 * @returns Array of DiffLine objects representing the unified diff.
 */
export function unifiedDiff(oldText: string, newText: string, _contextLines = 3): DiffLine[] {
  // Note: _contextLines is reserved for future context collapsing implementation
  const changes = diffLines(oldText, newText);
  const result: DiffLine[] = [];

  for (const change of changes) {
    // Split into individual lines, preserving empty lines
    const lines = change.value.replace(/\n$/, "").split("\n");

    for (const line of lines) {
      if (change.added === true) {
        result.push({ kind: "add", text: line });
      } else if (change.removed === true) {
        result.push({ kind: "del", text: line });
      } else {
        result.push({ kind: "ctx", text: line });
      }
    }
  }

  // Apply context collapsing if needed
  // For now, return all lines; context collapsing is handled at render time
  return result;
}
