// Keeping watch, on screen: the plan a person confirms (from Ask or "Set up something
// new"), the list on What runs automatically, and what comes to the person on Today (each "Ozzie
// noticed" card and each responsibility's line, grouped by today-groups.ts). Every word is fixed local copy (responsibility-words.ts);
// names appear only on this Mac, resolved from the current check.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import "./ask-panel.css";
import {
  BRIEFING_WEEKDAYS, checksFreeAt, defaultPlan, sundayAhead, TEMPLATE_IDS, TEMPLATES, untilLifetime, validPlan, addDays, templateLimitsLeft,
  type Area, type Lifetime, type Parsed, type Plan, type Responsibility, type RunRow, type TemplateId,
} from "../../../core/src/harness/responsibilities.js";
import type { Autostart } from "./background.js";
import type { NoticedItem, Runner, RunnerView, WriteUp } from "./responsibility-runner.js";
import {
  accountsText, areasText, assumedText, atText, daysText, foundText, isWeekdays, jobTitle, lifetimeChoice, lifetimeText, limitsText, missingAccess, NEVER_TEXT, NO_WRITEUP,
  NOTICE_WORDS, noticedBadge, noticedChanges, noticedTitle, offerText, ONLY_WHILE, preparedTitle, purposeText, refusalText, REPORT_CHOICES, reportText, runText, scheduleText,
  statusText, STOP_TEXT, templateTitle, togetherText, watchesText, whenText, WRITEUP_CHECK, WRITEUP_HOW, writeupHead,
} from "./responsibility-words.js";
import { useDay } from "./day-words.js";
import { dayName, keepTitle, watchTitle } from "./day-phrases.js";
import type { DayWords } from "../../../core/src/service-day.js";
import { fillPeople } from "../../../core/src/harness/session.js";
import { aiText, jobStarted } from "./harness-words.js";
import { TaskAccount } from "./activity-page.js";
import { Icon } from "./icons.js";
import { zoneLabel } from "./proactive-page.js";
import { dateText, weekRollup } from "./responsibility-words.js";
import { KeptForBriefing } from "./sunday-ready.js";
import { signNote, yourName } from "./connection.js";
import { DraftActions, type OpenDraft } from "./draft-actions.js";

export const useRunnerView = (runner: Runner) => useSyncExternalStore(runner.subscribe, runner.view, runner.view);

/** What a plan card needs to know about this Mac's setup. */
export interface PlanContext {
  organization: string;
  granted: readonly Area[];
  modelReady: boolean;
  /** A saved Planning Center connection and a chosen service. */
  connected: boolean;
  /** The church's zone when known, otherwise this Mac's. */
  zone: string;
  now: () => string;
  /** The church-local date of the service Ozzie watches, once a check has read it (named `sunday` for history; any day). */
  sunday?: string | null;
  /** The church's name, when known: said instead of an organization number (spec §6). */
  church?: string | null;
  /** This Mac's zone (defaults to the system's). */
  macZone?: string;
  /** What Ozzie already keeps an eye on: one of each kind at a time. */
  existing?: readonly Responsibility[];
  /** "Pause everything" is on. */
  pausedAll?: boolean;
}
/** A plan's times are on the clock it was made in (the church's when known); say so when this Mac's clock is different. */
function zoneNote(zone: string, context: PlanContext): string {
  const mac = context.macZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone === mac ? "" : ` Times are the church's: ${zoneLabel(zone)}.`;
}
const at = (plan: Pick<Plan, "zone">, context: PlanContext) => ({ now: context.now(), zone: plan.zone });
/** The one of this kind Ozzie already keeps an eye on (active or paused), if any. */
const existingFor = (template: TemplateId, context: PlanContext) => context.existing?.find(r => r.template === template && r.status !== "ended") ?? null;
/** An existing responsibility as a plan to change, on its own clock (or this one's, for one made before clocks were kept). */
export const asPlan = (r: Responsibility, context: PlanContext): Plan => ({
  template: r.template, schedule: r.schedule, report: r.report, lifetime: r.lifetime, limits: r.limits, zone: r.zone ?? context.zone,
});
/** A "Keep {day} covered" plan that would stop before the service Ozzie watches. */
function endsEarly(plan: Plan, context: PlanContext): string | null {
  const chosen = context.sunday;
  if (plan.template !== "keep-sunday-covered" || plan.lifetime.kind !== "until" || !chosen || plan.lifetime.until >= chosen) return null;
  return `This ends before ${dateText(chosen)}, the day of the service Ozzie watches. Change it if you meant to keep going until then.`;
}
export interface PlanActions {
  start: (plan: Plan) => Promise<unknown>;
  /** Changes one Ozzie already keeps an eye on (instead of setting up a second of the same kind). */
  edit?: (id: string, plan: Plan) => Promise<unknown>;
  onSettings: () => void;
  onAutomatic: () => void;
}
const errorCode = (e: unknown) => typeof e === "string" ? e : "unavailable";
const TONE: Record<string, string> = { ok: "b-ok", muted: "b-muted", attn: "b-attn", look: "b-look" };
const REPORTS = new Set<NoticedItem["kind"]>(["found", "clear", "briefing"]);
/** The report a run made, when Ozzie still has it. */
const reportFor = (run: RunRow | undefined, view: RunnerView) => run ? view.noticed.find(i => i.run_id === run.run_id && REPORTS.has(i.kind)) ?? null : null;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The lifetimes offered when changing a plan: its own date, the chosen Sunday, the coming two Sundays (never today), and until stopped. */
function lifetimeOptions(plan: Plan, context: PlanContext): Lifetime[] {
  const sunday = sundayAhead(context.now(), plan.zone);
  const chosen = context.sunday && context.sunday > addDays(sunday, 7) ? [context.sunday] : [];
  const dated = [sunday, addDays(sunday, 7), ...chosen].map(d => untilLifetime(d, plan.zone)).filter((l): l is Lifetime => l !== null);
  const own = plan.lifetime.kind === "until" && !dated.some(l => l.kind === "until" && l.until === (plan.lifetime as { until: string }).until) ? [plan.lifetime] : [];
  return [...own, ...dated, { kind: "until-stopped" }];
}
const planOptions = (context: PlanContext) => ({ sunday: context.sunday ?? null });
const lifetimeKey = (l: Lifetime) => l.kind === "until" ? l.until : "until-stopped";

