// The page's side of Ozzie running with its window closed (src-tauri/src/always_on.rs): the native
// timer's wake-ups, Mac sleep, "Pause everything" from the menu bar, the window coming back, "Open
// Ozzie when I log in", and the fixed notices. Nothing here carries text from a person or a source.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { NoticeKind } from "./responsibility-runner.js";
import type { NoticeOptions } from "./phone-notice.js";

export interface BackgroundInfo { fastSchedule: boolean; probe: boolean; tickMs: number }
export interface Autostart { get(): Promise<boolean>; set(enabled: boolean): Promise<boolean> }
export interface BackgroundHandlers {
  /** Every native wake (about every 30 seconds, sooner when work is due). */
  tick?: (event: { at_ms: number; due: boolean; slept_ms: number | null }) => void;
  /** The Mac slept this long and has just woken. */
  wake?: (sleptMs: number, at: string) => void;
  /** "Pause everything" changed (from the menu bar or the page). */
  paused?: (paused: boolean) => void;
  /** The window came back (menu bar "Open Ozzie" or the Dock). */
  shown?: () => void;
  /** Debug builds only: the hidden-window probe. */
  probe?: (phase: "hidden" | "report") => void;
}

export const autostart: Autostart = {
  get: () => invoke<boolean>("autostart_get"),
  set: enabled => invoke<boolean>("autostart_set", { enabled }),
};
export const background = {
  /** Debug-only switches; all off in a release build. */
  info: () => Promise.resolve().then(() => invoke<BackgroundInfo>("background_info"))
    .catch((): BackgroundInfo => ({ fastSchedule: false, probe: false, tickMs: 30_000 })),
  /** Wake the native timer when the next run is due. */
  nextDue: (at: string | null) => { void invoke("background_next_due", { atMs: at ? Date.parse(at) : null }).catch(() => undefined); },
  /**
   * One of four fixed notices; the text is fixed in native code and carries no names or details. "This Mac only"
   * (phone-notice.ts) keeps its phone line back; it never adds one.
   */
  notify: (kind: NoticeKind, options?: NoticeOptions) => invoke<void>("notify_ozzie", options?.localOnly ? { kind, localOnly: true } : { kind }),
  /** Listens for the native events; returns a function that stops listening. */
  on(handlers: BackgroundHandlers): () => void {
    const stops: Promise<() => void>[] = [];
    const add = <T,>(name: string, handle: (payload: T) => void) => {
      stops.push(listen<T>(name, e => { try { handle(e.payload); } catch { /* one handler never stops the others */ } }).catch(() => () => {}));
    };
    if (handlers.tick) add<{ at_ms: number; due: boolean; slept_ms: number | null }>("ozzie:tick", handlers.tick);
    if (handlers.wake) add<{ slept_ms: number; at_ms: number }>("ozzie:wake", p => handlers.wake!(p.slept_ms, new Date(p.at_ms).toISOString()));
    if (handlers.paused) add<{ paused: boolean }>("ozzie:paused", p => handlers.paused!(p.paused));
    if (handlers.shown) add<unknown>("ozzie:shown", () => handlers.shown!());
    if (handlers.probe) add<{ phase: "hidden" | "report" }>("ozzie:probe", p => handlers.probe!(p.phase));
    return () => { for (const stop of stops) void stop.then(f => f()); };
  },
};

/**
 * Debug builds only (OZZIE_DEV_BACKGROUND_PROBE=<seconds>): counts what ran while the window was
 * hidden: a one-second page timer, the native timer's wake-ups, and the page's visibility. Reports one
 * name-free line through dev_log when native asks, just before it quits.
 */
export function startProbe(log: (line: string) => void, clock: () => number = Date.now): BackgroundHandlers {
  let hiddenAt: number | null = null;
  let timerTicks = 0, nativeTicks = 0, wakes = 0, longestGap = 0, last = clock();
  let hiddenSeen = false;
  setInterval(() => {
    const now = clock();
    if (hiddenAt !== null) {
      timerTicks++;
      longestGap = Math.max(longestGap, now - last);
      if (typeof document !== "undefined" && document.visibilityState === "hidden") hiddenSeen = true;
    }
    last = now;
  }, 1000);
  return {
    tick: () => { if (hiddenAt !== null) nativeTicks++; },
    wake: () => { wakes++; },
    probe: phase => {
      if (phase === "hidden") { hiddenAt = clock(); last = hiddenAt; return; }
      const seconds = hiddenAt === null ? 0 : Math.round((clock() - hiddenAt) / 1000);
      const visibility = typeof document === "undefined" ? "unknown" : document.visibilityState;
      log(`background-probe: hidden_s=${seconds} page_hidden_seen=${hiddenSeen} visibility=${visibility} page_timer_ticks=${timerTicks} native_ticks=${nativeTicks} wakes=${wakes} longest_timer_gap_ms=${longestGap}`);
    },
  };
}
