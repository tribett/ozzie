// "A notice on your phone" (Settings, off by default; owner decision 2026-11-16). While it's on, each time Ozzie sends
// a notice, the same fixed line also goes to the leader's own phone through ntfy.sh, whether or not this Mac's own
// notifications show it. Native does all of that (src-tauri/src/phone_notice.rs, core/native-auth phone_notice.rs): it
// picks the line, makes and keeps the channel, sends the one request and keeps what became of the last one, riding on
// the same two notice commands the page already gates with quiet hours, Pause everything and the person's Church rules
// on notices (uncertain findings, Worth a look, bring no notice unless the person chose "Always tell me right away"
// for that kind). This page only turns it on and off, shows the channel to subscribe to with a Copy button, asks for a
// new channel or a test notice, and says plainly what happened.
//
// No command here passes anything to native: no text, channel, host or address. The channel is held only in this
// page's memory while Settings shows it; it is never saved by the page and never goes in the task record. The one word
// the notice commands may add is "this Mac only" (`THIS_MAC_ONLY`), for a notice only about a background check: it can
// keep a line off the phone, never add one.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { Finding } from "../../../core/src/sunday-brief.js";

export type Invoke = <T>(command: string) => Promise<T>;
const nativeInvoke: Invoke = command => tauriInvoke(command);

/** The five commands, each called with nothing but its name. */
export const PHONE_COMMANDS = ["phone_notice_status", "phone_notice_on", "phone_notice_new_channel", "phone_notice_off", "phone_notice_test"] as const;

/** What became of the last phone notice: native's closed code and when (milliseconds since 1970). */
export interface LastNotice { outcome: string; at_ms: number }
export interface PhoneView { on: boolean; channel: string | null; last?: LastNotice | null }

// ---- A notice only about a background check stays on this Mac (review N, L6) ------------------------------------

/** The finding kind of a background check (core/src/kids-rules.ts). */
export const BACKGROUND_CHECK: Finding["kind"] = "background-check";
/** What a notice command may say besides its kind: only that the notice stays on this Mac. */
export interface NoticeOptions { localOnly?: true }
export const THIS_MAC_ONLY: NoticeOptions = Object.freeze({ localOnly: true });
/**
 * Whether a notice stays on this Mac: every finding that brought it is a background check. `kinds`: the finding kind
 * of each thing that brought it; null for one that isn't a finding of a known kind. A mix, or nothing known, goes to
 * the phone as before (the line carries no fact).
 */
export const thisMacOnly = (kinds: readonly (string | null | undefined)[]): boolean => kinds.length > 0 && kinds.every(k => k === BACKGROUND_CHECK);
/**
 * Whether a notice held for quiet hours stays on this Mac when it goes out (review N re-check, N2). `held`: whether only
 * background checks brought it when it was held (undefined on one held before this was kept). `now`: the finding kinds
 * that still bring it, rechecked against the newest check (null when it can no longer be rechecked, e.g. its run record
 * is gone).
 *
 * The rule: what can be rechecked decides; what can't falls back to what was so when it was held; with neither known,
 * the phone line goes as it always did. So a notice that was, and as far as can be known still is, only about a
 * background check never reaches the phone, and one that has gained any other cause goes. A notice held as mixed whose
 * other cause has since gone (only the background check still holds) stays on this Mac too: at the moment it goes it
 * is only about a background check, as an unheld notice is judged at the moment it goes. This never sends a phone
 * line that "held only about background checks AND still so" would keep back; it keeps back strictly more.
 */
export const heldMacOnly = (held: boolean | undefined, now: readonly (string | null)[] | null): boolean =>
  now !== null ? thisMacOnly(now) : held === true;

// ---- The words in Settings ----------------------------------------------------------------------------------------

