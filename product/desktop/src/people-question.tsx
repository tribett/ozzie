// "Fill in who it's to?" (onboarding spec §4.2): asked the first time someone opens a note for one person in Mail or
// Messages while Ozzie's Planning Center sign-in doesn't include People, where email addresses and mobile numbers are
// kept. A sheet over the window, before anything opens. "Allow People access in my browser" runs the same explain →
// wait → welcome-back pattern as the first connection (S2–S4), compactly here: the sheet's words are the explanation; a
// waiting line with Cancel while the browser is out; once Planning Center has added People, the note opens addressed.
// "Open it without an address" opens it with To empty and is remembered (moments.ts), so the sheet is asked again only
// from the note's own "Fill in who it's to" link.
//
// Ozzie still only reads: the sign-in asks for People together with Calendar and Groups because Planning Center gives
// them together. Nothing here reads an address: native fills in To when the note opens (draft-actions.tsx).
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { promise } from "./promises.js";
import { connection, granted, moreOf, type ConnectionStatus } from "./connection.js";
import "./finish.css";

export const PEOPLE_TITLE = "Fill in who it's to?";
export const peopleBody = (name: string) =>
  `To put ${name}'s email address or mobile number in To, Ozzie needs to read Planning Center People. Ozzie asks for People together with Calendar and Groups, and Planning Center words it as read-and-write. ${promise("connectAnd")}`;
/**
 * Exactly what that read is and what it is for, said before it first happens (review P, L8: every read Ozzie can make is
 * stated where a person sees it first; native contact.rs reads it and never addresses a child).
 */
export const PEOPLE_READS = "Each time you open a note for one person in Mail or Messages, Ozzie reads that person's email addresses or phone numbers, and whether Planning Center lists them as a child, for that one person only. It uses one only to fill in To, keeps it nowhere, and never sends it to an AI. A person Planning Center lists as a child is never addressed. " +
  // Native reads rooms, follow-ups and group events only while Settings' switch is on, never because of this grant
  // (sunday_check.rs ChurchReads::operations, commit 2159c645; first-run review H1).
  "Allowing it starts nothing else: room bookings, follow-ups and group meetings are read only if you turn them on in Settings.";
export const ALLOW_PEOPLE = "Allow People access in my browser";
export const WITHOUT_ADDRESS = "Open it without an address";
export const PEOPLE_WAITING = "Waiting for you to choose Allow in your browser…";
export const PEOPLE_CHECKING = "Planning Center said yes. Checking…";

/** How the sign-in for People ended, in the page's own words; null when it worked. Nothing changed in any of them. */
export type PeopleEnd = "cancelled" | "denied" | "expired" | "not-granted" | "browser" | "failed";
export const PEOPLE_ENDS: Record<PeopleEnd, string> = {
  cancelled: "Nothing changed. You can try again, or open the note without an address.",
  denied: "You chose not to allow it in Planning Center, so nothing changed.",
  expired: "That took longer than 5 minutes, so Ozzie stopped waiting. Nothing changed.",
  "not-granted": "Planning Center didn't add People this time, so Ozzie still can't fill in To. Nothing else changed.",
  browser: "Your browser didn't open. Press the button again. If nothing happens, choose a default web browser in System Settings › Desktop & Dock.",
  failed: "Ozzie couldn't finish connecting just now. Nothing changed. Try again in a moment.",
};

/** The Planning Center sign-in this sheet starts and watches (tests pass their own). */
export interface PeopleAccess {
  /** Starts a browser sign-in that asks for People too, keeping the other products the connection has. */
  start(): Promise<unknown>;
  status(): Promise<ConnectionStatus | null>;
  cancel(): Promise<unknown>;
}
export const peopleAccess: PeopleAccess = {
  start: async () => connection.connectApp(true, moreOf(await connection.status().catch(() => null))),
  status: () => connection.status(),
  cancel: () => connection.cancel(),
};
/** About five minutes for Allow (native's attempt lasts five), plus a little for the check after. */
const WAIT_MS = 330_000;

