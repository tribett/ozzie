import { useSyncExternalStore } from "react";
import { describeChange, type SundayChange } from "../../../core/src/sunday-changes.js";
import type { RunRecord, RunTrigger, StartedBy } from "../../../core/src/schedule.js";
import { LIVE_CHECK_VALID_MS } from "../../../core/src/sunday-capture.js";
import { INTERVAL_CHOICES, type HistoryEntry, type ProactiveController, type ProactivePrefs, type ProactiveView, type Readiness } from "./proactive.js";
import { Icon } from "./icons.js";
import { EYE_ABOUT, QUIT_LINE, WATCH_HOW } from "./responsibility-words.js";
import { useDay } from "./day-words.js";
import { eyeLine, keepTitle, noticeDayOf, noticeLine, SERVICES } from "./day-phrases.js";
import { BUILD_FORM, promise } from "./promises.js";
import { CHECK_REFUSED } from "./sunday-source.js";
import { CopyForAdministrator } from "./planning-center-forms.js";
import type { DayWords } from "../../../core/src/service-day.js";
import { useSystemWords } from "./church-system.js";

export const useProactiveView = <C,>(p: ProactiveController<C>) => useSyncExternalStore(p.subscribe, p.view, p.view);

type Names = Record<string, string>;
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(2000, 0, 1, h ?? 0, m ?? 0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};
const every = (minutes: number) => minutes === 60 ? "every hour" : minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`;
const capital = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
/**
 * "At least every hour, and when Ozzie opens. Nothing runs after you quit Ozzie." Shared with Settings and guided
 * setup. Closing the window doesn't stop Ozzie; it keeps running in the menu bar.
 */
export const scheduleLine = (prefs: ProactivePrefs) =>
  `At least ${every(prefs.intervalMinutes)}${prefs.runOnLaunch ? ", and when Ozzie opens" : ""}. Nothing runs after you quit Ozzie.`;
/** "9:00 PM to 7:00 AM. Notices wait until they end." */
export const quietLine = (prefs: ProactivePrefs) =>
  `${clock(prefs.quietStart)} to ${clock(prefs.quietEnd)}. Notices wait until they end${prefs.urgentDuringQuiet ? ", except urgent ones" : ""}.`;
const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const ZONE_LABELS = new Map<string, string>();
/**
 * "Central Time (Chicago)", "Eastern Time (New York)": the zone's everyday name where this Mac knows one, with its city as
 * the hint; else the city alone. One style everywhere a zone is shown (Keeping watch, jobs, the time zone question,
 * Settings); what is kept is always the IANA name.
 */
export function zoneLabel(zone: string): string {
  const kept = ZONE_LABELS.get(zone);
  if (kept !== undefined) return kept;
  // English like the rest of the app, whatever this Mac's language (review of round 3, L8).
  const name = (style: "longGeneric" | "long") => {
    try { return new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style }).formatToParts(new Date()).find(p => p.type === "timeZoneName")?.value; }
    catch { return undefined; }
  };
  const city = zone.split("/").at(-1)!.replace(/_/gu, " ");
  const long = name("longGeneric") ?? name("long");
  const label = long && long !== zone && !/^GMT[+-]/u.test(long) ? (long === city ? long : `${long} (${city})`) : city;
  // The time zone question lists every zone this Mac knows: each is worked out once.
  ZONE_LABELS.set(zone, label);
  return label;
}
/**
 * The church's own zone when a check read it from Planning Center (`source`: the church's system); otherwise this Mac's.
 * Times on this page and quiet hours follow this Mac's clock, so a church on a different zone says so.
 */
export function zoneText(churchTimeZone: string | null, mac = macZone(), source = "Planning Center"): string {
  if (!churchTimeZone) return `${zoneLabel(mac)}, this Mac's time. The church's own time zone shows here once a check reads it from ${source}.`;
  return churchTimeZone === mac ? `${zoneLabel(churchTimeZone)}, the church's time zone in ${source}. This Mac is on the same time.`
    : `${zoneLabel(churchTimeZone)}, the church's time zone in ${source}. Times on this page and quiet hours follow this Mac's clock: ${zoneLabel(mac)}.`;
}
/**
 * How the last check started, finishing "Last check Sat, Nov 21 at 12:14 PM, …". "manual" is every check outside the
 * schedule, not only Check now (proactive.ts checkNow), so it says who started it, as the task ledger does: a person
 * (Check now, a question in Ask, the first read after setup or after choosing a zone or service on B1 Church or Breeze)
 * or Ozzie itself (its re-read while its window is on screen, a job's check, the read after the watched plan moves on,
 * after Watch another service, or after it picks the only service by itself). Each is true paused or not (a job or a
 * plan moving on can still read while this is paused). A check kept before who started it was recorded says neither.
 */
