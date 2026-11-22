// The page side of a change in Planning Center (planning-center-changes.ts): the switch's state and the one change being
// looked at, kept by App (`useChanges`) so a result outlives the check it came from; the button on a person's row in
// "who could help" and the confirmation under it (`ChangeOffer`); what came back, with "Take … off again"
// (`ChangeResults`); the switch in Settings (`ChangesSwitch`); and What happened's list (`ChangeHistory`).
//
// App hands these to the pages only while the switch is on for the church in use and the check on screen is a live
// one; without them every page is exactly as it is with changes off. Nothing here is offered to a model, a notice,
// Siri or the copy for other AI apps (stays-on-this-Mac proofs, product/desktop/test/planning-center-changes.test.ts).
// The one thing App takes from here for Ask: the keys of the check's own findings that adds made this session fill
// (`filledByAdds`), so its suggested questions move on from those roles; display only, no change, name or record.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Finding, SundayBrief } from "../../../core/src/sunday-brief.js";
import { Icon } from "./icons.js";
import { NOT_OPENED, OPEN_PLAN, type PlanningCenterPage } from "./planning-center-pages.js";
import {
  addButton, adding, backgroundFact, changes, CHECKING, CLOSE, CONFIRM_EXPIRED, confirmChecked, confirmPlace, confirmPlaceBack, confirmTitle, confirmUndo, confirmUndoEnds, confirmUntil,
  confirmWaiting, despiteChoice, despiteHelp, dontAdd, firstName, HIDE, HISTORY_NONE, HISTORY_TITLE, HISTORY_WHO, historyLine, KIDS_MARKED, KIDS_NOT_ADVISED,
  kidsAdvice, LOOK_AGAIN, made, mayTryUndoAgain, NO_PEOPLE_YET, notKnown, outcomeSentence, PREPARE_FAILED, RECHECK_FAILED, RECHECKING, refusalOf,
  planWords, refusalSentence, selectFirst, sundayLabel, SWITCH_LABEL, SWITCH_TITLE, switchBody, switchOff, switchProblem, takeOff, takingOff,
  undoWroteOut, wroteOut, yesAdd, addedPast, afterUndo,
  type BackgroundCheck, type ChangeRecord, type ChangesStatus, type Proposed, type Said, type UndoAnswer,
} from "./planning-center-changes.js";
import type { SundayChanges } from "./sunday-page.js";

/**
 * Who and which role the leader chose, from the open role's card: ids from the check on screen, and the names it shows.
 * `plan` is that service's own plan (several services watched: each part of the Services page has its own), `service` its
 * Planning Center name as Ozzie keeps it (null when not known).
 */
export interface ChangeAsk { key: string; plan: string; service: string | null; team: string; role: string; person: string; full: string; at: string | null }
/** The one change being looked at. */
export interface OpenChange {
  ask: ChangeAsk;
  stage: "checking" | "proposed" | "confirming" | "refused";
  proposed: Proposed | null;
  sentence: string | null;
}
/**
 * What came back from a change the leader confirmed this session, and from taking the person off again. `sentence` and
 * `tone` are the add's answer, shown only until a take-off has an answer (`answer`, at `offAt`); the card then says only
 * what is true now (planning-center-changes.ts `afterUndo`). `addedAt`: when Planning Center made the row.
 */
export interface ChangeResult {
  /** `plan`: the plan the change was made on; `day`: its church-local date ("2026-11-29"). */
  id: number; ask: ChangeAsk; plan: string; day: string; sentence: string;
  tone: "made" | "look" | "unchanged";
  row: string | null;
  undo: "can" | "working" | "done" | "none";
  addedAt: string | null;
  answer: UndoAnswer | null;
  offAt: string | null;
}
/**
 * A role whose card waits for the new check of its plan after a change or an undo (`failed`: that check didn't come).
 * `since`: when the plan's check on screen then was made; a newer one ends the wait.
 */
