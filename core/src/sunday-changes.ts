// What changed between two Sunday checks, in plain language. Pure and name-free: a check record
// and every change carry person ids only; the desktop view resolves names locally at render time.
// No I/O, no clock (the caller passes `now`), no model. Needs and leads are matched across checks
// by the brief's stable keys (needKey/leadKey), never by row order.
import type { CandidateAssessment, PositionAssessment } from "./coverage.js";
import { buildSundayBrief, leadKey, needKey, type Finding, type SundayBrief } from "./sunday-brief.js";
import type { SundayCapture, SundayRules } from "./sunday-capture.js";
import { kindWords } from "./finding-feedback.js";
import { SUNDAY_WORDS, type DayWords } from "./service-day.js";

export interface PositionFacts {
  team_id: string; name: string; starts_at: string | null;
  /** Remaining requests Planning Center reports; null when it couldn't be verified (never read as zero). */
  remaining: number | null;
  /** Person id → how the brief placed them while this position needs people. Not a ranking. */
  people: Record<string, CandidateAssessment["disposition"]>;
}
/** The team's scheduled Sunday lead, as the brief reports it (one per team). */
export interface LeadFacts { team_id: string; name: string; starts_at: string | null; state: Exclude<PositionAssessment["lead"], "not-required"> }
/** One scheduled row in the plan (no names). */
export interface ServingFact { assignment_id: string; team_id: string; position: string; person_id: string | null; status: "C" | "U" | "D" | "other" }
/** Name-free summary of one check: what the brief showed plus the facts it leaves out (who was scheduled and how they answered). */
export interface SundayCheckRecord {
  version: 2;
  organization: string; plan_id: string; plan_dates: string | null; plan_starts_at: string | null;
  completed_at: string;
  status: SundayBrief["status"];
  /** Every read completed and the brief has no "couldn't be checked" note. Only then can anything read as resolved. */
  fully_read: boolean;
  failed_reads: number;
  decisions: number;
  /** By needKey(team, position). */
  positions: Record<string, PositionFacts>;
  /** By leadKey(team), only for teams whose Church rules ask for a Sunday lead. */
  leads: Record<string, LeadFacts>;
  /** Null when the scheduled list wasn't completely read. */
  serving: ServingFact[] | null;
}

export type ChangeKind =
  | "confirmed-declined" | "confirmed-removed" | "pending-accepted" | "pending-declined" | "pending-removed"
  | "need-opened" | "need-increased" | "need-decreased" | "need-filled"
  | "lead-missing" | "lead-confirmed" | "suggestion-conflict" | "suggestion-left-out"
  | "coverage-unverified" | "coverage-verified"
  /** A finding of a kind the person asked to hear about right away, new since the last check (finding-feedback rightAwayChanges). */
  | "finding-new";
export interface SundayChange {
  /** Stable for the same fact, so the same change can be recognized again. */
  id: string;
  kind: ChangeKind;
  effect: "worse" | "better" | "neutral";
  /** "urgent": a required role lost confirmed coverage inside the church's window before the service. */
  urgency: "urgent" | "attention" | "none";
  position?: string;
  /** The team it is about, so a Church rule scoped to a team or role can recognize it. */
  team_id?: string;
  person_id?: string;
  from?: number; to?: number;
  failed_reads?: number;
  service_starts_at?: string;
  /** finding-new: the finding's kind, stable key and card tone. Ids only. */
  finding?: { kind: string; key: string; tone: "decision" | "look" };
}
export interface ChangeOptions { now: string; urgentWithinHours: number }
/** Default urgency window before the service; churches can adjust it. */
export const DEFAULT_URGENT_WITHIN_HOURS = 48;

interface Row { id: string; attributes?: Record<string, unknown>; relationships?: Record<string, { data: unknown }> }
const relId = (row: Row, key: string): string | null => {
  const d = row.relationships?.[key]?.data as { id?: unknown } | null | undefined;
  return d && typeof d.id === "string" ? d.id : null;
};
const statusOf = (v: unknown): ServingFact["status"] =>
  v === "C" || v === "Confirmed" ? "C" : v === "U" || v === "Unconfirmed" ? "U" : v === "D" || v === "Declined" ? "D" : "other";

