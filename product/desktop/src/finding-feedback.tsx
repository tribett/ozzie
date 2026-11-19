// What a person tells Ozzie from a finding card: "This isn't right", "Stop flagging this", "Always do
// this", and per kind "Always tell me right away" / "Put this in the briefing". Every choice becomes a
// visible, deletable entry on Church rules (core/src/finding-feedback.ts); nothing here reaches a model
// or Planning Center. Shared by every finding card (Sunday, rooms and follow-ups, group meetings, Today),
// so a new kind of finding gets the same controls.
import { useId, useState, type ReactNode } from "react";
import {
  alwaysEntry, alwaysFor, alwaysScope, alwaysText, canCorrect, canDemote, canPromote, correctionEntry, correctionSubject, entryText, hidesFinding, kindWords, NOTE_MAX, stopEntry,
  stopScopes, stopText, urgencyEntry, urgencyFor, withEntry, withoutEntry, type CorrectionWhat, type FeedbackEntry, type FeedbackScope, type FeedbackTarget, type UrgencyEntry,
} from "../../../core/src/finding-feedback.js";
import { Icon } from "./icons.js";
import { useSystemWords } from "./church-system.js";
import { SUNDAY_WORDS, useDay, type DayWords } from "./day-words.js";
import { dayName, pageRef } from "./day-phrases.js";

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
/** "Got it. Ozzie won't flag serving streaks for Jordan Lee." with Undo, shown where the card was. Never "I" (round 5). */
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
  "right-away": kind => `Ozzie will tell you right away about ${kindWords(kind)}.`,
  briefing: kind => `Ozzie will keep ${kindWords(kind)} for your briefing instead of sending a notice.`,
};
/** What a per-kind choice means, said on the card while it's on; the watched service named by its real day (`d`). */
export const URGENCY_NOW: Record<UrgencyEntry["level"], (kind: string, d?: DayWords) => string> = {
  "right-away": kind => `Ozzie tells you right away about ${kindWords(kind)}: a private notice as soon as a check finds a new one or one gets worse. Quiet hours still hold it unless you let urgent notices through.`,
  briefing: (kind, d = SUNDAY_WORDS) => `Ozzie keeps ${kindWords(kind)} for your briefing: no notice, even close to ${dayName(d)}. They still show here.`,
};

/**
 * What "This isn't right" asks before anything is hidden (audit item 28): the finding itself first, which hides it for
 * this occurrence; then, on an open role, a person's details on the card; then something else. Only the first hides it;
 * the others keep it showing and keep what the person said.
 */
export function correctionChoices(kind: string, occasion: string, source: string): { what: CorrectionWhat; label: string; effect: string }[] {
  const role = kind === "needs-people";
  return [
    { what: "finding", label: role ? "The role isn't open" : "This finding is wrong", effect: `Ozzie hides it ${occasion} and keeps your note. It comes back if ${source} changes.` },
    ...(role ? [{ what: "person" as const, label: "A person's details are wrong", effect: "Ozzie keeps showing the open role and keeps your note." }] : []),
    { what: "other", label: "Something else", effect: "Ozzie keeps showing it and keeps your note." },
  ];
}
/** What the page confirms, with Undo, once a correction is saved. */
export const correctionSaid = (what: CorrectionWhat, occasion: string) => what === "finding"
  ? `Got it. Ozzie hid this ${occasion} and kept your note. Undo brings it back now; later, it's under “What you've told Ozzie” on Church rules.`
  : "Got it. Ozzie kept your note, and this still shows. You can delete the note under “What you've told Ozzie” on Church rules.";

/**
 * The controls under a finding. `urgency`: false where notices don't apply (the fictional email import).
 * `occasion` and `source`: what one occurrence is and where its facts come from, in words.
 * A choice that sets this finding aside makes the card disappear; the page says what happened, with Undo.
 */
/**
 * What a person's Church rules already do for this card, said in words: how soon Ozzie tells them about this kind, and
 * that a note was prepared because of a rule. State, not a choice, so a Sunday card shows it beside the note it explains
 * even while More choices is closed (review F, L-5).
 */
