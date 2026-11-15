// What a leader tells Ozzie from a finding card, kept as visible, deletable Church rules entries: a
// correction ("This isn't right"), "Stop flagging this", "Always do this", and the notice choices
// "Always tell me right away" and "Put this in the briefing". Each entry names the scope it applies to
// ("Stop flagging this" offers the narrowest first), and nothing is learned without an entry the leader
// can see. Pure: no clock, no storage, no model.
//
// Generic over finding kinds: a finding is described as a FeedbackTarget (its kind, stable key, the
// Sunday it belongs to, and what it is about by id), so a new kind of finding gets every control
// without changes here. Entries are name-free: people are kept by Planning Center id and their names
// are resolved on this Mac at render time. A correction's note is typed by a person; it stays on this
// Mac and is never part of anything sent to an AI model (rules.current reads fixed fields only).
import type { SundayChange } from "./sunday-changes.js";
import type { Finding } from "./sunday-brief.js";
import type { GroupMeeting } from "./operations-capture.js";
import type { FollowUpFinding, RoomFinding } from "./operations-findings/types.js";
import { canEscalate } from "./escalation-draft.js";
import { canRemind } from "./reminder-draft.js";

export const FEEDBACK_MAX = 200;
export const NOTE_MAX = 200;

/** What a finding is about, by id, plus the church's own position name. Never a person's name. */
export interface FeedbackScope {
  team_id?: string; position?: string; person_id?: string; room_id?: string; workflow_id?: string; step_id?: string;
}
const SCOPE_KEYS = ["team_id", "position", "person_id", "room_id", "workflow_id", "step_id"] as const;
/** Display words for the parts of a scope that aren't people, as they read when the entry was made. Local only. */
export interface FeedbackLabels { team?: string; room?: string; workflow?: string; step?: string; occurrence?: string }
const LABEL_KEYS = ["team", "room", "workflow", "step", "occurrence"] as const;

/** Something Ozzie can prepare on its own, every time, once a person says so. Nothing is ever sent. */
export type AlwaysAction = "prepare-reminder" | "prepare-leader-note";
export const ALWAYS_ACTIONS: readonly AlwaysAction[] = ["prepare-reminder", "prepare-leader-note"];

/** A finding as feedback sees it. */
export interface FeedbackTarget {
  /** The finding's kind, e.g. "streak", "pending", "room-overlap", or any new one. */
  kind: string;
  /** Stable across checks of the same Sunday. */
  key: string;
  /** The occurrence it belongs to: the Sunday's plan id. */
  occurrence: string;
  /** The source facts that make this occurrence what it is. A correction stops hiding it when they change. */
  facts: string;
  /** "decision" findings may be told right away; "look" ones are Worth a look and never interrupt. */
  tone: "decision" | "look";
  scope: FeedbackScope;
  labels?: FeedbackLabels;
  /** What "Always do this" would prepare for this finding, when anything fits. */
  action?: AlwaysAction | null;
}

interface Base { id: string; kind: string; at: string }
/** "This isn't right": hides this one occurrence while its facts stay the same, and keeps what the person said. */
export interface CorrectionEntry extends Base { type: "correction"; key: string; occurrence: string; facts: string; scope: FeedbackScope; labels: FeedbackLabels; note: string }
/** "Stop flagging this": this kind of finding, for this scope, from the next check on. */
export interface StopEntry extends Base { type: "stop"; scope: FeedbackScope; labels: FeedbackLabels }
/** "Always do this": prepare this for every matching finding. */
export interface AlwaysEntry extends Base { type: "always"; action: AlwaysAction; scope: FeedbackScope; labels: FeedbackLabels }
/** "Always tell me right away" / "Put this in the briefing", for one kind of finding. */
export interface UrgencyEntry extends Base { type: "urgency"; level: "right-away" | "briefing" }
export type FeedbackEntry = CorrectionEntry | StopEntry | AlwaysEntry | UrgencyEntry;

/** A check that couldn't be completed is never set aside: a partial check must never read as all clear. */
const NEVER_HIDDEN: ReadonlySet<string> = new Set(["worth-a-look"]);
/**
 * Open roles are settled one Sunday at a time ("Not needed this Sunday"), never silenced for good. Kids safety
 * rules (kids-rules.ts) are never silenced from a card either, for a team or for one person: a later lapse (a
 * check that expires, a room left with one person) must still show. The church changes the rule itself on
 * Church rules, where it stays visible; "This isn't right" still sets aside one Sunday's occurrence.
 */
