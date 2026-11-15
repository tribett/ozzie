// Ask Ozzie: a question box beside every screen. Each question runs through the harness
// (harness-bridge.ts askOzzie): the core's placeholder boundary refuses what may not be sent, a
// procedure and fixed read-only tools gather what was read, native agent_step reaches the AI, and
// only an answer verified against what was read is restored on this Mac and shown here.
// Names appear here because this is the leader's own screen; they are never in a request.
// Asking Ozzie to take something on ("Keep an eye on Sunday") is read here without any model
// (core/src/harness/responsibilities.ts parseRequest) and answered with a plan to confirm.
// Ask is useful before anything is connected (owner decisions, 2026-11-15): "What can you do?" is answered here in
// fixed words, and a question before anything was read says what to do next, never an error.
import { useEffect, useRef, useState } from "react";
import { MAX_QUESTION_CHARS, suggestedQuestions } from "../../../core/src/ask.js";
import { kidsWording } from "../../../core/src/harness/compose.js";
import type { Parsed } from "../../../core/src/harness/responsibilities.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import type { AskTurn, ShownAnswer } from "./harness-bridge.js";
import { ADDED_HOW, ASK_FAILURES, ASK_LOADING, ASK_START, basedOnBrief, HELP, LOCAL_HOW, LOCAL_NOTE } from "./harness-words.js";
import { Icon } from "./icons.js";
import { DraftActions, type OpenDraft } from "./draft-actions.js";
import { PlanTurn, type PlanActions, type PlanContext } from "./responsibility-views.js";
import { isVoiceShortcut, listenInto, LISTENING_NOTE, nativeVoice, VOICE_HINT, VOICE_SHORTCUT, voiceOff, type Voice, type VoiceStatus } from "./voice.js";

type Page = "sunday" | "today" | "connection" | "cards";
type PlanRequest = Exclude<Parsed, { kind: "none" }>;
type TurnState = { state: "asking" } | AskTurn | { state: "plan"; parsed: PlanRequest } | { state: "cards" } | { state: "help"; checked: boolean } | { state: "start" };
export type Turn = { id: number; question: string } & TurnState;
/** Taking something on from Ask: the deterministic reading of a request, and the plan card's needs. */
export interface PlanHooks { parse: (typed: string) => Parsed; context: PlanContext; actions: PlanActions }
/** One question, start to finish. Production: askOzzie over the app's Harness. */
export type AskFn = (typed: string, signal: AbortSignal) => Promise<AskTurn>;

/**
 * Visitor, newcomer or guest cards are read on the Visitor cards page, on this Mac. Ask points
 * there without any AI model: the question isn't sent anywhere.
 */
export const isCardsRequest = (typed: string) => /\b(?:visitor|newcomer|guest|welcome|connect(?:ion)?)\s+cards?\b/i.test(typed);
export const CARDS_POINTER = "Visitor cards are read on this Mac, on the Visitor cards page: choose the photos there and check each card against its photo. Nothing from them goes to an AI model or into Planning Center.";

/** "What can you do?", "help", "How do you work?" and the like, as the whole question: answered here in fixed words. */
const HELP_ASK = new RegExp("^(?:(?:hey|hi|ok|okay)[\\s,]+)?(?:ozzie[\\s,:]+)?(?:help|what\\s+can\\s+(?:you|ozzie)\\s+(?:do|help\\s+(?:me\\s+)?with)(?:\\s+for\\s+(?:me|us))?(?:\\s+here)?" +
  "|what\\s+can\\s+i\\s+ask(?:\\s+(?:you|ozzie))?|what\\s+do\\s+you\\s+do|what\\s+does\\s+ozzie\\s+do|how\\s+do\\s+(?:you|i)\\s+(?:work|use\\s+(?:you|this|ozzie))|how\\s+does\\s+(?:this|ozzie)\\s+work" +
  "|how\\s+can\\s+you\\s+help(?:\\s+(?:me|us))?|what\\s+are\\s+you|who\\s+are\\s+you)(?:[\\s,]+ozzie)?[\\s?.!]*$", "iu");
export const isHelpRequest = (typed: string) => HELP_ASK.test(typed.trim());
export const HELP_CHIP = "What can you do?";