/** "Change it": time, day (weekly ones), until when, and how it tells you. */
export function PlanEditor({ plan, context, onDone, onCancel, doneLabel = "Use these changes" }: {
  plan: Plan; context: PlanContext; onDone: (plan: Plan) => void; onCancel: () => void; doneLabel?: string;
}) {
  const [draft, setDraft] = useState<Plan>(plan);
  const options = lifetimeOptions(plan, context);
  const ok = validPlan(draft, context.now());
  const weekly = TEMPLATES[draft.template].cadence === "weekly";
  return <div className="form plan-edit">
    <div className="row rule-row">
      <label htmlFor={`time-${draft.template}`}>Check at</label>
      <input id={`time-${draft.template}`} type="time" value={draft.schedule.time}
        onChange={e => setDraft({ ...draft, schedule: { ...draft.schedule, time: e.target.value } })} />
    </div>
    {draft.template === "morning-briefing" && <div className="row rule-row">
      <label htmlFor={`days-${draft.template}`}>On</label>
      <select id={`days-${draft.template}`} className="input" value={isWeekdays(draft.schedule.weekdays) ? "weekdays" : draft.schedule.weekdays.length ? "chosen" : "every"}
        onChange={e => setDraft({ ...draft, schedule: { ...draft.schedule, weekdays: e.target.value === "weekdays" ? [...BRIEFING_WEEKDAYS] : e.target.value === "every" ? [] : plan.schedule.weekdays } })}>
        <option value="weekdays">Weekdays (Monday to Friday)</option>
        <option value="every">Every day</option>
        {plan.schedule.weekdays.length > 0 && !isWeekdays(plan.schedule.weekdays) && <option value="chosen">{daysText(plan.schedule.weekdays)}</option>}
      </select>
    </div>}
    {weekly && <div className="row rule-row">
      <label htmlFor={`day-${draft.template}`}>Every</label>
      <select id={`day-${draft.template}`} className="input" value={draft.schedule.weekdays[0] ?? 0}
        onChange={e => setDraft({ ...draft, schedule: { ...draft.schedule, weekdays: [Number(e.target.value)] } })}>
        {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
      </select>
    </div>}
    <div className="row rule-row">
      <label htmlFor={`until-${draft.template}`}>Until</label>
      <select id={`until-${draft.template}`} className="input" value={lifetimeKey(draft.lifetime)}
        onChange={e => setDraft({ ...draft, lifetime: options.find(l => lifetimeKey(l) === e.target.value) ?? draft.lifetime })}>
        {options.map(l => <option key={lifetimeKey(l)} value={lifetimeKey(l)}>{lifetimeChoice(l)}</option>)}
      </select>
    </div>
    {draft.template !== "morning-briefing" && <fieldset className="plan-report">
      <legend className="bold">Tell me</legend>
      {(["decisions-only", "every-check"] as const).map(r => <label key={r} className="confirmation">
        <input type="radio" name={`report-${draft.template}`} checked={draft.report === r} onChange={() => setDraft({ ...draft, report: r })} />
        <span>{REPORT_CHOICES[r]}</span></label>)}
    </fieldset>}
    {!ok && <p className="problem" role="alert">That time or date isn't one Ozzie can use.</p>}
    <div className="find-next">
      <button type="button" className="btn btn-primary btn-sm" disabled={!ok} onClick={() => onDone(draft)}>{doneLabel}</button>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

/** The plan rows: what it watches, which accounts, when, how it tells you, until when, limits, how to stop. */
export function PlanRows({ plan, context }: { plan: Plan; context: PlanContext }) {
  const d = useDay();
  return <div className="sp">
    <div className="sp-row sp-2"><span className="sp-h">What Ozzie will watch</span><span>{watchesText(plan.template, d)}</span></div>
    <div className="sp-row sp-2"><span className="sp-h">Accounts</span><span>{accountsText(plan.template, context.church)}</span></div>
    <div className="sp-row sp-2"><span className="sp-h">When it checks</span><span>{scheduleText(plan, at(plan, context), d)}{zoneNote(plan.zone, context)} {ONLY_WHILE}</span></div>
    <div className="sp-row sp-2"><span className="sp-h">When it tells you</span><span>{reportText(plan)}</span></div>
    <div className="sp-row sp-2"><span className="sp-h">Until</span><span>{lifetimeText(plan.lifetime, plan.template, plan.schedule.weekdays)}</span></div>
    <div className="sp-row sp-2"><span className="sp-h">Limits</span><span>{limitsText(plan, context.modelReady)}</span></div>
    <div className="sp-row sp-2"><span className="sp-h">How to stop</span><span>{STOP_TEXT}</span></div>
  </div>;
}

/** What the plan card says once it has started: only what is true now (checking, waiting for a connection, or paused). */
export function startedText(plan: Plan, context: PlanContext, d?: DayWords): string {
  const then = scheduleText(plan, at(plan, context), d).replace(/^Every/u, "every").replace(/\.$/u, "");
  const first = context.pausedAll ? `Everything is paused, so Ozzie won't check until you resume everything. Then ${then}.`
    : !context.connected ? `Ozzie will check as soon as Planning Center is connected, then ${then}.`
      : `Ozzie is checking now, then ${then}.`;
  return `${first} ${ONLY_WHILE} ${STOP_TEXT}`;
}

/**
 * One confirmation before Ozzie takes something on (owner decision, November 4): a short, editable
 * plan. "Looks good — start it" creates it; nothing runs before that. Access that isn't granted is
 * offered, never widened.
 */
export function PlanCard({ plan: initial, assumed = [], context, actions }: {
  plan: Plan; assumed?: readonly string[]; context: PlanContext; actions: PlanActions;
}) {
  const [plan, setPlan] = useState(initial);
  const [stage, setStage] = useState<"review" | "edit" | "starting" | "started" | "declined" | "exists" | "change" | "changed" | "kept">(
    () => existingFor(initial.template, context) ? "exists" : "review");
  const [problem, setProblem] = useState<string | null>(null);
  const d = useDay();
  const title = templateTitle(plan.template, d);
  const access = missingAccess(plan.template, context.granted);
  const assumption = stage === "review" && plan === initial ? assumedText(plan, assumed) : null;
  const early = endsEarly(plan, context);
  const existing = existingFor(plan.template, context);
  const start = async () => {
    setStage("starting"); setProblem(null);
    try { await actions.start(plan); setStage("started"); }
    catch (e) {
      // One of each kind at a time: the one already running is changed instead.
      if (errorCode(e) === "exists" && existingFor(plan.template, context)) { setStage("exists"); return; }
      setProblem(refusalText(errorCode(e))); setStage("review");
    }
  };
  if (stage === "declined") return <div className="find plan-card"><p className="small">Not started. Nothing will run.</p></div>;
  if (stage === "started") {
    return <div className="find plan-card" role="status">
      <div className="find-top"><span className="badge b-ok"><Icon name="check" small />Started</span><span className="find-where">{title}</span></div>
      <p className="find-body">{startedText(plan, context, d)}</p>
      <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={actions.onAutomatic}>Open Keeping watch</button></div>
    </div>;
  }
  if (stage === "changed") return <div className="find plan-card" role="status"><p className="small">Changed. Ozzie keeps an eye on it with these changes.</p></div>;
  if (stage === "kept") return <div className="find plan-card"><p className="small">Nothing changed. Ozzie keeps an eye on it as before.</p></div>;
  if ((stage === "exists" || stage === "change") && existing) {
    const current = asPlan(existing, context);
    return <div className="find plan-card">
      <div className="find-top"><span className="badge b-muted">{existing.status === "paused" ? "Paused" : "Already running"}</span><span className="find-where">{title}</span></div>
      <p className="find-body">Ozzie is already keeping an eye on this.</p>
      {stage === "change"
        ? <PlanEditor plan={current} context={context} doneLabel="Save changes" onCancel={() => setStage("exists")}
          onDone={p => { setProblem(null); void actions.edit?.(existing.id, p).then(() => setStage("changed"), e => { setProblem(refusalText(errorCode(e))); setStage("exists"); }); }} />
        : <PlanRows plan={current} context={context} />}
      {problem && <p className="problem" role="alert">{problem}</p>}
      {stage === "exists" && <div className="find-next">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => actions.edit ? setStage("change") : actions.onAutomatic()}>Change it</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStage("kept")}>Leave it as it is</button>
      </div>}
    </div>;
  }
  return <div className="find plan-card">
    <div className="find-top"><span className="badge b-muted">Plan · not started yet</span><span className="find-where">Planning Center</span></div>
    <h3 className="find-title">{title}</h3>
    {stage === "edit"
      ? <PlanEditor plan={plan} context={context} onDone={p => { setPlan(p); setStage("review"); }} onCancel={() => setStage("review")} />
      : <PlanRows plan={plan} context={context} />}
    {assumption && <p className="small plan-assumed"><Icon name="info" small />{assumption}</p>}
    {early && stage !== "edit" && <p className="panel-warn" role="status"><Icon name="info" small />{early}</p>}
    <p className="small">{NEVER_TEXT}</p>
    {access && <p className="panel-warn" role="status"><Icon name="lock" small />{access}</p>}
    {!access && !context.connected && <p className="panel-info"><Icon name="info" small />Planning Center isn't connected yet, so the first check waits until it is.</p>}
    {problem && <p className="problem" role="alert">{problem}</p>}
    {stage !== "edit" && <div className="find-next">
      {access
        ? <button type="button" className="btn btn-primary btn-sm" onClick={actions.onSettings}>Set up access in Settings</button>
        : <button type="button" className="btn btn-primary btn-sm" disabled={stage === "starting"} onClick={() => { void start(); }}>
          {stage === "starting" ? <><Icon name="spinner" small spin />Starting…</> : "Looks good — start it"}</button>}
      {!access && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setStage("edit")}>Change it</button>}
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setStage("declined")}>Not now</button>
    </div>}
  </div>;
}

