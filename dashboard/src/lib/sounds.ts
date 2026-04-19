/**
 * Sound effects for the Jellyclaw dashboard.
 *
 * - Pure Web Audio synthesis, no files, no external deps.
 * - Off by default. User must opt in via `setSoundsEnabled(true)`.
 * - Persisted in localStorage under "jellyclaw:sounds".
 */

const STORAGE_KEY = "jellyclaw:sounds";

let ctx: AudioContext | null = null;
let enabled: boolean | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  // Safari: webkitAudioContext fallback
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

function readEnabled(): boolean {
  if (enabled !== null) return enabled;
  if (typeof window === "undefined") return false;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    enabled = v === "1";
  } catch {
    enabled = false;
  }
  return enabled;
}

export function isSoundsEnabled(): boolean {
  return readEnabled();
}

export function setSoundsEnabled(value: boolean): void {
  enabled = value;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* ignore quota / privacy errors */
  }
}

interface ChirpOptions {
  freq: number;
  endFreq?: number;
  duration: number; // seconds
  type?: OscillatorType;
  volume?: number; // 0..1
}

function chirp({ freq, endFreq, duration, type = "sine", volume = 0.08 }: ChirpOptions): void {
  if (!readEnabled()) return;
  const audio = getCtx();
  if (!audio) return;

  // Resume in case the context was suspended by autoplay policy
  if (audio.state === "suspended") {
    audio.resume().catch(() => undefined);
  }

  const now = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  if (endFreq !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), now + duration);
  }

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(volume, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

  osc.connect(gain).connect(audio.destination);
  osc.start(now);
  osc.stop(now + duration + 0.02);
}

/** Tiny "chk" on copy-success — short rising chirp. */
export function playCopySuccess(): void {
  chirp({ freq: 740, endFreq: 1320, duration: 0.09, type: "triangle", volume: 0.06 });
}

/** Soft click on SSE progress tick — gentle downward blip. */
export function playProgressTick(): void {
  chirp({ freq: 520, endFreq: 360, duration: 0.06, type: "sine", volume: 0.035 });
}

/** Error chime (optional, for toast errors). */
export function playError(): void {
  chirp({ freq: 220, endFreq: 140, duration: 0.18, type: "square", volume: 0.05 });
}

/** Release AudioContext (useful on app unmount in tests). */
export function disposeSounds(): void {
  if (ctx) {
    ctx.close().catch(() => undefined);
    ctx = null;
  }
}