export interface Recheck { plan: string; key: string; failed: boolean; since: string | null }
export interface ChangesControl {
  /** The switch as native code last said, for the church in use; null until known (or not connected). */
  status: ChangesStatus | null;
  /**
   * On for the church in use, as native code last said. Not dropped while App's connection blinks (a sign-in renewal,
   * "Check saved connection"): native code still holds what it made then. Adding is offered only while `connected`.
   */
  on: boolean;
  /** Planning Center is connected now: Add is offered only then. */
  connected: boolean;
  working: boolean; problem: string | null;
  set(on: boolean): void;
  open: OpenChange | null;
  results: readonly ChangeResult[];
  /** Each plan whose part waits for its new check after a change or an undo there (several services watched: one wait each). */
  rechecks: Readonly<Record<string, Recheck>>;
  /** First names of the people this session added who can still be taken off here (for the quit question). */
  undoable: readonly string[];
  ask(a: ChangeAsk): void;
  confirm(despite: BackgroundCheck | undefined): void;
  close(): void;
  undo(id: number): void;
  hide(id: number): void;
  /** What happened's records: undefined while loading, null when they couldn't be read. */
  history: ChangeRecord[] | null | undefined;
  loadHistory(): void;
  /** Counts each write that went out, so What happened reads its records again. */
  writes: number;
}

/**
 * The open roles that adds made this session fill while the check on screen doesn't show them yet (made after it was
 * read, on its plan, and not taken off again), by finding key: so Ask's suggested questions move on from them (App,
 * ask-panel.tsx settledRoles). Keys of the check's own findings only; nothing about a change goes anywhere else.
 */
export function filledByAdds(brief: Pick<SundayBrief, "plan" | "checked_at" | "findings">,
  results: readonly Pick<ChangeResult, "ask" | "plan" | "tone" | "addedAt" | "answer">[]): string[] {
  const read = brief.checked_at ? Date.parse(brief.checked_at) : NaN;
  const added = new Map<string, number>();
  for (const r of results) {
    // Taken off again, or already gone: the place is open again. Any other answer to a take-off leaves the add standing.
    const stands = r.tone === "made" && r.answer?.result !== "removed" && r.answer?.result !== "already-gone";
    const unseen = r.addedAt === null || Number.isNaN(read) || Date.parse(r.addedAt) > read;
    if (stands && unseen && r.plan === brief.plan.id) added.set(r.ask.key, (added.get(r.ask.key) ?? 0) + 1);
  }
  return brief.findings.filter(f => f.kind === "needs-people" && typeof f.remaining === "number" && f.remaining > 0 && (added.get(f.key) ?? 0) >= f.remaining)
    .map(f => f.key);
}

/** Who, which role and, once Planning Center was read for it, which plan: "the Youth Night plan for Wednesday, Nov 25". */
const said = (a: ChangeAsk, day: string | null = null): Said => ({ name: firstName(a.full), role: a.role, at: a.at, plan: planWords(a.service, day ? sundayLabel(day) : null) });

/**
 * The switch and the change being looked at, for the church in use (`organization`, digits; "" when none, or a church on
 * another system). `afterWrite` takes a fresh check of every service watched (native code drops the check of the plan a
 * change was made on once anything is sent) and says whether that plan's own new check came; `checked` names each
 * service's live check on screen by its plan, so a role waiting for its plan's new check is shown again once it is in.
 */
