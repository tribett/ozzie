// The church's own notes on Church lists: a plain text or Markdown file the leader adds from this Mac (a child safety
// policy, what to do on a snow day), shown in sections, with a find box. Nothing here renders Markdown: a `#` heading
// only starts a section and names it, and every line (a link or an image's text included) is shown as the text it is.
// Every line of every section is drawn, a heading as written too when its title had to be cut or tidied (review V, H1);
// the only changes are the documented cleaning (core/src/sources/text.ts `noteLine`). A find highlights what it found
// by splitting the text, never by building markup.
//
// The leader can point to a section from the Sunday cards for one Planning Center team (by its id) or about one kind
// of finding (from a closed list), only by choosing it here; nothing compares the notes' words with Planning Center or
// with anyone's name (the find box compares them with what is typed). When
// titles repeat, the sections are named apart ("Who to call (2)") and a pointer keeps which one it means (review V,
// M1). The Sunday card then shows the section's name and a way to open it here (church-own-words.tsx). What is read
// lives in memory in church-sources.ts; Ozzie's own tests check that nothing which sends anything imports it or this
// page, and that they use none of the ways off the page the test names (core/test/sources/stays-on-this-mac.test.ts; a
// check on Ozzie's own code, not a sandbox).
import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { PositionLabel } from "../../../core/src/sunday-capture.js";
import { MAX_HITS, occurrenceOf, pointerState, searchNotes, sectionName, titleCount, type NoteRange, type Notes, type NoteSection } from "../../../core/src/sources/notes.js";
import { MAX_LABEL, NOTE_FINDING_KINDS, type NoteAttachment, type NotesSource } from "../../../core/src/sources/types.js";
import { GUESSED_LETTERS_NOTES, LINES_CUT, LONG_LINES_CUT, NOTE_KIND_WORDS, NOTES_FRAME, readFrom } from "../../../core/src/sources/words.js";
import { plainLine } from "../../../core/src/sources/text.js";
import { TOO_MANY_POINTERS, type ChurchSources, type ChurchSourcesState, type NotesRead } from "./church-sources.js";
import { Icon } from "./icons.js";

export { TOO_MANY_POINTERS };
export const NOTES_TITLE = "Notes";
/** The one sentence before the button (audit item 26); how notes are split and saved is folded under HOW_NOTES. */
export const NOTES_BODY = "Add your church's own notes, such as a child safety policy, to read and search them here and point to a section from the cards you choose.";
export const HOW_NOTES = "How to save notes";
export const NOTES_SECTIONS = "Ozzie shows notes in sections, with a find box: a new section starts at each # heading, or, in a file with no headings, at each blank line.";
export const AS_WRITTEN = "Notes are shown as written, except that hidden format characters are removed, tabs and other control characters become spaces, and a line over 2,000 characters or a file over 20,000 lines is cut, which the notes then say.";
export const ADD_NOTES = "Add notes from this Mac";
export const ADD_NOTES_HELP = "Choose a file saved as plain text (.txt) or Markdown (.md), up to 1 MB. In Word choose File › Save As and pick Plain Text. In Pages choose File › Export To › Plain Text.";
export const NO_NOTES = "No notes yet.";
export const NOTES_NAME = "Name these notes";
export const FIND_NOTES = "Find in these notes";
export const FIND_HELP = "The find box searches these notes on this Mac. Ozzie never compares their words with Planning Center or with anyone's name.";
export const NOTHING_IN_NOTES = "Nothing in these notes matches that.";
export const MORE_PLACES = `Ozzie marked the first ${MAX_HITS.toLocaleString("en-US")} places. Type more to narrow them.`;
export const ATTACH_LABEL = "Point to this section from cards";
export const NOT_ON_SUNDAY = "Not on any card";
export const TEAM_CARDS = "Cards for a team";
export const KIND_CARDS = "Cards about";
export const KEEP_CHOICE = "Keep this choice (a team not in this check)";
export const UNTITLED = "Untitled section";
export const EMPTY_SECTION = "This section has no text under its heading.";
export const REMOVE_NOTES = "Remove these notes";
export const PART_SHOWN = "Ozzie showed the start of this section.";
export const MORE_OF_SECTION = "Show more of this section";
export const MORE_SECTIONS = "Show more sections";
export const FORGET_POINTER = "Forget this choice";
export const removeNotesConfirm = (label: string) => `Remove “${label}” from Ozzie? Ozzie forgets these notes and where you pointed to them. The file stays where it is on this Mac.`;
export const sectionsShown = (shown: number, all: number) => `Showing the first ${shown} of ${all.toLocaleString("en-US")} sections.`;
/** A section once pointed to from Sunday that is no longer in the file (review V, L3). */
export const goneNotice = (name: string) => `“${name}” was shown on cards, but it is no longer in these notes. If a section with that title comes back, Ozzie shows it there again.`;
/** A pointed title now shared by a different number of sections (audit item 30): Ozzie stops showing it on Sunday rather than guess. */
export const changedNotice = (title: string, count: number) =>
  `These notes changed: there ${count === 1 ? "is now 1 section" : `are now ${count.toLocaleString("en-US")} sections`} called “${title}”. Choose again, so the cards show the one you mean.`;
