import { onChurchClock, otherClock, timesText, titleOnlyDate } from "../../../core/src/service-day.js";
import { createContext, Fragment, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { blockoutCounted, blockoutRoles, blockoutTime, byServiceTime, findingTime, rolesUnchecked as coreRolesUnchecked, shownUncertainties, sundayShownCount, type BriefPerson, type Finding, type Roster, type RosterRole, rosterSummary, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { ServingInterval } from "../../../core/src/coverage.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { useSystemWords, type SystemWords } from "./church-system.js";
import type { FollowUpFinding, OperationsResult, RoomFinding } from "../../../core/src/operations-findings/index.js";
import { operationsNotChecked, type GroupMeeting, type SundayOperations } from "../../../core/src/operations-capture.js";
import { Icon } from "./icons.js";
import { acceptModelReply, buildRewordRequest, restoreDraft, templateDraft, REWORDINGS, type PlaceholderDraft, type Rewording } from "../../../core/src/draft-request.js";
import { canEscalate, escalationDraft, restoreEscalation } from "../../../core/src/escalation-draft.js";
import {
  applyDecisions, changeText, decide, decisionsStorageKey, loadDecisions, REASON_MAX, saveDecisions, withDecision, withoutDecision,
  type DecidedItem, type DecisionChoice, type DecisionHistory, type SundayDecision,
} from "../../../core/src/sunday-decisions.js";
import { model, modelProblem, REWORD_NEEDS_AI, REWORD_NOT_ON_MAC } from "./model.js";
import { ChooseAiButton } from "./ai-line.js";
import { NEEDS_AI } from "./ai-words.js";
import { alwaysFor, briefTarget, canCorrect, canDemote, canPromote, followUpTarget, groupTarget, roomTarget, stopScopes, type FeedbackTarget } from "../../../core/src/finding-feedback.js";
import { canRemind, reminderDraft, restoreReminder } from "../../../core/src/reminder-draft.js";
import { FeedbackState, FindingFeedback, HIDDEN_BY_YOU, SetAside, useFeedback, type FeedbackControls, type FeedbackSource } from "./finding-feedback.js";
import { signNote, yourName } from "./connection.js";
import { DraftActions, isPersonId, type Addressee, type OpenDraft, type OpenDraftTo } from "./draft-actions.js";
import { CHECK_REFUSED, REFUSED } from "./sunday-source.js";
import { CopyForAdministrator } from "./planning-center-forms.js";
import { promise } from "./promises.js";
import { NOT_OPENED, OPEN_PERSON, OPEN_PLAN, type PlanningCenterPage } from "./planning-center-pages.js";
import { activityLabel, TaskAccount } from "./activity-page.js";
import { aiText, procedureTitle } from "./harness-words.js";
import { ProcedureBody } from "./procedure-text.js";
import { zoneLabel } from "./proactive-page.js";
import { DayProvider, SUNDAY_WORDS, useDay, type DayWords } from "./day-words.js";
import { DayName, dayName } from "./day-phrases.js";
import { useAnnounce } from "./announce.js";
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
export const LOOKS_GOOD = "Looks good — I'll send it";
export const LOOKS_GOOD_HELP = "Marks it on this Mac so this page and Today show you said you'd ask. Nothing is sent and Planning Center doesn't change.";
/** Under a note Ozzie drafted (spec §6), claiming only what is true: the names Ozzie reads are replaced (re-check NM4). */
/** On the example church's page: where the way to one's own church is (the band's button). */
export const SET_UP_LINE = "To see your own church, press Set up my church at the top.";
/** While the launch's check of a saved sign-in is under way (Today, the service page and the sidebar say it). */
export const CHECKING_LINE = "Checking Planning Center…";
/** The launch's check of a saved sign-in had no answer after 20 seconds (review L6): said with "Check the connection". */
export const STUCK_LINE = "Ozzie couldn't check Planning Center just now.";
export const CHECK_CONNECTION = "Check the connection";
/**
 * A check whose only gap is facts about roles as the system lists them (core sunday-brief.ts `role_facts`): said as roles,
 * never as a read that failed (polish 2026-11-21). "One role couldn't be checked", "2 roles couldn't be checked". This page
 * shows one service at a time, under its own heading, so never with its service (core `rolesUnchecked`).
 */
export const rolesUnchecked = (roles: number) => coreRolesUnchecked(roles);
/** That gap's facts on a brief, when that is its only gap; null otherwise. */
export const roleFactsOf = (brief: Pick<SundayBrief, "findings"> | null | undefined) => brief?.findings.find(f => f.kind === "worth-a-look")?.role_facts ?? null;
export const DRAFT_FOOTER = "Ozzie never sends messages. The AI sees stand-ins like [Volunteer A] instead of the names Ozzie reads from Planning Center.";

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
/** When Ozzie or the person did something (checked, decided, saved): on this Mac's clock. */
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
/**
 * When something happens at church (a service, a role, a booking, a group meeting, a follow-up's due date): on the
 * church's clock, as the service's own heading says its times (service-day.ts onChurchClock); this Mac's only when the
 * church's zone isn't known. They differed when this Mac wasn't on the church's zone (CI, in UTC: "9:30 AM" in the
 * heading, "Nursery · Wednesday, November 25 at 2:30 PM" on its card).
 */
const clock = (iso: string, zone: string | null) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...onChurchClock(zone) });
const churchTime = (iso: string, zone: string | null) =>
  new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...onChurchClock(zone) });
/** The church's time zone of the check on this page (SundayPage gives it); null outside a page, so this Mac's clock. */
const ChurchZone = createContext<string | null>(null);
const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** When a card's time is: its service time, or the watched service by its real day ("this Wednesday") when it has none. */
/**
 * With several services on one page, a role with no serving time of its own is said by its service's date ("Wednesday,
 * November 25"), never "this Wednesday" beside another service's full date (coordinator's live read of 0.5.0), and never
 * with the plan's one service time, which read as the role's own time beside "Worth a look: Greeter isn't tied to a
 * service time" (0.5.3). Null: the day's own words, as one service's page.
 */
const UntimedWhen = createContext<string | null>(null);
const when = (i: ServingInterval | null, d: DayWords, untimed: string | null, zone: string | null) =>
  i ? `${new Date(i.starts_at).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...onChurchClock(zone) })} at ${clock(i.starts_at, zone)}` : untimed ?? d.thisOne;
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
const andList = (items: readonly string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)!}`;
/** One role's line: who said yes, who hasn't answered, who said no; "Nobody is scheduled." when nobody is on it. */
function rosterLine(r: RosterRole, names: Names): string {
  const who = (ids: string[]) => andList(alphabetical(ids, names).map(id => (Object.hasOwn(names, id) && names[id]) || "Someone"));
  const parts = [
    r.yes.length ? `${who(r.yes)} said yes` : "",
    r.waiting.length ? `${who(r.waiting)} ${r.waiting.length === 1 ? "hasn't" : "haven't"} answered yet` : "",
    r.unknown.length ? `Ozzie couldn't read ${who(r.unknown)}'s answer` : "",
    r.declined.length ? `${who(r.declined)} said no` : "",
  ].filter(Boolean);
  if (!parts.length) return "Nobody is listed yet.";
  return `${!r.yes.length && !r.waiting.length && !r.unknown.length ? "Nobody has said yes. " : ""}${parts.join("; ")}.`;
}
/**
 * Who is on each role, for a church system that doesn't share how many people a role needs (Breeze, round 4): there,
 * who said yes, who hasn't answered and who said no is what Ozzie can say about the service. Names stay on this Mac.
 */
function RosterSection({ roster, names, source, at }: { roster: Roster; names: Names; source: string; at: string | null }) {
  const id = useId();
  const roles = roster.roles.length;
  return <section className="find" aria-labelledby={id}>
    <div className="find-top"><span className="badge b-muted"><Icon name="user" small />Who is scheduled</span><span className="find-where">{source}</span></div>
    {/* The count is the page's first line; the card lists each role (review of round 5, L8). */}
    <h2 id={id} className="find-title">{roles === 1 ? "The role" : `All ${roles} roles`}, and who answered</h2>
    <ul className="list">{roster.roles.map(r => <li key={r.position_id}><span><strong>{r.name}</strong>: {rosterLine(r, names)}</span></li>)}</ul>
    {roster.no_role.length > 0 && <p className="small">On the service with no role: {andList(alphabetical(roster.no_role, names).map(p => (Object.hasOwn(names, p) && names[p]) || "Someone"))}.</p>}
    <p className="small">Everyone {source} lists on them{at ? `, checked ${time(at)}` : ""}.</p>
  </section>;
}
/** Unranked: alphabetical by the name shown, so the order never implies priority. */
const unranked = (people: BriefPerson[], names: Names) => [...people].sort((a, b) => nameOf(names, a.person_id).localeCompare(nameOf(names, b.person_id)));
const alphabetical = (ids: string[], names: Names) => [...ids].sort((a, b) => nameOf(names, a).localeCompare(nameOf(names, b)));

type ChoiceText = { button: string; question: string; example: string; save: string; done: (role: string) => string; earlier: string };
/**
 * The words of each one-service decision, for the watched service's real day ("for this Wednesday", "this weekend";
 * onboarding spec §5.2). The lead example keeps "fifth Sundays": it's an example of a Church rule, not the service.
 */
export function choiceText(d: DayWords = SUNDAY_WORDS, system = "Planning Center"): Record<DecisionChoice, ChoiceText> {
  const one = d.thisOne;
  return {
    "covered-outside": { button: `Covered outside ${system}`, question: "Who or what is covering it?", example: "A few words, for example: a parent from the class is covering", save: `Mark it covered for ${one}`,
      done: role => `${role}: covered outside ${system}.`, earlier: `covered outside ${system}` },
    "not-needed": { button: `Not needed ${one}`, question: `Why isn't it needed ${one}?`, example: "A few words, for example: one service this week, so one greeter is enough", save: `Mark it not needed ${one}`,
      done: role => `${role} isn't needed ${one}.`, earlier: `not needed ${one}` },
    "lead-expected": { button: "Yes, that's expected", question: "Why is that expected?", example: "A few words, for example: the team leads itself on fifth Sundays", save: `Mark it expected for ${one}`,
      done: role => `${role}: no scheduled lead expected ${one}.`, earlier: "no scheduled lead expected" },
  };
}

/** Decisions for the Sunday on screen, kept on this Mac per organization and plan. */
export function useSundayDecisions(capture: Pick<SundayCapture, "organization" | "plan_id"> | null, brief: SundayBrief | null): [SundayDecision[], (next: SundayDecision[]) => void] {
  const key = capture && brief ? decisionsStorageKey(brief.mode, capture.organization, capture.plan_id) : null;
  const [decisions, setDecisions] = useState<SundayDecision[]>([]);
  useEffect(() => { setDecisions(key ? loadDecisions(localStore(), key) : []); }, [key]);
  return [decisions, next => { setDecisions(next); if (key) saveDecisions(localStore(), key, next); }];
}
/**
 * The leader's decisions for each of several checks at once (the other services watched, owner decision 2026-11-19), by
 * their storage keys (decisionsStorageKey), kept on this Mac as useSundayDecisions keeps one.
 */
