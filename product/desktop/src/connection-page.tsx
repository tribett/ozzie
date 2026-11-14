import { connection, type ConnectionStatus } from "./connection.js";
import type { Settings } from "./sunday-source.js";
import type { ProactivePrefs } from "./proactive.js";
import { AiSettings } from "./ai-settings.js";
import { ConnectForm, SundayPlanFields, useConnectionControl } from "./planning-center-forms.js";
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

/** Settings: Planning Center, wording help, automatic checks, saved recordings and guided setup, in that order. */
export function ConnectionPage({ status, settings, onSettings, onStatus, recordingCount = 0, onDeleteRecordings, onModel, prefs, onAutomatic, onSetup, developer, autostart }: {
  status: ConnectionStatus | null; settings: Settings; onSettings: (s: Settings) => void; onStatus: (s: ConnectionStatus) => void;
  recordingCount?: number; onDeleteRecordings?: () => void; onModel?: (configured: boolean) => void;
  /** The automatic-check schedule, summarized here and changed under What runs automatically. */
  prefs?: ProactivePrefs; onAutomatic?: () => void; onSetup?: () => void;
  /** "Open Ozzie when I log in" on this Mac; the section is shown only when it's available. */
  autostart?: Autostart | undefined;
  /** Debug builds only: which answering loop Ask Ozzie uses, for comparison. Never shown in a release build. */
  developer?: { loop: "pi" | "ts"; onLoop: (loop: "pi" | "ts") => void } | undefined;
}) {
  const control = useConnectionControl(settings, onStatus, status);
  const { ready, working, pending, registered, run } = control;
  // The opt-in signs in again with the same registration confirmation as the sign-in form.
  const reconnect = (operations: boolean) => { void run(() => connection.connect(settings.clientId, settings.organization, registered, operations), "operations"); };
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
        <SundayPlanFields settings={settings} onSettings={onSettings} />
      </section>
      <section className="find" aria-labelledby="operations-title">
        <h3 id="operations-title" className="settings-t">Rooms, follow-ups and group events</h3>
        <p className="find-body">Ozzie can also check room bookings in Planning Center Calendar, follow-ups without an owner in People, and group events at the same time as serving in Groups. Turning this on signs in again and asks Planning Center for Calendar, People and Groups access. Planning Center grants each of those as read-and-write; Ozzie only reads, and has no way to change anything there.</p>
        <p className="checkline granted">{grantedCopy(status)}</p>
        <div className="row form-actions">
          {status?.scopes !== "services-and-operations"
            ? <button className="btn btn-secondary" disabled={!ready || working || pending} onClick={() => reconnect(true)}>Also check rooms, follow-ups and group events</button>
            : <button className="btn btn-secondary" disabled={!ready || working || pending} onClick={() => reconnect(false)}>Sign in again with Services only</button>}
        </div>
        {control.problem?.from === "operations" && <p role="alert" className="problem">{control.problem.text}</p>}
      </section>
    </section>

    <section className="settings-sec" aria-labelledby="ai-title">
      <h2 id="ai-title" className="h3">Wording help</h2>
      <AiSettings onChange={c => onModel?.(c)} labelledBy="ai-title" />
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

    <section className="settings-sec" aria-labelledby="saved-title">
      <h2 id="saved-title" className="h3">Saved recordings</h2>
      <div className="find">
        <p className="find-body">Each check saves a recording so Sunday can still be shown if Planning Center can't be reached. Recordings include volunteers' names and stay only on this Mac. Ozzie keeps the five newest for each Sunday.</p>
        <div className="find-next">
          <span className="bold">{recordingCount === 0 ? "No saved recordings for this organization." : `${recordingCount} saved for this organization.`}</span>
          {recordingCount > 0 && onDeleteRecordings && <button type="button" className="btn btn-secondary btn-sm" onClick={onDeleteRecordings}>Delete saved recordings</button>}
        </div>
      </div>
    </section>

    {onSetup && <section className="settings-sec" aria-labelledby="setup-again">
      <h2 id="setup-again" className="h3">Guided setup</h2>
      <div className="find">
        <p className="find-body">Walk through connecting Planning Center, choosing the Sunday, wording help and automatic checks, one step at a time.</p>
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
