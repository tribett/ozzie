// First run's state, from facts rather than a "closed" flag (onboarding spec §0.3). Setup opens at the first unmet fact:
// not connected (the first screen, or the browser step after an attempt that didn't finish), a sign-in under way
// (waiting for Allow), connected but no service watched or no result seen yet (the service step). Once a result has been
// seen, setup never opens by itself again. This Mac keeps only three facts about setup, never anything about the church.
// Every Planning Center outcome becomes one fixed sentence chosen by a closed code; native text is never shown (§0.4).
import { parseOrganizationDiagnostic, type ConnectionStatus } from "./connection.js";

export type Attempt = "denied" | "expired" | "cancelled";
/** How the AI screen ended: a way chosen, "No AI for now" (an answer), or "Decide later". */
export type AiAnswer = "chosen" | "none" | "later";
export interface SetupMemory { aiOffered: boolean; exampleSeen: boolean; lastAttempt: Attempt | null; aiAnswer: AiAnswer | null }
const KEY = "ozzie.setup.v2";
const FRESH: SetupMemory = { aiOffered: false, exampleSeen: false, lastAttempt: null, aiAnswer: null };
export function readSetupMemory(raw: string | null): SetupMemory {
  try {
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ...FRESH };
    const r = v as Record<string, unknown>;
    const attempt = r.lastAttempt === "denied" || r.lastAttempt === "expired" || r.lastAttempt === "cancelled" ? r.lastAttempt : null;
    const answer = r.aiAnswer === "chosen" || r.aiAnswer === "none" || r.aiAnswer === "later" ? r.aiAnswer : null;
    return { aiOffered: r.aiOffered === true, exampleSeen: r.exampleSeen === true, lastAttempt: attempt, aiAnswer: answer };
  } catch { return { ...FRESH }; }
}
type Store = Pick<Storage, "getItem" | "setItem">;
const browser = (): Store | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
/**
 * `ozzie.setup.v2`: whether the AI screen was offered and how it ended, whether the example was seen, and how the last
 * sign-in ended. Never anything about the church.
 */
export function setupMemory(store: Store | null = browser()) {
  const get = (): SetupMemory => { try { return readSetupMemory(store?.getItem(KEY) ?? null); } catch { return { ...FRESH }; } };
  return {
    get,
    set(patch: Partial<SetupMemory>) {
      const next = { ...get(), ...patch };
      try { store?.setItem(KEY, JSON.stringify({ aiOffered: next.aiOffered, exampleSeen: next.exampleSeen, lastAttempt: next.lastAttempt, aiAnswer: next.aiAnswer })); } catch { /* per-device convenience only */ }
      return next;
    },
  };
}

/**
 * Whether "Choose how Ozzie uses AI" stays on Today's Finish setting up (spec §4.1 item 4, review M1): only after
 * "Decide later", or leaving the screen any other way, while no way is chosen; "No AI for now" is an answer and never asked
 * again. A church set up before the AI screen existed (never offered, a result seen, no AI) is offered it there too.
 * Unknown AI status: not asked.
 */
export function aiStillOpen(memory: SetupMemory, ai: { route: string } | null, resultSeen: boolean): boolean {
  if (!ai || ai.route !== "none") return false;
  if (memory.aiAnswer) return memory.aiAnswer === "later";
  // Left the screen another way (the sidebar, a quit), or never offered it: the card offers it.
  return memory.aiOffered || resultSeen;
}

/**
 * A Planning Center connection Ozzie can work with: checked, saved but not yet checked this session, or saved and only
 * unreachable just now. One Planning Center refused (`invalid-token`, `scope-mismatch`) needs a new sign-in.
 */
export function isConnected(status: ConnectionStatus | null | undefined): boolean {
  if (!status) return false;
  if (status.state === "connected" || status.state === "stored-unchecked") return true;
  return status.state === "failed" && /^[1-9]\d{0,31}$/u.test(status.organization) && status.problem !== "invalid-token" && status.problem !== "scope-mismatch"
    && status.organization_diagnostic === undefined;
}
export const isPending = (status: ConnectionStatus | null | undefined) => status?.state === "waiting" || status?.state === "checking";

export type FirstRunScreen = "first" | "browser" | "waiting" | "service";
export interface FirstRunFacts { status: ConnectionStatus | null; watching: boolean; resultSeen: boolean; memory: SetupMemory }
/**
 * The screen setup opens at, or null when setup is done (connected, watching, a result seen). A Mac already set up (a
 * service watched, a saved check) whose connection isn't known (native has no status until the launch check of the saved
 * sign-in answers, and none if it couldn't) is done too: Today says how the connection stands (0.3.0 relaunch bug).
 */
