// Today: what needs the person, in the three settled groups (today-groups.ts says which item goes where),
// then the spoken briefing and what Ozzie read that needs nothing. Items can be set aside until tomorrow
// or Monday on this Mac; they come back on their own, with their age.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { evaluateAttentionImport, type AttentionFinding, type Message, type CalendarEvent } from "../../../core/src/attention-import/index.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, openCount, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { Icon } from "./icons.js";
import { BriefingPanel } from "./briefing.js";
import type { RunnerView } from "./responsibility-runner.js";
import { NoticedCard, watchLine } from "./responsibility-views.js";
import { noticedChanges, noticedTitle, preparedTitle, whenText } from "./responsibility-words.js";
import { browserStore, type KeyValueStore } from "./proactive.js";
import {
  ageText, backText, CAN_SET_ASIDE, countText, GROUP_OF, groupToday, ledeText, notesReadyText, pageNotes, setAsideChoices, sundayCountText, todayItems, todayMemory,
  type GroupId, type TodayItem, type TodaySunday,
} from "./today-groups.js";
import { correctionFor, type FeedbackEntry, type FeedbackTarget } from "../../../core/src/finding-feedback.js";
import { FindingFeedback, useFeedback, type FeedbackControls, type FeedbackSource } from "./finding-feedback.js";
import { SundayReadyBrief } from "./sunday-ready.js";

/** What Ozzie keeps an eye on, for Today: it comes to the person here first. */
export interface TodayWatch {
  view: RunnerView; now: string;
  onAutomatic: () => void; onOpen: (page: "sunday" | "automatic" | "connection") => void;
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
  progress: { title: "In progress", empty: "Nothing is under way. Ask Ozzie something like “Keep an eye on Sunday”, and it will keep checking without being asked again." },
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
      <span className="badge b-attn"><Icon name="flag" small />Needs a decision</span>
      {event && <span className="find-where">{event.title} · {clock(event.start_at, tz)} tonight · {event.location}</span>}
      {age && <span className="find-age">{age}</span>}
    </div>
    <h3 id={titleId} className="find-title">{finding.title}</h3>
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
        <li><Icon name="dot" small />I didn't mark anything read, move anything or change the calendar.</li>
      </ul>}
    </div>
    {/* Email and calendar bring no notices, so only "This isn't right" applies here. */}
    <FindingFeedback target={attentionTarget(finding)} feedback={feedback} urgency={false} occasion="for this import" source="what was imported" />
    {children}
  </article>;
}

/** The plain title of an item, for the set-aside list. */
function itemTitle(item: TodayItem, now: string): string {
  const s = item.subject;
  switch (s.type) {
    case "email": return s.finding.title;
    // Any kind of Sunday finding that needs a decision counts here, so the words don't assume positions.
    case "sunday": return `Sunday has ${sundayCountText(s.decisions)}.`;
    case "sunday-unchecked": return "Is Sunday covered?";
    case "noticed": return noticedTitle(s.item, now);
    case "prepared": return preparedTitle(s.ready);
    case "watching": return s.responsibility.title;
    case "answers": return "Waiting for an answer in Planning Center";
  }
}

const NO_NAMES: Record<string, string> = {};
const NO_DECISIONS: readonly SundayDecision[] = [];
const NO_ENTRIES: readonly FeedbackEntry[] = [];

