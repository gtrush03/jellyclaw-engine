/**
 * Multi-line prompt input (T3-06, polished in T1-04).
 *
 * Responsibilities:
 *   - Multi-line editing: Shift+Enter inserts a newline, Enter submits.
 *   - Paste: bracketed paste markers (`\x1b[200~…\x1b[201~`) are stripped.
 *   - History: Up / Down cycle through the last 50 submissions persisted at
 *     `~/.jellyclaw/history.jsonl` (0600). Edge-only: Up only recalls when the
 *     caret is on line 0, Down only moves forward when on the last line.
 *   - Slash-command hint strip: whenever the pending text starts with `/`,
 *     the top 5 matches from the provided command registry render directly
 *     below the input, each row showing `  /name — description`.
 *   - Placeholder (dim) when the buffer is empty:
 *     `Ask jellyclaw · / for commands`.
 *
 * When `disabled` is true (e.g. a stream is in flight), the editor is muted
 * to a `(streaming…)` label and stdin is ignored.
 */

import { Box, Text } from "ink";
import type { CommandDefinition } from "../commands/registry.js";
import { useHistory } from "../hooks/use-history.js";
import { useMultilineInput } from "../hooks/use-multiline-input.js";
import { useSlashCompletion } from "../hooks/use-slash-completion.js";
import { brand } from "../theme/brand.js";
import { density } from "../theme/density.js";
import { typography } from "../theme/typography.js";

/** Spec-mandated empty-state placeholder. */
export const DEFAULT_PLACEHOLDER = "Ask jellyclaw \u00B7 / for commands";

export interface InputBoxProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (text: string) => void;
  placeholder?: string;
  /** When true, input is read-only (e.g. while streaming). */
  disabled?: boolean;
  /** Command registry for slash-command autocomplete (T1-04). */
  commands?: readonly CommandDefinition[];
}

/**
 * Render the multi-line editor body with a caret block on the active line.
 */
function MultilineInputRenderer(props: {
  value: string;
  caret: { line: number; col: number };
  placeholder: string;
}): JSX.Element {
  const { value, caret, placeholder } = props;

  if (value.length === 0) {
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={brand.tidewater} dimColor>
            {placeholder}
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
        // Caret targets the active line by index; a content-hash key would
        // break cursor tracking when two lines happen to share the same prefix.
        // biome-ignore lint/suspicious/noArrayIndexKey: line index is the identity here
        <Box key={lineIdx}>
          {lineIdx === caret.line ? (
            <>
              <Text color={brand.foam}>{line.slice(0, caret.col)}</Text>
              <Text inverse>{line[caret.col] ?? " "}</Text>
              <Text color={brand.foam}>{line.slice(caret.col + 1)}</Text>
            </>
          ) : (
            <Text color={brand.foam}>{line}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

/**
 * Slash-command hint strip — rendered directly below the input whenever the
 * pending buffer starts with `/`. Silent when there are no matches.
 */
function SlashHintStrip(props: {
  readonly input: string;
  readonly commands: readonly CommandDefinition[];
}): JSX.Element | null {
  const matches = useSlashCompletion(props.input, props.commands);
  if (matches.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={density.padX.sm} marginTop={density.gap.xs}>
      {matches.map((m) => (
        <Box key={m.name}>
          <Text color={brand.jellyCyan} bold>
            {`  /${m.name}`}
          </Text>
          <Text color={brand.tidewaterDim}>{"  \u2014  "}</Text>
          <Text
            color={brand.foamDark}
            italic={typography.emphasis.italic ?? true}
            dimColor={typography.caption.dim}
          >
            {m.description}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

export function InputBox(props: InputBoxProps): JSX.Element {
  const placeholder = props.placeholder ?? DEFAULT_PLACEHOLDER;
  const commands = props.commands ?? [];
  const history = useHistory();

  const state = useMultilineInput({
    value: props.value,
    onChange: props.onChange,
    onSubmit: (text) => {
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        history.push(trimmed);
      }
      props.onSubmit(text);
    },
    onHistoryPrev: () => history.prev(),
    onHistoryNext: () => history.next(),
    ...(props.disabled !== undefined ? { disabled: props.disabled } : {}),
  });

  const showSlashHints =
    props.disabled !== true && props.value.startsWith("/") && commands.length > 0;

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="single"
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor={brand.tidewaterDim}
        paddingX={density.padX.sm}
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
            placeholder={placeholder}
          />
        )}
      </Box>
      {showSlashHints ? <SlashHintStrip input={props.value} commands={commands} /> : null}
    </Box>
  );
}
