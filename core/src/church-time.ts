// The church's own time zone and its local Sunday. Pure: no I/O, no clock, no model.
// The zone comes only from Planning Center Services' Organization (`time_zone`, read natively as
// the `organization` collection). There is no fallback to this Mac's zone: without the church's
// zone, anything that depends on which hours are "Sunday" is not checked.
// Services gives `Plan.sort_date` as the church's local wall-clock time with a misleading `Z`
// (verified live 2026-11-13: plan 92902197, a 9:30 AM Eastern service, reads
// `"sort_date":"2026-11-22T09:30:00Z"`), so its date part is the church-local Sunday and its time
// is local. It is never read as a UTC instant.
import type { SundayCapture } from "./sunday-capture.js";

export interface LocalInterval { starts_at: string; ends_at: string }

/**
 * An IANA zone name this Mac's time-zone data knows. ECMA-402 canonicalizes some names
 * (Asia/Kolkata reads back as Asia/Calcutta, Etc/UTC as UTC), so acceptance, not an identical
 * read-back, is the test.
 */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 64 || (v !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(v))) return false;
  const known = zoneNames.get(v);
  if (known !== undefined) return known;
  let ok: boolean;
  try { new Intl.DateTimeFormat("en-US", { timeZone: v }); ok = true; } catch { ok = false; }
  // Building a formatter is slow, and a calendar file can name the same zone many times: answers are kept, a bounded number.
  if (zoneNames.size < 512) zoneNames.set(v, ok);
  return ok;
}
const zoneNames = new Map<string, boolean>();

export type ChurchZone = { zone: string; problem: null } | { zone: null; problem: "missing" | "failed" | "unrecognized" };
interface Row { type?: unknown; id?: unknown; attributes?: Record<string, unknown> }

/** The church's time zone from this capture's Services Organization read, or why there isn't one. */
export function churchZone(capture: Pick<SundayCapture, "organization" | "reads">): ChurchZone {
  const reads = capture.reads.filter(r => r.collection === "organization");
  if (!reads.length) return { zone: null, problem: "missing" };
  const read = reads.length === 1 ? reads[0]! : null;
  if (!read || read.outcome !== "ok" || !read.body) return { zone: null, problem: "failed" };
  const row = read.body.data as Row | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.type !== "Organization" || row.id !== String(capture.organization)) return { zone: null, problem: "failed" };
  const zone = row.attributes?.time_zone;
  return isTimeZone(zone) ? { zone, problem: null } : { zone: null, problem: "unrecognized" };
}
export const churchTimeZone = (capture: Pick<SundayCapture, "organization" | "reads">): string | null => churchZone(capture).zone;

const DAY_MS = 86_400_000;
const iso = (n: number) => new Date(n).toISOString();
// One formatter per zone: building one is far slower than using it, and calendars convert many times per read.
const formats = new Map<string, Intl.DateTimeFormat>();
function formatIn(zone: string): Intl.DateTimeFormat {
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (formats.size < 64) formats.set(zone, format);
  }
  return format;
}
function parts(at: number, zone: string) {
  const p = formatIn(zone).formatToParts(new Date(at));
  const n = (type: string) => Number(p.find(x => x.type === type)?.value);
  return { year: n("year"), month: n("month"), day: n("day"), hour: n("hour"), minute: n("minute"), second: n("second") };
}
/** The zone's UTC offset at `at`, in milliseconds (whole seconds). */
export function offsetAt(at: number, zone: string): number {
  const p = parts(at, zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}
/** `YYYY-MM-DD` of the instant `at` in `zone`. */
export function localDate(at: string | number, zone: string): string {
  const p = parts(typeof at === "number" ? at : Date.parse(at), zone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
const validDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
  iso(Date.parse(`${date}T00:00:00Z`)).slice(0, 10) === date;

/**
 * The first instant whose local date in `zone` is `date`. Local midnight when it exists; where a
 * daylight-saving change skips midnight (Havana, Santiago), the first moment after the gap.
 */
function dayStart(date: string, zone: string): number {
  const base = Date.parse(`${date}T00:00:00Z`);
  // Every offset the zone could have around that midnight; the earliest that lands on the date wins.
  const offsets = new Set([-36, -18, -6, 0, 6, 18, 36].map(h => offsetAt(base + h * 3_600_000, zone)));
  const starts = [...offsets].map(o => base - o).filter(t => localDate(t, zone) === date && localDate(t - 1, zone) !== date);
  return starts.length ? Math.min(...starts) : NaN;
}
/** The church-local calendar day `date` in `zone`, as UTC instants. */
export function localDay(date: string, zone: string): LocalInterval | null {
  if (!validDate(date) || !isTimeZone(zone)) return null;
  const next = iso(Date.parse(`${date}T00:00:00Z`) + DAY_MS).slice(0, 10);
  const starts = dayStart(date, zone), ends = dayStart(next, zone);
  return Number.isFinite(starts) && Number.isFinite(ends) && starts < ends ? { starts_at: iso(starts), ends_at: iso(ends) } : null;
}

/** The church-local date of a plan's `sort_date`: its date part, whatever suffix it carries. */
export function planDate(sort_date: unknown): string | null {
  if (typeof sort_date !== "string") return null;
  const date = sort_date.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(sort_date) && validDate(date) ? date : null;
}

/** The instant of a plan's local wall-clock `sort_date` in the church's zone; null when it can't be placed (or falls in a skipped hour). */
export function planStart(sort_date: unknown, zone: string | null): string | null {
  const date = planDate(sort_date);
  if (!date || !zone || !isTimeZone(zone)) return null;
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(sort_date as string)!;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.parse(`${date}T00:00:00Z`) + ((h * 60 + mi) * 60 + s) * 1000;
  for (const o of new Set([offsetAt(wall - DAY_MS / 2, zone), offsetAt(wall, zone), offsetAt(wall + DAY_MS / 2, zone)])) {
    const t = wall - o, p = parts(t, zone);
    if (localDate(t, zone) === date && p.hour === h && p.minute === mi && p.second === s) return iso(t);
  }
  return null;
}
