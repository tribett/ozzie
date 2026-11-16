// Settings → Calendars: connect Apple Calendar on this Mac and choose which of its calendars Ozzie reads (none until
// chosen), add or remove private calendar links, see when each was last read. Read-only toward every calendar.
//
// A private link's address is typed here once and goes straight to native code (calendars.ts), which keeps it in
// this Mac's Keychain. The field is cleared as soon as it's added, and the page only ever shows the link's label and
// where it points, masked.
import { useId, useState } from "react";
import type { CalendarRead } from "../../../core/src/calendar/events.js";
import { calendarsConnected, useCalendarState, type AppleCalendarChoice, type Calendars, type CalendarState } from "./calendars.js";
import { Icon } from "./icons.js";
import "./calendars.css";

const MAX_LINKS = 8;
const LABEL_MAX = 60;
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

export const CALENDARS_BODY = "Ozzie shows what's on your calendars on Today. It never adds, changes or deletes an event, and what's on your calendars stays on this Mac: it isn't sent to AI help or shared with other AI apps.";
export const CALENDARS_HOW = [
  "Ozzie reads today and the next seven days from the calendars you choose: when it opens, when you open Today after a while, and when you ask it to. What it read is kept only while Ozzie is open.",
  "From each event it reads the title, the time, the place, and whether it's tentative, cancelled or free time. It doesn't read notes or who is invited.",
  "On Today it lists what's coming up and shows when two things are at the same time. A repeating event it can't work out, or a time zone it doesn't know, is labeled worth a look instead of guessed.",
  "What's on your calendars stays on this Mac. It isn't sent to AI help, put in notices, or shared with other AI apps.",
  "A private link's address works like a password. Ozzie keeps it in this Mac's Keychain, never shows it again in full, sends no sign-in with it, and only reads from addresses on the internet that start with https:// or webcal://.",
  "Ozzie only reads. It has no way to add, change or delete anything on a calendar.",
] as const;

/** When a calendar was last read, or why it couldn't be. */
function lastRead(read: CalendarRead | undefined): string {
  if (!read) return "Not read yet since Ozzie opened.";
  return read.problem ? `Couldn't read it at ${clock(read.checked_at)}. ${read.problem}` : `Last read at ${clock(read.checked_at)}.`;
}

