// Today's three groups, and setting an item aside until tomorrow or Monday. Pure apart from the small
// store at the end.
//
//   Needs your attention: a finding that needs the person's decision, or something only the person can
//     fix. An email that disagrees with the calendar, Sunday things to decide, something Ozzie noticed
//     while keeping an eye on things, Sunday not checked yet, or access Ozzie doesn't have.
//   Ready to review: work Ozzie prepared that waits for the person to read: a briefing, a written
//     summary, a drafted note.
//   In progress: work under way that isn't waiting on the person. The regular Sunday check, while it runs (with
//     a check it missed on the same card), what else Ozzie keeps an eye on (with any problem, such as a missed
//     check, on the same card), and requests sent in Planning Center that are waiting for an answer.
//
// The group follows from an item's state alone, never from the kind of finding, so new kinds land in
// the right group without changes here. Each item is in exactly one group and counts once; counts are
// items, never people, and one matter never shows in two groups. Only each responsibility's newest
// report is an item. A set-aside item leaves its group until its time, then comes back with its age.
//
// Sunday's decisions show once, on the Sunday card. A Keep Sunday covered report about the Sunday on the
// card, read by the card's own check or an older one, is the same matter: it is folded into the card,
// which says Ozzie noticed it, what changed, and how many notes are ready on the Sunday page. The AI's
// write-up of that run (audit item 6) leads the card, or the card says quietly why there is none. A write-up
// never moves an item between groups: where an item goes follows from the fixed check alone. A report about
// another Sunday, or read by a newer check than the card's, is its own item. Once nothing on Sunday needs a
// decision, the folded report and its write-up leave Today.
//
// Sunday's count is one number wherever it shows (the sidebar, the Sunday card, the Sunday page): things
// to decide as the Sunday page shows them (core sunday-brief `sundayShownCount`), meaning Services findings,
// confirmed room overlaps and follow-ups without an owner that need a decision, not resolved by the person
// and not set aside by Church rules. Worth a look is counted and labeled apart, never added in.
import type { AttentionFinding, Message } from "../../../core/src/attention-import/index.js";
import type { Responsibility } from "../../../core/src/harness/responsibilities.js";
import { addDays, DAY_MS, weekdayOf } from "../../../core/src/harness/responsibilities.js";
import { isTimeZone, localDate, localDay } from "../../../core/src/church-time.js";
import type { NoticedItem, RunnerView, WriteUp } from "./responsibility-runner.js";
import type { KeyValueStore } from "./proactive.js";
import { SUNDAY_WORDS, type DayWords } from "../../../core/src/service-day.js";
import { eyeLine, keepTitle, pageRef } from "./day-phrases.js";

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
  /** `noticed`: the Keep Sunday covered report folded into the card, if any; `writeup`: its run's write-up, or why there is none. */
  | { type: "sunday"; decisions: number; noticed: NoticedItem | null; writeup: WriteUp | null }
  | { type: "sunday-unchecked" }
  /** Planning Center isn't connected and the fictional example isn't on: what to do next, never invented items (audit item 2). */
  | { type: "connect" }
  | { type: "noticed"; item: NoticedItem }
  | { type: "watching"; responsibility: Responsibility; notes: NoticedItem[] }
  /** The regular Sunday check (proactive.ts), once it can run: how often, when it last and next looks, what it missed. */
  | { type: "regular"; check: RegularCheck }
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
/**
 * The regular Sunday check as Today shows it (audit item 24), from What runs automatically's schedule. Times are ISO;
 * `missed`: when each scheduled check it missed in the last day was due (Ozzie closed or this Mac asleep), newest first.
 */
export interface RegularCheck {
  ready: boolean; paused: boolean; running: boolean; intervalMinutes: number; runOnLaunch: boolean;
  last: { at: string; ok: boolean } | null; next: string | null; missed: string[];
}
export interface TodayInput {
  now: string;
  /** The regular Sunday check; null where it isn't shown (the fictional example, or no schedule). */
  regular?: RegularCheck | null;
  /** Planning Center isn't connected (and the example isn't on): Today asks for it in place of the unchecked Sunday. */
  notConnected?: boolean;
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

/** Whether a noticed report waits for review (a briefing, or notes the check prepared) or needs a decision. Never from a write-up. */
export function reportState(item: NoticedItem): ItemState {
  if (item.kind === "briefing") return "prepared";
  return (item.drafts ?? 0) > 0 ? "prepared" : "needs-decision";
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
    // About the Sunday on the card: the card carries its decisions, notes and write-up.
    if (onSundayCard(item, input.sunday)) {
      if (input.sunday.decisions === 0) continue;
      if (!foldedIntoSunday || item.at > foldedIntoSunday.at) foldedIntoSunday = item;
      continue;
    }
    noticed.push({ id: `noticed:${item.id}`, state: reportState(item), since: item.at, subject: { type: "noticed", item } });
  }

