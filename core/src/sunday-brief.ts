// Builds the Sunday readiness brief shown to a ministry leader. Pure and name-free:
// findings carry person ids; the desktop view resolves names locally at render time.
import { evaluateCoverage, type CandidateAssessment, type CoverageResult, type PositionAssessment, type ServingInterval } from "./coverage.js";
import { churchTimeZone, planDate, planStart } from "./church-time.js";
import { captureToCoverage, isOperationsRead, LIVE_CHECK_VALID_MS, ORGANIZATION_COLLECTION, servingStreaks, type SundayCapture, type SundayRead, type SundayRules } from "./sunday-capture.js";

export interface BriefPerson { person_id: string; reasons: string[] }
export interface Finding {
  /** Unique within one brief; follows Planning Center's row order. */
  id: string;
  /** Stable across checks (team and position, assignment or person; never a row index). Decisions are kept by this. */
  key: string;
  kind: "needs-people" | "lead-missing" | "lead-unverified" | "pending" | "streak" | "worth-a-look";
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
  /** The check is too old to treat as current (worth-a-look). */
  stale?: boolean;
  /** "Why I flagged this": the rule, the source facts and when they were read. Name-free. */
  why: string[];
}
/** One scheduled position as read, so a filled gap can be told apart from a person's decision. */
export interface PositionStatus { team_id: string; name: string; remaining: number | null; pending: number; lead: PositionAssessment["lead"] }
export interface SundayBrief {
  mode: SundayCapture["kind"] | "fictional";
  /**
   * `sort_date` is Planning Center's local wall-clock time with a misleading `Z`, never an instant.
   * `date` is its church-local date; `starts_at` the instant it names in the church's zone (null without the zone).
   */
  plan: { id: string; title: string | null; dates: string | null; sort_date: string | null; date: string | null; starts_at: string | null };
  /** The church's IANA time zone from Planning Center Services; null when it wasn't read. Never this Mac's zone. */
  time_zone: string | null;
  checked_at: string | null;
  completed_at: string;
  status: CoverageResult["status"];
  /** A live check older than LIVE_CHECK_VALID_MS: still shown, never treated as current. */
  stale: boolean;
  sources: { reads: number; failed: { collection: string; outcome: string }[] };
  findings: Finding[];
  positions: PositionStatus[];
  not_checked: string[];
}

export const needKey = (team_id: string, name: string) => JSON.stringify(["need", team_id, name]);
export const leadKey = (team_id: string) => JSON.stringify(["lead", team_id]);

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
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
  const services = capture.reads.filter(r => !isOperationsRead(r) && r.collection !== ORGANIZATION_COLLECTION);
  const time_zone = churchTimeZone(capture);
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
          `Your Church rules ask for a scheduled Sunday lead on this team (position "${leadPosition}").`,
          "No confirmed lead covers this service time in Planning Center.",
          ...(team.leaders?.length ? [`Planning Center lists ${plural(team.leaders.length, "team leader")} for this team. Leading the team isn't the same as being scheduled to lead this Sunday.`]
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
          `Your Church rules ask for a scheduled Sunday lead on this team (position "${leadPosition}").`,
          "Planning Center has a lead scheduled, but their answer or serving time couldn't be confirmed, so Ozzie doesn't count it as covered.",
        ],
      });
    }
    for (const assignment of p.pending_assignment_ids) {
      const a = pendingByAssignment.get(assignment);
      const person = personOf.get(assignment);
      findings.push({
        id: `pending:${assignment}`, key: JSON.stringify(["pending", assignment]), kind: "pending", tone: "look", position,
        ...(person ? { person_id: person } : {}), notification: a?.notification === "sent" ? "sent" : "unsent",
        why: [
          "Planning Center shows this assignment as pending (not yet accepted).",
          a?.notification === "sent" ? "Planning Center records that the request was sent." :
            "Planning Center shows no request was sent yet. Pending is not the same as asked.",
        ],
      });
    }
  }
  for (const s of servingStreaks(capture, rules.checkInAfterSundaysInARow)) {
    findings.push({
      id: `streak:${s.person_id}`, key: JSON.stringify(["streak", s.person_id]), kind: "streak", tone: "look", person_id: s.person_id, sundays: s.sundays,
      why: [
        `Your Church rules say: check in with anyone scheduled ${rules.checkInAfterSundaysInARow} Sundays in a row.`,
        `Planning Center shows ${plural(s.sundays, "confirmed Sunday")} in a row${s.team_position_name ? ` (${s.team_position_name})` : ""}, ending this Sunday.`,
        "This is a schedule fact, not a judgment about anyone.",
      ],
    });
  }
  const unread = unreadParts(services);
  const scopeIssues = result.issues.filter(i => i.person_id === null && i.code !== "observation-unverified" && i.code !== "lead-unverified");
  if (scopeIssues.length || failed.length || stale) findings.push({
    id: "worth-a-look:scope", key: JSON.stringify(["worth-a-look"]), kind: "worth-a-look", tone: "look",
    ...(unread.length ? { unread } : {}), ...(stale ? { stale } : {}),
    why: [
      ...(stale ? ["This check was read more than 30 minutes ago, so Ozzie doesn't treat it as current."] : []),
      ...(failed.length ? [`${plural(failed.length, "Planning Center read")} didn't complete, so this check isn't a full picture.`] : []),
      ...[...new Set(scopeIssues.map(i => i.message))],
    ],
  });
  return {
    mode: fictional ? "fictional" : capture.kind,
    plan: { id: capture.plan_id, ...mapped.plan, date: planDate(mapped.plan.sort_date), starts_at: planStart(mapped.plan.sort_date, time_zone) },
    time_zone, checked_at, completed_at: capture.completed_at, status: result.status, stale,
    sources: { reads: services.length, failed },
    findings,
    positions: result.positions.map(p => {
      const pos = label(p.position_id);
      return { team_id: pos.team_id, name: pos.name, remaining: p.remaining_need, pending: inSlot(pos.team_id, pos.name, "U").length, lead: p.lead };
    }),
    not_checked: [
      // A capture with Groups reads has its group meetings reported by the operations check.
      ...(capture.reads.some(r => r.collection.startsWith("groups_")) ? [] : ["Groups events weren't part of this check."]),
      ...unreadGroups(capture.reads),
      "Whether someone is willing to serve isn't something Planning Center records.",
      ...unread,
      ...(failed.length ? ["Some Planning Center reads didn't complete; see What happened."] : []),
      ...(stale ? ["Anything changed in Planning Center since this check isn't shown. Check again before relying on it."] : []),
    ],
  };
}
