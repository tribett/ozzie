// What a person tells Ozzie from a finding card: "This isn't right", "Stop flagging this", "Always do
// this", and per kind "Always tell me right away" / "Put this in the briefing". Every choice becomes a
// visible, deletable entry on Church rules (core/src/finding-feedback.ts); nothing here reaches a model
// or Planning Center. Shared by every finding card (Sunday, rooms and follow-ups, group meetings, Today),
// so a new kind of finding gets the same controls.
import { useId, useState, type ReactNode } from "react";
import {
  alwaysEntry, alwaysFor, alwaysScope, alwaysText, canCorrect, canDemote, canPromote, correctionEntry, correctionSubject, entryText, kindWords, NOTE_MAX, stopEntry, stopScopes,
  stopText, urgencyEntry, urgencyFor, withEntry, withoutEntry, type FeedbackEntry, type FeedbackScope, type FeedbackTarget, type UrgencyEntry,
} from "../../../core/src/finding-feedback.js";
import { Icon } from "./icons.js";

type Names = Readonly<Record<string, string>>;
/** What a page gives its cards: the entries, how to change them, and names (resolved on this Mac only). */
export interface FeedbackControls {
  entries: readonly FeedbackEntry[];
  /** Saves the new entries with the Church rules. `said`: what to confirm, with Undo, at the top of the page. */
  change: (next: FeedbackEntry[], said: string) => void;
  names: Names;
  now?: () => string;
}
const nameOf = (names: Names) => (id: string) => (Object.hasOwn(names, id) && names[id]) || undefined;
const sentence = (s: string) => s.replace(/\.$/u, "");

/** Where a page's entries come from: the Church rules the app keeps. */
export interface FeedbackSource { entries: readonly FeedbackEntry[]; onEntries: (next: FeedbackEntry[]) => void }
/** Pending confirmation of the last choice, with Undo. One per page. */
export interface FeedbackNote { said: string; before: readonly FeedbackEntry[] }
/** A page's controls for its cards, and the note that confirms the last choice with Undo. */
export function useFeedback(source: FeedbackSource | null | undefined, names: Names): { controls: FeedbackControls | null; notice: ReactNode } {
  const [note, setNote] = useState<FeedbackNote | null>(null);
  if (!source) return { controls: null, notice: null };
  const controls: FeedbackControls = {
    entries: source.entries, names,
    change: (next, said) => { setNote({ said, before: source.entries }); source.onEntries(next); },
  };
  const notice = <FeedbackNotice note={note} onUndo={() => { if (note) source.onEntries([...note.before]); setNote(null); }} onDismiss={() => setNote(null)} />;
  return { controls, notice };
}
/** "Got it. I won't flag serving streaks for Jordan Lee." with Undo, shown where the card was. */
export function FeedbackNotice({ note, onUndo, onDismiss }: { note: FeedbackNote | null; onUndo: () => void; onDismiss: () => void }) {
  if (!note) return null;
  return <div className="panel-ok feedback-note" role="status">
    <Icon name="check" small />
    <span>{note.said}</span>
    <span className="spacer" />
    <button type="button" className="btn btn-secondary btn-sm" onClick={onUndo}>Undo</button>
    <button type="button" className="ibtn" aria-label="Close this note" onClick={onDismiss}><Icon name="x" /></button>
  </div>;
}

const URGENCY_SAID: Record<UrgencyEntry["level"], (kind: string) => string> = {
  "right-away": kind => `I'll tell you right away about ${kindWords(kind)}.`,
  briefing: kind => `I'll keep ${kindWords(kind)} for your briefing instead of sending a notice.`,
};
/** What a per-kind choice means, said on the card while it's on. */
export const URGENCY_NOW: Record<UrgencyEntry["level"], (kind: string) => string> = {
  "right-away": kind => `Ozzie tells you right away about ${kindWords(kind)}: a private notice as soon as a check finds a new one or one gets worse. Quiet hours still hold it unless you let urgent notices through.`,
  briefing: kind => `Ozzie keeps ${kindWords(kind)} for your briefing: no notice, even close to Sunday. They still show here.`,
};

/**
 * The controls under a finding. `urgency`: false where notices don't apply (the fictional email import).
 * `occasion` and `source`: what one occurrence is and where its facts come from, in words.
 * A choice that sets this finding aside makes the card disappear; the page says what happened, with Undo.
 */
