// Builds the Sunday readiness brief shown to a ministry leader. Pure and name-free:
// findings carry person ids; the desktop view resolves names locally at render time.
import { evaluateCoverage, type CandidateAssessment, type CoverageResult, type PositionAssessment, type ServingInterval } from "./coverage.js";
import { churchTimeZone, planDate, planStart } from "./church-time.js";
import { plainIssues, roleFacts } from "./coverage-words.js";
import { applyFeedback, briefTarget, feedbackOf, type CorrectionEntry, type StopEntry } from "./finding-feedback.js";
import { kidsFindings } from "./kids-rules.js";
import { captureToCoverage, isChurchRead, isKidsRead, isOperationsRead, LIVE_CHECK_VALID_MS, ORGANIZATION_COLLECTION, servingStreaks, type SundayCapture, type SundayRead, type SundayRules } from "./sunday-capture.js";
import type { DecidedBrief } from "./sunday-decisions.js";
import type { SundayOperations } from "./operations-capture.js";
import type { OperationsResult } from "./operations-findings/index.js";
import { dayWords, planTimes, sortedTimes, timeLabel, type DayWords } from "./service-day.js";

export interface BriefPerson { person_id: string; reasons: string[] }
export interface Finding {
  /** Unique within one brief; follows Planning Center's row order. */
  id: string;
  /** Stable across checks (team and position, assignment or person; never a row index). Decisions are kept by this. */
  key: string;
  kind: "needs-people" | "lead-missing" | "lead-unverified" | "pending" | "streak" | "worth-a-look" | "too-few-confirmed" | "background-check" | "blockout";
  /** "decision" = Needs a decision; "look" = Worth a look. Never a score. */
  tone: "decision" | "look";
  position?: { id: string; team_id: string; name: string; interval: ServingInterval | null };
  person_id?: string;
  remaining?: number;
  notification?: "sent" | "unsent";
  sundays?: number;
  people?: { suggestions: BriefPerson[]; conflicts: BriefPerson[]; unverified: BriefPerson[]; left_out: BriefPerson[] };
  /** People confirmed on this position in Planning Center (needs-people). */
  confirmed?: string[];
  /** People scheduled to lead who haven't accepted yet (lead-missing). */
  pending_leads?: string[];
  /** Team leaders Planning Center lists for this team: oversight, not a Sunday assignment. Absent when that read didn't complete. */
  leaders?: string[];
  /** Each part of Planning Center that wasn't fully read, in plain words (worth-a-look). */
  unread?: string[];
  /**
   * worth-a-look, when its only reasons are facts about roles as the system lists them (a role not tied to a service time,
   * no number needed, an answer that can't be read) and no read failed, nothing is unread and the check is current: how
   * many roles, and each plain reason (coverage-words.ts `roleFacts`). The page says "One role couldn't be checked."
   * with the reason under it, never that a read failed.
   */
  role_facts?: { roles: number; reasons: string[] };
  /** The check is too old to treat as current (worth-a-look). */
  stale?: boolean;
  /** too-few-confirmed: the confirmed people the Church rules ask for at this service time (kids-rules.ts). */
  needed?: number;
  /** too-few-confirmed: people pending at this time whose request was sent (asked, no answer yet) or not sent yet. */
  asked?: string[];
  not_sent?: string[];
  /** background-check: what Planning Center People shows. Never a check's status, dates or other details. */
  check?: "none-current" | "expires-before-sunday" | "expires-on-sunday";
  /** Where and when this finding's facts were read, when that isn't the Services check (background-check). */
  source?: string;
  checked_at?: string;
  /**
   * blockout: each role this person is scheduled for (confirmed or pending) whose serving time their own blockout in
   * Planning Center overlaps, in Planning Center's order, with that serving time. The first is `position`.
   */
  serving?: { name: string; team_id: string; status: "confirmed" | "pending"; interval: ServingInterval }[];
  /** "Why I flagged this": the rule, the source facts and when they were read. Name-free. */
  why: string[];
}
/**
 * Who is on one role, by person id (names resolve on this Mac), as the system lists them: said yes, hasn't answered,
 * said no, or an answer Ozzie can't read. `needed`: the number the system asks for, or null when it doesn't share one.
 */
