// People forms, Check-Ins and Registrations on Today, Sunday and Church rules. Facts come from
// core/src/church-reads (pure); this file only shows them, each with its source and check time and
// "This isn't right". Only a card where something was flagged says "Why I flagged this"; a plain fact
// says "Where this comes from". Names (whom a form is for; form, room and signup names) are resolved
// on this Mac and are never sent anywhere. Nothing here can change Planning Center.
import { useMemo, useState } from "react";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import {
  checkInsFacts, checkInsTarget, formsFacts, formTarget, registrationsFacts, signupTarget, checkInsEvent, formsOn, roomMatches, watchedForms,
  withCheckInsEvent, withFormsOn, withRoomMatch, withWatchedForm, type CheckInsTime, type FormFact, type RoomRuleFact, type SignupFact,
} from "../../../core/src/church-reads/index.js";
import { kidsTeams } from "../../../core/src/kids-rules.js";
import { FindingFeedback, useFeedback, type FeedbackControls, type FeedbackSource } from "./finding-feedback.js";
import { granted, type ConnectionStatus } from "./connection.js";
import { Icon } from "./icons.js";
import { teamLabel, useTeamServices } from "./team-labels.js";

type Names = Readonly<Record<string, string>>;
const macZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const stamp = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The three church reads' facts for one check; each null when its product wasn't part of the check. */
export function useChurchFacts(capture: SundayCapture | null | undefined, rules: SundayRules, now?: string) {
  return useMemo(() => {
    if (!capture) return { checkIns: null, forms: null, registrations: null };
    const zone = macZone();
    return {
      checkIns: checkInsFacts(capture, rules, now ? { now } : {}),
      forms: formsFacts(capture, rules, { zone }),
      registrations: registrationsFacts(capture, rules, { ...(now ? { now } : {}), zone }),
    };
  }, [capture, rules, now]);
}

/** The source row. `flagged`: "Why I flagged this" on a card that flags something; otherwise "Where this comes from". */
function Source({ source, at, open, onToggle, flagged = false }: { source: string; at: string | null; open: boolean; onToggle: () => void; flagged?: boolean }) {
  return <>
    <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={onToggle}><Icon name="info" small /> {flagged ? "Why I flagged this" : "Where this comes from"}</button>
    <span className="badge b-muted">{source}</span>
    {at && <span>Checked {stamp(at)}</span>}
  </>;
}

/**
 * A Check-Ins room the leader matched to a kids team (or that shares its name) with fewer volunteers checked in than
 * the rule's number. Always Worth a look: it sets a count of check-ins beside a rule about confirmed team members.
 */
export function RoomRuleCard({ fact, feedback }: { fact: RoomRuleFact; feedback: FeedbackControls | null }) {
  const [open, setOpen] = useState(false);
  const titleId = `checkins-${fact.id.replace(/[^\w-]/gu, "-")}`;
  return <article className="find worth" aria-labelledby={titleId}>
    <div className="find-top">
      <span className="badge b-look"><Icon name="info" small />Worth a look</span>
      <span className="find-where">{fact.room ?? "A room"} · {fact.clock}</span>
    </div>
    <h3 id={titleId} className="find-title">{fact.title}</h3>
    <p className="find-body">{fact.why[0]} {fact.why[4]}</p>
    <div className="find-src">
      <Source source={fact.source} at={fact.checked_at} open={open} onToggle={() => setOpen(!open)} flagged />
      {open && <ul className="list why">{fact.why.map(w => <li key={w}><Icon name="dot" small />{w}</li>)}</ul>}
    </div>
    <FindingFeedback target={checkInsTarget(fact)} feedback={feedback} urgency={false} occasion="for that Sunday" source="Check-Ins" />
  </article>;
}

/**
 * One Sunday's counts per room and time, as Planning Center Check-Ins records them. `soFar`: a Sunday still under way,
 * whose counts are still changing and are never set beside a rule.
 */
