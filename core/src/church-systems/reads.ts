// Which parts of a B1 Church or Breeze check didn't read in full, for What happened, the schedule's "nothing new" and
// the ledger's complete or partial. A read the system cuts short by its own rule, every time, isn't a failure: counting
// it would mark every check of that system partial (seen live, round 3: B1 lists only the forms the key's maker may
// manage, so `b1.forms` is always `truncated`, and every B1 check read as "part of it couldn't be read"). What each of
// those reads holds is said where it is shown (facts.ts, the service page's "Also read").
import { READS, type CapturePart, type SystemCapture, type SystemId } from "./types.js";

/**
 * Reads cut short by design, never by a failure (a failed one still counts): B1 Church lists only the forms the person
 * who made the key may manage (native b1.rs: never `ok`); Breeze's entries are counted for its 5 newest forms only
 * (facts.ts NEWEST_ONLY). Each fills only an "also read" part, never the service check.
 */
export const PARTIAL_BY_DESIGN: Readonly<Record<SystemId, ReadonlySet<string>>> = Object.freeze({
  b1: new Set(["b1.forms"]), breeze: new Set(["breeze.form_entries"]), genesis: new Set<string>(),
});

/** Whether one read was cut short by design (PARTIAL_BY_DESIGN), never by a failure: What happened lists it as read. */
export const shortByDesign = (system: SystemId, read: string, outcome: string): boolean =>
  outcome === "truncated" && PARTIAL_BY_DESIGN[system].has(read);

/** The parts of the check that didn't read in full, in CAPTURE_PARTS order, by their closed words; empty when every read ended whole. */
export function unreadParts(capture: SystemCapture): CapturePart[] {
  const parts = new Set<CapturePart>();
  for (const r of capture.reads) {
    if (r.outcome === "ok" || r.outcome === "not-requested" || shortByDesign(capture.system, r.read, r.outcome)) continue;
    for (const part of READS[capture.system][r.read] ?? []) parts.add(part);
  }
  return CAPTURE_PARTS.filter(p => parts.has(p));
}

/** Each part in a few plain words, to finish "part of it couldn't be read: …". */
export const PART_NAMES: Readonly<Record<CapturePart, string>> = Object.freeze({
  church: "your church's account", service: "the service's times", busy: "other plans the same people are on", positions: "roles",
  assignments: "who is scheduled", team_members: "team members", blockouts: "blockouts", people: "names", groups: "groups", events: "events",
  forms: "forms",
});
export const CAPTURE_PARTS: readonly CapturePart[] = Object.freeze(Object.keys(PART_NAMES) as CapturePart[]);
