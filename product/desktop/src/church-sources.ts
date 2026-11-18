// Lists and notes the church adds ("Church lists"): spreadsheet files the leader chooses on this Mac, private links to
// published sheets, and the church's own notes (a plain text or Markdown file), read again from where they are through
// native code (src-tauri/src/church_sources.rs) and read here, in memory, as a sheet (core/src/sources/sheet.ts) or as
// notes (core/src/sources/notes.ts). The Church lists page shows them and lets the leader match a column to Planning
// Center teams and positions, or point to a section of notes from the cards for a team or a kind of finding; a Sunday
// card then shows the matching rows, or the section's title with a way to open it, as the church's own words.
//
// A list's text stays on this Mac and in memory: what was read lives only in this controller while Ozzie is open
// (nothing of a list is written to this page's storage; native code keeps the list of files and the leader's matches),
// it is read again when it is over an hour old or on "Read again", and this is the one file that talks to native code
// for it, calling only the church_* commands (SOURCE_COMMANDS). The page never names a file to read: commands take a
// list's id, and native code never gives back a path. A private link's address goes to native code once, in
// church_link_add, and is never kept here or given back: the page sees only where it points, masked. Ozzie's own tests
// check that nothing which builds a model request, a notice, the copy for other AI apps or Siri, the briefing or a
// draft imports this file or core/src/sources (core/test/sources/stays-on-this-mac.test.ts): a check on Ozzie's own
// code, not a sandbox.
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { readSheet, type Sheet } from "../../../core/src/sources/sheet.js";
import { readNotes, type Notes } from "../../../core/src/sources/notes.js";
import {
  MAX_ATTACHMENTS, MAX_LABEL, MAX_LINKS, MAX_SOURCES, MAX_TICKED, parseSourceList, type NoteAttachment, type NotesSource, type SheetSource, type SourceMatch,
} from "../../../core/src/sources/types.js";
import { plainLine } from "../../../core/src/sources/text.js";
import { SOURCE_PROBLEMS, sourceProblem } from "../../../core/src/sources/words.js";

export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** Every native command this file may call. A list's text goes nowhere else. */
export const SOURCE_COMMANDS = [
  "church_sources", "church_source_choose_file", "church_source_read", "church_source_set", "church_source_remove", "church_sources_forget_all",
  "church_link_add", "church_link_read", "church_link_remove", "church_links_forget_all", "church_notes_choose_file", "church_notes_set",
] as const;
type Command = typeof SOURCE_COMMANDS[number];
/**
 * Whether a command is one of SOURCE_COMMANDS, by literal comparison only: nothing an importer could patch (no Set, no
 * prototype; review U, finding 1).
 */
export function allowed(command: string): command is Command {
  switch (command) {
    case "church_sources":
    case "church_source_choose_file":
    case "church_source_read":
    case "church_source_set":
    case "church_source_remove":
    case "church_sources_forget_all":
    case "church_link_add":
    case "church_link_read":
    case "church_link_remove":
    case "church_links_forget_all":
    case "church_notes_choose_file":
    case "church_notes_set":
      return true;
    default:
      return false;
  }
}
/**
 * The one way to native code, private to this module: a command not in SOURCE_COMMANDS is refused here, before anything is
 * sent, however its name was made (review S2, finding 1). Every call below also names its command as a literal from that list.
 */
const nativeInvoke: Invoke = (command, args) => allowed(command) ? tauriInvoke(command, args) : Promise.reject("unavailable");

/** A list's last read: the sheet, or why it couldn't be shown in plain words. `at` is when it came back. */
export type SourceRead = { ok: true; at: string; sheet: Sheet } | { ok: false; at: string; problem: string };
/** Notes' last read: the notes, or why they couldn't be shown in plain words. */
export type NotesRead = { ok: true; at: string; notes: Notes } | { ok: false; at: string; problem: string };
/** A section of notes to open on Church lists, asked for from a Sunday card: the notes' id and the section's place. */
export interface NoteFocus { id: string; section: number }

