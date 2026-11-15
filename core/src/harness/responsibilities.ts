// Ongoing responsibilities (owner decisions, November 4 and 14): something Ozzie keeps an eye on
// without another prompt, set up with one confirmation, within limits the native store enforces.
// This file is pure: every function takes `now` (ISO) and a time zone; nothing reads the clock,
// starts timers, stores anything or reaches a model. The native store (core/native-auth
// src/responsibilities.rs) keeps the same fixed templates and refuses any run outside them.
//
// Name-free by construction: a responsibility is a fixed template, schedule numbers, dates, enums
// and counters. A typed request is read here only to choose among those; its text is never kept,
// echoed or sent anywhere.
import { isTimeZone, localDate, localDay, planStart } from "../church-time.js";
import { inQuietHours, parseClock, type QuietHours } from "../schedule.js";
import type { SundayChange } from "../sunday-changes.js";

export const TEMPLATE_IDS = ["keep-sunday-covered", "watch-room-bookings", "follow-ups-without-owner", "group-night-clashes", "morning-briefing"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export type Area = "services" | "operations";
export type ReportPolicy = "decisions-only" | "every-check";
/** "until": ends at the end of that church-local date (`ends_at`). "until-stopped": runs until paused or stopped. */
export type Lifetime = { kind: "until"; until: string; ends_at: string } | { kind: "until-stopped" };
/** `time` "HH:MM" in the church's zone; `weekdays` 0 (Sunday) to 6, empty for every day. */
export interface Schedule { time: string; weekdays: number[]; on_change: boolean }
export interface Limits { checks_per_day: number; ai_steps_per_day: number }
/**
 * What a person confirms. Everything else about a responsibility follows from its template. `zone` is the
 * IANA time zone the schedule and lifetime were worked out in (the church's when a check has read it,
 * otherwise this Mac's); the native store keeps it, so a responsibility keeps its clock from launch on.
 */
export interface Plan { template: TemplateId; schedule: Schedule; report: ReportPolicy; lifetime: Lifetime; limits: Limits; zone: string }

export type RunTrigger = "start" | "scheduled" | "catch-up" | "retry" | "change" | "manual";
/** One run as the native store lists it. Counts and codes only. */
export interface RunRow {
  run_id: string; trigger: RunTrigger; started_at: string; ended_at: string | null;
  outcome: "ok" | "failed" | "interrupted" | null; code: string | null; noticed: number; drafts: number; ai_steps: number;
}
export interface Responsibility extends Omit<Plan, "zone"> {
  id: string; title: string; skill_id: string;
  /** The zone it was confirmed in; null for one confirmed before the store kept zones. */
  zone: string | null;
  status: "active" | "paused" | "ended";
  created_at: string; confirmed_at: string;
  /** Newest first. */
  runs: RunRow[];
  open_run: RunRow | null;
}

export type Watch = "sunday-roles" | "sunday-answers" | "sunday-leads" | "rooms" | "follow-ups" | "groups" | "briefing";
export interface Template {
  id: TemplateId;
  /** Fixed. Shown to people. */
  title: string;
  /** The procedure (core/skills) a run follows when an AI model is set up. */
  skill_id: string;
  watches: Watch[];
  needs: Area[];
  cadence: "daily" | "weekly";
  /** Whether a relevant change found by the regular Sunday check may bring the next run sooner. */
  on_change: boolean;
  defaults: { time: string; weekdays: number[]; report: ReportPolicy; lifetime: "this-sunday" | "until-stopped" };
  /** Extra check times in the two days before the Sunday it watches. */
  near_deadline: string[];
  /** The most a person may allow; the plan may ask for less. */
  max: Limits;
}
// Mirrored in responsibilities.rs TEMPLATES (pinned by a test).
export const TEMPLATES: Readonly<Record<TemplateId, Template>> = Object.freeze({
  "keep-sunday-covered": {
    id: "keep-sunday-covered", title: "Keep Sunday covered", skill_id: "sunday-ready", watches: ["sunday-roles", "sunday-answers", "sunday-leads"], needs: ["services"],
    cadence: "daily", on_change: true, defaults: { time: "07:00", weekdays: [], report: "decisions-only", lifetime: "this-sunday" },
    near_deadline: ["12:00", "17:00"], max: { checks_per_day: 6, ai_steps_per_day: 12 },
  },
  "watch-room-bookings": {
    id: "watch-room-bookings", title: "Watch room bookings", skill_id: "room-check", watches: ["rooms"], needs: ["services", "operations"],
    cadence: "weekly", on_change: false, defaults: { time: "09:00", weekdays: [4], report: "decisions-only", lifetime: "until-stopped" },
    near_deadline: [], max: { checks_per_day: 3, ai_steps_per_day: 6 },
  },
  "follow-ups-without-owner": {
    id: "follow-ups-without-owner", title: "Follow-ups without an owner", skill_id: "follow-up-owners", watches: ["follow-ups"], needs: ["services", "operations"],
    cadence: "weekly", on_change: false, defaults: { time: "09:00", weekdays: [1], report: "decisions-only", lifetime: "until-stopped" },
    near_deadline: [], max: { checks_per_day: 3, ai_steps_per_day: 6 },
  },
  "group-night-clashes": {
    id: "group-night-clashes", title: "Group night clashes", skill_id: "group-night", watches: ["groups"], needs: ["services", "operations"],
    cadence: "weekly", on_change: false, defaults: { time: "09:00", weekdays: [3], report: "decisions-only", lifetime: "until-stopped" },
    near_deadline: [], max: { checks_per_day: 3, ai_steps_per_day: 6 },
  },
  // Owner decision, October 26: 7:00 AM on weekdays, just as the default quiet hours end.
  "morning-briefing": {
    id: "morning-briefing", title: "Morning briefing", skill_id: "sunday-ready", watches: ["briefing"], needs: ["services"],
    cadence: "daily", on_change: false, defaults: { time: "07:00", weekdays: [1, 2, 3, 4, 5], report: "every-check", lifetime: "until-stopped" },
    near_deadline: [], max: { checks_per_day: 3, ai_steps_per_day: 6 },
  },
});
/** Monday to Friday. */
export const BRIEFING_WEEKDAYS: readonly number[] = Object.freeze([1, 2, 3, 4, 5]);
/** Thursday's scheduled briefing includes the full Sunday Ready brief (owner decision, October 26). */
export const SUNDAY_READY_WEEKDAY = 4;
/** Whether a briefing at `at` is Thursday's, on the church's own date. */
export const includesSundayReady = (at: string, zone: string) => weekdayOf(localDate(at, zone)) === SUNDAY_READY_WEEKDAY;
/** The morning briefing's default before that decision: every day at 6:45, inside the settled quiet hours. */
const EARLIER_BRIEFING = { time: "06:45", weekdays: [] as number[] };
/**
 * A saved morning briefing still on the earlier default time and days, moved to the settled default;
 * null for anything a person changed (or anything else). Its lifetime, limits and report stay as they were.
 */
export function settledPlan(r: Pick<Responsibility, "template" | "schedule" | "report" | "lifetime" | "limits" | "zone" | "status">, zone?: string): Plan | null {
  if (r.template !== "morning-briefing" || r.status === "ended" || r.schedule.time !== EARLIER_BRIEFING.time || r.schedule.weekdays.length !== EARLIER_BRIEFING.weekdays.length) return null;
  const t = TEMPLATES["morning-briefing"];
  const planZone = r.zone ?? zone;
  if (!planZone) return null;
  return { template: r.template, schedule: { ...r.schedule, time: t.defaults.time, weekdays: [...t.defaults.weekdays] }, report: r.report, lifetime: r.lifetime, limits: r.limits, zone: planZone };
}

/** A scheduled time passed by more than this without a run was missed (Mac asleep, Ozzie closed), not just late. */
export const MISSED_AFTER_MS = 5 * 60_000;
/** After a run that couldn't finish, try again this much later (it counts toward the daily limit). */
export const RETRY_MS = 60 * 60_000;
/** The native store's own gaps (responsibilities.rs MIN_GAP_MS, FAST_MIN_GAP_MS, RUN_TIMEOUT_MS; pinned by a test). */
export const MIN_GAP_MS = 5 * 60_000;
export const FAST_MIN_GAP_MS = 20_000;
export const RUN_TIMEOUT_MS = 10 * 60_000;
/** A refusal the next refresh shows anyway (paused, ended…) is asked about again no sooner than this. */
export const RECHECK_MS = 30_000;
/** A change may bring a run sooner, but never within this long of the last one. */
export const CHANGE_GAP_MS = 30 * 60_000;
/** Developer builds only (OZZIE_DEV_FAST_SCHEDULE=1): scheduled runs this far apart. */
export const FAST_SLOT_MS = 2 * 60_000;
export const DAY_MS = 86_400_000;
const NEAR_DEADLINE_DAYS = 2;
/** How far back a long sleep is looked at; anything older was missed long ago and is caught up once anyway. */
const LOOKBACK_MS = 9 * DAY_MS;

const ms = (iso: string) => Date.parse(iso);
const iso = (n: number) => new Date(n).toISOString();
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const validDate = (date: string) => DATE.test(date) && Number.isFinite(ms(`${date}T00:00:00Z`)) && iso(ms(`${date}T00:00:00Z`)).slice(0, 10) === date;
export const addDays = (date: string, n: number) => iso(ms(`${date}T00:00:00Z`) + n * DAY_MS).slice(0, 10);
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** The instant of wall-clock `hhmm` on church-local `date`; null for a time that doesn't exist that day. */
export function localInstant(date: string, hhmm: string, zone: string): string | null {
  if (!validDate(date) || parseClock(hhmm) === null || !isTimeZone(zone)) return null;
  return planStart(`${date}T${hhmm}:00`, zone);
}
/** Minutes after local midnight on a clock in `zone` at `at`. */
function wallMinutes(at: number, zone: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(at));
  const n = (type: string) => Number(p.find(x => x.type === type)?.value);
  return (n("hour") % 24) * 60 + n("minute");
}
const clockOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
/**
 * The instant of wall-clock `hhmm` on church-local `date`. Where a daylight-saving change skips that
 * time (02:30 on a spring-forward night), the first moment after the gap, so the check still happens.
 */
