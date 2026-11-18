import { invoke } from "@tauri-apps/api/core";
import { connection, type ConnectionStatus } from "./connection.js";
import { sundayProblem, sundaySource, type Settings } from "./sunday-source.js";
import { desktopRecorder } from "./harness-bridge.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import {
  changeStillHolds, compareSundayCheck, DEFAULT_URGENT_WITHIN_HOURS, recordSundayCheck, type SundayChange, type SundayCheckMemory, type SundayCheckRecord,
} from "../../../core/src/sunday-changes.js";
import {
  DEFAULT_QUIET_HOURS, DEFAULT_SCHEDULE, finishRun, holdNotice, inQuietHours, launchSchedule, newSchedule, noticeDecision, parseClock,
  pauseSchedule, releaseHeld, rescheduleFor, resumeSchedule, settledQuietHours, startManual, tickSchedule, type RunTrigger, type ScheduleState,
} from "../../../core/src/schedule.js";
import { changeFindingKind, feedbackOf, foundOf, rightAwayChanges, routeChanges } from "../../../core/src/finding-feedback.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { thisMacOnly, type NoticeOptions } from "./phone-notice.js";
import { noticeDayOf } from "./day-phrases.js";
import type { NoticeDay } from "./onboarding-bridge.js";

/**
 * The Sunday check the app has always run: re-verify a saved connection when needed, then read.
 * Shared by "Check Planning Center now" and the schedule so both behave the same.
 */
export async function verifiedSundayCheck(ctx: { settings: Settings; status: ConnectionStatus | null; rules?: SundayRules }, onStatus: (s: ConnectionStatus) => void): Promise<SundayCapture> {
  // A saved connection must be re-verified after a restart, or after its sign-in couldn't be renewed. While it is
  // connected, native code renews the sign-in (its access lasts about two hours) before a read that finds it running
  // out (main.rs renewed_auth), so this isn't needed for that.
  if (ctx.status?.state !== "connected") {
    const verified = await connection.refresh(ctx.settings.clientId, ctx.settings.organization, true);
    onStatus(verified);
    if (verified.state !== "connected") throw "not-connected";
  }
  // The rules in use for this church (App's, never another church's kids teams), else this Mac's saved ones.
  return sundaySource.check(ctx.settings.serviceTypeId, ctx.settings.planId, ctx.rules);
}

/**
 * Lock-screen privacy: the title and body are fixed in native code; the webview passes no text at all. Its two closed
 * words: "this Mac only", which keeps the phone line of "A notice on your phone" back (phone-notice.ts) and never adds
 * one, and the day (native contract N8: a weekday, "weekend" or "service"), which picks the fixed line that names the
 * watched service's real day. Absent, native says "Service coverage needs attention".
 */
export const notifySundayAttention = (options?: NoticeOptions) => {
  const args = { ...(options?.localOnly ? { localOnly: true } : {}), ...(options?.day ? { day: options.day } : {}) };
  return Object.keys(args).length ? invoke<void>("notify_sunday_attention", args) : invoke<void>("notify_sunday_attention");
};
/** Whether the Sunday notice for these changes stays on this Mac: every one is about a background check. Kinds only. */
const macOnlyFor = (changes: readonly SundayChange[]) => thisMacOnly(changes.map(c => c.finding?.kind ?? changeFindingKind(c.kind)));

/**
 * On launch nothing is connected in memory yet, so automatic checks would wait forever: check the saved sign-in once
 * (a Planning Center userinfo read and token refresh, nothing else) when an organization is set and nothing has
 * started. Returns the verified status, or null when there was nothing to check or the check couldn't run.
 */
export async function verifySavedOnLaunch(settings: Settings, status: ConnectionStatus | null,
  refresh: (clientId: string, organization: string, registered: boolean) => Promise<ConnectionStatus> = connection.refresh): Promise<ConnectionStatus | null> {
  if (status !== null || !/^[1-9]\d{0,31}$/.test(settings.organization)) return null;
  try { return await refresh(settings.clientId, settings.organization, true); } catch { return null; }
}

