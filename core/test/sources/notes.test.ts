// The church's own notes (.txt or .md): split into sections at `#` headings, or at blank lines when there are none;
// everything else is literal text (no Markdown, no links, no images); a find that folds case and accents and gives
// ranges a renderer splits the text at; a section found again for what it is attached to. Fictional data only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_HITS, MAX_NOTE_LINE, MAX_NOTE_LINES, MAX_NOTES_BYTES, NOTES_PROBLEMS, occurrenceOf, parseNotes, readNotes, searchNotes, sectionFor, sectionName, type Notes,
  type NotesResult,
} from "../../src/sources/notes.js";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/sources/${name}`, import.meta.url)));
const notesOf = (result: NotesResult): Notes => {
  if (!result.ok) throw new Error(`expected notes, got ${result.problem}`);
  return result.notes;
};
const NO_FLAGS = { guessedEncoding: false, linesCut: false, longLinesCut: false };
const MD = notesOf(readNotes(fixture("notes.md")));
const TXT = notesOf(readNotes(fixture("notes.txt")));
/** What a renderer would highlight: the text at each range. */
const marked = (text: string, ranges: readonly { start: number; end: number }[]) => ranges.map(r => text.slice(r.start, r.end));

describe("parseNotes", () => {
  it("splits at # headings, with the text before the first one as its own section; headings are only titles", () => {
    expect(MD.sections).toEqual([
      { title: "These are the welcome team's notes.", heading: false, lines: ["These are the welcome team's notes."] },
      { title: "Child safety policy", heading: true, lines: ["Two adults in every room.", "No one is alone with a child.", "", "See https://example.invalid/policy for the full text."] },
      { title: "Building keys", heading: true, lines: ["The side-door key is in the office.", "", "#hashtag is not a heading"] },
      { title: `Caf${cp(0xe9)} and snow days`, heading: true, lines: [`If the roads are closed, the cafe${cp(0x301)} stays shut.`, "[a link](https://example.invalid) **bold** <b>tag</b>"] },
    ]);
    expect(MD.flags).toEqual(NO_FLAGS);
  });

  it("splits at blank lines when there are no headings, each section named by its first line and keeping it", () => {
    expect(TXT.sections).toEqual([
      { title: "Child safety policy", heading: false, lines: ["Child safety policy", "Two adults in every room."] },
      { title: "Building keys", heading: false, lines: ["Building keys", "The side-door key is in the office.", "  Ask the office first."] },
      { title: "Snow days", heading: false, lines: ["Snow days"] },
    ]);
  });

  it("keeps line breaks and each line's own spacing, and takes format characters and controls out", () => {
    const notes = notesOf(parseNotes(`# Keys${cp(0x202e)} and doors\nSide${cp(0x200b)} door\tkey${cp(0x7)}\r\nnext${cp(0x2028)}line${cp(0x2029)}last\rend${cp(0x85)}x   `));
    expect(notes.sections).toEqual([{ title: "Keys and doors", heading: true, lines: ["Side door key", "next", "line", "last", "end", "x"] }]);
    // A heading: up to three spaces, one to six #, then a space or nothing.
    const kinds = notesOf(parseNotes("   ### Three\n#### Four #\n####### Seven\n#\n    # Indented")).sections;
    expect(kinds.map(s => [s.title, s.heading, s.lines])).toEqual([["Three", true, []], ["Four #", true, ["####### Seven"]], ["", true, ["    # Indented"]]]);
    // A byte-order mark at the start is not text.
    expect(notesOf(parseNotes(`${cp(0xfeff)}# Title\nBody`)).sections[0]!.title).toBe("Title");
  });

  it("refuses empty notes and notes over 1 MB, counted in UTF-8 bytes", () => {
    expect(NOTES_PROBLEMS).toEqual(["notes-too-large", "not-text", "empty"]);
    for (const text of ["", "\n\n", "   \n\t\n", cp(0xfeff), `${cp(0x200b)}\n${cp(0x202e)}`]) expect(parseNotes(text), JSON.stringify(text)).toEqual({ ok: false, problem: "empty" });
    expect(parseNotes("a".repeat(MAX_NOTES_BYTES + 1))).toEqual({ ok: false, problem: "notes-too-large" });
    expect(parseNotes(cp(0xe9).repeat(MAX_NOTES_BYTES / 2 + 1))).toEqual({ ok: false, problem: "notes-too-large" });
    expect(parseNotes("a".repeat(MAX_NOTES_BYTES)).ok).toBe(true);
    expect(readNotes(new Uint8Array(MAX_NOTES_BYTES + 1).fill(0x61))).toEqual({ ok: false, problem: "notes-too-large" });
    expect(readNotes(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toEqual({ ok: false, problem: "not-text" });
    expect(readNotes(Uint8Array.from([0x61, 0x00, 0x62]))).toEqual({ ok: false, problem: "not-text" });
    expect(notesOf(readNotes(Uint8Array.from([0x43, 0x61, 0x66, 0xe9]))).flags).toEqual({ ...NO_FLAGS, guessedEncoding: true });
  });

  it("shows the first 20,000 lines and cuts a line over 2,000 characters, saying so", () => {
    expect([MAX_NOTE_LINES, MAX_NOTE_LINE]).toEqual([20000, 2000]);
    const over = notesOf(parseNotes("x\n".repeat(MAX_NOTE_LINES + 1)));
    expect(over.sections[0]!.lines).toHaveLength(MAX_NOTE_LINES);
    expect(over.flags).toEqual({ ...NO_FLAGS, linesCut: true });
    expect(notesOf(parseNotes(`${"x\n".repeat(MAX_NOTE_LINES)}\n\n  \n`)).flags.linesCut).toBe(false);
    const long = notesOf(parseNotes(`# T\n${"y".repeat(MAX_NOTE_LINE + 1)}`));
    expect(long.sections[0]!.lines[0]).toBe(`${"y".repeat(MAX_NOTE_LINE - 1)}…`);
    expect(long.flags).toEqual({ ...NO_FLAGS, longLinesCut: true });
    // A title is one plain line of at most 120 characters.
    expect(notesOf(parseNotes(`#  ${"T".repeat(130)}  `)).sections[0]!.title).toBe(`${"T".repeat(119)}…`);
  });

  it("reads nearly 1 MB of notes, and finds in them, quickly", () => {
    const big = Array.from({ length: MAX_NOTE_LINES }, (_, i) => (i % 40 === 0 ? `# Section ${i} caf${cp(0xe9)}` : `Line ${i}: r${cp(0xe9)}sum${cp(0xe9)} of the d${cp(0xe9)}j${cp(0xe0)} vu, na${cp(0xef)}ve, too`)).join("\n");
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(900_000);
    // The middle of five timings, with a loose bound (review S, L6): one run slowed by a busy Mac doesn't fail it, and
    // a pass over the notes for each line would take far longer.
    const middle = <T>(work: () => T): { ms: number; result: T } => {
      const times: number[] = [];
      let result = work();
      for (let run = 0; run < 5; run++) { const start = performance.now(); result = work(); times.push(performance.now() - start); }
      return { ms: times.sort((a, b) => a - b)[2]!, result };
    };
    const parsed = middle(() => notesOf(parseNotes(big)));
    expect(parsed.ms).toBeLessThan(600);
    const found = middle(() => searchNotes(parsed.result, "RESUME"));
    expect(found.ms).toBeLessThan(600);
    expect(found.result.more).toBe(true);
  });
});