export const PHONE_TITLE = "A notice on your phone";
export const PHONE_BODY = "Each time Ozzie sends a notice, it can send the same short line to your phone too, even if this Mac's own notifications are turned off for Ozzie.";
export const PHONE_SWITCH = "Send Ozzie's notices to my phone too";
export const PHONE_OFF_NOTE = "Off unless you turn it on. Turning it off stops sending and forgets the channel.";
/** One of the fixed lines, word for word (the Sunday notice; core/native-auth phone_notice.rs `Line::text`). */
export const PHONE_EXAMPLE = "Sunday coverage needs attention. Open Ozzie to see details.";
export const PHONE_WHAT = `Each notice goes through ntfy.sh, a free service Ozzie doesn't run. It holds only a fixed line, such as "${PHONE_EXAMPLE}", and never a name, a number or a link.`;
export const PHONE_SEEN = "ntfy.sh, and the phone makers' services it uses to reach your phone (Google's, and Apple's for an iPhone), can see which line was sent and when; ntfy.sh also sees this Mac's internet address and keeps each line for a while (about half a day by its usual setting).";
export const PHONE_RISK = "Anyone who learned your channel name could read those lines too, and could send your phone a notice that looks like Ozzie's. Ozzie's own notices are only these fixed lines and never hold a link. That's why Ozzie makes a long, random channel name, and why you can make a new one at any time.";
export const PHONE_QUIET = "Quiet hours apply, as they do to notices on this Mac.";
export const TEST_BUTTON = "Send a test notice";
export const COPY_BUTTON = "Copy channel name";
export const NEW_BUTTON = "Make a new channel";
export const KEEP_BUTTON = "Keep this one";
export const PHONE_STEPS = [
  "On your phone, install the free ntfy app from the App Store or Google Play.",
  "In ntfy, choose Subscribe to topic (the + button).",
  "Type or paste the channel name below as the topic name, then subscribe.",
  `Then press ${TEST_BUTTON} here.`,
] as const;
export const PHONE_BACKGROUND = "A notice that is only about a background check stays on this Mac: nothing goes to your phone for it.";
export const PHONE_HOW = [
  "Ozzie picks the line on this Mac from a short fixed list, one for each kind of notice. Nothing Ozzie reads or you type goes into it.",
  "It goes straight to ntfy.sh over an encrypted connection, once. If ntfy.sh doesn't answer within 10 seconds, Ozzie lets it go; the notice on this Mac is sent either way.",
  PHONE_BACKGROUND,
  "Phone notices: at most 12 an hour while Ozzie is running, test notices included.",
  "The channel name is kept in this Mac's Keychain. It isn't in the copies Ozzie saves of its checks or in Ozzie's record of what happened.",
  "The channel name is shown on this screen and put on the clipboard when you copy it. If either was shared, in a screen recording or a screenshot for example, make a new one.",
  "Making a new channel or turning this off means the old channel gets nothing more from Ozzie, except a notice that was already on its way at that moment.",
] as const;
export const NEW_CONFIRM = "Your phone stops getting notices until you subscribe to the new channel in ntfy. The old one gets nothing more.";
export const NEW_DONE = "Ozzie made a new channel. Subscribe to it in ntfy; you can remove the old one there.";
export const PHONE_ON_PROBLEM = "Ozzie couldn't turn this on. Try again.";
export const PHONE_OFF_PROBLEM = "Ozzie couldn't turn this off. Try again.";
export const PHONE_FORGET_PROBLEM = "Ozzie stopped sending, but couldn't forget the channel just now. It will try again the next time Ozzie opens.";
export const PHONE_NEW_PROBLEM = "Ozzie couldn't make a new channel. The one shown still works. Try again.";
export const PHONE_UNREADABLE = "Ozzie couldn't read this channel's name just now, so nothing can be sent to your phone. Make a new channel, then subscribe to it in ntfy.";

/** What "Send a test notice" came to, by native's closed codes (core/native-auth phone_notice.rs `Outcome`). */
export const TEST_RESULTS: Readonly<Record<string, string>> = {
  "accepted": "ntfy.sh accepted the test notice. It should show on your phone in a moment. If it doesn't, check the channel name in ntfy.",
  "refused": "ntfy.sh didn't accept the test notice just now. Try again in a few minutes.",
  "unreachable": "Ozzie couldn't reach ntfy.sh. Check this Mac's internet connection and try again.",
  "off": "This is turned off, so nothing was sent.",
  "unavailable": "Ozzie couldn't read this channel's name, so nothing was sent. Make a new channel and try again.",
  "too-many": "Ozzie has already sent 12 phone notices in the last hour, so nothing was sent. Try again later.",
};
export const testResult = (code: unknown): string => (typeof code === "string" && Object.hasOwn(TEST_RESULTS, code) ? TEST_RESULTS[code]! : TEST_RESULTS["unavailable"]!);

/** The last phone notice under the test button, by the same codes: what became of it, after its time. */
export const LAST_RESULTS: Readonly<Record<string, string>> = {
  "accepted": "sent.",
  "refused": "not sent: ntfy.sh didn't accept it.",
  "unreachable": "not sent: ntfy.sh couldn't be reached.",
  "off": "not sent: this was turned off.",
  "unavailable": "not sent: Ozzie couldn't read the channel name.",
  "too-many": "not sent: Ozzie had already sent 12 in the last hour.",
};
export const LAST_NONE = "Nothing has been sent to your phone yet.";
const clock = (ms: number, zone?: string) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) });
const dayKey = (ms: number, zone?: string) => new Date(ms).toLocaleDateString("en-CA", zone ? { timeZone: zone } : {});
/** "Last notice to your phone: today at 9:02 AM, sent." in this Mac's time (as updates.ts says its last check). */
export function lastLine(last: LastNotice | null | undefined, nowMs: number, zone?: string): string {
  if (!last) return LAST_NONE;
  const at = last.at_ms;
  const when = dayKey(at, zone) === dayKey(nowMs, zone) ? "today"
    : dayKey(at, zone) === dayKey(nowMs - 86_400_000, zone) ? "yesterday"
      : new Date(at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(zone ? { timeZone: zone } : {}) });
  return `Last notice to your phone: ${when} at ${clock(at, zone)}, ${LAST_RESULTS[last.outcome] ?? LAST_RESULTS["unavailable"]!}`;
}

