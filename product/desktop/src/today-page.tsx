import { useMemo, useState } from "react";
import { evaluateAttentionImport, type AttentionFinding, type Message, type CalendarEvent } from "../../../core/src/attention-import/index.js";
import { harborAttentionImport } from "../../../core/src/fictional-attention.js";
import type { SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { Icon } from "./icons.js";
import { BriefingPanel } from "./briefing.js";

const tz = "America/New_York";
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", timeZone: tz });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz });
const stamp = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
const isMessage = (s: Message | CalendarEvent): s is Message => "subject" in s;

function Item({ finding, sources }: { finding: AttentionFinding; sources: (Message | CalendarEvent)[] }) {
  const [open, setOpen] = useState(false);
  const event = sources.find(s => !isMessage(s) && finding.source_ids.includes(s.id)) as CalendarEvent | undefined;
  return <article className="find">
    <div className="find-top">
      <span className="badge b-attn"><Icon name="flag" small />Needs a decision</span>
      {event && <span className="find-where">{event.title} · {clock(event.start_at)} tonight · {event.location}</span>}
    </div>
    <h2 className="find-title">{finding.title}</h2>
    <p className="find-body">{finding.statement} {finding.why_now}</p>
    <p className="find-quote">{finding.communication}</p>
    <div className="find-next"><span className="find-next-l">Next step</span><span>{finding.next_step}</span></div>
    <div className="find-src">
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> Why I flagged this</button>
      <span>Imported {stamp(finding.imported_at)}</span>
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
  </article>;
}

const NO_NAMES: Record<string, string> = {};
const NO_DECISIONS: readonly SundayDecision[] = [];

export function TodayPage({ brief, onSunday, names = NO_NAMES, sundayDecisions = NO_DECISIONS, operations = null }: {
  brief: SundayBrief | null; onSunday: () => void; names?: Record<string, string> | undefined; sundayDecisions?: readonly SundayDecision[];
  /** Rooms, follow-ups and group meetings for the same check, so the briefing says what the Sunday page says. */
  operations?: SundayOperations | null;
}) {
  const report = useMemo(() => evaluateAttentionImport(harborAttentionImport()), []);
  const spoken = useMemo(() => {
    if (!report.ok) return null;
    const input = harborAttentionImport();
    const flagged = new Set(report.findings.flatMap(f => f.source_ids));
    const ignored = input.assertions.filter(a => a.kind === "untrusted-instruction").map(a => a.message_id);
    return { attention: report, sunday: brief, decided: brief ? applyDecisions(brief, sundayDecisions) : null, ignoredInstructions: ignored.length,
      quietCount: report.sources.filter(s => !flagged.has(s.id) && !ignored.includes(s.id)).length, operations };
  }, [report, brief, sundayDecisions, operations]);
  if (!report.ok) return <div className="col"><p role="alert" className="problem">The fictional import couldn't be read.</p></div>;
  const flagged = new Set(report.findings.flatMap(f => f.source_ids));
  const input = harborAttentionImport();
  const injected = input.assertions.filter(a => a.kind === "untrusted-instruction");
  const quiet = report.sources.filter(s => !flagged.has(s.id) && !injected.some(a => a.message_id === s.id));
  const decisions = brief?.findings.filter(f => f.tone === "decision").length ?? 0;
  return <div className="col">
    <p className="eyebrow">{day(report.evaluated_at)} · {clock(report.evaluated_at)}</p>
    <h1 className="h1">What needs you today</h1>
    <p className="banner dashed"><Icon name="info" small />Fictional import: invented email and calendar records for “{input.workspace_id === "harbor" ? "Harbor Example Church" : input.workspace_id}”. Not a connected mailbox.</p>
    <p className="lede">One thing needs a decision before tonight. Everything else I read can wait or is already handled.</p>
    {report.findings.map(f => <Item key={f.id} finding={f} sources={report.sources} />)}

    <section className="find">
      <div className="find-top">{decisions
        ? <span className="badge b-attn"><Icon name="flag" small />Needs a decision</span>
        : <span className="badge b-muted"><Icon name="sun" small />Sunday</span>}<span className="find-where">Planning Center Services</span></div>
      <h2 className="find-title">{brief ? decisions ? `Sunday has ${decisions} open ${decisions === 1 ? "position" : "positions"} to decide.` : "Nothing on Sunday needs a decision." : "Is Sunday covered?"}</h2>
      {!brief && <p className="find-body">Sunday hasn't been checked yet.</p>}
      <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onSunday}>{brief ? "Open Sunday" : "Check Sunday"}</button></div>
    </section>

    {/* After the decisions, so the work comes first; the written script stays folded until asked for. */}
    {spoken && <BriefingPanel input={spoken} names={names} attentionTimeZone={tz} />}

    {injected.length > 0 && <section className="find guarded">
      <div className="find-top"><span className="badge b-look"><Icon name="lock" small />Ignored on purpose</span></div>
      <h2 className="find-title">An email told me to “{injected[0]!.anchor.quote.replace(/\.$/, "")}”.</h2>
      <p className="find-body">I never follow instructions found inside email, and I can't send email or look up passwords at all. Nothing was done.</p>
    </section>}

    <section className="notchecked" aria-label="Read and nothing needed">
      <h2 className="h3">Read, nothing needed from you</h2>
      <ul className="list">{quiet.map(s => <li key={s.id}><Icon name="check" small />{isMessage(s)
        ? <>Email “{s.subject}”: {input.assertions.find(a => a.message_id === s.id)?.anchor.quote ?? "no action found."}</>
        : <>{s.title}, {day(s.start_at)} at {clock(s.start_at)}: no change.</>}</li>)}</ul>
      <p className="small">Nothing was marked read, moved, archived or answered.</p>
    </section>
  </div>;
}
