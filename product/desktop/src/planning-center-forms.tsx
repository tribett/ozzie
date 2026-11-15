// The Planning Center sign-in and "which Sunday" fields, shared by Settings and guided setup so both
// use the same connection calls and say connected only after Planning Center confirmed the organization.
import { useEffect, useId, useState } from "react";
import { connection, connectionProblem, connectionStatusProblem, type ConnectionStatus } from "./connection.js";
import type { Settings } from "./sunday-source.js";
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
  /** Your own registration's IDs, typed under Advanced. Otherwise Ozzie's own registration. */
  const ownIds = settings.clientId.trim().length > 0;
  const ready = registered && ownIds && numeric(settings.organization);
  /** Whether a sign-in can start now, with whichever registration is in use. */
  const canSignIn = ownIds ? ready : builtIn;
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
  return { registered, setRegistered, working, problem, pending, ready, builtIn, ownIds, canSignIn, canCheck, signIn, checkSaved, run };
}
export type ConnectionControl = ReturnType<typeof useConnectionControl>;

/** Your own Planning Center registration: the two IDs and the return-address confirmation. */
function OwnRegistration({ settings, onSettings, control, connected }: {
  settings: Settings; onSettings: (s: Settings) => void; control: ConnectionControl; connected: boolean;
}) {
  const id = useId();
  const { registered, setRegistered, working, pending, ready, builtIn, run } = control;
  const set = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => onSettings({ ...settings, [k]: e.target.value.trim() });
  return <>
    <div className="field-two">
      <div className="field">
        <label htmlFor={`${id}-client`}>Public application ID</label>
        <input id={`${id}-client`} value={settings.clientId} onChange={set("clientId")} autoComplete="off" spellCheck={false} disabled={working || pending} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-org`}>Organization ID</label>
        <input id={`${id}-org`} value={settings.organization} onChange={set("organization")} inputMode="numeric" autoComplete="off" spellCheck={false} disabled={working || pending} />
      </div>
    </div>
    <p className="small">Return address registered in Planning Center: <code>http://127.0.0.1:42819/oauth/callback</code></p>
    <label className="confirmation"><input type="checkbox" checked={registered} onChange={e => setRegistered(e.target.checked)} disabled={working || pending} /><span>This Public registration uses that exact return address.</span></label>
    <div className="row form-actions">
      <button className={`btn ${connected || builtIn ? "btn-secondary" : "btn-primary"}`} disabled={!ready || working || pending}
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
export function ConnectForm({ status, settings, onSettings, control, firstRun = false }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; control: ConnectionControl; firstRun?: boolean;
}) {
  const { working, pending, builtIn, ownIds, canCheck, run } = control;
  const problem = control.problem?.from === "sign-in" ? control.problem.text : "";
  const connected = status?.state === "connected";
  const saved = Boolean(status && status.state !== "disconnected" && !pending);
  // A cancelled or expired sign-in already says so in the state line; only a failure adds a problem.
  const shownProblem = status?.state === "failed" && status.organization_diagnostic !== undefined ? connectionStatusProblem(status)
    : problem || (status?.state === "failed" && status.problem ? connectionStatusProblem(status) : "");
  const state = !status || status.state === "disconnected" ? firstRun ? "Not connected yet." : stateCopy.disconnected
    : status.state === "connected" ? "" : stateCopy[status.state];
  return <div className="form connect-form">
    {builtIn
      ? <>
        <p className="find-body">Sign in to Planning Center in your browser and choose Allow. Ozzie finds your church's organization itself; there's nothing to copy or paste.</p>
        <div className="row form-actions">
          <button className={`btn ${connected ? "btn-secondary" : "btn-primary"}`} disabled={working || pending}
            onClick={() => { void run(() => connection.connectApp()); }}>{connected ? "Sign in again" : "Connect Planning Center"}</button>
          {saved && <button className="btn btn-secondary" disabled={!canCheck || working} onClick={() => { void run(control.checkSaved); }}>Check saved connection</button>}
          {pending && <button className="btn btn-quiet" onClick={() => { void run(() => connection.cancel()); }}>Cancel sign-in</button>}
        </div>
      </>
      : <>
        <OwnRegistration settings={settings} onSettings={onSettings} control={control} connected={connected} />
        {(saved || pending) && <div className="row form-actions">
          {saved && <button className="btn btn-secondary" disabled={!canCheck || working} onClick={() => { void run(control.checkSaved); }}>Check saved connection</button>}
          {pending && <button className="btn btn-quiet" onClick={() => { void run(() => connection.cancel()); }}>Cancel sign-in</button>}
        </div>}
      </>}
    {connected
      ? <p className="panel-ok" role="status"><Icon name="check" small /><span>Connected. Planning Center confirmed organization {status.organization}{status.checked_at_ms != null ? ` at ${at(status.checked_at_ms)}` : ""}.</span></p>
      : <p aria-live="polite">{state}</p>}
    {shownProblem && <p role="alert" className="problem">{shownProblem}</p>}
    {saved && <div><button className="btn btn-quiet btn-sm btn-flush" disabled={working} onClick={() => { void run(() => connection.disconnect()); }}>Disconnect and revoke access</button></div>}
    {builtIn && <details className="listen-more" open={ownIds || undefined}>
      <summary><Icon name="chev" small />Advanced: use your own Planning Center registration</summary>
      <p className="small">For a copy of Ozzie you built yourself, or a church that registered its own Public application in Planning Center. Leave the application ID empty to use Ozzie's.</p>
      <OwnRegistration settings={settings} onSettings={onSettings} control={control} connected={connected} />
    </details>}
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
