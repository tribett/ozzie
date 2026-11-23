// Jobs for a church on B1 Church or Breeze (owner, 2026-11-19: "I want them all … I really want you to polish and test
// them"): Keep services covered and the morning briefing run over the system's own check of the watched service, as they
// run over a Planning Center check (responsibility-runner.ts). The check is the one the system's schedule already makes
// (system-watch.ts), read through the same native command; nothing new is read. It is compared by the same name-free
// record (core church-systems/changes.ts) and counted from the same brief the service's page shows (brief.ts).
// Only those two jobs: watching room bookings, follow-ups and group meetings reads Planning Center's Calendar, People and
// Groups, which these systems' keys don't read, so those jobs wait, unshown, while the church is on another system, and
// run again if it switches back.
import { buildSystemBrief, type SystemBrief } from "../../../core/src/church-systems/brief.js";
import { recordSystemCheck } from "../../../core/src/church-systems/changes.js";
import { placeholderScope } from "../../../core/src/church-systems/placeholders.js";
import type { SystemCapture } from "../../../core/src/church-systems/types.js";
import { feedbackOf } from "../../../core/src/finding-feedback.js";
import type { HarnessData } from "../../../core/src/harness/index.js";
import type { Parsed, TemplateId } from "../../../core/src/harness/responsibilities.js";
import type { SundayRules } from "../../../core/src/sunday-capture.js";
import type { SundayCheckRecord } from "../../../core/src/sunday-changes.js";
import type { SundayDecision } from "../../../core/src/sunday-decisions.js";
import { systemWords, type OtherSystem } from "./church-system.js";
import { buildHarnessData, systemHarnessCapture } from "./harness-bridge.js";

/** The jobs a church on B1 Church or Breeze can run: the two that need nothing beyond the service's roles and who answered. */
export const SYSTEM_TEMPLATES: readonly TemplateId[] = Object.freeze(["keep-sunday-covered", "morning-briefing"]);
/** Whether a job of `template` runs for a church on `system` (every job on Planning Center: `system` null). */
export const runsOn = (template: TemplateId, system: OtherSystem | null | undefined): boolean => !system || SYSTEM_TEMPLATES.includes(template);

/**
 * One check of the watched service of a church on B1 Church or Breeze, as a job reads it. Always a live read (a saved
 * copy is never a job's check). `organization` is the church's placeholder scope (`<system>:<church id>`), the same key
 * its saved Sundays, decisions and notices use; `plan_id` the system's own service id; `zone` the time zone the person
 * confirmed in Ozzie (B1 Church), in which the brief is placed.
 */
export interface SystemJobCheck {
  kind: "live";
  organization: string; plan_id: string; completed_at: string;
  system: SystemCapture;
  zone: string | null;
}
/** A finished system check, as a job reads it; null when it has no service (Genesis), which no job reads. */
export function systemJobCheck(capture: SystemCapture, zone: string | null): SystemJobCheck | null {
  if (!capture.service || (capture.system !== "b1" && capture.system !== "breeze")) return null;
  return { kind: "live", organization: placeholderScope(capture), plan_id: capture.service.id, completed_at: capture.completed_at, system: capture, zone };
}
/** Whether a job's check is a B1 Church or Breeze check (a Planning Center check has no `system`). */
export const isSystemCheck = (c: object): c is SystemJobCheck =>
  Object.hasOwn(c, "system") && typeof (c as { system: unknown }).system === "object" && (c as { system: unknown }).system !== null;
/** The system that check read. */
export const systemOf = (c: SystemJobCheck): OtherSystem => c.system.system as OtherSystem;
/** The brief the service's page shows for that check: the confirmed zone and the person's own finding feedback. */
export const systemJobBrief = (c: SystemJobCheck, rules: SundayRules, now: string): SystemBrief =>
  buildSystemBrief(c.system, { confirmedZone: c.zone, feedback: feedbackOf(rules) }, now);
