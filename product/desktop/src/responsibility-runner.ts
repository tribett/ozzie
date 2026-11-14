// What Ozzie keeps an eye on, run on this Mac (owner, 2026-11-14: an always-on helper). The native
// store (responsibilities.rs) holds each responsibility and decides whether a run may happen; this
// controller decides WHEN to ask (core/src/harness/responsibilities.ts dueNow), runs the work, and
// surfaces what it found:
//
//   begin (native grant) → a deterministic Planning Center check through the same path as "Check
//   Planning Center now" (recorded in the task ledger), shared by every run that needs one within a
//   couple of minutes, the regular Sunday check's included → with an AI model, the template's
//   procedure through the harness, each AI step paid from the run's grant → compare with the last
//   run → an "Ozzie noticed" item, and a discreet notice only as the report policy says (quiet hours
//   hold it, never drop it; pausing drops it) → end (native).
//
// Missed runs (Mac asleep, Ozzie not running, Planning Center not connected) are reported plainly
// and caught up ONCE. A run that couldn't finish, or couldn't start, says so and is tried again
// later, within limits. A refused run is never asked for again before the store would allow it, so
// nothing here loops. Name-free storage: items keep counts, codes, times and person ids (resolved
// only at render). A written summary and a drafted note live in memory only, for this run of the app.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  changeEligible, dueNow, quietDeferral, refusedUntil, retryAt, scheduledSlots, TEMPLATES, type LocalState, type Plan, type Responsibility,
  type RunTrigger, type TemplateId,
} from "../../../core/src/harness/responsibilities.js";
import type { FailureCode, ModelStep } from "../../../core/src/harness/contract.js";
import { isTimeZone } from "../../../core/src/church-time.js";
import type { QuietHours } from "../../../core/src/schedule.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { compareSundayCheck, recordSundayCheck, type SundayChange, type SundayCheckMemory } from "../../../core/src/sunday-changes.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { checkFailure, retryDenied, StepFailure, stepFailure, type Invoke } from "./harness-bridge.js";
import type { KeyValueStore } from "./proactive.js";

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
export function responsibilityStep(runId: string, invoke: Invoke = nativeInvoke): ModelStep {
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
        .catch(error => { throw new StepFailure(stepFailure(error)); }), aborted]);
    } finally { stop(); }
  };
}

// ---- What Ozzie noticed ----------------------------------------------------------------------------

export type NoticeKind = "briefing-ready" | "needs-decision" | "checked" | "couldnt-check";
/** Why a check couldn't happen: a run's FailureCode, or the store refusing it (`unavailable`, `invalid`). */
export type ItemCode = FailureCode | "unavailable" | "invalid";
/** One "Ozzie noticed" entry. Name-free: counts, codes, times, and person ids inside changes. */
export interface NoticedItem {
  id: string;
  responsibility_id: string;
  template: TemplateId;
  at: string;
  kind: "found" | "clear" | "briefing" | "couldnt-check" | "missed" | "limit" | "ended";
  trigger?: RunTrigger;
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
  findings?: { rooms?: number; follow_ups?: number; groups?: number };
  changes?: SundayChange[];
  /** Notes ready to review on the Sunday page, plus any the AI drafted. */
  drafts?: number;
  summarized?: boolean;
  /** ended: the date it was for. */
  until?: string;
  notice?: "sent" | "held" | "sent-later" | "in-app" | "unavailable" | "none";
}
/** What a run with an AI model prepared, restored on this Mac. Kept in memory only. */
export interface Prepared { status: "verified" | "failed" | "cancelled"; code: FailureCode | null; summary: string | null; draft: string | null; ai_steps: number }

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
  /** Quiet hours follow this Mac's clock, as they always have. */
  macZone: string;
  quiet: QuietHours;
  urgentWithinHours: number;
  modelReady: boolean;
}
export interface RunnerHooks {
  context(): RunnerContext;
  /** One fresh deterministic check through the app's own path (recorded in the task ledger). */
  check(): Promise<SundayCapture>;
  /** With an AI model: the template's procedure for this run, its steps paid from the grant. `signal` aborts when it's paused. */
  prepare(r: Responsibility, grant: Grant, capture: SundayCapture, signal?: AbortSignal): Promise<Prepared | null>;
}
export interface RunnerDeps {
  native: ResponsibilityNative;
  store: KeyValueStore;
  now: () => string;
  notify: (kind: NoticeKind) => Promise<void>;
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
}
export interface RunnerView {
  available: boolean;
  paused_all: boolean;
  items: Responsibility[];
  noticed: NoticedItem[];
  /** Summaries and drafts prepared this session, by noticed item id. */
  prepared: Readonly<Record<string, { summary: string | null; draft: string | null }>>;
  next: Readonly<Record<string, string | null>>;
  running: string | null;
  unseen: number;
  /** A briefing was announced: open Today when the window comes back. */
  open_today: boolean;
}
export interface Runner {
  start(hooks: RunnerHooks): void;
  refresh(): Promise<void>;
  tick(): Promise<void>;
  wake(sleptMs: number, at: string): void;
  /** Changes the regular Sunday check found: an eligible responsibility runs sooner. */
  changes(changes: readonly SundayChange[]): Promise<void>;
  /** A check the app just made (the regular Sunday check's included): runs within a couple of minutes share it. */
  captured(capture: SundayCapture): void;
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
  view(): RunnerView;
  subscribe(listener: () => void): () => void;
}
export type RunResult = { status: "ok" | "failed"; code: FailureCode | null; noticed: number; drafts: number } | { status: "refused"; code: Refusal } | { status: "skipped" };

