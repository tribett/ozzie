// The service check from a B1 Church or Breeze capture, as the same SundayBrief a Planning Center check gives
// (core/src/sunday-brief.ts), so the service's page, Today and the sidebar read it the same way. Pure and name-free:
// findings carry person ids and the system's own role names; people's names resolve on this Mac. A role name is
// treated as Planning Center's position names are: shown here, and as [Role] in a note's placeholder text.
// Every "Why I flagged this" line names the system the fact came from, never Planning Center.
import { evaluateCoverage, type CandidateAssessment, type ServingInterval } from "../coverage.js";
import { plainIssues } from "../coverage-words.js";
import { applyFeedback, briefTarget, feedbackOf, type FeedbackEntry } from "../finding-feedback.js";
import { needKey, type Finding, type PositionStatus, type Roster, type SundayBrief } from "../sunday-brief.js";
import { LIVE_CHECK_VALID_MS } from "../sunday-capture.js";
import { longDate } from "../service-day.js";
import { systemCaptureToCoverage, type CoverageRefusal, type SystemCoverage } from "./coverage.js";
import { cannotSee, notSharedNotice, numbersNotShared, onServiceWithoutRole, waitingForZone } from "./facts.js";
import { labelsOf } from "./placeholders.js";
import { instant, readsFor, SYSTEMS, untimed, type AssignmentStatus, type CapturePart, type ReadOutcome, type SystemCapture } from "./types.js";

/** What the check needs from Church rules and this Mac: the zone the leader confirmed, and their finding feedback. */
export interface SystemBriefRules {
  /** The IANA zone the leader confirmed in Ozzie (B1 Church); null or absent: none. */
  confirmedZone?: string | null;
  /** What the person said on finding cards (finding-feedback.ts), kept with this church's Church rules. */
  feedback?: readonly FeedbackEntry[];
}
export type SystemBrief =
  | {
    ok: true; brief: SundayBrief;
    /** The mapped check (coverage.ts): its zone and day facts, for the questions the page asks. */
    coverage: Extract<SystemCoverage, { ok: true }>;
    /** Plain facts about this service the page shows beside the findings: a plan not shared yet, people with no role. */
    notices: string[];
  }
  | { ok: false; reason: CoverageRefusal };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const bucket = (cs: CandidateAssessment[], d: CandidateAssessment["disposition"]) =>
  cs.filter(c => c.disposition === d).map(c => ({ person_id: c.person_id, reasons: c.reasons }));

/** Each part of the Sunday check by the part of the capture it fills, in plain words. */
const PART_WORDS: Readonly<Partial<Record<CapturePart, string>>> = {
  church: "Your church's account", service: "The service's times", busy: "Other plans the same people are on", positions: "Roles",
  assignments: "Who is scheduled", team_members: "Team members", blockouts: "Blockouts", people: "Names",
};
/** The parts of the capture the service check reads (coverage.ts COVERAGE_PARTS, and the church and names). */
const CHECK_PARTS: readonly CapturePart[] = ["church", "service", "busy", "positions", "assignments", "team_members", "blockouts", "people"];
/** How one part's read ended, and what to do about it where there is something (round 4: "name the part and what to do"). */
function outcomeText(name: string, outcome: ReadOutcome): string {
  switch (outcome) {
    case "truncated": return "only partly read";
    case "timeout": return `took too long. Check ${name} again in a moment`;
    case "refused": return `${name} didn't allow it. The key sees only what the person who made it can see`;
    case "key-refused": return `${name} didn't accept the key. Connect ${name} again in Settings with a new key`;
    case "rate-limited": return `${name} asked Ozzie to slow down. Check again in a few minutes`;
    case "not-requested": return "not read this time";
    default: return `couldn't be read. Check ${name} again in a moment`;
  }
}

/**
 * The service check from `capture`, read at `now`. A capture with no service check (Genesis), no service, or a service
 * with no roles at all comes back as its closed reason; the page says each one plainly (facts.ts `noRoles`).
 * `saved`: a check kept on this Mac, shown when the system can't be reached: its brief is a saved copy ("recording"),
 * never a current check, and goes out of date as any check does.
 */
