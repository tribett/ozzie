// Ozzie's AI (onboarding spec S10; native contract N7, website W6): the explanation with the server's own price, one
// browser trip to sign in and pay, the wait (the same explain, wait, welcome-back pattern as Planning Center's), what
// happened, and the later states in Settings with how to stop paying. The price is never written here: it comes from
// the server's offer, and when the offer is closed there is nothing to buy. Escape never cancels a payment.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { useSystemWords } from "./church-system.js";
import { useDay } from "./day-words.js";
import { AI, CHOICE, OZZIE, ozzieState, paidSaid } from "./ai-words.js";
import { Ok, Problem, Quiet, Screen, Sheet, Status, useAiPlace } from "./ai-parts.js";
import { managedProblem, model, noPlan, offlineLine, resetDay, routeProblem, type ManagedAccount, type ModelStatus } from "./model.js";
import { paidEnd, planReason, reasonOf, type Offer, type PaidEnd } from "./onboarding-bridge.js";

/** The calm line after 55 minutes of the attempt's hour (native's PAID_CONNECT_LIFETIME_MS). */
export const STILL_THERE_MS = 55 * 60_000;
/** The attempt's hour (native's PAID_CONNECT_LIFETIME_MS): a wait followed past it has ended, heard here or not. */
export const PAID_WAIT_MS = 60 * 60_000;
/** After paying, the account is read every 5 seconds for 2 minutes, then every 30 seconds while this screen is open. */
export const POLL_MS = 5_000, POLL_FAST_FOR_MS = 120_000, POLL_SLOW_MS = 30_000;

/** After "Open {Day} (Ozzie keeps checking)": the account is read every 30 seconds for up to 30 minutes more. */
export const KEEP_CHECKING_MS = 30 * 60_000;

/**
 * The paid connect each bridge (one in the app) is waiting on, and when it started, kept past the screen that started it:
 * leaving the wait doesn't end it, so pressing Pay again follows that same wait, with its own ending, rather than asking
 * native for a second one, which native refuses as `busy` until the first ends, up to an hour (review M2).
 */
const waits = new WeakMap<object, { connect: Promise<unknown>; since: number }>();

/** An account as native sent it, read only when its numbers are numbers. */
export const accountOk = (v: unknown): v is ManagedAccount => {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a.plan === "string" && Number.isFinite(a.allowance_steps) && Number.isFinite(a.used_steps) && typeof a.period_ends === "string";
};

/**
 * This Mac still holds its connection to Ozzie's AI, whichever way is in use: native's status reads it on every route,
 * choosing another way never ends it (only Disconnect does), and the account isn't known to be without a plan. Then
 * Ozzie's AI is used again without a browser or a price (live, 2026-11-19: a subscriber who tried AI on this Mac was
 * shown "Pay $19 a month" on the way back).
 */
export const holdsOzzie = (s: ModelStatus | null): boolean => s?.managed === "connected" && !(accountOk(s.account) && noPlan(s.account));

/**
 * The person went on while a payment was being applied (review M4): Ozzie keeps reading the account after the screen has
 * closed, and says the plan is on (`onOn`, which has the app read its AI status again) as soon as it is. One at a time.
 */
let keptChecking: ReturnType<typeof setTimeout> | null = null;
function keepChecking(read: () => Promise<unknown>, onOn: () => void, until: number) {
  if (keptChecking) clearTimeout(keptChecking);
  const next = () => {
    keptChecking = setTimeout(() => {
      keptChecking = null;
      void read().catch(() => null).then(a => {
        if (accountOk(a) && !noPlan(a)) onOn();
        else if (Date.now() < until) next();
      });
    }, POLL_SLOW_MS);
  };
  next();
}

type Phase = "explain" | "waiting" | "received" | "on" | "ended";
/**
 * S10a–S10c. `reconnect`: this Mac's connection ended and the account may already have a plan, so the first screen
 * offers connecting again (the website charges nothing when the plan is already there) instead of the price. `held`
 * (`holdsOzzie`): this Mac still holds its connection, so the first screen offers using it again, which only saves the
 * route on this Mac; null while the AI status hasn't been read yet, when neither the price nor Pay is shown (review M3).
 * `heldAccount`: the account as that status read it, for a pause said before the press. `inUse`: it is the way in use.
 */
