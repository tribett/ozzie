// "Finish setting up" on Today (onboarding spec §4.1, decision 13): the few things setup left for later, one open at a
// time, each only when it applies. Done-ness is computed from facts the page passes in, never from a "closed" flag;
// what's remembered here is only "Not now" (an item collapsed) and "Hide this list" (the card gone for good, NEVER-LIST
// 10: it never comes back by itself). Item 1 replaces Today's old "Ozzie isn't set to start with this Mac" card.
//
// It also holds the small styles for the other at-the-moment questions (finish.css).
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "./icons.js";
import { useDay } from "./day-words.js";
import { finishMemory, type FinishItemId, type FinishStore } from "./moments.js";
import { useSystemWords } from "./church-system.js";
import "./first-run.css";
import "./finish.css";

export type { FinishItemId } from "./moments.js";

/**
 * The facts behind each item. Each pair says whether the item applies and whether it's done; an item that applied
 * keeps showing as done (and counted) as long as the page keeps its "applies" fact true.
 */
export interface FinishFacts {
  /** Item 1. `asked`: "Start Ozzie when this Mac starts" was answered on this Mac (ozzie.start-with-mac-asked.v1).
   *  `on`: the Mac's own login item, null when the Mac couldn't say. Always applies; done once answered or on. */
  start: { asked: boolean; on: boolean | null };
  /** Item 2. `deferred`: S5a's "Not now" was chosen. `watching`: a service is chosen now. */
  service: { deferred: boolean; watching: boolean };
  /** Item 3, from moments.ts `kidsFacts`: a team in the check looks like a kids team; one is marked or each was answered. */
  kids: { looking: boolean; answered: boolean };
  /** Item 4. `left`: S6 ended without a choice, or was never offered while no AI route is set. `chosen`: a way was chosen since. */
  ai: { left: boolean; chosen: boolean };
  /** Item 5. `waiting`: setup found no upcoming plan (S5d). `found`: a plan has appeared. `service`: its Planning Center name. */
  plan: { waiting: boolean; found: boolean; service?: string | null | undefined };
  /**
   * Item 6 (decision 24). `offered`: after a check, the connection reads Services only (or holds Calendar, People and
   * Groups with their reads off) and the offer wasn't hidden; it stays offered, done, once the person allowed it.
   */
  more?: { offered: boolean; done: boolean } | undefined;
}
export interface FinishItem { id: FinishItemId; title: string; done: boolean }

export const FINISH_TITLE = "Finish setting up";
const TITLES: Record<FinishItemId, string> = {
  start: "Start Ozzie when this Mac starts",
  service: "Choose which service Ozzie watches",
  kids: "Mark the teams that serve with kids",
  ai: "Choose how Ozzie uses AI",
  waiting: "Ozzie is waiting for the next plan",
  // An action, as the other titles are, which still reads right once ticked (review 2026-11-18); the card itself keeps the
  // offer's own heading (read-more.tsx `moreTitle`), and its button, "Let Ozzie read more in Planning Center", isn't the
  // title said twice (review L8).
  more: "Choose what else Ozzie checks",
};
/** At most four at once (spec §4.1). */
export const FINISH_MAX = 4;

/** The items, in the spec's order, each only when it applies; at most four, keeping the open ones first. */
export function finishItems(f: FinishFacts): FinishItem[] {
  const all: (FinishItem | null)[] = [
    { id: "start", title: TITLES.start, done: f.start.asked || f.start.on === true },
    f.service.deferred ? { id: "service", title: TITLES.service, done: f.service.watching } : null,
    f.kids.looking ? { id: "kids", title: TITLES.kids, done: f.kids.answered } : null,
    f.ai.left ? { id: "ai", title: TITLES.ai, done: f.ai.chosen } : null,
    f.plan.waiting ? { id: "waiting", title: TITLES.waiting, done: f.plan.found } : null,
    // Last: the most optional, so over four it is the first open one to wait.
    f.more?.offered ? { id: "more", title: TITLES.more, done: f.more.done } : null,
  ];
  const items = all.filter((i): i is FinishItem => i !== null);
  // Over four: done items leave first, from the end; then the last open ones.
  while (items.length > FINISH_MAX) {
    const at = items.map(i => i.done).lastIndexOf(true);
    items.splice(at >= 0 ? at : items.length - 1, 1);
  }
  return items;
}
/** The item open now: the first not done and not set aside with "Not now". */
export const openItem = (items: readonly FinishItem[], notNow: readonly FinishItemId[]): FinishItemId | null =>
  items.find(i => !i.done && !notNow.includes(i.id))?.id ?? null;

// "What else Ozzie can check" lives in Settings › Planning Center, not in Check my setup: so "Settings".
export const HIDDEN_LINE = "This list is hidden and won't come back by itself. The same things are in Settings and in Church rules.";
export const START_FAILED_LINE = "This Mac didn't let Ozzie change that setting. Try again, or later in Settings › Check my setup.";

export interface FinishSettingUpProps {
  facts: FinishFacts;
  /** Item 1's two answers; the page changes the Mac's login item and remembers it was answered. */
  onStartWithMac: (yes: boolean) => void;
  /** Item 2: "Choose a service" (the picker). */
  onChooseService: () => void;
  /** Item 3: "Open Church rules". */
  onKidsRules: () => void;
  /** Item 4: "Choose" (S6). */
  onChooseAi: () => void;
  /** Item 6's body: what else Ozzie can check and its one button (read-more.tsx `ReadMore`, place "today"). */
  moreBody?: ReactNode;
  /** The Mac refused the login-item change: said under item 1. */
  startFailed?: boolean | undefined;
  /** Where "Not now" and "Hide this list" are kept (tests pass their own). */
  store?: FinishStore | undefined;
}

