// Today's "On your calendar": the leader's own calendars (calendars.ts), today and the next seven days, with two
// things at the same time called out first. Facts only, each with its calendar and when it was read; an overlap with
// a tentative event, an event whose time Ozzie isn't sure of and anything Ozzie couldn't work out are worth a look.
//
// Calendar text is data, never instructions: titles and places are shown as plain text (React escapes them; nothing
// here makes a link from them or reads them as markup), and none of it leaves this Mac (calendars.ts).
import { useId, useMemo, useState } from "react";
import { localDate } from "../../../core/src/church-time.js";
import { calendarView, type CalendarEntry, type CalendarOverlap, type CalendarRead, type CalendarSource } from "../../../core/src/calendar/events.js";
import { Icon } from "./icons.js";
import "./calendars.css";

const DAY_MS = 86_400_000;
const clock = (iso: string, zone: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const list = (items: string[]) => items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** "Today", "Tomorrow", or the weekday and date. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return `Today, ${longDay(date)}`;
  if (date === nextDate(today)) return `Tomorrow, ${longDay(date)}`;
  return longDay(date);
}
/** A calendar as it is named on screen: Apple Calendar on this Mac, or the label the leader typed, in quotes. */
export const sourceName = (s: CalendarSource) => s.kind === "apple" ? s.label : `“${s.label}”`;

/** When an event is, as shown on one day: all day, its times, or the part of it that falls on that day. */
export function timeOnDay(entry: CalendarEntry, date: string, zone: string): string {
  const t = entry.time;
  if (t.all_day) return "All day";
  if (t.start === t.end) return clock(t.start, zone);
  const startsToday = localDate(t.start, zone) === date;
  const endsToday = localDate(Date.parse(t.end) - 1, zone) === date;
  if (startsToday && endsToday) return `${clock(t.start, zone)} – ${clock(t.end, zone)}`;
  if (startsToday) return `From ${clock(t.start, zone)}`;
  if (endsToday) return `Until ${clock(t.end, zone)}`;
  return "All day";
}
const span = (entry: CalendarEntry, zone: string) => entry.time.all_day ? "all day" : `${clock(entry.time.start, zone)} – ${clock(entry.time.end, zone)}`;

/** When each calendar an event came from was read. */
function readTimes(entry: CalendarEntry, reads: readonly CalendarRead[], zone: string): string {
  return list(entry.sources.map(s => {
    const read = reads.find(r => r.source.kind === s.kind && r.source.id === s.id);
    return `${sourceName(s)}${read ? `, read ${clock(read.checked_at, zone)}` : ""}`;
  }));
}

function OverlapCard({ overlap, reads, today, zone }: { overlap: CalendarOverlap; reads: readonly CalendarRead[]; today: string; zone: string }) {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const { first, second } = overlap;
  const look = overlap.tone === "look";
  return <article className="find cal-overlap" aria-labelledby={titleId}>
    <div className="find-top">
      <span className={`badge ${look ? "b-look" : "b-attn"}`}><Icon name={look ? "eye" : "flag"} small />{look ? "Worth a look" : "Needs a decision"}</span>
      <span className="find-where">{dayLabel(overlap.date, today)} · {clock(overlap.starts_at, zone)} – {clock(overlap.ends_at, zone)}</span>
    </div>
    <h3 id={titleId} className="find-title">Two things at the same time</h3>
    <p className="find-body">“{first.title}” ({span(first, zone)}) and “{second.title}” ({span(second, zone)}) overlap from {clock(overlap.starts_at, zone)} to {clock(overlap.ends_at, zone)}.{overlap.reason ? ` ${overlap.reason}` : ""}</p>
    <div className="find-src">
      <button type="button" className="btn btn-quiet btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="info" small /> Why I flagged this</button>
      <span>{list([...new Set([...first.sources, ...second.sources].map(sourceName))])}</span>
      {open && <ul className="list why">
        <li><Icon name="dot" small />Rule: two events with times on your calendars overlap, and neither is marked free or cancelled.</li>
        <li><Icon name="dot" small />“{first.title}”, {span(first, zone)}: from {readTimes(first, reads, zone)}.</li>
        <li><Icon name="dot" small />“{second.title}”, {span(second, zone)}: from {readTimes(second, reads, zone)}.</li>
        <li><Icon name="dot" small />I only read your calendars. Nothing was changed on either one.</li>
      </ul>}
    </div>
  </article>;
}

function EventLine({ entry, date, zone, now, many }: { entry: CalendarEntry; date: string; zone: string; now: string; many: boolean }) {
  const over = !entry.time.all_day && Date.parse(entry.time.end) <= Date.parse(now) && entry.time.start !== entry.time.end;
  return <li className={`cal-ev${over ? " cal-over" : ""}${entry.status === "cancelled" ? " cal-cancelled" : ""}`}>
    <span className="cal-time">{timeOnDay(entry, date, zone)}</span>
    <span className="cal-what">
      <span className="cal-title">{entry.title}</span>
      {entry.location && <span className="cal-where"> · {entry.location}</span>}
      {entry.status === "tentative" && <span className="badge b-muted cal-tag">Tentative</span>}
      {entry.status === "cancelled" && <span className="badge b-muted cal-tag">Cancelled</span>}
      {entry.free && entry.status !== "cancelled" && <span className="badge b-muted cal-tag">Free</span>}
      {over && <span className="sr-only"> (over)</span>}
      {entry.uncertain && <span className="cal-unsure"><span className="badge b-look cal-tag"><Icon name="eye" small />Worth a look</span> {entry.uncertain}</span>}
      {many && <span className="cal-from">{list(entry.sources.map(sourceName))}</span>}
    </span>
  </li>;
}