export type Readiness = "ready" | "not-configured" | "not-connected";
/** Automatic checks need a chosen Sunday and a saved connection. Never during sign-in: re-checking would cancel it. */
export function proactiveReadiness(settings: Settings, status: ConnectionStatus | null): Readiness {
  // An empty client ID means Ozzie's own registration (one-click connect).
  if (!/^[1-9]\d{0,31}$/.test(settings.organization) || !/^\d+$/.test(settings.serviceTypeId) || !/^\d+$/.test(settings.planId)) return "not-configured";
  // The connection must be for the organization in Settings (one may have been typed under Advanced since).
  return (status?.state === "connected" || status?.state === "stored-unchecked") && status.organization === settings.organization ? "ready" : "not-connected";
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
  /**
   * What happened to the notice for this entry. "in-app": a person was already looking. "briefing": every
   * change that got worse is a kind the person's Church rules keep for the briefing. "handed": waiting on
   * Keep Sunday covered's run; "responsibility": that run decided the notice, so this check sent none.
   */
  notice?: "sent" | "held" | "sent-later" | "in-app" | "unavailable" | "briefing" | "handed" | "responsibility" | "none";
  scheduled_for?: string;
  problem?: string;
}

export interface KeyValueStore { get(key: string): string | null; set(key: string, value: string): void }
/** localStorage, best effort: a blocked or full store never breaks a check. */
export const browserStore: KeyValueStore = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* per-device convenience only */ } },
};

export interface ProactiveContext {
  settings: Settings; rules: SundayRules; status: ConnectionStatus | null;
  /**
   * The day the coverage notice names (day-phrases.ts `noticeDayOf` of the watched service's day words), when App knows
   * it. Absent: the day of the plan this check last read ("sunday" only when that plan is on a Sunday), else none, which
   * native says as "Service coverage".
   */
  noticeDay?: NoticeDay;
}
export interface ProactiveHooks {
  context: () => ProactiveContext;
  onStatus: (s: ConnectionStatus) => void;
  onCapture: (capture: SundayCapture, trigger: RunTrigger) => void;
  /**
   * What an automatic check found changed (person ids only), so a responsibility can check sooner. `about`:
   * the Sunday it is about, and whether this check has a notice to send. A promise means Keep Sunday covered
   * took the changes: this check sends no notice of its own unless it resolves false (that run was refused,
   * failed, was paused or decided nothing), so one change brings at most one notice.
   */
  onChanges?: (changes: SundayChange[], about: { plan_id: string; notice: boolean }) => Promise<boolean> | void;
}
export interface ProactiveDeps {
  store: KeyValueStore;
  now: () => string;
  timeZone: () => string;
  /**
   * One Sunday check. `trigger` is how it started (the desktop records each check in the task ledger);
   * `source` overrides how the ledger records it (a responsibility's run is automatic, though it asks like Check now).
   */
  check: (ctx: ProactiveContext, onStatus: (s: ConnectionStatus) => void, trigger: RunTrigger, source?: "manual" | "automatic") => Promise<SundayCapture>;
  /** The coverage notice; `localOnly` when only background checks brought it (its phone line stays back), `day` its fixed line's day. */
  notify: (options?: NoticeOptions) => Promise<void>;
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
  /**
   * "Check now", and the check a responsibility's run makes (`source` "automatic" for the ledger). Either
   * way its changes show in Ozzie and never send the Sunday notice; the responsibility decides on notices.
   */
  checkNow(source?: "manual" | "automatic"): Promise<SundayCapture>;
  pause(): void;
  resume(): void;
  /**
   * "Pause everything" (menu bar or What runs automatically) pauses this check too; lifting it restores
   * this check to what it was before (paused on its own stays paused). Either way a held notice is dropped.
   */
  pauseWithEverything(paused: boolean): void;
  setPrefs(prefs: ProactivePrefs): void;
  markSeen(): void;
  view(): ProactiveView;
  subscribe(listener: () => void): () => void;
}

const KEYS = {
  prefs: "ozzie.proactive.prefs.v1", schedule: "ozzie.proactive.schedule.v1", history: "ozzie.proactive.history.v1", memory: "ozzie.proactive.sundays.v1", seen: "ozzie.proactive.seen.v1",
  everything: "ozzie.proactive.everything.v1",
};
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
/** Saved preferences carry this once the settled defaults (owner decision, October 26) have been applied to them. */
const SETTLED = 1;
/**
 * Saved preferences, with quiet hours moved to the settled default (9:00 PM to 7:00 AM) only when they
 * still equal the earlier default and haven't been settled before. A person's own choice is never changed.
 */