const NEVER_STOPPED: ReadonlySet<string> = new Set(["worth-a-look", "needs-people", "too-few-confirmed", "background-check"]);

const hasScope = (s: FeedbackScope) => SCOPE_KEYS.some(k => s[k] !== undefined);
const omit = (s: FeedbackScope, key: keyof FeedbackScope): FeedbackScope => Object.fromEntries(Object.entries(s).filter(([k]) => k !== key)) as FeedbackScope;
/** Every part an entry names matches the finding. An entry that names nothing matches nothing. */
export function scopeMatches(entry: FeedbackScope, finding: FeedbackScope): boolean {
  return hasScope(entry) && SCOPE_KEYS.every(k => entry[k] === undefined || entry[k] === finding[k]);
}
const sameScope = (a: FeedbackScope, b: FeedbackScope) => SCOPE_KEYS.every(k => a[k] === b[k]);

export const canCorrect = (t: Pick<FeedbackTarget, "kind">) => !NEVER_HIDDEN.has(t.kind);
/** Kinds whose changes between checks can bring a notice (changeFindingKind), whatever their card's tone. */
const NOTIFYING_KINDS: ReadonlySet<string> = new Set(["needs-people", "pending", "lead-missing"]);
/** Telling right away is only for solid findings that need a decision; Worth a look never interrupts. */
export const canPromote = (t: Pick<FeedbackTarget, "kind" | "tone">) => t.tone === "decision" && !NEVER_HIDDEN.has(t.kind);
/** Keeping a kind for the briefing is offered only where it changes something: kinds that can bring a notice. */
export const canDemote = (t: Pick<FeedbackTarget, "kind" | "tone">) => !NEVER_HIDDEN.has(t.kind) && (t.tone === "decision" || NOTIFYING_KINDS.has(t.kind));
/**
 * The scopes "Stop flagging this" offers, narrowest first: exactly what the finding is about, then one
 * step broader (anyone in that role rather than this person; the whole follow-up rather than this step).
 */
export function stopScopes(t: Pick<FeedbackTarget, "kind" | "scope">): FeedbackScope[] {
  if (NEVER_STOPPED.has(t.kind) || !hasScope(t.scope)) return [];
  const out = [t.scope];
  if (t.scope.person_id && (t.scope.position || t.scope.team_id)) out.push(omit(t.scope, "person_id"));
  else if (t.scope.step_id && t.scope.workflow_id) out.push(omit(t.scope, "step_id"));
  return out;
}
/** "Always do this" applies to the role or team, never to one person. */
export const alwaysScope = (t: Pick<FeedbackTarget, "scope">): FeedbackScope => omit(t.scope, "person_id");

export function urgencyFor(entries: readonly FeedbackEntry[], kind: string): UrgencyEntry["level"] | null {
  if (NEVER_HIDDEN.has(kind)) return null;
  return entries.find((e): e is UrgencyEntry => e.type === "urgency" && e.kind === kind)?.level ?? null;
}
export function stopFor(entries: readonly FeedbackEntry[], t: Pick<FeedbackTarget, "kind" | "scope">): StopEntry | null {
  if (NEVER_STOPPED.has(t.kind)) return null;
  return entries.find((e): e is StopEntry => e.type === "stop" && e.kind === t.kind && scopeMatches(e.scope, t.scope)) ?? null;
}
export function correctionFor(entries: readonly FeedbackEntry[], t: Pick<FeedbackTarget, "kind" | "key" | "occurrence" | "facts">): CorrectionEntry | null {
  if (NEVER_HIDDEN.has(t.kind)) return null;
  return entries.find((e): e is CorrectionEntry => e.type === "correction" && e.kind === t.kind && e.key === t.key && e.occurrence === t.occurrence && e.facts === t.facts) ?? null;
}
export function alwaysFor(entries: readonly FeedbackEntry[], t: Pick<FeedbackTarget, "kind" | "scope" | "action">): AlwaysEntry | null {
  if (!t.action) return null;
  return entries.find((e): e is AlwaysEntry => e.type === "always" && e.kind === t.kind && e.action === t.action && scopeMatches(e.scope, t.scope)) ?? null;
}

