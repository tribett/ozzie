// A fake native side for the onboarding bridge (src/onboarding-bridge.ts), in the shapes of
// docs/design/onboarding-native-contract.md, so first run, the AI screens and Check my setup are tested before and apart
// from the native lane. Fictional data only. `replies` maps a command to a value or a function of its arguments; a
// function that throws becomes a rejected call. Commands not listed reject with "fake-bridge: <command>", which the
// bridge treats as a command this build doesn't have (its fallback runs).
import { createOnboardingBridge, type Invoke, type Listen } from "../src/onboarding-bridge.js";

type Reply = unknown | ((args: Record<string, unknown>) => unknown);
export function fakeNative(replies: Record<string, Reply> = {}) {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const invoke: Invoke = async <T,>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args });
    if (!(command in replies)) throw `fake-bridge: ${command}`;
    const r = replies[command];
    return (typeof r === "function" ? await (r as (a: Record<string, unknown>) => unknown)(args) : r) as T;
  };
  const listen: Listen = async <T,>(event: string, handle: (payload: T) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handle as (p: unknown) => void);
    listeners.set(event, set);
    return () => { set.delete(handle as (p: unknown) => void); };
  };
  /** Delivers a native event to everything listening. */
  const emit = (event: string, payload: unknown) => { for (const h of listeners.get(event) ?? []) h(payload); };
  return { bridge: createOnboardingBridge(invoke, listen), calls, emit, invoke, listen };
}

/** A plan as native's `PlanNext` sends it: a local wall-clock `sort_date`, its date and weekday, its service times (UTC). */
export const planNext = (planId: string, sortDate: string, times: string[] = [], title: string | null = null) => {
  const date = sortDate.slice(0, 10);
  const weekday = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }).toLowerCase();
  return { id: planId, sort_date: sortDate, date, weekday, dates: null, title, series_title: null, times, times_read: times.length > 0 };
};
/** Fictional services of a church in Chicago: Sunday Morning (9:00 and 11:00), Saturday Night, Youth Night on Wednesday. */
export const SUNDAY_MORNING = { id: "1500", name: "Sunday Morning", problem: null,
  next: planNext("92902197", "2026-11-22T09:00:00Z", ["2026-11-22T15:00:00Z", "2026-11-22T17:00:00Z"], "Ozzie Demo — Main Sunday (fictional)") };
export const SATURDAY_NIGHT = { id: "1600", name: "Saturday Night", problem: null, next: planNext("93000001", "2026-11-21T17:00:00Z", ["2026-11-21T23:00:00Z"]) };
export const YOUTH_NIGHT = { id: "1700", name: "Youth Night", problem: null, next: planNext("94000001", "2026-11-25T19:00:00Z", ["2026-11-26T01:00:00Z"]) };
export const NOTHING_PLANNED = { id: "1800", name: "Christmas Eve", problem: null, next: null };
/** A `pick_service` reply, in the order given (native orders soonest first). */
export const pickReply = (...services: unknown[]) => ({ services, time_zone: "America/Chicago", more: false });
