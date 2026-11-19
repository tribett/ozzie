// Settings → A notice on your phone (phone-notice.ts): the switch, what goes to the phone, who can see it and what
// never goes, and, while it's on, the steps for the phone with the channel to subscribe to, a Copy button, "Send a test
// notice", what became of the last phone notice, and "Make a new channel". Nothing here sends anything itself; native
// does, with its own fixed line.
import { useEffect, useState } from "react";
import { copySetup } from "./other-ai-apps-setup.js";
import { Icon } from "./icons.js";
import {
  COPY_BUTTON, KEEP_BUTTON, lastLine, NEW_BUTTON, NEW_CONFIRM, PHONE_BODY, PHONE_HOW, PHONE_OFF_NOTE, PHONE_QUIET, PHONE_RISK, PHONE_SEEN, PHONE_STEPS,
  PHONE_SWITCH, PHONE_TITLE, PHONE_UNREADABLE, PHONE_WHAT, PhoneControl, phoneInvoke, TEST_BUTTON, type Invoke, type PhoneState, type PhoneView,
} from "./phone-notice.js";

/** The channel with its Copy button. */
function ChannelLine({ channel }: { channel: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => { setCopy("idle"); }, [channel]);
  return <>
    <p className="small">Channel name:</p>
    <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}><code>{channel}</code></pre>
    <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void copySetup(channel).then(ok => setCopy(ok ? "copied" : "failed")); }}>
      {copy === "copied" ? "Copied" : COPY_BUTTON}</button></div>
    {copy === "failed" && <p role="alert" className="problem">That couldn't be copied. Select it and copy it yourself.</p>}
  </>;
}

/** While it's on: the steps for the phone, the channel, a test notice, the last phone notice and a new channel. */
function PhoneSetup({ state, control, now }: { state: PhoneState; control: PhoneControl; now: () => number }) {
  const { channel, busy, confirmingNew } = state;
  return <div className="stack-tight" role="group" aria-labelledby="phone-setup-title" style={{ marginTop: 12 }}>
    <p id="phone-setup-title" className="bold">Set up your phone</p>
    <ol className="ask-steps">{PHONE_STEPS.map(step => <li key={step}>{step}</li>)}</ol>
    {channel ? <ChannelLine channel={channel} /> : <p className="problem">{PHONE_UNREADABLE}</p>}
    {confirmingNew
      ? <>
        <p className="small">{NEW_CONFIRM}</p>
        <div className="row form-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { void control.newChannel(); }}>{NEW_BUTTON}</button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => control.askNew(false)}>{KEEP_BUTTON}</button>
        </div>
      </>
      : <div className="row form-actions">
        {channel && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => { void control.test(); }}>{TEST_BUTTON}</button>}
        <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={() => control.askNew(true)}>{NEW_BUTTON}</button>
      </div>}
    <p className="small muted">{lastLine(state.last, now())}</p>
  </div>;
}

/**
 * The Settings section. `invoke` and `initial` (tests): native's stand-in, and the view to start from instead of asking
 * native. `now` (tests): the clock "today" is read against.
 */
export function PhoneNoticeSection({ invoke = phoneInvoke, initial, now = Date.now }: { invoke?: Invoke; initial?: PhoneView; now?: () => number }) {
  const [state, setState] = useState<PhoneState | null>(null);
  const [control] = useState(() => new PhoneControl(invoke, setState, initial));
  useEffect(() => { if (!initial) void control.load(); }, [control, initial]);
  const shown = state ?? control.state;
  // A card under "What Ozzie runs and notices" in Settings (audit item 27).
  return <section className="find" aria-labelledby="phone-title">
    <h3 id="phone-title" className="settings-t">{PHONE_TITLE}</h3>
      <p className="find-body">{PHONE_BODY}</p>
      <div className="stack-tight">
        <label className="confirmation"><input type="checkbox" checked={shown.on} disabled={shown.busy} onChange={e => { void control.change(e.target.checked); }} />
          <span>{PHONE_SWITCH}</span></label>
        <p className="small">{PHONE_OFF_NOTE}</p>
        {shown.problem && <p role="alert" className="problem">{shown.problem}</p>}
      </div>
      <p className="small" style={{ marginTop: 12 }}>{PHONE_WHAT} {PHONE_SEEN}</p>
      <p className="small" style={{ marginTop: 8 }}>{PHONE_RISK} {PHONE_QUIET}</p>
      {shown.on && <PhoneSetup state={shown} control={control} now={now} />}
      {shown.note && <p role="status" className="small" style={{ marginTop: 8 }}>{shown.note}</p>}
      <details className="listen-more">
        <summary><Icon name="chev" small />See how this works</summary>
        <ul className="small">{PHONE_HOW.map(line => <li key={line}>{line}</li>)}</ul>
      </details>
  </section>;
}
