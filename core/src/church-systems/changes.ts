// What a B1 Church or Breeze check is compared by, so the Sunday schedule (desktop proactive.ts) tells what changed
// between two checks of the same service exactly as it does for Planning Center (core/src/sunday-changes.ts). Pure and
// name-free: person ids, the system's own assignment ids and its role names; never a name.
// Two reads of the same facts give the same record and the same brief, whatever order the system listed them in and
// whenever each read ran: when a check started and finished and when each read ran are left out (the record keeps only
// when the check finished, which proactive.ts sets aside when it compares), and lists are put in one fixed order.
import { recordFromBrief, type ServingFact, type SundayCheckRecord } from "../sunday-changes.js";
import type { Finding, SundayBrief } from "../sunday-brief.js";
import { labelsOf, placeholderScope } from "./placeholders.js";
import { readsFor, type AssignmentStatus, type SystemCapture } from "./types.js";

const STATUS: Readonly<Record<AssignmentStatus, ServingFact["status"]>> = { accepted: "C", unconfirmed: "U", declined: "D", unknown: "other" };
const byText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/**
 * Who is scheduled for the service and how each answered, by the system's own assignment ids, which stay the same from
 * one read to the next (B1 Church's own ids; Breeze's volunteer and role ids joined). Null when the read of who is
 * scheduled, or of the roles, didn't end whole: then nothing reads as a decline or a removal.
 */
export function systemServing(capture: SystemCapture): ServingFact[] | null {
  const words = new Set([...readsFor(capture.system, "assignments"), ...readsFor(capture.system, "positions")]);
  const reads = capture.reads.filter(r => words.has(r.read));
  if (!reads.length || reads.some(r => r.outcome !== "ok")) return null;
  const labels = labelsOf(capture);
  const team = new Map(capture.positions.map(p => [p.id, p.team_id ?? "?"]));
  return capture.assignments.map(a => ({
    assignment_id: a.id, team_id: team.get(a.position_id) ?? "?",
    position: Object.hasOwn(labels, `position:${a.position_id}`) ? labels[`position:${a.position_id}`]! : "A role without a name",
    person_id: a.person_id, status: STATUS[a.status],
  })).sort((a, b) => byText(a.assignment_id, b.assignment_id));
}

/** People by id, each one's reasons in a fixed order too (they follow the order of the system's own lists). */
const people = <T extends { person_id: string; reasons: readonly string[] }>(list: readonly T[]) =>
  [...list].map(p => ({ ...p, reasons: [...p.reasons].sort(byText) })).sort((a, b) => byText(a.person_id, b.person_id));
/** One finding with its lists in a fixed order. */
function steadyFinding(f: Finding): Finding {
  return {
    ...f,
    ...(f.people ? { people: { suggestions: people(f.people.suggestions), conflicts: people(f.people.conflicts), unverified: people(f.people.unverified),
      left_out: people(f.people.left_out) } } : {}),
    ...(f.confirmed ? { confirmed: [...f.confirmed].sort(byText) } : {}),
    ...(f.serving ? { serving: [...f.serving].sort((a, b) => byText(JSON.stringify([a.team_id, a.name, a.status]), JSON.stringify([b.team_id, b.name, b.status]))) } : {}),
    ...(f.unread ? { unread: [...f.unread].sort(byText) } : {}),
  };
}
/**
 * The brief with its findings, roles and lists in one fixed order (by each finding's stable key, each role's team and
 * name, each person's id), so what a check shows doesn't depend on the order the system listed things in.
 */
export function steadyBrief(brief: SundayBrief): SundayBrief {
  return {
    ...brief,
    findings: brief.findings.map(steadyFinding).sort((a, b) => byText(a.key, b.key)),
    positions: [...brief.positions].sort((a, b) => byText(JSON.stringify([a.team_id, a.name]), JSON.stringify([b.team_id, b.name]))),
  };
}

/**
 * One check's record for comparison (sunday-changes.ts SundayCheckRecord), from the capture and the brief built from it
 * (brief.ts `buildSystemBrief`). The church is `<system>:<church id>`, the plan the system's own service id.
 */
export function recordSystemCheck(capture: SystemCapture, brief: SundayBrief): SundayCheckRecord {
  return recordFromBrief(steadyBrief(brief), { organization: placeholderScope(capture), plan_id: brief.plan.id, completed_at: capture.completed_at },
    systemServing(capture));
}