export function useChanges({ organization, connected, disconnected = false, kidsTeamIds, afterWrite, checked = {}, showingHistory = false, disconnectTries = 0 }: {
  organization: string; connected: boolean;
  /** No saved sign-in at all (after Disconnect): native code left the church and forgot what it made. A blink never is this. */
  disconnected?: boolean;
  kidsTeamIds: readonly string[]; afterWrite: (plan: string) => Promise<boolean>; checked?: Readonly<Record<string, string>>;
  /** What happened is on screen: its list is read then, and again after each write and each time Planning Center is connected again. */
  showingHistory?: boolean;
  /** Counts each Disconnect tried, however it ended: native code turns changes off for the church either way. */
  disconnectTries?: number;
}): ChangesControl {
  const [status, setStatus] = useState<ChangesStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<OpenChange | null>(null);
  const [results, setResults] = useState<ChangeResult[]>([]);
  const [rechecks, setRechecks] = useState<Readonly<Record<string, Recheck>>>({});
  const [history, setHistory] = useState<ChangeRecord[] | null | undefined>(undefined);
  const [writes, setWrites] = useState(0);
  // Each ask gets a number: an answer for an ask the leader has since replaced or closed is dropped.
  const asked = useRef(0);
  // Bumped whenever what this church's changes were is let go (another church, Disconnect, native off): any answer still on
  // its way from before (a yes, a look, a take-off, the list) belongs to that and is dropped.
  const generation = useRef(0);
  const nextId = useRef(0);
  const latest = useRef({ organization, kidsTeamIds, afterWrite, checked });
  latest.current = { organization, kidsTeamIds, afterWrite, checked };
  // Another church, or none (Disconnect): nothing of the last one's changes stays on screen (native code forgot them too).
  useEffect(() => {
    generation.current++;
    setOpen(null); setResults([]); setRechecks({}); setHistory(undefined); setProblem(null); setStatus(null); asked.current++;
  }, [organization]);
  useEffect(() => {
    if (!disconnected) return;
    generation.current++;
    setOpen(null); setResults([]); setRechecks({}); setHistory(undefined); setProblem(null); setStatus(null); asked.current++;
  }, [disconnected]);
  // The switch, read again whenever Planning Center is connected again. While it isn't (one status poll of a renewal, or
  // "Check saved connection"), what native code said is kept: nothing it made is forgotten by that.
  useEffect(() => {
    if (!connected || !organization) return;
    let alive = true;
    changes.status().then(s => { if (alive) setStatus(s); }, () => undefined);
    return () => { alive = false; };
  }, [organization, connected]);
  // After a Disconnect attempt, even one that failed with the connection unchanged: read the switch again. Once native
  // code says off, the clearing below lets go of the results, the Take-off buttons and the quit list.
  useEffect(() => {
    if (!disconnectTries || !organization) return;
    let alive = true;
    changes.status().then(s => { if (alive) setStatus(s); }, () => undefined);
    return () => { alive = false; };
  }, [disconnectTries]);
  const on = Boolean(organization && status?.on && status.organization === organization);
  // Native code says it's off: it forgot what it made, so nothing here can be taken off again.
  const off = status !== null && !status.on;
  useEffect(() => { if (off) { generation.current++; setOpen(null); setResults([]); asked.current++; } }, [off]);
  // A new check of the plan a role waits for is in: it shows its people again. Another service's check doesn't end it.
  const checkedKey = JSON.stringify(checked);
  useEffect(() => {
    setRechecks(all => {
      const kept = Object.entries(all).filter(([plan, r]) => { const now = checked[plan] ?? null; return now === null || now === r.since; });
      return kept.length === Object.keys(all).length ? all : Object.fromEntries(kept);
    });
  }, [checkedKey]);
  const wrote = (plan: string, key: string) => {
    // Native code dropped that plan's check and any change it had ready: an open confirmation can't be used any more.
    asked.current++; setOpen(null);
    setWrites(n => n + 1);
    const since = latest.current.checked[plan] ?? null;
    // Only this plan's wait: another service's own wait (or its "didn't come") is left as it is (review of write-back-050, L4).
    const settle = (failed: boolean) => setRechecks(all => {
      const r = all[plan];
      if (r && (r.key !== key || r.since !== since)) return all;
      if (!failed) return r ? Object.fromEntries(Object.entries(all).filter(([p]) => p !== plan)) : all;
      return { ...all, [plan]: { plan, key, failed: true, since } };
    });
    setRechecks(all => ({ ...all, [plan]: { plan, key, failed: false, since } }));
    void latest.current.afterWrite(plan).then(ok => settle(!ok), () => settle(true));
  };
  const result = (a: ChangeAsk, plan: string, sentence: string, tone: ChangeResult["tone"], row: string | null, addedAt: string | null, day: string) =>
    setResults(r => [{ id: ++nextId.current, ask: a, plan, day, sentence, tone, row, undo: row ? "can" : "none", addedAt, answer: null, offAt: null }, ...r]);
  /**
   * What happened's list for this church, whatever its switch says now: what Ozzie changed stays listed after it is turned
   * off (native code reads only this Mac's record, for the church the sign-in is bound to). A list already shown stays if
   * a later read fails (a blink of the sign-in).
   */
  const loadHistory = () => {
    if (!organization) return;
    const gen = generation.current;
    changes.history(50).then(list => { if (gen === generation.current) setHistory(list); },
      () => { if (gen === generation.current) setHistory(h => Array.isArray(h) ? h : null); });
  };
  // Read when What happened is shown, after each write, and each time Planning Center is connected again.
  useEffect(() => { if (showingHistory && organization) loadHistory(); }, [showingHistory, organization, on, connected, writes]);
  const undoable = [...new Set(results.filter(r => r.undo === "can" || r.undo === "working").map(r => firstName(r.ask.full)))];
  return {
    status, on, connected, working, problem, open, results, rechecks, undoable, history, writes,
    set: next => {
      setWorking(true); setProblem(null);
      changes.set(next).then(s => setStatus(s), e => setProblem(switchProblem(e))).finally(() => setWorking(false));
    },
    ask: a => {
      const mine = ++asked.current, gen = generation.current;
      setOpen({ ask: a, stage: "checking", proposed: null, sentence: null });
      // The plan is the one this service's part shows; native code refuses any plan no live check of a watched service read.
      changes.prepare({ plan: a.plan, team: a.team, position: a.role, person: a.person, kidsTeamIds: latest.current.kidsTeamIds }).then(
        p => { if (asked.current === mine && gen === generation.current) setOpen({ ask: a, stage: "proposed", proposed: p, sentence: null }); },
        e => {
          if (asked.current !== mine || gen !== generation.current) return;
          const r = refusalOf(e);
          setOpen({ ask: a, stage: "refused", proposed: null, sentence: r ? refusalSentence(r, said(a)) : PREPARE_FAILED });
        });
    },
    confirm: despite => {
      const now = open;
      if (!now?.proposed || now.stage !== "proposed") return;
      const { ask: a, proposed: p } = now;
      // The one place a change is made: the leader's yes to this exact change, its advice acknowledged only when given.
      const acknowledged = p.advised_against && despite !== undefined && despite === p.background_check ? despite : undefined;
      // Advised against: never on one tap. Nothing is asked of native code until the leader ticked going ahead anyway.
      if (p.advised_against && acknowledged === undefined) return;
      const mine = ++asked.current, gen = generation.current;
      setOpen({ ...now, stage: "confirming" });
      changes.confirm(p.change, acknowledged).then(o => {
        // Another church (or Disconnect, or off) since: this answer is not this church's, and nothing of it is shown.
        if (gen !== generation.current) return;
        if (o.result === "not-made") {
          if (asked.current === mine) setOpen({ ask: a, stage: "refused", proposed: null, sentence: outcomeSentence(o, said(a, p.sunday)) });
          return;
        }
        result(a, made(o) ? o.record.plan : p.plan, outcomeSentence(o, said(a, p.sunday)), made(o) ? "made" : o.result === "unknown" || o.result === "several-rows" ? "look" : "unchanged",
          made(o) ? o.record.row ?? null : null, made(o) ? o.record.sent_at || o.record.confirmed_at : null, p.sunday);
        if (asked.current === mine) setOpen(null);
        if (wroteOut(o)) wrote(p.plan, a.key);
      }, () => {
        if (gen !== generation.current) return;
        // The answer never reached the page: whether anything was made isn't known.
        result(a, p.plan, notKnown(firstName(a.full)), "look", null, null, p.sunday);
        if (asked.current === mine) setOpen(null);
        wrote(p.plan, a.key);
      });
    },
    close: () => { asked.current++; setOpen(null); },
    undo: id => {
      const r = results.find(x => x.id === id);
      if (!r?.row || r.undo !== "can") return;
      const row = r.row, gen = generation.current;
      const update = (change: Partial<ChangeResult>) => setResults(all => all.map(x => x.id === id ? { ...x, ...change } : x));
      update({ undo: "working" });
      changes.undo(row).then(u => {
        if (gen !== generation.current) return;
        // The take-off's answer carries no time of its own: the time it reached the page.
        update({ undo: mayTryUndoAgain(u) ? "can" : "done", answer: u, offAt: new Date().toISOString() });
        if (undoWroteOut(u)) wrote(r.plan, r.ask.key);
      }, () => {
        if (gen !== generation.current) return;
        update({ undo: "done", answer: { result: "not-known" }, offAt: new Date().toISOString() });
        wrote(r.plan, r.ask.key);
      });
    },
    hide: id => setResults(all => all.filter(x => x.id !== id || x.undo === "can" || x.undo === "working")),
    loadHistory,
  };
}