export function FindingFeedback({ target, feedback, urgency = true, occasion = "for this Sunday", source = "Planning Center" }: {
  target: FeedbackTarget; feedback: FeedbackControls | null | undefined; urgency?: boolean; occasion?: string; source?: string;
}) {
  const id = useId();
  const [stage, setStage] = useState<null | "correct" | "stop" | "always">(null);
  const [note, setNote] = useState("");
  const [scope, setScope] = useState(0);
  const [problem, setProblem] = useState("");
  if (!feedback) return null;
  const { entries, names } = feedback;
  const now = () => feedback.now?.() ?? new Date().toISOString();
  const who = nameOf(names);
  const scopes = stopScopes(target);
  const always = target.action ? alwaysFor(entries, target) : null;
  const level = urgencyFor(entries, target.kind);
  const promote = urgency && canPromote(target), demote = urgency && canDemote(target);
  const save = (entry: FeedbackEntry, said: string) => {
    feedback.change(withEntry(entries, entry), `${said} It's on your Church rules, where you can change it any time.`);
    setStage(null); setProblem("");
  };
  const attempt = (work: () => void) => { try { work(); } catch (error) { setProblem(error instanceof Error ? error.message : "That couldn't be saved."); } };
  const toggle = (want: UrgencyEntry["level"]) => attempt(() => {
    const current = entries.find(e => e.type === "urgency" && e.kind === target.kind);
    if (level === want && current) feedback.change(withoutEntry(entries, current.id), `Back to the usual for ${kindWords(target.kind)}.`);
    else save(urgencyEntry(target, want, now()), URGENCY_SAID[want](target.kind));
  });
  const open = (next: typeof stage) => { setStage(stage === next ? null : next); setProblem(""); };
  if (!canCorrect(target) && !scopes.length && !target.action && !promote && !demote) return null;
  return <div className="find-feedback">
    <div className="find-next" role="group" aria-label="Tell Ozzie about this">
      {canCorrect(target) && <button type="button" className="btn btn-quiet btn-sm" aria-expanded={stage === "correct"} aria-controls={`${id}-form`} onClick={() => open("correct")}>This isn't right</button>}
      {scopes.length > 0 && <button type="button" className="btn btn-quiet btn-sm" aria-expanded={stage === "stop"} aria-controls={`${id}-form`} onClick={() => open("stop")}>Stop flagging this</button>}
      {target.action && !always && <button type="button" className="btn btn-quiet btn-sm" aria-expanded={stage === "always"} aria-controls={`${id}-form`} onClick={() => open("always")}>Always do this</button>}
      {promote && <button type="button" className="btn btn-quiet btn-sm" aria-pressed={level === "right-away"} onClick={() => toggle("right-away")}>
        {level === "right-away" && <Icon name="check" small />}Always tell me right away</button>}
      {demote && <button type="button" className="btn btn-quiet btn-sm" aria-pressed={level === "briefing"} onClick={() => toggle("briefing")}>
        {level === "briefing" && <Icon name="check" small />}Put this in the briefing</button>}
    </div>
    {urgency && level && (level === "right-away" ? promote : demote) && <p className="small">{URGENCY_NOW[level](target.kind)}</p>}
    {always && <p className="small"><Icon name="rules" small /> Prepared because of your Church rule: “{sentence(alwaysText(always, who))}.”</p>}
    {stage === "correct" && <form id={`${id}-form`} className="decide" onSubmit={e => {
      e.preventDefault();
      attempt(() => save(correctionEntry(target, note, now()), `Got it. I've set this aside ${occasion} and kept your note.`));
    }}>
      <label className="field-l" htmlFor={`${id}-note`}>What should Ozzie have seen? (optional)</label>
      <input id={`${id}-note`} className="input" value={note} maxLength={NOTE_MAX} autoFocus placeholder="A few words, for example: she moved to the 11:00 service"
        onChange={e => { setNote(e.target.value); setProblem(""); }} />
      <p className="input-help">Kept on this Mac and never sent to an AI. This hides it {occasion} only; it comes back if {source} changes.</p>
      {problem && <p role="alert" className="problem">{problem}</p>}
      <div className="find-next">
        <button type="submit" className="btn btn-primary btn-sm">Hide it {occasion}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStage(null)}>Never mind</button>
      </div>
    </form>}
    {stage === "stop" && <form id={`${id}-form`} className="decide" onSubmit={e => {
      e.preventDefault();
      const chosen = scopes[scope] ?? scopes[0]!;
      attempt(() => { const entry = stopEntry(target, chosen, now()); save(entry, `Got it. ${stopText(entry, who).replace(/^Don't flag/u, "I won't flag")}`); });
    }}>
      {scopes.length > 1
        ? <fieldset className="plan-report"><legend className="bold">What should Ozzie stop flagging?</legend>
          {scopes.map((s: FeedbackScope, i) => <label key={i} className="confirmation">
            <input type="radio" name={`${id}-scope`} checked={scope === i} onChange={() => setScope(i)} />
            <span>{stopText({ kind: target.kind, scope: s, labels: target.labels ?? {} }, who)}</span></label>)}
        </fieldset>
        : <p className="find-body">{stopText({ kind: target.kind, scope: scopes[0]!, labels: target.labels ?? {} }, who)}</p>}
      <p className="input-help">It's set aside now and on every later check, and listed on your Church rules, where you can undo it any time.</p>
      {problem && <p role="alert" className="problem">{problem}</p>}
      <div className="find-next">
        <button type="submit" className="btn btn-primary btn-sm">Stop flagging it</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStage(null)}>Never mind</button>
      </div>
    </form>}
    {stage === "always" && target.action && <form id={`${id}-form`} className="decide" onSubmit={e => {
      e.preventDefault();
      attempt(() => { const entry = alwaysEntry(target, now()); save(entry, `Got it. ${alwaysText(entry, who).replace(/^Always prepare/u, "I'll always prepare")}`); });
    }}>
      <p className="find-body">{alwaysText({ kind: target.kind, action: target.action, scope: alwaysScope(target), labels: target.labels ?? {} }, who)}</p>
      <p className="input-help">Ozzie only prepares it. You still copy it and send it yourself.</p>
      {problem && <p role="alert" className="problem">{problem}</p>}
      <div className="find-next">
        <button type="submit" className="btn btn-primary btn-sm">Always prepare it</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStage(null)}>Never mind</button>
      </div>
    </form>}
    {problem && !stage && <p role="alert" className="problem">{problem}</p>}
  </div>;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "earlier" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
