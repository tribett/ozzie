import { OtherAiAppsSetup } from "./other-ai-apps-setup.js";
import { useState } from "react";
import { yourName, YOUR_NAME_MAX, type ConnectionStatus } from "./connection.js";
import type { Settings } from "./sunday-source.js";
import type { ProactivePrefs } from "./proactive.js";
import { AiSettings } from "./ai-settings.js";
import { ConnectForm, useConnectionControl } from "./planning-center-forms.js";
import { SundayPicker } from "./sunday-picker.js";
import { quietLine, scheduleLine } from "./proactive-page.js";
import { Icon } from "./icons.js";
import type { Autostart } from "./background.js";
import { AutostartToggle } from "./responsibility-views.js";

/** The access the saved connection was granted, known only once it's been checked this session. */
export function grantedCopy(status: ConnectionStatus | null): string {
  if (status?.scopes === "services-and-operations") return "Granted: Services, Calendar, People and Groups. Ozzie reads rooms, follow-ups and group events.";
  if (status?.scopes === "services") return "Granted: Services only. Rooms, follow-ups and group events aren't checked.";
  return "What's granted shows here once the connection has been checked.";
}

export const SHARE_BODY = "An AI app on this Mac, such as Claude, can use the same facts from Ozzie's last check that Ask Ozzie uses. People, roles and rooms are shown to it as labels like [Person 1]; their names stay here.";
export const SHARE_HOW = [
  "While this is on, Ozzie keeps one copy of its last check on this Mac, with every name replaced by a label. Ozzie checks it again for names before saving it.",
  "An AI app set up to use it can read that copy and a list of what Ozzie ran and how it ended. It can't check Planning Center, change anything or send anything.",
  "What that app keeps or does with what it reads is up to that app and its privacy terms, not Ozzie.",
  "Turning this on shows the setup text for an AI app here.",
] as const;

/**
 * How many recordings are saved, and deleting them. Deleting asks once first (Sunday can't be shown from them
 * afterwards); the question opens under the button, which says so to VoiceOver. `confirming`: start open (tests).
 */
export function SavedRecordings({ count, onDelete, sharing, confirming = false }: {
  count: number; onDelete?: (() => void) | undefined; sharing: boolean; confirming?: boolean;
}) {
  const [confirm, setConfirm] = useState(confirming);
  const it = count === 1 ? "it" : "them";
  return <>
    <div className="find-next">
      <span className="bold">{count === 0 ? "No saved recordings for this organization." : `${count} saved for this organization.`}</span>
      {count > 0 && onDelete && <button type="button" className="btn btn-secondary btn-sm" aria-expanded={confirm} aria-controls="delete-recordings"
        onClick={() => setConfirm(!confirm)}>Delete saved recordings</button>}
    </div>
    {count > 0 && onDelete && confirm && <div id="delete-recordings" className="decide" role="group" aria-labelledby="delete-recordings-q">
      <p id="delete-recordings-q" className="find-body">Delete {count === 1 ? "the saved recording" : `all ${count} saved recordings`} from this Mac? Sunday can't be shown
        from {it} afterwards.{sharing ? " The copy for other AI apps is removed too." : ""} Planning Center doesn't change.</p>
      <div className="find-next">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { setConfirm(false); onDelete(); }}>Yes, delete {it}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>Keep {it}</button>
      </div>
    </div>}
  </>;
}

/**
 * "Your name for notes": the name drafted notes end with, kept on this Mac (connection.ts `yourName`). What the
 * person types stays as typed, so a space between words survives; the saved name is tidied.
 */
export function YourNameField({ store = yourName }: { store?: { get(): string; set(name: string): void } }) {
  const [typed, setTyped] = useState(() => store.get());
  return <div className="field your-name">
    <label htmlFor="your-name" className="field-l">Your name for notes</label>
    <input id="your-name" className="input" value={typed} maxLength={YOUR_NAME_MAX} autoComplete="name" spellCheck={false} placeholder="[Your name]"
      aria-describedby="your-name-help" onChange={e => { setTyped(e.target.value); store.set(e.target.value); }} />
    <p id="your-name-help" className="input-help">Notes Ozzie drafts end with this name. It stays on this Mac and goes in after any AI rewording, so it's never sent to an AI. Leave it empty to keep [Your name] for you to fill in.</p>
  </div>;
}

