// The church's own notes (a .txt or .md file the leader added): shown on this Mac as the church's own words, with a
// find box, and a section can be attached to a team or a kind of finding so a Sunday card can point to it. Only the
// page that shows them uses this module: Ozzie's own tests check that nothing which builds a model request, a notice or
// the copy for other AI apps imports it (core/test/sources/stays-on-this-mac.test.ts; a check on Ozzie's own code, not
// a sandbox). Ozzie doesn't check or follow them.
//
// No Markdown: a `#` heading only starts a section and names it; everything else is the literal text, links and
// images included, shown as text. Each line has its format characters taken out (text.ts) and keeps its own spacing.
// A find gives ranges in that text, so the page can highlight by splitting it, never by building markup.
//
// Pure: no I/O. Runs in the page.
import { decodeText, noteLine, plainLineCut, type Decoded } from "./text.js";
import type { NoteAttachment } from "./types.js";

/** Largest notes file, in bytes (UTF-8 for text given directly). */
export const MAX_NOTES_BYTES = 1024 * 1024;
/** Lines shown; past this the notes say they showed the first ones. */
export const MAX_NOTE_LINES = 20_000;
/** Characters in a line; a longer one is cut and ends in "…". */
export const MAX_NOTE_LINE = 2000;
/** Characters in a section's title. */
export const MAX_TITLE = 120;
/** Places a find marks at most; past this it says there are more. */
export const MAX_HITS = 1000;
/** Characters of a find read. */
export const MAX_QUERY = 200;

export const NOTES_PROBLEMS = ["notes-too-large", "not-text", "empty"] as const;
export type NotesProblem = (typeof NOTES_PROBLEMS)[number];

/**
 * A section: under a `#` heading (`heading`, and `title` is the heading's text), or else a block of lines between
 * blank lines, named by its first line (`title`, which is also the first of `lines`). `lines` keep their order and the
 * blank lines between paragraphs, with none at either end. A title is one plain line of at most MAX_TITLE characters;
 * when that changed a heading (cut, or its spacing tidied), `written` is the heading's text as written, so the page can
 * show every word of it (review V, H1).
 */
export interface NoteSection { title: string; heading: boolean; lines: string[]; written?: string }
export interface NotesFlags {
  /** The file wasn't UTF-8 or UTF-16, so it was read as windows-1252: some letters may look wrong. */
  guessedEncoding: boolean;
  /** The notes had more than MAX_NOTE_LINES lines; only the first ones are here. */
  linesCut: boolean;
  /** A line was over MAX_NOTE_LINE characters, so it was cut and ends in "…". */
  longLinesCut: boolean;
}
export interface Notes { sections: NoteSection[]; flags: NotesFlags }
export type NotesResult = { ok: true; notes: Notes } | { ok: false; problem: NotesProblem };

export type DecodedNotes = Extract<Decoded, { ok: true }> | { ok: false; problem: NotesProblem };
/** The file's bytes as text (text.ts `decodeText`); a workbook or a ZIP (such as a Word file) isn't text here. */
export function decodeNotes(bytes: Uint8Array): DecodedNotes {
  const decoded = decodeText(bytes, MAX_NOTES_BYTES);
  if (decoded.ok) return decoded;
  return { ok: false, problem: decoded.problem === "too-large" ? "notes-too-large" : "not-text" };
}

/** A file's bytes as notes: decodeNotes, then parseNotes, with whether the encoding was guessed. */
export function readNotes(bytes: Uint8Array): NotesResult {
  const decoded = decodeNotes(bytes);
  if (!decoded.ok) return decoded;
  const result = parseNotes(decoded.text);
  if (!result.ok || !decoded.guessed) return result;
  return { ok: true, notes: { ...result.notes, flags: { ...result.notes.flags, guessedEncoding: true } } };
}

/** Whether `text` is over `max` bytes as UTF-8, counted without encoding it. */
function overBytes(text: string, max: number): boolean {
  if (text.length > max) return true;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00 ? (i++, 4) : 3;
    if (bytes > max) return true;
  }
  return false;
}

