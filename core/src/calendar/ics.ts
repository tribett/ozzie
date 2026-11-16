// Private calendar links: the iCalendar text (RFC 5545) a Google, Outlook or iCloud calendar publishes at its secret
// address, read on this Mac only. Native code fetches it (core/native-auth calendar_link.rs: GET, https only, public
// hosts only, bounded); this turns it into the events that touch a window of days. Pure: no I/O, no model; the only
// clock it reads is a time limit on its own work.
//
// Calendar text is outside text and often holds real people's names, so it stays on this Mac: nothing here is ever
// part of a model request or of the copy for other AI apps (core/test/calendar/stays-on-this-mac.test.ts proves no
// module that builds either one imports this). It is data, never instructions, and the page shows it as plain text.
//
// Only what Today needs is read: each event's title, place, time, status (confirmed, tentative, cancelled) and
// whether it blocks time. Notes, attendees, organizers, links and alarms are skipped without being kept.
//
// Repeating events are worked out for daily and weekly rules (INTERVAL, COUNT, UNTIL, plain BYDAY, WKST), with
// excluded dates and single changed or cancelled occurrences (RECURRENCE-ID), at the series' own wall-clock time so
// daylight saving doesn't move them. Anything else (monthly, yearly, extra dates, a change "from this one on") is
// returned as worth a look with the reason, never guessed. A time zone Ozzie doesn't know is shown at that wall-clock
// time on this Mac and labeled uncertain. Nothing is dropped silently: an event without a start, text that is out of
// order or unfinished, and characters that couldn't be read are each said as worth a look.
//
// A calendar file is outside input, so the work is bounded: every lookup keyed by its text is prototype-free; a time
// zone name is at most 64 characters and looked up once per read; times are worked out only for events whose dates
// are near the window (a calendar's years of history cost a string comparison each); and one budget covers every
// step toward the window and every time-zone conversion, with a time limit besides. A file that needs more is
// refused as too large, never read partly while looking complete.
import { isTimeZone, localDate, offsetAt } from "../church-time.js";

/** A timed event's instants, or an all-day event's local dates (end exclusive). */
export type CalendarTime =
  | { all_day: false; start: string; end: string }
  | { all_day: true; start_date: string; end_date: string };

export interface IcsEvent {
  /** The series and occurrence: its UID and the occurrence's original start. Stable across reads. */
  key: string;
  title: string;
  location: string | null;
  time: CalendarTime;
  status: "confirmed" | "tentative" | "cancelled";
  /** The calendar says it doesn't block time (TRANSP:TRANSPARENT, or "free"). */
  free: boolean;
  /** Why Ozzie isn't sure of its time, in plain words; null when it is. */
  uncertain: string | null;
}
/** Something on the calendar Ozzie couldn't work out, labeled worth a look. `title` is null for a note about the calendar. */
export interface CalendarLook { title: string | null; reason: string }
/** Local midnights in `zone`: the first day's start and the start of the day after the last. */
export interface IcsWindow { from: string; to: string }
export type IcsResult =
  | { ok: true; events: IcsEvent[]; looks: CalendarLook[]; skipped: number; truncated: boolean }
  | { ok: false; problem: "not-a-calendar" | "too-large" };
export interface IcsOptions {
  window: IcsWindow;
  zone: string;
  /** Milliseconds this read may take before it is refused as too large (default `MAX_PARSE_MS`). */
  timeLimitMs?: number;
  /** The clock the time limit is measured on (tests); `performance.now` by default. */
  clock?: () => number;
}

export const MAX_TITLE = 200;
export const MAX_LOCATION = 200;
/** Events read from one calendar's text; a calendar with more isn't read at all. */
const MAX_COMPONENTS = 50_000;
/** Occurrences kept inside the window; past this the read says it was cut short. */
export const MAX_IN_WINDOW = 500;
/** Steps toward the window one read may take across all its series, time-zone conversions included. */
const MAX_STEPS_PER_READ = 400_000;
/** What one time-zone conversion costs from that budget (it formats dates several times). */
const CONVERSION_STEPS = 8;
/** A read taking longer than this is refused as too large, whatever its steps. */
export const MAX_PARSE_MS = 3000;
/** A series with more changed occurrences (RECURRENCE-ID) than this, or more skipped dates, is worth a look. */
const MAX_CHANGES_PER_SERIES = 500;
const MAX_EXDATES = 1000;
/** A COUNT series with BYDAY must be counted from its start; one starting longer ago than this is worth a look. */
const COUNT_LOOKBACK_DAYS = 400;
/** An event longer than this is worth a look rather than shown. */
const MAX_LENGTH_DAYS = 366;
/** Things worth a look kept from one calendar; past this the read says it was cut short. */
const MAX_LOOKS = 25;
/** Longest time zone name looked up; longer ones are unknown. */
const MAX_TZID = 64;
/** Different time zone names looked up in one read; a calendar names a handful, and any past this are unknown. */
const MAX_ZONES = 64;
const DAY_MS = 86_400_000;

