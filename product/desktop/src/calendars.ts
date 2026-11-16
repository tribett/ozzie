// The leader's own calendars on Today: Apple Calendar on this Mac and private calendar links, read-only, through the
// native calendar commands (src-tauri/src/calendars.rs). Settings connects and chooses them; Today shows what they
// read (calendar-today.tsx).
//
// Calendar text stays on this Mac and in memory: the reads live only in this controller while Ozzie is open (nothing
// of a calendar is written to this page's storage; native code keeps the ids of the chosen Apple calendars and reads
// only those), and this file calls only the calendar commands (CALENDAR_COMMANDS; a test holds it to that). Every
// native call has its own time limit, so one calendar that never answers can't hold up the others.
// Nothing that builds a model request, a notice or the copy for other AI apps imports this file or core/src/calendar
// (core/test/calendar/stays-on-this-mac.test.ts). A private link's address goes to native code once, when it is
// added, and never comes back: the page only ever sees its label and where it points, masked.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import {
  APPLE_SOURCE, calendarWindow, failedRead, readFromApple, readFromLink, type CalendarRead, type CalendarSource,
} from "../../../core/src/calendar/events.js";
import { plainText } from "../../../core/src/calendar/ics.js";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const nativeInvoke: Invoke = (command, args) => tauriInvoke(command, args);

/** Every native command this file may call. Calendar text goes nowhere else. */
export const CALENDAR_COMMANDS = [
  "calendar_apple_status", "calendar_apple_ask", "calendar_apple_calendars", "calendar_apple_events", "calendar_apple_chosen", "calendar_apple_choose",
  "calendar_links", "calendar_link_add", "calendar_link_remove", "calendar_link_read", "calendar_links_forget_all",
] as const;
type Command = typeof CALENDAR_COMMANDS[number];

export type AppleAccess = "full" | "not-determined" | "denied" | "restricted" | "write-only" | "not-available";
export interface AppleCalendarChoice { id: string; title: string; account: string | null }
/**
 * A private link as native code shows it: never its address. `unusable`: an entry this version of Ozzie can't read
 * (from a newer one, or damaged), shown only so it can be removed.
 */
export interface CalendarLink { id: string; label: string; shown: string; missing: boolean; unusable?: boolean }
export type LinkError =
  | "not-an-address" | "not-https" | "sign-in-in-address" | "not-on-the-internet" | "no-label" | "too-many" | "unknown" | "missing" | "list-unreadable"
  | "unreachable" | "timeout" | "refused" | "moved-elsewhere" | "too-large" | "not-a-calendar" | "locked" | "denied" | "unavailable";

/** Why a private link couldn't be added or read, in plain words. */
export const LINK_PROBLEMS: Readonly<Record<LinkError, string>> = Object.freeze({
  "not-an-address": "That doesn't look like a web address. Copy the whole address, starting with https:// or webcal://.",
  "not-https": "Ozzie only reads addresses that start with https:// or webcal://.",
  "sign-in-in-address": "That address has a user name or password written into it. Use the calendar's private address instead.",
  "not-on-the-internet": "That address points at this Mac or a local network, which Ozzie doesn't read. Use the calendar's address on the internet.",
  "no-label": "Give this calendar a name, up to 60 characters.",
  "too-many": "Ozzie reads up to 8 private links. Remove one to add another.",
  unknown: "Ozzie doesn't have that calendar any more.",
  missing: "Its address is no longer in this Mac's Keychain. Remove it and add it again.",
  "list-unreadable": "Ozzie couldn't read its list of private calendar links on this Mac (it may have been saved by a newer Ozzie). The addresses are still in this Mac's Keychain, and nothing was removed.",
  unreachable: "The calendar's website couldn't be reached. Check the internet connection and try again.",
  timeout: "The calendar's website took too long to answer.",
  refused: "The calendar's website didn't give Ozzie the calendar. The address may have been reset; copy it again.",
  "moved-elsewhere": "The address sent Ozzie somewhere it doesn't read (not https, or not on the internet).",
  "too-large": "That calendar is too large for Ozzie to read.",
  "not-a-calendar": "That address didn't give back a calendar. Make sure it's the private iCal or ICS address, not the calendar's web page.",
  locked: "This Mac's Keychain is locked. Unlock this Mac and try again.",
  denied: "This Mac's Keychain didn't let Ozzie use it.",
  unavailable: "Ozzie couldn't save or read this calendar on this Mac. Try again.",
});
/** A problem in plain words, looked up without prototypes: an unexpected code is never a built-in property. */
const lookup = (table: Readonly<Record<string, string>>, code: unknown): string | null =>
  typeof code === "string" && Object.hasOwn(table, code) ? table[code]! : null;
