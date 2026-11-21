// Church lists: spreadsheets the church keeps (who holds which keys, a snack rota), added from this Mac or from a
// private link to a published sheet, and shown as the church's own words. The leader names each list, says which column names a team or role, matches its values to
// Planning Center teams and positions (Ozzie only suggests a same-named position; a suggestion counts once the leader
// uses it) and ticks the columns shown beside a matched card. The whole list is shown here in the file's own
// order, with a find box. No row has an action: nothing is copied, exported, drafted or mailed from here.
//
// What is read lives in memory in church-sources.ts; native code keeps the files' places, the links' addresses (in the
// Keychain) and the leader's matches. A link's card shows only where it points, masked.
// Nothing here goes to AI help, other AI apps, Siri, a notice or the briefing (core/test/sources/stays-on-this-mac.test.ts).
// So this page imports nothing the sending side does, the day words included: its sentences name no day, and never
// "Sunday" for a service on another day (onboarding spec §5.1).
import { memo, useContext, useId, useMemo, useState } from "react";
import type { PositionLabel } from "../../../core/src/sunday-capture.js";
import { MAX_COLUMNS, type Sheet } from "../../../core/src/sources/sheet.js";
import { columnValues, matchFor, suggestMatches, type MatchTarget, type Suggestion } from "../../../core/src/sources/match.js";
import { MAX_LABEL, MAX_TICKED, type SheetSource, type SourceMatch } from "../../../core/src/sources/types.js";
import { CELLS_CUT, GUESSED_LETTERS, readFrom, ROWS_CUT, SAME_NAME, SOURCE_PROBLEMS, USE_MATCH } from "../../../core/src/sources/words.js";
import { plainLine } from "../../../core/src/sources/text.js";
import { useChurchSources, type ChurchSources, type SourceRead } from "./church-sources.js";
import { LINK_TITLE, LinkForm } from "./church-link-form.js";
import { ListsSystemName, ListsTeamServices, sayFor, teamNames } from "./church-notes.js";
import { ChurchNotes } from "./church-notes.js";
import { Icon } from "./icons.js";
import "./church-lists.css";

/** The page's name (the sidebar's, spec §6), as its eyebrow; LISTS_HEADING is its title (owner's polish pass, 2026-11-18). */
export const LISTS_TITLE = "Church lists";
export const LISTS_HEADING = "Your church's own lists and notes";
/** The one sentence before the first button (audit item 26); how to save a list is folded under HOW_LISTS. */
export const LISTS_BODY = "Add a list your church keeps, such as who holds which keys, and Ozzie shows its rows beside the cards you match it to.";
export const HOW_LISTS = "How to save a list";
/**
 * What stays on this Mac, the promise first and then when Ozzie reads a list or notes, in short sentences (it was one
 * sentence of 60 words; polish pass). Re-read on opening a page: church-sources.ts, the first time, then once an hour.
 */
export const LISTS_STAYS = "Your lists and notes stay on this Mac.";
export const LISTS_PRIVATE = "They aren't sent to AI help, shared with other AI apps or Siri, or put in any notice. Ozzie never changes them.";
export const LISTS_WHEN = "Ozzie reads each one from its file or link when you add it and when you ask. It also reads them when you open your service's page or this page: the first time after Ozzie starts, then at most once an hour. It never reads them while the window is closed or hidden.";
export const LIST_FRAME = "This is your church's own list. Ozzie shows it as written and doesn't check it.";
export const ADD_LIST = "Add a list from this Mac";
export const ADD_LINK = LINK_TITLE;
export const ADD_HELP = "Choose a spreadsheet saved as CSV or tab-separated text, up to 2 MB. In Numbers choose File › Export To › CSV. In Excel choose File › Save As and pick CSV UTF-8.";
export const NO_LISTS = "No lists yet.";
export const NAME_LABEL = "Name this list";
export const SAVE_NAME = "Save the name";
export const COLUMN_QUESTION = "Which column names the team or role?";
export const COLUMN_HELP = "Ozzie matches the values in that column to Planning Center teams and positions, only as you choose. Choosing another column clears these matches.";
export const MATCH_HELP = "A suggestion counts only once you choose “Use this match”. Ozzie never compares names in your list with people in Planning Center.";
export const NEEDS_CHECK = "Run a check first to see the teams and positions to match.";
export const SHOW_QUESTION = `Which columns to show beside a matched card (up to ${MAX_TICKED})`;
export const SHOW_NONE = "None yet: a matched card shows nothing from this list until you tick at least one.";
export const FIND_LABEL = "Find in this list";
export const NOT_READ = "Not read yet since Ozzie opened.";
/** Before a link's masked address, until it has been read. */
export const LINK_TO = "Private link to";
export const READ_AGAIN = "Read again";
/** A link's button after a read that didn't work, and before its first read. */
export const TRY_AGAIN = "Try again";
export const READ_NOW = "Read it now";
export const READING = "Reading…";
export const REMOVE_LIST = "Remove this list";
export const FORGET_ALL = "Forget all lists and notes";
export const FORGET_CONFIRM = "Forget all lists and notes? Ozzie forgets which files and links you added, every match you made and every section you pointed to, and deletes the links from this Mac's Keychain. The files and sheets themselves don't change.";
export const removeConfirm = (label: string) => `Remove “${label}” from Ozzie? Ozzie forgets this list and its matches. The file stays where it is on this Mac.`;
export const removeLinkConfirm = (label: string) => `Remove “${label}” from Ozzie? Ozzie forgets this list, its matches and its link, and deletes the link from this Mac's Keychain. The sheet itself doesn't change.`;
export const FORGET_LINKS = "Forget all private links";
export const FORGET_LINKS_CONFIRM = "Forget all private links? Ozzie deletes every sheet link it saved in this Mac's Keychain, and the lists that read from them. The sheets themselves don't change, and you can add links again afterwards.";
/**
 * What the page lays out at once, so a list of long cells can't hold up the window (timed in the built page: a table of
 * 200 rows of 30 cells of 500 characters took over a second to lay out; reading the same 2 MB file took under 50 ms).
 * The match table lists the first different values; the list's table its first rows, until either limit, and find
 * narrows them.
 */