/** What a person's entries set aside, and which entry did. */
export interface Hidden<T> { item: T; entry: StopEntry | CorrectionEntry }
/** Lay the entries over one check's findings. A stop entry wins over a correction; a check that couldn't be completed always shows. */
export function applyFeedback<T>(items: readonly T[], targetOf: (item: T) => FeedbackTarget, entries: readonly FeedbackEntry[]): { shown: T[]; hidden: Hidden<T>[] } {
  const shown: T[] = [], hidden: Hidden<T>[] = [];
  for (const item of items) {
    const t = targetOf(item);
    const entry = entries.length ? stopFor(entries, t) ?? correctionFor(entries, t) : null;
    if (entry) hidden.push({ item, entry }); else shown.push(item);
  }
  return { shown, hidden };
}

// ---- Findings as feedback sees them --------------------------------------------------------------------

const sorted = (ids: readonly string[] | undefined) => [...new Set(ids ?? [])].sort();
/**
 * A room or follow-up finding's id without its workspace, organization and access epoch (which change
 * from check to check), so the same overlap or follow-up is recognized again.
 */
export function stableFindingKey(findingId: string): string {
  try {
    const parts = JSON.parse(findingId) as unknown;
    return Array.isArray(parts) && parts.length > 3 ? JSON.stringify(parts.slice(3)) : findingId;
  } catch { return findingId; }
}
/** A Sunday finding. A missing or unconfirmed lead is about the whole team; everything else about its role, and its person when it has one. */
export function briefTarget(f: Finding, occurrence: string, occurrenceLabel?: string | null): FeedbackTarget {
  const team = f.kind === "lead-missing" || f.kind === "lead-unverified";
  const scope: FeedbackScope = {
    ...(f.position ? team ? { team_id: f.position.team_id } : { team_id: f.position.team_id, position: f.position.name } : {}),
    ...(f.person_id ? { person_id: f.person_id } : {}),
  };
  const action: AlwaysAction | null = canRemind(f) ? "prepare-reminder" : canEscalate(f) ? "prepare-leader-note" : null;
  return {
    kind: f.kind, key: f.key, occurrence, tone: f.tone, scope, action,
    // Kids findings add what they state (the rule's number, who is pending, the background-check fact), so a
    // correction stops hiding one as soon as that changes. Other kinds keep their facts exactly as before.
    facts: JSON.stringify([f.remaining ?? null, f.notification ?? null, f.sundays ?? null, f.person_id ?? null, sorted(f.confirmed), sorted(f.pending_leads),
      ...(f.kind === "too-few-confirmed" || f.kind === "background-check" ? [f.needed ?? null, sorted(f.asked), sorted(f.not_sent), f.check ?? null, f.tone] : [])]),
    labels: { ...(team && f.position ? { team: f.position.name } : {}), ...(occurrenceLabel ? { occurrence: occurrenceLabel } : {}) },
  };
}
const label = (labels: Readonly<Record<string, string>>, id: string) => Object.hasOwn(labels, id) && labels[id] ? labels[id] : undefined;
/** A room overlap: about the room. Its facts are the two bookings and when they overlap. */
export function roomTarget(f: RoomFinding, occurrence: string, labels: Readonly<Record<string, string>> = {}): FeedbackTarget {
  const room = label(labels, f.resource_id);
  return {
    kind: f.kind, key: stableFindingKey(f.finding_id), occurrence, tone: f.certainty === "confirmed" ? "decision" : "look", scope: { room_id: f.resource_id },
    facts: JSON.stringify([sorted(f.bookings.map(b => b.booking_id)), f.overlap.starts_at, f.overlap.ends_at, f.certainty]), labels: room ? { room } : {},
  };
}
/** A follow-up without an owner: about its step in its workflow. */
export function followUpTarget(f: FollowUpFinding, occurrence: string, labels: Readonly<Record<string, string>> = {}): FeedbackTarget {
  const workflow = label(labels, f.workflow_id), step = label(labels, f.step_id);
  return {
    kind: f.kind, key: stableFindingKey(f.finding_id), occurrence, tone: "decision", scope: { workflow_id: f.workflow_id, step_id: f.step_id },
    facts: JSON.stringify([f.card_id, f.due_at]), labels: { ...(workflow ? { workflow } : {}), ...(step ? { step } : {}) },
  };
}
/** Someone whose group meets while they serve: about that person. Worth a look. */
export function groupTarget(m: GroupMeeting, occurrence: string): FeedbackTarget {
  return {
    kind: "group-meeting", key: `group:${m.person_id}`, occurrence, tone: "look", scope: { person_id: m.person_id },
    facts: JSON.stringify([m.meetings.map(x => [x.starts_at, x.ends_at]), m.serving.map(s => [s.position, s.status, s.interval.starts_at])]),
  };
}

