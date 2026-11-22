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
import { changeFindingKind, feedbackOf, foundOf, rightAwayChanges, routeChanges, stableFindingKey } from "../../../core/src/finding-feedback.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { roomsReadComplete, sundayOperations, type OperationsOptions, type SundayOperations } from "../../../core/src/operations-capture.js";
import { localDate } from "../../../core/src/church-time.js";
import { thisMacOnly, type NoticeOptions } from "./phone-notice.js";
import { withFormsOn } from "../../../core/src/church-reads/rules.js";
import { noticeDayOf } from "./day-phrases.js";
import type { NoticeDay } from "./onboarding-bridge.js";
import type { CheckFound } from "./harness-words.js";
import type { SystemConnection } from "./church-system.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";

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

/**
 * A church on B1 Church or Breeze, as its checks see it: the connection this Mac keeps when the check starts, and the read
 * of its watched service (App's: moving on to the next service once the day has passed, then native's read). The read
 * throws a SystemReadFailure when it brings no capture.
 */
export interface SystemWatch { connection: SystemConnection; read: () => Promise<SystemCapture> }
/** A system check that brought no capture, by native's closed outcome word. */
export class SystemReadFailure extends Error {
  /** `church`: the church read, when known, so a failure is never said of another church connected since. */
  constructor(readonly system: SystemConnection["system"] | "genesis", readonly outcome: string, readonly church: string | null = null) { super(outcome); }
}
export interface ProactiveContext {
  settings: Settings; rules: SundayRules; status: ConnectionStatus | null;
  /** A church on B1 Church or Breeze with a service to watch; absent or null otherwise (its checks then don't run). */
  system?: SystemWatch | null;
  /**
   * The day the coverage notice names (day-phrases.ts `noticeDayOf` of the watched service's day words), when App knows
   * it. Absent: the day of the plan this check last read ("sunday" only when that plan is on a Sunday), else none, which
   * native says as "Service coverage".
   */
  noticeDay?: NoticeDay;
  /**
   * The other services Ozzie watches (watched-services.ts, owner decision 2026-11-19), Planning Center only: each is read
   * in the same round, one after another, after the one Settings names, and compared with its own last check. Absent or
   * empty: one service, exactly as before.
   */
  also?: readonly AlsoPlan[];
  /**
   * With more than one service watched (0.7.0): whether this check of a watched service shows its church-local day's room
   * bookings, as the Services page decides it (services-merge.ts roomsHolders, over every watched service's latest check
   * with this one in its place). Only that service's check compares and tells that day's rooms. Absent: always.
   */
  holdsRooms?: (capture: SundayCapture, now: string) => boolean;
}
/** One more watched service's plan, as a round reads it. */
export interface AlsoPlan { serviceTypeId: string; planId: string }
export interface ProactiveHooks<C = SundayCapture> {
  context: () => ProactiveContext;
  onStatus: (s: ConnectionStatus) => void;
  onCapture: (capture: C, trigger: RunTrigger) => void;
  /** A check that ended without a capture, whatever started it (a church on another system says why on its page). */
  onFailure?: (error: unknown, trigger: RunTrigger) => void;
  /**
   * What an automatic check found changed (person ids only), so a responsibility can check sooner. `about`:
   * the Sunday it is about, and whether this check has a notice to send. A promise means Keep Sunday covered
   * took the changes: this check sends no notice of its own unless it resolves false (that run was refused,
   * failed, was paused or decided nothing), so one change brings at most one notice.
   */
  onChanges?: (changes: SundayChange[], about: { plan_id: string; notice: boolean }) => Promise<boolean> | void;
  /** A check of one of the other services watched (ProactiveContext `also`), in the same round. */
  onAlsoCapture?: (capture: C, trigger: RunTrigger) => void;
  /** A check of one of them that brought nothing: its own page part says so; the round goes on with the rest. */
  onAlsoFailure?: (planId: string, error: unknown, trigger: RunTrigger) => void;
  /** A check of one of them that ended after it stopped being watched: its saved copy is deleted, nothing else is kept. */
  onAlsoDropped?: (capture: C) => void;
}
/**
 * What a finished check is compared by: the church and service it is of, its name-free record (sunday-changes.ts), the
 * brief and rooms it shows, and whether every read completed. Null: not a live read of the church watched now, so nothing
 * is compared, kept or told.
 */
export interface CheckDigest {
  /** The church: Planning Center's organization, or `<system>:<church id>`. */
  owner: string;
  plan_id: string;
  record: SundayCheckRecord;
  brief: SundayBrief;
  ops: SundayOperations | null;
  /** Every read ended whole (or wasn't asked for): only then can a check count as having found nothing new. */
  complete: boolean;
}
/**
 * Planning Center's live check, as the schedule has always compared it. `part`: for another service than the first, the
 * rooms and group meetings its part of the Services page shows (core operations-capture.ts OperationsOptions).
 */
