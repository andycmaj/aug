// When aug can't go on but a fresh process would be fine, it exits with
// RESTART_CODE and bin/aug starts it again.

// EX_TEMPFAIL: try again.
export const RESTART_CODE = 75;

let wanted = false;

export function requestRestart(): void {
  wanted = true;
}

export function exitCode(): number {
  return wanted ? RESTART_CODE : 0;
}

// opentui caps the native text buffers alive at once. Past the cap no text can
// be drawn, not even the crash screen, so the UI freezes half-alive.
export function isOutOfTextBuffers(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Failed to create TextBuffer/.test(message);
}