export interface ChurchSourcesState {
  /** The lists the leader added, as native code lists them; null until listed. */
  sources: SheetSource[] | null;
  /** Why the lists couldn't be listed, in plain words. */
  listProblem: string | null;
  /** The list of lists on this Mac can't be read: the page offers "Forget all lists". */
  listUnreadable: boolean;
  /** The private links' own list on this Mac can't be read: the page offers "Forget all private links". */
  linksUnreadable: boolean;
  /** Each list's latest read, by id, in memory only. */
  reads: ReadonlyMap<string, SourceRead>;
  /** The church's notes, as native code lists them; none until listed. */
  notes: NotesSource[];
  /** Each notes' latest read, by id, in memory only. */
  noteReads: ReadonlyMap<string, NotesRead>;
  /** A section asked for from a Sunday card, until Church lists has shown it. */
  focus: NoteFocus | null;
  reading: boolean;
  /** When the latest read of every list finished. */
  readAt: string | null;
}
/**
 * What the leader changes on a list; anything left out stays as it is. Ticked columns and matches may be given as a
 * change to what they are when the edit is saved, so two quick changes both land (review S, L5).
 */
export interface SourceEdit {
  label?: string;
  column?: string | null;
  ticked?: readonly string[] | ((now: readonly string[]) => readonly string[]);
  matches?: ReadonlyMap<string, SourceMatch> | ((now: ReadonlyMap<string, SourceMatch>) => ReadonlyMap<string, SourceMatch>);
}
/**
 * What the leader changes on notes; anything left out stays as it is. Attachments may be given as a change to what they
 * are when the edit is saved, so two quick changes both land.
 */
export interface NotesEdit {
  label?: string;
  attachments?: readonly NoteAttachment[] | ((now: readonly NoteAttachment[]) => readonly NoteAttachment[]);
}
/** Choosing a file: the new list's id, why it couldn't be added, or nothing chosen. */
export type ChooseResult = { added: string } | { problem: string } | { cancelled: true };
/** Adding a private link: the new list's id, or why it couldn't be added. */
export type AddLinkResult = { added: string } | { problem: string };
type Kind = SheetSource["kind"];

/** How long a read is kept before Sunday or Church lists coming forward reads the files again. */
export const READ_AGAIN_MS = 60 * 60_000;
/** How long the page waits for one native call; choosing waits on the person. */
export const CALL_LIMIT_MS = 30_000;
/** A link's call: native code stops a read at 20 s, and adding, removing or forgetting one may wait on the Keychain. */
export const LINK_CALL_LIMIT_MS = 45_000;
const CHOOSE_LIMIT_MS = 30 * 60_000;
/** Page words for what native code doesn't decide. */
export const TOO_MANY_LISTS = `Ozzie keeps up to ${MAX_SOURCES} lists and notes. Remove one to add another.`;
export const NO_LABEL = `Give this list a name, up to ${MAX_LABEL} characters.`;
/** When one more column than a matched card shows is ticked (two quick ticks can get past the page's own limit). */
export const TOO_MANY_TICKED = `Ozzie shows up to ${MAX_TICKED} columns beside a matched card. Untick one to show another.`;
export const NO_ADDRESS = "Paste the sheet's published link.";
export const NO_NOTES_LABEL = `Give these notes a name, up to ${MAX_LABEL} characters.`;
/** One file of notes points to at most MAX_ATTACHMENTS sections from the cards (native code's limit too). */
export const TOO_MANY_POINTERS = `Ozzie shows up to ${MAX_ATTACHMENTS} sections of one file of notes beside the cards. Choose “Not on any card” for one before choosing another.`;

