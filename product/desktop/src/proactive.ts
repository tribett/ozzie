import { invoke } from "@tauri-apps/api/core";
import { connection, type ConnectionStatus } from "./connection.js";
import { sundayProblem, sundaySource, type Settings } from "./sunday-source.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import {
  compareSundayCheck, DEFAULT_URGENT_WITHIN_HOURS, recordSundayCheck, type SundayChange, type SundayCheckMemory, type SundayCheckRecord,
} from "../../../core/src/sunday-changes.js";
import {
  DEFAULT_QUIET_HOURS, DEFAULT_SCHEDULE, finishRun, holdNotice, inQuietHours, launchSchedule, newSchedule, noticeDecision, parseClock,
  pauseSchedule, releaseHeld, rescheduleFor, resumeSchedule, startManual, tickSchedule, type RunTrigger, type ScheduleState,
} from "../../../core/src/schedule.js";

/**
 * The Sunday check the app has always run: re-verify a saved connection when needed, then read.
 * Shared by "Check Planning Center now" and the schedule so both behave the same.
 */
export async function verifiedSundayCheck(ctx: { settings: Settings; status: ConnectionStatus | null }, onStatus: (s: ConnectionStatus) => void): Promise<SundayCapture> {
  // Tokens last about two hours, and a saved connection must be re-verified after restart.
  if (ctx.status?.state !== "connected") {
    const verified = await connection.refresh(ctx.settings.clientId, ctx.settings.organization, true);
    onStatus(verified);
    if (verified.state !== "connected") throw "not-connected";
  }
  return sundaySource.check(ctx.settings.serviceTypeId, ctx.settings.planId);
}

/** Lock-screen privacy: the title and body are fixed in native code; the webview passes no text at all. */
export const notifySundayAttention = () => invoke<void>("notify_sunday_attention");

export type Readiness = "ready" | "not-configured" | "not-connected";
/** Automatic checks need a chosen Sunday and a saved connection. Never during sign-in: re-checking would cancel it. */
export function proactiveReadiness(settings: Settings, status: ConnectionStatus | null): Readiness {
  if (!settings.clientId || !/^[1-9]\d{0,31}$/.test(settings.organization) || !/^\d+$/.test(settings.serviceTypeId) || !/^\d+$/.test(settings.planId)) return "not-configured";
  return status?.state === "connected" || status?.state === "stored-unchecked" ? "ready" : "not-connected";
}

/** Per-person preferences on this Mac. The urgency window is a Church rule. */
export interface ProactivePrefs {
  intervalMinutes: number; runOnLaunch: boolean;
  quietStart: string; quietEnd: string; urgentDuringQuiet: boolean;
  urgentWithinHours: number;
}
export const DEFAULT_PREFS: ProactivePrefs = {
  intervalMinutes: DEFAULT_SCHEDULE.intervalMinutes, runOnLaunch: DEFAULT_SCHEDULE.runOnLaunch,
  quietStart: DEFAULT_QUIET_HOURS.start, quietEnd: DEFAULT_QUIET_HOURS.end, urgentDuringQuiet: false,
  urgentWithinHours: DEFAULT_URGENT_WITHIN_HOURS,
};
export const INTERVAL_CHOICES = [15, 30, 60, 120, 240];

/** What the page lists. Name-free: changes carry person ids; names are resolved only at render. */
export interface HistoryEntry {
  at: string;
  kind: "first-check" | "changes" | "missed" | "failed" | "interrupted";
  trigger?: RunTrigger;
  plan_id?: string; plan_dates?: string | null;
  changes?: SundayChange[];
  /** What happened to the notice for this entry. "in-app": a person was already looking. */
  notice?: "sent" | "held" | "sent-later" | "in-app" | "unavailable" | "none";
  scheduled_for?: string;
  problem?: string;
}

export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
/** localStorage, best effort: a blocked or full store never breaks a check. */
export const browserStore: KeyValueStore = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* per-device convenience only */ } },
};