// Outlook and Exchange publish Windows zone names. The common ones, and every zone Ozzie's churches are likely in.
// A Map, so a name like "constructor" is just an unknown name.
const WINDOWS_ZONES: ReadonlyMap<string, string> = new Map(Object.entries({
  "Eastern Standard Time": "America/New_York", "US Eastern Standard Time": "America/Indianapolis",
  "Central Standard Time": "America/Chicago", "Mountain Standard Time": "America/Denver", "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles", "Alaskan Standard Time": "America/Anchorage", "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax", "Newfoundland Standard Time": "America/St_Johns", "Canada Central Standard Time": "America/Regina",
  "Central Standard Time (Mexico)": "America/Mexico_City", "Mountain Standard Time (Mexico)": "America/Mazatlan", "Pacific Standard Time (Mexico)": "America/Tijuana",
  "SA Pacific Standard Time": "America/Bogota", "SA Western Standard Time": "America/La_Paz", "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires", "Pacific SA Standard Time": "America/Santiago",
  "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik", "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris", "Central Europe Standard Time": "Europe/Budapest", "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau", "FLE Standard Time": "Europe/Kiev", "GTB Standard Time": "Europe/Bucharest",
  "South Africa Standard Time": "Africa/Johannesburg", "W. Central Africa Standard Time": "Africa/Lagos", "E. Africa Standard Time": "Africa/Nairobi",
  "Israel Standard Time": "Asia/Jerusalem", "Arabian Standard Time": "Asia/Dubai", "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai", "Singapore Standard Time": "Asia/Singapore", "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo", "Korea Standard Time": "Asia/Seoul", "SE Asia Standard Time": "Asia/Bangkok",
  "AUS Eastern Standard Time": "Australia/Sydney", "E. Australia Standard Time": "Australia/Brisbane", "Cen. Australia Standard Time": "Australia/Adelaide",
  "AUS Central Standard Time": "Australia/Darwin", "W. Australia Standard Time": "Australia/Perth", "New Zealand Standard Time": "Pacific/Auckland",
  "UTC": "UTC", "Coordinated Universal Time": "UTC",
}));

// ---- Text -------------------------------------------------------------------------------------------------

/** Parameters by upper-cased name, on an object with no prototype (a parameter named "constructor" is just a name). */
type Params = Readonly<Record<string, string | undefined>>;
interface Prop { name: string; params: Params; value: string }

/** RFC 5545 §3.1: a line beginning with a space or tab continues the one before it. */
function unfold(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.replace(/^\uFEFF/u, "").split(/\r\n|\n|\r/u)) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length) lines[lines.length - 1] += line.slice(1);
    else if (line.length) lines.push(line);
  }
  return lines;
}
/** Splits on `sep` outside double quotes. */
function split(text: string, sep: string): string[] {
  const out: string[] = [];
  let quoted = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\"") quoted = !quoted;
    else if (text[i] === sep && !quoted) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out;
}
function property(line: string): Prop | null {
  let quoted = false, colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\"") quoted = !quoted;
    else if (line[i] === ":" && !quoted) { colon = i; break; }
  }
  if (colon <= 0) return null;
  const [name = "", ...rest] = split(line.slice(0, colon), ";");
  // Without a prototype, and made from pairs rather than by keys set as they are read (review U: no key made at run time).
  const pairs = rest.flatMap(p => {
    const eq = p.indexOf("=");
    return eq > 0 ? [[p.slice(0, eq).trim().toUpperCase(), p.slice(eq + 1).trim().replace(/^"(.*)"$/su, "$1")] as const] : [];
  });
  const params = Object.setPrototypeOf(Object.fromEntries(pairs), null) as Record<string, string>;
  return { name: name.trim().toUpperCase(), params, value: line.slice(colon + 1) };
}
const unescapeText = (v: string) => v.replace(/\\([\\;,nN])/gu, (_, c: string) => c === "n" || c === "N" ? "\n" : c);
/**
 * Outside text as one plain line, at most `max` characters. Format characters are taken out (direction overrides and
 * isolates, zero-width spaces, the soft hyphen, tag characters, the Mongolian vowel separator, the byte-order mark):
 * they can make text read as something else. The two joiners stay where they join letters, marks or emoji, as in an
 * emoji family or a Persian word; anywhere else they go too. Controls and line breaks become spaces, and a run of
 * combining marks is kept to three.
 */
export function plainText(raw: string, max: number): string {
  const text = raw.slice(0, max * 8).replace(JOINER_OR_FORMAT, (_, joiner: string | undefined) => joiner ?? "").replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu, " ")
    .replace(/(\p{M}{3})\p{M}+/gu, "$1").replace(/\s+/gu, " ").trim();
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}
const GARBLED = "\uFFFD";
/** A zero-width joiner or non-joiner between letters, marks or emoji (kept: group 1), or any other format character. */
const JOINER_OR_FORMAT = /((?<=[\p{L}\p{M}\p{Extended_Pictographic}])[\u200C\u200D](?=[\p{L}\p{M}\p{Extended_Pictographic}]))|\p{Cf}/gu;

