// The page's side of new versions of Ozzie (src-tauri/src/updater.rs). Native code checks, downloads,
// checks the download and installs; the page shows the state it reports, in the fixed words below, and
// asks for exactly four things: the state, a check, the automatic setting, and the install the person
// clicked. It has no permission to call the updater plugin itself (capabilities/main.json).
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { browserStore, type KeyValueStore } from "./proactive.js";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "waiting" | "reopening";
export type UpdateProblem = "check-failed" | "install-failed" | "still-busy";
/** Where this copy runs: an app Ozzie can replace, a developer build, or a copy macOS runs from where it was downloaded. */
export type UpdatePlace = "app" | "not-an-app" | "move-to-applications";
export interface UpdateView {
  current: string;
  automatic: boolean;
  lastCheckedMs: number | null;
  phase: UpdatePhase;
  available: string | null;
  problem: UpdateProblem | null;
  place: UpdatePlace;
  /** Debug builds only: the stand-in test installs as if clicked. */
  autopilot: boolean;
  /** Debug builds only: the stand-in test, which never reads the Keychain. */
  probe: boolean;
}

export interface UpdatesApi {
  status(): Promise<UpdateView>;
  check(): Promise<UpdateView>;
  setAutomatic(on: boolean): Promise<UpdateView>;
  install(): Promise<UpdateView>;
  /** Native reports each step; returns a function that stops listening. */
  on(listener: (view: UpdateView) => void): () => void;
}
export const updates: UpdatesApi = {
  status: () => invoke<UpdateView>("update_status"),
  check: () => invoke<UpdateView>("update_check"),
  setAutomatic: on => invoke<UpdateView>("update_set_automatic", { on }),
  install: () => invoke<UpdateView>("update_install"),
  on(listener) {
    const stop = listen<UpdateView>("ozzie:update", e => listener(e.payload)).catch(() => () => {});
    return () => { void stop.then(f => f()); };
  },
};

// ---- Words ---------------------------------------------------------------------------------------

export const UPDATE_BUTTON = "Update Ozzie and reopen it";
export const CHECK_BUTTON = "Check for a new version";
export const AUTOMATIC_LABEL = "Check for new versions automatically";
export const AUTOMATIC_HELP = "On unless you turn it off. Ozzie checks a minute or two after it opens, then about once a day while it runs.";
export const LATER_BUTTON = "Remind me tomorrow";
export const REOPEN_NOTE = "Ozzie closes for a moment and opens again. Your Planning Center sign-in, Church rules and what Ozzie keeps an eye on stay as they are.";
export const UPDATE_HOW = [
  "To check, Ozzie asks GitHub, where Ozzie is published, for a short file that names the newest version. Nothing about you or your church goes with it: no names, no Planning Center details, no account.",
  "Ozzie installs a new version only after it proves the download came from FlockConnect and wasn't changed on the way. It never installs an older version.",
  "Nothing is installed until you choose Update Ozzie and reopen it. If Ozzie is in the middle of a check, it finishes that first.",
] as const;
export const PROBLEM_TEXT: Readonly<Record<UpdateProblem, string>> = Object.freeze({
  "check-failed": "Ozzie couldn't check for a new version. It will try again later.",
  "install-failed": "Ozzie couldn't install the new version. Nothing was changed. Try again later, or download it from ozzie.church.",
  "still-busy": "Ozzie stayed busy for a long time, so it didn't update. Try again when it has finished.",
});
export const PLACE_TEXT: Readonly<Record<Exclude<UpdatePlace, "app">, string>> = Object.freeze({
  "not-an-app": "This copy of Ozzie can't update itself. Download the new version from ozzie.church.",
  "move-to-applications": "To update, move Ozzie to your Applications folder, then open it from there.",
});

