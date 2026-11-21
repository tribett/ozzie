// When the recurring Sunday check runs, and when its notices may interrupt someone.
// Pure state machine: every function takes `now` (ISO) and returns new state; nothing reads the
// system clock, starts timers or touches storage. The caller persists state and runs the check.

export type RunTrigger = "launch" | "scheduled" | "retry" | "resume" | "catch-up" | "manual";
/**
 * Who started a check outside the schedule ("manual"): a person (Check now, a question in Ask, the first read after
 * setup) or Ozzie itself (its re-read while its window is on screen, a job's check, the read after the plan moves on,
 * after Watch another service, or after it picks the only service by itself). Absent on a record kept before this was,
 * and on every other trigger.
 */
export type StartedBy = "person" | "ozzie";
export interface ScheduleSettings {
  /** Regular spacing between checks while Ozzie is open. Church-adjustable. */
  intervalMinutes: number;
  /** Also check as soon as Ozzie opens. */
  runOnLaunch: boolean;
}
export const DEFAULT_SCHEDULE: ScheduleSettings = { intervalMinutes: 60, runOnLaunch: true };

export interface RunRecord {
  trigger: RunTrigger; started_at: string; finished_at: string;
  by?: StartedBy;
  outcome: "ok" | "failed" | "interrupted";
  /** Fixed local copy only; never provider text. */
  problem?: string;
}
export interface ScheduleState {
  version: 1;
  paused: boolean;
  next_run_at: string | null;
  next_trigger: RunTrigger;
  /** A check came due but its prerequisites (connection, chosen Sunday) were missing. Not a missed check. */
  waiting_since: string | null;
  running: { trigger: RunTrigger; started_at: string; by?: StartedBy } | null;
  last_run: RunRecord | null;
  /** Consecutive failed checks. */
  failures: number;
  /** A notice held for quiet hours, delivered once they end. */
  held: { since: string; urgent: boolean } | null;
}
/** Result of a transition: the new state plus what the caller should do or report. */
export interface Step {
  state: ScheduleState;
  start?: RunTrigger;
  /** The scheduled time of a check that didn't run (Ozzie closed or the Mac asleep). */
  missed?: string;
  interrupted?: RunRecord;
}

/** A scheduled time passed by more than this without a check: it was missed, not just late. */
export const MISSED_AFTER_MS = 5 * 60_000;
export const FIRST_RETRY_MS = 5 * 60_000;
export const MAX_RETRY_MS = 4 * 3_600_000;

const ms = (iso: string) => Date.parse(iso);
const plus = (iso: string, delta: number) => new Date(ms(iso) + delta).toISOString();
const intervalMs = (s: ScheduleSettings) => Math.max(1, s.intervalMinutes) * 60_000;

export function newSchedule(): ScheduleState {
  return { version: 1, paused: false, next_run_at: null, next_trigger: "launch", waiting_since: null, running: null, last_run: null, failures: 0, held: null };
}

/** Exponential backoff after failures: 5, 10, 20… minutes, capped at the longer of 4 hours and the regular interval. */
export function retryDelayMs(failures: number, regularMs: number): number {
  return Math.min(FIRST_RETRY_MS * 2 ** Math.max(0, failures - 1), Math.max(regularMs, MAX_RETRY_MS));
}

/** Ozzie opened. Records an interrupted check, notices a missed one, and makes the launch check due. */
export function launchSchedule(state: ScheduleState, settings: ScheduleSettings, now: string): Step {
  const s: ScheduleState = { ...state };
  const step: Omit<Step, "state"> = {};
  if (s.running) {
    step.interrupted = { trigger: s.running.trigger, started_at: s.running.started_at, ...(s.running.by ? { by: s.running.by } : {}), finished_at: now, outcome: "interrupted" };
    s.last_run = step.interrupted;
    s.running = null;
  }
  if (!s.paused) {
    const first = s.next_run_at === null;
    const overdue = !first && ms(now) >= ms(s.next_run_at!);
    if (overdue && !s.waiting_since && ms(now) - ms(s.next_run_at!) > MISSED_AFTER_MS) step.missed = s.next_run_at!;
    if (settings.runOnLaunch || overdue || first) {
      s.next_trigger = step.missed ? "catch-up" : settings.runOnLaunch || first ? "launch" : s.next_trigger;
      s.next_run_at = now;
    }
  }
  return { state: s, ...step };
}

/**
 * Called on a timer. Starts the due check unless paused, already running, or not ready.
 * A check that comes due while prerequisites are missing waits; it is not missed or failed.
 */
export function tickSchedule(state: ScheduleState, now: string, ready: boolean): Step {
  if (state.paused || state.running || state.next_run_at === null || ms(now) < ms(state.next_run_at)) return { state };
  if (!ready) return state.waiting_since ? { state } : { state: { ...state, waiting_since: now } };
  const late = ms(now) - ms(state.next_run_at) > MISSED_AFTER_MS;
  const missed = late && !state.waiting_since && (state.next_trigger === "scheduled" || state.next_trigger === "retry") ? state.next_run_at : undefined;
  const trigger: RunTrigger = missed ? "catch-up" : state.next_trigger;
  return { state: { ...state, waiting_since: null, running: { trigger, started_at: now } }, start: trigger, ...(missed ? { missed } : {}) };
}

