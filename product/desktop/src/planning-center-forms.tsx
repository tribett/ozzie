// The Planning Center sign-in and "which Sunday" fields, shared by Settings and guided setup so both
// use the same connection calls and say connected only after Planning Center confirmed the organization.
import { useEffect, useId, useState } from "react";
import {
  attemptCopy, churchLabel, churchShort, connection, connectionProblem, connectionStatusProblem, declinedCopy, leftBehindActions, leftBehindCopy,
  missingCopy, parseDeclined, parseInUse, parseLastAttempt, parseSwitchQuestion, parseUnretired, signInInstead, switchCopy, switchProblem,
  switchSettings, type ConnectionStatus, type RulesAtStake,
  type SwitchDecision, type SwitchQuestion, type Unretired,
} from "./connection.js";
import { loadRules, type Settings } from "./sunday-source.js";
import { loadRulesByChurch, rulesAtStake } from "./church-in-use.js";
import { Icon } from "./icons.js";

const numeric = (v: string) => /^[1-9]\d{0,31}$/.test(v);
const at = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const stateCopy: Record<Exclude<ConnectionStatus["state"], "connected">, string> = {
  disconnected: "Planning Center is disconnected.", waiting: "Finish signing in in your browser. This attempt lasts five minutes.",
  checking: "Checking the organization with Planning Center…",
  "stored-unchecked": "A connection is saved on this Mac but hasn't been checked yet. Check it before use.", cancelled: "Sign-in was cancelled on this Mac.",
  expired: "Sign-in expired. Start a new connection.", failed: "The connection couldn't be checked, so it isn't connected.",
};

/** Picks the service type and plan numbers out of a pasted Planning Center Services address. */
export function planFromAddress(text: string): { serviceTypeId?: string; planId?: string } {
  const s = typeof text === "string" ? text.slice(0, 2048) : "";
  const type = /service_types\/([1-9]\d{0,31})(?!\d)/.exec(s)?.[1];
  const plan = /plans\/([1-9]\d{0,31})(?!\d)/.exec(s)?.[1];
  return { ...(type ? { serviceTypeId: type } : {}), ...(plan ? { planId: plan } : {}) };
}

/**
 * Connection controls shared by the sign-in form and the Settings opt-in, so both use one confirmation and one busy state.
 * `oneClick` (tests) overrides asking the app whether Ozzie's own registration is built in.
 */
export function useConnectionControl(settings: Settings, onStatus: (s: ConnectionStatus) => void, status: ConnectionStatus | null, oneClick?: boolean) {
  const [registered, setRegistered] = useState(Boolean(settings.clientId));
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<{ text: string; from: "sign-in" | "operations" } | null>(null);
  const [builtIn, setBuiltIn] = useState(oneClick ?? false);
  useEffect(() => {
    if (oneClick !== undefined) return;
    let alive = true;
    void connection.appAvailable().then(available => { if (alive) setBuiltIn(available); });
    return () => { alive = false; };
  }, [oneClick]);
  const pending = status?.state === "waiting" || status?.state === "checking";
  /** "Switch Ozzie to this church?" is open: signing in, typing other IDs and disconnecting wait for the answer. */
  const asking = parseSwitchQuestion(status?.switch) !== undefined;
  /** Your own registration's IDs, typed under Advanced. Otherwise Ozzie's own registration. */
  const ownIds = settings.clientId.trim().length > 0;
  const ready = registered && ownIds && numeric(settings.organization);
  /** Whether a sign-in can start now, with whichever registration is in use. */
  const canSignIn = (ownIds ? ready : builtIn) && !asking;
  const canCheck = numeric(settings.organization) && (ownIds ? registered : builtIn);
  const signIn = (operations = false) => ownIds
    ? connection.connect(settings.clientId, settings.organization, registered, operations)
    : connection.connectApp(operations);
  const checkSaved = () => connection.refresh(ownIds ? settings.clientId : "", settings.organization, ownIds ? registered : true);
  const run = async (operation: () => Promise<ConnectionStatus | void>, from: "sign-in" | "operations" = "sign-in") => {
    setWorking(true); setProblem(null);
    try { const result = await operation(); if (result) onStatus(result); }
    catch (error) { setProblem({ text: connectionProblem(error), from }); }
    finally { setWorking(false); }
  };
  return { registered, setRegistered, working, problem, pending, asking, ready, builtIn, ownIds, canSignIn, canCheck, signIn, checkSaved, run };
}
export type ConnectionControl = ReturnType<typeof useConnectionControl>;

