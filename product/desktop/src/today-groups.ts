// Today's three groups, and setting an item aside until tomorrow or Monday. Pure apart from the small
// store at the end.
//
//   Needs your attention: a finding that needs the person's decision, or something only the person can
//     fix. An email that disagrees with the calendar, Sunday things to decide, something Ozzie noticed
//     while keeping an eye on things, Sunday not checked yet, or access Ozzie doesn't have.
//   Ready to review: work Ozzie prepared that waits for the person to read: a briefing, a written
//     summary, a drafted note.
//   In progress: work under way that isn't waiting on the person. What Ozzie keeps an eye on (with any
//     problem, such as a missed check, on the same card), and requests sent in Planning Center that are
//     waiting for an answer.
//
// The group follows from an item's state alone, never from the kind of finding, so new kinds land in
// the right group without changes here. Each item is in exactly one group and counts once; counts are
// items, never people, and one matter never shows in two groups. Only each responsibility's newest
// report is an item. A set-aside item leaves its group until its time, then comes back with its age.
//
// Sunday's decisions show once, on the Sunday card. A Keep Sunday covered report about the Sunday on the
// card, read by the card's own check or an older one, is the same matter: it is folded into the card,
// which says Ozzie noticed it, what changed, and how many notes are ready on the Sunday page. The AI's
// write-up of that Sunday restates the decisions, so it goes on the card too, folded away until asked
// for. A note the AI drafted is prepared work of its own in Ready to review, named as a drafted note and
// never repeating the decisions. A report about another Sunday, or read by a newer check than the card's,
// is its own item. Once nothing on Sunday needs a decision, the folded report and what was written for it
// leave Today.
//
// Sunday's count is one number wherever it shows (the sidebar, the Sunday card, the Sunday page): things
// to decide, meaning findings that need a decision, not resolved by the person and not set aside by Church
// rules. Worth a look is counted and labeled apart, never added in.
import type { AttentionFinding, Message } from "../../../core/src/attention-import/index.js";
import type { Responsibility } from "../../../core/src/harness/responsibilities.js";
import { addDays, DAY_MS, weekdayOf } from "../../../core/src/harness/responsibilities.js";
import { isTimeZone, localDate, localDay } from "../../../core/src/church-time.js";
import type { NoticedItem, RunnerView } from "./responsibility-runner.js";
import type { KeyValueStore } from "./proactive.js";

export type GroupId = "attention" | "review" | "progress";
export type ItemState = "needs-decision" | "needs-you" | "prepared" | "waiting-answer" | "under-way";
export const GROUP_OF: Readonly<Record<ItemState, GroupId>> = Object.freeze({
  "needs-decision": "attention", "needs-you": "attention", prepared: "review", "waiting-answer": "progress", "under-way": "progress",
});
export const GROUP_ORDER: readonly GroupId[] = ["attention", "review", "progress"];
/** Work under way has its own Pause; only what waits on the person can be set aside. */
export const CAN_SET_ASIDE: Readonly<Record<GroupId, boolean>> = Object.freeze({ attention: true, review: true, progress: false });

/** What a card shows. Rendering only: the group comes from `state`. */
export type TodaySubject =
  | { type: "email"; finding: AttentionFinding }
  /** `noticed`: the Keep Sunday covered report folded into the card, if any; `summary`: the AI's write-up for it. */
  | { type: "sunday"; decisions: number; noticed: NoticedItem | null; summary: string | null }
  | { type: "sunday-unchecked" }
  | { type: "noticed"; item: NoticedItem }
  /** A note the AI drafted for a report folded into the Sunday card (`ready.summary` is on the card, so null here). */
  | { type: "prepared"; item: NoticedItem; ready: Written }
  | { type: "watching"; responsibility: Responsibility; notes: NoticedItem[] }
  | { type: "answers"; positions: string[] };
export interface TodayItem {
  /** Name-free and stable: what set-aside and first-seen times are kept by on this Mac. */
  id: string;
  state: ItemState;
  /** When it started waiting for the person, or (under way) when it started; null shows no age. */
  since: string | null;
  /** A fictional item is shown at its own fixed clock, never this Mac's. */
  clock?: { now: string; zone: string };
  subject: TodaySubject;
}

/** A summary or a drafted note the AI wrote, kept in memory on this Mac. */
export interface Written { summary: string | null; draft: string | null }

