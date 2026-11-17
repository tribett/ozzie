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
import { YourNameField } from "./connection-page.js";
export { planFromAddress } from "./planning-center-forms.js";

const SETUP = "ozzie.setup.v1";
/** Only whether setup was finished or skipped is remembered on this Mac; never anything about the church. */
export const setupMemory = {
  closed: (): boolean => { try { return localStorage.getItem(SETUP) === "closed"; } catch { return false; } },
  close: () => { try { localStorage.setItem(SETUP, "closed"); } catch { /* per-device convenience only */ } },
};
const START_ASKED = "ozzie.start-with-mac-asked.v1";
/**
 * Whether "Start Ozzie when you turn on this Mac?" has been answered on this Mac (audit item 23), in setup or on Today.
 * Only that it was answered: the answer itself is the Mac's own login item.
 */
export const startMemory = {
  asked: (): boolean => { try { return localStorage.getItem(START_ASKED) === "1"; } catch { return false; } },
  answer: () => { try { localStorage.setItem(START_ASKED, "1"); } catch { /* per-device convenience only */ } },
};
export const START_QUESTION = "Start Ozzie when you turn on this Mac?";
export const START_WHY = "Ozzie can only check Planning Center while it is running.";
export const START_FAILED = "This Mac didn't let Ozzie change that setting. You can try again under Settings.";

