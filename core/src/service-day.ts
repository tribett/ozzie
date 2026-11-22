// The words for the service Ozzie watches, on its real day (onboarding spec §5.1, decision 18). A church may meet on
// Saturday night or Wednesday, so nothing may call its service "Sunday" unless it is on a Sunday. Pure: no clock, no I/O.
// The day comes from the plan's service times in the church's time zone; before a check has read them, from the plan's
// `sort_date` (Planning Center's local wall-clock time with a misleading `Z`, church-time.ts).
import { isTimeZone, localDate, offsetAt, planDate } from "./church-time.js";

export interface ServiceDayPlan {
  /** Planning Center's local wall-clock date and time of the plan; never an instant. */
  sort_date: string | null;
  /** The plan's service-time starts, as instants, from a check's `plan_times` (rehearsals left out). */
  times?: readonly string[];
}
export type DayKind = "weekday" | "weekend" | "spread" | "unknown";
/**
 * The sidebar page for the services Ozzie watches, and the question it asks, whatever day they are on (owner decision
 * 2026-11-19: "instead of Sunday - we should refer to it as Services"). The day stays where it says when.
 */
export const SERVICES_PAGE = "Services";
export const SERVICES_QUESTION = "Are your services covered?";
export interface DayWords {
  kind: DayKind;
  /** 0 Sunday … 6 Saturday for a service on one weekday; null otherwise. */
  weekday: number | null;
  /** Mid-sentence: "Sunday", "Wednesday", "this weekend's services", "these services", "your service". */
  day: string;
  /** At the start of a sentence: "Sunday", "This weekend's services", "These services", "Your service". */
  Day: string;
  /** The sidebar page and its title: always "Services" (SERVICES_PAGE). */
  page: string;
  /** The page's question: always "Are your services covered?" (SERVICES_QUESTION). */
  question: string;
  /** "Wednesday, November 25"; two dates for a weekend or a spread; null when nothing is known. */
  date: string | null;
  /** After "for" or "needed": "this Sunday", "this Wednesday", "this weekend", "these services", "your service". */
  thisOne: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const WEEKDAY_WORDS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_WORDS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/**
 * Whether a plan's or event's own title only says its date again ("Sunday Nov 22", "11/22", "November 22, 2026",
 * "Sunday"), so a page that already names the date leaves it out; a title that adds anything ("Youth Night", "Christmas
 * Eve", "Sunday Nov 22 – Communion") is shown. `date`: the plan's own date, YYYY-MM-DD. The weekday, the month and the
 * year are each said at most once, and any numbers say the day itself: "Sunday 11" in November may be the 11 o'clock
 * service, so it is shown (review of round 3, L4).
 */
export function titleOnlyDate(title: string, date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = WEEKDAY_WORDS[new Date(`${date}T00:00:00Z`).getUTCDay()]!, monthName = MONTH_WORDS[month - 1]!;
  const words = title.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  if (!words.length) return false;
  const numbers: number[] = [];
  let weekdays = 0, months = 0;
  for (const w of words) {
    const n = /^(\d{1,4})(?:st|nd|rd|th)?$/u.exec(w);
    if (n) numbers.push(Number(n[1]));
    else if ((w.length >= 3 && weekday.startsWith(w)) || (w === "tues" && weekday === "tuesday") || ((w === "thur" || w === "thurs") && weekday === "thursday")) weekdays++;
    else if ((w.length >= 3 && monthName.startsWith(w)) || (w === "sept" && month === 9)) months++;
    else return false;
  }
  if (weekdays > 1) return false;
  if (!numbers.length) return months <= 1;
  // The day first (it may equal the month or the year's last two digits), then at most one month and one year.
  const left = [...numbers];
  const take = (ok: (v: number) => boolean) => { const i = left.findIndex(ok); if (i < 0) return false; left.splice(i, 1); return true; };
  if (!take(v => v === day)) return false;
  if (left.length && take(v => v === month)) months++;
  if (months > 1) return false;
  if (left.length && !take(v => v === year || v === year % 100)) return false;
  return left.length === 0;
}

/** "Wednesday, November 25" for a `YYYY-MM-DD` calendar date. */
export function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function oneDay(date: string): DayWords {
  const weekday = weekdayOf(date);
  const name = WEEKDAYS[weekday]!;
  return { kind: "weekday", weekday, day: name, Day: name, page: SERVICES_PAGE, question: SERVICES_QUESTION, date: longDate(date), thisOne: `this ${name}` };
}

/** Nothing chosen yet: no day to name. */
export const UNKNOWN_WORDS: DayWords = Object.freeze({
  kind: "unknown", weekday: null, day: "your service", Day: "Your service", page: SERVICES_PAGE, question: SERVICES_QUESTION, date: null,
  thisOne: "your service",
});
/** A Sunday with no date: the fictional example church and the words pages show when nothing says otherwise. */
export const SUNDAY_WORDS: DayWords = Object.freeze({ ...oneDay("2026-11-22"), date: null });

/** The local dates of the plan's service times in the church's zone, earliest first; empty when they can't be placed. */
function serviceDates(times: readonly string[] | undefined, zone: string | null): string[] {
  if (!times?.length || !zone || !isTimeZone(zone)) return [];
  const dates = times.filter(t => Number.isFinite(Date.parse(t))).map(t => localDate(t, zone));
  return [...new Set(dates)].sort();
}

/**
 * The words for one plan: its service times' local day in the church's zone when a check has read them, else the
 * weekday of its `sort_date`; "your service" when there's no plan or no date.
 */
export function dayWords(plan: ServiceDayPlan | null, zone: string | null): DayWords {
  if (!plan) return UNKNOWN_WORDS;
  const dates = serviceDates(plan.times, zone);
  if (dates.length === 0) {
    const date = planDate(plan.sort_date);
    return date ? oneDay(date) : UNKNOWN_WORDS;
  }
  const first = dates[0]!, last = dates[dates.length - 1]!;
  if (dates.length === 1) return oneDay(first);
  if (dates.length === 2 && weekdayOf(first) === 6 && nextDate(first) === last) {
    return { kind: "weekend", weekday: null, day: "this weekend's services", Day: "This weekend's services", page: SERVICES_PAGE,
      question: SERVICES_QUESTION, date: `${longDate(first)} and ${longDate(last)}`, thisOne: "this weekend" };
  }
  return { kind: "spread", weekday: null, day: "these services", Day: capital("these services"), page: SERVICES_PAGE, question: SERVICES_QUESTION,
    date: `${longDate(first)} to ${longDate(last)}`, thisOne: "these services" };
}

/**
 * Which clock a time from the church's system is said on: the church's zone when this Mac knows it, else this Mac's (no
 * option). Every time that says when something happens at church (a service, a role, a booking, a group meeting) uses
 * it, as a service's heading does; a time that says when Ozzie or the person did something stays on this Mac's clock.
 */
export const onChurchClock = (zone: string | null | undefined): { timeZone?: string } => zone && isTimeZone(zone) ? { timeZone: zone } : {};
/** "9:30 AM" on the church's clock, or this Mac's when the church's zone isn't known. */
export function clockAt(iso: string, zone: string | null): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...onChurchClock(zone) });
}
/**
 * Whether this Mac's clock (`mac`, its zone) reads any of `times` differently from the church's: a heading that names
 * them then says whose clock they are on. False when the church's zone isn't known (they are then on this Mac's clock).
 */
