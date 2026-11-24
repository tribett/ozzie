// Maps a native Sunday capture (docs/build/sunday-capture-contract.md) into the
// pure coverage engine's input. Pure: no I/O, no clock, no model.
// Names stay in `capture.names`; nothing in this module copies them into output.
import type {
  Completeness, CoverageCandidate, CoverageInput, CoveragePosition, CoverageScope,
  Observation, ScheduledPerson, ServingAssignment, ServingInterval,
} from "./coverage.js";
import type { FeedbackEntry } from "./finding-feedback.js";

export interface SundayRead {
  collection: string; team_id?: string; person_id?: string; offset: number;
  /** v2 operations reads (Calendar, People, Groups) carry their own ids, never team_id/person_id. */
  workflow_id?: string; group_id?: string; groups_person_id?: string;
  /** The Person whose People background checks were read (`people_background_checks`; same id space as person_id). */
  people_person_id?: string;
  /** calendar_conflicts reads are per Calendar event. */
  event_id?: string;
  /** Church reads (core/src/church-reads): the form, Check-Ins event or event time, or signup a read is about. */
  form_id?: string; checkins_event_id?: string; checkins_event_time_id?: string; signup_id?: string;
  /** The time window a windowed read asked for (canonical UTC). */
  window?: { starts_at: string; ends_at: string };
  /** `ok`, `truncated`, `not-requested` (turned off in Settings) or a source error reason. */
  checked_at: string; outcome: string;
  body?: { data: unknown; included?: unknown[]; meta?: { count?: number; total_count?: number } };
}
export interface SundayCapture {
  version: 1; kind: "live" | "recording";
  organization: string; service_type_id: string; plan_id: string;
  started_at: string; completed_at: string;
  reads: SundayRead[];
  names: Record<string, string>;
  /** Room, workflow and step display names (`room:<id>`, `workflow:<id>`, `step:<id>`). LOCAL ONLY, like `names`. */
  labels?: Record<string, string>;
  /** The kids teams whose scheduled people's background checks this check read (native `kids_teams`). Absent: none. */
  kids_teams?: string[];
  /** The People forms this check was given to watch, once forms were turned on (native `forms`). Absent: forms off. */
  forms?: string[];
  /** The one Check-Ins event this check read, when one was chosen then (native `checkins_event`). Absent: every listed event. */
  checkins_event?: string;
}
/** The church's own rule for one Planning Center Calendar room. */
export interface RoomRuleSetting { room_id: string; exclusive: boolean; setup_minutes: number }
/** A team the church marks as a kids team, and how many confirmed people it needs at each service time. */
/** `name`: the team's display name when it was marked, local only, so Church rules can list it after it leaves the Sunday checked. */
export interface KidsTeamSetting { team_id: string; min_confirmed: number; name?: string }
/**
 * A kids team (B1 Church: the team, by B1's own group id) or kids role (Breeze: the role, by its name's key) a church on
 * another system marks, with the confirmed people it needs (core/src/church-systems/kids.ts).
 */
