// Ozzie's AI (onboarding spec S10; native contract N7, website W6): the explanation with the server's own price, one
// browser trip to sign in and pay, the wait (the same explain, wait, welcome-back pattern as Planning Center's), what
// happened, and the later states in Settings with how to stop paying. The price is never written here: it comes from
// the server's offer, and when the offer is closed there is nothing to buy. Escape never cancels a payment.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons.js";
import { useDay } from "./day-words.js";
import { AI, CHOICE, OZZIE, ozzieState, paidSaid } from "./ai-words.js";
import { Ok, Problem, Quiet, Screen, Sheet, Status, useAiPlace } from "./ai-parts.js";
import { managedProblem, model, noPlan, offlineLine, resetDay, routeProblem, type ManagedAccount, type ModelStatus } from "./model.js";
import { paidEnd, planReason, reasonOf, type Offer, type PaidEnd } from "./onboarding-bridge.js";

/** The calm line after 25 minutes of the attempt's 30 (native's PAID_CONNECT_LIFETIME_MS). */
export const STILL_THERE_MS = 25 * 60_000;
/** After paying, the account is read every 5 seconds for 2 minutes, then every 30 seconds while this screen is open. */
export const POLL_MS = 5_000, POLL_FAST_FOR_MS = 120_000, POLL_SLOW_MS = 30_000;

/** After "Open {Day} (Ozzie keeps checking)": the account is read every 30 seconds for up to 30 minutes more. */
export const KEEP_CHECKING_MS = 30 * 60_000;

/** An account as native sent it, read only when its numbers are numbers. */
const accountOk = (v: unknown): v is ManagedAccount => {
  if (v === null || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return typeof a.plan === "string" && Number.isFinite(a.allowance_steps) && Number.isFinite(a.used_steps) && typeof a.period_ends === "string";
};

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
 * offers connecting again (the website charges nothing when the plan is already there) instead of the price.
 */
export function OzzieScreen({ offer, reconnect = false, onBack, onLater, onAnother, onModel, onDone, done }: {
  offer: Offer | null; reconnect?: boolean; onBack: () => void; onLater: () => void; onAnother: () => void;
  onModel: (configured: boolean) => void; onDone: () => void; done: string;
}) {
  const { bridge, mode } = useAiPlace();
  const day = useDay();
  const [phase, setPhase] = useState<Phase>("explain");
  const [still, setStill] = useState(false);
  const [slow, setSlow] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [end, setEnd] = useState<PaidEnd | null>(null);
  const [problem, setProblem] = useState("");
  const [account, setAccount] = useState<ManagedAccount | null>(null);
  const attempt = useRef(0);
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
  const pay = async () => {
    const mine = ++attempt.current;
    clear(); setPhase("waiting"); setStill(false); setSlow(false); setStopped(false); setEnd(null); setProblem("");
    later(() => setStill(true), STILL_THERE_MS);
    let a: unknown;
    try { a = await bridge.payAndConnect(); } catch (error) {
      if (!live.current || mine !== attempt.current) return;
      clear(); setEnd(paidEnd(error)); setPhase("ended");
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
  const checkNow = async () => {
    const mine = attempt.current;
    const a = await bridge.accountNow().catch(() => null);
    if (live.current && mine === attempt.current && accountOk(a) && !noPlan(a)) { clear(); setAccount(a); setPhase("on"); }
  };
  // A closed tab: the waiting attempt's own page again (contract item 3), never a new connect while one waits. Only when
  // none waits ("no-attempt") does a new attempt start.
  const reopen = () => {
    setProblem("");
    bridge.reopenPay().catch((error: unknown) => {
      if (!live.current) return;
      if (reasonOf(error) === "no-attempt") void pay();
      else setProblem(paidSaid("browser-unavailable"));
    });
  };
  const cancel = () => { attempt.current++; clear(); void bridge.cancelPay().catch(() => undefined); setEnd("cancelled"); setPhase("ended"); };
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
    <Status text={still ? OZZIE.stillThere : ""} />
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
  if (phase === "on") return <Screen key="on" title={OZZIE.title}>
    <Ok lines={[OZZIE.on(offer?.open ? offer.answers_text : null, account ? resetDay(account) : null)]} />
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
  return <Screen key="explain" title={OZZIE.title}>
    {reconnect ? <p className="ai-body">{OZZIE.reconnect}</p> : <p className="ai-body">{OZZIE.body}</p>}
    {!reconnect && open && <>
      <div className="ai-price"><p className="ai-price-t">{OZZIE.plan(open.price)}</p><p className="ai-price-d">{OZZIE.answers(open.answers)}</p></div>
      <ul className="ai-checks">{OZZIE.checks.map(c => <li key={c}><Icon name="check" small /><span>{c}</span></li>)}</ul>
      <div className="ai-head"><p className="ai-small">{OZZIE.small}</p><Quiet onClick={terms}>{OZZIE.terms}</Quiet></div>
    </>}
    {!reconnect && !open && <p className="ai-body">{offer === null ? CHOICE.ozzieLooking : offer.reason === "unreachable" ? OZZIE.unreachable : OZZIE.closed}</p>}
    {problem && <Problem text={problem} calm />}
    <div className="ai-actions">
      {reconnect ? <button type="button" className="btn btn-primary ai-primary" onClick={() => void pay()}>{OZZIE.connectAgain}</button>
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