  if (input.attention) {
    const { zone, evaluated_at } = input.attention;
    for (const finding of input.attention.findings) {
      const received = input.attention.messages.filter(m => finding.source_ids.includes(m.id)).map(m => m.received_at).sort()[0];
      items.push({ id: `email:${safeId(finding.id)}`, state: "needs-decision", since: received ?? finding.imported_at, clock: { now: evaluated_at, zone }, subject: { type: "email", finding } });
    }
  }
  if (!input.sunday) items.push(input.notConnected ? { id: "connect:planning-center", state: "needs-you", since: null, subject: { type: "connect" } }
    : { id: "sunday-unchecked", state: "needs-you", since: null, subject: { type: "sunday-unchecked" } });
  else if (input.sunday.decisions > 0) {
    const id = `sunday:${input.sunday.plan_id}`;
    const writeup = foldedIntoSunday ? view?.writeups[foldedIntoSunday.id] ?? null : null;
    items.push({ id, state: "needs-decision", since: seen(id), subject: { type: "sunday", decisions: input.sunday.decisions, noticed: foldedIntoSunday, writeup } });
  }
  items.push(...noticed);
  for (const [rid, item] of access) {
    // A later check that finished shows the access is there now.
    if (!current(rid) || (succeeded.has(rid) && succeeded.get(rid)! > item.at)) continue;
    items.push({ id: `noticed:${item.id}`, state: "needs-you", since: item.at, subject: { type: "noticed", item } });
  }

  // Always on once it can run, so it leads what's in progress; before then the group says what starts it.
  if (input.regular && (input.regular.ready || input.regular.paused)) {
    items.push({ id: "regular:sunday-check", state: "under-way", since: null, subject: { type: "regular", check: input.regular } });
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

const every = (minutes: number) => minutes === 60 ? "every hour" : minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`;
const at = (iso: string, now: string, zone: string) => localDate(iso, zoneOr(zone)) === localDate(now, zoneOr(zone)) ? clock(iso, zone)
  : `${new Date(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: zoneOr(zone) })} ${clock(iso, zone)}`;
/**
 * What the regular Sunday check is doing, in one line (audit item 24): "Checks Planning Center every hour while Ozzie is
 * open. Last checked 9:06 AM. Next check 10:06 AM."
 */
export function regularLine(c: RegularCheck, now: string, zone: string): string {
  const how = `Checks Planning Center ${every(c.intervalMinutes)} while Ozzie is open${c.runOnLaunch ? ", and when it opens" : ""}.`;
  const last = c.last ? ` Last checked ${at(c.last.at, now, zone)}${c.last.ok ? "" : ", but that check couldn't finish"}.` : " Not checked yet.";
  const next = c.paused ? " Paused: nothing runs until you resume it in Keeping watch." : c.running ? " Checking now." : c.next ? ` Next check ${at(c.next, now, zone)}.` : "";
  return `${how}${last}${next}`;
}
/** A scheduled check missed in the last day, said plainly with when, and when it looked again if it has. */
export function regularMissedText(c: RegularCheck, now: string, zone: string): string | null {
  const due = c.missed[0];
  if (!due) return null;
  const others = c.missed.length > 1 ? ` and ${c.missed.length - 1} other ${c.missed.length === 2 ? "time" : "times"}` : "";
  const after = c.last && ms(c.last.at) > ms(due) ? ` It checked again at ${at(c.last.at, now, zone)}.` : " It checks again when it can.";
  return `A check was due at ${at(due, now, zone)}${others}, but Ozzie wasn't running or this Mac was asleep.${after}`;
}
/**
 * In progress with nothing in it: what would start something, never a pointer to Ask (audit item 4). Named by the
 * watched service's real day (`d`, onboarding spec §5); the fictional example is a Sunday.
 */
export function progressEmptyText(regular: RegularCheck | null | undefined, example: boolean, d: DayWords = SUNDAY_WORDS): string {
  if (example) return "Nothing runs in the fictional example.";
  if (regular && !regular.ready) return `Nothing runs yet. ${eyeLine(d)} once Planning Center is connected and a service is chosen; ${keepTitle(d)} and other jobs start when you set them up.`;
  return `Nothing is running. ${keepTitle(d)} and other jobs start when you set them up in Keeping watch.`;
}