export interface RosterRole {
  position_id: string; team_id: string | null; name: string; needed: number | null;
  yes: string[]; waiting: string[]; declined: string[]; unknown: string[];
}
/**
 * Everyone the check names on the service, role by role, for a church system that doesn't share how many people a role
 * needs (Breeze): there, who is scheduled is the answer Ozzie can give (round 4). `no_role`: people on the service
 * with no role. Absent on Planning Center's briefs.
 */
export interface Roster { roles: RosterRole[]; no_role: string[] }
/**
 * A roster's places on roles (one per person per role) by answer, and how many people hold them. Counting places, not
 * people, keeps someone who said yes on one role and hasn't answered on another from hiding the second (review of
 * round 5, M5).
 */
export function rosterCounts(roster: Roster): { people: number; places: number; yes: number; waiting: number; no: number; unknown: number } {
  const people = new Set<string>();
  const c = { yes: 0, waiting: 0, no: 0, unknown: 0 };
  for (const r of roster.roles) {
    const seen = new Set<string>();
    const add = (ids: string[], k: keyof typeof c) => { for (const id of ids) if (!seen.has(id)) { seen.add(id); people.add(id); c[k]++; } };
    add(r.yes, "yes"); add(r.waiting, "waiting"); add(r.unknown, "unknown"); add(r.declined, "no");
  }
  return { people: people.size, places: c.yes + c.waiting + c.no + c.unknown, ...c };
}
/**
 * "4 people are listed: 2 said yes, 1 hasn't answered, 1 said no." From a roster, no names. The parts add up to the
 * whole (round 5); where someone is on more than one role, the parts count places: "4 people are listed in 5 places on roles: …".
 */
export function rosterSummary(roster: Roster): string {
  const c = rosterCounts(roster);
  if (c.places === 0) return "Nobody is listed on a role yet.";
  const parts = [c.yes ? `${c.yes} said yes` : "", c.waiting ? `${c.waiting} ${c.waiting === 1 ? "hasn't" : "haven't"} answered` : "",
    c.unknown ? `${c.unknown} with an answer Ozzie couldn't read` : "", c.no ? `${c.no} said no` : ""].filter(Boolean);
  const who = c.people === 1 ? "1 person is" : `${c.people} people are`;
  return c.places === c.people ? `${who} listed: ${parts.join(", ")}.` : `${who} listed in ${c.places} places on roles: ${parts.join(", ")}.`;
}
/**
 * The roster of a church system that shares no number needed for any role (Breeze), where who is on each role is what
 * Ozzie can say: null otherwise. Every surface that would say "nothing needs a decision" says what is known instead.
 */
export const unnumberedRoster = (brief: Pick<SundayBrief, "roster"> | null | undefined): Roster | null =>
  brief?.roster && brief.roster.roles.length > 0 && brief.roster.roles.every(r => r.needed === null) ? brief.roster : null;
/**
 * The roles a pastor should look at on such a service (round 5): someone hasn't answered, or nobody has said yes (a
 * decline with no one in its place, or nobody listed). Facts only, never a judgment about anyone.
 */
export const rosterNeedsYou = (roster: Roster): RosterRole[] =>
  roster.roles.filter(r => r.waiting.length > 0 || (r.yes.length === 0 && r.unknown.length === 0));
