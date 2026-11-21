// Ask Ozzie: a question box beside every screen. Each question runs through the harness
// (harness-bridge.ts askOzzie): the core's placeholder boundary refuses what may not be sent, a
// procedure and fixed read-only tools gather what was read, native agent_step reaches the AI, and
// only an answer verified against what was read is restored on this Mac and shown here.
// Names appear here because this is the leader's own screen; they are never in a request.
// Asking Ozzie to take something on ("Keep an eye on Sunday") is read here without any model
// (core/src/harness/responsibilities.ts parseRequest) and answered with a plan to confirm.
// Ask is useful before anything is connected (owner decisions, 2026-11-15): "What can you do?" is answered here in
// fixed words, and a question before anything was read says what to do next, never an error.
//
// Ask is one surface, not the product (audit item 8): it opens when the leader chooses, and each answer is a card in
// the same language as a finding (the question, Ozzie's sentences, where the facts came from and when, and "See how
// this works" with the steps), not a thread of chat bubbles. Earlier questions this session stay as a short list of
// cards to reopen. Once there is an answer, the two notes about Ask fold away so the answer stays in view at any zoom.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import "./ask-panel.css";
import { MAX_QUESTION_CHARS, onDayPage, suggestedQuestions } from "../../../core/src/ask.js";
import { kidsWording } from "../../../core/src/harness/compose.js";
import type { Parsed } from "../../../core/src/harness/responsibilities.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import type { DayWords } from "../../../core/src/service-day.js";
import type { AskTurn, ShownAnswer } from "./harness-bridge.js";
import {
  addedHow, aiText, ASK_FAILURES, ASK_LOADING, ASK_START, basedOnBrief, COMPOSED_ENDED, composedHow, composedNote, HELP, HELP_SERVICES, LOCAL_HOW, LOCAL_NOTE, neverElsewhere, procedureTitle, type Account,
} from "./harness-words.js";
import { TaskAccount } from "./activity-page.js";
import { ChooseAiButton, ChooseAiContext } from "./ai-line.js";
import { NEEDS_AI } from "./ai-words.js";
import { Icon } from "./icons.js";
import { DayProvider, useDay } from "./day-words.js";
import { OPEN_SERVICES, pageRef, SERVICES } from "./day-phrases.js";
import { ProcedureBody } from "./procedure-text.js";
import { DraftActions, type OpenDraft } from "./draft-actions.js";
import { PlanTurn, type PlanActions, type PlanContext } from "./responsibility-views.js";
import { useSystemWords, type SystemWords } from "./church-system.js";
import { MANY_SERVICES, watchesSeveral } from "./services-merge.js";
import { isVoiceShortcut, listenInto, LISTENING_NOTE, nativeVoice, VOICE_HINT, VOICE_SHORTCUT, voiceOff, type Voice, type VoiceStatus } from "./voice.js";

type Page = "sunday" | "today" | "connection" | "cards";
/** "See how this works" for an answer the AI chose the facts of (Planning Center's words; another system's name in its place). */
const MODEL_HOW = "The names Ozzie read from Planning Center, and its roles and rooms, reached the AI only as labels such as [Person 1] and [Role 1]; " +
  "Ozzie put them back on this Mac. The AI only chose which facts answer your question: Ozzie wrote every sentence here from those facts, in its own order. " +
  "Nothing was sent to anyone, and nothing in Planning Center changed.";
/**
 * "What can you do?" in the church's own system's words: Planning Center's list unchanged; for B1 Church or Breeze, only
 * what Ozzie does with it (no kids teams, background checks, rooms or follow-ups; who could help only where the system
 * ties a team to each role).
 */