export const SHOWN_VALUES = 50;
export const SHOWN_ROWS = 200;
export const SHOWN_CHARACTERS = 150_000;
export const someShown = (shown: number, all: number) => `Showing the first ${shown} of ${all.toLocaleString("en-US")} rows. Find narrows them.`;
export const valuesShown = (shown: number, all: number) => `Showing the first ${shown} of ${all.toLocaleString("en-US")} different values.`;
export const NOTHING_FOUND = "Nothing in this list matches that.";

const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
/** A link's host, from where native code shows it ("docs.google.com/•••"). */
const linkHost = (shown: string) => shown.endsWith("/•••") ? shown.slice(0, -"/•••".length) : shown;
/** Folded for find: case, accents and spacing ignored. */
const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();

/** A team as Church rules name it (church-notes.tsx): by its positions' names, and its service with more than one watched. */
export { teamNames } from "./church-notes.js";
/** What a match says, in words: the whole team, or one position on it. */
export function matchText(match: SourceMatch, teams: ReadonlyMap<string, string>): string {
  const team = teams.get(match.team_id);
  if (match.position_name !== undefined) return team ? `${match.position_name} on the ${team}` : `${match.position_name} on a team not in this check`;
  return team ? `Everyone on the ${team}` : "A team not in this check";
}
const key = (m: SourceMatch) => JSON.stringify([m.team_id, m.position_name ?? null]);
/** The select's value for a match kept from an earlier check (a key is always a JSON array, so never this). */
const KEEP = "keep";
export const KEEP_MATCH = "Keep this match";
export const NOT_MATCHED = "Not matched";