/** Your own Planning Center registration: the two IDs and the return-address confirmation. */
function OwnRegistration({ settings, onSettings, control, connected }: {
  settings: Settings; onSettings: (s: Settings) => void; control: ConnectionControl; connected: boolean;
}) {
  const id = useId();
  const { registered, setRegistered, working, pending, asking, ready, builtIn, run } = control;
  const locked = working || pending || asking;
  const set = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => onSettings({ ...settings, [k]: e.target.value.trim() });
  return <>
    <div className="field-two">
      <div className="field">
        <label htmlFor={`${id}-client`}>Public application ID</label>
        <input id={`${id}-client`} value={settings.clientId} onChange={set("clientId")} autoComplete="off" spellCheck={false} disabled={locked} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-org`}>Organization ID</label>
        <input id={`${id}-org`} value={settings.organization} onChange={set("organization")} inputMode="numeric" autoComplete="off" spellCheck={false} disabled={locked} />
      </div>
    </div>
    <p className="small">Return address registered in Planning Center: <code>http://127.0.0.1:42819/oauth/callback</code></p>
    <label className="confirmation"><input type="checkbox" checked={registered} onChange={e => setRegistered(e.target.checked)} disabled={locked} /><span>This Public registration uses that exact return address.</span></label>
    <div className="row form-actions">
      <button className={`btn ${connected || builtIn ? "btn-secondary" : "btn-primary"}`} disabled={!ready || locked}
        onClick={() => { void run(() => connection.connect(settings.clientId, settings.organization, registered)); }}>{builtIn ? "Connect with these IDs" : "Connect Planning Center"}</button>
    </div>
    {/* Says why Connect is off, rather than leaving a grey button to guess at. */}
    {!ready && !connected && !pending && <p className="input-help">To connect, enter both IDs and tick the box confirming the return address.</p>}
  </>;
}

/**
 * Sign in to Planning Center. With Ozzie's own registration built in, one button: sign in, choose Allow, and
 * Planning Center names the organization. Typing your own registration's IDs is folded under Advanced.
 * `firstRun` only changes how a missing connection reads ("Not connected yet.").
 * Buttons carry no `type`: this is not a form, and nothing here submits.
 */
export function ConnectForm({ status, settings, onSettings, control, firstRun = false, stake }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; control: ConnectionControl; firstRun?: boolean;
  /** Tests only: the Church rules at stake in a switch, instead of reading this Mac's. */
  stake?: RulesAtStake;
}) {
  const { working, pending, asking, builtIn, ownIds, canCheck, registered, run } = control;
  const problem = control.problem?.from === "sign-in" ? control.problem.text : "";
  const connected = status?.state === "connected";
  const saved = Boolean(status && status.state !== "disconnected" && !pending);
  const question = parseSwitchQuestion(status?.switch);
  const unretired = parseUnretired(status?.unretired);
  const [answerProblem, setAnswerProblem] = useState("");
  const [answered, setAnswered] = useState<{ decision: SwitchDecision; question: SwitchQuestion; stake: RulesAtStake } | null>(null);
  const atStake = question ? stake ?? rulesAtStake(question, loadRules(), loadRulesByChurch()) : null;
  // A cancelled or expired sign-in already says so in the state line; only a failure adds a problem. One made while a
  // church was in use ends with that church back in use, and native code keeps how it ended (`last_attempt`): it is said
  // in the same two places, with the church Ozzie still uses (review S4, M1).
  const inUseNow = parseInUse(status?.in_use);
  const attempt = parseLastAttempt(status?.last_attempt);
  const attemptLine = attempt && inUseNow ? attemptCopy(attempt, inUseNow) : "";
  const shownProblem = attemptLine && attempt?.state === "failed" ? attemptLine
    : status?.state === "failed" && status.organization_diagnostic !== undefined ? connectionStatusProblem(status)
    : problem || (status?.state === "failed" && status.problem ? connectionStatusProblem(status) : "");
  const state = attemptLine && attempt?.state !== "failed" ? attemptLine
    : !status || status.state === "disconnected" ? firstRun ? "Not connected yet." : stateCopy.disconnected
    : status.state === "connected" ? "" : stateCopy[status.state];
  // The answer names the question it answers and comes back with the church Ozzie now uses, which Settings then show.
  // If it changed nothing, the page says why in words about that church, and reads native state again (review S, L5).
  // Native code records the church in use before it signs anything out, so a quit mid-answer needs nothing kept here.
  // "Sign in to X instead" closes the question, then starts an ordinary sign-in with the registration in use (the IDs
  // under Advanced, else one click). Settings keep the church in use: they take X only once that sign-in has connected
  // and the person switched (review S3, M1 and L3).
  const answer = (decision: SwitchDecision) => {
    if (!question || !atStake) return;
    const asked = question, stakeNow = atStake;
    setAnswerProblem("");
    void run(async () => {
      try {
        const done = await connection.answerSwitch(decision, asked.id);
        onSettings(switchSettings(settings, done));
        setAnswered({ decision, question: asked, stake: stakeNow });
        if (decision === "sign-in") {
          const start = signInInstead(settings, asked.to, registered, builtIn);
          if (start === "one-click") return await connection.connectApp();
          if (start) return await connection.connect(start.clientId, start.organization, start.registered);
        }
        return done.status;
      } catch (error) {
        setAnswerProblem(switchProblem(error, asked));
        return connection.status().then(current => current ?? undefined).catch(() => undefined);
      }
    });
  };
  // Settings named a church Ozzie doesn't use without a new sign-in; it kept the one it uses, and says so. A sign-in
  // it found for that church is asked about in the question instead.
  const declined = parseDeclined(status?.declined);
  const inUse = connected && status ? { organization: status.organization, name: status.organization_name } : null;
  const declinedLine = declined && inUse && declined !== inUse.organization && question?.to !== declined ? declinedCopy(declined, inUse) : "";
  const missing = parseDeclined(status?.missing);
  const missingLine = missing && inUse && missing !== inUse.organization ? missingCopy(missing, inUse) : "";
  const leftTo = (organization: string) => Boolean(unretired?.left.some(l => l.organization === organization));
  return <div className="form connect-form">
    {question && atStake && <SwitchQuestionPanel question={question} stake={atStake} working={working} onAnswer={answer} />}
    {answerProblem && question && <p role="alert" className="problem">{answerProblem}</p>}
    {answered && !question && <p className="panel-ok" role="status"><Icon name="check" small /><span>{answeredCopy(answered, leftTo(answered.question.to))}</span></p>}
    {declinedLine && <p className="panel-info" role="status">{declinedLine}</p>}
    {missingLine && <p className="panel-info" role="status">{missingLine}</p>}
    {unretired && <StillSignedIn unretired={unretired} working={working} asking={asking}
      onRetry={() => { void run(() => connection.retrySignOut()); }} onRemove={() => { void run(() => connection.removeRefused()); }} />}
    {builtIn
      ? <>
        <p className="find-body">Sign in to Planning Center in your browser and choose Allow. Ozzie finds your church's organization itself; there's nothing to copy or paste.</p>
        <div className="row form-actions">
          <button className={`btn ${connected || asking ? "btn-secondary" : "btn-primary"}`} disabled={working || pending || asking}
            onClick={() => { void run(() => connection.connectApp()); }}>{connected ? "Sign in again" : "Connect Planning Center"}</button>
          {saved && <button className="btn btn-secondary" disabled={!canCheck || working} onClick={() => { void run(control.checkSaved); }}>Check saved connection</button>}
          {/* While the question is open a check of the church still in use may run; it isn't a sign-in to cancel. */}
          {pending && !asking && <button className="btn btn-quiet" onClick={() => { void run(() => connection.cancel()); }}>Cancel sign-in</button>}
        </div>
      </>
      : <>
        <OwnRegistration settings={settings} onSettings={onSettings} control={control} connected={connected} />
        {(saved || pending) && <div className="row form-actions">
          {saved && <button className="btn btn-secondary" disabled={!canCheck || working} onClick={() => { void run(control.checkSaved); }}>Check saved connection</button>}
          {pending && !asking && <button className="btn btn-quiet" onClick={() => { void run(() => connection.cancel()); }}>Cancel sign-in</button>}
        </div>}
      </>}
    {connected
      ? <p className="panel-ok" role="status"><Icon name="check" small /><span>Connected. Planning Center confirmed {churchLabel(status.organization, status.organization_name)}{status.checked_at_ms != null ? ` at ${at(status.checked_at_ms)}` : ""}.</span></p>
      : <p aria-live="polite">{state}</p>}
    {shownProblem && <p role="alert" className="problem">{shownProblem}</p>}
    {saved && !asking && <div><button className="btn btn-quiet btn-sm btn-flush" disabled={working} onClick={() => { void run(() => connection.disconnect()); }}>Disconnect and revoke access</button></div>}
    {builtIn && <details className="listen-more" open={ownIds || undefined}>
      <summary><Icon name="chev" small />Advanced: use your own Planning Center registration</summary>
      <p className="small">For a copy of Ozzie you built yourself, or a church that registered its own Public application in Planning Center. Leave the application ID empty to use Ozzie's.</p>
      <OwnRegistration settings={settings} onSettings={onSettings} control={control} connected={connected} />
    </details>}
  </div>;
}

/** What an answer did, said once it's done. `leftTo`: Ozzie couldn't sign out of the other sign-in yet (said separately). */
export function answeredCopy(answered: { decision: SwitchDecision; question: SwitchQuestion; stake: RulesAtStake }, leftTo: boolean): string {
  const { to, to_name, from, from_name } = answered.question;
  const toShort = churchShort(to, to_name, from_name), fromShort = churchShort(from, from_name, to_name);
  if (answered.decision === "stay") {
    return `Ozzie still uses ${churchLabel(from, from_name)}.${leftTo ? "" : ` Planning Center no longer accepts the sign-in for ${toShort}, and it's removed from this Mac.`}`;
  }
  if (answered.decision === "sign-in") {
    return `Ozzie still uses ${churchLabel(from, from_name)}. Sign in to ${toShort}; once you have, Ozzie asks before it stops using ${fromShort}.`;
  }
  const rules = answered.stake.from ? ` Church rules for ${fromShort}'s teams and rooms are kept for that church.${answered.stake.to ? ` The ones you set for ${toShort} before are back.` : ` You can set ${toShort}'s in Church rules.`}`
    : answered.stake.to ? ` The Church rules you set for ${toShort} before are back.` : "";
  return `Ozzie now uses ${churchLabel(to, to_name)}. Choose which of its Sundays to check below.${rules}`;
}