/** The Sunday as the latest check read it, with the person's own decisions applied. */
export interface TodaySunday {
  plan_id: string;
  /** When that check finished. A Keep Sunday covered report read by this check or an older one is folded into the card. */
  checked_at: string;
  /** Sunday findings to decide, of any kind (Needs a decision, not resolved by the person, not set aside by Church rules). */
  decisions: number;
  /** Positions with a request Planning Center records as sent and not yet accepted. */
  answers: string[];
}
export interface TodayInput {
  now: string;
  /** The fictional email and calendar import, shown at its own clock. */
  attention: { findings: readonly AttentionFinding[]; messages: readonly Message[]; evaluated_at: string; zone: string } | null;
  /** null: Sunday hasn't been checked (in this run of the app). */
  sunday: TodaySunday | null;
  watch: RunnerView | null;
  /** When an item without a time of its own was first on Today on this Mac. */
  firstSeen: Readonly<Record<string, string>>;
}

/** Templates whose report is about the same Sunday decisions as the Sunday card. */
const SUNDAY_CARD = new Set(["keep-sunday-covered"]);
const REPORT = new Set<NoticedItem["kind"]>(["found", "briefing"]);
const NOTE = new Set<NoticedItem["kind"]>(["missed", "limit", "couldnt-check"]);
/** Problems older than this are history (What runs automatically keeps them), not news on Today. */
const NOTE_WINDOW_MS = DAY_MS;
const NOTES_SHOWN = 2;
const ms = (iso: string) => Date.parse(iso);
/** An id in the characters kept on this Mac (an import's finding id is JSON). */
const safeId = (raw: string) => raw.replace(/[^\w:.-]+/gu, "_").slice(0, 200);

/** Whether a noticed report waits for review (something prepared) or needs a decision. */
export function reportState(item: NoticedItem, prepared?: Written): ItemState {
  if (item.kind === "briefing") return "prepared";
  return prepared?.summary || prepared?.draft || (item.drafts ?? 0) > 0 ? "prepared" : "needs-decision";
}

/**
 * Whether a report is about the Sunday on the card, read by the card's own check or an older one. A report
 * from before reports kept their check counts when it is no newer than the card's check.
 */
function onSundayCard(item: NoticedItem, sunday: TodaySunday | null): sunday is TodaySunday {
  if (!sunday || !SUNDAY_CARD.has(item.template)) return false;
  return item.check ? item.check.plan_id === sunday.plan_id && ms(item.check.completed_at) <= ms(sunday.checked_at) : ms(item.at) <= ms(sunday.checked_at);
}

/** Every Today item, in the order shown within its group. */
export function todayItems(input: TodayInput): TodayItem[] {
  const items: TodayItem[] = [];
  const seen = (id: string) => input.firstSeen[id] ?? input.now;
  const view = input.watch;
  const known = new Map((view?.items ?? []).map(r => [r.id, r]));
  // A report from a responsibility that has ended, or one Ozzie no longer keeps, isn't current work.
  const current = (id: string) => known.get(id)?.status === "active" || known.get(id)?.status === "paused" || (!known.has(id) && view?.available === false);

  // Each responsibility's newest report (a later "nothing new" doesn't resolve it), and access only the person can add.
  const reports = new Map<string, NoticedItem>();
  const access = new Map<string, NoticedItem>();
  const succeeded = new Map<string, string>();
  for (const i of view?.noticed ?? []) {
    if ((REPORT.has(i.kind) || i.kind === "clear") && !succeeded.has(i.responsibility_id)) succeeded.set(i.responsibility_id, i.at);
    if (REPORT.has(i.kind) && !reports.has(i.responsibility_id)) reports.set(i.responsibility_id, i);
    if (i.kind === "couldnt-check" && i.access && !access.has(i.responsibility_id)) access.set(i.responsibility_id, i);
  }

  let foldedIntoSunday: NoticedItem | null = null;
  const noticed: TodayItem[] = [];
  for (const [rid, item] of reports) {
    if (!current(rid)) continue;
    const written = view?.prepared[item.id];
    // About the Sunday on the card: the card carries its decisions, notes and write-up; a drafted note is its own item.
    if (onSundayCard(item, input.sunday)) {
      if (input.sunday.decisions === 0) continue;
      if (!foldedIntoSunday || item.at > foldedIntoSunday.at) foldedIntoSunday = item;
      if (written?.draft) noticed.push({ id: `prepared:${item.id}`, state: "prepared", since: item.at, subject: { type: "prepared", item, ready: { summary: null, draft: written.draft } } });
      continue;
    }
    noticed.push({ id: `noticed:${item.id}`, state: reportState(item, written), since: item.at, subject: { type: "noticed", item } });
  }

  if (input.attention) {
    const { zone, evaluated_at } = input.attention;
    for (const finding of input.attention.findings) {
      const received = input.attention.messages.filter(m => finding.source_ids.includes(m.id)).map(m => m.received_at).sort()[0];
      items.push({ id: `email:${safeId(finding.id)}`, state: "needs-decision", since: received ?? finding.imported_at, clock: { now: evaluated_at, zone }, subject: { type: "email", finding } });
    }
  }
  if (!input.sunday) items.push({ id: "sunday-unchecked", state: "needs-you", since: null, subject: { type: "sunday-unchecked" } });
  else if (input.sunday.decisions > 0) {
    const id = `sunday:${input.sunday.plan_id}`;
    const summary = foldedIntoSunday ? view?.prepared[foldedIntoSunday.id]?.summary ?? null : null;
    items.push({ id, state: "needs-decision", since: seen(id), subject: { type: "sunday", decisions: input.sunday.decisions, noticed: foldedIntoSunday, summary } });
  }
  items.push(...noticed);
  for (const [rid, item] of access) {
    // A later check that finished shows the access is there now.
    if (!current(rid) || (succeeded.has(rid) && succeeded.get(rid)! > item.at)) continue;
    items.push({ id: `noticed:${item.id}`, state: "needs-you", since: item.at, subject: { type: "noticed", item } });
  }

  for (const r of view?.items ?? []) {
    if (r.status === "ended") continue;
    const notes = (view?.noticed ?? []).filter(i => i.responsibility_id === r.id && NOTE.has(i.kind) && !(i.kind === "couldnt-check" && i.access)
      && ms(input.now) - ms(i.at) <= NOTE_WINDOW_MS).slice(0, NOTES_SHOWN);
    items.push({ id: `watching:${r.id}`, state: "under-way", since: r.confirmed_at, subject: { type: "watching", responsibility: r, notes } });
  }
  if (input.sunday && input.sunday.answers.length) {
    const id = `answers:${input.sunday.plan_id}`;
    items.push({ id, state: "waiting-answer", since: seen(id), subject: { type: "answers", positions: input.sunday.answers } });
  }
  return items;
}