function AppleSection({ state, calendars }: { state: CalendarState; calendars: Calendars }) {
  const read = state.reads.find(r => r.source.kind === "apple");
  const groups = new Map<string, AppleCalendarChoice[]>();
  for (const c of state.calendars ?? []) groups.set(c.account ?? "On this Mac", [...(groups.get(c.account ?? "On this Mac") ?? []), c]);
  const toggle = (id: string, on: boolean) => { void calendars.choose(on ? [...state.chosen, id] : state.chosen.filter(c => c !== id)); };
  const access = state.access;
  return <section className="find" aria-labelledby="apple-cal-title">
    <h3 id="apple-cal-title" className="settings-t">Apple Calendar on this Mac</h3>
    <p className="find-body">The calendars in the Calendar app on this Mac, including any iCloud, Google or Exchange accounts added there.</p>
    {access === null && <p className="small">Checking what macOS allows…</p>}
    {access === "not-determined" && <>
      <div className="find-next"><button type="button" className="btn btn-secondary" disabled={state.asking} onClick={() => { void calendars.connectApple(); }}>
        {state.asking ? "Waiting for your answer in macOS…" : "Let Ozzie read my calendar"}</button></div>
      <p className="small">macOS asks once. Choose “Allow Full Access”: macOS calls it full access, but Ozzie only reads.</p>
    </>}
    {access === "denied" && <p className="find-body">macOS says Ozzie can't read your calendars. To change that, open System Settings, then Privacy &amp; Security, then Calendars, and turn on Ozzie.</p>}
    {access === "write-only" && <p className="find-body">Ozzie was given add-only access, which can't read events. In System Settings, Privacy &amp; Security, Calendars, choose Full Access for Ozzie.</p>}
    {access === "restricted" && <p className="find-body">This Mac doesn't allow apps to read calendars (a setting managed for this Mac).</p>}
    {access === "not-available" && <p className="find-body">Apple Calendar can't be read by this copy of Ozzie.</p>}
    {access === "full" && <>
      {state.calendars === null && <p className="small">Ozzie couldn't list the calendars on this Mac just now.</p>}
      {state.calendars?.length === 0 && <p className="small">There are no calendars in the Calendar app on this Mac.</p>}
      {(state.calendars?.length ?? 0) > 0 && <fieldset className="cal-choices">
        <legend>Which calendars Ozzie reads</legend>
        {state.chosen.length === 0 && <p className="small">None until you choose.</p>}
        {[...groups].map(([account, list]) => <div key={account}>
          <p className="cal-account">{account}</p>
          {list.map(c => <label key={c.id} className="confirmation">
            <input type="checkbox" checked={state.chosen.includes(c.id)} onChange={e => toggle(c.id, e.target.checked)} />
            <span>{c.title || "(No name)"}</span>
          </label>)}
        </div>)}
      </fieldset>}
      {state.chosen.length > 0 && <>
        <p className="checkline">{lastRead(read)}</p>
        <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={() => { void calendars.stopApple(); }}>Stop reading Apple Calendar</button></div>
        <p className="small">Ozzie then reads none of these calendars. To take back macOS's permission too, use System Settings, Privacy &amp; Security, Calendars.</p>
      </>}
    </>}
  </section>;
}

function LinkRow({ link, read, calendars }: { link: NonNullable<CalendarState["links"]>[number]; read: CalendarRead | undefined; calendars: Calendars }) {
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const id = useId();
  // An entry this version can't read is shown only so it can be removed (review C2, N1).
  if (link.unusable) return <li className="cal-link">
    <span className="cal-link-t">
      <span className="bold" id={`${id}-label`}>A link this version of Ozzie can't read</span>
      <span className="small">It may have been saved by a newer Ozzie. Ozzie doesn't read it.</span>
    </span>
    {!confirm && <button type="button" className="btn btn-quiet btn-sm" aria-describedby={`${id}-label`} onClick={() => setConfirm(true)}>Remove this link</button>}
    {confirm && <div className="decide" role="group" aria-labelledby={`${id}-q`}>
      <p id={`${id}-q`} className="find-body">Remove this link? Ozzie forgets it and any address saved for it. No calendar changes.</p>
      <div className="find-next">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { setConfirm(false); void calendars.removeLink(link.id).then(setProblem); }}>Yes, remove it</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>Keep it</button>
      </div>
    </div>}
    {problem && <p role="alert" className="problem">{problem}</p>}
  </li>;
  return <li className="cal-link">
    <span className="cal-link-t">
      <span className="bold" id={`${id}-label`}>{link.label}</span>
      <span className="small">{link.shown}</span>
      <span className="small">{link.missing ? "Its address is no longer in this Mac's Keychain. Remove it and add it again." : lastRead(read)}</span>
    </span>
    {!confirm && <button type="button" className="btn btn-quiet btn-sm" aria-describedby={`${id}-label`} onClick={() => setConfirm(true)}>Stop reading this calendar</button>}
    {confirm && <div className="decide" role="group" aria-labelledby={`${id}-q`}>
      <p id={`${id}-q`} className="find-body">Stop reading “{link.label}”? Ozzie forgets its address. The calendar itself doesn't change.</p>
      <div className="find-next">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { setConfirm(false); void calendars.removeLink(link.id).then(setProblem); }}>Yes, forget it</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>Keep it</button>
      </div>
    </div>}
    {problem && <p role="alert" className="problem">{problem}</p>}
  </li>;
}

/** When the list of links can't be read: the one way out, after a confirmation that says what it does. */
function ForgetAll({ calendars }: { calendars: Calendars }) {
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return <>
    {!confirm && <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirm(true)}>Forget all private calendar links</button></div>}
    {confirm && <div className="decide" role="group" aria-labelledby="forget-links-q">
      <p id="forget-links-q" className="find-body">Forget all private calendar links? Ozzie deletes every private calendar address it saved in this Mac's Keychain and starts a new, empty list. The calendars themselves don't change, and you can add links again afterwards.</p>
      <div className="find-next">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => { setConfirm(false); void calendars.forgetAllLinks().then(setProblem); }}>Yes, forget them all</button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>Keep them</button>
      </div>
    </div>}
    {problem && <p role="alert" className="problem">{problem}</p>}
  </>;
}

function LinksSection({ state, calendars }: { state: CalendarState; calendars: Calendars }) {
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const links = state.links ?? [];
  const add = async () => {
    setAdding(true);
    setProblem(null);
    const failed = await calendars.addLink(label, address);
    setAdding(false);
    // The address leaves this page either way once it has been tried: it's typed again rather than kept here.
    setAddress("");
    if (failed) setProblem(failed);
    else setLabel("");
  };
  return <section className="find" aria-labelledby="links-title">
    <h3 id="links-title" className="settings-t">Private calendar links</h3>
    <p className="find-body">Paste the private address of a Google, Outlook or iCloud calendar. Google calls it “Secret address in iCal format”; Outlook calls it the ICS link of a published calendar. The address works like a password, so Ozzie keeps it in this Mac's Keychain and shows only where it points.</p>
    {state.linksProblem && <p role="alert" className="problem">{state.linksProblem}</p>}
    {state.linksUnreadable && <ForgetAll calendars={calendars} />}
    {links.length > 0 && <ul className="cal-links">{links.map(l => <LinkRow key={l.id} link={l} calendars={calendars}
      read={state.reads.find(r => r.source.kind === "link" && r.source.id === l.id)} />)}</ul>}
    {state.linksUnreadable ? null : links.filter(l => !l.unusable).length < MAX_LINKS ? <form className="cal-link-form" onSubmit={e => { e.preventDefault(); void add(); }}>
      <div className="field">
        <label htmlFor="cal-link-label" className="field-l">Name for this calendar</label>
        <input id="cal-link-label" className="input" value={label} maxLength={LABEL_MAX} autoComplete="off" spellCheck={false} placeholder="Church office"
          onChange={e => setLabel(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="cal-link-address" className="field-l">Private address</label>
        <input id="cal-link-address" className="input" type="password" value={address} autoComplete="off" spellCheck={false} placeholder="https://… or webcal://…"
          aria-describedby="cal-link-help" onChange={e => setAddress(e.target.value)} />
        <p id="cal-link-help" className="input-help">Ozzie reads it once to check it's a calendar, then keeps it in this Mac's Keychain.</p>
      </div>
      <div className="row form-actions">
        <button type="submit" className="btn btn-secondary" disabled={adding || !label.trim() || !address.trim()}>{adding ? "Reading it…" : "Add this calendar"}</button>
      </div>
      {problem && <p role="alert" className="problem">{problem}</p>}
    </form> : <p className="small">Ozzie reads up to {MAX_LINKS} private links. Remove one to add another.</p>}
  </section>;
}

/** Settings → Calendars. */
export function CalendarSettings({ calendars }: { calendars: Calendars }) {
  const state = useCalendarState(calendars);
  return <section className="settings-sec" aria-labelledby="calendars-title">
    <h2 id="calendars-title" className="h3">Calendars</h2>
    <p className="banner"><Icon name="lock" small /><span><strong>Reads only.</strong> {CALENDARS_BODY}</span></p>
    <AppleSection state={state} calendars={calendars} />
    <LinksSection state={state} calendars={calendars} />
    <div className="find">
      {calendarsConnected(state) && <div className="find-next">
        <button type="button" className="btn btn-secondary btn-sm" disabled={state.reading} onClick={() => { void calendars.read(); }}>
          {state.reading ? <><Icon name="spinner" small spin />Reading your calendars…</> : "Read my calendars now"}</button>
        {state.readAt && !state.reading && <span className="small">Last read at {clock(state.readAt)}.</span>}
      </div>}
      <details className="listen-more">
        <summary><Icon name="chev" small />See how this works</summary>
        <ul className="small">{CALENDARS_HOW.map(line => <li key={line}>{line}</li>)}</ul>
      </details>
    </div>
  </section>;
}