/** One scheduled position as read, so a filled gap can be told apart from a person's decision. */
export interface PositionStatus { team_id: string; name: string; remaining: number | null; pending: number; lead: PositionAssessment["lead"] }
export interface SundayBrief {
  mode: SundayCapture["kind"] | "fictional";
  /**
   * The church system the check read, when it isn't Planning Center (core/src/church-systems/brief.ts: "B1 Church",
   * "Breeze"). Absent: Planning Center Services. Every sentence that names where the facts are reads it.
   */
  source?: string;
  /**
   * `sort_date` is Planning Center's local wall-clock time with a misleading `Z`, never an instant.
   * `date` is its church-local date; `starts_at` the instant it names in the church's zone (null without the zone).
   */
  plan: { id: string; title: string | null; dates: string | null; sort_date: string | null; date: string | null; starts_at: string | null };
  /** The church's IANA time zone from Planning Center Services; null when it wasn't read. Never this Mac's zone. */
  time_zone: string | null;
  /**
   * The plan's service times (their starts, as instants, earliest first; rehearsals left out), as read: Planning Center's
   * `plan_times`, a church system's one service time. Empty when none was read or the service has no time of day.
   * Absent only on a brief built by hand (a test).
   */
  times?: string[];
  /**
   * The words for this plan's real day (service-day.ts): "Wednesday", "this weekend's services". Every fixed sentence
   * here and in what reads a brief names the service with these, never a fixed "Sunday" (onboarding spec §5).
   * Absent only on a brief built by hand (a test); readers then use the Sunday words.
   */
  day?: DayWords;
  checked_at: string | null;
  completed_at: string;
  status: CoverageResult["status"];
  /** A live check older than LIVE_CHECK_VALID_MS: still shown, never treated as current. */
  stale: boolean;
  sources: { reads: number; failed: { collection: string; outcome: string }[] };
  findings: Finding[];
  /** Findings the person's Church rules set aside ("Stop flagging this", "This isn't right"), and which entry did. Absent when none. */
  hidden?: { finding: Finding; entry: StopEntry | CorrectionEntry }[];
  positions: PositionStatus[];
  not_checked: string[];
  /** A church system's service, role by role (Roster); absent for Planning Center. */
  roster?: Roster;
  /**
   * A church system's rarer limits, beside `not_checked`: true, but not what a pastor acts on (round 5). The page folds
   * them under "More that Ozzie can't see"; the spoken briefing and Ask read `not_checked` only. Absent for Planning Center.
   */
  not_checked_more?: string[];
}

export const needKey = (team_id: string, name: string) => JSON.stringify(["need", team_id, name]);
export const leadKey = (team_id: string) => JSON.stringify(["lead", team_id]);

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const andList = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
/** A blockout finding's roles, each once in Planning Center's order: "Greeter", "Greeter and Usher". */
export const blockoutRoles = (f: Pick<Finding, "serving" | "position">): string =>
  andList([...new Set((f.serving ?? []).map(s => s.name))]) || f.position?.name || "a role";
/** How Planning Center still counts the person on those roles: "confirmed for Greeter and pending for Usher". */
export const blockoutCounted = (f: Pick<Finding, "serving" | "position">): string =>
  andList([...new Set((f.serving ?? []).map(s => `${s.status} for ${s.name}`))]) || `scheduled for ${blockoutRoles(f)}`;
/** The one serving time a blockout finding is about, or null when it names more than one. */
export const blockoutTime = (f: Pick<Finding, "serving" | "position">): ServingInterval | null => {
  const times = [...new Map((f.serving ?? []).map(s => [JSON.stringify(s.interval), s.interval])).values()];
  return times.length === 1 ? times[0]! : times.length ? null : f.position?.interval ?? null;
};
const bucket = (cs: CandidateAssessment[], d: CandidateAssessment["disposition"]) =>
  cs.filter(c => c.disposition === d).map(c => ({ person_id: c.person_id, reasons: c.reasons }));

interface Row { type?: unknown; id?: unknown; attributes?: Record<string, unknown>; relationships?: Record<string, { data?: unknown } | undefined> }
const rows = (data: unknown): Row[] => (Array.isArray(data) ? data : data ? [data] : []) as Row[];
/** Related ids whether Planning Center sends one object or a list. */
const relIds = (row: Row, key: string): string[] => {
  const d = row.relationships?.[key]?.data;
  return (Array.isArray(d) ? d : d ? [d] : []).flatMap(x => typeof (x as { id?: unknown })?.id === "string" ? [(x as { id: string }).id] : []);
};
const statusOf = (v: unknown) => v === "C" || v === "Confirmed" ? "C" : v === "U" || v === "Unconfirmed" ? "U" : v === "D" || v === "Declined" ? "D" : "?";

