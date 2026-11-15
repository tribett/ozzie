// The full Sunday Ready brief, inside Thursday's morning briefing (owner decision, October 26):
// everything still open for the Sunday on screen, in one place, with what wasn't checked and when it
// was read. Built only from the brief, the person's decisions and the rooms / follow-ups check the
// Sunday page shows; names resolve on this Mac only. Read-only: decisions happen on the Sunday page.
import type { Finding, SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { Icon } from "./icons.js";

type Names = Readonly<Record<string, string>>;
const nameOf = (names: Names, id: string | undefined) => (id && Object.hasOwn(names, id) && names[id]) || "Someone on the team";
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const people = (n: number) => n === 1 ? "one more person" : `${n} more people`;

/** One line per open finding, in the Sunday page's words. A kind without its own line reads its first fact. */
export function sundayReadyLine(f: Finding, names: Names): string {
  const pos = f.position?.name ?? "A role";
  switch (f.kind) {
    case "needs-people": return `${pos} still needs ${people(f.remaining ?? 1)}.`;
    case "pending": return `${nameOf(names, f.person_id)} hasn't accepted ${pos} yet. ${f.notification === "sent" ? "The request was sent." : "Planning Center shows the request hasn't been sent."}`;
    case "streak": return `${nameOf(names, f.person_id)} is scheduled ${f.sundays} Sundays in a row. Your Church rules suggest a check-in.`;
    case "lead-missing": return `No one is scheduled to lead ${pos} this Sunday.`;
    case "lead-unverified": return `The scheduled lead for ${pos} couldn't be confirmed.`;
    case "worth-a-look": return f.stale ? "This check is out of date. Check Planning Center again before relying on it." : "Part of this Sunday couldn't be checked, so it isn't a full picture.";
    default: return f.why[0] ?? "Something else is worth a look.";
  }
}

export function SundayReadyBrief({ brief, decisions = [], operations = null, names, onSunday }: {
  brief: SundayBrief | null; decisions?: readonly SundayDecision[]; operations?: SundayOperations | null; names: Names; onSunday: () => void;
}) {
  if (!brief) return <div className="sunday-ready panel-sunken">
    <p className="bold">Sunday Ready</p>
    <p className="small">Sunday hasn't been checked yet, so the Sunday Ready brief isn't here. Check it on the Sunday page.</p>
  </div>;
  const view = applyDecisions(brief, decisions);
  const open = view.items.filter(i => i.state !== "resolved");
  const decide = open.filter(i => i.finding.tone === "decision"), looks = open.filter(i => i.finding.tone === "look");
  const resolved = view.items.length - open.length + view.history.length;
  const findings = operations?.stale ? [] : operations?.result?.findings ?? [];
  const rooms = findings.filter(f => f.kind === "room-overlap").length, followUps = findings.filter(f => f.kind === "unowned-overdue").length;
  const meetings = operations?.stale ? 0 : operations?.group_meetings.length ?? 0;
  const setAside = (brief.hidden?.length ?? 0) + (operations?.hidden?.length ?? 0);
  const others = [
    ...(rooms ? [`${rooms === 1 ? "One room booking overlap" : `${rooms} room booking overlaps`} to review.`] : []),
    ...(followUps ? [`${followUps === 1 ? "One follow-up has" : `${followUps} follow-ups have`} no owner and ${followUps === 1 ? "is" : "are"} past due.`] : []),
    ...(meetings ? [`${meetings === 1 ? "One person has" : `${meetings} people have`} a group meeting while they serve.`] : []),
  ];
  const unchecked = [...brief.not_checked, ...(operations?.not_checked ?? [])];
  const list = (lines: string[]) => <ul className="list">{lines.map(l => <li key={l}><Icon name="dot" small />{l}</li>)}</ul>;
  return <section className="sunday-ready" aria-label="Sunday Ready">
    <p className="bold">Sunday Ready{brief.plan.dates ? ` · ${brief.plan.dates}` : ""}</p>
    {brief.mode === "fictional" && <p className="small">Fictional example. No church data is shown.</p>}
    <p className="small">{decide.length ? `${decide.length === 1 ? "One thing needs" : `${decide.length} things need`} a decision` : "Nothing needs a decision"}
      {looks.length ? `, and ${looks.length} ${looks.length === 1 ? "is" : "are"} worth a look` : ""}.
      {resolved ? ` You resolved ${resolved} yourself.` : ""}{setAside ? ` ${setAside} set aside by your Church rules.` : ""}</p>
    {decide.length > 0 && <><p className="small bold">Needs a decision</p>{list(decide.map(i => sundayReadyLine(i.finding, names)))}</>}
    {looks.length > 0 && <><p className="small bold">Worth a look</p>{list(looks.map(i => sundayReadyLine(i.finding, names)))}</>}
    {others.length > 0 && <><p className="small bold">Rooms, follow-ups and group meetings</p>{list(others)}</>}
    {unchecked.length > 0 && <><p className="small bold">What I didn't check</p>{list(unchecked)}</>}
    <p className="small">{brief.mode === "recording" ? "From a saved recording made" : "Read from Planning Center"} {time(brief.checked_at ?? brief.completed_at)}.</p>
    <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onSunday}>Open Sunday to decide</button></div>
  </section>;
}
