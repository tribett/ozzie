// Ask Ozzie: a question box beside every screen. Each question runs through the harness
// (harness-bridge.ts askOzzie): the core's placeholder boundary refuses what may not be sent, a
// procedure and fixed read-only tools gather what was read, native agent_step reaches the AI, and
// only an answer verified against what was read is restored on this Mac and shown here.
// Names appear here because this is the leader's own screen; they are never in a request.
// Asking Ozzie to take something on ("Keep an eye on Sunday") is read here without any model
// (core/src/harness/responsibilities.ts parseRequest) and answered with a plan to confirm.
import { useEffect, useRef, useState } from "react";
import { MAX_QUESTION_CHARS, suggestedQuestions } from "../../../core/src/ask.js";
import type { Parsed } from "../../../core/src/harness/responsibilities.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import type { AskTurn, ShownAnswer } from "./harness-bridge.js";
import { ASK_FAILURES, basedOnBrief } from "./harness-words.js";
import { Icon } from "./icons.js";
import { PlanTurn, type PlanActions, type PlanContext } from "./responsibility-views.js";

type Page = "sunday" | "today" | "connection";
type PlanRequest = Exclude<Parsed, { kind: "none" }>;
export type Turn = { id: number; question: string } & ({ state: "asking" } | AskTurn | { state: "plan"; parsed: PlanRequest });
/** Taking something on from Ask: the deterministic reading of a request, and the plan card's needs. */
export interface PlanHooks { parse: (typed: string) => Parsed; context: PlanContext; actions: PlanActions }
/** One question, start to finish. Production: askOzzie over the app's Harness. */
export type AskFn = (typed: string, signal: AbortSignal) => Promise<AskTurn>;

export const ASK_NOTE = "Ozzie replaces the names it read from Planning Center with labels before asking the AI. It can't recognise a name it never read, so please don't type other personal details.";
const time = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "an unknown time";

export function AskIcon() {
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 5h.01M12 10h.01M15 10h.01" /></svg>;
}
const BasedOn = ({ text }: { text: string }) => <p className="ask-based"><Icon name="check" small />{text}</p>;

function DraftCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="draft ask-draft" role="region" aria-label="Draft note">
    <span className="badge b-draft">Draft only. Nothing has been sent.</span>
    <div className="draft-body">{text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
    <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>
      {copied ? "Copied — send it yourself" : "Copy draft"}</button></div>
  </div>;
}