/** A question back when the request left something important unclear, then the plan. */
export function PlanTurn({ parsed, context, actions }: { parsed: Exclude<Parsed, { kind: "none" }>; context: PlanContext; actions: PlanActions }) {
  const d = useDay();
  const [chosen, setChosen] = useState<{ plan: Plan; assumed: readonly string[] } | null>(parsed.kind === "plan" ? { plan: parsed.plan, assumed: parsed.assumed } : null);
  if (chosen) return <PlanCard plan={chosen.plan} assumed={chosen.assumed} context={context} actions={actions} />;
  if (parsed.kind === "ask" && parsed.need === "what") return <div className="find plan-card">
    <p className="find-body">What should Ozzie keep an eye on?</p>
    <div className="plan-choices">{parsed.choices.map(id => <button key={id} type="button" className="btn btn-secondary btn-sm"
      onClick={() => setChosen({ plan: defaultPlan(id, context.now(), context.zone, planOptions(context)), assumed: ["lifetime"] })}>{templateTitle(id, d)}</button>)}</div>
  </div>;
  if (parsed.kind === "ask") return <div className="find plan-card">
    <p className="find-body">{templateTitle(parsed.template, d)}: until when?</p>
    <div className="plan-choices">{parsed.choices.map(l => <button key={lifetimeKey(l)} type="button" className="btn btn-secondary btn-sm"
      onClick={() => setChosen({ plan: { ...defaultPlan(parsed.template, context.now(), context.zone, planOptions(context)), lifetime: l }, assumed: [] })}>{lifetimeChoice(l)}</button>)}</div>
  </div>;
  return null;
}

