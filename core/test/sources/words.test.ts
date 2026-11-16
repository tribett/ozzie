// What the leader reads about a church-added list or notes: each closed problem code in plain words (the plan's own
// sentences where it has them), the notes about what was shown, and the frames that say this is the church's own
// text, not checked by Ozzie.
import { describe, expect, it } from "vitest";
import { NOTES_PROBLEMS } from "../../src/sources/notes.js";
import { SHEET_PROBLEMS } from "../../src/sources/sheet.js";
import {
  CELLS_CUT, GUESSED_LETTERS, GUESSED_LETTERS_NOTES, LINES_CUT, LINK_PROBLEMS, LINK_ONLY_PROBLEMS, listFrame, LONG_LINES_CUT, NATIVE_SOURCE_PROBLEMS, NOTE_KIND_WORDS,
  NOTES_FRAME, NOTES_WORDS, notesBeside, readFrom, ROWS_CUT, SAME_NAME, SOURCE_PROBLEMS, sourceProblem, UNKNOWN_PROBLEM, USE_MATCH,
} from "../../src/sources/words.js";

describe("problems in plain words", () => {
  it("has one sentence for each closed code, from the sheet, the notes and native code, and no other", () => {
    expect(Object.keys(SOURCE_PROBLEMS).sort()).toEqual([...new Set([...SHEET_PROBLEMS, ...NOTES_PROBLEMS, ...NATIVE_SOURCE_PROBLEMS])].sort());
    expect(NATIVE_SOURCE_PROBLEMS).toEqual(["file-missing", "not-allowed", "not-the-file", "private-place", "list-unreadable", "pdf", "section-title", ...LINK_ONLY_PROBLEMS,
      "unavailable"]);
    // A private link's own (src-tauri church_sources.rs, from core/native-auth calendar_link.rs LinkError).
    expect(LINK_ONLY_PROBLEMS).toEqual(["not-an-address", "not-https", "sign-in-in-address", "not-on-the-internet", "unreachable", "timeout", "refused",
      "moved-elsewhere", "web-page", "not-a-sheet", "too-many-links", "link-already-added", "link-missing", "links-unreadable", "keychain-locked",
      "keychain-denied", "links-left-in-keychain"]);
  });

  it("says a problem a file and a link share in the link's own words, and every other one as for any list", () => {
    expect(Object.keys(LINK_PROBLEMS).sort()).toEqual(["empty", "no-header", "not-text", "too-large", "too-many-columns", "workbook"]);
    for (const [code, words] of Object.entries(LINK_PROBLEMS)) {
      expect(sourceProblem(code, "link")).toBe(words);
      expect(sourceProblem(code, "file")).toBe(SOURCE_PROBLEMS[code as keyof typeof SOURCE_PROBLEMS]);
      expect(words, code).not.toMatch(/\bfile\b/u);
    }
    expect(sourceProblem("too-large", "link")).toBe("That sheet is over 2 MB.");
    expect(sourceProblem("no-header", "link")).toBe("That sheet has no header row.");
    expect(sourceProblem("web-page", "link")).toBe(SOURCE_PROBLEMS["web-page"]);
    expect(sourceProblem("timeout", "link")).toBe(SOURCE_PROBLEMS.timeout);
    // A link's own problems say what to do, never "file".
    for (const code of LINK_ONLY_PROBLEMS) expect(SOURCE_PROBLEMS[code], code).not.toMatch(/\bfile\b/u);
    for (const other of ["constructor", "__proto__", undefined]) expect(sourceProblem(other, "link")).toBe(UNKNOWN_PROBLEM);
  });

  it("uses the plan's sentences word for word", () => {
    // Review S, L7: each app's own menu (Excel for Mac's Save As lists "CSV UTF-8 (Comma delimited) (.csv)").
    expect(SOURCE_PROBLEMS.workbook).toBe("This looks like a workbook, not a CSV file. In Numbers choose File › Export To › CSV. In Excel choose File › Save As and pick CSV UTF-8. Then choose that file.");
    expect(SOURCE_PROBLEMS["too-large"]).toBe("That file is over 2 MB.");
    expect(SOURCE_PROBLEMS["file-missing"]).toBe("Ozzie can't find that file any more (it may have been moved). Choose it again.");
    // Review S, L4: a file Ozzie may not read, and an alias chosen, each say what is so.
    expect(SOURCE_PROBLEMS["not-allowed"]).toBe("Ozzie isn't allowed to read that file. Choose it again, or move it to a folder Ozzie may read.");
    expect(SOURCE_PROBLEMS["not-the-file"]).toBe("That's an alias of a file, not the file itself. Choose the original file.");
    expect(SOURCE_PROBLEMS["no-header"]).toBe("That file has no header row.");
    expect(SOURCE_PROBLEMS["web-page"]).toBe("That address gave back a web page (often a sign-in page) rather than the spreadsheet, or the sheet's first cell starts like a web page's tag. In Google Sheets choose File › Share › Publish to web › Comma-separated values, and copy that link.");
    expect(SOURCE_PROBLEMS["too-many-links"]).toBe("Ozzie reads up to 8 private links. Remove one to add another.");
    expect(ROWS_CUT).toBe("Ozzie showed the first 2,000 rows.");
    expect(GUESSED_LETTERS).toBe("Some letters may look wrong. Save it as 'CSV UTF-8' for the best result.");
  });

  it("says a problem notes share with a list's file in notes' own words: plain text or Markdown, 1 MB", () => {
    expect(Object.keys(NOTES_WORDS).sort()).toEqual(["not-text", "pdf", "too-large", "workbook"]);
    expect(sourceProblem("pdf", "notes")).toBe("That's a PDF. Ozzie reads notes saved as plain text or Markdown: save or export it as plain text (.txt) from the app that made it, then choose that file.");
    expect(sourceProblem("workbook", "notes")).toBe("That looks like a Word or Pages document, not plain text. Save it as plain text (.txt) from the app that made it, then choose that file.");
    expect(sourceProblem("too-large", "notes")).toBe(SOURCE_PROBLEMS["notes-too-large"]);
    expect(sourceProblem("not-text", "notes")).toMatch(/plain text \(\.txt\) or Markdown/u);
    // Everything else as for any source.
    expect(sourceProblem("file-missing", "notes")).toBe(SOURCE_PROBLEMS["file-missing"]);
    expect(sourceProblem("pdf", "file")).toBe(SOURCE_PROBLEMS.pdf);
  });

  it("names each kind of finding a section can be attached to in plain words, and only those", () => {
    expect(Object.keys(NOTE_KIND_WORDS)).toEqual(["needs-people", "pending", "streak", "lead-missing", "lead-unverified", "too-few-confirmed", "background-check"]);
    for (const words of Object.values(NOTE_KIND_WORDS)) expect(words).toMatch(/^[A-Z]/u);
  });

  it("treats any other code as not read, looked up without prototypes", () => {
    expect(sourceProblem("workbook")).toBe(SOURCE_PROBLEMS.workbook);
    for (const other of ["constructor", "toString", "__proto__", "", undefined, null, { code: "workbook" }, 7]) expect(sourceProblem(other)).toBe(UNKNOWN_PROBLEM);
  });
});