const KEYS = { state: "ozzie.responsibilities.state.v1", noticed: "ozzie.responsibilities.noticed.v1", seen: "ozzie.responsibilities.seen.v1", held: "ozzie.responsibilities.held.v1" };
const NOTICED_KEPT = 30;
const REPORTED_KEPT = 60;
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
const CANCELLED = Symbol("cancelled");
const rateLimited = (value: unknown) => (JSON.stringify(value) ?? "").includes("rate-limited");

/**
 * A room or follow-up finding's id without its workspace, organization and access epoch (which change
 * from check to check), so the same overlap or follow-up is recognized again.
 */
function stableKey(findingId: string): string {
  try {
    const parts = JSON.parse(findingId) as unknown;
    return Array.isArray(parts) && parts.length > 3 ? JSON.stringify(parts.slice(3)) : findingId;
  } catch { return findingId; }
}
/** What one fresh check shows for a template. Counts and keys (ids) only. */
export function findingsFor(template: TemplateId, capture: SundayCapture, rules: SundayRules, now: string) {
  const brief = buildSundayBrief(capture, rules, now);
  const ops = TEMPLATES[template].needs.includes("operations") || template === "morning-briefing" ? sundayOperations(capture, rules, { now }) : null;
  const rooms = ops?.result?.findings.filter(f => f.kind === "room-overlap") ?? [];
  const followUps = ops?.result?.findings.filter(f => f.kind === "unowned-overdue") ?? [];
  const groups = ops?.group_meetings ?? [];
  const decisions = brief.findings.filter(f => f.tone === "decision"), looks = brief.findings.filter(f => f.tone === "look");
  const drafts = brief.findings.filter(f => f.kind === "needs-people" && (f.people?.suggestions.length ?? 0) > 0).length;
  switch (template) {
    case "watch-room-bookings": return { decisions: 0, looks: 0, findings: { rooms: rooms.length }, keys: rooms.map(f => stableKey(f.finding_id)), drafts: 0 };
    case "follow-ups-without-owner": return { decisions: 0, looks: 0, findings: { follow_ups: followUps.length }, keys: followUps.map(f => stableKey(f.finding_id)), drafts: 0 };
    case "group-night-clashes": return { decisions: 0, looks: groups.length, findings: { groups: groups.length }, keys: groups.map(g => `${g.person_id}:${g.meetings[0]?.starts_at ?? ""}`), drafts: 0 };
    case "morning-briefing": return {
      decisions: decisions.length, looks: looks.length, findings: { rooms: rooms.length, follow_ups: followUps.length, groups: groups.length },
      keys: decisions.map(f => f.key), drafts,
    };
    default: return { decisions: decisions.length, looks: looks.length, findings: {}, keys: decisions.map(f => f.key), drafts };
  }
}