/** Opens a Planning Center page by id (App passes planning-center-pages.ts `openInPlanningCenter`). */
export type OpenPage = (page: PlanningCenterPage, id: string) => Promise<boolean>;
/**
 * What one service's part of the Services page needs to offer a change: App passes it only while changes are on and that
 * service's check is live. `plan` that service's plan and `service` its name (null when not known), so the confirmation
 * names them and the change goes to that plan only. `people`: whether the sign-in includes People, without which native
 * code refuses every change (so none is offered). `resultsHere`: whether a change made on a plan shows its result here.
 */
export interface ChangeSlot {
  control: ChangesControl; zone: string | null; openPc: OpenPage | null; people: boolean; plan: string; service: string | null;
  resultsHere?: (plan: string) => boolean;
}

const clock = (iso: string, zone?: string | null) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) });
/** "9:30 AM", "9:30 AM and 11:00 AM", in the church's time zone when it was read; null when the plan lists no time. */
export function servicesLabel(times: readonly { starts_at: string }[], zone: string | null): string | null {
  const at = times.map(t => clock(t.starts_at, zone));
  if (!at.length) return null;
  return at.length === 1 ? at[0]! : `${at.slice(0, -1).join(", ")} and ${at.at(-1)}`;
}
/** The time on the leader's own clock, as "Checked at" says it, and when they added or took someone off. */
export const checkedClock = (iso: string) => clock(iso);