export function useDecisionsMap(keys: readonly string[]): [Readonly<Record<string, SundayDecision[]>>, (key: string, next: SundayDecision[]) => void] {
  const joined = keys.join("\n");
  const load = () => { const store = localStore(); return Object.fromEntries(keys.map(k => [k, store ? loadDecisions(store, k) : []])); };
  const [held, setHeld] = useState<{ joined: string; map: Record<string, SundayDecision[]> }>(() => ({ joined, map: load() }));
  // Read at once when the checks change, so a count never shows a resolved item for a moment.
  const map = useMemo(() => held.joined === joined ? held.map : load(), [held, joined]);
  useEffect(() => { if (held.joined !== joined) setHeld({ joined, map }); }, [joined]);
  return [map, (key, next) => { setHeld({ joined, map: { ...map, [key]: next } }); const store = localStore(); if (store) saveDecisions(store, key, next); }];
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
  blockout: ["plan_times", "team_members", "person_schedules", "person_blockouts"],
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
export const FIXED_HOW_END = "Why I flagged this lists the rule and the facts. Every read in the latest check is on What happened. Reading it changed nothing in Planning Center.";
/** "See how this works" under Why I flagged this: how the finding was worked out, and the reads it used. */
function HowFixed({ reads }: { reads: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const w = useSystemWords();
  return <div className="why-how stack-tight">
    <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> See how this works</button>
    {open && <div className="stack-tight small">
      <p>{w.say(FIXED_HOW)}</p>
      <ul className="list">{(w.reads ?? reads).map(r => <li key={r}><Icon name="dot" small />{r}</li>)}</ul>
      <p>{w.system === "planning-center" ? FIXED_HOW_END : w.howEnd}</p>
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
  const w = useSystemWords();
  return <SourceWhy sources={[finding.source ?? w.name]} at={finding.checked_at ?? checkedAt} why={finding.why} reads={readsFor(finding)} defaultOpen={defaultOpen} source={source} />;
}

/** When no one on the team can be listed: who else could help find someone. */
const noOneText = (finding: Finding, w?: SystemWords) => w && w.system !== "planning-center"
  ? w.noTeam ?? `No one else on this role's team in ${w.name} is clear for this time.`
  : finding.leaders?.length ? "You could ask the team's leader who else could help."
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
  const { say } = useSystemWords();
  return <div className={`person${left ? " is-left" : ""}`}>
    <Icon name={left ? "minus" : canDraft ? "user" : "question"} />
    <div>
      <div className="person-top">
        <span className="person-name">{nameOf(names, person.person_id)}</span>
        <span className={`badge ${left ? "b-muted" : label === "Possible conflict" ? "b-conflict" : canDraft ? "b-confirm" : "b-look"}`}>{label}</span>
        {action}
      </div>
      <p className="person-role">{say(plain(person.reasons))}</p>
      {children}
    </div>
  </div>;
}

/**
 * An open role's people as both lists show them (review K, L2): everyone not left out, then "Show N left out and why",
 * which opens those left out, so the fixed list and the AI's card under it can't show them differently. `none` is said
 * when everyone was left out.
 */
function FoldedPeople({ all, row, none = null }: { all: readonly Listed[]; row: (x: Listed) => ReactNode; none?: ReactNode }) {
  const [showLeft, setShowLeft] = useState(false);
  const shown = all.filter(x => !x.left), left = all.filter(x => x.left);
  return <>
    {shown.map(row)}
    {!shown.length && none}
    {left.length > 0 && <>
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={showLeft} onClick={() => setShowLeft(!showLeft)}>
        {showLeft ? "Hide" : "Show"} {left.length} left out and why
      </button>
      {showLeft && left.map(row)}
    </>}
  </>;
}

/**
 * A note's button (a person's row, the team's leader, a reminder): it says whether its note is open, as See who could
 * help does, and a second press closes it ("Prepare a note" becomes "Close the note").
 */
export const PREPARE_NOTE = "Prepare a note";
export const PREPARE_REMINDER = "Prepare a reminder";
export const closeLabel = (prepare: string) => prepare.replace(/^Prepare a /u, "Close the ");
/** Keeps each note button's element under a key ("person:<id>", "leader:<id>", "reminder"), so a note's X can go back to it. */
type Opener = (key: string) => (el: HTMLButtonElement | null) => void;

/**
 * An open role's people. A note to one of them opens right under their row, before the next person (click-through,
 * 2026-11-19: under the whole list it was off screen and the button seemed to do nothing). Hidden, the list stays in
 * the page, so a note being written there is kept until the people are shown again.
 */
function PeopleList({ finding, names, note, onNote, opener, hidden, asked = null, openPc = null, changes = null, busy = false, onUndone }: {
  finding: Finding; names: Names; onNote: (person: string) => void; opener: Opener; hidden: boolean;
  /** A mark's Undo on a row: where the keyboard goes as the mark goes (the card's title). */
  onUndone?: (() => void) | undefined;
  /** The open note, for the person it's to (one at a time per card). */
  note: { person: string; draft: ReactNode } | null;
  asked?: AskedSlot | null | undefined; openPc?: OpenPlanningCenter | null | undefined;
  /** Adding a person in Planning Center (change-card.tsx): only while changes are on and the check is live. */
  changes?: SundayChanges | null | undefined; busy?: boolean;
}) {
  const w = useSystemWords();
  const row = (x: Listed) => {
    const id = x.person.person_id, open = note?.person === id;
    return <Fragment key={id}>
      <PersonRow listed={x} names={names}
        // Whose note, for VoiceOver's list of buttons, where every row's read the same (audit M1): the visible words first,
        // then the name, as "Open … in Planning Center" on the same row says it.
        action={x.canDraft && <button type="button" className="btn btn-secondary btn-sm push" aria-expanded={open} ref={opener(`person:${id}`)}
          aria-label={`${open ? closeLabel(PREPARE_NOTE) : PREPARE_NOTE} to ${nameOf(names, id)}`}
          onClick={() => onNote(id)}>{open ? closeLabel(PREPARE_NOTE) : PREPARE_NOTE}</button>}>
        {openPc && <div className="person-pc"><OpenInPlanningCenter open={openPc} page="person" id={id} label={OPEN_PERSON} name={nameOf(names, id)} /></div>}
        {/* A mark shows once: in their open note, which follows this row, else here. */}
        {!open && asked?.lines.filter(l => l.key === finding.key && l.person_id === id).map(l => <AskedNote key={l.key + l.person_id} line={l} onUndone={onUndone} />)}
        {/* The leader's own click on one person, never a pick: the list's grouping and order stay as they are. */}
        {changes && isPersonId(id) && changes.row({ finding, person: id, full: nameOf(names, id), label: x.label, left: x.left, busy })}
      </PersonRow>
      {open && note?.draft}
    </Fragment>;
  };
  return <div className="stack people" hidden={hidden}>
    <p className="small">People on this {w.system === "planning-center" ? "team" : "role's team"} in {w.name}. Grouped by what Ozzie found, alphabetical within each group, not ranked. Whether someone is willing is theirs to say.</p>
    {changes?.waiting(finding)}
    <FoldedPeople all={listedPeople(finding, names)} row={row} none={<p className="find-body">{noOneText(finding, w)}</p>} />
  </div>;
}

/** Runs the who-could-help procedure through the harness for one open role (App: harness-bridge lookAtWhoCouldHelp). */
export type WhoCouldHelp = (finding: Finding, signal: AbortSignal) => Promise<AskTurn>;
export const LOOK_BUTTON = "Ask Ozzie to look at who could help";
export const LOOK_KEEPS = "The list above is still the full list from Ozzie's own check.";
export const LOOK_TITLE = "What the AI found when asked to look at the list above";
/**
 * "See how this works", how it ended: true to what the AI did, whether or not it asked for this role's list (review G, N3,
 * N4), even when it asked only for another role's, which its steps show (review K, L1).
 */
export function lookEnded(look: Look): string {
  switch (look.kind) {
    case "lines": return look.looked
      ? "Ozzie wrote a line for each fact the AI chose about the role. The people are Ozzie's own list for this role, the same as above."
      : "Ozzie wrote a line for each fact the AI chose about the role. The AI didn't ask for this role's list of people; the people are Ozzie's own list for this role, the same as above.";
    case "nothing": return look.looked ? "The AI looked at the list of people and chose nothing beyond it, so Ozzie said so."
      : "The AI didn't ask for this role's list of people and chose nothing about the role, so Ozzie said so.";
    case "not-covered": return "The AI answered that it couldn't tell more, so Ozzie said so.";
    case "draft": return "The AI asked for a note, which isn't prepared from this card, so Ozzie said so.";
  }
}

/**
 * What the AI found when asked to look at who could help with one role at one time, as a card next to the fixed list
 * (audit item 9; review H, M3; review G, M-1): Ozzie's own lines for the facts the AI chose about the role, then
 * everyone the finding lists, from the same source, in the same rows and with the same fold for those left out as the
 * fixed list (never the AI's copy, which may be cut to fit; review K, L2), with no one marked; or one line for what the
 * AI did instead. Where it came from and when, and See
 * how this works with the procedure word for word and the steps. Never a ranking, never a pick, never a note.
 */
export function WhoCouldHelpCard({ turn, finding, names }: { turn: AskTurn; finding: Finding; names: Names }) {
  const [how, setHow] = useState(false);
  const d = useDay();
  const role = finding.position?.name ?? "this role";
  if (turn.state !== "answered") {
    const said = turn.state === "no-model" ? NEEDS_AI.look : turn.text;
    return <div className="ai-look-note small" role={turn.state === "problem" ? "alert" : undefined}><p>{said}</p>
      {!/The list above is unchanged\./u.test(said) && <p>{LOOK_KEEPS}</p>}
      {turn.state === "no-model" && <ChooseAiButton />}</div>;
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
        <FoldedPeople all={people} row={x => <PersonRow key={x.person.person_id} listed={x} names={names} />} />
        <p className="small">{LOOK_NOTE}</p>
      </div>}
    </> : <p className="find-body">{line}</p>}
    {look.shortened > 0 && <p className="small">{lookShortened(look.shortened)}</p>}
    <p className="ask-based"><Icon name="check" small />{a.basedOn}</p>
    <button type="button" className="btn btn-quiet btn-sm ask-how" aria-expanded={how} onClick={() => setHow(!how)}><Icon name="info" small />See how this works</button>
    {how && <div className="ask-how-body stack-tight">
      {a.procedure && <><p className="bold">Ozzie followed this procedure: {procedureTitle(a.procedure.title, d) ?? a.procedure.title}</p><ProcedureBody body={a.procedure.body} /></>}
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

/**
 * A card's status ("Needs a decision", "Worth a look"), said as the end of its heading too, so VoiceOver's heading
 * navigation doesn't skip the app's main distinction (accessibility audit M2). The badge keeps its place on screen and is
 * hidden from VoiceOver, so the words are said once.
 */
export const HeadStatus = ({ words }: { words: string }) => <span className="sr-only">{` ${words}.`}</span>;

/** What the app's status line says as a mark is made, and taken back (accessibility audit S4). */
export const MARKED = `Marked “${LOOKS_GOOD}”. Undo is next to it.`;
export const UNMARKED = `Taken back: “${LOOKS_GOOD}”.`;
/**
 * "On Mon, Nov 16 you said you'd ask Riley about Greeter." with Undo: quiet, on the person's row, the card and Today.
 * Just made in a note (`focusOnMount`), it takes the keyboard, since the button that made it is gone; Undo says so, and
 * `onUndone` puts the keyboard where it goes next, since this line goes too (accessibility audit S3, S4).
 */
export function AskedNote({ line, focusOnMount = false, onUndone }: { line: AskedLine; focusOnMount?: boolean; onUndone?: (() => void) | undefined }) {
  const announce = useAnnounce();
  const here = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => { if (focusOnMount) here.current?.focus(); }, []);
  return <p className="small asked-line" ref={here} {...(focusOnMount ? { tabIndex: -1 } : {})}><Icon name="check" small /><span>{line.text}</span>
    <button type="button" className="btn btn-quiet btn-sm" onClick={() => { onUndone?.(); line.undo(); announce(UNMARKED); }}>Undo</button></p>;
}

const REWORD_LABEL: Record<Rewording, string> = { warmer: "Warmer", shorter: "Shorter", casual: "More casual", formal: "More formal" };

/** A note asking one person on the team (exported for tests): its To line and its addressee come from the same id. */
export function Draft({ finding, person, names, sender, sunday, canReword, onClose, people = null, mark = null, show }: {
  finding: Finding; person: string; names: Names; sender: string; sunday: string | null; canReword: boolean; onClose: () => void; people?: PeopleAccess | null; mark?: NoteMark;
  show?: ShowNote | undefined;
}) {
  const { say } = useSystemWords();
  const zone = useContext(ChurchZone);
  const ctx = { finding, person_id: person, sunday, zone };
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
      if (error instanceof Error && /draft|name|Ozzie/.test(error.message)) setProblem(error.message);
      // A pause of Ozzie's AI says until when, from the account (review: never "try again in a minute" during a pause).
      else setProblem(modelProblem(error, await model.status().then(st => st.account, () => null)));
    } finally { setWorking(null); }
  };
  return <DraftBox label="Draft note" to={nameOf(names, person)} addressee={addresseeFor(person, names, people)} body={body} onBody={b => { setBody(b); setEdited(true); setReworded(null); }} onClose={onClose}
    onSign={name => setBody(b => signNote(b, name))} mark={mark} show={show}
    footer={say(DRAFT_FOOTER)}>
    {canReword && <div className="find-next reword">
      <span className="find-next-l">Ask Ozzie to reword it</span>
      {(Object.keys(REWORDINGS) as Rewording[]).map(choice => <button key={choice} type="button" className="chip" disabled={working !== null} onClick={() => { void reword(choice); }}>
        {working === choice ? <Icon name="spinner" small spin /> : null}{REWORD_LABEL[choice]}</button>)}
    </div>}
    {canReword && <p className="small" role="status">{working ? "Rewording…" : reworded ? `Reworded: ${REWORD_LABEL[reworded].toLowerCase()}. Read it through before you copy it.` : ""}</p>}
    {canReword && edited && <p className="small">Rewording starts from Ozzie's last version. Your own changes stay on this Mac and are never sent.</p>}
    {/* Calm, not red (audit item 29): the note is unchanged and nothing broke; the words say what happened. */}
    {problem && <div role="status" className="panel-info reword-note"><Icon name="info" small /><p>{problem}</p></div>}
    {(problem === REWORD_NEEDS_AI || problem === REWORD_NOT_ON_MAC) && <ChooseAiButton />}
  </DraftBox>;
}

/** Called once as a note its button opened appears, with the note's element (FindingCard: showNote). */
type ShowNote = (note: HTMLElement) => void;

/**
 * The shared draft frame: never a send button. Copy it, open it unsent in Mail or Messages for the person to send, or
 * change the wording.
 */
export function DraftBox({ label, to, addressee = null, body, onBody, onClose, footer, children, startEditing = false, open, openTo, onSign, mark = null, signName, show }: {
  label: string; to?: string; body: string; onBody: (b: string) => void; onClose: () => void; footer: string; children?: ReactNode;
  /** Opened by its button just now (never by a Church rule as the card opened): brought into view and focused as it appears. */
  show?: ShowNote | undefined;
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
  const { say } = useSystemWords();
  const announce = useAnnounce();
  const [editing, setEditing] = useState(startEditing);
  const [copied, setCopied] = useState(false);
  const editId = useId();
  const box = useRef<HTMLDivElement>(null);
  // "Looks good — I'll send it" is replaced by the mark it made, and the mark's Undo by the button again: the keyboard
  // follows each (accessibility audit S3, S4).
  const [marking, setMarking] = useState(false);
  const offer = useRef<HTMLButtonElement>(null);
  const [offerAgain, setOfferAgain] = useState(false);
  useEffect(() => { if (offerAgain && offer.current) { offer.current.focus(); setOfferAgain(false); } }, [offerAgain, mark?.line]);
  // Only as it appears: a note that stays open never takes the focus back.
  useLayoutEffect(() => { if (show && box.current) show(box.current); }, []);
  // The name goes into the words shown (DraftActions keeps it on this Mac, as Settings' Your name for notes).
  const sign = (name: string) => { if (onSign) onSign(name); else onBody(signNote(body, name)); };
  return <div className="draft" role="region" aria-label={label} tabIndex={-1} ref={box}>
    <div className="row draft-head"><span className="badge b-draft">Draft only. Nothing has been sent.</span><span className="spacer" />
      <button type="button" className="ibtn" aria-label="Close the draft" onClick={onClose}><Icon name="x" /></button></div>
    {to && <p className="small draft-to">To {to}</p>}
    {editing
      ? <><label className="sr-only" htmlFor={editId}>{`${label}: change the wording`}</label>
        {/* Opened by "Change the wording", so the words to change get the focus. */}
        <textarea id={editId} className="draft-edit" value={body} onChange={e => { onBody(e.target.value); setCopied(false); }} rows={9} autoFocus /></>
      : <div className="draft-body">{body.split("\n\n").map((para, i) => <p key={i}>{para}</p>)}</div>}
    {/* The note's last line is [Your name] until the leader's name is set: asked once, here, under the note (spec §4.2). */}
    <DraftActions text={body} open={open} openTo={openTo} to={addressee} split onSign={sign} {...(signName ? { nameStore: { get: () => "", set: signName.set } } : {})}
      copy={<button type="button" className="btn btn-primary" onClick={() => { void navigator.clipboard?.writeText(body).then(() => setCopied(true)); }}>
        {copied ? "Copied — send it yourself" : "Copy draft"}</button>}
      after={<button type="button" className="btn btn-secondary" onClick={() => setEditing(!editing)}>{editing ? "Done changing" : "Change the wording"}</button>} />
    {/* The leader's own mark, a separate click after checking it: opening the note, addressed or not, never makes one. */}
    {mark && (mark.line ? <AskedNote line={mark.line} focusOnMount={marking} onUndone={() => { setMarking(false); setOfferAgain(true); }} />
      : <div className="find-next asked-offer"><button type="button" ref={offer} className="btn btn-secondary" aria-describedby={`${editId}-looks`}
        onClick={() => { setMarking(true); mark.onMark(); announce(MARKED); }}>{LOOKS_GOOD}</button>
        <span id={`${editId}-looks`} className="small">{say(LOOKS_GOOD_HELP)}</span></div>)}
    {children}
    <p className="small">{footer}</p>
  </div>;
}

/** A note to the team's leader. Written on this Mac in placeholder form and never offered for AI rewording. */
export function LeaderNote({ finding, leader, names, sender, sunday = null, onClose, people = null, mark = null, show }: {
  finding: Finding; leader: string; names: Names; sender: string; sunday?: string | null; onClose: () => void; people?: PeopleAccess | null; mark?: NoteMark;
  show?: ShowNote | undefined;
}) {
  const zone = useContext(ChurchZone);
  const ctx = { finding, leader_id: leader, sunday, zone };
  const [body, setBody] = useState(() => restoreEscalation(escalationDraft(ctx), ctx, names, sender));
  return <DraftBox label="Draft note to the team's leader" to={Object.hasOwn(names, leader) && names[leader] ? `${names[leader]} (team leader in Planning Center)` : "the team's leader in Planning Center"}
    addressee={addresseeFor(leader, names, people)} body={body} onBody={setBody} onClose={onClose} mark={mark} show={show}
    footer="Ozzie never sends messages. This note was written on this Mac; nothing in it went to an AI." />;
}

/** A reminder to someone whose request has no answer yet. Written on this Mac in placeholder form and never offered for AI rewording. */
export function ReminderNote({ finding, names, sender, sunday = null, onClose, people = null, mark = null, show }: {
  finding: Finding; names: Names; sender: string; onClose: () => void; people?: PeopleAccess | null; mark?: NoteMark;
  /** The plan's local date (YYYY-MM-DD), for a role with no service time. */
  sunday?: string | null;
  show?: ShowNote | undefined;
}) {
  // The plan's own date when the role has no service time, never a fixed day (review H4); a service time on the church's clock.
  const zone = useContext(ChurchZone);
  const [body, setBody] = useState(() => restoreReminder(reminderDraft(finding, sunday, zone), finding, names, sender));
  return <DraftBox label="Draft reminder" to={nameOf(names, finding.person_id)} addressee={addresseeFor(finding.person_id, names, people)} body={body} onBody={setBody} onClose={onClose} mark={mark}
    show={show} footer="Ozzie never sends messages. This note was written on this Mac; nothing in it went to an AI." />;
}

function LeaderButtons({ finding, names, label, open, opener, onPick }: {
  finding: Finding; names: Names; label: string; onPick: (leader: string) => void;
  /** The leader whose note is open, if any: that button says so and closes it. */
  open: string | null; opener: Opener;
}) {
  const leaders = alphabetical(finding.leaders ?? [], names);
  if (!canEscalate(finding)) return null;
  return <>{leaders.map(l => {
    const words = leaders.length === 1 ? label : `${label}: ${nameOf(names, l)}`;
    return <button key={l} type="button" className="btn btn-secondary btn-sm" aria-expanded={open === l} ref={opener(`leader:${l}`)} onClick={() => onPick(l)}>
      {open === l ? closeLabel(words) : words}</button>;
  })}</>;
}

/** A short reason, required, for a Sunday-only decision. */
export function DecisionForm({ choice, onSave, onCancel }: { choice: DecisionChoice; onSave: (reason: string) => void; onCancel: () => void }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState("");
  const d = useDay();
  const w = useSystemWords();
  const text = choiceText(d, w.name)[choice];
  return <form className="decide" onSubmit={e => {
    e.preventDefault();
    try { onSave(reason); } catch (error) { setProblem(error instanceof Error ? error.message : "That couldn't be saved."); }
  }}>
    <label className="field-l" htmlFor={id}>{text.question}</label>
    <input id={id} className="input" value={reason} maxLength={REASON_MAX} autoFocus placeholder={text.example}
      onChange={e => { setReason(e.target.value); setProblem(""); }} />
    <p className="input-help">Kept on this Mac. It applies to {d.thisOne} only, and this comes back if {w.name} changes.</p>
    {problem && <p role="alert" className="problem">{problem}</p>}
    <div className="find-next">
      <button type="submit" className="btn btn-primary btn-sm" disabled={!reason.trim()}>{text.save}</button>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Never mind</button>
    </div>
  </form>;
}

function Earlier({ decision }: { decision: SundayDecision }) {
  // The church's own system ("covered outside Breeze"), as the card's buttons say it.
  const text = choiceText(useDay(), useSystemWords().name);
  return <ul className="list earlier">
    {[...decision.earlier, decision].map(d => <li key={d.decided_at + d.reason}><Icon name="history" small />
      <span>Earlier, you said {text[d.choice].earlier} ({time(d.decided_at)}): “{d.reason}”</span></li>)}
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
/** The Mac's Reduce motion, read when a note opens: styles.css stills the page's own motion, but not a scroll asked for here. */
const reduceMotion = () => { try { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
/**
 * A note its button just opened (click-through, 2026-11-19): into view, then the keyboard focus, so VoiceOver reads it
 * where it opened. Like showTitle it scrolls only the page pane App gives, and only as far as it must: the note's end
 * into view, but never its top out of it, so the button pressed stays in view when the note fits. Smooth, unless this
 * Mac asks for reduced motion. With no pane, focusing it is the browser's own way into view.
 */
export function showNote(note: HTMLElement, pane: HTMLElement | null, still = reduceMotion()) {
  if (!pane) { note.focus(); return; }
  const n = note.getBoundingClientRect(), p = pane.getBoundingClientRect();
  const toTop = n.top - p.top - 16, toEnd = n.bottom - p.bottom + 16;
  const by = toTop < 0 ? toTop : toEnd > 0 ? Math.min(toEnd, toTop) : 0;
  if (by) pane.scrollBy({ top: by, behavior: still ? "auto" : "smooth" });
  note.focus({ preventScroll: true });
}
/**
 * "Only 1 confirmed person in Nursery at 9:30 AM." Services has no age: people, never "adults". `dayless`: the team is
 * already said with its own service (several services watched), so a time it doesn't have isn't every service's day words.
 * `zone`: the church's time zone, so the time is on the church's clock (this Mac's when it isn't known).
 */
export function fewConfirmedTitle(f: Finding, d: DayWords = SUNDAY_WORDS, dayless = false, zone: string | null = null): string {
  const c = f.confirmed?.length ?? 0, at = f.position!.interval ? ` at ${clock(f.position!.interval.starts_at, zone)}` : dayless ? "" : ` ${d.thisOne}`;
  // A church on B1 Church or Breeze (core church-systems/kids.ts): confirmed is who accepted there, said in its words.
  if (f.source) return c === 0 ? `No one has accepted in ${f.position!.name}${at}.` : `Only ${count(c, "person has", "people have")} accepted in ${f.position!.name}${at}.`;
  return c === 0 ? `No confirmed people in ${f.position!.name}${at}.` : `Only ${count(c, "confirmed person", "confirmed people")} in ${f.position!.name}${at}.`;
}
/** Pending is never confirmed, and an unsent request is never called asked. */
export function fewConfirmedBody(f: Finding): string {
  const asked = f.asked?.length ?? 0, unsent = f.not_sent?.length ?? 0;
  // A church on B1 Church or Breeze: someone it doesn't say was sent the request (Breeze) is never called asked or not sent.
  if (f.source) {
    const waiting = f.waiting?.length ?? 0;
    return [
      asked ? `${asked} more ${asked === 1 ? "is" : "are"} asked but ${asked === 1 ? "hasn't" : "haven't"} answered.` : "",
      unsent ? `${unsent} more ${unsent === 1 ? "is" : "are"} penciled in, but the request hasn't been sent.` : "",
      waiting ? `${waiting} more ${waiting === 1 ? "hasn't" : "haven't"} answered yet; ${f.source} doesn't say whether the request was sent.` : "",
      !asked && !unsent && !waiting ? "No one else is waiting to answer." : "",
      `Your Church rules ask for at least ${f.needed ?? 2} confirmed. Ozzie counts people who accepted in ${f.source} as confirmed; it doesn't check ages.`,
      f.tone === "look" ? `${f.source} has an answer Ozzie couldn't read for someone there, so this count may be low.` : "",
    ].filter(Boolean).join(" ");
  }
  return [
    asked ? `${asked} more ${asked === 1 ? "is" : "are"} asked but ${asked === 1 ? "hasn't" : "haven't"} answered.` : "",
    unsent ? `${unsent} more ${unsent === 1 ? "is" : "are"} penciled in, but the request hasn't been sent.` : "",
    !asked && !unsent ? "No one else is asked yet." : "",
    `Your Church rules ask for at least ${f.needed ?? 2}. Ozzie counts confirmed people; it doesn't check ages.`,
    f.tone === "look" ? "Planning Center doesn't show which service time some confirmed people serve, so this count may be low." : "",
  ].filter(Boolean).join(" ");
}
/** Nothing about a check beyond whether one is current on file, or when it runs out relative to the service's day. */
export function backgroundTitle(name: string, check: Finding["check"], d: DayWords = SUNDAY_WORDS): string {
  return check === "expires-before-sunday" ? `${name}'s background check on file expires before ${dayName(d)}.`
    : check === "expires-on-sunday" ? `${name}'s background check on file expires on ${dayName(d)}.`
      : `${name} has no current background check on file.`;
}

/** The Sunday a finding belongs to, for "This isn't right" (that Sunday only). */
export interface Occurrence { id: string; label: string | null }

/**
 * Something App shows beside a card, for its kind of finding and, when it has one, its team and position (SundayPage's
 * `beside`); this page knows nothing of what.
 */
export type Beside = (p: { kind: string; team_id?: string; position_id?: string; name?: string }) => ReactNode;

/**
 * Changes in Planning Center the leader confirms one at a time (change-card.tsx `sundayChanges`): App builds this only
 * while changes are on for the church in use, and this page shows it only for a live check. The page imports nothing
 * that makes a change; it draws what App hands it, where App says.
 */
export interface SundayChanges {
  /** On a person's row in who could help: the button for adding them, and the change under it (nothing when not offered). */
  row: (p: { finding: Finding; person: string; full: string; label: PeopleLabel; left: boolean; busy: boolean }) => ReactNode;
  /** What came back from changes confirmed just now, above the open cards. */
  results: ReactNode;
  /**
   * In place of an open role's people while the check a change came from is being taken again (the old one no longer
   * holds), or says that check didn't come; nothing for any other role.
   */
  recheck: (finding: Finding) => ReactNode;
  /** Above another open role's people while that check is being taken (its Add buttons wait too); nothing otherwise. */
  waiting: (finding: Finding) => ReactNode;
}

function FindingCard({ item, names, checkedAt, sender, sunday, canReword, onDecide, whoCouldHelp, feedback = null, occurrence, beside, people = null, asked = null,
  openPc = null, planId = null, titleRef: keepTitle, pane, changes = null, busy = false }: {
  item: DecidedItem; names: Names; checkedAt: string | null; sender: string; sunday: string | null; canReword: boolean; people?: PeopleAccess | null | undefined;
  asked?: AskedSlot | null | undefined;
  /** The page pane App scrolls, so a note opened by its button is brought into view by scrolling only it. */
  pane?: RefObject<HTMLElement | null> | undefined;
  /** "Open in Planning Center" for this plan and the people on the card (audit item 25); none in the example. */
  openPc?: OpenPlanningCenter | null | undefined; planId?: string | null | undefined;
  /** The title's element, so Today can open Sunday at this card. */
  titleRef?: ((el: HTMLElement | null) => void) | undefined;
  onDecide: (finding: Finding, choice: DecisionChoice, reason: string, previous: SundayDecision | null) => void;
  whoCouldHelp?: WhoCouldHelp | undefined;
  feedback?: FeedbackControls | null;
  occurrence: Occurrence;
  beside?: Beside | undefined;
  /** Adding a person in Planning Center from who could help: only while changes are on and the check is live. */
  changes?: SundayChanges | null | undefined; busy?: boolean;
}) {
  const { finding } = item;
  const d = useDay(), untimed = useContext(UntimedWhen), zone = useContext(ChurchZone);
  const w = useSystemWords();
  const CHOICE_TEXT = choiceText(d, w.name);
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
  // After a change to this role, its people wait for the new check (the old list no longer holds).
  const rechecking = changes?.recheck(finding) ?? null;
  const listed = finding.people ? [...finding.people.suggestions, ...finding.people.conflicts, ...finding.people.unverified] : [];
  const onRow = (person: string) => finding.kind === "needs-people" && hasPeople && open && listed.some(x => x.person_id === person);
  // A note to one person sits under their row whenever the list shows them (hidden with the list, and kept), otherwise
  // under the card's buttons.
  const underRow = Boolean(draftFor && hasPeople && listed.some(x => x.person_id === draftFor));
  const inOpenNote = (person: string) => (person === draftFor && (open || !underRow)) || person === leaderFor || (reminding && person === finding.person_id);
  // Each note's button, so the note's X gives the focus back to it; and the note last opened by a press, which alone is
  // brought into view and focused as it appears (a note a Church rule opened with the card leaves the focus where it is).
  const openers = useRef(new Map<string, HTMLButtonElement>());
  const opener: Opener = key => el => { if (el) openers.current.set(key, el); else openers.current.delete(key); };
  const [pressed, setPressed] = useState<string | null>(null);
  const show = (key: string): ShowNote | undefined => pressed === key ? note => showNote(note, pane?.current ?? null) : undefined;
  const closed = (key: string, close: () => void) => () => { openers.current.get(key)?.focus(); close(); };
  // One note open at a time to the team: a person's or the leader's, as before. A second press closes it.
  const notePerson = (person: string) => {
    if (draftFor === person) { setDraftFor(null); return; }
    setDraftFor(person); setLeaderFor(null); setPressed(`person:${person}`);
  };
  const noteLeader = (leader: string) => {
    if (leaderFor === leader) { setLeaderFor(null); return; }
    setLeaderFor(leader); setDraftFor(null); setPressed(`leader:${leader}`);
  };
  const remind = () => { if (reminding) setReminding(false); else { setReminding(true); setPressed("reminder"); } };
  // The card's title, which takes the keyboard when the control pressed goes away (Never mind, a mark's Undo; audit S3).
  const titleEl = useRef<HTMLHeadingElement | null>(null);
  const titleRef = (el: HTMLHeadingElement | null) => { titleEl.current = el; keepTitle?.(el); };
  const toTitle = () => titleEl.current?.focus();
  const decision = finding.tone === "decision";
  const tagWords = item.state === "reopened" ? "This needs attention again" : decision ? "Needs a decision" : "Worth a look";
  const tag = item.state === "reopened"
    ? <span className="badge b-attn" aria-hidden="true"><Icon name="flag" small />{tagWords}</span>
    : <span className={`badge ${decision ? "b-attn" : "b-look"}`} aria-hidden="true"><Icon name={decision ? "flag" : "eye"} small />{tagWords}</span>;
  const where = finding.position ? <span className="find-where">{finding.position.name} · {when(finding.position.interval, d, untimed, zone)}</span> : null;
  let title: string, body: string | null = null;
  switch (finding.kind) {
    case "needs-people":
      title = `${finding.position!.name} still needs ${finding.remaining === 1 ? "one more person" : `${finding.remaining} more people`}.`;
      { const n = finding.people?.suggestions.length ?? 0, c = finding.people?.conflicts.length ?? 0;
        body = !finding.people && w.noTeam ? w.noTeam : n + c === 0 ? "No one else on this team is clear for this time."
          : n === 0 ? `No one else on the team is clear with no overlap found; ${c === 1 ? "one person has" : `${c} people have`} a possible conflict.`
            : `${n === 1 ? "One person" : `${n} people`} on the team could help with no overlap found${c ? `, and ${c === 1 ? "one" : c} with a possible conflict` : ""}.`; }
      break;
    case "pending":
      title = `${nameOf(names, finding.person_id)} is pending for ${finding.position!.name}.`;
      // A system that doesn't say whether it was sent (Breeze): said as unknown, never as not sent.
      body = finding.notification === "sent" ? "The request was sent; there's no answer yet." : finding.notification === undefined && w.sentUnknown ? w.sentUnknown : w.notSent;
      break;
    case "streak":
      title = `${nameOf(names, finding.person_id)} is scheduled ${finding.sundays} weeks in a row.`;
      body = "Your Church rules suggest a quick check-in. This is about care, not performance.";
      break;
    case "lead-missing":
      title = `No one is scheduled to lead ${finding.position!.name} ${d.thisOne}.`;
      body = finding.leaders?.length ? `Ozzie found the team's leader in Planning Center, but no one scheduled to lead ${d.thisOne}. Is that expected?`
        : finding.leaders ? "Your Church rules ask for a scheduled lead, and Planning Center doesn't list a team leader. Is that expected?"
          : "Your Church rules ask for a scheduled lead. The team's leaders couldn't be read. Is that expected?";
      break;
    case "lead-unverified":
      title = `Ozzie couldn't confirm the scheduled lead for ${finding.position!.name}.`;
      body = "Planning Center has someone scheduled to lead, but their answer or serving time couldn't be confirmed, so Ozzie isn't counting it as covered.";
      break;
    case "too-few-confirmed":
      title = fewConfirmedTitle(finding, d, false, zone);
      body = fewConfirmedBody(finding);
      break;
    case "background-check":
      title = backgroundTitle(nameOf(names, finding.person_id), finding.check, d);
      body = `Scheduled for ${finding.position!.name} ${finding.position!.interval ? `at ${clock(finding.position!.interval.starts_at, zone)}` : d.thisOne}. Your Church rules ask for a current background check before serving with kids.${
        finding.tone === "look" && finding.check === "none-current" ? " Planning Center showed no current background checks for anyone on your kids teams; your Planning Center login may not be able to see them." : ""}`;
      break;
    case "blockout": {
      // Planning Center's own count stands: they're still counted, so no role reads as open (sunday-brief.ts).
      const one = blockoutTime(finding), many = (finding.serving?.length ?? 0) > 1;
      title = `${nameOf(names, finding.person_id)} is scheduled for ${blockoutRoles(finding)}${one ? ` at ${clock(one.starts_at, zone)}` : ""} and has a blockout in ${w.name} at ${one ? "that time" : "those times"}.`;
      body = `${w.name} still counts them as ${blockoutCounted(finding)}, so ${many ? "they aren't open spots" : "it isn't an open spot"}. Only they can say whether they'll be there.`;
      break;
    }
    default:
      // Facts about roles as the system lists them (a role not tied to a service time): said as roles, each reason shown
      // under the title; never "couldn't be checked" of a read that didn't fail, nor "Check again", which wouldn't help.
      if (finding.role_facts) {
        title = `${rolesUnchecked(finding.role_facts.roles)}.`;
        body = `Ozzie won't call ${dayName(d)} covered until ${finding.role_facts.roles === 1 ? "that role" : "those roles"} can be checked.`;
        break;
      }
      title = finding.stale ? "This check is out of date." : `Part of ${d.thisOne} couldn't be checked.`;
      body = finding.stale ? `It was read ${checkedAt ? time(checkedAt) : "earlier"}, more than 30 minutes ago. Check ${w.name} again before relying on it.`
        // A church system's read that truly failed: which part is listed below, and what to do (round 4).
        : finding.source && finding.source !== "Planning Center" && finding.unread?.length
          ? `${finding.source} didn't give Ozzie every part this time. What's missing, and what to do, is listed below. Ozzie won't call ${dayName(d)} covered until every part is read.`
        : `Ozzie won't call ${dayName(d)} covered until every part is read.`;
  }
  // For this Sunday only (under More choices): an open role covered another way, or not needed.
  const sundayOnly: DecisionChoice[] = finding.kind === "needs-people" ? ["covered-outside", "not-needed"] : [];
  const decisionForm = choosing && <DecisionForm key={choosing} choice={choosing} onCancel={() => { toTitle(); setChoosing(null); }}
    onSave={reason => { onDecide(finding, choosing, reason, item.decision); setChoosing(null); }} />;
  const pcPlan = openPc && planId && !finding.source ? <OpenInPlanningCenter open={openPc} page="plan" id={planId} label={OPEN_PLAN} /> : null;
  const main = (finding.kind === "needs-people" && (hasPeople || canEscalate(finding))) || finding.kind === "lead-missing" || canRemind(finding);
  const more = sundayOnly.length > 0 || Boolean(pcPlan) || feedbackShows(target, feedback);
  const personNote = draftFor && <Draft key={draftFor} finding={finding} person={draftFor} names={names} sender={sender} sunday={sunday} canReword={canReword}
    onClose={closed(`person:${draftFor}`, () => setDraftFor(null))} people={people} mark={markFor(asked, finding, draftFor)} show={show(`person:${draftFor}`)} />;
  return <article className={`find${finding.tone === "look" && item.state === "open" ? " is-look" : ""}${item.state === "reopened" ? " is-reopened" : ""}`}>
    <div className="find-top">{tag}{where}</div>
    <h3 className="find-title" tabIndex={-1} ref={titleRef}>{title}<HeadStatus words={tagWords} /></h3>
    {finding.role_facts && <ul className="list role-facts">{finding.role_facts.reasons.map(r => <li key={r}><Icon name="question" small />{r}</li>)}</ul>}
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
    {finding.kind === "needs-people" && !hasPeople && finding.people && <p className="find-body">{noOneText(finding, w)}</p>}
    {/* The card's main actions, then everything else under More choices (audit item 29). An open role: who could help and
        a note to the team's leader; a lead question: that it's expected, or a note to the leader; a pending request: a
        reminder. For this Sunday only, telling Ozzie about the card and Planning Center wait in the fold. */}
    {(main || more) && <div className="find-next card-actions">
      {finding.kind === "needs-people" && hasPeople && <button type="button" className="btn btn-secondary btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide people" : "See who could help"}</button>}
      {finding.kind === "needs-people" && <LeaderButtons finding={finding} names={names} label="Prepare a note to the team's leader" open={leaderFor} opener={opener} onPick={noteLeader} />}
      {finding.kind === "lead-missing" && !choosing && <button type="button" className="btn btn-sm btn-primary" onClick={() => setChoosing("lead-expected")}>{CHOICE_TEXT["lead-expected"].button}</button>}
      {finding.kind === "lead-missing" && <LeaderButtons finding={finding} names={names} label="Prepare a note to the leader" open={leaderFor} opener={opener} onPick={noteLeader} />}
      {canRemind(finding) && <button type="button" className="btn btn-secondary btn-sm" aria-expanded={reminding} ref={opener("reminder")} onClick={remind}>
        {reminding ? closeLabel(PREPARE_REMINDER) : PREPARE_REMINDER}</button>}
      {more && <MoreChoices>
        {sundayOnly.length > 0 && !choosing && <div className="find-next">
          <span className="find-next-l">For {d.thisOne} only:</span>
          {sundayOnly.map(c => <button key={c} type="button" className="btn btn-secondary btn-sm" onClick={() => setChoosing(c)}>{CHOICE_TEXT[c].button}</button>)}
        </div>}
        {choosing && choosing !== "lead-expected" && decisionForm}
        <FindingFeedback target={target} feedback={feedback} state={false} />
        {pcPlan && <div className="find-next">{pcPlan}</div>}
      </MoreChoices>}
    </div>}
    {choosing === "lead-expected" && decisionForm}
    {/* State, not a choice (review F, L-5): how soon Ozzie tells, and why a note opened by itself, next to that note and in
        view with More choices closed. */}
    <FeedbackState target={target} feedback={feedback} />
    {/* A note opens where it was asked for (click-through, 2026-11-19): a reminder or a note to the leader right under the
        card's buttons, a note to one person right under their row. */}
    {reminding && <ReminderNote finding={finding} names={names} sender={sender} sunday={sunday} onClose={closed("reminder", () => setReminding(false))} people={people}
      mark={markFor(asked, finding, finding.person_id)} show={show("reminder")} />}
    {leaderFor && <LeaderNote key={leaderFor} finding={finding} leader={leaderFor} names={names} sender={sender} sunday={sunday} onClose={closed(`leader:${leaderFor}`, () => setLeaderFor(null))}
      people={people} mark={markFor(asked, finding, leaderFor)} show={show(`leader:${leaderFor}`)} />}
    {finding.kind === "needs-people" && <>
      {/* Someone no longer on the list (a later check) keeps their note, here, rather than losing it. */}
      {personNote && !underRow && personNote}
      {/* After a change to this role, its people wait for the new check (the old list no longer holds); a note being
          written stays, hidden with the list. */}
      {open && rechecking}
      {hasPeople && (!rechecking || underRow) && <PeopleList finding={finding} names={names} hidden={!open || Boolean(rechecking)} note={underRow && draftFor ? { person: draftFor, draft: personNote } : null} onNote={notePerson}
        opener={opener} asked={asked} openPc={openPc} changes={changes} busy={busy} onUndone={toTitle} />}
      {hasPeople && open && !rechecking && whoCouldHelp && <AiLook finding={finding} names={names} look={whoCouldHelp} />}
    </>}
    {/* A mark shows once: in the note open for that person, else on their row in the people shown, else here on the card. */}
    {asked?.lines.filter(l => l.key === finding.key && !onRow(l.person_id) && !inOpenNote(l.person_id)).map(l => <AskedNote key={l.person_id} line={l} onUndone={toTitle} />)}
    {beside?.({ kind: finding.kind, ...(finding.position ? { team_id: finding.position.team_id, position_id: finding.position.id, name: finding.position.name } : {}) })}
    <Why finding={finding} checkedAt={checkedAt} />
  </article>;
}


/** What the app's status line says as a decision moves a card, and as Undo or removing a note moves it back (audit S4). */
export const decidedLine = (d: DayWords) => `Saved for ${d.thisOne} only. It's now under Resolved by you.`;
export const BACK_IN_LIST = "Brought back to the list.";
export const NOTE_REMOVED = "Your note is removed.";
export const DECISION_REMOVED = "Your decision is removed.";
// The leader's own decision changed nothing in Planning Center (true whether or not Ozzie can add people there).
const NO_LEAD_TEXT = "Planning Center still shows no confirmed lead; your decision here didn't change anything there.";

function ResolvedCard({ item, checkedAt, onUndo, titleRef }: { item: DecidedItem; checkedAt: string | null; onUndo: () => void; titleRef?: ((el: HTMLElement | null) => void) | undefined }) {
  const d = item.decision!, f = item.finding;
  const words = useDay(), untimed = useContext(UntimedWhen), zone = useContext(ChurchZone);
  const w = useSystemWords();
  const CHOICE_TEXT = choiceText(words, w.name);
  return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-you"><Icon name="user" small />Resolved by you — {words.thisOne} only</span>
      {f.position && <span className="find-where">{f.position.name} · {when(f.position.interval, words, untimed, zone)}</span>}</div>
    <h3 className="find-title" tabIndex={-1} ref={titleRef}>{CHOICE_TEXT[d.choice].done(d.subject.name)}</h3>
    <p className="find-quote">“{d.reason}”</p>
    <p className="find-body">You decided this {time(d.decided_at)}. {f.kind === "needs-people" ? w.remaining(f.remaining ?? 0) : w.system === "planning-center" ? NO_LEAD_TEXT : w.say("Planning Center still shows no confirmed lead; Ozzie hasn't changed anything there.")}</p>
    {d.earlier.length > 0 && <ul className="list earlier">{d.earlier.map(e => <li key={e.decided_at + e.reason}><Icon name="history" small />
      <span>Before that, you said {CHOICE_TEXT[e.choice].earlier} ({time(e.decided_at)}): “{e.reason}”</span></li>)}</ul>}
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onUndo}>Undo — bring it back to the list</button></div>
    <Why finding={f} checkedAt={checkedAt} />
  </article>;
}

function HistoryCard({ entry, onRemove }: { entry: DecisionHistory; onRemove: () => void }) {
  const d = entry.decision;
  const words = useDay(), untimed = useContext(UntimedWhen), zone = useContext(ChurchZone);
  const w = useSystemWords();
  const CHOICE_TEXT = choiceText(words, w.name);
  const where = <span className="find-where">{d.subject.name} · {when(d.subject.interval, words, untimed, zone)}</span>;
  if (entry.status === "source-confirmed") return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-ok"><Icon name="check" small />Confirmed in {w.name}</span>{where}</div>
    <h3 className="find-title">{d.kind === "lead-missing" ? `${w.name} now shows a confirmed lead for ${d.subject.name}.` : `${d.subject.name} is now filled in ${w.name}.`}</h3>
    <p className="find-body">{entry.checked_at ? `Checked ${time(entry.checked_at)}.` : ""} Your earlier note is kept below as history.</p>
    <Earlier decision={d} />
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onRemove}>Remove my note</button></div>
  </article>;
  const note = w.say(entry.status === "filled-pending" ? `Planning Center now shows no open requests for ${d.subject.name}, but someone there hasn't accepted yet.`
    : entry.status === "not-listed" ? `Planning Center no longer lists ${d.subject.name} on this plan.`
      : `This couldn't be rechecked in Planning Center, so it stands as your decision, not as confirmed coverage.`);
  return <article className="find is-resolved">
    <div className="find-top"><span className="badge b-you"><Icon name="user" small />Resolved by you — {words.thisOne} only</span>
      {entry.status === "couldnt-recheck" && <span className="badge b-look"><Icon name="eye" small />Worth a look</span>}{where}</div>
    <h3 className="find-title">{CHOICE_TEXT[d.choice].done(d.subject.name)}</h3>
    <p className="find-quote">“{d.reason}”</p>
    <p className="find-body">You decided this {time(d.decided_at)}. {note}</p>
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onRemove}>Undo — remove my decision</button></div>
  </article>;
}

const span = (i: { starts_at: string; ends_at: string }, zone: string | null) => `${clock(i.starts_at, zone)}–${clock(i.ends_at, zone)}`;
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

/**
 * A room or follow-up card's next step, naming where to do it when the card says where it was read (polish pass,
 * 2026-11-18): bookings from Planning Center Calendar, follow-ups from Planning Center People's workflows, as Why I
 * flagged this names them. Otherwise the core's own words, which name no product ("…in your church tools.").
 */
export function nextStep(f: RoomFinding | FollowUpFinding): string {
  if (f.kind === "room-overlap") {
    return f.evidence.some(e => e.source === "normalized-calendar") ? "Review these room bookings in Planning Center Calendar." : f.next_action;
  }
  return f.evidence.some(e => e.source === "normalized-workflow") ? "Choose who will handle this follow-up in Planning Center People." : f.next_action;
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
export function OperationsSection({ operations, whyOpen = false, feedback = null, occurrence = "", checkedAt = null, titleRef, followUps = true }: {
  operations: SundayOperations;
  /**
   * False for another service than the first (0.7.0): its own rooms only, under "Rooms", with words that never speak of
   * follow-ups (the church's, shown with the first service). Default: rooms and follow-ups, as always.
   */
  followUps?: boolean;
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
  const words = useDay(), untimed = useContext(UntimedWhen), zone = useContext(ChurchZone);
  const heading = followUps ? "Rooms and follow-ups" : "Rooms";
  const reads = followUps ? [...readsFor({ kind: "rooms" }), ...readsFor({ kind: "follow-ups" })] : readsFor({ kind: "rooms" });
  if (operations.stale) return <section className="stack" aria-label={heading}>
    <h2 className="h3">{heading}</h2>
    <article className="find is-look">
      <div className="find-top"><span className="badge b-look"><Icon name="clock" small />Out of date</span></div>
      <h3 className="find-title">{followUps ? "Rooms, follow-ups and group meetings aren't shown." : "Rooms and group meetings aren't shown."}</h3>
      <p className="find-body">This check was read more than 30 minutes ago, so Ozzie doesn't treat it as current. Check Planning Center again to see them.</p>
      <SourceWhy sources={["Planning Center"]} at={checkedAt} defaultOpen={whyOpen} reads={reads}
        why={[followUps ? "This check was read more than 30 minutes ago, so Ozzie doesn't treat its rooms, follow-ups or group meetings as current."
          : "This check was read more than 30 minutes ago, so Ozzie doesn't treat its rooms or group meetings as current.", "Anything changed in Planning Center since then isn't shown."]} />
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
      ...f.bookings.map(x => `The calendar shows ${label(x.booking_id, "a booking")} as ${x.status}, ${span(x.original, zone)}.`),
      f.resolution?.state === "unresolved" ? "Planning Center Calendar lists these two bookings as a conflict that hasn't been resolved."
        : "Planning Center doesn't show clearly whether these two bookings were worked out.",
    ];
    return <article className={`find${confirmed ? "" : " is-look"}`} key={f.finding_id}>
      <div className="find-top"><span className={`badge ${confirmed ? "b-attn" : "b-look"}`} aria-hidden="true"><Icon name={confirmed ? "flag" : "eye"} small />{f.label}</span>
        <span className="find-where">{label(f.resource_id, "A room")} · {when(f.overlap, words, untimed, zone)}</span></div>
      <h3 className="find-title">{label(f.resource_id, "A room")} has overlapping bookings from {span(f.overlap, zone)}.<HeadStatus words={f.label} /></h3>
      {a && b && <p className="find-body">{label(a.booking_id, "One booking")} ({span(a.original, zone)}) and {label(b.booking_id, "another booking")} ({span(b.original, zone)}) overlap
        {f.additional_setup_minutes ? `, counting the ${f.additional_setup_minutes} minutes of setup your Church rules set for this room` : ""}.</p>}
      <div className="find-next"><span className="find-next-l">Next step</span><span>{nextStep(f)}</span></div>
      <FeedbackChoices target={roomTarget(f, occurrence, labels)} feedback={feedback} />
      <OpsWhy evidence={f.evidence} why={why} reads={readsFor({ kind: "rooms" })} defaultOpen={whyOpen} />
    </article>;
  };
  const followUp = (f: FollowUpFinding) => <article className="find" key={f.finding_id}>
    <div className="find-top"><span className="badge b-attn" aria-hidden="true"><Icon name="flag" small />{f.label}</span>
      <span className="find-where">{label(f.workflow_id, "A follow-up")}</span></div>
    <h3 className="find-title">“{label(f.step_id, "A follow-up step")}” has no owner. It was due {churchTime(f.due_at, zone)}.<HeadStatus words={f.label} /></h3>
    <div className="find-next"><span className="find-next-l">Next step</span><span>{nextStep(f)}</span></div>
    <FeedbackChoices target={followUpTarget(f, occurrence, labels)} feedback={feedback} />
    <OpsWhy evidence={f.evidence} why={["This follow-up is active and ready on its current step.", "No one is assigned to it, and it isn't snoozed.", `Its due date, ${churchTime(f.due_at, zone)}, has passed.`]}
      reads={readsFor({ kind: "follow-ups" })} defaultOpen={whyOpen} />
  </article>;
  return <section className="stack" aria-label={heading}>
    <h2 className="h3" tabIndex={-1} ref={titleRef}>{heading}</h2>
    {result?.findings.map(f => f.kind === "room-overlap" ? room(f) : followUp(f))}
    {uncertainties.length > 0 && <article className="find is-look">
      <div className="find-top"><span className="badge b-look" aria-hidden="true"><Icon name="eye" small />Worth a look</span></div>
      <h3 className="find-title">{followUps ? "Some room or follow-up details couldn't be confirmed." : "Some room details couldn't be confirmed."}<HeadStatus words="Worth a look" /></h3>
      <ul className="list unread">{[...new Set(uncertainties.map(u => uncertaintyText[u.code] ?? (followUps ? "Part of the room and follow-up check couldn't be read." : "Part of the room check couldn't be read.")))]
        .map(t => <li key={t}><Icon name="question" small />{t}</li>)}</ul>
      <OpsWhy evidence={result?.checked_scopes ?? []} defaultOpen={whyOpen} reads={reads}
        why={["Ozzie doesn't treat something it couldn't confirm as clear, so it asks a person to look.", "Nothing about it changed in Planning Center."]} />
    </article>}
    {clear && <p className="small">{clear}{operations.checked_at ? ` (checked ${time(operations.checked_at)})` : ""}.</p>}
  </section>;
}

function GroupMeetingCard({ item, names, defaultOpen = false, feedback = null, occurrence = "" }: {
  item: GroupMeeting; names: Names; defaultOpen?: boolean; feedback?: FeedbackControls | null; occurrence?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const words = useDay(), untimed = useContext(UntimedWhen), zone = useContext(ChurchZone);
  const roles = [...new Set(item.serving.map(s => s.position ?? "their role"))].join(", ");
  const serving = [...new Set(item.serving.map(s => `${s.status} for ${s.position ?? "a role"}`))].join(" and ");
  const why = [
    ...item.meetings.map(m => `Planning Center Groups lists them in a group that meets ${span(m, zone)} ${words.thisOne}.`),
    ...item.serving.map(s => `Planning Center Services has them ${s.status} for ${s.position ?? "a role"}, ${span(s.interval, zone)}.`),
    "This is a schedule fact. Which one they go to is theirs to decide.",
  ];
  return <article className="find is-look">
    <div className="find-top"><span className="badge b-look" aria-hidden="true"><Icon name="eye" small />Worth a look</span>
      {item.serving[0] && <span className="find-where">{roles} · {when(item.serving[0].interval, words, untimed, zone)}</span>}</div>
    <h3 className="find-title">{nameOf(names, item.person_id)} has a group meeting at the same time.<HeadStatus words="Worth a look" /></h3>
    <p className="find-body">Their group meets {item.meetings.map(m => span(m, zone)).join(" and ")}, while they're {serving}.</p>
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
      <CopyForAdministrator />
      <p>{REFUSED.next}</p>
      {onSettings && <div className="find-next">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSettings}>{REFUSED.signInButton}</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSettings}>{REFUSED.chooseButton}</button>
      </div>}
    </div>
  </div>;
}

