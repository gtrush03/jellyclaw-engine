/**
 * Multi-line input hook (T3-06).
 *
 * Replaces ink-text-input with raw stdin via Ink's `useInput`. Supports:
 * - Enter: submit
 * - Shift+Enter: insert newline
 * - Arrow keys: navigate (wraps across lines)
 * - Ctrl-A: jump to line start
 * - Ctrl-E: jump to line end
 * - Backspace: delete char before caret (merges lines at col 0)
 * - Printable chars: insert at caret (handles multi-char paste)
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
}

/**
 * Split a string into lines for caret navigation.
 */
function splitLines(value: string): string[] {
  return value.split("\n");
}

/**
 * Convert a flat offset to (line, col).
 */
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
  // Past the end: clamp to final position
  const lastLine = lines.length - 1;
  return { line: lastLine, col: (lines[lastLine] ?? "").length };
}

/**
 * Convert (line, col) to flat offset.
 */
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

/**
 * Clamp caret to valid position within value.
 */
function clampCaret(value: string, caret: Caret): Caret {
  const lines = splitLines(value);
  const line = Math.max(0, Math.min(caret.line, lines.length - 1));
  const lineContent = lines[line] ?? "";
  const col = Math.max(0, Math.min(caret.col, lineContent.length));
  return { line, col };
}

/**
 * Check if a character is printable (not a control character).
 */
function isPrintable(input: string): boolean {
  if (input.length === 0) return false;
  // Control characters are below 0x20 (except for multi-char paste which is always printable)
  if (input.length > 1) return true;
  const code = input.charCodeAt(0);
  return code >= 0x20;
}

export function useMultilineInput(args: UseMultilineInputArgs): MultilineInputState {
  const { value, onChange, onSubmit, disabled } = args;

  // Internal caret state - tracks position as offset, converted to (line, col) on return
  const [offset, setOffset] = useState(value.length);

  // Compute caret from current offset
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

      // Enter (no shift) → submit
      if (key.return === true && key.shift !== true) {
        onSubmit(value);
        return;
      }

      // Shift+Enter → insert newline
      if (key.return === true && key.shift === true) {
        const newValue = `${value.slice(0, currentOffset)}\n${value.slice(currentOffset)}`;
        onChange(newValue);
        setOffset(currentOffset + 1);
        return;
      }

      // Left arrow
      if (key.leftArrow === true) {
        if (currentOffset > 0) {
          setOffset(currentOffset - 1);
        }
        return;
      }

      // Right arrow
      if (key.rightArrow === true) {
        if (currentOffset < value.length) {
          setOffset(currentOffset + 1);
        }
        return;
      }

      // Up arrow
      if (key.upArrow === true) {
        if (currentCaret.line > 0) {
          const targetLine = currentCaret.line - 1;
          const targetLineContent = lines[targetLine] ?? "";
          const targetCol = Math.min(currentCaret.col, targetLineContent.length);
          const newCaret = { line: targetLine, col: targetCol };
          setOffset(caretToOffset(value, newCaret));
        }
        return;
      }

      // Down arrow
      if (key.downArrow === true) {
        if (currentCaret.line < lines.length - 1) {
          const targetLine = currentCaret.line + 1;
          const targetLineContent = lines[targetLine] ?? "";
          const targetCol = Math.min(currentCaret.col, targetLineContent.length);
          const newCaret = { line: targetLine, col: targetCol };
          setOffset(caretToOffset(value, newCaret));
        }
        return;
      }

      // Ctrl-A → start of line
      if (key.ctrl === true && input === "a") {
        const newCaret = { line: currentCaret.line, col: 0 };
        setOffset(caretToOffset(value, newCaret));
        return;
      }

      // Ctrl-E → end of line
      if (key.ctrl === true && input === "e") {
        const currentLineContent = lines[currentCaret.line] ?? "";
        const newCaret = { line: currentCaret.line, col: currentLineContent.length };
        setOffset(caretToOffset(value, newCaret));
        return;
      }

      // Backspace / Delete
      if (key.backspace === true || key.delete === true) {
        if (currentOffset > 0) {
          const newValue = value.slice(0, currentOffset - 1) + value.slice(currentOffset);
          onChange(newValue);
          setOffset(currentOffset - 1);
        }
        return;
      }

      // Printable characters (including multi-char paste)
      if (isPrintable(input)) {
        const newValue = value.slice(0, currentOffset) + input + value.slice(currentOffset);
        onChange(newValue);
        setOffset(currentOffset + input.length);
        return;
      }
    },
    [value, offset, onChange, onSubmit, disabled],
  );

  useInput(handleInput, { isActive: disabled !== true });

  return {
    value,
    caret: clampCaret(value, caret),
  };
}
