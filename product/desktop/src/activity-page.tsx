import { useId, useState, type ReactNode } from "react";
import type { Skill } from "../../../core/src/harness/contract.js";
import type { SundayCapture } from "../../../core/src/sunday-capture.js";
import { quietCheck, quietChecksLine, taskAccount, taskLine, type Account, type CheckFound, type TaskEnd, type TaskRow, type TaskStart } from "./harness-words.js";
import { Icon } from "./icons.js";
import { useDay } from "./day-words.js";
import { BY_DESIGN_OUTCOME, NOT_YET_OUTCOME, READ_LABELS, readOutcome, useSystemWords } from "./church-system.js";
import { SYSTEMS, type CapturePart, type SystemId } from "../../../core/src/church-systems/types.js";
import { PART_NAMES, shortByDesign } from "../../../core/src/church-systems/reads.js";
import { pageRef, SERVICES } from "./day-phrases.js";
import { promise, systemPromise } from "./promises.js";
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
 * One day's tasks, in order, as Recent work's lines: each task its own line, except two or more quiet checks in a row
 * (`quiet`: harness-words.ts `quietCheck`), which share one line that opens to each of them. Any other task between them
 * ends the run; nothing is left out.
 */
export function foldQuiet(tasks: readonly TaskRow[], quiet: (row: TaskRow) => boolean, sourceOf: (row: TaskRow) => string | undefined = () => undefined,
  serviceOf: (row: TaskRow) => string | undefined = () => undefined): TaskRow[][] {
  const lines: TaskRow[][] = [];
  let run: TaskRow[] = [];
  // With several services watched, one round reads each in turn: each service's quiet checks in the run fold together,
  // in the order each service first appears (owner decision 2026-11-19). One service: the run is one fold, as before.
  const close = () => {
    const by = new Map<string, TaskRow[]>();
    for (const r of run) { const k = serviceOf(r) ?? ""; by.set(k, [...(by.get(k) ?? []), r]); }
    for (const rows of by.values()) lines.push(...(rows.length > 1 ? [rows] : rows.map(r => [r])));
    run = [];
  };
  for (const row of tasks) {
    // A run is of one system's checks: a check of another system ends it.
    if (quiet(row) && run.length && sourceOf(run[0]!) !== sourceOf(row)) close();
    if (quiet(row)) { run.push(row); continue; }
    close();
    lines.push([row]);
  }
  close();
  return lines;
}
/** A fold is known by its oldest check, so one that is open stays open as newer quiet checks join it at the top. */
export const foldKey = (rows: readonly TaskRow[]) => `quiet-${rows.at(-1)!.task_id}`;

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
 * Recent work, newest first and grouped by day: one plain line per task, opening to a short account of it. Quiet checks in
 * a row on one day share a line that opens to each one's own line (display only: every task is still there). The newest
 * RECENT_SHOWN lines show; "Show earlier work" lists the rest. Name-free: the list holds no question, answer or source text.
 */