/** Where a typed question goes, decided here without any model. */
export type Route = { kind: "help" } | { kind: "cards" } | { kind: "plan"; parsed: PlanRequest } | { kind: "start" } | { kind: "no-model" } | { kind: "loading" } | { kind: "ask" };
export function routeQuestion(typed: string, s: {
  brief: SundayBrief | null; modelReady: boolean;
  /** Ozzie's procedures are loaded, so a question can run. */
  canAsk: boolean;
  parse?: ((typed: string) => Parsed) | undefined;
}): Route {
  if (isHelpRequest(typed)) return { kind: "help" };
  // Cards are read on their own page, on this Mac.
  if (isCardsRequest(typed)) return { kind: "cards" };
  // A request to take something on becomes a plan to confirm.
  const parsed = s.parse?.(typed) ?? { kind: "none" as const };
  if (parsed.kind !== "none") return { kind: "plan", parsed };
  if (!s.brief) return { kind: "start" };
  // Kids teams and background checks are answered on this Mac (harness-bridge askOzzie), so they need no AI model.
  if (!s.modelReady) return s.canAsk && kidsWording(typed) ? { kind: "ask" } : { kind: "no-model" };
  return s.canAsk ? { kind: "ask" } : { kind: "loading" };
}

export const ASK_NOTE = "Ozzie replaces the names it read from Planning Center with labels before asking the AI. It can't recognise a name it never read, so please don't type other personal details.";
const time = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "an unknown time";

export function AskIcon() {
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4v-4H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Zm4 5h.01M12 10h.01M15 10h.01" /></svg>;
}
function MicIcon() {
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm-6-3a6 6 0 0 0 12 0M12 18v3m-3 0h6" /></svg>;
}
const BasedOn = ({ text }: { text: string }) => <p className="ask-based"><Icon name="check" small />{text}</p>;

/** A drafted note in an answer: copy it, or open it unsent in Mail or Messages for the person to send. */
export function DraftCard({ text, open }: { text: string; open?: OpenDraft | undefined }) {
  const [copied, setCopied] = useState(false);
  return <div className="draft ask-draft" role="region" aria-label="Draft note">
    <span className="badge b-draft">Draft only. Nothing has been sent.</span>
    <div className="draft-body">{text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)}</div>
    <DraftActions text={text} small split open={open}
      copy={<button type="button" className="btn btn-secondary btn-sm" onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopied(true)); }}>
        {copied ? "Copied — send it yourself" : "Copy draft"}</button>} />
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
    {answer.local ? <p className="small">{LOCAL_HOW}</p>
      : <p className="small">Ozzie asked the AI {times}. The names Ozzie read from Planning Center, and its roles and rooms, reached the AI only as labels such
        as [Person 1] and [Role 1]; Ozzie put them back on this Mac. The AI only chose which facts answer your question: Ozzie wrote every sentence
        here from those facts, in its own order. Nothing was sent to anyone, and nothing in Planning Center changed.</p>}
    {answer.added && <p className="small">{ADDED_HOW}</p>}
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
    {answer.local && <p className="small">{LOCAL_NOTE}</p>}
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
    <p>{page === "connection" ? "Ask Ozzie needs an AI model. Set one up in AI help on this page." : "Ask Ozzie needs an AI model. Set one up under Settings."} Everything else works without it.</p>
    {page !== "connection" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("connection")}>Open Settings</button></div>}</div></div>;
}

/**
 * What VoiceOver hears when a turn settles: one short status, not the whole thread. An answer is read as its words (it
 * is this person's own screen); the procedure, steps and draft stay on screen to move through, and are never re-read
 * when they open.
 */
export function turnAnnouncement(turn: Turn | undefined): string {
  if (!turn) return "";
  switch (turn.state) {
    case "asking": return "Reading what Ozzie already has…";
    case "plan": return "Ozzie prepared a plan. Nothing starts until you confirm it.";
    case "cards": return "Visitor cards are read on the Visitor cards page, on this Mac.";
    case "help": return "Ozzie listed what it can do here. Nothing was sent.";
    case "start": return ASK_START;
    case "no-model": return "Ask Ozzie needs an AI model. Set one up under Settings.";
    case "refused": case "problem": case "cancelled": return turn.text;
    case "answered": {
      const a = turn.answer;
      const first = a.body.split(/\n{2,}/u)[0]?.trim() ?? "";
      const more = [a.notCovered || a.gaps.length ? "Worth a look." : "", a.draft ? "A draft note is below." : ""].filter(Boolean).join(" ");
      return [first ? `Ozzie answered: ${first}` : "Ozzie answered.", more].filter(Boolean).join(" ");
    }
  }
}