/**
 * Church rules: everything the person told Ozzie on finding cards, visible, changeable and deletable
 * here (owner decision, November 4: no hidden learned preference). Deleting one says so, with Undo.
 */
export function FromYourCards({ feedback }: { feedback: FeedbackControls | null | undefined }) {
  if (!feedback) return null;
  const who = nameOf(feedback.names);
  const of = <T extends FeedbackEntry["type"]>(type: T) => feedback.entries.filter((e): e is Extract<FeedbackEntry, { type: T }> => e.type === type).slice().reverse();
  const stops = of("stop"), always = of("always"), urgency = of("urgency"), corrections = of("correction");
  const remove = (e: FeedbackEntry, said: string) => feedback.change(withoutEntry(feedback.entries, e.id), said);
  const row = (e: FeedbackEntry, text: string, button: string, said: string, extra: ReactNode = null) => <li key={e.id} className="rule-entry">
    <Icon name="rules" small />
    <div className="stack-tight"><span>{text}</span>{extra}<span className="small">Since {day(e.at)}</span></div>
    <button type="button" className="btn btn-quiet btn-sm" aria-label={`${button}: ${text}`} onClick={() => remove(e, said)}>{button}</button>
  </li>;
  return <section className="find from-cards" aria-labelledby="from-cards-title">
    <h2 id="from-cards-title" className="h3">What you've told Ozzie</h2>
    <p className="find-body">What you said on findings on the Sunday and Today pages. Each applies right away, using what was already read, and to every later check; delete one here any time. Nothing here changes Planning Center.</p>
    {!feedback.entries.length && <p className="small">Nothing yet. On a finding, choose “This isn't right”, “Stop flagging this”, “Always do this”, “Always tell me right away” or “Put this in the briefing”, and it shows here.</p>}
    {stops.length > 0 && <><h3 className="bold">Don't flag</h3>
      <ul className="list">{stops.map(e => row(e, stopText(e, who), "Start flagging this again", "Ozzie flags this again, starting now."))}</ul></>}
    {always.length > 0 && <><h3 className="bold">Always do</h3>
      <ul className="list">{always.map(e => row(e, alwaysText(e, who), "Stop doing this", "Ozzie won't prepare that on its own any more."))}</ul></>}
    {urgency.length > 0 && <><h3 className="bold">How Ozzie tells you</h3>
      <ul className="list">{urgency.map(e => row(e, entryText(e, who), "Go back to the usual", `Back to the usual for ${kindWords(e.kind)}.`,
        <span className="small">{URGENCY_NOW[e.level](e.kind)}</span>))}</ul></>}
    {corrections.length > 0 && <><h3 className="bold">Corrections you've made</h3>
      <ul className="list">{corrections.map(e => row(e, `${correctionSubject(e, who)}${e.labels.occurrence ? `, ${e.labels.occurrence}` : ""}`, "Delete my correction",
        "Your correction is deleted. If Planning Center still shows it, it's back on the Sunday page.",
        <span className="small">{e.note ? `You said: “${e.note}”` : "You said this wasn't right."} {e.kind === "attention"
          ? "Hidden for that import only." : "Hidden for that Sunday only, while Planning Center shows the same."}</span>))}</ul></>}
  </section>;
}

/** Findings set aside by the person's Church rules, each with what set it aside and a way back. */
export function SetAside({ entries, feedback, label = "Set aside by your Church rules" }: {
  entries: readonly FeedbackEntry[]; feedback: FeedbackControls | null | undefined; label?: string;
}) {
  if (!feedback || !entries.length) return null;
  const unique = [...new Map(entries.map(e => [e.id, e])).values()];
  const who = nameOf(feedback.names);
  return <section className="stack set-aside" aria-label={label}>
    <h2 className="h3">{label}</h2>
    <p className="small">Ozzie still read these. They aren't shown because of what you told it; nothing in Planning Center changed.</p>
    <ul className="list">{unique.map(e => <li key={e.id}><Icon name="rules" small /><span>{entryText(e, who)}</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => feedback.change(withoutEntry(feedback.entries, e.id), e.type === "stop" ? "Ozzie will flag this again." : "Your correction is deleted.")}>
        {e.type === "stop" ? "Start flagging this again" : "Show it again"}</button></li>)}</ul>
  </section>;
}
