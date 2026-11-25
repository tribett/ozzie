import { isTimeZone, localDate, offsetAt } from "../church-time.js";
import { validate } from "./validate.js";

/** Whether `start` is at 5 PM or later on the same day as `at`, on `zone`'s clock (a zone not known here: never). */
function sameEvening(start: string, at: string, zone: string): boolean {
  const s = Date.parse(start), a = Date.parse(at);
  if (!Number.isFinite(s) || !Number.isFinite(a) || !isTimeZone(zone)) return false;
  return localDate(s, zone) === localDate(a, zone) && new Date(s + offsetAt(s, zone)).getUTCHours() >= 17;
}

export type Outcome = "complete" | "partial" | "stale" | "denied";
export interface Binding { workspace_id: string; account_id: string }
export interface Anchor { start: number; end: number; quote: string }
export interface Message extends Binding { id: string; received_at: string; subject: string; body: string }
export interface CalendarEvent extends Binding {
  id: string; modified_at: string; title: string; start_at: string; end_at: string;
  location: string; status: "confirmed" | "cancelled" | "unknown";
}
export interface Assertion {
  kind: "location-unavailable" | "event-cancelled" | "explicitly-no-action" | "untrusted-instruction";
  message_id: string; event_id: string | null; anchor: Anchor; not_contacted: Anchor | null;
}
export interface AttentionInput extends Binding {
  kind: "fictional-import"; host: Binding; timezone: "America/New_York";
  imported_at: string; evaluated_at: string; valid_until: string;
  scopes: Record<"mail" | "calendar", { outcome: Outcome; expected_ids: string[] }>;
  messages: Message[]; events: CalendarEvent[]; assertions: Assertion[];
}
export interface AttentionFinding {
  id: string; title: string; statement: string; source_ids: string[];
  rule: "review-operational-disagreement"; why_now: string; next_step: string;
  urgent: boolean; uncertain: boolean; communication: string;
  start_at: string | null; end_at: string | null; imported_at: string; evaluated_at: string;
  evidence: Assertion[];
}
export interface AttentionReport {
  ok: true; kind: "fictional-import"; workspace_id: string; account_id: string;
  imported_at: string; evaluated_at: string; valid_until: string;
  status: "needs-attention" | "worth-a-look" | "checked-import-clear";
  stale: boolean; gaps: string[]; findings: AttentionFinding[]; sources: (Message | CalendarEvent)[];
}
export type AttentionResult = AttentionReport | { ok: false; error: "invalid-import" | "binding-denied" };

