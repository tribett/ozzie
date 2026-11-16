// Registrations: upcoming signups in Planning Center Registrations, how many registered against the
// overall limit when one is set, and when registration closes (or opens). Pure: no I/O, no model.
// Counts only: the native read keeps whether each attendee is active, never who they are. A count
// not fully read is "not checked" or "at least", never a number it isn't.
import { churchZone } from "../church-time.js";
import type { SundayCapture, SundayRead, SundayRules } from "../sunday-capture.js";
import { applyFeedback, feedbackOf, type CorrectionEntry, type FeedbackTarget, type StopEntry } from "../finding-feedback.js";
import { answered, attr, bodyRows, count, earliest, evaluatedAt, instant, labelOf, ms, plural, REASON, rowId, stateOf, unique } from "./common.js";
import { whenIn } from "./words.js";

export const REGISTRATIONS_SOURCE = "Planning Center Registrations";
export const REGISTRATIONS_KIND = "registration-signup";

export interface SignupFact {
  signup_id: string; name: string | null;
  /** "open": taking registrations now; "opens-later": registration hasn't opened yet. */
  state: "open" | "opens-later";
  /** Active registrations counted, or null when they weren't (fully) read. */
  registered: number | null; at_least: boolean;
  /** The signup's overall limit; null when Planning Center says there is none; undefined when it didn't say. */
  limit: number | null | undefined;
  full: boolean;
  opens_at: string | null; closes_at: string | null;
  checked_at: string; source: string; title: string;
}
export interface RegistrationsFacts {
  source: string;
  signups: SignupFact[];
  hidden?: { kind: string; key: string; entry: StopEntry | CorrectionEntry }[];
  not_checked: string[];
  checked_at: string | null;
}

/** "This isn't right" sets this signup's line aside while its count and dates stay the same. */
export const signupTarget = (s: SignupFact): FeedbackTarget => ({
  kind: REGISTRATIONS_KIND, key: `signup:${s.signup_id}`, occurrence: s.closes_at ?? s.opens_at ?? "open",
  facts: JSON.stringify([s.registered, s.at_least, s.limit ?? null, s.opens_at, s.closes_at]), tone: "look", scope: {},
  labels: { occurrence: "while these numbers stay the same" },
});

export function registrationsFacts(capture: SundayCapture, rules: SundayRules, options: { now?: string; zone?: string } = {}): RegistrationsFacts | null {
  const reads = (collection: string) => capture.reads.filter(r => r.collection === collection);
  const signupReads = reads("registrations_signups"), attendeeReads = reads("registrations_attendees");
  if (!signupReads.length && !attendeeReads.length) return null;
  const now = evaluatedAt(capture, options.now);
  const church = churchZone(capture).zone;
  const zone = church ?? options.zone ?? "UTC";
  const listState = stateOf(signupReads);
  const not_checked: string[] = listState === "ok" ? [] : [`Registrations signups: ${REASON[listState]}.`];
  const used: SundayRead[] = signupReads.filter(answered);
  const signups: SignupFact[] = [];
  let unplaced = 0;
  const seen = new Set<string>();
  for (const row of bodyRows(used)) {
    const id = rowId(row, "Signup");
    if (!id || seen.has(id) || attr(row, "archived") === true) continue;
    seen.add(id);
    const closed = attr(row, "closed"), opens_at = instant(attr(row, "open_at")), closes_at = instant(attr(row, "close_at"));
    const state = closed === false ? "open" : closed === true && opens_at && ms(opens_at) > ms(now) ? "opens-later" : closed === true ? null : undefined;
    if (state === null) continue;
    if (state === undefined) { unplaced++; continue; }
    const name = labelOf(capture, "signup", id);
    const max = attr(row, "maximum_capacity");
    const limit = max === null ? null : count(max) ?? undefined;
    let registered: number | null = null, at_least = false;
    const own = attendeeReads.filter(r => r.signup_id === id);
    if (state === "open") {
      const counted = stateOf(own);
      if (counted === "ok" || counted === "truncated") {
        used.push(...own);
        registered = unique(bodyRows(own).filter(r => rowId(r, "Attendee") && attr(r, "active") === true).map(r => r.id as string)).length;
        at_least = counted === "truncated";
      } else not_checked.push(`How many registered for ${name ?? "a signup"}: ${REASON[counted]}.`);
    }
    const full = registered !== null && typeof limit === "number" && registered >= limit;
    const closes = closes_at ? `registration closes ${whenIn(closes_at, zone)}` : "no closing date is set in Planning Center";
    const label = name ?? "A signup";
    const taken = registered === null ? null : typeof limit === "number"
      ? `${at_least ? "at least " : ""}${registered} of ${limit} places taken${full ? " (full)" : ""}`
      : `${at_least ? "at least " : ""}${plural(registered, "registered", "registered")}`;
    signups.push({
      signup_id: id, name, state, registered, at_least, limit, full, opens_at, closes_at,
      checked_at: earliest(state === "open" && registered !== null ? [...signupReads, ...own] : signupReads) ?? capture.completed_at, source: REGISTRATIONS_SOURCE,
      title: state === "opens-later" ? `${label}: registration opens ${whenIn(opens_at!, zone)}`
        : taken ? `${label}: ${taken}; ${closes}` : `${label}: registration is open; ${closes}`,
    });
  }
  if (!church && signups.length) not_checked.push("Dates for signups are in this Mac's time zone: the church's time zone wasn't read.");
  if (unplaced) not_checked.push(`${plural(unplaced, "signup")}: whether registration is open couldn't be read.`);
  // Open ones first, soonest to close (no closing date last), then those opening later, soonest first.
  const order = (s: SignupFact): [number, number] => s.state === "open" ? [0, s.closes_at ? ms(s.closes_at) : Infinity] : [1, s.opens_at ? ms(s.opens_at) : Infinity];
  signups.sort((a, b) => { const [x, y] = [order(a), order(b)]; return x[0] - y[0] || (x[1] === y[1] ? 0 : x[1] < y[1] ? -1 : 1) || (a.signup_id < b.signup_id ? -1 : 1); });
  const kept = applyFeedback(signups, signupTarget, feedbackOf(rules));
  return { source: REGISTRATIONS_SOURCE, signups: kept.shown, not_checked, checked_at: earliest(used),
    ...(kept.hidden.length ? { hidden: kept.hidden.map(h => ({ kind: REGISTRATIONS_KIND, key: `signup:${h.item.signup_id}`, entry: h.entry })) } : {}) };
}
