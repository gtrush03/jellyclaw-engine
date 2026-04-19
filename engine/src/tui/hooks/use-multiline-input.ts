/**
 * Multi-line input hook (T3-06, refined T1-04).
 *
 * Replaces ink-text-input with raw stdin via Ink's `useInput`. Supports:
 * - Enter: submit
 * - Shift+Enter: insert newline
 * - Arrow keys: navigate (wraps across lines)
 * - Ctrl-A: jump to line start
 * - Ctrl-E: jump to line end
 * - Backspace: delete char before caret (merges lines at col 0)
 * - Printable chars: insert at caret (handles multi-char paste)
 * - Bracketed paste markers (`\x1b[200~…\x1b[201~`) are stripped before insert.
 * - Optional history hooks: `onHistoryPrev` fires on Up-at-first-line,
 *   `onHistoryNext` fires on Down-at-last-line. Both receive no args and
 *   return a string to replace the buffer with, or `undefined` to no-op.
 */

import { useInput } from "ink";
import { useCallback, useState } from "react";

export interface Caret {
  readonly line: number;
  readonly col: number;
}

export interface MultilineInputState {
  /** Full string, lines joined by "\n". */
  readonly value: string;
  /** Caret position as (line, col). */
  readonly caret: Caret;
}

export interface UseMultilineInputArgs {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onSubmit: (text: string) => void;
  readonly disabled?: boolean;
  /** Called on Up-arrow when caret is on the first line. */
  readonly onHistoryPrev?: () => string | undefined;
  /** Called on Down-arrow when caret is past the last line of history nav. */
  readonly onHistoryNext?: () => string | undefined;
}

/**
 * Bracketed paste markers arrive as `ESC[200~` / `ESC[201~`. We build the
 * patterns from `String.fromCharCode(0x1b)` rather than an escaped literal so
 * Biome's `noControlCharactersInRegex` rule stays clean.
 */
const ESC = String.fromCharCode(0x1b);
const PASTE_START = new RegExp(`${ESC}\\[200~`, "g");
const PASTE_END = new RegExp(`${ESC}\\[201~`, "g");

function stripBracketedPaste(raw: string): string {
  return raw.replace(PASTE_START, "").replace(PASTE_END, "");
}

function splitLines(value: string): string[] {
  return value.split("\n");
}

function offsetToCaret(value: string, offset: number): Caret {
  const lines = splitLines(value);
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (remaining <= line.length) {
      return { line: i, col: remaining };
    }
    remaining -= line.length + 1; // +1 for the \n
  }
  const lastLine = lines.length - 1;
  return { line: lastLine, col: (lines[lastLine] ?? "").length };
}

function caretToOffset(value: string, caret: Caret): number {
  const lines = splitLines(value);
  let offset = 0;
  for (let i = 0; i < caret.line && i < lines.length; i++) {
    offset += (lines[i] as string).length + 1;
  }
  const currentLine = lines[caret.line] ?? "";
  offset += Math.min(caret.col, currentLine.length);
  return offset;
}

function clampCaret(value: string, caret: Caret): Caret {
  const lines = splitLines(value);
  const line = Math.max(0, Math.min(caret.line, lines.length - 1));
  const lineContent = lines[line] ?? "";
  const col = Math.max(0, Math.min(caret.col, lineContent.length));
  return { line, col };
}

function isPrintable(input: string): boolean {
  if (input.length === 0) return false;
  // Multi-char input is always considered printable (e.g. paste).
  if (input.length > 1) return true;
  const code = input.charCodeAt(0);
  return code >= 0x20;
}

export function useMultilineInput(args: UseMultilineInputArgs): MultilineInputState {
  const { value, onChange, onSubmit, disabled, onHistoryPrev, onHistoryNext } = args;

  const [offset, setOffset] = useState(value.length);
  const caret = offsetToCaret(value, Math.min(offset, value.length));

  const handleInput = useCallback(
    (
      input: string,
      key: {
        return?: boolean;
        shift?: boolean;
        backspace?: boolean;
        delete?: boolean;
        leftArrow?: boolean;
        rightArrow?: boolean;
        upArrow?: boolean;
        downArrow?: boolean;
        ctrl?: boolean;
        meta?: boolean;
      },
    ) => {
      if (disabled === true) return;

      const lines = splitLines(value);
      const currentOffset = Math.min(offset, value.length);
      const currentCaret = offsetToCaret(value, currentOffset);

      if (key.return === true && key.shift !== true) {
        onSubmit(value);
        return;
      }

      if (key.return === true && key.shift === true) {
        const newValue = `${value.slice(0, currentOffset)}\n${value.slice(currentOffset)}`;
        onChange(newValue);
        setOffset(currentOffset + 1);
        return;
      }

      if (key.leftArrow === true) {
        if (currentOffset > 0) setOffset(currentOffset - 1);
        return;
      }

      if (key.rightArrow === true) {
        if (currentOffset < value.length) setOffset(currentOffset + 1);
        return;
      }

      if (key.upArrow === true) {
        if (currentCaret.line > 0) {
          const targetLine = currentCaret.line - 1;
          const targetLineContent = lines[targetLine] ?? "";
          const targetCol = Math.min(currentCaret.col, targetLineContent.length);
          setOffset(caretToOffset(value, { line: targetLine, col: targetCol }));
          return;
        }
        if (onHistoryPrev !== undefined) {
          const next = onHistoryPrev();
          if (next !== undefined) {
            onChange(next);
            setOffset(next.length);
          }
        }
        return;
      }

      if (key.downArrow === true) {
        if (currentCaret.line < lines.length - 1) {
          const targetLine = currentCaret.line + 1;
          const targetLineContent = lines[targetLine] ?? "";
          const targetCol = Math.min(currentCaret.col, targetLineContent.length);
          setOffset(caretToOffset(value, { line: targetLine, col: targetCol }));
          return;
        }
        if (onHistoryNext !== undefined) {
          const next = onHistoryNext();
          if (next !== undefined) {
            onChange(next);
            setOffset(next.length);
          } else {
            onChange("");
            setOffset(0);
          }
        }
        return;
      }

      if (key.ctrl === true && input === "a") {
        setOffset(caretToOffset(value, { line: currentCaret.line, col: 0 }));
        return;
      }

      if (key.ctrl === true && input === "e") {
        const currentLineContent = lines[currentCaret.line] ?? "";
        setOffset(
          caretToOffset(value, { line: currentCaret.line, col: currentLineContent.length }),
        );
        return;
      }

      if (key.backspace === true || key.delete === true) {
        if (currentOffset > 0) {
          const newValue = value.slice(0, currentOffset - 1) + value.slice(currentOffset);
          onChange(newValue);
          setOffset(currentOffset - 1);
        }
        return;
      }

      if (isPrintable(input)) {
        const cleaned = stripBracketedPaste(input);
        if (cleaned.length === 0) return;
        const newValue = value.slice(0, currentOffset) + cleaned + value.slice(currentOffset);
        onChange(newValue);
        setOffset(currentOffset + cleaned.length);
        return;
      }
    },
    [value, offset, onChange, onSubmit, disabled, onHistoryPrev, onHistoryNext],
  );

  useInput(handleInput, { isActive: disabled !== true });

  return {
    value,
    caret: clampCaret(value, caret),
  };
}

/** Re-exported for tests and integrators that need standalone paste cleaning. */
export { stripBracketedPaste };
