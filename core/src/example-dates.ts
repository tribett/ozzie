// The example church follows the calendar (owner decision 2026-11-25). Its data is fixed, fictional and written
// around one week: an email import on Thursday, a check on Friday morning, a service on Sunday, November 22, 2026
// (fictional-sunday.ts, fictional-operations.ts, fictional-attention.ts, church-systems/fictional.ts). Shown as
// written, that Sunday is in the past for everyone who opens the example after it.
//
// So the example is shown moved in time, and only in time: its Sunday is the coming Sunday (today, on a Sunday), and
// nothing in it is later than now. Two moves, each a whole number of days on the church's own clock, so every time
// of day stays what it was across daylight-saving changes:
// - what belongs to the Sunday (the plan, its times, schedules, blockouts, rooms, earlier Sundays) moves by whole
//   weeks, so every weekday stays the weekday it was;
// - what belongs to the check (the check's own times, the email import the day before, a follow-up already past
//   due) moves by the same weeks less a few days, so the check is never in the future: on a Wednesday the example
//   was checked this Wednesday (or Tuesday, early in the day), not "next Friday".
// The fixtures themselves are not changed: every test still reads the fixed November 22 data.
import { localDate, offsetAt } from "./church-time.js";

const DAY_MS = 86_400_000;
/** The example's Sunday as written, and its church's zone (fictional-sunday.ts). */
export const EXAMPLE_SUNDAY = "2026-11-22";
export const EXAMPLE_ZONE = "America/New_York";
/** The example's check as written (fictional-sunday.ts CHECKED): what moves with it is within two days before it. */
export const EXAMPLE_CHECK = "2026-11-20T15:00:00Z";
/** The last moment in the example as written: the end of its later check (fictional-sunday.ts nov22LaterCapture). */
export const EXAMPLE_LAST = "2026-11-20T17:15:10Z";
/** What belongs to the check: from two days before it to three hours after it. */
const CHECK_WINDOW = { from: Date.parse(EXAMPLE_CHECK) - 2 * DAY_MS, to: Date.parse(EXAMPLE_CHECK) + 3 * 3_600_000 };

/** How far the example is moved: `weeks` for what belongs to the Sunday, and `back` days fewer for what belongs to the check. */
export interface ExampleShift { readonly weeks: number; readonly back: number }
/** The example as written. */
export const NO_SHIFT: ExampleShift = Object.freeze({ weeks: 0, back: 0 });

const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const addDays = (date: string, days: number) => new Date(dateMs(date) + days * DAY_MS).toISOString().slice(0, 10);
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The wall-clock date and time of `at` in `zone`, as if it were UTC (milliseconds). */
const wallClock = (at: number, zone: string) => at + offsetAt(at, zone);
/** The instant at which `zone`'s wall clock reads `wall` (given as if UTC). A time a clock change skips lands just after it. */
function instantAt(wall: number, zone: string): number {
  let at = wall - offsetAt(wall, zone);
  at = wall - offsetAt(at, zone);
  return wall - offsetAt(at, zone);
}
/** `at` moved by whole days on `zone`'s own clock: the same time of day, whatever daylight saving does between. */
const moveDays = (at: number, days: number, zone: string) => instantAt(wallClock(at, zone) + days * DAY_MS, zone);

/**
 * How far to move the example for someone looking at it at `now`: its Sunday becomes the first Sunday on or after
 * today in the example church's zone, and the check steps back by days until the last moment in the example is not
 * after `now`. `back` is 0 from Friday afternoon through Sunday, and never more than 5.
 */
export function exampleShift(now: number | string): ExampleShift {
  const at = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(at)) return NO_SHIFT;
  const today = localDate(at, EXAMPLE_ZONE);
  const untilSunday = (7 - new Date(dateMs(today)).getUTCDay()) % 7;
  const weeks = Math.round((dateMs(addDays(today, untilSunday)) - dateMs(EXAMPLE_SUNDAY)) / (7 * DAY_MS));
  const last = Date.parse(EXAMPLE_LAST);
  let back = 0;
  while (back < 6 && moveDays(last, weeks * 7 - back, EXAMPLE_ZONE) > at) back += 1;
  return { weeks, back };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;