/** Where to go first when nothing has been read: Settings to connect, Sunday to check. Never a button to the page already on screen. */
function NextSteps({ page, onOpen }: { page: string | undefined; onOpen: (page: Page) => void }) {
  return <div className="row">
    {page !== "connection" && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("connection")}>Open Settings</button>}
    {page !== "sunday" && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("sunday")}>Open Sunday</button>}
  </div>;
}

/** Ozzie's side of one question. */
export function TurnBody({ turn, page, onOpen, plans }: { turn: Turn; page?: string | undefined; onOpen: (page: Page) => void; plans?: PlanHooks | undefined }) {
  switch (turn.state) {
    case "plan": return plans ? <div className="body"><PlanTurn parsed={turn.parsed} context={plans.context} actions={plans.actions} /></div> : null;
    case "cards": return <div className="body"><p>{CARDS_POINTER}</p>
      {page !== "cards" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("cards")}><Icon name="user" small />Open Visitor cards</button></div>}</div>;
    case "help": return <div className="body stack-tight">
      <p>{HELP.intro}</p>
      <ul className="list">{HELP.can.map(c => <li key={c}><Icon name="dot" small />{c}</li>)}</ul>
      <p>{HELP.never}</p>
      {turn.checked ? <p className="small">{HELP.try}</p> : <><p>{HELP.first}</p><NextSteps page={page} onOpen={onOpen} /></>}
      <p className="small">Nothing was sent.</p></div>;
    case "start": return <div className="body stack-tight"><p>{ASK_START}</p><NextSteps page={page} onOpen={onOpen} /><p className="small">Nothing was sent.</p></div>;
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
  /** Speaking a question on this Mac. Production: the native listener. */
  voice?: Voice;
  /** Whether listening is possible, before the check (tests and restored views). */
  initialVoice?: VoiceStatus;
}) {
  const { brief, modelReady } = props;
  const voice = props.voice ?? nativeVoice;
  const [turns, setTurns] = useState<Turn[]>(props.initialTurns ?? []);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(() => (props.initialTurns ?? []).some(t => t.state === "asking"));
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus | null>(props.initialVoice ?? null);
  const [listening, setListening] = useState<"no" | "on" | "ending">("no");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const listeningRef = useRef(false);
  const nextId = useRef(1 + Math.max(0, ...(props.initialTurns ?? []).map(t => t.id)));
  const running = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.open) inputRef.current?.focus(); }, [props.open]);
  // Keep the newest question and its answer in view.
  useEffect(() => { lastRef.current?.scrollIntoView?.({ block: "start" }); }, [turns]);
  // A question still running when the panel goes away is stopped.
  useEffect(() => () => running.current?.abort(), []);
  // Each time Ask opens: can this Mac listen? (Checking never asks the person anything.)
  // Closing Ask while listening stops it and keeps nothing.
  useEffect(() => {
    if (!props.open) { if (listeningRef.current) void voice.cancel().catch(() => undefined); return; }
    let live = true;
    voice.status().then(s => { if (live) setVoiceStatus(s); }, () => { if (live) setVoiceStatus({ status: "not-available" }); });
    return () => { live = false; };
  }, [props.open, voice]);
  useEffect(() => () => { if (listeningRef.current) void voice.cancel().catch(() => undefined); }, [voice]);
  const ready = Boolean(brief && modelReady && props.ask);
  // Something can always be asked once Ozzie is loaded (the app always can take something on): what Ozzie can do, a
  // plan, or, once something is read, a question about it.
  const canType = ready || Boolean(props.plans) || Boolean(props.ask);
  const micUsable = canType && !busy && voiceStatus?.status === "ready";
  const update = (id: number, turn: AskTurn) => setTurns(all => all.map(t => t.id === id ? { id, question: t.question, ...turn } as Turn : t));

  /** The microphone button and ⌘⇧L: start listening, or finish. The words only fill the box. */
  const toggleVoice = async () => {
    if (listening === "on") { setListening("ending"); void voice.stop().catch(() => undefined); return; }
    if (listening !== "no" || !micUsable) return;
    const before = input;
    listeningRef.current = true;
    setVoiceNote(null);
    setListening("on");
    const after = await listenInto(voice, before, setInput);
    listeningRef.current = false;
    setListening("no");
    setInput(after.text);
    setVoiceNote(after.note);
    if (after.status) setVoiceStatus(after.status);
    const box = inputRef.current;
    if (box && after.text !== before) { box.focus(); box.setSelectionRange?.(after.text.length, after.text.length); }
  };

  const ask = async (typed: string) => {
    if (!canType || busy || listening !== "no" || !typed.trim()) return;
    setVoiceNote(null);
    const question = typed.trim();
    const route = routeQuestion(typed, { brief, modelReady, canAsk: Boolean(props.ask), parse: props.plans?.parse });
    // Everything but a question about what was read is answered here, without any model. Nothing is sent anywhere.
    const local = (turn: TurnState) => {
      const id = nextId.current++;
      setInput("");
      setTurns(all => [...all, { id, question, ...turn }]);
    };
    switch (route.kind) {
      case "help": return local({ state: "help", checked: Boolean(brief) });
      case "cards": return local({ state: "cards" });
      case "plan": return local({ state: "plan", parsed: route.parsed });
      case "start": return local({ state: "start" });
      case "no-model": return local({ state: "no-model" });
      case "loading": return local({ state: "refused", text: ASK_LOADING });
      case "ask": break;
    }
    if (!props.ask) return;
    const id = nextId.current++;
    const controller = new AbortController();
    running.current = controller;
    setInput("");
    setTurns(all => [...all, { id, question, state: "asking" }]);
    setBusy(true);
    try { update(id, await props.ask(typed, controller.signal)); }
    catch { update(id, { state: "problem", code: null, text: ASK_FAILURES.unfinished }); }
    finally { if (running.current === controller) running.current = null; setBusy(false); }
  };

  const chips = !canType || busy || listening !== "no" ? [] : ready ? suggestedQuestions(brief) : [HELP_CHIP];
  const off = voiceOff(voiceStatus);
  const voiceLine = listening === "on" ? LISTENING_NOTE : listening === "ending" ? "Finishing the last words…"
    : voiceNote ?? off ?? (voiceStatus?.status === "ready" && canType ? VOICE_HINT : null);
  return <aside id="ask-panel" className="convo ask-panel" aria-label="Ask Ozzie" hidden={!props.open}
    onKeyDown={e => {
      if (e.key === "Escape") props.onClose();
      else if (isVoiceShortcut(e)) { e.preventDefault(); void toggleVoice(); }
    }}>
    <div className="convo-head"><AskIcon />Ask Ozzie<span className="spacer" />
      <button type="button" className="ibtn" aria-label="Close Ask Ozzie" onClick={props.onClose}><Icon name="x" /></button></div>
    <div className="thread ask-thread">
      <p className="small">Ask about what Ozzie has already read. Ozzie prepares and explains; you decide.</p>
      {/* No button to the page already on screen. */}
      {!brief && <div className="panel-info"><Icon name="info" /><div className="stack-tight">
        <p>Nothing has been checked yet. Connect Planning Center in Settings, or check Planning Center on the Sunday page. You can also open the fictional example there, or ask what Ozzie can do.</p>
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
        readOnly={listening !== "no"}
        placeholder={listening !== "no" ? "Listening…" : ready ? "Ask about this Sunday…" : props.plans ? "Ask Ozzie to keep an eye on something…"
          : canType ? "Ask what Ozzie can do…" : "Ask Ozzie isn't available yet"}
        onChange={e => { setInput(e.target.value); setVoiceNote(null); }}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(input); } }} />
      <div className="composer-row"><span className="small">{input.length ? `${input.length}/${MAX_QUESTION_CHARS}` : ""}</span><span className="spacer" />
        {busy && <button type="button" className="btn btn-secondary btn-sm" onClick={() => running.current?.abort()}>Cancel this question</button>}
        <button type="button" className={`ibtn ask-mic${listening !== "no" ? " is-on" : ""}`}
          aria-label={listening !== "no" ? "Stop listening" : "Speak your question"}
          aria-keyshortcuts={VOICE_SHORTCUT} aria-describedby="ask-voice-line"
          title={listening !== "no" ? "Stop listening (⌘⇧L)" : "Speak your question (⌘⇧L)"}
          disabled={listening === "ending" || (listening === "no" && !micUsable)} onClick={() => { void toggleVoice(); }}><MicIcon /></button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canType || busy || listening !== "no" || !input.trim()}>{busy ? <Icon name="spinner" small spin /> : null}Ask</button></div>
    </form>
    <p className="small ask-voice" id="ask-voice-line" role="status" aria-live="polite">{voiceLine ?? ""}</p>
    <p className="sr-only" role="status" aria-live="polite">{props.open ? turnAnnouncement(turns.at(-1)) : ""}</p>
    <p className="small ask-note"><Icon name="lock" small />{ASK_NOTE}</p>
  </aside>;
}
