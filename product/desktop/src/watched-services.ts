// The services Ozzie watches besides the one Settings names (owner decision 2026-11-19: "some churches have multiple
// services and we need to account for that"). Planning Center service types only: the first is Settings' own
// serviceTypeId and planId, unchanged, so a church with one service sees exactly what it saw before; up to three more are
// kept here, each with the plan Ozzie watches now and the plans it watched before (so removing one can forget its saved
// checks). Bound to one church: another church's list is never read. Names are Planning Center's own service names,
// display text for this Mac only. Pure apart from the store it is handed.
import type { KeyValueStore } from "./proactive.js";

/** At most this many services are watched at once, the one in Settings included. */
export const MAX_WATCHED = 4;
/** How many earlier plans of a service are remembered, for forgetting its saved checks (native keeps 5 per plan). */
const PAST_KEPT = 12;
const KEY = "ozzie.also-watched.v1";
const ID = /^[1-9]\d{0,31}$/u;

/** One more service Ozzie watches: its service type, the plan it watches now, and what is known of that plan's day. */
export interface AlsoWatched {
  serviceTypeId: string;
  planId: string;
  /** The service's own Planning Center name ("Youth Night"); null when it has none. Display text, this Mac only. */
  name: string | null;
  /** Planning Center's local wall-clock date and time of the plan (a misleading `Z`), when known. */
  sort_date: string | null;
  /** The plan's service-time starts, as instants, when a check or the list has read them. */
  times: string[];
  /** The church's zone as last read, for placing the plan's day. */
  zone: string | null;
  /** Earlier plans of this service Ozzie watched (newest first), whose saved checks go with it when it is removed. */
  past: string[];
}

const text = (v: unknown, max: number): string | null => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const ids = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ID.test(x)) : [];

function clean(v: unknown): AlsoWatched | null {
  const o = v as Partial<Record<keyof AlsoWatched, unknown>> | null;
  if (!o || typeof o !== "object" || typeof o.serviceTypeId !== "string" || !ID.test(o.serviceTypeId) || typeof o.planId !== "string" || !ID.test(o.planId)) return null;
  return {
    serviceTypeId: o.serviceTypeId, planId: o.planId, name: text(o.name, 120), sort_date: text(o.sort_date, 40),
    times: Array.isArray(o.times) ? o.times.filter((t): t is string => typeof t === "string" && Number.isFinite(Date.parse(t))).slice(0, 12) : [],
    zone: text(o.zone, 64), past: ids(o.past).filter(p => p !== o.planId).slice(0, PAST_KEPT),
  };
}

/** The list kept on this Mac, for one church (Planning Center's organization id). Best effort: unreadable is empty. */
export function alsoWatched(store: KeyValueStore) {
  return {
    get(organization: string): AlsoWatched[] {
      if (!ID.test(organization)) return [];
      try {
        const v = JSON.parse(store.get(KEY) ?? "null") as { organization?: unknown; services?: unknown } | null;
        if (!v || v.organization !== organization || !Array.isArray(v.services)) return [];
        const seen = new Set<string>();
        return v.services.map(clean).filter((s): s is AlsoWatched => s !== null && !seen.has(s.serviceTypeId) && Boolean(seen.add(s.serviceTypeId)))
          .slice(0, MAX_WATCHED - 1);
      } catch { return []; }
    },
    set(organization: string, services: readonly AlsoWatched[]): void {
      if (!ID.test(organization)) return;
      store.set(KEY, JSON.stringify({ organization, services: services.slice(0, MAX_WATCHED - 1) }));
    },
  };
}

/** A service someone can add: its type, its name, and its next plan. */
export interface ServiceChoice { serviceTypeId: string; name: string | null; plan: { id: string; sort_date: string; times: string[] } | null }

/**
 * Adding one: never the service Settings already names, never one already watched, never past MAX_WATCHED, and only with
 * a plan to watch. Null when it can't be added (the caller says why).
 */
export function addService(list: readonly AlsoWatched[], choice: ServiceChoice, mainTypeId: string, zone: string | null): AlsoWatched[] | null {
  if (!ID.test(choice.serviceTypeId) || !choice.plan || !ID.test(choice.plan.id)) return null;
  if (choice.serviceTypeId === mainTypeId || list.some(s => s.serviceTypeId === choice.serviceTypeId)) return null;
  if (list.length + 1 >= MAX_WATCHED) return null;
  return [...list, { serviceTypeId: choice.serviceTypeId, planId: choice.plan.id, name: choice.name, sort_date: choice.plan.sort_date, times: [...choice.plan.times], zone, past: [] }];
}
/** Removing one: the list without it, and every plan of it Ozzie watched, whose saved checks are forgotten. */
export function removeService(list: readonly AlsoWatched[], serviceTypeId: string): { list: AlsoWatched[]; plans: string[] } {
  const gone = list.find(s => s.serviceTypeId === serviceTypeId);
  return { list: list.filter(s => s.serviceTypeId !== serviceTypeId), plans: gone ? [gone.planId, ...gone.past] : [] };
}
/** Moving one on to its next plan (move-on.ts), keeping the passed plan among its past ones. */
export function movedOn(list: readonly AlsoWatched[], serviceTypeId: string, fromPlan: string, plan: { id: string; sort_date: string; times: string[] }, zone: string | null): AlsoWatched[] {
  return list.map(s => s.serviceTypeId === serviceTypeId && s.planId === fromPlan
    ? { ...s, planId: plan.id, sort_date: plan.sort_date, times: [...plan.times], zone, past: [fromPlan, ...s.past.filter(p => p !== fromPlan && p !== plan.id)].slice(0, PAST_KEPT) } : s);
}
/**
 * What a check of one of them read of its plan's day: kept so the page names its day before the next check. The same list
 * (by reference) when nothing changed, so App doesn't save or render again.
 */
export function readDay(list: AlsoWatched[], planId: string, read: string | null, readTimes: readonly string[], readZone: string | null): AlsoWatched[] {
  let changed = false;
  const next = list.map(s => {
    if (s.planId !== planId) return s;
    // A read that couldn't place the plan (its plan read failed) never forgets what was known of its day.
    const sort_date = read ?? s.sort_date, times = readTimes.length ? readTimes : s.times, zone = readZone ?? s.zone;
    const same = s.sort_date === sort_date && s.zone === zone && s.times.length === times.length && s.times.every((t, i) => t === times[i]);
    if (same) return s;
    changed = true;
    return { ...s, sort_date, times: times.slice(0, 12), zone };
  });
  return changed ? next : list;
}