export function sundayDigest(capture: SundayCapture, ctx: ProactiveContext, now: string, part: Pick<OperationsOptions, "followUps" | "rooms"> = {}): CheckDigest | null {
  if (capture.kind !== "live") return null;
  return {
    owner: capture.organization, plan_id: capture.plan_id, record: recordSundayCheck(capture, ctx.rules, now),
    brief: buildSundayBrief(capture, ctx.rules, now), ops: sundayOperations(capture, ctx.rules, { now, ...part }),
    complete: capture.reads.every(r => r.outcome === "ok" || r.outcome === "not-requested"),
  };
}
/** Where a controller keeps its state on this Mac. Preferences are the person's own, shared by every controller. */
export interface ProactiveKeys { prefs: string; schedule: string; history: string; memory: string; seen: string; everything: string }
export interface ProactiveDeps<C = SundayCapture> {
  store: KeyValueStore;
  /** Where its state is kept; Planning Center's keys by default. */
  keys?: ProactiveKeys;
  now: () => string;
  timeZone: () => string;
  /**
   * One Sunday check. `trigger` is how it started (the desktop records each check in the task ledger);
   * `source` overrides how the ledger records it (a responsibility's run is automatic, though it asks like Check now).
   * `onTask`: told the check's task id in the ledger, when it has one.
   */
  check: (ctx: ProactiveContext, onStatus: (s: ConnectionStatus) => void, trigger: RunTrigger, source?: "manual" | "automatic",
    onTask?: (taskId: string) => void) => Promise<C>;
  /**
   * What a finished check is compared by (CheckDigest); Planning Center's `sundayDigest` by default. `part`: for another
   * service than the first, which of its rooms and group meetings it holds (sundayDigest).
   */
  digest?: (capture: C, ctx: ProactiveContext, now: string, part?: Pick<OperationsOptions, "followUps" | "rooms">) => CheckDigest | null;
  /** Whether a check may start on its own now; Planning Center's `proactiveReadiness` by default. */
  ready?: (ctx: ProactiveContext) => boolean;
  /** The church whose saved checks a held notice is rechecked against; Planning Center's organization by default. */
  owner?: (ctx: ProactiveContext) => string | undefined;
  /**
   * Whether a check that started with `start` is still of the church watched at `end`. A failed check of a church let go
   * meanwhile isn't charged to the one watched now (no "couldn't finish", no retry count, no history). Always by default.
   */
  same?: (start: ProactiveContext, end: ProactiveContext) => boolean;
  /** Keeps what a finished check found (closed words) beside its task, for What happened. Best effort. */
  found?: (taskId: string, found: CheckFound) => void;
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
export interface ProactiveController<C = SundayCapture> {
  start(hooks: ProactiveHooks<C>): void;
  stop(): void;
  tick(): Promise<void>;
  /**
   * "Check now", and the check a responsibility's run makes (`source` "automatic" for the ledger). Either
   * way its changes show in Ozzie and never send the Sunday notice; the responsibility decides on notices.
   */
  checkNow(source?: "manual" | "automatic"): Promise<C>;
  pause(): void;
  resume(): void;
  /**
   * "Pause everything" (menu bar or What runs automatically) pauses this check too; lifting it restores
   * this check to what it was before (paused on its own stays paused). Either way a held notice is dropped.
   */
  pauseWithEverything(paused: boolean): void;
  setPrefs(prefs: ProactivePrefs): void;
  /**
   * The church watched is let go (a disconnect, a switch of system or church): a notice held for quiet hours is dropped,
   * so nothing about that church is told afterwards, and what changed and how its last check went are cleared. Its saved
   * Sundays stay, name-free, as they do for Planning Center.
   */
  letGo(): void;
  /**
   * A service no longer watched (watched-services.ts removeService): what was kept of its plans' checks here (their
   * name-free records and what changed in them) is forgotten. Its saved checks on disk are App's to delete.
   */
  forgetPlans(planIds: readonly string[]): void;
  markSeen(): void;
  view(): ProactiveView;
  subscribe(listener: () => void): () => void;
}

const KEYS: ProactiveKeys = {
  prefs: "ozzie.proactive.prefs.v1", schedule: "ozzie.proactive.schedule.v1", history: "ozzie.proactive.history.v1", memory: "ozzie.proactive.sundays.v1", seen: "ozzie.proactive.seen.v1",
  everything: "ozzie.proactive.everything.v1",
};
/** A church on B1 Church or Breeze: its own schedule, history and checks, and the person's own preferences. */
export const SYSTEM_KEYS: ProactiveKeys = {
  prefs: KEYS.prefs, schedule: "ozzie.proactive.system.schedule.v1", history: "ozzie.proactive.system.history.v1", memory: "ozzie.proactive.system.sundays.v1",
  seen: "ozzie.proactive.system.seen.v1", everything: "ozzie.proactive.system.everything.v1",
};
const KEYS_PC = KEYS;
const TICK_MS = 10_000;
const HISTORY_LIMIT = 20;
/** Days whose room clashes are kept (ProactiveController `days`): a few weeks of every watched service's days. */
const DAYS_KEPT = 24;
/** Each watched service's newest checks (up to four services, watched-services.ts MAX_WATCHED). */
const SUNDAYS_KEPT = 12;

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
export function loadPrefs(store: KeyValueStore, key = KEYS.prefs): ProactivePrefs {
  const raw = read<Partial<ProactivePrefs> & { settled?: number }>(store, key);
  const prefs = cleanPrefs(raw);
  if (!raw || raw.settled === SETTLED) return prefs;
  const quiet = settledQuietHours({ start: prefs.quietStart, end: prefs.quietEnd });
  const settled = { ...prefs, quietStart: quiet.start, quietEnd: quiet.end };
  savePrefs(store, settled, key);
  return settled;
}
const savePrefs = (store: KeyValueStore, prefs: ProactivePrefs, key = KEYS.prefs) => store.set(key, JSON.stringify({ ...prefs, settled: SETTLED }));
const validSchedule = (s: ScheduleState | null): s is ScheduleState =>
  s !== null && typeof s === "object" && s.version === 1 && typeof s.paused === "boolean" && typeof s.failures === "number";
const keyOf = (organization: string, planId: string) => `${organization}:${planId}`;
const worse = (e: HistoryEntry) => e.kind === "missed" || e.kind === "failed" || (e.kind === "changes" && Boolean(e.changes?.some(c => c.effect === "worse")));
const sameKeys = (a: readonly string[], b: readonly string[]) => { const before = new Set(a), now = new Set(b); return before.size === now.size && [...now].every(k => before.has(k)); };
/** Two checks' name-free facts (each role, lead and who is scheduled and how), apart from when each finished. */
const sameFacts = (a: SundayCheckRecord, b: SundayCheckRecord) => JSON.stringify({ ...a, completed_at: "" }) === JSON.stringify({ ...b, completed_at: "" });
/**
 * When things were read, and the row-order ids and "Why I flagged this" lines that carry it: left out of a check's print.
 * So are a role's plain reasons under its card's title (`role_facts`), which repeat Why I flagged this in the system's
 * order: the print is as it was before they were shown (polish 2026-11-21).
 */
const READ_TIMES: ReadonlySet<string> = new Set(["id", "why", "source", "checked_at", "check_time", "valid_until", "evaluated_at", "stale", "role_facts"]);
/**
 * What a check shows, as a short hash (cyrb53): the service page's findings and, while current, its rooms, follow-ups and
 * group meetings, without when anything was read. Two checks that show the same have the same print. Ids and fixed words
 * go in; only the hash is kept. A room or follow-up finding's id names the read it came from (its binding's access_epoch
 * is the check's start, operations-capture.ts), so it goes in as its stable key, as foundOf keeps it.
 */
function shownPrint(brief: SundayBrief, ops: SundayOperations | null): string {
  const fresh = ops && !ops.stale ? ops : null;
  const result = fresh?.result ? { status: fresh.result.status, findings: fresh.result.findings, uncertainties: fresh.result.uncertainties, unchecked: fresh.result.unchecked_scope_ids } : null;
  const text = JSON.stringify([brief.findings, result, fresh?.group_meetings ?? null],
    (k, v: unknown) => READ_TIMES.has(k) ? undefined : k === "finding_id" && typeof v === "string" ? stableFindingKey(v) : v);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
/** A room overlap's kept key (stableFindingKey of its finding id, operations-findings `["room", …]`). */
const isRoomKey = (k: string) => k.startsWith('["room",');
/** A kept key of a room overlap, a follow-up or a group meeting: none in what was kept of a check compared without them. */
const isOpsKey = (k: string) => isRoomKey(k) || k.startsWith('["follow-up",') || k.startsWith("group:");
/** The Sunday the newest kept check was of. */
const newestOf = (sundays: Record<string, SundayCheckMemory>) =>
  Object.entries(sundays).sort(([, a], [, b]) => b.latest.completed_at.localeCompare(a.latest.completed_at))[0]?.[0] ?? null;

export function createProactive<C = SundayCapture>(deps: ProactiveDeps<C>): ProactiveController<C> {
  const KEYS = deps.keys ?? KEYS_PC;
  const digestOf = deps.digest ?? (sundayDigest as unknown as NonNullable<ProactiveDeps<C>["digest"]>);
  const readyNow = deps.ready ?? ((ctx: ProactiveContext) => proactiveReadiness(ctx.settings, ctx.status) === "ready");
  const ownerOf = deps.owner ?? ((ctx: ProactiveContext) => ctx.settings.organization);
  let prefs = loadPrefs(deps.store, KEYS.prefs);
  const loaded = read<ScheduleState>(deps.store, KEYS.schedule);
  let schedule = validSchedule(loaded) ? loaded : newSchedule();
  let history = read<{ version: 1; entries: HistoryEntry[] }>(deps.store, KEYS.history)?.entries ?? [];
  // A record of another shape is dropped; the next check for that Sunday becomes a fresh baseline.
  const remembered = read<{ version: 1; sundays: Record<string, SundayCheckMemory>; found?: Record<string, string[]>; prints?: Record<string, string>; round?: unknown;
    days?: unknown }>(deps.store, KEYS.memory);
  let sundays = Object.fromEntries(Object.entries(remembered?.sundays ?? {})
    .filter(([, m]) => m?.latest?.version === 2 && m?.known?.version === 2));
  /** The finding keys (ids only) the newest check of each Sunday showed, so a kind told right away is told when it is new. */
  let foundBy: Record<string, string[]> = Object.fromEntries(Object.entries(remembered?.found ?? {})
    .filter(([k, keys]) => Object.hasOwn(sundays, k) && Array.isArray(keys) && keys.every(x => typeof x === "string")));
  /** The print (shownPrint) of what the newest check of each Sunday showed, so a check can say it found nothing new. */
  let printBy: Record<string, string> = Object.fromEntries(Object.entries(remembered?.prints ?? {})
    .filter(([k, p]) => Object.hasOwn(sundays, k) && typeof p === "string"));
  /**
   * The services (owner:plan) the last round read, one check of each watched service: a check can find "nothing new" only
   * when its service was read in the round before (with one service, the check right before was of it, as always).
   * Unknown (a Mac that kept none): the newest check kept, as before.
   */
  let lastRound: string[] = Array.isArray(remembered?.round) ? remembered.round.filter((k): k is string => typeof k === "string" && Object.hasOwn(sundays, k)) : [];
  /**
   * With more than one service watched: each church-local day's room clashes as the service showing that day's rooms
   * (services-merge.ts roomsHolders) last showed them in a full read, by `<church>\u0000<YYYY-MM-DD>`, so a clash a day's
   * rooms carried from one service to another is never told as new, across a restart too. Kept with the memory as an
   * optional `days` field (older versions ignore it): ids only, the room-overlap keys foundOf keeps, never a name.
   */
  let roomsOfDay: Record<string, string[]> = Object.fromEntries(Object.entries(remembered?.days && typeof remembered.days === "object" ? remembered.days as Record<string, unknown> : {})
    .filter((e): e is [string, string[]] => Array.isArray(e[1]) && e[1].every(k => typeof k === "string" && isRoomKey(k))).slice(-DAYS_KEPT));
  /** This round so far, and whether its one notice already went: one round of checks sends at most one coverage notice. */
  let thisRound: string[] = [];
  let roundSent: { macOnly: boolean } | null = null;
  /** The real day of each plan a check read lately, for a held notice about one of the other services. */
  const dayByPlan = new Map<string, NoticeDay>();
  /** How many checks of each other service failed in a row: only the first is put in the history. */
  const alsoFailures = new Map<string, number>();
  const saveMemory = () => deps.store.set(KEYS.memory, JSON.stringify({ version: 1, sundays, found: foundBy, prints: printBy, round: lastRound,
    ...(Object.keys(roomsOfDay).length ? { days: roomsOfDay } : {}) }));
  let seenAt = read<string>(deps.store, KEYS.seen);
  /** While "Pause everything" is on: whether this check was paused on its own, to restore when it's lifted. */
  let beforeEverything = read<{ paused: boolean }>(deps.store, KEYS.everything);
  const setBefore = (value: { paused: boolean } | null) => { beforeEverything = value; deps.store.set(KEYS.everything, JSON.stringify(value)); };
  /** Pausing drops a held notice; its entry stops saying it is waiting. */
  const pauseNow = () => {
    schedule = pauseSchedule(schedule);
    history = history.map(e => e.notice === "held" ? { ...e, notice: "none" } : e);
  };
  let hooks: ProactiveHooks<C> | null = null;
  /** The real day of the plan the last check read, for the notice when App doesn't say (ProactiveContext `noticeDay`). */
  let checkedDay: NoticeDay | null = null;
  let inflight: Promise<C> | null = null;
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
  const deliver = async (macOnly: boolean, about?: NoticeDay): Promise<"sent" | "unavailable"> => {
    const day = about ?? hooks?.context().noticeDay ?? checkedDay;
    const options: NoticeOptions = { ...(macOnly ? { localOnly: true as const } : {}), ...(day ? { day } : {}) };
    try { await (Object.keys(options).length ? deps.notify(options) : deps.notify()); return "sent"; } catch { return "unavailable"; }
  };

  /**
   * Compare with what was last known for this Sunday and decide on one notice. Never throws. Returns what the check found
   * (harness-words.ts CheckFound), or null when that isn't known: not a live read, the first check of this Sunday, the
   * check right before it of another service, or nothing kept from the check before to compare what it showed with.
   */
  async function afterCapture(capture: C, trigger: RunTrigger, ctx: ProactiveContext, now: string, also = false): Promise<CheckFound | null> {
    // One of the other services watched: its own rooms and group meetings, as its part of the Services page shows them
    // (0.7.0). The church's follow-ups are the first service's, and a day's rooms are the one service's whose part shows
    // them (ProactiveContext `holdsRooms`, the page's own choice), so neither is ever compared or told twice.
    const holds = ctx.holdsRooms?.(capture as unknown as SundayCapture, now) ?? true;
    const digest = digestOf(capture, ctx, now, also ? { followUps: false, ...(holds ? {} : { rooms: false }) } : holds ? undefined : { rooms: false });
    if (!digest) return null;
    const { record, brief, ops } = digest;
    const rules = ctx.rules;
    const key = keyOf(digest.owner, digest.plan_id);
    const prior = sundays[key] ?? null;
    const follows = lastRound.length ? lastRound.includes(key) : newestOf(sundays) === key;
    thisRound.push(key);
    const { changes, memory } = compareSundayCheck(prior, record, { now, urgentWithinHours: prefs.urgentWithinHours });
    // Every finding this check shows, kids teams, rooms and follow-ups included, with what the last check of this Sunday showed.
    const entries = feedbackOf(rules);
    const day = noticeDayOf(brief.day);
    if (!also) checkedDay = day;
    dayByPlan.set(digest.plan_id, day);
    const shown = foundOf(brief, ops), print = shownPrint(brief, ops);
    let before = prior ? foundBy[key] ?? null : null;
    let printBefore = prior ? printBy[key] ?? null : null;
    // Another service's first check since its own rooms and group meetings were compared (0.7.0): what was kept of it was
    // compared without them, and showed exactly what this check shows apart from them. They are kept as what it showed,
    // never told as new; a service watched for the first time is a baseline anyway, and anything new after this is told.
    if (also && before !== null && printBefore !== null && !before.some(isOpsKey) && print !== printBefore && printBefore === shownPrint(brief, null)) {
      before = [...before, ...shown.filter(f => f.kind === "room-overlap" || f.kind === "group-meeting").map(f => f.key)];
      printBefore = print;
    }
    // A day's room clash already shown by the service showing that day's rooms before is never new here: a day's rooms move
    // to another service on that day when one's read fails or goes out of date (services-merge.ts roomsHolders). The day is
    // the plan's church-local date, as roomsHolders keys it. What that day last showed (`days`), or, before anything was
    // kept for it, what each same-day service's kept check showed.
    const date = brief.plan.date, zone = brief.time_zone;
    const dayKey = ctx.also?.length && date ? `${record.organization}\u0000${date}` : null;
    const sameDay = (m: SundayCheckMemory) => m.latest.organization === record.organization && m.latest.plan_starts_at !== null && zone !== null
      && localDate(m.latest.plan_starts_at, zone) === date;
    const dayRooms = dayKey === null ? [] : Object.hasOwn(roomsOfDay, dayKey) ? roomsOfDay[dayKey]!
      : Object.entries(sundays).filter(([k, m]) => k !== key && sameDay(m)).flatMap(([k]) => (foundBy[k] ?? []).filter(isRoomKey));
    // Kept only from the check showing the day's rooms, and only from a full read of them.
    if (dayKey !== null && holds && ops && !ops.stale && roomsReadComplete(capture as unknown as SundayCapture, rules)) {
      roomsOfDay = Object.fromEntries([...Object.entries(roomsOfDay).filter(([k]) => k !== dayKey), [dayKey, shown.filter(f => f.kind === "room-overlap").map(f => f.key)]]
        .slice(-DAYS_KEPT));
    }
    sundays = Object.fromEntries([...Object.entries({ ...sundays, [key]: memory })]
      .sort(([, a], [, b]) => b.latest.completed_at.localeCompare(a.latest.completed_at)).slice(0, SUNDAYS_KEPT));
    foundBy = Object.fromEntries(Object.keys(sundays).flatMap(k => k === key ? [[k, shown.map(f => f.key)]] : foundBy[k] ? [[k, foundBy[k]]] : []));
    printBy = Object.fromEntries(Object.keys(sundays).flatMap(k => k === key ? [[k, print]] : printBy[k] ? [[k, printBy[k]]] : []));
    saveMemory();
    const about = { trigger, plan_id: digest.plan_id, plan_dates: record.plan_dates };
    if (!prior) { add({ at: now, kind: "first-check", ...about, notice: "none" }); return null; }
    // The person's Church rules on notices: kinds kept for the briefing, kinds told right away (a kind the Sunday
    // comparison doesn't follow is told when this check newly finds one), and what they asked Ozzie to stop
    // flagging (left out here altogether, as they are on the Sunday page).
    const all = [...changes, ...rightAwayChanges(shown, before && dayRooms.length ? [...before, ...dayRooms] : before, entries)];
    // What What happened may fold. Nothing new only when every read completed, the check right before this one was of
    // this service, nothing changed (not even what the person asked Ozzie to stop flagging), and this check shows exactly
    // what that one did: the same facts of each role and who is scheduled, and the same findings saying the same. Unsure is null.
    const differs = all.length > 0 || (before !== null && !sameKeys(before, shown.map(f => f.key))) || (printBefore !== null && printBefore !== print)
      || !sameFacts(prior.latest, record);
    const outcome: CheckFound | null = differs ? "changes"
      : follows && before !== null && printBefore !== null && digest.complete ? "nothing-new" : null;
    const routed = routeChanges(all, entries);
    const listed = all.filter(c => !routed.stopped.includes(c));
    if (!listed.length) return outcome;
    const found = { worse: routed.notify.length > 0, urgent: routed.urgent, macOnly: macOnlyFor(routed.notify) };
    // Keep Sunday covered is handed the Sunday's own changes. A new finding told right away is this check's notice
    // to send, so then nothing is handed over and one notice goes out.
    const own = routed.notify.some(c => c.kind === "finding-new");
    const sunday = listed.filter(c => c.kind !== "finding-new");
    let handed: Promise<boolean> | void = undefined;
    // Keep services covered runs over the first service's check: the other services' changes bring their own notice.
    if (!also && trigger !== "manual" && !own && sunday.length) {
      try { handed = hooks?.onChanges?.(sunday, { plan_id: digest.plan_id, notice: found.worse }); } catch { /* the check itself finished */ }
    }
    let notice: HistoryEntry["notice"] = "none";
    if (found.worse && trigger === "manual") notice = "in-app";
    else if (found.worse && handed) { notice = "handed"; void afterHandoff(now, handed, found); }
    else if (found.worse) notice = await decide(found, now, also ? day : undefined);
    else if (routed.briefing.length && trigger !== "manual") notice = "briefing";
    add({ at: now, kind: "changes", ...about, changes: listed, notice });
    return outcome;
  }
  /**
   * Send the notice now, or hold it for quiet hours (unless the person let urgent ones through). `day`: the day of one of
   * the other services, when it is about one. A round of checks sends one notice: a second service with something worse in
   * the same round is told by the notice already sent (unless that one stayed on this Mac and this one may go further).
   */
  async function decide(found: { worse: boolean; urgent: boolean; macOnly: boolean }, now: string, day?: NoticeDay, oncePerRound = true): Promise<NonNullable<HistoryEntry["notice"]>> {
    const decision = noticeDecision(found, { quiet: quiet(), urgentDuringQuiet: prefs.urgentDuringQuiet }, now, deps.timeZone());
    // A late hand-off's notice (afterHandoff) belongs to its own round, not the one under way now.
    if (decision === "send" && oncePerRound && roundSent && (!roundSent.macOnly || found.macOnly)) return "sent";
    if (decision === "send") {
      const sent = await deliver(found.macOnly, day);
      if (sent === "sent") roundSent = { macOnly: found.macOnly };
      return sent;
    }
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
      : seenAt && seenAt >= at ? "in-app" : await decide(found, deps.now(), undefined, false);
    history = history.map(e => e.at === at && e.kind === "changes" && e.notice === "handed" ? { ...e, notice: outcome } : e);
    emit();
  }

  /**
   * One of the other services watched, read after the first in the same round (owner decision 2026-11-19), only while it
   * is still watched, with the connection as the round left it. Its own saved checks, comparison and notice; a failure
   * is its own, put in the history once in a row, and never stops the round or counts against the schedule.
   */
  async function alsoCheck(plan: AlsoPlan, ctx: ProactiveContext, status: ConnectionStatus | null, trigger: RunTrigger, source?: "manual" | "automatic") {
    if (!hooks?.context().also?.some(p => p.planId === plan.planId && p.serviceTypeId === plan.serviceTypeId)) return;
    // People forms are church-wide and read with the first service: another service's check doesn't read them again.
    const its: ProactiveContext = { ...ctx, status, settings: { ...ctx.settings, serviceTypeId: plan.serviceTypeId, planId: plan.planId }, rules: withFormsOn(ctx.rules, false) };
    const ledger: { task?: string } = {};
    try {
      const capture = await deps.check(its, s => hooks?.onStatus(s), trigger, source, id => { ledger.task = id; });
      alsoFailures.delete(plan.planId);
      // Stopped watching while it was read: nothing of it is kept here, and App deletes the copy native just saved.
      if (!hooks?.context().also?.some(p => p.planId === plan.planId && p.serviceTypeId === plan.serviceTypeId)) {
        try { hooks?.onAlsoDropped?.(capture); } catch { /* App's own deletion, best effort */ }
        return;
      }
      let found: CheckFound | null = null;
      try { found = await afterCapture(capture, trigger, { ...its, ...pick(hooks?.context()) }, deps.now(), true); } catch { /* comparing is best effort */ }
      if (found && ledger.task) try { deps.found?.(ledger.task, found); } catch { /* What happened then shows the check on its own */ }
      hooks?.onAlsoCapture?.(capture, trigger);
    } catch (error) {
      const failures = (alsoFailures.get(plan.planId) ?? 0) + 1;
      alsoFailures.set(plan.planId, failures);
      if (failures === 1) add({ at: deps.now(), kind: "failed", trigger, plan_id: plan.planId, problem: deps.problem(error) });
      try { hooks?.onAlsoFailure?.(plan.planId, error, trigger); } catch { /* the page's own words only */ }
    }
  }

  function run(trigger: RunTrigger, source?: "manual" | "automatic"): Promise<C> {
    const ctx = hooks!.context();
    const work = (async () => {
      thisRound = [];
      roundSent = null;
      try {
        // The check's task in the ledger, so what it found is kept beside it for What happened.
        const ledger: { task?: string } = {};
        // The connection as this round leaves it, so the other services' checks don't sign in again.
        let status = ctx.status;
        const capture = await deps.check(ctx, s => { status = s; hooks?.onStatus(s); }, trigger, source, id => { ledger.task = id; });
        const now = deps.now();
        let found: CheckFound | null = null;
        // Compared with what this Mac knows of the church watched when it ends: a church let go meanwhile (a switch, a
        // disconnect) gives no digest, so nothing of it is kept or told.
        try { found = await afterCapture(capture, trigger, { ...ctx, ...pick(hooks?.context()) }, now); } catch { /* the check itself finished; comparing is best effort */ }
        if (found && ledger.task) try { deps.found?.(ledger.task, found); } catch { /* What happened then shows the check on its own */ }
        const others = ctx.also ?? [];
        if (!others.length) schedule = finishRun(schedule, scheduleSettings(), now, { ok: true });
        hooks?.onCapture(capture, trigger);
        // Then each other service watched, one after another: native paces every read to Planning Center's rate limit.
        for (const plan of others) await alsoCheck(plan, ctx, status, trigger, source);
        // With other services the round ends after the last of them, so nothing (Resume, the timer) starts another on top.
        if (others.length) schedule = finishRun(schedule, scheduleSettings(), deps.now(), { ok: true });
        return capture;
      } catch (error) {
        const problem = deps.problem(error);
        const end = hooks?.context();
        if (deps.same && end && !deps.same(ctx, end)) {
          // A check of a church let go of meanwhile: nothing of it is charged to the church watched now.
          schedule = { ...finishRun(schedule, scheduleSettings(), deps.now(), { ok: false, problem }), failures: 0, last_run: schedule.last_run };
          throw error;
        }
        schedule = finishRun(schedule, scheduleSettings(), deps.now(), { ok: false, problem });
        // Report the first failure in a row; retries continue quietly with backoff.
        if (schedule.failures === 1) add({ at: deps.now(), kind: "failed", trigger, problem });
        try { hooks?.onFailure?.(error, trigger); } catch { /* the page's own words only */ }
        throw error;
      } finally {
        // What this round read is what the next one is compared with ("nothing new" needs the round before).
        if (thisRound.length) { lastRound = [...new Set(thisRound)]; saveMemory(); }
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
    const owner = ctx ? ownerOf(ctx) : undefined;
    const own = owner && entry.plan_id ? keyOf(owner, entry.plan_id) : undefined;
    const key = own && sundays[own] ? own : Object.keys(sundays).find(k => sundays[k]!.latest.plan_id === entry.plan_id);
    const memory = key ? sundays[key] : undefined;
    const holding = (entry.changes ?? []).filter(c => !memory || changeStillHolds(c, memory, foundBy[key!] ?? null));
    return routeChanges(holding, feedbackOf(ctx?.rules ?? {})).notify;
  };

  /**
   * The day a held notice names: the first service's own (App's) when every entry is about it; one other service's day
   * when they are all about that one; "service" when they span services on different days.
   */
  function heldDay(entries: readonly HistoryEntry[], ctx: ProactiveContext): NoticeDay | undefined {
    const plans = new Set(entries.map(e => e.plan_id ?? ctx.settings.planId));
    // Only another service watched changes the day (a church system's own service ids are never Settings' plan).
    if (![...plans].some(p => ctx.also?.some(a => a.planId === p))) return undefined;
    const days = new Set([...plans].map(p => p === ctx.settings.planId ? ctx.noticeDay ?? checkedDay ?? "service" : dayByPlan.get(p) ?? "service"));
    return days.size === 1 ? [...days][0]! : "service";
  }

  async function tick() {
    if (!hooks) return;
    const now = deps.now();
    const released = releaseHeld(schedule, inQuietHours(quiet(), now, deps.timeZone()));
    schedule = released.state;
    const ctx = hooks.context();
    const step = tickSchedule(schedule, now, readyNow(ctx));
    schedule = step.state;
    if (step.missed) add({ at: now, kind: "missed", scheduled_for: step.missed });
    const running = step.start ? run(step.start) : inflight;
    if (released.deliver) {
      // One notice for whatever is still so; a held entry that no longer is says no notice was needed.
      const still = new Map(history.filter(e => e.notice === "held").map(e => [e, stillNotifying(e)] as const).filter(([, c]) => c.length > 0));
      const relevant = new Set(still.keys());
      const outcome = relevant.size ? await deliver(macOnlyFor([...still.values()].flat()), heldDay([...relevant], ctx)) : null;
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
      // Who started it, as the task ledger records it: a person unless Ozzie's own caller says "automatic".
      const step = startManual(schedule, deps.now(), source === "automatic" ? "ozzie" : "person");
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
    forgetPlans(planIds) {
      const gone = new Set(planIds);
      if (!gone.size) return;
      const kept = (k: string) => !gone.has(sundays[k]?.latest.plan_id ?? k.slice(k.indexOf(":") + 1));
      sundays = Object.fromEntries(Object.entries(sundays).filter(([k]) => kept(k)));
      foundBy = Object.fromEntries(Object.entries(foundBy).filter(([k]) => kept(k)));
      printBy = Object.fromEntries(Object.entries(printBy).filter(([k]) => kept(k)));
      lastRound = lastRound.filter(k => Object.hasOwn(sundays, k));
      history = history.filter(e => !e.plan_id || !gone.has(e.plan_id));
      for (const p of gone) { dayByPlan.delete(p); alsoFailures.delete(p); }
      saveMemory();
      emit();
    },
    letGo() {
      checkedDay = null;
      // What changed and how the last check went were that church's: Keeping watch starts afresh for the next one.
      schedule = { ...schedule, held: null, failures: 0, last_run: null };
      history = [];
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

/** A check's own context, with the church watched when it ends (ProactiveContext `system`), for comparing it. */
const pick = (ctx: ProactiveContext | undefined): Partial<ProactiveContext> => ctx ? { system: ctx.system ?? null } : {};

let desktop: ProactiveController | null = null;
/** One controller per webview: checks run while Ozzie is open. */
export function desktopProactive(): ProactiveController {
  return desktop ??= createProactive({
    store: browserStore,
    now: () => new Date().toISOString(),
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Every check, automatic or manual, is a "check" task in the task ledger. No model is involved.
    check: (ctx, onStatus, trigger, source, onTask) =>
      desktopRecorder().check(() => verifiedSundayCheck(ctx, onStatus), source ?? (trigger === "manual" ? "manual" : "automatic"), onTask, ctx.settings.serviceTypeId),
    // What each check found, beside its task for What happened (closed words; harness-words.ts CheckFound).
    found: (taskId, found) => desktopRecorder().checked(taskId, found),
    notify: notifySundayAttention,
    problem: sundayProblem,
    timers: { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>) },
  });
}
