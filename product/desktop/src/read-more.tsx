// "What else Ozzie can check" (onboarding decision 24, spec §4.4): after the first check of a church whose Planning
// Center connection reads Services only, one calm, optional offer of the checks that need more of Planning Center: room
// overlaps (Calendar), follow-ups with no one assigned (People), the kids-team background-check rule (People) and group
// meetings at the same time as serving (Groups). On the service's page as a card, and on Today as the last item of
// "Finish setting up". Never during first run (decision 1: setup is done at the first result), never a finding, and
// nothing in it says a problem was found: it says what Ozzie hasn't read.
//
// Planning Center gives Calendar, People and Groups together in one consent, so there is one button. It is the same
// sign-in as Settings' "Also check rooms, follow-ups and group events" (operations-reads.ts `askForOperations`), and the
// switch goes on only once Planning Center granted the access. A connection that already holds the access (People allowed
// for a note's To line) needs no sign-in: the button only turns the switch on.
//
// Dismissing: "Not now" folds the card to one line here and the item on Today (the Finish list's own "Not now", key
// ozzie.finish-list.v1); "Don't show this again" removes both for good (ozzie.read-more.v1). Settings keeps the switch
// either way. Nothing here nags (NEVER-LIST 10): no count, no notice, and it never comes back by itself.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { useDay, type DayWords } from "./day-words.js";
import { dayName } from "./day-phrases.js";
import { promise } from "./promises.js";
import { connection, granted, onSignInStart, operationsGranted, type ConnectionStatus } from "./connection.js";
import { CopyForAdministrator, useConnectionControl } from "./planning-center-forms.js";
import { askForOperations, useOperationsReads } from "./operations-reads.js";
import { PEOPLE_CHECKING, PEOPLE_ENDS, PEOPLE_TO_READ, PEOPLE_WAITING, peopleOutcome } from "./people-question.js";
import { finishMemory, type FinishStore, type KeyValue } from "./moments.js";
import type { Settings } from "./sunday-source.js";
import type { SundayRead } from "../../../core/src/sunday-capture.js";
import "./finish.css";

/** What the offer needs: a new sign-in for Calendar, People and Groups, or only the switch (the access is held). */
export type ReadMoreNeed = "sign-in" | "switch";

/**
 * Whether to offer, and what: only after a check of the church's own service (`checked`), with a connection checked this
 * session (its access known), not hidden. Services only: a sign-in. The access held with the reads off: the switch.
 */
export function readMoreNeed({ status, readsOn, checked, hidden }: {
  status: ConnectionStatus | null; readsOn: boolean | null; checked: boolean; hidden: boolean;
}): ReadMoreNeed | null {
  if (!checked || hidden || status?.state !== "connected") return null;
  const access = granted(status);
  if (!access) return null;
  if (!access.operations) return "sign-in";
  return readsOn === false ? "switch" : null;
}

/** The product a refused read belongs to, for the reads this offer turns on. */
export type Product = "Calendar" | "People" | "Groups";
const PRODUCTS: readonly [Product, RegExp][] = [["Calendar", /^calendar_/u], ["People", /^people_workflow/u], ["Groups", /^groups_/u]];
/**
 * The products Planning Center refused (native "denied") in a check's rooms, follow-ups and group reads. The kids rule's
 * background-check read says its own refusals (kids-rules.ts).
 */
export function refusedProducts(reads: readonly Pick<SundayRead, "collection" | "outcome">[]): Product[] {
  return PRODUCTS.filter(([, re]) => reads.some(r => r.outcome === "denied" && re.test(r.collection))).map(([p]) => p);
}
const and = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

// ---- Words ---------------------------------------------------------------------------------------------------------