export function wallInstant(date: string, hhmm: string, zone: string): string | null {
  const exact = localInstant(date, hhmm, zone);
  const target = parseClock(hhmm);
  if (exact || target === null || !validDate(date) || !isTimeZone(zone)) return exact;
  const day = localDay(date, zone);
  if (!day) return null;
  // A day with a gap has no repeated hour, so its clock only moves forward: search it by the minute.
  let lo = ms(day.starts_at) / 60_000, hi = ms(day.ends_at) / 60_000;
  if (wallMinutes((hi - 1) * 60_000, zone) < target) return null;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallMinutes(mid * 60_000, zone) >= target) hi = mid; else lo = mid + 1;
  }
  return iso(lo * 60_000);
}
/** The coming `weekday` (0 = Sunday) in the church's zone, today included. */
export function upcomingWeekday(now: string, zone: string, weekday: number): string {
  const today = localDate(now, zone);
  return addDays(today, (weekday - weekdayOf(today) + 7) % 7);
}
/** A lifetime that ends when church-local `date` ends. */
export function untilLifetime(date: string, zone: string): Lifetime | null {
  const day = validDate(date) ? localDay(date, zone) : null;
  return day ? { kind: "until", until: date, ends_at: day.ends_at } : null;
}

/** What a plan can know about this Mac's setup: the church-local date of the Sunday chosen in Settings, once a check has read it. */
export interface PlanOptions { sunday?: string | null }
/** The Sunday a "this Sunday" default means: the one chosen in Settings while it's still ahead, otherwise the coming Sunday. */
function watchedSunday(now: string, zone: string, options: PlanOptions): string {
  const chosen = options.sunday;
  return chosen && validDate(chosen) && chosen >= localDate(now, zone) ? chosen : upcomingWeekday(now, zone, 0);
}
export function defaultPlan(template: TemplateId, now: string, zone: string, options: PlanOptions = {}): Plan {
  const t = TEMPLATES[template];
  const lifetime = t.defaults.lifetime === "this-sunday" ? untilLifetime(watchedSunday(now, zone, options), zone) ?? { kind: "until-stopped" as const } : { kind: "until-stopped" as const };
  return {
    template, schedule: { time: t.defaults.time, weekdays: [...t.defaults.weekdays], on_change: t.on_change },
    report: t.defaults.report, lifetime, limits: { ...t.max }, zone,
  };
}