const why: Record<RunTrigger, string> = {
  launch: "when Ozzie opened", scheduled: "on schedule", retry: "trying again after a problem", resume: "after checks were turned back on",
  "catch-up": "catching up after a missed check", manual: "an extra check",
};
const startedBy: Record<StartedBy, string> = { person: "started by you", ozzie: "an extra check by Ozzie" };
/** The words for how one check started. */
export const lastCheckWhy = (r: Pick<RunRecord, "trigger" | "by">): string => r.trigger === "manual" && r.by && Object.hasOwn(startedBy, r.by) ? startedBy[r.by] : why[r.trigger];
/** With its window on screen, Ozzie reads again once what it shows is this old (App's stale refresh, core LIVE_CHECK_VALID_MS). */
const FRESH_MINUTES = LIVE_CHECK_VALID_MS / 60_000;
const notice = (): Record<NonNullable<HistoryEntry["notice"]>, string | null> => ({
  sent: "Notice sent", held: "Notice waiting for quiet hours to end", "sent-later": "Notice sent after quiet hours",
  "in-app": "Seen in Ozzie", unavailable: "The Mac didn't show the notice", briefing: "Kept for your briefing, as your Church rules say",
  handed: `${keepTitle()} is checking this`, responsibility: `${keepTitle()} took care of the notice`, none: null,
});
const RECENT_MS = 24 * 3_600_000;

function ChangeLine({ change, names, d }: { change: SundayChange; names: Names; d: DayWords }) {
  const w = useSystemWords();
  const tag = change.urgency === "urgent" ? <span className="badge b-conflict"><Icon name="flag" small />Urgent</span>
    : change.kind === "coverage-unverified" ? <span className="badge b-look"><Icon name="question" small />Worth a look</span>
      : change.effect === "worse" ? <span className="badge b-muted">Changed</span>
        : <span className={`badge ${change.effect === "better" ? "b-ok" : "b-muted"}`}>{change.effect === "better" ? "Better" : "Changed"}</span>;
  return <li>
    {tag}
    <span>{describeChange(change, id => names[id], d, w.name)}
      {change.urgency === "urgent" && change.service_starts_at && <span className="small"> Service starts {time(change.service_starts_at)}.</span>}</span>
  </li>;
}

function Entry({ entry, names, d }: { entry: HistoryEntry; names: Names; d: DayWords }) {
  const attention = entry.kind === "missed" || entry.kind === "failed" || entry.changes?.some(c => c.effect === "worse");
  let body: React.ReactNode;
  switch (entry.kind) {
    case "changes": body = <ul className="list">{entry.changes!.map(c => <ChangeLine key={c.id} change={c} names={names} d={d} />)}</ul>; break;
    case "first-check": body = <span>First check for {entry.plan_dates ?? d.thisOne}. Later checks are compared with it.</span>; break;
    case "missed": body = <span>A scheduled check was missed at {time(entry.scheduled_for!)}. Ozzie was closed or this Mac was asleep.</span>; break;
    case "failed": body = <span>A check couldn't finish. {entry.problem}</span>; break;
    case "interrupted": body = <span>A check that started {time(entry.scheduled_for!)} stopped when Ozzie closed.</span>; break;
  }
  return <li className={attention ? "is-problem" : ""}>
    <span className="log-t">{time(entry.at)}</span>
    <div>{body}</div>
    <span className="small">{entry.notice ? notice()[entry.notice] : ""}</span>
  </li>;
}