export const moreTitle = (church?: string | null) => `What else Ozzie can check for ${church || "your church"}`;
/** The Finish list's item (finish-list.tsx) says the same in its own title. */
// Never "reads only Services": a church may have allowed Check-Ins or Registrations on their own.
export const MORE_LEAD = "Right now Ozzie doesn't read Calendar, People or Groups in your church's Planning Center. With them, it could also:";
/** One line per check: what it does, then the part of Planning Center it needs. Facts only, never "there may be…". */
export const moreLines = (need: ReadMoreNeed, d: DayWords): string[] => [
  `Check the rooms booked for ${dayName(d)} for times that overlap: needs Planning Center Calendar.`,
  "Find follow-ups that are past due with no one assigned: needs Planning Center People.",
  // With the access held, background checks are read already (they need People only, not the switch).
  ...(need === "sign-in" ? ["Check that each person scheduled on a team you mark as serving with kids has a current background check on file: needs Planning Center People."] : []),
  "Notice when someone scheduled to serve has a group meeting at the same time: needs Planning Center Groups.",
];
export const moreAccess = () => "Planning Center gives Calendar, People and Groups together, in one sign-in in your browser, and words them as read-and-write. "
  + `${promise("connectAnd")} ${promise("names")}`;
/**
 * People's other read, said where it is first allowed (review P, L8; contact.rs reads it and never addresses a child), in
 * the To sheet's own sentences, so the two places say the same thing (review L8, 2026-11-18).
 */
export const MORE_PEOPLE_TO = `With People, Ozzie also fills in To on a note. ${PEOPLE_TO_READ}`;
export const moreHeld = () => `Your connection already includes Calendar, People and Groups, so this needs no new sign-in. ${promise("connectAnd")}`;
export const MORE_BUTTON = "Let Ozzie read more in Planning Center";
export const MORE_NOT_NOW = "Not now";
export const MORE_HIDE = "Don't show this again";
export const MORE_HIDDEN = "Ozzie won't offer this again. You can turn it on any time in Settings, under Rooms, follow-ups and group events.";
export const MORE_CHECK = "Check Planning Center now";

/** How a press ended. `granted`/`on`: the reads start at the next check. The others changed nothing. */
export type ReadMoreEnd = "granted" | "on" | "not-granted" | "cancelled" | "denied" | "expired" | "failed" | "switch-failed";
export const moreNext = (d: DayWords) => `Ozzie reads rooms, follow-ups and group meetings from its next check of ${dayName(d)}.`;
export function moreEnd(end: ReadMoreEnd, d: DayWords): string {
  switch (end) {
    case "granted": return `Planning Center added Calendar, People and Groups. ${moreNext(d)}`;
    case "on": return moreNext(d);
    case "not-granted": return "Planning Center didn't add Calendar, People and Groups this time, so nothing changed. "
      + "If the account you signed in with can't use them, a Planning Center administrator at your church can give it access.";
    case "cancelled": return "Nothing changed.";
    case "denied": case "expired": case "failed": return PEOPLE_ENDS[end];
    case "switch-failed": return "Ozzie couldn't turn this on just now. Nothing changed. Try again in a moment.";
  }
}
/** A check's refusal, after the access was granted: what Planning Center refused and who can give it. */
export const moreRefused = (products: readonly Product[]) => `Planning Center didn't let Ozzie read ${and(products)} at the last check. `
  + `The account you signed in with may not have access to ${products.length === 1 ? "it" : "them"} there. A Planning Center administrator at your church can give it access.`;
/**
 * "Copy a message for your administrator" for these products (planning-center-forms.tsx `CopyForAdministrator`): what
 * Ozzie is, that it only reads, and what the account can't see. No name, church, service or number; no permission path
 * Ozzie hasn't read in Planning Center's own help (Services' is in sunday-source.ts `adminMessage`).
 */
export const productsAdminMessage = (products: readonly Product[]) => "Hi! I'd like to use Ozzie, an app on my Mac that reads our church's Planning Center "
  + `to show me who's scheduled and what still needs people. ${promise("request")} Planning Center doesn't let my account see ${and(products)} yet. `
  + `Could you give my account access to ${products.length === 1 ? "it" : "them"} in Planning Center? Thank you!`;
const ALL: readonly Product[] = ["Calendar", "People", "Groups"];

// ---- "Don't show this again" ------------------------------------------------------------------------------------------