export function otherClock(times: readonly string[], zone: string | null | undefined, mac: string): boolean {
  if (!zone || !isTimeZone(zone) || !isTimeZone(mac)) return false;
  return times.some(t => { const at = Date.parse(t); return Number.isFinite(at) && offsetAt(at, zone) !== offsetAt(at, mac); });
}
const andList = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
/** The distinct service-time starts, earliest first (as instants, so the same time written two ways counts once). */
export function sortedTimes(times: readonly string[]): string[] {
  const seen = new Map<number, string>();
  for (const t of times) { const ms = Date.parse(t); if (Number.isFinite(ms) && !seen.has(ms)) seen.set(ms, t); }
  return [...seen.entries()].sort(([a], [b]) => a - b).map(([, t]) => t);
}
/**
 * One service time as a heading names it: "9:30 AM", or "Saturday 5:00 PM" when the plan's times fall on more than one
 * day in the church's zone, so a weekend's two days are told apart.
 */
export function timeLabel(iso: string, times: readonly string[], zone: string | null): string {
  const days = new Set(times.map(t => zone && isTimeZone(zone) ? localDate(t, zone) : new Date(t).toDateString()));
  if (days.size <= 1) return clockAt(iso, zone);
  const weekday = new Date(iso).toLocaleDateString("en-US", { weekday: "long", ...onChurchClock(zone) });
  return `${weekday} ${clockAt(iso, zone)}`;
}
/** A plan's service times in one phrase: "9:30 AM and 11:00 AM", "Saturday 5:00 PM and Sunday 9:30 AM"; null when none. */
export function timesText(times: readonly string[], zone: string | null): string | null {
  const sorted = sortedTimes(times);
  return sorted.length ? andList(sorted.map(t => timeLabel(t, sorted, zone))) : null;
}

interface ReadLike { collection: string; outcome: string; body?: unknown }
/** The service times of a check's `plan_times` reads, as instants; rehearsals and anything unreadable are left out. */
export function planTimes(reads: readonly ReadLike[]): string[] {
  const out: string[] = [];
  for (const read of reads) {
    if (read.collection !== "plan_times" || read.outcome !== "ok") continue;
    const data = (read.body as { data?: unknown } | null | undefined)?.data;
    for (const row of Array.isArray(data) ? data : []) {
      const a = (row as { attributes?: Record<string, unknown> } | null)?.attributes;
      const at = a?.starts_at;
      if (a?.time_type === "service" && typeof at === "string" && Number.isFinite(Date.parse(at))) out.push(at);
    }
  }
  return out;
}
