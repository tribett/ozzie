// "Use Ozzie's last check in other AI apps" (Settings, off by default; harness plan H5). While it's on, the check on
// screen is shared through the same read-only agent tools Ask Ozzie uses (core/mcp/snapshot.ts): labels, counts,
// times and fixed words only. Native `share_last_check` checks every result again against each name this session has
// shown before writing the file Ozzie's read-only server reads (core/mcp), stamped with the facts' own check time.
//
// Only this church's check is shared: when there's nothing current to share (no check on screen, another church's,
// Planning Center disconnected, saved recordings deleted, a refused share) the copy is removed, never left behind.
// Whether sharing is on is kept natively (shared_check.rs), so turning it off holds without this page: native writes
// nothing while it's off and removes any copy left over at the next start. Turning it off removes the copy.
//
// A church on B1 Church or Breeze (0.10.0) shares its own check the same way, under the same switch: its results name
// that system as their source, and native is told which system it is and whether that system gave the number of people
// needed for every role (ShareContext `system`), so the copy says so (core/mcp/snapshot.ts). Planning Center's check is
// shared exactly as before; a check is never shared as another system's.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { HarnessData } from "../../../core/src/harness/index.js";
import type { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools } from "../../../core/src/harness/tools.js";
import { SHARED_SYSTEMS, sharedEnvelopes, type SharedSystem } from "../../../core/mcp/snapshot.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { ConnectionStatus } from "./connection.js";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const nativeInvoke: Invoke = (command, args) => tauriInvoke(command, args);

export const SHARE_STOP_PROBLEM = "Ozzie couldn't remove the shared copy. Try turning it off again.";
export const SHARE_START_PROBLEM = "Ozzie couldn't turn this on. Try again.";

// Every native call here runs one at a time, in the order asked, so a share still in flight when sharing is turned
// off finishes before the copy is removed and can't bring it back. (Native also refuses a share while it's off.)
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

// One random copy id per set of labels: a HarnessSession keeps a person's or role's label for as long as it lives, so
// labels mean the same thing across copies with the same id and nothing is promised across different ids. Six
// consonant-digit pairs (core/mcp/snapshot.ts COPY_ID): never a word, a name or a phone-number-like run of digits.
const CONSONANTS = "BCDFGHJKLMNPQRSTVWXZ";
const copies = new WeakMap<HarnessSession, string>();
export function copyIdFor(session: HarnessSession): string {
  let id = copies.get(session);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    id = Array.from({ length: 6 }, (_, i) => `${CONSONANTS[bytes[2 * i]! % CONSONANTS.length]}${2 + (bytes[2 * i + 1]! % 8)}`).join("");
    copies.set(session, id);
  }
  return id;
}

/**
 * What decides whether the check on screen is current for the church: the church in Settings, the connection, and a check
 * whose recordings were deleted. For a church on B1 Church or Breeze, `system` (then `organization` is the church as its
 * checks carry it, `<system>:<church id>`, and `status` isn't used); for a church on Genesis, `genesis`.
 */
export interface ShareContext { organization: string; status: ConnectionStatus | null; forgotten?: SundayCapture | null; system?: SystemShare | null; genesis?: boolean }
/**
 * A church on B1 Church or Breeze: its system, whether that system gave the number of people needed for every role on the
 * service, some or none (core/mcp/snapshot.ts ROLE_NUMBERS), and whether its check may be shared now: connected, and
 * for B1 Church with the church's time zone confirmed and the check not held back for it.
 */
export interface SystemShare extends SharedSystem { ready: boolean }
/** Whether a system gave the number of people needed for every role on the service, some or none (core/mcp/snapshot.ts). */
export { roleNumbersOf } from "../../../core/mcp/snapshot.js";

/**
 * Whether the check in `data` may be shared: the fictional example, or a check of the church in Settings while its
 * Planning Center connection isn't disconnected (or bound to another church), and not one whose saved recordings the
 * leader deleted. A church on B1 Church or Breeze: its own example, or a check of the church connected while it is ready
 * (SystemShare). A check is shared only as the system it read: never another system's as Planning Center's, or the
 * other way round.
 */
export function shareable(data: HarnessData, context: ShareContext): boolean {
  const capture = data.capture;
  if (!capture || capture === context.forgotten) return false;
  const system = context.system ?? null;
  if (data.source !== (system ? SHARED_SYSTEMS[system.id] : undefined)) return false;
  if (data.mode === "fictional") return true;
  const { organization, status } = context;
  if (system) return system.ready && organization !== "" && capture.organization === organization;
  return organization !== "" && capture.organization === organization && status !== null && status.state !== "disconnected"
    && (!status.organization || status.organization === organization);
}
/** What native is told of the church's system with the results: nothing for Planning Center, so its call is as before. */
export const systemArgs = (context: ShareContext): { system?: SharedSystem } =>
  context.system ? { system: { id: context.system.id, role_numbers: context.system.role_numbers } } : {};

