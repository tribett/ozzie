// A spreadsheet the leader added from this Mac (CSV or TSV): its bytes as text, then its header and rows, as the
// "Lists & notes" page and a matched Sunday card show them. Only shown on this Mac, as the church's own words; never
// part of a model request, a notice or the copy for other AI apps (core/test/sources/stays-on-this-mac.test.ts).
//
// Pure: no I/O. Runs in the page. Every header and cell is one plain line (text.ts); a cell that looks like a formula
// stays the text it is, since nothing here (or anywhere in Ozzie) works anything out from a cell. One pass over the
// text, and each cell keeps at most a few thousand characters however long it runs, so a hostile 2 MB file is read in
// a few milliseconds (timed in core/test/sources/sheet.test.ts).
import { decodeText, plainLine, plainLineCut, type Decoded } from "./text.js";

/** Largest file read. Native code refuses a larger one before it reaches the page. */
export const MAX_SHEET_BYTES = 2 * 1024 * 1024;
/** Rows shown; past this the sheet says it showed the first ones. */
export const MAX_ROWS = 2000;
/** Named columns read; a header row with more is refused. */
export const MAX_COLUMNS = 30;
/** Characters kept in a cell, and in a header; longer ones are cut and end in "…". */
export const MAX_CELL = 500;
export const MAX_HEADER = 120;

export const SHEET_PROBLEMS = ["workbook", "too-large", "not-text", "empty", "no-header", "too-many-columns"] as const;
/**
 * Why a file isn't shown: an Excel or Numbers workbook rather than CSV; over 2 MB; not text; nothing in it; a blank
 * first row (the header row) with rows under it; more than 30 named columns.
 */
export type SheetProblem = (typeof SHEET_PROBLEMS)[number];
export type Delimiter = "," | ";" | "\t";

export interface SheetFlags {
  /** The file wasn't UTF-8 or UTF-16, so it was read as windows-1252: some letters may look wrong. */
  guessedEncoding: boolean;
  /** The file had more than MAX_ROWS rows; only the first ones are here. */
  rowsCut: boolean;
  /** A header or a cell shown was cut and ends in "…". */
  cellsCut: boolean;
}
export interface Sheet {
  /** The header row, plain, at most MAX_HEADER characters each. Blank columns at the end are left off; a blank header between named ones stays (as ""). */
  headers: string[];
  /** Rows in file order, each exactly as long as `headers`; blank rows are left out. Cells plain, at most MAX_CELL characters. */
  rows: string[][];
  delimiter: Delimiter;
  flags: SheetFlags;
}
export type SheetResult = { ok: true; sheet: Sheet } | { ok: false; problem: SheetProblem };

/** The file's bytes as text: a byte-order mark, strict UTF-8, or else windows-1252 as a guess (text.ts `decodeText`). */
export const decodeSheet = (bytes: Uint8Array): Decoded => decodeText(bytes, MAX_SHEET_BYTES);

/** A file's bytes as a sheet: decodeSheet, then parseSheet, with whether the encoding was guessed. */
export function readSheet(bytes: Uint8Array): SheetResult {
  const decoded = decodeSheet(bytes);
  if (!decoded.ok) return decoded;
  const result = parseSheet(decoded.text);
  if (!result.ok || !decoded.guessed) return result;
  return { ok: true, sheet: { ...result.sheet, flags: { ...result.sheet.flags, guessedEncoding: true } } };
}

const QUOTE = 34, COMMA = 44, SEMICOLON = 59, TAB = 9, LF = 10, CR = 13, BOM = 0xfeff;
/** Raw characters kept from one field (in UTF-16 units): enough for plainLineCut to read MAX_CELL * 8 characters and see that more followed. */
const RAW_CAP = MAX_CELL * 8 * 2 + 2;

/**
 * The delimiter: whichever of comma, semicolon and tab the first line holds most often outside quotes (a quote opens
 * quoting only at the start of a field). Ties go to tab, then comma; none at all is one column, read as comma.
 */
function delimiterOf(text: string): Delimiter {
  let comma = 0, semicolon = 0, tab = 0, quoted = false, fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c !== QUOTE) continue;
      if (text.charCodeAt(i + 1) === QUOTE) i++;
      else quoted = false;
      continue;
    }
    if (c === LF || c === CR) break;
    if (c === QUOTE && fieldStart) { quoted = true; fieldStart = false; continue; }
    fieldStart = c === COMMA || c === SEMICOLON || c === TAB;
    if (c === COMMA) comma++;
    else if (c === SEMICOLON) semicolon++;
    else if (c === TAB) tab++;
  }
  if (tab > 0 && tab >= comma && tab >= semicolon) return "\t";
  if (semicolon > comma) return ";";
  return ",";
}