/** "Check now" and every other check outside the schedule, with who started it. Allowed while paused (a person asked); never while another check runs. */
export function startManual(state: ScheduleState, now: string, by?: StartedBy): Step {
  if (state.running) return { state };
  return { state: { ...state, running: { trigger: "manual", started_at: now, ...(by ? { by } : {}) } }, start: "manual" };
}

export function finishRun(state: ScheduleState, settings: ScheduleSettings, now: string, result: { ok: true } | { ok: false; problem: string }): ScheduleState {
  if (!state.running) return state;
  const failures = result.ok ? 0 : state.failures + 1;
  const delay = result.ok ? intervalMs(settings) : retryDelayMs(failures, intervalMs(settings));
  return {
    ...state, running: null, failures,
    last_run: { trigger: state.running.trigger, started_at: state.running.started_at, ...(state.running.by ? { by: state.running.by } : {}), finished_at: now,
      outcome: result.ok ? "ok" : "failed", ...(result.ok ? {} : { problem: result.problem }) },
    next_run_at: state.paused ? null : plus(now, delay),
    next_trigger: result.ok ? "scheduled" : "retry",
  };
}

/** Pausing stops automatic checks and drops any held notice. A running check is allowed to finish. */
export function pauseSchedule(state: ScheduleState): ScheduleState {
  return { ...state, paused: true, next_run_at: null, waiting_since: null, held: null };
}
export function resumeSchedule(state: ScheduleState, now: string): ScheduleState {
  return state.paused ? { ...state, paused: false, next_run_at: now, next_trigger: "resume", waiting_since: null } : state;
}

/** A new interval applies from the last check; an overdue result becomes due now. */
export function rescheduleFor(state: ScheduleState, settings: ScheduleSettings, now: string): ScheduleState {
  if (state.paused || state.running || state.next_trigger !== "scheduled" || !state.last_run) return state;
  const next = Math.max(ms(now), ms(state.last_run.finished_at) + intervalMs(settings));
  return { ...state, next_run_at: new Date(next).toISOString() };
}

// Quiet hours: per person, in this Mac's local time. During them notices wait; in-app attention never does.
export interface QuietHours { start: string; end: string }
/** Owner decision, October 26: 9:00 PM to 7:00 AM unless the person changes it. */
export const DEFAULT_QUIET_HOURS: QuietHours = { start: "21:00", end: "07:00" };
/** The default before that decision was applied. Saved quiet hours still equal to it were never chosen by anyone. */
export const EARLIER_DEFAULT_QUIET_HOURS: QuietHours = { start: "21:30", end: "06:30" };
/** Saved quiet hours, moved to the settled default only when they still equal the earlier default. */
export function settledQuietHours(quiet: QuietHours): QuietHours {
  return quiet.start === EARLIER_DEFAULT_QUIET_HOURS.start && quiet.end === EARLIER_DEFAULT_QUIET_HOURS.end ? { ...DEFAULT_QUIET_HOURS } : quiet;
}

/** "HH:MM" (24-hour, two digits each) → minutes after midnight, or null. */
export function parseClock(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function localMinutes(now: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
  return (part("hour") % 24) * 60 + part("minute");
}

/** Start inclusive, end exclusive; may cross midnight. Equal or invalid times mean no quiet hours. */
export function inQuietHours(quiet: QuietHours, now: string, timeZone: string): boolean {
  const start = parseClock(quiet.start), end = parseClock(quiet.end);
  if (start === null || end === null || start === end) return false;
  const t = localMinutes(now, timeZone);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export type NoticeDecision = "send" | "hold" | "none";
/**
 * One notice per check that found something worse. Quiet hours hold it, including urgent ones,
 * unless this person chose to let urgent notices through. Ozzie never widens that exception itself.
 */
export function noticeDecision(found: { worse: boolean; urgent: boolean }, prefs: { quiet: QuietHours; urgentDuringQuiet: boolean }, now: string, timeZone: string): NoticeDecision {
  if (!found.worse) return "none";
  if (!inQuietHours(prefs.quiet, now, timeZone)) return "send";
  return found.urgent && prefs.urgentDuringQuiet ? "send" : "hold";
}

/** Several held notices become one. */
export function holdNotice(state: ScheduleState, now: string, urgent: boolean): ScheduleState {
  return { ...state, held: { since: state.held?.since ?? now, urgent: Boolean(state.held?.urgent) || urgent } };
}
export function releaseHeld(state: ScheduleState, quietNow: boolean): { state: ScheduleState; deliver: boolean } {
  if (!state.held || quietNow) return { state, deliver: false };
  return { state: { ...state, held: null }, deliver: true };
}
