// The leader's own calendars on Today: Apple Calendar on this Mac (Ozzie's read-only helper, ozzie-calendar) and
// private calendar links (ics.ts). Pure: no I/O, no clock, no model.
//
// Findings are facts with their source and check time, and deterministic only: what is on the calendar today and on
// the next seven days, and two timed events that overlap ("two things at the same time"). An overlap with a tentative
// event is worth a look; an event whose time Ozzie isn't sure of is labeled and never counted in one. The same event
// read from two calendars (an Apple calendar subscribed to the same Google calendar as a link) is shown once with
// both sources, never as an overlap with itself.
//
// Calendar text stays on this Mac. Nothing here is part of a model request, the copy for other AI apps, or a notice:
// core/test/calendar/stays-on-this-mac.test.ts proves no module that builds one of those imports this.
import { isTimeZone, localDate, localDay } from "../church-time.js";
import { MAX_LOCATION, MAX_TITLE, parseIcs, plainText, type CalendarLook, type CalendarTime, type IcsEvent } from "./ics.js";

/** Where an event was read: Apple Calendar on this Mac, or a private link with the label the leader typed. */
export interface CalendarSource { kind: "apple" | "link"; id: string; label: string }
export const APPLE_SOURCE: CalendarSource = Object.freeze({ kind: "apple", id: "apple", label: "Apple Calendar on this Mac" });
/** An event as read. `calendar`: which Apple calendar it is in (Apple Calendar on this Mac holds several). */
export type CalendarEvent = IcsEvent & { calendar?: string };
/** One calendar's read: what touched the days shown, when it was read, and why not when it couldn't be. */
export interface CalendarRead {
  source: CalendarSource;
  checked_at: string;
  /** Why it couldn't be read, in plain words; null when it was. */
  problem: string | null;
  events: CalendarEvent[];
  looks: CalendarLook[];
  /** More events than Ozzie keeps for these days. */
  truncated: boolean;
}
/** An event as shown: once, with every calendar it was read from. */
export interface CalendarEntry extends IcsEvent { sources: CalendarSource[] }
export interface CalendarOverlap {
  /** Stable for the same two events, whatever order they were read in. */
  id: string;
  /** "decision" when both are confirmed; "look" (worth a look) when one is tentative. */
  tone: "decision" | "look";
  /** The local date the overlap starts on. */
  date: string;
  starts_at: string;
  ends_at: string;
  first: CalendarEntry;
  second: CalendarEntry;
  /** Why it is only worth a look; null for a decision. */
  reason: string | null;
}
export interface CalendarDay { date: string; entries: CalendarEntry[] }
export interface CalendarView {
  dates: string[];
  days: CalendarDay[];
  overlaps: CalendarOverlap[];
  /** More overlaps than `MAX_OVERLAPS` were found; the rest are left out. */
  overlaps_cut: boolean;
  looks: (CalendarLook & { source: CalendarSource })[];
  reads: { source: CalendarSource; checked_at: string; problem: string | null; truncated: boolean; count: number }[];
}

/** Today and the next seven days. */
export const CALENDAR_DAYS = 8;
/** Overlaps shown; a calendar with more says so. */
export const MAX_OVERLAPS = 50;
/** Events kept from Apple Calendar's answer (the helper sends at most this many). */
const MAX_APPLE_EVENTS = 1000;
const DAY_MS = 86_400_000;

/** The days shown, from this Mac's midnight today: their dates and the instants they span. */
export function calendarWindow(now: string, zone: string, days = CALENDAR_DAYS): { from: string; to: string; dates: string[] } | null {
  const at = Date.parse(now);
  if (!Number.isFinite(at) || !isTimeZone(zone)) return null;
  const first = localDate(at, zone);
  const dates = Array.from({ length: days }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));
  const start = localDay(dates[0]!, zone), end = localDay(dates.at(-1)!, zone);
  return start && end ? { from: start.starts_at, to: end.ends_at, dates } : null;
}

const touches = (time: CalendarTime, window: { from: string; to: string; dates: string[] }) => time.all_day
  ? time.start_date <= window.dates.at(-1)! && time.end_date > window.dates[0]!
  : Date.parse(time.start) < Date.parse(window.to) && (Date.parse(time.end) > Date.parse(window.from) || (time.start === time.end && Date.parse(time.start) >= Date.parse(window.from)));

/** A calendar that couldn't be read: nothing from it is shown, and the reason is. */
export function failedRead(source: CalendarSource, checked_at: string, problem: string): CalendarRead {
  return { source, checked_at, problem, events: [], looks: [], truncated: false };
}