/** Which people on an open role's list a change is offered for: those with no overlap found, or worth a look. */
export const offeredFor = (label: string, left: boolean) => !left && (label === "No overlap found" || label === "Availability needs confirmation");

/** In place of a role's people (or above another role's) while Ozzie waits for the new check, or says it didn't come. */
function Rechecking({ failed }: { failed: boolean }) {
  return failed
    ? <div className="panel-info change-recheck" role="alert"><Icon name="info" small /><p>{RECHECK_FAILED}</p></div>
    : <p className="small change-status change-recheck" role="status"><Icon name="spinner" small spin />{RECHECKING}</p>;
}

/** What a service's part of the Services page draws for changes (sunday-page.tsx `SundayChanges`), built here so that page imports none of it. */
export function sundayChanges(slot: ChangeSlot): SundayChanges {
  // After a change native code dropped the check of that plan, so every Add on that service's part waits for its new
  // check, not only the role's. Another service's part keeps its own check, and its Add buttons.
  const r = slot.control.rechecks[slot.plan] ?? null;
  return {
    // Through a blink of the connection, a change already open for this row stays (its answer still shows); no new Add.
    row: ({ finding, person, full, label, left, busy }) => {
      const open = slot.control.open;
      const mine = open?.ask.plan === slot.plan && open.ask.key === finding.key && open.ask.person === person;
      return slot.people && !r && offeredFor(label, left) && (slot.control.connected || mine)
        ? <ChangeOffer slot={slot} finding={finding} person={person} full={full} busy={busy} /> : null;
    },
    results: <ChangeResults slot={slot} />,
    recheck: finding => r && r.key === finding.key ? <Rechecking failed={r.failed} /> : null,
    waiting: finding => r && r.key !== finding.key && slot.people ? <Rechecking failed={r.failed} /> : null,
  };
}

/** The button on one person's row, and the change for them once the leader asks. */
export function ChangeOffer({ slot, finding, person, full, busy = false }: { slot: ChangeSlot; finding: Finding; person: string; full: string; busy?: boolean }) {
  const c = slot.control;
  const position = finding.position;
  const mine = position && c.open && c.open.ask.plan === slot.plan && c.open.ask.key === finding.key && c.open.ask.person === person ? c.open : null;
  // Closing the change (Don't add, Escape, Close) puts focus back on the button that opened it.
  const button = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !mine) button.current?.focus();
    wasOpen.current = Boolean(mine);
  }, [Boolean(mine)]);
  if (!position) return null;
  const waiting = c.open?.stage === "checking" || c.open?.stage === "confirming";
  const ask: ChangeAsk = { key: finding.key, plan: slot.plan, service: slot.service, team: position.team_id, role: position.name, person, full,
    at: position.interval ? clock(position.interval.starts_at, slot.zone) : null };
  return <div className="person-change">
    {!mine && <button type="button" ref={button} className="btn btn-secondary btn-sm" disabled={busy || waiting} onClick={() => c.ask(ask)}>{addButton(firstName(full), position.name)}</button>}
    {mine && <ChangeCard key={mine.proposed?.change ?? mine.stage} open={mine} control={c} zone={slot.zone} />}
  </div>;
}

/**
 * The confirmation of one exact change, or the calm "Checking…", or why it can't be made. Focus moves to it as it opens
 * (the advice when there is some, else its title; Close on a refusal), and Escape means Don't add.
 */