// ---- Notices: how a check's changes are routed --------------------------------------------------------

/** The finding kind a Sunday change is about, or null for changes that aren't about one (better, neutral). */
export function changeFindingKind(kind: SundayChange["kind"]): string | null {
  switch (kind) {
    case "confirmed-declined": case "confirmed-removed": case "need-opened": case "need-increased":
    case "suggestion-conflict": case "suggestion-left-out": return "needs-people";
    case "pending-declined": return "pending";
    case "lead-missing": return "lead-missing";
    case "coverage-unverified": return "worth-a-look";
    default: return null;
  }
}
const changeScope = (c: SundayChange): FeedbackScope => ({
  ...(c.team_id ? { team_id: c.team_id } : {}), ...(c.position && c.kind !== "lead-missing" ? { position: c.position } : {}), ...(c.person_id ? { person_id: c.person_id } : {}),
});
export interface RoutedChanges {
  /** Worse changes that may still bring a notice. */
  notify: SundayChange[];
  /** One of them is urgent: inside the church's window, or a kind the person asked to hear about right away. */
  urgent: boolean;
  /** Worse changes kept for the briefing instead of a notice. */
  briefing: SundayChange[];
  /** Worse changes about something the person asked Ozzie to stop flagging. */
  stopped: SundayChange[];
}
/**
 * The person's entries applied to one check's changes. "Put this in the briefing" keeps a kind out of
 * notices; "Always tell me right away" marks it urgent (quiet hours still hold it unless the person let
 * urgent notices through). A change that couldn't be verified is never routed away.
 */
export function routeChanges(changes: readonly SundayChange[], entries: readonly FeedbackEntry[]): RoutedChanges {
  const out: RoutedChanges = { notify: [], urgent: false, briefing: [], stopped: [] };
  for (const c of changes) {
    if (c.effect !== "worse") continue;
    const kind = changeFindingKind(c.kind);
    if (kind && stopFor(entries, { kind, scope: changeScope(c) })) { out.stopped.push(c); continue; }
    const level = kind ? urgencyFor(entries, kind) : null;
    if (level === "briefing") { out.briefing.push(c); continue; }
    out.notify.push(c);
    if (c.urgency === "urgent" || (level === "right-away" && kind === "needs-people")) out.urgent = true;
  }
  return out;
}
/** New findings by kind, routed the same way: which still bring a notice, and whether any was asked for right away. */
export function routeFindings(found: readonly { key: string; kind: string; tone: "decision" | "look" }[], entries: readonly FeedbackEntry[]): { notify: string[]; urgent: boolean; briefing: string[] } {
  const out = { notify: [] as string[], urgent: false, briefing: [] as string[] };
  for (const f of found) {
    const level = urgencyFor(entries, f.kind);
    if (level === "briefing") { out.briefing.push(f.key); continue; }
    out.notify.push(f.key);
    if (level === "right-away" && f.tone === "decision") out.urgent = true;
  }
  return out;
}

// ---- Making and keeping entries ------------------------------------------------------------------------

const clean = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim();
const keepLabels = (labels: FeedbackLabels | undefined): FeedbackLabels =>
  Object.fromEntries(LABEL_KEYS.flatMap(k => typeof labels?.[k] === "string" && labels[k]!.trim() ? [[k, labels[k]!.trim().slice(0, 300)]] : [])) as FeedbackLabels;
const idFor = (parts: unknown[]) => JSON.stringify(parts).slice(0, 600);