/** "On your calendar" on Today. `reads`: the latest read of each connected calendar (calendars.ts). */
export function CalendarGroup({ reads, now, zone, reading = false, onSettings }: {
  reads: readonly CalendarRead[]; now: string; zone: string; reading?: boolean; onSettings?: (() => void) | undefined;
}) {
  // Worked out again each minute, not on every tick of Today's clock.
  const minute = new Date(Math.floor(Date.parse(now) / 60_000) * 60_000).toISOString();
  const view = useMemo(() => calendarView(reads, minute, zone), [reads, minute, zone]);
  const today = view.dates[0] ?? localDate(now, zone);
  const count = new Set(view.days.flatMap(d => d.entries.map(e => e.key))).size;
  const many = reads.length > 1;
  const empty = view.days.filter(d => d.entries.length === 0 && d.date !== today).map(d => weekday(d.date));
  const read = view.reads.filter(r => !r.problem);
  const failed = view.reads.filter(r => r.problem);
  const cut = view.reads.filter(r => r.truncated);
  return <section className="today-group today-calendar" aria-labelledby="today-group-calendar">
    <h2 id="today-group-calendar" className="h3 today-group-h">On your calendar
      <span className="today-count">{count === 1 ? "1 event" : `${count} events`}</span></h2>

    {view.overlaps.map(o => <OverlapCard key={o.id} overlap={o} reads={reads} today={today} zone={zone} />)}
    {view.overlaps_cut && <p className="small">More things overlap than Ozzie shows here. Your calendar has them all.</p>}

    <div className="find cal-days">
      {reads.length === 0 && <p className="find-body">{reading ? "Reading your calendars…" : "Nothing read from your calendars yet."}</p>}
      {reads.length > 0 && count === 0 && failed.length < reads.length && <p className="find-body">Nothing on your calendars today or in the next seven days.</p>}
      {view.days.filter(d => d.entries.length > 0 || (d.date === today && count > 0)).map(day => <div key={day.date} className="cal-day">
        <h3 className="cal-day-h">{dayLabel(day.date, today)}</h3>
        {day.entries.length
          ? <ul className="cal-list">{day.entries.map(e => <EventLine key={e.key} entry={e} date={day.date} zone={zone} now={now} many={many} />)}</ul>
          : <p className="small">Nothing on your calendar today.</p>}
      </div>)}
      {count > 0 && empty.length > 0 && <p className="small">Nothing on your calendar {list(empty)}.</p>}
    </div>

    {view.looks.length > 0 && <div className="find cal-looks">
      <div className="find-top"><span className="badge b-look"><Icon name="eye" small />Worth a look</span></div>
      <ul className="list">{view.looks.map((l, i) => <li key={`${l.source.id}-${i}`}><Icon name="dot" small />
        <span>{l.title === null ? <>On {sourceName(l.source)}: {l.reason}</> : <>“{l.title}” on {sourceName(l.source)}: {l.reason}</>}</span></li>)}</ul>
    </div>}

    {failed.map(r => <p key={`${r.source.kind}-${r.source.id}`} className="problem" role="status">
      Couldn't read {sourceName(r.source)} at {clock(r.checked_at, zone)}. {r.problem}
      {onSettings && <> <button type="button" className="btn btn-quiet btn-sm" onClick={onSettings}>Open Settings</button></>}</p>)}
    {cut.map(r => <p key={`cut-${r.source.kind}-${r.source.id}`} className="small">{sourceName(r.source)} has more these days than Ozzie shows; the calendar itself has them all.</p>)}

    {read.length > 0 && <p className="small cal-read">Read from {list(read.map(r => `${sourceName(r.source)} at ${clock(r.checked_at, zone)}`))}. Ozzie only reads your calendars, and what's on them stays on this Mac.</p>}
    <details className="listen-more">
      <summary><Icon name="chev" small />See how this works</summary>
      <ul className="small">{TODAY_HOW.map(line => <li key={line}>{line}</li>)}</ul>
    </details>
  </section>;
}

export const TODAY_HOW = [
  "Ozzie reads the calendars you chose in Settings for today and the next seven days: each event's title, time, place, and whether it's tentative, cancelled or free time. It doesn't read notes or who is invited.",
  "Two things at the same time: two events with times that overlap, when neither is marked free or cancelled. If one is tentative, it's worth a look.",
  "A repeating event Ozzie can't work out, or a time zone it doesn't know, is labeled worth a look instead of guessed.",
  "What's on your calendars stays on this Mac. It isn't sent to AI help, put in notices, or shared with other AI apps, and Ozzie never changes a calendar.",
] as const;