export function RecentWork({ tasks, procedures = null, trigger = () => undefined, end = () => undefined, found = () => undefined, source = () => undefined,
  parts = () => undefined, service = () => undefined, serviceNames = {}, now }: {
  /** The Planning Center service type a check read, when this Mac kept it. */
  service?: (taskId: string) => string | undefined;
  /** With more than one service watched, each one's own name by its service type: a fold of its checks says it. */
  serviceNames?: Readonly<Record<string, string>>;
  /** undefined while loading; null when the list isn't available. */
  tasks: TaskRow[] | null | undefined;
  procedures?: ReadonlyMap<string, Skill> | null;
  /** How a task started (a Sunday check's trigger, a job's run …), when this Mac knows. */
  trigger?: (taskId: string) => TaskStart | undefined;
  /** Which closed form a verified answer took, when this Mac knows. */
  end?: (taskId: string) => TaskEnd | undefined;
  /** What a check found, when this Mac knows: only checks kept as having found nothing new are folded. */
  found?: (taskId: string) => CheckFound | undefined;
  /** The system a check read, when it isn't Planning Center (a church on B1 Church or Breeze), as this Mac kept it. */
  source?: (taskId: string) => SystemId | undefined;
  /** The parts a church system's check didn't read in full, as this Mac kept them (reads.ts closed words). */
  parts?: (taskId: string) => readonly CapturePart[] | undefined;
  now?: Date;
}) {
  const [all, setAll] = useState(false);
  const id = useId();
  const day = useDay();
  const w = useSystemWords();
  if (tasks === undefined) return null;
  if (tasks === null) return <p className="small recent-quiet"><Icon name="info" small />{LEDGER_UNAVAILABLE}</p>;
  if (!tasks.length) return <p className="panel-sunken">Nothing yet. Questions you ask Ozzie and each check of {w.name} appear here.</p>;
  const sorted = [...tasks].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const kept = new Map(sorted.map(row => [row.task_id, { start: trigger(row.task_id), end: end(row.task_id) }]));
  const sourceOf = (row: TaskRow) => { const id = row.kind === "check" ? source(row.task_id) : undefined; return id ? SYSTEMS[id].name : undefined; };
  const quiet = (row: TaskRow) => quietCheck(row, kept.get(row.task_id)?.start, found(row.task_id), sourceOf(row));
  // A run never crosses a day: each day's tasks are folded on their own.
  const serviceOf = (row: TaskRow) => row.kind === "check" && !sourceOf(row) ? service(row.task_id) : undefined;
  const days = byDay(sorted, now ?? new Date()).map(d => ({ day: d.day, lines: foldQuiet(d.tasks, quiet, sourceOf, serviceOf) }));
  const several = Object.keys(serviceNames).length > 1;
  /** "Youth Night in Planning Center", when more than one service is watched and the fold's service is known by name. */
  const foldSource = (row: TaskRow) => {
    const id = serviceOf(row), name = several && id && Object.hasOwn(serviceNames, id) ? serviceNames[id] : undefined;
    return name ? `${name} in ${sourceOf(row) ?? "Planning Center"}` : sourceOf(row);
  };
  const total = days.reduce((n, d) => n + d.lines.length, 0);
  const earlier = total - RECENT_SHOWN;
  let room = all ? total : RECENT_SHOWN;
  const shown = days.flatMap(d => { const lines = d.lines.slice(0, Math.max(0, room)); room -= lines.length; return lines.length ? [{ ...d, lines }] : []; });
  const item = (row: TaskRow) => {
    const { start, end: ended } = kept.get(row.task_id) ?? {};
    const of = sourceOf(row);
    const line = taskLine(row, { procedures, day, ...(start ? { trigger: start } : {}), ...(now ? { now } : {}), ...(of ? { source: of } : {}) });
    const unread = of ? parts(row.task_id)?.map(p => PART_NAMES[p]) : undefined;
    const account = taskAccount(row, { start, end: ended, procedures, day, ...(now ? { now } : {}), ...(of ? { source: of } : {}), ...(unread?.length ? { unread } : {}) });
    return <li key={row.task_id} className={row.state === "failed" ? "is-problem" : ""}>
      <details className="recent-task">
        <summary><Icon name="chev" small /><span>{line}</span></summary>
        <TaskAccount account={account} />
      </details>
    </li>;
  };
  // Quiet checks in a row: one line, opening to each check exactly as it shows on its own.
  const fold = (rows: TaskRow[]) => <li key={foldKey(rows)}>
    <details className="recent-task recent-fold">
      <summary><Icon name="chev" small /><span>{quietChecksLine(rows, foldSource(rows[0]!))}</span></summary>
      <ol className="log recent">{rows.map(item)}</ol>
    </details>
  </li>;
  return <>
    <div className="recent-days" id={`${id}-list`}>
      {shown.map((d, i) => <section key={d.day} className="recent-day" aria-labelledby={`${id}-day-${i}`}>
        <h3 id={`${id}-day-${i}`} className="recent-day-h">{d.day}</h3>
        <ol className="log recent">{d.lines.map(line => line.length > 1 ? fold(line) : item(line[0]!))}</ol>
      </section>)}
    </div>
    {earlier > 0 && <div><button type="button" className="btn btn-quiet btn-sm btn-flush" aria-expanded={all} aria-controls={`${id}-list`} onClick={() => setAll(!all)}>
      {all ? `Show only the newest ${RECENT_SHOWN}` : `Show earlier work (${earlier} more)`}</button></div>}
  </>;
}

/**
 * "What happened": what Ozzie did recently, then every read in the latest check. With changes off for the church, all
 * reads; with them on (Planning Center only), the changes the leader confirmed come first (`changes`, change-card.tsx
 * `ChangeHistory`).
 */