/** Reviewed fictional assertions only. No text extraction or external capability. */
export function evaluateAttentionImport(value: unknown): AttentionResult {
  let input: AttentionInput;
  try {
    const checked = validate(value);
    if (typeof checked === "string") return { ok: false, error: checked };
    // Validate before cloning so ordinary source accessors are never read.
    input = structuredClone(checked);
  } catch {
    // Proxy traps and clone failures must not expose caller-owned errors.
    return { ok: false, error: "invalid-import" };
  }
  const findings: AttentionFinding[] = [];
  const stale = Date.parse(input.evaluated_at) >= Date.parse(input.valid_until) ||
    input.scopes.mail.outcome === "stale" || input.scopes.calendar.outcome === "stale";
  const calendarChecked = input.scopes.calendar.outcome === "complete" && input.events.length > 0 &&
    input.scopes.calendar.expected_ids.every(id => input.events.some(e => e.id === id));
  const gaps = calendarChecked ? [] : ["Calendar coverage could not be verified for this import."];
  if (stale) gaps.push("This is a stale recorded import; source changes have not been checked.");
  const mailChecked = input.scopes.mail.outcome === "complete" && input.messages.length > 0 &&
    input.scopes.mail.expected_ids.every(id => input.messages.some(e => e.id === id));
  if (!mailChecked) gaps.push("Mail coverage could not be verified for this import.");
  if (input.scopes.calendar.outcome !== "denied" && input.events.some(e => e.status === "unknown")) {
    gaps.push("Calendar status is unknown in this import; current plans need human verification.");
  }
  const assertions = [...new Map(input.assertions.map(a => [assertionKey(a), a])).values()]
    .sort((a, b) => compare(assertionKey(a), assertionKey(b)));
  const eventIds = [...new Set(assertions.filter(a => a.kind === "location-unavailable" || a.kind === "event-cancelled")
    .map(a => a.event_id!))].sort(compare);
  for (const eventId of input.scopes.mail.outcome === "denied" ? [] : eventIds) {
    const evidence = assertions.filter(a => a.event_id === eventId);
    const kinds = new Set(evidence.map(a => a.kind));
    const contradictory = kinds.size > 1;
    const event = calendarChecked ? input.events.find(e => e.id === eventId) : undefined;
    const cancelled = kinds.has("event-cancelled");
    const untilStart = event ? Date.parse(event.start_at) - Date.parse(input.evaluated_at) : null;
    const passed = untilStart !== null && untilStart <= 0;
    const knownStatus = event?.status === "confirmed";
    const uncertain = !event || !knownStatus || !mailChecked || stale || passed || contradictory;
    // The scene's orientation, still to come on the evening of the day the import was read (on the import's own clock): "tonight". It was
    // the scene's two exact times until the example church began to follow the calendar (example-dates.ts).
    const tonight = event?.title === "Volunteer orientation" && !passed && sameEvening(event.start_at, input.evaluated_at, input.timezone);
    findings.push({
      id: JSON.stringify([input.workspace_id, input.account_id, eventId, [...kinds].sort(compare)]),
      source_ids: [...new Set([...evidence.map(a => a.message_id), ...(event ? [event.id] : [])])].sort(compare),
      title: contradictory ? "Prepared statements need a human review."
        : cancelled ? tonight ? "Tonight's orientation needs a plans decision." : "The recorded event needs a plans decision."
          : tonight ? "Tonight's orientation needs a location decision." : "The recorded event needs a location decision.",
      statement: contradictory ? "Reviewed message statements differ. Check every quoted statement and the calendar before deciding."
        : event && !knownStatus ? "A message reports an operational change; the calendar status needs human review."
        : cancelled ? event ? tonight ? "A message reports tonight's orientation cancelled; the calendar still shows it confirmed."
          : "A message reports the event cancelled; the calendar still shows it confirmed."
        : "A message reports the orientation cancelled; the calendar could not be verified."
        : event ? "A message reports the room unavailable; the calendar still lists it."
          : "A message reports the room unavailable; the calendar could not be verified.",
      rule: "review-operational-disagreement",
      why_now: passed ? "The recorded event has started or passed. Verify the current plans yourself."
        : "A person needs to decide before the event starts.",
      next_step: cancelled ? "Verify the plans and communicate any cancellation yourself." : "Decide the location and communicate the plans yourself.",
      urgent: untilStart !== null && untilStart > 0 && untilStart <= 48 * 60 * 60 * 1000 && !uncertain,
      uncertain,
      communication: evidence.some(a => a.not_contacted) ? "According to the message, volunteers have not been contacted."
        : "Communication status is unknown; no delivery was checked.",
      start_at: event?.start_at ?? null, end_at: event?.end_at ?? null, imported_at: input.imported_at, evaluated_at: input.evaluated_at,
      evidence,
    });
  }
  return {
    ok: true, kind: "fictional-import", workspace_id: input.workspace_id, account_id: input.account_id,
    imported_at: input.imported_at, evaluated_at: input.evaluated_at, valid_until: input.valid_until,
    status: gaps.length || findings.some(f => f.uncertain) ? "worth-a-look" : findings.length ? "needs-attention" : "checked-import-clear", stale, gaps,
    sources: [...(input.scopes.calendar.outcome === "denied" ? [] : input.events),
      ...(input.scopes.mail.outcome === "denied" ? [] : input.messages)].sort((a, b) => compare(a.id, b.id)), findings,
  };
}

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const assertionKey = (a: Assertion) => JSON.stringify([a.kind, a.message_id, a.event_id, a.anchor.start, a.anchor.end,
  a.anchor.quote, a.not_contacted?.start, a.not_contacted?.end, a.not_contacted?.quote]);
