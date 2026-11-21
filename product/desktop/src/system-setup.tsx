// First run for a church on B1 Church or Breeze (onboarding decision 21; docs/design/church-systems-design.md §7–8), and
// the question before it: "What does your church use?". Choosing Planning Center goes on exactly as before (setup-flow.tsx).
// The other systems' steps mirror Planning Center's (onboarding spec S2–S5) as closely as each system's data allows:
// connect with the church's own key (taken in natively, never by this page), then the service Ozzie watches, then its
// first result. B1 Church asks the church's time zone once, as a plain question with this Mac's zone as the default.
// Every outcome is a fixed sentence chosen by a closed word (church-system.ts); native text is never shown.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { longDate, type DayWords } from "../../../core/src/service-day.js";
import { rosterSummary, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { onServiceWithoutRole, sharedLabel, toConfirm } from "../../../core/src/church-systems/facts.js";
import { isKnownZone, readsFor, SYSTEMS, type SystemCapture, type SystemId } from "../../../core/src/church-systems/types.js";
import { isDateOnly } from "../../../core/src/read-result.js";
import {
  addressLabel, CONNECT, connectProblem, formatAt, HOST_SENTENCE, keychainAsking, keyGoesTo, letChurchGo, readProblemText, systemWords, useKeychainAsking,
  type ChurchSystemState, type Connected, type LetGo, type MainSystem,
  type OtherSystem, type ServiceChoice, type SystemConnection,
} from "./church-system.js";
import { FIRST_RUN, Sheet, StepHead, useTitleFocus } from "./first-run-screens.js";
import { Icon } from "./icons.js";
import { eyeLine, pageRef } from "./day-phrases.js";
import { systemPromise } from "./promises.js";
import { browserStore, loadPrefs } from "./proactive.js";
import { zoneLabel } from "./proactive-page.js";
import "./first-run.css";

export const CHOOSE = {
  title: "What does your church use?",
  body: "Ozzie reads it and tells you what needs you before your next service. It only reads: it never changes anything there.",
  help: "Choose where your church plans its services and schedules its volunteers.",
  systems: [
    { id: "planning-center", name: "Planning Center", line: "Who's scheduled, who said yes, who could help, and more of Planning Center if you want it." },
    { id: "b1", name: "B1 Church", line: "Who's scheduled, who said yes, and who on each team could help." },
    { id: "breeze", name: "Breeze", line: "Who's scheduled and who said yes. Breeze doesn't say who could help." },
    // Round 5 (owner decision 2026-11-19): a church that uses only Genesis can use Ozzie too, honestly.
    { id: "genesis", name: "Genesis", line: "Groups, events with attendance, and forms. Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered." },
  ] as const,
  example: FIRST_RUN.example,
  exampleIs: "The example church uses Planning Center. B1 Church, Breeze and Genesis each show their own example church on their next screen.",
  free: FIRST_RUN.free,
} as const;

/** S0, before "Connect Planning Center" (decision 21): which system the church uses. Planning Center is first. */
export function ChooseSystem({ onChoose, onExample }: { onChoose: (system: MainSystem) => void; onExample: () => void }) {
  const title = useTitleFocus<HTMLHeadingElement>("choose");
  return <section className="fr" aria-labelledby="fr-title">
    <h1 id="fr-title" className="fr-title" tabIndex={-1} ref={title}>{CHOOSE.title}</h1>
    <p className="fr-note">{CHOOSE.body}</p>
    <ul className="fr-services" aria-label={CHOOSE.help}>{CHOOSE.systems.map(s => <li key={s.id}>
      <button type="button" className="fr-service" onClick={() => onChoose(s.id)}>
        <span className="fr-service-t">{s.name}</span><span className="fr-service-d">{s.line}</span>
      </button></li>)}</ul>
    <div className="fr-actions"><button type="button" className="fr-link" onClick={onExample}>{CHOOSE.example}</button></div>
    {/* Which system the example shows (round 5); each other system's next screen offers its own. */}
    <p className="fr-small">{CHOOSE.exampleIs}</p>
    <p className="fr-small">{CHOOSE.free}</p>
  </section>;
}

/**
 * The promises on a system's connect screen: it only reads, names stay here, and the one host Ozzie contacts. Genesis's
 * key reads no People, so there Ozzie reads no one's name at all (live check 2026-11-19).
 */
export function systemPromises(system: SystemId): string[] {
  const name = SYSTEMS[system].name;
  return [systemPromise("connectReads", name), system === "genesis" ? "Ozzie reads no one's name from Genesis." : systemPromise("names", name), HOST_SENTENCE[system]];
}
const Checks = ({ lines }: { lines: readonly string[] }) =>
  <ul className="fr-checks">{lines.map(line => <li key={line}><Icon name="check" small /><span>{line}</span></li>)}</ul>;

/**
 * Connecting a system with the church's own key: what Ozzie reads, what it can't see there, the host it contacts, where
 * the key is in that system, the church's address (B1 Church, Breeze), then the key, taken in natively. `connect` is the
 * native call (church-system.ts `churchSystems.connect`); its outcome is said in its own words, and "works" hands on.
 */
export function SystemConnect({ system, step, again = false, connect, onConnected, onBack, backLabel, notNow, onExample }: {
  system: SystemId; step: string | null; again?: boolean;
  /** "See an example church first": this system's own fictional church (core church-systems/fictional.ts). */
  onExample?: (() => void) | undefined;
  connect: (address: string | null, how: "paste" | "enter") => Promise<Connected>;
  onConnected: (church: { id: string; name: string | null }, address: string) => void;
  onBack?: (() => void) | undefined; backLabel?: string; notNow?: (() => void) | undefined;
}) {
  const words = CONNECT[system];
  const title = useTitleFocus<HTMLHeadingElement>(`connect-${system}`);
  const [typed, setTyped] = useState("");
  const [working, setWorking] = useState(false);
  // Saving the key replaces any kept for the church: macOS may ask the person first (church-system.ts useKeychainAsking).
  const asking = useKeychainAsking(working);
  const [problem, setProblem] = useState<{ text: string; alert: boolean } | null>(null);
  const needsAddress = system !== "genesis";
  const label = needsAddress ? addressLabel(system, typed) : null;
  const ready = !needsAddress || label !== null;
  const go = async (how: "paste" | "enter") => {
    if (needsAddress && !label) { setProblem(connectProblem(system, "address", null)); return; }
    setWorking(true); setProblem(null);
    try {
      const r = await connect(label, how);
      if (r.outcome === "works" && r.church) { onConnected(r.church, label ?? ""); return; }
      setProblem(connectProblem(system, r.outcome === "works" ? "invalid-response" : r.outcome, label));
    } finally { setWorking(false); }
  };
  const name = SYSTEMS[system].name;
  return <section className="fr" aria-labelledby="fr-title">
    <StepHead step={step} titleRef={title}>{again ? `${words.title} again` : words.title}</StepHead>
    <Checks lines={systemPromises(system)} />
    <details className="fr-fold">
      <summary><Icon name="chev" small />What will Ozzie read?</summary>
      <p>{words.reads}</p>
    </details>
    <h2 className="fr-h2">What Ozzie can't see in {name}</h2>
    <ul className="fr-reads">{words.cantSee.map(line => <li key={line}>{line}</li>)}</ul>
    <details className="fr-fold">
      <summary><Icon name="chev" small />Everything Ozzie can't see in {name}</summary>
      <ul className="fr-reads">{words.everything.map(line => <li key={line}>{line}</li>)}</ul>
    </details>
    <h2 className="fr-h2">Where to find the key</h2>
    <ol className="fr-steps">{words.steps.map(s => <li key={s}>{s}</li>)}</ol>
    {needsAddress && <div className="field">
      <label htmlFor="fr-system-address">{words.addressLabel}</label>
      <input id="fr-system-address" className="input" value={typed} autoComplete="off" spellCheck={false} placeholder={words.addressPlaceholder ?? ""}
        onChange={e => { setTyped(e.target.value); setProblem(null); }} />
      <p className="input-help">{typed && !label ? connectProblem(system, "address", null)!.text : words.addressHelp}</p>
    </div>}
    <p className="fr-small">{keyGoesTo(system, label)} If it works, Ozzie keeps it in this Mac's Keychain, never in a file, and never shows it again.</p>
    {problem && (problem.alert ? <div className="fr-failure" role="alert"><p>{problem.text}</p></div> : <p className="fr-note" role="status">{problem.text}</p>)}
    {working && <p className="fr-note" role="status"><Icon name="spinner" small spin /> Checking the key with {name}…</p>}
    {asking && <p className="fr-note" role="status">{keychainAsking(name)}</p>}
    <div className="fr-actions">
      <button type="button" className="btn btn-primary fr-primary" disabled={working || !ready} onClick={() => { void go("paste"); }}>Paste my key</button>
      <button type="button" className="btn btn-secondary" disabled={working || !ready} onClick={() => { void go("enter"); }}>Type or paste it in a window</button>
      {onBack && <button type="button" className="fr-link" disabled={working} onClick={onBack}>{backLabel ?? FIRST_RUN.back}</button>}
      {notNow && <button type="button" className="fr-link" disabled={working} onClick={notNow}>{FIRST_RUN.notNow}</button>}
      {onExample && !again && <button type="button" className="fr-link" disabled={working} onClick={onExample}>{FIRST_RUN.example}</button>}
    </div>
  </section>;
}

/** Every zone this Mac knows, in the spelling native code and the coverage check agree on (types.ts `isKnownZone`). */
export function knownZones(): string[] {
  let all: string[] = [];
  try { all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { all = []; }
  const zones = all.filter(isKnownZone);
  return zones.includes("UTC") ? zones : [...zones, "UTC"];
}
/** This Mac's own zone, as the default answer. */
export const macZone = (): string => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return "UTC"; } };
/** "Sunday, November 22 at 9:00 AM": a start in `zone`, the words toConfirm allows. */
export function startIn(startsAt: string, zone: string): string | null {
  if (!isKnownZone(zone)) return null;
  try {
    const at = new Date(startsAt);
    if (!Number.isFinite(at.getTime())) return null;
    const day = at.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zone });
    const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
    return `${day} at ${time}`.replace(/ /gu, " ");
  } catch { return null; }
}