export const linkProblem = (error: unknown) => lookup(LINK_PROBLEMS, error) ?? LINK_PROBLEMS.unavailable;
const APPLE_PROBLEMS: Readonly<Record<string, string>> = Object.freeze({
  "not-available": "Apple Calendar can't be read by this copy of Ozzie.",
  timeout: "Apple Calendar took too long to answer.",
});
const appleProblem = (error: unknown) => lookup(APPLE_PROBLEMS, error) ?? "Apple Calendar couldn't be read just now.";
/** How long the page waits for any one native calendar call before it reads as "took too long". Native code stops a
 * link's read at 20 s and Apple Calendar's at 30 s; this is the page's own limit beside those. */
export const CALL_LIMIT_MS = 45_000;
/** "Let Ozzie read my calendar" waits on the person answering macOS's question. */
/** A little longer than native code waits for macOS's question (calendars.rs ASK_LIMIT), so native answers first. */
const ASK_LIMIT_MS = 310_000;
/** A link's text is read in a worker, whose parser stops itself at 3 s; one that hasn't answered by this is ended. */
export const PARSE_LIMIT_MS = 10_000;
type Window = NonNullable<ReturnType<typeof calendarWindow>>;
/**
 * A link's calendar text, read off the page's main thread (calendar-worker.ts) so a large or hostile calendar can't
 * freeze the window (the parser refuses one that needs more than 3 s, there as anywhere). Where no worker can run
 * (tests), or one can't start or never answers within `PARSE_LIMIT_MS` (it is then ended), it is read here, still
 * bounded by the parser's own time limit.
 */
export function parseLink(text: string, source: CalendarSource, checked_at: string, window: Window, zone: string): Promise<CalendarRead> {
  const here = () => readFromLink(text, source, checked_at, window, zone);
  if (typeof Worker === "undefined") return Promise.resolve(here());
  return new Promise(resolve => {
    let worker: Worker;
    try { worker = new Worker(new URL("./calendar-worker.ts", import.meta.url), { type: "module" }); }
    catch { resolve(here()); return; }
    let settled = false;
    const done = (read: () => CalendarRead) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(read());
    };
    const timer = setTimeout(() => done(here), PARSE_LIMIT_MS);
    worker.onmessage = (event: MessageEvent<CalendarRead>) => done(() => event.data);
    // The worker couldn't start (the parser itself never throws out of it): read it here instead.
    worker.onerror = () => done(here);
    worker.postMessage({ text, source, checked_at, window, zone });
  });
}

export interface CalendarState {
  /** null until Ozzie has asked native code. */
  access: AppleAccess | null;
  /** The calendars on this Mac, with full access; null until listed. */
  calendars: AppleCalendarChoice[] | null;
  chosen: string[];
  asking: boolean;
  /** Private links; null until listed. */
  links: CalendarLink[] | null;
  linksProblem: string | null;
  /** The list of links on this Mac can't be read; Settings offers to forget them all. */
  linksUnreadable: boolean;
  /** The latest read of each connected calendar, in memory only. */
  reads: CalendarRead[];
  reading: boolean;
  /** When the latest full read finished. */
  readAt: string | null;
}
/** Whether any calendar is connected: Apple Calendar with at least one calendar chosen, or a private link it can read. */
export const calendarsConnected = (s: Pick<CalendarState, "access" | "chosen" | "links">) =>
  (s.access === "full" && s.chosen.length > 0) || (s.links ?? []).some(l => !l.unusable);
export const linkSource = (link: Pick<CalendarLink, "id" | "label">): CalendarSource => ({ kind: "link", id: link.id, label: link.label });