export function FinishSettingUp({ facts, onStartWithMac, onChooseService, onKidsRules, onChooseAi, moreBody, startFailed = false, store = finishMemory }: FinishSettingUpProps) {
  const { day } = useDay();
  // The church's own system: Planning Center's words unchanged.
  const w = useSystemWords();
  const [memory, setMemory] = useState(() => store.get());
  // A line the person opened themselves (a collapsed one), over the first-not-done rule.
  const [chosen, setChosen] = useState<FinishItemId | null>(null);
  const [justHidden, setJustHidden] = useState(false);
  const id = useId();
  const openTitle = useRef<HTMLHeadingElement>(null);
  const hiddenLine = useRef<HTMLParagraphElement>(null);
  const moved = useRef(false);
  const items = finishItems(facts);
  const open = chosen && items.some(i => i.id === chosen && !i.done) ? chosen : openItem(items, memory.notNow);
  // After "Not now" or opening a line, the keyboard follows to the item now open.
  useEffect(() => { if (moved.current) { moved.current = false; openTitle.current?.focus(); } }, [open]);
  useEffect(() => { if (justHidden) hiddenLine.current?.focus(); }, [justHidden]);

  if (justHidden) return <p className="small finish-hidden" role="status" tabIndex={-1} ref={hiddenLine}>{HIDDEN_LINE}</p>;
  if (memory.hidden || !items.some(i => !i.done)) return null;

  const notNow = (item: FinishItemId) => { store.notNow(item); moved.current = true; setChosen(null); setMemory(store.get()); };
  const hide = () => { store.hide(); setMemory(store.get()); setJustHidden(true); };
  const done = items.filter(i => i.done).length;
  const body = (item: FinishItemId) => {
    switch (item) {
      case "start": return <>
        <p className="finish-body">{`Ozzie can only keep an eye on ${day} while it's running.`}</p>
        <div className="finish-acts">
          <button type="button" className="btn btn-primary" onClick={() => onStartWithMac(true)}>Yes, start Ozzie with this Mac</button>
          <button type="button" className="btn btn-secondary" onClick={() => onStartWithMac(false)}>No, I'll open it myself</button>
        </div>
        {startFailed && <p role="alert" className="problem finish-problem">{START_FAILED_LINE}</p>}
      </>;
      case "service": return <>
        <p className="finish-body">Ozzie watches one service from your church's {w.name}. Until you choose one, there's nothing for it to keep an eye on.</p>
        <div className="finish-acts"><button type="button" className="btn btn-primary" onClick={onChooseService}>Choose a service</button></div>
      </>;
      case "kids": return <>
        <p className="finish-body">If a team serves with kids, Ozzie can check that each service time has enough confirmed people on it.</p>
        <div className="finish-acts"><button type="button" className="btn btn-primary" onClick={onKidsRules}>Open Church rules</button></div>
      </>;
      case "ai": return <>
        <p className="finish-body">Everything else works without AI. With it, Ozzie can reword a note when you ask and answer your questions.</p>
        <div className="finish-acts"><button type="button" className="btn btn-primary" onClick={onChooseAi}>Choose</button></div>
      </>;
      case "waiting": return <p className="finish-body">
        {w.system === "planning-center"
          ? `When someone at your church makes the next ${facts.plan.service ? `${facts.plan.service} ` : ""}plan in Planning Center Services, Ozzie finds it by itself. It looks again every hour while it's open. If it's the only service with a plan, Ozzie starts watching it by itself; otherwise it asks you on Today.`
          : `When someone at your church adds the next ${facts.plan.service ? `${facts.plan.service} ` : ""}${w.system === "b1" ? "plan" : "event"} in ${w.name}, Ozzie finds it by itself and watches it. It looks again each time it checks.`}</p>;
      case "more": return moreBody ?? null;
    }
  };
  return <section className="find finish" aria-labelledby={`${id}-t`}>
    <div className="finish-head">
      <h2 id={`${id}-t`} className="h3 finish-title">{FINISH_TITLE}</h2>
      <span className="small finish-count">{`${done} of ${items.length} done`}</span>
    </div>
    <ol className="finish-items">{items.map(item => <li key={item.id} className={`finish-item${item.done ? " is-done" : ""}${item.id === open ? " is-open" : ""}`}>
      {item.done
        ? <p className="finish-line"><Icon name="check" small /><span>{item.title}</span><span className="sr-only">, done</span></p>
        : item.id === open
          ? <div className="finish-open">
            <h3 className="finish-item-t" tabIndex={-1} ref={openTitle}>{item.title}</h3>
            {body(item.id)}
            <button type="button" className="fr-link finish-later" onClick={() => notNow(item.id)}>Not now</button>
          </div>
          : <button type="button" className="finish-line finish-line-btn" aria-expanded={false} onClick={() => { moved.current = true; setChosen(item.id); }}>
            <span>{item.title}</span><Icon name="chev" small /></button>}
    </li>)}</ol>
    <div className="finish-foot"><button type="button" className="fr-link" onClick={hide}>Hide this list</button></div>
  </section>;
}
