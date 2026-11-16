// Beside a Sunday card: the rows of the church's own lists that the leader matched to the card's team or position,
// framed as the church's own words, not checked by Ozzie (core/src/sources/words.ts `listFrame`), and the title of any
// section of the church's notes the leader pointed to from the cards for that team or that kind of finding, with a way
// to open it on Lists & notes (`notesBeside`). App.tsx hands this to the Sunday page through its `beside` slot; the
// Sunday page imports none of it, so nothing here can reach a draft, a rewording or the copy for other AI apps. Only
// the ticked columns, in the list's own order, and a section's title, never its text; no actions on a row.
import { rowsFor } from "../../../core/src/sources/match.js";
import { sectionFor, sectionName } from "../../../core/src/sources/notes.js";
import { listFrame, notesBeside } from "../../../core/src/sources/words.js";
import type { ChurchSourcesState, NoteFocus } from "./church-sources.js";
import "./church-lists.css";

/** Rows shown for one list beside one card; the rest are on the Lists & notes page. */
export const ROWS_BESIDE = 5;
export const moreRows = (n: number) => `and ${n} more in Lists & notes`;
/** The button that opens a section of notes on Lists & notes. */
export const OPEN_NOTES = "Open";
export const openLabel = (title: string) => `Open “${title}” on Lists & notes`;
const UNTITLED = "Untitled section";

/** A Sunday card as the page's slot gives it: the kind of finding, and its team and position when it has one. */
export interface SundayCard { kind?: string; team_id?: string; position_id?: string; name?: string }

export function ChurchOwnWords({ state, card, onOpen, max = ROWS_BESIDE }: {
  state: Pick<ChurchSourcesState, "sources" | "reads" | "notes" | "noteReads">; card: SundayCard;
  /** Opens Lists & notes: at a section of notes, or (null) where the whole list is. */
  onOpen?: ((target: NoteFocus | null) => void) | undefined; max?: number;
}) {
  const position = card.team_id !== undefined && card.name !== undefined
    ? { team_id: card.team_id, name: card.name, ...(card.position_id !== undefined ? { position_id: card.position_id } : {}) } : null;
  const lists = position ? (state.sources ?? []).flatMap(source => {
    const read = state.reads.get(source.id);
    const rows = read?.ok ? rowsFor(read.sheet, source, position) : null;
    return rows ? [{ source, rows }] : [];
  }) : [];
  // Sections pointed to from this card's team (by its Planning Center id) or its kind of finding, never by their words.
  const notes = state.notes.flatMap(source => {
    const read = state.noteReads.get(source.id);
    if (!read?.ok) return [];
    // Named apart from any other section with the same title (review V, M1).
    const sections = new Map<number, string>();
    for (const a of source.attachments) {
      const here = "team_id" in a ? a.team_id === card.team_id : a.finding_kind === card.kind;
      const found = here ? sectionFor(read.notes, a) : null;
      if (found && !sections.has(found.index)) sections.set(found.index, sectionName(read.notes, found.index));
    }
    return sections.size ? [{ source, sections: [...sections] }] : [];
  });
  if (!lists.length && !notes.length) return null;
  return <>
    {lists.map(({ source, rows }) => <section className="church-own-words" key={source.id}>
      <p className="own-frame">{listFrame(source.label)}</p>
      <div className="own-table-wrap">
        <table className="own-table">
          <thead><tr>{rows.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
          <tbody>{rows.rows.slice(0, max).map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {rows.rows.length > max && (onOpen
        ? <button type="button" className="btn btn-quiet btn-sm" onClick={() => onOpen(null)}>{moreRows(rows.rows.length - max)}</button>
        : <p className="small">{moreRows(rows.rows.length - max)}</p>)}
    </section>)}
    {notes.map(({ source, sections }) => <section className="church-own-words own-notes" key={`notes-${source.id}`}>
      {sections.map(([index, title]) => <p className="own-frame" key={index}>
        {notesBeside(title || UNTITLED)}
        {onOpen && <><span aria-hidden="true"> · </span>
          <button type="button" className="btn btn-quiet btn-sm" aria-label={openLabel(title || UNTITLED)} onClick={() => onOpen({ id: source.id, section: index })}>
            {OPEN_NOTES}</button></>}
      </p>)}
    </section>)}
  </>;
}
