// Matching a church's list to Planning Center teams and positions, and the rows a matched Sunday card shows. The
// leader picks the column that names a team or role and matches each value in it; Ozzie may only suggest a team or
// position with the same name, and a suggestion counts for nothing until the leader chooses it ("Use this match").
// Nothing here is given a person's name from Planning Center, so nothing can compare one with a name in a list.
//
// Pure: no I/O. Runs in the page.
import type { PositionLabel } from "../sunday-capture.js";
import type { Sheet } from "./sheet.js";
import { plainLine } from "./text.js";
import { MAX_NAME, MAX_TICKED, TEAM_ID, type CardPosition, type SheetSource, type SourceMatch } from "./types.js";

/**
 * A team or position the match table offers: a position as Church rules list them (PositionLabel), or a team with a
 * name for it. With a `position_id` it is a position and `name` is the position's; without one, the team's.
 */
export type MatchTarget = Pick<PositionLabel, "team_id" | "name"> & { position_id?: string };
/** A same-named team or position Ozzie offers for a value, never applied by itself. */
export interface Suggestion { value: string; what: "team" | "position"; match: SourceMatch }

/** The same name, ignoring case and spacing (and full-width forms, as Check-Ins room names are compared). */
const fold = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** What choosing `target` saves: its team's id, and for a position its name as one plain line. Null when it can't be one. */
export function matchFor(target: MatchTarget): SourceMatch | null {
  if (!TEAM_ID.test(target.team_id)) return null;
  if (target.position_id === undefined) return { team_id: target.team_id };
  const position_name = plainLine(target.name, MAX_NAME);
  return position_name ? { team_id: target.team_id, position_name } : null;
}

/**
 * For each different value (in the order given), the one team, or else the one position, with the same name. A name
 * shared by two teams, or by positions on two teams, gets no suggestion: the leader matches it.
 */
export function suggestMatches(values: readonly string[], targets: readonly MatchTarget[]): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    const name = fold(value);
    if (!name) continue;
    const same = (team: boolean) => {
      const found = new Map<string, SourceMatch>();
      for (const t of targets) {
        if ((t.position_id === undefined) !== team || fold(t.name) !== name) continue;
        const match = matchFor(t);
        if (match) found.set(JSON.stringify([match.team_id, match.position_name ?? null]), match);
      }
      return [...found.values()];
    };
    const teams = same(true);
    if (teams.length) {
      if (teams.length === 1) out.push({ value, what: "team", match: teams[0]! });
      continue;
    }
    const positions = same(false);
    if (positions.length === 1) out.push({ value, what: "position", match: positions[0]! });
  }
  return out;
}

/** The first column with this header, or -1. */
const columnAt = (sheet: Sheet, header: string) => header ? sheet.headers.indexOf(header) : -1;

/** The different values in a column, in file order, blanks left out: what the match table lists. */
export function columnValues(sheet: Sheet, column: string): string[] {
  const at = columnAt(sheet, column);
  if (at < 0) return [];
  return [...new Set(sheet.rows.map(row => row[at] ?? "").filter(v => v !== ""))];
}

/** A list's rows for one Sunday card, with the headers of the columns shown. */
export interface SourceRows { columns: string[]; rows: string[][] }

/** Whether a match the leader chose covers this card: the same team, and for a position match the same position. */
const covers = (m: SourceMatch, card: CardPosition) =>
  m.team_id === card.team_id && (m.position_name === undefined || (card.position_id !== undefined && plainLine(card.name, MAX_NAME) === m.position_name));

/**
 * The rows of `sheet` whose value in the chosen column the leader matched to this card's team or position, in file
 * order, with only the ticked columns (in the sheet's order, at most MAX_TICKED); a row with nothing in them is left
 * out. Null when there is nothing to show: no chosen column, no ticked column, or neither still in the file, or no
 * matched row. The value must be exactly the one matched: no near name, no other column.
 */
export function rowsFor(sheet: Sheet, source: Pick<SheetSource, "column" | "ticked" | "matches">, card: CardPosition): SourceRows | null {
  const at = source.column === null ? -1 : columnAt(sheet, source.column);
  if (at < 0) return null;
  const ticked = new Set(source.ticked);
  const shown = sheet.headers.flatMap((h, i) => h !== "" && ticked.has(h) && sheet.headers.indexOf(h) === i ? [i] : []).slice(0, MAX_TICKED);
  if (!shown.length) return null;
  const rows = sheet.rows
    .filter(row => { const m = source.matches.get(row[at] ?? ""); return m !== undefined && covers(m, card); })
    .map(row => shown.map(i => row[i] ?? ""))
    .filter(row => row.some(cell => cell !== ""));
  return rows.length ? { columns: shown.map(i => sheet.headers[i]!), rows } : null;
}