export function loadPrefs(store: KeyValueStore): ProactivePrefs {
  const raw = read<Partial<ProactivePrefs> & { settled?: number }>(store, KEYS.prefs);
  const prefs = cleanPrefs(raw);
  if (!raw || raw.settled === SETTLED) return prefs;
  const quiet = settledQuietHours({ start: prefs.quietStart, end: prefs.quietEnd });
  const settled = { ...prefs, quietStart: quiet.start, quietEnd: quiet.end };
  savePrefs(store, settled);
  return settled;
}
const savePrefs = (store: KeyValueStore, prefs: ProactivePrefs) => store.set(KEYS.prefs, JSON.stringify({ ...prefs, settled: SETTLED }));
const validSchedule = (s: ScheduleState | null): s is ScheduleState =>
  s !== null && typeof s === "object" && s.version === 1 && typeof s.paused === "boolean" && typeof s.failures === "number";
const keyOf = (organization: string, planId: string) => `${organization}:${planId}`;
const worse = (e: HistoryEntry) => e.kind === "missed" || e.kind === "failed" || (e.kind === "changes" && Boolean(e.changes?.some(c => c.effect === "worse")));

export function createProactive(deps: ProactiveDeps): ProactiveController {
  let prefs = loadPrefs(deps.store);
  const loaded = read<ScheduleState>(deps.store, KEYS.schedule);
  let schedule = validSchedule(loaded) ? loaded : newSchedule();
  let history = read<{ version: 1; entries: HistoryEntry[] }>(deps.store, KEYS.history)?.entries ?? [];
  // A record of another shape is dropped; the next check for that Sunday becomes a fresh baseline.
  const remembered = read<{ version: 1; sundays: Record<string, SundayCheckMemory>; found?: Record<string, string[]> }>(deps.store, KEYS.memory);
  let sundays = Object.fromEntries(Object.entries(remembered?.sundays ?? {})
    .filter(([, m]) => m?.latest?.version === 2 && m?.known?.version === 2));
  /** The finding keys (ids only) the newest check of each Sunday showed, so a kind told right away is told when it is new. */
  let foundBy: Record<string, string[]> = Object.fromEntries(Object.entries(remembered?.found ?? {})
    .filter(([k, keys]) => Object.hasOwn(sundays, k) && Array.isArray(keys) && keys.every(x => typeof x === "string")));
  let seenAt = read<string>(deps.store, KEYS.seen);
  /** While "Pause everything" is on: whether this check was paused on its own, to restore when it's lifted. */
  let beforeEverything = read<{ paused: boolean }>(deps.store, KEYS.everything);
  const setBefore = (value: { paused: boolean } | null) => { beforeEverything = value; deps.store.set(KEYS.everything, JSON.stringify(value)); };
  /** Pausing drops a held notice; its entry stops saying it is waiting. */
  const pauseNow = () => {
    schedule = pauseSchedule(schedule);
    history = history.map(e => e.notice === "held" ? { ...e, notice: "none" } : e);
  };
  let hooks: ProactiveHooks | null = null;
  /** The real day of the plan the last check read, for the notice when App doesn't say (ProactiveContext `noticeDay`). */
  let checkedDay: NoticeDay | null = null;
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
  /**
   * `macOnly`: only background checks brought it, so "A notice on your phone" leaves it on this Mac. The notice names the
   * watched service's day by a closed code, never text.
   */
  const deliver = async (macOnly: boolean): Promise<"sent" | "unavailable"> => {
    const day = hooks?.context().noticeDay ?? checkedDay;
    const options: NoticeOptions = { ...(macOnly ? { localOnly: true as const } : {}), ...(day ? { day } : {}) };
    try { await (Object.keys(options).length ? deps.notify(options) : deps.notify()); return "sent"; } catch { return "unavailable"; }
  };

  /** Compare with what was last known for this Sunday and decide on one notice. Never throws. */
  async function afterCapture(capture: SundayCapture, trigger: RunTrigger, rules: SundayRules, now: string) {
    if (capture.kind !== "live") return;
    const record = recordSundayCheck(capture, rules, now);
    const key = keyOf(capture.organization, capture.plan_id);
    const prior = sundays[key] ?? null;
    const { changes, memory } = compareSundayCheck(prior, record, { now, urgentWithinHours: prefs.urgentWithinHours });
    // Every finding this check shows, kids teams, rooms and follow-ups included, with what the last check of this Sunday showed.
    const entries = feedbackOf(rules);
    const brief = buildSundayBrief(capture, rules, now);
    checkedDay = noticeDayOf(brief.day);
    const shown = foundOf(brief, sundayOperations(capture, rules, { now }));
    const before = prior ? foundBy[key] ?? null : null;
    sundays = Object.fromEntries([...Object.entries({ ...sundays, [key]: memory })]
      .sort(([, a], [, b]) => b.latest.completed_at.localeCompare(a.latest.completed_at)).slice(0, SUNDAYS_KEPT));
    foundBy = Object.fromEntries(Object.keys(sundays).flatMap(k => k === key ? [[k, shown.map(f => f.key)]] : foundBy[k] ? [[k, foundBy[k]]] : []));
    deps.store.set(KEYS.memory, JSON.stringify({ version: 1, sundays, found: foundBy }));
    const about = { trigger, plan_id: capture.plan_id, plan_dates: record.plan_dates };
    if (!prior) { add({ at: now, kind: "first-check", ...about, notice: "none" }); return; }
    // The person's Church rules on notices: kinds kept for the briefing, kinds told right away (a kind the Sunday
    // comparison doesn't follow is told when this check newly finds one), and what they asked Ozzie to stop
    // flagging (left out here altogether, as they are on the Sunday page).
    const all = [...changes, ...rightAwayChanges(shown, before, entries)];
    const routed = routeChanges(all, entries);
    const listed = all.filter(c => !routed.stopped.includes(c));
    if (!listed.length) return;
    const found = { worse: routed.notify.length > 0, urgent: routed.urgent, macOnly: macOnlyFor(routed.notify) };
    // Keep Sunday covered is handed the Sunday's own changes. A new finding told right away is this check's notice
    // to send, so then nothing is handed over and one notice goes out.
    const own = routed.notify.some(c => c.kind === "finding-new");
    const sunday = listed.filter(c => c.kind !== "finding-new");
    let handed: Promise<boolean> | void = undefined;
    if (trigger !== "manual" && !own && sunday.length) {
      try { handed = hooks?.onChanges?.(sunday, { plan_id: capture.plan_id, notice: found.worse }); } catch { /* the check itself finished */ }
    }
    let notice: HistoryEntry["notice"] = "none";
    if (found.worse && trigger === "manual") notice = "in-app";
    else if (found.worse && handed) { notice = "handed"; void afterHandoff(now, handed, found); }
    else if (found.worse) notice = await decide(found, now);
    else if (routed.briefing.length && trigger !== "manual") notice = "briefing";
    add({ at: now, kind: "changes", ...about, changes: listed, notice });
  }
  /** Send the notice now, or hold it for quiet hours (unless the person let urgent ones through). */
  async function decide(found: { worse: boolean; urgent: boolean; macOnly: boolean }, now: string): Promise<NonNullable<HistoryEntry["notice"]>> {
    const decision = noticeDecision(found, { quiet: quiet(), urgentDuringQuiet: prefs.urgentDuringQuiet }, now, deps.timeZone());
    if (decision === "send") return deliver(found.macOnly);
    if (decision === "hold") { schedule = holdNotice(schedule, now, found.urgent); return "held"; }
    return "none";
  }
  /**
   * Changes handed to Keep Sunday covered: its run sends the notice, with the notes it prepared. If it
   * doesn't decide one, this check's notice goes out after all, as it would have (quiet hours still hold
   * it), so nothing goes silent. Paused meanwhile: dropped, as a held notice is. Seen in Ozzie meanwhile:
   * that counts as being told.
   */
  async function afterHandoff(at: string, handed: Promise<boolean>, found: { worse: boolean; urgent: boolean; macOnly: boolean }) {
    const decided = await handed.catch(() => false);
    const outcome: NonNullable<HistoryEntry["notice"]> = decided ? "responsibility" : schedule.paused ? "none"
      : seenAt && seenAt >= at ? "in-app" : await decide(found, deps.now());
    history = history.map(e => e.at === at && e.kind === "changes" && e.notice === "handed" ? { ...e, notice: outcome } : e);
    emit();
  }

  function run(trigger: RunTrigger, source?: "manual" | "automatic"): Promise<SundayCapture> {
    const ctx = hooks!.context();
    const work = (async () => {
      try {
        const capture = await deps.check(ctx, s => hooks?.onStatus(s), trigger, ...(source ? [source] as const : []));
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

  /**
   * A held entry still worth its notice once quiet hours end (owner decision: a held notice is rechecked for
   * relevance before it goes out). Rechecked against the newest saved check of the same Sunday, with no new
   * Planning Center read: a change reversed meanwhile (a decline restored, the extra request gone) no longer
   * counts, and neither does one the person's Church rules now keep out of notices. With no saved check of
   * that Sunday to recheck against, its changes stand as they were found. Returns the changes that still bring it
   * (none: no notice needed), so a notice only about background checks still stays on this Mac.
   */
  const stillNotifying = (entry: HistoryEntry): SundayChange[] => {
    const ctx = hooks?.context();
    const own = ctx && entry.plan_id ? keyOf(ctx.settings.organization, entry.plan_id) : undefined;
    const key = own && sundays[own] ? own : Object.keys(sundays).find(k => sundays[k]!.latest.plan_id === entry.plan_id);
    const memory = key ? sundays[key] : undefined;
    const holding = (entry.changes ?? []).filter(c => !memory || changeStillHolds(c, memory, foundBy[key!] ?? null));
    return routeChanges(holding, feedbackOf(ctx?.rules ?? {})).notify;
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
    if (released.deliver) {
      // One notice for whatever is still so; a held entry that no longer is says no notice was needed.
      const still = new Map(history.filter(e => e.notice === "held").map(e => [e, stillNotifying(e)] as const).filter(([, c]) => c.length > 0));
      const relevant = new Set(still.keys());
      const outcome = relevant.size ? await deliver(macOnlyFor([...still.values()].flat())) : null;
      history = history.map(e => e.notice !== "held" ? e : { ...e, notice: !relevant.has(e) ? "none" : outcome === "sent" ? "sent-later" : "unavailable" });
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
        // Ozzie closed while Keep Sunday covered had changes this check handed it: its notice waits like a
        // held one and goes out at the next tick outside quiet hours, so nothing goes silent.
        const handed = history.filter(e => e.notice === "handed");
        if (handed.length) {
          const urgent = handed.some(e => routeChanges(e.changes ?? [], feedbackOf(h.context().rules)).urgent);
          if (!schedule.paused) schedule = holdNotice(schedule, now, urgent);
          history = history.map(e => e.notice === "handed" ? { ...e, notice: schedule.paused ? "none" : "held" } : e);
        }
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
    checkNow(source) {
      if (inflight) return inflight;
      if (!hooks) return Promise.reject("not-connected");
      const step = startManual(schedule, deps.now());
      if (!step.start) return Promise.reject("busy");
      schedule = step.state;
      const work = run("manual", source);
      emit();
      return work;
    },
    // A person pausing or resuming this check while everything is paused is what it returns to afterwards.
    pause() { if (beforeEverything) setBefore({ paused: true }); pauseNow(); emit(); },
    resume() { if (beforeEverything) setBefore({ paused: false }); schedule = resumeSchedule(schedule, deps.now()); emit(); void tick(); },
    pauseWithEverything(paused) {
      if (paused) {
        if (!beforeEverything) setBefore({ paused: schedule.paused });
        if (!schedule.paused) { pauseNow(); emit(); }
        return;
      }
      const before = beforeEverything;
      if (!before) return;
      setBefore(null);
      if (!before.paused && schedule.paused) { schedule = resumeSchedule(schedule, deps.now()); emit(); void tick(); }
    },
    setPrefs(next) {
      prefs = cleanPrefs(next);
      savePrefs(deps.store, prefs);
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
    // Every check, automatic or manual, is a "check" task in the task ledger. No model is involved.
    check: (ctx, onStatus, trigger, source) => desktopRecorder().check(() => verifiedSundayCheck(ctx, onStatus), source ?? (trigger === "manual" ? "manual" : "automatic")),
    notify: notifySundayAttention,
    problem: sundayProblem,
    timers: { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>) },
  });
}
