// Choosing the Sunday in setup: once Planning Center is connected, Ozzie lists the church's service
// types and the chosen type's upcoming plans (read-only, native sunday_picker.rs), and the person
// picks one. Only the two ids are kept, exactly as typing them did; "Enter the plan by hand" stays below.
import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { choicesProblem, sundaySource, type Choices, type PlanChoice, type ServiceTypeChoice, type Settings } from "./sunday-source.js";
import { SundayPlanFields } from "./planning-center-forms.js";
import { Icon } from "./icons.js";

export type Loaded<T> = { state: "idle" } | { state: "loading" } | { state: "ready"; value: Choices<T> } | { state: "problem"; text: string };
export type PickerSource = Pick<typeof sundaySource, "serviceTypes" | "upcomingPlans">;

/** Which service type to show plans for once the list arrives: the one already chosen, else Planning Center's first. */
export function typeAfterLoad(items: readonly ServiceTypeChoice[], current: string): string {
  if (items.some(t => t.id === current)) return current;
  return items[0]?.id ?? "";
}
/** A pick keeps exactly what typing the two ids kept: the service type and plan ids, nothing else changed. */
export const withPlan = (settings: Settings, serviceTypeId: string, planId: string): Settings => ({ ...settings, serviceTypeId, planId });
/** "Sunday, November 29 · 9:00 AM", from Planning Center's local wall-clock time (its `Z` isn't UTC). Year only when it isn't this one. */
export function planWhen(plan: Pick<PlanChoice, "sort_date" | "dates">, now: string): string {
  const at = new Date(plan.sort_date);
  if (Number.isNaN(at.getTime())) return plan.dates ?? "Date not set";
  const sameYear = at.getUTCFullYear() === new Date(now).getUTCFullYear();
  const date = at.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
  return `${date} · ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" })}`;
}
/** The plan's title and series, as Planning Center names them. */
export const planName = (plan: Pick<PlanChoice, "title" | "series_title">) => [plan.title, plan.series_title].filter(Boolean).join(" · ");
const typeName = (t: ServiceTypeChoice) => t.name ?? `Service type ${t.id}`;

/** The picker's states, drawn without reading anything: what the person sees at each step. */
export function SundayChoicesView({ connected, settings, onSettings, types, typeId, onType, plans, onRetry, now, handOpen, onHand }: {
  connected: boolean; settings: Settings; onSettings: (s: Settings) => void;
  types: Loaded<ServiceTypeChoice>; typeId: string; onType: (id: string) => void; plans: Loaded<PlanChoice>;
  onRetry: () => void; now: string; handOpen: boolean; onHand: (open: boolean) => void;
}) {
  const id = useId();
  const list = types.state === "ready" ? types.value.items : [];
  const shown = plans.state === "ready" ? plans.value.items : [];
  const chosen = /^\d+$/u.test(settings.serviceTypeId) && /^\d+$/u.test(settings.planId);
  const chosenListed = shown.some(p => p.id === settings.planId) && typeId === settings.serviceTypeId;
  const problem = types.state === "problem" ? types.text : plans.state === "problem" ? plans.text : null;
  const pick = (plan: PlanChoice) => onSettings(withPlan(settings, typeId, plan.id));
  return <div className="picker">
    {!connected && <p className="panel-info"><Icon name="info" small /><span>Connect Planning Center first. Then your upcoming Sundays are listed here to choose from.</span></p>}
    {types.state === "loading" && <p className="picker-status" role="status"><Icon name="spinner" small spin />Reading your service types from Planning Center…</p>}
    {types.state === "ready" && list.length === 0 && <p className="panel-sunken">Planning Center shows no service types this account can see. Enter the plan by hand below.</p>}
    {list.length === 1 && <p className="picker-type"><span className="field-l">Service type</span>{typeName(list[0]!)}</p>}
    {list.length > 1 && <div className="field picker-type">
      <label className="field-l" htmlFor={`${id}-type`}>Service type</label>
      <select id={`${id}-type`} className="input" value={typeId} onChange={e => onType(e.target.value)}>
        {!typeId && <option value="">Choose a service type</option>}
        {list.map(t => <option key={t.id} value={t.id}>{typeName(t)}</option>)}
      </select>
      {types.state === "ready" && types.value.more && <p className="input-help">Showing the first {list.length}. Another service type can be entered by hand below.</p>}
    </div>}
    {plans.state === "loading" && <p className="picker-status" role="status"><Icon name="spinner" small spin />Reading upcoming plans…</p>}
    {plans.state === "ready" && shown.length === 0 && <p className="panel-sunken">No upcoming plans in this service type. {list.length > 1 ? "Choose another, or enter" : "Enter"} the plan by hand below.</p>}
    {shown.length > 0 && <fieldset className="picker-plans">
      <legend className="field-l">Upcoming plans</legend>
      {shown.map(p => {
        const selected = typeId === settings.serviceTypeId && p.id === settings.planId;
        const name = planName(p);
        return <label key={p.id} className={`choice${selected ? " is-sel" : ""}`}>
          <input type="radio" name={`${id}-plan`} checked={selected} onChange={() => pick(p)} />
          <span><span className="choice-t">{planWhen(p, now)}</span>{name && <span className="choice-d">{name}</span>}</span>
        </label>;
      })}
      {plans.state === "ready" && plans.value.more && <p className="input-help">Showing the next {shown.length}. A later Sunday can be entered by hand below.</p>}
    </fieldset>}
    {problem && <div className="picker-problem"><p role="alert" className="problem">{problem}</p>
      {connected && <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>Try again</button>}</div>}
    {chosen && !chosenListed && types.state !== "loading" && plans.state !== "loading"
      && <p className="small">Chosen now: a plan entered by hand. It isn't in this list.</p>}
    <details className="picker-hand" open={handOpen} onToggle={e => onHand((e.target as HTMLDetailsElement).open)}>
      <summary><Icon name="chev" small />Enter the plan by hand</summary>
      <div className="picker-hand-body">
        <p className="small">In Planning Center Services, open the Sunday plan you want checked and copy the address from your browser, then paste it here.</p>
        <SundayPlanFields settings={settings} onSettings={onSettings} />
      </div>
    </details>
  </div>;
}

const SKIPPED = Symbol("skipped");
/** One picker read at a time. A read queued behind another starts only once that one settles, and is never sent if
 *  something newer replaced it meanwhile, so Ozzie's own overlapping reads (React's doubled effects in development,
 *  Try again, a new service type mid-read) never make the native side answer `busy`. */
export function serialReads() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T,>(wanted: () => boolean, read: () => Promise<T>): Promise<T | typeof SKIPPED> => {
    const turn = tail.then<T | typeof SKIPPED>(() => wanted() ? read() : SKIPPED);
    tail = turn.catch(() => undefined);
    return turn;
  };
}
type Queue = ReturnType<typeof serialReads>;
/** Every picker on the page shares one queue, so a remount mid-read waits for the read in flight. */
const pickerReads = serialReads();

