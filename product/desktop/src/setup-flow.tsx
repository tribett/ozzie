// Guided first-run setup: one calm step at a time, always skippable, reopened from Settings.
// It uses the same sign-in form, Sunday fields and AI help settings as the Settings page,
// and says Planning Center is connected only after Planning Center confirmed the organization.
import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "./connection.js";
import type { Settings } from "./sunday-source.js";
import type { ProactivePrefs } from "./proactive.js";
import { AiSettings } from "./ai-settings.js";
import { ConnectForm, useConnectionControl } from "./planning-center-forms.js";
import { SundayPicker } from "./sunday-picker.js";
import { quietLine, scheduleLine } from "./proactive-page.js";
import { Icon } from "./icons.js";
import { autostart as macAutostart, type Autostart } from "./background.js";
import { AutostartToggle } from "./responsibility-views.js";
export { planFromAddress } from "./planning-center-forms.js";

const SETUP = "ozzie.setup.v1";
/** Only whether setup was finished or skipped is remembered on this Mac; never anything about the church. */
export const setupMemory = {
  closed: (): boolean => { try { return localStorage.getItem(SETUP) === "closed"; } catch { return false; } },
  close: () => { try { localStorage.setItem(SETUP, "closed"); } catch { /* per-device convenience only */ } },
};