export function ChangeCard({ open, control, zone, now = () => Date.now() }: { open: OpenChange; control: ChangesControl; zone: string | null; now?: () => number }) {
  const id = useId();
  const [despite, setDespite] = useState(false);
  const p = open.proposed;
  const [expired, setExpired] = useState(() => Boolean(p && Date.parse(p.expires_at) <= now()));
  const first = useRef<HTMLElement | null>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    if (!p) return;
    const left = Date.parse(p.expires_at) - now();
    if (left <= 0) { setExpired(true); return; }
    const timer = setTimeout(() => setExpired(true), left);
    return () => clearTimeout(timer);
  }, [p?.change]);
  const at = (el: HTMLElement | null) => { first.current = el; };
  // Escape cancels the look or closes the refusal; an answer still on its way is dropped (`close`), never shown later.
  const escape = (e: { key: string; stopPropagation(): void }) => { if (e.key === "Escape") { e.stopPropagation(); control.close(); } };
  if (open.stage === "checking") return <p className="small change-status" role="status" tabIndex={-1} ref={at} onKeyDown={escape}><Icon name="spinner" small spin />{CHECKING}</p>;
  if (open.stage === "refused" || !p) return <div className="panel-info change-refused" role="alert" onKeyDown={escape}><Icon name="info" small />
    <div className="stack-tight"><p>{open.sentence ?? PREPARE_FAILED}</p>
      <div><button type="button" ref={at} className="btn btn-quiet btn-sm" onClick={control.close}>{CLOSE}</button></div></div>
  </div>;
  const name = firstName(open.ask.full);
  const advised = p.advised_against;
  const confirming = open.stage === "confirming";
  // The service's own day ("Wednesday, Nov 25"), as Planning Center gave the plan's date just now.
  const day = sundayLabel(p.sunday);
  const fact = p.kids_team && p.background_check ? backgroundFact(p.background_check, name, day, checkedClock(p.checked_at), p.background_check_date ?? null) : null;
  const blocked = advised && !despite;
  const yes = <button type="button" className={`btn ${advised ? "btn-secondary" : "btn-primary"}`} disabled={confirming || blocked}
    aria-describedby={blocked ? `${id}-why` : undefined}
    onClick={() => control.confirm(advised && despite ? p.background_check : undefined)}>{yesAdd(name, advised)}</button>;
  const no = <button type="button" className={`btn ${advised ? "btn-primary" : "btn-secondary"}`} disabled={confirming} onClick={control.close}>{dontAdd(name)}</button>;
  return <section className="change-card" aria-labelledby={`${id}-t`}
    onKeyDown={e => { if (e.key === "Escape" && !confirming) { e.stopPropagation(); control.close(); } }}>
    {/* A kids team without a current check: the advice comes first, then the fact as Planning Center records it. */}
    {fact && advised && <div className="panel-warn change-advice" role="note" tabIndex={-1} ref={at}><Icon name="flag" small />
      <div className="stack-tight">
        <p className="bold change-advice-title">{KIDS_NOT_ADVISED}</p>
        <p>{KIDS_MARKED}</p>
        <p className="bold">{fact}</p>
        <p>{kidsAdvice(p.background_check!)}</p>
      </div></div>}
    <h4 id={`${id}-t`} className="change-title" tabIndex={-1} ref={fact && advised ? undefined : at}>{confirmTitle(open.ask.full, open.ask.service, day)}</h4>
    {fact && !advised && <p className="change-fact"><Icon name="check" small /><span>{fact}</span></p>}
    <p className="change-what">{[p.position, open.ask.service, day, servicesLabel(p.times, zone), `${p.still_needed} still needed`]
      .filter((part): part is string => Boolean(part))
      .map((part, i) => <span key={i}>{i > 0 && " · "}<span className="change-part">{part}</span></span>)}</p>
    <p>{confirmWaiting(name)}</p>
    {confirmPlace(name, p.position, p.still_needed) && <p>{confirmPlace(name, p.position, p.still_needed)}</p>}
    <p className="small change-checked"><Icon name="check" small /><span>{confirmChecked(checkedClock(p.checked_at), name)}</span></p>
    <p>{confirmUndo(name)}</p>
    {/* The rest, in the app's own fold (polish 2026-11-21): what ends the undo, and how long this confirmation holds. */}
    <details className="listen-more change-more"><summary><Icon name="chev" small />See how this works</summary>
      {p.still_needed > 0 && <p className="small">{confirmPlaceBack(name)}</p>}
      <p className="small">{confirmUndoEnds(name)}</p>
      {!expired && <p className="small">{confirmUntil(checkedClock(p.expires_at), name)}</p>}
    </details>
    {expired
      ? <div className="stack-tight"><p role="alert" className="change-expired">{CONFIRM_EXPIRED}</p>
        <div className="find-next change-actions">
          <button type="button" className="btn btn-secondary" onClick={() => control.ask(open.ask)}>{LOOK_AGAIN(name)}</button>
          <button type="button" className="btn btn-quiet" onClick={control.close}>{dontAdd(name)}</button>
        </div></div>
      : <>
        {advised && <div className="stack-tight change-despite">
          <label className="confirmation"><input type="checkbox" checked={despite} disabled={confirming} aria-describedby={`${id}-d`}
            onChange={e => setDespite(e.target.checked)} /><span>{despiteChoice(name)}</span></label>
          <p id={`${id}-d`} className="small">{despiteHelp(name)}</p>
        </div>}
        <div className="find-next change-actions">{advised ? <>{no}{yes}</> : <>{yes}{no}</>}
          {blocked && <span id={`${id}-why`} className="small change-why">{selectFirst(name)}</span>}</div>
        {confirming && <p className="small change-status" role="status"><Icon name="spinner" small spin />{adding(name)}</p>}
      </>}
  </section>;
}