/** One decision Today names (audit item 17): its words, the Sunday card it opens, and whether that card lists people. */
export interface DecisionLine { key: string; text: string; people: boolean; count?: number }
/** At most this many decisions are named on Today; the rest are counted, "and 2 more on Sunday". */
export const DECISIONS_NAMED = 5;
type Decided = { finding: { key: string; kind: string; tone: string; position?: { name: string; interval: { starts_at: string } | null }; remaining?: number;
  people?: { suggestions: readonly unknown[]; conflicts: readonly unknown[] }; check?: string | undefined } ; state: string };
const more = (n: number) => n === 1 ? "1 more person needed" : `${n} more people needed`;
/**
 * The Sunday decisions Today names, in the Sunday page's order: role, how many still needed, when, and how many on the
 * team are clear for that time. Counts and role names only: never a person's name, never ranked or scored. Rooms and
 * follow-ups that need a decision are named by what they are. `named` is at most DECISIONS_NAMED; `more` the rest.
 */
export function decisionLines(items: readonly Decided[], ops: { rooms: number; followUps: number }, zone: string, d: DayWords = SUNDAY_WORDS): { named: DecisionLine[]; more: number } {
  const z = zoneOr(zone);
  const at = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: z });
  const lines: DecisionLine[] = items.filter(i => i.state !== "resolved" && i.finding.tone === "decision").map(({ finding: f }) => {
    const role = f.position?.name ?? "A role";
    const when = f.position?.interval ? at(f.position.interval.starts_at) : d.thisOne;
    switch (f.kind) {
      case "needs-people": {
        const clear = f.people?.suggestions.length ?? 0;
        const team = clear === 0 ? "no one else on the team is clear" : clear === 1 ? "1 on the team is clear" : `${clear} on the team are clear`;
        return { key: f.key, text: `${role}: ${more(f.remaining ?? 1)}, ${when}. ${team.charAt(0).toUpperCase()}${team.slice(1)} for that time.`,
          people: clear + (f.people?.conflicts.length ?? 0) > 0 };
      }
      case "too-few-confirmed": return { key: f.key, text: `${role}: fewer confirmed people than your rule asks, ${when}.`, people: false };
      // As Planning Center People shows it (core kids-rules.ts `check`), never whose (review P, L7).
      case "background-check": return { key: f.key, people: false, text: f.check === "none-current" ? `${role}: someone scheduled for ${when} has no current background check on file.`
        : f.check === "expires-before-sunday" ? `${role}: a background check on file expires before ${when}.`
          : `${role}: a background check is missing or expires before ${when}.` };
      case "lead-missing": return { key: f.key, text: `${role}: no one is scheduled to lead, ${when}.`, people: false };
      default: return { key: f.key, text: `${role}: needs a decision, ${when}.`, people: false };
    }
  });
  // Rooms and follow-ups are named together, each line standing for as many decisions as it counts.
  if (ops.rooms) lines.push({ key: "rooms", text: ops.rooms === 1 ? "A room has overlapping bookings to review." : `${ops.rooms} room booking overlaps to review.`, people: false, count: ops.rooms });
  if (ops.followUps) lines.push({ key: "follow-ups", text: ops.followUps === 1 ? "A follow-up has no owner and is past due." : `${ops.followUps} follow-ups have no owner and are past due.`, people: false, count: ops.followUps });
  const named = lines.slice(0, DECISIONS_NAMED);
  const total = lines.reduce((n, l) => n + (l.count ?? 1), 0);
  return { named, more: total - named.reduce((n, l) => n + (l.count ?? 1), 0) };
}

/** The count beside a group's heading: items, never people. */
export const countText = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;

/**
 * Sunday's count wherever it shows (the sidebar, the Sunday card): things to decide, from `sundayShownCount` so it
 * matches the Sunday page. Worth a look is never added in.
 */
export const sundayCount = (open: { decisions: number } | null) => open?.decisions ?? 0;
export const sundayCountText = (n: number) => `${n} ${n === 1 ? "thing" : "things"} to decide`;

/** Notes ready on the Sunday page for a report folded into the Sunday card (less one an older version counted as the AI's). */
export const pageNotes = (item: NoticedItem) => Math.max(0, (item.drafts ?? 0) - (item.drafted ? 1 : 0));
export const notesReadyText = (n: number, d: DayWords = SUNDAY_WORDS) => `Ozzie has ${n === 1 ? "a note" : `${n} notes`} ready for these on ${pageRef(d)}. Nothing has been sent.`;

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