/**
 * What a page's check is and what can be done with it: the live read, saved copy or fictional example with its reads and
 * check time, Check now and the last saved check, the line about connecting or checking, and why a check failed. Said once:
 * on the one-service page under its question, and with several services (services-page.tsx) once above them all.
 */
export function PageControls(props: Pick<Parameters<typeof SundayPage>[0], "brief" | "busy" | "connected" | "configured" | "hasRecording" | "onCheck" | "onRecording"
  | "onExample" | "onLaterExample" | "checking" | "stuck" | "adding" | "onSetUp" | "onSettings" | "problem" | "refused"> & {
  /** What the page now says needs a decision ("2 things need a decision and 1 is worth a look."), said when a check the leader started ends. */
  summary?: string | undefined;
}) {
  const { brief } = props;
  const w = useSystemWords();
  const announce = useAnnounce();
  const stamp = useMemo(() => brief ? time(brief.checked_at ?? brief.completed_at) : null, [brief]);
  // Check now stays focusable while it checks (marked unavailable, never disabled, so the keyboard isn't dropped), and the
  // check it started is said when it ends: when, and what now needs a decision (accessibility audit S3e, S4). A check
  // that fails says so by its own alert below.
  const started = useRef(false);
  const wasBusy = useRef(props.busy);
  useEffect(() => {
    if (wasBusy.current && !props.busy && started.current) {
      started.current = false;
      if (!props.problem && stamp) announce([`Checked ${stamp}.`, props.summary].filter(Boolean).join(" "));
    }
    wasBusy.current = props.busy;
  }, [props.busy]);
  return <>
    {/* Always says what this is: a live read, the saved copy of a check, or the fictional example. */}
    {brief && <p className="checkline evidence"><Icon name="check" small />{brief.mode === "fictional" ? "Fictional example data" : brief.mode === "recording" ? w.savedCopy : w.liveRead} · {brief.sources.reads} reads · {stamp}{brief.sources.failed.length ? ` · ${brief.sources.failed.length} didn't complete` : ""}</p>}
    <div className="row" role="group" aria-label="What this page shows: a live check, the last saved check or the fictional example">
      <button type="button" className="btn btn-primary" disabled={!props.connected || !props.configured} aria-disabled={props.busy || undefined}
        onClick={() => { if (props.busy) return; started.current = true; props.onCheck(); }}>
        {props.busy ? <><Icon name="spinner" small spin />{w.checking}</> : w.checkNow}</button>
      {props.hasRecording && <button type="button" className="btn btn-secondary" disabled={props.busy} onClick={props.onRecording}>Show the last saved check</button>}
      {!brief && <button type="button" className="btn btn-quiet" onClick={props.onExample}>See a fictional example</button>}
      {brief?.mode === "fictional" && props.onLaterExample && <button type="button" className="btn btn-quiet" onClick={props.onLaterExample}>See a later fictional check</button>}
    </div>
    {/* The example's band already offers "Set up my church", so the page points there rather than to Settings (review L6). */}
    {brief?.mode === "fictional" && props.onSetUp ? <p className="small row"><span>{SET_UP_LINE}</span></p>
      : props.checking ? <p className="small" role="status" aria-live="polite">{CHECKING_LINE}</p>
      : props.stuck ? <p className="small row"><span role="status" aria-live="polite">{STUCK_LINE}</span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={props.stuck}>{CHECK_CONNECTION}</button></p>
      : props.adding ? null
      : (!props.connected || !props.configured) && <p className="small row">
        <span>{!props.connected ? w.unchosen ? `Choose what your church uses to check your own service. ${promise("connectAnd")}`
          : w.system === "planning-center" ? `Connect Planning Center to check your own service. ${promise("connectAnd")}` : `Connect ${w.name} to check your own service. Ozzie only reads it.` : "Choose which service Ozzie watches."}</span>
        {(props.onSetUp ?? props.onSettings) && <button type="button" className="btn btn-quiet btn-sm" onClick={props.onSetUp ?? props.onSettings}>
          {props.onSetUp ? !props.connected ? w.connect : "Choose a service" : "Open Settings"}</button>}</p>}
    {props.problem && !props.refused && <p role="alert" className="problem">{props.problem}</p>}
    {props.problem === CHECK_REFUSED && !props.refused && <CopyForAdministrator />}
    {props.problem && props.refused && <Refused onSettings={props.onSettings} />}
  </>;
}