export function firstRunScreen(f: FirstRunFacts): FirstRunScreen | null {
  if (f.status === null && f.watching && f.resultSeen) return null;
  if (isPending(f.status)) return "waiting";
  if (isConnected(f.status)) return f.watching && f.resultSeen ? null : "service";
  const ended = f.status?.state === "cancelled" || f.status?.state === "expired" || f.status?.state === "failed";
  return ended || f.memory.lastAttempt ? "browser" : "first";
}

/** The line S2 shows on relaunch after an attempt that didn't finish (quit mid-way, or it ended while away). */
export const RESUME_LINE: Record<Attempt, string> = {
  cancelled: "Last time, Planning Center didn't finish connecting. Nothing was connected.",
  expired: "Last time, Planning Center didn't finish connecting. Nothing was connected.",
  denied: "Last time, Ozzie wasn't allowed in Planning Center. Nothing was connected.",
};

/** One Planning Center outcome as the person sees it: the row of the spec's table, its sentence, and its buttons. */
export interface Failure { row: number; text: string; alert: boolean; notNow: boolean }
const fail = (row: number, text: string, notNow = true, alert = true): Failure => ({ row, text, alert, notNow });
export const FAILURE_TEXT = {
  denied: "You chose not to allow Ozzie in Planning Center, so nothing was connected. Ozzie can't show your service without it.",
  expired: "That took longer than 5 minutes, so Ozzie stopped waiting. Nothing was connected.",
  cancelled: "Nothing was connected.",
  browser: "Your browser didn't open. Press the button again. If nothing happens, choose a default web browser in System Settings › Desktop & Dock, then try again.",
  dropped: "Planning Center said yes, but the internet connection dropped before Ozzie could finish. Nothing was saved. Check that this Mac is online, then try again.",
  keychain: "Planning Center said yes, but this Mac didn't let Ozzie keep the connection. Unlock this Mac (type your Mac password if it asks), then try again.",
  scope: "Planning Center gave different access than Ozzie asked for, so nothing was saved. Please try again.",
  church: "Planning Center said yes, but Ozzie couldn't confirm which church it is, so nothing was saved. Please try again.",
  slow: "Planning Center asked Ozzie to slow down. Wait a minute, then try again.",
  busy: "Ozzie is still finishing the last attempt. Wait a few seconds, then try again.",
  again: "Planning Center no longer accepts Ozzie's sign-in, so nothing was read. Connect again to see your service.",
  other: "Planning Center didn't finish connecting, so nothing was connected. Please try again.",
} as const;

/**
 * What happened to a sign-in, from a status (or a rejected call's closed code), as a fixed sentence; null while it is
 * under way or once it connected. `cancelled` with `denied` is Planning Center's Allow refused in the browser
 * (contract N2); `failed` with `denied` is this Mac refusing Ozzie its own Keychain.
 */
export function connectFailure(outcome: ConnectionStatus | string | unknown): Failure | null {
  if (outcome === null || outcome === undefined) return null;
  const s =outcome && typeof outcome === "object" && "state" in outcome ? outcome as ConnectionStatus : null;
  const code = s ? (typeof s.problem === "string" ? s.problem : JSON.stringify(s.problem) ?? "") : typeof outcome === "string" ? outcome : JSON.stringify(outcome) ?? "";
  if (s) {
    if (s.state === "connected" || s.state === "stored-unchecked" || s.state === "waiting" || s.state === "checking" || s.state === "disconnected") return null;
    if (s.state === "cancelled") return code === "denied" ? fail(1, FAILURE_TEXT.denied) : fail(3, FAILURE_TEXT.cancelled, false, false);
    if (s.state === "expired") return fail(2, FAILURE_TEXT.expired);
    const diagnostic = parseOrganizationDiagnostic(s.organization_diagnostic);
    if (diagnostic) return diagnostic.reason === "transport-failure" ? fail(5, FAILURE_TEXT.dropped) : fail(12, FAILURE_TEXT.church);
  }
  if (code.includes("browser-unavailable")) return fail(4, FAILURE_TEXT.browser, false);
  if (code.includes("provider-failure") || code.includes("transport")) return fail(5, FAILURE_TEXT.dropped);
  if (code.includes("locked") || code.includes("denied") || code.includes("store")) return fail(10, FAILURE_TEXT.keychain, false);
  if (code.includes("scope-mismatch")) return fail(11, FAILURE_TEXT.scope, false);
  if (code.includes("organization")) return fail(12, FAILURE_TEXT.church);
  if (code.includes("rate-limited")) return fail(13, FAILURE_TEXT.slow, false);
  if (code.includes("busy")) return fail(0, FAILURE_TEXT.busy, false);
  if (code.includes("invalid-token")) return fail(0, FAILURE_TEXT.again);
  return fail(0, FAILURE_TEXT.other);
}
/** How an attempt ended, for the resume line after a relaunch. */
export const attemptOf = (f: Failure): Attempt => f.row === 1 ? "denied" : f.row === 2 ? "expired" : "cancelled";