/** A full instant: date, time to the minute or finer, and `Z` or a numeric offset. */
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Planning Center's own words for a plan's date: "November 22, 2026". */
const PLAN_DATES = new RegExp(`^(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4})$`, "u");
/** A day named in running text: "Friday, November 27". */
const NAMED_DAY = new RegExp(`\\b(${WEEKDAYS.join("|")}), (${MONTHS.join("|")}) (\\d{1,2})\\b`, "gu");

function instant(text: string, m: RegExpExecArray, shift: ExampleShift, zone: string): string {
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return text;
  const days = shift.weeks * 7 - (at >= CHECK_WINDOW.from && at <= CHECK_WINDOW.to ? shift.back : 0);
  const moved = moveDays(at, days, zone);
  const [, , , seconds, fraction, suffix] = m;
  if (suffix === "Z") {
    const iso = new Date(moved).toISOString();
    return `${iso.slice(0, 16)}${seconds ? iso.slice(16, 19) : ""}${fraction ? iso.slice(19, 20 + fraction.length - 1) : ""}Z`;
  }
  // Written on the church's own clock with its offset: the same wall-clock time, with the zone's offset on the new day.
  const offset = offsetAt(moved, zone), wall = new Date(moved + offset).toISOString();
  const sign = offset < 0 ? "-" : "+", minutes = Math.abs(offset) / 60_000;
  return `${wall.slice(0, 16)}${seconds ? wall.slice(16, 19) : ""}${fraction ? wall.slice(19, 20 + fraction.length - 1) : ""}${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
function text(value: string, key: string | null, shift: ExampleShift, zone: string): string {
  const days = shift.weeks * 7;
  if (DATE_ONLY.test(value)) return Number.isFinite(dateMs(value)) ? addDays(value, days) : value;
  const at = INSTANT.exec(value);
  if (at) {
    // Planning Center's `sort_date` is the church's wall-clock time with a misleading `Z` (fictional-sunday.ts): its
    // date moves, its time of day never does.
    if (key === "sort_date") return `${addDays(at[1]!, days)}${value.slice(10)}`;
    return instant(value, at, shift, zone);
  }
  const plan = key === "dates" ? PLAN_DATES.exec(value) : null;
  if (plan) {
    const moved = new Date(Date.UTC(Number(plan[3]), MONTHS.indexOf(plan[1]!), Number(plan[2])) + days * DAY_MS);
    return `${MONTHS[moved.getUTCMonth()]} ${moved.getUTCDate()}, ${moved.getUTCFullYear()}`;
  }
  return value;
}
/**
 * `words` with each day named in it ("due Friday, November 27") moved by the shift's whole weeks, so it is still that
 * weekday. For the one message in the example that names a day (fictional-attention.ts): its text is built with the
 * moved day, never rewritten afterwards, so the places quoted from it stay where they are.
 */
export function shiftNamedDays(words: string, shift: ExampleShift): string {
  return words.replace(NAMED_DAY, (all: string, weekday: string, month: string, day: string) => {
    const base = Number(EXAMPLE_SUNDAY.slice(0, 4));
    const year = [base, base + 1, base - 1].find(y => new Date(Date.UTC(y, MONTHS.indexOf(month), Number(day))).getUTCDay() === WEEKDAYS.indexOf(weekday));
    if (year === undefined) return all;
    const moved = new Date(Date.UTC(year, MONTHS.indexOf(month), Number(day)) + shift.weeks * 7 * DAY_MS);
    return `${WEEKDAYS[moved.getUTCDay()]}, ${MONTHS[moved.getUTCMonth()]} ${moved.getUTCDate()}`;
  });
}

/**
 * The example data `value` (plain JSON: a capture, an import, an evaluated result) moved by `shift`, as a new value;
 * `zone` is the zone of the church it is about. Only dates and times change: ids, names, counts, statuses and every
 * other word are copied as they are. With no shift it is a plain copy.
 */
export function shiftExample<T>(value: T, shift: ExampleShift, zone: string = EXAMPLE_ZONE): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") return shift.weeks === 0 && shift.back === 0 ? v : text(v, key, shift, zone);
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = Object.create(Object.getPrototypeOf(v) === null ? null : Object.prototype) as Record<string, unknown>;
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, k);
      return out;
    }
    return v;
  };
  return walk(value, null) as T;
}