// ---- Dates and times ----------------------------------------------------------------------------------------

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const MIN_MS = Date.parse("0001-01-01T00:00:00Z"), LAST_MS = Date.parse("9999-12-31T00:00:00Z");
/** `n` days after `date`, kept within the years 0001 to 9999 so dates always compare in order as text. */
const addDays = (date: string, n: number) => isoDate(Math.min(LAST_MS, Math.max(MIN_MS, dateMs(date) + n * DAY_MS)));
const daysBetween = (a: string, b: string) => Math.round((dateMs(b) - dateMs(a)) / DAY_MS);
/** 0 Sunday … 6 Saturday. */
const weekday = (date: string) => new Date(dateMs(date)).getUTCDay();
const validDate = (y: number, m: number, d: number) => {
  const ms = Date.UTC(y, m - 1, d);
  return Number.isFinite(ms) && isoDate(ms) === `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
/** The date a value starts with (`YYYYMMDD…`), read as text only: no time zone work. */
const rawDate = (value: string | undefined): string | null => {
  const m = /^\s*(\d{4})(\d{2})(\d{2})/u.exec(value ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

/** One read's limits and caches. */
interface Ctx {
  macZone: string;
  firstDate: string;
  endDate: string;
  zones: Map<string, string | null>;
  steps: number;
  deadline: number;
  clock: () => number;
  ticks: number;
}
/** Thrown when a read runs out of steps or time; the read is then refused as too large. */
class TooLarge { readonly tooLarge = true; }
function spend(ctx: Ctx, steps = 1) {
  ctx.steps -= steps;
  if (ctx.steps < 0) throw new TooLarge();
  if (++ctx.ticks % 256 === 0 && ctx.clock() > ctx.deadline) throw new TooLarge();
}

/** A wall-clock time: a date and the seconds into it. */
interface Wall { date: string; seconds: number }
/**
 * The instant a wall-clock time names in `zone`. A time skipped by daylight saving is read with the offset before
 * the gap (RFC 5545 §3.3.5: 2:30 AM on the spring-forward day is 3:30 AM); a repeated one is its first occurrence.
 */
function wallToInstant(wall: Wall, zone: string, ctx: Ctx): number {
  const naive = dateMs(wall.date) + wall.seconds * 1000;
  if (zone === "UTC") return naive;
  spend(ctx, CONVERSION_STEPS);
  const before = offsetAt(naive - DAY_MS / 2, zone), after = offsetAt(naive + DAY_MS / 2, zone);
  const fits = [naive - before, naive - after].filter(t => offsetAt(t, zone) === naive - t);
  return fits.length ? Math.min(...fits) : naive - before;
}

/** One DTSTART, DTEND, EXDATE or RECURRENCE-ID value: a date, or a time with the zone its wall clock is in. */
type When =
  | { kind: "date"; date: string }
  | { kind: "time"; at: number; wall: Wall; zone: string; uncertain: string | null };

/** Whether this Mac's time-zone data knows a zone name (a plain answer, not a type guard on `string`). */
const knownZone = (zone: string): boolean => isTimeZone(zone);
/** The IANA zone a TZID names (itself, an Outlook name, or a zone at the end of a longer name), once per read. */
function zoneFor(tzid: string, ctx: Ctx): string | null {
  const name = tzid.trim();
  if (name.length > MAX_TZID) return null;
  const known = ctx.zones.get(name);
  if (known !== undefined) return known;
  if (ctx.zones.size >= MAX_ZONES) return null;
  spend(ctx, CONVERSION_STEPS);
  let zone: string | null = knownZone(name) ? name : WINDOWS_ZONES.get(name) ?? null;
  for (let i = name.indexOf("/"); zone === null && i >= 0 && i < name.length - 1; i = name.indexOf("/", i + 1)) {
    const tail = name.slice(i + 1);
    if (tail.includes("/") && knownZone(tail)) zone = tail;
  }
  ctx.zones.set(name, zone);
  return zone;
}
function parseWhen(value: string, params: Params, ctx: Ctx): When | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/u.exec(v);
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])];
    return validDate(y, m, d) ? { kind: "date", date: `${date[1]}-${date[2]}-${date[3]}` } : null;
  }
  if (params.VALUE === "DATE") return null;
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/u.exec(v);
  if (!time) return null;
  const [y, m, d, h, mi, s] = time.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (!validDate(y, m, d) || h > 23 || mi > 59 || s > 60) return null;
  const wall: Wall = { date: `${time[1]}-${time[2]}-${time[3]}`, seconds: (h * 60 + mi) * 60 + Math.min(s, 59) };
  if (time[7] === "Z") return { kind: "time", at: dateMs(wall.date) + wall.seconds * 1000, wall, zone: "UTC", uncertain: null };
  const tzid = params.TZID;
  if (tzid === undefined) return { kind: "time", at: wallToInstant(wall, ctx.macZone, ctx), wall, zone: ctx.macZone, uncertain: null };
  const zone = zoneFor(tzid, ctx);
  if (zone) return { kind: "time", at: wallToInstant(wall, zone, ctx), wall, zone, uncertain: null };
  return { kind: "time", at: wallToInstant(wall, ctx.macZone, ctx), wall, zone: ctx.macZone,
    uncertain: `This calendar uses a time zone Ozzie doesn't know (“${plainText(tzid, 40)}”), so the time may be off.` };
}
/** RFC 5545 §3.3.6 durations: P1D, PT1H30M, P1W. Null when it isn't one. */
function parseDuration(value: string): { days: number; ms: number } | null {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u.exec(value.trim());
  if (!m || value.trim() === "P" || value.trim().endsWith("T")) return null;
  const [w, d, h, mi, s] = m.slice(1, 6).map(x => Number(x ?? 0)) as [number, number, number, number, number];
  return { days: w * 7 + d, ms: ((h * 60 + mi) * 60 + s) * 1000 };
}

