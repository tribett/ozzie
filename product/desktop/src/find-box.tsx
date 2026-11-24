// Find in Ozzie (owner decision 2026-11-24): one box, opened with ⌘K, from Find… in the menu bar's Edit menu, or from Find
// in the sidebar. It finds what the pages already hold (find-items.ts), matched on this Mac (find-match.ts), and choosing
// a result only goes there or does one of a few safe things; nothing is changed in any church system from here. Nothing
// typed is kept: not in storage, not in What happened, not in anything sent. The words leave the box only through its
// last row, "Ask Ozzie: …", when the person picks that row; then Ask takes them exactly as if they were typed into Ask,
// and Ask's own steps put labels in place of names before anything reaches an AI. A search with no results never asks.
//
// It is a question over the page (modal.ts): the page under it is inert, the keyboard starts in the box and goes back
// where it was on Escape. The box is a combobox with its results as a listbox; arrows move, Enter chooses, and the app's
// one polite status line says how many were found.
import { listen as tauriListen } from "@tauri-apps/api/event";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { MAX_QUESTION_CHARS } from "../../../core/src/ask.js";
import { useAnnounce } from "./announce.js";
import { findGroups, findItems, namesUnaskable, PEOPLE_ORDER, prepareItems, startingPoints, unaskableWords, type FindInput, type FindItem, type FindTarget } from "./find-items.js";
import { Icon } from "./icons.js";
import { inertOutside, questionOpen } from "./modal.js";
import "./find-box.css";

/** Every word Find shows. */
export const FIND = {
  title: "Find in Ozzie",
  placeholder: "Find a page, a setting, a person on your plans…",
  label: "Find",
  close: "Close Find",
  results: "Results",
  kept: "Everything is matched on this Mac. Nothing you type is kept.",
  empty: "Find Ozzie's pages and settings, your Church rules and lists, what needs a decision, and the people on your plans.",
  starting: "Go to",
  none: (typed: string) => `Nothing in Ozzie matches “${typed}”.`,
  ask: (typed: string) => `Ask Ozzie: “${typed}”`,
  askAi: "Your words go to Ask, which puts labels in place of the names on your plans before anything reaches an AI.",
  /** In place of the Ask row when the words may name someone only Church lists know: Ask couldn't put a label in their place. */
  notSent: "Not sent to Ask: it might name someone from your Church lists, and Ask can't replace that name with a label.",
  more: (count: number, heading: string) => `Show all ${count} in ${heading}`,
  askHere: "Answered on this Mac from what Genesis shares. Nothing is sent to an AI.",
  askNeedsAi: "Ask needs AI for this. Choose how Ozzie uses AI.",
} as const;

/** How long typing pauses before the count is said. */
export const ANNOUNCE_AFTER_MS = 400;
/** The menu bar's Find… (app_menu.rs FIND_ID) reaches the page as this event (always_on.rs). */
export const FIND_EVENT = "ozzie:find";
type Keys = { key: string; metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean };
/** ⌘K, and nothing else held. */
export const isFindKey = (e: Keys) => e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "k";

type Listen = (event: string, handler: () => void) => Promise<() => void>;
const nativeListen: Listen = (event, handler) => tauriListen(event, () => handler());

/**
 * Whether Find is open, and the ways to open it: ⌘K anywhere on the page, and the menu bar's Find… (which the page hears
 * as FIND_EVENT). Never while another question is over the page (modal.ts), and not while `allowed` is false (Quit Ozzie?
 * is on its way). Opening it again while open puts the keyboard back in the box (`asked` changes).
 */
export function useFindOpener(allowed: boolean, listen: Listen = nativeListen) {
  const [open, setOpen] = useState(false);
  const [asked, setAsked] = useState(0);
  const may = useRef(allowed);
  may.current = allowed;
  const show = useCallback(() => { if (!may.current || questionOpen()) return; setOpen(true); setAsked(n => n + 1); }, []);
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const key = (e: KeyboardEvent) => { if (!isFindKey(e) || !may.current || questionOpen()) return; e.preventDefault(); show(); };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [show]);
  useEffect(() => {
    let live = true;
    const stop = listen(FIND_EVENT, () => { if (live) show(); }).catch(() => () => {});
    return () => { live = false; void stop.then(f => f()); };
  }, [listen, show]);
  return { open, asked, show, close };
}

