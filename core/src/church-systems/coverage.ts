// Maps a B1 Church or Breeze capture (types.ts) into the pure coverage engine's input (core/src/coverage.ts), the
// sibling of core/src/sunday-capture.ts `captureToCoverage`. Pure: no I/O, no clock, no model.
// It returns ids only: no name or label from the capture is in anything it returns. A read that failed, a time with
// no end, an answer Ozzie doesn't know and a fact the system doesn't give all stay "couldn't be verified" here, so the
// engine can't turn them into "covered".
import type {
  Completeness, CoverageCandidate, CoverageInput, CoveragePosition, CoverageScope, Observation, ScheduledPerson, ServingAssignment, ServingInterval,
} from "../coverage.js";
import { localDay } from "../church-time.js";
import { dayWords, UNKNOWN_WORDS, type DayWords } from "../service-day.js";
import { LIVE_CHECK_VALID_MS } from "../sunday-capture.js";
import { labelsOf } from "./placeholders.js";
import {
  instant, isKnownZone, readsFor, SYSTEMS, untimed, type AssignmentStatus, type CapturePart, type ReadOutcome, type SystemAssignment, type SystemCapture,
  type SystemId,
} from "./types.js";

/**
 * The Church rules this needs: teams where the church expects a scheduled Sunday lead, by the lead role's name (the
 * same shape as SundayRules `sundayLeads`, but `team_id` is the other system's own team id, B1 Church's group id), and
 * the time zone the leader confirmed in Ozzie (facts.ts `toConfirm`).
 */
export interface SystemLeadRules {
  sundayLeads: readonly { team_id: string; lead_position: string }[];
  /**
   * The IANA zone the leader confirmed in Ozzie; null or absent: none. Where the system's zone may be a default or
   * missing (B1 Church), the check runs only when this is a zone this Mac knows and is exactly the zone the capture
   * carries: a confirmation for one zone never covers a capture placed in another.
   */
  confirmedZone?: string | null;
}
export type SystemRules = SystemLeadRules;

/**
 * Why no Sunday check was built. "no-roles": the service's planning was read whole and has no roles at all, which the
 * page says plainly (facts.ts `noRoles`) instead of showing an empty check the engine would call unverified.
 */
export const COVERAGE_REFUSALS = ["no-sunday-check", "no-service", "no-roles"] as const;
/**
 * A required scope that is never read: while B1 Church's zone waits for the leader to confirm it, the check requires
 * it, so the engine reports it as a closed issue ("scope-unverified" with this scope id) and nothing reads as covered.
 */
export const ZONE_CONFIRMATION_SCOPE = "b1.zone-confirmation";
export type CoverageRefusal = (typeof COVERAGE_REFUSALS)[number];
export type SystemCoverage =
  | {
    ok: true; system: SystemId;
    /** The system's display name, as every scope's source. */
    source: string;
    service_id: string;
    /** The church's IANA zone as the system gave it; null when it didn't (then only the system's own day can name the day). */
    time_zone: string | null;
    /** The system named a zone with the right shape that this Mac's time-zone data doesn't know: treated as no zone. */
    zone_unknown: boolean;
    /**
     * The check waits for the leader to confirm the zone (facts.ts `waitingForZone`): the service's times, blockouts
     * and day are all held back, and the engine reports `scope-unverified` on ZONE_CONFIRMATION_SCOPE.
     */
    waiting_for_zone: boolean;
    /**
     * A zone was confirmed, but the capture carries a different one (or none): the page runs a fresh read with the
     * confirmed zone rather than asking again. Held back meanwhile, like any check waiting for its zone.
     */
    zone_mismatch: boolean;
    /**
     * Whether the checked plan is shared with volunteers yet (B1 Church; null when the system doesn't say). A plan not
     * shared yet is still checked; the page labels it (facts.ts `sharedLabel`, `notSharedNotice`).
     */
    plan_shared: boolean | null;
    /** People on the service with no role (facts.ts `onServiceWithoutRole`): offered for no role, counted toward none. */
    on_service_count: number;
    /**
     * The zone may be one the system set by default (B1 Church) and the leader hasn't confirmed it: ask once (facts.ts
     * `toConfirm`). Until then blockouts don't count and `day` names no day.
     */
    zone_needs_confirming: boolean;
    /** The service's real day (core/src/service-day.ts): the system's own calendar day, else its start in the church's zone. */
    day: DayWords;
    input: CoverageInput;
  }
  | { ok: false; reason: CoverageRefusal };