// ---- Events --------------------------------------------------------------------------------------------------

interface Raw { value: string; params: Params }
interface Component {
  /** Its place in the file, for one without a UID. */
  index: number;
  uid: string; summary: string; location: string | null;
  startRaw: Raw | null; endRaw: Raw | null; recurrenceRaw: Raw | null;
  duration: { days: number; ms: number } | null;
  status: IcsEvent["status"]; free: boolean;
  rrule: string | null; rdate: boolean; rdates: string[]; exdates: Raw[]; tooManyExdates: boolean; range: string | null;
  /** Worked out when first needed (undefined until then). */
  start?: When | null; end?: When | null; recurrence?: When | null;
}
const STATUS: ReadonlyMap<string, IcsEvent["status"]> = new Map([["CONFIRMED", "confirmed"], ["TENTATIVE", "tentative"], ["CANCELLED", "cancelled"]]);

function component(props: readonly Prop[], index: number): Component {
  const c: Component = { index, uid: "", summary: "", location: null, startRaw: null, endRaw: null, recurrenceRaw: null, duration: null,
    status: "confirmed", free: false, rrule: null, rdate: false, rdates: [], exdates: [], tooManyExdates: false, range: null };
  // Only these are read; everything else (DESCRIPTION, ATTENDEE, ORGANIZER, URL, ATTACH, …) is skipped unread.
  // Times are kept as written and worked out only for events near the window.
  for (const p of props) {
    switch (p.name) {
      case "UID": c.uid = p.value.trim().slice(0, 512); break;
      case "SUMMARY": c.summary = plainText(unescapeText(p.value.slice(0, MAX_TITLE * 8)), MAX_TITLE); break;
      case "LOCATION": c.location = plainText(unescapeText(p.value.slice(0, MAX_LOCATION * 8)), MAX_LOCATION) || null; break;
      case "DTSTART": c.startRaw = { value: p.value.slice(0, 64), params: p.params }; break;
      case "DTEND": c.endRaw = { value: p.value.slice(0, 64), params: p.params }; break;
      case "DURATION": c.duration = parseDuration(p.value.slice(0, 64)); break;
      case "STATUS": c.status = STATUS.get(p.value.trim().toUpperCase()) ?? "confirmed"; break;
      case "TRANSP": c.free = p.value.trim().toUpperCase() === "TRANSPARENT"; break;
      case "RRULE": c.rrule = p.value.trim().slice(0, 1024); break;
      case "RDATE":
        c.rdate = true;
        // Their dates as text, only to tell whether one falls near the window.
        for (const v of p.value.slice(0, 64 * 64).split(",")) { const d = rawDate(v); if (d && c.rdates.length < 64) c.rdates.push(d); }
        break;
      case "EXDATE":
        for (const v of p.value.slice(0, (MAX_EXDATES + 1) * 64).split(",")) {
          if (c.exdates.length >= MAX_EXDATES) { c.tooManyExdates = true; break; }
          c.exdates.push({ value: v.slice(0, 64), params: p.params });
        }
        break;
      case "RECURRENCE-ID": c.recurrenceRaw = { value: p.value.slice(0, 64), params: p.params }; c.range = p.params.RANGE?.toUpperCase() ?? null; break;
    }
  }
  return c;
}
const startOf = (c: Component, ctx: Ctx) => c.start !== undefined ? c.start : (c.start = c.startRaw ? parseWhen(c.startRaw.value, c.startRaw.params, ctx) : null);
const endOf = (c: Component, ctx: Ctx) => c.end !== undefined ? c.end : (c.end = c.endRaw ? parseWhen(c.endRaw.value, c.endRaw.params, ctx) : null);
const recurrenceOf = (c: Component, ctx: Ctx) => c.recurrence !== undefined ? c.recurrence
  : (c.recurrence = c.recurrenceRaw ? parseWhen(c.recurrenceRaw.value, c.recurrenceRaw.params, ctx) : null);
