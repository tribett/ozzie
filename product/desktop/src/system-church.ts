// A church on B1 Church or Breeze, as App holds it: which system and church this Mac keeps (church-system.ts), the last
// check of the watched service, and the brief built from it (core church-systems/brief.ts), the same SundayBrief a
// Planning Center check gives. Every check goes through the Sunday schedule (system-watch.ts): on its own at launch and
// on its interval, and when the person asks (Check now, first run); App hands each finished one here (`take`).
// Each check is also kept on this Mac (native church_systems.rs); the newest saved one of the watched service is shown,
// labeled as a saved copy, until a check lands, and when the person asks for it after a check fails.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildSystemBrief, type SystemBrief } from "../../../core/src/church-systems/brief.js";
import { placeholderScope } from "../../../core/src/church-systems/placeholders.js";
import { isKnownZone, parseSystemCaptureText, type SystemCapture } from "../../../core/src/church-systems/types.js";
import { localDate } from "../../../core/src/church-time.js";
import type { FeedbackEntry } from "../../../core/src/finding-feedback.js";
import {
  churchSystem, churchSystems, isOtherSystem, readProblemText, type churchSystemStore, type ChurchSystemState, type OtherSystem, type SavedCheck,
  type SystemConnection,
} from "./church-system.js";

type Bridge = Pick<typeof churchSystems, "check" | "savedChecks" | "loadCheck">;
type Store = Pick<ReturnType<typeof churchSystemStore>, "get" | "set">;

/** The service's day where the church meets: the system's own day, else its start in the confirmed zone; null if neither. */
export function realDay(capture: SystemCapture, zone: string | null): string | null {
  const service = capture.service;
  if (!service) return null;
  if (service.day) return service.day;
  const placed = capture.church.time_zone ?? zone;
  return placed && isKnownZone(placed) ? localDate(service.starts_at, placed) : null;
}

/** Whether `capture` is a read of `connection`'s watched service. */
export const ofConnection = (capture: SystemCapture | null, connection: SystemConnection | null): capture is SystemCapture =>
  Boolean(capture && connection && capture.system === connection.system && capture.church.id === connection.church_id &&
    connection.service_id !== null && capture.service?.id === connection.service_id);

/** Reads `connection`'s watched service through native. A capture native sends that the page refuses is never shown. */
export async function readSystem(connection: SystemConnection, bridge: Pick<Bridge, "check"> = churchSystems): Promise<{ outcome: string; capture: SystemCapture | null }> {
  if (!connection.service_id) return { outcome: "bad-id", capture: null };
  const r = await bridge.check(connection.system, connection.church_id, connection.service_id, connection.zone);
  if (r.outcome !== "ok" || !r.capture) return { outcome: r.outcome === "ok" ? "invalid-response" : r.outcome, capture: null };
  const parsed = parseSystemCaptureText(r.capture);
  return parsed.ok ? { outcome: "ok", capture: parsed.capture } : { outcome: "invalid-response", capture: null };
}
/** A saved check of `connection`'s church read back through native, refused unless it is a whole check of the watched service. */
export async function readSaved(connection: SystemConnection, saved: SavedCheck, bridge: Pick<Bridge, "loadCheck"> = churchSystems): Promise<SystemCapture | null> {
  const r = await bridge.loadCheck(connection.system, connection.church_id, saved.path_id);
  if (r.outcome !== "ok" || !r.capture) return null;
  const parsed = parseSystemCaptureText(r.capture);
  return parsed.ok && ofConnection(parsed.capture, connection) ? parsed.capture : null;
}
/** The error a check ended with, as native's closed outcome word (proactive.ts SystemReadFailure carries it). */
export const outcomeOf = (error: unknown): string =>
  error instanceof Error && "outcome" in error && typeof (error as { outcome: unknown }).outcome === "string" ? (error as { outcome: string }).outcome
    : typeof error === "string" && /^[a-z-]{1,40}$/u.test(error) ? error : "unavailable";