export function helpFor(w: SystemWords, several = false): { intro: string; can: readonly string[]; never: string; try: string; first: string } {
  // Several services are watched only on Planning Center: its two lines about the service then say "services".
  if (w.system === "planning-center" && !w.unchosen) {
    return several ? { ...HELP, can: HELP.can.map((c, i) => i === 0 ? HELP_SERVICES.check : i === 3 ? HELP_SERVICES.keep : c), try: HELP_SERVICES.try } : HELP;
  }
  // Nothing chosen yet (a fresh Mac): Planning Center's list, never "from what it reads in Planning Center" (release review L5).
  if (w.unchosen) return { ...HELP, intro: w.say(HELP.intro), never: w.say(HELP.never), first: w.say(HELP.first) };
  // Genesis shares no volunteer schedules (round 5): what Ozzie answers from it, all on this Mac.
  if (w.system === "genesis") return {
    intro: "Here is what Ozzie can do for you, from what it reads in Genesis:", never: neverElsewhere(w.name), first: w.say(HELP.first),
    try: "You could ask “What events are coming up?” or “How many times was each form filled in?”.",
    can: [
      "Show the events of the next four weeks, and how many attended the ones just past.",
      "Show how many times each form was filled in, and say when one is filled in again.",
      "Show your groups.",
      "Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered or who is serving.",
      HELP.can[5]!,
    ],
  };
  return {
    intro: w.say(HELP.intro), never: neverElsewhere(w.name), first: w.say(HELP.first),
    // Where no team is tied to roles (Breeze), what works there instead of who could help (round 5).
    try: w.noTeam ? "You could ask “Who is scheduled?” or “Who hasn't answered yet?”, or say “Keep an eye on the service”." : HELP.try,
    can: [
      "Check the service Ozzie watches: open roles, who answered, and anything that needs a decision.",
      ...(w.noTeam ? ["Show who is on each role, who said yes, who hasn't answered yet and who said no."] : [HELP.can[1]!]),
      HELP.can[2]!,
      "Keep an eye on the service and tell you privately when something changes.",
      HELP.can[5]!,
    ],
  };
}
type PlanRequest = Exclude<Parsed, { kind: "none" }>;
type TurnState = { state: "asking" } | AskTurn | { state: "plan"; parsed: PlanRequest } | { state: "cards" } | { state: "help"; checked: boolean } | { state: "start" };
/**
 * `several`: more than one Planning Center service was watched when it was asked (services-merge.ts MANY_SERVICES), kept
 * with the turn so a card reopened later says what was true then: its help list, its procedure and its notes say "services".
 */
export type Turn = { id: number; question: string; several?: boolean } & TurnState;
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
/** The line at the top of Ask before any question. */
export const ASK_INTRO = "Ask about what Ozzie has already read. Ozzie prepares and explains; you decide.";
/** Once there is an answer, the two notes above fold under this. */
export const ASK_ABOUT = "About Ask and the names Ozzie reads";
/** Earlier questions this session, newest first: at most this many are listed. */
export const EARLIER_SHOWN = 8;
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

/** An answer's steps as the same short account What happened gives (audit items 7 and 8). */
export function answerAccount(answer: ShownAnswer): Account {
  // Written by Ozzie after the AI's answer was set aside: the AI was asked, but it chose none of this.
  if (answer.composedHere) return { started: "You asked a question.", looked: answer.steps, ai: aiText("ask", undefined, answer.aiSteps, false), ended: COMPOSED_ENDED };
  const ended = answer.local ? "Answered on this Mac." : answer.end === "nothing-needs-a-decision" ? "Nothing needed a decision."
    : answer.end === "not-covered" || answer.notCovered ? "What Ozzie read didn't answer it, and the answer says so."
      : answer.end === "draft" ? "Answered with a draft note for you to read and send yourself." : "Answered.";
  return { started: "You asked a question.", looked: answer.steps, ai: aiText("ask", answer.local ? "on-this-mac" : undefined, answer.aiSteps, true), ended };
}

/**
 * Every service's day words while more than one is watched (services-merge.ts MANY_SERVICES; AskPanel provides them): an
 * answer covers them all, so the procedure it followed is named, and the line above its exact text and the note under an
 * answer Ozzie wrote itself speak, for every service, never for the first one's day. Null with one service. Only these
 * read it: a plan card in Ask keeps the page's own words.
 */
const AnswerServices = createContext<DayWords | null>(null);