/**
 * "Switch Ozzie to this church?", asked after a sign-in Planning Center bound to another church (or about one saved on
 * this Mac from before). Nothing has been signed out yet; each button says which church Ozzie keeps, and the lines above
 * them say what each one signs Ozzie out of and what happens to recordings, Church rules and automatic checks.
 */
export function SwitchQuestionPanel({ question, stake, working, onAnswer }: {
  question: SwitchQuestion; stake: RulesAtStake; working: boolean; onAnswer: (decision: SwitchDecision) => void;
}) {
  const copy = switchCopy(question, stake);
  return <div className="decide switch-church" role="group" aria-labelledby="switch-church-q">
    <p id="switch-church-q" className="bold">{copy.title}</p>
    <p className="find-body">{copy.lead}</p>
    <ul className="small">{copy.effects.map(line => <li key={line}>{line}</li>)}</ul>
    <div className="find-next">
      {copy.actions.map((action, i) => <button key={action.decision} type="button" className={`btn ${i === 0 ? "btn-primary" : "btn-secondary"} btn-sm`}
        disabled={working} onClick={() => onAnswer(action.decision)}>{action.label}</button>)}
    </div>
  </div>;
}

/**
 * Sign-ins the person chose to leave that Ozzie couldn't sign out of yet: each with its own reason, a retry for what may
 * still work, and, for what Planning Center refused, removing it from this Mac on the person's click. While a question
 * is open the buttons wait (native code refuses them too): an answer may be about one of these very sign-ins.
 */