/** One service's part of the Services page when several are watched (owner decision 2026-11-19). */
export interface ServicePartHead {
  /** The service's own Planning Center name; null when it has none ("Your service"). Display text, this Mac only. */
  name: string | null;
  /** No next plan of it yet (move-on.ts waitingText), said under its name. */
  waiting?: string | null;
  /**
   * Another service than the first, by the first one's name: the church's follow-ups (church-wide) are shown with the first
   * service, and What I didn't check says so. Its own rooms and group meetings show here, as `operations` (0.7.0).
   */
  opsWith?: string | null;
  /**
   * Another service on the same church-local day shows that day's room bookings, by its name (services-merge.ts
   * roomsHolders: the first on that day whose check read them in full), and What I didn't check says so. Null: this
   * service's rooms are its own. The first service's part can carry it too.
   */
  roomsWith?: string | null;
}
/** A service Planning Center gives no name. */
export const SERVICE_UNNAMED = "Your service";
/**
 * What I didn't check, for another service than the first whose check read nothing of Calendar, People or Groups (made
 * before those reads existed): its rooms and group meetings weren't checked, and the church's follow-ups are shown with the first service.
 */
export const opsWithLine = (first: string) => `Room bookings and group meetings aren't checked for this service. Follow-ups without an owner are shown with ${first}.`;
/** What I didn't check, for another service than the first: the church's follow-ups (church-wide) are shown with the first service. */
export const followUpsWithLine = (first: string) => `Follow-ups without an owner are shown with ${first}.`;
/** What I didn't check, for a service whose day's room bookings another service on the same day shows (roomsHolders). */
export const roomsWithLine = (holder: string) => `Room bookings for this day are shown with ${holder}.`;
/** What I didn't check for another service than the first: its own rooms and group meetings' lines, then where the rest is shown. */
export const otherServiceNotChecked = (operations: SundayOperations | null, part: Pick<ServicePartHead, "opsWith" | "roomsWith"> & { opsWith: string }): string[] =>
  operations ? [...operations.not_checked, ...(part.roomsWith ? [roomsWithLine(part.roomsWith)] : []), followUpsWithLine(part.opsWith)] : [opsWithLine(part.opsWith)];

