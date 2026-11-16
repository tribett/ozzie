// Church-added sources as native code lists them for the page (church-sources.json holds more, such as a file's path,
// which never reaches the page). A source is a spreadsheet file from this Mac, a private link to a published sheet, or
// a file of the church's own notes. Each is named by the leader and read again from its source when needed; its
// contents are never saved. Its label, the file name, the column choices and the matching values are the church's
// own words too: they stay on this Mac with the contents.
//
// Matches are the leader's own: a value in the chosen column, matched to a Planning Center team (by its id), or to one
// position on that team (by the position's name, as Church rules name a lead position: Ozzie's position ids are
// numbered afresh for each check, core/src/sunday-capture.ts). Ozzie may suggest a same-named team or position
// (match.ts); only a match the leader chose is ever listed here. Nothing compares a name in a list with a person.
//
// parseSourceList refuses the whole list when anything in it falls outside this format (fail closed).
import { plainLine } from "./text.js";
import { MAX_NOTE_LINES, MAX_TITLE } from "./notes.js";
import { MAX_CELL, MAX_HEADER, MAX_ROWS } from "./sheet.js";

export const SOURCE_KINDS = ["file", "link", "notes"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Sources in all, private links among them, and columns shown on a Sunday card. */
export const MAX_SOURCES = 20;
export const MAX_LINKS = 8;
export const MAX_TICKED = 8;
/** Characters in a source's label, in what is shown of where it is (a file name or a masked address), and in a position's name. */
export const MAX_LABEL = 60;
export const MAX_SHOWN = 255;
export const MAX_NAME = 120;
/** Note sections attached to a team or a kind of finding, in one notes source. */
export const MAX_ATTACHMENTS = 50;

/** A Planning Center team, or one position on it, that the leader matched a value to. */
export interface SourceMatch { team_id: string; position_name?: string }
/** A spreadsheet source, from a file on this Mac or a private link. */
export interface SheetSource {
  id: string;
  kind: "file" | "link";
  /** The leader's name for it ("Key holders"). */
  label: string;
  /** Where it is, as the page may show it: the file's name, or the link's address masked by native code. */
  shown: string;
  /** The header of the column that names a team or role; null until the leader chooses one. */
  column: string | null;
  /** The headers of the columns shown on a matched Sunday card, at most MAX_TICKED. */
  ticked: string[];
  /** Values in the chosen column, each matched by the leader to a team or position. */
  matches: ReadonlyMap<string, SourceMatch>;
  /** When it was last read (ISO), or null. */
  read_at: string | null;
}
/**
 * The kinds of finding a section of notes can be attached to: the Sunday brief's own (core/src/sunday-brief.ts), less
 * "worth-a-look", which says what Ozzie couldn't read. Native code keeps the same list (church_sources.rs).
 */
export const NOTE_FINDING_KINDS = ["needs-people", "pending", "streak", "lead-missing", "lead-unverified", "too-few-confirmed", "background-check"] as const;
export type NoteFindingKind = (typeof NOTE_FINDING_KINDS)[number];
/** A section of the church's notes attached to a team, or to a kind of finding. */
export type NoteAttachment = ({ section: string; team_id: string } | { section: string; finding_kind: string }) & {
  /** Which section with this title, when titles repeat: 2 for the second, and so on; the first leaves it out (review V, M1). */
  occurrence?: number;
};
export interface NotesSource {
  id: string;
  kind: "notes";
  label: string;
  shown: string;
  attachments: NoteAttachment[];
  read_at: string | null;
}
export type SourceEntry = SheetSource | NotesSource;

/** A Sunday card's position, as the page hands it to the slot beside it: a position on a team, or the team itself. */
export interface CardPosition { team_id: string; position_id?: string; name: string }

const SOURCE_ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** A Planning Center id, as the rest of Ozzie checks one (core/src/kids-rules.ts). */
export const TEAM_ID = /^[1-9]\d{0,19}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u;

const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
const exactly = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
/** Text already one plain line (text.ts), not empty, at most `max` characters. */
const isPlain = (v: unknown, max: number): v is string => typeof v === "string" && v !== "" && plainLine(v, max) === v;
const instant = (v: unknown): v is string => typeof v === "string" && INSTANT.test(v) && !Number.isNaN(Date.parse(v));
const teamId = (v: unknown): v is string => typeof v === "string" && TEAM_ID.test(v);

function matchOf(v: unknown): SourceMatch | null {
  if (!plain(v)) return null;
  if (exactly(v, ["team_id"])) return teamId(v["team_id"]) ? { team_id: v["team_id"] } : null;
  if (exactly(v, ["team_id", "position_name"])) {
    return teamId(v["team_id"]) && isPlain(v["position_name"], MAX_NAME) ? { team_id: v["team_id"], position_name: v["position_name"] } : null;
  }
  return null;
}
const JOINERS = /[\u200c\u200d]/gu;
/**
 * A section's title as a pointer keeps it: at most MAX_TITLE characters, one plain line once its joiners are set aside.
 * Whether a joiner stays depends on each runtime's Unicode data (text.ts `joinable`), so it is never what makes the
 * whole list unreadable (review V); a title that differs only there just finds no section.
 */
const isTitle = (v: unknown): v is string => typeof v === "string" && v !== "" && [...v].length <= MAX_TITLE && isPlain(v.replace(JOINERS, ""), MAX_TITLE);
function attachmentOf(v: unknown): NoteAttachment | null {
  if (!plain(v) || !isTitle(v["section"])) return null;
  let occurrence: { occurrence: number } | object = {};
  if (Object.hasOwn(v, "occurrence")) {
    const n = v["occurrence"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 2 || n > MAX_NOTE_LINES) return null;
    occurrence = { occurrence: n };
  }
  const keys = Object.keys(v).filter(k => k !== "occurrence");
  const only = (names: string[]) => keys.length === names.length && names.every(k => keys.includes(k));
  if (only(["section", "team_id"])) return teamId(v["team_id"]) ? { section: v["section"], team_id: v["team_id"], ...occurrence } : null;
  if (only(["section", "finding_kind"])) {
    const kind = v["finding_kind"];
    return typeof kind === "string" && (NOTE_FINDING_KINDS as readonly string[]).includes(kind) ? { section: v["section"], finding_kind: kind, ...occurrence } : null;
  }
  return null;
}
function entryOf(v: unknown): SourceEntry | null {
  if (!plain(v)) return null;
  const { id, kind, label, shown, read_at } = v;
  if (typeof id !== "string" || !SOURCE_ID.test(id) || !isPlain(label, MAX_LABEL) || !isPlain(shown, MAX_SHOWN)) return null;
  if (read_at !== null && !instant(read_at)) return null;
  if (kind === "notes") {
    if (!exactly(v, ["id", "kind", "label", "shown", "attachments", "read_at"]) || !Array.isArray(v["attachments"])) return null;
    if (v["attachments"].length > MAX_ATTACHMENTS) return null;
    // Array.from visits holes in a sparse array, which map and every skip.
    const attachments = Array.from(v["attachments"] as unknown[], attachmentOf);
    return attachments.every(a => a !== null) ? { id, kind, label, shown, attachments: attachments as NoteAttachment[], read_at } : null;
  }
  if (kind !== "file" && kind !== "link") return null;
  if (!exactly(v, ["id", "kind", "label", "shown", "column", "ticked", "matches", "read_at"])) return null;
  const { column, ticked, matches } = v;
  if (column !== null && !isPlain(column, MAX_HEADER)) return null;
  if (!Array.isArray(ticked) || ticked.length > MAX_TICKED || !Array.from(ticked as unknown[]).every(t => isPlain(t, MAX_HEADER)) || new Set(ticked).size !== ticked.length) return null;
  if (!plain(matches)) return null;
  const pairs = Object.entries(matches);
  if (pairs.length > MAX_ROWS) return null;
  const map = new Map<string, SourceMatch>();
  for (const [value, m] of pairs) {
    const match = matchOf(m);
    if (!isPlain(value, MAX_CELL) || match === null) return null;
    map.set(value, match);
  }
  return { id, kind, label, shown, column, ticked: ticked as string[], matches: map, read_at };
}

/**
 * The list native code sends (`church_sources`), or null when any part of it is outside the format: each entry's keys
 * exactly as above, every text already plain and within its limit, ids unique, at most MAX_SOURCES sources and
 * MAX_LINKS links.
 */
export function parseSourceList(value: unknown): SourceEntry[] | null {
  if (!Array.isArray(value) || value.length > MAX_SOURCES) return null;
  const entries = Array.from(value as unknown[], entryOf);
  if (!entries.every(e => e !== null)) return null;
  const list = entries as SourceEntry[];
  if (new Set(list.map(e => e.id)).size !== list.length || list.filter(e => e.kind === "link").length > MAX_LINKS) return null;
  return list;
}
