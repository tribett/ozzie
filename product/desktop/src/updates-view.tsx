// New versions of Ozzie on screen: the Updates section in Settings, and one calm line above Today when a
// newer version is ready. Every word is fixed in updates.ts; native code does the work (updater.rs).
import { useState } from "react";
import { Icon } from "./icons.js";
import {
  AUTOMATIC_HELP, AUTOMATIC_LABEL, canInstall, CHECK_BUTTON, LATER_BUTTON, laterMemory, lastCheckedText, PLACE_TEXT, REOPEN_NOTE, statusLine,
  UPDATE_BUTTON, UPDATE_HOW, working, type UpdatesState,
} from "./updates.js";

export const AUTOMATIC_OFF = "Off. Ozzie checks only when you choose Check for a new version.";

/** Settings: this copy's version, when Ozzie last checked, a check now, the automatic setting and, when ready, the update. */
export function UpdatesSection({ state, nowMs }: { state: UpdatesState; nowMs: number }) {
  const view = state.view;
  if (!view) return null;
  const line = statusLine(view);
  const problem = view.problem !== null && !working(view);
  return <section className="settings-sec" aria-labelledby="updates-title">
    <h2 id="updates-title" className="h3">Updates</h2>
    <div className="find updates">
      <p className="find-body"><span className="bold">This Mac has Ozzie {view.current}.</span> {lastCheckedText(view, nowMs)}</p>
      {/* A newer version is the news here, so it reads as body text; checking and "up to date" stay small. */}
      {line && (problem ? <p className="problem" role="alert">{line}</p>
        : <p className={canInstall(view) ? "find-body bold" : "checkline"} role="status">{line}</p>)}
      {view.available && view.place !== "app" && <p className="small">{PLACE_TEXT[view.place]}</p>}
      {canInstall(view) && <div className="stack-tight">
        <div className="find-next"><button type="button" className="btn btn-primary btn-sm" onClick={state.install}>{UPDATE_BUTTON}</button></div>
        <p className="small">{REOPEN_NOTE}</p>
      </div>}
      <div className="find-next">
        <button type="button" className="btn btn-secondary btn-sm" disabled={working(view)} onClick={state.check}>{CHECK_BUTTON}</button>
      </div>
      <div className="stack-tight">
        <label className="confirmation"><input type="checkbox" checked={view.automatic} onChange={e => state.setAutomatic(e.target.checked)} />
          <span>{AUTOMATIC_LABEL}</span></label>
        <p className="small">{view.automatic ? AUTOMATIC_HELP : AUTOMATIC_OFF}</p>
      </div>
      <details className="listen-more">
        <summary>See how this works</summary>
        <ul className="small">{UPDATE_HOW.map(l => <li key={l}>{l}</li>)}</ul>
      </details>
    </div>
  </section>;
}

/**
 * Above Today, only while a newer version is ready (or being put in place): one line, the update button and
 * "Remind me tomorrow", which hides it here until the next morning for that version. Settings always shows it.
 */
export function UpdateLine({ state, nowMs, memory = laterMemory() }: {
  state: UpdatesState; nowMs: number; memory?: ReturnType<typeof laterMemory>;
}) {
  const view = state.view;
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  if (!view?.available) return null;
  const version = view.available;
  const busy = working(view) && view.phase !== "checking";
  if (!busy && (hiddenFor === version || memory.hidden(version, nowMs))) return null;
  const line = busy || view.problem ? statusLine(view) : null;
  return <section className="banner update-line" aria-labelledby="update-line-title">
    <Icon name="info" small />
    <div className="stack-tight">
      <h2 id="update-line-title" className="update-line-t">A new version of Ozzie is ready: {version}.</h2>
      {line && <p className="small" role={view.problem && !busy ? "alert" : "status"}>{line}</p>}
      {view.place !== "app" && <p className="small">{PLACE_TEXT[view.place]}</p>}
      {canInstall(view) && <div className="find-next">
        <button type="button" className="btn btn-secondary btn-sm" onClick={state.install}>{UPDATE_BUTTON}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { memory.later(version, nowMs); setHiddenFor(version); }}>{LATER_BUTTON}</button>
      </div>}
    </div>
  </section>;
}