describe("the frames around the church's own words", () => {
  it("names the list and says Ozzie didn't check it", () => {
    expect(listFrame("Key holders")).toBe("From your church's list 'Key holders' (not checked by Ozzie)");
    expect(NOTES_FRAME).toBe("Your church's own notes. Ozzie doesn't check or follow these.");
    // Review V, L1: framed as the church's own and not checked, as a list's rows are.
    expect(notesBeside("Child safety policy")).toBe("From your church's own notes (not checked by Ozzie): Child safety policy");
    expect(GUESSED_LETTERS_NOTES).toBe("Some letters may look wrong. Save the file again as plain text from the app that made it.");
    expect(readFrom("key-holders.csv", "9:06 AM")).toBe("Read from key-holders.csv at 9:06 AM");
    expect(SAME_NAME).toEqual({ team: "Same name as the Planning Center team", position: "Same name as the Planning Center position" });
    expect(USE_MATCH).toBe("Use this match");
  });
});

describe("plain words", () => {
  const lines = [
    ...Object.values(SOURCE_PROBLEMS), ...Object.values(LINK_PROBLEMS), ...Object.values(NOTES_WORDS), ...Object.values(NOTE_KIND_WORDS), UNKNOWN_PROBLEM, ROWS_CUT, CELLS_CUT, GUESSED_LETTERS, GUESSED_LETTERS_NOTES, LINES_CUT, LONG_LINES_CUT,
    listFrame("Key holders"), NOTES_FRAME, notesBeside("Snow days"), readFrom("notes.md", "9:06 AM"), ...Object.values(SAME_NAME), USE_MATCH,
  ];
  it("uses none of the words kept off every screen, and never calls the church's text checked", () => {
    for (const line of lines) {
      expect(line).not.toMatch(/\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|MCP|servers?|JSON|stdio|protocol|parse[ds]?|parser|encoding|delimiter|bytes?)\b/iu);
      expect(line).not.toMatch(/\b(?:approve|block(?:ed)?|risk|drift(?:ing)?|score|rank(?:ed|ing)?)\b/iu);
      // Ozzie never presents the list or notes as facts it checked.
      expect(line).not.toMatch(/\b(?:verified|confirmed|accurate|correct|true)\b/iu);
      expect(line.replace("not checked by Ozzie", "")).not.toMatch(/\bchecked\b/iu);
      // Sentences end in a full stop, except the frame lines and short labels.
      expect(line.trim()).toBe(line);
    }
    for (const sentence of [...Object.values(SOURCE_PROBLEMS), ...Object.values(LINK_PROBLEMS), ...Object.values(NOTES_WORDS), UNKNOWN_PROBLEM, ROWS_CUT, CELLS_CUT, GUESSED_LETTERS, GUESSED_LETTERS_NOTES, LINES_CUT, LONG_LINES_CUT, NOTES_FRAME]) {
      expect(sentence).toMatch(/[.]$/u);
    }
  });
});