export interface CalendarDeps { invoke?: Invoke; now?: () => string; zone?: () => string; callLimitMs?: number }
export type Calendars = ReturnType<typeof createCalendars>;

/** The calendars' state and what Settings and Today can do with it. Subscribe for changes (useSyncExternalStore). */
export function createCalendars(deps: CalendarDeps = {}) {
  const invoke = deps.invoke ?? nativeInvoke;
  const limit = deps.callLimitMs ?? CALL_LIMIT_MS;
  /** One native call, given up as "timeout" after its limit so nothing waits on it forever. */
  const call = <T>(command: Command, args?: Record<string, unknown>, ms = limit) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject("timeout"), ms);
    invoke<T>(command, args).then(v => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
  const cleanLink = (l: CalendarLink): CalendarLink => l.unusable ? { id: l.id, label: "", shown: "", missing: false, unusable: true }
    : { ...l, label: plainText(l.label, 60) || "(No name)", shown: plainText(l.shown, 300) };
  const now = deps.now ?? (() => new Date().toISOString());
  const zone = deps.zone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  let state: CalendarState = {
    access: null, calendars: null, chosen: [], asking: false, links: null, linksProblem: null, linksUnreadable: false, reads: [], reading: false, readAt: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<CalendarState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  // Reads are applied in the order they were started, so an older read never replaces a newer one.
  let generation = 0;

  const listCalendars = async () => {
    try {
      const list = await call<{ access: AppleAccess; calendars: { id: string; title: string; account?: string | null }[] }>("calendar_apple_calendars");
      set({ access: list.access, calendars: list.access === "full"
        ? list.calendars.map(c => ({ id: c.id, title: plainText(c.title, 300), account: c.account ? plainText(c.account, 300) || null : null })) : null });
    } catch { set({ calendars: null }); }
  };
  const readApple = async (window: Window, at: string): Promise<CalendarRead | null> => {
    if (state.access !== "full" || !state.chosen.length) return null;
    try {
      // Native code reads only the calendars it keeps as chosen; the page asks for the days alone.
      const answer = await call<unknown>("calendar_apple_events", { from: window.from, to: window.to });
      return readFromApple(answer, APPLE_SOURCE, at, window);
    } catch (error) { return failedRead(APPLE_SOURCE, at, appleProblem(error)); }
  };
  const readLink = async (link: CalendarLink, window: Window): Promise<CalendarRead> => {
    const source = linkSource(link);
    let text: string;
    try { text = await call<string>("calendar_link_read", { id: link.id }); }
    catch (error) { return failedRead(source, now(), linkProblem(error)); }
    return parseLink(text, source, now(), window, zone());
  };

  const controller = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    state: () => state,

    /** What macOS has decided and which links exist; then reads everything connected. Never asks anything. */
    async load() {
      let access: AppleAccess = "not-available";
      try { access = await call<AppleAccess>("calendar_apple_status"); } catch { /* not available in this copy */ }
      set({ access });
      if (access === "full") await listCalendars();
      try { set({ chosen: await call<string[]>("calendar_apple_chosen") }); } catch { set({ chosen: [] }); }
      try { set({ links: (await call<CalendarLink[]>("calendar_links")).map(cleanLink), linksProblem: null, linksUnreadable: false }); }
      catch (error) { set({ links: [], linksProblem: linkProblem(error), linksUnreadable: error === "list-unreadable" }); }
      await controller.read();
    },

    /** Reads every connected calendar for today and the next seven days. Results replace the earlier read. */
    async read() {
      const mine = ++generation;
      const at = now();
      const window = calendarWindow(at, zone());
      if (!window || !calendarsConnected(state)) { set({ reads: [], reading: false }); return; }
      set({ reading: true });
      const links = (state.links ?? []).filter(l => !l.unusable);
      const [apple, ...fromLinks] = await Promise.all([readApple(window, at), ...links.map(l => readLink(l, window))]);
      if (mine !== generation) return;
      // A link removed or Apple Calendar stopped while this read ran: nothing from it is kept.
      const still = (r: CalendarRead) => r.source.kind === "apple" ? state.access === "full" && state.chosen.length > 0 : (state.links ?? []).some(l => l.id === r.source.id);
      set({ reads: [...(apple ? [apple] : []), ...fromLinks].filter(still), reading: false, readAt: now() });
    },

    /** Reads again when the last read is older than `maxAgeMs` (Today opening). */
    async readIfOld(maxAgeMs = 15 * 60_000) {
      if (state.reading || !calendarsConnected(state)) return;
      if (state.readAt && Date.parse(now()) - Date.parse(state.readAt) < maxAgeMs) return;
      await controller.read();
    },

    /** "Let Ozzie read my calendar": macOS asks once if it never has. Then lists the calendars to choose from. */
    async connectApple() {
      set({ asking: true });
      let access: AppleAccess = "not-available";
      try { access = await call<AppleAccess>("calendar_apple_ask", undefined, ASK_LIMIT_MS); } catch { /* not available */ }
      // macOS's question can sit unanswered until the ask gives up. That isn't "this copy can't read calendars":
      // what macOS has decided (still nothing) is asked for again, without asking the person, so the button comes back.
      if (access === "not-available") { try { access = await call<AppleAccess>("calendar_apple_status"); } catch { /* not available */ } }
      set({ access, asking: false });
      if (access === "full") await listCalendars();
    },

    /**
     * macOS's question can be answered long after the ask gave up (live run 2026-11-16: the owner answered an hour
     * later and Settings still showed the button). When the window comes forward and nothing is decided yet, what
     * macOS has decided is read again. Never asks the person anything.
     */
    async refreshAccess() {
      if (state.access !== "not-determined" || state.asking) return;
      let access: AppleAccess = state.access;
      try { access = await call<AppleAccess>("calendar_apple_status"); } catch { return; }
      if (access === state.access || state.asking) return;
      set({ access });
      if (access === "full") await listCalendars();
    },

    /** The calendars Ozzie reads; none until the leader chooses. */
    async choose(ids: readonly string[]) {
      try { set({ chosen: await call<string[]>("calendar_apple_choose", { ids }) }); } catch { /* the earlier choice stays */ }
      await controller.read();
    },

    /** "Stop reading Apple Calendar": no calendar chosen, and nothing from Apple Calendar is kept. */
    async stopApple() {
      try { await call<string[]>("calendar_apple_choose", { ids: [] }); } catch { /* read nothing from it here either way */ }
      set({ chosen: [], reads: state.reads.filter(r => r.source.kind !== "apple") });
      await controller.read();
    },

    /** Adds a private link. Returns a plain-words problem, or null when it was added and read. */
    async addLink(label: string, address: string): Promise<string | null> {
      try {
        const added = await call<{ link: CalendarLink; text: string }>("calendar_link_add", { label, address });
        const link = cleanLink(added.link);
        const window = calendarWindow(now(), zone());
        const read = window ? await parseLink(added.text, linkSource(link), now(), window, zone()) : null;
        const midRead = state.reading;
        set({ links: [...(state.links ?? []), link], reads: [...state.reads, ...(read ? [read] : [])] });
        // A read already running started without this link; read again so its result doesn't leave it out.
        if (midRead) void controller.read();
        return null;
      } catch (error) { return linkProblem(error); }
    },

    /**
     * "Forget all private calendar links", after the person confirms: native code deletes every saved address and the
     * list, and Ozzie starts with none. Returns a plain-words problem, or null.
     */
    async forgetAllLinks(): Promise<string | null> {
      try { await call<void>("calendar_links_forget_all"); }
      catch (error) { return linkProblem(error); }
      set({ links: [], linksProblem: null, linksUnreadable: false, reads: state.reads.filter(r => r.source.kind !== "link") });
      await controller.read();
      return null;
    },

    /** "Stop reading this calendar": its address leaves the Keychain and nothing read from it is kept. */
    async removeLink(id: string): Promise<string | null> {
      try {
        await call<void>("calendar_link_remove", { id });
        set({ links: (state.links ?? []).filter(l => l.id !== id), reads: state.reads.filter(r => !(r.source.kind === "link" && r.source.id === id)) });
        return null;
      } catch (error) { return linkProblem(error); }
    },
  };
  return controller;
}

/** The calendars' state, for a page. */
export const useCalendarState = (calendars: Calendars): CalendarState => useSyncExternalStore(calendars.subscribe, calendars.state, calendars.state);
