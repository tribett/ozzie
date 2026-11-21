// "Which services Ozzie watches" (owner decision 2026-11-19): the services Ozzie watches besides the one first run chose,
// with "Watch another service" to add one and "Stop watching" to remove one after saying what that forgets. On Settings
// and on the Services page. Planning Center only; names are Planning Center's own service names, shown on this Mac only.
// Nothing here reads Planning Center except the list of services (`pick`, the same list setup reads) when the person asks.
import { useState } from "react";
import { Icon } from "./icons.js";
import { dayWords } from "../../../core/src/service-day.js";
import { choicesProblem } from "./sunday-source.js";
import { MAX_WATCHED, type AlsoWatched, type ServiceChoice } from "./watched-services.js";
import type { ServicePick } from "./onboarding-bridge.js";

export const WATCH_ANOTHER = "Watch another service";
/** Said beside the list: what watching more than one service does. */
export const WATCH_MORE_LINE = `Ozzie can watch up to ${MAX_WATCHED} of your church's services at once. Each one's next plan is read at every check, and the Services page shows them together.`;
export const STOP_WATCHING = "Stop watching";
/** What stopping forgets, said before it happens. */
export const stopQuestion = (name: string) =>
  `Stop watching ${name}? Ozzie forgets its saved checks and your decisions for it on this Mac. Planning Center doesn't change.`;
const named = (name: string | null) => name ?? "Your service";
/** "Wednesday, November 25", the day a plan is on, from what is known of it. */
const planDay = (p: { sort_date: string | null; times: readonly string[] }, zone: string | null) => dayWords({ sort_date: p.sort_date, times: p.times }, zone).date;

export function WatchedServices({ mainName, mainTypeId, also, connected, zone, pick, onAdd, onRemove, onMainName }: {
  /** The service first run chose (Settings' own), by its name when known. */
  mainName: string | null;
  /**
   * That service's name as the list of services just read it, when it wasn't known (a plan chosen in Settings' picker),
   * with the service type it is the name of (the one watched when the list was asked for).
   */
  onMainName?: ((name: string, serviceTypeId: string) => void) | undefined;
  mainTypeId: string;
  also: readonly AlsoWatched[];
  /** Whether Planning Center is connected, so the list of services can be read. */
  connected: boolean;
  zone: string | null;
  /** The church's services, each with its next plan (onboarding-bridge.ts `pickService`). */
  pick: () => Promise<ServicePick>;
  onAdd: (choice: ServiceChoice) => void;
  /** Forgets that service's saved checks and decisions, then stops watching it; a refusal says why. */
  onRemove: (serviceTypeId: string) => Promise<string | null>;
}) {
  const [choosing, setChoosing] = useState(false);
  const [choices, setChoices] = useState<ServiceChoice[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const full = also.length + 1 >= MAX_WATCHED;
  const open = () => {
    setChoosing(true); setChoices(null); setProblem(null);
    const typeAsked = mainTypeId;
    pick().then(p => {
      const main = p.services.find(s => s.id === typeAsked)?.name?.trim();
      if (!mainName && main) onMainName?.(main, typeAsked);
      return p;
    }).then(p => setChoices(p.services.filter(s => s.id !== mainTypeId && !also.some(a => a.serviceTypeId === s.id))
      .map(s => ({ serviceTypeId: s.id, name: s.name, plan: s.next ? { id: s.next.id, sort_date: s.next.sort_date, times: s.next.times } : null }))),
    error => setProblem(choicesProblem(error)));
  };
  const remove = (id: string) => {
    setRemoving(true);
    void onRemove(id).then(refused => { setProblem(refused); if (!refused) setConfirm(null); }).finally(() => setRemoving(false));
  };
  return <div className="stack-tight watched-services">
    <p className="find-body">{WATCH_MORE_LINE}</p>
    <ul className="list">
      <li><Icon name="check" small /><span>{named(mainName)}{" "}<span className="small">(the first one Ozzie watches)</span></span></li>
      {also.map(s => <li key={s.serviceTypeId}><Icon name="check" small />
        <span>{named(s.name)}{planDay(s, s.zone ?? zone) ? <span className="small"> · next: {planDay(s, s.zone ?? zone)}</span> : null}</span>
        {confirm !== s.serviceTypeId && <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setConfirm(s.serviceTypeId); setProblem(null); }}>{STOP_WATCHING}</button>}
        {confirm === s.serviceTypeId && <span className="decide" role="group" aria-label={`${STOP_WATCHING} ${named(s.name)}`}>
          <span className="find-body">{stopQuestion(named(s.name))}</span>
          <button type="button" className="btn btn-forget btn-sm" disabled={removing} onClick={() => remove(s.serviceTypeId)}>Yes, stop watching it</button>
          <button type="button" className="btn btn-quiet btn-sm" disabled={removing} onClick={() => setConfirm(null)}>Keep watching it</button>
        </span>}
      </li>)}
    </ul>
    {/* Offered while the church is connected: the list of services is read from Planning Center when it is pressed. */}
    {!choosing && connected && <div className="find-next">
      <button type="button" className="btn btn-secondary btn-sm" disabled={full} onClick={open}>{WATCH_ANOTHER}</button>
      {full && <span className="small">Ozzie is watching {MAX_WATCHED} services, as many as it can.</span>}
    </div>}
    {choosing && <div className="stack-tight" role="group" aria-label={WATCH_ANOTHER}>
      {!choices && !problem && <p className="small" role="status"><Icon name="spinner" small spin />Looking for your church's services…</p>}
      {choices && choices.length === 0 && <p className="small" role="status">Every other service in Planning Center is already watched, or Planning Center lists no other service.</p>}
      {choices && choices.length > 0 && <ul className="list">{choices.map(c => <li key={c.serviceTypeId}><Icon name="dot" small />
        <span>{named(c.name)}{c.plan ? <span className="small"> · next: {planDay(c.plan, zone)}</span> : <span className="small"> · no upcoming plan yet</span>}</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!c.plan} onClick={() => { onAdd(c); setChoosing(false); }}>Watch {named(c.name)}</button>
      </li>)}</ul>}
      <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={() => setChoosing(false)}>Not now</button></div>
    </div>}
    {problem && <p role="alert" className="problem">{problem}</p>}
  </div>;
}