/** Every limit and shape the native store checks, so the app never offers a plan it would refuse. */
export function validPlan(plan: Plan, now: string): boolean {
  const t = (TEMPLATE_IDS as readonly string[]).includes(plan?.template) ? TEMPLATES[plan.template] : null;
  if (!t) return false;
  const { schedule: s, limits: l, lifetime } = plan;
  const int = (n: unknown, max: number) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;
  const days = Array.isArray(s?.weekdays) && s.weekdays.length <= 7 && s.weekdays.every((d, i) => Number.isInteger(d) && d >= 0 && d <= 6 && (i === 0 || d > s.weekdays[i - 1]!));
  const life = lifetime?.kind === "until-stopped" || (lifetime?.kind === "until" && validDate(lifetime.until)
    && iso(ms(lifetime.ends_at)) === lifetime.ends_at
    // The end of that date somewhere between UTC-12 and UTC+14, still ahead, and within a year.
    && ms(lifetime.ends_at) >= ms(`${addDays(lifetime.until, 1)}T00:00:00Z`) - 14 * 3_600_000
    && ms(lifetime.ends_at) <= ms(`${addDays(lifetime.until, 1)}T00:00:00Z`) + 12 * 3_600_000
    && ms(lifetime.ends_at) > ms(now) && ms(lifetime.ends_at) <= ms(now) + 367 * DAY_MS);
  return isTimeZone(plan.zone) && typeof s?.time === "string" && parseClock(s.time) !== null && days && typeof s.on_change === "boolean" && (!s.on_change || t.on_change)
    && (plan.report === "decisions-only" || plan.report === "every-check")
    && int(l?.checks_per_day, t.max.checks_per_day) && int(l?.ai_steps_per_day, t.max.ai_steps_per_day) && life;
}

