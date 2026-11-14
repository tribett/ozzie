import { useSyncExternalStore } from "react";
import { describeChange, type SundayChange } from "../../../core/src/sunday-changes.js";
import type { RunTrigger } from "../../../core/src/schedule.js";
import { INTERVAL_CHOICES, type HistoryEntry, type ProactiveController, type ProactivePrefs, type ProactiveView, type Readiness } from "./proactive.js";
import { Icon } from "./icons.js";

export const useProactiveView = (p: ProactiveController) => useSyncExternalStore(p.subscribe, p.view, p.view);

type Names = Record<string, string>;
const time = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h ?? 0, m ?? 0).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
};
const every = (minutes: number) => minutes === 60 ? "every hour" : minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`;
const capital = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
/**
 * "Every hour, and when Ozzie opens. Nothing runs after you quit Ozzie." Shared with Settings and guided
 * setup. Closing the window doesn't stop Ozzie; it keeps running in the menu bar.
 */
export const scheduleLine = (prefs: ProactivePrefs) =>
  `${capital(every(prefs.intervalMinutes))}${prefs.runOnLaunch ? ", and when Ozzie opens" : ""}. Nothing runs after you quit Ozzie.`;
/** "9:30 PM to 6:30 AM. Notices wait until they end." */
export const quietLine = (prefs: ProactivePrefs) =>
  `${clock(prefs.quietStart)} to ${clock(prefs.quietEnd)}. Notices wait until they end${prefs.urgentDuringQuiet ? ", except urgent ones" : ""}.`;
const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** "Central Time (America/Chicago)": the zone's everyday name where this Mac knows one, then its IANA name. */
export function zoneLabel(zone: string): string {
  const name = (style: "longGeneric" | "long") => {
    try { return new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: style }).formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value; }
    catch { return undefined; }
  };
  const long = name("longGeneric") ?? name("long");
  return long && long !== zone ? `${long} (${zone})` : zone;
}
/**
 * The church's own zone when a check read it from Planning Center; otherwise this Mac's. Times on this
 * page and quiet hours follow this Mac's clock, so a church on a different zone says so.
 */
export function zoneText(churchTimeZone: string | null, mac = macZone()): string {
  if (!churchTimeZone) return `${zoneLabel(mac)}, this Mac's time. The church's own time zone shows here once a check reads it from Planning Center.`;
  return churchTimeZone === mac ? `${zoneLabel(churchTimeZone)}, the church's time zone in Planning Center. This Mac is on the same time.`
    : `${zoneLabel(churchTimeZone)}, the church's time zone in Planning Center. Times on this page and quiet hours follow this Mac's clock: ${zoneLabel(mac)}.`;
}
const why: Record<RunTrigger, string> = {
  launch: "when Ozzie opened", scheduled: "on schedule", retry: "trying again after a problem", resume: "after resuming",
  "catch-up": "catching up after a missed check", manual: "Check now",
};
const notice: Record<NonNullable<HistoryEntry["notice"]>, string | null> = {
  sent: "Notice sent", held: "Notice waiting for quiet hours to end", "sent-later": "Notice sent after quiet hours",
  "in-app": "Seen in Ozzie", unavailable: "The Mac didn't show the notice", none: null,
};
const RECENT_MS = 24 * 3_600_000;

function ChangeLine({ change, names }: { change: SundayChange; names: Names }) {
  const tag = change.urgency === "urgent" ? <span className="badge b-conflict"><Icon name="flag" small />Urgent</span>
    : change.kind === "coverage-unverified" ? <span className="badge b-look"><Icon name="question" small />Worth a look</span>
      : change.effect === "worse" ? <span className="badge b-muted">Changed</span>
        : <span className={`badge ${change.effect === "better" ? "b-ok" : "b-muted"}`}>{change.effect === "better" ? "Better" : "Changed"}</span>;
  return <li>
    {tag}
    <span>{describeChange(change, id => names[id])}
      {change.urgency === "urgent" && change.service_starts_at && <span className="small"> Service starts {time(change.service_starts_at)}.</span>}</span>
  </li>;
}

function Entry({ entry, names }: { entry: HistoryEntry; names: Names }) {
  const attention = entry.kind === "missed" || entry.kind === "failed" || entry.changes?.some(c => c.effect === "worse");
  let body: React.ReactNode;
  switch (entry.kind) {
    case "changes": body = <ul className="list">{entry.changes!.map(c => <ChangeLine key={c.id} change={c} names={names} />)}</ul>; break;
    case "first-check": body = <span>First check for {entry.plan_dates ?? "this Sunday"}. Later checks are compared with it.</span>; break;
    case "missed": body = <span>A scheduled check was missed at {time(entry.scheduled_for!)}. Ozzie was closed or this Mac was asleep.</span>; break;
    case "failed": body = <span>A check couldn't finish. {entry.problem}</span>; break;
    case "interrupted": body = <span>A check that started {time(entry.scheduled_for!)} stopped when Ozzie closed.</span>; break;
  }
  return <li className={attention ? "is-problem" : ""}>
    <span className="log-t">{time(entry.at)}</span>
    <div>{body}</div>
    <span className="small">{entry.notice ? notice[entry.notice] : ""}</span>
  </li>;
}