export const READ_MORE_KEY = "ozzie.read-more.v1";
export interface ReadMoreStore { hidden(): boolean; hide(): void }
const thisMacStorage = (): KeyValue | null => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
/** Only `{ "hidden": true }` is kept, on this Mac: nothing about the church or what was read. */
export function readMoreStore(storage: () => KeyValue | null = thisMacStorage): ReadMoreStore {
  return {
    hidden: () => { try { return (JSON.parse(storage()?.getItem(READ_MORE_KEY) ?? "null") as { hidden?: unknown } | null)?.hidden === true; } catch { return false; } },
    hide: () => { try { storage()?.setItem(READ_MORE_KEY, JSON.stringify({ hidden: true })); } catch { /* a per-device convenience only */ } },
  };
}
export const readMoreMemory: ReadMoreStore = readMoreStore();

// ---- The offer -------------------------------------------------------------------------------------------------------

/**
 * `place` "service": the card on the service's page, with its own title, "Not now" and "Don't show this again", and after
 * a press its outcome (the page keeps it mounted while a check is on screen). `place` "today": the body of the Finish
 * list's item, whose title and "Not now" are the list's own.
 */
export function ReadMore({ need, place, status, settings, onStatus, church, reads = [], onCheck, oneClick, store = readMoreMemory, finish = finishMemory }: {
  need: ReadMoreNeed | null; place: "service" | "today";
  status: ConnectionStatus | null; settings: Settings; onStatus: (s: ConnectionStatus) => void;
  /** The church's name as Planning Center gave it, for the card's title. */
  church?: string | null | undefined;
  /** The check on screen's reads: a product Planning Center refused there is said, with a message for the administrator. */
  reads?: readonly Pick<SundayRead, "collection" | "outcome">[] | undefined;
  /** "Check Planning Center now" after the access was allowed (the page's own check). */
  onCheck?: (() => void) | undefined;
  /** Tests only: whether Ozzie's own registration is built in, instead of asking the app. */
  oneClick?: boolean | undefined;
  store?: ReadMoreStore | undefined; finish?: FinishStore | undefined;
}) {
  const d = useDay();
  const id = useId();
  const control = useConnectionControl(settings, onStatus, status, oneClick);
  const switchState = useOperationsReads(status, { read: false });
  // This card's own sign-in, until Planning Center answers: started, then in the browser.
  const [watch, setWatch] = useState<"asked" | "waiting" | null>(null);
  const [end, setEnd] = useState<ReadMoreEnd | null>(null);
  const [switching, setSwitching] = useState(false);
  const [hidden, setHidden] = useState(() => store.hidden());
  const [justHidden, setJustHidden] = useState(false);
  const [later, setLater] = useState(() => finish.get().notNow.includes("more"));
  const [opened, setOpened] = useState(false);
  const pending = status?.state === "waiting" || status?.state === "checking";
  // Any other sign-in (a note's To line, Sign in again) replaces this card's own in native: its grant is never this card's
  // to say (review 2026-11-18), so the card stops watching as it starts.
  useEffect(() => onSignInStart(purpose => { if (purpose !== "operations") setWatch(null); }), []);
  // Opened again while a sign-in for this access is in the browser (the page was left meanwhile, or Settings started it):
  // this card says how it ends too, unless it was hidden for good.
  useEffect(() => { if (!watch && !hidden && pending && switchState.asking) setWatch("waiting"); }, [watch, hidden, pending, switchState.asking]);
  useEffect(() => {
    if (!watch) return;
    if (pending) { if (watch !== "waiting") setWatch("waiting"); return; }
    if (operationsGranted(status)) { setWatch(null); setEnd("granted"); return; }
    // A status from before the browser opened says nothing yet.
    if (watch === "asked") return;
    setWatch(null);
    const why = peopleOutcome(status);
    setEnd(why === null ? "granted" : why === undefined || why === "browser" ? "failed" : why);
  }, [watch, pending, status?.state, status?.scopes, status?.problem, status?.revision]);

  // A sign-in for this access is in the browser: this card's own, or one Settings started.
  const mine = watch !== null;
  const waiting = pending && (mine || switchState.asking);
  const allow = () => {
    setEnd(null);
    if (need === "switch") {
      setSwitching(true);
      void switchState.switchReads(true).then(v => setEnd(v ? "on" : "switch-failed"), () => setEnd("switch-failed")).finally(() => setSwitching(false));
      return;
    }
    setWatch("asked");
    void askForOperations(control, status).then(started => { if (!started) setWatch(null); });
  };
  const cancel = () => { void control.run(() => connection.cancel()); };
  const notNow = () => { finish.notNow("more"); setLater(true); setOpened(false); };
  const hide = () => { store.hide(); setHidden(true); setJustHidden(true); };

  if (justHidden) return <p className="small read-more-hidden" role="status">{MORE_HIDDEN}</p>;
  // Hidden for good: nothing here again, whatever Settings does (only this card's own sign-in, if any, is said).
  if (hidden && !mine) return null;
  const problem = control.problem?.from === "operations" && !waiting ? control.problem.text : "";
  const wrap = (children: ReactNode) => place === "today" ? <div className="read-more-body">{children}</div>
    : <section className="find read-more" aria-labelledby={`${id}-t`}>
      <div className="find-top"><span className="badge b-muted"><Icon name="link" small />Optional</span><span className="find-where">Planning Center</span></div>
      <h2 id={`${id}-t`} className="find-title">{moreTitle(church)}</h2>
      {children}
    </section>;

  if (!waiting && need === null) {
    if (end === "granted" || end === "on") return wrap(<>
      <p className="panel-ok" role="status"><Icon name="check" small /><span>{moreEnd(end, d)}</span></p>
      {onCheck && <div className="finish-acts"><button type="button" className="btn btn-secondary btn-sm" onClick={onCheck}>{MORE_CHECK}</button></div>}
    </>);
    const refused = place === "service" ? refusedProducts(reads) : [];
    if (refused.length) return wrap(<>
      <p className="find-body">{moreRefused(refused)}</p>
      <CopyForAdministrator message={productsAdminMessage(refused)} />
      <div className="finish-acts"><button type="button" className="btn btn-quiet btn-sm" onClick={hide}>{MORE_HIDE}</button></div>
    </>);
    return null;
  }
  if (!waiting && place === "service" && later && !opened) {
    return <p className="read-more-later"><button type="button" className="finish-line-btn" aria-expanded={false} onClick={() => setOpened(true)}>
      <span>{moreTitle(church)}</span><Icon name="chev" small /></button></p>;
  }
  const shown = need ?? "sign-in";
  const failed = end !== null && end !== "granted" && end !== "on";
  return wrap(<>
    {shown === "sign-in" && <p className="find-body">{MORE_LEAD}</p>}
    <ul className="list read-more-lines">{moreLines(shown, d).map(l => <li key={l}><Icon name="dot" small />{l}</li>)}</ul>
    <p className="small">{shown === "sign-in" ? moreAccess() : moreHeld()}</p>
    {shown === "sign-in" && <p className="small">{MORE_PEOPLE_TO}</p>}
    <p className="people-wait" aria-live="polite">{waiting && <><Icon name="spinner" small spin />{status?.state === "checking" ? PEOPLE_CHECKING : PEOPLE_WAITING}</>}</p>
    {failed && !waiting && <p role={end === "cancelled" ? undefined : "alert"} className={end === "cancelled" ? "small" : "problem"}>{moreEnd(end, d)}</p>}
    {end === "not-granted" && !waiting && <CopyForAdministrator message={productsAdminMessage(ALL)} />}
    {problem && <p role="alert" className="problem">{problem}</p>}
    <div className="finish-acts">
      {waiting
        ? <button type="button" className="btn btn-quiet" onClick={cancel}>Cancel</button>
        : <>
          <button type="button" className={`btn ${place === "today" ? "btn-primary" : "btn-secondary"}`}
            disabled={shown === "switch" ? switching : !control.canSignIn || control.working || control.pending} onClick={allow}>{MORE_BUTTON}</button>
          {place === "service" && <button type="button" className="btn btn-quiet" onClick={notNow}>{MORE_NOT_NOW}</button>}
          {place === "service" && <button type="button" className="btn btn-quiet btn-sm" onClick={hide}>{MORE_HIDE}</button>}
        </>}
    </div>
  </>);
}