function servingFacts(capture: SundayCapture): ServingFact[] | null {
  const reads = capture.reads.filter(r => r.collection === "team_members");
  if (!reads.length || reads.some(r => r.outcome !== "ok" || !r.body)) return null;
  return reads.flatMap(r => Array.isArray(r.body!.data) ? r.body!.data as Row[] : []).map(row => ({
    assignment_id: row.id, team_id: relId(row, "team") ?? "?", position: String(row.attributes?.team_position_name ?? "Unnamed position"),
    person_id: relId(row, "person"), status: statusOf(row.attributes?.status),
  }));
}
const dispositions = (f: Finding | undefined): PositionFacts["people"] => {
  if (!f?.people) return {};
  const as = (list: { person_id: string }[], d: CandidateAssessment["disposition"]) => list.map(p => [p.person_id, d] as [string, typeof d]);
  const placed = [...as(f.people.suggestions, "suggestion"), ...as(f.people.conflicts, "possible-conflict"),
    ...as(f.people.unverified, "unverified"), ...as(f.people.left_out, "excluded")];
  return Object.fromEntries(placed.sort(([a], [b]) => a.localeCompare(b)));
};

/** Summarize one check for comparison. `now` must be the time the brief is evaluated at. */
export function recordSundayCheck(capture: SundayCapture, rules: SundayRules, now: string): SundayCheckRecord {
  return recordFromBrief(buildSundayBrief(capture, rules, now), { organization: capture.organization, plan_id: capture.plan_id, completed_at: capture.completed_at },
    servingFacts(capture));
}
/**
 * One check's record from its brief, the check it is of (`organization`: Planning Center's, or `<system>:<church id>` for
 * another church system) and who was scheduled and how (`serving`: null when that wasn't completely read).
 */
export function recordFromBrief(brief: SundayBrief, of: { organization: string; plan_id: string; completed_at: string }, serving: ServingFact[] | null): SundayCheckRecord {
  const byKey = new Map(brief.findings.map(f => [f.key, f]));
  const positions: Record<string, PositionFacts> = {};
  for (const p of brief.positions) {
    const need = byKey.get(needKey(p.team_id, p.name));
    positions[needKey(p.team_id, p.name)] = {
      team_id: p.team_id, name: p.name, starts_at: need?.position?.interval?.starts_at ?? null, remaining: p.remaining, people: dispositions(need),
    };
  }
  const leads: Record<string, LeadFacts> = {};
  for (const team of new Set(brief.positions.map(p => p.team_id))) {
    const slots = brief.positions.filter(p => p.team_id === team && p.lead !== "not-required");
    if (!slots.length) continue;
    const finding = byKey.get(leadKey(team));
    const state: LeadFacts["state"] = finding?.kind === "lead-missing" ? "missing"
      : slots.some(p => p.lead === "unverified") ? "unverified" : slots.some(p => p.lead === "missing") ? "missing" : "confirmed";
    leads[leadKey(team)] = { team_id: team, name: finding?.position?.name ?? slots[0]!.name, starts_at: finding?.position?.interval?.starts_at ?? null, state };
  }
  return {
    version: 2, organization: of.organization, plan_id: of.plan_id,
    plan_dates: brief.plan.dates, plan_starts_at: brief.plan.starts_at,
    completed_at: of.completed_at, status: brief.status,
    fully_read: brief.sources.failed.length === 0 && !brief.findings.some(f => f.kind === "worth-a-look"),
    failed_reads: brief.sources.failed.length,
    decisions: brief.findings.filter(f => f.tone === "decision").length,
    positions, leads, serving,
  };
}

const rank = { urgent: 0, attention: 1, none: 2 } as const;

/**
 * Material changes from `previous` to `next`. Facts that couldn't be verified on either side are
 * skipped rather than read as a change; nothing reads as resolved unless it was positively read.
 * `latest` (default `previous`) is the check just before, used for the "could everything be read" transition.
 */
