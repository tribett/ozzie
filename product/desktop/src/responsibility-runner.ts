// Keeping watch, run on this Mac (owner, 2026-11-14: an always-on helper). The native
// store (responsibilities.rs) holds each responsibility and decides whether a run may happen; this
// controller decides WHEN to ask (core/src/harness/responsibilities.ts dueNow), runs the work, and
// surfaces what it found:
//
//   begin (native grant) → a deterministic Planning Center check through the same path as "Check
//   Planning Center now" (recorded in the task ledger), shared by every run that needs one within a
//   couple of minutes, the regular Sunday check's included → with an AI model, the template's
//   procedure through the harness, each AI step paid from the run's grant → compare with the last
//   run → an "Ozzie noticed" item, and a discreet notice only as the report policy says (quiet hours
//   hold it, never drop it; pausing drops it) → end (native). For changes the regular Sunday check
//   handed over (handChanges), this run's notice is the one notice; the regular check sends its own only
//   if this run doesn't decide one.
//
// A church on B1 Church or Breeze (system-jobs.ts): Keep services covered and the morning briefing run the same way over
// the system's own check of the watched service (its schedule's read, recorded in the task ledger, shared the same way),
// counted from the brief its service page shows and compared by the same name-free record. The other jobs read Planning
// Center's Calendar, People and Groups, which those systems' keys don't read: they wait, unshown, as when Planning
// Center isn't connected, and run again if the church switches back. Each item says which system its check read.
//
// A job is for the church a person confirmed its plan for (owner decision 2026-11-22). Each job keeps that church
// on this Mac (KEYS.churches, beside the native store, which holds no church). When the Mac uses a different church,
// whatever system each is on, each job confirmed for the old one pauses and Ozzie asks once whether to keep it for the
// new one (`questions`): Yes starts it fresh there, its first check a quiet baseline; No stops it; switching back before
// answering simply resumes it. A job from before churches were kept belongs to the Planning Center church in use when it
// is first seen, without a question. Only the church in use's items are shown, and a notice held about another never
// goes out.
//
// Missed runs (Mac asleep, Ozzie not running, Planning Center not connected) are reported plainly
// and caught up ONCE. A run that couldn't finish, or couldn't start, says so and is tried again
// later, within limits. A refused run is never asked for again before the store would allow it, so
// nothing here loops. Name-free storage: items keep counts, codes, times and person ids (resolved
// only at render).
//
// The AI's write-up of a run (audit item 6) is kept with that run on this Mac, under a key of its own: Ozzie's own
// sentences with each person as their Planning Center id (core session.ts PERSON_TOKEN), filled in with names from the
// check on screen only when shown, and role, room, follow-up and group names as Planning Center has them (which can
// include a person's name if a church typed one there; review H, M4); the run's steps in plain words, and where its
// facts came from; or, when AI help is set up and there is none, why (AI help's allowance used for now, the answer ran
// past what one run may use, an answer that didn't check out, or one that couldn't be prepared; nothing when the run
// was paused during it). It decides nothing: findings, counts, notices and the native run row are worked out before
// it and without it, and the notice is decided before the write-up is asked for. The last WRITEUPS_KEPT_PER_JOB of
// each job are kept; a job's are forgotten when it is stopped or ends, every other church's when Ozzie switches church
// (keepWriteupsFor), and all of them when saved checks are deleted or Planning Center is disconnected
// (forgetAllWriteups), one still being prepared included. Nothing else reads that key: not the task record, not the
// copy for other AI apps or Siri, and never a notice.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  changeEligible, checksFreeAt, dueNow, includesSundayReady, quietDeferral, refusedUntil, retryAt, scheduledSlots, settledPlan, TEMPLATES, untilLifetime, type LocalState, type Plan,
  type Responsibility, type RunTrigger, type TemplateId,
} from "../../../core/src/harness/responsibilities.js";
import type { FailureCode, ModelStep } from "../../../core/src/harness/contract.js";
import { isTimeZone } from "../../../core/src/church-time.js";
import { inQuietHours, type QuietHours } from "../../../core/src/schedule.js";
import { buildSundayBrief, sundayShownCount, unnumberedRoster, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { isOperationsRead, type SundayCapture, type SundayRules } from "../../../core/src/sunday-capture.js";
import { applyDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { changeStillHolds, compareSundayCheck, recordSundayCheck, type SundayChange, type SundayCheckMemory, type SundayCheckRecord } from "../../../core/src/sunday-changes.js";
import { sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { partKey } from "./services-merge.js";
import {
  alwaysFor, briefTarget, changeFindingKind, feedbackOf, foundOf, keptForBriefing, routeChanges, routeFindings, stableFindingKey, type FoundKey,
} from "../../../core/src/finding-feedback.js";
import { checkFailure, retryDenied, StepFailure, stepFailure, StepNotes, stepNotes, type Invoke } from "./harness-bridge.js";
import type { KeyValueStore } from "./proactive.js";
import { heldMacOnly, THIS_MAC_ONLY, thisMacOnly, type NoticeOptions } from "./phone-notice.js";
import { isSystemCheck, runsOn, systemJobBrief, systemJobRecord, systemOf, type SystemJobCheck } from "./system-jobs.js";
import type { OtherSystem } from "./church-system.js";

/** What a job reads: a Planning Center check, or a B1 Church or Breeze check of the watched service (system-jobs.ts). */
export type JobCheck = SundayCapture | SystemJobCheck;
/** Every read the check made, with how it ended. */
const readsOf = (c: JobCheck): readonly { outcome: string }[] => isSystemCheck(c) ? c.system.reads : c.reads;
/**
 * Why a B1 Church or Breeze read didn't finish, as native's closed word (proactive.ts SystemReadFailure), for the item's
 * own sentence; nothing for any other failure (a Planning Center check says what it always said).
 */
const readWord = (error: unknown): Pick<NoticedItem, "read"> | Record<string, never> => {
  if (!(error instanceof Error) || !Object.hasOwn(error, "system")) return {};
  const outcome = (error as { outcome?: unknown }).outcome;
  return typeof outcome === "string" && /^[a-z-]{1,40}$/u.test(outcome) ? { read: outcome } : {};
};
/** What a check is compared by (sunday-changes.ts); null for a system check whose brief can't be built. */
function recordOf(c: JobCheck, rules: SundayRules, now: string): SundayCheckRecord | null {
  if (!isSystemCheck(c)) return recordSundayCheck(c, rules, now);
  const built = systemJobBrief(c, rules, now);
  return built.ok ? systemJobRecord(c, built.brief) : null;
}

// ---- The native store --------------------------------------------------------------------------------

/** responsibilities.rs ResponsibilityError, rejected as a bare string. */
export const REFUSALS = ["invalid", "unknown", "paused", "paused-all", "ended", "expired", "checks-limit", "ai-limit", "too-soon", "busy", "full", "exists", "no-run", "unavailable"] as const;
export type Refusal = (typeof REFUSALS)[number];
export const refusalOf = (error: unknown): Refusal =>
  typeof error === "string" && (REFUSALS as readonly string[]).includes(error) ? error as Refusal : "unavailable";
export interface Listing { paused_all: boolean; items: Responsibility[] }
export interface Grant { run_id: string; ai_steps: number; checks_left: number }
export interface ResponsibilityNative {
  list(): Promise<Listing>;
  create(plan: Plan): Promise<Responsibility>;
  edit(id: string, plan: Plan): Promise<Responsibility>;
  pause(id: string): Promise<Responsibility>;
  resume(id: string): Promise<Responsibility>;
  stop(id: string): Promise<Responsibility>;
  pauseAll(paused: boolean): Promise<Listing>;
  begin(id: string, trigger: RunTrigger): Promise<Grant>;
  end(id: string, runId: string, outcome: "ok" | "failed", code: FailureCode | null, noticed: number, drafts: number): Promise<Responsibility>;
}
const nativeInvoke: Invoke = (command, args) => tauriInvoke(command, args);
/** The plan goes over as its fixed fields only (the store refuses any other field). */
const planOnly = (p: Plan): Plan => ({ template: p.template, schedule: p.schedule, report: p.report, lifetime: p.lifetime, limits: p.limits, zone: p.zone });
export function nativeResponsibilities(invoke: Invoke = nativeInvoke): ResponsibilityNative {
  return {
    list: () => invoke("responsibility_list"),
    create: plan => invoke("responsibility_create", { plan: planOnly(plan) }),
    edit: (id, plan) => invoke("responsibility_edit", { id, plan: planOnly(plan) }),
    pause: id => invoke("responsibility_pause", { id }),
    resume: id => invoke("responsibility_resume", { id }),
    stop: id => invoke("responsibility_stop", { id }),
    pauseAll: paused => invoke("responsibility_pause_all", { paused }),
    begin: (id, trigger) => invoke("responsibility_run_begin", { id, trigger }),
    end: (id, runId, outcome, code, noticed, drafts) => invoke("responsibility_run_end", { id, runId, outcome, code, noticed, drafts }),
  };
}
/** A responsibility run's only path to a model: native responsibility_agent_step, paid from the run's grant. */
export function responsibilityStep(runId: string, invoke: Invoke = nativeInvoke, notes: StepNotes = stepNotes): ModelStep {
  return async (request, signal) => {
    if (signal.aborted) throw new StepFailure("transport");
    let stop = () => {};
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new StepFailure("transport"));
      signal.addEventListener("abort", onAbort, { once: true });
      stop = () => signal.removeEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([retryDenied(() => invoke<Awaited<ReturnType<ModelStep>>>("responsibility_agent_step", { runId, request }), signal)
        // The native code is noted by task, so a spent allowance is told apart from the run's own limit (review G).
        .catch(error => { notes.record(request.task_id, error); throw new StepFailure(stepFailure(error)); }), aborted]);
    } finally { stop(); }
  };
}

// ---- What Ozzie noticed ----------------------------------------------------------------------------

export type NoticeKind = "briefing-ready" | "needs-decision" | "checked" | "couldnt-check";
/** Why a check couldn't happen: a run's FailureCode, or the store refusing it (`unavailable`, `invalid`). */
export type ItemCode = FailureCode | "unavailable" | "invalid";
/** One "Ozzie noticed" entry. Name-free: counts, codes, times, the run and plan ids, and person ids inside changes. */
export interface NoticedItem {
  id: string;
  responsibility_id: string;
  template: TemplateId;
  at: string;
  kind: "found" | "clear" | "briefing" | "couldnt-check" | "missed" | "limit" | "ended";
  trigger?: RunTrigger;
  /** found / clear / briefing: the run that reported it (the native store's run id). */
  run_id?: string;
  /** found / clear / briefing: the Sunday plan its check read, and when that check finished. */
  check?: { plan_id: string; completed_at: string };
  /** missed / couldnt-check: the scheduled time it was about. */
  scheduled_for?: string;
  missed_reason?: "asleep" | "closed" | "waiting" | "unknown";
  /** missed: how many scheduled times; ended: how many were missed before it ended. */
  missed_count?: number;
  /** missed: checked late at this time. Absent when it ended before it could check again. */
  ran_at?: string;
  /** missed: these were the last times before it ended; no check followed. */
  before_end?: boolean;
  retry_at?: string | null;
  code?: ItemCode;
  /** couldnt-check: the connection doesn't include what this needs. */
  access?: boolean;
  decisions?: number;
  looks?: number;
  /** rooms: overlaps a room rule confirms (Needs a decision); rooms_uncertain: the rest (Worth a look), as on the Sunday page. */
  findings?: { rooms?: number; rooms_uncertain?: number; follow_ups?: number; groups?: number };
  changes?: SundayChange[];
  /** Notes ready to review on the Sunday page (the fixed check's; a write-up never adds one). */
  drafts?: number;
  /** Kept on items saved before write-ups were kept with their runs; no longer written. */
  summarized?: boolean;
  drafted?: boolean;
  /** ended: the date it was for. */
  until?: string;
  /** It came up during quiet hours: the morning briefing labels it Overnight. */
  overnight?: boolean;
  /** briefing: how many items came up overnight since the last briefing. */
  overnight_count?: number;
  /** briefing: Thursday's, which includes the full Sunday Ready brief. */
  sunday_ready?: boolean;
  /**
   * briefing: what the person's Church rules keep for the briefing ("Put this in the briefing"), each kind with
   * how many its check showed, listed under "Kept for your briefing". Kinds and counts only.
   */
  kept?: { kind: string; count: number }[];
  /**
   * "briefing": kept for the briefing by the person's Church rules ("Put this in the briefing").
   * "in-briefing": held for quiet hours, then brought into the morning briefing instead of its own notice.
   */
  notice?: "sent" | "held" | "sent-later" | "in-app" | "unavailable" | "briefing" | "in-briefing" | "none";
  /** The church system the job read when it came up, when it isn't Planning Center (B1 Church, Breeze). Absent: Planning Center. */
  system?: OtherSystem;
  /**
   * The church it is about, as JobChurch `church` keeps it ("" for one from before churches were kept that no longer
   * belongs to a known church). Absent on an item kept before 0.8.0, until the runner first knows the church in use.
   * Keeping watch and Today show only the church in use's.
   */
  church?: string;
  /**
   * found / clear / briefing: the system shares no number needed for any role (Breeze), so Ozzie can't say whether the
   * service is covered, and every sentence that would say nothing needs a decision says that instead.
   */
  unnumbered?: true;
  /** couldnt-check: why the system's read didn't finish, as native's closed word (church-system.ts readProblemText). */
  read?: string;
  /** couldnt-check: the system lists no roles on the service watched, so there was nothing to check. */
  no_roles?: true;
}
/**
 * What the AI wrote for a run, in the form kept on this Mac: Ozzie's own sentences for the facts it chose, people as id
 * tokens (core session.ts `Harness.keep`), where those facts came from and when, what wasn't complete, and the steps.
 */
export interface Written { lines: string[]; based_on: string; gaps: string[]; steps: string[] }
/** What a run with an AI model prepared: a verified write-up, or why there is none. */
export interface Prepared {
  status: "verified" | "failed" | "cancelled"; code: FailureCode | null; writeup: Written | null; ai_steps: number;
  /** A "limit" that was an AI help allowance (the route's cap, today's steps, the church's managed allowance), not the run's own. */
  allowance?: boolean;
  /** The AI company says the church's account has no credit left (native no-credit), not the run's own limit (review F5). */
  noCredit?: boolean;
}
/**
 * Why a run has no write-up: AI help off, AI help's allowance used for now, the answer ran past what one run may use
 * (review G), the answer didn't check out, or it couldn't be prepared. "off" and "stopped" (paused during the write-up)
 * are never kept, so a card says nothing for them.
 */
export type NoWriteup = "off" | "spent" | "no-credit" | "run-limit" | "unverified" | "unavailable" | "stopped";
/** One run's write-up as kept with it on this Mac (header): people as Planning Center ids; other names as Planning Center has them. */
export interface WriteUp extends Partial<Written> {
  /** The noticed item it belongs to (its id), its job, run, the church it was read from, and when. */
  item: string; responsibility_id: string; run_id: string; organization: string; at: string;
  kind: "written" | "none";
  /** none: why. */
  why?: NoWriteup;
  /** written: how many times the AI was asked. */
  ai_steps?: number;
}
/** How many write-ups each job keeps. */
export const WRITEUPS_KEPT_PER_JOB = 5;
const WRITEUPS_KEPT = 40;
/** Whether a native refusal was an AI help allowance (the route's cap, today's steps, the church's managed allowance, the own key's month). */
export const allowanceSpent = (native: string | undefined) => native === "budget" || native === "daily-limit" || native === "allowance-paused" || native === "month-limit";
const whyNot = (code: FailureCode | null, allowance = false, noCredit = false): NoWriteup =>
  code === "fidelity" ? "unverified" : code === "limit" ? noCredit ? "no-credit" : allowance ? "spent" : "run-limit" : code === "no-model" ? "off" : "unavailable";

export interface RunnerContext {
  /** A saved connection and a chosen Sunday (proactiveReadiness "ready"). */
  ready: boolean;
  granted: readonly ("services" | "operations")[];
  rules: SundayRules;
  /**
   * The church's zone when a check has read it, otherwise this Mac's. A responsibility follows the zone
   * it was confirmed in; this one (as it was at launch) only for one confirmed before zones were kept.
   */
  zone: string;
  /**
   * The church in use as the app knows it at this moment (JobChurch `church`; null with none), which can be ahead of what
   * the runner was last told (churchInUse): a job confirmed for another church never starts a run then. Absent: not said.
   */
  church?: string | null;
  /** Quiet hours follow this Mac's clock, as they always have. */
  macZone: string;
  quiet: QuietHours;
  /** The person let urgent notices through quiet hours (What runs automatically); Ozzie never widens it. */
  urgentDuringQuiet?: boolean;
  urgentWithinHours: number;
  modelReady: boolean;
  /**
   * The leader's own decisions about a check's Sunday, as the Sunday page applies them (kept on this Mac), so Keep Sunday
   * covered's report counts what the page shows. Absent: none.
   */
  decisionsFor?: (capture: JobCheck) => readonly SundayDecision[];
  /**
   * The church's system when it is B1 Church or Breeze: jobs read its checks, and only the jobs it can run do
   * (system-jobs.ts SYSTEM_TEMPLATES); the rest wait, unshown, as when nothing is connected. Absent: Planning Center.
   */
  system?: OtherSystem | null;
  /**
   * The other services Ozzie watches as the Services page shows them now, beside `capture` (this run's check of the first
   * service): their latest checks, read in the same round, with the leader's decisions for each and each one's own rooms
   * and group meetings; `firstRooms` false when another service on the first service's day shows that day's rooms
   * (services-merge.ts roomsHolders). Keep services covered, the morning briefing, Watch room bookings and Group night
   * clashes then count every service's, each once, as the page and the jobs' write-ups do (owner decision 2026-11-19,
   * 0.7.0). Absent or null: one service.
   */
  alsoServices?: (capture: SundayCapture) => AlsoServices | null;
}
export interface RunnerHooks {
  context(): RunnerContext;
  /** One fresh deterministic check through the app's own path (recorded in the task ledger). */
  check(): Promise<JobCheck>;
  /**
   * With an AI model: the template's procedure for this run, its steps paid from the grant, written up in the form kept
   * on this Mac. `signal` aborts when it's paused; `trigger`: why this run started, for What happened.
   */
  prepare(r: Responsibility, grant: Grant, capture: JobCheck, signal?: AbortSignal, trigger?: RunTrigger): Promise<Prepared | null>;
  /**
   * Whether a check is of the church Ozzie uses now. A check of another church (one finished or shared from before a
   * switch) is never reused or acted on. Absent: every check is.
   */
  belongs?(capture: JobCheck): boolean;
}
export interface RunnerDeps {
  native: ResponsibilityNative;
  store: KeyValueStore;
  now: () => string;
  /** One fixed notice; `THIS_MAC_ONLY` when only background checks brought it (its phone line stays back). */
  notify: (kind: NoticeKind, options?: NoticeOptions) => Promise<void>;
  /** Wakes the native timer when the next run is due. */
  nextDue?: (at: string | null) => void;
  /** Developer builds only (OZZIE_DEV_FAST_SCHEDULE=1): due times minutes apart. */
  fast?: () => boolean;
  /** Debug builds only: name-free lines for the developer's terminal. */
  log?: (line: string) => void;
}
interface Saved extends LocalState {
  memory: SundayCheckMemory | null;
  /** Finding keys already reported, so the same decision isn't announced twice. Ids only. */
  reported: string[];
  waiting_since: string | null;
  ended_told: boolean;
  limit_told: string | null;
  /** A refused run isn't asked for again before this (core refusedUntil). */
  not_before: string | null;
  /** The last run the store closed as interrupted that has been reported (its run id). */
  interrupted_told: string | null;
  /** Paused (on its own or with everything) since: its scheduled times meanwhile weren't missed. */
  paused_at: string | null;
  /** Kept for a new church after a switch (Yes): its first check there tells nothing, only learns what is there. */
  baseline?: true;
  /** Runs in a row whose check came back from another church or service than the job's (each ended quietly). */
  mismatches?: number;
  /**
   * After two such runs: it stops asking native for runs (no checks used) until a check of its own church comes back
   * (captured), or the church in use changes. Its card says why it waits.
   */
  mismatch_hold?: true;
}
export interface RunnerView {
  available: boolean;
  paused_all: boolean;
  items: Responsibility[];
  noticed: NoticedItem[];
  /** Each run's write-up (or why there is none), by noticed item id, kept on this Mac. People are id tokens. */
  writeups: Readonly<Record<string, WriteUp>>;
  next: Readonly<Record<string, string | null>>;
  running: string | null;
  unseen: number;
  /** A briefing was announced: open Today when the window comes back. */
  open_today: boolean;
  /** Jobs confirmed for another church than the one in use, each paused until the person says whether to keep it. */
  questions?: readonly SwitchQuestion[];
  /** The system each B1 Church or Breeze run read (by its run id), so a run is said in its own system's name. */
  run_systems?: Readonly<Record<string, OtherSystem>>;
  /**
   * Jobs this Mac keeps that are confirmed for another church than the one shown and aren't asked about (one of each kind
   * at a time, so that kind is never offered to set up again here): each waits until Ozzie uses its church again.
   */
  held?: readonly { responsibility_id: string; template: TemplateId; title: string; church: JobChurch }[];
  /** Jobs that stopped using checks because their last two checks came back from another church or service (by id). */
  stalled?: readonly string[];
}
/**
 * The church a job was confirmed for: its key (Planning Center's organization number, or `<system>:<church id>` for
 * B1 Church and Breeze, as checks carry it), its name when known, and its system. `church: null`: not known yet; `adopt`:
 * confirmed before any church was connected, so it belongs to the first one used.
 */
export interface JobChurch { church: string | null; name: string | null; system: "planning-center" | OtherSystem; adopt?: true }
/** A job confirmed for another church than the one in use: paused until the person answers (Keeping watch and Today). */
export interface SwitchQuestion {
  responsibility_id: string; template: TemplateId; title: string; from: JobChurch; to: JobChurch;
  /** `to` is the church last in use, not connected right now (a disconnect): a job kept for it waits until it is. */
  waiting?: true;
}
export interface Runner {
  start(hooks: RunnerHooks): void;
  refresh(): Promise<void>;
  tick(): Promise<void>;
  wake(sleptMs: number, at: string): void;
  /** Whether an eligible responsibility would run sooner for these changes now (what `changes` checks first). */
  takes(changes: readonly SundayChange[]): boolean;
  /**
   * Changes the regular Sunday check found: an eligible responsibility runs sooner. Resolves true when Keep
   * Sunday covered ran for the Sunday in `about` and decided the notice itself (sent it, held it for quiet
   * hours or kept it for the briefing); false when nothing ran, or its run was refused, failed, was paused
   * or decided nothing, so the regular check's own notice goes out instead.
   */
  changes(changes: readonly SundayChange[], about?: HandedChanges): Promise<boolean>;
  /** A check the app just made (the regular Sunday check's included): runs within a couple of minutes share it. */
  captured(capture: JobCheck): void;
  /** "Pause everything" changed somewhere else (the menu bar): takes effect at once, not after a running run. */
  pausedElsewhere(paused: boolean): Promise<void>;
  create(plan: Plan): Promise<Responsibility>;
  edit(id: string, plan: Plan): Promise<Responsibility>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  pauseAll(paused: boolean): Promise<void>;
  runNow(id: string): Promise<RunResult>;
  markSeen(): void;
  clearOpenToday(): void;
  /** Ozzie uses this church now: every other church's write-ups are forgotten. */
  keepWriteupsFor(organization: string): void;
  /** Saved checks were deleted, or Planning Center was disconnected: every write-up is forgotten (review H, M4). */
  forgetAllWriteups(): void;
  /**
   * The church Ozzie uses now (null while none is connected): jobs confirmed for another one pause and are asked about;
   * one confirmed for this one resumes if a question about it was waiting; a notice held about another church is dropped.
   */
  churchInUse?(church: JobChurch | null): void;
  /** The person's answer to a SwitchQuestion: keep the job for the church in use (true), or stop it. */
  answerSwitch?(id: string, keep: boolean): Promise<void>;
  /** The church was let go of (a switch of system, a disconnect): a notice held about it never goes out, and a run stops. */
  letGo?(): void;
  /**
   * A church this Mac forgets (a B1 Church or Breeze Disconnect, or a switch away from it), by its key: its name goes from
   * everything the jobs keep (the last church in use is removed; each job and question keeps only its id and system, so
   * it is still asked about), and its items go.
   */
  forgetChurch?(church: string): void;
  /** Every job this Mac keeps that hasn't ended, as last read (those the page doesn't show included), with its church. */
  jobs?(): { template: TemplateId; church: JobChurch | null }[];
  view(): RunnerView;
  subscribe(listener: () => void): () => void;
}
export type RunResult = {
  status: "ok" | "failed"; code: FailureCode | null; noticed: number; drafts: number;
  /** ok: the Sunday plan whose notice this run decided (sent, held or kept for the briefing), if it decided one. */
  decided_for?: string;
} | { status: "refused"; code: Refusal } | { status: "skipped" };
/**
 * What the regular Sunday check says about changes it hands over: the Sunday they are about, and whether it
 * has a notice of its own to send if the responsibility doesn't decide one.
 */
export interface HandedChanges { plan_id: string; notice: boolean }

const KEYS = {
  state: "ozzie.responsibilities.state.v1", noticed: "ozzie.responsibilities.noticed.v1", seen: "ozzie.responsibilities.seen.v1", held: "ozzie.responsibilities.held.v1",
  /** Responsibilities already moved to the settled defaults, so a person's later choice of the old time stays. */
  settled: "ozzie.responsibilities.settled.v1",
  /** Each run's write-up (header): people as Planning Center ids. Read and written only here. */
  writeups: "ozzie.responsibilities.writeups.v1",
  /** The church each job was confirmed for (JobChurch), by its id: church keys and names, never a person's. */
  churches: "ozzie.responsibilities.churches.v1",
  /** Jobs paused by a switch of church until the person answers: the church each was for, and whether it was running. */
  questions: "ozzie.responsibilities.switch.v1",
  /** The last church in use Ozzie knew (JobChurch), so its jobs stay shown while it isn't known for a while. */
  church: "ozzie.responsibilities.church.v1",
};
const NOTICED_KEPT = 30;
const HELD_KEPT = 30;
const REPORTED_KEPT = 60;
/** A room or group job's mark that it has looked at another service's plan once (kept with its reported keys; ids only). */
const seenMark = (plan: string) => JSON.stringify(["seen", plan]);
const WAKES_KEPT = 10;
/** A check this recent is shared instead of reading Planning Center again. */
export const SHARED_CHECK_MS = 2 * 60_000;
const FAST_SHARED_CHECK_MS = 20_000;
/** After Planning Center asked Ozzie to slow down, no new check starts for this long. */
export const RATE_LIMIT_WAIT_MS = 5 * 60_000;
const FAST_RATE_LIMIT_WAIT_MS = 30_000;
/** How far back the scheduled times before a dated end are looked at (as dueNow does). */
const LOOKBACK_MS = 9 * 86_400_000;
const ms = (iso: string) => Date.parse(iso);
const iso = (n: number) => new Date(n).toISOString();
const fresh = (): Saved => ({
  last_slot: null, last_run_at: null, retry_at: null, failures: 0, memory: null, reported: [], waiting_since: null, ended_told: false, limit_told: null,
  not_before: null, interrupted_told: null, paused_at: null,
});
const read = <T,>(store: KeyValueStore, key: string): T | null => { try { const raw = store.get(key); return raw ? JSON.parse(raw) as T : null; } catch { return null; } };
const NOTICE_RANK: Record<NoticeKind, number> = { "couldnt-check": 0, checked: 1, "needs-decision": 2, "briefing-ready": 3 };
/** A change's finding kind, for "this Mac only" (null: not about a finding). Kinds only. */
const changeKind = (c: SundayChange) => c.finding?.kind ?? changeFindingKind(c.kind);
/** Sends one notice; `macOnly`: only background checks brought it, so "A notice on your phone" leaves it on this Mac. */
const sendNotice = (deps: Pick<RunnerDeps, "notify">, kind: NoticeKind, macOnly: boolean) => macOnly ? deps.notify(kind, THIS_MAC_ONLY) : deps.notify(kind);
const CANCELLED = Symbol("cancelled");
/** A check that finished for a church Ozzie no longer uses (hooks.belongs): its run ends as cancelled, telling nothing. */
const FOREIGN = Symbol("another church");
/** A run whose check came back from another church or service than its job's: it ends quietly, and is counted. */
const MISMATCH = Symbol("mismatch");
/** How many such runs in a row before the job stops using checks (review of 0.8.0, fourth pass, L3). */
const MISMATCHES_HELD_AFTER = 2;
const rateLimited = (value: unknown) => (JSON.stringify(value) ?? "").includes("rate-limited");

/** One finding a run reports, by its stable key and kind (for the person's Church rules on notices). Ids only. */
export type { FoundKey };
/**
 * A notice waiting for quiet hours to end, and what brought it: the new findings (ids only; the item keeps its
 * changes), so it can be rechecked before it goes out. `found` is absent on one held before rechecks were kept.
 * `mac_only`: only background checks brought it when it was held, kept for when it can no longer be rechecked
 * (phone-notice.ts `heldMacOnly`); absent on one held before this was kept.
 */
interface Held { kind: NoticeKind; at: string; item: string; found?: FoundKey[]; mac_only?: boolean }
/** The other services watched, as a job counts them beside the first service's check (RunnerContext `alsoServices`). */
export interface AlsoServices {
  firstRooms: boolean;
  others: readonly { plan_id: string; brief: SundayBrief; decisions: readonly SundayDecision[]; operations: SundayOperations | null }[];
}
/**
 * `found`/`keys`: what a template reports and announces; `all`: every finding the check shows, for the briefing's kept
 * list; `others`: the keys among `keys` that are each other service's own, by its plan.
 */
export interface Found {
  decisions: number; looks: number; findings: NonNullable<NoticedItem["findings"]>; found: FoundKey[]; keys: string[]; drafts: number; all: FoundKey[];
  others?: Readonly<Record<string, readonly string[]>>;
  /** A church system that shares no number needed for any role (Breeze): Ozzie can't say whether the service is covered. */
  unnumbered?: true;
}
/**
 * What one fresh check shows for a template. Counts and keys (ids) only. The person's Church rules
 * already set aside what they asked Ozzie to stop flagging; notes their "Always do this" prepares count as drafts.
 * A room overlap counts as a decision only when a room rule confirms it, as the Sunday page labels it. Keep Sunday
 * covered's and the morning briefing's counts are the Sunday page's own (sundayShownCount, after the leader's
 * `decisions`): rooms, follow-ups and group meetings the check read included, so "Keep Sunday covered: 2 things need a
 * decision" never sits beside a page that says 3 (review item 2). What it announces is still only what it watches: the
 * Services findings in `found`. `also`: the other services watched (RunnerContext `alsoServices`): every count, room and
 * group meeting is then every service's, each once, as the Services page and the job's own write-up (which reads every
 * service's) say them; the church's follow-ups stay the first service's.
 */
export function findingsFor(template: TemplateId, capture: JobCheck, rules: SundayRules, now: string, decided: readonly SundayDecision[] = [], also: AlsoServices | null = null): Found {
  if (isSystemCheck(capture)) return systemFindings(template, capture, rules, now, decided);
  const brief = buildSundayBrief(capture, rules, now);
  const own = also && !also.firstRooms ? { rooms: false as const } : {};
  const ops = TEMPLATES[template].needs.includes("operations") || template === "morning-briefing" ? sundayOperations(capture, rules, { now, ...own }) : null;
  const others = also?.others ?? [];
  const fresh = (o: SundayOperations | null) => o && !o.stale ? o : null;
  const roomsOf = (o: SundayOperations | null) => (o?.result?.findings ?? []).filter(f => f.kind === "room-overlap");
  const rooms = [...roomsOf(ops), ...others.flatMap(o => roomsOf(fresh(o.operations)))];
  const confirmedRooms = rooms.filter(f => f.certainty === "confirmed").length, uncertainRooms = rooms.length - confirmedRooms;
  const roomCounts = { ...(confirmedRooms ? { rooms: confirmedRooms } : {}), ...(uncertainRooms ? { rooms_uncertain: uncertainRooms } : {}) };
  const followUps = ops?.result?.findings.filter(f => f.kind === "unowned-overdue") ?? [];
  // Each other service's group meetings under keys of its own (services-merge.ts partKey), so one person's two never meet.
  const groups = [...(ops?.group_meetings ?? []).map(g => ({ g, key: `${g.person_id}:${g.meetings[0]?.starts_at ?? ""}` })),
    ...others.flatMap(o => (fresh(o.operations)?.group_meetings ?? []).map(g => ({ g, key: partKey(o.plan_id, `${g.person_id}:${g.meetings[0]?.starts_at ?? ""}`) })))];
  const decisions = brief.findings.filter(f => f.tone === "decision");
  const entries = feedbackOf(rules);
  const always = brief.findings.filter(f => alwaysFor(entries, briefTarget(f, capture.plan_id))).length;
  const drafts = brief.findings.filter(f => f.kind === "needs-people" && (f.people?.suggestions.length ?? 0) > 0).length + always;
  const roomKeys = rooms.map((f): FoundKey => ({ key: stableFindingKey(f.finding_id), kind: f.kind, tone: f.certainty === "confirmed" ? "decision" : "look" }));
  const followUpKeys = followUps.map((f): FoundKey => ({ key: stableFindingKey(f.finding_id), kind: f.kind, tone: "decision" }));
  const decisionKeys = decisions.map((f): FoundKey => ({ key: f.key, kind: f.kind, tone: f.tone }));
  // Kept for the briefing counts every service's findings too (each other's under its own keys).
  const keyed = (found: FoundKey[]) => ({ found, keys: found.map(f => f.key),
    all: [...foundOf(brief, ops), ...others.flatMap(o => foundOf(o.brief, o.operations).map(f => ({ ...f, key: partKey(o.plan_id, f.key) })))] });
  // Which of a room or group job's keys are each other service's own, so a job's first look at a service is a baseline.
  const ownKeys = (keys: (o: AlsoServices["others"][number]) => string[]) => others.length ? { others: Object.fromEntries(others.map(o => [o.plan_id, keys(o)])) } : {};
  switch (template) {
    case "watch-room-bookings": return { decisions: 0, looks: 0, findings: roomCounts, ...keyed(roomKeys), drafts: 0,
      ...ownKeys(o => roomsOf(fresh(o.operations)).map(f => stableFindingKey(f.finding_id))) };
    case "follow-ups-without-owner": return { decisions: 0, looks: 0, findings: { follow_ups: followUps.length }, ...keyed(followUpKeys), drafts: 0 };
    case "group-night-clashes": return {
      decisions: 0, looks: groups.length, findings: { groups: groups.length }, drafts: 0,
      ...keyed(groups.map(({ key }): FoundKey => ({ key, kind: "group-meeting", tone: "look" }))),
      ...ownKeys(o => (fresh(o.operations)?.group_meetings ?? []).map(g => partKey(o.plan_id, `${g.person_id}:${g.meetings[0]?.starts_at ?? ""}`))),
    };
    // The morning briefing's run line says the Sunday page's count too (polish pass): its rooms, follow-ups and group
    // meetings are in it, so they aren't listed beside it again.
    case "morning-briefing":
    default: {
      const shown = sundayShownCount(applyDecisions(brief, decided), ops ?? sundayOperations(capture, rules, { now, ...own }));
      const more = others.map(o => sundayShownCount(applyDecisions(o.brief, o.decisions), o.operations));
      return { decisions: more.reduce((n, c) => n + c.decisions, shown.decisions), looks: more.reduce((n, c) => n + c.looks, shown.looks), findings: {}, ...keyed(decisionKeys), drafts };
    }
  }
}

/**
 * What one B1 Church or Breeze check shows for Keep services covered or the morning briefing: the service page's own count
 * (sundayShownCount over the brief it shows, after the leader's decisions), its decisions as what a job tells, and notes
 * as drafts. These systems hold no rooms, follow-ups or group meetings, so there are none. Where the system shares no
 * number needed for any role (Breeze), "covered" can't be said, and the item says so (`unnumbered`); its counts are still
 * the page's. A brief that can't be built counts nothing (the run says why before it gets here).
 */
function systemFindings(template: TemplateId, capture: SystemJobCheck, rules: SundayRules, now: string, decided: readonly SundayDecision[]): Found {
  const built = systemJobBrief(capture, rules, now);
  const none: Found = { decisions: 0, looks: 0, findings: {}, found: [], keys: [], drafts: 0, all: [] };
  if (!built.ok || !runsOn(template, systemOf(capture))) return none;
  const brief = built.brief;
  const entries = feedbackOf(rules);
  const always = brief.findings.filter(f => alwaysFor(entries, briefTarget(f, capture.plan_id))).length;
  const drafts = brief.findings.filter(f => f.kind === "needs-people" && (f.people?.suggestions.length ?? 0) > 0).length + always;
  const found = brief.findings.filter(f => f.tone === "decision").map((f): FoundKey => ({ key: f.key, kind: f.kind, tone: f.tone }));
  const shown = sundayShownCount(applyDecisions(brief, decided), null);
  return { decisions: shown.decisions, looks: shown.looks, findings: {}, found, keys: found.map(f => f.key), drafts,
    all: foundOf(brief, null), ...(unnumberedRoster(brief) ? { unnumbered: true as const } : {}) };
}

/**
 * The regular Sunday check's onChanges. What got worse goes to Keep Sunday covered when it would run for it
 * now; the regular check then leaves the notice to that run and sends its own only if the run didn't decide
 * one (proactive.ts afterCapture). Otherwise nothing is handed over and the regular check's notice goes out
 * as it always has.
 */
export const handChanges = (runner: Pick<Runner, "takes" | "changes">) =>
  (changes: readonly SundayChange[], about: HandedChanges): Promise<boolean> | undefined => runner.takes(changes) ? runner.changes(changes, about) : undefined;

/** The runner App uses: with the church controls the Runner interface leaves optional (tests' fakes leave them out). */
export type ChurchRunner = Runner & Required<Pick<Runner, "churchInUse" | "answerSwitch" | "letGo" | "jobs" | "forgetChurch">>;
export function createRunner(deps: RunnerDeps): ChurchRunner {
  let hooks: RunnerHooks | null = null;
  let listing: Listing | null = null;
  let available = true;
  const saved: Record<string, Saved> = read<Record<string, Saved>>(deps.store, KEYS.state) ?? {};
  let noticed: NoticedItem[] = read<{ version: 1; items: NoticedItem[] }>(deps.store, KEYS.noticed)?.items ?? [];
  let held: Held[] = read<Held[]>(deps.store, KEYS.held) ?? [];
  let seenAt = read<string>(deps.store, KEYS.seen);
  let writeups: WriteUp[] = (read<{ version: 1; items: WriteUp[] }>(deps.store, KEYS.writeups)?.items ?? []).filter(w => w && typeof w.item === "string");
  const churches: Record<string, JobChurch> = read<Record<string, JobChurch>>(deps.store, KEYS.churches) ?? {};
  const questions: Record<string, { from: JobChurch; resume: boolean }> = read<Record<string, { from: JobChurch; resume: boolean }>>(deps.store, KEYS.questions) ?? {};
  /**
   * The church in use (churchInUse), and the last one known (kept across launches), so a switch is told apart from a
   * while with none known on the same system (a disconnect, a launch before the status, a sign-in that never answers).
   */
  let churchNow: JobChurch | null = null;
  let lastKnown: JobChurch | null = read<JobChurch>(deps.store, KEYS.church);
  /**
   * The church Ozzie uses now, once App says (keepWriteupsFor): only its write-ups are shown, so no id is ever filled
   * with another church's names, and none at all until it is known (review H, L9).
   */
  let church: string | null = null;
  const wakes: { from: string; to: string }[] = [];
  let launchedAt = deps.now();
  /** The zone at launch, for responsibilities confirmed before the store kept their own. Never changes mid-session. */
  let sessionZone: string | null = null;
  let running: { id: string; run_id: string; abort: AbortController } | null = null;
  let busy: Promise<unknown> | null = null;
  let openToday = false;
  let next: Record<string, string | null> = {};
  /** The newest live check, shared by runs that need one soon after. */
  let latest: { capture: JobCheck; at: number } | null = null;
  /** Planning Center asked Ozzie to slow down: no new check starts before this. */
  let slowUntil: string | null = null;
  const listeners = new Set<() => void>();
  const log = (line: string) => { try { deps.log?.(line); } catch { /* debug lines only */ } };
  const options = () => ({ fast: Boolean(deps.fast?.()) });

  const save = () => {
    deps.store.set(KEYS.state, JSON.stringify(saved));
    deps.store.set(KEYS.noticed, JSON.stringify({ version: 1, items: noticed }));
    deps.store.set(KEYS.held, JSON.stringify(held));
    deps.store.set(KEYS.writeups, JSON.stringify({ version: 1, items: writeups }));
    deps.store.set(KEYS.churches, JSON.stringify(churches));
    deps.store.set(KEYS.questions, JSON.stringify(questions));
    if (lastKnown) deps.store.set(KEYS.church, JSON.stringify(lastKnown));
  };
  /**
   * How many times every write-up was forgotten (deleted saved checks, a disconnect, a switch of church): the write-up of
   * a run under way then, still reading or still being prepared, is dropped when it comes back (review G, N2; K, L3). Stopping a job aborts its run, so its write-up
   * never comes back. One for another church is kept but never shown (build).
   */
  let forgotten = 0;
  /** A run's write-up, kept with it: the newest WRITEUPS_KEPT_PER_JOB of each job. Never read by anything that decides. */
  const keepWriteup = (w: WriteUp, since: number) => {
    if (since !== forgotten) return;
    const mine = [w, ...writeups.filter(x => x.responsibility_id === w.responsibility_id && x.item !== w.item)].slice(0, WRITEUPS_KEPT_PER_JOB);
    writeups = [...mine, ...writeups.filter(x => x.responsibility_id !== w.responsibility_id)].slice(0, WRITEUPS_KEPT);
  };
  const forgetWriteups = (keep: (w: WriteUp) => boolean) => { writeups = writeups.filter(keep); };
  const attention = (i: NoticedItem) => i.kind === "found" || i.kind === "couldnt-check" || i.kind === "missed" || i.kind === "briefing";
  /**
   * What Keeping watch and Today show: on B1 Church or Breeze only the jobs that church can run and what they noticed (the
   * rest wait, unshown); on Planning Center everything, as before.
   */
  /**
   * The church whose jobs and items the pages show: the one in use; while none is known on the system the last one was on
   * (a disconnect, a launch before the status), that one; after a switch to a system whose church isn't connected, none.
   * `undefined` before App has said anything (every job and item is shown, as before churches were kept).
   */
  const viewChurch = (): string | null | undefined => !churchNow ? undefined
    : churchNow.church ?? (lastKnown?.church && lastKnown.system === churchNow.system ? lastKnown.church : null);
  /** That church, whole (its name and system), when there is one: what a question names and an answer applies to. */
  const shownChurch = (): JobChurch | null => churchNow?.church ? churchNow
    : churchNow && lastKnown?.church && lastKnown.system === churchNow.system ? lastKnown : null;
  const build = (): RunnerView => {
    const system = hooks?.context().system;
    // Only the church in use's items (one kept before churches were, until it is first stamped, as before). While the
    // church in use isn't known on the system it was last known on (a disconnect, a launch before the status), that last
    // church's: its jobs stay shown, waiting (none runs meanwhile). After a switch to another system whose church isn't
    // connected yet, no church's items and no job confirmed for a church: none is ever shown under another church.
    const cur = viewChurch();
    const here = !churchNow ? noticed : noticed.filter(i => i.church === undefined || (cur !== null && i.church === cur));
    const ownHere = (r: Responsibility) => !churchNow || !churches[r.id]?.church || churches[r.id]!.church === cur;
    const shown = system ? here.filter(i => runsOn(i.template, system)) : here;
    // A question waiting for an answer stays while the church it names isn't connected for a while (it is the one shown).
    const to = shownChurch();
    const asked = to ? (listing?.items ?? []).filter(r => r.status !== "ended" && Object.hasOwn(questions, r.id) && questions[r.id]!.from.church !== to.church)
      .map((r): SwitchQuestion => ({ responsibility_id: r.id, template: r.template, title: r.title, from: questions[r.id]!.from, to,
        ...(churchNow?.church ? {} : { waiting: true as const }) })) : [];
    // Kinds this Mac keeps for another church, not asked about: never offered to set up again here (native allows one).
    const held = churchNow ? (listing?.items ?? []).filter(r => r.status !== "ended" && runsOn(r.template, system) && !ownHere(r) && !asked.some(q => q.responsibility_id === r.id))
      .map(r => ({ responsibility_id: r.id, template: r.template, title: r.title, church: churches[r.id]! })) : [];
    const stalled = (listing?.items ?? []).filter(r => r.status !== "ended" && saved[r.id]?.mismatch_hold).map(r => r.id);
    const runSystems = Object.fromEntries(noticed.flatMap(i => i.run_id && i.system ? [[i.run_id, i.system] as const] : []));
    return {
      available, paused_all: listing?.paused_all ?? false,
      items: (listing?.items ?? []).filter(r => runsOn(r.template, system) && ownHere(r) && !asked.some(q => q.responsibility_id === r.id)), noticed: shown,
      writeups: Object.fromEntries(writeups.filter(w => church !== null && w.organization === church).map(w => [w.item, w])), next, running: running?.id ?? null,
      unseen: shown.filter(i => attention(i) && (!seenAt || i.at > seenAt)).length, open_today: openToday,
      ...(asked.length ? { questions: asked } : {}), ...(Object.keys(runSystems).length ? { run_systems: runSystems } : {}),
      ...(held.length ? { held } : {}), ...(stalled.length ? { stalled } : {}),
    };
  };
  let snapshot = build();
  const emit = () => { save(); snapshot = build(); listeners.forEach(l => l()); };
  /** During quiet hours (this Mac's clock, as notices follow it): the morning briefing labels it Overnight. */
  const overnight = (at: string) => {
    const ctx = hooks?.context();
    return Boolean(ctx && inQuietHours(ctx.quiet, at, ctx.macZone));
  };
  /**
   * One item. Its church and system are the caller's (what the run read when it started, or the job's own church), never
   * whichever church is in use when it is added; with none given, the job's own church.
   */
  const add = (item: Omit<NoticedItem, "id">): NoticedItem => {
    const own = churches[item.responsibility_id];
    const stamped = item.church === undefined && own?.church ? { ...item, church: own.church, ...(own.system !== "planning-center" && !item.system ? { system: own.system } : {}) } : item;
    const marked = stamped.kind !== "briefing" && stamped.kind !== "ended" && stamped.kind !== "clear" && overnight(stamped.at) ? { ...stamped, overnight: true } : stamped;
    const full = { ...marked, id: `${item.responsibility_id}:${item.at}:${item.kind}` };
    noticed = [full, ...noticed.filter(i => i.id !== full.id)].slice(0, NOTICED_KEPT);
    return full;
  };
  const patch = (id: string, change: Partial<NoticedItem>) => { noticed = noticed.map(i => i.id === id ? { ...i, ...change } : i); };
  const stateOf = (id: string): Saved => ({ ...fresh(), ...saved[id] });
  const zoneOf = (r: Pick<Responsibility, "zone">): string => r.zone && isTimeZone(r.zone) ? r.zone : sessionZone ??= hooks?.context().zone ?? "UTC";

  /** Pausing drops held notices, as the regular Sunday check's pause does; what they were about stays in Ozzie. */
  const dropHeld = (id?: string) => {
    const dropped = held.filter(h => !id || h.item.startsWith(`${id}:`));
    for (const h of dropped) patch(h.item, { notice: "none" });
    held = held.filter(h => !dropped.includes(h));
  };
  /** Pausing takes effect at once: the running run stops and ends as cancelled. */
  const cancelRunning = (id?: string) => { if (running && (!id || running.id === id)) running.abort.abort(); };
  /** Scheduled times while paused aren't missed: pausing remembers when, resuming moves past them. */
  const markPaused = (ids: readonly string[]) => {
    for (const id of ids) { const s = stateOf(id); if (!s.paused_at) saved[id] = { ...s, paused_at: deps.now() }; }
  };
  const markResumed = (ids: readonly string[]) => {
    const now = deps.now();
    for (const id of ids) {
      const s = stateOf(id);
      if (!s.paused_at) continue;
      // One that never had its first check still has it; one that had moves on to its next time. A refusal
      // because it was paused no longer holds it back.
      const started = s.last_slot !== null || s.last_run_at !== null;
      saved[id] = { ...s, paused_at: null, not_before: null, last_slot: started && (!s.last_slot || ms(now) > ms(s.last_slot)) ? now : s.last_slot };
    }
  };
  const activeIds = () => (listing?.items ?? []).filter(r => r.status === "active").map(r => r.id);

  async function refresh() {
    try {
      listing = await deps.native.list();
      available = true;
      // A job that ended, or that Ozzie no longer keeps, takes its write-ups with it.
      const current = new Set(listing.items.filter(r => r.status !== "ended").map(r => r.id));
      forgetWriteups(w => current.has(w.responsibility_id));
      const now = deps.now();
      for (const r of listing.items) {
        const s = stateOf(r.id);
        // A dated responsibility that ended on its own says so once, after any times it missed on the way.
        if (r.status === "ended" && r.lifetime.kind === "until" && !s.ended_told && ms(now) >= ms(r.lifetime.ends_at)) {
          const from = Math.max(ms(s.last_slot ?? r.confirmed_at), ms(r.lifetime.ends_at) - LOOKBACK_MS);
          // Times after it was paused weren't missed; it was paused.
          const missed = scheduledSlots(r, iso(from), s.paused_at ?? r.lifetime.ends_at, zoneOf(r), options());
          if (missed.length) {
            add({ responsibility_id: r.id, template: r.template, at: r.lifetime.ends_at, kind: "missed", scheduled_for: missed[0]!, missed_count: missed.length,
              missed_reason: missedReason(missed[0]!, s), before_end: true });
          }
          add({ responsibility_id: r.id, template: r.template, at: r.lifetime.ends_at, kind: "ended", until: r.lifetime.until, ...(missed.length ? { missed_count: missed.length } : {}) });
          saved[r.id] = { ...s, ended_told: true, last_slot: missed.at(-1) ?? s.last_slot };
          continue;
        }
        // A run the store closed as interrupted (Ozzie closed while it ran, or it ran too long) says so and is tried again.
        const last = r.runs[0];
        if (last?.outcome === "interrupted" && s.interrupted_told !== last.run_id) {
          if (r.status === "ended") { saved[r.id] = { ...s, interrupted_told: last.run_id }; continue; }
          const retry = retryAt(r, now, options());
          add({ responsibility_id: r.id, template: r.template, at: last.ended_at ?? now, kind: "couldnt-check", code: "interrupted", retry_at: retry,
            scheduled_for: last.started_at, trigger: last.trigger, notice: "none" });
          saved[r.id] = { ...s, interrupted_told: last.run_id, retry_at: retry, failures: s.failures + 1 };
        }
      }
    } catch { available = false; }
  }
  /** Whether a notice may still go out: nothing paused, the responsibility still active. Asked of the store itself. */
  async function stillActive(id: string): Promise<boolean> {
    try {
      listing = await deps.native.list();
      available = true;
    } catch { return false; }
    return !listing.paused_all && listing.items.find(r => r.id === id)?.status === "active";
  }

  /**
   * `urgent`: inside the church's window, or a kind the person asked to hear about right away. Quiet hours
   * still hold it unless the person chose to let urgent notices through; Ozzie never widens that itself.
   * `macOnly`: only background checks brought it, so its phone line stays back (rechecked if it is held).
   */
  async function notice(kind: NoticeKind, item: NoticedItem, trigger: RunTrigger, id: string, urgent = false, found?: FoundKey[], macOnly = false) {
    // A person who just asked is already looking.
    if (trigger === "start" || trigger === "manual") { patch(item.id, { notice: "in-app" }); return; }
    if (!await stillActive(id)) { patch(item.id, { notice: "none" }); return; }
    const ctx = hooks!.context();
    const decision = urgent && ctx.urgentDuringQuiet === true ? { send: true as const } : quietDeferral(deps.now(), ctx.quiet, ctx.macZone);
    if (!decision.send) {
      // Each one is kept (one notice per kind still goes out), so a cause reversed later never hides an earlier one.
      held = [...held, { kind, at: decision.at, item: item.id, ...(found ? { found } : {}), mac_only: macOnly }].slice(-HELD_KEPT);
      patch(item.id, { notice: "held" });
      return;
    }
    try { await sendNotice(deps, kind, macOnly); patch(item.id, { notice: "sent" }); } catch { patch(item.id, { notice: "unavailable" }); }
    if (kind === "briefing-ready") openToday = true;
  }
  /**
   * Whether a held notice is still worth sending once quiet hours end (owner decision: a held notice is
   * rechecked for relevance before it goes out). Rechecked against the newest saved check, with no new
   * Planning Center read: this job's memory of that Sunday, brought up to date with a newer check when the
   * app made one. A change reversed meanwhile, or a finding no longer there, no longer counts; neither does
   * one the person's Church rules now keep out of notices. "Couldn't check" no longer counts once a later
   * check of the same job finished. A briefing or an every-check notice is the person's own choice: it goes.
   * Returns null when nothing brings it any more; otherwise `kinds`: the finding kinds that still bring it (null in
   * the list for a cause that isn't a finding of a known kind), or `kinds: null` when it can no longer be rechecked
   * (its run record is gone, or it was held before its findings were kept), so the phone line falls back to what was
   * so when it was held (phone-notice.ts `heldMacOnly`).
   */
  function stillCause(h: Held): { kinds: (string | null)[] | null } | null {
    const item = noticed.find(i => i.id === h.item);
    if (!item || !hooks) return { kinds: null };
    if (h.kind === "couldnt-check") return noticed.some(i => i.responsibility_id === item.responsibility_id && i.at > item.at && (i.kind === "found" || i.kind === "clear" || i.kind === "briefing")) ? null : { kinds: [null] };
    if (h.kind !== "needs-decision") return { kinds: [null] };
    if (!h.found || !item.check) return { kinds: null };
    const ctx = hooks.context();
    const entries = feedbackOf(ctx.rules);
    const plan = item.check.plan_id;
    const newer = latest && latest.capture.plan_id === plan && ms(latest.capture.completed_at) > ms(item.check.completed_at) ? latest.capture : null;
    let memory = stateOf(item.responsibility_id).memory;
    if (memory && memory.latest.plan_id !== plan) memory = null;
    const record = newer && memory && ms(newer.completed_at) > ms(memory.latest.completed_at) ? recordOf(newer, ctx.rules, newer.completed_at) : null;
    if (memory && record) memory = compareSundayCheck(memory, record, { now: deps.now(), urgentWithinHours: ctx.urgentWithinHours }).memory;
    const holding = (item.changes ?? []).filter(c => !memory || changeStillHolds(c, memory));
    const changed = routeChanges(holding, entries).notify;
    if (changed.length) return { kinds: changed.map(changeKind) };
    // New findings: still there in a newer check that read what this job reads; otherwise as its own check found them.
    const answers = newer && (!TEMPLATES[item.template].needs.includes("operations") || (!isSystemCheck(newer) && newer.reads.some(isOperationsRead)));
    const still = answers ? findingsFor(item.template, newer, ctx.rules, newer.completed_at, [], isSystemCheck(newer) ? null : ctx.alsoServices?.(newer) ?? null).found.filter(f => h.found!.some(x => x.key === f.key)) : h.found;
    const notify = routeFindings(still, entries).notify;
    return notify.length ? { kinds: still.filter(f => notify.includes(f.key)).map(f => f.kind) } : null;
  }
  /** Held notices go out once quiet hours end, one per kind, the most important first, for what is still so. */
  async function deliverHeld() {
    if (!held.length || !hooks || listing?.paused_all) return;
    const ctx = hooks.context();
    if (!quietDeferral(deps.now(), ctx.quiet, ctx.macZone).send) return;
    const due = held.filter(h => ms(h.at) <= ms(deps.now()));
    held = held.filter(h => ms(h.at) > ms(deps.now()));
    const kinds = new Map<NoticeKind, { list: Held[]; macOnly: boolean }>();
    for (const h of due) {
      // One that no longer holds says no notice was needed.
      const cause = stillCause(h);
      if (!cause) { patch(h.item, { notice: "none" }); continue; }
      // One notice per kind: it stays on this Mac only if every held one it stands for does.
      const kind = kinds.get(h.kind) ?? { list: [], macOnly: true };
      kinds.set(h.kind, { list: [...kind.list, h], macOnly: kind.macOnly && heldMacOnly(h.mac_only, cause.kinds) });
    }
    for (const [kind, { list, macOnly }] of [...kinds].sort(([a], [b]) => NOTICE_RANK[b] - NOTICE_RANK[a])) {
      let outcome: NoticedItem["notice"] = "sent-later";
      try { await sendNotice(deps, kind, kind === "needs-decision" && macOnly); } catch { outcome = "unavailable"; }
      for (const h of list) patch(h.item, { notice: outcome });
      if (kind === "briefing-ready") openToday = true;
    }
  }
  /**
   * The morning briefing brings in what came up overnight (owner decision, October 26): notices held for
   * quiet hours become part of it instead of a catch-up flood of their own. Returns how many items came up
   * overnight since the last briefing.
   */
  function foldIntoBriefing(briefing: NoticedItem): number {
    for (const h of held) patch(h.item, { notice: "in-briefing" });
    held = [];
    const previous = noticed.find(i => i.kind === "briefing" && i.id !== briefing.id && i.at < briefing.at);
    return noticed.filter(i => i.overnight && i.id !== briefing.id && i.at <= briefing.at && (!previous || i.at > previous.at)
      && (i.church === undefined || briefing.church === undefined || i.church === briefing.church)).length;
  }
  /** A morning briefing due now (and able to run) gathers held notices itself. */
  function briefingDue(ready: boolean): boolean {
    if (!ready || !listing || listing.paused_all) return false;
    const now = deps.now();
    return listing.items.some(r => r.template === "morning-briefing" && dueNow(r, stateOf(r.id), now, zoneOf(r), options()).due);
  }
  /**
   * A saved morning briefing still on the earlier default time and days moves to the settled default
   * (7:00 AM weekdays), once: a person who later picks the old time keeps it.
   */
  async function settleDefaults() {
    if (!listing) return;
    const done = new Set(read<string[]>(deps.store, KEYS.settled) ?? []);
    let changed = false;
    for (const r of listing.items) {
      if (done.has(r.id)) continue;
      const plan = settledPlan(r, zoneOf(r));
      if (!plan) continue;
      done.add(r.id);
      changed = true;
      try { await deps.native.edit(r.id, plan); log(`responsibility: settled defaults template=${r.template}`); } catch { /* it keeps its saved time */ }
    }
    if (changed) { deps.store.set(KEYS.settled, JSON.stringify([...done].slice(-50))); await refresh(); }
  }

  function missedReason(slot: string, s: Saved): NonNullable<NoticedItem["missed_reason"]> {
    if (s.waiting_since && ms(s.waiting_since) <= ms(slot)) return "waiting";
    if (wakes.some(w => ms(w.from) <= ms(slot) && ms(slot) <= ms(w.to))) return "asleep";
    if (ms(slot) < ms(launchedAt)) return "closed";
    return "unknown";
  }

  /** A check recent enough to share, or null. */
  function shared(): JobCheck | null {
    const window = options().fast ? FAST_SHARED_CHECK_MS : SHARED_CHECK_MS;
    return latest && ms(deps.now()) - latest.at < window && hooks?.belongs?.(latest.capture) !== false ? latest.capture : null;
  }
  /** Jobs held back by mismatches whose own church this check read (or every one, `all`): they run again. */
  function release(of: string | null) {
    for (const [id, st] of Object.entries(saved)) {
      if (!st.mismatch_hold || (of !== null && churches[id]?.church && churches[id]!.church !== of)) continue;
      const { mismatches: _m, mismatch_hold: _h, ...rest } = st;
      void _m; void _h;
      saved[id] = rest;
    }
  }
  function captured(capture: JobCheck) {
    if (capture.kind !== "live" || hooks?.belongs?.(capture) === false) return;
    release(capture.organization);
    const at = Number.isFinite(ms(capture.completed_at)) ? Math.min(ms(capture.completed_at), ms(deps.now())) : ms(deps.now());
    if (!latest || at >= latest.at) latest = { capture, at };
    if (readsOf(capture).some(r => r.outcome === "rate-limited")) slowDown();
  }
  function slowDown() { slowUntil = iso(ms(deps.now()) + (options().fast ? FAST_RATE_LIMIT_WAIT_MS : RATE_LIMIT_WAIT_MS)); }
  const slowing = () => slowUntil !== null && ms(deps.now()) < ms(slowUntil);
  /**
   * One check for every run that needs one now: a recent one is shared (except for Check now, which reads
   * again); otherwise the app's own path, which shares a check already running.
   */
  async function check(trigger: RunTrigger): Promise<JobCheck> {
    const recent = trigger === "manual" ? null : shared();
    if (recent) return recent;
    try {
      const capture = await hooks!.check();
      // Finished after Ozzie switched churches: not this church's Sunday, so not acted on; the run ends as if paused.
      if (hooks!.belongs?.(capture) === false) throw FOREIGN;
      captured(capture);
      return capture;
    } catch (error) {
      if (rateLimited(error)) slowDown();
      throw error;
    }
  }

  /**
   * `fallback`: changes the regular Sunday check handed over with a notice of its own to send if this run
   * doesn't decide one. Then a run that can't finish says so in Ozzie without a notice of its own: the
   * regular check's notice is the one the person gets.
   */
  async function run(r: Responsibility, trigger: RunTrigger, slot: string | null, missed: string[], fallback = false): Promise<RunResult> {
    if (!hooks) return { status: "skipped" };
    const started = deps.now();
    // Taken before anything is read: a forget while this run still reads Planning Center drops its write-up too (review K, L3).
    const since = forgotten;
    const s = stateOf(r.id);
    // The church and system this run is for, as they are when it starts: what it says stays theirs whatever happens next.
    const own = churches[r.id];
    const runSystem = hooks.context().system ?? undefined;
    const whose = { ...(own?.church ? { church: own.church } : churchNow?.church ? { church: churchNow.church } : {}), ...(runSystem ? { system: runSystem } : {}) };
    // Kept for a new church after a switch: its first check there tells nothing (owner decision 2026-11-22).
    const quietFirst = s.baseline === true;
    let grant: Grant;
    try { grant = await deps.native.begin(r.id, trigger); }
    catch (error) {
      const code = refusalOf(error);
      log(`responsibility: begin refused=${code}`);
      // Never asked again before the store would allow it.
      // A used-up daily limit counts every job of this kind (a stopped copy too), so wait until one of those checks is a day old.
      const until = (code === "checks-limit" ? checksFreeAt(r, listing?.items ?? [], started) : null) ?? refusedUntil(r, code, started, options());
      if (code === "too-soon" || code === "busy") { saved[r.id] = { ...s, not_before: until }; return { status: "refused", code }; }
      const day = started.slice(0, 10);
      if (code === "checks-limit" && s.limit_told !== day) {
        add({ responsibility_id: r.id, template: r.template, at: started, kind: "limit", trigger, ...whose });
        saved[r.id] = { ...s, limit_told: day };
      }
      const broken = code === "unavailable" || code === "invalid";
      // Paused, ended or over its limit: this slot is covered; the next one is tried as usual.
      saved[r.id] = { ...stateOf(r.id), last_slot: slot ?? s.last_slot, retry_at: broken ? until : null, not_before: until, failures: s.failures + (broken ? 1 : 0) };
      if (broken) {
        // The store couldn't be read, or refused the plan as saved: say so, and try again later.
        const item = add({ responsibility_id: r.id, template: r.template, at: started, kind: "couldnt-check", code, retry_at: until, scheduled_for: slot ?? started, trigger, ...whose });
        if (s.failures === 0 && !fallback) await notice("couldnt-check", item, trigger, r.id);
        else patch(item.id, { notice: "none" });
      }
      return { status: "refused", code };
    }
    const abort = new AbortController();
    running = { id: r.id, run_id: grant.run_id, abort };
    const cancelled = new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(CANCELLED), { once: true }));
    cancelled.catch(() => undefined);
    const guard = <T,>(work: Promise<T>) => Promise.race([work, cancelled]);
    // One run covers every scheduled time up to now.
    saved[r.id] = { ...s, last_slot: slot ?? s.last_slot ?? started, last_run_at: started, waiting_since: null, not_before: null };
    emit();
    if (missed.length) {
      add({ responsibility_id: r.id, template: r.template, at: started, kind: "missed", scheduled_for: missed[0]!, missed_count: missed.length,
        missed_reason: missedReason(missed[0]!, s), ran_at: started, trigger, ...whose });
    }
    const fail = async (code: FailureCode, access = false, why: Partial<Pick<NoticedItem, "read" | "no_roles">> = {}): Promise<RunResult> => {
      const failures = stateOf(r.id).failures + 1;
      const retry = access ? null : retryAt(r, deps.now(), options());
      saved[r.id] = { ...stateOf(r.id), failures, retry_at: retry };
      await deps.native.end(r.id, grant.run_id, "failed", code, 0, 0).catch(() => undefined);
      log(`responsibility: run status=failed code=${code} noticed=0 drafts=0`);
      const item = add({ responsibility_id: r.id, template: r.template, at: deps.now(), kind: "couldnt-check", code, retry_at: retry, scheduled_for: slot ?? started, trigger, run_id: grant.run_id,
        ...(access ? { access } : {}), ...why, ...whose });
      // Reported once per streak; retries continue quietly.
      if (failures === 1 && !fallback) await notice("couldnt-check", item, trigger, r.id);
      else patch(item.id, { notice: "none" });
      return { status: "failed", code, noticed: 0, drafts: 0 };
    };
    try {
      const ctx = hooks.context();
      if (TEMPLATES[r.template].needs.includes("operations") && !ctx.granted.includes("operations")) return await fail("denied", true);
      let capture: JobCheck;
      try { capture = await guard(check(trigger)); }
      catch (error) { if (error === CANCELLED) throw error; if (error === FOREIGN) throw MISMATCH; return await fail(checkFailure(error), false, readWord(error)); }
      const now = deps.now();
      // A check of another church than the one this job was confirmed for (the church changed as it started): nothing of
      // it is kept or told; the run ends as if paused, and the switch's question comes next.
      if (own?.church && capture.organization !== own.church) throw MISMATCH;
      // A B1 Church or Breeze check that can't make a service check (no roles, no service times) or, on B1 Church, waits for
      // the church's time zone to be confirmed: nothing is counted or compared, and the run says so.
      if (isSystemCheck(capture)) {
        const built = systemJobBrief(capture, ctx.rules, now);
        if (!built.ok || built.coverage.waiting_for_zone) return await fail("partial", false, !built.ok && built.reason === "no-roles" ? { no_roles: true } : {});
      }
      // Every service watched, as the Services page shows them (and the job's write-up reads them).
      const found = findingsFor(r.template, capture, ctx.rules, now, ctx.decisionsFor?.(capture) ?? [], isSystemCheck(capture) ? null : ctx.alsoServices?.(capture) ?? null);
      // What changed since this responsibility last looked at the same Sunday.
      let changes: SundayChange[] = [];
      let memory = stateOf(r.id).memory;
      const record = capture.kind === "live" && (r.template === "keep-sunday-covered" || r.template === "morning-briefing") ? recordOf(capture, ctx.rules, now) : null;
      if (record) {
        const compared = compareSundayCheck(memory, record, { now, urgentWithinHours: ctx.urgentWithinHours });
        changes = compared.changes;
        memory = compared.memory;
      }
      const reported = new Set(stateOf(r.id).reported);
      // Another service this job looks at for the first time (newly watched, moved on to its next plan, or the first run
      // since each service's own rooms and group meetings were counted): what it shows now is a baseline, as the notices
      // take a service's first check, kept as already reported without a notice; anything new after this is told. Its
      // mark (`["seen", plan]`) is kept with the reported keys.
      const baseline = new Set(Object.entries(found.others ?? {}).filter(([plan]) => !reported.has(seenMark(plan))).flatMap(([, keys]) => keys));
      const newKeys = found.keys.filter(k => !reported.has(k) && !baseline.has(k));
      // The person's Church rules on notices: "Put this in the briefing" keeps a kind out of them; "Always
      // tell me right away" marks it urgent; what they asked Ozzie to stop flagging is left out altogether.
      const entries = feedbackOf(ctx.rules);
      const routed = routeChanges(changes, entries);
      const listed = changes.filter(c => !routed.stopped.includes(c));
      const worse = listed.some(c => c.effect === "worse");
      const count = found.decisions + found.looks + (found.findings.rooms ?? 0) + (found.findings.rooms_uncertain ?? 0) + (found.findings.follow_ups ?? 0)
        + (r.template === "group-night-clashes" ? 0 : (found.findings.groups ?? 0));
      const drafts = found.drafts;
      const briefing = r.template === "morning-briefing";
      // "Put this in the briefing": the briefing lists what the person's Church rules keep for it.
      const forBriefing = briefing ? keptForBriefing(found.all, entries) : [];
      const kind: NoticedItem["kind"] = briefing ? "briefing" : count > 0 || worse ? "found" : "clear";
      const item = add({
        responsibility_id: r.id, template: r.template, at: now, kind, trigger, run_id: grant.run_id, check: { plan_id: capture.plan_id, completed_at: capture.completed_at },
        decisions: found.decisions, looks: found.looks, findings: found.findings,
        changes: listed, drafts, ...(briefing && includesSundayReady(now, zoneOf(r)) ? { sunday_ready: true } : {}),
        ...(forBriefing.length ? { kept: forBriefing } : {}), ...(found.unnumbered ? { unnumbered: true as const } : {}),
        // What this check read: its church, and its system when it isn't Planning Center.
        church: capture.organization, ...(isSystemCheck(capture) ? { system: systemOf(capture) } : {}),
      });
      const { baseline: _quiet, mismatches: _m, mismatch_hold: _h, ...settled } = stateOf(r.id);
      void _quiet; void _m; void _h;
      saved[r.id] = { ...settled, failures: 0, retry_at: null, memory,
        reported: [...new Set([...Object.keys(found.others ?? {}).map(seenMark), ...found.keys, ...stateOf(r.id).reported])].slice(0, REPORTED_KEPT) };
      if (briefing) {
        const n = foldIntoBriefing(item);
        if (n) patch(item.id, { overnight_count: n });
      }
      // Worth a look never brings a notice (only the person's own "Always tell me right away" does); it shows in Ozzie.
      const fresh = routeFindings(found.found.filter(f => newKeys.includes(f.key)), entries);
      const kept = routeFindings(found.found, entries);
      const urgent = routed.urgent || fresh.urgent;
      const noticeKind: NoticeKind | null = briefing ? "briefing-ready"
        : r.report === "every-check" ? (kept.notify.length > 0 || routed.notify.length > 0 ? "needs-decision" : "checked")
          : fresh.notify.length > 0 || routed.notify.length > 0 ? "needs-decision" : null;
      const briefingOnly = fresh.briefing.length + routed.briefing.length > 0 && trigger !== "start" && trigger !== "manual";
      // What brought a "needs a decision" notice, so a held one can be rechecked before it goes out.
      const cause = noticeKind === "needs-decision" ? found.found.filter(f => (r.report === "every-check" ? kept : fresh).notify.includes(f.key)) : undefined;
      // Only background checks brought it: "A notice on your phone" leaves it on this Mac. A mix still goes.
      const macOnly = noticeKind === "needs-decision" && thisMacOnly([...routed.notify.map(changeKind), ...(cause ?? []).map(f => f.kind)]);
      // A baseline (the first check for a church after a switch) is shown in Ozzie and tells nothing.
      if (quietFirst) patch(item.id, { notice: trigger === "start" || trigger === "manual" ? "in-app" : "none" });
      else if (noticeKind) await notice(noticeKind, item, trigger, r.id, urgent, cause, macOnly);
      else patch(item.id, { notice: briefingOnly ? "briefing" : "none" });
      // The AI's write-up, or why there is none: after the notice is decided and sent or held, so a notice never waits on
      // the model and quiet hours are judged at check time (review H, L14). Everything above is worked out without it.
      // Pausing now stops the write-up only; the check and its notice stand. With no AI route set up, nothing is kept
      // and the card shows the check alone (L15).
      let ready: Prepared | null = null;
      let why: NoWriteup | null = !ctx.modelReady ? "off" : grant.ai_steps <= 0 ? "spent" : null;
      if (!why) {
        try { ready = await guard(hooks.prepare(r, grant, capture, abort.signal, trigger)); }
        catch (error) { if (error !== CANCELLED && !abort.signal.aborted) ready = null; else why = "stopped"; }
        why ??= !ready ? "unavailable" : ready.status === "verified" && ready.writeup ? null : whyNot(ready.code, ready.allowance, ready.noCredit);
      }
      const about = { item: item.id, responsibility_id: r.id, run_id: grant.run_id, organization: capture.organization, at: item.at };
      if (why !== "off" && why !== "stopped") {
        keepWriteup(ready?.writeup && !why ? { ...about, kind: "written", ...ready.writeup, ai_steps: ready.ai_steps } : { ...about, kind: "none", why: why ?? "unavailable" }, since);
      }
      await deps.native.end(r.id, grant.run_id, "ok", null, count, drafts).catch(() => undefined);
      log(`responsibility: run status=ok code=- noticed=${count} drafts=${drafts}${ready ? ` summary=${ready.status}` : ""}`);
      // "none": nothing new for this run to tell, or paused before its notice. Anything else is a decision.
      const decided = noticed.find(i => i.id === item.id)?.notice;
      return { status: "ok", code: null, noticed: count, drafts, ...(decided && decided !== "none" ? { decided_for: capture.plan_id } : {}) };
    } catch (error) {
      if (error === MISMATCH) {
        // Its check came back from another church or service: it ends as cancelled, quietly, and is counted; the second in a
        // row holds it back, so a mismatch that lasts never uses its checks unseen (its card says why it waits).
        const n = (stateOf(r.id).mismatches ?? 0) + 1;
        saved[r.id] = { ...stateOf(r.id), mismatches: n, ...(n >= MISMATCHES_HELD_AFTER ? { mismatch_hold: true as const } : {}) };
        await deps.native.end(r.id, grant.run_id, "failed", "cancelled", 0, 0).catch(() => undefined);
        log(`responsibility: run status=failed code=cancelled mismatch=${n}`);
        return { status: "failed", code: "cancelled", noticed: 0, drafts: 0 };
      }
      if (error === CANCELLED || abort.signal.aborted) {
        // Paused while it ran: it ends as cancelled, quietly; nothing is retried or announced.
        await deps.native.end(r.id, grant.run_id, "failed", "cancelled", 0, 0).catch(() => undefined);
        log("responsibility: run status=failed code=cancelled noticed=0 drafts=0");
        return { status: "failed", code: "cancelled", noticed: 0, drafts: 0 };
      }
      return await fail("provider-failure");
    } finally {
      running = null;
      await refresh();
      emit();
    }
  }

  /**
   * When the native timer should next wake this page. Something due that can't run is never "now":
   * waiting for Planning Center is covered by the regular tick, and a refusal or a slow-down waits
   * until it is over. The native timer adds its own floor as well (always_on.rs MIN_DUE_LEAD/GAP).
   */
  function nextFor(r: Responsibility, ready: boolean, now: string): string | null {
    const s = stateOf(r.id);
    const due = dueNow(r, s, now, zoneOf(r), options());
    if (!due.due) return due.next;
    if (!ready) return null;
    const blocked = [s.not_before, slowing() && !shared() ? slowUntil : null].filter((x): x is string => x !== null && ms(x) > ms(now)).sort().at(-1);
    return blocked ?? now;
  }
  function scheduleNext() {
    if (!listing || !hooks) return;
    const ready = hooks.context().ready;
    const now = deps.now();
    const system = hooks.context().system;
    // A job confirmed for a church while none is known (a disconnect): no time is promised; its card says what it waits for.
    const unknown = (r: Responsibility) => churchNow !== null && !churchNow.church && Boolean(churches[r.id]?.church);
    next = Object.fromEntries(listing.items.map(r => [r.id, listing!.paused_all || unknown(r) ? null
      : nextFor(r, ready && runsOn(r.template, system) && !Object.hasOwn(questions, r.id), now)]));
    const soonest = Object.values(next).filter((x): x is string => x !== null).sort()[0] ?? null;
    try { deps.nextDue?.(soonest); } catch { /* the regular tick still comes */ }
  }

  /** Whether `own` is the church in use. */
  const isHere = (own: JobChurch | undefined, here: JobChurch) => Boolean(own?.church) && own!.church === here.church;
  /**
   * Each job against the church in use (owner decision 2026-11-22): one confirmed for it runs (a question about it, from a
   * switch away and back, is dropped and it resumes as it was); one confirmed for another church pauses and is asked about
   * once. A job from before churches were kept was Planning Center's (jobs ran nowhere else), following its church in use:
   * on a Planning Center church it belongs to that one, with no question and nothing told; on another system it is asked
   * about as Planning Center's. Only jobs the church's system can run are asked about; the rest wait, unshown.
   */
  async function reconcile(): Promise<boolean> {
    const here = churchNow;
    if (!here?.church || !listing) return false;
    let paused = false, changed = false;
    // Items kept before churches were: the job's church when known, else this Planning Center church's, else no one's.
    if (noticed.some(i => i.church === undefined)) {
      changed = true;
      noticed = noticed.map(i => i.church !== undefined ? i
        : { ...i, church: churches[i.responsibility_id]?.church ?? (here.system === "planning-center" ? here.church! : "") });
    }
    for (const r of listing.items) {
      if (r.status === "ended") continue;
      let own = churches[r.id];
      if (!own) { own = churches[r.id] = here.system === "planning-center" ? { church: here.church, name: here.name, system: here.system } : { church: null, name: null, system: "planning-center" }; changed = true; }
      // Confirmed before a church was known: the first church used takes it over (one made on another system before it was
      // connected; or one from before churches were kept, which was Planning Center's and followed its church in use, so the
      // first Planning Center church used after the upgrade, without a question, even if this Mac has used two of them).
      else if (own.church === null && (own.adopt || (own.system === "planning-center" && here.system === "planning-center"))) {
        own = churches[r.id] = { church: here.church, name: here.name, system: here.system }; changed = true;
      }
      // Its church's name, once Ozzie knows it (a question names it).
      else if (isHere(own, here) && !own.name && here.name) { own = churches[r.id] = { ...own, name: here.name }; changed = true; }
      const asked = questions[r.id];
      if (isHere(own, here)) {
        if (asked) {
          changed = true;
          delete questions[r.id];
          if (asked.resume) { try { await deps.native.resume(r.id); markResumed([r.id]); } catch { /* it shows as paused; Resume is on its card */ } }
        }
        continue;
      }
      if (asked || !runsOn(r.template, here.system === "planning-center" ? null : here.system)) continue;
      questions[r.id] = { from: own, resume: r.status === "active" };
      changed = true;
      if (r.status === "active") {
        try { await deps.native.pause(r.id); } catch { /* the page holds it back all the same (tickOnce) */ }
        markPaused([r.id]); dropHeld(r.id); cancelRunning(r.id); paused = true;
      }
    }
    if (paused || (changed && Object.keys(questions).length)) await refresh();
    return changed;
  }
  /** A run's plan on another church's clock: the same schedule and limits, its dated end on that clock's same day. */
  const rezoned = (r: Responsibility, zone: string): Plan => ({
    template: r.template, schedule: r.schedule, report: r.report, limits: r.limits, zone,
    lifetime: r.lifetime.kind === "until" ? untilLifetime(r.lifetime.until, zone) ?? r.lifetime : r.lifetime,
  });

  async function tickOnce() {
    if (!hooks) return;
    await refresh();
    await reconcile();
    await settleDefaults();
    // A morning briefing about to run brings held notices in with it, rather than sending them first.
    if (!briefingDue(hooks.context().ready)) await deliverHeld();
    if (listing && !listing.paused_all) {
      const ctx = hooks.context();
      for (const r of listing.items) {
        if (listing?.paused_all) break;
        const now = deps.now();
        const s = stateOf(r.id);
        const due = dueNow(r, s, now, zoneOf(r), options());
        if (!due.due) continue;
        // Waiting for the person's answer about a switch of church: paused, nothing runs. So does one whose checks kept
        // coming back from another church or service, until one of its own comes back.
        if (Object.hasOwn(questions, r.id) || s.mismatch_hold) continue;
        // None is known now (a setup left unfinished, a disconnect): a job confirmed for a church waits, and says since when,
        // so a time it misses is said as not connected. The app already on another church (the runner not told yet): it
        // waits for that switch's question.
        if (churches[r.id]?.church && !ctx.church && churchNow !== null && !churchNow.church) { if (!s.waiting_since) saved[r.id] = { ...s, waiting_since: now }; continue; }
        if (churches[r.id]?.church && ctx.church && ctx.church !== churches[r.id]!.church) continue;
        // Planning Center not connected yet: the run waits; it isn't missed. So does a job the church's system can't run.
        if (!ctx.ready || !runsOn(r.template, ctx.system)) { if (!s.waiting_since) saved[r.id] = { ...s, waiting_since: now }; continue; }
        if (s.not_before && ms(now) < ms(s.not_before)) continue;
        // Planning Center asked Ozzie to slow down: no new check until then (a recent one may still be shared).
        if (slowing() && !shared()) { saved[r.id] = { ...s, not_before: slowUntil }; continue; }
        await run(r, due.trigger, due.slot, due.missed);
      }
    }
    scheduleNext();
    emit();
  }
  /** One thing at a time: a tick, a change-triggered run or Check now never overlap. Pausing never waits for them. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const prior = busy ?? Promise.resolve();
    const mine = prior.then(work, work);
    busy = mine.catch(() => undefined);
    return mine;
  }
  /** A change brings this responsibility's run sooner now: not held back by a refusal or a slow-down. */
  function runsFor(r: Responsibility, changes: readonly SundayChange[]): boolean {
    const s = stateOf(r.id);
    if (s.not_before && ms(deps.now()) < ms(s.not_before)) return false;
    if (slowing() && !shared()) return false;
    if (!runsOn(r.template, hooks?.context().system) || Object.hasOwn(questions, r.id) || s.mismatch_hold) return false;
    const now = hooks?.context().church;
    if (churches[r.id]?.church && (now ? now !== churches[r.id]!.church : churchNow !== null && !churchNow.church)) return false;
    return changeEligible(r, s, changes, deps.now(), options());
  }
  /** After Pause / Pause everything (or their resume) changed in the store: at once, never after a running run. */
  async function afterPause(paused: boolean, id?: string) {
    if (paused) {
      markPaused(id ? [id] : activeIds());
      dropHeld(id);
      cancelRunning(id);
    } else if (!listing?.paused_all) markResumed(id ? [id] : activeIds());
    scheduleNext();
    emit();
  }

  return {
    start(h) {
      const first = hooks === null;
      hooks = h;
      if (first) { launchedAt = deps.now(); sessionZone = h.context().zone; }
      void serial(tickOnce);
    },
    refresh: () => serial(async () => { await refresh(); await reconcile(); scheduleNext(); emit(); }),
    tick: () => serial(tickOnce),
    wake(sleptMs, at) {
      wakes.unshift({ from: new Date(ms(at) - sleptMs).toISOString(), to: at });
      wakes.splice(WAKES_KEPT);
      void serial(tickOnce);
    },
    takes: changes => Boolean(hooks && listing && !listing.paused_all && hooks.context().ready && listing.items.some(r => runsFor(r, changes))),
    changes(changes, about) {
      return serial(async () => {
        if (!hooks || !listing || listing.paused_all || !hooks.context().ready) return false;
        let decided = false;
        for (const r of listing.items) {
          if (listing?.paused_all) break;
          if (!runsFor(r, changes)) continue;
          const result = await run(r, "change", null, [], about?.notice === true);
          if (about && r.template === "keep-sunday-covered" && result.status === "ok" && result.decided_for === about.plan_id) decided = true;
        }
        scheduleNext();
        emit();
        return decided;
      });
    },
    captured,
    async pausedElsewhere(paused) {
      await refresh();
      await afterPause(paused);
      if (!paused) void serial(tickOnce);
    },
    create: plan => serial(async () => {
      const r = await deps.native.create(plan);
      // Confirmed for the church in use; before any is connected on another system, for the first one connected there.
      // (On Planning Center with none connected yet it is a job with no church, which the first church in use adopts.)
      if (churchNow?.church) churches[r.id] = { church: churchNow.church, name: churchNow.name, system: churchNow.system };
      else if (churchNow && churchNow.system !== "planning-center") churches[r.id] = { church: null, name: null, system: churchNow.system, adopt: true };
      log(`responsibility: created template=${r.template} lifetime=${r.lifetime.kind === "until" ? `until:${r.lifetime.until}` : "until-stopped"}`);
      await refresh();
      scheduleNext();
      emit();
      // Its first check runs straight away, after this.
      void serial(tickOnce);
      return r;
    }),
    edit: (id, plan) => serial(async () => { const r = await deps.native.edit(id, plan); await refresh(); scheduleNext(); emit(); return r; }),
    // Pausing and stopping take effect at once, not after a running run.
    pause: async id => { await deps.native.pause(id); await refresh(); await afterPause(true, id); },
    resume: async id => { await deps.native.resume(id); await refresh(); await afterPause(false, id); void serial(tickOnce); },
    stop: async id => {
      await deps.native.stop(id);
      delete questions[id];
      // Stopped by a person: it never says it ended as planned, and its write-ups go with it.
      saved[id] = { ...stateOf(id), ended_told: true };
      forgetWriteups(w => w.responsibility_id !== id);
      await refresh();
      await afterPause(true, id);
    },
    pauseAll: async paused => {
      listing = await deps.native.pauseAll(paused);
      available = true;
      await afterPause(paused);
      if (!paused) void serial(tickOnce);
    },
    runNow: id => serial(async () => {
      await refresh();
      const r = listing?.items.find(x => x.id === id);
      if (!r || !hooks || !runsOn(r.template, hooks.context().system) || Object.hasOwn(questions, r.id)) return { status: "skipped" } as RunResult;
      const result = await run(r, "manual", null, []);
      scheduleNext();
      emit();
      return result;
    }),
    markSeen() {
      seenAt = deps.now();
      deps.store.set(KEYS.seen, JSON.stringify(seenAt));
      // Seeing it in Ozzie counts as being told; a held notice isn't needed any more.
      for (const h of held) patch(h.item, { notice: "in-app" });
      held = [];
      emit();
    },
    clearOpenToday() { if (openToday) { openToday = false; emit(); } },
    // Called on every status that is disconnected, so it changes nothing visible unless there is something to forget.
    forgetAllWriteups() { forgotten++; if (writeups.length) { writeups = []; emit(); } },
    keepWriteupsFor(organization) {
      const before = writeups.length, was = church;
      // A switch from another church also drops one still being prepared (review G, N2).
      if (was !== null && was !== organization) forgotten++;
      church = organization;
      forgetWriteups(w => w.organization === organization);
      if (writeups.length !== before || was !== church) emit();
    },
    churchInUse(next) {
      const was = churchNow;
      const shownBefore = viewChurch();
      churchNow = next ? { church: next.church, name: next.name, system: next.system } : null;
      // Another church than the last one known (a moment with none in between isn't a switch): a notice held about the
      // old one never goes out, and a run of it stops (as proactive.ts letGo does for the regular check).
      if (next?.church && lastKnown?.church && next.church !== lastKnown.church) { dropHeld(); cancelRunning(); }
      // Another church in use: a job held back by mismatches gets its chance again.
      if (next?.church && next.church !== was?.church) release(null);
      if (next?.church) lastKnown = { church: next.church, name: next.name, system: next.system };
      // Against the list as last read (nothing is read just for this; the first tick after Ozzie starts reads it and
      // reconciles too): only a switch reaches native, to pause the jobs it asks about.
      if (!hooks || (was?.church === churchNow?.church && was?.name === churchNow?.name && was?.system === churchNow?.system)) return;
      // Shown again only when what the pages show changes: the church whose jobs and items they show, or a job, its church or
      // an item reconcile affected. (A moment with no church on the same system shows the same; the next tick drops its
      // jobs' promised times.)
      const shownNow = viewChurch();
      void serial(async () => { if (await reconcile() || shownNow !== shownBefore) { scheduleNext(); emit(); } });
    },
    answerSwitch: (id, keep) => serial(async () => {
      // The church the question named: the one in use, or the one last in use while it isn't connected for a while.
      const asked = questions[id], here = shownChurch();
      if (!asked || !here?.church) return;
      delete questions[id];
      if (!keep) {
        // No: it stops, as Stop does.
        await deps.native.stop(id).catch(() => undefined);
        saved[id] = { ...stateOf(id), ended_told: true };
        forgetWriteups(w => w.responsibility_id !== id);
      } else {
        // Yes: it is this church's now, on its clock, starting fresh (its first check a quiet baseline).
        churches[id] = { church: here.church, name: here.name, system: here.system };
        const r = listing?.items.find(x => x.id === id);
        const zone = hooks?.context().zone;
        if (r && zone && isTimeZone(zone) && r.zone !== zone) await deps.native.edit(id, rezoned(r, zone)).catch(() => undefined);
        if (asked.resume) await deps.native.resume(id).catch(() => undefined);
        saved[id] = { ...stateOf(id), memory: null, reported: [], baseline: true, last_slot: null, last_run_at: null, retry_at: null, failures: 0,
          waiting_since: null, not_before: null, limit_told: null, paused_at: null };
      }
      await refresh();
      scheduleNext();
      emit();
      if (keep) void serial(tickOnce);
    }),
    letGo() { dropHeld(); cancelRunning(); emit(); },
    forgetChurch(key) {
      const nameless = (c: JobChurch): JobChurch => c.church === key ? { church: c.church, name: null, system: c.system, ...(c.adopt ? { adopt: true as const } : {}) } : c;
      for (const id of Object.keys(churches)) churches[id] = nameless(churches[id]!);
      for (const id of Object.keys(questions)) questions[id] = { ...questions[id]!, from: nameless(questions[id]!.from) };
      if (lastKnown?.church === key) { lastKnown = null; deps.store.set(KEYS.church, ""); }
      if (churchNow?.church === key) churchNow = { ...churchNow, name: null };
      noticed = noticed.filter(i => i.church !== key);
      emit();
    },
    jobs: () => (listing?.items ?? []).filter(r => r.status !== "ended").map(r => ({ template: r.template, church: churches[r.id] ?? null })),
    view: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