export type Scheduled = Pick<Responsibility, "template" | "schedule" | "lifetime" | "confirmed_at">;
export const lifetimeEnded = (r: Pick<Responsibility, "lifetime">, now: string) => r.lifetime.kind === "until" && ms(now) >= ms(r.lifetime.ends_at);
const endMs = (r: Scheduled) => r.lifetime.kind === "until" ? ms(r.lifetime.ends_at) : Infinity;

const sundayFrom = (date: string) => addDays(date, (7 - weekdayOf(date)) % 7);
/**
 * In the two days before the Sunday it watches, on a schedule that runs every day. That Sunday is the one
 * a dated plan runs up to (the first Sunday on or after its date: "until Wednesday" never gets there), or
 * each week's Sunday when it runs until stopped. A schedule on chosen weekdays keeps to its own time only.
 */
function nearDeadline(r: Scheduled, date: string): boolean {
  if (r.schedule.weekdays.length) return false;
  const sunday = sundayFrom(r.lifetime.kind === "until" ? r.lifetime.until : date);
  const days = (ms(`${sunday}T00:00:00Z`) - ms(`${date}T00:00:00Z`)) / DAY_MS;
  return days >= 1 && days <= NEAR_DEADLINE_DAYS;
}
/**
 * Scheduled times after `after` (exclusive) up to `upTo` (inclusive), in order, within the lifetime.
 * `fast` (developer builds only): every FAST_SLOT_MS from when it was confirmed.
 */