/** "Open the plan in Planning Center" beside a result; says so plainly if the browser didn't open. */
function OpenPlan({ open, plan }: { open: OpenPage; plan: string }) {
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" className="btn btn-quiet btn-sm pc-open" onClick={() => { void open("plan", plan).then(ok => setFailed(!ok)); }}>{OPEN_PLAN}</button>
    {failed && <span role="alert" className="small pc-failed">{NOT_OPENED}</span>}
  </>;
}

const BADGE: Record<ChangeResult["tone"], { cls: string; icon: string; text: string }> = {
  made: { cls: "b-you", icon: "check", text: "Changed in Planning Center" },
  look: { cls: "b-look", icon: "eye", text: "Worth a look" },
  unchanged: { cls: "b-muted", icon: "info", text: "Not on the plan" },
};
export const RESULTS_LABEL = "Changes you confirmed just now";

/**
 * What came back from each change the leader confirmed this session, newest first. Focus moves to what just came back.
 * "Hide this" is offered only once "Take … off again" can no longer work, so hiding never takes the undo away.
 */
export function ChangeResults({ slot }: { slot: ChangeSlot }) {
  const c = slot.control;
  const lines = useRef(new Map<string, HTMLElement>());
  const seen = useRef<Map<number, string> | null>(null);
  // What just came back gets focus: a new result, or a take-off's answer (the card's first line then says it).
  useEffect(() => {
    const now = new Map(c.results.map(r => [r.id, r.offAt ?? ""]));
    if (seen.current) {
      // Only a part that shows it moves focus there (each part keeps its own focus map).
      const fresh = c.results.find(r => !seen.current!.has(r.id)) ?? c.results.find(r => r.offAt && seen.current!.get(r.id) !== r.offAt);
      if (fresh) lines.current.get(`${fresh.id}:0`)?.focus();
    }
    seen.current = now;
  });
  // Several services watched: each part shows what came back from changes on its own plan (App decides, `resultsHere`).
  const here = c.results.filter(r => (slot.resultsHere ?? (plan => plan === slot.plan))(r.plan));
  if (!here.length) return null;
  const line = (key: string) => (el: HTMLElement | null) => { if (el) lines.current.set(key, el); else lines.current.delete(key); };
  return <section className="stack change-results" aria-label={RESULTS_LABEL}>
    {here.map(r => {
      const name = firstName(r.ask.full);
      // Once a take-off has an answer, only what is true now (the add in the past, then the answer); while another try is
      // under way, only the add in the past. When the leader added and took off is on this Mac's clock, as What happened
      // says the same change (the role's own time stays on the church's).
      const now = r.answer ? afterUndo(r.answer, said(r.ask, r.day), r.addedAt ? checkedClock(r.addedAt) : null,
        checkedClock(r.offAt ?? new Date().toISOString())) : { lines: [r.sentence], tone: r.tone };
      const shown = r.answer && r.undo === "working" ? [addedPast(name, r.ask.role, r.addedAt ? checkedClock(r.addedAt) : null)] : now.lines;
      const badge = BADGE[now.tone];
      return <article key={r.id} className={`find change-result${now.tone === "look" ? " is-look" : ""}`}>
        <div className="find-top"><span className={`badge ${badge.cls}`}><Icon name={badge.icon} small />{badge.text}</span><span className="find-where">{r.ask.role}</span></div>
        {shown.map((text, i) => <p key={i} className="find-body" role="status" tabIndex={-1} ref={line(`${r.id}:${i}`)}>{text}</p>)}
        <div className="find-next">
          {r.undo === "can" && <button type="button" className="btn btn-secondary btn-sm" onClick={() => c.undo(r.id)}>{takeOff(name)}</button>}
          {r.undo === "working" && <span className="small" role="status"><Icon name="spinner" small spin />{takingOff(name)}</span>}
          {slot.openPc && <OpenPlan open={slot.openPc} plan={r.plan} />}
          {r.undo !== "can" && r.undo !== "working" && <button type="button" className="btn btn-quiet btn-sm" onClick={() => c.hide(r.id)}>{HIDE}</button>}
        </div>
      </article>;
    })}
  </section>;
}