export function OzzieScreen({ offer, reconnect = false, held = false, heldAccount = null, inUse = false, onBack, onLater, onAnother, onModel, onDone, done }: {
  offer: Offer | null; reconnect?: boolean; held?: boolean | null; heldAccount?: unknown; inUse?: boolean; onBack: () => void; onLater: () => void;
  onAnother: () => void; onModel: (configured: boolean) => void; onDone: () => void; done: string;
}) {
  // The church's own system where AI help names Planning Center as where names come from; neutral before one is chosen.
  const say = useSystemWords().say;
  const { bridge, mode } = useAiPlace();
  const day = useDay();
  const [phase, setPhase] = useState<Phase>("explain");
  const [still, setStill] = useState(false);
  const [slow, setSlow] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [end, setEnd] = useState<PaidEnd | null>(null);
  const [problem, setProblem] = useState("");
  const [account, setAccount] = useState<ManagedAccount | null>(null);
  // On again through the connection this Mac held (`switchBack`), not after a payment: the account's own line is said.
  const [again, setAgain] = useState(false);
  // The connection (or its plan) turned out to have ended when Ozzie's AI was used again: the screens' own words for that.
  const [lost, setLost] = useState<"reconnect" | "plan" | null>(null);
  // "Use Ozzie's AI again" is reading the status and saving the route (each can wait on ozzie.church's account reading).
  const [switching, setSwitching] = useState(false);
  // Following a wait that was already running (the screen was left and opened again, or native said `busy`).
  const [resumed, setResumed] = useState(false);
  const attempt = useRef(0);
  // Following a wait native reported as `busy`, whose own ending can't be heard here (followBusy).
  const following = useRef(false);
  const live = useRef(true);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (f: () => void, ms: number) => { timers.current.push(setTimeout(f, ms)); };
  const clear = () => { for (const t of timers.current) clearTimeout(t); timers.current = []; };
  useEffect(() => { live.current = true; return () => { live.current = false; clear(); }; }, []);

  // Paid, but the website hasn't applied the plan yet: read the account until it has.
  const poll = (mine: number, since: number) => {
    later(async () => {
      const a = await bridge.accountNow().catch(() => null);
      if (!live.current || mine !== attempt.current) return;
      if (accountOk(a) && !noPlan(a)) { setAccount(a); setPhase("on"); return; }
      const fast = Date.now() - since < POLL_FAST_FOR_MS;
      if (!fast) setSlow(true);
      // Reading stops after 30 minutes, and the screen says so; Check again still reads once (re-check Low).
      if (Date.now() - since >= KEEP_CHECKING_MS) { setStopped(true); return; }
      poll(mine, since);
    }, Date.now() - since < POLL_FAST_FOR_MS ? POLL_MS : POLL_SLOW_MS);
  };
  // The plan is on: Ozzie's AI becomes the route, as choosing it means using it.
  const turnOn = async (mine: number, a: ManagedAccount) => {
    try { onModel((await model.setRoute("managed")).configured); } catch (error) { if (live.current) setProblem(routeProblem(error)); }
    if (!live.current || mine !== attempt.current) return;
    following.current = false; clear(); setAccount(a); setPhase("on");
  };
  // A followed wait that has ended without the plan on: its true ending, and no more reading.
  const ended = (end: PaidEnd) => { attempt.current++; following.current = false; clear(); setEnd(end); setPhase("ended"); };
  // A wait native is running that this page didn't start (`busy`): read the account until the plan is on there, as the
  // wait's own ending can't be heard here. Open the page again and Cancel act on that wait. Native's wait lasts at most its
  // hour from before `since`, so past that hour it has ended: Ozzie says so and stops reading (review 2026-11-18).
  const followBusy = (mine: number, since: number) => {
    later(async () => {
      const a = await bridge.accountNow().catch(() => null);
      if (!live.current || mine !== attempt.current) return;
      if (accountOk(a) && !noPlan(a)) { await turnOn(mine, a); return; }
      if (Date.now() - since >= PAID_WAIT_MS) { ended("not-finished"); return; }
      followBusy(mine, since);
    }, POLL_SLOW_MS);
  };
  const pay = async () => {
    const mine = ++attempt.current;
    following.current = false;
    clear(); setPhase("waiting"); setStill(false); setSlow(false); setStopped(false); setEnd(null); setProblem(""); setResumed(false); setAgain(false);
    const held = waits.get(bridge);
    const wait = held ?? { connect: bridge.payAndConnect(), since: Date.now() };
    if (held) setResumed(true);
    else {
      waits.set(bridge, wait);
      const forget = () => { if (waits.get(bridge) === wait) waits.delete(bridge); };
      wait.connect.then(forget, forget);
    }
    // "Still there?" 55 minutes into the wait itself, not into this screen.
    later(() => setStill(true), Math.max(0, STILL_THERE_MS - (Date.now() - wait.since)));
    let a: unknown;
    try { a = await wait.connect; } catch (error) {
      if (!live.current || mine !== attempt.current) return;
      const how = paidEnd(error);
      // Native is already waiting for the browser (a wait this page didn't start): that wait is shown, never an ending.
      // "Still there?" stays timed from the press, as the follow's hour is (review 2026-11-18).
      if (how === "busy") { following.current = true; setResumed(true); followBusy(mine, wait.since); return; }
      clear(); setEnd(how); setPhase("ended");
      return;
    }
    if (!live.current || mine !== attempt.current) return;
    clear();
    // Connected: Ozzie's AI becomes the route, as choosing it means using it.
    try { onModel((await model.setRoute("managed")).configured); } catch (error) { if (live.current) setProblem(routeProblem(error)); }
    if (!live.current || mine !== attempt.current) return;
    if (accountOk(a) && !noPlan(a)) { setAccount(a); setPhase("on"); return; }
    setPhase("received");
    poll(mine, Date.now());
  };
  // The connection this Mac holds: using Ozzie's AI again only saves the route on this Mac. No browser, no connect, nothing
  // bought. The status is read again first (the same reading each screen makes), and the route changes only while the
  // connection still holds, so a way that works is never swapped for one that doesn't (review M1). One that ended since
  // the screen opened is said as the screens say it (connect again, or the price for no plan), never as on, and the way in
  // use stays. The status the save returns is checked too, for the moment between.
  const switchBack = async () => {
    const mine = ++attempt.current;
    const mineNow = () => live.current && mine === attempt.current;
    const ended = (s: ModelStatus) => setLost(s.managed === "reconnect" || s.setup === "reconnect" ? "reconnect" : "plan");
    setProblem(""); setSwitching(true);
    try {
      let before: ModelStatus;
      try { before = await model.status(); } catch (error) { if (mineNow()) setProblem(routeProblem(error)); return; }
      if (!mineNow()) return;
      if (!holdsOzzie(before)) { ended(before); return; }
      let s: ModelStatus;
      try { s = await model.setRoute("managed"); } catch (error) { if (mineNow()) setProblem(routeProblem(error)); return; }
      onModel(s.configured);
      if (!mineNow()) return;
      if (s.configured && holdsOzzie(s)) { setAgain(true); setAccount(accountOk(s.account) ? s.account : null); setPhase("on"); return; }
      ended(s);
    } finally { if (mineNow()) setSwitching(false); }
  };
  const checkNow = async () => {
    const mine = attempt.current;
    const a = await bridge.accountNow().catch(() => null);
    if (live.current && mine === attempt.current && accountOk(a) && !noPlan(a)) { clear(); setAccount(a); setPhase("on"); }
  };
  // A closed tab: the waiting attempt's own page again (contract item 3), never a new connect while one waits. Only when
  // none waits ("no-attempt") does a new attempt start.
  const reopen = () => {
    setProblem("");
    const mine = attempt.current;
    bridge.reopenPay().catch(async (error: unknown) => {
      if (!live.current) return;
      if (reasonOf(error) !== "no-attempt") { setProblem(paidSaid("browser-unavailable")); return; }
      if (!following.current) { waits.delete(bridge); void pay(); return; }
      // The wait this page followed has ended, and how can't be heard here: on if the plan is, otherwise said. Never a new
      // payment the person didn't press for (review 2026-11-18).
      const a = await bridge.accountNow().catch(() => null);
      if (!live.current || mine !== attempt.current) return;
      if (accountOk(a) && !noPlan(a)) await turnOn(mine, a);
      else ended("expired");
    });
  };
  const cancel = () => {
    attempt.current++; following.current = false; clear(); waits.delete(bridge);
    void bridge.cancelPay().catch(() => undefined); setEnd("cancelled"); setPhase("ended");
  };
  // Native opens ozzie.church/terms itself (contract N5); the address to type is said only when the browser didn't open.
  const terms = () => { bridge.openHelpPage("ozzie-terms").catch(() => { if (live.current) setProblem(OZZIE.browserFailed("ozzie.church/terms")); }); };
  // Paid, the plan not on yet: go on now, and Ozzie keeps reading the account after this screen closes.
  const carryOn = () => {
    attempt.current++; clear();
    keepChecking(() => bridge.accountNow(), () => onModel(true), Date.now() + KEEP_CHECKING_MS);
    onDone();
  };

  if (phase === "waiting") return <Screen key="waiting" title={OZZIE.waitTitle}>
    <p className="ai-body">{OZZIE.waitLede}</p>
    <ol className="ai-steps">{OZZIE.waitSteps.map(s => <li key={s}><div><p>{s}</p></div></li>)}</ol>
    <Status text={still ? OZZIE.stillThere : resumed ? OZZIE.stillWaiting : ""} />
    {problem && <Problem text={problem} calm />}
    {/* Only for someone it happened to: folded, so the wait itself stays three short steps (first-run review, S10b). */}
    <details className="fr-fold"><summary><Icon name="chev" small />{OZZIE.waitHelpTitle}</summary><p>{OZZIE.waitHelp}</p></details>
    <div className="ai-actions">
      <button type="button" className="btn btn-secondary" onClick={reopen}>{OZZIE.openAgain}</button>
      <Quiet onClick={cancel}>{OZZIE.cancel}</Quiet>
    </div>
  </Screen>;
  if (phase === "received") return <Screen key="received" title={OZZIE.title}>
    <Status text={stopped ? OZZIE.receivedStopped : slow ? OZZIE.receivedSlow : OZZIE.received} />
    {problem && <Problem text={problem} />}
    <div className="ai-actions">
      {slow && <button type="button" className="btn btn-secondary" onClick={() => void checkNow()}>{OZZIE.checkAgain}</button>}
      <Quiet onClick={carryOn}>{OZZIE.carryOn(mode === "settings" ? done : `Open ${day.page}`)}</Quiet>
    </div>
  </Screen>;
  // On again through the held connection: the account's own line (answers left, near the end, paused), never the offer's
  // full month, which is only true just after paying.
  const accountLine = again && account ? ozzieState(account, planReason(account)) : null;
  if (phase === "on") return <Screen key="on" title={OZZIE.title}>
    <Ok lines={[again ? OZZIE.usingNow : OZZIE.on(offer?.open ? offer.answers_text : null, account ? resetDay(account) : null)]} />
    {/* A pause is said as S10d says it, calmly, never as part of the success (review L3). */}
    {again && (accountLine?.kind === "paused" ? <Problem text={accountLine.text} calm />
      : <p className="ai-body">{accountLine ? accountLine.text : OZZIE.notKnown}</p>)}
    {again && account?.offline && <p className="ai-small">{offlineLine(account)}</p>}
    {problem && <Problem text={problem} />}
    <div className="ai-actions"><button type="button" className="btn btn-primary ai-primary" onClick={onDone}>{done}</button></div>
  </Screen>;
  if (phase === "ended" && end) {
    const calm = end === "cancelled" || end === "payment-cancelled";
    // Every ending has a way on besides Try again (review M4).
    return <Screen key="ended" title={OZZIE.title}>
      <Problem text={paidSaid(end)} calm={calm} />
      <div className="ai-actions">
        <button type="button" className="btn btn-primary ai-primary" onClick={() => void pay()}>{OZZIE.tryAgain}</button>
        <button type="button" className="btn btn-secondary" onClick={onAnother}>{OZZIE.another}</button>
      </div>
    </Screen>;
  }
  const open = offer?.open && offer.price_text && offer.answers_text ? { price: offer.price_text, answers: offer.answers_text } : null;
  const reconnecting = reconnect || lost === "reconnect";
  const holding = held === true && !reconnecting && lost === null;
  // The AI status not read yet: neither the price nor Pay until it is, as a subscriber could be shown them (review M3).
  const checking = held === null && !reconnecting && lost === null;
  const priced = !reconnecting && !holding && !checking;
  // A held plan that is paused is said before the press, in S10d's words (review L3).
  const heldState = holding && accountOk(heldAccount) ? ozzieState(heldAccount, planReason(heldAccount)) : null;
  return <Screen key="explain" title={OZZIE.title}>
    {holding ? <p className="ai-body">{inUse ? OZZIE.held : `${OZZIE.held} ${OZZIE.heldFree}`}</p>
      : reconnecting ? <p className="ai-body">{OZZIE.reconnect}</p> : !checking && <p className="ai-body">{OZZIE.body}</p>}
    {heldState?.kind === "paused" && <Problem text={heldState.text} calm />}
    {checking && <Status text={CHOICE.ozzieLooking} />}
    {holding && <Status text={switching ? OZZIE.switching : ""} />}
    {priced && open && <>
      <div className="ai-price"><p className="ai-price-t">{OZZIE.plan(open.price)}</p><p className="ai-price-d">{OZZIE.answers(open.answers)}</p></div>
      <ul className="ai-checks">{OZZIE.checks.map(c => <li key={c}><Icon name="check" small /><span>{say(c)}</span></li>)}</ul>
      <div className="ai-head"><p className="ai-small">{OZZIE.small}</p><Quiet onClick={terms}>{OZZIE.terms}</Quiet></div>
    </>}
    {priced && !open && <p className="ai-body">{offer === null ? CHOICE.ozzieLooking : offer.reason === "unreachable" ? OZZIE.unreachable : OZZIE.closed}</p>}
    {problem && <Problem text={problem} calm />}
    <div className="ai-actions">
      {holding ? <button type="button" className="btn btn-primary ai-primary" disabled={switching} onClick={() => void switchBack()}>{inUse ? OZZIE.keepUsing : OZZIE.useAgain}</button>
        : checking ? null
        : reconnecting ? <button type="button" className="btn btn-primary ai-primary" onClick={() => void pay()}>{OZZIE.connectAgain}</button>
        : open && <button type="button" className="btn btn-primary ai-primary" onClick={() => void pay()}>{OZZIE.pay(open.price)}</button>}
      <Quiet onClick={onBack}>{AI.back}</Quiet>
      <Quiet onClick={onLater}>{AI.notNow}</Quiet>
    </div>
  </Screen>;
}

