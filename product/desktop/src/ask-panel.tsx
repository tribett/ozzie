// Ask Ozzie: a question box beside every screen. Everything that decides what may reach the AI
// lives in core/src/ask.ts (facts, question checks, answer checks); this file only shows it.
// Names appear here because this is the leader's own screen; they are never in a request.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  acceptAskReply, ANSWER_PROBLEMS, buildAskContext, MAX_QUESTION_CHARS, prepareAsk, REFUSALS, restoreAnswer, suggestedQuestions,
  type AskAnswer, type AskContext, type AskedQuestion, type AskLink, type AskSession,
} from "../../../core/src/ask.js";
import { evaluateAttentionImport } from "../../../core/src/attention-import/index.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayDecision } from "../../../core/src/sunday-decisions.js";
import { Icon } from "./icons.js";
import { askProblem, model } from "./model.js";

type Names = Record<string, string>;
type Page = "sunday" | "today" | "connection";
type Turn = { id: number; question: string } & (
  | { state: "asking" }
  | { state: "refused"; text: string }
  | { state: "problem"; text: string }
  | { state: "answered"; answer: AskAnswer; asked: AskedQuestion });

export const ASK_NOTE = "Ozzie replaces names from Planning Center before asking the AI. Please don't type other personal details.";
/** A failed native call, as the panel shows it. The native name check refusing is a refusal to reword, not a fault. */
export function askFailure(error: unknown): { state: "refused" | "problem"; text: string } {
  if ((JSON.stringify(error) ?? "").includes("name-present")) return { state: "refused", text: REFUSALS.native };
  return { state: "problem", text: askProblem(error) };
}
const time = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "an unknown time";

export function AskIcon() {
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 5h.01M12 10h.01M15 10h.01" /></svg>;
}

/** "Based on: …": the source and check time behind every answer. */
export function basedOn(context: AskContext): string {
  const b = context.basedOn;
  const sunday = b.mode === "fictional" ? `fictional example data as of ${time(b.checkedAt)}`
    : b.mode === "recording" ? `a saved recording of the Planning Center check at ${time(b.checkedAt)}`
      : `Planning Center check at ${time(b.checkedAt)}`;
  return `Based on: ${sunday}${b.attentionImportedAt ? `, plus the fictional email import` : ""}`;
}
const BasedOn = ({ context }: { context: AskContext }) => <p className="ask-based"><Icon name="check" small />{basedOn(context)}</p>;

function linkText(link: AskLink, names: Names): string {
  const f = link.finding;
  if (!f) return "Today: fictional email import";
  const role = f.position?.name ?? "This Sunday";
  const who = (id: string | undefined) => (id && names[id]) || "Someone on the team";
  switch (f.kind) {
    case "needs-people": return `${role} needs ${f.remaining === 1 ? "one more" : `${f.remaining ?? "more"} more`}`;
    case "lead-missing": return `${role}: no Sunday lead`;
    case "lead-unverified": return `${role}: lead not confirmed`;
    case "pending": return `${who(f.person_id)} pending for ${role}`;
    case "streak": return `${who(f.person_id)}: ${f.sundays ?? "several"} Sundays in a row`;
    default: return "Part of the check";
  }
}