export function SundayPage(props: {
  brief: SundayBrief | null; names: Names; busy: boolean; problem: string; sender: string;
  connected: boolean; hasRecording: boolean; configured: boolean; canReword: boolean;
  /** The launch's check of this Mac's saved sign-in is under way: say so quietly, and never "connect" (0.3.0 live). */
  checking?: boolean;
  /** That check had no answer after 20 seconds: say so, with a way to check again, and never "connect" (review L6). */
  stuck?: (() => void) | null;
  /**
   * A sign-in that only adds Calendar, People and Groups is in the browser: the church stays connected, so nothing here
   * offers to connect it (the offer's own card says what it waits for, read-more.tsx).
   */
  adding?: boolean;
  decisions: SundayDecision[]; onDecisions: (next: SundayDecision[]) => void;
  operations: SundayOperations | null;
  onCheck: () => void; onRecording: () => void; onExample: () => void; onLaterExample?: (() => void) | undefined;
  /** Opens Settings, where Planning Center is connected and the service chosen. */
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
  /**
   * Worth a look cards App adds for this service (the kids-team question, spec §4.2), after the open cards. Rendered only
   * when given.
   */
  worthALook?: ReactNode;
  /** Opens first run where it fits (connect, or choose the service); the example's line points to its band instead. */
  onSetUp?: (() => void) | undefined;
  /** Last Sunday in Check-Ins against the kids rules (church-reads-view.tsx), when Check-Ins was part of the check. */
  church?: ReactNode;
  /**
   * What else Ozzie can check with more of Planning Center (read-more.tsx, decision 24), where rooms and follow-ups show
   * once they are read. App passes it for a check of the church's own service, never the example.
   */
  more?: ReactNode;
  /** Last on the page, after What I didn't check: a church system's "Also read", folded closed (round 4). */
  last?: ReactNode;
  /** Shown on an open card for its team or position: App passes the church's own lists here (church-own-words.tsx). */
  beside?: Beside | undefined;
  /**
   * A church on another system whose last check built no service check: why, said in place of "hasn't been checked
   * yet" (system-pages.tsx `refusalLine`). Planning Center never passes one.
   */
  uncheckedLine?: string | null | undefined;
  /**
   * One of several services watched (owner decision 2026-11-19), shown as a part of the Services page (services-page.tsx):
   * headed by the service's own name under its date and times, with the page's question, count and buttons said once
   * above all the parts. Absent: the whole page, as for one service.
   */
  part?: ServicePartHead | undefined;
  /**
   * Adding a person who could help in Planning Center, one confirmed change at a time (change-card.tsx). App passes it only
   * while changes are on for the church in use, Planning Center is its system and this service's check on screen is live;
   * without it the page is as it always was.
   */
  changes?: SundayChanges | null | undefined;
}) {
  const { brief, names, decisions, onDecisions } = props;
  const announce = useAnnounce();
  // The check's own day: with several services watched each part's cards say their own service's day ("For this Wednesday
  // only", "Not needed this Wednesday"), whatever day is around the page (polish 2026-11-21). A brief built by hand has none.
  const around = useDay();
  const d = brief?.day ?? around;
  const w = useSystemWords();
  // Never for the example, a saved check or another church system, whatever App passes.
  const changes = brief?.mode === "live" && w.system === "planning-center" && !brief.source ? props.changes ?? null : null;
  // "Your name for notes" from Settings, put in on this Mac after any rewording; [Your name] when none is set.
  const sender = props.sender.trim() || yourName.get();
  const { controls, notice } = useFeedback(props.feedback, names);
  const occurrence: Occurrence = { id: brief?.plan.id ?? "", label: brief?.plan.dates ?? null };
  // The plan's own title, unless it only says the date the eyebrow already names (round 3: "Sunday Nov 22").
  const titled = brief?.plan.title?.trim() || null;
  const planTitle = titled && brief?.plan.date && titleOnlyDate(titled, brief.plan.date) ? null : titled;
  // Under the page's question, the facts of the plan checked: its day and date, then its service times on the church's
  // clock ("Sunday, November 22 · 9:30 AM and 11:00 AM"), then its own title.
  const dateText = brief?.day?.date ?? brief?.plan.dates ?? d.date ?? DayName(d);
  const timeText = brief ? timesText(brief.times ?? [], brief.time_zone) : null;
  // Whose clock those are, only when this Mac's reads them differently: "9:30 AM Eastern Time (New York)", the zone named
  // as Keeping watch and Settings name it (proactive-page.tsx zoneLabel). The cards' role, room, group and follow-up
  // times are on that clock too; when Ozzie checked and when the leader decided or added someone stay on this Mac's.
  const zoneText = timeText && brief?.time_zone && otherClock(brief.times ?? [], brief.time_zone, macZone()) ? ` ${zoneLabel(brief.time_zone)}` : "";
  const setAside = [...(brief?.hidden ?? []).map(h => h.entry), ...(props.operations?.hidden ?? []).map(h => h.entry)];
  const view = useMemo(() => brief ? applyDecisions(brief, decisions) : null, [brief, decisions]);
  // Everything the page shows, counted as items: Services, rooms, follow-ups and group meetings (the sidebar and Today use the same count).
  const counts = view ? sundayShownCount(view, props.operations) : { decisions: 0, looks: 0, resolved: 0 };
  const incomplete = Boolean(brief && (brief.stale || brief.findings.some(f => f.kind === "worth-a-look")));
  const roleFacts = roleFactsOf(brief);
  // A system that doesn't share how many people a role needs (Breeze): Ozzie can't call the service covered, so the page
  // says that once and shows who is on each role (round 4).
  const roster = brief?.roster && brief.roster.roles.length > 0 && brief.roster.roles.every(r => r.needed === null) ? brief.roster : null;
  const source = brief?.source ?? w.name;
  // Incomplete checks first, then anything that came back, then Planning Center's order.
  const rank = (i: DecidedItem) => i.finding.kind === "worth-a-look" ? 0 : i.state === "reopened" ? 1 : 2;
  const open = view ? view.items.filter(i => i.state !== "resolved").sort((a, b) => rank(a) - rank(b)) : [];
  // A plan with two or more service times (9:00 and 11:00): each time's findings under its own heading, so a pastor sees
  // what each service needs (core sunday-brief.ts byServiceTime, from the times the findings carry). A check that couldn't
  // be completed stays first, above them all; with one time, everything is listed together as before.
  const lead = open.filter(i => i.finding.kind === "worth-a-look");
  const timed = brief ? byServiceTime(open.filter(i => i.finding.kind !== "worth-a-look"), i => findingTime(i.finding), brief.times, brief.time_zone) : null;
  const groups = timed && timed.some(g => g.items.length > 0) ? timed : null;
  const resolved = view ? view.items.filter(i => i.state === "resolved") : [];
  const history = view?.history ?? [];
  // What needs a decision, as the lede says it and as a check the leader started is said when it ends.
  const countsText = !brief ? "" : roster ? `${rosterSummary(roster)} ${
    counts.decisions ? `${counts.decisions} ${counts.decisions === 1 ? "thing needs" : "things need"} a decision${counts.looks ? ` and ${counts.looks} ${counts.looks === 1 ? "is" : "are"} worth a look` : ""}. `
      : counts.looks ? `${counts.looks} ${counts.looks === 1 ? "thing is" : "things are"} worth a look. ` : ""}`
    : brief.status === "checked-scope-clear" ? "Everything Ozzie checked is covered. " :
    `${counts.decisions ? `${counts.decisions} ${counts.decisions === 1 ? "thing needs" : "things need"} a decision` : incomplete ? "Nothing in what was read needs a decision" : "Nothing needs a decision"}${counts.looks ? ` and ${counts.looks} ${counts.looks === 1 ? "is" : "are"} worth a look` : ""}. `;
  // Opened from Today at one card: move there once it's laid out, with its people (and their Prepare a note) open.
  const titles = useRef(new Map<string, HTMLElement>());
  const titleRef = (key: string) => (el: HTMLElement | null) => { if (el) titles.current.set(key, el); else titles.current.delete(key); };
  useLayoutEffect(() => {
    if (!props.focus) return;
    const title = titles.current.get(props.focus === "follow-ups" ? "rooms" : props.focus);
    if (title) showTitle(title, props.pane?.current ?? null);
    props.onFocused?.();
  }, [props.focus, brief]);
  // A decision moves its card to Resolved by you, and Undo moves it back: the keyboard follows the card's title (or, when
  // the card is gone, the heading it was under), and the app's status line says where it went (accessibility audit S3f–g, S4).
  const [focusTo, setFocusTo] = useState<string | null>(null);
  const resolvedHead = useRef<HTMLHeadingElement>(null);
  const openHead = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusTo) return;
    setFocusTo(null);
    // Without scrolling: a decision made with the mouse leaves the leader where they were in the list (review of 0.6.1).
    (titles.current.get(focusTo) ?? resolvedHead.current ?? openHead.current)?.focus({ preventScroll: true });
  }, [focusTo]);
  const onDecide = (finding: Finding, choice: DecisionChoice, reason: string, previous: SundayDecision | null) => {
    onDecisions(withDecision(decisions, decide(finding, choice, reason, new Date().toISOString(), previous)));
    setFocusTo(`resolved:${finding.key}`);
    announce(decidedLine(d));
  };
  const undo = (key: string) => { onDecisions(withoutDecision(decisions, key)); setFocusTo(key); announce(BACK_IN_LIST); };
  const removeNote = (h: DecisionHistory) => {
    onDecisions(withoutDecision(decisions, h.decision.key)); setFocusTo("resolved-heading"); announce(h.status === "source-confirmed" ? NOTE_REMOVED : DECISION_REMOVED);
  };
  const card = (i: DecidedItem) => brief && <FindingCard key={i.finding.key + i.state} item={i} names={names} checkedAt={brief.checked_at} sender={sender} sunday={brief.plan.date} canReword={props.canReword}
    onDecide={onDecide} whoCouldHelp={props.whoCouldHelp} asked={brief.mode === "fictional" ? null : props.asked} openPc={brief.mode === "fictional" ? null : props.openInPlanningCenter}
    planId={brief.plan.id} titleRef={titleRef(i.finding.key)} pane={props.pane} feedback={controls} occurrence={occurrence} beside={props.beside}
    people={brief.mode === "fictional" ? null : props.people} changes={changes} busy={props.busy} />;
  const part = props.part;
  const partId = useId();
  const Root = part ? "section" : "div";
  const untimed = part && d.date ? d.date : null;
  return <DayProvider value={d}><UntimedWhen.Provider value={untimed}><ChurchZone.Provider value={brief?.time_zone ?? null}>
    <Root className={part ? "stack service-part" : "col"} {...(part ? { "aria-labelledby": partId } : {})}>
    {/* The plan's own title from Planning Center, after its date as the plan picker shows it (click-through, 2026-11-19:
        added to the lede, it read as a sentence of its own). In its own case, and wrapped whole when long. */}
    <p className="eyebrow">{dateText}{timeText && ` · ${timeText}${zoneText}`}{planTitle && <> · <span className="eyebrow-plan">{planTitle}</span></>}</p>
    {part ? <h2 id={partId} className="h2">{part.name ?? SERVICE_UNNAMED}</h2> : <h1 className="h1">{d.question}</h1>}
    {part?.waiting && <p className="small" role="status">{part.waiting}</p>}
    {brief?.mode === "recording" && <p className="banner dashed"><Icon name="clock" small />Saved copy of the check from {time(brief.completed_at)}. This is not a current check.</p>}
    {/* The fictional example's band is across the top of every page (App.tsx ExampleBand); the line below still says it. */}
    {brief && <p className="lede">
      {brief.stale ? "This check is out of date, so it isn't a current picture. " : incomplete ? `${roleFacts ? rolesUnchecked(roleFacts.roles) : `Part of ${d.thisOne} couldn't be checked`}, so this isn't a full picture. ` : ""}
      {/* The facts first, the limit on a quieter line of its own below (round 5). */}
      {countsText}
      {counts.resolved > 0 && `You resolved ${counts.resolved} yourself. `}
      {/* Only the leader hides a finding ("This isn't right", "Stop flagging this"), so it says so, and where it can come back. */}
      {setAside.length > 0 && `You hid ${setAside.length === 1 ? "one finding" : `${setAside.length} findings`}: ${setAside.length === 1 ? "it's" : "they're"} under “${HIDDEN_BY_YOU}” at the end of this page, where you can bring ${setAside.length === 1 ? "it" : "them"} back. `}
    </p>}
    {brief && roster && <p className="small">{source} doesn't share how many people each role needs, so Ozzie can't say whether {d.thisOne} is covered.</p>}
    {!brief && (props.uncheckedLine ? <p className="lede" role="status">{props.uncheckedLine}</p>
      : part ? <p className="lede">{part.name ?? SERVICE_UNNAMED} hasn't been checked yet. Ozzie reads it with your other services.</p>
      : <p className="lede">{DayName(d)} hasn't been checked yet. Check {w.name} now, or look around the fictional example first.</p>)}
    {!part ? <PageControls {...props} summary={countsText.trim()} /> : <>
      {props.problem && !props.refused && <p role="alert" className="problem">{props.problem}</p>}
      {props.problem === CHECK_REFUSED && !props.refused && <CopyForAdministrator />}
      {props.problem && props.refused && <Refused onSettings={props.onSettings} />}
    </>}
    {brief && <section className="stack" aria-labelledby={part ? `${partId}-open` : "sunday-open-title"}>
      <h2 id={part ? `${partId}-open` : "sunday-open-title"} className="sr-only" tabIndex={-1} ref={openHead}>Open for {part?.name ?? d.thisOne}</h2>
      {notice}
      {changes?.results}
      {(groups ? lead : open).map(card)}
      {!groups && props.worthALook}
      {roster && <RosterSection roster={roster} names={names} source={source} at={brief.checked_at ?? brief.completed_at} />}
      {brief.findings.length === 0 && !roster && <p className="lede">{brief.hidden?.length ? "Nothing open in what was read, apart from what your Church rules set aside below."
        : "No open needs, pending requests or Church-rule check-ins in what was read."}</p>}
      {brief.findings.length > 0 && open.length === 0 && <p className="lede">Everything left is something you resolved yourself, below.</p>}
    </section>}
    {brief && groups?.map((g, n) => <section key={g.at ?? "none"} className="stack service-time" aria-labelledby={`${part ? partId : ""}service-time-${n}`}>
      <h2 id={`${part ? partId : ""}service-time-${n}`} className="h3">{g.at ? `${g.label} service` : g.label}</h2>
      {g.items.length ? g.items.map(card) : <p className="small">Nothing open for this service time in what was read.</p>}
    </section>)}
    {brief && groups && props.worthALook && <section className="stack" aria-label="Also worth a look">{props.worthALook}</section>}
    {(resolved.length > 0 || history.length > 0) && <section className="stack" aria-label="Resolved by you">
      <h2 className="h3" tabIndex={-1} ref={resolvedHead}>Resolved by you</h2>
      <p className="small">Your own decisions for {d.thisOne} only. They aren't coverage in {w.name}, and they come back here if something there changes.</p>
      {resolved.map(i => <ResolvedCard key={i.finding.key} item={i} checkedAt={brief!.checked_at} onUndo={() => undo(i.finding.key)} titleRef={titleRef(`resolved:${i.finding.key}`)} />)}
      {history.map(h => <HistoryCard key={h.decision.key} entry={h} onRemove={() => removeNote(h)} />)}
    </section>}
    {brief && brief.mode !== "fictional" && props.more}
    {brief && hasOperationsSection(props.operations) && <OperationsSection operations={props.operations} feedback={controls} occurrence={occurrence.id} titleRef={titleRef("rooms")}
      checkedAt={brief.checked_at ?? brief.completed_at} {...(part?.opsWith ? { followUps: false } : {})} />}
    {brief && props.operations && props.operations.group_meetings.length > 0 && <GroupMeetings items={props.operations.group_meetings} names={names}
      feedback={controls} occurrence={occurrence.id} />}
    {brief && props.church}
    {brief && <SetAside entries={setAside} feedback={controls} />}
    {brief && <section className="notchecked" aria-label="What I didn't check">
      <h2 className="h3">What I didn't check</h2>
      <ul className="list">{[...brief.not_checked, ...(part?.opsWith ? otherServiceNotChecked(props.operations, { opsWith: part.opsWith, roomsWith: part.roomsWith ?? null })
        : props.operations ? [...props.operations.not_checked, ...(part?.roomsWith ? [roomsWithLine(part.roomsWith)] : [])] : w.extras || brief.mode === "fictional" ? operationsNotChecked(null) : [])].map(n => <li key={n}><Icon name="dot" small />{n}</li>)}</ul>
      {/* A church system's rarer limits: true, folded, so the list above holds what a pastor acts on (round 5). */}
      {(brief.not_checked_more?.length ?? 0) > 0 && <details className="listen-more"><summary><Icon name="chev" small />More that Ozzie can't see in {source}</summary>
        <ul className="list">{brief.not_checked_more!.map(n => <li key={n}><Icon name="dot" small />{n}</li>)}</ul></details>}
    </section>}
    {brief && props.last}
  </Root></ChurchZone.Provider></UntimedWhen.Provider></DayProvider>;
}
