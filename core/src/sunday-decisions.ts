// Sunday-only decisions a person makes about a finding ("Covered outside Planning Center",
// "Not needed this Sunday", "Yes, that's expected"). Pure, apart from the small storage helpers
// at the end. A decision is never source evidence: it is shown as "Resolved by you" and is
// compared against each later check so a material change brings the finding back.
// Kept on this Mac only; the reason a person types is never sent anywhere.
import type { ServingInterval } from "./coverage.js";
import type { Finding, SundayBrief } from "./sunday-brief.js";

export type DecisionChoice = "covered-outside" | "not-needed" | "lead-expected";
export type DecidableKind = "needs-people" | "lead-missing";
/** Which choices fit which finding. Incomplete checks, pending requests and check-ins can't be resolved this way. */
export const CHOICES: Record<DecidableKind, readonly DecisionChoice[]> = {
  "needs-people": ["covered-outside", "not-needed"],
  "lead-missing": ["lead-expected"],
};
export const REASON_MAX = 160;
const MAX_DECISIONS = 200, MAX_EARLIER = 20;

/** The source facts a decision was made against. Person ids only. */
export interface DecisionFacts { remaining?: number; confirmed?: string[]; suggestions?: string[]; pending_leads?: string[] }
export interface EarlierDecision { choice: DecisionChoice; reason: string; decided_at: string }
export interface SundayDecision {
  key: string; kind: DecidableKind;
  /** What the decision was about, so it can still be described if the finding goes away. */
  subject: { team_id: string; name: string; interval: ServingInterval | null };
  choice: DecisionChoice; reason: string; decided_at: string;
  facts: DecisionFacts;
  earlier: EarlierDecision[];
}
export type Change =
  | { code: "need-up"; from: number; to: number }
  | { code: "confirmed-lost"; person_ids: string[] }
  | { code: "suggestions-changed"; added: string[]; removed: string[] }
  | { code: "lead-lost"; person_ids: string[] };
export interface DecidedItem { finding: Finding; state: "open" | "reopened" | "resolved"; decision: SundayDecision | null; changes: Change[] }
/** A decision whose finding is gone from the latest check, and what the source now says. */
export interface DecisionHistory {
  decision: SundayDecision;
  status: "source-confirmed" | "filled-pending" | "not-listed" | "couldnt-recheck";
  checked_at: string | null;
}
export interface DecidedBrief { items: DecidedItem[]; history: DecisionHistory[] }

const isDecidable = (kind: string): kind is DecidableKind => Object.hasOwn(CHOICES, kind);
const sorted = (ids: readonly string[] | undefined) => [...new Set(ids ?? [])].sort();

export function factsOf(finding: Finding): DecisionFacts {
  if (finding.kind === "needs-people") return {
    remaining: finding.remaining ?? 0, confirmed: sorted(finding.confirmed),
    suggestions: sorted(finding.people?.suggestions.map(p => p.person_id)),
  };
  if (finding.kind === "lead-missing") return { pending_leads: sorted(finding.pending_leads) };
  return {};
}

/** Record a decision for this Sunday only. Throws a plain message when it can't be recorded. */
export function decide(finding: Finding, choice: DecisionChoice, reason: string, at: string, previous?: SundayDecision | null): SundayDecision {
  if (!isDecidable(finding.kind) || !finding.position || !CHOICES[finding.kind].includes(choice)) throw new Error("This can't be resolved that way.");
  const text = reason.trim().replace(/\s+/g, " ");
  if (!text) throw new Error("Add a short reason first.");
  if (text.length > REASON_MAX) throw new Error(`Keep the reason shorter (${REASON_MAX} characters at most).`);
  const earlier = previous && previous.key === finding.key
    ? [...previous.earlier, { choice: previous.choice, reason: previous.reason, decided_at: previous.decided_at }].slice(-MAX_EARLIER) : [];
  return {
    key: finding.key, kind: finding.kind,
    subject: { team_id: finding.position.team_id, name: finding.position.name, interval: finding.position.interval },
    choice, reason: text, decided_at: at, facts: factsOf(finding), earlier,
  };
}

/** Material differences only. Check times, row order, other positions and lower needs are not material. */
export function changesSince(before: DecisionFacts, now: DecisionFacts): Change[] {
  const lost = (a?: string[], b?: string[]) => (a ?? []).filter(x => !(b ?? []).includes(x));
  const changes: Change[] = [];
  if (before.remaining !== undefined && now.remaining !== undefined && now.remaining > before.remaining)
    changes.push({ code: "need-up", from: before.remaining, to: now.remaining });
  const confirmed = lost(before.confirmed, now.confirmed);
  if (confirmed.length) changes.push({ code: "confirmed-lost", person_ids: confirmed });
  if (before.suggestions && now.suggestions) {
    const added = lost(now.suggestions, before.suggestions), removed = lost(before.suggestions, now.suggestions);
    if (added.length || removed.length) changes.push({ code: "suggestions-changed", added, removed });
  }
  const leads = lost(before.pending_leads, now.pending_leads);
  if (leads.length) changes.push({ code: "lead-lost", person_ids: leads });
  return changes;
}

