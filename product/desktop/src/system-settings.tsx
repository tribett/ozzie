// Settings for a church on B1 Church or Breeze (in place of the Planning Center section), and, for every church, the
// other systems: switching the main system (one at a time, said plainly with what it forgets) and Genesis, read beside
// the main system for groups, events and forms only (design §8). Keys go only through native (church-system.ts).
import { Fragment, useState, type ReactNode } from "react";
import { readableName, readProblem, sharedLabel, systemFacts, type FactOutcome, type NullCount, type SystemFacts } from "../../../core/src/church-systems/facts.js";
import { labelsOf } from "../../../core/src/church-systems/placeholders.js";
import { parseSystemCaptureText, SYSTEMS, type SystemCapture, type SystemId } from "../../../core/src/church-systems/types.js";
import {
  CONNECT, churchSystems as defaultBridge, eventWhen, formatAt, HOST_SENTENCE, keychainAsking, readProblemText, systemWords, useKeychainAsking, type AlsoRead, type ChurchSystemState,
  type MainSystem, type ServiceChoice, type SystemConnection,
} from "./church-system.js";
import { choiceLine, SystemConnect, TimeZoneQuestion } from "./system-setup.js";
import { Icon } from "./icons.js";
import { zoneLabel } from "./proactive-page.js";

type Bridge = Pick<typeof defaultBridge, "verify" | "forget" | "choices" | "check" | "connect" | "saved">;
const clock = (ms: number) => formatAt(ms, { hour: "numeric", minute: "2-digit" }) ?? "just now";
const NAMES: Readonly<Record<MainSystem, string>> = { "planning-center": "Planning Center", b1: "B1 Church", breeze: "Breeze" };
/** What a church on another system doesn't get yet, said once where it would look. */
export const ONLY_PLANNING_CENTER = (name: string) =>
  `Siri and Shortcuts, the copy for other AI apps, jobs such as the morning briefing, and rooms and follow-ups work with Planning Center only for now. Ozzie can't do these with ${name} yet.`;

/** What switching away from `from` forgets on this Mac, in one plain sentence. */
export function switchForgets(from: MainSystem, church: string | null, cards = 0): string {
  const open = cards > 0 ? ` ${cards === 1 ? "The visitor card you have open is" : `The ${cards} visitor cards you have open are`} discarded too.` : "";
  if (from === "planning-center") return `Switching signs Ozzie out of Planning Center on this Mac. Nothing changes in Planning Center, and your Church rules stay here. Its saved checks stay on this Mac until you delete them in Settings. Switching back asks you to allow Ozzie in Planning Center again.${open}`;
  const name = NAMES[from];
  return `Switching forgets ${church ?? "your church"} in ${name} on this Mac: the key in this Mac's Keychain, the church, the service Ozzie watches and its saved checks. Nothing changes in ${name}.${open}`;
}