export function scheduledSlots(r: Scheduled, after: string, upTo: string, zone: string, options: { fast?: boolean } = {}): string[] {
  const from = ms(after), to = Math.min(ms(upTo), endMs(r) - 1);
  if (!(from < to)) return [];
  if (options.fast) {
    // Every FAST_SLOT_MS from when it was confirmed.
    const out: string[] = [], start = ms(r.confirmed_at);
    for (let t = start + (Math.max(0, Math.floor((from - start) / FAST_SLOT_MS)) + 1) * FAST_SLOT_MS; t <= to && out.length < 1_000; t += FAST_SLOT_MS) if (t > from) out.push(iso(t));
    return out;
  }
  const out: string[] = [];
  const last = localDate(to, zone);
  const t = TEMPLATES[r.template];
  for (let date = localDate(from, zone); date <= last; date = addDays(date, 1)) {
    if (r.schedule.weekdays.length && !r.schedule.weekdays.includes(weekdayOf(date))) continue;
    const times = [r.schedule.time, ...(nearDeadline(r, date) ? t.near_deadline : [])];
    for (const time of [...new Set(times)]) {
      const at = wallInstant(date, time, zone);
      if (at && ms(at) > from && ms(at) <= to) out.push(at);
    }
  }
  return [...new Set(out)].sort();
}
/** The extra times near Sunday a plan will actually use within its lifetime (looking two weeks ahead), for the plan card. */
export function nearDeadlineTimes(plan: Pick<Plan, "template" | "schedule" | "lifetime">, now: string, zone: string): string[] {
  const slots = scheduledSlots({ ...plan, confirmed_at: now }, now, iso(ms(now) + 15 * DAY_MS), zone);
  const used = new Set(slots.filter(s => wallInstant(localDate(s, zone), plan.schedule.time, zone) !== s).map(s => clockOf(wallMinutes(ms(s), zone))));
  return TEMPLATES[plan.template].near_deadline.filter(time => time !== plan.schedule.time && used.has(time));
}
/** The next scheduled time after `after`, or null when the lifetime ends first. */
export function nextSlot(r: Scheduled, after: string, zone: string, options: { fast?: boolean } = {}): string | null {
  return scheduledSlots(r, after, iso(ms(after) + 8 * DAY_MS), zone, options)[0] ?? null;
}

/** What this Mac remembers about one responsibility between runs. Name-free. */
export interface LocalState {
  /** The latest scheduled time a run has covered (a catch-up covers every missed one). */
  last_slot: string | null;
  last_run_at: string | null;
  /** After a run that couldn't finish. */
  retry_at: string | null;
  /** Runs in a row that couldn't finish. */
  failures: number;
}
export type Due = { due: false; next: string | null } | { due: true; trigger: RunTrigger; slot: string | null; missed: string[] };

/**
 * Whether a run is due now. A new responsibility runs once as soon as it starts. Every scheduled time
 * that passed while the Mac slept or Ozzie was closed is reported as missed and covered by ONE catch-up
 * run, never a burst. A run that couldn't finish is retried RETRY_MS later.
 */
export function dueNow(r: Pick<Responsibility, "template" | "schedule" | "lifetime" | "confirmed_at" | "status">, state: LocalState, now: string, zone: string,
  options: { fast?: boolean } = {}): Due {
  if (r.status !== "active" || lifetimeEnded(r, now)) return { due: false, next: null };
  if (!state.last_slot && !state.last_run_at) return { due: true, trigger: "start", slot: null, missed: [] };
  const base = Math.max(ms(state.last_slot ?? r.confirmed_at), ms(now) - LOOKBACK_MS);
  const slots = scheduledSlots(r, iso(base), now, zone, options);
  if (slots.length) {
    const missed = slots.filter(s => ms(now) - ms(s) > MISSED_AFTER_MS);
    return { due: true, trigger: missed.length ? "catch-up" : "scheduled", slot: slots.at(-1)!, missed };
  }
  if (state.retry_at && ms(now) >= ms(state.retry_at)) return { due: true, trigger: "retry", slot: null, missed: [] };
  const next = [nextSlot(r, now, zone, options), state.retry_at].filter((x): x is string => x !== null).sort()[0] ?? null;
  return { due: false, next };
}
/** When to try again after a run that couldn't finish; null when that would be past the lifetime. */
export function retryAt(r: Pick<Responsibility, "lifetime">, now: string, options: { fast?: boolean } = {}): string | null {
  const at = ms(now) + (options.fast ? FAST_SLOT_MS / 2 : RETRY_MS);
  return r.lifetime.kind === "until" && at >= ms(r.lifetime.ends_at) ? null : iso(at);
}