/** What a status after the attempt means: People granted (null), or why not. Undefined while still waiting. */
export function peopleOutcome(status: ConnectionStatus | null): PeopleEnd | null | undefined {
  if (!status || status.state === "waiting" || status.state === "checking") return status ? undefined : "failed";
  if (status.state === "connected") {
    if (granted(status)?.operations) return null;
    // The church in use went back into use after an attempt that didn't connect: native keeps how it ended.
    const last = status.last_attempt;
    if (last && typeof last === "object") return endOf(last.state, last.problem);
    return "not-granted";
  }
  return endOf(status.state, status.problem);
}
const endOf = (state: unknown, problem: unknown): PeopleEnd =>
  problem === "denied" ? "denied" : state === "expired" ? "expired" : state === "cancelled" ? "cancelled" : "failed";

export function PeopleQuestion({ name, onAddressed, onWithout, onClose, access = peopleAccess, pollMs = 1000, clock = Date.now }: {
  /** The name the page already shows for this person, or "this person". */
  name: string;
  /** People is granted now: open the note addressed. */
  onAddressed: () => void;
  /** "Open it without an address": the page remembers it and opens the note with To empty. */
  onWithout: () => void;
  /** Escape or closing the sheet: nothing opens. */
  onClose: () => void;
  access?: PeopleAccess | undefined; pollMs?: number | undefined; clock?: (() => number) | undefined;
}) {
  const id = useId();
  const [phase, setPhase] = useState<"ask" | "waiting" | "checking">("ask");
  const [end, setEnd] = useState<PeopleEnd | null>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const alive = useRef(true);
  // Each Allow is one attempt; Cancel or a new Allow ends the one before, so its waiting loop stops.
  const attempt = useRef(0);
  useEffect(() => { title.current?.focus(); return () => { alive.current = false; }; }, []);
  const waiting = phase !== "ask";

  const allow = async () => {
    const mine = ++attempt.current;
    const current = () => alive.current && attempt.current === mine;
    setEnd(null);
    setPhase("waiting");
    try { await access.start(); }
    catch (error) {
      if (!current()) return;
      setPhase("ask");
      setEnd(JSON.stringify(error ?? "").includes("browser-unavailable") ? "browser" : "failed");
      return;
    }
    const until = clock() + WAIT_MS;
    while (current()) {
      await new Promise(resolve => setTimeout(resolve, pollMs));
      if (!current()) return;
      let status: ConnectionStatus | null;
      try { status = await access.status(); } catch { status = null; }
      if (!current()) return;
      const outcome = peopleOutcome(status);
      if (outcome === undefined && clock() < until) { setPhase(status?.state === "checking" ? "checking" : "waiting"); continue; }
      if (outcome === null) { onAddressed(); return; }
      setPhase("ask");
      setEnd(outcome ?? "expired");
      return;
    }
  };
  const cancel = () => { attempt.current++; setPhase("ask"); setEnd("cancelled"); void access.cancel().catch(() => undefined); };

  return <div className="people-scrim">
    <div className="people-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={`${id}-b`}
      // Escape closes the sheet, never a sign-in in progress (spec §0.1): while waiting, Cancel is the way out.
      onKeyDown={e => { if (e.key === "Escape" && !waiting) { e.stopPropagation(); onClose(); } }}>
      <h2 id={`${id}-t`} className="h3" tabIndex={-1} ref={title}>{PEOPLE_TITLE}</h2>
      <p id={`${id}-b`}>{peopleBody(name)}</p>
      <p className="small">{PEOPLE_READS}</p>
      <p className="people-wait" aria-live="polite">{waiting && <><Icon name="spinner" small spin />{phase === "checking" ? PEOPLE_CHECKING : PEOPLE_WAITING}</>}</p>
      {end && <p role={end === "cancelled" ? undefined : "alert"} className={end === "cancelled" ? "small" : "problem"}>{PEOPLE_ENDS[end]}</p>}
      <div className="people-acts">
        {waiting
          ? <button type="button" className="btn btn-quiet" onClick={cancel}>Cancel</button>
          : <>
            <button type="button" className="btn btn-primary" onClick={() => { void allow(); }}>{ALLOW_PEOPLE}</button>
            <button type="button" className="btn btn-secondary" onClick={onWithout}>{WITHOUT_ADDRESS}</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>Not now</button>
          </>}
      </div>
    </div>
  </div>;
}
