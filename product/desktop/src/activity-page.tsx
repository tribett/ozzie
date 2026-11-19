import { useId, useState } from "react";
import type { Skill } from "../../../core/src/harness/contract.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { taskAccount, taskLine, type Account, type TaskEnd, type TaskRow, type TaskStart } from "./harness-words.js";
import { Icon } from "./icons.js";
import { useDay } from "./day-words.js";
import { dayName, pageRef } from "./day-phrases.js";
import { promise } from "./promises.js";
import { OLLAMA, ollamaDoneSaid } from "./ai-words.js";
import type { OllamaHistory } from "./onboarding-bridge.js";

// What each read was, said without the day: an older check may have been of another week's service.
const what: Record<string, string> = {
  plan: "Read the service's plan", plan_times: "Read the service times", needed_positions: "Read the open roles",
  team_members: "Read who is scheduled", team_position_assignments: "Read who is on a team",
  team_leaders: "Read a team's leaders", person_schedules: "Read one person's other schedules", person_blockouts: "Read one person's blockouts",
  calendar_rooms: "Read the list of rooms", calendar_resource_bookings: "Read room bookings for the service's day",
  people_workflows: "Read the follow-up workflows", people_workflow_steps: "Read one workflow's steps",
  people_workflow_ready_cards: "Read one workflow's ready follow-ups", people_workflow_snoozed_cards: "Read one workflow's snoozed follow-ups",
  groups_person_memberships: "Read one person's groups", groups_group_events: "Read one group's events on the service's day",
  calendar_conflicts: "Read one event's room conflicts",
  organization: "Read the church's time zone",
  people_background_checks: "Read whether one person has a current background check",
  people_forms: "Read the list of People forms", people_form_submissions: "Read one form's new submissions (when and who, never the answers)",
  checkins_events: "Read the Check-Ins events", checkins_locations: "Read one Check-Ins event's rooms",
  checkins_event_periods: "Read one Check-Ins event's recent times", checkins_location_counts: "Read how many checked in to each room at one time",
  registrations_signups: "Read the upcoming signups", registrations_attendees: "Count one signup's registrations",
};
/**
 * `notGranted`: Ozzie asked Planning Center for Calendar, People and Groups, and it granted Services
 * only, so those reads weren't asked for that reason, not because they're turned off.
 */
export const activityOutcome = (o: string, notGranted = false) => o === "ok" ? "Complete" : o === "truncated" ? "Partial — more existed than Ozzie reads at once"
  : o === "not-requested" ? notGranted ? "Not asked — Planning Center didn't grant this" : "Not asked — turned off in Settings"
    : o === "denied" ? "Planning Center didn't allow it" : "Didn't complete";
export const activityLabel = (collection: string) => Object.hasOwn(what, collection) ? what[collection]! : collection;

export const LEDGER_UNAVAILABLE = "Ozzie's list of recent work isn't available right now. Every Planning Center read in the latest check is still listed below.";