/** "Set up something new": the fixed templates, each opening its plan. */
export function TemplatePicker({ context, actions, onCancel }: { context: PlanContext; actions: PlanActions; onCancel: () => void }) {
  const [picked, setPicked] = useState<TemplateId | null>(null);
  const d = useDay();
  if (picked) return <PlanCard plan={defaultPlan(picked, context.now(), context.zone, planOptions(context))} context={context} actions={actions} />;
  return <div className="find template-picker">
    <h3 className="find-title">What should Ozzie keep an eye on?</h3>
    <ul className="list template-list">{TEMPLATE_IDS.map(id => <li key={id}>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPicked(id)}>{templateTitle(id, d)}</button>
      <span className="small">{purposeText(id, d)}</span>
    </li>)}</ul>
    <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={onCancel}>Cancel</button></div>
  </div>;
}

// ---- Keeping watch ------------------------------------------------------------------------

/** On this Mac's clock, as whenText: "at 9:31 AM" today, "tomorrow at 9:31 AM", otherwise "Mon 9:31 AM". */
export function againText(iso: string, now: string): string {
  const d = new Date(iso), today = new Date(now);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? `at ${time}` : d.toDateString() === tomorrow.toDateString() ? `tomorrow at ${time}` : whenText(iso, now);
}
/**
 * When a responsibility whose kind has used its checks for the last 24 hours can check again, if that is later
 * than its next scheduled time (a time it couldn't keep); null otherwise.
 */
export function checksBack(r: Responsibility, view: RunnerView, now: string): string | null {
  const free = checksFreeAt(r, view.items, now);
  const next = view.next[r.id];
  return free && (!next || Date.parse(free) > Date.parse(next)) ? free : null;
}

