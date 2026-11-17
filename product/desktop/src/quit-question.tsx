// Asked in the window before Ozzie quits (audit items 20 and 23, owner decisions 2026-11-16): quitting stops the
// regular Sunday check, the jobs and their notices until Ozzie is opened again, and discards visitor cards, which are
// kept nowhere else. Asked for "Quit Ozzie" in the app menu or the menu bar icon's menu, and for Command-Q, which is that
// menu item (src-tauri/src/app_menu.rs): native code asks before it quits (always_on.rs `request_quit`, QuitGuard) and
// tells the page only counts; the leader's answer quits now or keeps Ozzie running, and a second Quit within a minute
// goes ahead. Logging out, restarting or shutting down the Mac and the Dock's Quit are never held, so they don't ask.
// Closing the window instead keeps Ozzie running in the menu bar.
import { useEffect, useRef } from "react";
import { Icon } from "./icons.js";
import { quitting } from "./background.js";
import type { Readiness } from "./proactive.js";

export interface QuitAsk { cards: number; checks: boolean }

/** What says whether checks are on: this Mac's own settings, the regular Sunday check's schedule and the jobs. */
export type ChecksState = {
  readiness: Readiness; schedule: { paused: boolean };
  watch: { paused_all: boolean; items: readonly { status: string }[] };
};
/**
 * Whether quitting would stop checks (review P, L2): the regular Sunday check is on (Ozzie can check this church and its
 * schedule isn't paused), or any job is on while Pause everything is off. All of it is this Mac's own church and jobs,
 * which the fictional example never changes.
 */
export function checksOn({ readiness, schedule, watch }: ChecksState): boolean {
  return (readiness === "ready" && !schedule.paused) || (!watch.paused_all && watch.items.some(r => r.status === "active"));
}
/** Tells native code what quitting would stop or lose, whenever that changes: open cards (a count) and whether checks are on. */
export function useQuitGuard(cards: number, state: ChecksState): void {
  const on = checksOn(state);
  useEffect(() => { quitting.guard(cards, on); }, [cards, on]);
}
/** The question's words, by what quitting would stop or lose. */
export function quitWords({ cards, checks }: QuitAsk): { title: string; lines: string[]; quit: string; keep: string } {
  const lines = [
    ...(cards > 0 ? [`You have ${cards === 1 ? "1 visitor card that isn't" : `${cards} visitor cards that aren't`} saved anywhere. Quitting discards ${cards === 1 ? "it" : "them"}.`] : []),
    ...(checks ? ["Checks and notices stop until you open Ozzie again."] : []),
    "Closing the window instead keeps Ozzie running in the menu bar.",
  ];
  return {
    title: cards > 0 && !checks ? `Quit and discard ${cards === 1 ? "the card" : "the cards"}?` : "Quit Ozzie?",
    lines, quit: cards > 0 ? `Quit and discard ${cards === 1 ? "the card" : "the cards"}` : "Quit Ozzie", keep: "Keep Ozzie running",
  };
}

export function QuitQuestion({ ask, onQuit, onKeep }: { ask: QuitAsk; onQuit: () => void; onKeep: () => void }) {
  const keep = useRef<HTMLButtonElement>(null);
  // Keeping Ozzie running is where focus starts: the safe answer.
  useEffect(() => { keep.current?.focus(); }, []);
  const words = quitWords(ask);
  return <div className="quit-scrim">
    <div className="quit-question" role="alertdialog" aria-modal="true" aria-labelledby="quit-title" aria-describedby="quit-body"
      onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onKeep(); } }}>
      <h2 id="quit-title" className="h3"><Icon name="info" small /> {words.title}</h2>
      <div id="quit-body" className="stack-tight">{words.lines.map(l => <p key={l}>{l}</p>)}</div>
      <div className="find-next">
        <button type="button" className="btn btn-secondary" ref={keep} onClick={onKeep}>{words.keep}</button>
        <button type="button" className="btn btn-quiet" onClick={onQuit}>{words.quit}</button>
      </div>
    </div>
  </div>;
}