/** What the check is compared by: the same record the system's own schedule keeps (core church-systems/changes.ts). */
export const systemJobRecord = (c: SystemJobCheck, brief: Extract<SystemBrief, { ok: true }>["brief"]): SundayCheckRecord =>
  recordSystemCheck(c.system, brief);

/**
 * What a job's AI write-up reads for a B1 Church or Breeze check: the same data Ask reads for that church (App.tsx), built
 * from the job's own check: its people as labels under the church's placeholder scope (names stay on this Mac, and in
 * native's name guard, which every system check fills), the system as every result's source, no Planning Center check
 * again and nothing of Calendar, People or Groups, with the leader's decisions about that service. Null when the check
 * makes no service check.
 */
export function systemJobHarness(c: SystemJobCheck, rules: SundayRules, decisions: readonly SundayDecision[], at: string): HarnessData | null {
  const built = systemJobBrief(c, rules, at);
  if (!built.ok) return null;
  return buildHarnessData({ capture: systemHarnessCapture(c.system, false), fictional: false, rules, decisions: [...decisions], status: null, configured: false, now: at,
    brief: built.brief, operations: null, fictionalImport: false, source: systemWords(systemOf(c)).name });
}

/**
 * Why a B1 Church or Breeze church's jobs wait although its connection is set up (L1, review of 0.8.0): its key was
 * refused, isn't on this Mac or macOS didn't allow it ("key"), which only connecting again fixes; or the service
 * watched lists no roles ("no-roles"), which only a person fixes. Then no job asks native for a run, so none uses its
 * checks on reads that would fail, as Planning Center's jobs wait while it isn't connected. Ozzie's own check of the
 * service keeps reading on its schedule, and its next check that reads the service whole lets them run again.
 */
export type JobsBlock = "key" | "no-roles";
const KEY_OUTCOMES = new Set(["key-refused", "no-key", "denied", "refused"]);
export function createJobsGate() {
  let block: { church: string; why: JobsBlock } | null = null;
  return {
    /** A check of `church` that ended without a capture: a key it can't use holds that church's jobs back. */
    failed(church: string | null, error: unknown) {
      const outcome = error instanceof Error && "outcome" in error ? (error as { outcome: unknown }).outcome : error;
      if (church && typeof outcome === "string" && KEY_OUTCOMES.has(outcome)) block = { church, why: "key" };
    },
    /** A check that read the service: its jobs run again, unless the service lists no roles. */
    checked(capture: SystemCapture, zone: string | null) {
      const built = buildSystemBrief(capture, { confirmedZone: zone }, capture.completed_at);
      block = !built.ok && built.reason === "no-roles" ? { church: placeholderScope(capture), why: "no-roles" } : null;
    },
    /** Why `church`'s jobs wait now, if they do. */
    blocked: (church: string | null): JobsBlock | null => block && church === block.church ? block.why : null,
  };
}

/**
 * A request to take something on (core responsibilities.ts `parseRequest`), for a church on B1 Church or Breeze: the part
 * Ozzie can plan there (`plan`; `{ kind: "none" }` when nothing), and whether it asked only for jobs that work with
 * Planning Center only (`notHere`), which Ask answers plainly instead.
 */
export function forSystem(parsed: Parsed): { plan: Parsed; notHere: boolean } {
  const none = { kind: "none" } as const;
  switch (parsed.kind) {
    case "none": return { plan: parsed, notHere: false };
    case "plan": return SYSTEM_TEMPLATES.includes(parsed.plan.template) ? { plan: parsed, notHere: false } : { plan: none, notHere: true };
    case "ask": {
      if (parsed.need === "when") return SYSTEM_TEMPLATES.includes(parsed.template) ? { plan: parsed, notHere: false } : { plan: none, notHere: true };
      const choices = parsed.choices.filter(t => SYSTEM_TEMPLATES.includes(t));
      return choices.length ? { plan: { ...parsed, choices }, notHere: false } : { plan: none, notHere: true };
    }
  }
}