export function FeedbackState({ target, feedback, urgency = true }: { target: FeedbackTarget; feedback: FeedbackControls | null | undefined; urgency?: boolean }) {
  const d = useDay();
  if (!feedback) return null;
  const always = target.action ? alwaysFor(feedback.entries, target) : null;
  const level = urgencyFor(feedback.entries, target.kind);
  const said = urgency && level && (level === "right-away" ? canPromote(target) : canDemote(target));
  if (!said && !always) return null;
  return <div className="feedback-state">
    {said && <p className="small">{URGENCY_NOW[level](target.kind, d)}</p>}
    {always && <p className="small"><Icon name="rules" small /> Prepared because of your Church rule: “{sentence(alwaysText(always, nameOf(feedback.names)))}.”</p>}
  </div>;
}

export function FindingFeedback({ target, feedback, urgency = true, occasion: occasionProp, source = "Planning Center", startOpen = null, startWhat = null, state = true }: {
  target: FeedbackTarget; feedback: FeedbackControls | null | undefined; urgency?: boolean; occasion?: string; source?: string;
  /** False where the card shows FeedbackState itself, outside a fold. */
  state?: boolean;
  /** Tests only: start with one of the forms open, and (This isn't right) one choice made. */
  startOpen?: "correct" | "stop" | "always" | null; startWhat?: CorrectionWhat | null;
}) {
  const id = useId();
  // One occurrence of a Services finding is the watched service, by its real day: "for this Wednesday".
  const words = useDay();
  const occasion = occasionProp ?? `for ${words.thisOne}`;
  const [stage, setStage] = useState<null | "correct" | "stop" | "always">(startOpen);
  const [note, setNote] = useState("");
  const [what, setWhat] = useState<CorrectionWhat | null>(startWhat);
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
  const save = (entry: FeedbackEntry, said: string, whole = false) => {
    feedback.change(withEntry(entries, entry), whole ? said : `${said} It's on your Church rules, where you can change it any time.`);
    setStage(null); setProblem(""); setWhat(null);
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
    {state && urgency && level && (level === "right-away" ? promote : demote) && <p className="small">{URGENCY_NOW[level](target.kind)}</p>}
    {state && always && <p className="small"><Icon name="rules" small /> Prepared because of your Church rule: “{sentence(alwaysText(always, who))}.”</p>}
    {stage === "correct" && <form id={`${id}-form`} className="decide" onSubmit={e => {
      e.preventDefault();
      if (!what) return;
      attempt(() => save(correctionEntry(target, note, now(), what), correctionSaid(what, occasion), true));
    }}>
      {/* What isn't right comes first, and nothing is chosen for the person: only the finding itself hides it. */}
      <fieldset className="plan-report"><legend className="bold">What isn't right?</legend>
        {correctionChoices(target.kind, occasion, source).map((c, i) => <label key={c.what} className="confirmation">
          <input type="radio" name={`${id}-what`} checked={what === c.what} autoFocus={i === 0} onChange={() => { setWhat(c.what); setProblem(""); }} />
          <span><span className="bold">{c.label}</span> <span className="small">{c.effect}</span></span></label>)}
      </fieldset>
      <label className="field-l" htmlFor={`${id}-note`}>What should Ozzie have seen? (optional)</label>
      <input id={`${id}-note`} className="input" value={note} maxLength={NOTE_MAX} placeholder="A few words, for example: they moved to the 11:00 service"
        onChange={e => { setNote(e.target.value); setProblem(""); }} />
      <p className="input-help">Kept on this Mac and never sent to an AI.</p>
      {problem && <p role="alert" className="problem">{problem}</p>}
      <div className="find-next">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!what}>{what === "finding" ? `Hide it ${occasion}` : what ? "Keep it showing and save my note" : "Choose what isn't right"}</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setStage(null); setWhat(null); }}>Never mind</button>
      </div>
    </form>}
    {stage === "stop" && <form id={`${id}-form`} className="decide" onSubmit={e => {
      e.preventDefault();
      const chosen = scopes[scope] ?? scopes[0]!;
      attempt(() => { const entry = stopEntry(target, chosen, now()); save(entry, `Got it. ${stopText(entry, who).replace(/^Don't flag/u, "Ozzie won't flag")}`); });
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
      attempt(() => { const entry = alwaysEntry(target, now()); save(entry, `Got it. ${alwaysText(entry, who).replace(/^Always prepare/u, "Ozzie will always prepare")}`); });
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
  const d = useDay();
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
    <p className="find-body">What you said on findings on {pageRef(d)} and Today. Each applies right away, using what was already read, and to every later check; delete one here any time. Nothing here changes {useSystemWords().name}.</p>
    {!feedback.entries.length && <p className="small">Nothing yet. On a finding, choose “This isn't right”, “Stop flagging this”, “Always do this”, “Always tell me right away” or “Put this in the briefing”, and it shows here.</p>}
    {stops.length > 0 && <><h3 className="bold">Don't flag</h3>
      <ul className="list">{stops.map(e => row(e, stopText(e, who), "Start flagging this again", "Ozzie flags this again, starting now."))}</ul></>}
    {always.length > 0 && <><h3 className="bold">Always do</h3>
      <ul className="list">{always.map(e => row(e, alwaysText(e, who), "Stop doing this", "Ozzie won't prepare that on its own any more."))}</ul></>}
    {urgency.length > 0 && <><h3 className="bold">How Ozzie tells you</h3>
      <ul className="list">{urgency.map(e => row(e, entryText(e, who), "Go back to the usual", `Back to the usual for ${kindWords(e.kind)}.`,
        <span className="small">{URGENCY_NOW[e.level](e.kind, d)}</span>))}</ul></>}
    {corrections.length > 0 && <><h3 className="bold">Corrections you've made</h3>
      <ul className="list">{corrections.map(e => row(e, `${correctionSubject(e, who)}${e.labels.occurrence ? `, ${e.labels.occurrence}` : ""}`, "Delete my correction",
        hidesFinding(e) ? `Your correction is deleted. If Planning Center still shows it, it's back on ${pageRef(d)}.` : "Your note is deleted.",
        <span className="small">{e.note ? `You said: “${e.note}”` : e.what === "person" ? "You said a person's details were wrong." : e.what === "other" ? "You said something else wasn't right." : "You said this wasn't right."} {
          !hidesFinding(e) ? "It still shows." : e.kind === "attention" ? "Hidden for that import only." : "Hidden for that service only, while Planning Center shows the same."}</span>))}</ul></>}
  </section>;
}

/** Where the Sunday page lists what the leader hid. */
export const HIDDEN_BY_YOU = "Hidden by you";
/** Findings the leader hid ("This isn't right", "Stop flagging this"), each with what they said and a way back. */
export function SetAside({ entries, feedback, label = HIDDEN_BY_YOU }: {
  entries: readonly FeedbackEntry[]; feedback: FeedbackControls | null | undefined; label?: string;
}) {
  if (!feedback || !entries.length) return null;
  const unique = [...new Map(entries.map(e => [e.id, e])).values()];
  const who = nameOf(feedback.names);
  return <section className="stack set-aside" aria-label={label}>
    <h2 className="h3">{label}</h2>
    <p className="small">Ozzie still read these. They're hidden because of what you told it, and they're listed on Church rules too; nothing in Planning Center changed.</p>
    <ul className="list">{unique.map(e => <li key={e.id}><Icon name="rules" small /><span>{entryText(e, who)}</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => feedback.change(withoutEntry(feedback.entries, e.id), e.type === "stop" ? "Ozzie will flag this again." : "Your correction is deleted.")}>
        {e.type === "stop" ? "Start flagging this again" : "Show it again"}</button></li>)}</ul>
  </section>;
}