/**
 * The church's time zone, asked once (B1 Church, and Genesis's events): the system's own zone or this Mac's as the
 * default, with the service's start in the chosen zone so a wrong yes shows. Ozzie never guesses: nothing is checked
 * until the person answers.
 */
export function TimeZoneQuestion({ system, systemZone, startsAt, initial, onConfirm, working = false }: {
  system: SystemId; systemZone: string | null; startsAt: string | null; initial?: string | null; onConfirm: (zone: string) => void; working?: boolean;
}) {
  // Each zone by its everyday name and city ("Eastern Time (New York)"), the IANA name kept as the value.
  const zones = useMemo(() => knownZones().map(z => ({ zone: z, label: zoneLabel(z) })), []);
  const fromSystem = systemZone && isKnownZone(systemZone) ? systemZone : null;
  const [zone, setZone] = useState(() => initial && isKnownZone(initial) ? initial : fromSystem ?? (isKnownZone(macZone()) ? macZone() : "UTC"));
  const local = startsAt ? startIn(startsAt, zone) : null;
  // The system's own zone, chosen as it is: its own question ("B1 Church says … Is that right?"). Any other: which zone,
  // with the start it gives, so a wrong answer shows before it is used.
  const question = fromSystem === zone ? toConfirm(system, zone, { ...(local ? { localStart: local } : {}), source: "system", zoneName: zoneLabel(zone) }) : null;
  const asked = question ?? `Which time zone does your church meet in?${local ? ` In ${zoneLabel(zone)}, this service starts ${local}.` : ""}`;
  return <div className="fr-zone">
    <p className="fr-note">{asked}</p>
    <div className="field">
      <label htmlFor="fr-zone">Your church's time zone</label>
      <select id="fr-zone" className="input" value={zone} onChange={e => setZone(e.target.value)}>
        {zones.map(z => <option key={z.zone} value={z.zone}>{z.label}</option>)}
      </select>
      <p className="input-help">This Mac is set to {zoneLabel(macZone())}. Ozzie uses the zone you choose for the times and days it reads.</p>
    </div>
    <div className="fr-actions"><button type="button" className="btn btn-primary fr-primary" disabled={working} onClick={() => onConfirm(zone)}>Use {zoneLabel(zone)}</button></div>
  </div>;
}