/** Team leaders per team from `team_leaders` reads. `null` when a page for that team didn't complete. */
export function teamLeaders(capture: SundayCapture): Record<string, string[] | null> {
  const out = new Map<string, string[] | null>();
  for (const read of capture.reads) {
    if (read.collection !== "team_leaders" || !read.team_id) continue;
    if (read.outcome !== "ok" || !read.body) { out.set(read.team_id, null); continue; }
    const known = out.get(read.team_id);
    if (known === null) continue;
    const ids = rows(read.body.data).filter(r => r.type === "TeamLeader").flatMap(r => [...relIds(r, "people"), ...relIds(r, "person")]);
    out.set(read.team_id, [...new Set([...(known ?? []), ...ids])]);
  }
  return Object.fromEntries(out);
}

const PARTS = new Map<string, (n: number) => string>([
  ["plan", () => "The plan details"], ["plan_times", () => "Service times"], ["needed_positions", () => "Open positions"],
  ["team_members", () => "Who is scheduled"], ["team_position_assignments", n => `Team members for ${plural(n, "team")}`],
  ["team_leaders", n => `Team leaders for ${plural(n, "team")}`],
  ["person_schedules", n => `Other schedules for ${plural(n, "person", "people")}`],
  ["person_blockouts", n => `Blockouts for ${plural(n, "person", "people")}`],
]);
const outcomeText = (o: string) => o === "truncated" ? "only partly read" : o === "timeout" ? "took too long"
  : o === "denied" || o === "source_denied" ? "Planning Center didn't allow it" : "couldn't be read";
/** "Blockouts for 2 people: took too long." One line per part and outcome, in read order. */
function unreadParts(reads: SundayRead[]): string[] {
  const groups = new Map<string, { collection: string; outcome: string; subjects: Set<string> }>();
  for (const r of reads) {
    if (r.outcome === "ok") continue;
    const k = JSON.stringify([r.collection, outcomeText(r.outcome)]);
    const g = groups.get(k) ?? { collection: r.collection, outcome: r.outcome, subjects: new Set<string>() };
    g.subjects.add(r.person_id ?? r.team_id ?? r.collection);
    groups.set(k, g);
  }
  return [...groups.values()].map(g => `${(PARTS.get(g.collection) ?? (() => "Another part of the check"))(g.subjects.size)}: ${outcomeText(g.outcome)}.`);
}
/**
 * "Groups for 3 people: Planning Center didn't allow it." Whose groups couldn't be read, so their
 * group meetings weren't checked, whether that was some of the plan's people or all of them.
 * Turned off in Settings is the operations check's own line, not a gap here.
 */
function unreadGroups(reads: SundayRead[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const r of reads) {
    if (r.collection !== "groups_person_memberships" || r.outcome === "ok" || r.outcome === "not-requested") continue;
    const text = outcomeText(r.outcome);
    groups.set(text, (groups.get(text) ?? new Set()).add(r.groups_person_id ?? ""));
  }
  return [...groups].map(([text, people]) => `Groups for ${plural(people.size, "person", "people")}: ${text}.`);
}
const CORE = ["plan_times", "needed_positions", "team_members"];