export interface Grouped {
  attention: TodayItem[]; review: TodayItem[]; progress: TodayItem[];
  /** Set aside and not back yet, soonest first. */
  setAside: { item: TodayItem; until: string }[];
}
/** Each item into exactly one group by its state; a set-aside item waits outside them until its time. */
export function groupToday(items: readonly TodayItem[], setAside: Readonly<Record<string, string>>, now: string): Grouped {
  const out: Grouped = { attention: [], review: [], progress: [], setAside: [] };
  for (const item of items) {
    const group = GROUP_OF[item.state];
    const until = setAside[item.id];
    if (until && CAN_SET_ASIDE[group] && ms(until) > ms(now)) out.setAside.push({ item, until });
    else out[group].push(item);
  }
  out.setAside.sort((a, b) => a.until.localeCompare(b.until));
  return out;
}

// ---- Words ---------------------------------------------------------------------------------------------

const zoneOr = (zone: string) => isTimeZone(zone) ? zone : "UTC";
const daysBetween = (from: string, to: string) => Math.round((ms(`${to}T00:00:00Z`) - ms(`${from}T00:00:00Z`)) / DAY_MS);
const clock = (iso: string, zone: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zoneOr(zone) });

/** An item's age in plain words, by calendar day on `zone`'s clock: "Waiting since 8:15 AM", "Waiting 4 days". */
export function ageText(item: Pick<TodayItem, "since" | "state">, now: string, zone: string): string | null {
  if (!item.since || !Number.isFinite(ms(item.since)) || !Number.isFinite(ms(now))) return null;
  const since = ms(item.since) > ms(now) ? now : item.since;
  const z = zoneOr(zone);
  const days = daysBetween(localDate(since, z), localDate(now, z));
  if (item.state === "under-way") return days <= 0 ? `Started at ${clock(since, z)}` : days === 1 ? "Started yesterday" : `Started ${days} days ago`;
  return days <= 0 ? `Waiting since ${clock(since, z)}` : days === 1 ? "Waiting since yesterday" : `Waiting ${days} days`;
}

/** "Set aside until tomorrow" and, unless tomorrow is Monday, "until Monday": the start of that day on `zone`'s clock. */
export function setAsideChoices(now: string, zone: string): { label: string; until: string }[] {
  const z = zoneOr(zone);
  const today = localDate(now, z);
  const tomorrow = addDays(today, 1);
  const choices = [{ label: "Set aside until tomorrow", until: localDay(tomorrow, z)?.starts_at }];
  if (weekdayOf(tomorrow) !== 1) {
    const monday = addDays(today, (1 - weekdayOf(today) + 7) % 7 || 7);
    choices.push({ label: weekdayOf(today) === 1 ? "Set aside until next Monday" : "Set aside until Monday", until: localDay(monday, z)?.starts_at });
  }
  return choices.filter((c): c is { label: string; until: string } => Boolean(c.until));
}

