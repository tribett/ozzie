// A church whose main system is Genesis (round 5, owner decision 2026-11-19): honest and still useful. Genesis shares
// no volunteer schedules, so Ozzie never checks or claims a covered service here; it shows what Genesis does share
// (the next four weeks of events, how many attended the ones just past, how many times each form was filled in, the
// groups), says "worth a look" only for a form filled in more times than at the last check, reads Genesis on opening
// and on the person's interval while Ozzie is open, and answers Ask from what it read, on this Mac. Genesis gives no
// one's name; the church's own words for events, forms and groups stay on this Mac. Read-only, like every system.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fictionalGenesis } from "../../../core/src/church-systems/fictional.js";
import {
  GENESIS_NO_SCHEDULES, genesisLabel, genesisSummary, genesisView, newSubmissionLine, type FormCounts, type GenesisView,
} from "../../../core/src/church-systems/genesis-view.js";
import { labelsOf } from "../../../core/src/church-systems/placeholders.js";
import { instant, parseSystemCaptureText, type SystemCapture } from "../../../core/src/church-systems/types.js";
import {
  churchSystems, eventWhen, formatAt, readProblemText, type AlsoRead, type ChurchSystemState, type Connected,
} from "./church-system.js";
import { StepHead, useTitleFocus } from "./first-run-screens.js";
import { Icon } from "./icons.js";
import { SystemReadFailure } from "./proactive.js";
import { outcomeOf } from "./system-church.js";
import { SystemFactsList } from "./system-settings.js";
import { SystemConnect, TimeZoneQuestion } from "./system-setup.js";
import { zoneLabel } from "./proactive-page.js";
import { keepTitle, OPEN_SERVICES } from "./day-phrases.js";
import { SERVICES_PAGE } from "../../../core/src/service-day.js";
import type { AskTurn } from "./harness-bridge.js";
import type { CheckTrigger } from "./harness-words.js";

type Store = Pick<Storage, "getItem" | "setItem">;
const COUNTS_KEY = "ozzie.genesis.form-counts.v1";
/** The form counts kept from this church's last check: ids and numbers only, never what was filled in. */
export function keptCounts(store: Store | null, church: string): FormCounts | null {
  try {
    const v = JSON.parse(store?.getItem(COUNTS_KEY) ?? "null") as { church?: unknown; counts?: unknown } | null;
    if (!v || v.church !== church || !v.counts || typeof v.counts !== "object") return null;
    return Object.fromEntries(Object.entries(v.counts as Record<string, unknown>)
      .filter((e): e is [string, number] => /^[A-Za-z0-9_-]{1,64}$/u.test(e[0]) && Number.isSafeInteger(e[1]) && (e[1] as number) >= 0));
  } catch { return null; }
}
function keepCounts(store: Store | null, church: string, counts: FormCounts): void {
  try { store?.setItem(COUNTS_KEY, JSON.stringify({ church, counts })); } catch { /* a per-device convenience only */ }
}
const browser = (): Store | null => { try { return localStorage; } catch { return null; } };