export function buildSundayBrief(capture: SundayCapture, rules: SundayRules, now: string, fictional = false): SundayBrief {
  const mapped = captureToCoverage(capture, rules, now);
  const result = evaluateCoverage(mapped.input);
  // Calendar, People and Groups reads are reported by the operations check (operations-capture),
  // so a turned-off or refused room read never makes the Services picture look incomplete. So is the
  // church's time zone: only rooms and group meetings depend on it, never Services coverage.
  // People forms, Check-Ins and Registrations are reported by core/src/church-reads, never as Services reads.
  const services = capture.reads.filter(r => !isOperationsRead(r) && !isKidsRead(r) && !isChurchRead(r) && r.collection !== ORGANIZATION_COLLECTION);
  const time_zone = churchTimeZone(capture);
  const times = sortedTimes(planTimes(capture.reads));
  const day = dayWords({ sort_date: mapped.plan.sort_date, times }, time_zone);
  // "a scheduled Wednesday lead", "a scheduled lead": the rule names the service's real day, never a fixed Sunday (spec §5).
  const dayLead = day.kind === "weekday" ? `${day.day} lead` : "lead";
  const checkTimes = services.map(r => r.checked_at).sort();
  const checked_at = checkTimes[0] ?? null;
  const stale = !fictional && capture.kind === "live" && checked_at !== null && Date.parse(now) > Date.parse(checked_at) + LIVE_CHECK_VALID_MS;
  const findings: Finding[] = [];
  const label = (id: string) => mapped.positions.find(p => p.position_id === id)!;
  const pendingByAssignment = new Map(mapped.input.positions.flatMap(p => p.assignments.value.map(a => [a.assignment_id, a] as const)));
  const members = capture.reads.filter(r => r.collection === "team_members" && r.body).flatMap(r => rows(r.body!.data));
  const personOf = new Map(members.map(m => [m.id, relIds(m, "person")[0]] as const));
  const inSlot = (team: string, name: string, status: string) => members.filter(m => relIds(m, "team")[0] === team &&
    m.attributes?.team_position_name === name && statusOf(m.attributes?.status) === status);
  const peopleIn = (team: string, name: string, status: string) => [...new Set(inSlot(team, name, status).flatMap(m => relIds(m, "person")))].sort();
  const leaders = teamLeaders(capture);
  const leadersOf = (team: string) => {
    const l = Object.hasOwn(leaders, team) ? leaders[team] : undefined;
    return l === null || l === undefined ? {} : { leaders: l };
  };
  const leadRule = (team: string) => rules.sundayLeads.find(l => l.team_id === team)?.lead_position;
  const failed = services.filter(r => r.outcome !== "ok").map(r => ({ collection: r.collection, outcome: r.outcome }));
  const coreFailed = failed.some(f => CORE.includes(f.collection));
  const leadTeams = new Set<string>();
  const toldPending = new Set<string>();

  for (const p of result.positions) {
    const pos = label(p.position_id);
    const position = { id: pos.position_id, team_id: pos.team_id, name: pos.name, interval: pos.interval };
    if ((p.remaining_need ?? 0) > 0) {
      findings.push({
        id: `need:${pos.position_id}`, key: needKey(pos.team_id, pos.name), kind: "needs-people", tone: "decision", position, remaining: p.remaining_need!,
        people: {
          suggestions: bucket(p.candidates, "suggestion"), conflicts: bucket(p.candidates, "possible-conflict"),
          unverified: bucket(p.candidates, "unverified"), left_out: bucket(p.candidates, "excluded"),
        },
        confirmed: peopleIn(pos.team_id, pos.name, "C"), ...leadersOf(pos.team_id),
        why: [
          `Planning Center reports ${plural(p.remaining_need!, "remaining request")} for ${pos.name}.`,
          "That number already accounts for people who accepted or are pending; Ozzie doesn't subtract them again.",
          "People are listed from this position's team in Planning Center, checked against their blockouts and other schedules. They are not ranked.",
        ],
      });
    }
    const leadPosition = leadRule(pos.team_id);
    if (leadPosition && !leadTeams.has(pos.team_id) && p.lead === "missing") {
      leadTeams.add(pos.team_id);
      const team = leadersOf(pos.team_id);
      findings.push({
        id: `lead:${pos.position_id}`, key: leadKey(pos.team_id), kind: "lead-missing", tone: "look", position,
        pending_leads: peopleIn(pos.team_id, leadPosition, "U"), ...team,
        why: [
          `Your Church rules ask for a scheduled ${dayLead} on this team (position "${leadPosition}").`,
          "No confirmed lead covers this service time in Planning Center.",
          ...(team.leaders?.length ? [`Planning Center lists ${plural(team.leaders.length, "team leader")} for this team. Leading the team isn't the same as being scheduled to lead ${day.thisOne}.`]
            : team.leaders ? ["Planning Center doesn't list a team leader for this team."] : ["The team's leaders couldn't be read."]),
        ],
      });
    }
    if (leadPosition && !leadTeams.has(pos.team_id) && p.lead === "unverified" && !stale && !coreFailed) {
      leadTeams.add(pos.team_id);
      findings.push({
        id: `lead-unverified:${pos.position_id}`, key: JSON.stringify(["lead-unverified", pos.team_id]), kind: "lead-unverified", tone: "look", position,
        ...leadersOf(pos.team_id),
        why: [
          `Your Church rules ask for a scheduled ${dayLead} on this team (position "${leadPosition}").`,
          "Planning Center has a lead scheduled, but their answer or serving time couldn't be confirmed, so Ozzie doesn't count it as covered.",
        ],
      });
    }
    for (const assignment of p.pending_assignment_ids) {
      // A scheduled lead's row is checked with each position of their team: one finding per assignment, named for the
      // row's own role, as the blockout finding below is (B-1).
      if (toldPending.has(assignment)) continue;
      toldPending.add(assignment);
      const a = pendingByAssignment.get(assignment);
      const person = personOf.get(assignment);
      const row = members.find(m => m.id === assignment);
      const own = typeof row?.attributes?.team_position_name === "string" ? row.attributes.team_position_name : pos.name;
      // A lead's own serving time, when it has one, rather than the first position's of their team.
      const interval = own !== pos.name && a?.intervals.length === 1 ? { ...a.intervals[0]! } : position.interval;
      findings.push({
        id: `pending:${assignment}`, key: JSON.stringify(["pending", assignment]), kind: "pending", tone: "look", position: { ...position, name: own, interval },
        ...(person ? { person_id: person } : {}), notification: a?.notification === "sent" ? "sent" : "unsent",
        why: [
          "Planning Center shows this assignment as pending (not yet accepted).",
          a?.notification === "sent" ? "Planning Center records that the request was sent." :
            "Planning Center shows no request was sent yet. Pending is not the same as asked.",
        ],
      });
    }
  }
  // Someone confirmed or pending whose own blockout overlaps their serving time: Worth a look, once per person, naming
  // every role it overlaps (someone on two roles at once is told once). Planning Center still counts them, so no role
  // reads as open and no count changes.
  const blocked = new Map<string, { position_id: string; serving: NonNullable<Finding["serving"]> }>();
  const told = new Set<string>();
  for (const p of result.positions) for (const b of p.scheduled_blockouts) {
    // A scheduled lead is checked with each position of their team: once is enough.
    if (told.has(b.assignment_id)) continue;
    told.add(b.assignment_id);
    const row = members.find(m => m.id === b.assignment_id);
    const name = typeof row?.attributes?.team_position_name === "string" ? row.attributes.team_position_name : label(p.position_id).name;
    const seen = blocked.get(b.person_id) ?? { position_id: p.position_id, serving: [] };
    seen.serving.push({ name, team_id: (row && relIds(row, "team")[0]) ?? p.team_id,
      status: pendingByAssignment.get(b.assignment_id)?.status === "U" ? "pending" : "confirmed", interval: b.interval });
    blocked.set(b.person_id, seen);
  }
  for (const [person, { position_id, serving }] of blocked) {
    const first = serving[0]!;
    const times = new Set(serving.map(s => JSON.stringify(s.interval))).size;
    findings.push({
      id: `blockout:${person}`, key: JSON.stringify(["blockout", person]), kind: "blockout", tone: "look",
      position: { id: position_id, team_id: first.team_id, name: first.name, interval: first.interval }, person_id: person, serving,
      why: [
        ...new Set(serving.map(s => `Planning Center Services has them ${s.status} for ${s.name}.`)),
        `Planning Center has a blockout for them that overlaps ${times > 1 ? "those times" : "that time"}. A blockout is when someone has told Planning Center they'll be away.`,
        "Planning Center still counts them as scheduled, so its count of who is still needed doesn't change, and Ozzie doesn't change it either.",
        "This is a schedule fact, not a judgment about anyone.",
      ],
    });
  }
  // Blockouts of people scheduled that couldn't be checked (a repeating one isn't placed on dates): never read as clear.
  const uncheckedBlockouts = new Set(result.issues.filter(i => i.code === "blockout-unverified").map(i => i.person_id)).size;
  for (const s of servingStreaks(capture, rules.checkInAfterSundaysInARow)) {
    findings.push({
      id: `streak:${s.person_id}`, key: JSON.stringify(["streak", s.person_id]), kind: "streak", tone: "look", person_id: s.person_id, sundays: s.sundays,
      why: [
        `Your Church rules say: check in with anyone scheduled ${rules.checkInAfterSundaysInARow} weeks in a row.`,
        `Planning Center shows them confirmed ${plural(s.sundays, "week")} in a row${s.team_position_name ? ` (${s.team_position_name})` : ""}, ending ${day.thisOne}.`,
        "This is a schedule fact, not a judgment about anyone.",
      ],
    });
  }
  // Church rules for kids teams: confirmed people per service time, and background checks (kids-rules.ts).
  const teamNames = new Map<string, string>();
  for (const p of mapped.positions) teamNames.set(p.team_id, teamNames.has(p.team_id) ? `${teamNames.get(p.team_id)!}, ${p.name}` : p.name);
  const kids = kidsFindings(capture, rules, { teamNames, sundayDate: planDate(mapped.plan.sort_date), zone: time_zone, words: day });
  findings.push(...kids.findings);
  const unread = unreadParts(services);
  const scopeIssues = result.issues.filter(i => i.person_id === null && i.code !== "observation-unverified" && i.code !== "lead-unverified");
  const roleOf = (id: string) => mapped.positions.find(p => p.position_id === id)?.name ?? null;
  // Only facts about roles as Planning Center lists them, with every read complete and current: said as roles, not a failed read.
  const roles = !failed.length && !stale && !unread.length ? roleFacts(scopeIssues, roleOf, "Planning Center") : null;
  if (scopeIssues.length || failed.length || stale) findings.push({
    id: "worth-a-look:scope", key: JSON.stringify(["worth-a-look"]), kind: "worth-a-look", tone: "look",
    ...(unread.length ? { unread } : {}), ...(stale ? { stale } : {}), ...(roles ? { role_facts: roles } : {}),
    why: [
      ...(stale ? ["This check was read more than 30 minutes ago, so Ozzie doesn't treat it as current."] : []),
      ...(failed.length ? [`${plural(failed.length, "Planning Center read")} didn't complete, so this check isn't a full picture.`] : []),
      ...plainIssues(scopeIssues, roleOf, "Planning Center"),
    ],
  });
  // What the person said on earlier cards, applied to this check. A check that couldn't be completed always shows.
  const kept = applyFeedback(findings, f => briefTarget(f, capture.plan_id, mapped.plan.dates), feedbackOf(rules));
  return {
    mode: fictional ? "fictional" : capture.kind,
    plan: { id: capture.plan_id, ...mapped.plan, date: planDate(mapped.plan.sort_date), starts_at: planStart(mapped.plan.sort_date, time_zone) },
    time_zone, times, day, checked_at, completed_at: capture.completed_at, status: result.status, stale,
    sources: { reads: services.length, failed },
    findings: kept.shown,
    ...(kept.hidden.length ? { hidden: kept.hidden.map(h => ({ finding: h.item, entry: h.entry })) } : {}),
    positions: result.positions.map(p => {
      const pos = label(p.position_id);
      return { team_id: pos.team_id, name: pos.name, remaining: p.remaining_need, pending: inSlot(pos.team_id, pos.name, "U").length, lead: p.lead };
    }),
    not_checked: [
      // A capture with Groups reads has its group meetings reported by the operations check.
      ...(capture.reads.some(r => r.collection.startsWith("groups_")) ? [] : ["Group events weren't part of this check."]),
      ...unreadGroups(capture.reads),
      "Whether someone is willing to serve isn't something Planning Center records.",
      ...kids.not_checked,
      ...(uncheckedBlockouts ? [`Blockouts for ${plural(uncheckedBlockouts, "scheduled person", "scheduled people")} couldn't be checked for this service time.`] : []),
      ...unread,
      ...(failed.length ? ["Some Planning Center reads didn't complete; see What happened."] : []),
      ...(stale ? ["Anything changed in Planning Center since this check isn't shown. Check again before relying on it."] : []),
    ],
  };
}

