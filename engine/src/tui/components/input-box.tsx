/**
 * Phase 99-06 — single-line prompt input.
 *
 * Wraps `ink-text-input`. When `disabled` is true (e.g. a stream is in flight),
 * we render a muted placeholder and skip mounting `TextInput` — Ink 5 captures
 * keys eagerly, so an active TextInput during streaming would swallow control
 * keys (Ctrl+C, Esc) the parent app needs.
 *
 * TODO(phase-99-07): true multi-line editing. `ink-text-input@6` is single-line
 * only; Meta+Enter / Shift+Enter newline insertion needs a custom input that
 * consumes raw stdin via `useInput`. Tracked as deferred follow-up; the prop
 * surface intentionally stays single-line for this phase.
 */

import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface InputBoxProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (text: string) => void;
  placeholder?: string;
  /** When true, input is read-only (e.g. while streaming). */
  disabled?: boolean;
}

export function InputBox(props: InputBoxProps): JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      <Text color="#9E7BFF">{"\u203A "}</Text>
      {props.disabled === true ? (
        <Text color="gray">{"(streaming\u2026)"}</Text>
      ) : (
        <TextInput
          value={props.value}
          onChange={props.onChange}
          onSubmit={(v) => props.onSubmit(v)}
          {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        />
      )}
    </Box>
  );
}