/**
 * Whether an event written from `start` (its DTSTART date) to its end could touch the window, by its dates as text:
 * a day's margin either side covers any time zone. Everything else is skipped without working out its times.
 */
function nearWindow(c: Component, ctx: Ctx): boolean {
  const start = rawDate(c.startRaw?.value);
  if (!start) return true;
  const span = c.duration ? c.duration.days + Math.ceil(c.duration.ms / DAY_MS) : 1;
  const end = rawDate(c.endRaw?.value) ?? addDays(start, Number.isFinite(span) ? Math.min(span, 1e6) : 1e6);
  const last = end > start ? end : start;
  return start <= addDays(ctx.endDate, 1) && last >= addDays(ctx.firstDate, -2);
}

/** A repeating rule Ozzie works out, or why it can't. */
type Rule =
  | { ok: true; freq: "DAILY" | "WEEKLY"; interval: number; count: number | null; until: When | null; byday: number[] | null; wkst: number }
  | { ok: false; reason: string };
const DAYS: ReadonlyMap<string, number> = new Map([["SU", 0], ["MO", 1], ["TU", 2], ["WE", 3], ["TH", 4], ["FR", 5], ["SA", 6]]);
const RULE_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"]);
const CANT = (how: string) => `It ${how}, which Ozzie can't work out yet, so it may fall in these days.`;
const ODD = "It repeats in a way Ozzie can't work out yet, so it may fall in these days.";
const LONG_AGO = CANT("repeats a set number of times from long ago");
const TOO_LONG = "It lasts longer than a year in the calendar, which Ozzie can't show.";
const EXTRA_DATES = "It has extra dates Ozzie can't work out yet, so it may fall in these days.";
const SHARED_UID = "This calendar lists more than one repeating event with the same identifier, so a changed date may not show on the right one.";
function parseRule(value: string, ctx: Ctx): Rule {
  const parts = new Map<string, string>();
  for (const p of value.split(";")) {
    const eq = p.indexOf("=");
    if (eq > 0) parts.set(p.slice(0, eq).trim().toUpperCase(), p.slice(eq + 1).trim().toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq === "MONTHLY") return { ok: false, reason: CANT("repeats monthly") };
  if (freq === "YEARLY") return { ok: false, reason: CANT("repeats yearly") };
  if (freq === "HOURLY" || freq === "MINUTELY" || freq === "SECONDLY") return { ok: false, reason: CANT("repeats more than once a day") };
  if (freq !== "DAILY" && freq !== "WEEKLY") return { ok: false, reason: ODD };
  for (const key of parts.keys()) if (!RULE_PARTS.has(key)) return { ok: false, reason: ODD };
  const interval = parts.has("INTERVAL") ? Number(parts.get("INTERVAL")) : 1;
  const count = parts.has("COUNT") ? Number(parts.get("COUNT")) : null;
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000 || (count !== null && (!Number.isSafeInteger(count) || count < 1))) return { ok: false, reason: ODD };
  const untilText = parts.get("UNTIL");
  const until = untilText === undefined ? null : parseWhen(untilText.slice(0, 64), Object.create(null) as Params, ctx);
  if ((untilText !== undefined && !until) || (until && count !== null)) return { ok: false, reason: ODD };
  let byday: number[] | null = null;
  if (parts.has("BYDAY")) {
    byday = [];
    for (const d of parts.get("BYDAY")!.split(",")) {
      const day = DAYS.get(d.trim());
      if (day === undefined) return { ok: false, reason: ODD };
      byday.push(day);
    }
  }
  const wkst = DAYS.get(parts.get("WKST") ?? "MO");
  if (wkst === undefined) return { ok: false, reason: ODD };
  return { ok: true, freq, interval, count, until, byday: byday ? [...new Set(byday)] : null, wkst };
}

/**
 * The dates a series falls on that could touch the window, in order (and within UNTIL or COUNT). A series that falls
 * on one day per period (no BYDAY) skips straight to the window arithmetically, COUNT included. One with BYDAY skips
 * by whole periods when it has no COUNT; with a COUNT it must be counted from its start, so it is refused ("far") when
 * that start is more than `COUNT_LOOKBACK_DAYS` before the window. Every candidate date costs one step from the read's
 * budget. `margin`: days before the window an occurrence can start and still reach it.
 */