function ResponsibilityCard({ r, view, context, runner, level = 3, names = {} }: {
  r: Responsibility; view: RunnerView; context: PlanContext; runner: Runner;
  /** Its title's heading level: 4 inside the Sunday item. */
  level?: 3 | 4;
  /** Names from the check on screen, for its write-up (on this Mac only). */
  names?: Readonly<Record<string, string>>;
}) {
  const Title = level === 4 ? "h4" : "h3";
  const d = useDay();
  const title = jobTitle(r, d);
  const [editing, setEditing] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const now = context.now();
  // The newest thing it reported about a check, if that was that it couldn't check (the store refused the run).
  const lastReport = view.noticed.find(i => i.responsibility_id === r.id && (i.kind === "couldnt-check" || i.kind === "found" || i.kind === "clear" || i.kind === "briefing"));
  const couldnt = lastReport?.kind === "couldnt-check";
  const status = statusText(r, view.paused_all, couldnt);
  // As the Mac counts it: this kind's checks in the last 24 hours, including one stopped and set up again.
  const left = templateLimitsLeft(r, view.items, now);
  const next = view.next[r.id];
  const back = checksBack(r, view, now);
  const running = view.running === r.id;
  const plan = asPlan(r, context);
  const items = view.noticed.filter(i => i.responsibility_id === r.id && (i.kind === "missed" || i.kind === "couldnt-check" || i.kind === "limit")).slice(0, 3);
  // The last check's write-up, kept with its run: folded here, where the job is managed.
  const lastItem = reportFor(r.runs[0], view);
  const lastWriteup = lastItem ? view.writeups[lastItem.id] ?? null : null;
  const act = (work: () => Promise<unknown>) => { setProblem(null); void work().catch(e => setProblem(refusalText(errorCode(e)))); };
  return <section className="find responsibility" aria-label={title}>
    <div className="find-top"><span className={`badge ${TONE[status.tone]}`}>{status.label}</span><span className="find-where">{areasText(r.template)}{context.church ? `, ${context.church}` : ""}</span></div>
    <Title className="find-title">{title}</Title>
    {editing
      ? <PlanEditor plan={plan} context={context} doneLabel="Save changes" onCancel={() => setEditing(false)}
        onDone={p => { setEditing(false); act(() => runner.edit(r.id, p)); }} />
      : <div className="sp">
        <div className="sp-row sp-2"><span className="sp-h">Watches</span><span>{watchesText(r.template, d)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">When</span><span>{scheduleText(plan, at(plan, context), d)}{zoneNote(plan.zone, context)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Until</span><span>{lifetimeText(r.lifetime, r.template, r.schedule.weekdays)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Tells you</span><span>{reportText(r)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Last check</span><span>{running ? "Checking now…" : r.runs[0] ? runText(r.runs[0], now, reportFor(r.runs[0], view)) : "Not yet."}</span></div>
        {r.status === "active" && !view.paused_all && <div className="sp-row sp-2"><span className="sp-h">Next check</span>
          <span>{back ? `It has used its checks for now. It can check again ${againText(back, now)}.` : next ? whenText(next, now)
            : !context.connected ? "As soon as Planning Center is connected." : "Not scheduled."}</span></div>}
        <div className="sp-row sp-2"><span className="sp-h">Today</span><span>{r.limits.checks_per_day - left.checks} of {r.limits.checks_per_day} checks used in the last 24 hours.</span></div>
      </div>}
    {!editing && lastItem && lastWriteup?.kind === "written" && <details className="listen-more today-writeup resp-writeup">
      <summary><Icon name="chev" small />Ozzie's write-up of the last check</summary>
      <WriteUpBlock item={lastItem} writeup={lastWriteup} names={names} now={now} /></details>}
    {!editing && lastItem && lastWriteup && lastWriteup.kind !== "written" && <WriteUpBlock item={lastItem} writeup={lastWriteup} names={names} now={now} />}
    {items.length > 0 && <ul className="list resp-problems">{items.map(i => <li key={i.id}><Icon name="clock" small />{noticedTitle(i, now, d)}</li>)}</ul>}
    {problem && <p className="problem" role="alert">{problem}</p>}
    {!editing && <div className="find-next">
      <button type="button" className="btn btn-primary btn-sm" disabled={running || r.status !== "active" || view.paused_all}
        onClick={() => act(() => runner.runNow(r.id))}>{running ? <><Icon name="spinner" small spin />Checking…</> : status.tone === "attn" ? "Try again now" : "Check now"}</button>
      {r.status === "paused"
        ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => act(() => runner.resume(r.id))}>Resume</button>
        : <button type="button" className="btn btn-secondary btn-sm" onClick={() => act(() => runner.pause(r.id))}>Pause</button>}
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>Change</button>
      {confirmStop
        ? <><span className="small">Stop for good? Ozzie won't check this again.</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setConfirmStop(false); act(() => runner.stop(r.id)); }}>Yes, stop it</button>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirmStop(false)}>Keep it</button></>
        : <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirmStop(true)}>Stop</button>}
    </div>}
  </section>;
}

/** Keep {day} covered isn't on: offered beside the hourly look, opening its plan to confirm. */
function KeepSundayOffer({ context, actions }: { context: PlanContext; actions: PlanActions }) {
  const [open, setOpen] = useState(false);
  const d = useDay();
  if (open) return <PlanCard plan={defaultPlan("keep-sunday-covered", context.now(), context.zone, planOptions(context))} context={context} actions={actions} />;
  return <section className="find" aria-labelledby="keep-sunday-offer">
    <div className="find-top"><span className="badge b-muted">Not on</span></div>
    <h4 id="keep-sunday-offer" className="find-title">{keepTitle(d)}</h4>
    <p className="find-body">{offerText(d)}</p>
    <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>Set up {keepTitle(d)}</button></div>
  </section>;
}