export function correctionEntry(t: FeedbackTarget, note: string, at: string): CorrectionEntry {
  if (!canCorrect(t)) throw new Error("This can't be set aside: part of the check couldn't be read.");
  const text = clean(note);
  if (text.length > NOTE_MAX) throw new Error(`Keep it shorter (${NOTE_MAX} characters at most).`);
  return { type: "correction", id: idFor(["correction", t.kind, t.key, t.occurrence, at]), kind: t.kind, key: t.key, occurrence: t.occurrence, facts: t.facts,
    scope: { ...t.scope }, labels: keepLabels(t.labels), note: text, at };
}
export function stopEntry(t: FeedbackTarget, scope: FeedbackScope, at: string): StopEntry {
  if (!stopScopes(t).some(s => sameScope(s, scope))) throw new Error("That can't be stopped this way.");
  return { type: "stop", id: idFor(["stop", t.kind, scope, at]), kind: t.kind, scope: { ...scope }, labels: keepLabels(t.labels), at };
}
export function alwaysEntry(t: FeedbackTarget, at: string): AlwaysEntry {
  const scope = alwaysScope(t);
  if (!t.action || !hasScope(scope)) throw new Error("There's nothing Ozzie can prepare for this every time.");
  return { type: "always", id: idFor(["always", t.kind, t.action, scope, at]), kind: t.kind, action: t.action, scope, labels: keepLabels(t.labels), at };
}
export function urgencyEntry(t: Pick<FeedbackTarget, "kind" | "tone">, level: UrgencyEntry["level"], at: string): UrgencyEntry {
  if (level === "right-away" ? !canPromote(t) : !canDemote(t)) throw new Error(level === "right-away" ? "Worth a look never interrupts." : "This can't wait for the briefing.");
  return { type: "urgency", id: idFor(["urgency", t.kind, at]), kind: t.kind, level, at };
}

/** Adds an entry, replacing one that says the same thing (one urgency per kind). Oldest go first past the limit. */
export function withEntry(entries: readonly FeedbackEntry[], entry: FeedbackEntry): FeedbackEntry[] {
  const same = (e: FeedbackEntry) => e.type === entry.type && e.kind === entry.kind && (
    entry.type === "urgency" ||
    (entry.type === "stop" && sameScope((e as StopEntry).scope, entry.scope)) ||
    (entry.type === "always" && (e as AlwaysEntry).action === entry.action && sameScope((e as AlwaysEntry).scope, entry.scope)) ||
    (entry.type === "correction" && (e as CorrectionEntry).key === entry.key && (e as CorrectionEntry).occurrence === entry.occurrence));
  return [...entries.filter(e => !same(e)), entry].slice(-FEEDBACK_MAX);
}
export const withoutEntry = (entries: readonly FeedbackEntry[], id: string) => entries.filter(e => e.id !== id);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number, min = 1): v is string => typeof v === "string" && v.length >= min && v.length <= max;
function isScope(v: unknown): v is FeedbackScope {
  return isRecord(v) && Object.keys(v).every(k => (SCOPE_KEYS as readonly string[]).includes(k)) && Object.values(v).every(x => isText(x, 300));
}
const isLabels = (v: unknown): v is FeedbackLabels => isRecord(v) && Object.keys(v).every(k => (LABEL_KEYS as readonly string[]).includes(k)) && Object.values(v).every(x => isText(x, 300));
function isEntry(v: unknown): v is FeedbackEntry {
  if (!isRecord(v) || !isText(v.id, 600) || !isText(v.kind, 64) || !isText(v.at, 40)) return false;
  switch (v.type) {
    case "correction": return isText(v.key, 600) && isText(v.occurrence, 64) && isText(v.facts, 4000, 0) && isScope(v.scope) && isLabels(v.labels) && isText(v.note, NOTE_MAX, 0);
    case "stop": return isScope(v.scope) && hasScope(v.scope) && isLabels(v.labels) && !NEVER_STOPPED.has(v.kind);
    case "always": return isScope(v.scope) && hasScope(v.scope) && isLabels(v.labels) && (ALWAYS_ACTIONS as readonly unknown[]).includes(v.action);
    case "urgency": return (v.level === "right-away" || v.level === "briefing") && !NEVER_HIDDEN.has(v.kind);
    default: return false;
  }
}
/** The entries kept with the Church rules, checked: anything of another shape is dropped. */
export function feedbackOf(rules: { feedback?: unknown }): FeedbackEntry[] {
  return Array.isArray(rules.feedback) ? (rules.feedback as unknown[]).filter(isEntry).slice(-FEEDBACK_MAX) : [];
}