/** The sidebar's row: near its top, named Find, with ⌘K beside it. */
export function FindRow({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="nav-i side-find" aria-haspopup="dialog" aria-keyshortcuts="Meta+K" onClick={onOpen}>
    <Icon name="search" /><span className="nav-label">{FIND.label}</span><kbd className="side-find-key" aria-hidden="true">⌘K</kbd></button>;
}

/** What the Ask row does: hand the words to Ask, say Ask needs AI first, or (Genesis) answer on this Mac. Null: no Ask now. */
export type AskRow = "ai" | "here" | "needs-ai" | null;

/** At most this many rows of one group are drawn until the person asks for the rest ("Show all …"). */
export const GROUP_ROWS = 20;
type Row = { kind: "item"; item: FindItem } | { kind: "more"; group: string; heading: string; count: number } | { kind: "ask" };

/** One row of the list: drawn again only when it, or whether it is the chosen one, changes. */
const Option = memo(function Option({ row, at, on, ask, words, onPick, onHover, keep }: {
  row: Row; at: number; on: boolean; ask: AskRow; words: string;
  onPick: (at: number) => void; onHover: (at: number) => void; keep: (at: number, el: HTMLElement | null) => void;
}) {
  const props = {
    id: `find-option-${at}`, role: "option", "aria-selected": on,
    className: `find-opt${on ? " is-active" : ""}${row.kind === "ask" ? " find-ask" : row.kind === "more" ? " find-more" : ""}`,
    ref: (el: HTMLElement | null) => keep(at, el),
    // A click keeps the keyboard in the box (the row itself takes no focus).
    onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(), onMouseMove: () => { if (!on) onHover(at); }, onClick: () => onPick(at),
  };
  if (row.kind === "ask") return <div {...props}>
    <span className="find-opt-title"><Icon name="question" small />{FIND.ask(words)}</span>
    <span className="find-opt-detail"><span className="sr-only">, </span>{ask === "needs-ai" ? FIND.askNeedsAi : ask === "here" ? FIND.askHere : FIND.askAi}</span>
  </div>;
  if (row.kind === "more") return <div {...props}><span className="find-opt-title">{FIND.more(row.count, row.heading)}</span></div>;
  return <div {...props}>
    <span className="find-opt-title">{row.item.title}</span>
    {row.item.detail && <span className="find-opt-detail"><span className="sr-only">, </span>{row.item.detail}</span>}
  </div>;
});

/**
 * The box itself, drawn only while open: what can be found is read once as it opens (`input`), with its words folded
 * then, so the list stays still under the arrow keys; it is gone with everything typed when it closes.
 */
export function FindBox({ input, ask, asked = 0, onChoose, onAsk, onClose }: {
  input: () => FindInput;
  ask: AskRow;
  /** Changes each time Find is asked to open again while open: the keyboard goes back to the box. */
  asked?: number;
  onChoose: (target: FindTarget) => void;
  /** The Ask row was chosen: the words, exactly as typed. */
  onAsk: (typed: string) => void;
  onClose: () => void;
}) {
  const [built] = useState(() => {
    const given = input();
    const items = findItems(given);
    return { items, prepared: prepareItems(items), unaskable: unaskableWords(given) };
  });
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  // Groups the person asked to see whole ("Show all …"), for what is typed now.
  const [whole, setWhole] = useState<ReadonlySet<string>>(() => new Set());
  const dialog = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const options = useRef(new Map<number, HTMLElement>());
  // A question over the page (modal.ts): everything outside is inert while it is open (App makes the sidebar and the
  // page inert itself, so those two have one owner) and the keyboard starts in the box. Closing gives the page back before
  // the page it goes to moves the keyboard (so this is a layout effect), and the keyboard goes back where it was only when
  // nothing else takes it: Escape, Close, or making the text bigger or smaller.
  const giveBack = useRef(true);
  useLayoutEffect(() => {
    if (typeof document === "undefined" || !dialog.current) return;
    const before = document.activeElement as HTMLElement | null;
    const restore = inertOutside(dialog.current);
    box.current?.focus();
    return () => { restore(); if (giveBack.current) before?.focus?.(); };
  }, []);
  const announce = useAnnounce();
  const words = typed.trim();
  const groups: readonly { id: string; heading: string; items: FindItem[] }[] = useMemo(() => words ? findGroups(built.prepared, typed)
    : [{ id: "start", heading: FIND.starting, items: startingPoints(built.items) }], [built, typed, words]);
  const found = groups.reduce((n, g) => n + g.items.length, 0);
  // Words that name someone from the church's own lists whom Ask can't put a label in place of: the Ask row isn't offered.
  const unaskable = useMemo(() => Boolean(words) && namesUnaskable(typed, built.unaskable), [typed, words, built]);
  const askHere = words && ask && !unaskable ? ask : null;
  const shown = useMemo(() => groups.map(g => ({ ...g, rows: (whole.has(g.id) ? g.items : g.items.slice(0, GROUP_ROWS)).map(item => ({ kind: "item" as const, item }) as Row)
    .concat(!whole.has(g.id) && g.items.length > GROUP_ROWS ? [{ kind: "more", group: g.id, heading: g.heading, count: g.items.length }] : []) })), [groups, whole]);
  const rows: Row[] = useMemo(() => [...shown.flatMap(g => g.rows), ...(askHere ? [{ kind: "ask" as const }] : [])], [shown, askHere]);
  // With nothing found, no row is chosen by Enter: the Ask row is only ever a choice the person moves to.
  useEffect(() => { setActive(words && found === 0 ? -1 : 0); setWhole(new Set()); }, [typed]);
  useEffect(() => { if (asked) { box.current?.focus(); box.current?.select?.(); } }, [asked]);
  useEffect(() => { if (active >= 0) options.current.get(active)?.scrollIntoView?.({ block: "nearest" }); }, [active]);
  // How many were found, said politely once typing pauses (counts only, never the words typed), and why the Ask row
  // isn't there when the words may name someone from the church's lists.
  const said = useRef<string | null>(null);
  useEffect(() => {
    const count = !words ? "" : found === 0 ? (askHere ? "Nothing found. Ask Ozzie is the one row." : "Nothing found.") : `${found} ${found === 1 ? "result" : "results"}.`;
    const line = count && unaskable ? `${count} ${FIND.notSent}` : count;
    if (line === said.current) return;
    const timer = setTimeout(() => { said.current = line; if (line) announce(line); }, ANNOUNCE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [words, found, askHere, unaskable, announce]);

  const latest = useRef({ rows, active });
  latest.current = { rows, active };
  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "more") { setWhole(w => new Set([...w, row.group])); return; }
    const t = row.kind === "item" ? row.item.target : null;
    giveBack.current = t?.to === "do" && (t.action === "bigger" || t.action === "smaller");
    if (t) { onChoose(t); return; }
    if (ask === "needs-ai") onChoose({ to: "do", action: "ai" });
    else onAsk(typed);
  };
  const chooseRef = useRef(choose);
  chooseRef.current = choose;
  const onPick = useCallback((at: number) => chooseRef.current(latest.current.rows[at]), []);
  const onHover = useCallback((at: number) => setActive(at), []);
  const keep = useCallback((at: number, el: HTMLElement | null) => { if (el) options.current.set(at, el); else options.current.delete(at); }, []);
  // Escape closes Find wherever the keyboard is in it (never while a word is still being composed), and goes no further,
  // so nothing under it closes too.
  const dialogKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (e.nativeEvent?.isComposing) return;
    e.preventDefault();
    onClose();
  };
  const key = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive(a => a < 0 ? (step > 0 ? 0 : rows.length - 1) : (a + step + rows.length) % rows.length);
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent?.isComposing) { e.preventDefault(); if (active >= 0) choose(rows[active]); }
  };
  let at = 0;
  const option = (row: Row) => { const i = at++; return <Option key={row.kind === "item" ? row.item.id : row.kind === "more" ? `more:${row.group}` : "ask"} row={row} at={i}
    on={i === active} ask={ask} words={words} onPick={onPick} onHover={onHover} keep={keep} />; };
  return <div className="find-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="find-dialog" role="dialog" aria-modal="true" aria-labelledby="find-title" ref={dialog} onKeyDown={dialogKey}>
      <div className="find-head">
        <h2 id="find-title" className="h3">{FIND.title}</h2>
        <button type="button" className="ibtn" aria-label={FIND.close} onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="find-field">
        <Icon name="search" />
        <input id="find-input" ref={box} className="find-input" type="text" role="combobox" aria-expanded="true" aria-controls="find-results" aria-autocomplete="list"
          aria-activedescendant={active >= 0 && active < rows.length ? `find-option-${active}` : undefined} aria-labelledby="find-title" aria-describedby="find-kept"
          placeholder={FIND.placeholder} value={typed} maxLength={MAX_QUESTION_CHARS} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          onChange={e => setTyped(e.target.value)} onKeyDown={key} />
      </div>
      <p id="find-kept" className="small find-kept"><Icon name="lock" small />{FIND.kept}</p>
      <div className="find-scroll">
        {!words && <p className="small find-note">{FIND.empty}</p>}
        {words && found === 0 && <p className="small find-note">{FIND.none(words)}</p>}
        <div id="find-results" role="listbox" aria-label={FIND.results} className="find-results">
          {shown.map(g => <div key={g.id} role="group" aria-labelledby={`find-group-${g.id}`} {...(g.id === "people" ? { "aria-describedby": "find-people-order" } : {})}
            className="find-group">
            <div id={`find-group-${g.id}`} role="presentation" className="find-group-h">{g.heading}</div>
            {g.id === "people" && <div id="find-people-order" role="presentation" className="small find-group-note">{PEOPLE_ORDER}</div>}
            {g.rows.map(option)}
          </div>)}
          {askHere && option({ kind: "ask" })}
        </div>
        {unaskable && <p className="small find-note find-not-sent" role="note"><Icon name="lock" small />{FIND.notSent}</p>}
      </div>
    </div>
  </div>;
}