export const STEPS = ["about", "connect", "sunday", "wording", "automatic"] as const;
export type Step = typeof STEPS[number];
const TITLES: Record<Step, string> = {
  about: "What Ozzie does, and what it never does", connect: "Connect Planning Center", sunday: "Choose the Sunday to check",
  wording: "AI help (optional)", automatic: "Automatic checks and quiet hours",
};
const numeric = (v: string) => /^[1-9]\d{0,31}$/.test(v);
export function SetupFlow({ status, settings, onSettings, onStatus, prefs, onModel, onClose, onExample, onAutomatic, initial = "about", autostart = macAutostart }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
  prefs: ProactivePrefs; onModel: (configured: boolean) => void;
  /** Skip for now, or finished. Either way setup isn't shown again on its own; Settings can reopen it. */
  onClose: () => void; onExample: () => void; onAutomatic: () => void; initial?: Step;
  /** "Open Ozzie when I log in" on this Mac. */
  autostart?: Autostart;
}) {
  const [step, setStep] = useState<Step>(initial);
  const index = STEPS.indexOf(step);
  // Moving to another step puts keyboard and VoiceOver focus on its title, not back at the top of the window.
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  useEffect(() => { if (shown.current !== step) { shown.current = step; title.current?.focus(); } }, [step]);
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!);
  const back = () => setStep(STEPS[Math.max(index - 1, 0)]!);
  const connected = status?.state === "connected";
  const chosen = numeric(settings.serviceTypeId) && numeric(settings.planId);
  return <div className="col setup">
    <div className="setup-head">
      <p className="eyebrow">Setting up Ozzie · step {index + 1} of {STEPS.length}</p>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>Skip for now</button>
    </div>
    {/* A check mark means done, not just passed: connecting and choosing the Sunday can be left for later. */}
    <ol className="setup-steps" aria-label="Setup steps">{STEPS.map((s, i) => {
      const done = i < index && (s === "connect" ? connected : s === "sunday" ? chosen : true);
      return <li key={s} aria-current={s === step ? "step" : undefined} className={done ? "is-done" : ""}>
        <span className="setup-dot">{done ? <Icon name="check" small /> : i + 1}</span><span>{TITLES[s]}{done && <span className="sr-only">, done</span>}</span></li>;
    })}</ol>
    <h1 id="setup-title" className="h1" tabIndex={-1} ref={title}>{TITLES[step]}</h1>

    {step === "about" && <>
      <p className="lede">Ozzie prepares Sunday for you: it reads your church's Planning Center, shows what needs a decision, and drafts notes for you to send yourself.</p>
      <ul className="list setup-promises">
        <li><Icon name="lock" small /><span><strong>Reads only.</strong> Ozzie never changes anything in Planning Center.</span></li>
        <li><Icon name="x" small /><span><strong>Never sends.</strong> Drafts are yours to read, change and send from your own email or phone.</span></li>
        <li><Icon name="user" small /><span><strong>Names Ozzie reads stay on this Mac.</strong> If you turn on AI help, the AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center.</span></li>
        <li><Icon name="check" small /><span><strong>People decide.</strong> Ozzie never scores or ranks anyone; it shows facts, where they came from and when it checked.</span></li>
      </ul>
      <p className="small">Want to look around first? The fictional example church works without any connection.</p>
      <div className="find-next">
        <button type="button" className="btn btn-primary" onClick={next}>Next: connect Planning Center</button>
        <button type="button" className="btn btn-secondary" onClick={onExample}>See the fictional example</button>
      </div>
    </>}

    {step === "connect" && <ConnectStep status={status} settings={settings} onSettings={onSettings} onStatus={onStatus} />}

    {step === "sunday" && <SundayStep settings={settings} onSettings={onSettings} connected={connected} />}

    {step === "wording" && <>
      <p className="lede">Optional. Ozzie writes every draft itself on this Mac. AI help can reword a draft when you ask, and answers your questions in Ask Ozzie. The AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center, and nothing is ever sent.</p>
      {/* Ozzie managed shows as coming soon here until this Mac is connected; Settings has the connect button. */}
      <AiSettings onChange={onModel} labelledBy="setup-title" preview />
    </>}

    {step === "automatic" && <>
      <p className="lede">Ozzie checks the chosen Sunday on a schedule and tells you privately when something gets worse. When you close its window, it keeps running in the menu bar.</p>
      <div className="sp">
        <div className="sp-row sp-2"><span className="sp-h">Checks</span><span>{scheduleLine(prefs)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Quiet hours</span><span>{quietLine(prefs)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Notices</span><span>“Sunday coverage needs attention. Open Ozzie to see details.” Never names or details.</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Status</span><span>{connected && chosen ? "Ready to run." : !connected ? "Waits until Planning Center is connected." : "Waits until you choose the Sunday."}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">More</span><span>Ask Ozzie to keep an eye on something, like “Keep an eye on Sunday” or “Watch room bookings every week”. It shows you a plan before anything starts.</span></div>
      </div>
      <AutostartToggle autostart={autostart} />
      {/* This ends setup too, so it says so; "Finish setup" below goes to Today. */}
      <div className="find-next"><button type="button" className="btn btn-secondary" onClick={onAutomatic}>Finish and open What runs automatically</button></div>
    </>}

    {/* The first step has its own buttons above, so no empty bar under them. */}
    {index > 0 && <div className="setup-nav">
      <button type="button" className="btn btn-quiet" onClick={back}>Back</button>
      <span className="spacer" />
      {step === "connect" && <button type="button" className={`btn ${connected ? "btn-primary" : "btn-secondary"}`} onClick={next}>{connected ? "Next: choose the Sunday" : "Next — I'll connect later"}</button>}
      {step === "sunday" && <button type="button" className={`btn ${chosen ? "btn-primary" : "btn-secondary"}`} onClick={next}>{chosen ? "Next: AI help" : "Next — I'll choose later"}</button>}
      {step === "wording" && <button type="button" className="btn btn-primary" onClick={next}>Next: automatic checks</button>}
      {step === "automatic" && <button type="button" className="btn btn-primary" onClick={onClose}>Finish setup</button>}
    </div>}
  </div>;
}

function ConnectStep({ status, settings, onSettings, onStatus }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
}) {
  const control = useConnectionControl(settings, onStatus, status);
  return <>
    <p className="lede">You'll sign in to Planning Center in your browser. The connection is kept in this Mac's Keychain.</p>
    <div className="two setup-two">
      <div className="panel-sunken"><p className="bold">What Ozzie will read</p>
        <p className="small">For the Sunday you choose: the plan and its service times, open roles, who is scheduled and whether they've accepted, each team's members and leaders, and those people's blockouts and other schedules around that Sunday.</p>
        <p className="small">Background checks, only if you ask for them: when you mark kids teams and turn on the background-check rule in Church rules, and your connection includes People, Ozzie reads whether each person scheduled on those teams has a current cleared background check, never its details. That stays on this Mac and never goes to an AI.</p></div>
      <div className="panel-sunken"><p className="bold">What it can't do</p>
        <p className="small">Change anything in Planning Center or send messages. Planning Center may show a broader permission at sign-in; Ozzie still only reads.</p></div>
    </div>
    <section className="find" aria-labelledby="setup-connect-title">
      <h2 id="setup-connect-title" className="settings-t">Sign in</h2>
      <ConnectForm status={status} settings={settings} onSettings={onSettings} control={control} firstRun />
    </section>
  </>;
}

function SundayStep({ settings, onSettings, connected }: { settings: Settings; onSettings: (s: Settings) => void; connected: boolean }) {
  return <>
    <p className="lede">Ozzie checks one Sunday plan at a time. Choose it from your upcoming plans; you can change it any time under Settings.</p>
    <section className="find" aria-labelledby="setup-sunday-title">
      <h2 id="setup-sunday-title" className="settings-t">The Sunday plan</h2>
      <SundayPicker connected={connected} settings={settings} onSettings={onSettings} />
    </section>
  </>;
}