/** What Settings shows. `note`: what the last action came to (a test notice, a new channel), said once. */
export interface PhoneState extends PhoneView { busy: boolean; problem: string | null; note: string | null; confirmingNew: boolean; last: LastNotice | null }
const OFF: PhoneState = { on: false, channel: null, last: null, busy: false, problem: null, note: null, confirmingNew: false };
/** Only a last notice native sent: one of its codes and a time. */
function lastOf(value: unknown): LastNotice | null {
  if (!value || typeof value !== "object") return null;
  const { outcome, at_ms } = value as { outcome?: unknown; at_ms?: unknown };
  return typeof outcome === "string" && Object.hasOwn(LAST_RESULTS, outcome) && typeof at_ms === "number" && Number.isFinite(at_ms) && at_ms >= 0
    ? { outcome, at_ms } : null;
}
/** Only a view native sent: `on` a boolean and a channel a string, else off. */
function viewOf(value: unknown): PhoneView & { last: LastNotice | null } {
  if (!value || typeof value !== "object") return { on: false, channel: null, last: null };
  const { on, channel, last } = value as { on?: unknown; channel?: unknown; last?: unknown };
  return { on: on === true, channel: on === true && typeof channel === "string" && channel ? channel : null, last: on === true ? lastOf(last) : null };
}

/** Turning it on and off, a new channel and a test notice, as kept natively; one at a time, in the order asked. */
export class PhoneControl {
  #state: PhoneState;
  #changed = false;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #invoke: Invoke;
  readonly #show: (state: PhoneState) => void;
  constructor(invoke: Invoke, show: (state: PhoneState) => void, initial?: PhoneView) {
    this.#invoke = invoke; this.#show = show;
    this.#state = initial ? { ...OFF, ...viewOf(initial) } : OFF;
  }
  get state(): PhoneState { return this.#state; }
  #set(patch: Partial<PhoneState>) { this.#state = { ...this.#state, ...patch }; this.#show(this.#state); }
  #inOrder<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => undefined);
    return next;
  }
  #status(): Promise<PhoneView & { last: LastNotice | null }> {
    return this.#invoke<unknown>("phone_notice_status").then(viewOf, () => ({ on: false, channel: null, last: null }));
  }

  /** Whether native has it on, its channel and its last phone notice. Off when it can't say. A choice made meanwhile wins. */
  async load(): Promise<void> {
    const view = await this.#inOrder(() => this.#status());
    if (!this.#changed) this.#set(view);
  }

  /** The leader's switch. */
  async change(on: boolean): Promise<void> {
    this.#changed = true;
    this.#set({ busy: true, problem: null, note: null, confirmingNew: false });
    await this.#inOrder(async () => {
      if (on) {
        try { this.#set({ ...viewOf(await this.#invoke<unknown>("phone_notice_on")), busy: false }); }
        catch { this.#set({ ...(await this.#status()), busy: false, problem: PHONE_ON_PROBLEM }); }
        return;
      }
      try { await this.#invoke<void>("phone_notice_off"); this.#set({ on: false, channel: null, last: null, busy: false }); }
      catch {
        const now = await this.#status();
        this.#set({ ...now, busy: false, problem: now.on ? PHONE_OFF_PROBLEM : PHONE_FORGET_PROBLEM });
      }
    });
  }

  /** "Make a new channel" asks first; the leader confirms or keeps the one they have. */
  askNew(asking: boolean): void { this.#set({ confirmingNew: asking, note: null, problem: null }); }
  async newChannel(): Promise<void> {
    this.#set({ busy: true, confirmingNew: false, note: null, problem: null });
    await this.#inOrder(async () => {
      try { this.#set({ ...viewOf(await this.#invoke<unknown>("phone_notice_new_channel")), busy: false, note: NEW_DONE }); }
      catch { this.#set({ ...(await this.#status()), busy: false, problem: PHONE_NEW_PROBLEM }); }
    });
  }

  /** One fixed test line; what ntfy.sh made of it, in plain words, and it becomes the last phone notice shown. */
  async test(): Promise<void> {
    this.#set({ busy: true, note: null, problem: null, confirmingNew: false });
    await this.#inOrder(async () => {
      let answer: unknown = null;
      try { answer = await this.#invoke<unknown>("phone_notice_test"); } catch { answer = null; }
      const last = lastOf(answer);
      this.#set({ busy: false, note: testResult(last?.outcome), ...(last ? { last } : {}) });
    });
  }
}

export const phoneInvoke: Invoke = nativeInvoke;