function historyOf(brief: SundayBrief, d: SundayDecision): DecisionHistory | null {
  const team = brief.positions.filter(p => p.team_id === d.subject.team_id);
  const sourceIncomplete = brief.stale || brief.sources.failed.some(f => f.collection === "needed_positions" || f.collection === "team_members");
  const entry = (status: DecisionHistory["status"]): DecisionHistory => ({ decision: d, status, checked_at: brief.checked_at });
  if (d.kind === "lead-missing") {
    if (team.some(p => p.lead === "confirmed")) return entry("source-confirmed");
    if (team.length && team.every(p => p.lead === "not-required")) return null; // the Church rule is off; nothing to show
    return entry(team.length || sourceIncomplete ? "couldnt-recheck" : "not-listed");
  }
  const position = team.find(p => p.name === d.subject.name);
  if (!position) return entry(sourceIncomplete ? "couldnt-recheck" : "not-listed");
  if (position.remaining === 0) return entry(position.pending === 0 ? "source-confirmed" : "filled-pending");
  return entry("couldnt-recheck");
}

/** Lay the person's decisions over the latest check. */
export function applyDecisions(brief: SundayBrief, decisions: readonly SundayDecision[]): DecidedBrief {
  const byKey = new Map(decisions.map(d => [d.key, d]));
  const seen = new Set<string>();
  const items = brief.findings.map((finding): DecidedItem => {
    const decision = byKey.get(finding.key);
    if (!decision || decision.kind !== finding.kind) return { finding, state: "open", decision: null, changes: [] };
    seen.add(decision.key);
    const changes = changesSince(decision.facts, factsOf(finding));
    return { finding, state: changes.length ? "reopened" : "resolved", decision, changes };
  });
  const history = decisions.filter(d => !seen.has(d.key)).flatMap(d => historyOf(brief, d) ?? []);
  return { items, history };
}

export function openCount(view: DecidedBrief) {
  const open = view.items.filter(i => i.state !== "resolved");
  return {
    decisions: open.filter(i => i.finding.tone === "decision").length,
    looks: open.filter(i => i.finding.tone === "look").length,
    resolved: view.items.length - open.length,
  };
}

export const withDecision = (list: readonly SundayDecision[], d: SundayDecision) => [...list.filter(x => x.key !== d.key), d];
export const withoutDecision = (list: readonly SundayDecision[], key: string) => list.filter(x => x.key !== key);

const listOf = (ids: string[], nameOf: (id: string) => string) => {
  const names = ids.map(nameOf);
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
};
/** Plain description of what changed. Names come from the caller, on this Mac. */
export function changeText(change: Change, nameOf: (id: string) => string): string {
  switch (change.code) {
    case "need-up":
      return `Planning Center now shows ${change.to} remaining ${change.to === 1 ? "request" : "requests"}; it was ${change.from} when you decided.`;
    case "confirmed-lost":
      return `${listOf(change.person_ids, nameOf)} ${change.person_ids.length === 1 ? "is" : "are"} no longer confirmed in Planning Center.`;
    case "lead-lost":
      return `${listOf(change.person_ids, nameOf)} no longer ${change.person_ids.length === 1 ? "has" : "have"} a pending request to lead.`;
    case "suggestions-changed": {
      const parts = [
        ...(change.added.length ? [`${listOf(change.added, nameOf)} could now help, with no overlap found`] : []),
        ...(change.removed.length ? [`${listOf(change.removed, nameOf)} ${change.removed.length === 1 ? "is" : "are"} no longer clear for this time`] : []),
      ];
      return `Who could help changed: ${parts.join("; ")}.`;
    }
  }
}

// Local storage, per organization and Sunday. Any failure just means no saved decisions.
export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** A live check and a saved recording of the same Sunday share decisions; the fictional example never mixes with church data. */
export function decisionsStorageKey(mode: SundayBrief["mode"], organization: string, plan_id: string): string {
  return `ozzie.sunday-decisions.v1:${JSON.stringify([mode === "fictional" ? "fictional" : "church", organization, plan_id])}`;
}

const isString = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const isIds = (v: unknown) => v === undefined || (Array.isArray(v) && v.length <= 500 && v.every(x => isString(x, 64, 1)));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function isInterval(v: unknown): boolean {
  return v === null || (isRecord(v) && isString(v.starts_at, 40) && isString(v.ends_at, 40));
}
function isEarlier(v: unknown, kind: DecidableKind): boolean {
  return isRecord(v) && CHOICES[kind].includes(v.choice as DecisionChoice) && isString(v.reason, REASON_MAX, 1) && isString(v.decided_at, 40, 1);
}
function isDecision(v: unknown): v is SundayDecision {
  if (!isRecord(v) || !isString(v.key, 600, 1) || typeof v.kind !== "string" || !isDecidable(v.kind)) return false;
  const kind = v.kind;
  const s = v.subject, f = v.facts;
  return CHOICES[kind].includes(v.choice as DecisionChoice) && isString(v.reason, REASON_MAX, 1) && isString(v.decided_at, 40, 1) &&
    isRecord(s) && isString(s.team_id, 64, 1) && isString(s.name, 300) && isInterval(s.interval) &&
    isRecord(f) && (f.remaining === undefined || (typeof f.remaining === "number" && Number.isSafeInteger(f.remaining) && f.remaining >= 0)) &&
    isIds(f.confirmed) && isIds(f.suggestions) && isIds(f.pending_leads) &&
    Array.isArray(v.earlier) && v.earlier.length <= MAX_EARLIER && v.earlier.every(e => isEarlier(e, kind));
}

export function loadDecisions(store: KeyValueStore | null | undefined, key: string): SundayDecision[] {
  try {
    const raw = store?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isDecision).slice(-MAX_DECISIONS) : [];
  } catch { return []; }
}

export function saveDecisions(store: KeyValueStore | null | undefined, key: string, decisions: readonly SundayDecision[]): boolean {
  try {
    if (!store) return false;
    store.setItem(key, JSON.stringify(decisions.slice(-MAX_DECISIONS)));
    return true;
  } catch { return false; }
}
