// "Let Siri and Shortcuts ask Ozzie" (Settings, off by default; ADR 0006). While it's on, the Sunday overview of the
// check on screen is kept as a small copy that Ozzie's bundled helper (ozzie-shortcuts) answers from when a shortcut
// asks: the same placeholder-only result the copy for other AI apps holds (core/mcp/shortcuts.ts), checked natively
// against every name this session has shown before it's written (shortcuts_check.rs). The helper says only counts,
// dates and Ozzie's own words from it.
//
// Only this church's current check is kept (share-check.ts `shareable`): otherwise the copy is removed. Whether it's on
// is kept natively, so turning it off holds without this page, and the helper answers "turned off" without the marker.
// A church on B1 Church or Breeze keeps its own check's overview the same way (0.10.0); a church on Genesis, which shares
// no volunteer schedules, has native's fixed line instead, so Siri and Shortcuts say that (save_shortcuts_genesis).
// Also here: the pages an ozzie:// link opens (native accepts only these, and only while this is on).
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import type { HarnessData } from "../../../core/src/harness/index.js";
import type { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools } from "../../../core/src/harness/tools.js";
import { sharedEnvelopes } from "../../../core/mcp/snapshot.js";
import { shortcutsEnvelopes } from "../../../core/mcp/shortcuts.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { copyIdFor, shareable, systemArgs, type Invoke, type ShareContext } from "./share-check.js";

const nativeInvoke: Invoke = (command, args) => tauriInvoke(command, args);

export const SHORTCUTS_START_PROBLEM = "Ozzie couldn't turn this on. Try again.";
export const SHORTCUTS_STOP_PROBLEM = "Ozzie couldn't remove the copy Siri and Shortcuts answer from. Try turning it off again.";
/** The pages an ozzie:// link can open (shortcuts.rs PAGES, pinned by its test). */
export const OPENABLE_PAGES = Object.freeze(["today", "sunday"] as const);
export type OpenablePage = (typeof OPENABLE_PAGES)[number];

// One native call at a time, in the order asked, so a save still in flight when this is turned off finishes before the
// copy is removed and can't bring it back. (Native also refuses a save while it's off.)
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Saves the Sunday overview of the check in `data` when it's current for the church, serialized exactly as the agent
 * tools return it. Otherwise, or when native refuses it, removes the copy. Resolves to whether a copy was written;
 * rejects only when the copy couldn't be removed.
 */
export function syncShortcuts(data: HarnessData, session: HarnessSession, context: ShareContext, invoke: Invoke = nativeInvoke): Promise<boolean> {
  return inOrder(async () => {
    // A church on Genesis: nothing from the page, only native's own fixed line.
    if (context.genesis) {
      try { await invoke<void>("save_shortcuts_genesis"); return true; } catch { /* off, or not written: removed below */ }
      await invoke<void>("clear_shortcuts_check");
      return false;
    }
    let envelopes: string[] = [];
    try {
      if (shareable(data, context)) envelopes = shortcutsEnvelopes(await sharedEnvelopes(new HarnessTools(data, session))).map(e => JSON.stringify(e));
    } catch { envelopes = []; }
    if (envelopes.length) {
      try { await invoke<void>("save_shortcuts_check", { envelopes, copyId: copyIdFor(session), ...systemArgs(context) }); return true; }
      catch { /* refused (a name, off) or not written: a copy that isn't this check isn't kept */ }
    }
    await invoke<void>("clear_shortcuts_check");
    return false;
  });
}

export interface ShortcutsView { on: boolean; problem: string | null }