/** The values in the chosen column, each with its match, a same-named suggestion to use, or a choice of team or position. */
function MatchTable({ sheet, source, positions, onMatches }: {
  sheet: Sheet; source: SheetSource; positions: readonly PositionLabel[];
  /** A change to the matches, made to them as they are when it is saved (two quick changes both land). */
  onMatches: (change: (now: ReadonlyMap<string, SourceMatch>) => ReadonlyMap<string, SourceMatch>) => void;
}) {
  const values = useMemo(() => columnValues(sheet, source.column ?? ""), [sheet, source.column]);
  const targets: MatchTarget[] = useMemo(() => positions.map(p => ({ team_id: p.team_id, name: p.name, position_id: p.position_id })), [positions]);
  const services = useContext(ListsTeamServices);
  const teams = useMemo(() => teamNames(positions, services), [positions, services]);
  const suggestions = useMemo(() => new Map(suggestMatches(values, targets).map(s => [s.value, s])), [values, targets]);
  // The choices: each team in the last check, as a whole and by each of its positions' names.
  const choices = useMemo(() => [...teams].map(([team_id, name]) => ({
    team_id, name,
    matches: [{ team_id, name }, ...positions.filter(p => p.team_id === team_id)].map(matchFor)
      .filter((m, i, all): m is SourceMatch => m !== null && all.findIndex(x => x !== null && key(x) === key(m)) === i),
  })), [teams, positions]);
  const set = (value: string, match: SourceMatch | null) => onMatches(now => {
    const next = new Map(now);
    if (match) next.set(value, match); else next.delete(value);
    return next;
  });
  const id = useId();
  const system = useContext(ListsSystemName);
  if (!values.length) return <p className="small">That column has nothing in it to match.</p>;
  return <div className="stack-tight">
    <p className="small">{sayFor(MATCH_HELP, system)}</p>
    {!positions.length && <p className="small">{NEEDS_CHECK}</p>}
    <table className="own-table match-table">
      <thead><tr><th scope="col">In your list</th><th scope="col">Matched to</th></tr></thead>
      <tbody>{values.slice(0, SHOWN_VALUES).map((value, i) => {
        const match = source.matches.get(value);
        const suggestion: Suggestion | undefined = match ? undefined : suggestions.get(value);
        const known = match && choices.some(c => c.matches.some(m => key(m) === key(match)));
        return <tr key={value}>
          <td className="match-value">{value}</td>
          <td>
            <div className="match-cell">
              {match && <span className="match-now">{matchText(match, teams)}</span>}
              {suggestion && <span className="match-suggest">
                <span className="small">{SAME_NAME[suggestion.what]}: {matchText(suggestion.match, teams)}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => set(value, suggestion.match)}>{USE_MATCH}</button>
              </span>}
              {(choices.length > 0 || match) && <>
                <label className="sr-only" htmlFor={`${id}-${i}`}>{`Match “${value}” to a team or position`}</label>
                {/* A match to a team not in this check stays until the leader chooses otherwise; "Not matched" removes it. */}
                <select id={`${id}-${i}`} className="input match-select" value={!match ? "" : known ? key(match) : KEEP}
                  onChange={e => {
                    if (e.target.value === KEEP) return;
                    set(value, choices.flatMap(c => c.matches).find(m => key(m) === e.target.value) ?? null);
                  }}>
                  {match && !known && <option value={KEEP}>{KEEP_MATCH}</option>}
                  <option value="">{NOT_MATCHED}</option>
                  {choices.map(c => <optgroup key={c.team_id} label={c.name}>
                    {c.matches.map(m => <option key={key(m)} value={key(m)}>{m.position_name ?? "The whole team"}</option>)}
                  </optgroup>)}
                </select>
              </>}
            </div>
          </td>
        </tr>;
      })}</tbody>
    </table>
    {values.length > SHOWN_VALUES && <p className="small">{valuesShown(SHOWN_VALUES, values.length)}</p>}
  </div>;
}

/** The first rows that fit within SHOWN_ROWS and SHOWN_CHARACTERS (always at least one). */
export function shownRows(rows: readonly string[][]): string[][] {
  const out: string[][] = [];
  let characters = 0;
  for (const row of rows) {
    characters += row.reduce((n, cell) => n + cell.length, 0);
    if (out.length === SHOWN_ROWS || (out.length > 0 && characters > SHOWN_CHARACTERS)) break;
    out.push(row);
  }
  return out;
}

/**
 * The list in the file's own order, with a find box. Never sorted, never counted per person, no actions on a row. Kept
 * as it is while the rest of the page re-renders (App's clock ticks every second).
 */