export interface ProactiveContext { settings: Settings; rules: SundayRules; status: ConnectionStatus | null }
export interface ProactiveHooks {
  context: () => ProactiveContext;
  onStatus: (s: ConnectionStatus) => void;
  onCapture: (capture: SundayCapture, trigger: RunTrigger) => void;
}
export interface ProactiveDeps {
  store: KeyValueStore;
  now: () => string;
  timeZone: () => string;
  check: (ctx: ProactiveContext, onStatus: (s: ConnectionStatus) => void) => Promise<SundayCapture>;
  notify: () => Promise<void>;
  /** Fixed local copy for a failed check. */
  problem: (error: unknown) => string;
  timers: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (handle: unknown) => void };
}
export interface ProactiveView {
  prefs: ProactivePrefs;
  schedule: ScheduleState;
  history: HistoryEntry[];
  /** Newest check per organization:plan. */
  latest: Record<string, SundayCheckRecord>;
  running: boolean;
  /** Entries needing attention since the page was last opened. */
  unseen: number;
}
export interface ProactiveController {
  start(hooks: ProactiveHooks): void;
  stop(): void;
  tick(): Promise<void>;
  checkNow(): Promise<SundayCapture>;
  pause(): void;
  resume(): void;
  setPrefs(prefs: ProactivePrefs): void;
  markSeen(): void;
  view(): ProactiveView;
  subscribe(listener: () => void): () => void;
}

const KEYS = { prefs: "ozzie.proactive.prefs.v1", schedule: "ozzie.proactive.schedule.v1", history: "ozzie.proactive.history.v1", memory: "ozzie.proactive.sundays.v1", seen: "ozzie.proactive.seen.v1" };
const TICK_MS = 10_000;
const HISTORY_LIMIT = 20;
const SUNDAYS_KEPT = 6;

