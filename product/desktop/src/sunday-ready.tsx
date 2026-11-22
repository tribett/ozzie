// The full Sunday Ready brief, inside Thursday's morning briefing (owner decision, October 26):
// everything still open for the Sunday on screen, in one place, with what wasn't checked and when it
// was read. Built only from the brief, the person's decisions and the rooms / follow-ups check the
// Sunday page shows; names resolve on this Mac only. Read-only: decisions happen on the Sunday page.
import { blockoutRoles, blockoutTime, findingService, roleReasons, rolesUnchecked, rosterSummary, shownUncertainties, sundayShownCount, serviceOfTeam, unnumberedRoster, withServices,
  type Finding, type FindingServices, type SundayBrief, type TeamServices } from "../../../core/src/sunday-brief.js";
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
import { useAlsoOperations, useFindingServices, useTeamServices } from "./team-labels.js";
import { withOthers } from "./services-merge.js";

type Names = Readonly<Record<string, string>>;
const nameOf = (names: Names, id: string | undefined) => (id && Object.hasOwn(names, id) && names[id]) || "Someone on the team";
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const people = (n: number) => n === 1 ? "one more person" : `${n} more people`;
/** The brief's display title by the service's real day: "Ready for Wednesday", "Ready for this weekend" (spec §5.2). */
export const readyTitle = (d: DayWords) => `Ready for ${dayName(d)}`;

/**
 * One line per open finding, in the Sunday page's words. A kind without its own line reads its first fact. `services`:
 * with more than one service watched, each team's service, so every role is said with it ("Greeter (Youth Night)").
 * `zone`: the church's time zone, so a role's time is on the church's clock, as the Sunday page says it. `findings`: with
 * more than one service watched, each finding's service by a name a person would recognise, for a part of the check that
 * has no role to say it with ("At Youth Night, one role couldn't be checked, …").
 */
export function sundayReadyLine(found: Finding, names: Names, d: DayWords = SUNDAY_WORDS, services?: TeamServices, zone: string | null = null, findings?: FindingServices): string {
  const f = withServices(found, services);
  const pos = f.position?.name ?? "A role";
  switch (f.kind) {
    case "needs-people": return `${pos} still needs ${people(f.remaining ?? 1)}.`;
    case "pending": return `${nameOf(names, f.person_id)} hasn't accepted ${pos} yet. ${f.notification === "sent" ? "The request was sent."
      : f.notification === undefined && f.source ? `${f.source} doesn't say whether the request was sent.` : `${f.source ?? "Planning Center"} shows the request hasn't been sent.`}`;
    case "streak": return `${nameOf(names, f.person_id)} is scheduled ${f.sundays} weeks in a row. Your Church rules suggest a check-in.`;
    // Said with its own service, the role needs no day words (every service's, "your services").
    case "lead-missing": return `No one is scheduled to lead ${pos}${serviceOfTeam(f.position?.team_id, services) ? "" : ` ${d.thisOne}`}.`;
    case "lead-unverified": return `The scheduled lead for ${pos} couldn't be confirmed.`;
    // The kids rules read as on the Sunday page: which team, which time, and (on this Mac only) who.
    // In the service's own day words (it said "this Sunday" for every service), or none once said with its own service.
    case "too-few-confirmed": return fewConfirmedTitle(f, d, Boolean(serviceOfTeam(f.position?.team_id, services)), zone);
    case "background-check": return backgroundTitle(nameOf(names, f.person_id), f.check);
    case "blockout": return `${nameOf(names, f.person_id)} is scheduled for ${blockoutRoles(f)} and has a blockout in ${f.source ?? "Planning Center"} at ${blockoutTime(f) ? "that time" : "those times"}. ${f.source ?? "Planning Center"} still counts them.`;
    case "worth-a-look": return f.stale ? `This check is out of date. Check ${f.source ?? "Planning Center"} again before relying on it.`
      // Only facts about roles: how many, then each plain reason, as the Services page says them; with more than one
      // service watched, its service first, as Ask says it (the page shows it under that service's heading).
      : f.role_facts ? `${rolesUnchecked(f.role_facts.roles, findingService(f.id, findings))}, so it isn't a full picture.${roleReasons(f)}`
        : `Part of ${d.thisOne} couldn't be checked, so it isn't a full picture.`;
    default: return f.why[0] ?? "Something else is worth a look.";
  }
}