export interface SystemKidsSetting { id: string; min_confirmed: number; name?: string }
export interface SundayRules {
  /** Teams where the church expects a scheduled Sunday lead, by the lead's position name. */
  sundayLeads: { team_id: string; lead_position: string }[];
  /** Check in with someone scheduled this many Sundays in a row (confirmed). 0 turns it off. */
  checkInAfterSundaysInARow: number;
  /** Rooms the church has set a rule for. Absent or empty: none set. */
  rooms?: RoomRuleSetting[];
  /** Teams the church marks as kids teams (core/src/kids-rules.ts). Absent or empty: none; no team is assumed. */
  kidsTeams?: KidsTeamSetting[];
  /** A current background check in Planning Center People before serving on a kids team. On unless set false. */
  kidsBackgroundChecks?: boolean;
  /** What the person said on finding cards (finding-feedback.ts). Read through feedbackOf, which checks every entry. */
  feedback?: FeedbackEntry[];
  /** People forms to watch for new submissions (core/src/church-reads/rules.ts). Absent or off: no form is read. */
  forms?: { on?: boolean; watched?: string[] };
  /**
   * Check-Ins (core/src/church-reads/rules.ts): the event to read last Sunday from (absent: every event), and the
   * Check-Ins rooms the leader matched to a kids team, so that team's rule can be compared with the room's count.
   */
  checkIns?: { event_id?: string; rooms?: { location_id: string; team_id: string }[] };
  /**
   * Kids teams or roles for each church on B1 Church or Breeze, by its `<system>:<church id>` (church-systems/kids.ts).
   * Absent: none. Never read for a Planning Center check.
   */
  systemKids?: Record<string, SystemKidsSetting[]>;
}
/** Calendar, People and Groups reads (contract "v2 operations reads"). They never feed Services coverage. */
export const OPERATIONS_COLLECTIONS: ReadonlySet<string> = new Set([
  "calendar_rooms", "calendar_resource_bookings", "people_workflows", "people_workflow_steps",
  "people_workflow_ready_cards", "people_workflow_snoozed_cards", "groups_person_memberships", "groups_group_events",
  "calendar_conflicts",
]);
export const isOperationsRead = (read: Pick<SundayRead, "collection">) => OPERATIONS_COLLECTIONS.has(read.collection);
/** The People background-check read (kids-rules.ts). Reported by the kids rules; never Services coverage or the operations check. */
export const KIDS_COLLECTIONS: ReadonlySet<string> = new Set(["people_background_checks"]);
export const isKidsRead = (read: Pick<SundayRead, "collection">) => KIDS_COLLECTIONS.has(read.collection);
/** People forms, Check-Ins and Registrations reads (core/src/church-reads). Never Services coverage or the operations check. */
export const CHURCH_COLLECTIONS: ReadonlySet<string> = new Set([
  "people_forms", "people_form_submissions", "checkins_events", "checkins_locations", "checkins_event_periods",
  "checkins_location_counts", "registrations_signups", "registrations_attendees",
]);
export const isChurchRead = (read: Pick<SundayRead, "collection">) => CHURCH_COLLECTIONS.has(read.collection);
/** The Services Organization read: only the church's time zone (core/src/church-time.ts). Not part of coverage. */
export const ORGANIZATION_COLLECTION = "organization";
export interface PositionLabel { position_id: string; team_id: string; name: string; interval: ServingInterval | null }
export interface MappedSunday {
  input: CoverageInput;
  positions: PositionLabel[];
  plan: { title: string | null; dates: string | null; sort_date: string | null };
}

/** How long a live check is treated as current before it must be refreshed. */
export const LIVE_CHECK_VALID_MS = 30 * 60 * 1000;

interface Row { type: string; id: string; attributes: Record<string, unknown>; relationships: Record<string, { data: unknown }> }
const asRows = (data: unknown): Row[] => (Array.isArray(data) ? data : data ? [data] : []) as Row[];
const relId = (row: Row, key: string): string | null => {
  const d = row.relationships?.[key]?.data as { id?: string } | null | undefined;
  return d && typeof d.id === "string" ? d.id : null;
};
const relIds = (row: Row, key: string): string[] => {
  const d = row.relationships?.[key]?.data;
  return Array.isArray(d) ? d.flatMap(x => typeof (x as { id?: unknown }).id === "string" ? [(x as { id: string }).id] : []) : [];
};
const str = (v: unknown): string | null => typeof v === "string" ? v : null;

function scopeId(read: Pick<SundayRead, "collection" | "team_id" | "person_id">): string {
  if (read.person_id) return `person:${read.person_id}`;
  if (read.team_id) return `team:${read.team_id}`;
  return read.collection;
}
const CORE = ["plan_times", "needed_positions", "team_members"];

function completenessOf(outcomes: string[]): Completeness {
  if (outcomes.every(o => o === "ok")) return "complete";
  if (outcomes.some(o => o === "denied" || o === "source_denied")) return "denied";
  if (outcomes.every(o => o === "ok" || o === "truncated")) return "partial";
  return "unreadable";
}

function status(v: unknown): ServingAssignment["status"] {
  switch (v) {
    case "C": case "Confirmed": return "C";
    case "U": case "Unconfirmed": return "U";
    case "D": case "Declined": return "D";
    default: return "unknown";
  }
}