/**
 * The home for responsibilities on Keeping watch. `sunday`: Ozzie's regular look at the watched service
 * (proactive-page.tsx), shown first as one item with Keep {day} covered (or an offer to set it up), so the two things that
 * look at the service read as one; the rest follow.
 */
export function ResponsibilityList({ view, context, runner, actions, sunday, names = {} }: {
  view: RunnerView; context: PlanContext; runner: Runner; actions: PlanActions; sunday?: ReactNode;
  /** Names from the check on screen, for each job's write-up (on this Mac only). */
  names?: Readonly<Record<string, string>>;
}) {
  const [picking, setPicking] = useState(false);
  const d = useDay();
  const active = view.items.filter(r => r.status !== "ended");
  const ended = view.items.filter(r => r.status === "ended").slice(0, 3);
  const grouped = sunday !== undefined;
  const keep = grouped ? active.find(r => r.template === "keep-sunday-covered") ?? null : null;
  const others = active.filter(r => r !== keep);
  // Pause everything pauses the regular look at the service too (proactive.ts pauseWithEverything), so it is
  // offered whenever anything runs on its own, that look alone included.
  const watching = `Ozzie keeping an eye on ${dayName(d)}`;
  const stops = grouped && active.length ? `${watching}, and everything else here,` : grouped ? watching : active.length ? "everything here" : null;
  return <section className="stack responsibilities" aria-labelledby="resp-title">
    <div className="row resp-head">
      <h2 id="resp-title" className="h3">What Ozzie is keeping an eye on</h2>
      <span className="spacer" />
      {view.paused_all
        ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => { void runner.pauseAll(false); }}>Resume everything</button>
        : stops && <button type="button" className="btn btn-secondary btn-sm" aria-describedby="pause-scope" onClick={() => { void runner.pauseAll(true); }}>Pause everything</button>}
    </div>
    <p className="small">Ozzie keeps checking while its window is closed; it stays as the small Ozzie picture at the top of your screen. Nothing runs after you quit Ozzie or while this Mac is asleep, and it catches up once when it can. Ozzie keeps an eye on one of each kind at a time; change it rather than setting up another.</p>
    {stops && !view.paused_all && <p id="pause-scope" className="small">Pause everything stops {stops} until you resume.</p>}
    {!view.available && <p className="panel-warn" role="status"><Icon name="info" small />Ozzie's list of what it keeps an eye on couldn't be read on this Mac right now.</p>}
    {view.paused_all && <p className="panel-info" role="status"><Icon name="info" small />Everything is paused. Nothing runs on its own until you resume.</p>}
    {grouped && <section className="sunday-watch" aria-labelledby="sunday-watch-title">
      <h3 id="sunday-watch-title" className="sunday-watch-h">Keeping an eye on {dayName(d)}</h3>
      <p className="small">{togetherText(d)}</p>
      {sunday}
      {keep ? <ResponsibilityCard r={keep} view={view} context={context} runner={runner} level={4} names={names} />
        : view.available && <KeepSundayOffer context={context} actions={actions} />}
    </section>}
    {view.available && !grouped && active.length === 0 && <p className="panel-sunken">Nothing yet. Ask Ozzie something like “{watchTitle(d)}”, or set one up here.</p>}
    {others.map(r => <ResponsibilityCard key={r.id} r={r} view={view} context={context} runner={runner} names={names} />)}
    {picking
      ? <TemplatePicker context={context} actions={actions} onCancel={() => setPicking(false)} />
      : <div><button type="button" className="btn btn-secondary" onClick={() => setPicking(true)}>Set up something new</button></div>}
    {ended.length > 0 && <details className="resp-ended"><summary>Ended recently</summary>
      <ul className="list">{ended.map(r => <li key={r.id}><Icon name="dot" small />{jobTitle(r, d)} · {lifetimeText(r.lifetime, r.template).replace(/ Then it stops on its own\.$/u, "")}</li>)}</ul>
    </details>}
  </section>;
}

// ---- A job's write-up (audit item 6) --------------------------------------------------------------------

/**
 * A job's run, as the AI wrote it up: "Ozzie checked Wednesday at 9:06 AM:", Ozzie's own sentence for each fact the AI
 * chose (people filled in from the check on screen, on this Mac), where those facts came from and when, and "See how
 * this works" with the run's steps. Without a write-up, one quiet line says why, never a blank. It decides nothing: the
 * card's counts, findings and notice come from Ozzie's own check.
 */