/** One read of Genesis: native's outcome word, and what it read when it worked. */
export interface GenesisRead { outcome: string; capture: SystemCapture | null; view: GenesisView | null }
export interface GenesisChurch {
  /** Genesis as kept on this Mac (the AlsoRead record), when it is the main system. */
  connection: AlsoRead | null;
  capture: SystemCapture | null;
  view: GenesisView | null;
  busy: boolean;
  problem: string;
  /** Reads Genesis now (recorded for What happened). */
  read: (trigger?: CheckTrigger, at?: AlsoRead) => Promise<GenesisRead>;
  /** The last read that ended, and whether it worked (Today's line: never a failure beside an earlier success's time). */
  last: { at: string; ok: boolean } | null;
}
type Bridge = Pick<typeof churchSystems, "check">;
/** "every hour", "every 2 hours", "every 30 minutes": the person's interval, as Keeping watch says it. */
export const everyWords = (minutes: number) => minutes === 60 ? "every hour" : minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`;
/**
 * Genesis as the main system: one read on opening and one every `intervalMinutes` while Ozzie is open (none while
 * everything is paused), each recorded by `record` (What happened) and compared with the form counts kept from the last.
 * First run reads through `read` too, so its read is recorded once and not repeated. A successful read marks the result
 * seen (`onSeen`). Nothing read for one church or zone stays on screen for another (review of e9cbd97d, M4, M6, L7).
 */
export function useGenesisChurch(o: { state: ChurchSystemState; on: boolean; intervalMinutes: number; paused?: boolean; now: () => string;
  record?: (work: () => Promise<SystemCapture>, trigger: CheckTrigger) => Promise<SystemCapture>; onSeen?: (church: string) => void;
  bridge?: Bridge; store?: Store | null }): GenesisChurch {
  const a = o.on ? o.state.genesis : null;
  const opts = useRef(o);
  opts.current = o;
  const store = o.store === undefined ? browser() : o.store;
  const [capture, setCapture] = useState<SystemCapture | null>(null);
  const [view, setView] = useState<GenesisView | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [last, setLast] = useState<{ at: string; ok: boolean } | null>(null);
  const latest = useRef(a);
  latest.current = a;
  // The last read that landed, so first run's read isn't made again as soon as its result is seen.
  const lastRead = useRef<{ church: string; zone: string; at: number } | null>(null);
  const running = useRef(0);
  // The church and zone a read may land for: the latest asked for, or kept (a read started before the page has drawn a
  // zone just given still lands; one for a zone changed since, or a church let go, doesn't).
  const wanted = useRef<{ church: string; zone: string } | null>(a?.zone ? { church: a.church_id, zone: a.zone } : null);
  useEffect(() => { wanted.current = a?.zone ? { church: a.church_id, zone: a.zone } : null; }, [a?.church_id, a?.zone]);
  // Disconnected, or another church: nothing of the last one stays on Today, its page or Ask.
  useEffect(() => { setCapture(null); setView(null); setProblem(""); setLast(null); lastRead.current = null; }, [a?.church_id]);
  const read = useCallback(async (trigger: CheckTrigger = "manual", at: AlsoRead | undefined = latest.current ?? undefined): Promise<GenesisRead> => {
    const none = (outcome: string): GenesisRead => ({ outcome, capture: null, view: null });
    if (!at?.zone) return none("bad-zone");
    const zone = at.zone;
    // Only for the church and zone kept now: a switch, a disconnect or a zone change may come while a read is out.
    wanted.current = { church: at.church_id, zone };
    const current = () => wanted.current?.church === at.church_id && wanted.current.zone === zone;
    running.current += 1;
    setBusy(true); setProblem("");
    try {
      const bridge = opts.current.bridge ?? churchSystems;
      const work = async () => {
        const r = await bridge.check("genesis", at.church_id, null, zone);
        const parsed = r.capture ? parseSystemCaptureText(r.capture) : null;
        if (r.outcome === "ok" && parsed?.ok && parsed.capture.system === "genesis") return parsed.capture;
        throw new SystemReadFailure("genesis", r.outcome === "ok" ? "invalid-response" : r.outcome, at.church_id);
      };
      const record = opts.current.record;
      const c = record ? await record(work, trigger) : await work();
      if (!current()) return none("busy");
      const v = genesisView(c, zone, opts.current.now(), keptCounts(store, at.church_id));
      keepCounts(store, at.church_id, v.counts);
      setCapture(c); setView(v); setLast({ at: c.completed_at, ok: true });
      lastRead.current = { church: at.church_id, zone, at: Date.now() };
      if (!latest.current?.result_seen) opts.current.onSeen?.(at.church_id);
      return { outcome: "ok", capture: c, view: v };
    } catch (error) {
      const word = outcomeOf(error);
      if (current()) { setProblem(readProblemText("genesis", word) ?? readProblemText("genesis", "unavailable") ?? ""); setLast({ at: opts.current.now(), ok: false }); }
      return none(word);
    } finally {
      running.current -= 1;
      setBusy(running.current > 0);
    }
  }, [store]);
  // On opening, and on the interval, once a first result was seen (first run reads it itself).
  useEffect(() => {
    if (!a?.zone || !a.result_seen) return;
    const last = lastRead.current;
    const fresh = last !== null && last.church === a.church_id && last.zone === a.zone && Date.now() - last.at < 5 * 60_000;
    if (!fresh && !opts.current.paused) void read("automatic", a);
    const t = setInterval(() => { if (latest.current && !opts.current.paused) void read("automatic", latest.current); }, Math.max(15, o.intervalMinutes) * 60_000);
    return () => clearInterval(t);
  }, [a?.church_id, a?.zone, a?.result_seen, o.intervalMinutes]);
  return { connection: a, capture, view, busy, problem, read, last };
}

/** The fictional Genesis church (core fictional.ts), as of its own check, never going out of date. */
export function genesisExample(): { capture: SystemCapture; view: GenesisView } {
  const capture = fictionalGenesis();
  return { capture, view: genesisView(capture, capture.church.time_zone, capture.completed_at, { "GF-prayer": 5, "GF-serve": 3 }) };
}

/**
 * First run for a church on Genesis: connect (its key, never an address), the church's time zone (Genesis gives none),
 * then the first read and its result.
 */
export function GenesisFirstRun({ state, onState, onLeave, onChooseAgain, onExample, aiOffered, renderAi, nowMs, connect, read: readGenesis, intervalMinutes = 60, shown = null }: {
  state: ChurchSystemState; onState: (next: ChurchSystemState) => void; onLeave: (to: "today" | "sunday") => void; onChooseAgain: () => void;
  onExample?: (() => void) | undefined; aiOffered: boolean; renderAi?: ((done: () => void) => ReactNode) | undefined; nowMs: number;
  connect?: (address: string | null, how: "paste" | "enter") => Promise<Connected>;
  /** The read Genesis's own schedule makes (useGenesisChurch `read`): recorded for What happened, and not made again. */
  read: (at: AlsoRead) => Promise<GenesisRead>;
  intervalMinutes?: number;
  /**
   * What Genesis's own schedule read, with its problem and whether it is reading: a church whose result was seen before
   * (a switch back to Genesis) is shown that read, never a second one started here (review of 4c3d32ac, M-d).
   */
  shown?: { capture: SystemCapture | null; view: GenesisView | null; busy: boolean; problem: string } | null;
}) {
  const a = state.genesis;
  const [at, setAt] = useState<"steps" | "ai">("steps");
  const [phase, setPhase] = useState<{ at: "idle" } | { at: "reading"; started: number } | { at: "problem"; text: string } | { at: "result"; view: GenesisView; capture: SystemCapture }>({ at: "idle" });
  const title = useTitleFocus<HTMLHeadingElement>(`${a ? "a" : "-"}${a?.zone ? "z" : "-"}${phase.at}`);
  const read = (next: AlsoRead) => {
    setPhase({ at: "reading", started: Date.now() });
    void readGenesis(next).then(r => {
      if (r.outcome === "ok" && r.capture && r.view) setPhase({ at: "result", view: r.view, capture: r.capture });
      else setPhase({ at: "problem", text: readProblemText("genesis", r.outcome) ?? readProblemText("genesis", "unavailable") ?? "" });
    }, () => setPhase({ at: "problem", text: readProblemText("genesis", "unavailable") ?? "" }));
  };
  // A key kept with a zone already given (first run reopened): read at once, unless its result was seen before, when
  // Genesis's own schedule reads it on opening and that read is shown here.
  useEffect(() => { if (a?.zone && !a.result_seen && phase.at === "idle") read(a); }, [a?.church_id, a?.zone]);
  // What is on screen: this screen's own read, or (result seen before) the read Genesis's schedule made.
  const scheduled = phase.at === "idle" && Boolean(a?.zone && a.result_seen) && shown ? shown : null;
  const shownPhase: typeof phase | { at: "reading"; started: number } = scheduled
    ? scheduled.capture && scheduled.view ? { at: "result", view: scheduled.view, capture: scheduled.capture }
      : scheduled.problem ? { at: "problem", text: scheduled.problem } : { at: "reading", started: nowMs }
    : phase;
  if (at === "ai" && renderAi) return <>{renderAi(() => onLeave("sunday"))}</>;
  if (!a) return <SystemConnect system="genesis" step="Step 1 of 2" connect={connect ?? ((address, how) => churchSystems.connect("genesis", address, how))}
    onConnected={church => onState({ ...state, genesis: { system: "genesis", church_id: church.id, church_name: church.name, zone: null } })}
    onBack={onChooseAgain} backLabel="Use a different system" notNow={() => onLeave("today")} onExample={onExample} />;
  const finish = (to: "ai" | "sunday") => { onState({ ...state, genesis: { ...a, result_seen: true } }); if (to === "ai" && renderAi) setAt("ai"); else onLeave("sunday"); };
  const elapsed = shownPhase.at === "reading" ? Math.max(0, Math.floor((nowMs - shownPhase.started) / 1000)) : 0;
  return <section className="fr" aria-labelledby="fr-title">
    <StepHead step="Step 2 of 2" titleRef={title}>{a.zone ? "What Ozzie read from Genesis" : "Which time zone does your church meet in?"}</StepHead>
    {!a.zone && <>
      <p className="fr-note">Genesis gives its event times without a time zone, so Ozzie asks once and uses yours for every check.</p>
      <TimeZoneQuestion system="genesis" systemZone={null} startsAt={null} onConfirm={zone => { const next = { ...a, zone }; onState({ ...state, genesis: next }); read(next); }} />
    </>}
    {shownPhase.at === "reading" && <p className="fr-note" role="status" aria-live="polite"><Icon name="spinner" small spin /> Reading Genesis… {elapsed >= 5 ? `${elapsed} seconds so far.` : "This can take a minute."}</p>}
    {shownPhase.at === "problem" && <div className="fr-failure" role="alert"><p>{shownPhase.text}</p>
      <div className="fr-row"><button type="button" className="btn btn-primary" onClick={() => read(a)}>Try again</button>
        <button type="button" className="fr-link" onClick={() => onLeave("today")}>Not now</button></div></div>}
    {shownPhase.at === "result" && <div className="fr-result" aria-live="polite">
      <p className="fr-answer">{genesisSummary(shownPhase.view).replace(/^./u, c => c.toUpperCase())}.</p>
      <p className="fr-note">{GENESIS_NO_SCHEDULES} It shows what Genesis does share, and tells you when a form has been filled in again.</p>
      <p className="fr-note">Ozzie reads Genesis when it opens and at least {everyWords(intervalMinutes)} while it's open. Nothing in Genesis changes.</p>
      <div className="fr-actions"><button type="button" className="btn btn-primary fr-primary" onClick={() => finish(aiOffered ? "sunday" : "ai")}>
        {aiOffered ? OPEN_SERVICES : "Next: choose how Ozzie uses AI"}</button></div>
    </div>}
  </section>;
}

const when = (capture: SystemCapture, iso: string) => eventWhen("genesis", iso, capture.church.time_zone) ?? "a time Ozzie couldn't read";

/**
 * The service's page for a church on Genesis: what Genesis shares, never a covered service. "Worth a look" only for a
 * form filled in more times than at the last check.
 */
export function GenesisPage({ capture, view, busy, problem, onCheck, fictional = false, connected = true, onSetUp }: {
  capture: SystemCapture | null; view: GenesisView | null; busy: boolean; problem: string; onCheck: () => void; fictional?: boolean;
  connected?: boolean; onSetUp?: () => void;
}) {
  const labels = useMemo(() => capture ? labelsOf(capture) : {}, [capture]);
  const checked = capture ? formatAt(capture.completed_at, { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;
  return <div className="col">
    {/* The Services page, as for every church (owner decision 2026-11-19), with Genesis's own events: no coverage check. */}
    <p className="eyebrow">Genesis{capture && labels.church ? ` · ${labels.church}` : ""}</p>
    <h1 className="h1">{SERVICES_PAGE}</h1>
    <p className="lede">{view ? `${genesisSummary(view).replace(/^./u, c => c.toUpperCase())}.` : "Genesis hasn't been read yet."} {GENESIS_NO_SCHEDULES}</p>
    {capture && <p className="checkline evidence"><Icon name="check" small />{fictional ? "Fictional example data" : "Live read from Genesis"}{checked ? ` · ${checked}` : ""}</p>}
    <div className="row">
      <button type="button" className="btn btn-primary" disabled={busy || fictional || !connected} onClick={onCheck}>{busy ? <><Icon name="spinner" small spin />Checking Genesis…</> : "Check Genesis now"}</button>
      {!connected && onSetUp && <button type="button" className="btn btn-quiet" onClick={onSetUp}>Connect Genesis</button>}
    </div>
    {problem && <p role="alert" className="problem">{problem}</p>}
    {view && view.newSubmissions.length > 0 && <section className="stack" aria-label="Worth a look">
      {view.newSubmissions.map(n => <article key={n.form_id} className="find">
        <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span><span className="find-where">Genesis</span></div>
        <h2 className="find-title">{newSubmissionLine(n, labels)}</h2>
        <p className="find-body">Ozzie counts entries only; what was filled in stays in Genesis.</p>
      </article>)}
    </section>}
    {view && <section className="find" aria-labelledby="genesis-coming">
      <h2 id="genesis-coming" className="h3">Coming up in Genesis</h2>
      {view.upcoming.length === 0 ? <p className="find-body">Genesis lists no events in the next four weeks.</p>
        : <ul className="list">{view.upcoming.slice(0, 8).map(e => <li key={e.event_id}>{genesisLabel(capture!, `event:${e.event_id}`, "An event without a name")}, {when(capture!, e.starts_at)}</li>)}</ul>}
      {view.upcoming.length > 8 && <p className="small">And {view.upcoming.length - 8} more, listed below.</p>}
    </section>}
    {view && view.recent.some(e => e.attendance !== null) && <section className="find" aria-labelledby="genesis-recent">
      <h2 id="genesis-recent" className="h3">Just past</h2>
      <ul className="list">{view.recent.filter(e => e.attendance !== null).map(e => <li key={e.event_id}>
        {genesisLabel(capture!, `event:${e.event_id}`, "An event without a name")}, {when(capture!, e.starts_at)}: {e.attendance} attended.</li>)}</ul>
    </section>}
    {capture && <section className="stack" aria-labelledby="genesis-shares"><h2 id="genesis-shares" className="h3">What Genesis shares</h2>
      <SystemFactsList capture={capture} zone={capture.church.time_zone} folded={false} /></section>}
  </div>;
}

/** Today for a church on Genesis: what changed (a form filled in again) needs a look; otherwise one calm line. */
export function GenesisToday({ capture, view, onOpen, problem = "" }: { capture: SystemCapture | null; view: GenesisView | null; onOpen: () => void; problem?: string }) {
  // Nothing read: why, when the last read couldn't finish (a key refused, say), in its own words.
  if (!capture || !view) return <p className="today-calm"><Icon name="sun" small /><span>{problem || "Genesis hasn't been read yet."} {GENESIS_NO_SCHEDULES}</span></p>;
  const labels = labelsOf(capture);
  const next = view.upcoming[0];
  return <>
    {view.newSubmissions.length > 0 && <article className="find" aria-labelledby="genesis-today-title">
      <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span><span className="find-where">Genesis</span></div>
      <h3 id="genesis-today-title" className="find-title">{view.newSubmissions.length === 1 ? "A form was filled in again." : `${view.newSubmissions.length} forms were filled in again.`}</h3>
      <ul className="list">{view.newSubmissions.map(n => <li key={n.form_id}>{newSubmissionLine(n, labels)}</li>)}</ul>
      <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onOpen}>{OPEN_SERVICES}</button></div>
    </article>}
    <p className="today-calm"><Icon name="sun" small /><span>From Genesis: {genesisSummary(view)}.{next ? ` Next: ${genesisLabel(capture, `event:${next.event_id}`, "an event")}, ${when(capture, next.starts_at)}.` : ""} {GENESIS_NO_SCHEDULES}</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onOpen}>{OPEN_SERVICES}</button></p>
  </>;
}

/** Keeping watch for a church on Genesis: what runs, and what isn't available there. */
export function GenesisWatch({ intervalMinutes, capture, problem, paused = false, onPause, onResume }: { intervalMinutes: number; capture: SystemCapture | null; problem: string; paused?: boolean;
  onPause?: () => void; onResume?: () => void }) {
  const every = everyWords(intervalMinutes);
  const last = capture ? formatAt(capture.completed_at, { weekday: "short", hour: "numeric", minute: "2-digit" }) : null;
  return <div className="col">
    <p className="eyebrow">Keeping watch</p>
    <h1 className="h1">What Ozzie keeps an eye on</h1>
    <section className="find" aria-labelledby="genesis-watch">
      <h2 id="genesis-watch" className="h3">Genesis</h2>
      <p className="find-body">Ozzie reads Genesis when it opens and at least {every} while it's open, and says on Today when a form has been filled in again.{last ? ` Last read ${last}.` : ""}{paused ? " Paused: nothing is read on its own until you resume it." : ""}</p>
      {problem && <p className="problem" role="alert">{problem}</p>}
      {/* Its own pause, so a pause kept from before a switch can always be lifted here (review of 4c3d32ac, M-e). */}
      {(paused ? onResume : onPause) && <div className="row form-actions"><button type="button" className="btn btn-secondary" onClick={paused ? onResume : onPause}>
        {paused ? "Resume reading Genesis" : "Pause reading Genesis"}</button></div>}
      <p className="small">{GENESIS_NO_SCHEDULES} {keepTitle()} and the morning briefing work with Planning Center only for now, and private notices with Planning Center, B1 Church and Breeze.</p>
    </section>
  </div>;
}

/** Folded for matching: lower case, curly quotes made straight, runs of space made one. */
const fold = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\u2018\u2019]/gu, "'").replace(/\s+/gu, " ").trim();
/** Whole words or phrases only: "who" never inside "whole", "come" never inside "comes up". */
const WORDS = (alternatives: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, "u");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** Who is serving, scheduled or covering, and whether a service is covered: what Genesis doesn't share. */
const SCHEDULE = WORDS("covered|coverage|cover|covering|declined?|volunteers|roles?|positions?|rota|staffed|short-?handed|schedules?|scheduled");
const WHO_SERVING = WORDS("serve|serving|volunteering|volunteer|helping|on (?:the )?team");
const WHO = WORDS("who|who's|whom");
const CHANGED = WORDS("changed?|new|since|lately|recently|anything new");
const GROUPS = WORDS("groups?|members?|small groups?");
const FORMS = WORDS("forms?|filled(?: in| out)?|sign-?ups?|submissions?|entries|entry|responses?|cards?");
const ATTENDANCE = WORDS("attend|attended|attendance|came|turn ?out|turned out|showed up|were there|how many people came");
const EVENTS = WORDS("events?|services?|coming up|upcoming|next|this week|next week|calendar|happening|on the calendar|what time|when is|when's");
const ANYONE = WORDS("anyone|anybody|someone|enough|people");

/** The suggested questions on Genesis, each answered here from what was read. */
export function genesisQuestions(view: GenesisView | null): string[] {
  if (!view) return [];
  return ["What events are coming up?", "How many times was each form filled in?",
    ...(view.recent.some(e => e.attendance !== null) ? ["How many came to the events just past?"] : []), "What groups do we have?", "What changed since the last check?"];
}

/**
 * Ask for a church on Genesis, answered on this Mac from what Ozzie read (nothing goes to an AI; Genesis gives no one's
 * name): a form, group or event the question names first, by the church's own name; the events coming up, attendance
 * for events that have ended, the forms and the groups; and, for anything about who is serving or whether a service is
 * covered, plainly that Genesis doesn't share it (review of e9cbd97d, M2: whole words, names first, narrow refusal).
 */
export function genesisAnswer(typed: string, capture: SystemCapture | null, view: GenesisView | null, fictional = false): AskTurn {
  const text = fold(typed);
  const based = capture ? `Based on: ${fictional ? "fictional example data" : "Genesis"}, read ${formatAt(capture.completed_at, { weekday: "short", hour: "numeric", minute: "2-digit" }) ?? "earlier"}` : "Based on: nothing read yet";
  const answer = (paragraphs: string[]): AskTurn => ({ state: "answered", answer: {
    body: paragraphs.filter(Boolean).join("\n\n"), draft: null, notCovered: false, basedOn: based, gaps: [], procedure: null, steps: [], aiSteps: 0, page: "sunday", local: true,
  } });
  const CAN = "With Genesis, Ozzie can tell you the events coming up, how many attended the ones that have ended, how many times each form was filled in, and your groups.";
  const NO_NAMES = "Genesis gives counts, not names: Ozzie reads no one's name from Genesis.";
  if (!capture || !view) return answer(["Ozzie hasn't read Genesis yet, so it can't answer that. Check Genesis on its page first.", CAN]);
  const label = (key: string, fallback: string) => genesisLabel(capture, key, fallback);
  const who = WHO.test(text);
  // The church's own names are taken out first, so "Who filled in the Serve Sign-up?" isn't read as about serving.
  const ownNames = [...view.facts.forms.map(f => `form:${f.form_id}`), ...view.facts.groups.map(g => `group:${g.group_id}`), ...view.facts.events.map(e => `event:${e.event_id}`)]
    .map(key => fold(label(key, ""))).filter(name => name.length > 1).sort((x, y) => y.length - x.length);
  const rest = ownNames.reduce((t, name) => t.replace(new RegExp(WORDS(escape(name)).source, "gu"), " "), text);
  // Who is serving, or whether something is covered: Genesis doesn't share it. "Who came" is attendance, not this.
  if (SCHEDULE.test(rest) || ((who || ANYONE.test(rest)) && WHO_SERVING.test(rest))) return answer([GENESIS_NO_SCHEDULES, CAN]);
  const formLine = (f: GenesisView["facts"]["forms"][number]) => `${label(`form:${f.form_id}`, "A form without a name")}: ${f.submissions === null
    ? "not counted this time" : `filled in ${f.at_least ? "at least " : ""}${f.submissions} ${f.submissions === 1 ? "time" : "times"}`}.`;
  const groupLine = (g: GenesisView["facts"]["groups"][number]) => `${label(`group:${g.group_id}`, "A group without a name")}${g.members !== null ? `: ${g.members} ${g.members === 1 ? "member" : "members"}` : ""}`;
  const eventLine = (e: GenesisView["facts"]["events"][number]) => `${label(`event:${e.event_id}`, "An event without a name")}, ${when(capture, e.starts_at)}${e.attendance !== null ? `: ${e.attendance} attended` : ""}.`;
  const groupsShareNoCount = view.facts.groups.some(g => g.members === null) ? "Genesis doesn't share how many people are in each group." : "";
  // A form, group or event the question names, by the church's own name (the longest that matches).
  const named = <T,>(items: readonly T[], key: (item: T) => string) => items
    .map(item => ({ item, name: fold(label(key(item), "")) })).filter(x => x.name.length > 1 && WORDS(escape(x.name)).test(text))
    .sort((a, b) => b.name.length - a.name.length).map(x => x.item);
  const forms = named(view.facts.forms, f => `form:${f.form_id}`), groups = named(view.facts.groups, g => `group:${g.group_id}`);
  const events = named(view.facts.events, e => `event:${e.event_id}`);
  if (forms.length) return answer([forms.map(formLine).join("\n"), ...view.newSubmissions.filter(n => forms.some(f => f.form_id === n.form_id)).map(n => newSubmissionLine(n, labelsOf(capture))), who ? NO_NAMES : ""]);
  if (groups.length) return answer([groups.map(groupLine).join("\n"), groups.some(g => g.members === null) ? groupsShareNoCount : "", who ? NO_NAMES : ""]);
  if (events.length) {
    const lines = events.map(e => `${eventLine(e)}${e.attendance === null && instant(e.ends_at ?? e.starts_at) > instant(capture.completed_at) ? " It hasn't happened yet." : ""}`);
    return answer([lines.join("\n"), who ? NO_NAMES : ""]);
  }
  if (CHANGED.test(text)) {
    const lines = view.newSubmissions.map(n => newSubmissionLine(n, labelsOf(capture)));
    return answer([lines.length ? lines.join("\n") : "No form was filled in again since the last check.", `From Genesis: ${genesisSummary(view)}.`]);
  }
  if (GROUPS.test(text)) return answer([view.facts.groups.length ? view.facts.groups.map(groupLine).join("\n") : "Genesis lists no groups.", groupsShareNoCount, who ? NO_NAMES : ""]);
  if (FORMS.test(text)) {
    return answer([view.facts.forms.length ? view.facts.forms.map(formLine).join("\n") : "Genesis lists no forms.", ...view.newSubmissions.map(n => newSubmissionLine(n, labelsOf(capture))), who ? NO_NAMES : ""]);
  }
  if (ATTENDANCE.test(text)) {
    const past = view.recent.filter(e => e.attendance !== null);
    return answer([past.length ? past.map(eventLine).join("\n")
      : "Genesis shows no attendance for an event that has ended among those Ozzie read. Ozzie reads events from yesterday through the next four weeks.", who ? NO_NAMES : ""]);
  }
  if (EVENTS.test(text)) {
    const next = view.upcoming.slice(0, 8).map(e => `${label(`event:${e.event_id}`, "An event without a name")}, ${when(capture, e.starts_at)}.`);
    return answer([next.length ? next.join("\n") : "Genesis lists no events in the next four weeks.", ...(view.upcoming.length > 8 ? [`And ${view.upcoming.length - 8} more on Genesis's page in Ozzie.`] : [])]);
  }
  if (who) return answer([NO_NAMES, CAN]);
  return answer([`From Genesis: ${genesisSummary(view)}.`, CAN]);
}