export function StillSignedIn({ unretired, working, asking = false, onRetry, onRemove }: {
  unretired: Unretired; working: boolean; asking?: boolean; onRetry: () => void; onRemove: () => void;
}) {
  const actions = leftBehindActions(unretired);
  return <div className="decide">
    <div role="alert" className="left-behind">{unretired.left.map(entry => <p key={entry.organization} className="find-body">{leftBehindCopy(entry)}</p>)}</div>
    {asking
      ? <p className="small">Answer the question above first; then you can try again here.</p>
      : <div className="find-next">
        {actions.retryLabel && <button type="button" className="btn btn-secondary btn-sm" disabled={working} onClick={onRetry}>{actions.retryLabel}</button>}
        {actions.removeLabel && <button type="button" className="btn btn-secondary btn-sm" disabled={working} onClick={onRemove}>{actions.removeLabel}</button>}
      </div>}
  </div>;
}

/** On other pages while the question is open: which church Ozzie still uses, and where to answer. */
export function SwitchWaiting({ question, onOpen }: { question: SwitchQuestion; onOpen: () => void }) {
  return <div className="col">
    <div className="banner switch-waiting" role="status">
      <Icon name="question" small />
      <span>Ozzie is still using {churchLabel(question.from, question.from_name)}. A sign-in for {churchLabel(question.to, question.to_name)} is waiting for you to choose which church Ozzie uses.</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onOpen}>Choose in Settings</button>
    </div>
  </div>;
}