export function WriteUpBlock({ item, writeup, names, now }: {
  item: Pick<NoticedItem, "template" | "at" | "trigger">; writeup: WriteUp | null | undefined; names: Readonly<Record<string, string>>; now: string;
}) {
  const [how, setHow] = useState(false);
  const d = useDay();
  if (!writeup) return null;
  // With no AI route set up the card simply shows the check (review H, L15); "stopped" was a pause during the write-up.
  if (writeup.kind !== "written") return writeup.why === "off" || writeup.why === "stopped" ? null
    : <p className="small writeup-none"><Icon name="info" small />{NO_WRITEUP[writeup.why ?? "unavailable"]}</p>;
  const started = item.trigger ? jobStarted(item.template, item.trigger, atText(item.at, now).replace(/^(?:at|on) /u, ""), d) : null;
  return <section className="writeup" aria-label="Ozzie's write-up">
    <p className="writeup-head">{writeupHead(item, now, d)}</p>
    {(writeup.gaps?.length ?? 0) > 0 && <div className="stack-tight"><span className="badge b-look"><Icon name="eye" small />Worth a look</span>
      <ul className="list">{writeup.gaps!.map(g => <li key={g}><Icon name="dot" small />{g}</li>)}</ul></div>}
    <div className="writeup-lines">{(writeup.lines ?? []).map((l, i) => <p key={i}>{fillPeople(l, names)}</p>)}</div>
    {writeup.based_on && <p className="ask-based"><Icon name="check" small />{writeup.based_on}</p>}
    <button type="button" className="btn btn-quiet btn-sm ask-how" aria-expanded={how} onClick={() => setHow(!how)}><Icon name="info" small />See how this works</button>
    {how && <div className="ask-how-body stack-tight">
      <TaskAccount account={{
        started: [started, WRITEUP_CHECK].filter(Boolean).join(" "), looked: writeup.steps ?? [],
        ai: aiText("skill", undefined, writeup.ai_steps ?? 0, true), ended: "Ozzie wrote the lines above from the facts the AI chose.",
      }} />
      <p className="small">{WRITEUP_HOW}</p>
    </div>}
  </section>;
}

// ---- Today -------------------------------------------------------------------------------------------

/**
 * One responsibility's line on Today (In progress): when it checks next and what it found last, labeled
 * as everywhere else (things to decide, Worth a look apart); without the run's report, "findings".
 */
export function watchLine(r: Responsibility, view: RunnerView, now: string): string {
  const last = r.runs.find(x => x.outcome);
  const next = view.next[r.id];
  // Its checks for the last 24 hours used: when it can check again, never a scheduled time it can't keep.
  const back = checksBack(r, view, now);
  const when = r.status === "paused" ? "Paused" : view.paused_all ? "Paused with everything" : view.running === r.id ? "Checking now"
    : back ? `Can check again ${againText(back, now)}` : next ? `Next check ${whenText(next, now)}` : "";
  const report = reportFor(last, view);
  const labeled = report ? foundText(report) : "";
  const found = last ? `last check: ${last.outcome !== "ok" ? "couldn't finish" : labeled || (!report && last.noticed ? `${last.noticed} ${last.noticed === 1 ? "finding" : "findings"}` : "nothing new")}`
    : "not checked yet";
  return when ? `${when} · ${found}` : found.charAt(0).toUpperCase() + found.slice(1);
}