const LF = 10, CR = 13, NEL = 0x85, LINE_SEPARATOR = 0x2028, PARAGRAPH_SEPARATOR = 0x2029;
/** A Markdown-style heading: up to three spaces, one to six `#`, then a space or the end of the line. */
const HEADING = /^ {0,3}#{1,6}(?: |$)/u;
const MARKER = /^ {0,3}#{1,6}/u;

/** Blank lines off both ends. */
function trimmed(lines: string[]): string[] {
  let from = 0, to = lines.length;
  while (from < to && lines[from] === "") from++;
  while (to > from && lines[to - 1] === "") to--;
  return lines.slice(from, to);
}

/**
 * Notes as sections. Lines end at CRLF, LF, CR, NEL and the two Unicode line breaks. With any `#` heading, a section
 * starts at each one (text before the first is a section of its own); with none, each block between blank lines is a
 * section. Refused: over 1 MB, or nothing in it.
 */
export function parseNotes(input: string): NotesResult {
  if (overBytes(input, MAX_NOTES_BYTES)) return { ok: false, problem: "notes-too-large" };
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const lines: string[] = [];
  let linesCut = false, longLinesCut = false, start = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = i < text.length ? text.charCodeAt(i) : -1;
    if (c !== -1 && c !== LF && c !== CR && c !== NEL && c !== LINE_SEPARATOR && c !== PARAGRAPH_SEPARATOR) continue;
    // The end of the text after a final line break is not another line.
    if (c === -1 && start === text.length && lines.length) break;
    const line = noteLine(text.slice(start, i), MAX_NOTE_LINE);
    if (lines.length === MAX_NOTE_LINES) {
      if (line.text !== "") { linesCut = true; break; }
    } else {
      lines.push(line.text);
      longLinesCut ||= line.cut;
    }
    if (c === CR && text.charCodeAt(i + 1) === LF) i++;
    start = i + 1;
  }

  const sections: NoteSection[] = [];
  const titleOf = (raw: string) => plainLineCut(raw, MAX_TITLE).text;
  if (lines.some(l => HEADING.test(l))) {
    let current: NoteSection | null = null;
    const opening: string[] = [];
    for (const line of lines) {
      if (HEADING.test(line)) {
        if (current) sections.push(current);
        const written = line.replace(MARKER, "").trimStart();
        const title = titleOf(written);
        current = { title, heading: true, lines: [], ...(written !== title ? { written } : {}) };
      } else (current ? current.lines : opening).push(line);
    }
    if (current) sections.push(current);
    for (const s of sections) s.lines = trimmed(s.lines);
    const before = trimmed(opening);
    if (before.length) sections.unshift({ title: titleOf(before[0]!), heading: false, lines: before });
  } else {
    let block: string[] = [];
    const close = () => { if (block.length) sections.push({ title: titleOf(block[0]!), heading: false, lines: block }); block = []; };
    for (const line of lines) {
      if (line === "") close();
      else block.push(line);
    }
    close();
  }
  if (!sections.length) return { ok: false, problem: "empty" };
  return { ok: true, notes: { sections, flags: { guessedEncoding: false, linesCut, longLinesCut } } };
}

// ---- Find -------------------------------------------------------------------------------------------------

/** A stretch of a title or line, in UTF-16 offsets: `text.slice(start, end)` is what to highlight. */
export interface NoteRange { start: number; end: number }
/** The places found in one section's title (only for a heading) or one of its lines. */
export interface NoteHit { section: number; line: "title" | number; ranges: NoteRange[] }
/** `more`: the find stopped at MAX_HITS places. */
export interface NoteSearch { hits: NoteHit[]; more: boolean }

const MARK = /\p{M}/gu;
/** One character folded: compatibility forms apart, lower case, accents and other marks off. "" for a mark. */
function foldChar(ch: string, cache: Map<string, string>): string {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
  let out = cache.get(ch);
  if (out === undefined) {
    out = ch.normalize("NFKD").toLowerCase().normalize("NFKD").replace(MARK, "");
    cache.set(ch, out);
  }
  return out;
}
/**
 * `text` folded, with where each folded unit came from: `from[k]` and `to[k]` bound the character it is part of. A
 * mark that folds away widens the character before it, so a range never splits a letter from its accent.
 */