/**
 * Where the keyboard goes after Find went to a page: its title, a section by its id (its first heading when it has one),
 * or a list's card on Church lists by the list's id (`data-source`). Found by the page's own ids, never by reading what
 * the page says.
 */
export type FoundFocus = { title: true } | { id: string } | { source: string };
type El = { nodeType: number; tagName?: string; childNodes: ArrayLike<unknown>; getAttribute(n: string): string | null; hasAttribute(n: string): boolean };
/** The first element under `root` that `want` names, never inside something hidden (Visitor cards kept behind other pages). */
function located(root: El | null, want: FoundFocus): HTMLElement | null {
  const walk = (n: El): El | null => {
    if (n.nodeType !== 1 || n.hasAttribute("hidden")) return null;
    const tag = (n.tagName ?? "").toUpperCase();
    if ("title" in want ? tag === "H1" : "id" in want ? n.getAttribute("id") === want.id : n.getAttribute("data-source") === want.source) return n;
    for (const c of Array.from(n.childNodes)) { const hit = walk(c as El); if (hit) return hit; }
    return null;
  };
  return root ? walk(root) as HTMLElement | null : null;
}

/** The first heading inside `el`, if any. */
function firstHeading(el: HTMLElement): HTMLElement | null {
  const walk = (n: El): El | null => {
    if (n.nodeType !== 1 || n.hasAttribute("hidden")) return null;
    if (/^H[1-6]$/u.test((n.tagName ?? "").toUpperCase())) return n;
    for (const c of Array.from(n.childNodes)) { const hit = walk(c as El); if (hit) return hit; }
    return null;
  };
  for (const c of Array.from((el as unknown as El).childNodes)) { const hit = walk(c as El); if (hit) return hit as unknown as HTMLElement; }
  return null;
}

/**
 * After Find went to a page: once the page has drawn, the keyboard moves to what was found (looked for again for a moment
 * while a page is still filling in), and only the page pane scrolls so it is near the top. Call it after App's other
 * effects, so it has the last word on the keyboard.
 */
export function useFoundFocus(pane: RefObject<HTMLElement | null>): (focus: FoundFocus) => void {
  const [want, setWant] = useState<{ focus: FoundFocus } | null>(null);
  useEffect(() => {
    if (!want) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () => {
      const found = located(pane.current as unknown as El | null, want.focus);
      // A section found by its id: the keyboard goes to its heading.
      const el = found && !/^H[1-6]$/u.test(found.tagName) ? firstHeading(found) ?? found : found;
      if (!el) { if (++tries < 4) timer = setTimeout(attempt, 150); return; }
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      const box = pane.current;
      if (box && typeof el.getBoundingClientRect === "function") box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - 16;
      el.focus({ preventScroll: true });
    };
    attempt();
    return () => clearTimeout(timer);
  }, [want]);
  return useCallback((focus: FoundFocus) => setWant({ focus }), []);
}