export interface SystemChurch {
  state: ChurchSystemState;
  setState: (next: ChurchSystemState) => void;
  /** The main system when it is B1 Church or Breeze; null for Planning Center or none chosen. */
  on: OtherSystem | null;
  connection: SystemConnection | null;
  /** The check shown: the newest of the watched service, else its newest saved copy (`saved` true). */
  capture: SystemCapture | null;
  saved: boolean;
  built: Extract<SystemBrief, { ok: true }> | null;
  /** A capture that couldn't make a service check (Genesis, no service, no roles), by its closed reason. */
  refusal: Extract<SystemBrief, { ok: false }>["reason"] | null;
  busy: boolean; problem: string;
  /** The decisions key's church and plan: `<system>:<church id>` and the watched service. */
  decisionsKey: { organization: string; plan_id: string } | null;
  /** Reads the watched service now (through the schedule); resolves to native's outcome word ("ok" when a check landed). */
  check: (connection?: SystemConnection) => Promise<string>;
  /** A finished check from the schedule: kept when it is of the church and service watched now. */
  take: (capture: SystemCapture) => void;
  /** A check from the schedule that brought nothing: why, said on the service's page while the same church is watched. */
  fail: (error: unknown) => void;
  /** This church's saved checks, newest first (all its services); reread after each check. */
  savedChecks: SavedCheck[];
  refreshSaved: () => void;
  /** The newest saved check of the watched service, when there is one. */
  latestSaved: SavedCheck | null;
  /** Shows the newest saved check of the watched service: "ok", or why not. */
  showSaved: () => Promise<string>;
  forgetCheck: () => void;
}