function read<T>(store: KeyValueStore, key: string): T | null {
  try { const raw = store.get(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; }
}
function cleanPrefs(raw: Partial<ProactivePrefs> | null): ProactivePrefs {
  const int = (v: unknown, min: number, max: number, fallback: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fallback;
  const clock = (v: unknown, fallback: string) => typeof v === "string" && parseClock(v) !== null ? v : fallback;
  return {
    intervalMinutes: int(raw?.intervalMinutes, 15, 24 * 60, DEFAULT_PREFS.intervalMinutes),
    runOnLaunch: typeof raw?.runOnLaunch === "boolean" ? raw.runOnLaunch : DEFAULT_PREFS.runOnLaunch,
    quietStart: clock(raw?.quietStart, DEFAULT_PREFS.quietStart), quietEnd: clock(raw?.quietEnd, DEFAULT_PREFS.quietEnd),
    urgentDuringQuiet: raw?.urgentDuringQuiet === true,
    urgentWithinHours: int(raw?.urgentWithinHours, 1, 7 * 24, DEFAULT_PREFS.urgentWithinHours),
  };
}
const validSchedule = (s: ScheduleState | null): s is ScheduleState =>
  s !== null && typeof s === "object" && s.version === 1 && typeof s.paused === "boolean" && typeof s.failures === "number";
const keyOf = (organization: string, planId: string) => `${organization}:${planId}`;
const worse = (e: HistoryEntry) => e.kind === "missed" || e.kind === "failed" || (e.kind === "changes" && Boolean(e.changes?.some(c => c.effect === "worse")));

export function createProactive(deps: ProactiveDeps): ProactiveController {
  let prefs = cleanPrefs(read<Partial<ProactivePrefs>>(deps.store, KEYS.prefs));
  const loaded = read<ScheduleState>(deps.store, KEYS.schedule);
  let schedule = validSchedule(loaded) ? loaded : newSchedule();
  let history = read<{ version: 1; entries: HistoryEntry[] }>(deps.store, KEYS.history)?.entries ?? [];
  // A record of another shape is dropped; the next check for that Sunday becomes a fresh baseline.
  let sundays = Object.fromEntries(Object.entries(read<{ version: 1; sundays: Record<string, SundayCheckMemory> }>(deps.store, KEYS.memory)?.sundays ?? {})
    .filter(([, m]) => m?.latest?.version === 2 && m?.known?.version === 2));
  let seenAt = read<string>(deps.store, KEYS.seen);
  let hooks: ProactiveHooks | null = null;
  let inflight: Promise<SundayCapture> | null = null;
  let launched = false;
  let timer: unknown = null;
  const listeners = new Set<() => void>();
  let snapshot: ProactiveView;

  const scheduleSettings = () => ({ intervalMinutes: prefs.intervalMinutes, runOnLaunch: prefs.runOnLaunch });
  const quiet = () => ({ start: prefs.quietStart, end: prefs.quietEnd });
  const saved = { schedule: "", history: "" };
  const save = () => {
    const s = JSON.stringify(schedule), h = JSON.stringify({ version: 1, entries: history });
    if (s !== saved.schedule) deps.store.set(KEYS.schedule, saved.schedule = s);
    if (h !== saved.history) deps.store.set(KEYS.history, saved.history = h);
  };
  const build = (): ProactiveView => ({
    prefs, schedule, history,
    latest: Object.fromEntries(Object.entries(sundays).map(([k, m]) => [k, m.latest])),
    running: inflight !== null || schedule.running !== null,
    unseen: history.filter(e => worse(e) && (!seenAt || e.at > seenAt)).length,
  });
  snapshot = build();
  const emit = () => { save(); snapshot = build(); listeners.forEach(l => l()); };
  const add = (entry: HistoryEntry) => { history = [entry, ...history].slice(0, HISTORY_LIMIT); };
  const deliver = async (): Promise<"sent" | "unavailable"> => {
    try { await deps.notify(); return "sent"; } catch { return "unavailable"; }
  };

  /** Compare with what was last known for this Sunday and decide on one notice. Never throws. */
  async function afterCapture(capture: SundayCapture, trigger: RunTrigger, rules: SundayRules, now: string) {
    if (capture.kind !== "live") return;
    const record = recordSundayCheck(capture, rules, now);
    const key = keyOf(capture.organization, capture.plan_id);
    const prior = sundays[key] ?? null;
    const { changes, memory } = compareSundayCheck(prior, record, { now, urgentWithinHours: prefs.urgentWithinHours });
    sundays = Object.fromEntries([...Object.entries({ ...sundays, [key]: memory })]
      .sort(([, a], [, b]) => b.latest.completed_at.localeCompare(a.latest.completed_at)).slice(0, SUNDAYS_KEPT));
    deps.store.set(KEYS.memory, JSON.stringify({ version: 1, sundays }));
    const about = { trigger, plan_id: capture.plan_id, plan_dates: record.plan_dates };
    if (!prior) { add({ at: now, kind: "first-check", ...about, notice: "none" }); return; }
    if (!changes.length) return;
    const found = { worse: changes.some(c => c.effect === "worse"), urgent: changes.some(c => c.urgency === "urgent") };
    let notice: HistoryEntry["notice"] = "none";
    if (found.worse && trigger === "manual") notice = "in-app";
    else if (found.worse) {
      const decision = noticeDecision(found, { quiet: quiet(), urgentDuringQuiet: prefs.urgentDuringQuiet }, now, deps.timeZone());
      if (decision === "send") notice = await deliver();
      if (decision === "hold") { schedule = holdNotice(schedule, now, found.urgent); notice = "held"; }
    }
    add({ at: now, kind: "changes", ...about, changes, notice });
  }

  function run(trigger: RunTrigger): Promise<SundayCapture> {
    const ctx = hooks!.context();
    const work = (async () => {
      try {
        const capture = await deps.check(ctx, s => hooks?.onStatus(s));
        const now = deps.now();
        try { await afterCapture(capture, trigger, ctx.rules, now); } catch { /* the check itself finished; comparing is best effort */ }
        schedule = finishRun(schedule, scheduleSettings(), now, { ok: true });
        hooks?.onCapture(capture, trigger);
        return capture;
      } catch (error) {
        const problem = deps.problem(error);
        schedule = finishRun(schedule, scheduleSettings(), deps.now(), { ok: false, problem });
        // Report the first failure in a row; retries continue quietly with backoff.
        if (schedule.failures === 1) add({ at: deps.now(), kind: "failed", trigger, problem });
        throw error;
      } finally {
        inflight = null;
        emit();
      }
    })();
    inflight = work;
    return work;
  }

  /** Held notices go out once quiet hours end, if the newest check still has something to look at. */
  const stillNeedsAttention = () => {
    const ctx = hooks?.context();
    const latest = ctx ? sundays[keyOf(ctx.settings.organization, ctx.settings.planId)]?.latest : undefined;
    return !latest || latest.status !== "checked-scope-clear";
  };

  async function tick() {
    if (!hooks) return;
    const now = deps.now();
    const released = releaseHeld(schedule, inQuietHours(quiet(), now, deps.timeZone()));
    schedule = released.state;
    const ctx = hooks.context();
    const step = tickSchedule(schedule, now, proactiveReadiness(ctx.settings, ctx.status) === "ready");
    schedule = step.state;
    if (step.missed) add({ at: now, kind: "missed", scheduled_for: step.missed });
    const running = step.start ? run(step.start) : inflight;
    if (released.deliver && stillNeedsAttention()) {
      const outcome = await deliver();
      history = history.map(e => e.notice === "held" ? { ...e, notice: outcome === "sent" ? "sent-later" : "unavailable" } : e);
    }
    emit();
    await running?.catch(() => undefined);
  }

  return {
    start(h) {
      hooks = h;
      if (!launched) {
        launched = true;
        const now = deps.now();
        const step = launchSchedule(schedule, scheduleSettings(), now);
        schedule = step.state;
        if (step.interrupted) add({ at: now, kind: "interrupted", trigger: step.interrupted.trigger, scheduled_for: step.interrupted.started_at });
        if (step.missed) add({ at: now, kind: "missed", scheduled_for: step.missed });
        emit();
      }
      if (timer === null) timer = deps.timers.setInterval(() => { void tick(); }, TICK_MS);
      void tick();
    },
    stop() {
      if (timer !== null) deps.timers.clearInterval(timer);
      timer = null;
    },
    tick,
    checkNow() {
      if (inflight) return inflight;
      if (!hooks) return Promise.reject("not-connected");
      const step = startManual(schedule, deps.now());
      if (!step.start) return Promise.reject("busy");
      schedule = step.state;
      const work = run("manual");
      emit();
      return work;
    },
    pause() { schedule = pauseSchedule(schedule); emit(); },
    resume() { schedule = resumeSchedule(schedule, deps.now()); emit(); void tick(); },
    setPrefs(next) {
      prefs = cleanPrefs(next);
      deps.store.set(KEYS.prefs, JSON.stringify(prefs));
      schedule = rescheduleFor(schedule, scheduleSettings(), deps.now());
      emit();
    },
    markSeen() {
      // Seeing the changes in the app counts as being told; a held notice isn't needed any more.
      seenAt = deps.now();
      deps.store.set(KEYS.seen, JSON.stringify(seenAt));
      if (schedule.held) {
        schedule = { ...schedule, held: null };
        history = history.map(e => e.notice === "held" ? { ...e, notice: "in-app" } : e);
      }
      emit();
    },
    view: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

let desktop: ProactiveController | null = null;
/** One controller per webview: checks run while Ozzie is open. */
export function desktopProactive(): ProactiveController {
  return desktop ??= createProactive({
    store: browserStore,
    now: () => new Date().toISOString(),
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    check: verifiedSundayCheck,
    notify: notifySundayAttention,
    problem: sundayProblem,
    timers: { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>) },
  });
}