/** A relevant change (something worse) may bring the next run sooner, on templates that watch for changes, at most every CHANGE_GAP_MS. */
export function changeEligible(r: Pick<Responsibility, "schedule" | "lifetime" | "status" | "template">, state: LocalState, changes: readonly SundayChange[], now: string,
  options: { fast?: boolean } = {}): boolean {
  if (r.status !== "active" || !r.schedule.on_change || !TEMPLATES[r.template].on_change || lifetimeEnded(r, now)) return false;
  if (!changes.some(c => c.effect === "worse")) return false;
  return !state.last_run_at || ms(now) - ms(state.last_run_at) >= (options.fast ? FAST_SLOT_MS / 2 : CHANGE_GAP_MS);
}

/**
 * When a run the native store refused may be asked for again, so a refusal never turns into a busy loop:
 * too soon → the store's gap after the last run started; busy → when the store closes a run left open;
 * over the day's checks → when the oldest counted check turns 24 hours old; the store unreadable or the
 * plan refused → RETRY_MS later; anything the next refresh shows (paused, ended) → RECHECK_MS later.
 * Never sooner than a second from now.
 */
export function refusedUntil(r: Pick<Responsibility, "runs" | "open_run" | "limits">, refusal: string, now: string, options: { fast?: boolean } = {}): string {
  const t = ms(now);
  const latest = r.open_run ?? r.runs[0] ?? null;
  const gap = options.fast ? FAST_MIN_GAP_MS : MIN_GAP_MS;
  let at: number;
  switch (refusal) {
    case "too-soon": at = latest ? ms(latest.started_at) + gap : t + gap; break;
    case "busy": at = latest && !latest.ended_at ? ms(latest.started_at) + RUN_TIMEOUT_MS : t + gap; break;
    case "checks-limit": {
      const starts = r.runs.map(x => ms(x.started_at)).filter(s => s <= t && t - s < DAY_MS).sort((a, b) => a - b);
      const over = starts.length - r.limits.checks_per_day;
      at = over >= 0 ? starts[over]! + DAY_MS : t + RECHECK_MS;
      break;
    }
    case "unavailable": case "invalid": at = t + (options.fast ? FAST_SLOT_MS / 2 : RETRY_MS); break;
    default: at = t + RECHECK_MS;
  }
  return iso(Math.max(Number.isFinite(at) ? at : t + RECHECK_MS, t + 1_000));
}

/** Checks and AI steps used in the last 24 hours (the native store counts the same way). */
export function usage(runs: readonly RunRow[], now: string): { checks: number; ai_steps: number } {
  const recent = runs.filter(r => ms(now) - ms(r.started_at) < DAY_MS && ms(r.started_at) <= ms(now));
  return { checks: recent.length, ai_steps: recent.reduce((n, r) => n + r.ai_steps, 0) };
}
export function limitsLeft(r: Pick<Responsibility, "limits" | "runs" | "open_run">, now: string): { checks: number; ai_steps: number } {
  const used = usage([...r.runs, ...(r.open_run ? [r.open_run] : [])].filter((x, i, all) => all.findIndex(y => y.run_id === x.run_id) === i), now);
  return { checks: Math.max(0, r.limits.checks_per_day - used.checks), ai_steps: Math.max(0, r.limits.ai_steps_per_day - used.ai_steps) };
}

/**
 * What's left for `r` as the native store counts it: a template's rolling 24 hours, whichever of its responsibilities
 * used them (so stopping one and setting up another doesn't reset its limits). `all` is every listed responsibility.
 */
export function templateLimitsLeft(r: Pick<Responsibility, "template" | "limits">, all: readonly Pick<Responsibility, "template" | "runs" | "open_run">[], now: string): { checks: number; ai_steps: number } {
  const same = all.filter(x => x.template === r.template);
  return limitsLeft({ limits: r.limits, runs: same.flatMap(x => [...x.runs, ...(x.open_run ? [x.open_run] : [])]), open_run: null }, now);
}

/** Quiet hours hold a notice until they end (the first moment after a daylight-saving gap they end in); they never drop it. */
export function quietDeferral(now: string, quiet: QuietHours, zone: string): { send: true } | { send: false; at: string } {
  if (!inQuietHours(quiet, now, zone)) return { send: true };
  const today = localDate(now, zone);
  for (const date of [today, addDays(today, 1)]) {
    const at = wallInstant(date, quiet.end, zone);
    if (at && ms(at) > ms(now)) return { send: false, at };
  }
  return { send: true };
}