/** Settings for a church on Genesis: the church, its time zone, reading now, and letting the key go. */
export function GenesisSettings({ connection, onConnection, onRead, busy, onConnect, forget = churchSystems.forget }: {
  connection: AlsoRead | null; onConnection: (next: AlsoRead | null) => void; onRead: () => void; busy: boolean; onConnect: () => void;
  forget?: typeof churchSystems.forget;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const [zoneOpen, setZoneOpen] = useState(false);
  return <section className="settings-sec" aria-labelledby="pco-title">
    <h2 id="pco-title" className="h3" tabIndex={-1}>Genesis</h2>
    {!connection ? <div className="find"><p className="find-body">Genesis not connected.</p>
      <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={onConnect}>Connect Genesis</button></div></div>
      : <div className="find">
        <p className="find-body">Connected to {connection.church_name ?? "your church"} in Genesis. Ozzie reads its groups, events and forms only, and changes nothing there.</p>
        <p className="small">{connection.zone ? `Ozzie places Genesis's event times in ${zoneLabel(connection.zone)}.` : "Ozzie is waiting for your church's time zone before it reads Genesis's events."}</p>
        {(zoneOpen || !connection.zone) && <TimeZoneQuestion system="genesis" systemZone={null} startsAt={null} initial={connection.zone}
          onConfirm={zone => { setZoneOpen(false); onConnection({ ...connection, zone }); }} />}
        <div className="row form-actions">
          {connection.zone && <button type="button" className="btn btn-secondary" disabled={busy} onClick={onRead}>{busy ? "Reading Genesis…" : "Read Genesis now"}</button>}
          {connection.zone && !zoneOpen && <button type="button" className="btn btn-quiet" onClick={() => setZoneOpen(true)}>Change the time zone</button>}
          <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => {
            void forget("genesis", connection.church_id).then(word => {
              if (word === "forgotten") onConnection(null);
              else setProblem("This Mac didn't let Ozzie remove the Genesis key just now. Unlock this Mac (type your Mac password if it asks), then try again.");
            });
          }}>Disconnect Genesis and forget its key</button>
        </div>
        {problem && <p className="problem" role="alert">{problem}</p>}
      </div>}
  </section>;
}