describe("searchNotes", () => {
  it("folds case and accents, and gives ranges in the text as shown", () => {
    const found = searchNotes(MD, "CAFE");
    expect(found.more).toBe(false);
    expect(found.hits.map(h => [h.section, h.line])).toEqual([[3, "title"], [3, 0]]);
    expect(marked(MD.sections[3]!.title, found.hits[0]!.ranges)).toEqual([`Caf${cp(0xe9)}`]);
    // The accent written as its own mark is part of the highlighted text.
    expect(marked(MD.sections[3]!.lines[0]!, found.hits[1]!.ranges)).toEqual([`cafe${cp(0x301)}`]);
    const two = searchNotes(MD, "two ADULTS");
    expect(two.hits).toEqual([{ section: 1, line: 0, ranges: [{ start: 0, end: 10 }] }]);
  });

  it("finds every place in a line, never a title that is only the first line repeated", () => {
    const found = searchNotes(TXT, "safety");
    expect(found.hits).toEqual([{ section: 0, line: 0, ranges: [{ start: 6, end: 12 }] }]);
    const os = searchNotes(MD, "o");
    const line = os.hits.find(h => h.section === 1 && h.line === 1)!;
    expect(marked(MD.sections[1]!.lines[1]!, line.ranges)).toEqual(["o", "o", "o"]);
    expect(line.ranges.map(r => r.start)).toEqual([1, 3, 12]);
  });

  it("folds compatibility forms and never splits a character or overlaps two ranges", () => {
    const notes = notesOf(parseNotes(`# x\n${cp(0xfb01)}re drill\n${cp(0xff33, 0xff4e, 0xff4f, 0xff57)} day\n${cp(0xfb03)}x`));
    expect(marked(notes.sections[0]!.lines[0]!, searchNotes(notes, "fire").hits[0]!.ranges)).toEqual([`${cp(0xfb01)}re`]);
    expect(marked(notes.sections[0]!.lines[1]!, searchNotes(notes, "snow").hits[0]!.ranges)).toEqual([cp(0xff33, 0xff4e, 0xff4f, 0xff57)]);
    expect(searchNotes(notes, "f").hits.find(h => h.line === 2)!.ranges).toEqual([{ start: 0, end: 1 }]);
    const emoji = notesOf(parseNotes(`# x\nPicnic ${cp(0x1f9fa)} basket`));
    expect(marked(emoji.sections[0]!.lines[0]!, searchNotes(emoji, cp(0x1f9fa)).hits[0]!.ranges)).toEqual([cp(0x1f9fa)]);
  });

  it("finds nothing for an empty query, and stops at a bound", () => {
    expect(searchNotes(MD, "")).toEqual({ hits: [], more: false });
    expect(searchNotes(MD, "   ")).toEqual({ hits: [], more: false });
    expect(searchNotes(MD, "nowhere in here")).toEqual({ hits: [], more: false });
    const many = notesOf(parseNotes(`# A\n${"aa \n".repeat(MAX_HITS)}`));
    const found = searchNotes(many, "a");
    expect(found.more).toBe(true);
    expect(found.hits.reduce((n, h) => n + h.ranges.length, 0)).toBe(MAX_HITS);
  });
});

