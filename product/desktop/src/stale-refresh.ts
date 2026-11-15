/**
 * Someone looking at Ozzie sees a current picture. A live check stops being treated as current after
 * 30 minutes (core LIVE_CHECK_VALID_MS) while the regular check runs every hour by default, so with
 * the window on screen an out-of-date check is read again: the same read as "Check Planning Center now".
 */
export const STALE_REFRESH_GAP_MS = 10 * 60_000;

export interface StaleRefreshInput {
  /** The window is on screen. */
  visible: boolean;
  /** The fictional example is showing. */
  fictional: boolean;
  /** A saved sign-in and a chosen Sunday. */
  ready: boolean;
  /** What is on screen is a live read (not a saved recording) that has gone out of date. */
  staleLive: boolean;
  /** The regular Sunday check is paused (on its own or by Pause everything). */
  paused: boolean;
  /** A check is already running. */
  running: boolean;
  nowMs: number;
  /** When this last asked for a refresh; 0 if never. */
  lastAttemptMs: number;
}

/**
 * True when Ozzie should read Planning Center again on its own. Never while paused, never over a
 * recording or the example, and at most once per gap so an unreachable Planning Center isn't hammered.
 */
export function shouldRefreshStale(i: StaleRefreshInput): boolean {
  if (!i.visible || i.fictional || !i.ready || !i.staleLive || i.paused || i.running) return false;
  return i.lastAttemptMs === 0 || i.nowMs - i.lastAttemptMs >= STALE_REFRESH_GAP_MS;
}