/**
 * Settings: the switch for the church in use (App shows it only while Planning Center is connected and is the church's
 * system). One sentence, the switch, then what a leader needs to know before turning it on, always in view: each change
 * needs their yes, unconfirmed with the request waiting, one person at a time, never on its own or from an AI, the kids
 * teams advice and where it applies, and the reminders caveat. How undo ends, which church it's for and People access
 * are under See how this works; People access stays in view while the sign-in doesn't include it.
 */
export function ChangesSwitch({ control, church, people }: { control: ChangesControl; church: string | null; people: boolean }) {
  const body = switchBody(church);
  const needPeople = <p className="small">{body.people} {NO_PEOPLE_YET}</p>;
  return <section className="find changes-switch" aria-labelledby="changes-title">
    <h3 id="changes-title" className="settings-t">{SWITCH_TITLE}</h3>
    {/* Said while it's off (onboarding spec §0.2, form B builds): nothing changes in Planning Center until it's turned on. */}
    {control.status && !control.on && <p className="find-body">{switchOff(church)}</p>}
    <p className="find-body">{body.lead}</p>
    <label className="confirmation"><input type="checkbox" checked={control.on} disabled={control.working || !control.status}
      onChange={e => control.set(e.target.checked)} /><span>{SWITCH_LABEL}</span></label>
    <ul className="list changes-facts">{[body.confirm, body.waiting, body.one, body.never, `${body.kids} ${body.kidsWhere}`, body.reminders]
      .map(line => <li key={line}><Icon name="dot" small /><span>{line}</span></li>)}</ul>
    {!people && needPeople}
    <details className="listen-more changes-more"><summary><Icon name="chev" small />See how this works</summary>
      <p className="small">{body.undo}</p>
      <p className="small">{body.church}</p>
      {people && <p className="small">{body.people}</p>}
    </details>
    {control.problem && <p role="alert" className="problem">{control.problem}</p>}
  </section>;
}

/**
 * What happened: each change confirmed for this church, newest first, with names put in from the checks on screen and each
 * service named by its service type when App knows it (`services`).
 */
export function ChangeHistory({ records, names, services = {} }: {
  records: ChangeRecord[] | null | undefined; names: Readonly<Record<string, string>>; services?: Readonly<Record<string, string>>;
}): ReactNode {
  return <section className="stack" aria-labelledby="changes-history-title">
    <h2 id="changes-history-title" className="h3">{HISTORY_TITLE}</h2>
    <p className="small">{HISTORY_WHO}</p>
    {records === null && <p className="small recent-quiet"><Icon name="info" small />Ozzie's list of changes isn't available right now.</p>}
    {records && !records.length && <p className="panel-sunken">{HISTORY_NONE}</p>}
    {records && records.length > 0 && <ol className="log changes-log">{records.map((r, i) => <li key={`${r.confirmed_at}-${i}`}
      className={r.came_back === "unknown" ? "is-problem" : ""}>
      <span className="log-t">{new Date(r.confirmed_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
      <span>{historyLine(r, Object.hasOwn(names, r.person) && names[r.person] ? names[r.person]! : "a person",
        Object.hasOwn(services, r.service_type) ? services[r.service_type] ?? null : null)}</span>
    </li>)}</ol>}
  </section>;
}