const clock = (ms: number, zone?: string) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) });
const dayKey = (ms: number, zone?: string) => new Date(ms).toLocaleDateString("en-CA", zone ? { timeZone: zone } : {});
/** "Last checked today at 9:14 AM." in this Mac's time; "Not checked yet." before the first answer. */
export function lastCheckedText(view: Pick<UpdateView, "lastCheckedMs">, nowMs: number, zone?: string): string {
  const at = view.lastCheckedMs;
  if (at === null || !Number.isFinite(at)) return "Not checked yet.";
  const when = dayKey(at, zone) === dayKey(nowMs, zone) ? "today"
    : dayKey(at, zone) === dayKey(nowMs - 86_400_000, zone) ? "yesterday"
      : new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(zone ? { timeZone: zone } : {}) });
  return `Last checked ${when} at ${clock(at, zone)}.`;
}
/** The one status line under the version: what's happening now, or the latest answer. */
export function statusLine(view: UpdateView): string | null {
  if (view.phase === "checking") return "Checking for a new version…";
  if (view.phase === "downloading") return view.available ? `Getting Ozzie ${view.available} ready…` : "Getting the new version ready…";
  if (view.phase === "waiting") return "Ozzie is finishing what it's doing. Then it closes for a moment and opens again with the new version.";
  if (view.phase === "reopening") return "Ozzie is reopening with the new version…";
  if (view.problem) return PROBLEM_TEXT[view.problem];
  if (view.available) return `Ozzie ${view.available} is ready to install.`;
  if (view.lastCheckedMs !== null) return "Ozzie is up to date.";
  return null;
}
/** Whether the Update button shows: a newer version found, and this copy can be replaced. */
export const canInstall = (view: UpdateView) => view.place === "app" && view.available !== null && view.phase === "available";
/** A check, download or reopen is under way. */
export const working = (view: UpdateView) => view.phase === "checking" || view.phase === "downloading" || view.phase === "waiting" || view.phase === "reopening";

// ---- "Remind me tomorrow" on Today ---------------------------------------------------------------

const LATER_KEY = "ozzie.update.later.v1";
/** Hidden on Today until the next morning for this version only; Settings always shows it. */
export function laterMemory(store: KeyValueStore = browserStore) {
  return {
    hidden(version: string, nowMs: number): boolean {
      try {
        const saved = JSON.parse(store.get(LATER_KEY) ?? "null") as { version?: unknown; until?: unknown } | null;
        return saved?.version === version && typeof saved.until === "number" && nowMs < saved.until;
      } catch { return false; }
    },
    later(version: string, nowMs: number): void {
      // Tomorrow at 8 in the morning, this Mac's time.
      const until = new Date(nowMs);
      until.setDate(until.getDate() + 1);
      until.setHours(8, 0, 0, 0);
      store.set(LATER_KEY, JSON.stringify({ version, until: until.getTime() }));
    },
  };
}

// ---- The hook App uses ---------------------------------------------------------------------------

export interface UpdatesState {
  view: UpdateView | null;
  check(): void;
  setAutomatic(on: boolean): void;
  install(): void;
}
/** Native state, kept current from `ozzie:update`. Debug builds' stand-in test installs as if clicked. */
export function useUpdates(api: UpdatesApi = updates): UpdatesState {
  const [view, setView] = useState<UpdateView | null>(null);
  useEffect(() => {
    let alive = true;
    api.status().then(v => { if (alive) setView(v); }).catch(() => undefined);
    const stop = api.on(v => { if (alive) setView(v); });
    return () => { alive = false; stop(); };
  }, [api]);
  const check = useCallback(() => {
    api.check().then(setView).catch(() => setView(v => v && { ...v, phase: v.available ? "available" : "idle", problem: "check-failed" }));
  }, [api]);
  const setAutomatic = useCallback((on: boolean) => { api.setAutomatic(on).then(setView).catch(() => undefined); }, [api]);
  const install = useCallback(() => {
    api.install().then(setView).catch(() => setView(v => v && { ...v, problem: "install-failed" }));
  }, [api]);
  // Debug builds only (the stand-in test): "Check for a new version" once, then "Update Ozzie and reopen it" once.
  const autopiloted = useRef({ checked: false, installed: false });
  useEffect(() => {
    if (!view?.autopilot) return;
    if (!autopiloted.current.checked && view.phase === "idle") { autopiloted.current.checked = true; check(); }
    if (!autopiloted.current.installed && view.phase === "available") { autopiloted.current.installed = true; install(); }
  }, [view, check, install]);
  return { view, check, setAutomatic, install };
}