/**
 * "Keeping watch" (spec §6): what is running first. Ozzie's steady look at the watched service (where it stands, then what
 * it does, its controls and what it found) beside Keep {day} covered as one item, then how it works in a fold, what
 * changed, and the schedule and quiet hours. What Ozzie changes (the build's promise) and "Nothing runs after you quit Ozzie or while this Mac is
 * asleep" are said outside any fold. Every sentence names the service by its real day (the day words, spec §5).
 */
export function ProactivePage({ view, names, organization, planId, readiness, shownReadiness = readiness, busy, now, churchTimeZone = null, church = null, onCheckNow, onPause,
  onResume, onPrefs, responsibilities = null, note = null, notReady = null, several = false }: {
  view: ProactiveView; names: Names; organization: string; planId: string; readiness: Readiness; busy: boolean; now: string;
  /**
   * What the page says about readiness: while a sign-in for a church already connected is in the browser, what was true
   * before it started (App's useHeldWhile), never "Waiting for setup" (review item 4). `readiness` itself still decides
   * what can be pressed.
   */
  shownReadiness?: Readiness;
  /** The church's name, when known: said instead of its organization number (spec §6). */
  church?: string | null;
  /** The church's IANA zone from the latest real check of this organization; null when no check has read it. */
  churchTimeZone?: string | null;
  onCheckNow: () => void; onPause: () => void; onResume: () => void; onPrefs: (p: ProactivePrefs) => void;
  /**
   * Keeping watch (responsibility-views ResponsibilityList), shown first. It is handed Ozzie's
   * steady look at Sunday to show first under the day's heading, above Keep Sunday covered.
   */
  responsibilities?: ((regular: React.ReactNode) => React.ReactNode) | null;
  /** Said under what Ozzie is watching when there are no jobs to list (a church on a system jobs don't read yet). */
  note?: string | null;
  /** Why checks don't run yet, when the three readiness words don't say it (a church system's zone or first run). */
  notReady?: string | null;
  /** More than one service is watched (owner decision 2026-11-19): each is read on every check. */
  several?: boolean;
}) {
  const { prefs, schedule } = view;
  const d = useDay();
  // The church's own system (Planning Center's words unchanged): a church on B1 Church or Breeze is kept watch over the same way.
  const w = useSystemWords();
  // Ozzie's hourly look is at "your services", whatever day they are on (owner decision 2026-11-19).
  const day = SERVICES;
  const last = schedule.last_run;
  const latest = view.latest[`${organization}:${planId}`];
  const running = busy || view.running;
  const missed = view.history.find(e => e.kind === "missed");
  const recentMissed = missed && Date.parse(now) - Date.parse(missed.at) < RECENT_MS ? missed : null;
  const shown = view.history.slice(0, 6);
  const set = (patch: Partial<ProactivePrefs>) => onPrefs({ ...prefs, ...patch });
  const intervals = INTERVAL_CHOICES.includes(prefs.intervalMinutes) ? INTERVAL_CHOICES : [...INTERVAL_CHOICES, prefs.intervalMinutes].sort((a, b) => a - b);

  const state = schedule.paused ? <span className="badge b-muted">Paused</span>
    : shownReadiness !== "ready" ? <span className="badge b-look">Waiting for setup</span>
      : schedule.failures > 0 ? <span className="badge b-attn">Couldn't finish last time</span>
        : <span className="badge b-ok"><Icon name="check" small />On schedule</span>;
  const ran = (r: NonNullable<typeof last>) => `${time(r.finished_at)}${lastCheckWhy(r) ? `, ${lastCheckWhy(r)}` : ""}`;
  const lastLine = !last ? "Not yet."
    : last.outcome === "failed" ? `${ran(last)}. Couldn't finish.`
      : last.outcome === "interrupted" ? `${time(last.finished_at)}. Stopped when Ozzie closed.`
        : `${ran(last)}. Finished.${latest && !latest.fully_read ? " Some coverage couldn't be verified." : ""}`;
  const nextLine = schedule.paused ? `Paused. Ozzie doesn't look at ${day} until you resume.`
    : notReady && shownReadiness !== "ready" ? notReady
    : shownReadiness === "not-configured" ? "After you choose which service Ozzie watches under Settings."
      : shownReadiness === "not-connected" ? `After ${w.name} is connected under Settings.`
        : running ? "Checking now…"
          : schedule.next_run_at ? `${time(schedule.next_run_at)}${schedule.failures ? ", trying again after a problem" : ""}.` : "Not scheduled.";

  // Its card title sits under the day's heading inside the list, or straight under the section's: a level below it either way.
  const Title = responsibilities ? "h4" : "h3";
  // At least this often (Today's words): with the window on screen, Ozzie also reads again once what it shows is out of date.
  const often = `at least ${every(prefs.intervalMinutes)}`;
  const howOften = `${prefs.runOnLaunch ? `When Ozzie opens, then ${often}` : capital(often)} while it is running, even with its window closed.${
    prefs.intervalMinutes > FRESH_MINUTES ? ` While its window is on screen, about ${every(FRESH_MINUTES)}.` : ""}`;
  const regular = <>
    {recentMissed && <p className="panel-warn" role="status"><Icon name="clock" small />
      A scheduled check was missed at {time(recentMissed.scheduled_for!)}. Ozzie was closed or this Mac was asleep, so it checked again when it could.</p>}
    {last?.outcome === "failed" && !schedule.paused && <p className="panel-warn" role="status"><Icon name="info" small />
      The last check couldn't finish. {last.problem} {schedule.next_run_at ? `Ozzie will try again ${time(schedule.next_run_at)}.` : ""}</p>}
    {last?.outcome === "failed" && !schedule.paused && last.problem === CHECK_REFUSED && <CopyForAdministrator />}
    {shownReadiness !== "ready" && !schedule.paused && <p className="panel-info"><Icon name="info" small />
      {notReady ? `Not running yet. ${notReady}` : shownReadiness === "not-configured" ? "Not running yet. Choose which service Ozzie watches under Settings." : `Not running yet. ${w.connect} under Settings, then checks start on their own.`}</p>}
    {schedule.held && <p className="panel-info"><Icon name="clock" small />A notice is waiting until quiet hours end at {clock(prefs.quietEnd)}. Everything it's about is listed below.</p>}

    <section className="find" aria-labelledby="job-title">
      {/* The church by its name, as a job's card says it (spec §6); never its organization number. */}
      <div className="find-top">{state}<span className="find-where">{!organization ? `${w.services}, not connected yet`
        : church ? `${w.services}, ${church}` : w.services}</span></div>
      <Title id="job-title" className="find-title">{eyeLine()}</Title>
      <p className="find-body">{EYE_ABOUT}</p>
      {/* Where it stands first, then what it does. The time zone is said under Schedule and quiet hours. */}
      <div className="sp">
        <div className="sp-row sp-2"><span className="sp-h">Last check</span><span>{lastLine}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Next check</span><span>{nextLine}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">What it does</span><span>Reads open roles, who is scheduled and service times for {several ? "each service" : "the service"} Ozzie watches, then compares them with the last check.</span></div>
        <div className="sp-row sp-2"><span className="sp-h">What it can do</span><span>{promise("readsShort", "A")} It never sends messages.</span></div>
        <div className="sp-row sp-2"><span className="sp-h">How often</span><span>{howOften}</span></div>
        <div className="sp-row sp-2"><span className="sp-h">Telling you</span><span>When something gets worse, a private notice on this Mac{several ? ", such as" : ":"} “{noticeLine(noticeDayOf(d))}” It never includes names or details. Quiet hours {clock(prefs.quietStart)} to {clock(prefs.quietEnd)}: notices wait until they end{prefs.urgentDuringQuiet ? ", except urgent ones" : ""}.</span></div>
      </div>
      <div className="find-next">
        <button type="button" className="btn btn-primary" disabled={running || readiness === "not-configured"} onClick={onCheckNow}>
          {running ? <><Icon name="spinner" small spin />{w.checking}</> : "Check now"}</button>
        {schedule.paused
          ? <button type="button" className="btn btn-secondary" onClick={onResume}>Resume keeping an eye on {day}</button>
          : <button type="button" className="btn btn-secondary" onClick={onPause}>Pause keeping an eye on {day}</button>}
      </div>
    </section>
  </>;

  return <div className="col">
    <p className="eyebrow">Keeping watch</p>
    <h1 className="h1">What Ozzie does on its own</h1>
    {/* Planning Center's line is the build's form; another system only reads (form A). */}
    <p className="lede">Ozzie checks {w.name} for you and tells you privately when something needs you. {promise("connectAnd", w.system === "planning-center" ? BUILD_FORM : "A")}</p>
    {/* Without the list (it is always there in the app): the same order, what is running before how it works. */}
    {responsibilities ? responsibilities(regular) : <section className="stack" aria-labelledby="watching-title">
      <h2 id="watching-title" className="h3">What Ozzie is watching</h2>
      <p className="small">{QUIT_LINE}</p>
      {regular}
      {note && <p className="small">{note}</p>}
      <details className="listen-more watch-how"><summary><Icon name="chev" small />See how this works</summary>
        <ul className="small">{WATCH_HOW.map(line => <li key={line}>{line}</li>)}</ul>
      </details>
    </section>}

    <section className="stack runs-list" aria-labelledby="changes-title">
      <h2 id="changes-title" className="h3">What changed recently</h2>
      {shown.length === 0 && <p className="small">Nothing yet. After the first check, Ozzie lists what changes from one check to the next.</p>}
      {shown.length > 0 && <>
        <ol className="log">{shown.map(e => <Entry key={`${e.at}:${e.kind}`} entry={e} names={names} d={d} />)}</ol>
        <p className="small">Only changes are listed. A check that finds the same facts as the one before adds nothing here.</p>
      </>}
    </section>

    <section className="find form runs-prefs" aria-labelledby="prefs-title">
      <h2 id="prefs-title" className="h3">Schedule and quiet hours</h2>
      <div className="row rule-row">
        <label htmlFor="interval">Look at {day} at least every</label>
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
      <p className="small">Time zone: {zoneText(churchTimeZone, macZone(), w.name)}</p>
      <label className="confirmation"><input type="checkbox" checked={prefs.urgentDuringQuiet} onChange={e => set({ urgentDuringQuiet: e.target.checked })} /><span>Let urgent changes through during quiet hours</span></label>
      <p className="small">Off unless you turn it on. Changes always show here in Ozzie, quiet hours or not.</p>
      <div className="row rule-row">
        <label htmlFor="urgent-hours">Urgent within</label>
        <input id="urgent-hours" type="number" min={1} max={168} value={prefs.urgentWithinHours}
          onChange={e => set({ urgentWithinHours: Math.max(1, Math.min(168, Math.round(Number(e.target.value)) || 1)) })} />
        <span className="small">hours before the service (Church rule)</span>
      </div>
      <p className="small">Urgent means someone who had confirmed, or the scheduled lead, dropped out of a role that's now open, and the service starts within this many hours.</p>
    </section>
  </div>;
}