export function captureToCoverage(capture: SundayCapture, rules: SundayRules, now: string): MappedSunday {
  const evaluated_at = capture.kind === "recording" ? capture.completed_at : now;
  // Scopes: one per collection/team/person, from every page read for it.
  const grouped = new Map<string, SundayRead[]>();
  for (const read of capture.reads) {
    if (read.collection === "plan" || read.collection === ORGANIZATION_COLLECTION || isOperationsRead(read) || isKidsRead(read) || isChurchRead(read)) continue;
    const id = scopeId(read);
    grouped.set(id, [...(grouped.get(id) ?? []), read]);
  }
  const scopes: CoverageScope[] = [...grouped].map(([scope_id, reads]) => {
    const check = reads.map(r => r.checked_at).sort()[0]!;
    return {
      scope_id, source: "Planning Center Services", check_time: check,
      valid_until: new Date(Date.parse(check) + LIVE_CHECK_VALID_MS).toISOString(),
      completeness: completenessOf(reads.map(r => r.outcome)),
    };
  });
  const complete = new Set(scopes.filter(s => s.completeness === "complete").map(s => s.scope_id));
  // Core scopes are always required (a failure there must poison every conclusion);
  // a failed person/team scope only makes the observations that rely on it unverified.
  const required_scope_ids = [...new Set([...CORE, ...complete])];

  const rowsOf = (scope: string, collection: string) => (grouped.get(scope) ?? [])
    .filter(r => r.collection === collection && r.body).flatMap(r => asRows(r.body!.data));
  const includedOf = (scope: string, collection: string) => (grouped.get(scope) ?? [])
    .filter(r => r.collection === collection && r.body).flatMap(r => asRows(r.body!.included ?? []));

  const planTimes = new Map<string, ServingInterval>();
  const addTime = (row: Row) => {
    const starts_at = str(row.attributes?.starts_at), ends_at = str(row.attributes?.ends_at);
    if (row.type === "PlanTime" && starts_at && ends_at) planTimes.set(row.id, { starts_at, ends_at });
  };
  rowsOf("plan_times", "plan_times").forEach(addTime);
  const intervalFor = (ids: string[]): ServingInterval | null => {
    const times = [...new Set(ids)].map(id => planTimes.get(id));
    return times.length === 1 && times[0] ? times[0] : null;
  };

  const needs = rowsOf("needed_positions", "needed_positions");
  const members = rowsOf("team_members", "team_members");
  const key = (team: string | null, name: unknown) => `${team ?? "?"}|${String(name ?? "?")}`;
  const order: string[] = [];
  const slots = new Map<string, { team: string; name: string; needs: Row[]; members: Row[] }>();
  const slot = (team: string | null, name: unknown) => {
    const k = key(team, name);
    if (!slots.has(k)) { order.push(k); slots.set(k, { team: team ?? "?", name: String(name ?? "Unnamed position"), needs: [], members: [] }); }
    return slots.get(k)!;
  };
  needs.forEach(n => slot(relId(n, "team"), n.attributes?.team_position_name).needs.push(n));
  const leadNames = new Map(rules.sundayLeads.map(l => [l.team_id, l.lead_position]));
  members.forEach(m => {
    const team = relId(m, "team");
    if (leadNames.get(team ?? "") === m.attributes?.team_position_name) return; // lead rows attach to their team below
    slot(team, m.attributes?.team_position_name).members.push(m);
  });

  const assignmentOf = (m: Row): ServingAssignment => {
    const ids = relIds(m, "times");
    const intervals = ids.map(id => planTimes.get(id)).filter((t): t is ServingInterval => !!t);
    return {
      assignment_id: m.id, status: status(m.attributes?.status),
      notification: str(m.attributes?.notification_sent_at) ? "sent" : "unsent",
      intervals, time_semantics: ids.length > 0 && intervals.length === ids.length ? "verified" : "unverified",
    };
  };

  // Per-person facts from their own scope.
  const personFacts = (person: string) => {
    const scope = `person:${person}`;
    const times = new Map<string, ServingInterval>();
    for (const row of includedOf(scope, "person_schedules")) {
      const s = str(row.attributes?.starts_at), e = str(row.attributes?.ends_at);
      if (row.type === "PlanTime" && s && e) times.set(row.id, { starts_at: s, ends_at: e });
    }
    const assignments: ServingAssignment[] = rowsOf(scope, "person_schedules").map(row => {
      const ids = relIds(row, "times");
      const intervals = ids.map(id => times.get(id)).filter((t): t is ServingInterval => !!t);
      return {
        assignment_id: `schedule:${row.id}`, status: status(row.attributes?.status), notification: "unknown",
        intervals, time_semantics: ids.length > 0 && intervals.length === ids.length ? "verified" : "unverified",
      };
    });
    const blockoutRows = rowsOf(scope, "person_blockouts");
    const repeating = blockoutRows.some(b => (b.attributes?.repeat_frequency ?? "no_repeat") !== "no_repeat");
    const blockouts: ServingInterval[] | null = repeating ? null : blockoutRows.map(b => ({
      starts_at: str(b.attributes?.starts_at) ?? "", ends_at: str(b.attributes?.ends_at) ?? "",
    }));
    return { scope, assignments, blockouts, plans: rowsOf(scope, "person_schedules").map(r => [r.id, relId(r, "plan"), r.attributes?.team_position_name] as const) };
  };

  const positions: CoveragePosition[] = [];
  const labels: PositionLabel[] = [];
  for (const [index, k] of order.entries()) {
    const s = slots.get(k)!;
    const position_id = `position:${index + 1}`;
    const timeIds = [...s.needs.flatMap(n => relId(n, "time") ?? []), ...s.members.flatMap(m => relIds(m, "times"))];
    const interval = intervalFor(timeIds);
    const quantity = s.needs.length === 0 ? 0 : s.needs.length === 1 ? (s.needs[0]!.attributes?.quantity as number) : null;
    const leadPosition = leadNames.get(s.team);
    const leadRows = leadPosition ? members.filter(m => relId(m, "team") === s.team && m.attributes?.team_position_name === leadPosition) : [];
    const assignments = [...s.members, ...leadRows].map(assignmentOf);
    // Who each scheduled row is, with their own blockouts, when the check read them (it reads everyone on the plan first).
    const scheduled: ScheduledPerson[] = [...s.members, ...leadRows].flatMap(m => {
      const person = relId(m, "person");
      if (!person || !(grouped.get(`person:${person}`) ?? []).some(r => r.collection === "person_blockouts")) return [];
      const facts = personFacts(person);
      return [{ assignment_id: m.id, person_id: person, blockouts: { scope_id: facts.scope, value: facts.blockouts } }];
    });
    const already = new Set(s.members.flatMap(m => relId(m, "person") ?? []));
    const teamScope = `team:${s.team}`;
    const positionNames = new Map(includedOf(teamScope, "team_position_assignments")
      .filter(r => r.type === "TeamPosition").map(r => [r.id, str(r.attributes?.name)]));
    const candidatePeople = [...new Set(rowsOf(teamScope, "team_position_assignments")
      .filter(a => positionNames.get(relId(a, "team_position") ?? "") === s.name)
      .flatMap(a => relId(a, "person") ?? []))].filter(p => !already.has(p));
    const candidates: CoverageCandidate[] = candidatePeople.map(person => {
      const facts = personFacts(person);
      const personComplete = complete.has(facts.scope);
      const own = <T>(value: T): Observation<T> => ({ scope_id: facts.scope, value });
      const team = <T>(value: T): Observation<T> => ({ scope_id: teamScope, value });
      return {
        person_id: person,
        membership: team(true), eligibility: team(true),
        availability: own(personComplete ? "available" as const : "unknown" as const),
        blockouts: own(facts.blockouts), assignments: own(facts.assignments),
      };
    });
    positions.push({
      position_id, team_id: s.team, interval,
      remaining_need: { scope_id: "needed_positions", value: quantity },
      lead: { scope_id: "team_members", value: leadPosition
        ? { mapping: "required", assignment_ids: leadRows.map(r => r.id) }
        : { mapping: "not-required", assignment_ids: [] } },
      assignments: { scope_id: "team_members", value: assignments },
      candidates, scheduled,
    });
    labels.push({ position_id, team_id: s.team, name: s.name, interval });
  }
  const plan = asRows(capture.reads.find(r => r.collection === "plan" && r.outcome === "ok")?.body?.data)[0];
  return {
    input: { evaluated_at, required_scope_ids, scopes, positions },
    positions: labels,
    plan: { title: str(plan?.attributes?.title), dates: str(plan?.attributes?.dates), sort_date: str(plan?.attributes?.sort_date) },
  };
}