export const STEPS = ["about", "connect", "sunday", "wording", "automatic"] as const;
export type Step = typeof STEPS[number];
const TITLES: Record<Step, string> = {
  about: "What Ozzie does, and what it never does", connect: "Connect Planning Center", sunday: "Choose the Sunday to check",
  wording: "AI help (optional)", automatic: "Automatic checks and quiet hours",
};
const numeric = (v: string) => /^[1-9]\d{0,31}$/.test(v);
export function SetupFlow({ status, settings, onSettings, onStatus, prefs, onModel, onClose, onExample, onAutomatic, initial = "about", autostart = macAutostart, nameStore,
  startStore = startMemory, cards = 0, onDiscardCards }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
  prefs: ProactivePrefs; onModel: (configured: boolean) => void;
  /** Skip for now, or finished. Either way setup isn't shown again on its own; Settings can reopen it. */
  onClose: () => void; onExample: () => void; onAutomatic: () => void; initial?: Step;
  /** "Open Ozzie when I log in" on this Mac. */
  autostart?: Autostart;
  /** Tests only: where "Your name for notes" is kept, instead of this Mac's storage. */
  nameStore?: { get(): string; set(name: string): void };
  /** Tests only: where answering "Start Ozzie when you turn on this Mac?" is remembered. */
  startStore?: { asked(): boolean; answer(): void };
  /** Visitor cards open (a count only): switching churches says first that it discards them. */
  cards?: number;
  /** Disconnect was chosen with cards open: App ends them. */
  onDiscardCards?: (() => void) | undefined;
}) {
  // "Start Ozzie when you turn on this Mac?", Yes chosen to begin with (owner decision 2026-11-16); applied only when the
  // leader finishes setup, by their own click. Setup reopened after it was answered starts from what this Mac is set to
  // now, so Finish never turns it back on unasked (review P, L5); until the Mac says (or if it can't), neither is chosen
  // and Finish leaves the setting as it is.
  const [startWithMac, setStartWithMac] = useState<boolean | null>(() => startStore.asked() ? null : true);
  useEffect(() => {
    if (!startStore.asked()) return;
    let alive = true;
    autostart.get().then(on => { if (alive) setStartWithMac(now => now ?? on); }, () => undefined);
    return () => { alive = false; };
  }, [autostart, startStore]);
  // Remembered as answered only once the Mac took it; if it didn't, Today asks again later.
  const finish = (then: () => void) => {
    if (startWithMac === null) { then(); return; }
    void autostart.set(startWithMac).then(() => { startStore.answer(); then(); }, then);
  };
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
        <li><Icon name="x" small /><span><strong>Never sends.</strong> Drafts are yours to read, change and send from your own email or phone. A note for one person can open in this Mac's email app or Messages already addressed to them, when Planning Center has one usable email address or mobile number for them, or marks one as primary.</span></li>
        <li><Icon name="user" small /><span><strong>Names Ozzie reads stay on this Mac.</strong> If you turn on AI help, the AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center.</span></li>
        <li><Icon name="check" small /><span><strong>People decide.</strong> Ozzie never scores or ranks anyone; it shows facts, where they came from and when it checked.</span></li>
      </ul>
      {/* Asked once, here (audit item 18): the name notes are signed with. Optional; Settings has it too. */}
      <div className="find setup-name"><YourNameField optional {...(nameStore ? { store: nameStore } : {})} /></div>
      <p className="small">Want to look around first? The fictional example church works without any connection.</p>
      <div className="find-next">
        <button type="button" className="btn btn-primary" onClick={next}>Next: connect Planning Center</button>
        <button type="button" className="btn btn-secondary" onClick={onExample}>See the fictional example</button>
      </div>
    </>}

    {step === "connect" && <ConnectStep status={status} settings={settings} onSettings={onSettings} onStatus={onStatus} cards={cards} onDiscardCards={onDiscardCards} />}

    {step === "sunday" && <SundayStep settings={settings} onSettings={onSettings} connected={connected} />}

    {step === "wording" && <>
      <p className="lede">Optional. Ozzie writes every draft itself on this Mac. AI help can reword a draft when you ask, answers your questions in Ask Ozzie, looks at who could help with a role when you ask from a Sunday card, and writes a short summary of what a job you set up found, as often as its plan allows. The AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center, and nothing is ever sent.</p>
      {/* Ozzie managed shows as coming soon here until this Mac is connected; Settings has the connect button. */}
      <AiSettings onChange={onModel} labelledBy="setup-title" preview />
    </>}

    {step === "automatic" && <>
      <p className="lede">The regular Sunday check looks at the chosen Sunday on a schedule and tells you privately when something gets worse. When you close Ozzie's window, it keeps running in the menu bar.</p>
      <div className="sp">
        <div className="sp-row sp-2"><span className="sp-h">The regular Sunday check</span><span>{scheduleLine(prefs)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Quiet hours</span><span>{quietLine(prefs)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Notices</span><span>“Sunday coverage needs attention. Open Ozzie to see details.” Never names or details.</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Status</span><span>{connected && chosen ? "Ready to run." : !connected ? "Waits until Planning Center is connected." : "Waits until you choose the Sunday."}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Keep Sunday covered and other jobs</span><span>Start one in What runs automatically, or ask Ozzie, like “Keep an eye on Sunday” or “Watch room bookings every week”. It shows you a plan before anything starts.</span></div>
      </div>
      <fieldset className="find start-with-mac">
        <legend className="bold">{START_QUESTION}</legend>
        <p className="small">{START_WHY} When this Mac restarts, Ozzie then opens quietly in the menu bar.</p>
        <label className="confirmation"><input type="radio" name="start-with-mac" checked={startWithMac === true} onChange={() => setStartWithMac(true)} />
          <span>Yes, start Ozzie with this Mac (recommended)</span></label>
        <label className="confirmation"><input type="radio" name="start-with-mac" checked={startWithMac === false} onChange={() => setStartWithMac(false)} />
          <span>No, I'll open it myself</span></label>
      </fieldset>
      {/* This ends setup too, so it says so; "Finish setup" below goes to Today. Both apply the answer above. */}
      <div className="find-next"><button type="button" className="btn btn-secondary" onClick={() => finish(onAutomatic)}>Finish and open What runs automatically</button></div>
    </>}

    {/* The first step has its own buttons above, so no empty bar under them. */}
    {index > 0 && <div className="setup-nav">
      <button type="button" className="btn btn-quiet" onClick={back}>Back</button>
      <span className="spacer" />
      {step === "connect" && <button type="button" className={`btn ${connected ? "btn-primary" : "btn-secondary"}`} onClick={next}>{connected ? "Next: choose the Sunday" : "Next — I'll connect later"}</button>}
      {step === "sunday" && <button type="button" className={`btn ${chosen ? "btn-primary" : "btn-secondary"}`} onClick={next}>{chosen ? "Next: AI help" : "Next — I'll choose later"}</button>}
      {step === "wording" && <button type="button" className="btn btn-primary" onClick={next}>Next: automatic checks</button>}
      {step === "automatic" && <button type="button" className="btn btn-primary" onClick={() => finish(onClose)}>Finish setup</button>}
    </div>}
  </div>;
}

function ConnectStep({ status, settings, onSettings, onStatus, cards, onDiscardCards }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void; cards: number;
  onDiscardCards?: (() => void) | undefined;
}) {
  const control = useConnectionControl(settings, onStatus, status);
  return <>
    <p className="lede">You'll sign in to Planning Center in your browser. The connection is kept in this Mac's Keychain.</p>
    <div className="two setup-two">
      <div className="panel-sunken"><p className="bold">What Ozzie will read</p>
        <p className="small">For the Sunday you choose: the plan and its service times, open roles, who is scheduled and whether they've accepted, each team's members and leaders, and those people's blockouts and other schedules around that Sunday.</p>
        <p className="small">Background checks, only if you ask for them: when you mark kids teams and turn on the background-check rule in Church rules, and your connection includes People, Ozzie reads whether each person scheduled on those teams has a current cleared background check, never its details. That stays on this Mac and never goes to an AI.</p>
        <p className="small">Email addresses or phone numbers, only when you open a note for one person in Mail or Messages and your connection includes People: that person's, and whether Planning Center lists them as a child. One is used to fill in To. They're kept nowhere and never go to an AI.</p></div>
      <div className="panel-sunken"><p className="bold">What it can't do</p>
        <p className="small">Change anything in Planning Center or send messages. Planning Center may show a broader permission at sign-in; Ozzie still only reads.</p></div>
    </div>
    <section className="find" aria-labelledby="setup-connect-title">
      <h2 id="setup-connect-title" className="settings-t">Sign in</h2>
      <ConnectForm status={status} settings={settings} onSettings={onSettings} control={control} firstRun cards={cards} onDiscardCards={onDiscardCards} />
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