function seriesDates(start: string, rule: Extract<Rule, { ok: true }>, untilOk: (date: string) => boolean, firstDate: string, lastDate: string,
  margin: number, ctx: Ctx): string[] | "far" {
  const out: string[] = [];
  const earliest = addDays(firstDate, -margin);
  const gap = Math.max(0, daysBetween(start, firstDate) - margin);
  if (!rule.byday || (rule.freq === "WEEKLY" && rule.byday.length === 1 && rule.byday[0] === weekday(start))) {
    // One occurrence per period: occurrence k is start + k periods, and COUNT is simply k < COUNT.
    const period = rule.freq === "DAILY" ? rule.interval : 7 * rule.interval;
    for (let k = Math.floor(gap / period); rule.count === null || k < rule.count; k++) {
      spend(ctx);
      const date = addDays(start, k * period);
      if (date > lastDate || !untilOk(date)) break;
      if (date >= earliest) out.push(date);
    }
    return out;
  }
  if (rule.count !== null && daysBetween(start, firstDate) > COUNT_LOOKBACK_DAYS) return "far";
  let produced = 0;
  // Counted from the start: the start itself is always the first occurrence (RFC 5545 §3.8.5.3).
  const take = (date: string) => {
    if (!untilOk(date)) return false;
    produced++;
    if (date >= earliest) out.push(date);
    return rule.count === null || produced < rule.count;
  };
  spend(ctx);
  if (!take(start)) return out;
  const skip = rule.count === null ? gap : 0;
  if (rule.freq === "DAILY") {
    for (let k = Math.floor(skip / rule.interval) + 1; ; k++) {
      spend(ctx);
      const date = addDays(start, k * rule.interval);
      if (date > lastDate) return out;
      if (!rule.byday.includes(weekday(date))) continue;
      if (!take(date)) return out;
    }
  }
  const days = rule.byday.map(d => (d - rule.wkst + 7) % 7).sort((a, b) => a - b);
  const weekStart = addDays(start, -((weekday(start) - rule.wkst + 7) % 7));
  for (let w = Math.max(0, Math.floor(skip / (7 * rule.interval)) - 1); ; w++) {
    const week = addDays(weekStart, w * 7 * rule.interval);
    if (week > lastDate) return out;
    for (const offset of days) {
      spend(ctx);
      const date = addDays(week, offset);
      if (date <= start) continue;
      if (date > lastDate) return out;
      if (!take(date)) return out;
    }
  }
}

