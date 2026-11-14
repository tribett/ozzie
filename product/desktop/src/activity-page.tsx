import type { SundayCapture } from "../../../core/src/sunday-capture.js";

const what: Record<string, string> = {
  plan: "Read this Sunday's plan", plan_times: "Read the service times", needed_positions: "Read the open positions",
  team_members: "Read who is scheduled", team_position_assignments: "Read who is on a team",
  team_leaders: "Read a team's leaders", person_schedules: "Read one person's other schedules", person_blockouts: "Read one person's blockouts",
  calendar_rooms: "Read the list of rooms", calendar_resource_bookings: "Read room bookings for this Sunday",
  people_workflows: "Read the follow-up workflows", people_workflow_steps: "Read one workflow's steps",
  people_workflow_ready_cards: "Read one workflow's ready follow-ups", people_workflow_snoozed_cards: "Read one workflow's snoozed follow-ups",
  groups_person_memberships: "Read one person's groups", groups_group_events: "Read one group's events this Sunday",
  calendar_conflicts: "Read one event's room conflicts",
  organization: "Read the church's time zone",
};
/**
 * `notGranted`: Ozzie asked Planning Center for Calendar, People and Groups, and it granted Services
 * only, so those reads weren't asked for that reason, not because they're turned off.
 */
export const activityOutcome = (o: string, notGranted = false) => o === "ok" ? "Complete" : o === "truncated" ? "Partial — more existed than Ozzie reads at once"
  : o === "not-requested" ? notGranted ? "Not asked — Planning Center didn't grant this" : "Not asked — turned off in Settings"
    : o === "denied" ? "Planning Center didn't allow it" : "Didn't complete";
export const activityLabel = (collection: string) => Object.hasOwn(what, collection) ? what[collection]! : collection;

/** "What happened": every Planning Center read in this check, in order. All reads; no writes exist. */
export function ActivityPage({ capture, notGranted = false }: { capture: SundayCapture | null; notGranted?: boolean }) {
  return <div className="col">
    <p className="eyebrow">What happened</p>
    <h1 className="h1">Every read in this check</h1>
    <p className="lede">Ozzie only reads from Planning Center. It has no way to change records, send messages or mark anything.</p>
    {!capture && <p className="panel-sunken">No check has run yet. Every read appears here once Sunday is checked, or when you open the fictional example on the Sunday page.</p>}
    {capture && <>
      <p className="checkline">{capture.kind === "recording" ? "Saved recording" : "Planning Center"} · started {new Date(capture.started_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {capture.reads.length} reads</p>
      <ol className="log">{capture.reads.map((r, i) => <li key={i} className={r.outcome === "ok" || r.outcome === "not-requested" ? "" : "is-problem"}>
        <span className="log-t">{new Date(r.checked_at).toLocaleTimeString()}</span>
        <span>{activityLabel(r.collection)}{r.offset ? ` (page from ${r.offset})` : ""}</span>
        <span className="small">{activityOutcome(r.outcome, notGranted)}</span>
      </li>)}</ol>
    </>}
  </div>;
}
