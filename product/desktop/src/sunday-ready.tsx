// The full Sunday Ready brief, inside Thursday's morning briefing (owner decision, October 26):
// everything still open for the Sunday on screen, in one place, with what wasn't checked and when it
// was read. Built only from the brief, the person's decisions and the rooms / follow-ups check the
// Sunday page shows; names resolve on this Mac only. Read-only: decisions happen on the Sunday page.
import { blockoutRoles, blockoutTime, rosterSummary, shownUncertainties, sundayShownCount, unnumberedRoster, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { includesSundayReady, scheduledSlots, type Scheduled } from "../../../core/src/harness/responsibilities.js";
import { isTimeZone } from "../../../core/src/church-time.js";
import { Icon } from "./icons.js";
import { backgroundTitle, fewConfirmedTitle } from "./sunday-page.js";
import { keptLines } from "./responsibility-words.js";
import type { NoticedItem } from "./responsibility-runner.js";
import { SUNDAY_WORDS, useDay, type DayWords } from "./day-words.js";
import { dayName, DayName, OPEN_SERVICES, pageRef } from "./day-phrases.js";

type Names = Readonly<Record<string, string>>;
const nameOf = (names: Names, id: string | undefined) => (id && Object.hasOwn(names, id) && names[id]) || "Someone on the team";
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const people = (n: number) => n === 1 ? "one more person" : `${n} more people`;
/** The brief's display title by the service's real day: "Ready for Wednesday", "Ready for this weekend" (spec §5.2). */
export const readyTitle = (d: DayWords) => `Ready for ${dayName(d)}`;

/** One line per open finding, in the Sunday page's words. A kind without its own line reads its first fact. */
export function sundayReadyLine(f: Finding, names: Names, d: DayWords = SUNDAY_WORDS): string {
  const pos = f.position?.name ?? "A role";
  switch (f.kind) {
    case "needs-people": return `${pos} still needs ${people(f.remaining ?? 1)}.`;
    case "pending": return `${nameOf(names, f.person_id)} hasn't accepted ${pos} yet. ${f.notification === "sent" ? "The request was sent."
      : f.notification === undefined && f.source ? `${f.source} doesn't say whether the request was sent.` : `${f.source ?? "Planning Center"} shows the request hasn't been sent.`}`;
    case "streak": return `${nameOf(names, f.person_id)} is scheduled ${f.sundays} weeks in a row. Your Church rules suggest a check-in.`;
    case "lead-missing": return `No one is scheduled to lead ${pos} ${d.thisOne}.`;
    case "lead-unverified": return `The scheduled lead for ${pos} couldn't be confirmed.`;
    // The kids rules read as on the Sunday page: which team, which time, and (on this Mac only) who.
    case "too-few-confirmed": return fewConfirmedTitle(f);
    case "background-check": return backgroundTitle(nameOf(names, f.person_id), f.check);
    case "blockout": return `${nameOf(names, f.person_id)} is scheduled for ${blockoutRoles(f)} and has a blockout in ${f.source ?? "Planning Center"} at ${blockoutTime(f) ? "that time" : "those times"}. ${f.source ?? "Planning Center"} still counts them.`;
    case "worth-a-look": return f.stale ? `This check is out of date. Check ${f.source ?? "Planning Center"} again before relying on it.` : `Part of ${d.thisOne} couldn't be checked, so it isn't a full picture.`;
    default: return f.why[0] ?? "Something else is worth a look.";
  }
}

export function SundayReadyBrief({ brief, decisions = [], operations = null, names, onSunday }: {
  brief: SundayBrief | null; decisions?: readonly SundayDecision[]; operations?: SundayOperations | null; names: Names; onSunday: () => void;
}) {
  const d = useDay();
  if (!brief) return <div className="sunday-ready panel-sunken">
    <p className="bold">{readyTitle(d)}</p>
    <p className="small">{DayName(d)} hasn't been checked yet, so this brief isn't here. Check it on {pageRef()}.</p>
  </div>;
  const view = applyDecisions(brief, decisions);
  const open = view.items.filter(i => i.state !== "resolved");
  const decide = open.filter(i => i.finding.tone === "decision"), looks = open.filter(i => i.finding.tone === "look");
  // The Sunday page's own counts, as Today and the sidebar say them: rooms, follow-ups and group meetings included (live review 2026-11-18).
  const counts = sundayShownCount(view, operations);
  const current = operations?.stale ? null : operations;
  const findings = current?.result?.findings ?? [];
  const rooms = findings.filter(f => f.kind === "room-overlap").length, followUps = findings.filter(f => f.kind === "unowned-overdue").length;
  const meetings = current?.group_meetings.length ?? 0;
  const setAside = (brief.hidden?.length ?? 0) + (operations?.hidden?.length ?? 0);
  const others = [
    ...(rooms ? [`${rooms === 1 ? "One room booking overlap" : `${rooms} room booking overlaps`} to review.`] : []),
    ...(followUps ? [`${followUps === 1 ? "One follow-up has" : `${followUps} follow-ups have`} no owner and ${followUps === 1 ? "is" : "are"} past due.`] : []),
    ...(shownUncertainties(current?.result ?? null).length ? ["Some room or follow-up details couldn't be confirmed."] : []),
    ...(meetings ? [`${meetings === 1 ? "One person has" : `${meetings} people have`} a group meeting while they serve.`] : []),
  ];
  const unchecked = [...brief.not_checked, ...(operations?.not_checked ?? [])];
  const list = (lines: string[]) => <ul className="list">{lines.map(l => <li key={l}><Icon name="dot" small />{l}</li>)}</ul>;
  return <section className="sunday-ready" aria-label={readyTitle(d)}>
    {/* Several services at once (services-merge.ts MANY_SERVICES): no one plan's date is said for all of them. */}
    <p className="bold">{readyTitle(d)}{brief.plan.dates && !(brief.day?.kind === "spread" && brief.day.date === null) ? ` · ${brief.plan.dates}` : ""}</p>
    {brief.mode === "fictional" && <p className="small">Fictional example. No church data is shown.</p>}
    {/* Never "nothing needs a decision" where the system shares no number needed (Breeze, round 5). */}
    {unnumberedRoster(brief) && !counts.decisions ? <p className="small">{rosterSummary(unnumberedRoster(brief)!)} {brief.source ?? "The church system"} doesn't share how many people each role needs, so Ozzie can't say whether {d.thisOne} is covered.
      {counts.looks ? ` ${counts.looks} ${counts.looks === 1 ? "is" : "are"} worth a look.` : ""}
      {counts.resolved ? ` You resolved ${counts.resolved} yourself.` : ""}{setAside ? ` ${setAside} hidden by you.` : ""}</p>
    : <p className="small">{counts.decisions ? `${counts.decisions === 1 ? "One thing needs" : `${counts.decisions} things need`} a decision` : "Nothing needs a decision"}
      {counts.looks ? `, and ${counts.looks} ${counts.looks === 1 ? "is" : "are"} worth a look` : ""}.
      {counts.resolved ? ` You resolved ${counts.resolved} yourself.` : ""}{setAside ? ` ${setAside} hidden by you.` : ""}</p>}
    {decide.length > 0 && <><p className="small bold">Needs a decision</p>{list(decide.map(i => sundayReadyLine(i.finding, names, d)))}</>}
    {looks.length > 0 && <><p className="small bold">Worth a look</p>{list(looks.map(i => sundayReadyLine(i.finding, names, d)))}</>}
    {others.length > 0 && <><p className="small bold">Rooms, follow-ups and group meetings</p>{list(others)}</>}
    {unchecked.length > 0 && <><p className="small bold">What I didn't check</p>{list(unchecked)}</>}
    <p className="small">{brief.mode === "recording" ? "From the saved copy of a check made" : `Read from ${brief.source ?? "Planning Center"}`} {time(brief.checked_at ?? brief.completed_at)}.</p>
    <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onSunday}>{OPEN_SERVICES} to decide</button></div>
  </section>;
}

/**
 * "Kept for your briefing", inside a morning briefing: what the person's Church rules keep for it ("Put this in
 * the briefing") instead of a notice, each kind with how many its check showed. Kinds and counts only; nothing
 * when nothing is kept.
 */
export function KeptForBriefing({ item }: { item: Pick<NoticedItem, "kind" | "kept"> }) {
  const lines = keptLines(item);
  if (!lines.length) return null;
  return <section aria-label="Kept for your briefing">
    <p className="small bold">Kept for your briefing</p>
    <ul className="list">{lines.map(l => <li key={l}><Icon name="dot" small />{l}</li>)}</ul>
    <p className="small">Your Church rules keep these for the briefing instead of a notice. Each one is on {pageRef()}.</p>
  </section>;
}

const DAY_MS = 86_400_000;
const zoned = (iso: string, zone: string, withDay = true) => new Date(iso).toLocaleString(undefined, {
  ...(withDay ? { weekday: "short", month: "short", day: "numeric" } : {}), hour: "numeric", minute: "2-digit", timeZone: zone,
});

/**
 * When the morning briefing runs next, and when its next Thursday run is (which carries the Sunday Ready brief),
 * both within the coming eight days. `next` prefers the runner's own next time (it knows about pauses and catch-up).
 */
export function briefingPreviewTimes(r: Scheduled & { zone?: string | null }, now: string, fallbackZone: string, runnerNext?: string | null):
  { next: string | null; thursday: string | null; zone: string } {
  const zone = r.zone && isTimeZone(r.zone) ? r.zone : fallbackZone;
  const slots = scheduledSlots(r, now, new Date(Date.parse(now) + 8 * DAY_MS).toISOString(), zone);
  const next = runnerNext ?? slots[0] ?? null;
  return { next, thursday: slots.find(at => includesSundayReady(at, zone)) ?? null, zone };
}

/**
 * "Preview this briefing": what the morning briefing will include on its next run, from Ozzie's last check. Nothing is
 * read or sent to make it. When the next run isn't Thursday's, it also shows the Sunday Ready brief Thursday's will carry.
 */
export function BriefingPreview({ next, thursday, zone, brief, decisions = [], operations = null, names, onSunday }: {
  next: string | null; thursday: string | null; zone: string; brief: SundayBrief | null; decisions?: readonly SundayDecision[];
  operations?: SundayOperations | null; names: Names; onSunday: () => void;
}) {
  const d = useDay();
  const fullBrief = `the full “${readyTitle(d)}” brief`;
  const nextIsThursday = next !== null && thursday !== null && next === thursday;
  const ready = <SundayReadyBrief brief={brief} decisions={decisions} operations={operations} names={names} onSunday={onSunday} />;
  return <section className="briefing-preview" aria-label="Briefing preview">
    <p className="bold">{next ? `Next briefing: ${zoned(next, zone)}` : "No briefing is scheduled right now"}</p>
    <p className="small">It brings together what still needs you before {dayName(d)}, and anything that came up overnight.
      {nextIsThursday ? ` It's Thursday's, so it includes ${fullBrief}:` : thursday ? ` Thursday's briefing, ${zoned(thursday, zone)}, also includes ${fullBrief}. From Ozzie's last check, it would say:` : ` Thursday's briefing also includes ${fullBrief}. From Ozzie's last check, it would say:`}</p>
    {ready}
    <p className="small">A preview from Ozzie's last check. Nothing was read or sent to make it. The briefing checks Planning Center again when it runs, so it can differ.</p>
  </section>;
}