// ---- Plain words -----------------------------------------------------------------------------------------

/** Each kind in a few plain words, as the rules list says it. New kinds read as "findings like this" until named here. */
export const KIND_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "needs-people": "open roles",
  pending: "requests not yet accepted",
  streak: "serving streaks",
  "lead-missing": "a missing Sunday lead",
  "lead-unverified": "an unconfirmed Sunday lead",
  "room-overlap": "overlapping room bookings",
  "unowned-overdue": "follow-ups without an owner",
  "group-meeting": "group meeting clashes",
  attention: "email and calendar that disagree",
  "too-few-confirmed": "kids teams with fewer confirmed people than your rule asks",
  "background-check": "missing or expiring background checks",
});
export const kindWords = (kind: string) => Object.hasOwn(KIND_WORDS, kind) ? KIND_WORDS[kind]! : "findings like this";
type NameOf = (personId: string) => string | undefined;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "for Jordan Lee as Greeter", "for the Greeter team", "in Fellowship Hall". Names come only from `nameOf`, on this Mac. */
export function scopeWords(scope: FeedbackScope, labels: FeedbackLabels, nameOf: NameOf): string {
  const person = scope.person_id ? nameOf(scope.person_id)?.trim() || "someone on the team" : null;
  if (person && scope.position) return `for ${person} as ${scope.position}`;
  if (person) return `for ${person}`;
  if (scope.position) return `for ${scope.position}`;
  if (scope.team_id) return labels.team ? `for the ${labels.team} team` : "for that team";
  if (scope.room_id) return `in ${labels.room ?? "that room"}`;
  if (scope.step_id) return `for “${labels.step ?? "that step"}”${labels.workflow ? ` in ${labels.workflow}` : ""}`;
  if (scope.workflow_id) return `in ${labels.workflow ?? "that follow-up"}`;
  return "";
}
/** "Don't flag serving streaks for Jordan Lee." */
export function stopText(e: Pick<StopEntry, "kind" | "scope" | "labels">, nameOf: NameOf): string {
  return `Don't flag ${kindWords(e.kind)} ${scopeWords(e.scope, e.labels, nameOf)}.`.replace(/\s+\./u, ".");
}
/** "Always prepare a reminder note when a Greeter request has no answer yet." */
export function alwaysText(e: Pick<AlwaysEntry, "kind" | "action" | "scope" | "labels">, nameOf: NameOf): string {
  if (e.action === "prepare-reminder") return `Always prepare a reminder note when a request ${scopeWords(e.scope, e.labels, nameOf)} has no answer yet.`.replace(/\s+has/u, " has");
  return `Always prepare a note to the team's leader about ${kindWords(e.kind)} ${scopeWords(e.scope, e.labels, nameOf)}.`.replace(/\s+\./u, ".");
}
/** "Always tell me right away about open roles." / "Put serving streaks in the briefing." */
export function urgencyText(e: Pick<UrgencyEntry, "kind" | "level">): string {
  return e.level === "right-away" ? `Always tell me right away about ${kindWords(e.kind)}.` : `Put ${kindWords(e.kind)} in the briefing.`;
}
/** "Serving streaks for Jordan Lee", the subject of a correction. */
export function correctionSubject(e: Pick<CorrectionEntry, "kind" | "scope" | "labels">, nameOf: NameOf): string {
  return capital(`${kindWords(e.kind)} ${scopeWords(e.scope, e.labels, nameOf)}`.trim());
}
/** What one entry says, in a sentence. */
export function entryText(e: FeedbackEntry, nameOf: NameOf): string {
  switch (e.type) {
    case "stop": return stopText(e, nameOf);
    case "always": return alwaysText(e, nameOf);
    case "urgency": return urgencyText(e);
    case "correction": return `${correctionSubject(e, nameOf)}: you said this wasn't right${e.labels.occurrence ? ` for ${e.labels.occurrence}` : ""}.`;
  }
}
