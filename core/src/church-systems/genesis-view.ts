// A church whose main system is Genesis (round 5): Genesis shares no volunteer schedules, so Ozzie can't check whether a
// service is covered; what it can show is what Genesis does share, plainly: the events of the next four weeks, how many
// attended the ones just past, how many times each form was filled in, and the groups. "Worth a look" only where the
// basis is clear in the data: a form filled in more times than at the last check, said as numbers. Pure; no names (Genesis
// gives none); the church's own words for events, forms and groups resolve on this Mac (placeholders.ts labels).
import { readableName, systemFacts, type EventFact, type FormFact, type GroupFact, type SystemFacts } from "./facts.js";
import { labelsOf } from "./placeholders.js";
import { instant, type SystemCapture } from "./types.js";

/** How many times each form was filled in at a check, by form id: kept on this Mac between checks (counts only). */
export type FormCounts = Readonly<Record<string, number>>;
export interface NewSubmissions { form_id: string; before: number; now: number }
export interface GenesisView {
  facts: SystemFacts;
  /** Events starting at or after `now`, soonest first. */
  upcoming: EventFact[];
  /** Events already started, with how many attended where Genesis gave it. */
  recent: EventFact[];
  /** Forms filled in more times than at the last check; empty on the first check. */
  newSubmissions: NewSubmissions[];
  /** The counts to keep for the next check. */
  counts: FormCounts;
}

/** The view of one Genesis check at `now`, against the form counts kept from the last one (null: none kept). */
export function genesisView(capture: SystemCapture, zone: string | null, now: string, previous: FormCounts | null): GenesisView {
  const facts = systemFacts(capture, { confirmedZone: zone });
  const at = instant(now) || Date.parse(now);
  const events = [...facts.events].sort((a, b) => instant(a.starts_at) - instant(b.starts_at));
  const counts = Object.fromEntries(facts.forms.filter((f): f is FormFact & { submissions: number } => f.submissions !== null && !f.at_least)
    .map(f => [f.form_id, f.submissions]));
  const newSubmissions = previous ? facts.forms.flatMap(f => {
    const before = previous[f.form_id];
    return typeof before === "number" && f.submissions !== null && !f.at_least && f.submissions > before ? [{ form_id: f.form_id, before, now: f.submissions }] : [];
  }) : [];
  return {
    facts, upcoming: events.filter(e => instant(e.starts_at) >= at), recent: events.filter(e => instant(e.starts_at) < at),
    newSubmissions, counts,
  };
}

/** "4 events in the next four weeks, 2 forms, 3 groups": what one Genesis check holds, in counts. */
export function genesisSummary(view: GenesisView): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  return `${n(view.upcoming.length, "event", "events")} in the next four weeks, ${n(view.facts.forms.length, "form", "forms")}, ${n(view.facts.groups.length, "group", "groups")}`;
}

/** Genesis shares no volunteer schedules: said wherever a covered service would be. */
export const GENESIS_NO_SCHEDULES = "Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered.";

/** One "worth a look" line: a form filled in more times than at the last check, as numbers. */
export function newSubmissionLine(n: NewSubmissions, labels: Readonly<Record<string, string>>): string {
  const name = Object.hasOwn(labels, `form:${n.form_id}`) ? readableName(labels[`form:${n.form_id}`]!) : "A form";
  const more = n.now - n.before;
  return `${name} was filled in ${more === 1 ? "once more" : `${more} more times`} since the last check (${n.now} in all).`;
}

/** The church's own name for an event, form or group, kept on this Mac; a form's slug made readable (live 2026-11-19). */
export const genesisLabel = (capture: SystemCapture, key: string, fallback: string): string => {
  const labels = labelsOf(capture);
  if (!Object.hasOwn(labels, key)) return fallback;
  return key.startsWith("form:") ? readableName(labels[key]!) : labels[key]!;
};
export type { EventFact, FormFact, GroupFact };