export function ActivityPage({ capture, notGranted = false, tasks, procedures = null, trigger, end, found, source, parts, service, serviceNames, now, ollama = null, system = null, changes }: {
  /** Each check's Planning Center service type, and each watched service's name by it (several services watched). */
  service?: (taskId: string) => string | undefined; serviceNames?: Readonly<Record<string, string>>;
  capture: SundayCapture | null; notGranted?: boolean;
  /** A church on B1 Church or Breeze: the reads of its latest check, in place of Planning Center's. */
  system?: { name: string; check: { started_at: string; system?: SystemId; reads: readonly { read: string; checked_at: string; outcome: string }[] } | null } | null;
  tasks?: TaskRow[] | null | undefined; procedures?: ReadonlyMap<string, Skill> | null;
  trigger?: (taskId: string) => TaskStart | undefined; end?: (taskId: string) => TaskEnd | undefined;
  found?: (taskId: string) => CheckFound | undefined; source?: (taskId: string) => SystemId | undefined;
  parts?: (taskId: string) => readonly CapturePart[] | undefined; now?: Date;
  /** Each time Ozzie got Ollama (native `ollama_install_history`), oldest first: a time and a closed word, never a path. */
  ollama?: OllamaHistory["done"] | null;
  /** The changes confirmed for this church, and the line about reading as it reads then: App passes them only while changes are on. */
  changes?: { lede: string | null; section: ReactNode } | undefined;
}) {
  const w = useSystemWords();
  return <div className="col">
    <p className="eyebrow">What happened</p>
    <h1 className="h1">What Ozzie did</h1>
    <p className="lede">{changes?.lede ?? <>{system ? systemPromise("reads", system.name) : w.unchosen ? w.say(promise("reads")) : promise("reads")} {system ? promise("sends", "A") : promise("sends")}</>}</p>
    {!system && changes?.section}
    <section className="stack" aria-labelledby="recent-title">
      <h2 id="recent-title" className="h3">Recent work</h2>
      <RecentWork tasks={tasks} procedures={procedures} {...(trigger ? { trigger } : {})} {...(end ? { end } : {})} {...(found ? { found } : {})} {...(source ? { source } : {})} {...(parts ? { parts } : {})} {...(now ? { now } : {})}
        {...(service ? { service } : {})} {...(serviceNames ? { serviceNames } : {})} />
    </section>
    {ollama && ollama.length > 0 && <section className="stack" aria-labelledby="ollama-title">
      <h2 id="ollama-title" className="h3">{OLLAMA.historyTitle}</h2>
      <ol className="log">{[...ollama].reverse().map((o, i) => <li key={i}>
        <span className="log-t">{new Date(o.at_ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        <span>{ollamaDoneSaid(o.end)}</span>
      </li>)}</ol>
    </section>}
    {system && <section className="stack" aria-labelledby="reads-title">
      <h2 id="reads-title" className="h3">Every read in the latest check</h2>
      {!system.check && <p className="panel-sunken">No check has run yet. Every read appears here once {SERVICES} are checked.</p>}
      {system.check && <>
        <p className="checkline">{system.name} · started {new Date(system.check.started_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {system.check.reads.length} reads</p>
        <ol className="log">{system.check.reads.map((r, i) => {
          // Cut short by design every time (B1's forms, Breeze's newest form entries): read as Ozzie reads it, no problem.
          const designed = !!system.check?.system && shortByDesign(system.check.system, r.read, r.outcome) && !!BY_DESIGN_OUTCOME[r.read];
          return <li key={i} className={r.outcome === "ok" || r.outcome === "not-requested" || designed ? "" : "is-problem"}>
            <span className="log-t">{new Date(r.checked_at).toLocaleTimeString()}</span>
            <span>{READ_LABELS[r.read] ?? "Another read"}</span>
            <span className="small">{designed ? BY_DESIGN_OUTCOME[r.read] : r.outcome === "not-requested" && NOT_YET_OUTCOME[r.read] ? NOT_YET_OUTCOME[r.read] : readOutcome(r.outcome, system.name)}</span>
          </li>;
        })}</ol>
      </>}
    </section>}
    {!system && <section className="stack" aria-labelledby="reads-title">
      <h2 id="reads-title" className="h3">Every read in the latest check</h2>
      {!capture && <p className="panel-sunken">No check has run yet. Every read appears here once {SERVICES} are checked, or when you open the fictional example on {pageRef()}.</p>}
      {capture && <>
        <p className="checkline">{capture.kind === "recording" ? "Saved copy of a check" : "Planning Center"} · started {new Date(capture.started_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {capture.reads.length} reads</p>
        <ol className="log">{capture.reads.map((r, i) => <li key={i} className={r.outcome === "ok" || r.outcome === "not-requested" ? "" : "is-problem"}>
          <span className="log-t">{new Date(r.checked_at).toLocaleTimeString()}</span>
          <span>{activityLabel(r.collection)}{r.offset ? " (continued)" : ""}</span>
          <span className="small">{activityOutcome(r.outcome, notGranted)}</span>
        </li>)}</ol>
      </>}
    </section>}
  </div>;
}
