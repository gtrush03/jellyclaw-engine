/**
 * Phase 99-06 — first-run API key prompt (Ink TUI).
 *
 * Asks for an Anthropic API key, validates it locally, pings
 * `/v1/messages` with a 1-token Haiku request to verify the key works,
 * persists via `updateCredentials()`, then signals the parent to transition
 * to the chat UI.
 *
 * Security
 * --------
 *  - Key is never logged. The masked `<TextInput>` is the only sink that
 *    sees the value before it's handed to `saveImpl` / `fetchImpl`.
 *  - On cancel, nothing is persisted.
 */

import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useCallback, useState } from "react";
import { updateCredentials } from "../../cli/credentials.js";
import { brand } from "../theme/brand.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ApiKeyPromptProps {
  /** Called with the validated key AFTER it's been persisted. */
  onAccepted: (key: string) => void;
  /** Called when the user aborts (Esc or Ctrl+C). */
  onCancelled?: () => void;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to `updateCredentials({anthropicApiKey: key})`. */
  saveImpl?: (key: string) => Promise<void>;
}

type Phase =
  | { kind: "prompting" }
  | { kind: "validating"; key: string }
  | { kind: "saved" }
  | { kind: "rejected"; reason: string };

// ---------------------------------------------------------------------------
// Local validation (mirrors credentials-prompt.ts::validateKey)
// ---------------------------------------------------------------------------

const MIN_KEY_LENGTH = 10;
const VALIDATION_TIMEOUT_MS = 10_000;

function validateKey(raw: string): { ok: true; value: string } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length < MIN_KEY_LENGTH) {
    return { ok: false, reason: "key is too short" };
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return { ok: false, reason: "paste without quotes" };
  }
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Best-effort error body parsing
// ---------------------------------------------------------------------------

async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "object" &&
      (body as { error: unknown }).error !== null
    ) {
      const err = (body as { error: { message?: unknown } }).error;
      if (typeof err.message === "string" && err.message.length > 0) {
        return `${String(res.status)} ${err.message}`;
      }
    }
  } catch {
    /* fall through */
  }
  return `${String(res.status)} ${res.statusText || "request failed"}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ApiKeyPrompt(props: ApiKeyPromptProps): JSX.Element {
  const { onAccepted, onCancelled, fetchImpl, saveImpl } = props;
  const { exit } = useApp();
  const [phase, setPhase] = useState<Phase>({ kind: "prompting" });
  const [value, setValue] = useState("");

  const cancel = useCallback(() => {
    if (onCancelled) {
      onCancelled();
    } else {
      exit();
    }
  }, [onCancelled, exit]);

  const runValidation = useCallback(
    async (key: string): Promise<void> => {
      const fetchFn = fetchImpl ?? globalThis.fetch;
      const saveFn =
        saveImpl ??
        ((k: string) => updateCredentials({ anthropicApiKey: k }).then(() => undefined));

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, VALIDATION_TIMEOUT_MS);

      try {
        const res = await fetchFn("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": key,
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          const reason = await extractErrorMessage(res);
          setPhase({ kind: "rejected", reason });
          return;
        }
      } catch (err) {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        setPhase({ kind: "rejected", reason: message });
        return;
      }

      // Validation succeeded — persist.
      try {
        await saveFn(key);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setPhase({ kind: "rejected", reason: `save failed: ${message}` });
        return;
      }
      setPhase({ kind: "saved" });
      onAccepted(key);
    },
    [fetchImpl, saveImpl, onAccepted],
  );

  const onSubmit = useCallback(
    (raw: string): void => {
      const result = validateKey(raw);
      if (!result.ok) {
        setPhase({ kind: "rejected", reason: result.reason });
        return;
      }
      setPhase({ kind: "validating", key: result.value });
      void runValidation(result.value);
    },
    [runValidation],
  );

  useInput((_input, key) => {
    if (key.escape) {
      cancel();
      return;
    }
    if (phase.kind === "rejected" && key.return) {
      setValue("");
      setPhase({ kind: "prompting" });
    }
  });

  if (phase.kind === "validating") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box>
          <Text color="gray">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> validating key…</Text>
        </Box>
      </Box>
    );
  }

  if (phase.kind === "saved") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="green">✓ key saved to ~/.jellyclaw/credentials.json</Text>
      </Box>
    );
  }

  if (phase.kind === "rejected") {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="red">✗ {phase.reason}</Text>
        <Text color="gray">press Enter to try again · Esc to quit</Text>
      </Box>
    );
  }

  // prompting
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text bold>jellyclaw — first-run setup</Text>
      <Text color="gray">─────────────────────────────</Text>
      <Box marginTop={1}>
        <Text>Paste your Anthropic API key to continue.</Text>
      </Box>
      <Text color="gray">Get one at https://console.anthropic.com/settings/keys</Text>
      <Box marginTop={1}>
        <Text color={brand.jellyCyan}>{"› "}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={onSubmit} mask="•" />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">(Enter to submit · Esc to quit)</Text>
      </Box>
    </Box>
  );
}