/** Turning it on and off, as kept natively. Starts off until native says otherwise; a failure says so in plain words. */
export class ShortcutsControl {
  #view: ShortcutsView = { on: false, problem: null };
  #changed = false;
  readonly #invoke: Invoke;
  readonly #show: (view: ShortcutsView) => void;
  constructor(invoke: Invoke, show: (view: ShortcutsView) => void) { this.#invoke = invoke; this.#show = show; }
  get view(): ShortcutsView { return this.#view; }
  #set(view: ShortcutsView) { this.#view = view; this.#show(view); }

  /** Whether native has it on. Off when it can't say. A choice made meanwhile wins. */
  async load(): Promise<void> {
    let on = false;
    try { on = await inOrder(() => this.#invoke<boolean>("shortcuts_status")) === true; } catch { on = false; }
    if (!this.#changed) this.#set({ on, problem: null });
  }

  /** The leader's choice. Turning it off removes the copy; when that fails it stays on, with SHORTCUTS_STOP_PROBLEM. */
  async change(on: boolean): Promise<void> {
    this.#changed = true;
    this.#set({ on, problem: null });
    try { await inOrder(() => this.#invoke<void>(on ? "start_shortcuts" : "stop_shortcuts")); }
    catch { this.#set({ on: !on, problem: on ? SHORTCUTS_START_PROBLEM : SHORTCUTS_STOP_PROBLEM }); }
  }
}

export interface ShortcutsSettings { on: boolean; onChange: (on: boolean) => void; problem: string | null }
export interface Shortcuts {
  /** For Settings (siri-shortcuts-section.tsx). */
  settings: ShortcutsSettings;
  /** The leader deleted saved recordings: the check on screen is no longer kept for Shortcuts. */
  forget: () => void;
}

/**
 * Keeps the copy current while it's on: after each new check, a change to the Church rules or decisions, the church in
 * Settings or the connection. No timer: the helper works out how old the check is when it's asked. Never throws.
 */
export function useShortcuts(data: HarnessData, session: HarnessSession, context: ShareContext, invoke: Invoke = nativeInvoke): Shortcuts {
  const [view, setView] = useState<ShortcutsView>({ on: false, problem: null });
  const [control] = useState(() => new ShortcutsControl(invoke, setView));
  useEffect(() => { void control.load(); }, [control]);
  const latest = useRef({ data, context });
  latest.current = { data, context };
  const forgotten = useRef<SundayCapture | null>(null);
  const [forgets, setForgets] = useState(0);
  const { capture, rules, decisions, granted, mode, source } = data;
  const { organization, status, system, genesis } = context;
  useEffect(() => {
    if (!view.on) return;
    const now = latest.current;
    void syncShortcuts(now.data, session, { ...now.context, forgotten: forgotten.current }, invoke).catch(() => undefined);
  }, [view.on, capture, rules, decisions, granted.join(), mode, session, invoke, organization, status?.state, status?.organization, forgets,
    source, system?.id, system?.role_numbers, system?.ready, genesis]);
  return {
    settings: { on: view.on, onChange: on => { void control.change(on); }, problem: view.problem },
    forget: () => { forgotten.current = latest.current.data.capture; setForgets(n => n + 1); },
  };
}

type Listen = (event: string, handler: () => void) => Promise<() => void>;
const nativeListen: Listen = (event, handler) => tauriListen(event, () => handler());
const openable = (page: unknown): page is OpenablePage => typeof page === "string" && (OPENABLE_PAGES as readonly string[]).includes(page);

/**
 * Takes the page an ozzie:// link asked for from native (always, so it's used once) and opens it only when `ready`:
 * while guided setup is showing a link is ignored, never closing setup. Anything but one of OPENABLE_PAGES is ignored.
 */
export async function takeOpenedPage(invoke: Invoke, ready: () => boolean, open: (page: OpenablePage) => void): Promise<void> {
  let page: unknown;
  try { page = await invoke<string | null>("take_opened_page"); } catch { return; }
  if (openable(page) && ready()) open(page);
}

/**
 * Opens the page an ozzie:// link asked for: the one native kept when the link arrived (even before this page loaded),
 * and each one after, unless guided setup is showing (`ready` false).
 */
export function useOpenedPage(open: (page: OpenablePage) => void, ready: () => boolean, invoke: Invoke = nativeInvoke, listen: Listen = nativeListen): void {
  const latest = useRef({ open, ready });
  latest.current = { open, ready };
  useEffect(() => {
    let live = true;
    const take = () => { void takeOpenedPage(invoke, () => live && latest.current.ready(), page => latest.current.open(page)); };
    take();
    const stop = listen("ozzie:open-page", take).catch(() => () => {});
    return () => { live = false; void stop.then(f => f()); };
  }, [invoke, listen]);
}