/** What the service step needs from App: the result on screen once a read ends, in Today's counts. */
export interface SystemResultView {
  brief: SundayBrief; capture: SystemCapture;
  counts: { decisions: number; looks: number };
  lines: readonly { key: string; text: string }[];
  /** Facts beside the findings (a plan not shared yet, people with no role). */
  notices: readonly string[];
  /** The check waits for the church's time zone (B1 Church). */
  waitingForZone: boolean;
}
/** How many are scheduled and how many said yes, from the capture's own answers (no names). */
export function systemCounts(capture: Pick<SystemCapture, "assignments">): { scheduled: number; yes: number; waiting: number } {
  const best = new Map<string, "accepted" | "unconfirmed">();
  for (const a of capture.assignments) {
    if (a.status === "accepted") best.set(a.person_id, "accepted");
    else if (a.status === "unconfirmed" && !best.has(a.person_id)) best.set(a.person_id, "unconfirmed");
  }
  const yes = [...best.values()].filter(s => s === "accepted").length;
  return { scheduled: best.size, yes, waiting: best.size - yes };
}
/** The soonest service on or after `today` (YYYY-MM-DD), the system's own day; null when none is listed. */
export function soonest(choices: readonly ServiceChoice[], today: string): ServiceChoice | null {
  return [...choices].filter(c => c.day >= today).sort((a, b) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id))[0] ?? null;
}
/** A name that reads like a service: "Sunday Service", "Worship", "Mass", "Gathering". */
const SERVICE_NAME = /\b(?:service|services|worship|mass|gathering|celebration|sunday)\b/iu;
/** Why Ozzie picked the one it did among several on the same day, as the first result says it. */
export type PickedBecause = "people" | "time" | "name" | "first";
/**
 * The service Ozzie watches by itself: on the soonest day on or after `today`, the event with people listed on it (most
 * first), then one with a start time, then one whose name reads like a service, then the earliest (round 4, live: it
 * picked "Event Location limit", with no time and nobody on it, over "Breeze Sunday" at 9:35 AM). `sameDay`: how many
 * are listed that day, so the first result can offer the rest plainly.
 */