/**
 * The one service time a finding is about, as an instant: its role's serving time, a blockout's one serving time, a kids
 * team's time. Null when it names no single time (a role Planning Center lists at more than one time, a person's run of
 * weeks, a check that couldn't be completed).
 */
export function findingTime(f: Pick<Finding, "kind" | "serving" | "position">): string | null {
  if (f.kind === "worth-a-look" || f.kind === "streak") return null;
  return (f.kind === "blockout" ? blockoutTime(f) : f.position?.interval ?? null)?.starts_at ?? null;
}
/** One service time's part of the page: its start (null for what names no single time), its heading and its items. */
export interface TimeGroup<T> { at: string | null; label: string; items: T[] }
/** The heading for what names no single service time. */
export const NO_ONE_TIME = "Not tied to one service time";
/**
 * A plan with two or more service times (9:00 and 11:00 in one plan), its items by the time each is about, so a pastor
 * sees what each service needs: one group per service time in order (empty ones included, so every service is named),
 * then what names no single time, or a time that isn't one of the plan's service times. Null when the plan has fewer
 * than two service times: the page then lists everything together, as before. Order within a group is kept.
 */
export function byServiceTime<T>(items: readonly T[], timeOf: (item: T) => string | null, times: readonly string[] | undefined, zone: string | null): TimeGroup<T>[] | null {
  const sorted = sortedTimes(times ?? []);
  if (sorted.length < 2) return null;
  const groups: TimeGroup<T>[] = sorted.map(at => ({ at, label: timeLabel(at, sorted, zone), items: [] }));
  const rest: TimeGroup<T> = { at: null, label: NO_ONE_TIME, items: [] };
  for (const item of items) {
    const at = timeOf(item);
    const ms = at === null ? NaN : Date.parse(at);
    (groups.find(g => Date.parse(g.at!) === ms) ?? rest).items.push(item);
  }
  return rest.items.length ? [...groups, rest] : groups;
}