export interface ChoicesState { types: Loaded<ServiceTypeChoice>; typeId: string; plans: Loaded<PlanChoice>; handOpen: boolean }
const IDLE = { state: "idle" } as const, LOADING = { state: "loading" } as const;
const problem = (error: unknown) => ({ state: "problem", text: choicesProblem(error) }) as const;
/** What the picker shows, kept outside React so its reads are serialized: the latest request wins and a stale answer
 *  is dropped. `connect` is idempotent, so a doubled effect reads once. */
export function sundayChoices(source: PickerSource, typeId: string, connected: boolean, queue: Queue = pickerReads) {
  // Typing by hand is the way in until Planning Center is connected, and whenever a list can't be read.
  let state: ChoicesState = { types: IDLE, typeId, plans: IDLE, handOpen: !connected };
  let typesRead = 0, plansRead = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<ChoicesState>) => { state = { ...state, ...next }; listeners.forEach(listener => listener()); };
  function loadPlans() {
    const read = ++plansRead, id = state.typeId;
    if (state.types.state !== "ready" || !state.types.value.items.some(t => t.id === id)) { set({ plans: IDLE }); return; }
    set({ plans: LOADING });
    queue(() => read === plansRead, () => source.upcomingPlans(id)).then(
      value => { if (value !== SKIPPED && read === plansRead) set({ plans: { state: "ready", value } }); },
      error => { if (read === plansRead) set({ plans: problem(error), handOpen: true }); });
  }
  function loadTypes() {
    const read = ++typesRead;
    plansRead += 1;
    set({ types: LOADING, plans: IDLE });
    queue(() => read === typesRead, () => source.serviceTypes()).then(value => {
      if (value === SKIPPED || read !== typesRead) return;
      set({ types: { state: "ready", value }, typeId: typeAfterLoad(value.items, state.typeId), ...(value.items.length ? {} : { handOpen: true }) });
      loadPlans();
    }, error => { if (read === typesRead) set({ types: problem(error), handOpen: true }); });
  }
  return {
    view: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect(now: boolean) {
      if (now) { if (state.types.state === "idle") loadTypes(); return; }
      typesRead += 1;
      plansRead += 1;
      if (state.types.state !== "idle" || state.plans.state !== "idle") set({ types: IDLE, plans: IDLE });
    },
    retry: () => loadTypes(),
    chooseType(id: string) { if (id !== state.typeId) { set({ typeId: id }); loadPlans(); } },
    setHand(open: boolean) { if (open !== state.handOpen) set({ handOpen: open }); },
  };
}

/** The picker, reading Planning Center when connected. Nothing it reads is kept; a pick stores two ids. */
export function SundayPicker({ connected, settings, onSettings, source = sundaySource }: {
  connected: boolean; settings: Settings; onSettings: (s: Settings) => void; source?: PickerSource;
}) {
  const [choices] = useState(() => sundayChoices(source, settings.serviceTypeId, connected));
  const view = useSyncExternalStore(choices.subscribe, choices.view, choices.view);
  useEffect(() => choices.connect(connected), [choices, connected]);
  return <SundayChoicesView connected={connected} settings={settings} onSettings={onSettings} types={view.types} typeId={view.typeId}
    onType={choices.chooseType} plans={view.plans} onRetry={choices.retry} now={new Date().toISOString()} handOpen={view.handOpen} onHand={choices.setHand} />;
}
