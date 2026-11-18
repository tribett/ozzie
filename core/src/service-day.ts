// The words for the service Ozzie watches, on its real day (onboarding spec §5.1, decision 18). A church may meet on
// Saturday night or Wednesday, so nothing may call its service "Sunday" unless it is on a Sunday. Pure: no clock, no I/O.
// The day comes from the plan's service times in the church's time zone; before a check has read them, from the plan's
// `sort_date` (Planning Center's local wall-clock time with a misleading `Z`, church-time.ts).
import { isTimeZone, localDate, planDate } from "./church-time.js";

export interface ServiceDayPlan {
  /** Planning Center's local wall-clock date and time of the plan; never an instant. */
  sort_date: string | null;
  /** The plan's service-time starts, as instants, from a check's `plan_times` (rehearsals left out). */
  times?: readonly string[];
}
export type DayKind = "weekday" | "weekend" | "spread" | "unknown";
export interface DayWords {
  kind: DayKind;
  /** 0 Sunday … 6 Saturday for a service on one weekday; null otherwise. */
  weekday: number | null;
  /** Mid-sentence: "Sunday", "Wednesday", "this weekend's services", "these services", "your service". */
  day: string;
  /** At the start of a sentence: "Sunday", "This weekend's services", "These services", "Your service". */
  Day: string;
  /** The sidebar page and its title: "Sunday", "Saturday", "This weekend", "These services", "Your service". */
  page: string;
  /** "Is Sunday covered?", "Are this weekend's services covered?". */
  question: string;
  /** "Wednesday, November 25"; two dates for a weekend or a spread; null when nothing is known. */
  date: string | null;
  /** After "for" or "needed": "this Sunday", "this Wednesday", "this weekend", "these services", "your service". */
  thisOne: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** "Wednesday, November 25" for a `YYYY-MM-DD` calendar date. */
export function longDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function oneDay(date: string): DayWords {
  const weekday = weekdayOf(date);
  const name = WEEKDAYS[weekday]!;
  return { kind: "weekday", weekday, day: name, Day: name, page: name, question: `Is ${name} covered?`, date: longDate(date), thisOne: `this ${name}` };
}

/** Nothing chosen yet: no day to name. */
export const UNKNOWN_WORDS: DayWords = Object.freeze({
  kind: "unknown", weekday: null, day: "your service", Day: "Your service", page: "Your service", question: "Is your service covered?", date: null,
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
    return { kind: "weekend", weekday: null, day: "this weekend's services", Day: "This weekend's services", page: "This weekend",
      question: "Are this weekend's services covered?", date: `${longDate(first)} and ${longDate(last)}`, thisOne: "this weekend" };
  }
  return { kind: "spread", weekday: null, day: "these services", Day: capital("these services"), page: "These services", question: "Are these services covered?",
    date: `${longDate(first)} to ${longDate(last)}`, thisOne: "these services" };
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