// ---- A typed request, read deterministically (no model) ---------------------------------------------

export type Parsed =
  | { kind: "none" }
  | { kind: "plan"; plan: Plan; assumed: ("lifetime" | "time")[] }
  /** Something important is unclear: which responsibility, or until when. */
  | { kind: "ask"; need: "what"; choices: TemplateId[] }
  | { kind: "ask"; need: "when"; template: TemplateId; choices: Lifetime[] };

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY = `(${DAYS.join("|")})`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const UNTIL = "(?:until|till|til|through|thru)";
/** Asking Ozzie to take something on, firmly enough to stand alone. */
const STRONG = /\b(?:keep (?:an )?eye on|keep watch|keep track of|keep checking|let me know (?:if|when|whether)|tell me (?:if|when|whether)|alert me|notify me|remind me|(?:every|each) (?:week|day|morning)|weekly|daily|from now on)\b/u;
/** Words that ask only together with something to watch. */
const WEAK = new RegExp(`\\b(?:watch(?:ing)?|monitor(?:ing)?|${UNTIL}|(?:every|each) ${DAY}|(?:on|every|each) week ?days?)\\b`, "u");
const QUESTION = /^(?:what|who|whom|whose|which|why|how|where|when|is|are|was|were|does|do|did|has|have)\b/u;
const TOPICS: readonly [TemplateId, RegExp][] = [
  ["watch-room-bookings", /\b(?:rooms?|room bookings?|bookings?|reservations?)\b/u],
  ["follow-ups-without-owner", /\b(?:follow[- ]?ups?|workflows?|unowned)\b/u],
  ["group-night-clashes", /\b(?:groups?|group nights?|small groups?|clash(?:es)?)\b/u],
  ["morning-briefing", /\b(?:briefing|morning summary|morning report|morning update)\b/u],
];
const SUNDAY_WORDS = /\b(?:sunday|coverage|covered|volunteers?|serving|scheduled|positions?|roles?|teams?|declines?|declined|open spots?)\b/u;

function parseTime(text: string): string | null {
  if (/\bat noon\b/u.test(text)) return "12:00";
  const m = /\bat (\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d:/])/u.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0), half = m[3]?.[0];
  if (h > 23 || min > 59 || (half && (h < 1 || h > 12))) return null;
  // Without am or pm, 6 to 11 are mornings and 1 to 5 afternoons; the plan shows the time either way.
  if (half === "p" && h < 12) h += 12;
  else if (half === "a" && h === 12) h = 0;
  else if (!half && h >= 1 && h <= 5) h += 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
/** The coming `month`/`day` in the church's zone, today included; null for a date that doesn't exist. */
function upcomingDate(now: string, zone: string, month: number, day: number): string | null {
  const today = localDate(now, zone);
  for (const year of [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1]) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (!validDate(date)) return null;
    if (date >= today) return date;
  }
  return null;
}
type LifetimeRead = { kind: "set"; lifetime: Lifetime } | { kind: "ask"; choices: Lifetime[] } | { kind: "none" };
function parseLifetime(text: string, now: string, zone: string, template: TemplateId, options: PlanOptions): LifetimeRead {
  const until = (date: string | null) => date ? untilLifetime(date, zone) : null;
  const choicesFor = (...dates: string[]) => dates.map(d => until(d)).filter((l): l is Lifetime => l !== null);
  const unclear = (): LifetimeRead => ({ kind: "ask", choices: [defaultPlan(template, now, zone, options).lifetime, { kind: "until-stopped" }] });
  const next = new RegExp(`\\bnext ${DAY}\\b`, "u").exec(text);
  if (next) {
    // "Next Sunday" means the coming one to some people and the one after to others.
    const first = upcomingWeekday(now, zone, DAYS.indexOf(next[1]!));
    return { kind: "ask", choices: choicesFor(first, addDays(first, 7)) };
  }
  const named = new RegExp(`\\b(?:${UNTIL} (?:this )?|this (?:coming )?)${DAY}\\b`, "u").exec(text);
  if (named) {
    const l = until(upcomingWeekday(now, zone, DAYS.indexOf(named[1]!)));
    return l ? { kind: "set", lifetime: l } : unclear();
  }
  if (new RegExp(`\\b${UNTIL} tomorrow\\b`, "u").test(text)) {
    const l = until(addDays(localDate(now, zone), 1));
    return l ? { kind: "set", lifetime: l } : unclear();
  }
  const monthDay = new RegExp(`\\b${UNTIL} (?:the )?(${MONTHS.join("|")})[a-z]*\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`, "u").exec(text);
  const slashed = new RegExp(`\\b${UNTIL} (\\d{1,2})/(\\d{1,2})\\b`, "u").exec(text);
  if (monthDay || slashed) {
    const [month, day] = monthDay ? [MONTHS.indexOf(monthDay[1]!) + 1, Number(monthDay[2])] : [Number(slashed![1]), Number(slashed![2])];
    const l = month >= 1 && month <= 12 ? until(upcomingDate(now, zone, month, day)) : null;
    return l ? { kind: "set", lifetime: l } : unclear();
  }
  if (new RegExp(`\\b(?:${UNTIL} (?:i|you) (?:say|tell|stop)|from now on|ongoing|weekly|daily|(?:every|each) (?:week|day|morning|${DAYS.join("|")}))\\b`, "u").test(text)) {
    return { kind: "set", lifetime: { kind: "until-stopped" } };
  }
  if (new RegExp(`\\b${UNTIL}\\b`, "u").test(text)) return unclear();
  return { kind: "none" };
}