type Clipboard = { writeText(text: string): Promise<void> } | undefined;
const systemClipboard = (): Clipboard => typeof navigator === "undefined" ? undefined : navigator.clipboard;
/** True only once the text is on the clipboard; a missing or refusing clipboard is false, never success. */
export async function copyText(text: string, clipboard: Clipboard = systemClipboard()): Promise<boolean> {
  if (!clipboard) return false;
  try { await clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * "Copy draft", with Open in Mail and Open in Messages for the same words. A copy that didn't work says so and is never
 * shown as copied.
 */
export function CopyDraft({ text, describedBy, open }: { text: string; describedBy?: string | undefined; open?: OpenDraft | undefined }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => setState(await copyText(text) ? "copied" : "failed");
  return <div className="stack-tight copy-draft">
    <DraftActions text={text} small describedBy={describedBy} open={open}
      copy={<button type="button" className="btn btn-secondary btn-sm" aria-describedby={describedBy} onClick={() => { void copy(); }}>
        {state === "copied" ? "Copied — send it yourself" : "Copy draft"}</button>} />
    {state === "failed" && <p role="alert" className="problem">The draft couldn't be copied. Select its text and copy it yourself.</p>}
  </div>;
}

/**
 * Something Ozzie noticed while keeping an eye on things, as a Today card: what it found, what it
 * prepared (a summary, and a drafted note to copy), and where to go next. `children` adds Today's own
 * controls under the card's actions.
 */
/** Quiet success, loud problems: one line for the week's regular jobs in the morning briefing, and each one that couldn't finish. */
function WeekLine({ view, now }: { view: RunnerView; now: string }) {
  const week = weekRollup(view.items, now, useDay());
  if (!week.line && !week.problems.length) return null;
  return <div className="small noticed-week">
    {week.line && <p>{week.line}</p>}
    {week.problems.map(p => <p key={p}>{p}</p>)}
  </div>;
}

export function NoticedCard({ item, view, names, now, onOpen, titleId, age, prepared = false, written = null, sundayReady = null, children }: {
  item: NoticedItem; view: RunnerView; names: Readonly<Record<string, string>>; now: string;
  onOpen: (page: "sunday" | "automatic" | "connection") => void; titleId?: string;
  /** Its age on Today, which also says when it came: the noticed time isn't repeated. */
  age?: string | null;
  /** Shown under Ready to review: its badge says it is ready rather than repeating the decision in its title. */
  prepared?: boolean;
  /**
   * Only what the AI wrote for this report, named for what was written: its decisions, changes and notes
   * are on Today's Sunday card, so they aren't repeated here.
   */
  written?: { summary: string | null; draft: string | null } | null;
  /** Thursday's briefing: the full brief for the service, shown inside it (only on a briefing marked Thursday's). */
  sundayReady?: ReactNode;
  children?: ReactNode;
}) {
  const own = written !== null;
  const d = useDay();
  const badge = prepared || own ? { label: "Ready", tone: "ok" as const } : noticedBadge(item);
  const changes = own ? [] : noticedChanges(item, names, d);
  // "Your name for notes" goes in here, on this Mac, after the note was drafted; [Your name] stays when none is set.
  const ready = written?.draft ? { ...written, draft: signNote(written.draft, yourName.get()) } : written;
  // A report's write-up (or why there is none) leads its card.
  const writeup = !own && (item.kind === "found" || item.kind === "briefing") ? view.writeups[item.id] ?? null : null;
  const notice = !own && item.notice ? NOTICE_WORDS[item.notice] : null;
  const page = item.kind === "couldnt-check" && item.access ? "connection" : item.kind === "missed" || item.kind === "limit" || item.kind === "couldnt-check" ? "automatic" : "sunday";
  return <article className="find noticed" aria-labelledby={titleId}>
    <div className="find-top"><span className={`badge ${TONE[badge.tone]}`}>{badge.label}</span>
      {item.overnight && !own && <span className="badge b-muted"><Icon name="clock" small />Overnight</span>}
      <span className="find-where">{own ? "Ozzie prepared" : "Ozzie noticed"} · {templateTitle(item.template, d)}{age ? "" : ` · ${whenText(item.at, now)}`}</span>
      {age && <span className="find-age">{age}</span>}</div>
    <h3 id={titleId} className="find-title">{written ? preparedTitle(written, d) : noticedTitle(item, now, d)}</h3>
    <WriteUpBlock item={item} writeup={writeup} names={names} now={now} />
    {changes.length > 0 && <ul className="list">{changes.map(c => <li key={c}><Icon name="dot" small />{c}</li>)}</ul>}
    {item.kind === "briefing" && item.sunday_ready && sundayReady}
    {item.kind === "briefing" && !own && <KeptForBriefing item={item} />}
    {item.kind === "briefing" && !own && <WeekLine view={view} now={now} />}
    {ready?.summary && <div className="noticed-summary">{ready.summary.split(/\n{2,}/u).map((p, i) => <p key={i}>{p}</p>)}</div>}
    {ready?.draft && <div className="draft" role="region" aria-label="Draft note">
      <span className="badge b-draft">Draft only. Nothing has been sent.</span>
      <div className="draft-body">{ready.draft.split(/\n{2,}/u).map((p, i) => <p key={i}>{p}</p>)}</div>
      <CopyDraft text={ready.draft} describedBy={titleId} /></div>}
    {item.drafts && !own ? <p className="small">{item.drafts === 1 ? "1 note is" : `${item.drafts} notes are`} ready for you to review and send yourself.</p> : null}
    <div className="find-next">
      <button type="button" className="btn btn-secondary btn-sm" aria-describedby={titleId} onClick={() => onOpen(page)}>
        {page === "sunday" ? `Open ${dayName(d)}` : page === "connection" ? "Open Settings" : "Open Keeping watch"}</button>
      {notice && <span className="small">{notice}</span>}
    </div>
    {children}
  </article>;
}

// ---- Open at login -----------------------------------------------------------------------------------

/** "Start Ozzie when this Mac starts" (spec §4.1, §6: never "log in"): as chosen in setup (Yes is chosen there to start), and changed only here or in setup. */
export function AutostartToggle({ autostart }: { autostart: Autostart }) {
  const [state, setState] = useState<boolean | null>(null);
  const [problem, setProblem] = useState(false);
  useEffect(() => { let alive = true; autostart.get().then(v => { if (alive) setState(v); }).catch(() => { if (alive) setProblem(true); }); return () => { alive = false; }; }, [autostart]);
  return <div className="stack-tight">
    <label className="confirmation"><input type="checkbox" checked={state === true} disabled={state === null && !problem}
      onChange={e => { const want = e.target.checked; autostart.set(want).then(setState).catch(() => setProblem(true)); }} />
      <span>Start Ozzie when this Mac starts</span></label>
    <p className="small">On if you chose it in setup; you can change it here. When it's on, Ozzie starts quietly as the small Ozzie picture at the top of your screen, so it keeps an eye on things after a restart.</p>
    {problem && <p className="small">This Mac didn't let Ozzie change that setting.</p>}
  </div>;
}