function folded(text: string, cache: Map<string, string>): { text: string; from: number[]; to: number[] } {
  let out = "";
  const from: number[] = [], to: number[] = [];
  let at = 0;
  for (const ch of text) {
    const f = foldChar(ch, cache);
    const end = at + ch.length;
    if (f === "") { if (to.length) to[to.length - 1] = end; }
    else {
      out += f;
      for (let k = 0; k < f.length; k++) { from.push(at); to.push(end); }
    }
    at = end;
  }
  return { text: out, from, to };
}

/**
 * Where `query` appears in the notes, ignoring case and accents (and compatibility forms such as ligatures and
 * full-width letters): each section's heading title, then its lines, in order. Ranges in a line don't overlap. Stops
 * after MAX_HITS places. An empty query finds nothing.
 */
export function searchNotes(notes: Notes, query: string): NoteSearch {
  const cache = new Map<string, string>();
  const q = folded([...query].slice(0, MAX_QUERY).join(""), cache).text.trim();
  const hits: NoteHit[] = [];
  if (!q) return { hits, more: false };
  let total = 0;
  const find = (section: number, line: NoteHit["line"], text: string): boolean => {
    const f = folded(text, cache);
    const ranges: NoteRange[] = [];
    let more = false;
    for (let k = f.text.indexOf(q); k !== -1; k = f.text.indexOf(q, k + q.length)) {
      const start = f.from[k]!, end = f.to[k + q.length - 1]!;
      const last = ranges.at(-1);
      if (last && start < last.end) { last.end = Math.max(last.end, end); continue; }
      if (total === MAX_HITS) { more = true; break; }
      ranges.push({ start, end });
      total++;
    }
    if (ranges.length) hits.push({ section, line, ranges });
    return more;
  };
  for (const [i, s] of notes.sections.entries()) {
    if (s.heading && s.title && find(i, "title", s.title)) return { hits, more: true };
    for (const [j, line] of s.lines.entries()) if (line && find(i, j, line)) return { hits, more: true };
  }
  return { hits, more: false };
}

/**
 * The section a pointer names: the one with its title, the first or (when titles repeat) the occurrence it keeps; with
 * where it is. Null when there is no such section any more.
 */
export function sectionFor(notes: Notes, attachment: NoteAttachment): { index: number; section: NoteSection } | null {
  if (!attachment.section) return null;
  let left = attachment.occurrence ?? 1;
  for (const [index, section] of notes.sections.entries()) if (section.title === attachment.section && --left === 0) return { index, section };
  return null;
}

/** For each section, which occurrence of its title it is (1 for the first) and how many sections share the title. */
const counted = new WeakMap<Notes, { occurrence: number[]; of: number[] }>();
function counts(notes: Notes): { occurrence: number[]; of: number[] } {
  let known = counted.get(notes);
  if (!known) {
    const seen = new Map<string, number>();
    const occurrence = notes.sections.map(s => { const n = (seen.get(s.title) ?? 0) + 1; seen.set(s.title, n); return n; });
    known = { occurrence, of: notes.sections.map(s => seen.get(s.title)!) };
    counted.set(notes, known);
  }
  return known;
}
/** Which occurrence of its title the section at `index` is: 1 for the first. */
export const occurrenceOf = (notes: Notes, index: number): number => counts(notes).occurrence[index] ?? 1;
/**
 * A section's name, apart from any other with the same title: its title, with "(2)" and so on when titles repeat
 * ("Who to call (1)", "Who to call (2)"). "" for a section with no title (a bare `#`).
 */
export function sectionName(notes: Notes, index: number): string {
  const title = notes.sections[index]?.title ?? "";
  if (!title) return "";
  const { occurrence, of } = counts(notes);
  return of[index]! > 1 ? `${title} (${occurrence[index]})` : title;
}
