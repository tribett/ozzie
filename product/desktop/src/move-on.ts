// Moving on by itself (onboarding spec §5.3, decision 12 as amended by 18). Once the watched plan's day has passed in the
// church's time zone, the next check first asks native for that service's next plan (`next_plan`, contract N3): maybe
// next Wednesday, not next Sunday. A plan someone chose further ahead is watched until it passes, then the same rule
// applies. With no next plan yet, Today says Ozzie is waiting and it looks again each hour. App wires this in before
// `proactive.checkNow`; this file decides and words it, and asks nothing else of native.
//
// Pure apart from the one `nextPlan` call it is handed. Dates are calendar dates (`YYYY-MM-DD`) in the church's zone.
import { isTimeZone, localDate, planDate } from "../../../core/src/church-time.js";
import { dayWords, longDate } from "../../../core/src/service-day.js";
import { roleWithService } from "../../../core/src/sunday-brief.js";
import type { PlanOption } from "./onboarding-bridge.js";

/** The plan Ozzie watches, as Settings and the last check know it. */
export interface WatchedPlan {
  serviceTypeId: string;
  planId: string;
  /** Planning Center's local wall-clock date and time (a misleading `Z`; church-time.ts), or null when not known. */
  sort_date: string | null;
  /** The plan's service-time starts, as instants, when a check or the picker has read them. */
  times?: readonly string[];
  /** The service's own Planning Center name ("Youth Night"); null when it has none. */
  serviceName: string | null;
}

/** How long Ozzie waits before asking again when no next plan exists yet (spec §5.3: "it looks again each hour"). */
export const WAIT_AGAIN_MS = 60 * 60 * 1000;

/**
 * The watched plan's last local date in the church's zone: the latest of its service times there, else the date part of
 * its `sort_date`. Null when nothing places it.
 */
export function planLocalDate(plan: Pick<WatchedPlan, "sort_date" | "times">, zone: string | null): string | null {
  const z = zone && isTimeZone(zone) ? zone : null;
  const dates = z ? (plan.times ?? []).filter(t => Number.isFinite(Date.parse(t))).map(t => localDate(t, z)).sort() : [];
  return dates.at(-1) ?? planDate(plan.sort_date);
}

/**
 * Whether the watched plan's day has passed: today, in the church's zone, is a later date than the plan's last local
 * date. The plan's own day hasn't passed until its midnight in that zone, wherever this Mac is. `zone`: the church's;
 * when it wasn't read, App passes this Mac's. Unplaceable: false (Ozzie keeps the plan rather than guess).
 */
export function hasPassed(plan: Pick<WatchedPlan, "sort_date" | "times">, zone: string | null, now: string): boolean {
  const day = planLocalDate(plan, zone);
  if (!day || !zone || !isTimeZone(zone) || !Number.isFinite(Date.parse(now))) return false;
  return localDate(now, zone) > day;
}

/** "November 19", for a calendar date. */
const monthDay = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });

/** What happened records (spec §5.3): "Moved on to Wednesday, November 26 (Youth Night) because November 19 has passed." */
export function movedText(next: Pick<PlanOption, "sort_date" | "times">, serviceName: string | null, passed: string, zone: string | null): string {
  const date = dayWords({ sort_date: next.sort_date, times: next.times }, zone).date ?? (planDate(next.sort_date) ? longDate(planDate(next.sort_date)!) : "the next plan");
  // The service after its date as a role is said with its service: in brackets, or after a dash when its own name already
  // ends in brackets ("Youth Night (fictional)"), never a pair inside another.
  return `Moved on to ${roleWithService(date, serviceName)} because ${monthDay(passed)} has passed.`;
}
/** Today, while no next plan exists (spec §5.3): "Ozzie is waiting for the next Youth Night plan in Planning Center." */
export const waitingText = (serviceName: string | null): string =>
  `Ozzie is waiting for the next ${serviceName ? `${serviceName} ` : ""}plan in Planning Center.`;

export type MoveOn =
  /** The watched plan's day hasn't passed (or can't be placed): keep watching it. */
  | { kind: "stay" }
  /** Watch `plan` now; `line` is What happened's sentence. */
  | { kind: "moved"; plan: PlanOption; passed: string; line: string }
  /** Nothing planned yet after `passed`: Today says `line`, with no button, and Ozzie asks again after WAIT_AGAIN_MS. */
  | { kind: "waiting"; passed: string; line: string };

/**
 * Decides whether to move on, and to what: asks `nextPlan` (onboarding-bridge.ts `onboarding.nextPlan`) for the same
 * service's first plan after the passed plan's local date only when that date has passed. A failed ask rejects as the
 * bridge does; the caller keeps the plan it has and tries again at the next check.
 */
export async function moveOn(watched: WatchedPlan, zone: string | null, now: string,
  nextPlan: (serviceTypeId: string, afterDate: string) => Promise<PlanOption | null>): Promise<MoveOn> {
  const passed = planLocalDate(watched, zone);
  if (!passed || !hasPassed(watched, zone, now)) return { kind: "stay" };
  const next = await nextPlan(watched.serviceTypeId, passed);
  // Never "moves" to the same plan, or to one that isn't after the passed day (a fallback list may hold it).
  const nextDate = next ? planLocalDate(next, zone) : null;
  if (!next || next.id === watched.planId || !nextDate || nextDate <= passed) return { kind: "waiting", passed, line: waitingText(watched.serviceName) };
  return { kind: "moved", plan: next, passed, line: movedText(next, watched.serviceName, passed, zone) };
}