/** The section for a church on B1 Church or Breeze, where Planning Center's would be. */
export function SystemSettings({ connection, onConnection, onForget, onConnect, startsAt, systemZone, bridge = defaultBridge }: {
  connection: SystemConnection; onConnection: (next: SystemConnection) => void;
  /** After the key is forgotten (Disconnect): App clears the connection. */
  onForget: () => void;
  /** "Connect again with a new key": first run's connect screen. */
  onConnect: () => void;
  /** The watched service's start and the system's own zone, from the last check, for the time zone question. */
  startsAt: string | null; systemZone: string | null; bridge?: Bridge;
}) {
  const system = connection.system;
  const words = systemWords(system);
  const church = connection.church_name ?? "your church";
  const [checked, setChecked] = useState<{ text: string; ok: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [choosing, setChoosing] = useState<ServiceChoice[] | null | "reading" | string>(null);
  const [zone, setZone] = useState(false);
  // Checking the connection and listing services read the key Ozzie keeps first: while macOS asks about it, Settings says so.
  const asking = useKeychainAsking(working || choosing === "reading");
  const where = system === "b1" ? `${connection.address}.b1.church` : `${connection.address}.breezechms.com`;
  const verify = () => {
    setWorking(true); setChecked(null);
    void bridge.verify(system, connection.church_id).then(r => {
      setChecked(r.outcome === "works"
        ? { ok: true, text: `It works: ${words.name} accepts Ozzie's key for ${r.church?.name ?? church}. Checked ${clock(Date.now())}.` }
        : { ok: false, text: readProblemText(system, r.outcome) ?? `${words.name} couldn't be checked just now.` });
      if (r.outcome === "works" && r.church?.name && r.church.name !== connection.church_name) onConnection({ ...connection, church_name: r.church.name });
    }).finally(() => setWorking(false));
  };
  const forget = () => {
    setWorking(true);
    void bridge.forget(system, connection.church_id).then(word => {
      if (word === "forgotten") { setConfirm(false); onForget(); }
      else setChecked({ ok: false, text: "This Mac didn't let Ozzie remove the key just now. Unlock this Mac (type your Mac password if it asks), then try again." });
    }).finally(() => setWorking(false));
  };
  const list = () => {
    setChoosing("reading");
    void bridge.choices(system, connection.church_id).then(r => setChoosing(r.outcome === "ok" || r.outcome === "works" ? r.choices : readProblemText(system, r.outcome) ?? ""));
  };
  return <section className="settings-sec" aria-labelledby="pco-title">
    <h2 id="pco-title" className="h3" tabIndex={-1}>{words.name} and which service Ozzie watches</h2>
    <div className="banner"><Icon name="lock" small /><div className="stack-tight">
      <span><strong>Reads only.</strong> Ozzie never changes anything in {words.name}. {HOST_SENTENCE[system]} The key is kept in this Mac's Keychain, never in a file.</span>
    </div></div>
    <section className="find" aria-labelledby="system-connected-title">
      <h3 id="system-connected-title" className="settings-t">Connected</h3>
      <p className="find-body">Connected to {church} in {words.name}, at {where}.</p>
      {checked && <p className={checked.ok ? "checkline granted" : "problem"} role={checked.ok ? "status" : "alert"}>{checked.text}</p>}
      {asking && <p className="small" role="status">{keychainAsking(words.name)}</p>}
      <div className="row form-actions">
        <button type="button" className="btn btn-secondary" disabled={working} onClick={verify}>Check the connection</button>
        <button type="button" className="btn btn-quiet" disabled={working} onClick={onConnect}>Connect again with a new key</button>
        <button type="button" className="btn btn-quiet" disabled={working} onClick={() => setConfirm(true)}>Disconnect {words.name}</button>
      </div>
      {confirm && <div className="decide" role="group" aria-labelledby="system-disconnect-q">
        <p id="system-disconnect-q" className="find-body"><strong>Disconnect {church}?</strong> Ozzie forgets its {words.name} key and the checks it saved on this Mac, and stops reading {words.name}. Nothing changes in {words.name}.</p>
        <div className="row">
          <button type="button" className="btn btn-secondary" disabled={working} onClick={forget}>Disconnect and forget the key</button>
          <button type="button" className="btn btn-quiet" disabled={working} onClick={() => setConfirm(false)}>Keep {church}</button>
        </div>
      </div>}
    </section>
    <section className="find" aria-labelledby="system-service-title">
      <h3 id="system-service-title" className="settings-t">Which service Ozzie watches</h3>
      <p className="find-body">{connection.service_id ? `Ozzie watches ${connection.service_day ? choiceLine({ day: connection.service_day, name: connection.service_name }) : connection.service_name ?? "one service"}.` : "No service is chosen yet."}</p>
      <div className="row form-actions"><button type="button" className="btn btn-secondary" disabled={choosing === "reading"} onClick={list}>Choose a different one</button></div>
      {choosing === "reading" && <p className="small" role="status"><Icon name="spinner" small spin /> Reading what's planned in {words.name}…</p>}
      {typeof choosing === "string" && choosing !== "reading" && <p className="problem" role="alert">{choosing}</p>}
      {Array.isArray(choosing) && (choosing.length === 0 ? <p className="small">{system === "b1" ? "B1 Church lists no upcoming plans with roles." : "Breeze lists no events in the next four weeks."}</p>
        : <ul className="list">{choosing.slice(0, 24).map(c => <li key={c.id} className="row">
          <span>{choiceLine(c)}{sharedLabel(system, c.shared) ? ` · ${sharedLabel(system, c.shared)}` : ""}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={c.id === connection.service_id}
            onClick={() => { onConnection({ ...connection, service_id: c.id, service_day: c.day, service_name: c.name }); setChoosing(null); }}>Watch this one</button>
        </li>)}</ul>)}
    </section>
    {SYSTEMS[system].zoneAsked && <section className="find" aria-labelledby="system-zone-title">
      <h3 id="system-zone-title" className="settings-t">Your church's time zone</h3>
      <p className="find-body">{connection.zone ? `Ozzie uses ${zoneLabel(connection.zone)} for ${church}'s times and days.` : `Ozzie is waiting for you to confirm your church's time zone before it checks a ${words.name} plan.`}</p>
      {!zone && <div className="row form-actions"><button type="button" className="btn btn-secondary" onClick={() => setZone(true)}>{connection.zone ? "Change the time zone" : "Choose the time zone"}</button></div>}
      {zone && <TimeZoneQuestion system={system} systemZone={systemZone} startsAt={startsAt} initial={connection.zone}
        onConfirm={z => { onConnection({ ...connection, zone: z }); setZone(false); }} />}
    </section>}
    <section className="find" aria-labelledby="system-cant-title">
      <h3 id="system-cant-title" className="settings-t">What Ozzie can't see in {words.name}</h3>
      <ul className="list">{CONNECT[system].cantSee.map(line => <li key={line}>{line}</li>)}</ul>
      <details className="listen-more"><summary><Icon name="chev" small />Everything Ozzie can't see in {words.name}</summary>
        <ul className="small">{CONNECT[system].everything.map(line => <li key={line}>{line}</li>)}</ul></details>
      <p className="small">{ONLY_PLANNING_CENTER(words.name)}</p>
    </section>
  </section>;
}

/**
 * Every church's way to the other systems: switching the main system, said with what it forgets, and Genesis read
 * beside it. `onSwitch` is App's: it does what the sentence says, then opens first run at the new system.
 */
export function OtherSystems({ state, onSwitch, genesis, cards = 0 }: {
  state: ChurchSystemState;
  /** Visitor cards open now: a switch discards them, and its question says so. */
  cards?: number;
  /** Switches; resolves to a plain sentence when the old system couldn't be let go (nothing switched then). */
  onSwitch: (to: MainSystem) => Promise<string | null> | void; genesis: ReactNode;
}) {
  const from: MainSystem = state.main ?? "planning-center";
  const [to, setTo] = useState<MainSystem | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const go = async (target: MainSystem) => {
    setWorking(true); setProblem(null);
    try { const said = await onSwitch(target); if (said) setProblem(said); else setTo(null); } finally { setWorking(false); }
  };
  return <section className="settings-sec" aria-labelledby="systems-title">
    <h2 id="systems-title" className="h3" tabIndex={-1}>Other church systems</h2>
    <section className="find" aria-labelledby="switch-title">
      <h3 id="switch-title" className="settings-t">Use a different system</h3>
      {/* Nothing chosen yet (a fresh Mac, round 5): the choice is made above, never "Planning Center now". */}
      {state.main === null ? <p className="find-body">Ozzie reads one church system at a time for your services. Choose yours under What your church uses, above.</p>
        : <p className="find-body">Ozzie reads one church system at a time for your services: {NAMES[from]} now.</p>}
      {!to && state.main !== null && <div className="row form-actions">{(["planning-center", "b1", "breeze"] as const).filter(s => s !== from).map(s =>
        <button key={s} type="button" className="btn btn-quiet" onClick={() => setTo(s)}>Switch to {NAMES[s]}</button>)}</div>}
      {to && <div className="decide" role="group" aria-labelledby="switch-q">
        <p id="switch-q" className="find-body"><strong>Switch to {NAMES[to]}?</strong> {switchForgets(from, state.connection?.church_name ?? null, cards)}</p>
        <div className="row">
          <button type="button" className="btn btn-secondary" disabled={working} onClick={() => { void go(to); }}>Switch to {NAMES[to]}</button>
          <button type="button" className="btn btn-quiet" disabled={working} onClick={() => { setTo(null); setProblem(null); }}>Keep {NAMES[from]}</button>
        </div>
        {problem && <p className="problem" role="alert">{problem}</p>}
      </div>}
    </section>
    {genesis}
  </section>;
}

/** Genesis, read beside the main system: connect, the zone its events need, read now, and what was read (counts only). */
export function GenesisAlsoRead({ also, onAlso, bridge = defaultBridge }: {
  also: AlsoRead | null; onAlso: (next: AlsoRead | null) => void; bridge?: Bridge;
}) {
  const [connecting, setConnecting] = useState(false);
  const [capture, setCapture] = useState<SystemCapture | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const asking = useKeychainAsking(working);
  const read = (a: AlsoRead) => {
    setWorking(true); setProblem(null);
    void bridge.check("genesis", a.church_id, null, a.zone).then(r => {
      const parsed = r.capture ? parseSystemCaptureText(r.capture) : null;
      if (r.outcome === "ok" && parsed?.ok) setCapture(parsed.capture);
      else setProblem(readProblemText("genesis", r.outcome === "ok" ? "invalid-response" : r.outcome));
    }).finally(() => setWorking(false));
  };
  // Read only when the person asks, or right after they give the zone: never just because Settings was opened (review L6).
  const words = CONNECT.genesis;
  if (!also) return <section className="find" aria-labelledby="genesis-title">
    <h3 id="genesis-title" className="settings-t">Also read Genesis: groups, events and forms</h3>
    <p className="find-body">{words.reads} {HOST_SENTENCE.genesis}</p>
    <ul className="list">{words.cantSee.map(line => <li key={line}>{line}</li>)}</ul>
    {!connecting && <div className="row form-actions"><button type="button" className="btn btn-secondary" onClick={() => setConnecting(true)}>Connect Genesis</button></div>}
    {connecting && <SystemConnect system="genesis" step={null} connect={(address, how) => bridge.connect("genesis", address, how)}
      onConnected={church => { setConnecting(false); onAlso({ system: "genesis", church_id: church.id, church_name: church.name, zone: null }); }}
      onBack={() => setConnecting(false)} backLabel="Cancel" />}
  </section>;
  return <section className="find" aria-labelledby="genesis-title">
    <h3 id="genesis-title" className="settings-t">Also read Genesis</h3>
    <p className="find-body">Ozzie also reads {also.church_name ?? "your church"} in Genesis: groups, events and forms only. {HOST_SENTENCE.genesis}</p>
    {!also.zone && <TimeZoneQuestion system="genesis" systemZone={null} startsAt={null} onConfirm={zone => { const next = { ...also, zone }; onAlso(next); read(next); }} />}
    <div className="row form-actions">
      {also.zone && <button type="button" className="btn btn-secondary" disabled={working} onClick={() => read(also)}>{working ? "Reading Genesis…" : "Read Genesis now"}</button>}
      <button type="button" className="btn btn-quiet" disabled={working} onClick={() => {
        void bridge.forget("genesis", also.church_id).then(word => { if (word === "forgotten") { setCapture(null); onAlso(null); } else setProblem("This Mac didn't let Ozzie remove the Genesis key just now. Unlock this Mac, then try again."); });
      }}>Stop reading Genesis and forget its key</button>
    </div>
    {asking && <p className="small" role="status">{keychainAsking("Genesis")}</p>}
    {problem && <p className="problem" role="alert">{problem}</p>}
    {capture && <SystemFactsList capture={capture} zone={also.zone} />}
  </section>;
}

/** Up to `max` of `items`, with "Show all N" when there are more (round 4: lists of twenty were shown whole). */
function Capped<T>({ items, max, render, wrap = false }: { items: readonly T[]; max: number; render: (item: T) => ReactNode; wrap?: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, max);
  const more = items.length > max && <button type="button" className="btn btn-quiet btn-sm btn-flush" aria-expanded={all} onClick={() => setAll(!all)}>
    {all ? "Show fewer" : `Show all ${items.length}`}</button>;
  // A list of names only (nothing else known about each): one wrapped line, never a row each.
  if (wrap) return <p className="small">{shown.map((item, i) => <Fragment key={i}>{i > 0 && ", "}{render(item)}</Fragment>)}{!all && items.length > max ? ", …" : ""} {more}</p>;
  return <>{<ul className="list">{shown.map((item, i) => <li key={i}>{render(item)}</li>)}</ul>}{more}</>;
}

/**
 * Why some counts in one part are missing, said once for the part, never beside each item (round 4: "Elders: Ozzie
 * doesn't read this number from Breeze yet." ten times). Closed sentences.
 */
export function limitSentence(system: SystemId, part: "groups" | "events" | "forms", why: NullCount): string {
  const name = SYSTEMS[system].name;
  switch (`${part}:${why}`) {
    case "groups:not-read-yet": return system === "breeze" ? "Ozzie doesn't read how many people have each tag from Breeze yet." : `Ozzie doesn't read how many people are in each group from ${name} yet.`;
    case "groups:not-given": return `${name} doesn't share how many people are in each group.`;
    case "events:not-read-yet": return system === "breeze" ? "Ozzie counts the people checked in by name only for the service it watches, once it has ended."
      : `Ozzie doesn't read attendance from ${name} yet.`;
    case "events:not-given": return `${name} doesn't share attendance for these events.`;
    case "events:not-ended": return "The service hasn't ended yet, so its check-ins aren't counted.";
    case "events:no-end-time": return `${name} gives the service no end time, so Ozzie doesn't count the people checked in to it.`;
    case "forms:not-in-newest": return system === "breeze" ? "Ozzie counts entries for the 5 newest Breeze forms." : `Ozzie counts entries for the newest forms from ${name} only.`;
    case "forms:not-read-yet": return system === "b1" ? "Ozzie doesn't read how many times a B1 Church form was filled in: B1 shares that only with a key that can make changes."
      : `Ozzie doesn't read how many times a form was filled in from ${name} yet.`;
    case "forms:not-given": return `${name} doesn't share how many times a form was filled in.`;
    default: return part === "groups" ? "Ozzie couldn't check how many people are in some of these this time."
      : part === "events" ? "Ozzie couldn't check attendance for some of these this time." : "Ozzie couldn't check how many times some forms were filled in this time.";
  }
}

/** "10 groups, 20 events in the next four weeks, 20 forms": what a check also read, in one line, never a list of absences. */
export function alsoReadSummary(facts: SystemFacts): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const tags = facts.system === "breeze";
  // A list cut short says "at least", never a count it can't stand behind; B1 Church's forms are always cut (only those
  // the key's maker can manage), so they are "at least" too (review of round 4, L3).
  const part = (outcome: FactOutcome, count: number, one: string, many: string, after = "") =>
    outcome !== "ok" && outcome !== "truncated" ? `${many} not read`
      : `${outcome === "truncated" && count ? "at least " : ""}${n(count, one, many)}${count ? after : ""}`;
  return [
    part(facts.reads.groups.outcome, facts.groups.length, tags ? "tag" : "group", tags ? "tags" : "groups"),
    part(facts.reads.events.outcome, facts.events.length, "event", "events", tags ? " in the next four weeks" : ""),
    part(facts.reads.forms.outcome, facts.forms.length, "form", "forms"),
  ].join(", ");
}

/**
 * What a system's check also read, beside the service: its groups, events and forms, from facts.ts. Only what Ozzie
 * has is listed: a count where it has one, otherwise just the names; why a count is missing is said once for the part
 * (`limitSentence`), and long lists are capped (round 4: thirty-five lines that each said Ozzie didn't know something).
 * Folded behind one line by default (`folded`): it is the least of what a service page holds. The church's own words for
 * each stay on this Mac.
 */
export function SystemFactsList({ capture, zone, folded = true }: { capture: SystemCapture; zone: string | null; folded?: boolean }) {
  const facts = systemFacts(capture, { confirmedZone: zone });
  const labels = labelsOf(capture);
  const system = capture.system;
  const sysName = SYSTEMS[system].name;
  const name = (key: string, fallback: string) => Object.hasOwn(labels, key) ? labels[key]! : fallback;
  // A form's name as the system gave it, or made readable when it is a slug (Genesis: "visitor-connection-card").
  const formName = (id: string) => readableName(name(`form:${id}`, "A form without a name"));
  const line = (outcome: FactOutcome) => readProblem(system, outcome);
  const checked = clock(Date.parse(capture.completed_at));
  // The church's zone as the system gave it, or as the person confirmed it, only when this Mac knows it; else this Mac's.
  // An event with no time of day (Breeze writes it as midnight) says its date only, never 12:00 AM.
  const when = (iso: string) => eventWhen(system, iso, capture.church.time_zone, zone) ?? "a time Ozzie couldn't read";
  // A list read cut short still lists what it read, with one sentence saying so: by design for B1 Church's forms (only
  // those the key's maker can manage), otherwise a read that stopped part way (review of round 4, L3).
  const cut = (part: "groups" | "events" | "forms") => facts.reads[part].outcome === "truncated";
  const cutLine = (part: "groups" | "events" | "forms") => !cut(part) ? null
    : system === "b1" && part === "forms" ? <p className="small">Ozzie sees only the forms the person who made the key can manage.</p>
    : <p className="small">{readProblem(system, "truncated")}</p>;
  const failed = (part: "groups" | "events" | "forms") => cut(part) ? null : line(facts.reads[part].outcome);
  // An event still to come says nothing about attendance, not even why (live check 2026-11-19).
  const limits = (part: "groups" | "events" | "forms", whys: readonly (NullCount | null)[]) =>
    [...new Set(whys.filter((w): w is NullCount => w !== null && w !== "upcoming"))].map(w => <p key={w} className="small">{limitSentence(system, part, w)}</p>);
  const tags = system === "breeze";
  const counted = facts.groups.filter(g => g.members !== null), named = facts.groups.filter(g => g.members === null);
  const formsCounted = facts.forms.filter(f => f.submissions !== null), formsNamed = facts.forms.filter(f => f.submissions === null);
  const body = <div className="stack-tight">
    <p className="checkline evidence"><Icon name="check" small />Live read from {sysName} · checked {checked}</p>
    <h4 className="settings-t">{tags ? "Tags" : "Groups"}</h4>
    {failed("groups") ? <p className="small">{failed("groups")}</p>
      : facts.groups.length === 0 ? <p className="small">None listed.</p>
      : <>
        {cutLine("groups")}
        {counted.length > 0 && <Capped items={counted} max={8} render={g => `${name(`group:${g.group_id}`, "A group without a name")}: ${g.at_least ? "at least " : ""}${g.members} ${g.members === 1 ? "member" : "members"}`} />}
        {named.length > 0 && <Capped wrap items={named} max={12} render={g => name(`group:${g.group_id}`, "A group without a name")} />}
        {limits("groups", named.map(g => g.why_null))}
      </>}
    <h4 className="settings-t">Events{tags ? " in the next four weeks" : ""}</h4>
    {failed("events") ? <p className="small">{failed("events")}</p>
      : facts.events.length === 0 ? <p className="small">None listed.</p>
      : <>
        {cutLine("events")}
        <Capped items={facts.events} max={5} render={e => `${name(`event:${e.event_id}`, "An event without a name")}, ${when(e.starts_at)}${e.attendance !== null
          ? `: ${e.at_least ? "at least " : ""}${e.attendance} ${tags ? "checked in by name" : "attended"}` : ""}`} />
        {limits("events", facts.events.filter(e => e.attendance === null).map(e => e.why_null))}
      </>}
    <h4 className="settings-t">Forms</h4>
    {failed("forms") ? <p className="small">{failed("forms")}</p>
      : facts.forms.length === 0 ? <p className="small">None listed.</p>
      : <>
        {cutLine("forms")}
        {limits("forms", formsNamed.map(f => f.why_null))}
        {formsCounted.length > 0 && <Capped items={formsCounted} max={8} render={f => `${formName(f.form_id)}: ${f.at_least ? "at least " : ""}${f.submissions} ${f.submissions === 1 ? "entry" : "entries"}`} />}
        {formsNamed.length > 0 && <Capped wrap items={formsNamed} max={8} render={f => formName(f.form_id)} />}
      </>}
    <details className="listen-more"><summary><Icon name="chev" small />What Ozzie can't see in {sysName}</summary>
      <ul className="small">{facts.cannot_see.map(l => <li key={l}>{l}</li>)}</ul></details>
  </div>;
  if (!folded) return body;
  return <details className="listen-more"><summary><Icon name="chev" small />Also read from {sysName}: {alsoReadSummary(facts)}</summary>{body}</details>;
}