/** What the page lays out at once, as for a list's table (church-lists-page.tsx); "Show more" lays out more. */
export const SHOWN_SECTIONS = 200;
export const SHOWN_CHARACTERS = 150_000;
/** Space left above a section moved to, so it doesn't sit against the pane's edge. */
export const PANE_MARGIN = 16;

/** What moving to a section needs of its heading: the pane it scrolls in, where it is, and keyboard focus. */
export interface Place {
  closest(selector: "main"): { scrollTop: number; getBoundingClientRect(): { top: number } } | null;
  getBoundingClientRect(): { top: number };
  focus(options?: { preventScroll?: boolean }): void;
}
/**
 * Moves to a section: scrolls only the page pane it is in so its heading is near the top, then moves keyboard focus
 * there without scrolling again. Never scrollIntoView, which scrolls every box around the pane too (in the real app it
 * pushed the whole window up; the coordinator's 0.1.8 click-through).
 */
export function showInPane(place: Place): void {
  const pane = place.closest("main");
  if (pane) pane.scrollTop += place.getBoundingClientRect().top - pane.getBoundingClientRect().top - PANE_MARGIN;
  place.focus({ preventScroll: true });
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
/** A section as the page names it: apart from any other with its title, or "Untitled section". */
const named = (notes: Notes, index: number) => sectionName(notes, index) || UNTITLED;

/** A line with what a find found marked: the text split at each range, each found part in a <mark>, all as text. */
function Marked({ text, ranges }: { text: string; ranges: readonly NoteRange[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach((r, i) => {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(<mark key={i}>{text.slice(r.start, r.end)}</mark>);
    at = r.end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
/**
 * Every line a section has, each its own line with its spacing kept: a heading's text as written when its title had to
 * be cut or tidied, then the lines under it; a section without a heading starts with the line that names it. Laid
 * out up to `budget` characters, then "Show more of this section".
 */
function Lines({ section, budget, onMore }: { section: NoteSection; budget: number; onMore: () => void }) {
  const lines = [...(section.written !== undefined ? [section.written] : []), ...section.lines];
  if (!lines.length) return <p className="small">{EMPTY_SECTION}</p>;
  let characters = 0;
  const shown: string[] = [];
  for (const line of lines) {
    characters += line.length;
    if (shown.length > 0 && characters > budget) break;
    shown.push(line);
  }
  return <>
    <div className="note-text">{shown.map((line, i) => <div key={i} className={i === 0 && section.written !== undefined ? "note-line note-written" : "note-line"}>
      {line === "" ? " " : line}</div>)}</div>
    {shown.length < lines.length && <div className="find-next"><span className="small">{PART_SHOWN}</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onMore}>{MORE_OF_SECTION}</button></div>}
  </>;
}

/** What a find found in the notes: each section with a place found, its name and the lines found, marked. */
export const NotesFound = memo(function NotesFound({ notes, query }: { notes: Notes; query: string }) {
  const found = useMemo(() => searchNotes(notes, query), [notes, query]);
  if (!found.hits.length) return <p className="small" role="status">{NOTHING_IN_NOTES}</p>;
  const bySection = new Map<number, typeof found.hits>();
  for (const hit of found.hits) bySection.set(hit.section, [...(bySection.get(hit.section) ?? []), hit]);
  return <div className="stack-tight">
    {[...bySection].map(([index, hits]) => {
      const section = notes.sections[index]!;
      const title = hits.find(h => h.line === "title");
      const name = named(notes, index);
      return <div key={index} className="note-found">
        {/* A heading found is shown as written, every word of it, since that is what was searched. */}
        <h3 className="note-title">{title ? <><Marked text={section.written ?? section.title} ranges={title.ranges} />{name.slice(section.title.length)}</> : name}</h3>
        <div className="note-text">{hits.filter(h => h.line !== "title").map(h => <div key={String(h.line)} className="note-line">
          <Marked text={section.lines[h.line as number]!} ranges={h.ranges} /></div>)}</div>
      </div>;
    })}
    {found.more && <p className="small" role="status">{MORE_PLACES}</p>}
  </div>;
});

/** A team as Church rules name it, by its positions' names in the last check (as church-lists-page.tsx names one). */
function teamNames(positions: readonly PositionLabel[]): Map<string, string> {
  const names = new Map<string, string[]>();
  for (const p of positions) names.set(p.team_id, [...new Set([...(names.get(p.team_id) ?? []), p.name])]);
  return new Map([...names].map(([team, list]) => [team, `${list.join(", ")} team`]));
}
const KEEP = "keep";
/** Whether a pointer means this section: its title and which occurrence of it (the first by default). */
const means = (a: NoteAttachment, title: string, occurrence: number) => a.section === title && (a.occurrence ?? 1) === occurrence;
const samePointer = (a: NoteAttachment, b: NoteAttachment) =>
  a.section === b.section && (a.occurrence ?? 1) === (b.occurrence ?? 1) && ("team_id" in a ? "team_id" in b && a.team_id === b.team_id : "finding_kind" in b && a.finding_kind === b.finding_kind);
/**
 * The pointers once the leader chooses for one section (its title and which occurrence of it): its own pointer
 * replaced by the choice ("team:<id>", "kind:<kind>", or "" for not on Sunday); every other pointer as it was.
 */
export function choosePointer(attachments: readonly NoteAttachment[], title: string, occurrence: number, choice: string, of?: number): NoteAttachment[] {
  if (choice === KEEP) return [...attachments];
  const [what, target = ""] = choice.split(/:(.*)/su);
  // How many sections share the title now, so a later change is said rather than followed (audit item 30).
  const which = { ...(occurrence > 1 ? { occurrence } : {}), ...(of !== undefined ? { of } : {}) };
  const next: NoteAttachment | null = what === "team" ? { section: title, team_id: target, ...which }
    : what === "kind" ? { section: title, finding_kind: target, ...which } : null;
  return [...attachments.filter(a => !means(a, title, occurrence)), ...(next ? [next] : [])];
}
/** Where a section is pointed to from Sunday: nowhere, a team's cards, or the cards about one kind of finding. */
function AttachChoice({ title, occurrence, of, attachments, teams, onChange }: {
  title: string; occurrence: number; of: number; attachments: readonly NoteAttachment[]; teams: ReadonlyMap<string, string>;
  onChange: (change: (now: readonly NoteAttachment[]) => readonly NoteAttachment[]) => void;
}) {
  const id = useId();
  // A pointer whose title is now shared by a different number of sections names none of them (audit item 30).
  const mine = attachments.find(a => means(a, title, occurrence) && (a.of === undefined || a.of === of));
  const value = !mine ? "" : "team_id" in mine ? (teams.has(mine.team_id) ? `team:${mine.team_id}` : KEEP) : `kind:${mine.finding_kind}`;
  return <div className="own-field">
    <label className="field-l" htmlFor={id}>{ATTACH_LABEL}</label>
    <select id={id} className="input own-column" value={value} onChange={e => { const choice = e.target.value; onChange(now => choosePointer(now, title, occurrence, choice, of)); }}>
      <option value="">{NOT_ON_SUNDAY}</option>
      {value === KEEP && <option value={KEEP}>{KEEP_CHOICE}</option>}
      {teams.size > 0 && <optgroup label={TEAM_CARDS}>{[...teams].map(([team, name]) => <option key={team} value={`team:${team}`}>{name}</option>)}</optgroup>}
      <optgroup label={KIND_CARDS}>{NOTE_FINDING_KINDS.map(kind => <option key={kind} value={`kind:${kind}`}>{NOTE_KIND_WORDS[kind]}</option>)}</optgroup>
    </select>
  </div>;
}

function Confirm({ question, yes, no, onYes, onNo }: { question: string; yes: string; no: string; onYes: () => void; onNo: () => void }) {
  const id = useId();
  return <div className="decide" role="group" aria-labelledby={id}>
    <p id={id} className="find-body">{question}</p>
    <div className="find-next">
      <button type="button" className="btn btn-primary btn-sm" onClick={onYes}>{yes}</button>
      <button type="button" className="btn btn-quiet btn-sm" onClick={onNo}>{no}</button>
    </div>
  </div>;
}

function NotesCard({ source, read, positions, sources, reading, focused }: {
  source: NotesSource; read: NotesRead | undefined; positions: readonly PositionLabel[]; sources: ChurchSources; reading: boolean;
  /** A section asked for from a Sunday card, laid out, opened and moved to (review V, L4). */
  focused: number | null;
}) {
  const [name, setName] = useState(source.label);
  const [query, setQuery] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(focused === null ? [] : [focused]));
  const [shownCount, setShownCount] = useState(() => Math.max(SHOWN_SECTIONS, (focused ?? -1) + 1));
  const [budgets, setBudgets] = useState<ReadonlyMap<number, number>>(new Map());
  const places = useRef(new Map<number, HTMLElement>());
  /** A section asked for, until it is laid out and moved to. */
  const [target, setTarget] = useState<number | null>(focused);
  const id = useId();
  const teams = useMemo(() => teamNames(positions), [positions]);
  useEffect(() => {
    if (focused === null) return;
    setQuery("");
    setShownCount(now => Math.max(now, focused + 1));
    setOpen(now => new Set([...now, focused]));
    setTarget(focused);
    sources.focus(null);
  }, [focused, sources]);
  // Once the section asked for is laid out (a find cleared, more sections shown): move to it.
  useEffect(() => {
    const place = target === null ? undefined : places.current.get(target);
    if (place) { showInPane(place); setTarget(null); }
  }, [target, query, shownCount, open]);
  const notes = read?.ok ? read.notes : null;
  const save = (edit: Parameters<ChurchSources["updateNotes"]>[1]) => { setProblem(null); void sources.updateNotes(source.id, edit).then(setProblem); };
  const renamed = plainLine(name, MAX_LABEL);
  const count = notes ? Math.min(notes.sections.length, shownCount) : 0;
  const gone = notes ? source.attachments.filter(a => pointerState(notes, a) === "gone") : [];
  const changed = notes ? source.attachments.filter(a => pointerState(notes, a) === "changed") : [];
  return <section className="find church-list church-notes" aria-labelledby={`${id}-t`}>
    <h2 id={`${id}-t`} className="settings-t">{source.label}</h2>
    <div className="checkline">
      {read?.ok && <><Icon name="check" small /><span>{readFrom(source.shown, clock(read.at))}</span></>}
      {!read && <span>{`${source.shown}. Not read yet since Ozzie opened.`}</span>}
      {read && !read.ok && <span>{source.shown}</span>}
      <button type="button" className="btn btn-quiet btn-sm" disabled={rereading || reading}
        onClick={() => { setRereading(true); void sources.readOne(source.id).finally(() => setRereading(false)); }}>
        {rereading ? "Reading…" : "Read again"}</button>
    </div>
    <p className="small own-note">{NOTES_FRAME}</p>
    {read && !read.ok && <p role="alert" className="problem">{read.problem}</p>}
    {notes && (notes.flags.guessedEncoding || notes.flags.linesCut || notes.flags.longLinesCut) && <ul className="list own-flags">
      {notes.flags.linesCut && <li><Icon name="dot" small />{LINES_CUT}</li>}
      {notes.flags.longLinesCut && <li><Icon name="dot" small />{LONG_LINES_CUT}</li>}
      {notes.flags.guessedEncoding && <li><Icon name="dot" small />{GUESSED_LETTERS_NOTES}</li>}
    </ul>}
    {gone.map((a, i) => <div key={i} className="note-gone find-next">
      <span className="small">{goneNotice(a.occurrence ? `${a.section} (${a.occurrence})` : a.section)}</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => save({ attachments: now => now.filter(x => !samePointer(x, a)) })}>{FORGET_POINTER}</button>
    </div>)}
    {notes && changed.map((a, i) => <div key={`c${i}`} className="note-gone find-next">
      <span className="small">{changedNotice(a.section, titleCount(notes, a.section))}</span>
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => save({ attachments: now => now.filter(x => !samePointer(x, a)) })}>{FORGET_POINTER}</button>
    </div>)}
    <div className="own-field">
      <label className="field-l" htmlFor={`${id}-name`}>{NOTES_NAME}</label>
      <div className="row">
        <input id={`${id}-name`} className="input own-name" value={name} maxLength={MAX_LABEL * 2} autoComplete="off" onChange={e => setName(e.target.value)} />
        <button type="button" className="btn btn-secondary btn-sm" disabled={renamed === source.label} onClick={() => save({ label: name })}>Save the name</button>
      </div>
    </div>
    {notes && <>
      <div className="stack-tight">
        <label className="field-l" htmlFor={`${id}-find`}>{FIND_NOTES}</label>
        <input id={`${id}-find`} className="input own-find" type="search" value={query} autoComplete="off" spellCheck={false} aria-describedby={`${id}-find-help`}
          onChange={e => setQuery(e.target.value)} />
        <p id={`${id}-find-help`} className="input-help">{FIND_HELP}</p>
      </div>
      {query.trim() ? <NotesFound notes={notes} query={query} /> : <div className="note-sections">
        {notes.sections.slice(0, count).map((section, index) => <details key={index} className="note-section" open={open.has(index)}
          onToggle={e => { const isOpen = e.currentTarget.open; setOpen(now => { const next = new Set(now); if (isOpen) next.add(index); else next.delete(index); return next; }); }}>
          <summary className="note-title" ref={el => { if (el) places.current.set(index, el); else places.current.delete(index); }}>
            <Icon name="chev" small />{named(notes, index)}</summary>
          {open.has(index) && <div className="note-body stack-tight">
            <Lines section={section} budget={budgets.get(index) ?? SHOWN_CHARACTERS}
              onMore={() => setBudgets(now => new Map(now).set(index, (now.get(index) ?? SHOWN_CHARACTERS) + SHOWN_CHARACTERS))} />
            {/* A section without a title can't be named on Sunday, so it offers no choice (review V, L2). */}
            {section.title && <AttachChoice title={section.title} occurrence={occurrenceOf(notes, index)} of={titleCount(notes, section.title)} attachments={source.attachments} teams={teams}
              onChange={attachments => save({ attachments })} />}
          </div>}
        </details>)}
        {notes.sections.length > count && <div className="find-next"><span className="small">{sectionsShown(count, notes.sections.length)}</span>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setShownCount(now => now + SHOWN_SECTIONS)}>{MORE_SECTIONS}</button></div>}
      </div>}
    </>}
    {problem && <p role="alert" className="problem">{problem}</p>}
    {!removing && <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={() => setRemoving(true)}>{REMOVE_NOTES}</button></div>}
    {removing && <Confirm question={removeNotesConfirm(source.label)} yes="Yes, remove them" no="Keep them"
      onYes={() => { setRemoving(false); void sources.remove(source.id).then(setProblem); }} onNo={() => setRemoving(false)} />}
  </section>;
}

/** The Notes part of Church lists: adding notes, and each one's card. */
export function ChurchNotes({ sources, state, positions }: {
  sources: ChurchSources; state: ChurchSourcesState; positions: readonly PositionLabel[];
}) {
  const [choosing, setChoosing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choose = () => {
    setChoosing(true); setProblem(null);
    void sources.chooseNotes().then(r => { if ("problem" in r) setProblem(r.problem); }).finally(() => setChoosing(false));
  };
  return <div className="col church-notes-part">
    <h2 className="h2">{NOTES_TITLE}</h2>
    <p className="lede">{NOTES_BODY}</p>
    <div className="row">
      <button type="button" className="btn btn-secondary" disabled={choosing} onClick={choose}>
        {choosing ? <><Icon name="spinner" small spin />Choosing a file…</> : ADD_NOTES}</button>
    </div>
    <details className="listen-more"><summary><Icon name="chev" small />{HOW_NOTES}</summary>
      <div className="stack-tight"><p className="small">{ADD_NOTES_HELP}</p><p className="small">{NOTES_SECTIONS}</p><p className="small">{AS_WRITTEN}</p></div></details>
    {problem && <p role="alert" className="problem">{problem}</p>}
    {state.sources !== null && state.notes.length === 0 && <p className="small">{NO_NOTES}</p>}
    {state.notes.map(n => <NotesCard key={n.id} source={n} read={state.noteReads.get(n.id)} positions={positions} sources={sources} reading={state.reading}
      focused={state.focus?.id === n.id ? state.focus.section : null} />)}
  </div>;
}