/**
 * Whether a raw field shows nothing. Spaces, tabs and controls alone are settled here, and a printable letter of the
 * basic Latin set shows; only other text goes through plainLine, so a file of thousands of fields holding a space
 * costs no more than one of empty fields (review S, L6).
 */
function blank(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c <= 0x20 || c === 0x7f) continue;
    return c < 0x80 ? false : plainLine(raw, MAX_CELL) === "";
  }
  return true;
}

/**
 * The text as a sheet. RFC 4180 quoting (a field that starts with a quote runs to the next lone quote, a doubled quote
 * inside it is one quote, and line breaks and delimiters inside it are text; characters after the closing quote are
 * kept, and a quote never closed runs to the end, as spreadsheets read them); CRLF, LF and CR end a row; the first row
 * is the header row. A byte-order mark at the start is skipped.
 */
export function parseSheet(input: string): SheetResult {
  const text = input.charCodeAt(0) === BOM ? input.slice(1) : input;
  const delimiter = delimiterOf(text);
  const d = delimiter.charCodeAt(0), n = text.length;
  let pos = 0;

  /** One field from `pos`, at most RAW_CAP raw characters kept; `pos` ends on the delimiter or line end after it. */
  const field = (): string => {
    let out = "";
    const add = (from: number, to: number) => { if (out.length < RAW_CAP && to > from) out += text.slice(from, Math.min(to, from + RAW_CAP - out.length)); };
    if (text.charCodeAt(pos) === QUOTE) {
      pos++;
      for (;;) {
        const q = text.indexOf("\"", pos);
        if (q === -1) { add(pos, n); pos = n; return out; }
        add(pos, q);
        if (text.charCodeAt(q + 1) === QUOTE) { add(q, q + 1); pos = q + 2; continue; }
        pos = q + 1;
        break;
      }
    }
    const start = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === d || c === LF || c === CR) break;
      pos++;
    }
    add(start, pos);
    return out;
  };
  /** One row from `pos`: its first MAX_COLUMNS raw fields, and whether any field past those has something in it. */
  const record = (): { cells: string[]; beyond: boolean } => {
    const cells: string[] = [];
    let beyond = false;
    for (;;) {
      const raw = field();
      if (cells.length < MAX_COLUMNS) cells.push(raw);
      else if (!beyond && !blank(raw)) beyond = true;
      const c = text.charCodeAt(pos);
      if (c === d) { pos++; continue; }
      if (c === CR) { pos++; if (text.charCodeAt(pos) === LF) pos++; }
      else if (c === LF) pos++;
      return { cells, beyond };
    }
  };
  /** Whether anything from `pos` on has something in it. */
  const anythingLeft = () => {
    while (pos < n) {
      const r = record();
      if (r.beyond || r.cells.some(c => !blank(c))) return true;
    }
    return false;
  };

  if (n === 0) return { ok: false, problem: "empty" };
  const head = record();
  if (head.beyond) return { ok: false, problem: "too-many-columns" };
  const named = head.cells.map(raw => plainLineCut(raw, MAX_HEADER));
  let width = named.length;
  while (width > 0 && named[width - 1]!.text === "") width--;
  if (width === 0) return { ok: false, problem: anythingLeft() ? "no-header" : "empty" };
  const headers = named.slice(0, width).map(h => h.text);
  let cellsCut = named.slice(0, width).some(h => h.cut), rowsCut = false;

  const rows: string[][] = [];
  while (pos < n) {
    // A line break at the start of a row is a blank row: skipped without building one.
    const first = text.charCodeAt(pos);
    if (first === LF || first === CR) { pos++; continue; }
    const { cells } = record();
    const row: string[] = [];
    let any = false, cut = false;
    for (let i = 0; i < width; i++) {
      const raw = cells[i] ?? "";
      const cell = raw === "" ? { text: "", cut: false } : plainLineCut(raw, MAX_CELL);
      row.push(cell.text);
      any ||= cell.text !== "";
      cut ||= cell.cut;
    }
    if (!any) continue;
    if (rows.length === MAX_ROWS) { rowsCut = true; break; }
    rows.push(row);
    cellsCut ||= cut;
  }
  return { ok: true, sheet: { headers, rows, delimiter, flags: { guessedEncoding: false, rowsCut, cellsCut } } };
}