export function useSystemChurch(now: string, feedback: readonly FeedbackEntry[], checkNow: () => Promise<SystemCapture>, store: Store = churchSystem,
  bridge: Bridge = churchSystems): SystemChurch {
  const [state, setRaw] = useState(() => store.get());
  const latest = useRef(state);
  latest.current = state;
  const setState = useCallback((next: ChurchSystemState) => { const kept = store.set(next); latest.current = kept; setRaw(kept); }, [store]);
  const [live, setLive] = useState<SystemCapture | null>(null);
  const [savedCapture, setSavedCapture] = useState<SystemCapture | null>(null);
  const [savedChecks, setSavedChecks] = useState<SavedCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const on = isOtherSystem(state.main) ? state.main : null;
  const connection = on ? state.connection : null;
  // "Show the last saved check" shows it in place of the check on screen until the next check lands.
  const [preferSaved, setPreferSaved] = useState(false);
  const liveOk = ofConnection(live, connection) ? live : null;
  const savedOk = ofConnection(savedCapture, connection) ? savedCapture : null;
  const savedShown = savedOk && (preferSaved || !liveOk) ? savedOk : null;
  const liveShown = savedShown ? null : liveOk;
  const shown = liveShown ?? savedShown;
  const result = useMemo(() => shown && connection ? buildSystemBrief(shown, { confirmedZone: connection.zone, feedback }, now, { saved: shown === savedShown }) : null,
    [shown, savedShown, connection?.zone, feedback, now]);

  // This church's saved checks, read again when the church changes and after each check.
  const church = connection ? `${connection.system}:${connection.church_id}` : null;
  const refreshSaved = useCallback(() => {
    const c = latest.current.connection;
    if (!c || !isOtherSystem(latest.current.main)) { setSavedChecks([]); return; }
    const of = `${c.system}:${c.church_id}`;
    void bridge.savedChecks(c.system, c.church_id).then(list => {
      const still = latest.current.connection;
      if (still && `${still.system}:${still.church_id}` === of) setSavedChecks(list);
    });
  }, [bridge]);
  useEffect(() => { setSavedChecks([]); refreshSaved(); }, [church, refreshSaved]);
  const latestSaved = connection?.service_id ? savedChecks.find(c => c.service_id === connection.service_id) ?? null : null;

  const showSaved = useCallback(async (): Promise<string> => {
    const c = latest.current.connection;
    const newest = c?.service_id ? savedChecks.find(s => s.service_id === c.service_id) : undefined;
    if (!c || !newest) return "not-found";
    const capture = await readSaved(c, newest, bridge);
    if (!capture || !ofConnection(capture, latest.current.connection)) return "invalid-response";
    setSavedCapture(capture);
    setPreferSaved(true);
    return "ok";
  }, [bridge, savedChecks]);
  // Until a check of the watched service lands, its newest saved copy is shown (labeled as one), once per service.
  const autoShown = useRef<string | null>(null);
  const watched = connection?.service_id ? `${church}:${connection.service_id}` : null;
  useEffect(() => {
    if (!watched || liveShown || savedShown || !latestSaved || autoShown.current === watched) return;
    autoShown.current = watched;
    const c = latest.current.connection;
    if (c) void readSaved(c, latestSaved, bridge).then(capture => { if (capture && ofConnection(capture, latest.current.connection)) setSavedCapture(capture); });
  }, [watched, Boolean(liveShown), Boolean(savedShown), latestSaved?.path_id]);

  const take = useCallback((capture: SystemCapture) => {
    const still = latest.current.connection;
    // Only a read of the church and service still watched is kept (the person may have switched meanwhile).
    if (!still || !isOtherSystem(latest.current.main) || !ofConnection(capture, still)) return;
    setLive(capture);
    setPreferSaved(false);
    setProblem("");
    // The service's real day, as this check placed it (B1 Church can list a plan a day early far ahead of UTC), so
    // moving on to the next service compares the day the church meets.
    const day = realDay(capture, still.zone) ?? still.service_day;
    if (!still.result_seen || day !== still.service_day) setState({ ...latest.current, connection: { ...still, result_seen: true, service_day: day } });
    refreshSaved();
  }, [setState, refreshSaved]);
  const fail = useCallback((error: unknown) => {
    const outcome = outcomeOf(error);
    const system = error instanceof Error && "system" in error ? (error as { system: unknown }).system : null;
    const of = error instanceof Error && "church" in error ? (error as { church: unknown }).church : null;
    const c = latest.current.connection;
    // Never said of another church: one connected since a check of the church before it failed (review L3).
    if (!c || !isOtherSystem(latest.current.main) || (system !== null && system !== c.system) || (typeof of === "string" && of !== c.church_id)) return;
    const word = /^(?:busy|not-connected)$/u.test(outcome) ? "unavailable" : outcome;
    setProblem(readProblemText(c.system, word) ?? readProblemText(c.system, "unavailable") ?? "");
  }, []);
  const check = useCallback(async (): Promise<string> => {
    const c = latest.current.connection;
    if (!c) return "no-key";
    setBusy(true); setProblem("");
    try {
      // A check already under way (on its own) may be of the service watched before the person chose another one: then
      // the one now watched is read straight after it, so Check now and a new choice always read what they name (review M2).
      let capture = await checkNow();
      if (!ofConnection(capture, latest.current.connection)) capture = await checkNow();
      if (ofConnection(capture, latest.current.connection)) return "ok";
      setProblem(readProblemText(c.system, "busy") ?? "");
      return "busy";
    } catch (error) {
      const outcome = outcomeOf(error);
      // The schedule's own refusals (already checking, not set up yet) aren't the system's: said as it being unavailable.
      const word = /^(?:busy|not-connected)$/u.test(outcome) ? "unavailable" : outcome;
      const still = latest.current.connection;
      if (still && still.system === c.system && still.church_id === c.church_id) setProblem(readProblemText(c.system, word) ?? readProblemText(c.system, "unavailable") ?? "");
      return word;
    } finally { setBusy(false); }
  }, [checkNow]);
  return {
    state, setState, on, connection, capture: shown, saved: Boolean(savedShown),
    built: result?.ok ? result : null, refusal: result && !result.ok ? result.reason : null,
    busy, problem,
    decisionsKey: shown && connection?.service_id ? { organization: placeholderScope(shown), plan_id: connection.service_id } : null,
    check, take, fail, savedChecks, refreshSaved, latestSaved, showSaved,
    forgetCheck: () => { setLive(null); setSavedCapture(null); setPreferSaved(false); setProblem(""); autoShown.current = null; },
  };
}