/** When a set-aside item comes back: "Back tomorrow", "Back Monday". */
export function backText(until: string, now: string, zone: string): string {
  const z = zoneOr(zone);
  const days = daysBetween(localDate(now, z), localDate(until, z));
  if (days <= 0) return "Back soon";
  if (days === 1) return "Back tomorrow";
  const weekday = new Date(until).toLocaleDateString("en-US", { weekday: "long", timeZone: z });
  return days < 7 ? `Back ${weekday}` : `Back ${weekday}, ${new Date(until).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: z })}`;
}

/** The count beside a group's heading: items, never people. */
export const countText = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/** Sunday's count wherever it shows (the sidebar, the Sunday card): things to decide. Worth a look is never added in. */
export const sundayCount = (open: { decisions: number } | null) => open?.decisions ?? 0;
export const sundayCountText = (n: number) => `${n} ${n === 1 ? "thing" : "things"} to decide`;

/** Notes ready on the Sunday page for a report folded into the Sunday card: its notes, less the one the AI drafted (that one is its own item). */
export const pageNotes = (item: NoticedItem) => Math.max(0, (item.drafts ?? 0) - (item.drafted ? 1 : 0));
export const notesReadyText = (n: number) => `Ozzie has ${n === 1 ? "a note" : `${n} notes`} ready for these on the Sunday page. Nothing has been sent.`;

/** The line under the page title, from the counts alone. */
export function ledeText(g: Pick<Grouped, "attention" | "review" | "progress">): string {
  const a = g.attention.length, r = g.review.length;
  const parts = [
    ...(a ? [`${a} ${a === 1 ? "thing needs" : "things need"} your attention.`] : []),
    ...(r ? [`${r} ${r === 1 ? "is" : "are"} ready to review.`] : []),
  ];
  return parts.length ? parts.join(" ") : "Nothing needs you right now.";
}

// ---- Kept on this Mac ----------------------------------------------------------------------------------

const SET_ASIDE = "ozzie.today.set-aside.v1";
const FIRST_SEEN = "ozzie.today.first-seen.v1";
const KEPT = 200;
const FORGET_AFTER_MS = 30 * DAY_MS;
const ID = /^[a-z-]+:[\w:.\-]{1,200}$|^sunday-unchecked$/u;
const valid = (id: unknown, at: unknown): at is string => typeof id === "string" && ID.test(id) && typeof at === "string" && Number.isFinite(ms(at));
function readMap(store: KeyValueStore, key: string): Record<string, string> {
  try {
    const raw = JSON.parse(store.get(key) ?? "null") as { version?: unknown; items?: unknown } | null;
    if (!raw || raw.version !== 1 || !raw.items || typeof raw.items !== "object") return {};
    return Object.fromEntries(Object.entries(raw.items as Record<string, unknown>).filter(([id, at]) => valid(id, at)).slice(0, KEPT)) as Record<string, string>;
  } catch { return {}; }
}
const writeMap = (store: KeyValueStore, key: string, items: Record<string, string>) => store.set(key, JSON.stringify({ version: 1, items }));

/**
 * Set-aside times and first-seen times, per device and name-free (ids and times only). Losing them only
 * brings set-aside items back early and restarts an age; it never hides anything.
 */
export function todayMemory(store: KeyValueStore) {
  return {
    setAside: (): Record<string, string> => readMap(store, SET_ASIDE),
    /** Sets one aside; anything already back is forgotten. */
    setAsideUntil(id: string, until: string, now: string): Record<string, string> {
      const kept = Object.fromEntries(Object.entries(readMap(store, SET_ASIDE)).filter(([, at]) => ms(at) > ms(now)));
      const next = valid(id, until) ? { ...kept, [id]: until } : kept;
      writeMap(store, SET_ASIDE, next);
      return next;
    },
    bringBack(id: string): Record<string, string> {
      const next = Object.fromEntries(Object.entries(readMap(store, SET_ASIDE)).filter(([k]) => k !== id));
      writeMap(store, SET_ASIDE, next);
      return next;
    },
    firstSeen: (): Record<string, string> => readMap(store, FIRST_SEEN),
    /** Notes when these items were first on Today; forgets ones first seen over a month ago that aren't on Today now. Returns what changed, or null. */
    noteSeen(ids: readonly string[], now: string): Record<string, string> | null {
      const known = readMap(store, FIRST_SEEN);
      const missing = ids.filter(id => !known[id] && valid(id, now));
      const stale = Object.entries(known).filter(([id, at]) => !ids.includes(id) && ms(now) - ms(at) > FORGET_AFTER_MS);
      if (!missing.length && !stale.length) return null;
      const next = Object.fromEntries([...Object.entries(known).filter(([id]) => !stale.some(([s]) => s === id)), ...missing.map(id => [id, now])].slice(-KEPT));
      writeMap(store, FIRST_SEEN, next);
      return next;
    },
  };
}