/** "See how this works": the procedure Ozzie followed, verbatim, and the steps it took, in plain words. */
export function HowItWorks({ answer }: { answer: ShownAnswer }) {
  const page = useDay();
  const day = useContext(AnswerServices) ?? page;
  // The church's own system where these say where the names came from (Planning Center's words unchanged).
  const { say } = useSystemWords();
  return <div className="ask-how-body stack-tight">
    {answer.procedure && <>
      <p className="bold">Ozzie followed this procedure: {procedureTitle(answer.procedure.title, day) ?? answer.procedure.title}</p>
      <DayProvider value={day}><ProcedureBody body={answer.procedure.body} /></DayProvider>
    </>}
    <TaskAccount account={answerAccount(answer)} />
    {answer.local ? <p className="small">{say(LOCAL_HOW)}</p>
      : answer.composedHere ? <p className="small">{say(composedHow(day))}</p>
      : <p className="small">{say(MODEL_HOW)}</p>}
    {answer.added && <p className="small">{addedHow(day)}</p>}
  </div>;
}

/** An answer as a finding reads: what wasn't complete first, Ozzie's sentences, any draft, where it came from and when. */
export function Answer({ answer, onOpen }: { answer: ShownAnswer; onOpen: (page: Page) => void }) {
  const [how, setHow] = useState(false);
  // Fixed lines that point to "the Sunday page" name the watched service's own page (onboarding spec §5).
  const d = useDay(), services = useContext(AnswerServices);
  return <div className="body ask-answer">
    {(answer.notCovered || answer.gaps.length > 0) && <div className="stack-tight">
      <span className="badge b-look"><Icon name="eye" small />Worth a look</span>
      {answer.gaps.length > 0 && <ul className="list">{answer.gaps.map(g => <li key={g}><Icon name="dot" small />{onDayPage(g, d)}</li>)}</ul>}
    </div>}
    {/* A line ending in a colon heads the lines under it ("Needs a decision:", "On the Sunday page, needing a decision:"). */}
    {answer.body && <div className="ask-lines">{onDayPage(answer.body, d).split(/\n{2,}/).map((p, i) => <p key={i} className={p.endsWith(":") ? "ask-group" : undefined}>{p}</p>)}</div>}
    {answer.local && <p className="small">{LOCAL_NOTE}</p>}
    {answer.composedHere && <p className="small">{composedNote(services ?? d)}</p>}
    {answer.draft && <DraftCard text={answer.draft} />}
    <div className="ask-src">
      <BasedOn text={answer.basedOn} />
      <div className="row ask-links">
        <button type="button" className="src" onClick={() => onOpen(answer.page)}>
          <Icon name={answer.page === "today" ? "clock" : "sun"} small />{answer.page === "today" ? "Open Today" : OPEN_SERVICES}</button>
      </div>
    </div>
    <button type="button" className="btn btn-quiet btn-sm ask-how" aria-expanded={how} onClick={() => setHow(!how)}><Icon name="info" small />See how this works</button>
    {how && <HowItWorks answer={answer} />}
  </div>;
}

/** The badge on a question's card: what kind of reply it is, in a word or two. */
function cardBadge(turn: Turn): { label: string; tone: string } {
  switch (turn.state) {
    case "answered": return turn.answer.notCovered || turn.answer.gaps.length ? { label: "Worth a look", tone: "b-look" }
      : { label: turn.answer.local ? "Answered on this Mac" : "Answered", tone: "b-ok" };
    case "asking": return { label: "Reading…", tone: "b-muted" };
    case "help": return { label: "What Ozzie can do", tone: "b-muted" };
    case "cards": return { label: "Visitor cards", tone: "b-muted" };
    case "start": return { label: "Nothing read yet", tone: "b-muted" };
    case "no-model": return { label: NEEDS_AI.badge, tone: "b-muted" };
    case "refused": return { label: "Not sent", tone: "b-muted" };
    case "cancelled": return { label: "Stopped", tone: "b-muted" };
    case "problem": return { label: "Couldn't answer", tone: "b-attn" };
    case "plan": return { label: "Plan", tone: "b-muted" };
  }
}