/**
 * A typed request to take something on, as a plan from the fixed templates, a question back when
 * something important is unclear, or "none" for anything else (it goes to Ask as usual).
 */
export function parseRequest(typed: string, now: string, zone: string, options: PlanOptions = {}): Parsed {
  const text = typed.normalize("NFKC").toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, " ").trim().slice(0, 600);
  if (!text || QUESTION.test(text)) return { kind: "none" };
  const strong = STRONG.test(text), weak = WEAK.test(text);
  if (!strong && !weak) return { kind: "none" };
  const topics = TOPICS.filter(([, re]) => re.test(text)).map(([id]) => id);
  const chosen: TemplateId[] = topics.length ? topics : SUNDAY_WORDS.test(text) ? ["keep-sunday-covered"] : [];
  if (!chosen.length) return strong ? { kind: "ask", need: "what", choices: [...TEMPLATE_IDS] } : { kind: "none" };
  if (chosen.length > 1) return { kind: "ask", need: "what", choices: TEMPLATE_IDS.filter(id => chosen.includes(id)) };
  const template = chosen[0]!;
  const plan = defaultPlan(template, now, zone, options);
  const assumed: ("lifetime" | "time")[] = [];
  const life = parseLifetime(text, now, zone, template, options);
  if (life.kind === "ask") return { kind: "ask", need: "when", template, choices: life.choices };
  if (life.kind === "set") plan.lifetime = life.lifetime;
  else assumed.push("lifetime");
  const time = parseTime(text);
  if (time) plan.schedule.time = time;
  else assumed.push("time");
  // "Every Wednesday", "on Mondays"; never "on Sunday" (that names what to watch, not when).
  const days = [...new Set([...text.matchAll(new RegExp(`\\b(?:(?:every|each) ${DAY}|on ${DAY}s)\\b`, "gu"))].map(m => DAYS.indexOf((m[1] ?? m[2])!)))].sort();
  if (days.length) plan.schedule.weekdays = days;
  // A daily one may be asked for on weekdays or every day; the morning briefing's default is weekdays.
  else if (TEMPLATES[template].cadence === "daily") {
    if (/\b(?:week ?days?|monday (?:to|through|thru) friday)\b/u.test(text)) plan.schedule.weekdays = [...BRIEFING_WEEKDAYS];
    else if (/\b(?:(?:every|each) (?:day|morning)|daily)\b/u.test(text)) plan.schedule.weekdays = [];
  }
  if (/\b(?:every time|each time|after (?:each|every) check|always tell me)\b/u.test(text)) plan.report = "every-check";
  return validPlan(plan, now) ? { kind: "plan", plan, assumed } : { kind: "ask", need: "when", template, choices: [defaultPlan(template, now, zone, options).lifetime, { kind: "until-stopped" }] };
}