export function createRunner(deps: RunnerDeps): Runner {
  let hooks: RunnerHooks | null = null;
  let listing: Listing | null = null;
  let available = true;
  const saved: Record<string, Saved> = read<Record<string, Saved>>(deps.store, KEYS.state) ?? {};
  let noticed: NoticedItem[] = read<{ version: 1; items: NoticedItem[] }>(deps.store, KEYS.noticed)?.items ?? [];
  let held: { kind: NoticeKind; at: string; item: string }[] = read<{ kind: NoticeKind; at: string; item: string }[]>(deps.store, KEYS.held) ?? [];
  let seenAt = read<string>(deps.store, KEYS.seen);
  const prepared: Record<string, { summary: string | null; draft: string | null }> = {};
  const wakes: { from: string; to: string }[] = [];
  let launchedAt = deps.now();
  /** The zone at launch, for responsibilities confirmed before the store kept their own. Never changes mid-session. */
  let sessionZone: string | null = null;
  let running: { id: string; run_id: string; abort: AbortController } | null = null;
  let busy: Promise<unknown> | null = null;
  let openToday = false;
  let next: Record<string, string | null> = {};
  /** The newest live check, shared by runs that need one soon after. */
  let latest: { capture: SundayCapture; at: number } | null = null;
  /** Planning Center asked Ozzie to slow down: no new check starts before this. */
  let slowUntil: string | null = null;
  const listeners = new Set<() => void>();
  const log = (line: string) => { try { deps.log?.(line); } catch { /* debug lines only */ } };
  const options = () => ({ fast: Boolean(deps.fast?.()) });

  const save = () => {
    deps.store.set(KEYS.state, JSON.stringify(saved));
    deps.store.set(KEYS.noticed, JSON.stringify({ version: 1, items: noticed }));
    deps.store.set(KEYS.held, JSON.stringify(held));
  };
  const attention = (i: NoticedItem) => i.kind === "found" || i.kind === "couldnt-check" || i.kind === "missed" || i.kind === "briefing";
  const build = (): RunnerView => ({
    available, paused_all: listing?.paused_all ?? false, items: listing?.items ?? [], noticed, prepared: { ...prepared }, next, running: running?.id ?? null,
    unseen: noticed.filter(i => attention(i) && (!seenAt || i.at > seenAt)).length, open_today: openToday,
  });
  let snapshot = build();
  const emit = () => { save(); snapshot = build(); listeners.forEach(l => l()); };
  const add = (item: Omit<NoticedItem, "id">): NoticedItem => {
    const full = { ...item, id: `${item.responsibility_id}:${item.at}:${item.kind}` };
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

  async function notice(kind: NoticeKind, item: NoticedItem, trigger: RunTrigger, id: string) {
    // A person who just asked is already looking.
    if (trigger === "start" || trigger === "manual") { patch(item.id, { notice: "in-app" }); return; }
    if (!await stillActive(id)) { patch(item.id, { notice: "none" }); return; }
    const ctx = hooks!.context();
    const decision = quietDeferral(deps.now(), ctx.quiet, ctx.macZone);
    if (!decision.send) {
      held = [...held.filter(h => h.kind !== kind), { kind, at: decision.at, item: item.id }];
      patch(item.id, { notice: "held" });
      return;
    }
    try { await deps.notify(kind); patch(item.id, { notice: "sent" }); } catch { patch(item.id, { notice: "unavailable" }); }
    if (kind === "briefing-ready") openToday = true;
  }
  /** Held notices go out once quiet hours end, one per kind, the most important first. */
  async function deliverHeld() {
    if (!held.length || !hooks || listing?.paused_all) return;
    const ctx = hooks.context();
    if (!quietDeferral(deps.now(), ctx.quiet, ctx.macZone).send) return;
    const due = held.filter(h => ms(h.at) <= ms(deps.now())).sort((a, b) => NOTICE_RANK[b.kind] - NOTICE_RANK[a.kind]);
    held = held.filter(h => ms(h.at) > ms(deps.now()));
    for (const h of due) {
      let outcome: NoticedItem["notice"] = "sent-later";
      try { await deps.notify(h.kind); } catch { outcome = "unavailable"; }
      patch(h.item, { notice: outcome });
      if (h.kind === "briefing-ready") openToday = true;
    }
  }

  function missedReason(slot: string, s: Saved): NonNullable<NoticedItem["missed_reason"]> {
    if (s.waiting_since && ms(s.waiting_since) <= ms(slot)) return "waiting";
    if (wakes.some(w => ms(w.from) <= ms(slot) && ms(slot) <= ms(w.to))) return "asleep";
    if (ms(slot) < ms(launchedAt)) return "closed";
    return "unknown";
  }

  /** A check recent enough to share, or null. */
  function shared(): SundayCapture | null {
    const window = options().fast ? FAST_SHARED_CHECK_MS : SHARED_CHECK_MS;
    return latest && ms(deps.now()) - latest.at < window ? latest.capture : null;
  }
  function captured(capture: SundayCapture) {
    if (capture.kind !== "live") return;
    const at = Number.isFinite(ms(capture.completed_at)) ? Math.min(ms(capture.completed_at), ms(deps.now())) : ms(deps.now());
    if (!latest || at >= latest.at) latest = { capture, at };
    if (capture.reads.some(r => r.outcome === "rate-limited")) slowDown();
  }
  function slowDown() { slowUntil = iso(ms(deps.now()) + (options().fast ? FAST_RATE_LIMIT_WAIT_MS : RATE_LIMIT_WAIT_MS)); }
  const slowing = () => slowUntil !== null && ms(deps.now()) < ms(slowUntil);
  /**
   * One check for every run that needs one now: a recent one is shared (except for Check now, which reads
   * again); otherwise the app's own path, which shares a check already running.
   */
  async function check(trigger: RunTrigger): Promise<SundayCapture> {
    const recent = trigger === "manual" ? null : shared();
    if (recent) return recent;
    try {
      const capture = await hooks!.check();
      captured(capture);
      return capture;
    } catch (error) {
      if (rateLimited(error)) slowDown();
      throw error;
    }
  }

  async function run(r: Responsibility, trigger: RunTrigger, slot: string | null, missed: string[]): Promise<RunResult> {
    if (!hooks) return { status: "skipped" };
    const started = deps.now();
    const s = stateOf(r.id);
    let grant: Grant;
    try { grant = await deps.native.begin(r.id, trigger); }
    catch (error) {
      const code = refusalOf(error);
      log(`responsibility: begin refused=${code}`);
      // Never asked again before the store would allow it.
      const until = refusedUntil(r, code, started, options());
      if (code === "too-soon" || code === "busy") { saved[r.id] = { ...s, not_before: until }; return { status: "refused", code }; }
      const day = started.slice(0, 10);
      if (code === "checks-limit" && s.limit_told !== day) {
        add({ responsibility_id: r.id, template: r.template, at: started, kind: "limit", trigger });
        saved[r.id] = { ...s, limit_told: day };
      }
      const broken = code === "unavailable" || code === "invalid";
      // Paused, ended or over its limit: this slot is covered; the next one is tried as usual.
      saved[r.id] = { ...stateOf(r.id), last_slot: slot ?? s.last_slot, retry_at: broken ? until : null, not_before: until, failures: s.failures + (broken ? 1 : 0) };
      if (broken) {
        // The store couldn't be read, or refused the plan as saved: say so, and try again later.
        const item = add({ responsibility_id: r.id, template: r.template, at: started, kind: "couldnt-check", code, retry_at: until, scheduled_for: slot ?? started, trigger });
        if (s.failures === 0) await notice("couldnt-check", item, trigger, r.id);
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
        missed_reason: missedReason(missed[0]!, s), ran_at: started, trigger });
    }
    const fail = async (code: FailureCode, access = false): Promise<RunResult> => {
      const failures = stateOf(r.id).failures + 1;
      const retry = access ? null : retryAt(r, deps.now(), options());
      saved[r.id] = { ...stateOf(r.id), failures, retry_at: retry };
      await deps.native.end(r.id, grant.run_id, "failed", code, 0, 0).catch(() => undefined);
      log(`responsibility: run status=failed code=${code} noticed=0 drafts=0`);
      const item = add({ responsibility_id: r.id, template: r.template, at: deps.now(), kind: "couldnt-check", code, retry_at: retry, scheduled_for: slot ?? started, trigger, ...(access ? { access } : {}) });
      // Reported once per streak; retries continue quietly.
      if (failures === 1) await notice("couldnt-check", item, trigger, r.id);
      else patch(item.id, { notice: "none" });
      return { status: "failed", code, noticed: 0, drafts: 0 };
    };
    try {
      const ctx = hooks.context();
      if (TEMPLATES[r.template].needs.includes("operations") && !ctx.granted.includes("operations")) return await fail("denied", true);
      let capture: SundayCapture;
      try { capture = await guard(check(trigger)); }
      catch (error) { if (error === CANCELLED) throw error; return await fail(checkFailure(error)); }
      const now = deps.now();
      const found = findingsFor(r.template, capture, ctx.rules, now);
      // What changed since this responsibility last looked at the same Sunday.
      let changes: SundayChange[] = [];
      let memory = stateOf(r.id).memory;
      if (capture.kind === "live" && (r.template === "keep-sunday-covered" || r.template === "morning-briefing")) {
        const compared = compareSundayCheck(memory, recordSundayCheck(capture, ctx.rules, now), { now, urgentWithinHours: ctx.urgentWithinHours });
        changes = compared.changes;
        memory = compared.memory;
      }
      let ready: Prepared | null = null;
      if (ctx.modelReady && grant.ai_steps > 0) {
        try { ready = await guard(hooks.prepare(r, grant, capture, abort.signal)); } catch (error) { if (error === CANCELLED) throw error; ready = null; }
      }
      const reported = new Set(stateOf(r.id).reported);
      const newKeys = found.keys.filter(k => !reported.has(k));
      const worse = changes.some(c => c.effect === "worse");
      const count = found.decisions + found.looks + (found.findings.rooms ?? 0) + (found.findings.follow_ups ?? 0) + (r.template === "group-night-clashes" ? 0 : (found.findings.groups ?? 0));
      const drafts = found.drafts + (ready?.draft ? 1 : 0);
      const kind: NoticedItem["kind"] = r.template === "morning-briefing" ? "briefing" : count > 0 || worse ? "found" : "clear";
      const item = add({
        responsibility_id: r.id, template: r.template, at: now, kind, trigger, decisions: found.decisions, looks: found.looks, findings: found.findings,
        changes, drafts, summarized: Boolean(ready?.summary),
      });
      if (ready?.summary || ready?.draft) prepared[item.id] = { summary: ready.summary, draft: ready.draft };
      saved[r.id] = { ...stateOf(r.id), failures: 0, retry_at: null, memory, reported: [...new Set([...found.keys, ...stateOf(r.id).reported])].slice(0, REPORTED_KEPT) };
      const noticeKind: NoticeKind | null = r.template === "morning-briefing" ? "briefing-ready"
        : r.report === "every-check" ? (count > 0 ? "needs-decision" : "checked")
          : newKeys.length > 0 || worse ? "needs-decision" : null;
      if (noticeKind) await notice(noticeKind, item, trigger, r.id);
      else patch(item.id, { notice: "none" });
      await deps.native.end(r.id, grant.run_id, "ok", null, count, drafts).catch(() => undefined);
      log(`responsibility: run status=ok code=- noticed=${count} drafts=${drafts}${ready ? ` summary=${ready.status}` : ""}`);
      return { status: "ok", code: null, noticed: count, drafts };
    } catch (error) {
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
    next = Object.fromEntries(listing.items.map(r => [r.id, listing!.paused_all ? null : nextFor(r, ready, now)]));
    const soonest = Object.values(next).filter((x): x is string => x !== null).sort()[0] ?? null;
    try { deps.nextDue?.(soonest); } catch { /* the regular tick still comes */ }
  }

  async function tickOnce() {
    if (!hooks) return;
    await refresh();
    await deliverHeld();
    if (listing && !listing.paused_all) {
      const ctx = hooks.context();
      for (const r of listing.items) {
        if (listing?.paused_all) break;
        const now = deps.now();
        const s = stateOf(r.id);
        const due = dueNow(r, s, now, zoneOf(r), options());
        if (!due.due) continue;
        // Planning Center not connected yet: the run waits; it isn't missed.
        if (!ctx.ready) { if (!s.waiting_since) saved[r.id] = { ...s, waiting_since: now }; continue; }
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
    refresh: () => serial(async () => { await refresh(); scheduleNext(); emit(); }),
    tick: () => serial(tickOnce),
    wake(sleptMs, at) {
      wakes.unshift({ from: new Date(ms(at) - sleptMs).toISOString(), to: at });
      wakes.splice(WAKES_KEPT);
      void serial(tickOnce);
    },
    changes(changes) {
      return serial(async () => {
        if (!hooks || !listing || listing.paused_all || !hooks.context().ready) return;
        for (const r of listing.items) {
          if (listing?.paused_all) break;
          const s = stateOf(r.id);
          if (s.not_before && ms(deps.now()) < ms(s.not_before)) continue;
          if (slowing() && !shared()) continue;
          if (changeEligible(r, s, changes, deps.now(), options())) await run(r, "change", null, []);
        }
        scheduleNext();
        emit();
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
      // Stopped by a person: it never says it ended as planned.
      saved[id] = { ...stateOf(id), ended_told: true };
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
      if (!r || !hooks) return { status: "skipped" } as RunResult;
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
    view: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
