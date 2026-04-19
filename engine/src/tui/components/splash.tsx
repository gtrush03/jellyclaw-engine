/**
 * Startup splash — premium wordmark + tagline, shown on first launch (no
 * session, empty transcript). Intentionally avoids multi-row ASCII stencils:
 * those are fragile across terminals (column alignment breaks on half-block
 * chars with non-monospaced widths, and any missing letter definition prints
 * as garbage). Instead we lean on terminal strengths: a single bold wordmark
 * painted with a per-character truecolor cyan→violet→blush gradient, flanked
 * by a jellyfish glyph, with a thin gradient underline for depth.
 *
 * Rendered inside the transcript area; once the user sends a prompt (or a
 * session resumes), the `App` swaps it for the live `<Transcript />`.
 *
 * Compact mode (once a session exists) collapses to a 2-line header so the
 * splash stays pinned without eating screen real estate.
 *
 * Key bindings:
 * - Enter: start session (onStart callback)
 * - Escape: quit application (onQuit callback)
 */

import { Box, Text, useInput } from "ink";
import { brand, GRADIENT_BELL, GRADIENT_JELLY, gradient } from "../theme/brand.js";

/** Version from package.json, injected at build time or read dynamically. */
const VERSION = "0.0.1";

export interface SplashProps {
  /** CWD printed under the tagline — short form. */
  readonly cwd: string;
  /** Model string, rendered dim beside the tagline. */
  readonly model: string;
  /** Optional short session id, shown only when a session exists. */
  readonly sessionId?: string | null;
  /** Callback when Enter is pressed to start. */
  readonly onStart?: () => void;
  /** Callback when Escape is pressed to quit. */
  readonly onQuit?: () => void;
  /** Override version string for testing. */
  readonly version?: string;
}

export function Splash(props: SplashProps): JSX.Element {
  const tagline = "open-source agent runtime \u00B7 1M context";
  const hasModel = props.model.length > 0 && props.model !== "(default)";
  const sessionShort =
    typeof props.sessionId === "string" && props.sessionId.length > 0
      ? props.sessionId.slice(0, 8)
      : null;
  // Compact mode: once a session exists, collapse the splash to a 2-line
  // header so it stays pinned without eating screen real estate.
  const compact = sessionShort !== null;
  const versionStr = props.version ?? VERSION;

  // Handle Enter to start, Escape to quit.
  useInput((_input, key) => {
    if (key.return && props.onStart) {
      props.onStart();
    }
    if (key.escape && props.onQuit) {
      props.onQuit();
    }
  });

  if (compact) {
    return (
      <Box flexDirection="column" paddingX={2} paddingTop={1}>
        <Box>
          <Text color={brand.blushPink}>{"\u{1FABC} "}</Text>
          <Text bold>{gradient("jellyclaw", GRADIENT_JELLY)}</Text>
          <Text color={brand.tidewaterDim}>{"  \u00B7  "}</Text>
          {hasModel ? (
            <>
              <Text color={brand.jellyCyan}>{props.model}</Text>
              <Text color={brand.tidewaterDim}>{"  \u00B7  "}</Text>
            </>
          ) : null}
          <Text color={brand.amberEye}>{sessionShort}</Text>
          <Text color={brand.tidewaterDim}>{"  \u00B7  "}</Text>
          <Text color={brand.medusaViolet}>{shortCwd(props.cwd)}</Text>
        </Box>
        <Box>
          <Text>
            {gradient(
              "\u2500".repeat(Math.min(64, shortCwd(props.cwd).length + 40)),
              GRADIENT_BELL,
            )}
          </Text>
        </Box>
      </Box>
    );
  }

  // Full splash — first-launch / empty-session view.
  const hint = "ENTER to start \u00B7 /help for commands \u00B7 ESC to quit";
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box>
        <Text color={brand.blushPink}>{"\u{1FABC}  "}</Text>
        <Text bold>{gradient("jellyclaw", GRADIENT_JELLY)}</Text>
      </Box>
      <Box>
        <Text>{gradient("\u2500".repeat(28), GRADIENT_JELLY)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={brand.tidewater}>{tagline}</Text>
      </Box>
      <Box marginTop={1}>
        {hasModel ? (
          <>
            <Text color={brand.tidewaterDim}>model </Text>
            <Text color={brand.jellyCyan}>{props.model}</Text>
            <Text color={brand.tidewaterDim}>{"  \u00B7  "}</Text>
          </>
        ) : null}
        <Text color={brand.tidewaterDim}>cwd </Text>
        <Text color={brand.medusaViolet}>{shortCwd(props.cwd)}</Text>
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text color={brand.tidewaterDim}>{hint}</Text>
        <Text color={brand.tidewaterDim}>v{versionStr}</Text>
      </Box>
    </Box>
  );
}

function shortCwd(cwd: string): string {
  if (cwd.length <= 48) return cwd;
  return `\u2026${cwd.slice(cwd.length - 47)}`;
}