/** How many tasks Recent work shows before "Show earlier work". */
export const RECENT_SHOWN = 10;
/** A day heading on this Mac's clock: "Today", "Yesterday", or the date ("Thursday, November 19"). */
export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso), yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}
/** Tasks newest first, in runs of the same day, each with its heading. */
export function byDay(tasks: readonly TaskRow[], now: Date): { day: string; tasks: TaskRow[] }[] {
  const out: { day: string; tasks: TaskRow[] }[] = [];
  for (const row of [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    const day = dayLabel(row.created_at, now);
    if (out.at(-1)?.day === day) out.at(-1)!.tasks.push(row); else out.push({ day, tasks: [row] });
  }
  return out;
}

/**
 * A task as a short account (audit item 7): what started it, what Ozzie looked at, whether it asked the AI and what the AI
 * did, and how it ended. Shared by What happened, a job's write-up and an Ask answer's "See how this works".
 */
export function TaskAccount({ account }: { account: Account }) {
  return <div className="task-account stack-tight">
    <p>{account.started}</p>
    {account.looked.length > 0 && <>
      <p className="bold">What Ozzie looked at</p>
      <ul className="list recent-steps">{account.looked.map((s, i) => <li key={i}><Icon name="dot" small />{s}</li>)}</ul>
    </>}
    <p>{account.ai}</p>
    <p>{account.ended}</p>
  </div>;
}

/**
 * Recent work, newest first and grouped by day: one plain line per task, opening to a short account of it. The newest
 * RECENT_SHOWN show; "Show earlier work" lists the rest. Name-free: the list holds no question, answer or source text.
 */
export function RecentWork({ tasks, procedures = null, trigger = () => undefined, end = () => undefined, now }: {
  /** undefined while loading; null when the list isn't available. */
  tasks: TaskRow[] | null | undefined;
  procedures?: ReadonlyMap<string, Skill> | null;
  /** How a task started (a Sunday check's trigger, a job's run …), when this Mac knows. */
  trigger?: (taskId: string) => TaskStart | undefined;
  /** Which closed form a verified answer took, when this Mac knows. */
  end?: (taskId: string) => TaskEnd | undefined;
  now?: Date;
}) {
  const [all, setAll] = useState(false);
  const id = useId();
  const day = useDay();
  if (tasks === undefined) return null;
  if (tasks === null) return <p className="small recent-quiet"><Icon name="info" small />{LEDGER_UNAVAILABLE}</p>;
  if (!tasks.length) return <p className="panel-sunken">Nothing yet. Questions you ask Ozzie and each check of Planning Center appear here.</p>;
  const sorted = [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const earlier = sorted.length - RECENT_SHOWN;
  const item = (row: TaskRow) => {
    const start = trigger(row.task_id);
    const line = taskLine(row, { procedures, day, ...(start ? { trigger: start } : {}), ...(now ? { now } : {}) });
    const account = taskAccount(row, { start, end: end(row.task_id), procedures, day, ...(now ? { now } : {}) });
    return <li key={row.task_id} className={row.state === "failed" ? "is-problem" : ""}>
      <details className="recent-task">
        <summary><Icon name="chev" small /><span>{line}</span></summary>
        <TaskAccount account={account} />
      </details>
    </li>;
  };
  return <>
    <div className="recent-days" id={`${id}-list`}>
      {byDay(all ? sorted : sorted.slice(0, RECENT_SHOWN), now ?? new Date()).map((d, i) => <section key={d.day} className="recent-day" aria-labelledby={`${id}-day-${i}`}>
        <h3 id={`${id}-day-${i}`} className="recent-day-h">{d.day}</h3>
        <ol className="log recent">{d.tasks.map(item)}</ol>
      </section>)}
    </div>
    {earlier > 0 && <div><button type="button" className="btn btn-quiet btn-sm btn-flush" aria-expanded={all} aria-controls={`${id}-list`} onClick={() => setAll(!all)}>
      {all ? `Show only the newest ${RECENT_SHOWN}` : `Show earlier work (${earlier} more)`}</button></div>}
  </>;
}

/** "What happened": what Ozzie did recently, then every Planning Center read in the latest check. All reads; no writes exist. */
export function ActivityPage({ capture, notGranted = false, tasks, procedures = null, trigger, end, now, ollama = null }: {
  capture: SundayCapture | null; notGranted?: boolean;
  tasks?: TaskRow[] | null | undefined; procedures?: ReadonlyMap<string, Skill> | null;
  trigger?: (taskId: string) => TaskStart | undefined; end?: (taskId: string) => TaskEnd | undefined; now?: Date;
  /** Each time Ozzie got Ollama (native `ollama_install_history`), oldest first: a time and a closed word, never a path. */
  ollama?: OllamaHistory["done"] | null;
}) {
  const d = useDay();
  return <div className="col">
    <p className="eyebrow">What happened</p>
    <h1 className="h1">What Ozzie did</h1>
    <p className="lede">{promise("reads")} {promise("sends")}</p>
    <section className="stack" aria-labelledby="recent-title">
      <h2 id="recent-title" className="h3">Recent work</h2>
      <RecentWork tasks={tasks} procedures={procedures} {...(trigger ? { trigger } : {})} {...(end ? { end } : {})} {...(now ? { now } : {})} />
    </section>
    {ollama && ollama.length > 0 && <section className="stack" aria-labelledby="ollama-title">
      <h2 id="ollama-title" className="h3">{OLLAMA.historyTitle}</h2>
      <ol className="log">{[...ollama].reverse().map((o, i) => <li key={i}>
        <span className="log-t">{new Date(o.at_ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        <span>{ollamaDoneSaid(o.end)}</span>
      </li>)}</ol>
    </section>}
    <section className="stack" aria-labelledby="reads-title">
      <h2 id="reads-title" className="h3">Every read in the latest check</h2>
      {!capture && <p className="panel-sunken">No check has run yet. Every read appears here once {dayName(d)} is checked, or when you open the fictional example on {pageRef(d)}.</p>}
      {capture && <>
        <p className="checkline">{capture.kind === "recording" ? "Saved copy of a check" : "Planning Center"} · started {new Date(capture.started_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {capture.reads.length} reads</p>
        <ol className="log">{capture.reads.map((r, i) => <li key={i} className={r.outcome === "ok" || r.outcome === "not-requested" ? "" : "is-problem"}>
          <span className="log-t">{new Date(r.checked_at).toLocaleTimeString()}</span>
          <span>{activityLabel(r.collection)}{r.offset ? " (continued)" : ""}</span>
          <span className="small">{activityOutcome(r.outcome, notGranted)}</span>
        </li>)}</ol>
      </>}
    </section>
  </div>;
}