const ListTable = memo(function ListTable({ sheet, label }: { sheet: Sheet; label: string }) {
  const [query, setQuery] = useState("");
  const id = useId();
  const q = fold(query);
  // Each cell folded once per list read, not on every key pressed in the find box (review S, L6).
  const folded = useMemo(() => sheet.rows.map(row => row.map(fold)), [sheet]);
  const rows = useMemo(() => q ? sheet.rows.filter((_, i) => folded[i]!.some(cell => cell.includes(q))) : sheet.rows, [sheet, folded, q]);
  const shown = useMemo(() => shownRows(rows), [rows]);
  return <div className="stack-tight">
    <label className="field-l" htmlFor={id}>{FIND_LABEL}</label>
    <input id={id} className="input own-find" type="search" value={query} autoComplete="off" spellCheck={false} onChange={e => setQuery(e.target.value)} />
    <div className="own-table-wrap own-table-tall" role="region" aria-label={label} tabIndex={0}>
      <table className="own-table">
        <thead><tr>{sheet.headers.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr></thead>
        <tbody>{shown.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
    {q && rows.length === 0 && <p className="small">{NOTHING_FOUND}</p>}
    {rows.length > shown.length && <p className="small">{someShown(shown.length, rows.length)}</p>}
  </div>;
});

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

function ListCard({ source, read, positions, sources, reading }: {
  source: SheetSource; read: SourceRead | undefined; positions: readonly PositionLabel[]; sources: ChurchSources; reading: boolean;
}) {
  const [name, setName] = useState(source.label);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [rereading, setRereading] = useState(false);
  const id = useId();
  const system = useContext(ListsSystemName);
  const save = (edit: Parameters<ChurchSources["update"]>[1]) => { setProblem(null); void sources.update(source.id, edit).then(setProblem); };
  const sheet = read?.ok ? read.sheet : null;
  const headers = sheet ? [...new Set(sheet.headers.filter(h => h !== ""))].slice(0, MAX_COLUMNS) : [];
  const ticked = new Set(source.ticked);
  const tick = (header: string, on: boolean) => save({ ticked: now => headers.filter(h => h === header ? on : now.includes(h)) });
  const renamed = plainLine(name, MAX_LABEL);
  const link = source.kind === "link";
  // A link's "Read again" only after a read that worked: before one, or after one that didn't, it is tried.
  const again = !link || read?.ok ? READ_AGAIN : read ? TRY_AGAIN : READ_NOW;
  return <section className="find church-list" aria-labelledby={`${id}-t`}>
    <h2 id={`${id}-t`} className="settings-t">{source.label}</h2>
    <div className="checkline">
      {/* Where and when it was read only for a read that worked; a read that didn't says only why (review S, L3). A
          link says only its host, never the rest of its address. */}
      {read?.ok && <><Icon name="check" small /><span>{readFrom(link ? linkHost(source.shown) : source.shown, clock(read.at))}</span></>}
      {!read && <span>{link ? `${LINK_TO} ${source.shown}. ${NOT_READ}` : `${source.shown}. ${NOT_READ}`}</span>}
      {/* After a read that didn't work, which file or link it is, without a time or a check mark (review S2, A). */}
      {read && !read.ok && <span>{link ? `${LINK_TO} ${source.shown}.` : source.shown}</span>}
      <button type="button" className="btn btn-quiet btn-sm" disabled={rereading || reading}
        onClick={() => { setRereading(true); void sources.readOne(source.id).finally(() => setRereading(false)); }}>
        {rereading ? READING : again}</button>
    </div>
    <p className="small own-note">{LIST_FRAME}</p>
    {read && !read.ok && <p role="alert" className="problem">{read.problem}</p>}
    {sheet && (sheet.flags.rowsCut || sheet.flags.cellsCut || sheet.flags.guessedEncoding) && <ul className="list own-flags">
      {sheet.flags.rowsCut && <li><Icon name="dot" small />{ROWS_CUT}</li>}
      {sheet.flags.cellsCut && <li><Icon name="dot" small />{CELLS_CUT}</li>}
      {sheet.flags.guessedEncoding && <li><Icon name="dot" small />{GUESSED_LETTERS}</li>}
    </ul>}
    <div className="own-field">
      <label className="field-l" htmlFor={`${id}-name`}>{NAME_LABEL}</label>
      <div className="row">
        <input id={`${id}-name`} className="input own-name" value={name} maxLength={MAX_LABEL * 2} autoComplete="off" onChange={e => setName(e.target.value)} />
        <button type="button" className="btn btn-secondary btn-sm" disabled={renamed === source.label} onClick={() => save({ label: name })}>{SAVE_NAME}</button>
      </div>
    </div>
    {sheet && <>
      <div className="own-field">
        <label className="field-l" htmlFor={`${id}-column`}>{COLUMN_QUESTION}</label>
        <select id={`${id}-column`} className="input own-column" value={source.column !== null && headers.includes(source.column) ? source.column : ""}
          onChange={e => save({ column: e.target.value || null, matches: new Map() })}>
          <option value="">Choose a column</option>
          {headers.map(h => <option key={h} value={h}>{h}</option>)}
        </select>
        <p className="input-help">{sayFor(COLUMN_HELP, system)}</p>
      </div>
      {source.column !== null && headers.includes(source.column) && <MatchTable sheet={sheet} source={source} positions={positions}
        onMatches={matches => save({ matches })} />}
      <fieldset className="own-ticks">
        <legend>{SHOW_QUESTION}</legend>
        {source.ticked.length === 0 && <p className="small">{SHOW_NONE}</p>}
        {headers.map(h => <label key={h} className="confirmation">
          <input type="checkbox" checked={ticked.has(h)} disabled={!ticked.has(h) && source.ticked.filter(t => headers.includes(t)).length >= MAX_TICKED}
            onChange={e => tick(h, e.target.checked)} />
          <span>{h}</span>
        </label>)}
      </fieldset>
      <ListTable sheet={sheet} label={source.label} />
    </>}
    {problem && <p role="alert" className="problem">{problem}</p>}
    {!removing && <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={() => setRemoving(true)}>{REMOVE_LIST}</button></div>}
    {removing && <Confirm question={link ? removeLinkConfirm(source.label) : removeConfirm(source.label)} yes="Yes, remove it" no="Keep it"
      onYes={() => { setRemoving(false); void sources.remove(source.id).then(setProblem); }} onNo={() => setRemoving(false)} />}
  </section>;
}

/** "Forget all lists": the way out when the list on this Mac can't be read, and a clean start any time. */
function ForgetAll({ sources, onDone }: {
  sources: ChurchSources;
  /** What came of it, in plain words, said by the page: this goes once no list is left (review T, L7). */
  onDone: (problem: string | null) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return <div>
    {!confirm && <div className="find-next"><button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(true)}>{FORGET_ALL}</button></div>}
    {confirm && <Confirm question={FORGET_CONFIRM} yes="Yes, forget them all" no="Keep them"
      onYes={() => { setConfirm(false); void sources.forgetAll().then(onDone); }} onNo={() => setConfirm(false)} />}
  </div>;
}

/** "Forget all private links": the way out when the links' own list on this Mac can't be read. Files' lists stay. */
function ForgetLinks({ sources }: { sources: ChurchSources }) {
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return <div className="find">
    <p className="find-body">{SOURCE_PROBLEMS["links-unreadable"]}</p>
    {!confirm && <div className="find-next"><button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirm(true)}>{FORGET_LINKS}</button></div>}
    {confirm && <Confirm question={FORGET_LINKS_CONFIRM} yes="Yes, forget them all" no="Keep them"
      onYes={() => { setConfirm(false); void sources.forgetLinks().then(setProblem); }} onNo={() => setConfirm(false)} />}
    {problem && <p role="alert" className="problem">{problem}</p>}
  </div>;
}

export function ChurchListsPage({ sources, positions }: {
  sources: ChurchSources;
  /** The positions in the check on screen, as Church rules list them: what values can be matched to. */
  positions: readonly PositionLabel[];
}) {
  const state = useChurchSources(sources);
  const [choosing, setChoosing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choose = () => {
    setChoosing(true); setProblem(null);
    void sources.choose().then(r => { if ("problem" in r) setProblem(r.problem); }).finally(() => setChoosing(false));
  };
  const list = state.sources ?? [];
  return <div className="col church-lists">
    <p className="eyebrow">{LISTS_TITLE}</p>
    <h1 className="h1">{LISTS_HEADING}</h1>
    {/* One sentence, then the buttons; the file-format detail is folded away and what stays on this Mac follows. */}
    <p className="lede">{LISTS_BODY}</p>
    <div className="row">
      <button type="button" className="btn btn-primary" disabled={choosing} onClick={choose}>
        {choosing ? <><Icon name="spinner" small spin />Choosing a file…</> : ADD_LIST}</button>
      {!linking && <button type="button" className="btn btn-secondary" onClick={() => { setLinking(true); setProblem(null); }}>{ADD_LINK}</button>}
    </div>
    <details className="listen-more"><summary><Icon name="chev" small />{HOW_LISTS}</summary><p className="small">{ADD_HELP}</p></details>
    <div className="banner"><Icon name="lock" small /><div className="stack-tight">
      <span><strong>{LISTS_STAYS}</strong> {LISTS_PRIVATE}</span>
      <span>{LISTS_WHEN}</span>
    </div></div>
    {problem && <p role="alert" className="problem">{problem}</p>}
    {linking && <LinkForm sources={sources} onDone={() => setLinking(false)} />}
    {state.linksUnreadable && <ForgetLinks sources={sources} />}
    {state.listProblem && <p role="alert" className="problem">{state.listProblem}</p>}
    {/* Something that stopped Ozzie listing them just now can be tried again; an unreadable list is forgotten below. */}
    {state.listProblem && !state.listUnreadable && <div className="row">
      <button type="button" className="btn btn-secondary btn-sm" disabled={state.reading} onClick={() => { void sources.load(); }}>{READ_AGAIN}</button></div>}
    {state.sources !== null && list.length === 0 && !state.listProblem && <p className="small">{NO_LISTS}</p>}
    {state.sources === null && <p className="small">{READING}</p>}
    {list.map(s => <ListCard key={s.id} source={s} read={state.reads.get(s.id)} positions={positions} sources={sources} reading={state.reading} />)}
    <ChurchNotes sources={sources} state={state} positions={positions} />
    {(list.length > 0 || state.notes.length > 0 || state.listUnreadable) && <ForgetAll sources={sources} onDone={setProblem} />}
  </div>;
}