describe("a heading as written (review V, H1)", () => {
  it("keeps the heading's text as written when its title is cut or its spacing tidied, and only then", () => {
    const long = "A".repeat(300);
    const notes = notesOf(parseNotes(`# ${long}\nbody\n#  Snow   days \nwe text\n# Child safety policy\nTwo adults.\n#\nbare\n`));
    expect(notes.sections.map(s => [s.title, s.written])).toEqual([
      [`${"A".repeat(119)}…`, long], ["Snow days", "Snow   days"], ["Child safety policy", undefined], ["", undefined],
    ]);
    expect(notes.sections[2]).toEqual({ title: "Child safety policy", heading: true, lines: ["Two adults."] });
  });
});

describe("sectionFor", () => {
  it("finds the first section with the attached title, or nothing", () => {
    expect(sectionFor(MD, { section: "Building keys", team_id: "101" })).toEqual({ index: 2, section: MD.sections[2] });
    expect(sectionFor(TXT, { section: "Snow days", finding_kind: "lead-missing" })).toEqual({ index: 2, section: TXT.sections[2] });
    expect(sectionFor(MD, { section: "Gone", team_id: "101" })).toBeNull();
    expect(sectionFor(MD, { section: "", team_id: "101" })).toBeNull();
    const twice = notesOf(parseNotes("# Keys\none\n# Keys\ntwo"));
    expect(sectionFor(twice, { section: "Keys", team_id: "1" })?.section.lines).toEqual(["one"]);
  });

  it("finds the occurrence chosen when titles repeat, and names repeats apart (review V, M1)", () => {
    const notes = notesOf(parseNotes("# Nursery\n## Who to call\nNursery lead\n# Kids\n## Who to call\nKids lead\n# Who to call\nOffice\n#\n"));
    expect(sectionFor(notes, { section: "Who to call", team_id: "1" })?.index).toBe(1);
    expect(sectionFor(notes, { section: "Who to call", team_id: "1", occurrence: 2 })?.section.lines).toEqual(["Kids lead"]);
    expect(sectionFor(notes, { section: "Who to call", finding_kind: "pending", occurrence: 3 })?.index).toBe(4);
    expect(sectionFor(notes, { section: "Who to call", team_id: "1", occurrence: 4 })).toBeNull();
    expect(notes.sections.map((_, i) => [sectionName(notes, i), occurrenceOf(notes, i)])).toEqual([
      ["Nursery", 1], ["Who to call (1)", 1], ["Kids", 1], ["Who to call (2)", 2], ["Who to call (3)", 3], ["", 1],
    ]);
  });
});