/**
 * The open questions about rooms and follow-ups the Sunday page shows. A part that couldn't be read is listed
 * under What I didn't check instead, so it isn't an open question here too.
 */
export function shownUncertainties(result: OperationsResult | null): OperationsResult["uncertainties"] {
  const unchecked = new Set(result?.unchecked_scope_ids ?? []);
  return (result?.uncertainties ?? []).filter(u => u.scope_id === null || !unchecked.has(u.scope_id));
}

/**
 * What the Sunday page shows, counted as items (never people), so its headline, the sidebar's Sunday count and
 * Today say the same numbers. Decisions: Services findings that need a decision and are still open after the
 * person's own decisions, confirmed room overlaps (Room use needs review) and follow-ups without an owner.
 * Worth a look: the other open Services findings, room overlaps no Church rule confirms, one item for room or
 * follow-up details that couldn't be confirmed, and each group meeting at the same time as serving. An
 * out-of-date rooms check shows none of its findings. What Church rules set aside is already out of both.
 */
export function sundayShownCount(view: Pick<DecidedBrief, "items" | "history">, operations: SundayOperations | null): { decisions: number; looks: number; resolved: number } {
  const open = view.items.filter(i => i.state !== "resolved");
  const ops = operations && !operations.stale ? operations : null;
  const found = ops?.result?.findings ?? [];
  const confirmed = found.filter(f => f.kind !== "room-overlap" || f.certainty === "confirmed").length;
  return {
    decisions: open.filter(i => i.finding.tone === "decision").length + confirmed,
    looks: open.filter(i => i.finding.tone === "look").length + (found.length - confirmed)
      + (shownUncertainties(ops?.result ?? null).length ? 1 : 0) + (ops?.group_meetings.length ?? 0),
    resolved: view.items.length - open.length + view.history.length,
  };
}
