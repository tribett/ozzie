import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { shownUncertainties, sundayShownCount, type BriefPerson, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { ServingInterval } from "../../../core/src/coverage.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import type { FollowUpFinding, OperationsResult, RoomFinding } from "../../../core/src/operations-findings/index.js";
import { operationsNotChecked, type GroupMeeting, type SundayOperations } from "../../../core/src/operations-capture.js";
import { Icon } from "./icons.js";
import { acceptModelReply, buildRewordRequest, restoreDraft, templateDraft, REWORDINGS, type PlaceholderDraft, type Rewording } from "../../../core/src/draft-request.js";
import { canEscalate, escalationDraft, restoreEscalation } from "../../../core/src/escalation-draft.js";
import {
  applyDecisions, changeText, decide, decisionsStorageKey, loadDecisions, REASON_MAX, saveDecisions, withDecision, withoutDecision,
  type DecidedItem, type DecisionChoice, type DecisionHistory, type SundayDecision,
} from "../../../core/src/sunday-decisions.js";
import { model, modelProblem } from "./model.js";
import { alwaysFor, briefTarget, canCorrect, canDemote, canPromote, followUpTarget, groupTarget, roomTarget, stopScopes, type FeedbackTarget } from "../../../core/src/finding-feedback.js";
import { canRemind, reminderDraft, restoreReminder } from "../../../core/src/reminder-draft.js";
import { FeedbackState, FindingFeedback, HIDDEN_BY_YOU, SetAside, useFeedback, type FeedbackControls, type FeedbackSource } from "./finding-feedback.js";
import { signNote, yourName, YOUR_NAME_MAX } from "./connection.js";
import { DraftActions, isPersonId, type Addressee, type OpenDraft, type OpenDraftTo } from "./draft-actions.js";
import { REFUSED } from "./sunday-source.js";
import { NOT_OPENED, OPEN_PERSON, OPEN_PLAN, type PlanningCenterPage } from "./planning-center-pages.js";
import { activityLabel, TaskAccount } from "./activity-page.js";
import { aiText } from "./harness-words.js";
import {
  LOOK_DRAFT, LOOK_FAILED, LOOK_NOT_COVERED, LOOK_NOT_LOOKED, LOOK_NOTE, LOOK_NOTHING, lookShortened, type AskTurn, type Look, type PeopleLabel,
} from "./harness-bridge.js";

type Names = Record<string, string>;
const nameOf = (names: Names, id: string | undefined) => (id && Object.hasOwn(names, id) && names[id]) || "Someone on the team";
/** One "Looks good — I'll send it" mark as the page shows it: whose, the words, and Undo. App keeps the marks (asked.ts). */
export interface AskedLine { key: string; person_id: string; text: string; undo: () => void }
/**
 * The marks for the Sunday shown, and the leader's click that makes one (audit item 18). App.tsx hands them over; this
 * page imports nothing that keeps them, so nothing that builds what a model, a notice or Siri is given can reach them.
 */
export interface AskedSlot { lines: readonly AskedLine[]; onMark: (finding: Finding, person: string) => void }
/** What a note offers once it's ready: the mark for it if there is one, or the click that makes one. */
type NoteMark = { line: AskedLine | null; onMark: () => void } | null;
const markFor = (asked: AskedSlot | null | undefined, finding: Finding, person: string | undefined): NoteMark =>
  asked && person ? { line: asked.lines.find(l => l.key === finding.key && l.person_id === person) ?? null, onMark: () => asked.onMark(finding, person) } : null;
const PLACEHOLDER = "[Your name]";
export const LOOKS_GOOD = "Looks good — I'll send it";
export const LOOKS_GOOD_HELP = "Marks it on this Mac so the Sunday page and Today show you said you'd ask. Nothing is sent and Planning Center doesn't change.";
export const UNSIGNED = "This note still ends “[Your name]”. Add the name your notes are signed with, and Ozzie puts it in.";
export const UNSIGNED_HELP = "Kept on this Mac, as Settings' Your name for notes. It goes in after any AI rewording, so it's never sent to an AI.";
export const SIGN = "Sign it with this name";

/** Opens a Planning Center page by id (planning-center-pages.ts): App passes it for a real check, never the example. */
export type OpenPlanningCenter = (page: PlanningCenterPage, id: string) => Promise<boolean>;
/** "Open in Planning Center" (audit item 25): a quiet link-style button; says so plainly if the browser didn't open. */
export function OpenInPlanningCenter({ open, page, id, label, name }: {
  open: OpenPlanningCenter; page: PlanningCenterPage; id: string; label: string;
  /** Whose page, for VoiceOver when several rows each have the button: "Open Riley Thornbury in Planning Center". */
  name?: string | undefined;
}) {
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" className="btn btn-quiet btn-sm pc-open" aria-label={name ? `Open ${name} in Planning Center` : undefined}
      onClick={() => { void open(page, id).then(ok => setFailed(!ok)); }}>{label}</button>
    {failed && <span role="alert" className="small pc-failed">{NOT_OPENED}</span>}
  </>;
}

/** Whether the saved sign-in includes People, and Settings, where the leader can sign in again with it (audit item 19). */
export interface PeopleAccess { granted: boolean; onAdd?: (() => void) | undefined }
/**
 * Who a note is for, from the Planning Center id the finding itself holds (never anything typed, listed or read from a
 * card): its To line is filled in when Planning Center has one usable detail for them. No id, or no `people` (the
 * fictional example, whose people aren't in Planning Center), no addressee: the note opens with To empty, as before.
 */
export function addresseeFor(person: string | undefined, names: Names, people: PeopleAccess | null | undefined): Addressee | null {
  if (!people || !isPersonId(person)) return null;
  const name = Object.hasOwn(names, person) && names[person] ? names[person] : "this person";
  return { person, name, peopleGranted: Boolean(people?.granted), onAddPeople: people?.onAdd };
}
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const when = (i: ServingInterval | null) => i ? `${new Date(i.starts_at).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} at ${clock(i.starts_at)}` : "this Sunday";
const plainReasons: [RegExp, string][] = [
  [/^Recorded team membership.*/, "On this team in Planning Center. No blockout or other schedule overlaps this time."],
  [/^Possible conflict: source records an unanswered sent request\./, "Has an unanswered request for another role at this time."],
  [/^Possible conflict: unconfirmed scheduling record; invitation not sent\./, "Is penciled in for another role at this time; that request hasn't been sent."],
  [/^Possible conflict: unconfirmed scheduling record; sending couldn't be verified\./, "Is also pending for another role at this time."],
  [/^Confirmed overlapping serving assignment\./, "Already confirmed to serve somewhere else at this time."],
  [/^Recorded overlapping blockout\./, "Has a blockout that covers this time."],
  // The engine checks a person's schedules and blockouts as one read scope: if either read fails, both are unconfirmed.
  [/^Blockouts couldn't be verified\./, "Their blockouts couldn't be checked (one repeats, or the read didn't finish)."],
  [/^Serving assignments couldn't be verified\./, "Their other schedules couldn't be confirmed."],
  [/^Recorded availability couldn't be verified\./, "Part of their Planning Center record didn't load, so availability isn't confirmed."],
  [/^(Team membership|Required role eligibility) couldn't be verified\./, "Their place on this team couldn't be confirmed (part of the team's record didn't load)."],
  [/^Required related scope couldn't be verified\./, "Part of this check didn't load."],
  [/^Required serving interval couldn't be verified\./, "This service time couldn't be confirmed."],
];
const plain = (reasons: string[]) => [...new Set(reasons.map(r => plainReasons.find(([re]) => re.test(r))?.[1] ?? r))].join(" ");
/** Unranked: alphabetical by the name shown, so the order never implies priority. */
const unranked = (people: BriefPerson[], names: Names) => [...people].sort((a, b) => nameOf(names, a.person_id).localeCompare(nameOf(names, b.person_id)));
const alphabetical = (ids: string[], names: Names) => [...ids].sort((a, b) => nameOf(names, a).localeCompare(nameOf(names, b)));

const CHOICE_TEXT: Record<DecisionChoice, { button: string; question: string; example: string; save: string; done: (role: string) => string; earlier: string }> = {
  "covered-outside": { button: "Covered outside Planning Center", question: "Who or what is covering it?", example: "A few words, for example: a parent from the class is covering", save: "Mark it covered for this Sunday",
    done: role => `${role}: covered outside Planning Center.`, earlier: "covered outside Planning Center" },
  "not-needed": { button: "Not needed this Sunday", question: "Why isn't it needed this Sunday?", example: "A few words, for example: one service this week, so one greeter is enough", save: "Mark it not needed this Sunday",
    done: role => `${role} isn't needed this Sunday.`, earlier: "not needed this Sunday" },
  "lead-expected": { button: "Yes, that's expected", question: "Why is that expected?", example: "A few words, for example: the team leads itself on fifth Sundays", save: "Mark it expected for this Sunday",
    done: role => `${role}: no scheduled lead expected this Sunday.`, earlier: "no scheduled lead expected" },
};

/** Decisions for the Sunday on screen, kept on this Mac per organization and plan. */
export function useSundayDecisions(capture: SundayCapture | null, brief: SundayBrief | null): [SundayDecision[], (next: SundayDecision[]) => void] {
  const key = capture && brief ? decisionsStorageKey(brief.mode, capture.organization, capture.plan_id) : null;
  const [decisions, setDecisions] = useState<SundayDecision[]>([]);
  useEffect(() => { setDecisions(key ? loadDecisions(localStore(), key) : []); }, [key]);
  return [decisions, next => { setDecisions(next); if (key) saveDecisions(localStore(), key, next); }];
}
function localStore(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

/**
 * The Planning Center reads each kind of Sunday finding is worked out from (audit item 9a), in read order: the Sunday
 * page's findings come from Ozzie's own fixed check, not from a procedure the AI follows. Collections as What happened
 * names them. Hand-kept: the engine declares no reads per kind, so a test (who-could-help.test.ts) fails each read of
 * the fictional check in turn and holds this table to the reads whose failure changes that kind's findings (review H,
 * L5). Follow-up steps name each step and who owns it; a lead the check couldn't confirm reads as a missing one does.
 */
export const READS_FOR: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "needs-people": ["plan_times", "needed_positions", "team_members", "team_position_assignments", "team_leaders", "person_schedules", "person_blockouts"],
  pending: ["plan_times", "team_members"], streak: ["plan", "team_members", "person_schedules"],
  "lead-missing": ["plan_times", "team_members", "team_leaders"], "lead-unverified": ["plan_times", "team_members", "team_leaders"],
  "too-few-confirmed": ["plan_times", "team_members"], "background-check": ["plan_times", "team_members", "people_background_checks"],
  rooms: ["plan", "organization", "calendar_rooms", "calendar_resource_bookings", "calendar_conflicts"],
  "follow-ups": ["people_workflows", "people_workflow_steps", "people_workflow_ready_cards", "people_workflow_snoozed_cards"],
  "group-meetings": ["plan", "plan_times", "team_members", "organization", "groups_person_memberships", "groups_group_events"],
});
/** Said for a finding about what the check couldn't rely on: no shorter list would be true. */
export const EVERY_READ = "Every read in this check, each listed on What happened";
/** What a finding was read from, in plain words. Anything else ("Worth a look" about the check itself) is every read of the check. */
export const readsFor = (finding: Pick<Finding, "kind"> | { kind: "rooms" | "follow-ups" | "group-meetings" }): string[] =>
  Object.hasOwn(READS_FOR, finding.kind) ? READS_FOR[finding.kind]!.map(activityLabel) : [EVERY_READ];
export const FIXED_HOW = "Ozzie's own check of Planning Center found this, with no AI. It applies the same fixed rules, including your Church rules, to what it read every time it checks. It read:";
export const FIXED_HOW_END = "Why I flagged this lists the rule and the facts. Every read in the latest check is on What happened. Nothing in Planning Center changed.";
/** "See how this works" under Why I flagged this: how the finding was worked out, and the reads it used. */
function HowFixed({ reads }: { reads: readonly string[] }) {
  const [open, setOpen] = useState(false);
  return <div className="why-how stack-tight">
    <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> See how this works</button>
    {open && <div className="stack-tight small">
      <p>{FIXED_HOW}</p>
      <ul className="list">{reads.map(r => <li key={r}><Icon name="dot" small />{r}</li>)}</ul>
      <p>{FIXED_HOW_END}</p>
    </div>}
  </div>;
}

/**
 * "More choices" (audit item 29): a card shows its one or two main actions as buttons and keeps the rest here, closed
 * each time the card is shown (nothing remembers it). The button says whether it's open; the choices sit right under it,
 * still in the page (hidden while closed), so nothing is removed and the keyboard reaches them once it's open.
 */
export function MoreChoices({ children, startOpen = false }: { children: ReactNode; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  return <div className="more-choices">
    <button type="button" className="btn btn-quiet btn-sm more-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Icon name="chev" small />More choices</button>
    <div id={id} className="more-body" hidden={!open}>{children}</div>
  </div>;
}
/** Whether FindingFeedback shows anything for this card (its own rule, kept beside it), so an empty fold is never offered. */
const feedbackShows = (target: FeedbackTarget, feedback: FeedbackControls | null | undefined) =>
  Boolean(feedback && (canCorrect(target) || stopScopes(target).length || target.action || canPromote(target) || canDemote(target)));

/**
 * A card whose only other actions are telling Ozzie about it: those, under More choices; what its Church rules already
 * do for it (FeedbackState) stays in view under them, since a closed fold mustn't hide state (review F, L-5).
 */
function FeedbackChoices({ target, feedback }: { target: FeedbackTarget; feedback: FeedbackControls | null | undefined }) {
  if (!feedbackShows(target, feedback)) return null;
  return <>
    <div className="find-next card-actions"><MoreChoices><FindingFeedback target={target} feedback={feedback} state={false} /></MoreChoices></div>
    <FeedbackState target={target} feedback={feedback} />
  </>;
}

/** Every card's source row: "Why I flagged this" (the rule and facts), where the facts came from and when they were read. */
function SourceWhy({ sources, at, why, reads, defaultOpen = false, source = null }: {
  sources: readonly string[]; at: string | null; why: readonly string[]; reads: readonly string[]; defaultOpen?: boolean; source?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <div className="find-src">
    <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="info" small /> Why I flagged this
    </button>
    {sources.map(s => <span key={s} className="badge b-muted">{s}</span>)}
    {at && <span>Checked {time(at)}</span>}
    {source}
    {open && <ul className="list why">{why.map(w => <li key={w}><Icon name="dot" small />{w}</li>)}</ul>}
    {open && <HowFixed reads={reads} />}
  </div>;
}

export function Why({ finding, checkedAt, defaultOpen = false, source }: {
  finding: Finding; checkedAt: string | null; defaultOpen?: boolean;
  /** Beside where the facts came from: "Open the plan in Planning Center" (audit item 25). */
  source?: ReactNode;
}) {
  return <SourceWhy sources={[finding.source ?? "Planning Center"]} at={finding.checked_at ?? checkedAt} why={finding.why} reads={readsFor(finding)} defaultOpen={defaultOpen} source={source} />;
}

/** When no one on the team can be listed: who else could help find someone. */
const noOneText = (finding: Finding) => finding.leaders?.length ? "You could ask the team's leader who else could help."
  : finding.leaders ? "Planning Center doesn't list a leader for this team." : "The team's leaders couldn't be read.";
/** Whether a needs-people finding has anyone to show, including people left out and why. */
const listsPeople = (finding: Finding) => {
  const p = finding.people;
  return Boolean(p && (p.suggestions.length || p.conflicts.length || p.unverified.length || p.left_out.length));
};

/** One person on an open role's list, under one of the four closed labels, as Ozzie's own check found them. */
interface Listed { person: BriefPerson; label: PeopleLabel; canDraft: boolean; left: boolean }
/**
 * Everyone an open role's finding lists, in the fixed list's order: by label, then alphabetically. The one source of the
 * people on that card and on the AI's card under it (review G, M-1), so the two can never differ.
 */
export function listedPeople(finding: Finding, names: Names): Listed[] {
  const p = finding.people;
  if (!p) return [];
  const of = (people: BriefPerson[], label: PeopleLabel, canDraft: boolean, left = false) => unranked(people, names).map(person => ({ person, label, canDraft, left }));
  return [...of(p.suggestions, "No overlap found", true), ...of(p.conflicts, "Possible conflict", true),
    ...of(p.unverified, "Availability needs confirmation", false), ...of(p.left_out, "Left out", false, true)];
}
/** A person's row: the mark, name and closed label every list of people uses, and nothing else unless the list adds it. */
function PersonRow({ listed: { person, label, canDraft, left }, names, action = null, children = null }: {
  listed: Listed; names: Names; action?: ReactNode; children?: ReactNode;
}) {
  return <div className={`person${left ? " is-left" : ""}`}>
    <Icon name={left ? "minus" : canDraft ? "user" : "question"} />
    <div>
      <div className="person-top">
        <span className="person-name">{nameOf(names, person.person_id)}</span>
        <span className={`badge ${left ? "b-muted" : label === "Possible conflict" ? "b-conflict" : canDraft ? "b-confirm" : "b-look"}`}>{label}</span>
        {action}
      </div>
      <p className="person-role">{plain(person.reasons)}</p>
      {children}
    </div>
  </div>;
}

function PeopleList({ finding, names, onDraft, asked = null, openPc = null }: {
  finding: Finding; names: Names; onDraft: (person: string) => void; asked?: AskedSlot | null | undefined; openPc?: OpenPlanningCenter | null | undefined;
}) {
  const [showLeft, setShowLeft] = useState(false);
  const all = listedPeople(finding, names);
  const row = (x: Listed) => <PersonRow key={x.person.person_id} listed={x} names={names}
    action={x.canDraft && <button type="button" className="btn btn-secondary btn-sm push" onClick={() => onDraft(x.person.person_id)}>Prepare a note</button>}>
    {openPc && <div className="person-pc"><OpenInPlanningCenter open={openPc} page="person" id={x.person.person_id} label={OPEN_PERSON}
      name={nameOf(names, x.person.person_id)} /></div>}
    {asked?.lines.filter(l => l.key === finding.key && l.person_id === x.person.person_id).map(l => <AskedNote key={l.key + l.person_id} line={l} />)}
  </PersonRow>;
  const shown = all.filter(x => !x.left), left = all.filter(x => x.left);
  return <div className="stack people">
    <p className="small">People on this team in Planning Center. Listed alphabetically, not ranked. Whether someone is willing is theirs to say.</p>
    {shown.map(row)}
    {!shown.length && <p className="find-body">{noOneText(finding)}</p>}
    {left.length > 0 && <>
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={showLeft} onClick={() => setShowLeft(!showLeft)}>
        {showLeft ? "Hide" : "Show"} {left.length} left out and why
      </button>
      {showLeft && left.map(row)}
    </>}
  </div>;
}

/** Runs the who-could-help procedure through the harness for one open role (App: harness-bridge lookAtWhoCouldHelp). */
export type WhoCouldHelp = (finding: Finding, signal: AbortSignal) => Promise<AskTurn>;
export const LOOK_BUTTON = "Ask Ozzie to look at who could help";
export const LOOK_KEEPS = "The list above is still the full list from Ozzie's own check.";
export const LOOK_TITLE = "What the AI found when asked to look at the list above";
/** "See how this works", how it ended: true to what the AI did, whether or not it asked for the list (review G, N3, N4). */
export function lookEnded(look: Look): string {
  switch (look.kind) {
    case "lines": return look.looked
      ? "Ozzie wrote a line for each fact the AI chose about the role. The people are Ozzie's own list for this role, the same as above."
      : "Ozzie wrote a line for each fact the AI chose about the role. The AI didn't ask for the list of people; the people are Ozzie's own list for this role, the same as above.";
    case "nothing": return look.looked ? "The AI looked at the list of people and chose nothing beyond it, so Ozzie said so."
      : "The AI didn't ask for the list of people and chose nothing about the role, so Ozzie said so.";
    case "not-covered": return "The AI answered that it couldn't tell more, so Ozzie said so.";
    case "draft": return "The AI asked for a note, which isn't prepared from this card, so Ozzie said so.";
  }
}

/**
 * What the AI found when asked to look at who could help with one role at one time, as a card next to the fixed list
 * (audit item 9; review H, M3; review G, M-1): Ozzie's own lines for the facts the AI chose about the role, then
 * everyone the finding lists, from the same source and in the same rows as the fixed list (never the AI's copy, which
 * may be cut to fit), with no one marked; or one line for what the AI did instead. Where it came from and when, and See
 * how this works with the procedure word for word and the steps. Never a ranking, never a pick, never a note.
 */
export function WhoCouldHelpCard({ turn, finding, names }: { turn: AskTurn; finding: Finding; names: Names }) {
  const [how, setHow] = useState(false);
  const role = finding.position?.name ?? "this role";
  if (turn.state !== "answered") {
    const said = turn.state === "no-model" ? "Ask Ozzie needs an AI model. Set one up under Settings." : turn.text;
    return <div className="ai-look-note small" role={turn.state === "problem" ? "alert" : undefined}><p>{said}</p>
      {!/The list above is unchanged\./u.test(said) && <p>{LOOK_KEEPS}</p>}</div>;
  }
  const a = turn.answer;
  const look: Look = a.look ?? { kind: "nothing", looked: false, shortened: 0 };
  const people = look.kind === "lines" ? listedPeople(finding, names) : [];
  const line = look.kind === "draft" ? LOOK_DRAFT : look.kind === "not-covered" ? LOOK_NOT_COVERED : look.looked ? LOOK_NOTHING : LOOK_NOT_LOOKED;
  return <article className="find ask-card ai-look-card" aria-label={`${LOOK_TITLE}: ${role}`}>
    <div className="find-top"><span className="badge b-muted">AI help</span><span className="find-where">{role}</span></div>
    <h4 className="find-title ai-look-title">{LOOK_TITLE}</h4>
    {a.gaps.length > 0 && <div className="stack-tight"><span className="badge b-look"><Icon name="eye" small />Worth a look</span>
      <ul className="list">{a.gaps.map(g => <li key={g}><Icon name="dot" small />{g}</li>)}</ul></div>}
    {look.kind === "lines" ? <>
      <div className="ask-lines">{a.body.split(/\n{2,}/u).map((p, i) => <p key={i}>{p}</p>)}</div>
      {people.length > 0 && <div className="stack people">
        {people.map(x => <PersonRow key={x.person.person_id} listed={x} names={names} />)}
        <p className="small">{LOOK_NOTE}</p>
      </div>}
    </> : <p className="find-body">{line}</p>}
    {look.shortened > 0 && <p className="small">{lookShortened(look.shortened)}</p>}
    <p className="ask-based"><Icon name="check" small />{a.basedOn}</p>
    <button type="button" className="btn btn-quiet btn-sm ask-how" aria-expanded={how} onClick={() => setHow(!how)}><Icon name="info" small />See how this works</button>
    {how && <div className="ask-how-body stack-tight">
      {a.procedure && <><p className="bold">Ozzie followed this procedure: {a.procedure.title}</p><div className="procedure-body">{a.procedure.body}</div></>}
      <TaskAccount account={{ started: `You asked Ozzie to look at who could help with ${role}.`, looked: a.steps, ai: aiText("skill", "who-could-help", a.aiSteps, true),
        ended: lookEnded(look) }} />
      <p className="small">The AI saw labels such as [Person 1] and [Role 1], never the names Ozzie read; Ozzie put the names back on this Mac. It only chose which facts to show, and Ozzie wrote every line here. Nothing was sent to anyone, and nothing in Planning Center changed.</p>
    </div>}
  </article>;
}

/** "Ask Ozzie to look at who could help": one run of the procedure for this role, its card shown under the fixed list. */
function AiLook({ finding, names, look }: { finding: Finding; names: Names; look: WhoCouldHelp }) {
  const [turn, setTurn] = useState<AskTurn | null>(null);
  const [running, setRunning] = useState<AbortController | null>(null);
  useEffect(() => () => running?.abort(), [running]);
  const start = () => {
    const controller = new AbortController();
    setRunning(controller); setTurn(null);
    void look(finding, controller.signal).then(setTurn, () => setTurn({ state: "problem", code: null, text: LOOK_FAILED }))
      .finally(() => setRunning(r => r === controller ? null : r));
  };
  return <div className="stack-tight ai-look">
    {running ? <div className="row"><p className="small" role="status"><Icon name="spinner" small spin /> Ozzie is asking the AI to look at who could help…</p>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => running.abort()}>Stop</button></div>
      : <div><button type="button" className="btn btn-secondary btn-sm" onClick={start}><Icon name="info" small />{turn ? "Ask again" : LOOK_BUTTON}</button></div>}
    {turn && !running && <WhoCouldHelpCard turn={turn} finding={finding} names={names} />}
  </div>;
}

/** "On Mon, Nov 16 you said you'd ask Riley about Greeter." with Undo: quiet, on the person's row, the card and Today. */
export function AskedNote({ line }: { line: AskedLine }) {
  return <p className="small asked-line"><Icon name="check" small /><span>{line.text}</span>
    <button type="button" className="btn btn-quiet btn-sm" onClick={line.undo}>Undo</button></p>;
}

const REWORD_LABEL: Record<Rewording, string> = { warmer: "Warmer", shorter: "Shorter", casual: "More casual", formal: "More formal" };

/** A note asking one person on the team (exported for tests): its To line and its addressee come from the same id. */
export function Draft({ finding, person, names, sender, sunday, canReword, onClose, people = null, mark = null }: {
  finding: Finding; person: string; names: Names; sender: string; sunday: string | null; canReword: boolean; onClose: () => void; people?: PeopleAccess | null; mark?: NoteMark;
}) {
  const ctx = { finding, person_id: person, sunday };
  const [version, setVersion] = useState<PlaceholderDraft>(() => templateDraft(ctx, names));
  const [body, setBody] = useState(() => restoreDraft(version, ctx, names, sender));
  const [edited, setEdited] = useState(false);
  const [working, setWorking] = useState<Rewording | null>(null);
  const [problem, setProblem] = useState("");
  // Says the wording changed (the draft itself changes in place, which is easy to miss).
  const [reworded, setReworded] = useState<Rewording | null>(null);
  const reword = async (choice: Rewording) => {
    setWorking(choice); setProblem(""); setReworded(null);
    try {
      const reply = await model.reword(buildRewordRequest(version, choice, names));
      const next = acceptModelReply(reply, version, names);
      setVersion(next); setBody(restoreDraft(next, ctx, names, sender)); setEdited(false); setReworded(choice);
    } catch (error) {
      setProblem(error instanceof Error && /draft|name|Ozzie/.test(error.message) ? error.message : modelProblem(error));
    } finally { setWorking(null); }
  };
  return <DraftBox label="Draft note" to={nameOf(names, person)} addressee={addresseeFor(person, names, people)} body={body} onBody={b => { setBody(b); setEdited(true); setReworded(null); }} onClose={onClose}
    onSign={name => setBody(b => signNote(b, name))} mark={mark}
    footer="Ozzie never sends messages. The AI sees placeholders like [Volunteer A] instead of the names Ozzie read from Planning Center.">
    {canReword && <div className="find-next reword">
      <span className="find-next-l">Ask Ozzie to reword it</span>
      {(Object.keys(REWORDINGS) as Rewording[]).map(choice => <button key={choice} type="button" className="chip" disabled={working !== null} onClick={() => { void reword(choice); }}>
        {working === choice ? <Icon name="spinner" small spin /> : null}{REWORD_LABEL[choice]}</button>)}
    </div>}
    {canReword && <p className="small" role="status">{working ? "Rewording…" : reworded ? `Reworded: ${REWORD_LABEL[reworded].toLowerCase()}. Read it through before you copy it.` : ""}</p>}
    {canReword && edited && <p className="small">Rewording starts from Ozzie's last version. Your own changes stay on this Mac and are never sent.</p>}
    {/* Calm, not red (audit item 29): the note is unchanged and nothing broke; the words say what happened. */}
    {problem && <div role="status" className="panel-info reword-note"><Icon name="info" small /><p>{problem}</p></div>}
  </DraftBox>;
}

/**
 * The shared draft frame: never a send button. Copy it, open it unsent in Mail or Messages for the person to send, or
 * change the wording.
 */
export function DraftBox({ label, to, addressee = null, body, onBody, onClose, footer, children, startEditing = false, open, openTo, onSign, mark = null, signName }: {
  label: string; to?: string; body: string; onBody: (b: string) => void; onClose: () => void; footer: string; children?: ReactNode;
  /** Who the note is for, by the id the finding holds: Open in Mail or Messages then fills in To when it can. */
  addressee?: Addressee | null;
  /** Puts the leader's name in place of [Your name] (default: in the words shown); offered while the note still has it. */
  onSign?: ((name: string) => void) | undefined;
  /** "Looks good — I'll send it": the mark for this note, or the click that makes one. None for a note for no one in particular. */
  mark?: NoteMark | undefined;
  /** Where the name is kept on this Mac (tests replace Settings' own). */
  signName?: { set(name: string): void } | undefined;
  /** Start with the wording open to change (tests). */
  startEditing?: boolean;
  /** Opens the draft in Mail or Messages (tests replace the Mac's). */
  open?: OpenDraft | undefined; openTo?: OpenDraftTo | undefined;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState("");
  const editId = useId();
  const nameId = useId();
  // Said before it's copied or opened (audit item 18): a note that would go out signed "[Your name]".
  const unsigned = body.includes(PLACEHOLDER);
  const sign = () => {
    (signName ?? yourName).set(name);
    if (onSign) onSign(name); else onBody(signNote(body, name));
    setName("");
  };
  return <div className="draft" role="region" aria-label={label}>
    <div className="row draft-head"><span className="badge b-draft">Draft only. Nothing has been sent.</span><span className="spacer" />
      <button type="button" className="ibtn" aria-label="Close the draft" onClick={onClose}><Icon name="x" /></button></div>
    {to && <p className="small draft-to">To {to}</p>}
    {editing
      ? <><label className="sr-only" htmlFor={editId}>{`${label}: change the wording`}</label>
        {/* Opened by "Change the wording", so the words to change get the focus. */}
        <textarea id={editId} className="draft-edit" value={body} onChange={e => { onBody(e.target.value); setCopied(false); }} rows={9} autoFocus /></>
      : <div className="draft-body">{body.split("\n\n").map((para, i) => <p key={i}>{para}</p>)}</div>}
    {unsigned && <form className="panel-info draft-unsigned" onSubmit={e => { e.preventDefault(); if (name.trim()) sign(); }}>
      <Icon name="info" small />
      <div className="stack-tight">
        <p>{UNSIGNED}</p>
        <label className="field-l" htmlFor={nameId}>Your name for notes</label>
        <div className="row">
          <input id={nameId} className="input own-name" value={name} maxLength={YOUR_NAME_MAX} autoComplete="name" spellCheck={false} aria-describedby={`${nameId}-help`}
            onChange={e => setName(e.target.value)} />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={!name.trim()}>{SIGN}</button>
        </div>
        <p id={`${nameId}-help`} className="input-help">{UNSIGNED_HELP}</p>
      </div>
    </form>}
    <DraftActions text={body} open={open} openTo={openTo} to={addressee} split
      copy={<button type="button" className="btn btn-primary" onClick={() => { void navigator.clipboard?.writeText(body).then(() => setCopied(true)); }}>
        {copied ? "Copied — send it yourself" : "Copy draft"}</button>}
      after={<button type="button" className="btn btn-secondary" onClick={() => setEditing(!editing)}>{editing ? "Done changing" : "Change the wording"}</button>} />
    {/* The leader's own mark, a separate click after checking it: opening the note, addressed or not, never makes one. */}
    {mark && (mark.line ? <AskedNote line={mark.line} />
      : <div className="find-next asked-offer"><button type="button" className="btn btn-secondary" aria-describedby={`${editId}-looks`} onClick={mark.onMark}>{LOOKS_GOOD}</button>
        <span id={`${editId}-looks`} className="small">{LOOKS_GOOD_HELP}</span></div>)}
    {children}
    <p className="small">{footer}</p>
  </div>;
}

/** A note to the team's leader. Written on this Mac in placeholder form and never offered for AI rewording. */
export function LeaderNote({ finding, leader, names, sender, sunday = null, onClose, people = null, mark = null }: {
  finding: Finding; leader: string; names: Names; sender: string; sunday?: string | null; onClose: () => void; people?: PeopleAccess | null; mark?: NoteMark;
}) {
  const ctx = { finding, leader_id: leader, sunday };
  const [body, setBody] = useState(() => restoreEscalation(escalationDraft(ctx), ctx, names, sender));
  return <DraftBox label="Draft note to the team's leader" to={Object.hasOwn(names, leader) && names[leader] ? `${names[leader]} (team leader in Planning Center)` : "the team's leader in Planning Center"}
    addressee={addresseeFor(leader, names, people)} body={body} onBody={setBody} onClose={onClose} mark={mark}
    footer="Ozzie never sends messages. This note was written on this Mac; nothing in it went to an AI." />;
}

/** A reminder to someone whose request has no answer yet. Written on this Mac in placeholder form and never offered for AI rewording. */
export function ReminderNote({ finding, names, sender, onClose, people = null, mark = null }: {
  finding: Finding; names: Names; sender: string; onClose: () => void; people?: PeopleAccess | null; mark?: NoteMark;
}) {
  const [body, setBody] = useState(() => restoreReminder(reminderDraft(finding), finding, names, sender));
  return <DraftBox label="Draft reminder" to={nameOf(names, finding.person_id)} addressee={addresseeFor(finding.person_id, names, people)} body={body} onBody={setBody} onClose={onClose} mark={mark}
    footer="Ozzie never sends messages. This note was written on this Mac; nothing in it went to an AI." />;
}

function LeaderButtons({ finding, names, label, onPick }: { finding: Finding; names: Names; label: string; onPick: (leader: string) => void }) {
  const leaders = alphabetical(finding.leaders ?? [], names);
  if (!canEscalate(finding)) return null;
  return <>{leaders.map(l => <button key={l} type="button" className="btn btn-secondary btn-sm" onClick={() => onPick(l)}>
    {leaders.length === 1 ? label : `${label}: ${nameOf(names, l)}`}</button>)}</>;
}

/** A short reason, required, for a Sunday-only decision. */
export function DecisionForm({ choice, onSave, onCancel }: { choice: DecisionChoice; onSave: (reason: string) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState("");
  const text = CHOICE_TEXT[choice];
  return <form className="decide" onSubmit={e => {
    e.preventDefault();
    try { onSave(reason); } catch (error) { setProblem(error instanceof Error ? error.message : "That couldn't be saved."); }
  }}>
    <label className="field-l" htmlFor={id}>{text.question}</label>
    <input id={id} className="input" value={reason} maxLength={REASON_MAX} autoFocus placeholder={text.example}
      onChange={e => { setReason(e.target.value); setProblem(""); }} />
    <p className="input-help">Kept on this Mac. It applies to this Sunday only, and this comes back if Planning Center changes.</p>
    {problem && <p role="alert" className="problem">{problem}</p>}
    <div className="find-next">
      <button type="submit" className="btn btn-primary btn-sm" disabled={!reason.trim()}>{text.save}</button>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Never mind</button>
    </div>
  </form>;
}

function Earlier({ decision }: { decision: SundayDecision }) {
  return <ul className="list earlier">
    {[...decision.earlier, decision].map(d => <li key={d.decided_at + d.reason}><Icon name="history" small />
      <span>Earlier, you said {CHOICE_TEXT[d.choice].earlier} ({time(d.decided_at)}): “{d.reason}”</span></li>)}
  </ul>;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/**
 * Moves to a card's title (audit item 17): scrolls only the page pane App gives (never scrollIntoView, which scrolls the
 * whole window), so the title is near the top, then gives it keyboard focus without scrolling again. By the element
 * itself, never by finding anything in the page.
 */
function showTitle(title: HTMLElement, pane: HTMLElement | null) {
  if (pane) pane.scrollTop += title.getBoundingClientRect().top - pane.getBoundingClientRect().top - 16;
  title.focus({ preventScroll: true });
}
/** "Only 1 confirmed person in Nursery at 9:30 AM." Services has no age: people, never "adults". */
export function fewConfirmedTitle(f: Finding): string {
  const c = f.confirmed?.length ?? 0, at = f.position!.interval ? `at ${clock(f.position!.interval.starts_at)}` : "this Sunday";
  return c === 0 ? `No confirmed people in ${f.position!.name} ${at}.` : `Only ${count(c, "confirmed person", "confirmed people")} in ${f.position!.name} ${at}.`;
}
/** Pending is never confirmed, and an unsent request is never called asked. */
export function fewConfirmedBody(f: Finding): string {
  const asked = f.asked?.length ?? 0, unsent = f.not_sent?.length ?? 0;
  return [
    asked ? `${asked} more ${asked === 1 ? "is" : "are"} asked but ${asked === 1 ? "hasn't" : "haven't"} answered.` : "",
    unsent ? `${unsent} more ${unsent === 1 ? "is" : "are"} penciled in, but the request hasn't been sent.` : "",
    !asked && !unsent ? "No one else is asked yet." : "",
    `Your Church rules ask for at least ${f.needed ?? 2}. Ozzie counts confirmed people; it doesn't check ages.`,
    f.tone === "look" ? "Planning Center doesn't show which service time some confirmed people serve, so this count may be low." : "",
  ].filter(Boolean).join(" ");
}
/** Nothing about a check beyond whether one is current on file, or when it runs out relative to Sunday. */
export function backgroundTitle(name: string, check: Finding["check"]): string {
  return check === "expires-before-sunday" ? `${name}'s background check on file expires before Sunday.`
    : check === "expires-on-sunday" ? `${name}'s background check on file expires on Sunday.`
      : `${name} has no current background check on file.`;
}

/** The Sunday a finding belongs to, for "This isn't right" (that Sunday only). */
export interface Occurrence { id: string; label: string | null }

/**
 * Something App shows beside a card, for its kind of finding and, when it has one, its team and position (SundayPage's
 * `beside`); this page knows nothing of what.
 */
export type Beside = (p: { kind: string; team_id?: string; position_id?: string; name?: string }) => ReactNode;

function FindingCard({ item, names, checkedAt, sender, sunday, canReword, onDecide, whoCouldHelp, feedback = null, occurrence, beside, people = null, asked = null,
  openPc = null, planId = null, titleRef }: {
  item: DecidedItem; names: Names; checkedAt: string | null; sender: string; sunday: string | null; canReword: boolean; people?: PeopleAccess | null | undefined;
  asked?: AskedSlot | null | undefined;
  /** "Open in Planning Center" for this plan and the people on the card (audit item 25); none in the example. */
  openPc?: OpenPlanningCenter | null | undefined; planId?: string | null | undefined;
  /** The title's element, so Today can open Sunday at this card. */
  titleRef?: ((el: HTMLElement | null) => void) | undefined;
  onDecide: (finding: Finding, choice: DecisionChoice, reason: string, previous: SundayDecision | null) => void;
  whoCouldHelp?: WhoCouldHelp | undefined;
  feedback?: FeedbackControls | null;
  occurrence: Occurrence;
  beside?: Beside | undefined;
}) {
  const { finding } = item;
  const target = briefTarget(finding, occurrence.id, occurrence.label);
  // "Always do this": the note a Church rule asks Ozzie to prepare is ready when the card opens.
  const always = feedback && alwaysFor(feedback.entries, target);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const firstLeader = () => canEscalate(finding) ? alphabetical(finding.leaders ?? [], names)[0] ?? null : null;
  const [leaderFor, setLeaderFor] = useState<string | null>(() => always?.action === "prepare-leader-note" ? firstLeader() : null);
  const [reminding, setReminding] = useState(() => always?.action === "prepare-reminder" && canRemind(finding));
  // A rule made from this card just now prepares its note straight away, as it will on every later check.
  useEffect(() => {
    if (always?.action === "prepare-reminder" && canRemind(finding)) setReminding(true);
    if (always?.action === "prepare-leader-note") setLeaderFor(l => l ?? firstLeader());
  }, [always?.id]); // Only when the rule itself changes.
  const [choosing, setChoosing] = useState<DecisionChoice | null>(null);
  const [open, setOpen] = useState(finding.kind === "needs-people");
  const hasPeople = listsPeople(finding);
  const listed = finding.people ? [...finding.people.suggestions, ...finding.people.conflicts, ...finding.people.unverified] : [];
  const onRow = (person: string) => finding.kind === "needs-people" && hasPeople && open && listed.some(x => x.person_id === person);
  const inOpenNote = (person: string) => person === draftFor || person === leaderFor || (reminding && person === finding.person_id);
  const decision = finding.tone === "decision";
  const tag = item.state === "reopened"
    ? <span className="badge b-attn"><Icon name="flag" small />This needs attention again</span>
    : <span className={`badge ${decision ? "b-attn" : "b-look"}`}><Icon name={decision ? "flag" : "eye"} small />{decision ? "Needs a decision" : "Worth a look"}</span>;
  const where = finding.position ? <span className="find-where">{finding.position.name} · {when(finding.position.interval)}</span> : null;
  let title: string, body: string | null = null;
  switch (finding.kind) {
    case "needs-people":
      title = `${finding.position!.name} still needs ${finding.remaining === 1 ? "one more person" : `${finding.remaining} more people`}.`;
      { const n = finding.people!.suggestions.length, c = finding.people!.conflicts.length;
        body = n + c === 0 ? "No one else on this team is clear for this time."
          : n === 0 ? `No one else on the team is clear with no overlap found; ${c === 1 ? "one person has" : `${c} people have`} a possible conflict.`
            : `${n === 1 ? "One person" : `${n} people`} on the team could help with no overlap found${c ? `, and ${c === 1 ? "one" : c} with a possible conflict` : ""}.`; }
      break;
    case "pending":
      title = `${nameOf(names, finding.person_id)} is pending for ${finding.position!.name}.`;
      body = finding.notification === "sent" ? "The request was sent; there's no answer yet." : "Planning Center shows the request hasn't been sent yet. Is that expected?";
      break;
    case "streak":
      title = `${nameOf(names, finding.person_id)} is scheduled ${finding.sundays} Sundays in a row.`;
      body = "Your Church rules suggest a quick check-in. This is about care, not performance.";
      break;
    case "lead-missing":
      title = `No one is scheduled to lead ${finding.position!.name} this Sunday.`;
      body = finding.leaders?.length ? "I found the team's leader in Planning Center, but no one scheduled to lead this Sunday. Is that expected?"
        : finding.leaders ? "Your Church rules ask for a scheduled lead, and Planning Center doesn't list a team leader. Is that expected?"
          : "Your Church rules ask for a scheduled lead. The team's leaders couldn't be read. Is that expected?";
      break;
    case "lead-unverified":
      title = `I couldn't confirm the scheduled lead for ${finding.position!.name}.`;
      body = "Planning Center has someone scheduled to lead, but their answer or serving time couldn't be confirmed, so I'm not counting it as covered.";
      break;
    case "too-few-confirmed":
      title = fewConfirmedTitle(finding);
      body = fewConfirmedBody(finding);
      break;
    case "background-check":
      title = backgroundTitle(nameOf(names, finding.person_id), finding.check);
      body = `Scheduled for ${finding.position!.name} ${finding.position!.interval ? `at ${clock(finding.position!.interval.starts_at)}` : "this Sunday"}. Your Church rules ask for a current background check before serving with kids.${
        finding.tone === "look" && finding.check === "none-current" ? " Planning Center showed no current background checks for anyone on your kids teams; your Planning Center login may not be able to see them." : ""}`;
      break;
    default:
      title = finding.stale ? "This check is out of date." : "Part of this Sunday couldn't be checked.";
      body = finding.stale ? `It was read ${checkedAt ? time(checkedAt) : "earlier"}, more than 30 minutes ago. Check Planning Center again before relying on it.`
        : "Ozzie won't call Sunday covered until every part is read.";
  }
  // For this Sunday only (under More choices): an open role covered another way, or not needed.
  const sundayOnly: DecisionChoice[] = finding.kind === "needs-people" ? ["covered-outside", "not-needed"] : [];
  const decisionForm = choosing && <DecisionForm key={choosing} choice={choosing} onCancel={() => setChoosing(null)}
    onSave={reason => { onDecide(finding, choosing, reason, item.decision); setChoosing(null); }} />;
  const pcPlan = openPc && planId && !finding.source ? <OpenInPlanningCenter open={openPc} page="plan" id={planId} label={OPEN_PLAN} /> : null;
  const main = (finding.kind === "needs-people" && (hasPeople || canEscalate(finding))) || finding.kind === "lead-missing" || (canRemind(finding) && !reminding);
  const more = sundayOnly.length > 0 || Boolean(pcPlan) || feedbackShows(target, feedback);
  return <article className={`find${finding.tone === "look" && item.state === "open" ? " is-look" : ""}${item.state === "reopened" ? " is-reopened" : ""}`}>
    <div className="find-top">{tag}{where}</div>
    <h3 className="find-title" tabIndex={-1} ref={titleRef}>{title}</h3>
    {body && <p className="find-body">{body}</p>}
    {item.state === "reopened" && item.decision && <div className="panel-warn reopen" role="note">
      <Icon name="history" />
      <div className="stack-tight">
        <p className="bold">What changed since you decided</p>
        <ul className="list">{item.changes.map(c => <li key={c.code}><Icon name="dot" small />{changeText(c, id => nameOf(names, id))}</li>)}</ul>
        <Earlier decision={item.decision} />
      </div>
    </div>}
    {finding.unread && <ul className="list unread">{finding.unread.map(u => <li key={u}><Icon name="question" small />{u}</li>)}</ul>}
    {/* No one to list: no show/hide toggle, just what could help instead. */}
    {finding.kind === "needs-people" && !hasPeople && <p className="find-body">{noOneText(finding)}</p>}
    {/* The card's main actions, then everything else under More choices (audit item 29). An open role: who could help and
        a note to the team's leader; a lead question: that it's expected, or a note to the leader; a pending request: a
        reminder. For this Sunday only, telling Ozzie about the card and Planning Center wait in the fold. */}
    {(main || more) && <div className="find-next card-actions">
      {finding.kind === "needs-people" && hasPeople && <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide people" : "See who could help"}</button>}
      {finding.kind === "needs-people" && <LeaderButtons finding={finding} names={names} label="Prepare a note to the team's leader" onPick={l => { setLeaderFor(l); setDraftFor(null); }} />}
      {finding.kind === "lead-missing" && !choosing && <button type="button" className="btn btn-sm btn-primary" onClick={() => setChoosing("lead-expected")}>{CHOICE_TEXT["lead-expected"].button}</button>}
      {finding.kind === "lead-missing" && <LeaderButtons finding={finding} names={names} label="Prepare a note to the leader" onPick={setLeaderFor} />}
      {canRemind(finding) && !reminding && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setReminding(true)}>Prepare a reminder</button>}
      {more && <MoreChoices>
        {sundayOnly.length > 0 && !choosing && <div className="find-next">
          <span className="find-next-l">For this Sunday only:</span>
          {sundayOnly.map(c => <button key={c} type="button" className="btn btn-secondary btn-sm" onClick={() => setChoosing(c)}>{CHOICE_TEXT[c].button}</button>)}
        </div>}
        {choosing && choosing !== "lead-expected" && decisionForm}
        <FindingFeedback target={target} feedback={feedback} state={false} />
        {pcPlan && <div className="find-next">{pcPlan}</div>}
      </MoreChoices>}
    </div>}
    {choosing === "lead-expected" && decisionForm}
    {finding.kind === "needs-people" && <>
      {hasPeople && open && <PeopleList finding={finding} names={names} onDraft={p => { setDraftFor(p); setLeaderFor(null); }} asked={asked} openPc={openPc} />}
      {hasPeople && open && whoCouldHelp && <AiLook finding={finding} names={names} look={whoCouldHelp} />}
      {draftFor && <Draft key={draftFor} finding={finding} person={draftFor} names={names} sender={sender} sunday={sunday} canReword={canReword} onClose={() => setDraftFor(null)} people={people}
        mark={markFor(asked, finding, draftFor)} />}
    </>}
    {/* State, not a choice (review F, L-5): how soon Ozzie tells, and why a note opened by itself, next to that note and in
        view with More choices closed. */}
    <FeedbackState target={target} feedback={feedback} />
    {reminding && <ReminderNote finding={finding} names={names} sender={sender} onClose={() => setReminding(false)} people={people} mark={markFor(asked, finding, finding.person_id)} />}
    {leaderFor && <LeaderNote key={leaderFor} finding={finding} leader={leaderFor} names={names} sender={sender} sunday={sunday} onClose={() => setLeaderFor(null)} people={people}
      mark={markFor(asked, finding, leaderFor)} />}
    {/* A mark shows once: in the note open for that person, else on their row in the people shown, else here on the card. */}
    {asked?.lines.filter(l => l.key === finding.key && !onRow(l.person_id) && !inOpenNote(l.person_id)).map(l => <AskedNote key={l.person_id} line={l} />)}
    {beside?.({ kind: finding.kind, ...(finding.position ? { team_id: finding.position.team_id, position_id: finding.position.id, name: finding.position.name } : {}) })}
    <Why finding={finding} checkedAt={checkedAt} />
  </article>;
}

const remainingText = (n: number) => `Planning Center still shows ${n === 1 ? "1 remaining request" : `${n} remaining requests`}; Ozzie hasn't changed anything there.`;

function ResolvedCard({ item, checkedAt, onUndo }: { item: DecidedItem; checkedAt: string | null; onUndo: () => void }) {
  const d = item.decision!, f = item.finding;
  return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-you"><Icon name="user" small />Resolved by you — this Sunday only</span>
      {f.position && <span className="find-where">{f.position.name} · {when(f.position.interval)}</span>}</div>
    <h3 className="find-title">{CHOICE_TEXT[d.choice].done(d.subject.name)}</h3>
    <p className="find-quote">“{d.reason}”</p>
    <p className="find-body">You decided this {time(d.decided_at)}. {f.kind === "needs-people" ? remainingText(f.remaining ?? 0) : "Planning Center still shows no confirmed lead; Ozzie hasn't changed anything there."}</p>
    {d.earlier.length > 0 && <ul className="list earlier">{d.earlier.map(e => <li key={e.decided_at + e.reason}><Icon name="history" small />
      <span>Before that, you said {CHOICE_TEXT[e.choice].earlier} ({time(e.decided_at)}): “{e.reason}”</span></li>)}</ul>}
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onUndo}>Undo — bring it back to the list</button></div>
    <Why finding={f} checkedAt={checkedAt} />
  </article>;
}

function HistoryCard({ entry, onRemove }: { entry: DecisionHistory; onRemove: () => void }) {
  const d = entry.decision;
  const where = <span className="find-where">{d.subject.name} · {when(d.subject.interval)}</span>;
  if (entry.status === "source-confirmed") return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-ok"><Icon name="check" small />Confirmed in Planning Center</span>{where}</div>
    <h3 className="find-title">{d.kind === "lead-missing" ? `Planning Center now shows a confirmed lead for ${d.subject.name}.` : `${d.subject.name} is now filled in Planning Center.`}</h3>
    <p className="find-body">{entry.checked_at ? `Checked ${time(entry.checked_at)}.` : ""} Your earlier note is kept below as history.</p>
    <Earlier decision={d} />
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onRemove}>Remove my note</button></div>
  </article>;
  const note = entry.status === "filled-pending" ? `Planning Center now shows no open requests for ${d.subject.name}, but someone there hasn't accepted yet.`
    : entry.status === "not-listed" ? `Planning Center no longer lists ${d.subject.name} on this plan.`
      : `This couldn't be rechecked in Planning Center, so it stands as your decision, not as confirmed coverage.`;
  return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-you"><Icon name="user" small />Resolved by you — this Sunday only</span>
      {entry.status === "couldnt-recheck" && <span className="badge b-look"><Icon name="eye" small />Worth a look</span>}{where}</div>
    <h3 className="find-title">{CHOICE_TEXT[d.choice].done(d.subject.name)}</h3>
    <p className="find-quote">“{d.reason}”</p>
    <p className="find-body">You decided this {time(d.decided_at)}. {note}</p>
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onRemove}>Undo — remove my decision</button></div>
  </article>;
}

const span = (i: { starts_at: string; ends_at: string }) => `${clock(i.starts_at)}–${clock(i.ends_at)}`;
const uncertaintyText: Partial<Record<string, string>> = {
  "unknown-rule": "A room isn't set as not shared in Church rules, so overlaps there can't be confirmed.",
  "unknown-booking": "A booking's status or time couldn't be read.",
  "unknown-resolution": "Planning Center doesn't show clearly whether overlapping bookings (counting any setup time) were already worked out.",
  "unknown-card": "A follow-up's step, owner or due date couldn't be read.",
  "snooze-recheck": "A snoozed follow-up's snooze has ended and needs a fresh look.",
};

export function OpsWhy({ evidence, why, reads, defaultOpen = false }: { evidence: OperationsResult["checked_scopes"]; why: string[]; reads: readonly string[]; defaultOpen?: boolean }) {
  // Only Planning Center reads have a check time; Church rules are the church's own settings.
  const at = evidence.filter(e => e.source !== "church-rule").map(e => e.check_time).sort()[0] ?? null;
  const sources = [...new Set(evidence.map(e => e.source === "church-rule" ? "Church rules" : e.source === "normalized-calendar" ? "Calendar" : "People follow-ups"))];
  return <SourceWhy sources={sources} at={at} why={why} reads={reads} defaultOpen={defaultOpen} />;
}

const CLEAR: Record<string, string> = {
  "rooms,follow-ups": "No room overlaps or follow-ups without an owner in what was read",
  rooms: "No room overlaps in what was read", "follow-ups": "No follow-ups without an owner in what was read",
};
/** Whether the rooms and follow-ups slot has anything to show: a result, an out-of-date state, or a fully checked "nothing found". */
export const hasOperationsSection = (operations: SundayOperations | null): operations is SundayOperations =>
  Boolean(operations && (operations.stale || operations.result || operations.clear.length));

/**
 * Rooms and follow-ups for this Sunday. An out-of-date check shows only that it's out of date. The
 * "nothing found" line appears only when the operations check says every part was fully read, and
 * names only those parts, with the time Planning Center was read (never a Church-rules time).
 */
export function OperationsSection({ operations, whyOpen = false, feedback = null, occurrence = "", checkedAt = null, titleRef }: {
  operations: SundayOperations;
  /** The section title's element, so Today can open Sunday at rooms and follow-ups. */
  titleRef?: ((el: HTMLElement | null) => void) | undefined;
  /** When the Sunday check behind these was read (an out-of-date one has no rooms time of its own). */
  checkedAt?: string | null;
  /** Start with every Why I flagged this open (tests). */
  whyOpen?: boolean;
  /** The person's Church rules for these cards, and the Sunday's plan id they belong to. */
  feedback?: FeedbackControls | null; occurrence?: string;
}) {
  const { labels, result } = operations;
  if (operations.stale) return <section className="stack" aria-label="Rooms and follow-ups">
    <h2 className="h3">Rooms and follow-ups</h2>
    <article className="find is-look">
      <div className="find-top"><span className="badge b-look"><Icon name="clock" small />Out of date</span></div>
      <h3 className="find-title">Rooms, follow-ups and group meetings aren't shown.</h3>
      <p className="find-body">This check was read more than 30 minutes ago, so Ozzie doesn't treat it as current. Check Planning Center again to see them.</p>
      <SourceWhy sources={["Planning Center"]} at={checkedAt} defaultOpen={whyOpen} reads={[...readsFor({ kind: "rooms" }), ...readsFor({ kind: "follow-ups" })]}
        why={["This check was read more than 30 minutes ago, so Ozzie doesn't treat its rooms, follow-ups or group meetings as current.", "Anything changed in Planning Center since then isn't shown."]} />
    </article>
  </section>;
  const label = (id: string, fallback: string) => (Object.hasOwn(labels, id) && labels[id]) || fallback;
  // Parts that couldn't be read are listed under What I didn't check; only open questions about what was read show here.
  const uncertainties = shownUncertainties(result);
  const clear = CLEAR[operations.clear.join(",")];
  const room = (f: RoomFinding) => {
    const [a, b] = f.bookings;
    const confirmed = f.label === "Room use needs review";
    const why = [
      ...(f.rule?.exclusive ? [`Your Church rules say ${label(f.resource_id, "this room")} isn't shared${f.rule.additional_setup_minutes ? ` and needs ${f.rule.additional_setup_minutes} minutes of setup` : ""}.`]
        : ["No Church rule says this room isn't shared, so this overlap can't be confirmed."]),
      ...f.bookings.map(x => `The calendar shows ${label(x.booking_id, "a booking")} as ${x.status}, ${span(x.original)}.`),
      f.resolution?.state === "unresolved" ? "Planning Center Calendar lists these two bookings as a conflict that hasn't been resolved."
        : "Planning Center doesn't show clearly whether these two bookings were worked out.",
    ];
    return <article className={`find${confirmed ? "" : " is-look"}`} key={f.finding_id}>
      <div className="find-top"><span className={`badge ${confirmed ? "b-attn" : "b-look"}`}><Icon name={confirmed ? "flag" : "eye"} small />{f.label}</span>
        <span className="find-where">{label(f.resource_id, "A room")} · {when(f.overlap)}</span></div>
      <h3 className="find-title">{label(f.resource_id, "A room")} has overlapping bookings from {span(f.overlap)}.</h3>
      {a && b && <p className="find-body">{label(a.booking_id, "One booking")} ({span(a.original)}) and {label(b.booking_id, "another booking")} ({span(b.original)}) overlap
        {f.additional_setup_minutes ? `, counting the ${f.additional_setup_minutes} minutes of setup your Church rules set for this room` : ""}.</p>}
      <div className="find-next"><span className="find-next-l">Next step</span><span>{f.next_action}</span></div>
      <FeedbackChoices target={roomTarget(f, occurrence, labels)} feedback={feedback} />
      <OpsWhy evidence={f.evidence} why={why} reads={readsFor({ kind: "rooms" })} defaultOpen={whyOpen} />
    </article>;
  };
  const followUp = (f: FollowUpFinding) => <article className="find" key={f.finding_id}>
    <div className="find-top"><span className="badge b-attn"><Icon name="flag" small />{f.label}</span>
      <span className="find-where">{label(f.workflow_id, "A follow-up")}</span></div>
    <h3 className="find-title">“{label(f.step_id, "A follow-up step")}” has no owner. It was due {time(f.due_at)}.</h3>
    <div className="find-next"><span className="find-next-l">Next step</span><span>{f.next_action}</span></div>
    <FeedbackChoices target={followUpTarget(f, occurrence, labels)} feedback={feedback} />
    <OpsWhy evidence={f.evidence} why={["This follow-up is active and ready on its current step.", "No one is assigned to it, and it isn't snoozed.", `Its due date, ${time(f.due_at)}, has passed.`]}
      reads={readsFor({ kind: "follow-ups" })} defaultOpen={whyOpen} />
  </article>;
  return <section className="stack" aria-label="Rooms and follow-ups">
    <h2 className="h3" tabIndex={-1} ref={titleRef}>Rooms and follow-ups</h2>
    {result?.findings.map(f => f.kind === "room-overlap" ? room(f) : followUp(f))}
    {uncertainties.length > 0 && <article className="find is-look">
      <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span></div>
      <h3 className="find-title">Some room or follow-up details couldn't be confirmed.</h3>
      <ul className="list unread">{[...new Set(uncertainties.map(u => uncertaintyText[u.code] ?? "Part of the room and follow-up check couldn't be read."))]
        .map(t => <li key={t}><Icon name="question" small />{t}</li>)}</ul>
      <OpsWhy evidence={result?.checked_scopes ?? []} defaultOpen={whyOpen} reads={[...readsFor({ kind: "rooms" }), ...readsFor({ kind: "follow-ups" })]}
        why={["Ozzie doesn't treat something it couldn't confirm as clear, so it asks a person to look.", "Nothing about it changed in Planning Center."]} />
    </article>}
    {clear && <p className="small">{clear}{operations.checked_at ? ` (checked ${time(operations.checked_at)})` : ""}.</p>}
  </section>;
}

function GroupMeetingCard({ item, names, defaultOpen = false, feedback = null, occurrence = "" }: {
  item: GroupMeeting; names: Names; defaultOpen?: boolean; feedback?: FeedbackControls | null; occurrence?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const roles = [...new Set(item.serving.map(s => s.position ?? "their role"))].join(", ");
  const serving = [...new Set(item.serving.map(s => `${s.status} for ${s.position ?? "a role"}`))].join(" and ");
  const why = [
    ...item.meetings.map(m => `Planning Center Groups lists them in a group that meets ${span(m)} this Sunday.`),
    ...item.serving.map(s => `Planning Center Services has them ${s.status} for ${s.position ?? "a role"}, ${span(s.interval)}.`),
    "This is a schedule fact. Which one they go to is theirs to decide.",
  ];
  return <article className="find is-look">
    <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span>
      {item.serving[0] && <span className="find-where">{roles} · {when(item.serving[0].interval)}</span>}</div>
    <h3 className="find-title">{nameOf(names, item.person_id)} has a group meeting at the same time.</h3>
    <p className="find-body">Their group meets {item.meetings.map(span).join(" and ")}, while they're {serving}.</p>
    <FeedbackChoices target={groupTarget(item, occurrence)} feedback={feedback} />
    <div className="find-src">
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> Why I flagged this</button>
      <span className="badge b-muted">Groups</span><span className="badge b-muted">Planning Center</span><span>Checked {time(item.checked_at)}</span>
      {open && <ul className="list why">{why.map(w => <li key={w}><Icon name="dot" small />{w}</li>)}</ul>}
      {open && <HowFixed reads={readsFor({ kind: "group-meetings" })} />}
    </div>
  </article>;
}

/** People on this plan whose group meets while they serve. Listed alphabetically, never ranked; names resolve on this Mac. */
export function GroupMeetings({ items, names, whyOpen = false, feedback = null, occurrence = "" }: {
  items: GroupMeeting[]; names: Names; whyOpen?: boolean; feedback?: FeedbackControls | null; occurrence?: string;
}) {
  return <section className="stack" aria-label="Group meetings">
    <h2 className="h3">Group meetings</h2>
    {[...items].sort((a, b) => nameOf(names, a.person_id).localeCompare(nameOf(names, b.person_id)))
      .map(m => <GroupMeetingCard key={m.person_id} item={m} names={names} defaultOpen={whyOpen} feedback={feedback} occurrence={occurrence} />)}
  </section>;
}

/**
 * Planning Center refused the check (audit item 5): which kinds of access could be missing (Ozzie can't tell the two
 * apart), who can give it, and the next steps, which open Settings, where signing in and choosing the Sunday are.
 */
export function Refused({ onSettings }: { onSettings?: (() => void) | undefined }) {
  return <div role="alert" className="panel-warn refused"><Icon name="info" />
    <div className="stack-tight">
      <p className="bold">{REFUSED.summary}</p>
      <p>{REFUSED.either}</p>
      <ul className="list">{[REFUSED.login, REFUSED.signIn].map(l => <li key={l}><Icon name="dot" small />{l}</li>)}</ul>
      <p>{REFUSED.next}</p>
      {onSettings && <div className="find-next">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSettings}>{REFUSED.signInButton}</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSettings}>{REFUSED.chooseButton}</button>
      </div>}
    </div>
  </div>;
}

export function SundayPage(props: {
  brief: SundayBrief | null; names: Names; busy: boolean; problem: string; sender: string;
  connected: boolean; hasRecording: boolean; configured: boolean; canReword: boolean;
  decisions: SundayDecision[]; onDecisions: (next: SundayDecision[]) => void;
  operations: SundayOperations | null;
  onCheck: () => void; onRecording: () => void; onExample: () => void; onLaterExample?: (() => void) | undefined;
  /** Opens Settings, where Planning Center is connected and the Sunday chosen. */
  onSettings?: (() => void) | undefined;
  /** The last check was refused by Planning Center (sunday-source.ts `refusedRead`): the problem says which access and what next. */
  refused?: boolean;
  /** Whether the sign-in includes People, for a note's To line, and Settings to add it (audit item 19). */
  people?: PeopleAccess | null;
  /** "Looks good — I'll send it" marks for this Sunday, kept by App (audit item 18). */
  asked?: AskedSlot | null;
  /** Opens a Planning Center page by id, for a real check (audit item 25): App passes it, never for the example. */
  openInPlanningCenter?: OpenPlanningCenter | null;
  /** A card Today asked to open at (its finding key, or "rooms" / "follow-ups"); `onFocused` once the page has moved there. */
  focus?: string | null; onFocused?: (() => void) | undefined;
  /** The page pane App scrolls, so moving to a card scrolls only it. */
  pane?: RefObject<HTMLElement | null> | undefined;
  /**
   * "Ask Ozzie to look at who could help" on an open role's card (audit item 9): the who-could-help procedure through the
   * harness for that role. App passes it only while AI help is set up; without it the card shows the fixed list only.
   */
  whoCouldHelp?: WhoCouldHelp | undefined;
  /** What the person tells Ozzie on finding cards, kept with the Church rules. */
  feedback?: FeedbackSource | null;
  /** Last Sunday in Check-Ins against the kids rules (church-reads-view.tsx), when Check-Ins was part of the check. */
  church?: ReactNode;
  /** Shown on an open card for its team or position: App passes the church's own lists here (church-own-words.tsx). */
  beside?: Beside | undefined;
}) {
  const { brief, names, decisions, onDecisions } = props;
  // "Your name for notes" from Settings, put in on this Mac after any rewording; [Your name] when none is set.
  const sender = props.sender.trim() || yourName.get();
  const { controls, notice } = useFeedback(props.feedback, names);
  const occurrence: Occurrence = { id: brief?.plan.id ?? "", label: brief?.plan.dates ?? null };
  const setAside = [...(brief?.hidden ?? []).map(h => h.entry), ...(props.operations?.hidden ?? []).map(h => h.entry)];
  const stamp = useMemo(() => brief ? time(brief.checked_at ?? brief.completed_at) : null, [brief]);
  const view = useMemo(() => brief ? applyDecisions(brief, decisions) : null, [brief, decisions]);
  // Everything the page shows, counted as items: Services, rooms, follow-ups and group meetings (the sidebar and Today use the same count).
  const counts = view ? sundayShownCount(view, props.operations) : { decisions: 0, looks: 0, resolved: 0 };
  const incomplete = Boolean(brief && (brief.stale || brief.findings.some(f => f.kind === "worth-a-look")));
  // Incomplete checks first, then anything that came back, then Planning Center's order.
  const rank = (i: DecidedItem) => i.finding.kind === "worth-a-look" ? 0 : i.state === "reopened" ? 1 : 2;
  const open = view ? view.items.filter(i => i.state !== "resolved").sort((a, b) => rank(a) - rank(b)) : [];
  const resolved = view ? view.items.filter(i => i.state === "resolved") : [];
  const history = view?.history ?? [];
  // Opened from Today at one card: move there once it's laid out, with its people (and their Prepare a note) open.
  const titles = useRef(new Map<string, HTMLElement>());
  const titleRef = (key: string) => (el: HTMLElement | null) => { if (el) titles.current.set(key, el); else titles.current.delete(key); };
  useLayoutEffect(() => {
    if (!props.focus) return;
    const title = titles.current.get(props.focus === "follow-ups" ? "rooms" : props.focus);
    if (title) showTitle(title, props.pane?.current ?? null);
    props.onFocused?.();
  }, [props.focus, brief]);
  const onDecide = (finding: Finding, choice: DecisionChoice, reason: string, previous: SundayDecision | null) =>
    onDecisions(withDecision(decisions, decide(finding, choice, reason, new Date().toISOString(), previous)));
  return <div className="col">
    <p className="eyebrow">{brief?.plan.dates ?? "This Sunday"}</p>
    <h1 className="h1">Is Sunday covered?</h1>
    {brief?.mode === "recording" && <p className="banner dashed"><Icon name="clock" small />Saved copy of the check from {time(brief.completed_at)}. This is not a current check.</p>}
    {/* The fictional example's band is across the top of every page (App.tsx ExampleBand); the line below still says it. */}
    {brief && <p className="lede">
      {brief.stale ? "This check is out of date, so it isn't a current picture. " : incomplete ? "Part of this Sunday couldn't be checked, so this isn't a full picture. " : ""}
      {brief.status === "checked-scope-clear" ? "Everything Ozzie checked is covered. " :
        `${counts.decisions ? `${counts.decisions} ${counts.decisions === 1 ? "thing needs" : "things need"} a decision` : incomplete ? "Nothing in what was read needs a decision" : "Nothing needs a decision"}${counts.looks ? ` and ${counts.looks} ${counts.looks === 1 ? "is" : "are"} worth a look` : ""}. `}
      {counts.resolved > 0 && `You resolved ${counts.resolved} yourself. `}
      {/* Only the leader hides a finding ("This isn't right", "Stop flagging this"), so it says so, and where it can come back. */}
      {setAside.length > 0 && `You hid ${setAside.length === 1 ? "one finding" : `${setAside.length} findings`}: ${setAside.length === 1 ? "it's" : "they're"} under “${HIDDEN_BY_YOU}” at the end of this page, where you can bring ${setAside.length === 1 ? "it" : "them"} back. `}
      {brief.plan.title && <span className="muted">{brief.plan.title}.</span>}
    </p>}
    {!brief && <p className="lede">Sunday hasn't been checked yet. Check Planning Center now, or look around the fictional example first.</p>}
    {/* Always says what this is: a live read, the saved copy of a check, or the fictional example. */}
    {brief && <p className="checkline evidence"><Icon name="check" small />{brief.mode === "fictional" ? "Fictional example data" : brief.mode === "recording" ? "Saved copy of a check of Planning Center Services" : "Live read from Planning Center Services"} · {brief.sources.reads} reads · {stamp}{brief.sources.failed.length ? ` · ${brief.sources.failed.length} didn't complete` : ""}</p>}
    <div className="row" role="group" aria-label="What Sunday shows: a live check, the last saved check or the fictional example">
      <button type="button" className="btn btn-primary" disabled={props.busy || !props.connected || !props.configured} onClick={props.onCheck}>
        {props.busy ? <><Icon name="spinner" small spin />Checking Planning Center…</> : "Check Planning Center now"}</button>
      {props.hasRecording && <button type="button" className="btn btn-secondary" disabled={props.busy} onClick={props.onRecording}>Show the last saved check</button>}
      {!brief && <button type="button" className="btn btn-quiet" onClick={props.onExample}>See a fictional example</button>}
      {brief?.mode === "fictional" && props.onLaterExample && <button type="button" className="btn btn-quiet" onClick={props.onLaterExample}>See a later fictional check</button>}
    </div>
    {(!props.connected || !props.configured) && <p className="small row">
      <span>{!props.connected ? "Connect Planning Center under Settings to check a real Sunday. Ozzie only reads; it changes nothing there." : "Choose which Sunday to check under Settings."}</span>
      {props.onSettings && <button type="button" className="btn btn-quiet btn-sm" onClick={props.onSettings}>Open Settings</button>}</p>}
    {props.problem && !props.refused && <p role="alert" className="problem">{props.problem}</p>}
    {props.problem && props.refused && <Refused onSettings={props.onSettings} />}
    {brief && <section className="stack" aria-labelledby="sunday-open-title">
      <h2 id="sunday-open-title" className="sr-only">Open for this Sunday</h2>
      {notice}
      {open.map(i => <FindingCard key={i.finding.key + i.state} item={i} names={names} checkedAt={brief.checked_at} sender={sender} sunday={brief.plan.date} canReword={props.canReword} onDecide={onDecide} whoCouldHelp={props.whoCouldHelp}
        asked={brief.mode === "fictional" ? null : props.asked} openPc={brief.mode === "fictional" ? null : props.openInPlanningCenter} planId={brief.plan.id} titleRef={titleRef(i.finding.key)}
        feedback={controls} occurrence={occurrence} beside={props.beside} people={brief.mode === "fictional" ? null : props.people} />)}
      {brief.findings.length === 0 && <p className="lede">{brief.hidden?.length ? "Nothing open in what was read, apart from what your Church rules set aside below."
        : "No open needs, pending requests or Church-rule check-ins in what was read."}</p>}
      {brief.findings.length > 0 && open.length === 0 && <p className="lede">Everything left is something you resolved yourself, below.</p>}
    </section>}
    {(resolved.length > 0 || history.length > 0) && <section className="stack" aria-label="Resolved by you">
      <h2 className="h3">Resolved by you</h2>
      <p className="small">Your own decisions for this Sunday only. They aren't coverage in Planning Center, and they come back here if something there changes.</p>
      {resolved.map(i => <ResolvedCard key={i.finding.key} item={i} checkedAt={brief!.checked_at} onUndo={() => onDecisions(withoutDecision(decisions, i.finding.key))} />)}
      {history.map(h => <HistoryCard key={h.decision.key} entry={h} onRemove={() => onDecisions(withoutDecision(decisions, h.decision.key))} />)}
    </section>}
    {brief && hasOperationsSection(props.operations) && <OperationsSection operations={props.operations} feedback={controls} occurrence={occurrence.id} titleRef={titleRef("rooms")}
      checkedAt={brief.checked_at ?? brief.completed_at} />}
    {brief && props.operations && props.operations.group_meetings.length > 0 && <GroupMeetings items={props.operations.group_meetings} names={names}
      feedback={controls} occurrence={occurrence.id} />}
    {brief && props.church}
    {brief && <SetAside entries={setAside} feedback={controls} />}
    {brief && <section className="notchecked" aria-label="What I didn't check">
      <h2 className="h3">What I didn't check</h2>
      <ul className="list">{[...brief.not_checked, ...(props.operations ? props.operations.not_checked : operationsNotChecked(null))].map(n => <li key={n}><Icon name="dot" small />{n}</li>)}</ul>
    </section>}
  </div>;
}
