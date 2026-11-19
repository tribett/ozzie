// Native's switch for rooms, follow-ups and group events (`operations_reads`, kept per church: main.rs
// operations-reads.json), and the one way the page asks Planning Center for the Calendar, People and Groups access those
// reads need. Settings' "Also check rooms, follow-ups and group events" and the offer after the first check
// (read-more.tsx, onboarding decision 24) both go through here, so there is one sign-in path, not two.
//
// The switch goes on only after Planning Center granted the access, never before: a later People grant for a note's To
// line must never start these reads (first-run review H1). A sign-in that asked for them is remembered here, in memory
// only, until Planning Center answers, so the switch goes on whichever page is open when the answer comes back. Any other
// sign-in started meanwhile (the To line's People, Sign in again) replaces it in native and here forgets the ask, so its
// grant turns nothing on (review M1); native refuses it too, from the purpose each sign-in carries (main.rs).
import { useEffect, useLayoutEffect, useState } from "react";
import { moreOf, onSignInStart, operationsGranted, type ConnectionStatus } from "./connection.js";
import { onboarding } from "./onboarding-bridge.js";
import type { ConnectionControl } from "./planning-center-forms.js";

/**
 * Native's switch, set once the connection holds the access: turning on before Planning Center granted it would let a
 * later People grant for To start those reads. Null: not set (not granted yet). `how`: a person's press, or the page's
 * own call after a sign-in that asked for the access (native allows that one only for such a sign-in's grant).
 */
export async function setOperationsReadsAfter(status: ConnectionStatus | null, on: boolean, how: "pressed" | "after-sign-in",
  set: (on: boolean, pressed: boolean) => Promise<boolean> = onboarding.setOperationsReads): Promise<boolean | null> {
  if (on && !operationsGranted(status)) return null;
  return set(on, how === "pressed");
}

/** A sign-in that asked for Calendar, People and Groups: started ("asked"), in the browser ("waiting"), or none. */
export type Wanted = false | "asked" | "waiting";
/** `church`: the organization native's answer was for, so another church's switch is never taken for it (review 2026-11-19). */
const shared: { on: boolean | null; church: string | null; wanted: Wanted } = { on: null, church: null, wanted: false };
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };
const put = (on: boolean | null, church: string | null) => { shared.on = on; shared.church = church; changed(); };
// A sign-in for anything else replaced the one that asked (native stops it): its grant is not the one asked for.
onSignInStart(purpose => { if (purpose !== "operations" && shared.wanted) { shared.wanted = false; changed(); } });

/**
 * What a status means for a sign-in that asked for the access: still in the browser, granted (turn the switch on), ended
 * without it (forget it), or not started yet (a status from before the browser opened).
 */
export function wantedAfter(wanted: Wanted, status: ConnectionStatus | null): { wanted: Wanted; turnOn: boolean } {
  if (!wanted) return { wanted, turnOn: false };
  if (status?.state === "waiting" || status?.state === "checking") return { wanted: "waiting", turnOn: false };
  if (operationsGranted(status)) return { wanted: false, turnOn: true };
  return { wanted: wanted === "waiting" ? false : wanted, turnOn: false };
}

/**
 * The switch as the page knows it, the same for every page that asks. `read`: ask native again on mount and whenever the
 * church in use changes (App does; a page under it needn't). The access a sign-in asked for turns the switch on as soon
 * as a status shows Planning Center granted it, whichever page holds this hook then.
 */
export function useOperationsReads(status: ConnectionStatus | null, { read = true }: { read?: boolean } = {}) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const again = () => redraw(n => n + 1);
    listeners.add(again);
    return () => { listeners.delete(again); };
  }, []);
  const church = status?.organization || null;
  useEffect(() => { if (read) void onboarding.operationsReads().then(on => put(on, church), () => undefined); }, [read, church]);
  // Before paint, so a page never shows the access as granted but off for a moment while the switch goes on.
  useLayoutEffect(() => {
    const next = wantedAfter(shared.wanted, status);
    if (next.wanted !== shared.wanted) { shared.wanted = next.wanted; changed(); }
    if (!next.turnOn) return;
    put(true, church);
    void setOperationsReadsAfter(status, true, "after-sign-in").then(v => put(v ?? false, church), () => put(false, church));
  }, [status?.state, status?.scopes, status?.organization, status?.revision]);
  return {
    /** Native's switch for the church in use; null until native has said for this church (or when it couldn't). */
    on: shared.church === church ? shared.on : null,
    /** A sign-in that asked for the access is under way. */
    asking: shared.wanted !== false,
    /** A person's press: turns the reads on (only once granted) or off. Resolves with the switch, or null when it wasn't set. */
    switchReads: (want: boolean) => setOperationsReadsAfter(status, want, "pressed").then(v => { if (v !== null) put(v, church); return v; }),
  };
}

/**
 * Signs in again asking Planning Center for Calendar, People and Groups, keeping the Check-Ins and Registrations the
 * connection already has, with the registration in use (Ozzie's own, or one typed under "For a copy of Ozzie you built
 * yourself"): the same call as every Planning Center sign-in. Resolves false when the sign-in couldn't start (its
 * problem is on `control.problem`, from "operations").
 */
export async function askForOperations(control: ConnectionControl, status: ConnectionStatus | null): Promise<boolean> {
  let started = true;
  shared.wanted = "asked"; changed();
  await control.run(async () => {
    try { return await control.signIn(true, moreOf(status), "operations"); }
    catch (error) { started = false; shared.wanted = false; changed(); throw error; }
  }, "operations");
  return started;
}

/** Tests only: forget what this page knew of the switch and any sign-in under way. */
export function resetOperationsReads() { shared.on = null; shared.church = null; shared.wanted = false; changed(); }