/** A list's bytes as a sheet, or the problem in plain words (a link's in its own words). */
export function readSource(reply: unknown, at: string, kind: Kind = "file"): SourceRead {
  const bytes = reply instanceof Uint8Array ? reply : reply instanceof ArrayBuffer ? new Uint8Array(reply)
    : Array.isArray(reply) && reply.every(b => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(reply as number[]) : null;
  if (!bytes) return { ok: false, at, problem: sourceProblem(null) };
  const result = readSheet(bytes);
  return result.ok ? { ok: true, at, sheet: result.sheet } : { ok: false, at, problem: sourceProblem(result.problem, kind) };
}
/** Notes' bytes as notes, or the problem in plain words (notes' own). */
export function readNotesSource(reply: unknown, at: string): NotesRead {
  const bytes = reply instanceof Uint8Array ? reply : reply instanceof ArrayBuffer ? new Uint8Array(reply) : null;
  if (!bytes) return { ok: false, at, problem: sourceProblem(null) };
  const result = readNotes(bytes);
  return result.ok ? { ok: true, at, notes: result.notes } : { ok: false, at, problem: sourceProblem(result.problem, "notes") };
}
/** church_link_add's reply: the new list and the sheet the add read, exactly. */
function linkAdded(reply: unknown): { source: unknown; sheet: unknown } | null {
  if (typeof reply !== "object" || reply === null || Object.getPrototypeOf(reply) !== Object.prototype) return null;
  const keys = Object.keys(reply);
  return keys.length === 2 && keys.includes("source") && keys.includes("sheet") ? reply as { source: unknown; sheet: unknown } : null;
}

export interface ChurchSourcesDeps { invoke?: Invoke; now?: () => string; callLimitMs?: number }
export type ChurchSources = ReturnType<typeof createChurchSources>;

/** The lists' state and what the Church lists page and Sunday can do with it. Subscribe for changes (useSyncExternalStore). */
export function createChurchSources(deps: ChurchSourcesDeps = {}) {
  const invoke = deps.invoke ?? nativeInvoke;
  const limit = deps.callLimitMs ?? CALL_LIMIT_MS;
  const now = deps.now ?? (() => new Date().toISOString());
  /** One native call, given up as "unavailable" after its limit so nothing waits on it forever. */
  const call = <T>(command: Command, args?: Record<string, unknown>, ms = limit) => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject("unavailable"), ms);
    invoke<T>(command, args).then(v => { clearTimeout(timer); resolve(v); }, (e: unknown) => { clearTimeout(timer); reject(e); });
  });
  let state: ChurchSourcesState = {
    sources: null, listProblem: null, listUnreadable: false, linksUnreadable: false, reads: new Map(), notes: [], noteReads: new Map(), focus: null, reading: false,
    readAt: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<ChurchSourcesState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
  /** The list native code sends, checked whole (types.ts parseSourceList): spreadsheets (a file or a private link) and notes. */
  const split = (value: unknown): { sheets: SheetSource[]; notes: NotesSource[] } | null => {
    const list = parseSourceList(value);
    return list ? {
      sheets: list.filter((s): s is SheetSource => s.kind === "file" || s.kind === "link"),
      notes: list.filter((s): s is NotesSource => s.kind === "notes"),
    } : null;
  };
  const sheetsOf = (value: unknown): SheetSource[] | null => split(value)?.sheets ?? null;
  const isNotes = (id: string) => state.notes.some(n => n.id === id);
  /** Reads kept only for what is listed. */
  const kept = <R>(reads: ReadonlyMap<string, R>, ids: readonly { id: string }[]) => new Map([...reads].filter(([id]) => ids.some(s => s.id === id)));
  const kindOf = (id: string): Kind => (state.sources ?? []).find(s => s.id === id)?.kind ?? "file";
  const withRead = (id: string, read: SourceRead | null) => {
    const reads = new Map(state.reads);
    if (read) reads.set(id, read); else reads.delete(id);
    return reads;
  };
  // A list removed while it was being read keeps nothing from that read; a newer read of a list wins over an older one.
  const started = new Map<string, number>();
  let generation = 0;
  const readOne = async (id: string): Promise<void> => {
    const mine = ++generation;
    started.set(id, mine);
    if (isNotes(id)) {
      let read: NotesRead;
      try { read = readNotesSource(await call<unknown>("church_source_read", { id }), now()); }
      catch (error) { read = { ok: false, at: now(), problem: sourceProblem(error, "notes") }; }
      if (started.get(id) !== mine || !isNotes(id)) return;
      const noteReads = new Map(state.noteReads);
      noteReads.set(id, read);
      set({ noteReads });
      return;
    }
    const kind = kindOf(id);
    let read: SourceRead;
    let unreadable = false;
    try {
      read = readSource(kind === "link" ? await call<unknown>("church_link_read", { id }, LINK_CALL_LIMIT_MS) : await call<unknown>("church_source_read", { id }), now(), kind);
    } catch (error) {
      read = { ok: false, at: now(), problem: sourceProblem(error, kind) };
      unreadable = error === "links-unreadable";
    }
    if (started.get(id) !== mine || !(state.sources ?? []).some(s => s.id === id)) return;
    set({ reads: withRead(id, read), ...(unreadable ? { linksUnreadable: true } : {}) });
  };
  /** A list as native code gave it back, put in place; a new one (`add`) is put at the end, and only a new one. */
  const replace = (view: unknown, kind?: Kind, add = false): boolean => {
    const [next] = sheetsOf([view]) ?? [];
    if (!next || (kind && next.kind !== kind)) return false;
    const sources = state.sources ?? [];
    if (!add && !sources.some(s => s.id === next.id)) return false;
    set({ sources: sources.some(s => s.id === next.id) ? sources.map(s => s.id === next.id ? next : s) : [...sources, next] });
    return true;
  };
  /** Notes as native code gave them back, put in place; new ones (`add`) at the end, and only new ones. */
  const replaceNotes = (view: unknown, add = false): boolean => {
    const [next] = split([view])?.notes ?? [];
    if (!next) return false;
    const notes = state.notes;
    if (!add && !notes.some(n => n.id === next.id)) return false;
    set({ notes: notes.some(n => n.id === next.id) ? notes.map(n => n.id === next.id ? next : n) : [...notes, next] });
    return true;
  };
  const total = () => (state.sources ?? []).length + state.notes.length;

  /**
   * Lists the lists again without reading any: after an add the page stopped waiting for, which may have been saved
   * after all, or one native code already has (review T, B), so the page shows what native code keeps and a retry
   * finds it there. A list that appears is read on its own "Read it now" or the next opening.
   */
  const relist = async () => {
    let listed: ReturnType<typeof split>;
    try { listed = split(await call<unknown>("church_sources")); } catch { return; }
    if (listed) set({ sources: listed.sheets, notes: listed.notes, reads: kept(state.reads, listed.sheets), noteReads: kept(state.noteReads, listed.notes) });
  };
  /** Nothing of any list or notes kept: after "Forget all lists and notes". */
  /**
   * After a forget whose links' addresses the Keychain kept: list natively at the next opening of Sunday or Church
   * lists, whatever the time, since listing is what removes them (review U, finding 3).
   */
  let listAgain = false;
  const forgotten = () => {
    started.clear();
    set({ sources: [], notes: [], listProblem: null, listUnreadable: false, linksUnreadable: false, reads: new Map(), noteReads: new Map(), focus: null, readAt: now() });
  };

  // Saving one change at a time (update).
  let edits: Promise<unknown> = Promise.resolve();
  const saveEdit = async (id: string, edit: SourceEdit): Promise<string | null> => {
    const source = (state.sources ?? []).find(s => s.id === id);
    if (!source) return sourceProblem("unavailable");
    const label = plainLine(edit.label ?? source.label, MAX_LABEL);
    if (!label) return NO_LABEL;
    const ticked = [...(typeof edit.ticked === "function" ? edit.ticked(source.ticked) : edit.ticked ?? source.ticked)];
    if (ticked.length > MAX_TICKED) return TOO_MANY_TICKED;
    const matches = [...(typeof edit.matches === "function" ? edit.matches(source.matches) : edit.matches ?? source.matches)].map(([value, m]) => ({ value, ...m }));
    const column = edit.column === undefined ? source.column : edit.column;
    let view: unknown;
    try { view = await call<unknown>("church_source_set", { id, label, column, ticked, matches }); }
    catch (error) { return sourceProblem(error); }
    // Removed while it was being saved: nothing to bring back, and nothing to say (review S2, B).
    if (!(state.sources ?? []).some(s => s.id === id)) return null;
    return replace(view) ? null : sourceProblem(null);
  };
  const saveNotes = async (id: string, edit: NotesEdit): Promise<string | null> => {
    const source = state.notes.find(n => n.id === id);
    if (!source) return sourceProblem("unavailable");
    const label = plainLine(edit.label ?? source.label, MAX_LABEL);
    if (!label) return NO_NOTES_LABEL;
    const attachments = [...(typeof edit.attachments === "function" ? edit.attachments(source.attachments) : edit.attachments ?? source.attachments)];
    if (attachments.length > MAX_ATTACHMENTS) return TOO_MANY_POINTERS;
    let view: unknown;
    try { view = await call<unknown>("church_notes_set", { id, label, attachments }); }
    catch (error) { return sourceProblem(error, "notes"); }
    if (!isNotes(id)) return null;
    return replaceNotes(view) ? null : sourceProblem(null);
  };

  const controller = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    state: () => state,

    /** Lists the lists, then reads each one. */
    async load() {
      try {
        const listed = split(await call<unknown>("church_sources"));
        if (!listed) {
          set({ sources: [], notes: [], listProblem: SOURCE_PROBLEMS["list-unreadable"], listUnreadable: true, linksUnreadable: false, reads: new Map(), noteReads: new Map() });
        } else {
          set({ sources: listed.sheets, notes: listed.notes, listProblem: null, listUnreadable: false, linksUnreadable: false, reads: kept(state.reads, listed.sheets),
            noteReads: kept(state.noteReads, listed.notes) });
        }
      } catch (error) {
        set({ sources: [], notes: [], listProblem: sourceProblem(error), listUnreadable: error === "list-unreadable", linksUnreadable: false, reads: new Map(), noteReads: new Map() });
      }
      await controller.read();
    },

    /** "Read again": every list, from its file or its link, and all notes, from their files. */
    async read() {
      const ids = [...(state.sources ?? []), ...state.notes].map(s => s.id);
      if (!ids.length) { set({ reading: false, readAt: now() }); return; }
      set({ reading: true });
      await Promise.all(ids.map(readOne));
      set({ reading: false, readAt: now() });
    },

    /** One list's "Read again". */
    readOne,

    /** Sunday or Church lists in front: lists them the first time, then reads again once the last read is over an hour old. */
    async readIfOld(maxAgeMs = READ_AGAIN_MS) {
      if (state.reading) return;
      if (state.sources === null || listAgain) { listAgain = false; await controller.load(); return; }
      if (state.readAt && Date.parse(now()) - Date.parse(state.readAt) < maxAgeMs) return;
      await controller.read();
    },

    /** "Add a list from this Mac": Ozzie's own panel, then the new list read. */
    async choose(): Promise<ChooseResult> {
      if (total() >= MAX_SOURCES) return { problem: TOO_MANY_LISTS };
      let view: unknown;
      try { view = await call<unknown>("church_source_choose_file", undefined, CHOOSE_LIMIT_MS); }
      catch (error) { return { problem: sourceProblem(error) }; }
      if (view === null || view === undefined) return { cancelled: true };
      if (!replace(view, "file", true)) return { problem: sourceProblem(null) };
      const id = (view as { id: string }).id;
      await readOne(id);
      return { added: id };
    },

    /**
     * "Add a list from a private link": the address goes to native code once, which reads it (it must give back a
     * sheet), keeps it in this Mac's Keychain and gives back the new list, the host masked, with the sheet it read. The
     * address is kept nowhere here, whatever the answer.
     */
    async addLink(label: string, address: string): Promise<AddLinkResult> {
      const name = plainLine(label, MAX_LABEL);
      if (!name) return { problem: NO_LABEL };
      if (!address.trim()) return { problem: NO_ADDRESS };
      const list = state.sources ?? [];
      if (list.filter(s => s.kind === "link").length >= MAX_LINKS) return { problem: sourceProblem("too-many-links", "link") };
      if (total() >= MAX_SOURCES) return { problem: TOO_MANY_LISTS };
      let reply: unknown;
      try { reply = await call<unknown>("church_link_add", { label: name, address }, LINK_CALL_LIMIT_MS); }
      catch (error) {
        if (error === "links-unreadable") set({ linksUnreadable: true });
        if (error === "unavailable" || error === "link-already-added") await relist();
        return { problem: sourceProblem(error, "link") };
      }
      const added = linkAdded(reply);
      if (!added || !replace(added.source, "link", true)) return { problem: sourceProblem(null) };
      const id = (added.source as { id: string }).id;
      started.set(id, ++generation);
      set({ reads: withRead(id, readSource(added.sheet, now(), "link")) });
      return { added: id };
    },

    /**
     * Saves what the leader changed on a list (native code keeps it). Returns a plain-words problem, or null. Changes are
     * saved one after another, each to the list as the one before left it, since native code keeps each whole.
     */
    update(id: string, edit: SourceEdit): Promise<string | null> {
      const run = edits.then(() => saveEdit(id, edit));
      edits = run.catch(() => null);
      return run;
    },

    /** "Add notes from this Mac": Ozzie's own panel (plain text or Markdown), then the new notes read. */
    async chooseNotes(): Promise<ChooseResult> {
      if (total() >= MAX_SOURCES) return { problem: TOO_MANY_LISTS };
      let view: unknown;
      try { view = await call<unknown>("church_notes_choose_file", undefined, CHOOSE_LIMIT_MS); }
      catch (error) { return { problem: sourceProblem(error, "notes") }; }
      if (view === null || view === undefined) return { cancelled: true };
      if (!replaceNotes(view, true)) return { problem: sourceProblem(null) };
      const id = (view as { id: string }).id;
      await readOne(id);
      return { added: id };
    },

    /** Saves what the leader changed on notes (their label and the sections attached), one change after another. */
    updateNotes(id: string, edit: NotesEdit): Promise<string | null> {
      const run = edits.then(() => saveNotes(id, edit));
      edits = run.catch(() => null);
      return run;
    },

    /** A section to open on Church lists (from a Sunday card's "Open"), or none once it has been shown. */
    focus(target: NoteFocus | null) { set({ focus: target }); },

    /** Removes a list or notes from Ozzie (a link's address from the Keychain too); its file or sheet stays as it is, and nothing read from it is kept. */
    async remove(id: string): Promise<string | null> {
      if (isNotes(id)) {
        try { await call<void>("church_source_remove", { id }); }
        catch (error) { return sourceProblem(error, "notes"); }
        started.delete(id);
        const noteReads = new Map(state.noteReads);
        noteReads.delete(id);
        set({ notes: state.notes.filter(n => n.id !== id), noteReads, focus: state.focus?.id === id ? null : state.focus });
        return null;
      }
      const kind = kindOf(id);
      try { await (kind === "link" ? call<void>("church_link_remove", { id }, LINK_CALL_LIMIT_MS) : call<void>("church_source_remove", { id })); }
      catch (error) { return sourceProblem(error, kind); }
      started.delete(id);
      set({ sources: (state.sources ?? []).filter(s => s.id !== id), reads: withRead(id, null) });
      return null;
    },

    /**
     * "Forget all lists", after the person confirms: native code forgets the list and every link's address, and nothing
     * read is kept. When the Keychain keeps the addresses for now, the lists are still forgotten and the page says so.
     */
    async forgetAll(): Promise<string | null> {
      try { await call<void>("church_sources_forget_all", undefined, LINK_CALL_LIMIT_MS); }
      catch (error) {
        if (error !== "links-left-in-keychain") return sourceProblem(error, "link");
        forgotten();
        listAgain = true;
        return sourceProblem(error, "link");
      }
      forgotten();
      return null;
    },

    /** "Forget all private links", after the person confirms: every link's address and list go; files' lists stay. */
    async forgetLinks(): Promise<string | null> {
      try { await call<void>("church_links_forget_all", undefined, LINK_CALL_LIMIT_MS); }
      catch (error) { return sourceProblem(error, "link"); }
      const gone = new Set((state.sources ?? []).filter(s => s.kind === "link").map(s => s.id));
      for (const id of gone) started.delete(id);
      set({ sources: (state.sources ?? []).filter(s => !gone.has(s.id)), reads: new Map([...state.reads].filter(([id]) => !gone.has(id))), linksUnreadable: false });
      return null;
    },
  };
  return controller;
}

/** The lists' state, for a page. */
export const useChurchSources = (sources: ChurchSources): ChurchSourcesState => useSyncExternalStore(sources.subscribe, sources.state, sources.state);