export interface ServingStreak { person_id: string; team_position_name: string | null; sundays: number }

/**
 * Church rule: confirmed on N weekly Sundays in a row ending with this plan.
 * A fact for a person to look at — never a score, ranking or label about anyone.
 */
export function servingStreaks(capture: SundayCapture, threshold: number): ServingStreak[] {
  if (threshold <= 0) return [];
  const members = capture.reads.filter(r => r.collection === "team_members" && r.outcome === "ok")
    .flatMap(r => asRows(r.body?.data)).filter(m => status(m.attributes?.status) === "C");
  const result: ServingStreak[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const person = relId(m, "person");
    if (!person || seen.has(person)) continue;
    seen.add(person);
    const reads = capture.reads.filter(r => r.collection === "person_schedules" && r.person_id === person);
    if (!reads.length || reads.some(r => r.outcome !== "ok")) continue;
    const dates = new Set(reads.flatMap(r => asRows(r.body?.data))
      .filter(s => status(s.attributes?.status) === "C")
      .flatMap(s => { const d = str(s.attributes?.sort_date); return d ? [d.slice(0, 10)] : []; }));
    const plan = asRows(capture.reads.find(r => r.collection === "plan" && r.outcome === "ok")?.body?.data)[0];
    const anchor = str(plan?.attributes?.sort_date)?.slice(0, 10);
    if (!anchor || !dates.has(anchor)) continue;
    let count = 0;
    for (let d = Date.parse(anchor + "T00:00:00Z"); dates.has(new Date(d).toISOString().slice(0, 10)); d -= 7 * 86400000) count++;
    if (count >= threshold) result.push({ person_id: person, team_position_name: str(m.attributes?.team_position_name), sundays: count });
  }
  return result;
}
