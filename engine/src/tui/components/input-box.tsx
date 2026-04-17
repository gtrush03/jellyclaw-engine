/**
 * Phase 99-07 — multi-line prompt input (T3-06).
 *
 * Uses a custom `useMultilineInput` hook that reads raw stdin via Ink's `useInput`.
 * Supports:
 * - Multi-line paste (preserved intact)
 * - Shift+Enter for newlines, Enter to submit
 * - Arrow key navigation across lines
 * - Ctrl-A/E for line start/end
 *
 * When `disabled` is true (e.g. a stream is in flight), we render a muted
 * placeholder and skip processing input.
 */

import { Box, Text } from "ink";
import { useMultilineInput } from "../hooks/use-multiline-input.js";
import { brand } from "../theme/brand.js";

export interface InputBoxProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (text: string) => void;
  placeholder?: string;
  /** When true, input is read-only (e.g. while streaming). */
  disabled?: boolean;
}

/**
 * Render the multi-line input with caret visualization.
 */
function MultilineInputRenderer(props: {
  value: string;
  caret: { line: number; col: number };
  placeholder?: string;
}): JSX.Element {
  const { value, caret, placeholder } = props;

  // Empty state: show placeholder
  if (value.length === 0) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={brand.tidewater} dimColor>
            {placeholder ?? "Type a message..."}
          </Text>
          <Text inverse> </Text>
        </Box>
      </Box>
    );
  }

  const lines = value.split("\n");

  return (
    <Box flexDirection="column">
      {lines.map((line, lineIdx) => (
        <Box key={lineIdx}>
          {lineIdx === caret.line ? (
            // Current line with caret
            <>
              <Text color={brand.foam}>{line.slice(0, caret.col)}</Text>
              <Text inverse>{line[caret.col] ?? " "}</Text>
              <Text color={brand.foam}>{line.slice(caret.col + 1)}</Text>
            </>
          ) : (
            // Other lines
            <Text color={brand.foam}>{line}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

export function InputBox(props: InputBoxProps): JSX.Element {
  const state = useMultilineInput({
    value: props.value,
    onChange: props.onChange,
    onSubmit: props.onSubmit,
    ...(props.disabled !== undefined ? { disabled: props.disabled } : {}),
  });

  return (
    <Box
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={brand.tidewaterDim}
      paddingX={1}
    >
      <Text color={brand.medusaViolet} bold>
        {"\u203A "}
      </Text>
      {props.disabled === true ? (
        <Text color={brand.tidewater}>{"(streaming\u2026)"}</Text>
      ) : (
        <MultilineInputRenderer
          value={state.value}
          caret={state.caret}
          {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
        />
      )}
    </Box>
  );
}