/** An instant as ISO text, or null when it is outside what a date can hold. */
const safeIso = (ms: number) => Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
const defaultClock = () => typeof performance !== "undefined" ? performance.now() : Date.now();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Reads a calendar's text and returns what touches the window. */
export function parseIcs(text: string, options: IcsOptions): IcsResult {
  const macZone = isTimeZone(options.zone) ? options.zone : "UTC";
  const from = Date.parse(options.window.from), to = Date.parse(options.window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { ok: false, problem: "not-a-calendar" };
  const clock = options.clock ?? defaultClock;
  const ctx: Ctx = {
    macZone, firstDate: localDate(from, macZone), endDate: addDays(localDate(to - 1, macZone), 1), zones: new Map(),
    steps: MAX_STEPS_PER_READ, deadline: clock() + (options.timeLimitMs ?? MAX_PARSE_MS), clock, ticks: 0,
  };
  try { return read(text, ctx, from, to); }
  catch (error) { if (error instanceof TooLarge) return { ok: false, problem: "too-large" }; throw error; }
}

function read(text: string, ctx: Ctx, from: number, to: number): IcsResult {
  const { macZone, firstDate, endDate } = ctx;
  const lines = unfold(text);
  if (lines[0]?.toUpperCase() !== "BEGIN:VCALENDAR" || !lines.some(l => l.toUpperCase() === "END:VCALENDAR")) return { ok: false, problem: "not-a-calendar" };

  // Components: a VEVENT directly inside the VCALENDAR; anything nested in it (VALARM) is skipped. An END that closes
  // something still open closes everything opened inside it; one that closes nothing open is ignored. Either way the
  // text was out of order or unfinished, and the read says so.
  const components: Component[] = [];
  const stack: string[] = [];
  let props: Prop[] | null = null;
  let damaged = 0;
  const finish = () => {
    if (!props) return;
    if (components.length >= MAX_COMPONENTS) throw new TooLarge();
    components.push(component(props, components.length));
    props = null;
  };
  for (const line of lines) {
    spend(ctx, 0);
    const p = property(line);
    if (!p) continue;
    if (p.name === "BEGIN") {
      const name = p.value.trim().toUpperCase();
      if (name === "VEVENT" && props) { damaged++; finish(); stack.length = Math.min(stack.length, 1); }
      stack.push(name);
      if (stack.length === 2 && name === "VEVENT") props = [];
      continue;
    }
    if (p.name === "END") {
      const name = p.value.trim().toUpperCase();
      const at = stack.lastIndexOf(name);
      if (at < 0) { damaged++; continue; }
      if (at !== stack.length - 1) damaged++;
      if (at <= 1) finish();
      stack.length = at;
      continue;
    }
    if (props && stack.length === 2) props.push(p);
  }
  if (props) { damaged++; finish(); }

  const events: IcsEvent[] = [];
  const looks: CalendarLook[] = [];
  let lookCount = 0, skipped = 0, garbled = false;
  const look = (c: Component, reason: string) => { if (++lookCount <= MAX_LOOKS) looks.push({ title: c.summary || "(No title)", reason }); };
  // Each UID's repeating series and the occurrences changed in it (RECURRENCE-ID), found once before the main loop.
  // One without a UID is a series of its own; a second series with the same UID is shown too, and said.
  const series = new Map<string, Component>();
  const changed = new Map<string, Component[]>();
  const tooManyChanges = new Set<string>();
  for (const c of components) {
    if (!c.startRaw) continue;
    if (!c.recurrenceRaw) { if (c.rrule && c.uid && !series.has(c.uid)) series.set(c.uid, c); continue; }
    if (!c.uid) continue;
    const list = changed.get(c.uid);
    if (!list) changed.set(c.uid, [c]);
    else if (list.length < MAX_CHANGES_PER_SERIES) list.push(c);
    else tooManyChanges.add(c.uid);
  }
  const keyOf = (c: Component) => c.uid || `#${c.index}`;
  const originalKey = (w: When) => w.kind === "date" ? w.date : safeIso(w.at) ?? "";
  const touches = (time: CalendarTime) => time.all_day
    ? time.start_date < endDate && time.end_date > firstDate
    : (Date.parse(time.start) < to && Date.parse(time.end) > from) || (time.start === time.end && Date.parse(time.start) >= from && Date.parse(time.start) < to);

  /** An event's length (days for all-day, milliseconds for timed), or null when it is over a year. */
  const lengthOf = (c: Component): { days: number; ms: number; backwards: boolean } | null => {
    const start = startOf(c, ctx)!;
    if (start.kind === "date") {
      const end = endOf(c, ctx);
      const days = end?.kind === "date" ? daysBetween(start.date, end.date) : c.duration ? c.duration.days : 1;
      if (!Number.isFinite(days) || days > MAX_LENGTH_DAYS) return null;
      // An end on its own start date (or no length) is a one-day event, as calendars show it.
      return { days: Math.max(1, days), ms: 0, backwards: days < 0 };
    }
    const end = endOf(c, ctx);
    const ms = end?.kind === "time" ? end.at - start.at : c.duration ? c.duration.days * DAY_MS + c.duration.ms : 0;
    if (!Number.isFinite(ms) || ms > MAX_LENGTH_DAYS * DAY_MS) return null;
    return { days: 0, ms: Math.max(0, ms), backwards: ms < 0 };
  };
  const place = (c: Component, start: When, original: When) => {
    const length = lengthOf(c);
    if (!length) { look(c, TOO_LONG); return; }
    let time: CalendarTime;
    let uncertain = start.kind === "time" ? start.uncertain : null;
    const end = endOf(c, ctx);
    if (end?.kind === "time" && end.uncertain) uncertain ??= end.uncertain;
    if (length.backwards) uncertain ??= "Its end is before its start in the calendar.";
    if (start.kind === "date") time = { all_day: true, start_date: start.date, end_date: addDays(start.date, length.days) };
    else {
      const s = safeIso(start.at), e = safeIso(start.at + length.ms);
      if (!s || !e) { skipped++; return; }
      time = { all_day: false, start: s, end: e };
    }
    if (!touches(time)) return;
    if (c.summary.includes(GARBLED) || c.location?.includes(GARBLED)) garbled = true;
    events.push({ key: `${keyOf(c)}|${originalKey(original)}`, title: c.summary || "(No title)", location: c.location, time, status: c.status, free: c.free, uncertain });
  };
  /** Changed occurrences of a series that isn't expanded here: each stands on its own where it now is. */
  const placeChanges = (uid: string) => {
    for (const change of changed.get(uid) ?? []) {
      if (!nearWindow(change, ctx)) continue;
      const start = startOf(change, ctx), original = recurrenceOf(change, ctx);
      if (start && original) place(change, start, original);
    }
  };

  for (const c of components) {
    if (!c.startRaw) { skipped++; continue; }
    if (c.recurrenceRaw) {
      // A changed occurrence without its series in this text stands alone; with one, the series places it.
      if (!c.uid || !series.has(c.uid)) {
        if (!nearWindow(c, ctx)) continue;
        const start = startOf(c, ctx), original = recurrenceOf(c, ctx);
        if (!start) { skipped++; continue; }
        place(c, start, original ?? start);
      }
      continue;
    }
    if (!c.rrule) {
      // Extra dates are said only for an event near these days, or one with an extra date near them.
      const near = nearWindow(c, ctx);
      if (c.rdate && (near || c.rdates.some(d => d >= addDays(firstDate, -2) && d <= addDays(endDate, 1)))) look(c, EXTRA_DATES);
      if (!near) continue;
      const start = startOf(c, ctx);
      if (!start) { skipped++; continue; }
      place(c, start, start);
      continue;
    }
    const first = c.uid ? series.get(c.uid) === c : true;
    const startDate = rawDate(c.startRaw.value);
    if (!startDate) { skipped++; continue; }
    const rule = parseRule(c.rrule, ctx);
    // Whether the series could reach the window at all: it starts before the window ends and hasn't ended before it.
    const untilText = /(?:^|;)UNTIL=([^;]+)/iu.exec(c.rrule)?.[1];
    const untilDate = rawDate(untilText);
    const overrides = first ? changed.get(c.uid) ?? [] : [];
    if (startDate >= addDays(endDate, 1) || (untilDate && untilDate < addDays(firstDate, -1))) { if (first) placeChanges(c.uid); continue; }
    const start = startOf(c, ctx);
    if (!start) { skipped++; continue; }
    if (!first) look(c, SHARED_UID);
    const length = lengthOf(c);
    if (!length) { look(c, TOO_LONG); continue; }
    const why = !rule.ok ? rule.reason
      : c.rdate ? EXTRA_DATES
        : overrides.some(o => o.range === "THISANDFUTURE") ? "One of its dates was changed for the rest of the series, which Ozzie can't work out yet, so it may fall in these days."
          : first && tooManyChanges.has(c.uid) ? "It has more changed dates than Ozzie can work out, so it may fall in these days."
            : c.tooManyExdates ? "It has more skipped dates than Ozzie can work out, so it may fall in these days." : null;
    if (why || !rule.ok) {
      look(c, why ?? ODD);
      if (first && !tooManyChanges.has(c.uid)) placeChanges(c.uid);
      continue;
    }
    // Dates in the series' own calendar: its zone's wall clock, or plain dates for all-day events.
    const seriesZone = start.kind === "time" ? start.zone : macZone;
    const lastDate = addDays(localDate(to - 1, seriesZone), 1);
    const untilOk = (date: string): boolean => {
      const u = rule.until;
      if (!u) return true;
      if (u.kind === "date") return date <= u.date;
      if (start.kind === "date") return date <= localDate(u.at, macZone);
      return wallToInstant({ date, seconds: start.wall.seconds }, start.zone, ctx) <= u.at;
    };
    const margin = Math.ceil(length.ms / DAY_MS) + length.days + 2;
    const dates = seriesDates(startDate, rule, untilOk, localDate(from, seriesZone), lastDate, margin, ctx);
    if (dates === "far") { look(c, LONG_AGO); if (first) placeChanges(c.uid); continue; }
    // Only skipped dates near the window are worked out; a date-only skip on a timed series skips that whole day.
    const lowest = addDays(dates[0] ?? firstDate, -1), highest = addDays(lastDate, 1);
    const excluded = new Set<string>(), excludedDays = new Set<string>();
    for (const raw of c.exdates) {
      const day = rawDate(raw.value);
      if (!day || day < lowest || day > highest) continue;
      const w = parseWhen(raw.value, raw.params, ctx);
      if (w?.kind === "date" && start.kind === "time") excludedDays.add(w.date);
      else if (w) excluded.add(originalKey(w));
    }
    const replaced = new Map<string, Component>();
    for (const o of overrides) {
      // Needed when it moves an occurrence into the window or takes one out of it.
      const was = rawDate(o.recurrenceRaw?.value);
      if (!nearWindow(o, ctx) && !(was !== null && was >= lowest && was <= highest)) continue;
      const original = recurrenceOf(o, ctx);
      if (original && startOf(o, ctx)) replaced.set(originalKey(original), o);
    }
    for (const date of dates) {
      const occurrence: When = start.kind === "date" ? { kind: "date", date }
        : { ...start, at: wallToInstant({ date, seconds: start.wall.seconds }, start.zone, ctx), wall: { date, seconds: start.wall.seconds } };
      const key = originalKey(occurrence);
      if (excluded.has(key) || excludedDays.has(date)) continue;
      const change = replaced.get(key);
      if (change) { place(change, startOf(change, ctx)!, occurrence); replaced.delete(key); }
      else place(c, occurrence, occurrence);
    }
    // A changed occurrence moved here from a date outside the dates worked out above.
    for (const change of replaced.values()) place(change, startOf(change, ctx)!, recurrenceOf(change, ctx)!);
  }

  const startMs = (e: IcsEvent) => e.time.all_day ? dateMs(e.time.start_date) : Date.parse(e.time.start);
  events.sort((a, b) => startMs(a) - startMs(b) || a.title.localeCompare(b.title));
  // Notes about the calendar itself come first and are always kept.
  const notes: CalendarLook[] = [
    ...(skipped ? [{ title: null, reason: `${plural(skipped, "event", "events")} in this calendar ${skipped === 1 ? "has" : "have"} no start time Ozzie can read, so ${skipped === 1 ? "it isn't" : "they aren't"} shown.` }] : []),
    ...(damaged ? [{ title: null, reason: "Part of this calendar's text is out of order or unfinished, so some events may be missing." }] : []),
    ...(garbled ? [{ title: null, reason: `Some text in this calendar couldn't be read and shows as “${GARBLED}”.` }] : []),
  ];
  const truncated = events.length > MAX_IN_WINDOW || lookCount > MAX_LOOKS;
  return { ok: true, events: events.slice(0, MAX_IN_WINDOW), looks: [...notes, ...looks], skipped, truncated };
}