/** The parts of a capture the Sunday check reads. Scopes are built for these reads only. */
const COVERAGE_PARTS: readonly CapturePart[] = ["service", "busy", "positions", "assignments", "team_members", "blockouts"];
/** The parts every conclusion depends on: a failure in any of them must make the whole check unverified. */
const REQUIRED_PARTS: readonly CapturePart[] = ["service", "positions", "assignments"];

/** One read outcome's completeness, as sunday-capture.ts maps Planning Center outcomes (a refusal is "denied"). */
const COMPLETENESS: Readonly<Record<ReadOutcome, Completeness>> = {
  ok: "complete", truncated: "partial", "not-requested": "unreadable",
  refused: "denied", "key-refused": "denied", "invalid-response": "unverified",
  "not-found": "unreadable", "rate-limited": "unreadable", timeout: "unreadable", unreachable: "unreadable", "too-large": "unreadable",
};
const WORST: readonly Completeness[] = ["denied", "unverified", "unreadable", "partial", "complete"];
/** The completeness of a read from all its pages: the worst page wins; no page at all is unreadable. */
export function completenessOf(outcomes: readonly ReadOutcome[]): Completeness {
  if (!outcomes.length) return "unreadable";
  const each = new Set(outcomes.map(o => COMPLETENESS[o]));
  return WORST.find(c => each.has(c))!;
}

const STATUS: Readonly<Record<AssignmentStatus, ServingAssignment["status"]>> = { accepted: "C", unconfirmed: "U", declined: "D", unknown: "unknown" };