function CheckInsCountsCard({ day, on, times, source, at, soFar = false, asOf = "", over = false }: {
  day: string; on: string; times: CheckInsTime[]; source: string; at: string | null; soFar?: boolean;
  /** A Sunday under way: when Check-Ins was read, and whether that Sunday is over by now. */
  asOf?: string; over?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = soFar ? "checkins-so-far" : "checkins-counts";
  return <article className="find" aria-labelledby={id}>
    <div className="find-top">{soFar ? <span className="badge b-muted"><Icon name="clock" small />{on === "today" ? "Today" : day} so far, as of {asOf}</span>
      : <span className="badge b-muted"><Icon name="check" small />{day}</span>}</div>
    <h3 id={id} className="find-title">How many checked in, by room</h3>
    {soFar && <p className="find-body">{over ? "This Sunday is over now. Check again for the finished counts."
      : "This Sunday isn't over, so these counts are still changing."}</p>}
    {times.map(t => <div key={t.event_time_id} className="stack-tight checkins-time">
      <p className="bold">{t.clock}{t.event ? ` · ${t.event}` : ""}</p>
      {t.rooms.length ? <ul className="list">{t.rooms.map(r => <li key={r.location_id}><Icon name="dot" small />{r.line}</li>)}</ul>
        : <p className="small">No room counts were read for this time.</p>}
    </div>)}
    <div className="find-src">
      <Source source={source} at={at} open={open} onToggle={() => setOpen(!open)} />
      {open && <ul className="list why">
        <li><Icon name="dot" small />These are the counts Planning Center Check-Ins keeps for each room at each time: regular, guest and volunteer check-ins.</li>
        {soFar && <li><Icon name="dot" small />Ozzie read these at {asOf}, before this Sunday was over. It sets a Sunday beside your kids rules only from counts read after it's over.</li>}
        <li><Icon name="dot" small />Ozzie reads only these counts. It never reads who checked in, and it never reads a child's name.</li>
      </ul>}
    </div>
  </article>;
}

function FormCard({ fact, names, feedback }: { fact: FormFact; names: Names; feedback: FeedbackControls | null }) {
  const [open, setOpen] = useState(false);
  const titleId = `form-${fact.form_id}`;
  // Planning Center's submission names whom it's for, who isn't always who sent it (a parent can submit for a child).
  const who = [...new Set(fact.submitters.map(id => (Object.hasOwn(names, id) && names[id]) || "someone not named here"))];
  const more = fact.unnamed ? [`${fact.unnamed} more not named here`] : [];
  return <article className="find" aria-labelledby={titleId}>
    <div className="find-top"><span className="badge b-muted"><Icon name="check" small />New submissions</span><span className="find-where">{fact.name ?? "A form you watch"}</span></div>
    <h3 id={titleId} className="find-title">{fact.title}</h3>
    {who.length + more.length > 0 && <details className="listen-more"><summary><Icon name="chev" small />Who they're for</summary>
      <p className="find-body">{list([...who, ...more])}</p></details>}
    <div className="find-src">
      <Source source={fact.source} at={fact.checked_at} open={open} onToggle={() => setOpen(!open)} />
      {open && <ul className="list why">
        <li><Icon name="dot" small />You asked Ozzie to watch this form on Church rules.</li>
        <li><Icon name="dot" small />Planning Center People shows {fact.at_least ? "at least " : ""}{fact.count} {fact.count === 1 ? "submission" : "submissions"} created since {fact.since_words}{fact.at_least ? "; there were more than Ozzie reads at once" : ""}.</li>
        <li><Icon name="dot" small />Ozzie reads when each was sent and whom it's for, never the answers. A child's name is never kept. Names stay on this Mac.</li>
      </ul>}
    </div>
    <FindingFeedback target={formTarget(fact)} feedback={feedback} urgency={false} occasion="while the same submissions stand" source="the submissions" />
  </article>;
}

function SignupCard({ fact, feedback }: { fact: SignupFact; feedback: FeedbackControls | null }) {
  const [open, setOpen] = useState(false);
  const titleId = `signup-${fact.signup_id}`;
  return <article className="find" aria-labelledby={titleId}>
    <div className="find-top"><span className={`badge ${fact.full ? "b-attn" : "b-muted"}`}><Icon name="check" small />{fact.state === "open" ? fact.full ? "Full" : "Open signup" : "Opens later"}</span>
      <span className="find-where">{fact.name ?? "A signup"}</span></div>
    <h3 id={titleId} className="find-title">{fact.title}</h3>
    <div className="find-src">
      <Source source={fact.source} at={fact.checked_at} open={open} onToggle={() => setOpen(!open)} />
      {open && <ul className="list why">
        <li><Icon name="dot" small />This signup is {fact.state === "open" ? "taking registrations" : "set to open later"} in Planning Center Registrations.</li>
        {fact.registered !== null && <li><Icon name="dot" small />Ozzie counted {fact.at_least ? "at least " : ""}{fact.registered} active {fact.registered === 1 ? "registration" : "registrations"}{typeof fact.limit === "number" ? ` against the signup's limit of ${fact.limit}` : ""}. Canceled and waitlisted ones aren't counted.</li>}
        <li><Icon name="dot" small />Ozzie reads only counts and dates. It never reads who registered.</li>
      </ul>}
    </div>
    <FindingFeedback target={signupTarget(fact)} feedback={feedback} urgency={false} occasion="while these numbers stay the same" source="Planning Center" />
  </article>;
}

/** Today: the church reads that were part of the check, after the three groups. Nothing when none were. */
export function ChurchReadsToday({ capture, rules, names = {}, feedback = null, now }: {
  capture: SundayCapture | null | undefined; rules: SundayRules; names?: Names | undefined; feedback?: FeedbackSource | null; now?: string;
}) {
  const facts = useChurchFacts(capture, rules, now);
  const { controls, notice } = useFeedback(feedback, names);
  const { checkIns, forms, registrations } = facts;
  if (!checkIns && !forms && !registrations) return null;
  const notChecked = [...(checkIns?.not_checked ?? []), ...(forms?.not_checked ?? []), ...(registrations?.not_checked ?? [])];
  const nothing = !checkIns?.below.length && !checkIns?.times.length && !checkIns?.so_far && !forms?.forms.length && !registrations?.signups.length;
  return <section className="today-group today-church" aria-labelledby="today-church">
    <h2 id="today-church" className="h3 today-group-h">From Planning Center this week</h2>
    {notice}
    {checkIns?.below.map(f => <RoomRuleCard key={f.id} fact={f} feedback={controls} />)}
    {checkIns?.so_far && checkIns.so_far.times.length > 0 && <CheckInsCountsCard day={checkIns.so_far.sunday_words} on={checkIns.so_far.on} times={checkIns.so_far.times}
      source={checkIns.source} at={checkIns.checked_at} soFar asOf={checkIns.so_far.as_of} over={checkIns.so_far.over} />}
    {checkIns && checkIns.sunday_words && checkIns.times.length > 0 && <CheckInsCountsCard day={checkIns.sunday_words} on={checkIns.on ?? ""} times={checkIns.times}
      source={checkIns.source} at={checkIns.checked_at} />}
    {forms?.forms.map(f => <FormCard key={f.form_id} fact={f} names={names} feedback={controls} />)}
    {registrations?.signups.map(s => <SignupCard key={s.signup_id} fact={s} feedback={controls} />)}
    {nothing && !notChecked.length && <p className="today-empty">Nothing new from forms, check-ins or signups in this check.</p>}
    {notChecked.length > 0 && <div className="notchecked">
      <h3 className="bold">What I didn't check</h3>
      <ul className="list">{notChecked.map(n => <li key={n}><Icon name="dot" small />{n}</li>)}</ul>
    </div>}
  </section>;
}

/** Sunday: the most recent finished Sunday's Check-Ins set beside the kids rules, when Check-Ins was part of the check. */
export function CheckInsSunday({ capture, rules, names = {}, feedback = null, now }: {
  capture: SundayCapture | null | undefined; rules: SundayRules; names?: Names; feedback?: FeedbackSource | null; now?: string;
}) {
  const facts = useChurchFacts(capture, rules, now).checkIns;
  const { controls } = useFeedback(feedback, names);
  if (!facts || !kidsTeams(rules).length) return null;
  return <section className="stack" aria-labelledby="sunday-checkins">
    <h2 id="sunday-checkins" className="h3">{facts.on ? `Check-Ins ${facts.on}` : "Check-Ins"}</h2>
    <p className="small">After the fact: how many volunteers checked in to the rooms you matched to a kids team, beside that team's rule. Matching is on Church rules.</p>
    {facts.below.map(f => <RoomRuleCard key={f.id} fact={f} feedback={controls} />)}
    {/* Only when every matched room was compared in full and met its number, with nothing set aside. */}
    {facts.held && <p className="small"><Icon name="check" small /> Each room you matched showed at least as many volunteers checked in as its kids rule's number {facts.on}.</p>}
    {facts.so_far && <p className="small"><Icon name="clock" small /> {facts.so_far.over
      ? `${facts.so_far.on === "today" ? "Today" : facts.so_far.sunday_words} was read at ${facts.so_far.as_of}, before it was over. Check again for the finished counts.`
      : `${facts.so_far.on === "today" ? "Today" : facts.so_far.sunday_words} isn't over yet, so its counts are still changing and aren't set beside your rules.`}</p>}
    {facts.not_checked.length > 0 && <ul className="list">{facts.not_checked.map(n => <li key={n}><Icon name="dot" small />{n}</li>)}</ul>}
  </section>;
}

/** Church rules: which forms to watch, and which Check-Ins room each kids team uses. Ids only are saved. */
export function ChurchReadsRules({ rules, onChange, capture, status }: {
  rules: SundayRules; onChange: (r: SundayRules) => void; capture: SundayCapture | null | undefined; status: ConnectionStatus | null;
}) {
  const facts = useChurchFacts(capture, rules);
  const g = granted(status);
  const on = formsOn(rules), watched = watchedForms(rules);
  const listed = facts.forms?.listed ?? [];
  const teams = kidsTeams(rules);
  // With more than one service watched, each kids team says its service, so two with the same roles are told apart.
  const services = useTeamServices();
  const matches = roomMatches(rules);
  const rooms = facts.checkIns?.rooms ?? [];
  const events = facts.checkIns?.events ?? [];
  const roomFor = (team: string) => matches.find(m => m.team_id === team)?.location_id ?? "";
  const setRoom = (team: string, location: string) => {
    let next = rules;
    for (const m of matches.filter(m => m.team_id === team)) next = withRoomMatch(next, m.location_id, null);
    onChange(location ? withRoomMatch(next, location, team) : next);
  };
  return <>
    <section className="find rule-forms" aria-labelledby="forms-rules-title">
      <h2 id="forms-rules-title" className="h3">People forms</h2>
      <p className="find-body">Choose forms to watch, and Ozzie tells you how many new submissions came in on each, and whom each is for. It never reads the answers.</p>
      <label className="confirmation" htmlFor="forms-on">
        <input id="forms-on" type="checkbox" checked={on} onChange={e => onChange(withFormsOn(rules, e.target.checked))} />
        <span>Watch People forms for new submissions</span>
      </label>
      {on && g && !g.operations && <p className="small">This needs People in your Planning Center connection: turn on rooms, follow-ups and group events in Settings.</p>}
      {on && !listed.length && <p className="small">Your forms show here after the next check.</p>}
      {on && listed.map(f => <label key={f.form_id} className="confirmation" htmlFor={`form-${f.form_id}`}>
        <input id={`form-${f.form_id}`} type="checkbox" checked={watched.includes(f.form_id)}
          disabled={!watched.includes(f.form_id) && watched.length >= 10} onChange={e => onChange(withWatchedForm(rules, f.form_id, e.target.checked))} />
        <span>{f.name ?? "Unnamed form"}</span>
      </label>)}
      {on && watched.filter(id => listed.length && !listed.some(f => f.form_id === id)).map(id => <div key={id} className="row rule-row">
        <span className="small">A form you watch isn't in the last check's list.</span>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange(withWatchedForm(rules, id, false))}>Stop watching it</button>
      </div>)}
    </section>
    <section className="find rule-checkins" aria-labelledby="checkins-rules-title">
      <h2 id="checkins-rules-title" className="h3">Check-Ins rooms</h2>
      <p className="find-body">Match the Check-Ins room each kids team uses, and Ozzie compares last Sunday's volunteer count in that room with the team's rule. Ozzie never matches a room for you; a room that only shares a team's name shows as Worth a look.</p>
      {!facts.checkIns && <p className="small">{g?.checkIns ? "Your Check-Ins rooms show here after the next check." : "Check-Ins isn't connected yet. Allow it in Settings to match rooms."}</p>}
      {facts.checkIns && events.length > 1 && <div className="row rule-row">
        <label htmlFor="checkins-event">Read last Sunday from</label>
        <select id="checkins-event" className="input" value={checkInsEvent(rules) ?? ""} onChange={e => onChange(withCheckInsEvent(rules, e.target.value || null))}>
          <option value="">Every Check-Ins event</option>
          {events.map(e => <option key={e.event_id} value={e.event_id}>{e.name ?? "Unnamed event"}</option>)}
        </select>
      </div>}
      {facts.checkIns && !teams.length && <p className="small">Mark a kids team above to compare a Check-Ins room with it.</p>}
      {facts.checkIns && teams.map(t => <div key={t.team_id} className="row rule-row">
        <label htmlFor={`checkins-room-${t.team_id}`}>{t.name ? teamLabel(t.name, t.team_id, services) : "A kids team"}</label>
        <select id={`checkins-room-${t.team_id}`} className="input" value={roomFor(t.team_id)} onChange={e => setRoom(t.team_id, e.target.value)}>
          <option value="">Not matched</option>
          {rooms.map(r => <option key={r.location_id} value={r.location_id}>{r.name ?? "Unnamed room"}{events.length > 1 && r.event ? ` (${r.event})` : ""}</option>)}
        </select>
      </div>)}
    </section>
  </>;
}