export function diffSundayChecks(previous: SundayCheckRecord, next: SundayCheckRecord, options: ChangeOptions, latest = previous): SundayChange[] {
  if (previous.organization !== next.organization || previous.plan_id !== next.plan_id) return [];
  const changes: SundayChange[] = [];
  const startOf = (key: string) => next.positions[key]?.starts_at ?? next.leads[key]?.starts_at ?? previous.positions[key]?.starts_at ?? next.plan_starts_at;
  const within = (start: string | null) => {
    const ms = start ? Date.parse(start) - Date.parse(options.now) : NaN;
    return Number.isFinite(ms) && ms >= 0 && ms <= options.urgentWithinHours * 3_600_000;
  };
  const worse = (change: Omit<SundayChange, "effect" | "urgency" | "service_starts_at">, key: string | null, urgent: boolean): SundayChange => {
    const start = key ? startOf(key) : next.plan_starts_at;
    return { ...change, effect: "worse", urgency: urgent && within(start) ? "urgent" : "attention", ...(start ? { service_starts_at: start } : {}) };
  };
  const better = (change: Omit<SundayChange, "effect" | "urgency">, effect: "better" | "neutral" = "better"): SundayChange => ({ ...change, effect, urgency: "none" });

  // Confirmed coverage lost, and how pending requests were answered. Losing a confirmed person is
  // urgent only when it leaves a required role open: remaining requests, or the team's Sunday lead.
  const leadLostTeams = new Set(Object.entries(next.leads)
    .filter(([key, l]) => l.state === "missing" && previous.leads[key]?.state === "confirmed").map(([, l]) => l.team_id));
  const lost: ServingFact[] = [];
  if (previous.serving && next.serving) {
    const current = new Map(next.serving.map(f => [f.assignment_id, f]));
    for (const before of previous.serving) {
      const after = current.get(before.assignment_id);
      const key = needKey(before.team_id, before.position);
      const who = { position: before.position, team_id: before.team_id, ...(before.person_id ? { person_id: before.person_id } : {}) };
      if (before.status === "C" && (!after || after.status === "D")) {
        lost.push(before);
        const kind = after ? "confirmed-declined" : "confirmed-removed";
        changes.push(worse({ id: `${kind}:${before.assignment_id}`, kind, ...who }, key, (next.positions[key]?.remaining ?? 0) > 0 || leadLostTeams.has(before.team_id)));
      } else if (before.status === "U" && !after) changes.push(better({ id: `pending-removed:${before.assignment_id}`, kind: "pending-removed", ...who }, "neutral"));
      else if (before.status === "U" && after?.status === "C") changes.push(better({ id: `pending-accepted:${before.assignment_id}`, kind: "pending-accepted", ...who }));
      else if (before.status === "U" && after?.status === "D") changes.push(worse({ id: `pending-declined:${before.assignment_id}`, kind: "pending-declined", ...who }, key, false));
    }
  }
  const lostKeys = new Set(lost.map(f => needKey(f.team_id, f.position)));

  for (const [key, after] of Object.entries(next.positions)) {
    const before = previous.positions[key];
    const position = after.name, team_id = after.team_id;
    // Open requests. A position new to the plan starts from zero.
    const from = before ? before.remaining : 0, to = after.remaining;
    if (from !== null && to !== null && from !== to) {
      if (to > from) changes.push(worse({ id: `${from === 0 ? "need-opened" : "need-increased"}:${key}:${to}`, kind: from === 0 ? "need-opened" : "need-increased", position, team_id, from, to }, key, lostKeys.has(key)));
      else if (to === 0) changes.push(better({ id: `need-filled:${key}`, kind: "need-filled", position, team_id, from, to }));
      else changes.push(better({ id: `need-decreased:${key}:${to}`, kind: "need-decreased", position, team_id, from, to }));
    }
    // Someone suggested before who no longer is, while the position still needs people.
    if (before && (to ?? 0) > 0) for (const [person, was] of Object.entries(before.people)) {
      const is = after.people[person];
      if (was !== "suggestion" || (is !== "possible-conflict" && is !== "excluded")) continue;
      const kind = is === "possible-conflict" ? "suggestion-conflict" : "suggestion-left-out";
      changes.push(worse({ id: `${kind}:${key}:${person}`, kind, position, team_id, person_id: person }, key, false));
    }
  }
  // The team's Sunday lead, only when both checks positively read it. A missing lead is Worth a look on its
  // card (the team's leader may be leading), so it is never urgent; a confirmed lead declining is, above.
  for (const [key, after] of Object.entries(next.leads)) {
    const before = previous.leads[key]?.state;
    if (before === "confirmed" && after.state === "missing") changes.push(worse({ id: `lead-missing:${key}`, kind: "lead-missing", position: after.name, team_id: after.team_id }, key, false));
    if (before === "missing" && after.state === "confirmed") changes.push(better({ id: `lead-confirmed:${key}`, kind: "lead-confirmed", position: after.name, team_id: after.team_id }));
  }

  if (latest.fully_read && !next.fully_read) changes.push(worse({ id: "coverage-unverified", kind: "coverage-unverified", failed_reads: next.failed_reads }, null, false));
  if (!latest.fully_read && next.fully_read) changes.push(better({ id: "coverage-verified", kind: "coverage-verified" }));
  return changes.map((c, i) => [c, i] as const).sort(([a, i], [b, j]) => rank[a.urgency] - rank[b.urgency] || i - j).map(([c]) => c);
}