/** Settings: Planning Center, AI help, your name on notes, automatic checks, other AI apps, saved recordings and guided setup, in that order. */
export function ConnectionPage({ status, settings, onSettings, onStatus, recordingCount = 0, onDeleteRecordings, onModel, prefs, onAutomatic, onSetup, developer, autostart, sharing, oneClick, nameStore }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
  recordingCount?: number; onDeleteRecordings?: () => void; onModel?: (configured: boolean) => void;
  /** The automatic-check schedule, summarized here and changed under What runs automatically. */
  prefs?: ProactivePrefs; onAutomatic?: () => void; onSetup?: () => void;
  /** "Open Ozzie when I log in" on this Mac; the section is shown only when it's available. */
  autostart?: Autostart | undefined;
  /** Debug builds only: which answering loop Ask Ozzie uses, for comparison. Never shown in a release build. */
  developer?: { loop: "pi" | "ts"; onLoop: (loop: "pi" | "ts") => void } | undefined;
  /** "Use Ozzie's last check in other AI apps" (share-check.ts), off by default; `problem` when turning it on or off failed. */
  sharing?: { on: boolean; onChange: (on: boolean) => void; problem?: string | null } | undefined;
  /** Tests only: whether Ozzie's own registration is built in, instead of asking the app. */
  oneClick?: boolean;
  /** Tests only: where "Your name for notes" is kept, instead of this Mac's storage. */
  nameStore?: { get(): string; set(name: string): void };
}) {
  const control = useConnectionControl(settings, onStatus, status, oneClick);
  const { canSignIn, working, pending, run } = control;
  // The opt-in signs in again with the same registration (Ozzie's own, or yours under Advanced) as the sign-in form.
  const reconnect = (operations: boolean) => { void run(() => control.signIn(operations), "operations"); };
  return <div className="col settings">
    <h1 className="h1">Settings</h1>
    <p className="lede">How Ozzie reads your church's Planning Center, and what it keeps on this Mac.</p>

    <section className="settings-sec" aria-labelledby="pco-title">
      <h2 id="pco-title" className="h3">Planning Center</h2>
      <p className="banner"><Icon name="lock" small /><span><strong>Reads only.</strong> Planning Center may grant broad access at sign-in, but Ozzie has no way to change records or send messages. The connection stays on this Mac, in its Keychain.</span></p>
      <section className="find" aria-labelledby="signin-title">
        <h3 id="signin-title" className="settings-t">Sign in</h3>
        <ConnectForm status={status} settings={settings} onSettings={onSettings} control={control} />
      </section>
      <section className="find" aria-labelledby="sunday-title">
        <h3 id="sunday-title" className="settings-t">Which Sunday</h3>
        {/* The same picker as guided setup: upcoming plans once connected, with typing the plan by hand folded below. */}
        <SundayPicker connected={status?.state === "connected"} settings={settings} onSettings={onSettings} />
      </section>
      <section className="find" aria-labelledby="operations-title">
        <h3 id="operations-title" className="settings-t">Rooms, follow-ups and group events</h3>
        <p className="find-body">Ozzie can also check room bookings in Planning Center Calendar, follow-ups without an owner in People, and group events at the same time as serving in Groups. Turning this on signs in again and asks Planning Center for Calendar, People and Groups access. Planning Center grants each of those as read-and-write; Ozzie only reads, and has no way to change anything there.</p>
        <p className="checkline granted">{grantedCopy(status)}</p>
        <div className="row form-actions">
          {status?.scopes !== "services-and-operations"
            ? <button className="btn btn-secondary" disabled={!canSignIn || working || pending} onClick={() => reconnect(true)}>Also check rooms, follow-ups and group events</button>
            : <button className="btn btn-secondary" disabled={!canSignIn || working || pending} onClick={() => reconnect(false)}>Sign in again with Services only</button>}
        </div>
        {control.problem?.from === "operations" && <p role="alert" className="problem">{control.problem.text}</p>}
      </section>
    </section>

    <section className="settings-sec" aria-labelledby="ai-title">
      <h2 id="ai-title" className="h3">AI help</h2>
      <AiSettings onChange={c => onModel?.(c)} labelledBy="ai-title" />
    </section>

    <section className="settings-sec" aria-labelledby="your-name-title">
      <h2 id="your-name-title" className="h3">Your name on notes</h2>
      <div className="find"><YourNameField {...(nameStore ? { store: nameStore } : {})} /></div>
    </section>

    <section className="settings-sec" aria-labelledby="auto-title">
      <h2 id="auto-title" className="h3">Automatic checks</h2>
      <div className="find">
        <p className="find-body">{prefs ? `${scheduleLine(prefs)} Quiet hours ${quietLine(prefs)}` : "While Ozzie is open on this Mac, it checks the chosen Sunday on a schedule and tells you privately when something gets worse."}</p>
        {onAutomatic && <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onAutomatic}>Change these in What runs automatically</button></div>}
      </div>
    </section>

    {autostart && <section className="settings-sec" aria-labelledby="background-title">
      <h2 id="background-title" className="h3">When the window is closed</h2>
      <div className="find">
        <p className="find-body">Ozzie keeps running in the menu bar when you close its window, so it can keep an eye on what you asked. To stop it completely, choose Quit Ozzie from the menu bar icon.</p>
        <AutostartToggle autostart={autostart} />
      </div>
    </section>}

    {sharing && <section className="settings-sec" aria-labelledby="other-ai-title">
      <h2 id="other-ai-title" className="h3">Other AI apps</h2>
      <div className="find">
        <p className="find-body">{SHARE_BODY}</p>
        <div className="stack-tight">
          <label className="confirmation"><input type="checkbox" checked={sharing.on} onChange={e => sharing.onChange(e.target.checked)} />
            <span>Use Ozzie's last check in other AI apps</span></label>
          <p className="small">Off unless you turn it on. Turning it off removes the copy.</p>
          {sharing.problem && <p role="alert" className="problem">{sharing.problem}</p>}
        </div>
        <OtherAiAppsSetup on={sharing.on} />
        <details className="listen-more">
          <summary>See how this works</summary>
          <ul className="small">{SHARE_HOW.map(line => <li key={line}>{line}</li>)}</ul>
        </details>
      </div>
    </section>}

    <section className="settings-sec" aria-labelledby="saved-title">
      <h2 id="saved-title" className="h3">Saved recordings</h2>
      <div className="find">
        <p className="find-body">Each check saves a recording so Sunday can still be shown if Planning Center can't be reached. Recordings include volunteers' names and stay only on this Mac. Ozzie keeps the five newest for each Sunday.</p>
        <SavedRecordings count={recordingCount} onDelete={onDeleteRecordings} sharing={Boolean(sharing?.on)} />
      </div>
    </section>

    {onSetup && <section className="settings-sec" aria-labelledby="setup-again">
      <h2 id="setup-again" className="h3">Guided setup</h2>
      <div className="find">
        <p className="find-body">Walk through connecting Planning Center, choosing the Sunday, AI help and automatic checks, one step at a time.</p>
        <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onSetup}>Walk through setup again</button></div>
      </div>
    </section>}

    {developer && <section className="settings-sec" aria-labelledby="developer-title">
      <h2 id="developer-title" className="h3">Developer build only</h2>
      <div className="find">
        <p className="find-body">How Ask Ozzie runs its steps, for comparing the two. Both follow the same procedures and checks.</p>
        <div className="row rule-row">
          <label htmlFor="dev-loop">Answering steps</label>
          <select id="dev-loop" className="input" value={developer.loop} onChange={e => developer.onLoop(e.target.value === "ts" ? "ts" : "pi")}>
            <option value="pi">Pi (default)</option><option value="ts">Plain TypeScript</option>
          </select>
        </div>
      </div>
    </section>}
  </div>;
}