/** One question and Ozzie's reply, as a card. A plan is its own card already, under the words that asked for it. */
export function AskCard({ turn, page, onOpen, plans }: { turn: Turn; page?: string | undefined; onOpen: (page: Page) => void; plans?: PlanHooks | undefined }) {
  const titleId = `ask-q-${turn.id}`;
  if (turn.state === "plan") return <section className="ask-plan" aria-labelledby={titleId}>
    <p id={titleId} className="small ask-asked">You asked: “{turn.question}”</p>
    <TurnBody turn={turn} page={page} onOpen={onOpen} plans={plans} />
  </section>;
  const badge = cardBadge(turn);
  return <article className="find ask-card" aria-labelledby={titleId}>
    <div className="find-top"><span className={`badge ${badge.tone}`}>{badge.label}</span><span className="find-where">Ask Ozzie</span></div>
    <h3 id={titleId} className="find-title ask-q">{turn.question}</h3>
    <TurnBody turn={turn} page={page} onOpen={onOpen} plans={plans} />
  </article>;
}

/**
 * No AI works, in the panel and in a turn: one sentence and one step on, to "How should Ozzie use AI?" over the page
 * (walk-through, 2026-11-18: "Set one up under Settings" was a dead end).
 */
function NeedsModel() {
  return <div className="panel-info"><Icon name="info" /><div className="stack-tight">
    <p>{NEEDS_AI.ask}</p>
    <ChooseAiButton /></div></div>;
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
    case "no-model": return NEEDS_AI.ask;
    case "refused": case "problem": case "cancelled": return turn.text;
    case "answered": {
      const a = turn.answer;
      // A group's label line ("Needs a decision:") is said with the line it heads, never on its own.
      const parts = a.body.split(/\n{2,}/u).map(p => p.trim()).filter(Boolean);
      const first = parts[0]?.endsWith(":") && parts[1] ? `${parts[0]} ${parts[1]}` : parts[0] ?? "";
      const more = [a.notCovered || a.gaps.length ? "Worth a look." : "", a.draft ? "A draft note is below." : ""].filter(Boolean).join(" ");
      return [first ? `Ozzie answered: ${first}` : "Ozzie answered.", more].filter(Boolean).join(" ");
    }
  }
}

/** Where to go first when nothing has been read: Settings to connect, Services to check. Never a button to the page already on screen. */
function NextSteps({ page, onOpen }: { page: string | undefined; onOpen: (page: Page) => void }) {
  return <div className="row">
    {page !== "connection" && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("connection")}>Open Settings</button>}
    {page !== "sunday" && <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("sunday")}>{OPEN_SERVICES}</button>}
  </div>;
}

/** Ozzie's side of one question. */
export function TurnBody({ turn, page, onOpen, plans }: { turn: Turn; page?: string | undefined; onOpen: (page: Page) => void; plans?: PlanHooks | undefined }) {
  const d = useDay();
  const w = useSystemWords();
  const help = helpFor(w, Boolean(turn.several));
  switch (turn.state) {
    case "plan": return plans ? <div className="body"><PlanTurn parsed={turn.parsed} context={plans.context} actions={plans.actions} /></div> : null;
    case "cards": return <div className="body"><p>{w.say(CARDS_POINTER)}</p>
      {page !== "cards" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen("cards")}><Icon name="user" small />Open Visitor cards</button></div>}</div>;
    case "help": return <div className="body stack-tight">
      <p>{help.intro}</p>
      <ul className="list">{help.can.map(c => <li key={c}><Icon name="dot" small />{c}</li>)}</ul>
      <p>{help.never}</p>
      {turn.checked ? <p className="small">{help.try}</p> : <><p>{help.first}</p><NextSteps page={page} onOpen={onOpen} /></>}
      <p className="small">Nothing was sent.</p></div>;
    case "start": return <div className="body stack-tight"><p>{w.say(ASK_START)}</p><NextSteps page={page} onOpen={onOpen} /><p className="small">Nothing was sent.</p></div>;
    case "asking": return <div className="body"><p className="small"><Icon name="spinner" small spin /> Reading what Ozzie already has…</p></div>;
    case "refused": return <div className="body"><p>{onDayPage(turn.text, d)}</p>{!/nothing was sent/i.test(turn.text) && <p className="small">Nothing was sent.</p>}</div>;
    case "no-model": return <div className="body"><NeedsModel /></div>;
    case "cancelled": return <div className="body"><p className="small">{onDayPage(turn.text, d)}</p></div>;
    case "problem": return <div className="body"><p role="alert" className="problem">{onDayPage(turn.text, d)}</p></div>;
    case "answered": return <Answer answer={turn.answer} onOpen={onOpen} />;
  }
}