/** "What runs automatically": the recurring Sunday check, its limits, its controls and what it found. */
export function ProactivePage({ view, names, organization, planId, readiness, busy, now, churchTimeZone = null, onCheckNow, onPause, onResume, onPrefs, responsibilities = null }: {
  view: ProactiveView; names: Names; organization: string; planId: string; readiness: Readiness; busy: boolean; now: string;
  /** The church's IANA zone from the latest real check of this organization; null when no check has read it. */
  churchTimeZone?: string | null;
  onCheckNow: () => void; onPause: () => void; onResume: () => void; onPrefs: (p: ProactivePrefs) => void;
  /** What Ozzie keeps an eye on (responsibility-views ResponsibilityList), shown first. */
  responsibilities?: React.ReactNode;
}) {
  const { prefs, schedule } = view;
  const last = schedule.last_run;
  const latest = view.latest[`${organization}:${planId}`];
  const running = busy || view.running;
  const missed = view.history.find(e => e.kind === "missed");
  const recentMissed = missed && Date.parse(now) - Date.parse(missed.at) < RECENT_MS ? missed : null;
  const shown = view.history.slice(0, 6);
  const set = (patch: Partial<ProactivePrefs>) => onPrefs({ ...prefs, ...patch });
  const intervals = INTERVAL_CHOICES.includes(prefs.intervalMinutes) ? INTERVAL_CHOICES : [...INTERVAL_CHOICES, prefs.intervalMinutes].sort((a, b) => a - b);

  const state = schedule.paused ? <span className="badge b-muted">Paused</span>
    : readiness !== "ready" ? <span className="badge b-look">Waiting for setup</span>
      : schedule.failures > 0 ? <span className="badge b-attn">Couldn't finish last time</span>
        : <span className="badge b-ok"><Icon name="check" small />On schedule</span>;
  const ran = (r: NonNullable<typeof last>) => `${time(r.finished_at)}${why[r.trigger] ? `, ${why[r.trigger]}` : ""}`;
  const lastLine = !last ? "Not yet."
    : last.outcome === "failed" ? `${ran(last)}. Couldn't finish.`
      : last.outcome === "interrupted" ? `${time(last.finished_at)}. Stopped when Ozzie closed.`
        : `${ran(last)}. Finished.${latest && !latest.fully_read ? " Some coverage couldn't be verified." : ""}`;
  const nextLine = schedule.paused ? "Paused. Nothing runs automatically until you resume."
    : readiness === "not-configured" ? "After you choose which Sunday under Settings."
      : readiness === "not-connected" ? "After Planning Center is connected under Settings."
        : running ? "Checking now…"
          : schedule.next_run_at ? `${time(schedule.next_run_at)}${schedule.failures ? ", trying again after a problem" : ""}.` : "Not scheduled.";

  return <div className="col">
    <p className="eyebrow">What runs automatically</p>
    <h1 className="h1">What Ozzie does on its own</h1>
    <p className="lede">Ozzie keeps an eye on what you ask, even with its window closed, and tells you privately when something needs you. It only reads.</p>
    {responsibilities}
    <h2 className="h3">The regular Sunday check</h2>
    <p className="small">While Ozzie is running on this Mac, it checks Sunday coverage in Planning Center and tells you when something changes.</p>

    {recentMissed && <p className="panel-warn" role="status"><Icon name="clock" small />
      A scheduled check was missed at {time(recentMissed.scheduled_for!)}. Ozzie was closed or this Mac was asleep, so it checked again when it could.</p>}
    {last?.outcome === "failed" && !schedule.paused && <p className="panel-warn" role="status"><Icon name="info" small />
      The last check couldn't finish. {last.problem} {schedule.next_run_at ? `Ozzie will try again ${time(schedule.next_run_at)}.` : ""}</p>}
    {readiness !== "ready" && !schedule.paused && <p className="panel-info"><Icon name="info" small />
      {readiness === "not-configured" ? "Not running yet. Choose which Sunday to check under Settings." : "Not running yet. Connect Planning Center under Settings, then checks start on their own."}</p>}
    {schedule.held && <p className="panel-info"><Icon name="clock" small />A notice is waiting until quiet hours end at {clock(prefs.quietEnd)}. Everything it's about is listed below.</p>}

    <section className="find" aria-labelledby="job-title">
      <div className="find-top">{state}<span className="find-where">Planning Center Services</span></div>
      <h2 id="job-title" className="find-title">Check Sunday coverage in Planning Center</h2>
      <div className="sp">
        <div className="sp-row sp-2"><span className="sp-h">What it does</span><span>Reads open positions, who is scheduled and service times for the Sunday chosen in Settings, then compares them with the last check.</span></div>
        <div className="sp-row sp-2"><span className="sp-h">What it can do</span><span>Reads only. It never changes Planning Center or sends messages.</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Account</span><span>Planning Center organization {organization || "not set yet"}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">When</span><span>{prefs.runOnLaunch ? `When Ozzie opens, then ${every(prefs.intervalMinutes)}` : capital(every(prefs.intervalMinutes))} while Ozzie is running on this Mac, even with its window closed. Nothing runs after you quit it.</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Last check</span><span>{lastLine}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Next check</span><span>{nextLine}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Time zone</span><span>{zoneText(churchTimeZone)}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Telling you</span><span>When something gets worse, a private notice on this Mac: “Sunday coverage needs attention. Open Ozzie to see details.” It never includes names or details. Quiet hours {clock(prefs.quietStart)} to {clock(prefs.quietEnd)}: notices wait until they end{prefs.urgentDuringQuiet ? ", except urgent ones" : ""}.</span></div>
      </div>
      <div className="find-next">
        <button type="button" className="btn btn-primary" disabled={running || readiness === "not-configured"} onClick={onCheckNow}>
          {running ? <><Icon name="spinner" small spin />Checking Planning Center…</> : "Check now"}</button>
        {schedule.paused
          ? <button type="button" className="btn btn-secondary" onClick={onResume}>Resume automatic checks</button>
          : <button type="button" className="btn btn-secondary" onClick={onPause}>Pause automatic checks</button>}
      </div>
    </section>

    <section className="stack runs-list" aria-labelledby="changes-title">
      <h2 id="changes-title" className="h3">What changed recently</h2>
      {shown.length === 0 && <p className="small">Nothing yet. After the first check, Ozzie lists what changes from one check to the next.</p>}
      {shown.length > 0 && <ol className="log">{shown.map(e => <Entry key={`${e.at}:${e.kind}`} entry={e} names={names} />)}</ol>}
      <p className="small">Only changes are listed. A check that finds the same facts as the one before adds nothing here.</p>
    </section>

    <section className="find form runs-prefs" aria-labelledby="prefs-title">
      <h2 id="prefs-title" className="h3">Schedule and quiet hours</h2>
      <div className="row rule-row">
        <label htmlFor="interval">Check every</label>
        <select id="interval" className="input" value={prefs.intervalMinutes} onChange={e => set({ intervalMinutes: Number(e.target.value) })}>
          {intervals.map(m => <option key={m} value={m}>{m === 60 ? "1 hour" : every(m).replace(/^every /, "")}</option>)}
        </select>
      </div>
      <label className="confirmation"><input type="checkbox" checked={prefs.runOnLaunch} onChange={e => set({ runOnLaunch: e.target.checked })} /><span>Also check when Ozzie opens</span></label>
      <div className="row rule-row">
        <label htmlFor="quiet-start">Quiet hours start</label>
        <input id="quiet-start" type="time" value={prefs.quietStart} onChange={e => set({ quietStart: e.target.value })} />
      </div>
      <div className="row rule-row">
        <label htmlFor="quiet-end">Quiet hours end</label>
        <input id="quiet-end" type="time" value={prefs.quietEnd} onChange={e => set({ quietEnd: e.target.value })} />
      </div>
      <label className="confirmation"><input type="checkbox" checked={prefs.urgentDuringQuiet} onChange={e => set({ urgentDuringQuiet: e.target.checked })} /><span>Let urgent changes through during quiet hours</span></label>
      <p className="small">Off unless you turn it on. Changes always show here in Ozzie, quiet hours or not.</p>
      <div className="row rule-row">
        <label htmlFor="urgent-hours">Urgent within</label>
        <input id="urgent-hours" type="number" min={1} max={168} value={prefs.urgentWithinHours}
          onChange={e => set({ urgentWithinHours: Math.max(1, Math.min(168, Math.round(Number(e.target.value)) || 1)) })} />
        <span className="small">hours before the service (Church rule)</span>
      </div>
      <p className="small">Urgent means someone who had confirmed, or the Sunday lead, dropped out of a role that's now open, and the service starts within this many hours.</p>
    </section>
  </div>;
}