export function SundayReadyBrief({ brief, decisions = [], operations = null, names, onSunday }: {
  brief: SundayBrief | null; decisions?: readonly SundayDecision[]; operations?: SundayOperations | null; names: Names; onSunday: () => void;
}) {
  const d = useDay();
  const services = useTeamServices();
  const findingNames = useFindingServices();
  // With more than one service watched, each other service's own rooms and group meetings, as its part of the Services
  // page shows them, said with its service; undefined with one service, which reads as before.
  const also = useAlsoOperations();
  if (!brief) return <div className="sunday-ready panel-sunken">
    <p className="bold">{readyTitle(d)}</p>
    <p className="small">{DayName(d)} hasn't been checked yet, so this brief isn't here. Check it on {pageRef()}.</p>
  </div>;
  const view = applyDecisions(brief, decisions);
  const open = view.items.filter(i => i.state !== "resolved");
  const decide = open.filter(i => i.finding.tone === "decision"), looks = open.filter(i => i.finding.tone === "look");
  // The Sunday page's own counts, as Today and the sidebar say them: rooms, follow-ups and group meetings included (live review 2026-11-18).
  const counts = withOthers(sundayShownCount(view, operations), also?.also ?? []);
  /** One service's rooms, follow-ups and group meetings; with more than one watched, its rooms and group meetings at its service. */
  const lines = (ops: SundayOperations | null, service: string | null, withFollowUps: boolean) => {
    const current = ops?.stale ? null : ops;
    const findings = current?.result?.findings ?? [];
    const rooms = findings.filter(f => f.kind === "room-overlap").length, followUps = findings.filter(f => f.kind === "unowned-overdue").length;
    const meetings = current?.group_meetings.length ?? 0;
    const at = (text: string) => service ? `At ${service}, ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
    return [
      ...(rooms ? [at(`${rooms === 1 ? "One room booking overlap" : `${rooms} room booking overlaps`} to review.`)] : []),
      ...(followUps ? [`${followUps === 1 ? "One follow-up has" : `${followUps} follow-ups have`} no owner and ${followUps === 1 ? "is" : "are"} past due.`] : []),
      ...(shownUncertainties(current?.result ?? null).length ? [at(withFollowUps ? "Some room or follow-up details couldn't be confirmed." : "Some room details couldn't be confirmed.")] : []),
      ...(meetings ? [at(`${meetings === 1 ? "One person has" : `${meetings} people have`} a group meeting while they serve.`)] : []),
    ];
  };
  const setAside = (brief.hidden?.length ?? 0) + (operations?.hidden?.length ?? 0) + (also?.also ?? []).reduce((n, o) => n + (o.operations?.hidden?.length ?? 0), 0);
  const others = [...lines(operations, also?.first ?? null, true), ...(also?.also ?? []).flatMap(o => lines(o.operations, o.service, false))];
  const unchecked = also ? [...new Set([...brief.not_checked, ...(operations?.not_checked ?? []), ...also.also.flatMap(o => o.operations?.not_checked ?? [])])]
    : [...brief.not_checked, ...(operations?.not_checked ?? [])];
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
    {decide.length > 0 && <><p className="small bold">Needs a decision</p>{list(decide.map(i => sundayReadyLine(i.finding, names, d, services, brief.time_zone, findingNames)))}</>}
    {looks.length > 0 && <><p className="small bold">Worth a look</p>{list(looks.map(i => sundayReadyLine(i.finding, names, d, services, brief.time_zone, findingNames)))}</>}
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
const zoned = (iso: string, zone: string, withDay = true) => new Date(iso).toLocaleString("en-US", {
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