export function AskPanel(props: {
  open: boolean; onClose: () => void;
  /** Null until Ozzie's procedures are loaded. */
  ask: AskFn | null;
  brief: SundayBrief | null;
  modelReady: boolean; onOpen: (page: Page) => void;
  /** How Planning Center stands, for the nothing-checked line: Connect is offered only when it isn't connected. */
  connection?: "connected" | "checking" | "unchecked" | "not-connected";
  /** The page on screen beside the panel, so it never offers a button to where the person already is. */
  page?: string;
  /** Turns to start with (tests and restored views). */
  initialTurns?: Turn[];
  /** Taking something on ("Keep an eye on Sunday"): needs no AI model and nothing checked yet. */
  plans?: PlanHooks;
  /**
   * A church whose system shares no volunteer schedules (Genesis, round 5): every question is answered on this Mac from
   * what Ozzie read, with no AI model and nothing sent (genesis-church.tsx `genesisAnswer`).
   */
  answerHere?: (typed: string) => AskTurn;
  /**
   * With `answerHere`: whether anything has been read to answer from, and the questions to offer then. What can you do?,
   * the suggestions and the nothing-read line follow it, never Planning Center's check (review of e9cbd97d, M1).
   */
  here?: { checked: boolean; chips: readonly string[] } | undefined;
  /** Speaking a question on this Mac. Production: the native listener. */
  voice?: Voice;
  /**
   * Ask isn't available for the church's system (Planning Center only, for now): this one plain line says so in place of
   * the nothing-checked line, and no question can be sent.
   */
  notHere?: string | undefined;
  /**
   * A church on a system jobs don't read yet: a request to take something on (`parse`, as `plans` would read it) is
   * answered with `text`, which says so plainly.
   */
  jobsNotHere?: { parse: (typed: string) => Parsed; text: string } | undefined;
  /** Whether listening is possible, before the check (tests and restored views). */
  initialVoice?: VoiceStatus;
}) {
  const { brief, modelReady } = props;
  // Several services watched now: a turn asked now keeps it (Turn `several`), and its answer covers them all (AnswerServices).
  const several = watchesSeveral(brief?.day);
  const words = useSystemWords();
  const voice = props.voice ?? nativeVoice;
  // "Choose how Ozzie uses AI" from inside the panel closes the panel as it opens the AI screens, which the panel would
  // otherwise cover (live in the release app, 2026-11-18). The same button elsewhere is unchanged.
  const chooseAi = useContext(ChooseAiContext);
  const onClose = props.onClose;
  const closeThenChoose = useMemo(() => chooseAi ? () => { onClose(); chooseAi(); } : null, [chooseAi, onClose]);
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
  const cardRef = useRef<HTMLDivElement>(null);
  // The card on show: the newest question's unless the leader reopened an earlier one.
  const [shownId, setShownId] = useState<number | null>(null);
  const current = turns.find(t => t.id === shownId) ?? turns.at(-1);
  const earlier = turns.filter(t => t !== current).reverse().slice(0, EARLIER_SHOWN);
  useEffect(() => { if (props.open) inputRef.current?.focus(); }, [props.open]);
  // Keep the card on show in view, at its top.
  useEffect(() => { cardRef.current?.scrollIntoView?.({ block: "start" }); }, [current?.id, current?.state]);
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
  const update = (id: number, turn: AskTurn) => setTurns(all => all.map(t => t.id === id ? { id, question: t.question, ...(t.several ? { several: true } : {}), ...turn } as Turn : t));

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
    // A church on another system: asking Ozzie to take something on is read the same way, and answered with what can't be
    // done there yet (props.jobsNotHere), never sent to the AI as a question.
    const route = !props.plans && props.jobsNotHere && props.jobsNotHere.parse(typed).kind !== "none"
      ? { kind: "jobs-not-here" as const } : routeQuestion(typed, { brief, modelReady, canAsk: Boolean(props.ask), parse: props.plans?.parse });
    // Everything but a question about what was read is answered here, without any model. Nothing is sent anywhere.
    const local = (turn: TurnState) => {
      const id = nextId.current++;
      setInput("");
      setShownId(id);
      setTurns(all => [...all, { id, question, ...(several ? { several: true } : {}), ...turn }]);
    };
    // Answered here from what was read (Genesis): what to take on and "What can you do?" keep their own answers. A card
    // asked about by count ("How many times was the visitor card filled in?") is a Genesis form, not the cards page.
    const countOfCards = route.kind === "cards" && /\b(?:how many|filled|entries|submissions|times|count)\b/iu.test(question);
    if (props.answerHere && (route.kind === "start" || route.kind === "no-model" || route.kind === "loading" || route.kind === "ask" || countOfCards)) {
      return local(props.answerHere(question));
    }
    switch (route.kind) {
      case "jobs-not-here": return local({ state: "refused", text: props.jobsNotHere!.text });
      case "help": return local({ state: "help", checked: props.here ? props.here.checked : Boolean(brief) });
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
    setShownId(id);
    setTurns(all => [...all, { id, question, ...(several ? { several: true } : {}), state: "asking" }]);
    setBusy(true);
    try { update(id, await props.ask(typed, controller.signal)); }
    catch { update(id, { state: "problem", code: null, text: ASK_FAILURES.unfinished }); }
    finally { if (running.current === controller) running.current = null; setBusy(false); }
  };

  const chips = !canType || busy || listening !== "no" ? [] : props.here ? (props.here.checked ? [...props.here.chips] : [HELP_CHIP])
    : ready ? suggestedQuestions(brief) : [HELP_CHIP];
  const off = voiceOff(voiceStatus);
  const answered = turns.length > 0;
  // What speaking does, or why it's off: under the question box until there is an answer, then folded with the other
  // notes so the answer keeps the room at any zoom (audit item 8). Listening, and what just happened, always show.
  const voiceAbout = off ?? (voiceStatus?.status === "ready" && canType ? VOICE_HINT : null);
  const voiceLine = listening === "on" ? LISTENING_NOTE : listening === "ending" ? "Finishing the last words…"
    : voiceNote ?? (answered ? null : voiceAbout);
  const notes = <>
    <p className="small">{ASK_INTRO}</p>
    {/* Genesis (round 5): answered here from what was read; nothing is asked of an AI. */}
    <p className="small ask-note"><Icon name="lock" small />{props.answerHere ? "Ozzie answers Genesis questions on this Mac from what it read. Nothing is sent to an AI." : words.say(ASK_NOTE)}</p>
    {answered && voiceAbout && <p className="small">{voiceAbout}</p>}
  </>;
  return <ChooseAiContext.Provider value={closeThenChoose}><aside id="ask-panel" className="convo ask-panel" aria-label="Ask Ozzie" hidden={!props.open}
    onKeyDown={e => {
      if (e.key === "Escape") props.onClose();
      else if (isVoiceShortcut(e)) { e.preventDefault(); void toggleVoice(); }
    }}>
    {/* Named with what it's for (spec §6): "Ask Ozzie", and under it, quieter, "Questions about your services", each kept on
        one line (owner's read of 0.3.2: "Ask Ozzie (questions about Sunday)" wrapped into two columns at 380 px). */}
    <div className="convo-head"><AskIcon /><div className="ask-head"><span className="ask-head-title">Ask Ozzie</span>
      <span className="ask-head-scope">Questions about {props.answerHere ? "what Genesis shares" : SERVICES}</span></div><span className="spacer" />
      <button type="button" className="ibtn" aria-label="Close Ask Ozzie" onClick={props.onClose}><Icon name="x" /></button></div>
    <div className="ask-scroll">
      {!answered && !props.notHere && notes}
      {/* No button to the page already on screen. */}
      {props.notHere && <div className="panel-info"><Icon name="info" /><p>{props.notHere}</p></div>}
      {props.here && !props.here.checked && <div className="panel-info"><Icon name="info" /><div className="stack-tight">
        <p>Nothing has been read from Genesis yet. Check Genesis on {pageRef()}, or ask what Ozzie can do.</p>
        {props.page !== "sunday" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => props.onOpen("sunday")}>{OPEN_SERVICES}</button></div>}</div></div>}
      {!brief && !props.notHere && !props.answerHere && <div className="panel-info"><Icon name="info" /><div className="stack-tight">
        <p>{words.say(props.connection === "checking" ? `Nothing has been checked yet. Ozzie is checking Planning Center now. You can also open the fictional example on ${pageRef()}, or ask what Ozzie can do.`
          : props.connection === "unchecked" ? `Nothing has been checked yet, and Ozzie couldn't check Planning Center just now. You can open the fictional example on ${pageRef()}, or ask what Ozzie can do.`
          : props.connection === "connected" ? `Nothing has been checked yet. Check Planning Center on ${pageRef()}. You can also open the fictional example there, or ask what Ozzie can do.`
          : `Nothing has been checked yet. Connect Planning Center in Settings, or check Planning Center on ${pageRef()}. You can also open the fictional example there, or ask what Ozzie can do.`)}</p>
        {props.page !== "sunday" && <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => props.onOpen("sunday")}>{OPEN_SERVICES}</button></div>}</div></div>}
      {!modelReady && !props.notHere && !props.answerHere && <NeedsModel />}
      {brief?.mode === "fictional" && <p className="banner dashed"><Icon name="info" small />Fictional example. Answers use invented data.</p>}
      {brief?.mode === "recording" && <p className="banner dashed"><Icon name="clock" small />A saved copy of a check from {time(brief.completed_at)}. Not a current check.</p>}
      {brief && !answered && <BasedOn text={basedOnBrief(brief)} />}
      {current && <AnswerServices.Provider value={current.several ? MANY_SERVICES : null}><div ref={cardRef} className="ask-current"><AskCard turn={current} page={props.page} onOpen={props.onOpen} plans={props.plans} /></div></AnswerServices.Provider>}
      {earlier.length > 0 && <section className="ask-earlier" aria-labelledby="ask-earlier-h">
        <h3 id="ask-earlier-h" className="small bold">Earlier questions</h3>
        <ul className="list">{earlier.map(t => <li key={t.id}>
          <button type="button" className="btn btn-quiet btn-sm ask-reopen" onClick={() => setShownId(t.id)}><Icon name="history" small />{t.question}</button></li>)}</ul>
      </section>}
      {chips.length > 0 && <div className="quick ask-quick" aria-label="Suggested questions">{chips.map(c => <button key={c} type="button" className="chip" onClick={() => { void ask(c); }}>{c}</button>)}</div>}
      {answered && <details className="listen-more ask-about"><summary><Icon name="chev" small />{ASK_ABOUT}</summary>{notes}</details>}
    </div>
    <form className="composer" onSubmit={e => { e.preventDefault(); void ask(input); }}>
      <label htmlFor="ask-input" className="sr-only">Your question</label>
      <textarea id="ask-input" ref={inputRef} className="ask-input" rows={2} maxLength={MAX_QUESTION_CHARS} value={input} disabled={!canType || busy}
        readOnly={listening !== "no"}
        placeholder={listening !== "no" ? "Listening…" : ready ? `Ask about ${SERVICES}…` : props.plans ? "Ask Ozzie to keep an eye on something…"
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
    <p className="sr-only" role="status" aria-live="polite">{props.open ? turnAnnouncement(current) : ""}</p>
  </aside></ChooseAiContext.Provider>;
}