export function buildSystemBrief(capture: SystemCapture, rules: SystemBriefRules, now: string, options: { fictional?: boolean; saved?: boolean } = {}): SystemBrief {
  const info = SYSTEMS[capture.system];
  const name = info.name;
  // The fictional example is evaluated as of its own check, as core/src/sunday-brief.ts does Planning Center's.
  const at = options.fictional ? capture.completed_at : now;
  const mapped = systemCaptureToCoverage(capture, { sundayLeads: [], confirmedZone: rules.confirmedZone ?? null }, at);
  if (!mapped.ok) return mapped;
  const result = evaluateCoverage(mapped.input);
  const labels = labelsOf(capture);
  const label = (key: string): string | null => Object.hasOwn(labels, key) ? labels[key]! : null;
  const roleName = (id: string) => label(`position:${id}`) ?? "A role without a name";
  const positionOf = new Map(capture.positions.map(p => [p.id, p]));
  // A service with no time of day (Breeze writes it as the church's midnight): its findings name its day, never 12:00 AM
  // (round 4). The check itself still runs over the day (coverage.ts).
  // Only Breeze writes a service with no time as midnight; another system's midnight is a real time (review of round 4, L1).
  const timed = !(capture.system === "breeze" && untimed(capture.service!.starts_at));
  const interval = (id: string): ServingInterval | null => timed ? mapped.input.positions.find(p => p.position_id === id)?.interval ?? null : null;
  const assignmentOf = new Map(capture.assignments.map(a => [a.id, a]));
  const people = (position: string, status: AssignmentStatus) =>
    [...new Set(capture.assignments.filter(a => a.position_id === position && a.status === status).map(a => a.person_id))].sort();

  // The reads the service check is made from, and those that didn't end whole.
  const used = new Set(CHECK_PARTS.flatMap(part => readsFor(capture.system, part)));
  const reads = capture.reads.filter(r => used.has(r.read));
  const failed = reads.filter(r => r.outcome !== "ok").map(r => ({ collection: r.read, outcome: r.outcome }));
  const checked_at = reads.map(r => r.checked_at).sort((a, b) => instant(a) - instant(b))[0] ?? null;
  // The fictional example (fictional.ts) is read as of its own check and never goes out of date.
  const stale = !options.fictional && checked_at !== null && Date.parse(at) > instant(checked_at) + LIVE_CHECK_VALID_MS;
  const partOf = (word: string) => CHECK_PARTS.find(part => readsFor(capture.system, part).includes(word));
  const unread = [...new Map(failed.map(f => {
    const words = PART_WORDS[partOf(f.collection) ?? "church"] ?? "Another part of the check";
    const line = `${words}: ${outcomeText(name, f.outcome as ReadOutcome)}.`;
    return [line, line] as const;
  })).values()];

  const day = mapped.day;
  const findings: Finding[] = [];
  // While the church's time zone waits to be confirmed (B1 Church), the check is held back whole: no role, answer or
  // blockout is said from it, only that it waits (facts.ts `waitingForZone`).
  const held = mapped.waiting_for_zone;
  for (const p of held ? [] : result.positions) {
    const own = positionOf.get(p.position_id);
    const role = roleName(p.position_id);
    const position = { id: p.position_id, team_id: p.team_id, name: role, interval: interval(p.position_id) };
    if ((p.remaining_need ?? 0) > 0 && own?.needed != null) {
      const filling = own.needed - p.remaining_need!;
      findings.push({
        id: `need:${p.position_id}`, key: needKey(p.team_id, role), kind: "needs-people", tone: "decision", position, remaining: p.remaining_need!,
        // Who could help, only where the system ties a team to each role (B1 Church). Breeze has none to list: no list,
        // never an empty one that would read as "no one on the team is clear".
        ...(info.teamMembers ? { people: {
          suggestions: bucket(p.candidates, "suggestion"), conflicts: bucket(p.candidates, "possible-conflict"),
          unverified: bucket(p.candidates, "unverified"), left_out: bucket(p.candidates, "excluded"),
        } } : {}),
        confirmed: people(p.position_id, "accepted"),
        why: [
          `${name} asks for ${plural(own.needed, "person", "people")} for ${role}, and ${filling === 0 ? "nobody has" : `${plural(filling, "person", "people")} ${filling === 1 ? "has" : "have"}`} said yes or ${filling <= 1 ? "is" : "are"} waiting to answer.`,
          "Ozzie counts each person once, and doesn't count anyone who said no.",
          info.teamMembers
            ? `People are listed from this role's team in ${name}, checked against their blockouts and other plans. They are not ranked.`
            : `${name} doesn't tie a team to each role, so Ozzie can't suggest who could help.`,
        ],
      });
    }
    for (const id of p.pending_assignment_ids) {
      const a = assignmentOf.get(id);
      if (!a || a.position_id !== p.position_id) continue;
      findings.push({
        id: `pending:${id}`, key: JSON.stringify(["pending", id]), kind: "pending", tone: "look", position, person_id: a.person_id,
        ...(a.asked === true ? { notification: "sent" as const } : a.asked === false ? { notification: "unsent" as const } : {}),
        why: [
          `${name} shows this person hasn't answered yet.`,
          a.asked === true ? `${name} records that the request was sent.`
            : a.asked === false ? `${name} shows the request hasn't been sent yet. Not answered isn't the same as asked.`
            : `${name} doesn't say whether the request was sent.`,
        ],
      });
    }
  }
  // Someone who said yes (or hasn't answered) whose own blockout overlaps the service: once per person, naming every role.
  const blocked = new Map<string, { serving: (NonNullable<Finding["serving"]>[number] & { position_id: string })[] }>();
  const told = new Set<string>();
  for (const p of held ? [] : result.positions) for (const b of p.scheduled_blockouts) {
    if (told.has(b.assignment_id)) continue;
    told.add(b.assignment_id);
    const a = assignmentOf.get(b.assignment_id);
    const role = roleName(a?.position_id ?? p.position_id);
    const seen = blocked.get(b.person_id) ?? { serving: [] };
    seen.serving.push({ position_id: a?.position_id ?? p.position_id, name: role, team_id: positionOf.get(a?.position_id ?? p.position_id)?.team_id ?? p.team_id,
      status: a?.status === "unconfirmed" ? "pending" : "confirmed", interval: b.interval });
    blocked.set(b.person_id, seen);
  }
  // Each person's roles in one fixed order (by role name, then answer), the first named as the finding's role: what is
  // shown doesn't depend on the order the system listed things in (changes.ts compares two checks by it).
  for (const [person, seen] of blocked) {
    const sorted = [...seen.serving].sort((x, y) => x.name.localeCompare(y.name, "en") || x.status.localeCompare(y.status) || x.position_id.localeCompare(y.position_id));
    const first = sorted[0]!;
    const serving = sorted.map(s => ({ name: s.name, team_id: s.team_id, status: s.status, interval: s.interval }));
    findings.push({
      id: `blockout:${person}`, key: JSON.stringify(["blockout", person]), kind: "blockout", tone: "look",
      position: { id: first.position_id, team_id: first.team_id, name: first.name, interval: first.interval }, person_id: person, serving,
      why: [
        ...new Set(serving.map(s => `${name} has them ${s.status === "pending" ? "waiting to answer" : "saying yes"} for ${s.name}.`)),
        `${name} has a blockout for them over the service. A blockout is when someone has told ${name} they'll be away.`,
        `${name} still counts them as scheduled, so the number still needed doesn't change, and Ozzie doesn't change it either.`,
        "This is a schedule fact, not a judgment about anyone.",
      ],
    });
  }
  // A role the system gave no number for can't be counted, and is never counted as zero. When no role on the service has
  // one, that is what the system shares (Breeze's older volunteers page has no number at all, breeze.rs), not a read
  // that failed: it never makes the check partial (round 4: every Breeze check said "Part of this Sunday couldn't be
  // checked"). It is said once, plainly (facts.ts `numbersNotShared`), and who is on each role is shown instead
  // (`roster`). When only some roles lack one, that is still Worth a look, by name (review of round 4, M2).
  const unnumbered = held ? [] : capture.positions.filter(p => p.needed === null);
  const noneNumbered = unnumbered.length > 0 && unnumbered.length === capture.positions.length;
  const byDesign = (i: (typeof result.issues)[number]) => noneNumbered &&
    i.code === "need-unverified" && i.position_id !== null && positionOf.get(i.position_id)?.needed === null;
  const scopeIssues = result.issues.filter(i => i.person_id === null && i.code !== "observation-unverified" && i.code !== "lead-unverified" && !byDesign(i));
  if (scopeIssues.length || failed.length || stale || mapped.waiting_for_zone) findings.push({
    id: "worth-a-look:scope", key: JSON.stringify(["worth-a-look"]), kind: "worth-a-look", tone: "look",
    ...(unread.length ? { unread } : {}), ...(stale ? { stale } : {}),
    why: [
      ...(mapped.waiting_for_zone ? [waitingForZone()] : []),
      ...(stale ? ["This check was read more than 30 minutes ago, so Ozzie doesn't treat it as current."] : []),
      ...(failed.length ? [`${plural(failed.length, `${name} read`)} didn't complete, so this check isn't a full picture.`] : []),
      ...(unnumbered.length && !noneNumbered ? [numbersNotShared(capture.system, unnumbered.map(p => roleName(p.id)))] : []),
      ...plainIssues(scopeIssues, id => roleName(id), name),
    ],
  });

  // Every finding says where its facts came from: the system, never Planning Center.
  for (const f of findings) f.source = name;
  // What needs a decision first, then what is worth a look, each in the system's own order (live, round 3: a role
  // waiting for an answer was shown above one that still needs people). The sort is stable.
  findings.sort((a, b) => (a.tone === "decision" ? 0 : 1) - (b.tone === "decision" ? 0 : 1));
  const occurrence = { id: mapped.service_id, dates: capture.service?.day ? longDate(capture.service.day) : day.date };
  const kept = applyFeedback(findings, f => briefTarget(f, occurrence.id, occurrence.dates), feedbackOf({ feedback: rules.feedback ? [...rules.feedback] : [] }));
  const unchecked = new Set(result.issues.filter(i => i.code === "blockout-unverified").map(i => i.person_id)).size;
  const positions: PositionStatus[] = result.positions.map(p => ({
    team_id: p.team_id, name: roleName(p.position_id), remaining: p.remaining_need, pending: people(p.position_id, "unconfirmed").length, lead: p.lead,
  }));
  const service = capture.service!;
  // Everyone on the service, role by role, in the system's own order: for a system that doesn't share how many people a
  // role needs, who is scheduled is the answer Ozzie can give (round 4).
  // Only from roles and answers read whole: from a read cut short, "Nobody is scheduled" could be untrue.
  const rosterWhole = !failed.some(f => { const part = partOf(f.collection); return part === "positions" || part === "assignments"; });
  const roster: Roster | undefined = held || !rosterWhole ? undefined : {
    roles: capture.positions.map(p => ({
      position_id: p.id, team_id: p.team_id, name: roleName(p.id), needed: p.needed,
      yes: people(p.id, "accepted"), waiting: people(p.id, "unconfirmed"), declined: people(p.id, "declined"), unknown: people(p.id, "unknown"),
    })),
    no_role: [...new Set(capture.on_service.filter(person => !capture.assignments.some(a => a.person_id === person)))].sort(),
  };
  const brief: SundayBrief = {
    mode: options.fictional ? "fictional" : options.saved ? "recording" : "live", source: name,
    plan: { id: mapped.service_id, title: label("service"), dates: occurrence.dates, sort_date: null,
      date: service.day ?? null, starts_at: timed ? service.starts_at : null },
    // Its one service time, named only on the church's own clock and never for a service with no time of day.
    time_zone: mapped.time_zone, times: timed && mapped.time_zone ? [service.starts_at] : [], day, checked_at, completed_at: capture.completed_at, status: result.status, stale,
    sources: { reads: reads.length, failed },
    findings: kept.shown,
    ...(kept.hidden.length ? { hidden: kept.hidden.map(h => ({ finding: h.item, entry: h.entry })) } : {}),
    positions, ...(roster ? { roster } : {}),
    not_checked_more: [...cannotSee(capture.system, "service-more"), `Whether someone is willing to serve isn't something ${name} records.`],
    not_checked: [
      ...(unnumbered.length ? [numbersNotShared(capture.system, noneNumbered ? null : unnumbered.map(p => roleName(p.id)))] : []),
      // What Ozzie can't see that bears on this service and a pastor acts on; the rarer lines are in `not_checked_more`,
      // and the rest under "Also read" and in Settings.
      ...cannotSee(capture.system, "service"),
      ...(unchecked ? [`Blockouts for ${plural(unchecked, "scheduled person", "scheduled people")} couldn't be checked for this service.`] : []),
      ...unread,
      ...(failed.length ? [`Some ${name} reads didn't complete.`] : []),
      ...(stale ? [`Anything changed in ${name} since this check isn't shown. Check again before relying on it.`] : []),
    ],
  };
  // Someone on the service with no role is said once: in the "Who is scheduled" card where it is shown (round 5), else here.
  const rosterShown = roster !== undefined && noneNumbered;
  const notices = [notSharedNotice(capture.system, service.shared), rosterShown ? null : onServiceWithoutRole(mapped.on_service_count)]
    .filter((n): n is string => n !== null);
  return { ok: true, brief, coverage: mapped, notices };
}