function DraftCard({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="draft ask-draft" role="region" aria-label="Draft note">
    <span className="badge b-draft">Draft only. Nothing has been sent.</span>
    <div className="draft-body">{text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
    <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>
      {copied ? "Copied — send it yourself" : "Copy draft"}</button></div>
  </div>;
}

export function Answer({ answer, asked, names, onOpen }: { answer: AskAnswer; asked: AskedQuestion; names: Names; onOpen: (page: Page) => void }) {
  const [how, setHow] = useState(false);
  const gaps = asked.context.gaps;
  const people = asked.people.size;
  return <div className="body ask-answer">
    {(answer.notCovered || gaps.length > 0) && <div className="stack-tight">
      <span className="badge b-look"><Icon name="eye" small />Worth a look</span>
      {gaps.length > 0 && <ul className="list">{gaps.map(g => <li key={g}><Icon name="dot" small />{g}</li>)}</ul>}
    </div>}
    {answer.body && answer.body.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}
    {answer.draft && <DraftCard text={answer.draft} />}
    <BasedOn context={asked.context} />
    <div className="row ask-links">
      {(answer.links.length ? answer.links : [{ finding: null, page: "sunday", terms: [] } as AskLink]).map((l, i) =>
        <button key={i} type="button" className="src" onClick={() => onOpen(l.page)}>
          <Icon name={l.page === "today" ? "clock" : "sun"} small />{l.finding || l.page === "today" ? linkText(l, names) : "Open Sunday"}</button>)}
    </div>
    <button type="button" className="btn btn-quiet btn-sm ask-how" aria-expanded={how} onClick={() => setHow(!how)}><Icon name="info" small />See how this works</button>
    {how && <p className="small">Ozzie sent the AI your question as “{asked.sent}”, with {asked.request.user.split("\n").length - 1} short facts from the check.
      {people > 0 && ` People appeared only as [Person 1], [Person 2] and so on.`}
      {asked.roles.size > 0 && ` Roles appeared only as [Role 1], [Role 2] and so on.`} Names were put back on this Mac. Nothing was sent to anyone, and nothing in Planning Center changed.</p>}
  </div>;
}

export function AskPanel(props: {
  open: boolean; onClose: () => void; session: AskSession;
  brief: SundayBrief | null; names: Names; organization: string; decisions: readonly SundayDecision[];
  modelReady: boolean; sender: string; onOpen: (page: Page) => void;
  /** The page on screen beside the panel, so it never offers a button to where the person already is. */
  page?: string;
}) {
  const { brief, names, session, modelReady } = props;
  const attention = useMemo(() => { const r = evaluateAttentionImport(harborAttentionImport()); return r.ok ? r : null; }, []);
  // The core only uses the fictional email import beside the fictional Sunday example.
  const context = useMemo(() => buildAskContext(session, { brief, names, organization: props.organization, attention, decisions: props.decisions }),
    [session, brief, names, props.organization, attention, props.decisions]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.open) inputRef.current?.focus(); }, [props.open]);
  // Keep the newest question and its answer in view.
  useEffect(() => { lastRef.current?.scrollIntoView?.({ block: "start" }); }, [turns]);
  const ready = Boolean(context && modelReady);
  const update = (id: number, turn: Partial<Turn> & { state: Turn["state"] }) =>
    setTurns(all => all.map(t => t.id === id ? { ...t, ...turn } as Turn : t));

  const ask = async (typed: string) => {
    if (!context || !modelReady || busy || !typed.trim()) return;
    const id = nextId.current++;
    const prepared = prepareAsk(session, context, typed);
    setInput("");
    if (!prepared.ok) { setTurns(all => [...all, { id, question: typed.trim(), state: "refused", text: prepared.refusal }]); return; }
    setTurns(all => [...all, { id, question: typed.trim(), state: "asking" }]);
    setBusy(true);
    try {
      const reply = await model.ask(prepared.asked.request);
      try {
        update(id, { state: "answered", answer: restoreAnswer(acceptAskReply(reply, prepared.asked), props.sender), asked: prepared.asked });
      } catch (error) {
        update(id, { state: "problem", text: error instanceof Error ? error.message : ANSWER_PROBLEMS.unusable });
      }
    } catch (error) {
      update(id, askFailure(error));
    } finally { setBusy(false); }
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
      {!modelReady && <div className="panel-info"><Icon name="info" /><div className="stack-tight">
        <p>{props.page === "connection" ? "Ask Ozzie needs an AI model. Set one up in Wording help on this page." : "Ask Ozzie needs an AI model. Set one up under Settings."} Everything else works without it.</p>
        {props.page !== "connection" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => props.onOpen("connection")}>Open Settings</button></div>}</div></div>}
      {brief?.mode === "fictional" && <p className="banner dashed"><Icon name="info" small />Fictional example. Answers use invented data.</p>}
      {brief?.mode === "recording" && <p className="banner dashed"><Icon name="clock" small />Saved recording from {time(brief.completed_at)}. Not a current check.</p>}
      {context && turns.length === 0 && <BasedOn context={context} />}
      {turns.map((t, i) => <div key={t.id} className="stack" ref={i === turns.length - 1 ? lastRef : undefined}>
        <div className="msg-me">{t.question}</div>
        <div className="msg-oz"><span className="av"><AskIcon /></span>
          {t.state === "asking" && <div className="body"><p className="small"><Icon name="spinner" small spin /> Reading what Ozzie already has…</p></div>}
          {t.state === "refused" && <div className="body"><p>{t.text}</p>{!/nothing was sent/i.test(t.text) && <p className="small">Nothing was sent.</p>}</div>}
          {t.state === "problem" && <div className="body"><p role="alert" className="problem">{t.text}</p></div>}
          {t.state === "answered" && <Answer answer={t.answer} asked={t.asked} names={names} onOpen={props.onOpen} />}
        </div>
      </div>)}
    </div>
    {chips.length > 0 && <div className={`quick ask-quick${turns.length ? " is-compact" : ""}`} aria-label="Suggested questions">{chips.map(c => <button key={c} type="button" className="chip" onClick={() => { void ask(c); }}>{c}</button>)}</div>}
    <form className="composer" onSubmit={e => { e.preventDefault(); void ask(input); }}>
      <label htmlFor="ask-input" className="sr-only">Your question</label>
      <textarea id="ask-input" ref={inputRef} className="ask-input" rows={2} maxLength={MAX_QUESTION_CHARS} value={input} disabled={!ready || busy}
        placeholder={ready ? "Ask about this Sunday…" : "Ask Ozzie isn't available yet"}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
      <div className="composer-row"><span className="small">{input.length ? `${input.length}/${MAX_QUESTION_CHARS}` : ""}</span><span className="spacer" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!ready || busy || !input.trim()}>{busy ? <Icon name="spinner" small spin /> : null}Ask</button></div>
    </form>
    <p className="small ask-note"><Icon name="lock" small />{ASK_NOTE}</p>
  </aside>;
}
