/**
 * Phase 10.03 — library API: compile-only type-smoke fixture.
 *
 * This file MUST typecheck clean under `tsc --noEmit` using the workspace
 * path alias `@jellyclaw/engine` → `engine/src/index.ts`. If any of the
 * assertions below break, the public type surface has drifted from the
 * frozen contract in `engine/src/public-types.ts`.
 *
 * No runtime assertions — the point is the type checker.
 */

import type {
  Agent,
  EngineConfig,
  EngineEvent,
  EngineEventKind,
  EngineOptions,
  HookEvent,
  McpTool,
  PermissionMode,
  ProviderConfig,
  ProviderName,
  RunHandle,
  RunInput,
  SessionSummary,
  Skill,
  Usage,
} from "@jellyclaw/engine";
import { createEngine, type Engine, type EngineDisposedError } from "@jellyclaw/engine";

// ---------------------------------------------------------------------------
// Compile-time equality helper. AssertEqual<A, B> resolves to `true` only
// when both directions of assignability hold.
// ---------------------------------------------------------------------------

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ---------------------------------------------------------------------------
// Shape assertions
// ---------------------------------------------------------------------------

// RunInput.prompt is optional (resume path allowed).
const _runInputPromptOptional: AssertEqual<RunInput["prompt"], string | undefined> = true;
void _runInputPromptOptional;

// EngineEvent.type narrows to the same literal set exported as EngineEventKind.
const _eventKindMatchesUnion: AssertEqual<EngineEvent["type"], EngineEventKind> = true;
void _eventKindMatchesUnion;

// One known event kind must be assignable — guards against accidental empty-union.
const _anEventKind: EngineEventKind = "session.started";
void _anEventKind;

// ProviderName is a string-literal union. Pick one concrete member.
const _aProviderName: ProviderName = "anthropic";
void _aProviderName;

// PermissionMode must include all four documented modes.
const _pmDefault: PermissionMode = "default";
const _pmAcceptEdits: PermissionMode = "acceptEdits";
const _pmBypass: PermissionMode = "bypassPermissions";
const _pmPlan: PermissionMode = "plan";
void _pmDefault;
void _pmAcceptEdits;
void _pmBypass;
void _pmPlan;

// createEngine signature — options optional, returns a Promise<Engine>.
async function _signatureSmoke(): Promise<void> {
  const e: Engine = await createEngine();
  const h: RunHandle = e.run({ prompt: "hi" });
  const _firstId: string = h.id;
  const _firstSid: string = h.sessionId;
  void _firstId;
  void _firstSid;
  for await (const ev of h) {
    const _k: EngineEventKind = ev.type;
    void _k;
    break;
  }
  await e.dispose();
}
void _signatureSmoke;

// EngineDisposedError is constructible / pattern-matchable. Signature varies
// (0-arg vs `(msg: string)`), so we only assert the TYPE, not the ctor arity.
declare const _err: EngineDisposedError;
void _err;

// Config / subsystem entity types are exported and usable.
function _surfaceUse(
  _c: EngineConfig,
  _o: EngineOptions,
  _p: ProviderConfig,
  _s: Skill,
  _a: Agent,
  _m: McpTool,
  _sum: SessionSummary,
  _h: HookEvent,
  _u: Usage,
): void {}
void _surfaceUse;
