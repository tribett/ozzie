// Keeping watch for a church on B1 Church or Breeze: the same Sunday schedule as Planning Center's (proactive.ts), with
// its own state on this Mac. It checks at launch, on its interval and on Check now; compares each check with the last
// one of the same service (core church-systems/changes.ts); keeps quiet hours; and sends the same private notice, whose
// words are fixed in native code and name no one. Only the church and service connected when a check ends are compared
// or told: a check that ends after a switch or a disconnect is let go.
import { buildSystemBrief } from "../../../core/src/church-systems/brief.js";
import { recordSystemCheck, steadyBrief } from "../../../core/src/church-systems/changes.js";
import { placeholderScope } from "../../../core/src/church-systems/placeholders.js";
import { unreadParts } from "../../../core/src/church-systems/reads.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { feedbackOf } from "../../../core/src/finding-feedback.js";
import { readProblemText, systemWords } from "./church-system.js";
import { desktopRecorder } from "./harness-bridge.js";
import {
  browserStore, createProactive, notifySundayAttention, SYSTEM_KEYS, SystemReadFailure, type CheckDigest, type ProactiveContext, type ProactiveController,
  type ProactiveDeps, type SystemWatch,
} from "./proactive.js";
import { ofConnection } from "./system-church.js";

/**
 * Whether checks of this church may run on their own: a church on B1 Church or Breeze with a service to watch whose first
 * result has been seen (first run reads it itself), and, for B1 Church, the church's time zone confirmed.
 */
export function systemReady(watch: SystemWatch | null | undefined): boolean {
  const c = watch?.connection;
  return Boolean(c && c.service_id && c.result_seen && (c.system !== "b1" || c.zone));
}
/** The church a check's notices and saved Sundays belong to: `<system>:<church id>`. */
export const systemOwner = (watch: SystemWatch | null | undefined): string | undefined =>
  watch ? `${watch.connection.system}:${watch.connection.church_id}` : undefined;

/**
 * What a system check is compared by. Null (nothing compared, kept or told) when it isn't of the church and service
 * connected now, when it can't make a service check, or while the church's time zone waits to be confirmed (B1 Church:
 * nothing of the check is said until then, so nothing is told either).
 */
export function systemDigest(capture: SystemCapture, ctx: ProactiveContext, now: string): CheckDigest | null {
  const watch = ctx.system;
  if (!watch || !ofConnection(capture, watch.connection)) return null;
  // The kids teams or roles the church marked count here too, so a kids team falling short is told like any decision.
  const built = buildSystemBrief(capture, { confirmedZone: watch.connection.zone, feedback: feedbackOf(ctx.rules),
    ...(ctx.rules.systemKids ? { systemKids: ctx.rules.systemKids } : {}) }, now);
  if (!built.ok || built.coverage.waiting_for_zone) return null;
  return {
    owner: placeholderScope(capture), plan_id: built.brief.plan.id, record: recordSystemCheck(capture, built.brief),
    brief: steadyBrief(built.brief), ops: null,
    // Reads the system cuts short by its own rule aren't missing anything (reads.ts PARTIAL_BY_DESIGN).
    complete: unreadParts(capture).length === 0,
  };
}
/** A failed check in plain words, for Keeping watch's list (fixed local copy; never the system's own text). */
export function systemProblem(error: unknown): string {
  if (error instanceof SystemReadFailure) return readProblemText(error.system, error.outcome) ?? `${systemWords(error.system).name} couldn't be read just now.`;
  return "The check couldn't finish just now.";
}

/**
 * A church system's Sunday schedule (proactive.ts createProactive): its own keys on this Mac, its comparison, readiness and
 * failure words. `check` runs one read of the watched service (desktop: recorded in the task ledger).
 */
export function createSystemProactive(deps: Pick<ProactiveDeps<SystemCapture>, "store" | "now" | "timeZone" | "check" | "notify" | "timers"> & Pick<ProactiveDeps<SystemCapture>, "found">): ProactiveController<SystemCapture> {
  return createProactive<SystemCapture>({
    ...deps, keys: SYSTEM_KEYS, problem: systemProblem, digest: systemDigest,
    ready: ctx => systemReady(ctx.system), owner: ctx => systemOwner(ctx.system),
    same: (start, end) => systemOwner(start.system) === systemOwner(end.system),
  });
}
/** One read of the watched service, refused before anything is read when no service is set. */
export function systemCheck(ctx: ProactiveContext, record: (watch: SystemWatch) => Promise<SystemCapture>): Promise<SystemCapture> {
  const watch = ctx.system;
  // Check now and first run may read before a first result: a service is all a read needs.
  if (!watch?.connection.service_id) return Promise.reject(new SystemReadFailure(watch?.connection.system ?? "b1", "bad-id", watch?.connection.church_id ?? null));
  return record(watch);
}

let desktop: ProactiveController<SystemCapture> | null = null;
/** One controller per webview, beside Planning Center's: checks of a church on another system run while Ozzie is open. */
export function desktopSystemProactive(): ProactiveController<SystemCapture> {
  return desktop ??= createSystemProactive({
    store: browserStore,
    now: () => new Date().toISOString(),
    timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Every check, automatic or manual, is a "check" task in the task ledger, beside the system it read. No model is involved.
    check: (ctx, _onStatus, trigger, source, onTask) => systemCheck(ctx, watch =>
      desktopRecorder().checkSystem(watch.read, watch.connection.system, source ?? (trigger === "manual" ? "manual" : "automatic"), onTask)),
    found: (taskId, found) => desktopRecorder().checked(taskId, found),
    notify: notifySundayAttention,
    timers: { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>) },
  });
}