/** Appends to the list kept under `key`. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

export function systemCaptureToCoverage(capture: SystemCapture, rules: SystemLeadRules, now: string): SystemCoverage {
  const info = SYSTEMS[capture.system];
  if (!info.sundayCheck) return { ok: false, reason: "no-sunday-check" };
  const service = capture.service;
  if (!service) return { ok: false, reason: "no-service" };
  const words = (part: CapturePart) => readsFor(capture.system, part);
  // Every page of every read that fills `part` is in the capture and ended ok.
  const readWhole = (part: CapturePart) => words(part).every(w => {
    const reads = capture.reads.filter(r => r.read === w);
    return reads.length > 0 && reads.every(r => r.outcome === "ok");
  });
  // No roles, from roles and answers read whole: a fact. From any read that failed, was cut short or is missing, the
  // check goes on and the engine says it couldn't be verified.
  if (!capture.positions.length && readWhole("positions") && readWhole("assignments")) return { ok: false, reason: "no-roles" };

  // Scopes: one per read word the Sunday check uses, from every page of it.
  const used = new Set(COVERAGE_PARTS.flatMap(words));
  const grouped = new Map<string, { checked_at: string; outcome: ReadOutcome }[]>();
  for (const read of capture.reads) if (used.has(read.read)) push(grouped, read.read, read);
  const scopes: CoverageScope[] = [...grouped].map(([scope_id, reads]) => {
    const check = reads.map(r => r.checked_at).sort((a, b) => instant(a) - instant(b))[0]!;
    return {
      scope_id, source: info.name, check_time: check,
      valid_until: new Date(instant(check) + LIVE_CHECK_VALID_MS).toISOString(),
      completeness: completenessOf(reads.map(r => r.outcome)),
    };
  });
  const complete = new Set(scopes.filter(s => s.completeness === "complete").map(s => s.scope_id));
  // The service, its roles and its answers are always required (missing or failed, they poison every conclusion).
  // So is the team read once any role has a team: unread, it would leave no one offered, which looks like a team with
  // nobody free. A failed blockout or busy read only makes the observations that rely on it unverified.
  const teamRequired = capture.positions.some(p => p.team_id !== null) ? words("team_members") : [];
  // A possibly-default zone not yet confirmed (below) adds one required scope that is never read.
  const zoneScope = `${capture.system}.zone-confirmation`;
  const positionsScope = words("positions")[0]!, assignmentsScope = words("assignments")[0]!;
  const teamScope = words("team_members")[0] ?? positionsScope;
  const blockoutWords = words("blockouts"), busyWords = words("busy");
  // A system with no blockouts has no read of them: its candidates' availability rests on the team read, as unknown.
  const blockoutScope = blockoutWords[0] ?? teamScope;
  // A zone that may be the system's default, not yet confirmed by the leader: native placed day blockouts in it, so
  // they may sit on the wrong day. Until it is confirmed they don't count, and no day is named.
  // Known means a zone this Mac knows in its canonical spelling (types.ts isKnownZone): any other spelling is no zone.
  const knownZone = capture.church.time_zone !== null && isKnownZone(capture.church.time_zone) ? capture.church.time_zone : null;
  // B1 Church: held back until the leader has confirmed a zone and the capture carries it, a zone this Mac knows. With
  // no zone from B1 (a new church has none), B1's own stored day places blockouts, a day early far ahead of UTC.
  const confirmed = isKnownZone(rules?.confirmedZone) ? rules.confirmedZone : null;
  const zoneMatches = confirmed !== null && capture.church.time_zone === confirmed;
  const zonePending = info.zoneMayBeDefault && !zoneMatches;
  const zoneMismatch = info.zoneMayBeDefault && confirmed !== null && !zoneMatches;
  const required_scope_ids = [...new Set([...REQUIRED_PARTS.flatMap(words), ...teamRequired, ...complete, ...(zonePending ? [zoneScope] : [])])];
  const blockoutsKnown = !zonePending && capture.blockouts !== null && blockoutWords.length > 0 && blockoutWords.every(w => complete.has(w));
  const busyKnown = capture.busy !== null && busyWords.length > 0 && busyWords.every(w => complete.has(w));
  // Other commitments not read: their observation sits in a scope that is never complete, as sunday-capture.ts leaves
  // an unread person's schedules, so the engine says they couldn't be verified. The read's own word when there is one.
  const busyScope = busyKnown || (busyWords[0] !== undefined && !complete.has(busyWords[0])) ? busyWords[0]! : `${capture.system}.busy:not-read`;

  // The service's interval: both ends with explicit offsets (types.ts checks the offsets), or unknown.
  // Native picks which plan times are the service by the church's zone, so with that zone unconfirmed the interval
  // is unknown: every role and answer is unverified and nobody is suggested.
  // A Breeze service with no time of day (written as the church's midnight, types.ts `untimed`) and no end is served over
  // its whole day, to the next midnight on the church's clock: its day is known, so no answer is made unverified for want
  // of a time (round 4). Only Breeze writes it so; with no zone or day to place the next midnight, it stays unknown.
  const wholeDay = capture.system === "breeze" && service.ends_at === null && untimed(service.starts_at) && knownZone && service.day
    ? localDay(service.day, knownZone) : null;
  const ends_at = service.ends_at ?? (wholeDay && Date.parse(wholeDay.starts_at) === instant(service.starts_at) ? wholeDay.ends_at : null);
  const interval: ServingInterval | null = !zonePending && ends_at !== null && Number.isFinite(instant(service.starts_at)) &&
    Number.isFinite(instant(ends_at)) ? { starts_at: service.starts_at, ends_at } : null;
  const target = interval ? [instant(interval.starts_at), instant(interval.ends_at)] as const : null;
  const serving = (a: SystemAssignment): ServingAssignment => ({
    // Whether the request was sent, as sunday-capture.ts takes Planning Center's sent time; unknown where the system doesn't say.
    assignment_id: a.id, status: STATUS[a.status], notification: a.asked === true ? "sent" : a.asked === false ? "unsent" : "unknown",
    intervals: interval ? [{ ...interval }] : [], time_semantics: interval ? "verified" : "unverified",
  });

  // Indexes, built once, so the mapping stays near-linear at the parser's caps.
  // Someone on the service with no role is treated like someone with an answer on it: never offered for a role. They
  // fill no role.
  const onService = new Set([...capture.assignments.map(a => a.person_id), ...capture.on_service]);
  const byPosition = new Map<string, SystemAssignment[]>();
  for (const a of capture.assignments) push(byPosition, a.position_id, a);
  const byTeam = new Map<string, string[]>();
  for (const m of capture.team_members) push(byTeam, m.team_id, m.person_id);
  const blockoutsOf = new Map<string, ServingInterval[]>();
  if (blockoutsKnown) for (const b of capture.blockouts!) push(blockoutsOf, b.person_id, { starts_at: b.starts_at, ends_at: b.ends_at });
  const busyOf = new Map<string, ServingAssignment[]>();
  // Something else the person is scheduled for is a real commitment at its own time: confirmed where they said yes,
  // unconfirmed where they haven't answered (the engine then says "possible conflict", as for Planning Center).
  if (busyKnown) capture.busy!.forEach((b, index) => push(busyOf, b.person_id, {
    assignment_id: `busy:${index}`, status: b.answer === "accepted" ? "C" : "U", notification: "unknown",
    intervals: [{ starts_at: b.starts_at, ends_at: b.ends_at }], time_semantics: "verified",
  }));

  // What is known about one person who could help, the same on every role they're offered for.
  const personFacts = new Map<string, Omit<CoverageCandidate, "person_id">>();
  const factsOf = (person: string): Omit<CoverageCandidate, "person_id"> => {
    const known = personFacts.get(person);
    if (known) return known;
    const theirs = blockoutsKnown ? blockoutsOf.get(person) ?? [] : null;
    const availability = theirs === null || target === null ? "unknown" as const
      : theirs.some(b => instant(b.starts_at) < target[1] && target[0] < instant(b.ends_at)) ? "unavailable" as const : "available" as const;
    const facts = {
      membership: { scope_id: teamScope, value: true },
      // Where the system ties a team to each role (B1 Church: the position's group is who may serve in it), being on
      // that team is eligibility. Elsewhere (Breeze tags) it isn't the system saying the person can do the role.
      eligibility: { scope_id: teamScope, value: info.teamMembers ? true : null },
      availability: { scope_id: blockoutScope, value: availability },
      blockouts: { scope_id: blockoutScope, value: theirs },
      assignments: { scope_id: busyScope, value: busyKnown ? busyOf.get(person) ?? [] : [] },
    };
    personFacts.set(person, facts);
    return facts;
  };

  // Leads: no system marks a Sunday lead, so Church rules name the lead role on a team, matched to this system's role names.
  const labels = labelsOf(capture);
  const roleName = (id: string) => Object.hasOwn(labels, `position:${id}`) ? labels[`position:${id}`] : undefined;
  const leadNames = new Map((Array.isArray(rules?.sundayLeads) ? rules.sundayLeads : [])
    .filter(l => typeof l?.team_id === "string" && typeof l.lead_position === "string").map(l => [l.team_id, l.lead_position]));
  const rolesOf = new Map<string, string[]>();
  for (const p of capture.positions) if (p.team_id !== null) push(rolesOf, p.team_id, p.id);
  type Lead = { lead: Observation<CoveragePosition["lead"]["value"]>; extra: SystemAssignment[] };
  const leads = new Map<string, Lead>();
  const leadOf = (team: string | null): Lead => {
    const observe = (value: CoveragePosition["lead"]["value"]) => ({ scope_id: assignmentsScope, value });
    const name = team === null ? undefined : leadNames.get(team);
    if (team === null || name === undefined) return { lead: observe({ mapping: "not-required", assignment_ids: [] }), extra: [] };
    const known = leads.get(team);
    if (known) return { lead: observe({ ...known.lead.value, assignment_ids: [...known.lead.value.assignment_ids] }), extra: known.extra };
    const roles = rolesOf.get(team) ?? [];
    // A role on the team with no name might be the lead role: unknown, never "missing".
    const result: Lead = roles.some(id => roleName(id) === undefined)
      ? { lead: observe({ mapping: "unknown", assignment_ids: [] }), extra: [] }
      : (() => {
        const extra = roles.filter(id => roleName(id) === name).flatMap(id => byPosition.get(id) ?? []);
        return { lead: observe({ mapping: "required", assignment_ids: extra.map(a => a.id) }), extra };
      })();
    leads.set(team, result);
    return result;
  };

  const positions: CoveragePosition[] = capture.positions.map(p => {
    const own = byPosition.get(p.id) ?? [];
    const { lead, extra } = leadOf(p.team_id);
    const assignments = [...own, ...extra.filter(a => a.position_id !== p.id)].map(serving);
    // Needed minus the distinct people who said yes or haven't answered, floor 0: one person twice on a role fills one
    // place. Unknown when the number wanted, the answers read, or any one answer is unknown: no zero is inferred.
    const filling = new Set(own.filter(a => a.status === "accepted" || a.status === "unconfirmed").map(a => a.person_id)).size;
    const need = p.needed === null || !complete.has(assignmentsScope) || own.some(a => a.status === "unknown")
      ? null : Math.max(0, p.needed - filling);
    const people = p.team_id === null ? [] : [...new Set(byTeam.get(p.team_id) ?? [])].filter(person => !onService.has(person));
    const candidates: CoverageCandidate[] = people.map(person => ({ person_id: person, ...factsOf(person) }));
    // Who each of this role's assignments is, with their own blockouts, so someone who said yes (or hasn't answered) and
    // is blocked out over the service is pointed out, as on Planning Center (design §11). Only where the system has
    // blockouts (B1 Church): Breeze has none, so none is checked. Blockouts not known whole (a read cut short, the zone
    // not yet confirmed) are null in the blockouts' own scope, so the engine never reads them as clear.
    const scheduled: ScheduledPerson[] | undefined = info.blockouts
      ? [...own, ...extra.filter(a => a.position_id !== p.id)].map(a => ({
        assignment_id: a.id, person_id: a.person_id,
        blockouts: { scope_id: blockoutScope, value: blockoutsKnown ? [...(blockoutsOf.get(a.person_id) ?? [])].map(b => ({ ...b })) : null },
      }))
      : undefined;
    return {
      position_id: p.id, team_id: p.team_id ?? "?", interval: interval ? { ...interval } : null,
      remaining_need: { scope_id: positionsScope, value: need },
      lead, assignments: { scope_id: assignmentsScope, value: assignments }, candidates,
      ...(scheduled ? { scheduled } : {}),
    };
  });

  // A zone this Mac's time-zone data doesn't know is no zone: no day is named from it and nothing asks to confirm it.
  const zone = knownZone;
  // The system's own calendar day names the service, with no zone math (a Sunday plan may start with a Saturday-evening
  // time); only without one does the first time read, in the church's zone, name it. While a possibly-default zone is
  // unconfirmed, no day is named at all: B1 Church saves the day a day early for churches far ahead of UTC, which only
  // the right zone reveals.
  // Without the system's own day, the start names the day only when the service's reads were whole: from a read cut
  // short, the start is just the earliest time native found (an evening-before rehearsal, say).
  const day = zonePending ? UNKNOWN_WORDS
    : service.day === null && !readWhole("service") ? UNKNOWN_WORDS
    : service.day !== null ? dayWords({ sort_date: `${service.day}T00:00:00`, times: [] }, zone)
    : dayWords({ sort_date: null, times: [service.starts_at] }, zone);
  return {
    ok: true, system: capture.system, source: info.name, service_id: service.id, time_zone: zone,
    zone_unknown: capture.church.time_zone !== null && zone === null,
    zone_needs_confirming: zonePending && !zoneMismatch, waiting_for_zone: zonePending, zone_mismatch: zoneMismatch,
    plan_shared: service.shared,
    // Only people listed on the service who hold no answer on it (the parser already refuses anyone in both).
    on_service_count: capture.on_service.filter(person => !capture.assignments.some(a => a.person_id === person)).length, day,
    input: { evaluated_at: now, required_scope_ids, scopes, positions },
  };
}