/** What was last positively known about a Sunday, plus the check just before. Name-free; safe to store. */
export interface SundayCheckMemory { latest: SundayCheckRecord; known: SundayCheckRecord }

function remember(known: SundayCheckRecord, next: SundayCheckRecord): SundayCheckRecord {
  const positions: Record<string, PositionFacts> = {};
  if (!next.fully_read) for (const [key, p] of Object.entries(known.positions)) if (!next.positions[key]) positions[key] = p;
  for (const [key, p] of Object.entries(next.positions)) {
    const k = known.positions[key];
    const people = { ...k?.people };
    for (const [person, d] of Object.entries(p.people)) if (d !== "unverified" || !people[person]) people[person] = d;
    positions[key] = { ...p, remaining: p.remaining ?? k?.remaining ?? null, people };
  }
  const leads: Record<string, LeadFacts> = {};
  for (const [key, l] of Object.entries(next.leads)) leads[key] = l.state === "unverified" && known.leads[key] ? { ...l, state: known.leads[key]!.state } : l;
  if (!next.fully_read) for (const [key, l] of Object.entries(known.leads)) leads[key] ??= l;
  return { ...next, positions, leads, serving: next.serving ?? known.serving };
}

/**
 * Compare a new check with what was last known for the same Sunday. The first check is a baseline
 * (no changes). Facts are compared with the last value that was actually read, so a failed read
 * neither hides a real change nor re-reports one after it recovers.
 */
export function compareSundayCheck(memory: SundayCheckMemory | null, next: SundayCheckRecord, options: ChangeOptions): { changes: SundayChange[]; memory: SundayCheckMemory } {
  if (!memory || memory.latest.organization !== next.organization || memory.latest.plan_id !== next.plan_id) {
    return { changes: [], memory: { latest: next, known: next } };
  }
  return { changes: diffSundayChecks(memory.known, next, options, memory.latest), memory: { latest: next, known: remember(memory.known, next) } };
}

/**
 * Whether a worse change found earlier is still so in what is known about the same Sunday now. A notice held
 * for quiet hours is rechecked against the newest saved check before it goes out (owner decision: quiet hours
 * hold notices; what they held is rechecked first), so a change reversed meanwhile (a decline restored, the
 * extra request gone) brings none. Facts are compared with the last value actually read: a fact no later
 * check could read still holds, so nothing reads as resolved unless it was positively read.
 */
