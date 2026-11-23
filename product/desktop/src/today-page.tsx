// Today: what needs the person, in the three settled groups (today-groups.ts says which item goes where),
// then the spoken briefing and what Ozzie read that needs nothing. Items can be set aside until tomorrow
// or Monday on this Mac; they come back on their own, with their age.
import { isTimeZone } from "../../../core/src/church-time.js";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { evaluateAttentionImport, type AttentionFinding, type Message, type CalendarEvent } from "../../../core/src/attention-import/index.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";
import { roleWithService, rosterNeedsYou, rosterSummary, serviceOfTeam, sundayShownCount, unnumberedRoster, type Roster, type RosterRole, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { useAlsoOperations, useTeamServices } from "./team-labels.js";
import { partKey, withOthers } from "./services-merge.js";
import type { SundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { Icon } from "./icons.js";
import { BriefingPanel } from "./briefing.js";
import type { Runner, RunnerView } from "./responsibility-runner.js";
import { NoticedCard, SwitchQuestionCard, watchLine, WriteUpBlock } from "./responsibility-views.js";
import { jobTitle, noticedChanges, noticedTitle, switchQuestionText, whenText } from "./responsibility-words.js";
import { browserStore, type KeyValueStore } from "./proactive.js";
import {
  ageText, backText, CAN_SET_ASIDE, countText, decisionLines, GROUP_OF, groupToday, ledeText, notesReadyText, pageNotes, progressEmptyText, regularLine, regularMissedText, setAsideChoices,
  sundayCountText, todayItems, todayMemory, type GroupId, type RegularCheck, type TodayItem, type TodaySunday,
} from "./today-groups.js";
import { correctionFor, type FeedbackEntry, type FeedbackTarget } from "../../../core/src/finding-feedback.js";
import { FindingFeedback, useFeedback, type FeedbackControls, type FeedbackSource } from "./finding-feedback.js";
import { BriefingPreview, briefingPreviewTimes, SundayReadyBrief } from "./sunday-ready.js";
import type { CalendarRead } from "../../../core/src/calendar/events.js";
import { CalendarGroup } from "./calendar-today.js";
import { AskedNote, CHECK_CONNECTION, CHECKING_LINE, HeadStatus, STUCK_LINE, type AskedLine } from "./sunday-page.js";
import { useDay, type DayWords } from "./day-words.js";
import { DayName, dayName, eyeLine, OPEN_SERVICES, pageRef, SERVICES } from "./day-phrases.js";
import { SERVICES_PAGE } from "../../../core/src/service-day.js";
import { promise } from "./promises.js";
import { systemWords, useSystemWords, type SystemWords } from "./church-system.js";
import { useAnnounce } from "./announce.js";

/** Keeping watch, for Today: it comes to the person here first. */
export interface TodayWatch {
  view: RunnerView; now: string;
  onAutomatic: () => void; onOpen: (page: "sunday" | "automatic" | "connection") => void;
  /** Answers a job's question after a switch of church (responsibility-runner.ts answerSwitch). */
  runner?: Pick<Runner, "answerSwitch">;
}

/** The fictional import's own clock and zone. */
const tz = "America/New_York";
const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const day = (iso: string, zone: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zone });
const clock = (iso: string, zone: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
const stamp = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
const isMessage = (s: Message | CalendarEvent): s is Message => "subject" in s;
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

const GROUPS: Readonly<Record<GroupId, { title: string; empty: string }>> = Object.freeze({
  attention: { title: "Needs your attention", empty: "Nothing needs your attention right now." },
  review: { title: "Ready to review", empty: "Nothing to review. Briefings and notes Ozzie prepares will be here." },
  // Said from what would start something (today-groups.ts progressEmptyText), never "nothing is under way" while the regular check runs.
  progress: { title: "In progress", empty: "" },
});

/** An email-and-calendar finding as Church rules see it: "This isn't right" sets it aside for that import. */
const attentionTarget = (f: AttentionFinding): FeedbackTarget => ({
  kind: "attention", key: f.id, occurrence: f.imported_at.slice(0, 10), facts: JSON.stringify([...f.source_ids].sort()), tone: "decision", scope: {},
});

/** An email that disagrees with the calendar, from the fictional import. */
function EmailCard({ finding, sources, titleId, age, feedback = null, children }: {
  finding: AttentionFinding; sources: (Message | CalendarEvent)[]; titleId: string; age: string | null; feedback?: FeedbackControls | null; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const event = sources.find(s => !isMessage(s) && finding.source_ids.includes(s.id)) as CalendarEvent | undefined;
  return <article className="find" aria-labelledby={titleId}>
    <div className="find-top">
      <span className="badge b-attn" aria-hidden="true"><Icon name="flag" small />Needs a decision</span>
      {event && <span className="find-where">{event.title} · {clock(event.start_at, tz)} tonight · {event.location}</span>}
      {age && <span className="find-age">{age}</span>}
    </div>
    <h3 id={titleId} className="find-title">{finding.title}<HeadStatus words="Needs a decision" /></h3>
    <p className="find-body">{finding.statement} {finding.why_now}</p>
    <p className="find-quote">{finding.communication}</p>
    <div className="find-next"><span className="find-next-l">Next step</span><span>{finding.next_step}</span></div>
    <div className="find-src">
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> Why I flagged this</button>
      <span>Fictional import · {stamp(finding.imported_at)}</span>
      {open && <ul className="list why">
        <li><Icon name="dot" small />Rule: when a message and the calendar disagree about something happening soon, a person decides.</li>
        {finding.evidence.map(e => {
          const m = sources.find(s => s.id === e.message_id) as Message | undefined;
          return <li key={e.message_id + e.anchor.start}><Icon name="dot" small />Email “{m?.subject}”, received {m ? stamp(m.received_at) : "—"}: “{e.anchor.quote}”</li>;
        })}
        {event && <li><Icon name="dot" small />Calendar “{event.title}”, last changed {stamp(event.modified_at)}: still lists {event.location}, {event.status}.</li>}
        <li><Icon name="dot" small />Ozzie didn't mark anything read, move anything or change the calendar.</li>
      </ul>}
    </div>
    {/* Email and calendar bring no notices, so only "This isn't right" applies here. */}
    <FindingFeedback target={attentionTarget(finding)} feedback={feedback} urgency={false} occasion="for this import" source="what was imported" />
    {children}
  </article>;
}

/** "your Wednesday", or "your service(s)" when the service isn't on one day (or none is chosen yet). */
const yourService = (d: DayWords) => d.kind === "weekday" ? `your ${d.day}` : d.kind === "unknown" ? "your service" : "your services";
/** The not-connected card's title (spec §2, after the failures table), named by the watched service's day. */
export const connectTitle = (d: DayWords, system = "Planning Center") => `Connect ${system} to see ${yourService(d)}`;
/** Its body: what connecting is, then the promise (promises.ts, never retyped). Another system connects with its own key. */
export const connectBody = (w?: SystemWords) => w?.unchosen
  ? `Nothing on this page is about your church yet. ${promise("systemsRead")}`
  : w && w.system !== "planning-center"
  ? `Nothing on this page is about your church yet. Connecting takes a key from your church's ${w.name}, and Ozzie only reads it: it never changes anything in ${w.name}.`
  : `Nothing on this page is about your church yet. Connecting is a sign-in in your browser, and ${promise("connectAnd")}`;

/** The plain title of an item, for the set-aside list. Named by the watched service's real day (spec §5). */
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
/** One role a pastor should look at, with the names on this Mac: who hasn't answered, or that nobody has said yes. */
function needsYouLine(r: RosterRole, names: Readonly<Record<string, string>>): string {
  const who = (ids: string[]) => { const n = ids.map(id => (Object.hasOwn(names, id) && names[id]) || "Someone").sort((a, b) => a.localeCompare(b));
    return n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)!}`; };
  const parts = [
    r.waiting.length ? `${who(r.waiting)} ${r.waiting.length === 1 ? "hasn't" : "haven't"} answered yet` : "",
    !r.yes.length && !r.waiting.length && r.declined.length ? `${who(r.declined)} said no, and nobody else on it has said yes` : "",
    !r.yes.length && !r.waiting.length && !r.declined.length && !r.unknown.length ? "nobody is listed yet" : "",
  ].filter(Boolean);
  return `${r.name}: ${parts.join("; ")}.`;
}
function itemTitle(item: TodayItem, now: string, d: DayWords, w: SystemWords = systemWords(null), roster: Roster | null = null, many = false): string {
  const s = item.subject;
  switch (s.type) {
    case "roster": return roster ? `On ${dayName(d)}, ${lowerFirst(rosterSummary(roster))}` : d.question;
    case "email": return s.finding.title;
    // Any kind of finding that needs a decision counts here, so the words don't assume positions.
    // More than one service watched (owner decision 2026-11-19): the count is across them all, so no one day is named.
    case "sunday": return many ? `Your services have ${sundayCountText(s.decisions)}.` : `${DayName(d)} has ${sundayCountText(s.decisions)}.`;
    case "sunday-unchecked": return d.question;
    case "connect": return w.unchosen ? `Choose what your church uses to see ${yourService(d)}` : w.system === "genesis" ? "Connect Genesis to see what it shares" : connectTitle(d, w.name);
    case "noticed": return noticedTitle(s.item, now, d);
    case "watching": return jobTitle(s.responsibility);
    // Genesis has no service to keep an eye on: its own reads are what runs (review of e9cbd97d, H1).
    case "regular": return w.system === "genesis" ? "Ozzie reads Genesis on its own" : eyeLine();
    case "answers": return `Waiting for an answer in ${w.name}`;
    case "job-question": return switchQuestionText(s.question).title;
  }
}

const NO_NAMES: Record<string, string> = {};
const NO_DECISIONS: readonly SundayDecision[] = [];
const NO_ENTRIES: readonly FeedbackEntry[] = [];
const NO_ASKED: readonly AskedLine[] = [];
/** A saved check shown on Today, with the time it was made (the service page's own words for it). */
export const savedLine = (iso: string) => `Saved copy of the check from ${new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`;
export const START_TITLE = "Ozzie isn't set to start with this Mac";
export const START_BODY = "Ozzie can only check Planning Center while it is running, so after this Mac restarts nothing is checked until you open it. Start Ozzie with this Mac?";

export function TodayPage({ brief, onSunday, names = NO_NAMES, sundayDecisions = NO_DECISIONS, operations = null, watch = null, now: nowProp, zone: zoneProp, store = browserStore,
  feedback = null, example = false, church = null, calendar = null, regular = null, notConnected = null, asked = NO_ASKED, onSundayCard,
  startQuestion = null, finish = null, moment = null, waiting = null, checking = false, stuck = null, services = 1, serviceLess = null }: {
  /**
   * A church whose system shares no volunteer schedules (Genesis, round 5): no service card, no unchecked service and no
   * spoken briefing of one; this shows what the system does share in their place.
   */
  serviceLess?: ReactNode;
  brief: SundayBrief | null; onSunday: () => void; names?: Record<string, string> | undefined; sundayDecisions?: readonly SundayDecision[];
  /** How many services Ozzie watches (owner decision 2026-11-19): with more than one, `brief` holds them all and no one day is named. */
  services?: number;
  /** Rooms, follow-ups and group meetings for the same check, so the briefing says what the Sunday page says. */
  operations?: SundayOperations | null;
  /** Keeping watch and what it noticed; null where it isn't available. */
  watch?: TodayWatch | null;
  /** This Mac's clock; set-aside items come back when it passes their time. */
  now?: string; zone?: string;
  /** Where set-aside and first-seen times are kept on this Mac. */
  store?: KeyValueStore;
  /** What the person tells Ozzie on finding cards, kept with the Church rules. */
  feedback?: FeedbackSource | null;
  /**
   * The fictional example is on (the person chose "See the fictional example"): its invented email-and-calendar items
   * (an invented church's inbox, including an email Ozzie ignores on purpose) show with it, and only then, so they never
   * sit on a real or a not-yet-connected Today (audit item 2).
   */
  example?: boolean;
  /**
   * "Ozzie isn't set to start with this Mac" (audit item 23): asked once on Today of an install set up before setup asked
   * it, while Ozzie doesn't start with the Mac. The switch changes only on the leader's click.
   */
  startQuestion?: { onYes: () => void; onNo: () => void; failed: boolean } | null;
  /** Opens Sunday at one card (its finding key, or "rooms" / "follow-ups"), with what to do there in view (audit item 17). */
  onSundayCard?: ((key: string) => void) | undefined;
  /** "Looks good — I'll send it" marks for the Sunday shown (App.tsx keeps them): said quietly on the Sunday card, with Undo. */
  asked?: readonly AskedLine[];
  /** Planning Center isn't connected and the example isn't on: Today says what to do next, with these two ways on. */
  notConnected?: { onConnect: () => void; onExample: () => void } | null;
  /** The launch's check of this Mac's saved sign-in is under way: a quiet polite line, and never "not connected". */
  checking?: boolean;
  /** That check had no answer after 20 seconds: said, with "Check the connection" (review L6). */
  stuck?: (() => void) | null;
  /** People forms, Check-Ins and Registrations from the same check (church-reads-view.tsx), after the three groups. */
  church?: ReactNode;
  /**
   * The leader's own calendars (calendars.ts), once one is connected: "On your calendar" replaces the fictional
   * example. Shown on this Mac only; null when none is connected.
   */
  calendar?: { reads: readonly CalendarRead[]; reading: boolean; onSettings?: () => void } | null;
  /** Ozzie's hourly look at the watched service (Keeping watch): under In progress once it can run. Null in the example. */
  regular?: RegularCheck | null;
  /** "Finish setting up" (spec §4.1), at the top of Today above the three groups; App passes it while any item is open. */
  finish?: ReactNode;
  /** One line under it: a question at the moment it matters (spec §4.2), such as the phone notice. */
  moment?: ReactNode;
  /**
   * No next plan of the watched service yet (spec §5.3, move-on.ts `waitingText`): said in place of the unchecked card,
   * with no button. Null otherwise.
   */
  waiting?: string | null;
}) {
  const words = useDay();
  const w = useSystemWords();
  const now = nowProp ?? watch?.now ?? new Date().toISOString();
  const zone = zoneProp ?? macZone();
  const { controls, notice } = useFeedback(feedback, names);
  const entries = feedback?.entries ?? NO_ENTRIES;
  const imported = useMemo(() => evaluateAttentionImport(harborAttentionImport()), []);
  // "This isn't right" sets an email-and-calendar finding aside for that import, before grouping and in the briefing.
  const report = useMemo(() => imported.ok ? { ...imported, findings: imported.findings.filter(f => !correctionFor(entries, attentionTarget(f))) } : imported, [imported, entries]);
  const input = useMemo(() => harborAttentionImport(), []);
  // Findings set aside by the person's Church rules are already out of the brief, so Sunday's count leaves them out too.
  const decided = useMemo(() => brief ? applyDecisions(brief, sundayDecisions) : null, [brief, sundayDecisions]);
  // With more than one service watched, each other service's own rooms and group meetings (services-merge.ts), counted
  // and said with its service as the Services page shows them; undefined with one service, which reads as before.
  const also = useAlsoOperations();
  const spoken = useMemo(() => {
    const more = also ? { alsoOperations: also } : {};
    if (!example) return { attention: null, sunday: brief, decided, ignoredInstructions: 0, quietCount: 0, operations, ...more };
    if (!report.ok) return null;
    const flagged = new Set(report.findings.flatMap(f => f.source_ids));
    const ignored = input.assertions.filter(a => a.kind === "untrusted-instruction").map(a => a.message_id);
    return { attention: report, sunday: brief, decided, ignoredInstructions: ignored.length,
      quietCount: report.sources.filter(s => !flagged.has(s.id) && !ignored.includes(s.id)).length, operations, ...more };
  }, [report, input, brief, decided, operations, example, also]);

  const memory = useMemo(() => todayMemory(store), [store]);
  const [setAside, setSetAside] = useState(() => memory.setAside());
  const [firstSeen, setFirstSeen] = useState(() => memory.firstSeen());
  // Said by the app's one status line (announce.tsx), which Today's own line became (accessibility audit S4).
  const setAnnouncement = useAnnounce();
  const headings = useRef<Partial<Record<GroupId, HTMLHeadingElement | null>>>({});
  const [focusGroup, setFocusGroup] = useState<GroupId | null>(null);

  // A church system that doesn't share how many people each role needs (Breeze): who is on each role is what is known.
  const roster = unnumberedRoster(brief);
  // With more than one service watched, each role is said with its service (team-labels.ts); undefined with one.
  const teamServices = useTeamServices();
  // The same count as the Sunday page's headline and the sidebar: Services, rooms and follow-ups that need a decision.
  const sunday: TodaySunday | null = useMemo(() => brief && decided ? {
    plan_id: brief.plan.id, checked_at: brief.completed_at, decisions: withOthers(sundayShownCount(decided, operations), also?.also ?? []).decisions,
    answers: [...new Set(decided.items.filter(i => i.state !== "resolved" && i.finding.notification === "sent")
      .flatMap(i => i.finding.position ? [roleWithService(i.finding.position.name, serviceOfTeam(i.finding.position.team_id, teamServices))] : []))],
    ...(roster ? { unknownNeed: { needsYou: rosterNeedsYou(roster).length > 0 } } : {}),
  } : null, [brief, decided, operations, roster, teamServices, also]);
  // Each decision named on the Sunday card (audit item 17), in the Sunday page's order, and Worth a look counted apart.
  const named = useMemo(() => {
    if (!decided) return null;
    const found = (o: SundayOperations | null) => o && !o.stale ? o.result?.findings ?? [] : [];
    const ops = found(operations);
    const confirmed = (o: SundayOperations | null) => found(o).filter(f => f.kind === "room-overlap" && f.certainty === "confirmed").length;
    // Each service's rooms on a line of its own, with its service, opening its own part of the Services page.
    const rooms = also ? [{ key: "rooms", service: also.first, count: confirmed(operations) },
      ...also.also.map(o => ({ key: partKey(o.plan_id, "rooms"), service: o.service, count: confirmed(o.operations) }))] : undefined;
    const lines = decisionLines(decided.items, { rooms: confirmed(operations), followUps: ops.filter(f => f.kind !== "room-overlap").length },
      brief?.time_zone ?? zone, words, teamServices, rooms);
    return { ...lines, looks: withOthers(sundayShownCount(decided, operations), also?.also ?? []).looks };
  }, [decided, operations, brief?.time_zone, zone, words, teamServices, also]);
  const toCard = onSundayCard ?? (() => onSunday());
  const items = useMemo(() => todayItems({
    now, sunday, watch: watch?.view ?? null, firstSeen, regular, notConnected: Boolean(notConnected) && !example, noService: Boolean(serviceLess) && !notConnected,
    attention: example && report.ok ? { findings: report.findings, messages: report.sources.filter(isMessage), evaluated_at: report.evaluated_at, zone: tz } : null,
  }), [now, sunday, watch?.view, firstSeen, report, example, regular, notConnected, Boolean(serviceLess)]);
  const grouped = groupToday(items, setAside, now);

  // Ages for items without a time of their own start when they are first on Today on this Mac.
  const unseen = items.filter(i => (i.id.startsWith("sunday:") || i.id.startsWith("answers:")) && !firstSeen[i.id]).map(i => i.id).join("|");
  useEffect(() => {
    const changed = memory.noteSeen(items.filter(i => i.id.startsWith("sunday:") || i.id.startsWith("answers:")).map(i => i.id), now);
    if (changed) setFirstSeen(changed);
    // Runs when an item first appears (`unseen` changes), not on every tick of `now`.
  }, [unseen, memory]);
  // After setting an item aside or bringing it back, focus lands on its group's heading rather than nowhere.
  useEffect(() => { if (focusGroup) { headings.current[focusGroup]?.focus(); setFocusGroup(null); } }, [focusGroup]);

  // "Preview this briefing" on the morning briefing's card: which responsibility's preview is open.
  const [previewing, setPreviewing] = useState<string | null>(null);
  const putAside = (item: TodayItem, until: string) => {
    setSetAside(memory.setAsideUntil(item.id, until, now));
    setAnnouncement(`Set aside. ${backText(until, now, zone)}.`);
    setFocusGroup(GROUP_OF[item.state]);
  };
  const bringBack = (item: TodayItem) => {
    setSetAside(memory.bringBack(item.id));
    const group = GROUP_OF[item.state];
    setAnnouncement(`Back in ${GROUPS[group].title}.`);
    setFocusGroup(group);
  };

  const flagged = new Set(report.ok ? report.findings.flatMap(f => f.source_ids) : []);
  const injected = input.assertions.filter(a => a.kind === "untrusted-instruction");
  const quiet = report.ok ? report.sources.filter(s => !flagged.has(s.id) && !injected.some(a => a.message_id === s.id)) : [];
  const choices = setAsideChoices(now, zone);
  const open = watch?.onOpen ?? ((page: "sunday" | "automatic" | "connection") => { if (page === "sunday") onSunday(); });
  // Thursday's briefing carries the full Sunday Ready brief from the Sunday on screen (NoticedCard shows it only there).
  const sundayReady = <SundayReadyBrief brief={brief} decisions={sundayDecisions} operations={operations} names={names} onSunday={onSunday} />;

  const card = (item: TodayItem) => {
    const titleId = `today-${item.id.replace(/[^\w-]/gu, "-")}`;
    const age = item.clock ? ageText(item, item.clock.now, item.clock.zone) : ageText(item, now, zone);
    const later = CAN_SET_ASIDE[GROUP_OF[item.state]] && choices.length > 0 && <div className="today-later" role="group" aria-label="Set aside">
      {choices.map(c => <button key={c.label} type="button" className="btn btn-quiet btn-sm" aria-describedby={titleId} onClick={() => putAside(item, c.until)}>
        <Icon name="clock" small />{c.label}</button>)}
    </div>;
    const s = item.subject;
    switch (s.type) {
      case "email": return <EmailCard key={item.id} finding={s.finding} sources={report.ok ? report.sources : []} titleId={titleId} age={age} feedback={controls}>
        <p className="small fictional-note"><Icon name="info" small />Fictional import: invented email and calendar records for “{input.workspace_id === "harbor" ? "Harbor Example Church" : input.workspace_id}”. Not a connected mailbox.</p>
        {later}</EmailCard>;
      case "sunday": {
        // A Keep Sunday covered report about this Sunday is folded in here (today-groups.ts): when, what changed, notes ready.
        const changes = s.noticed ? noticedChanges(s.noticed, names, words) : [];
        const notes = s.noticed ? pageNotes(s.noticed) : 0;
        return <article key={item.id} className="find" aria-labelledby={titleId}>
          <div className="find-top"><span className="badge b-attn" aria-hidden="true"><Icon name="flag" small />Needs a decision</span>
            {s.noticed?.overnight && <span className="badge b-muted"><Icon name="clock" small />Overnight</span>}
            <span className="find-where">{w.services}</span>{age && <span className="find-age">{age}</span>}</div>
          <h3 id={titleId} className="find-title">{itemTitle(item, now, words, w, null, services > 1)}<HeadStatus words="Needs a decision" /></h3>
          {/* Keep Sunday covered's write-up of its run leads the card, or says quietly why there is none (audit item 6). */}
          {s.noticed && <WriteUpBlock item={s.noticed} writeup={s.writeup} names={names} now={now} />}
          {named && named.named.length > 0 && <ul className="list today-decisions">{named.named.map((l, i) => <li key={l.key}>
            <span id={`${titleId}-d${i}`}>{l.text}</span>
            <button type="button" className="btn btn-quiet btn-sm" aria-describedby={`${titleId}-d${i}`} onClick={() => toCard(l.key)}>{l.people ? "See who could help" : `Open in ${SERVICES_PAGE}`}</button>
          </li>)}</ul>}
          {named && named.more > 0 && <p className="small">And {named.more} more on {services > 1 ? pageRef() : dayName(words)}.</p>}
          {named && named.looks > 0 && <p className="small today-looks">Also {named.looks === 1 ? "1 thing" : `${named.looks} things`} worth a look on {services > 1 ? pageRef() : dayName(words)}.</p>}
          {s.noticed && <p className="find-body">Ozzie noticed this at {whenText(s.noticed.at, now)} while keeping an eye on {SERVICES}.</p>}
          {changes.length > 0 && <ul className="list">{changes.map(c => <li key={c}><Icon name="dot" small />{c}</li>)}</ul>}
          {notes > 0 && <p className="today-notes"><span className="badge b-ok"><Icon name="check" small />Notes ready</span><span>{notesReadyText(notes)}</span></p>}
          {asked.length > 0 && <div className="stack-tight">{asked.map(l => <AskedNote key={l.key + l.person_id} line={l} onUndone={() => setFocusGroup(GROUP_OF[item.state])} />)}</div>}
          <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={onSunday}>{OPEN_SERVICES}</button></div>
          {later}
        </article>;
      }
      // A church system that doesn't share how many people each role needs: what is known, and what needs a look.
      case "roster": return roster && <article key={item.id} className="find" aria-labelledby={titleId}>
        <div className="find-top"><span className="badge b-look" aria-hidden="true"><Icon name="eye" small />Worth a look</span>
          <span className="find-where">{w.services}</span>{age && <span className="find-age">{age}</span>}</div>
        <h3 id={titleId} className="find-title">{itemTitle(item, now, words, w, roster, services > 1)}<HeadStatus words="Worth a look" /></h3>
        <ul className="list today-decisions">{rosterNeedsYou(roster).map(r => <li key={r.position_id}><span>{needsYouLine(r, names)}</span></li>)}</ul>
        <p className="find-body">{brief?.source ?? w.name} doesn't share how many people each role needs, so Ozzie can't say whether {words.thisOne} is covered.</p>
        <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={onSunday}>{OPEN_SERVICES}</button></div>
        {later}
      </article>;
      // No next plan of the watched service yet (move-on.ts): said plainly, with nothing to press; Ozzie looks again each hour.
      case "sunday-unchecked": return waiting ? <article key={item.id} className="find" aria-labelledby={titleId}>
        <div className="find-top"><span className="badge b-muted"><Icon name="clock" small />Waiting for a plan</span><span className="find-where">{w.services}</span></div>
        <h3 id={titleId} className="find-title">{waiting}</h3>
      </article> : <article key={item.id} className="find" aria-labelledby={titleId}>
        <div className="find-top"><span className="badge b-muted"><Icon name="sun" small />{words.page}</span><span className="find-where">{w.services}</span></div>
        <h3 id={titleId} className="find-title">{words.question}</h3>
        <p className="find-body">{DayName(words)} hasn't been checked yet.</p>
        <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={onSunday}>{OPEN_SERVICES}</button></div>
        {later}
      </article>;
      case "connect": return notConnected && <article key={item.id} className="find today-connect" aria-labelledby={titleId}>
        <div className="find-top"><span className="badge b-muted"><Icon name="link" small />Not connected yet</span><span className="find-where">{w.name}</span></div>
        <h3 id={titleId} className="find-title">{itemTitle(item, now, words, w, null, services > 1)}</h3>
        <p className="find-body">{connectBody(w)}</p>
        <div className="find-next">
          <button type="button" className="btn btn-primary btn-sm" aria-describedby={titleId} onClick={notConnected.onConnect}>{w.connect}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={notConnected.onExample}>See an example church first</button>
        </div>
      </article>;
      case "noticed": return watch && <NoticedCard key={item.id} item={s.item} view={watch.view} names={names} now={now} onOpen={open} titleId={titleId} age={age}
        prepared={item.state === "prepared"} sundayReady={sundayReady}>{later}</NoticedCard>;
      case "watching": {
        const r = s.responsibility;
        return <article key={item.id} className="find today-watch" aria-labelledby={titleId}>
          <div className="find-top"><span className={`badge ${r.status === "paused" || watch?.view.paused_all ? "b-muted" : "b-ok"}`}><Icon name="repeat" small />
            {r.status === "paused" || watch?.view.paused_all ? "Paused" : "Keeping an eye on it"}</span>{age && <span className="find-age">{age}</span>}</div>
          <h3 id={titleId} className="find-title">{jobTitle(r)}</h3>
          {watch && <p className="find-body">{watchLine(r, watch.view, now)}</p>}
          {s.notes.length > 0 && <ul className="list resp-problems">{s.notes.map(n => <li key={n.id}><Icon name="clock" small />
            {n.overnight && <span className="badge b-muted">Overnight</span>}{noticedTitle(n, now, words)}</li>)}</ul>}
          {r.template === "morning-briefing" && <div className="find-next">
            <button type="button" className="btn btn-secondary btn-sm" aria-expanded={previewing === r.id} aria-controls={`${titleId}-preview`} aria-describedby={titleId}
              onClick={() => setPreviewing(previewing === r.id ? null : r.id)}>{previewing === r.id ? "Hide the preview" : "Preview this briefing"}</button></div>}
          {r.template === "morning-briefing" && previewing === r.id && <div id={`${titleId}-preview`}>
            <BriefingPreview {...briefingPreviewTimes(r, now, zone, r.status === "active" && !watch?.view.paused_all ? watch?.view.next[r.id] ?? null : null)}
              brief={brief} decisions={sundayDecisions} operations={operations} names={names} onSunday={onSunday} /></div>}
        </article>;
      }
      case "regular": {
        const missed = regularMissedText(s.check, now, zone);
        return <article key={item.id} className="find today-watch" aria-labelledby={titleId}>
          <div className="find-top"><span className={`badge ${s.check.paused ? "b-muted" : "b-ok"}`}><Icon name="repeat" small />{s.check.paused ? "Paused" : "Always on"}</span>
            <span className="find-where">{w.services}</span></div>
          <h3 id={titleId} className="find-title">{itemTitle(item, now, words, w)}</h3>
          <p className="find-body">{regularLine(s.check, now, zone, w.name)}</p>
          {missed && <ul className="list resp-problems"><li><Icon name="clock" small />{missed}</li></ul>}
        </article>;
      }
      // A job paused by a switch of church: its one question, answered here or on Keeping watch.
      case "job-question": return <SwitchQuestionCard key={item.id} question={s.question} runner={watch?.runner ?? {}}
        onAnswered={() => setFocusGroup(GROUP_OF[item.state])}>{later}</SwitchQuestionCard>;
      case "answers": return <article key={item.id} className="find" aria-labelledby={titleId}>
        <div className="find-top"><span className="badge b-muted"><Icon name="clock" small />Waiting for an answer</span>
          <span className="find-where">{w.services}</span>{age && <span className="find-age">{age}</span>}</div>
        <h3 id={titleId} className="find-title">{itemTitle(item, now, words, w, null, services > 1)}</h3>
        <p className="find-body">{w.name} shows a request was sent for {list(s.positions)} and hasn't been accepted yet.</p>
        <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={onSunday}>{OPEN_SERVICES}</button></div>
      </article>;
    }
  };

  const group = (id: GroupId, extra?: ReactNode) => {
    const shown = grouped[id];
    return <section key={id} className={`today-group today-${id}`} aria-labelledby={`today-group-${id}`}>
      <h2 id={`today-group-${id}`} className="h3 today-group-h" tabIndex={-1} ref={el => { headings.current[id] = el; }}>
        {GROUPS[id].title}<span className="today-count">{countText(shown.length)}</span></h2>
      {shown.length === 0 && <p className="today-empty">{id === "progress" ? progressEmptyText(regular, example, w) : GROUPS[id].empty}</p>}
      {shown.map(card)}
      {extra}
    </section>;
  };

  // Never "nothing needs a decision" for a church system that doesn't share how many people each role needs (round 5):
  // what is known, and that Ozzie can't say whether it is covered. The card above says it when someone needs a look.
  const sundayCalm = brief && sunday && sunday.decisions === 0 && !sunday.unknownNeed?.needsYou && <><p className="today-calm"><Icon name="sun" small />
    <span>{roster ? `On ${dayName(words)}, ${lowerFirst(rosterSummary(roster))} ${brief.source ?? w.name} doesn't share how many people each role needs, so Ozzie can't say whether ${words.thisOne} is covered.`
      : services > 1 ? "Nothing in your services needs a decision." : `Nothing on ${dayName(words)} needs a decision.`}</span><button type="button" className="btn btn-quiet btn-sm" onClick={onSunday}>{OPEN_SERVICES}</button></p>
    {/* With no Sunday card, what the leader said they'd send is said here instead. */}
    {asked.length > 0 && <div className="stack-tight">{asked.map(l => <AskedNote key={l.key + l.person_id} line={l} onUndone={() => setFocusGroup("attention")} />)}</div>}</>;
  const progressMore = watch && <div className="today-more">
    <button type="button" className="btn btn-quiet btn-sm" onClick={watch.onAutomatic}>
      {grouped.progress.some(i => i.subject.type === "watching") ? "Change what Ozzie keeps an eye on" : "See what Ozzie can keep an eye on"}</button></div>;

  return <div className="col today">
    <p className="eyebrow">{day(now, zone)} · {clock(now, zone)}</p>
    <h1 className="h1">What needs you today</h1>
    <p className="lede">{ledeText(grouped, Boolean(sunday?.unknownNeed))}</p>
    {serviceLess}
    {/* A saved check on screen says so, with its real time; while the launch's check is under way, a quiet line says that. */}
    {(checking || stuck || brief?.mode === "recording") && <p className="small today-checking">
      {brief?.mode === "recording" && <span>{savedLine(brief.completed_at)} </span>}
      {checking && <span role="status" aria-live="polite">{CHECKING_LINE}</span>}
      {!checking && stuck && <><span role="status" aria-live="polite">{STUCK_LINE} </span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={stuck}>{CHECK_CONNECTION}</button></>}</p>}
    {finish}
    {moment}
    {startQuestion && !example && <section className="find today-start" aria-labelledby="today-start-t">
      <div className="find-top"><span className="badge b-muted"><Icon name="repeat" small />Staying on</span></div>
      <h2 id="today-start-t" className="find-title">{START_TITLE}</h2>
      <p className="find-body">{START_BODY}</p>
      <div className="find-next">
        <button type="button" className="btn btn-primary btn-sm" onClick={startQuestion.onYes}>Yes, start it with this Mac</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={startQuestion.onNo}>No, I'll open it myself</button>
      </div>
      {startQuestion.failed && <p role="alert" className="small">This Mac didn't let Ozzie change that setting. You can try again under Settings.</p>}
    </section>}
    {notice}
    {example && !report.ok && <p role="alert" className="problem">The fictional import couldn't be read.</p>}
    {group("attention", sundayCalm)}
    {group("review")}
    {group("progress", progressMore)}
    {church}
    {calendar && <CalendarGroup reads={calendar.reads} now={now} zone={zone} reading={calendar.reading} onSettings={calendar.onSettings} />}

    {grouped.setAside.length > 0 && <SetAsideList entries={grouped.setAside} now={now} zone={zone} title={i => itemTitle(i, now, words, w, null, services > 1)} onBack={bringBack} />}

    {/* After the work, so the work comes first; the written script stays folded until asked for. Nothing to brief before
        Planning Center is connected. */}
    {/* The service's times on the church's own clock, as the cards above say them (round 3: they differed when the
        church's zone isn't this Mac's). */}
    {spoken && !serviceLess && !(notConnected && !example && !brief) && <BriefingPanel input={spoken} names={names} attentionTimeZone={tz}
      {...(brief?.time_zone && isTimeZone(brief.time_zone) ? { timeZone: brief.time_zone } : {})} />}

    {example && injected.length > 0 && <section className="find guarded" aria-labelledby="today-ignored">
      <div className="find-top"><span className="badge b-look"><Icon name="lock" small />Ignored on purpose</span></div>
      <h2 id="today-ignored" className="find-title">An email told Ozzie to “{injected[0]!.anchor.quote.replace(/\.$/, "")}”.</h2>
      <p className="find-body">Ozzie never follows instructions found inside email, and it can't send email or look up passwords at all. Nothing was done.</p>
    </section>}

    {example && report.ok && <section className="notchecked" aria-labelledby="today-quiet">
      <h2 id="today-quiet" className="h3">Read, nothing needed from you</h2>
      <ul className="list">{quiet.map(s => <li key={s.id}><Icon name="check" small />{isMessage(s)
        ? <>Email “{s.subject}”: {input.assertions.find(a => a.message_id === s.id)?.anchor.quote ?? "no action found."}</>
        : <>{s.title}, {day(s.start_at, tz)} at {clock(s.start_at, tz)}: no change.</>}</li>)}</ul>
      <p className="small">Fictional import. Nothing was marked read, moved, archived or answered.</p>
    </section>}
  </div>;
}

/** What's set aside, folded away, each with when it comes back and a way to bring it back now. */
function SetAsideList({ entries, now, zone, title, onBack }: {
  entries: { item: TodayItem; until: string }[]; now: string; zone: string; title: (i: TodayItem) => string; onBack: (i: TodayItem) => void;
}) {
  const id = useId();
  return <details className="today-aside">
    <summary><Icon name="chev" small />Set aside for now<span className="today-count">{countText(entries.length)}</span></summary>
    <ul className="list">{entries.map(({ item, until }) => <li key={item.id}>
      <Icon name="clock" small /><span className="today-aside-t" id={`${id}-${item.id.replace(/[^\w-]/gu, "-")}`}>{title(item)}</span>
      <span className="small">{backText(until, now, zone)}</span>
      <button type="button" className="btn btn-quiet btn-sm" aria-describedby={`${id}-${item.id.replace(/[^\w-]/gu, "-")}`} onClick={() => onBack(item)}>Bring it back now</button>
    </li>)}</ul>
  </details>;
}