/** Which Sunday to check: paste the plan's address, or type its two numbers. */
export function SundayPlanFields({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const id = useId();
  const [address, setAddress] = useState("");
  const found = planFromAddress(address);
  const set = (k: "serviceTypeId" | "planId") => (e: React.ChangeEvent<HTMLInputElement>) => onSettings({ ...settings, [k]: e.target.value.trim() });
  return <div className="form">
    <div className="field">
      <label htmlFor={`${id}-address`}>Paste the plan's address (optional)</label>
      <input id={`${id}-address`} value={address} placeholder="https://services.planningcenteronline.com/…" autoComplete="off" spellCheck={false}
        onChange={e => {
          const text = e.target.value;
          setAddress(text);
          const picked = planFromAddress(text);
          if (picked.serviceTypeId || picked.planId) onSettings({ ...settings, ...picked });
        }} />
      {address && <p className="input-help" role="status">{found.serviceTypeId && found.planId ? "Found both numbers below. Check they're the Sunday you meant."
        : found.planId ? "Found the plan number. Type the service type number below." : found.serviceTypeId ? "Found the service type number. Type the plan number below."
          : "That address doesn't show the numbers. Type them below instead."}</p>}
    </div>
    <div className="field-two">
      <div className="field">
        <label htmlFor={`${id}-st`}>Service type ID</label>
        <input id={`${id}-st`} value={settings.serviceTypeId} onChange={set("serviceTypeId")} inputMode="numeric" autoComplete="off" />
      </div>
      <div className="field">
        <label htmlFor={`${id}-plan`}>Plan ID</label>
        <input id={`${id}-plan`} value={settings.planId} onChange={set("planId")} inputMode="numeric" autoComplete="off" />
      </div>
    </div>
    <p className="input-help">The numbers come from the plan's address in Planning Center Services: …/service_types/<b>service type</b>/plans/<b>plan</b></p>
  </div>;
}
