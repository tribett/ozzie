// New versions of Ozzie on screen: the Updates section in Settings, and one calm line above Today when a
// newer version is ready. Every word is fixed in updates.ts; native code does the work (updater.rs).
import { useId, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";
import {
  AUTOMATIC_HELP, AUTOMATIC_LABEL, canInstall, CHECK_BUTTON, LATER_BUTTON, laterMemory, lastCheckedText, PLACE_TEXT, REOPEN_NOTE, statusLine,
  UPDATE_BUTTON, UPDATE_CARDS_ASK, UPDATE_DISCARD, UPDATE_HOW, UPDATE_KEEP_CARDS, working, type UpdatesState,
} from "./updates.js";

export const AUTOMATIC_OFF = "Off. Ozzie checks only when you choose Check for a new version.";

/**
 * "Update Ozzie and reopen it", with `beside` in the same row. While visitor cards are open (`cards`, a count) it asks
 * first, since reopening discards them (review P, L3); otherwise it updates at once. `asking`: start asked (tests).
 */
function InstallUpdate({ state, cards, primary, beside, asking = false }: {
  state: UpdatesState; cards: number; primary: boolean; beside?: ReactNode; asking?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(asking);
  const kind = primary ? "btn-primary" : "btn-secondary";
  if (cards <= 0) return <div className="find-next">
    <button type="button" className={`btn ${kind} btn-sm`} onClick={state.install}>{UPDATE_BUTTON}</button>{beside}
  </div>;
  return <>
    <div className="find-next">
      <button type="button" className={`btn ${kind} btn-sm`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{UPDATE_BUTTON}</button>{beside}
    </div>
    {open && <div id={id} className="decide" role="group" aria-labelledby={`${id}-q`}>
      <p id={`${id}-q`} className="find-body">{UPDATE_CARDS_ASK(cards)}</p>
      <div className="find-next">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(false)}>{UPDATE_KEEP_CARDS}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setOpen(false); state.install(); }}>{UPDATE_DISCARD(cards)}</button>
      </div>
    </div>}
  </>;
}

/** Settings: this copy's version, when Ozzie last checked, a check now, the automatic setting and, when ready, the update. */
export function UpdatesSection({ state, nowMs, cards, asking = false }: {
  state: UpdatesState; nowMs: number;
  /**
   * Visitor cards open (a count only): updating asks first while there are any. Required, so a place that shows the update
   * without saying how many cards are open doesn't compile (review F, L3). `asking`: start asked (tests).
   */
  cards: number; asking?: boolean;
}) {
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
        <InstallUpdate state={state} cards={cards} primary asking={asking} />
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
export function UpdateLine({ state, nowMs, memory = laterMemory(), cards, asking = false }: {
  state: UpdatesState; nowMs: number; memory?: ReturnType<typeof laterMemory>;
  /** As in the Updates section: visitor cards open (required), and (tests) the question already asked. */
  cards: number; asking?: boolean;
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
      {canInstall(view) && <InstallUpdate state={state} cards={cards} primary={false} asking={asking}
        beside={<button type="button" className="btn btn-quiet btn-sm" onClick={() => { memory.later(version, nowMs); setHiddenFor(version); }}>{LATER_BUTTON}</button>} />}
    </div>
  </section>;
}