/**
 * Shares the check in `data` when it's current for the church (`shareable`), serialized exactly as the agent tools
 * return them, the form the native check reads. Otherwise, or when native refuses it, removes the copy. Resolves to
 * whether a copy was written; rejects only when the copy couldn't be removed.
 */
export function syncShared(data: HarnessData, session: HarnessSession, context: ShareContext, invoke: Invoke = nativeInvoke): Promise<boolean> {
  return inOrder(async () => {
    let envelopes: string[] = [];
    try { if (shareable(data, context)) envelopes = (await sharedEnvelopes(new HarnessTools(data, session))).map(e => JSON.stringify(e)); }
    catch { envelopes = []; }
    if (envelopes.length) {
      try { await invoke<void>("share_last_check", { envelopes, copyId: copyIdFor(session), ...systemArgs(context) }); return true; }
      catch { /* refused (a name, off) or not written: a copy that isn't this check isn't kept */ }
    }
    await invoke<void>("clear_shared_check");
    return false;
  });
}

export interface SharingView { on: boolean; problem: string | null }

/** Turning sharing on and off, as kept natively. Starts off until native says otherwise; a failure says so in plain words. */
export class SharingControl {
  #view: SharingView = { on: false, problem: null };
  #changed = false;
  readonly #invoke: Invoke;
  readonly #show: (view: SharingView) => void;
  constructor(invoke: Invoke, show: (view: SharingView) => void) { this.#invoke = invoke; this.#show = show; }
  get view(): SharingView { return this.#view; }
  #set(view: SharingView) { this.#view = view; this.#show(view); }

  /** Whether native has sharing on. Off when it can't say. A choice made meanwhile wins. */
  async load(): Promise<void> {
    let on = false;
    try { on = await inOrder(() => this.#invoke<boolean>("sharing_check_status")) === true; } catch { on = false; }
    if (!this.#changed) this.#set({ on, problem: null });
  }

  /** The leader's choice. Turning it off removes the copy; when that fails it stays on, with SHARE_STOP_PROBLEM. */
  async change(on: boolean): Promise<void> {
    this.#changed = true;
    this.#set({ on, problem: null });
    try { await inOrder(() => this.#invoke<void>(on ? "start_sharing_check" : "stop_sharing_check")); }
    catch { this.#set({ on: !on, problem: on ? SHARE_START_PROBLEM : SHARE_STOP_PROBLEM }); }
  }
}

export interface Sharing {
  /** For Settings (connection-page.tsx). */
  settings: { on: boolean; onChange: (on: boolean) => void; problem: string | null };
  /** The leader deleted saved recordings: the check on screen is no longer shared. */
  forget: () => void;
}

/**
 * Keeps the shared copy current while sharing is on: after each new check, a change to the Church rules or decisions,
 * the church in Settings or the connection, a finished task (`version`), and once a minute so "out of date" is said
 * when it becomes true. Never throws.
 */
export function useSharing(data: HarnessData, session: HarnessSession, version: number, context: ShareContext, invoke: Invoke = nativeInvoke): Sharing {
  const [view, setView] = useState<SharingView>({ on: false, problem: null });
  const [control] = useState(() => new SharingControl(invoke, setView));
  useEffect(() => { void control.load(); }, [control]);
  const latest = useRef({ data, context });
  latest.current = { data, context };
  const forgotten = useRef<SundayCapture | null>(null);
  const [forgets, setForgets] = useState(0);
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    if (!view.on) return;
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / 60_000)), 15_000);
    return () => clearInterval(timer);
  }, [view.on]);
  const { capture, rules, decisions, granted, mode, source } = data;
  const { organization, status, system } = context;
  useEffect(() => {
    if (!view.on) return;
    const now = latest.current;
    void syncShared(now.data, session, { ...now.context, forgotten: forgotten.current }, invoke).catch(() => undefined);
  }, [view.on, capture, rules, decisions, granted.join(), mode, version, minute, session, invoke, organization, status?.state, status?.organization, forgets,
    source, system?.id, system?.role_numbers, system?.ready]);
  return {
    settings: { on: view.on, onChange: on => { void control.change(on); }, problem: view.problem },
    forget: () => { forgotten.current = latest.current.data.capture; setForgets(n => n + 1); },
  };
}