/** "See how this works": the procedure Ozzie followed, verbatim, and the steps it took, in plain words. */
export function HowItWorks({ answer }: { answer: ShownAnswer }) {
  const times = answer.aiSteps === 1 ? "once" : `${answer.aiSteps} times`;
  return <div className="ask-how-body stack-tight">
    {answer.procedure && <>
      <p className="bold">Ozzie followed this procedure: {answer.procedure.title}</p>
      <div className="procedure-body">{answer.procedure.body}</div>
    </>}
    {answer.steps.length > 0 && <>
      <p className="bold">What Ozzie did</p>
      <ol className="list ask-steps">{answer.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
    </>}
    <p className="small">Ozzie asked the AI {times}. The names Ozzie read from Planning Center, and its roles and rooms, reached the AI only as labels such
      as [Person 1] and [Role 1]; Ozzie put them back on this Mac. The AI only chose which facts answer your question: Ozzie wrote every sentence
      here from those facts, in its own order. Nothing was sent to anyone, and nothing in Planning Center changed.</p>
  </div>;
}

export function Answer({ answer, onOpen }: { answer: ShownAnswer; onOpen: (page: Page) => void }) {
  const [how, setHow] = useState(false);
  return <div className="body ask-answer">
    {(answer.notCovered || answer.gaps.length > 0) && <div className="stack-tight">
      <span className="badge b-look"><Icon name="eye" small />Worth a look</span>
      {answer.gaps.length > 0 && <ul className="list">{answer.gaps.map(g => <li key={g}><Icon name="dot" small />{g}</li>)}</ul>}
    </div>}
    {answer.body && answer.body.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
    {answer.draft && <DraftCard text={answer.draft} />}
    <BasedOn text={answer.basedOn} />
    <div className="row ask-links">
      <button type="button" className="src" onClick={() => onOpen(answer.page)}>
        <Icon name={answer.page === "today" ? "clock" : "sun"} small />{answer.page === "today" ? "Open Today" : "Open Sunday"}</button>
    </div>
    <button type="button" className="btn btn-quiet btn-sm ask-how" aria-expanded={how} onClick={() => setHow(!how)}><Icon name="info" small />See how this works</button>
    {how && <HowItWorks answer={answer} />}
  </div>;
}

/** The set-up panel shown when no AI model is set up, in the panel and in a turn. */
function NeedsModel({ page, onOpen }: { page: string | undefined; onOpen: (page: Page) => void }) {
  return <div className="panel-info"><Icon name="info" /><div className="stack-tight">
    <p>{page === "connection" ? "Ask Ozzie needs an AI model. Set one up in Wording help on this page." : "Ask Ozzie needs an AI model. Set one up under Settings."} Everything else works without it.</p>
    {page !== "connection" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("connection")}>Open Settings</button></div>}</div></div>;
}

/** Ozzie's side of one question. */
export function TurnBody({ turn, page, onOpen, plans }: { turn: Turn; page?: string | undefined; onOpen: (page: Page) => void; plans?: PlanHooks | undefined }) {
  switch (turn.state) {
    case "plan": return plans ? <div className="body"><PlanTurn parsed={turn.parsed} context={plans.context} actions={plans.actions} /></div> : null;
    case "asking": return <div className="body"><p className="small"><Icon name="spinner" small spin /> Reading what Ozzie already has…</p></div>;
    case "refused": return <div className="body"><p>{turn.text}</p>{!/nothing was sent/i.test(turn.text) && <p className="small">Nothing was sent.</p>}</div>;
    case "no-model": return <div className="body"><NeedsModel page={page} onOpen={onOpen} /></div>;
    case "cancelled": return <div className="body"><p className="small">{turn.text}</p></div>;
    case "problem": return <div className="body"><p role="alert" className="problem">{turn.text}</p></div>;
    case "answered": return <Answer answer={turn.answer} onOpen={onOpen} />;
  }
}

export function AskPanel(props: {
  open: boolean; onClose: () => void;
  /** Null until Ozzie's procedures are loaded. */
  ask: AskFn | null;
  brief: SundayBrief | null;
  modelReady: boolean; onOpen: (page: Page) => void;
  /** The page on screen beside the panel, so it never offers a button to where the person already is. */
  page?: string;
  /** Turns to start with (tests and restored views). */
  initialTurns?: Turn[];
  /** Taking something on ("Keep an eye on Sunday"): needs no AI model and nothing checked yet. */
  plans?: PlanHooks;
}) {
  const { brief, modelReady } = props;
  const [turns, setTurns] = useState<Turn[]>(props.initialTurns ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(() => (props.initialTurns ?? []).some(t => t.state === "asking"));
  const nextId = useRef(1 + Math.max(0, ...(props.initialTurns ?? []).map(t => t.id)));
  const running = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.open) inputRef.current?.focus(); }, [props.open]);
  // Keep the newest question and its answer in view.
  useEffect(() => { lastRef.current?.scrollIntoView?.({ block: "start" }); }, [turns]);
  // A question still running when the panel goes away is stopped.
  useEffect(() => () => running.current?.abort(), []);
  const ready = Boolean(brief && modelReady && props.ask);
  const canType = ready || Boolean(props.plans);
  const update = (id: number, turn: AskTurn) => setTurns(all => all.map(t => t.id === id ? { id, question: t.question, ...turn } as Turn : t));

  const ask = async (typed: string) => {
    if (!canType || busy || !typed.trim()) return;
    // A request to take something on becomes a plan to confirm. Nothing is sent anywhere.
    const parsed = props.plans?.parse(typed) ?? { kind: "none" as const };
    if (parsed.kind !== "none") {
      setInput("");
      setTurns(all => [...all, { id: nextId.current++, question: typed.trim(), state: "plan", parsed }]);
      return;
    }
    if (!ready || !props.ask) {
      setInput("");
      setTurns(all => [...all, !modelReady ? { id: nextId.current++, question: typed.trim(), state: "no-model" }
        : { id: nextId.current++, question: typed.trim(), state: "refused", text: "Nothing has been checked yet. Check Planning Center on the Sunday page first. Nothing was sent." }]);
      return;
    }
    const id = nextId.current++;
    const controller = new AbortController();
    running.current = controller;
    setInput("");
    setTurns(all => [...all, { id, question: typed.trim(), state: "asking" }]);
    setBusy(true);
    try { update(id, await props.ask(typed, controller.signal)); }
    catch { update(id, { state: "problem", code: null, text: ASK_FAILURES.unfinished }); }
    finally { if (running.current === controller) running.current = null; setBusy(false); }
  };

  const chips = ready && !busy ? suggestedQuestions(brief) : [];
  return <aside id="ask-panel" className="convo ask-panel" aria-label="Ask Ozzie" hidden={!props.open}
    onKeyDown={e => { if (e.key === "Escape") props.onClose(); }}>
    <div className="convo-head"><AskIcon />Ask Ozzie<span className="spacer" />
      <button type="button" className="ibtn" aria-label="Close Ask Ozzie" onClick={props.onClose}><Icon name="x" /></button></div>
    <div className="thread ask-thread" aria-live="polite">
      <p className="small">Ask about what Ozzie has already read. Ozzie prepares and explains; you decide.</p>
      {/* No button to the page already on screen. */}
      {!brief && <div className="panel-info"><Icon name="info" /><div className="stack-tight">
        <p>Nothing has been checked yet. Check Planning Center on the Sunday page, or open the fictional example there.</p>
        {props.page !== "sunday" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => props.onOpen("sunday")}>Open Sunday</button></div>}</div></div>}
      {!modelReady && <NeedsModel page={props.page} onOpen={props.onOpen} />}
      {brief?.mode === "fictional" && <p className="banner dashed"><Icon name="info" small />Fictional example. Answers use invented data.</p>}
      {brief?.mode === "recording" && <p className="banner dashed"><Icon name="clock" small />Saved recording from {time(brief.completed_at)}. Not a current check.</p>}
      {brief && turns.length === 0 && <BasedOn text={basedOnBrief(brief)} />}
      {turns.map((t, i) => <div key={t.id} className="stack" ref={i === turns.length - 1 ? lastRef : undefined}>
        <div className="msg-me">{t.question}</div>
        <div className="msg-oz"><span className="av"><AskIcon /></span><TurnBody turn={t} page={props.page} onOpen={props.onOpen} plans={props.plans} /></div>
      </div>)}
    </div>
    {chips.length > 0 && <div className={`quick ask-quick${turns.length ? " is-compact" : ""}`} aria-label="Suggested questions">{chips.map(c => <button key={c} type="button" className="chip" onClick={() => { void ask(c); }}>{c}</button>)}</div>}
    <form className="composer" onSubmit={e => { e.preventDefault(); void ask(input); }}>
      <label htmlFor="ask-input" className="sr-only">Your question</label>
      <textarea id="ask-input" ref={inputRef} className="ask-input" rows={2} maxLength={MAX_QUESTION_CHARS} value={input} disabled={!canType || busy}
        placeholder={ready ? "Ask about this Sunday…" : canType ? "Ask Ozzie to keep an eye on something…" : "Ask Ozzie isn't available yet"}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
      <div className="composer-row"><span className="small">{input.length ? `${input.length}/${MAX_QUESTION_CHARS}` : ""}</span><span className="spacer" />
        {busy && <button type="button" className="btn btn-secondary btn-sm" onClick={() => running.current?.abort()}>Cancel this question</button>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canType || busy || !input.trim()}>{busy ? <Icon name="spinner" small spin /> : null}Ask</button></div>
    </form>
    <p className="small ask-note"><Icon name="lock" small />{ASK_NOTE}</p>
  </aside>;
}
