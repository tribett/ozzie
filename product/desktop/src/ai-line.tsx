// Which AI Ozzie is using, always in sight (onboarding spec §4.4): "AI: ChatGPT, your key" under the sidebar's promise
// line, and small in the Ask panel's header, with a quiet "Change" one tap away. A paused or failing route says so
// (" · paused", " · not answering") and "Change" becomes "Check". Words come from closed codes only, never native's label.
import { createContext, useContext, useId } from "react";
import { aiLine, LINE, NEEDS_AI } from "./ai-words.js";
import type { ModelStatus } from "./model.js";
import "./ai-screens.css";

/**
 * Opens "How should Ozzie use AI?" over the page (App's `openAi`), for every place that needs AI when none works: Ask,
 * rewording a note, the who-could-help look. Null outside the app (a page drawn alone): no button promises it.
 */
export const ChooseAiContext = createContext<(() => void) | null>(null);
/** The one step on after "… needs AI": "Choose how Ozzie uses AI". */
export function ChooseAiButton() {
  const open = useContext(ChooseAiContext);
  return open ? <div><button type="button" className="btn btn-secondary btn-sm" onClick={open}>{NEEDS_AI.button}</button></div> : null;
}

export function AiLine({ status, onChange, small = false }: { status: ModelStatus | null; onChange: () => void; small?: boolean }) {
  const id = useId();
  const { text, trouble } = aiLine(status);
  return <p className={`ai-line${small ? " is-small" : ""}`}>
    <span id={id}>{text}{trouble && <span className="ai-line-trouble"> · {trouble}</span>}</span>
    <button type="button" className="ai-link" aria-describedby={id} onClick={onChange}>{trouble ? LINE.check : LINE.change}</button>
  </p>;
}