/**
 * S10d: Ozzie's AI in Settings when it is the route: answers left, near the end, paused, a payment that didn't go
 * through, ended, or no plan, each with its one button; and "Stop paying for Ozzie's AI", which says what cancelling
 * means before sending the person to the account page.
 */
export function OzzieAiState({ status, onStart, onReconnect, onAnother, onChanged }: {
  status: ModelStatus; onStart: () => void; onReconnect: () => void; onAnother: () => void; onChanged: (s: ModelStatus) => void;
}) {
  const { bridge } = useAiPlace();
  const [stopping, setStopping] = useState(false);
  const [problem, setProblem] = useState("");
  const openAccount = () => { setProblem(""); bridge.openHelpPage("ozzie-account").catch(() => setProblem(OZZIE.browserFailed("ozzie.church/account"))); };
  const disconnect = () => { setProblem(""); model.disconnect().then(onChanged, e => setProblem(managedProblem(e))); };
  const said = problem ? <Problem text={problem} /> : null;
  if (status.managed === "reconnect" || status.setup === "reconnect") return <div className="ai-now">
    <Problem text={OZZIE.reconnect}><button type="button" className="btn btn-primary" onClick={onReconnect}>{OZZIE.connectAgain}</button></Problem>{said}
  </div>;
  if (status.managed !== "connected") return <div className="ai-now">
    <Problem text={OZZIE.notConnected} calm><button type="button" className="btn btn-primary" onClick={onStart}>{OZZIE.start}</button></Problem>{said}
  </div>;
  const a = accountOk(status.account) ? status.account : null;
  const state = a ? ozzieState(a, planReason(a)) : null;
  const active = state && (state.kind === "on" || state.kind === "near" || state.kind === "paused");
  return <div className="ai-now">
    {!state && <p className="ai-body">{OZZIE.notKnown}</p>}
    {state && (state.kind === "on" || state.kind === "near") && <p className="ai-body" role="status">{state.text}</p>}
    {state?.kind === "paused" && <Problem text={state.text} calm><button type="button" className="btn btn-secondary" onClick={openAccount}>{OZZIE.seePlan}</button></Problem>}
    {state?.kind === "payment-failed" && <Problem text={state.text}><button type="button" className="btn btn-primary" onClick={openAccount}>{OZZIE.updateCard}</button></Problem>}
    {(state?.kind === "ended" || state?.kind === "no-plan") && <Problem text={state.text} calm>
      <button type="button" className="btn btn-primary" onClick={onStart}>{state.kind === "ended" ? OZZIE.startAgain : OZZIE.start}</button>
      <button type="button" className="btn btn-secondary" onClick={onAnother}>{OZZIE.another}</button>
    </Problem>}
    {a?.offline && <p className="ai-small">{offlineLine(a)}</p>}
    {said}
    <div className="ai-actions">
      {active && <Quiet onClick={() => setStopping(true)}>{OZZIE.stop}</Quiet>}
      <Quiet onClick={disconnect}>{OZZIE.disconnect}</Quiet>
    </div>
    {stopping && <Sheet title={OZZIE.stopTitle} onClose={() => setStopping(false)}>
      <p className="ai-body">{OZZIE.stopBody(a ? resetDay(a) : null)}</p>
      <div className="ai-actions">
        <button type="button" className="btn btn-primary ai-primary" onClick={() => setStopping(false)}>{OZZIE.stopKeep}</button>
        <button type="button" className="btn btn-secondary" onClick={() => { setStopping(false); openAccount(); }}>{OZZIE.stopYes}</button>
      </div>
    </Sheet>}
  </div>;
}