/** A private link's calendar text, read for the days shown. */
export function readFromLink(text: string, source: CalendarSource, checked_at: string, window: { from: string; to: string; dates: string[] }, zone: string): CalendarRead {
  let parsed: ReturnType<typeof parseIcs>;
  // The text came from outside; whatever happens reading it, the result is a failed read, never a thrown error.
  try { parsed = parseIcs(text, { window, zone }); } catch { return failedRead(source, checked_at, "Ozzie couldn't read this calendar."); }
  if (!parsed.ok) return failedRead(source, checked_at, parsed.problem === "too-large" ? "The calendar has more events than Ozzie can read." : "The address didn't give back a calendar.");
  return { source, checked_at, problem: null, events: parsed.events, looks: parsed.looks, truncated: parsed.truncated };
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const validDate = (d: unknown): d is string => typeof d === "string" && ISO_DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const STATUSES = new Set(["confirmed", "tentative", "cancelled"]);
const shortId = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001F]/u.test(v);

/**
 * Apple Calendar's answer through Ozzie's helper (native code has already bounded it), checked again here: anything
 * malformed is skipped, every title and place becomes plain text, and only what touches the days shown is kept.
 */
export function readFromApple(raw: unknown, source: CalendarSource, checked_at: string, window: { from: string; to: string; dates: string[] }): CalendarRead {
  const answer = raw as { access?: unknown; events?: unknown; truncated?: unknown } | null;
  if (!answer || typeof answer !== "object") return failedRead(source, checked_at, "Apple Calendar's answer couldn't be read.");
  if (answer.access !== "full") {
    return failedRead(source, checked_at, typeof answer.access === "string" ? "macOS hasn't given Ozzie permission to read your calendars." : "Apple Calendar's answer couldn't be read.");
  }
  if (!Array.isArray(answer.events)) return failedRead(source, checked_at, "Apple Calendar's answer couldn't be read.");
  const events: CalendarEvent[] = [];
  for (const item of answer.events.slice(0, MAX_APPLE_EVENTS)) {
    const e = item as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || !shortId(e.calendar) || !shortId(e.id) || typeof e.title !== "string" || typeof e.status !== "string" || !STATUSES.has(e.status)) continue;
    let time: CalendarTime;
    let uncertain: string | null = null;
    if (e.all_day === true) {
      if (!validDate(e.start) || !validDate(e.end)) continue;
      time = { all_day: true, start_date: e.start, end_date: e.end > e.start ? e.end : new Date(Date.parse(`${e.start}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10) };
    } else if (e.all_day === false) {
      if (typeof e.start !== "string" || typeof e.end !== "string" || !ISO_INSTANT.test(e.start) || !ISO_INSTANT.test(e.end)) continue;
      const start = Date.parse(e.start), end = Date.parse(e.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (end < start) uncertain = "Its end is before its start in the calendar.";
      time = { all_day: false, start: new Date(start).toISOString(), end: new Date(Math.max(start, end)).toISOString() };
    } else continue;
    if (!touches(time, window)) continue;
    const title = plainText(e.title, MAX_TITLE) || "(No title)";
    const location = typeof e.location === "string" ? plainText(e.location, MAX_LOCATION) || null : null;
    const original = time.all_day ? time.start_date : time.start;
    events.push({ key: `${e.calendar}|${e.id}|${original}`, calendar: String(e.calendar), title, location, time, status: e.status as CalendarEvent["status"], free: e.free === true, uncertain });
  }
  events.sort(byStart);
  return { source, checked_at, problem: null, events, looks: [], truncated: answer.truncated === true };
}

const startMs = (t: CalendarTime) => t.all_day ? Date.parse(`${t.start_date}T00:00:00Z`) : Date.parse(t.start);
const byStart = (a: { time: CalendarTime; title: string }, b: { time: CalendarTime; title: string }) => startMs(a.time) - startMs(b.time) || a.title.localeCompare(b.title);
const fold = (title: string) => title.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();

const timeKey = (t: CalendarTime) => t.all_day ? `d|${t.start_date}|${t.end_date}` : `t|${t.start}|${t.end}`;
/**
 * Every event once: the same title, time, status and free-time marking in two different calendars is one event, shown
 * with both. Two such events in one calendar are two events (and may overlap), never merged into one.
 */
function merged(reads: readonly CalendarRead[]): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  const alike = new Map<string, { entry: CalendarEntry; from: Set<string> }[]>();
  const keys = new Set<string>();
  for (const r of reads) for (const e of r.events) {
    const from = `${r.source.kind}|${r.source.id}|${e.calendar ?? ""}`;
    const key = JSON.stringify([fold(e.title), timeKey(e.time), e.status, e.free, e.uncertain]);
    const same = (alike.get(key) ?? []).find(x => !x.from.has(from));
    if (same) {
      same.from.add(from);
      if (!same.entry.sources.some(s => s.kind === r.source.kind && s.id === r.source.id)) same.entry.sources.push(r.source);
      continue;
    }
    // Each entry keeps a key of its own, even when a calendar lists the same event twice.
    let own = e.key;
    for (let n = 2; keys.has(own); n++) own = `${e.key}#${n}`;
    keys.add(own);
    const entry: CalendarEntry = { ...e, key: own, sources: [r.source] };
    out.push(entry);
    alike.set(key, [...(alike.get(key) ?? []), { entry, from: new Set([from]) }]);
  }
  return out.sort(byStart);
}

/** FNV-1a, so an overlap's id stays the same for the same two events. Not a secret and not a person. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}

/**
 * Two timed events that overlap and haven't both ended, earliest overlap first: at most `max` (one more than
 * `MAX_OVERLAPS` by default, so a caller can tell some were left out). Events already over are left out before
 * anything is compared. The rest are walked in start order, each against the events still going when it starts (every
 * one of which it overlaps), so each comparison finds an overlap, the overlaps come out in the order they start, and
 * the work stops once `max` are found.
 */
export function calendarOverlaps(entries: readonly CalendarEntry[], now: string, zone: string, max = MAX_OVERLAPS + 1): CalendarOverlap[] {
  const nowMs = Date.parse(now);
  type Timed = CalendarEntry & { time: Extract<CalendarTime, { all_day: false }> };
  const timed = entries
    .filter((e): e is Timed => !e.time.all_day && e.status !== "cancelled" && !e.free && e.uncertain === null && Date.parse(e.time.end) > nowMs)
    .sort((a, b) => byStart(a, b) || a.key.localeCompare(b.key));
  const found: CalendarOverlap[] = [];
  let going: Timed[] = [];
  pairs: for (const b of timed) {
    const bStart = Date.parse(b.time.start);
    going = going.filter(a => Date.parse(a.time.end) > bStart);
    for (const a of going) {
      if (found.length >= max) break pairs;
      const start = bStart, end = Math.min(Date.parse(a.time.end), Date.parse(b.time.end));
      if (start >= end) continue;
      const tentative = [a, b].filter(e => e.status === "tentative");
      const keys = [a.key, b.key].sort();
      found.push({
        id: `calendar-overlap:${hash(keys.join("\n"))}`, tone: tentative.length ? "look" : "decision", date: localDate(start, zone),
        starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString(), first: a, second: b,
        reason: tentative.length ? `${tentative.map(e => `“${e.title}”`).join(" and ")} ${tentative.length === 1 ? "is" : "are"} marked tentative.` : null,
      });
    }
    going.push(b);
  }
  return found.sort((x, y) => Date.parse(x.starts_at) - Date.parse(y.starts_at) || x.first.title.localeCompare(y.first.title) || x.second.title.localeCompare(y.second.title));
}

/** What Today shows: each day's events (all-day first), the overlaps, what Ozzie couldn't work out, and every read. */
export function calendarView(reads: readonly CalendarRead[], now: string, zone: string): CalendarView {
  const window = calendarWindow(now, zone);
  const reported = reads.map(r => ({ source: r.source, checked_at: r.checked_at, problem: r.problem, truncated: r.truncated, count: r.events.length }));
  if (!window) return { dates: [], days: [], overlaps: [], overlaps_cut: false, looks: [], reads: reported };
  const entries = merged(reads);
  const days = window.dates.map(date => {
    const day = localDay(date, zone)!;
    const from = Date.parse(day.starts_at), to = Date.parse(day.ends_at);
    const on = entries.filter(e => e.time.all_day ? e.time.start_date <= date && e.time.end_date > date
      : Date.parse(e.time.start) < to && (Date.parse(e.time.end) > from || (e.time.start === e.time.end && Date.parse(e.time.start) >= from)));
    return { date, entries: [...on.filter(e => e.time.all_day), ...on.filter(e => !e.time.all_day)] };
  });
  const overlaps = calendarOverlaps(entries, now, zone);
  return {
    dates: window.dates, days, overlaps: overlaps.slice(0, MAX_OVERLAPS), overlaps_cut: overlaps.length > MAX_OVERLAPS,
    looks: reads.flatMap(r => r.looks.map(l => ({ ...l, source: r.source }))), reads: reported,
  };
}