export function TodayPage({ brief, onSunday, names = NO_NAMES, sundayDecisions = NO_DECISIONS, operations = null, watch = null, now: nowProp, zone: zoneProp, store = browserStore,
  feedback = null }: {
  brief: SundayBrief | null; onSunday: () => void; names?: Record<string, string> | undefined; sundayDecisions?: readonly SundayDecision[];
  /** Rooms, follow-ups and group meetings for the same check, so the briefing says what the Sunday page says. */
  operations?: SundayOperations | null;
  /** What Ozzie keeps an eye on and what it noticed; null where it isn't available. */
  watch?: TodayWatch | null;
  /** This Mac's clock; set-aside items come back when it passes their time. */
  now?: string; zone?: string;
  /** Where set-aside and first-seen times are kept on this Mac. */
  store?: KeyValueStore;
  /** What the person tells Ozzie on finding cards, kept with the Church rules. */
  feedback?: FeedbackSource | null;
}) {
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
  const spoken = useMemo(() => {
    if (!report.ok) return null;
    const flagged = new Set(report.findings.flatMap(f => f.source_ids));
    const ignored = input.assertions.filter(a => a.kind === "untrusted-instruction").map(a => a.message_id);
    return { attention: report, sunday: brief, decided, ignoredInstructions: ignored.length,
      quietCount: report.sources.filter(s => !flagged.has(s.id) && !ignored.includes(s.id)).length, operations };
  }, [report, input, brief, decided, operations]);

  const memory = useMemo(() => todayMemory(store), [store]);
  const [setAside, setSetAside] = useState(() => memory.setAside());
  const [firstSeen, setFirstSeen] = useState(() => memory.firstSeen());
  const [announcement, setAnnouncement] = useState("");
  const headings = useRef<Partial<Record<GroupId, HTMLHeadingElement | null>>>({});
  const [focusGroup, setFocusGroup] = useState<GroupId | null>(null);

  const sunday: TodaySunday | null = useMemo(() => brief && decided ? {
    plan_id: brief.plan.id, checked_at: brief.completed_at, decisions: openCount(decided).decisions,
    answers: [...new Set(decided.items.filter(i => i.state !== "resolved" && i.finding.notification === "sent").flatMap(i => i.finding.position ? [i.finding.position.name] : []))],
  } : null, [brief, decided]);
  const items = useMemo(() => todayItems({
    now, sunday, watch: watch?.view ?? null, firstSeen,
    attention: report.ok ? { findings: report.findings, messages: report.sources.filter(isMessage), evaluated_at: report.evaluated_at, zone: tz } : null,
  }), [now, sunday, watch?.view, firstSeen, report]);
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
        const changes = s.noticed ? noticedChanges(s.noticed, names) : [];
        const notes = s.noticed ? pageNotes(s.noticed) : 0;
        return <article key={item.id} className="find" aria-labelledby={titleId}>
          <div className="find-top"><span className="badge b-attn"><Icon name="flag" small />Needs a decision</span>
            {s.noticed?.overnight && <span className="badge b-muted"><Icon name="clock" small />Overnight</span>}
            <span className="find-where">Planning Center Services</span>{age && <span className="find-age">{age}</span>}</div>
          <h3 id={titleId} className="find-title">{itemTitle(item, now)}</h3>
          {s.noticed && <p className="find-body">Ozzie noticed this at {whenText(s.noticed.at, now)} while keeping an eye on Sunday.</p>}
          {changes.length > 0 && <ul className="list">{changes.map(c => <li key={c}><Icon name="dot" small />{c}</li>)}</ul>}
          {notes > 0 && <p className="today-notes"><span className="badge b-ok"><Icon name="check" small />Notes ready</span><span>{notesReadyText(notes)}</span></p>}
          {/* It restates the decisions above, so it stays folded until asked for. */}
          {s.summary && <details className="listen-more today-writeup"><summary><Icon name="chev" small />Read Ozzie's write-up</summary><div className="noticed-summary">
            {s.summary.split(/\n{2,}/u).map((p, i) => <p key={i}>{p}</p>)}</div></details>}
          <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={onSunday}>Open Sunday</button></div>
          {later}
        </article>;
      }
      case "sunday-unchecked": return <article key={item.id} className="find" aria-labelledby={titleId}>
        <div className="find-top"><span className="badge b-muted"><Icon name="sun" small />Sunday</span><span className="find-where">Planning Center Services</span></div>
        <h3 id={titleId} className="find-title">Is Sunday covered?</h3>
        <p className="find-body">Sunday hasn't been checked yet.</p>
        <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={onSunday}>Check Sunday</button></div>
        {later}
      </article>;
      case "noticed": return watch && <NoticedCard key={item.id} item={s.item} view={watch.view} names={names} now={now} onOpen={open} titleId={titleId} age={age}
        prepared={item.state === "prepared"} sundayReady={sundayReady}>{later}</NoticedCard>;
      // What the AI wrote for the report on the Sunday card: only the writing, named for what it is.
      case "prepared": return watch && <NoticedCard key={item.id} item={s.item} view={watch.view} names={names} now={now} onOpen={open} titleId={titleId} age={age}
        written={s.ready}>{later}</NoticedCard>;
      case "watching": {
        const r = s.responsibility;
        return <article key={item.id} className="find today-watch" aria-labelledby={titleId}>
          <div className="find-top"><span className={`badge ${r.status === "paused" || watch?.view.paused_all ? "b-muted" : "b-ok"}`}><Icon name="repeat" small />
            {r.status === "paused" || watch?.view.paused_all ? "Paused" : "Keeping an eye on it"}</span>{age && <span className="find-age">{age}</span>}</div>
          <h3 id={titleId} className="find-title">{r.title}</h3>
          {watch && <p className="find-body">{watchLine(r, watch.view, now)}</p>}
          {s.notes.length > 0 && <ul className="list resp-problems">{s.notes.map(n => <li key={n.id}><Icon name="clock" small />
            {n.overnight && <span className="badge b-muted">Overnight</span>}{noticedTitle(n, now)}</li>)}</ul>}
        </article>;
      }
      case "answers": return <article key={item.id} className="find" aria-labelledby={titleId}>
        <div className="find-top"><span className="badge b-muted"><Icon name="clock" small />Waiting for an answer</span>
          <span className="find-where">Planning Center Services</span>{age && <span className="find-age">{age}</span>}</div>
        <h3 id={titleId} className="find-title">{itemTitle(item, now)}</h3>
        <p className="find-body">Planning Center shows a request was sent for {list(s.positions)} and hasn't been accepted yet.</p>
        <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={onSunday}>Open Sunday</button></div>
      </article>;
    }
  };

  const group = (id: GroupId, extra?: ReactNode) => {
    const shown = grouped[id];
    return <section key={id} className={`today-group today-${id}`} aria-labelledby={`today-group-${id}`}>
      <h2 id={`today-group-${id}`} className="h3 today-group-h" tabIndex={-1} ref={el => { headings.current[id] = el; }}>
        {GROUPS[id].title}<span className="today-count">{countText(shown.length)}</span></h2>
      {shown.length === 0 && <p className="today-empty">{GROUPS[id].empty}</p>}
      {shown.map(card)}
      {extra}
    </section>;
  };

  const sundayCalm = brief && sunday && sunday.decisions === 0 && <p className="today-calm"><Icon name="sun" small />
    <span>Nothing on Sunday needs a decision.</span><button type="button" className="btn btn-quiet btn-sm" onClick={onSunday}>Open Sunday</button></p>;
  const progressMore = watch && <div className="today-more">
    <button type="button" className="btn btn-quiet btn-sm" onClick={watch.onAutomatic}>
      {grouped.progress.some(i => i.subject.type === "watching") ? "Change what Ozzie keeps an eye on" : "See what Ozzie can keep an eye on"}</button></div>;

  return <div className="col today">
    <p className="eyebrow">{day(now, zone)} · {clock(now, zone)}</p>
    <h1 className="h1">What needs you today</h1>
    <p className="lede">{ledeText(grouped)}</p>
    <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    {notice}
    {!report.ok && <p role="alert" className="problem">The fictional import couldn't be read.</p>}
    {group("attention", sundayCalm)}
    {group("review")}
    {group("progress", progressMore)}

    {grouped.setAside.length > 0 && <SetAsideList entries={grouped.setAside} now={now} zone={zone} title={i => itemTitle(i, now)} onBack={bringBack} />}

    {/* After the work, so the work comes first; the written script stays folded until asked for. */}
    {spoken && <BriefingPanel input={spoken} names={names} attentionTimeZone={tz} />}

    {injected.length > 0 && <section className="find guarded" aria-labelledby="today-ignored">
      <div className="find-top"><span className="badge b-look"><Icon name="lock" small />Ignored on purpose</span></div>
      <h2 id="today-ignored" className="find-title">An email told me to “{injected[0]!.anchor.quote.replace(/\.$/, "")}”.</h2>
      <p className="find-body">I never follow instructions found inside email, and I can't send email or look up passwords at all. Nothing was done.</p>
    </section>}

    {report.ok && <section className="notchecked" aria-labelledby="today-quiet">
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