export function changeStillHolds(change: SundayChange, memory: SundayCheckMemory, found?: readonly string[] | null): boolean {
  if (change.effect !== "worse") return false;
  const { known } = memory;
  // Serving changes carry the assignment in their id: `${kind}:${assignment_id}`.
  const serving = () => known.serving?.find(f => f.assignment_id === change.id.slice(change.kind.length + 1))?.status;
  const position = change.team_id && change.position ? known.positions[needKey(change.team_id, change.position)] : undefined;
  switch (change.kind) {
    case "confirmed-declined": case "confirmed-removed": return !known.serving || serving() !== "C";
    case "pending-declined": { const status = serving(); return !known.serving || (status !== "C" && status !== "U"); }
    // A position no longer in the plan has no open request.
    case "need-opened": case "need-increased": return position !== undefined && (position.remaining === null || position.remaining > (change.from ?? 0));
    case "suggestion-conflict": case "suggestion-left-out": return position !== undefined && (position.remaining ?? 1) > 0 && change.person_id !== undefined
      && position.people[change.person_id] === (change.kind === "suggestion-conflict" ? "possible-conflict" : "excluded");
    case "lead-missing": { const lead = change.team_id ? known.leads[leadKey(change.team_id)] : undefined; return lead !== undefined && lead.state !== "confirmed"; }
    case "coverage-unverified": return !memory.latest.fully_read;
    // A new finding still holds while the newest check still shows it (`found`: its finding keys, when known).
    case "finding-new": return !found || (change.finding !== undefined && found.includes(change.finding.key));
    default: return true;
  }
}

// Wording follows the Sunday page ("Greeter still needs one more person.").
const people = (n: number) => n === 1 ? "one more person" : `${n} more people`;
/** The watched service's sidebar page at the start of a sentence: "The Wednesday page", "The “This weekend” page" (ask.ts `dayPage`). */
const PageOf = (d: DayWords) => d.kind === "weekday" ? `The ${d.page} page` : `The “${d.page}” page`;
/**
 * Plain-language sentence for one change. Names come only from the local resolver, at render time. `d`: the watched
 * service's day words, so a change names its real day and page (onboarding spec §5); the Sunday words otherwise.
 * `source`: the system the check read (Planning Center unless a church uses B1 Church or Breeze).
 */
export function describeChange(change: SundayChange, nameOf: (personId: string) => string | undefined, d: DayWords = SUNDAY_WORDS, source = "Planning Center"): string {
  const name = change.person_id ? nameOf(change.person_id) : undefined;
  const Who = name ?? "Someone", who = name ?? "someone";
  const pos = change.position ?? "A position";
  switch (change.kind) {
    case "confirmed-declined": return `${Who} declined ${pos} after confirming.`;
    case "confirmed-removed": return `${Who} is no longer scheduled for ${pos}. They had confirmed.`;
    case "pending-accepted": return `${Who} accepted ${pos}.`;
    case "pending-declined": return `${Who} declined the ${pos} request.`;
    case "pending-removed": return `The pending ${pos} request for ${who} was removed.`;
    case "need-opened": return `${pos} now needs ${people(change.to ?? 0)}.`;
    case "need-increased": return `${pos} now needs ${people(change.to ?? 0)}, up from ${change.from}.`;
    case "need-decreased": return `${pos} now needs ${people(change.to ?? 0)}, down from ${change.from}.`;
    case "need-filled": return source === "Planning Center" ? `${pos} no longer has an open request in Planning Center.` : `${pos} no longer needs anyone, by ${source}'s numbers.`;
    case "lead-missing": return `No one is confirmed to lead ${pos} ${d.thisOne} now.`;
    case "lead-confirmed": return `Someone is confirmed to lead ${pos} ${d.thisOne} now.`;
    case "suggestion-conflict": return `${Who} now has a possible conflict for ${pos}.`;
    case "suggestion-left-out": return `${Who} is now left out for ${pos}. ${PageOf(d)} shows why.`;
    case "coverage-unverified": return change.failed_reads
      ? `Some coverage couldn't be verified: ${change.failed_reads} ${source} ${change.failed_reads === 1 ? "read" : "reads"} didn't complete.`
      : "Some coverage couldn't be verified in the latest check.";
    case "coverage-verified": return `Every ${source} read completed again.`;
    case "finding-new": return `New since the last check: ${kindWords(change.finding?.kind ?? "")}. Your Church rules say to tell you right away.`;
  }
}