export function pickService(choices: readonly ServiceChoice[], today: string): { choice: ServiceChoice; sameDay: number; because: PickedBecause } | null {
  const first = soonest(choices, today);
  if (!first) return null;
  const day = choices.filter(c => c.day === first.day);
  if (day.length === 1) return { choice: first, sameDay: 1, because: "first" };
  // People listed decide only when every event that day was counted: native counts at most 4, and an uncounted one may
  // be the service (review of round 4, M3).
  const counted = day.every(c => typeof c.people === "number");
  const score = (c: ServiceChoice) => [counted ? -(c.people ?? 0) : 0, c.time ? 0 : 1, c.name && SERVICE_NAME.test(c.name) ? 0 : 1] as const;
  const sorted = [...day].sort((a, b) => {
    const x = score(a), y = score(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (a.time ?? "99").localeCompare(b.time ?? "99") || a.id.localeCompare(b.id);
  });
  const choice = sorted[0]!;
  const because: PickedBecause = counted && (choice.people ?? 0) > 0 && day.some(c => (c.people ?? 0) < (choice.people ?? 0)) ? "people"
    : choice.time && day.some(c => !c.time) ? "time"
    : choice.name && SERVICE_NAME.test(choice.name) && day.some(c => !c.name || !SERVICE_NAME.test(c.name)) ? "name" : "first";
  return { choice, sameDay: day.length, because };
}
/** "9:35 AM" from Breeze's "09:35"; null for none. */
export const clockWords = (time: string | null | undefined): string | null => {
  const m = typeof time === "string" ? /^([01]\d|2[0-3]):([0-5]\d)$/u.exec(time) : null;
  if (!m) return null;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? "AM" : "PM"}`;
};
const localToday = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
/**
 * The first day a listed service may be on to count as upcoming: this Mac's date; for B1 Church, the earlier of that and
 * today's date in UTC. B1 saves a plan's day a day early for churches at UTC+12 or later (b1.rs), so on a Sunday morning
 * there a Sunday plan is listed as Saturday: comparing with this Mac's date alone would skip it for next week's. West of
 * UTC this Mac's date is the earlier one, so nothing changes there.
 */
export function listedToday(system: OtherSystem, ms: number = Date.now(), local: string = localToday(ms)): string {
  if (system !== "b1") return local;
  const utc = new Date(ms).toISOString().slice(0, 10);
  return utc < local ? utc : local;
}
const every = (minutes: number) => minutes === 60 ? "every hour" : minutes % 60 === 0 ? `every ${minutes / 60} hours` : `every ${minutes} minutes`;
export const choiceLine = (c: Pick<ServiceChoice, "day" | "name"> & { time?: string | null }) =>
  [isDateOnly(c.day) ? `${longDate(c.day)}${clockWords(c.time) ? ` at ${clockWords(c.time)}` : ""}` : null, c.name].filter(Boolean).join(" · ");

type Phase =
  | { at: "loading" }
  | { at: "none" }
  | { at: "problem"; text: string; during: "list" | "read" }
  | { at: "reading"; started: number }
  | { at: "zone" }
  | { at: "result" };

/**
 * S5 for a system: Ozzie picks the soonest plan (B1 Church) or event (Breeze) itself, with "Choose a different one";
 * reads it; asks B1 Church's time zone when the check waits for it; then the first result and the one next action.
 */
export function SystemService({ connection, onConnection, list, read, result, day, aiOffered, onNext, nowMs, banner, refusal = null }: {
  /** The last read built no service check, and why (system-pages.tsx `refusalLine`). */
  refusal?: string | null;
  connection: SystemConnection; onConnection: (next: SystemConnection) => void;
  list: () => Promise<{ outcome: string; choices: ServiceChoice[] }>;
  /** Reads the watched service (App's check, the same one the service's page runs). Resolves to native's outcome word. */
  read: (connection: SystemConnection) => Promise<string>;
  result: SystemResultView | null; day: DayWords; aiOffered: boolean; onNext: (to: "ai" | "sunday" | "today") => void; nowMs: number; banner?: ReactNode;
}) {
  const system = connection.system;
  const words = systemWords(system);
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  const [choices, setChoices] = useState<ServiceChoice[] | null>(null);
  const [sheet, setSheet] = useState(false);
  const [listNow, setListNow] = useState(0);
  // What Ozzie picked by itself, and why, when several are listed that day (round 4): said plainly with the choice.
  const [picked, setPicked] = useState<{ id: string; sameDay: number; because: PickedBecause } | null>(null);
  const asking = useKeychainAsking(phase.at === "loading" || phase.at === "reading" || (sheet && choices === null));
  const conn = useRef(connection);
  conn.current = connection;
  const title = useTitleFocus<HTMLHeadingElement>(phase.at);
  const readNow = (next: SystemConnection) => {
    setPhase({ at: "reading", started: Date.now() });
    void read(next).then(outcome => {
      const text = readProblemText(system, outcome);
      setPhase(text ? { at: "problem", text, during: "read" } : { at: "result" });
    }, () => setPhase({ at: "problem", text: readProblemText(system, "unavailable")!, during: "read" }));
  };
  // The service: the one already watched, else the soonest listed (no confirm click: the read starts at once).
  useEffect(() => {
    let alive = true;
    setPhase({ at: "loading" });
    void list().then(r => {
      if (!alive) return;
      setChoices(r.choices);
      const text = r.outcome === "ok" || r.outcome === "works" ? null : readProblemText(system, r.outcome);
      if (text) { setPhase({ at: "problem", text, during: "list" }); return; }
      const c = conn.current;
      if (c.service_id) { readNow(c); return; }
      const pick = pickService(r.choices, listedToday(system));
      if (!pick) { setPhase({ at: "none" }); return; }
      const first = pick.choice;
      if (pick.sameDay > 1) setPicked({ id: first.id, sameDay: pick.sameDay, because: pick.because });
      const next = { ...c, service_id: first.id, service_day: first.day, service_name: first.name };
      onConnection(next); readNow(next);
    });
    return () => { alive = false; };
  }, [listNow]);
  // A read that waits for the zone asks it; once confirmed, the same service is read again in that zone.
  const waiting = phase.at === "result" && result?.waitingForZone === true && result.capture.service?.id === connection.service_id;
  const watchedChoice = choices?.find(c => c.id === connection.service_id) ?? null;
  const watching = connection.service_day ? choiceLine({ day: connection.service_day, name: connection.service_name, time: watchedChoice?.time ?? null }) : connection.service_name ?? "";
  // Several on the day Ozzie picked from: say how many, which and why, with the choice as a real button (round 4).
  const crowded = picked && picked.id === connection.service_id && picked.sameDay > 1 && connection.service_day ? picked : null;
  const why = crowded?.because === "people" ? ", the one with the most people listed on it" : crowded?.because === "time" ? ", the one with a start time"
    : crowded?.because === "name" ? ", the one named like a service" : "";
  const notFound = system === "b1" ? "B1 Church has no upcoming plans with roles yet" : "Breeze has no events in the next four weeks";
  const elapsed = phase.at === "reading" ? Math.max(0, Math.floor((nowMs - phase.started) / 1000)) : 0;
  // Each step here reads the key Ozzie keeps first: while macOS asks the person about it, the step says so.
  const askingLine = asking ? <p className="fr-note" role="status">{keychainAsking(words.name)}</p> : null;

  if (phase.at === "loading") return <section className="fr" aria-labelledby="fr-title">{banner}
    <StepHead step="Step 2 of 2" titleRef={title}>Finding your services in {words.name}…</StepHead>
    <p className="fr-note" role="status"><Icon name="spinner" small spin /> Reading what your church has planned.</p>
    {askingLine}
  </section>;
  if (phase.at === "none") return <section className="fr" aria-labelledby="fr-title">{banner}
    <StepHead step="Step 2 of 2" titleRef={title}>{notFound}</StepHead>
    <p className="fr-note">{system === "b1" ? "Ozzie lists B1 Church plans in the next eight weeks that have roles. When someone adds roles to the next plan, look again." : "Ozzie lists Breeze events in the next four weeks. When the next one is in Breeze, look again."}</p>
    <div className="fr-actions">
      <button type="button" className="btn btn-primary fr-primary" onClick={() => setListNow(n => n + 1)}>Look again now</button>
      <button type="button" className="fr-link" onClick={() => onNext("today")}>Go to Today</button>
    </div>
  </section>;
  // Only a result of the service now watched.
  const ofWatched = result && result.capture.service?.id === connection.service_id ? result : null;
  const shown = phase.at === "result" && ofWatched && !waiting ? ofWatched : null;
  return <section className="fr" aria-labelledby="fr-title">
    {!shown && banner}
    <StepHead step="Step 2 of 2" titleRef={title}>{day.question}</StepHead>
    {crowded ? <p className="fr-watching"><span>Ozzie found {crowded.sameDay} {system === "b1" ? "plans" : "events"} on {longDate(connection.service_day!)}. It picked {connection.service_name ?? "one"}{clockWords(watchedChoice?.time) ? ` at ${clockWords(watchedChoice?.time)}` : ""}{why}.</span>
      {phase.at !== "reading" && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSheet(true)}>Choose a different one</button>}</p>
      : <p className="fr-watching"><span>Ozzie is watching {watching || "your service"}</span>
        {phase.at !== "reading" && <button type="button" className="fr-link" onClick={() => setSheet(true)}>Choose a different one</button>}</p>}
    {phase.at === "reading" && <p className="fr-note" role="status" aria-live="polite"><Icon name="spinner" small spin /> Reading {watching || "your service"} from {words.name}… {elapsed >= 5 ? `${elapsed} seconds so far.` : "This can take a minute."}</p>}
    {askingLine}
    {phase.at === "problem" && <div className="fr-failure" role="alert"><p>{phase.text}</p>
      <div className="fr-row">
        <button type="button" className="btn btn-primary" onClick={() => phase.during === "list" ? setListNow(n => n + 1) : readNow(conn.current)}>Try again</button>
        <button type="button" className="fr-link" onClick={() => onNext("today")}>Not now</button>
      </div></div>}
    {waiting && result && <TimeZoneQuestion system={system} systemZone={result.capture.church.time_zone} startsAt={result.capture.service?.starts_at ?? null}
      initial={connection.zone} onConfirm={zone => { const next = { ...conn.current, zone }; onConnection(next); readNow(next); }} />}
    {shown && <SystemResult view={shown} day={day} system={system} aiOffered={aiOffered} onNext={onNext} />}
    {phase.at === "result" && !shown && !waiting && refusal && <div className="fr-failure" role="status"><p>{refusal}</p>
      <div className="fr-row">
        <button type="button" className="btn btn-primary" onClick={() => setSheet(true)}>Choose a different one</button>
        <button type="button" className="fr-link" onClick={() => onNext("today")}>Go to Today</button>
      </div></div>}
    {sheet && <Sheet title={system === "b1" ? "Which plan should Ozzie watch?" : "Which event should Ozzie watch?"} onClose={() => setSheet(false)} labelId="fr-system-different">
      {choices === null ? <p className="fr-note" role="status"><Icon name="spinner" small spin /> Reading…</p>
        : choices.length === 0 ? <p className="fr-note">{notFound}.</p>
        : <ul className="fr-plans">{choices.slice(0, 24).map(c => <li key={c.id}>
          <span>{choiceLine(c)}{sharedLabel(system, c.shared) ? <span className="fr-small"> · {sharedLabel(system, c.shared)}</span> : null}
            {typeof c.people === "number" ? <span className="fr-small"> · {c.people === 0 ? "nobody listed on it" : c.people === 1 ? "1 person listed on it" : `${c.people} people listed on it`}</span> : null}</span>
          <button type="button" className="btn btn-secondary" disabled={c.id === connection.service_id} onClick={() => {
            setSheet(false);
            const next = { ...conn.current, service_id: c.id, service_day: c.day, service_name: c.name };
            setPicked(null); onConnection(next); readNow(next);
          }}>Watch this one</button></li>)}</ul>}
      <div className="fr-actions"><button type="button" className="fr-link" onClick={() => setSheet(false)}>{FIRST_RUN.back}</button></div>
    </Sheet>}
  </section>;
}

/** S5e for a system: the answer, up to three decisions as Today names them, the source, and the one next action. */
function SystemResult({ view, day, system, aiOffered, onNext }: { view: SystemResultView; day: DayWords; system: OtherSystem; aiOffered: boolean; onNext: (to: "ai" | "sunday" | "today") => void }) {
  const words = systemWords(system);
  const { brief, counts, lines } = view;
  const when = day.date ?? day.day;
  const checked = brief.checked_at ? formatAt(brief.checked_at, { hour: "numeric", minute: "2-digit" }) : null;
  const source = `${words.name}${checked ? ` · checked ${checked}` : ""}`;
  const people = systemCounts(view.capture);
  const partial = brief.sources.failed.length > 0 || brief.findings.some(f => f.kind === "worth-a-look");
  // Breeze shares no number of people a role needs: Ozzie can't call the service covered, so it says so and who is on it
  // (round 4: the first result said who was scheduled, the service's page never did).
  const roster = brief.roster && brief.roster.roles.length > 0 && brief.roster.roles.every(r => r.needed === null) ? brief.roster : null;
  // Who is scheduled is a fact only from answers read whole (final review M3): otherwise no count and no "nobody".
  const answers = readsFor(system, "assignments");
  const answersWhole = answers.every(w => { const r = view.capture.reads.filter(x => x.read === w); return r.length > 0 && r.every(x => x.outcome === "ok"); });
  return <div className="fr-result" aria-live="polite">
    {counts.decisions > 0
      ? <>
        <p className="fr-answer">{counts.decisions === 1 ? "1 thing needs a decision" : `${counts.decisions} things need a decision`} for {when}.</p>
        <ul className="fr-decisions">{lines.slice(0, 3).map(l => <li key={l.key}><span>{l.text}</span><span className="fr-small">{source}</span></li>)}</ul>
        {counts.decisions > 3 && <p className="fr-note">And {counts.decisions - 3} more.</p>}
      </>
      : <>
        <p className="fr-answer">{!answersWhole || partial ? `Nothing in what Ozzie could read needs a decision for ${when}.`
          : roster ? rosterSummary(roster)
          : people.scheduled === 0 ? `Nobody is scheduled for ${when} yet in ${words.name}.` : `Everything Ozzie checks is covered for ${when}.`}</p>
        {/* The facts first, then the limit (round 5); someone with no role is said here, as the service's page says it. */}
        {answersWhole && roster ? <p className="fr-note">{words.name} doesn't share how many people each role needs, so Ozzie can't say whether {when} is covered.
          {roster.no_role.length > 0 ? ` ${onServiceWithoutRole(roster.no_role.length)}` : ""} {pageRef().charAt(0).toUpperCase() + pageRef().slice(1)} shows who is on each role.</p>
          : answersWhole && people.scheduled > 0 && <p className="fr-note">{people.scheduled === 1 ? "1 person" : `${people.scheduled} people`} scheduled. {people.yes} said yes{people.waiting ? `, ${people.waiting} ${people.waiting === 1 ? "hasn't" : "haven't"} answered yet` : ""}.</p>}
        <p className="fr-small">{source}</p>
      </>}
    {view.notices.map(n => <p key={n} className="fr-note">{n}</p>)}
    {counts.looks > 0 && <p className="fr-note">Also {counts.looks === 1 ? "1 thing" : `${counts.looks} things`} worth a look. You'll see {counts.looks === 1 ? "it" : "them"} on {pageRef()}.</p>}
    {partial && <p className="fr-note">Part of {day.day} couldn't be checked, so this isn't a full picture.</p>}
    {/* As Planning Center's first result says it (your-service.tsx), with the person's own schedule (proactive.ts loadPrefs). */}
    <p className="fr-note">{eyeLine()} at least {every(loadPrefs(browserStore).intervalMinutes)} while it's open, and moves on to the next {system === "b1" ? "plan" : "event"} by itself after this one. To read it now, press {words.checkNow} on {pageRef()}.</p>
    <div className="fr-actions"><button type="button" className="btn btn-primary fr-primary" onClick={() => onNext(aiOffered ? "sunday" : "ai")}>{aiOffered ? `Open ${day.page}` : "Next: choose how Ozzie uses AI"}</button></div>
  </div>;
}

/** Where a system's first run is: connect (no key yet), the service (nothing watched or no result seen yet), or done. */
export function systemFirstRunAt(state: ChurchSystemState, resultSeen: boolean): "connect" | "service" | null {
  if (state.main !== "b1" && state.main !== "breeze") return null;
  if (!state.connection) return "connect";
  return state.connection.service_id && resultSeen ? null : "service";
}

/**
 * First run for a church on B1 Church or Breeze: connect (step 1 of 2), then the service and its first result (step 2
 * of 2), then the AI screen once. Back from connecting goes to "What does your church use?".
 */
export function SystemFirstRun({ state, onState, start, read, result, day, aiOffered, renderAi, onLeave, onChooseAgain, nowMs, bridge, onExample, refusal = null }: {
  onExample?: (() => void) | undefined; refusal?: string | null;
  state: ChurchSystemState; onState: (next: ChurchSystemState) => void; start: "connect" | "service";
  read: (connection: SystemConnection) => Promise<string>; result: SystemResultView | null; day: DayWords; aiOffered: boolean;
  renderAi?: ((done: (how?: "chosen" | "none" | "later") => void) => ReactNode) | undefined;
  onLeave: (to: "today" | "sunday") => void; onChooseAgain: () => void; nowMs: number;
  bridge: { connect: (system: SystemId, address: string | null, how: "paste" | "enter") => Promise<Connected>;
    choices: (system: OtherSystem, churchId: string, from?: string) => Promise<{ outcome: string; choices: ServiceChoice[] }>;
    /** Lets the church connected before go (church-system.ts letChurchGo: kept to try again if the Keychain refuses). */
    letGo?: (c: LetGo) => Promise<boolean> };
}) {
  const system = state.main === "b1" || state.main === "breeze" ? state.main : null;
  const [at, setAt] = useState<"connect" | "service" | "ai">(state.connection ? start : "connect");
  const [justConnected, setJustConnected] = useState(false);
  if (!system) return null;
  const connection = state.connection;
  if (at === "ai" && renderAi) return <>{renderAi(() => onLeave("sunday"))}</>;
  if (at === "connect" || !connection) {
    return <SystemConnect system={system} step="Step 1 of 2" again={Boolean(connection)} connect={(address, how) => bridge.connect(system, address, how)}
      onConnected={(church, address) => {
        // A new key for the same church keeps what was chosen; another church starts afresh, and the key kept for the
        // church before it is forgotten (review L3).
        const same = connection && connection.church_id === church.id ? connection : null;
        if (connection && !same) void (bridge.letGo ?? letChurchGo)({ system: connection.system, church_id: connection.church_id });
        onState({ ...state, connection: { system, church_id: church.id, church_name: church.name, address,
          service_id: same?.service_id ?? null, service_day: same?.service_day ?? null, service_name: same?.service_name ?? null, zone: same?.zone ?? null,
          result_seen: same?.result_seen ?? false } });
        setJustConnected(true); setAt("service");
      }}
      onBack={connection ? () => setAt("service") : onChooseAgain} backLabel={connection ? FIRST_RUN.back : "Use a different system"}
      notNow={() => onLeave("today")} onExample={onExample} />;
  }
  const name = SYSTEMS[system].name;
  const banner = justConnected ? <div className="fr-connected" role="status"><Icon name="check" /><div>
    <p className="fr-connected-t">{FIRST_RUN.connectedTo(connection.church_name ?? "your church")}</p>
    <p className="fr-small">{name} accepted the key. Ozzie keeps it in this Mac's Keychain.</p></div></div> : undefined;
  return <SystemService connection={connection} onConnection={next => onState({ ...state, connection: next })}
    list={() => bridge.choices(system, connection.church_id, listedToday(system))} read={read} result={result} day={day} aiOffered={aiOffered || !renderAi} nowMs={nowMs} banner={banner} refusal={refusal}
    onNext={to => { if (to === "ai") { setAt("ai"); return; } onLeave(to); }} />;
}
