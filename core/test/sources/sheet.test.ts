// A spreadsheet file the leader picks (CSV or TSV), read on this Mac: its encodings, RFC 4180 quoting, the delimiter
// from the first line, the header row, the limits, formula-looking cells kept as text, and no freeze on a
// pathological 2 MB file. Fixtures are fictional and written as bytes (core/test/fixtures/sources); the two that
// hold NUL bytes are kept as hex text so the repository holds no binary file outside images and fonts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decodeSheet, MAX_CELL, MAX_COLUMNS, MAX_HEADER, MAX_ROWS, MAX_SHEET_BYTES, parseSheet, readSheet, SHEET_PROBLEMS, type Sheet, type SheetResult,
} from "../../src/sources/sheet.js";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/sources/${name}`, import.meta.url)));
const hexFixture = (name: string) => Uint8Array.from(readFileSync(new URL(`../fixtures/sources/${name}`, import.meta.url), "utf8").trim().split(/\s+/u).map(h => parseInt(h, 16)));
const sheetOf = (result: SheetResult): Sheet => {
  if (!result.ok) throw new Error(`expected a sheet, got ${result.problem}`);
  return result.sheet;
};
const NO_FLAGS = { guessedEncoding: false, rowsCut: false, cellsCut: false };

describe("reading the leader's file", () => {
  it("reads a UTF-8 file into its header and rows, in file order, quoted commas intact", () => {
    const sheet = sheetOf(readSheet(fixture("utf8.csv")));
    expect(sheet).toEqual({
      headers: ["Name", "Team", "Role", "Notes"],
      rows: [
        ["Dana Fictional", "Ushers", "Door greeter", "Has the side-door key"],
        ["Lee Example", "Parking", "Lot lead", "Prefers the north lot, by the trees"],
        [`R${cp(0xe9)}my Sample`, "Ushers", "Usher", `Caf${cp(0xe9)} shift`],
      ],
      delimiter: ",",
      flags: NO_FLAGS,
    });
    expect(readSheet(fixture("utf8-bom.csv"))).toEqual(readSheet(fixture("utf8.csv")));
  });

  it("reads UTF-16 with its byte-order mark, and windows-1252 with a note that letters may look wrong", () => {
    const sixteen = sheetOf(readSheet(hexFixture("utf16le-bom.hex")));
    expect(sixteen.headers).toEqual(["Name", "Team"]);
    expect(sixteen.rows).toEqual([[`Zo${cp(0xeb)} Fictional`, `Greeters ${cp(0x1f44b)}`], ["Dana Fictional", "Ushers"]]);
    expect(sixteen.flags).toEqual(NO_FLAGS);
    const guessed = sheetOf(readSheet(fixture("windows-1252.csv")));
    expect(guessed.rows).toEqual([[`Ren${cp(0xe9)} Fictional`, `Caf${cp(0xe9)} crew`, `Coffee ${cp(0x20ac)}2`], [`Zo${cp(0xeb)} Sample`, "Ushers", `Lee${cp(0x2019)}s spare key`]]);
    expect(guessed.flags).toEqual({ ...NO_FLAGS, guessedEncoding: true });
  });

  it("takes the delimiter from the first line, outside quotes: comma, semicolon or tab", () => {
    const semi = sheetOf(readSheet(fixture("semicolon.csv")));
    expect(semi.delimiter).toBe(";");
    expect(semi.rows).toEqual([["Dana Fictional", "Ushers", "Keys; side door, back gate"], ["Lee Example", "Parking", "1,5 hours"]]);
    const tab = sheetOf(readSheet(fixture("tab.tsv")));
    expect(tab.delimiter).toBe("\t");
    expect(tab.rows).toEqual([["Dana Fictional", "Ushers", "Side door, back gate"], ["Lee Example", "Parking", "North lot"]]);
    expect(sheetOf(parseSheet("\"Name, full\";Team\nDana Fictional;Ushers\n")).headers).toEqual(["Name, full", "Team"]);
    // A quote in the middle of a field is a character, not the start of quoting.
    expect(sheetOf(parseSheet("5\" screen, room;Team;Room\na;b;c\n")).delimiter).toBe(";");
    // Only the first line decides; later lines can hold the others as text.
    expect(sheetOf(parseSheet("Name,Team\nDana; Fictional,Ushers\n")).rows).toEqual([["Dana; Fictional", "Ushers"]]);
    // Ties: tab, then comma, then semicolon. None: one column.
    expect(sheetOf(parseSheet("Last, First\tTeam\nx\ty\n")).delimiter).toBe("\t");
    expect(sheetOf(parseSheet("A,B;C\n")).delimiter).toBe(",");
    expect(sheetOf(parseSheet("Team\nUshers\nParking\n"))).toEqual({ headers: ["Team"], rows: [["Ushers"], ["Parking"]], delimiter: ",", flags: NO_FLAGS });
  });

  it("follows RFC 4180 quoting: line breaks, doubled quotes and delimiters inside quotes; CRLF, LF and CR line ends", () => {
    const quoted = sheetOf(readSheet(fixture("quoted.csv")));
    expect(quoted.rows).toEqual([
      ["Dana Fictional", "Ushers", "Line one line two"],
      ["Lee \"Lee\" Example", "Parking", "North lot, by the trees"],
      ["Remy, Sample", "Greeters\" team", "ab"],
    ]);
    expect(sheetOf(readSheet(fixture("cr-endings.csv"))).rows).toEqual([["Dana Fictional", "Ushers"], ["Lee Example", "Parking"]]);
    // A quote never closed runs to the end of the text, as a spreadsheet reads it.
    expect(sheetOf(parseSheet("Name,Notes\nDana Fictional,\"open\nstill open,here\n")).rows).toEqual([["Dana Fictional", "open still open,here"]]);
    // A byte-order mark left at the start of the text doesn't stop the first field being quoted.
    expect(sheetOf(parseSheet(`${cp(0xfeff)}"Name, full",Team\nx,y`)).headers).toEqual(["Name, full", "Team"]);
  });

  it("keeps formula-looking cells as the text they are: nothing is ever worked out", () => {
    const sheet = sheetOf(readSheet(fixture("formulas.csv")));
    expect(sheet.rows).toEqual([
      ["Dana Fictional", "Ushers", "=HYPERLINK(\"https://example.invalid/x\",\"Open\")"],
      ["Lee Example", "+1", "-1"],
      ["Remy Sample", "@x", "=1+2"],
    ]);
  });

  it("makes every header and cell one plain line: direction overrides and zero-width characters out, an emoji family whole", () => {
    const sheet = sheetOf(readSheet(fixture("bidi.csv")));
    expect(sheet.headers).toEqual(["Name", "Team", "Notes"]);
    expect(sheet.rows).toEqual([
      ["Dana Fictional", "Ushers", "Side door key"],
      ["Lee Example", "Parking", `Snack table ${cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)}`],
    ]);
    const hiddenOrControl = /[\p{Cc}\p{Cf}]/u;
    for (const cell of [...sheet.headers, ...sheet.rows.flat()]) expect(cell.replace(new RegExp(cp(0x200d), "gu"), "")).not.toMatch(hiddenOrControl);
    // Headers are made plain too.
    expect(sheetOf(parseSheet(`Na${cp(0x202e)}me,${cp(0x200b)}Team\na,b\n`)).headers).toEqual(["Name", "Team"]);
  });

  it("refuses what isn't a list it can show, with a closed problem", () => {
    expect(SHEET_PROBLEMS).toEqual(["workbook", "too-large", "not-text", "empty", "no-header", "too-many-columns"]);
    expect(readSheet(hexFixture("workbook-start.hex"))).toEqual({ ok: false, problem: "workbook" });
    expect(readSheet(fixture("empty.csv"))).toEqual({ ok: false, problem: "empty" });
    for (const text of ["", " ", "\n\n\r\n", ",,,\n,,\n", `${cp(0xfeff)}`, `${cp(0x200b)},${cp(0x202e)}\n`]) expect(parseSheet(text), JSON.stringify(text)).toEqual({ ok: false, problem: "empty" });
    // The first row is the header: when it is blank and rows follow, there is no header row.
    expect(readSheet(fixture("no-header.csv"))).toEqual({ ok: false, problem: "no-header" });
    expect(parseSheet("\nName,Team\nDana Fictional,Ushers\n")).toEqual({ ok: false, problem: "no-header" });
    expect(readSheet(Uint8Array.from([0x41, 0x00, 0x42]))).toEqual({ ok: false, problem: "not-text" });
    expect(readSheet(new Uint8Array(MAX_SHEET_BYTES + 1).fill(0x41))).toEqual({ ok: false, problem: "too-large" });
    expect(decodeSheet(new Uint8Array(MAX_SHEET_BYTES + 1))).toEqual({ ok: false, problem: "too-large" });
  });

  it("reads a header row with nothing under it as an empty list", () => {
    expect(readSheet(fixture("header-only.csv"))).toEqual({ ok: true, sheet: { headers: ["Name", "Team", "Role"], rows: [], delimiter: ",", flags: NO_FLAGS } });
  });
});

describe("the limits", () => {
  const header = (n: number) => Array.from({ length: n }, (_, i) => `Column ${i + 1}`).join(",");
  it("refuses more than 30 named columns; blank columns at the end don't count; extra cells in a row are left out", () => {
    expect(MAX_COLUMNS).toBe(30);
    expect(parseSheet(`${header(31)}\n`)).toEqual({ ok: false, problem: "too-many-columns" });
    expect(sheetOf(parseSheet(`${header(30)}\n`)).headers).toHaveLength(30);
    expect(sheetOf(parseSheet(`${header(30)}${",".repeat(40)}\n`)).headers).toHaveLength(30);
    expect(sheetOf(parseSheet(`Name,Team,,,\n${"x,".repeat(40)}y\n`))).toEqual({ headers: ["Name", "Team"], rows: [["x", "x"]], delimiter: ",", flags: NO_FLAGS });
    // A column with a blank header between named ones stays, so cells keep their places.
    expect(sheetOf(parseSheet("Name,,Team\na,b,c\n")).rows).toEqual([["a", "b", "c"]]);
  });

  it("shows the first 2,000 rows and says when there were more; blank rows aren't rows", () => {
    expect(MAX_ROWS).toBe(2000);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `Person ${i + 1},Team`).join("\n");
    const exact = sheetOf(parseSheet(`Name,Team\n${rows(2000)}\n\n,\n  \n`));
    expect(exact.rows).toHaveLength(2000);
    expect(exact.flags.rowsCut).toBe(false);
    const over = sheetOf(parseSheet(`Name,Team\n${rows(2001)}\n`));
    expect(over.rows).toHaveLength(2000);
    expect(over.rows.at(-1)).toEqual(["Person 2000", "Team"]);
    expect(over.flags).toEqual({ ...NO_FLAGS, rowsCut: true });
    expect(sheetOf(parseSheet("Name,Team\n\nDana Fictional,Ushers\n,\n\nLee Example\n")).rows).toEqual([["Dana Fictional", "Ushers"], ["Lee Example", ""]]);
  });

  it("cuts a cell over 500 characters and a header over 120, marking each with …", () => {
    expect([MAX_CELL, MAX_HEADER]).toEqual([500, 120]);
    const sheet = sheetOf(parseSheet(`${"H".repeat(121)},Team\n${"c".repeat(501)},${"d".repeat(500)}\n`));
    expect(sheet.headers[0]).toBe(`${"H".repeat(119)}…`);
    expect(sheet.rows[0]).toEqual([`${"c".repeat(499)}…`, "d".repeat(500)]);
    expect(sheet.flags).toEqual({ ...NO_FLAGS, cellsCut: true });
    expect(sheetOf(parseSheet(`${"H".repeat(121)}\nx\n`)).flags.cellsCut).toBe(true);
    // A long cell in a row past the 2,000 shown doesn't count as shown cut.
    expect(sheetOf(parseSheet(`Name\n${"a\n".repeat(2000)}${"z".repeat(600)}\n`)).flags).toEqual({ ...NO_FLAGS, rowsCut: true });
  });
});

describe("a pathological 2 MB file doesn't freeze the page", () => {
  const TWO_MB = 2 * 1024 * 1024;
  /** Processor time this test process has used, in milliseconds: time spent waiting for a core is not counted. */
  const cpuMs = () => { const { user, system } = process.cpuUsage(); return (user + system) / 1000; };
  /**
   * Pieces of work timed in turn, five times each, giving back each one's least processor time in milliseconds. The
   * clock on the wall failed here (audit item 32): with every core busy several times over, a run waits for a core
   * again and again (a cargo build took one to 239 ms, review S, L6), and a long run waits more often than a short one,
   * so work that grows in step looked as if it grew faster, even comparing the fastest of five. Processor time leaves
   * the waiting out. Timed in turn, a busy stretch slows all of them alike; measured one after the other, a busy moment
   * during one alone (the type-checker proofs beside it in the full run) could still tip a comparison.
   */
  const timedTogether = (...works: (() => unknown)[]) => {
    const times = works.map((): number[] => []);
    for (let run = 0; run < 5; run++) {
      works.forEach((work, i) => { const start = cpuMs(); work(); times[i]!.push(cpuMs() - start); });
    }
    return times.map(t => Math.min(...t));
  };
  /** One pass over `text` reading every character: the least any reader of it does. */
  const onePass = (text: string) => { let odd = 0; for (let i = 0; i < text.length; i++) odd += text.charCodeAt(i) & 1; return odd; };
  /**
   * Each file is timed in turn with one pass over its own text, and may take at most PASSES passes' worth (plus a few
   * milliseconds for times too small to measure well). A fixed number of milliseconds (600) failed under heavy load
   * instead (audit item 32); measured against a pass over the same text, the bound holds on a slower Mac as well as a
   * busy one. Measured 2026-11-16, the costliest of these files took about 15 to 25 passes' worth, idle or with every
   * core busy; each failure these tests guard against takes a pass over the text for each field or row, hundreds of
   * thousands of passes over 2 MB. The bound sits far from both.
   */
  const PASSES = 200;
  const SLACK_MS = 20;
  /**
   * Each test here times its work five times over: a few hundred milliseconds alone, but beyond vitest's 5 s default
   * with every core busy. Work that took a pass for each field or row would still be stopped by this limit.
   */
  const TIMING_LIMIT_MS = 60_000;
  const timed = (text: string) => {
    let result = parseSheet("");
    const [ms, passMs] = timedTogether(() => { result = parseSheet(text); }, () => onePass(text));
    return { ms: ms!, passMs: passMs!, result };
  };
  const expectCheap = ({ ms, passMs }: { ms: number; passMs: number }, what: string) =>
    expect(ms < passMs * PASSES + SLACK_MS, `${what}: ${ms} ms, one pass ${passMs} ms`).toBe(true);

  it("the pass bound catches work that takes a pass over the text for each character (so the checks below can fail)", () => {
    const text = "x".repeat(10_000);
    const [ms, passMs] = timedTogether(() => { for (let i = 0; i < text.length; i++) onePass(text); }, () => onePass(text));
    expect(ms! < passMs! * PASSES + SLACK_MS, `${ms} ms, one pass ${passMs} ms`).toBe(false);
  }, TIMING_LIMIT_MS);

  it("one quoted field of 2 MB, closed or never closed", () => {
    const closed = timed(`"${"x".repeat(TWO_MB - 2)}"`);
    expectCheap(closed, "closed");
    expect(sheetOf(closed.result).headers).toEqual([`${"x".repeat(119)}…`]);
    const open = timed(`Name\n"${"y".repeat(TWO_MB - 6)}`);
    expectCheap(open, "open");
    expect(sheetOf(open.result).rows).toEqual([[`${"y".repeat(499)}…`]]);
    const doubled = timed(`Name\n"${"\"\"".repeat(TWO_MB / 2 - 4)}"`);
    expectCheap(doubled, "doubled");
    expect(sheetOf(doubled.result).rows).toEqual([[`${"\"".repeat(499)}…`]]);
  }, TIMING_LIMIT_MS);

  it("a 2 MB line of delimiters, as the header or as a row", () => {
    const asHeader = timed(`Name${",".repeat(TWO_MB - 4)}\nDana Fictional\n`);
    expectCheap(asHeader, "as the header");
    expect(sheetOf(asHeader.result).rows).toEqual([["Dana Fictional"]]);
    const asRow = timed(`Name,Team\n${";".repeat(TWO_MB - 10)}`);
    expectCheap(asRow, "as a row");
    expect(sheetOf(asRow.result).rows).toEqual([[";".repeat(499) + "…", ""]]);
    const commas = timed(`Name,Team\n${",".repeat(TWO_MB - 10)}`);
    expectCheap(commas, "commas");
    expect(sheetOf(commas.result).rows).toEqual([]);
    const tabs = timed(`${"\t".repeat(TWO_MB)}`);
    expectCheap(tabs, "tabs");
    expect(tabs.result).toEqual({ ok: false, problem: "empty" });
  }, TIMING_LIMIT_MS);

  /**
   * Whether work grew in step with its size: `large` is four times `small`, so it takes about four times as long, and work
   * that grew with the square would take sixteen times as long. Eight leaves room for a busy Mac; the few milliseconds
   * added cover times too small to measure well (review S2, finding 4).
   */
  const inStep = (small: number, large: number) => large < small * 8 + 3;
  it("the growth check catches work that grows with the square of its size (so the checks below can fail)", () => {
    const square = (n: number) => () => { let sum = 0; for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) sum += j & 1; return sum; };
    const [small, large] = timedTogether(square(2500), square(10_000));
    expect(small).toBeGreaterThan(0.5);
    expect(inStep(small!, large!), `${small} ms, then ${large} ms`).toBe(false);
  }, TIMING_LIMIT_MS);

  it("blank fields past the 30 columns cost about what empty ones do, and four times the fields take about four times as long", () => {
    // Spaces, tabs and a control between the delimiters: each blank, none empty; four fields to eight characters.
    const blank = (fields: number) => `Name\n${",  ,\t, \u0001".repeat(fields / 4)}\n`;
    const empty = (fields: number) => `Name\n${",".repeat(fields)}\n`;
    // 524,288 fields: 1 MB of blank ones.
    const fields = TWO_MB / 4;
    const [blankText, emptyText, quarterText] = [blank(fields), empty(fields), blank(fields / 4)];
    const most = timed(blankText);
    expectCheap(most, "blank fields");
    expect(sheetOf(most.result).rows).toEqual([]);
    expect(sheetOf(parseSheet(emptyText)).rows).toEqual([]);
    // The same number of fields, blank or empty, timed in turn under the same load: blank ones read their spaces too
    // (about one and a half times as long when measured), never a pass over the row for each one.
    const [blankMs, emptyMs] = timedTogether(() => parseSheet(blankText), () => parseSheet(emptyText));
    expect(blankMs! < emptyMs! * 3 + 3, `${blankMs} ms blank, ${emptyMs} ms empty`).toBe(true);
    // Growth, with a quarter of the fields and all of them timed in turn, under the same load.
    const [quarterMs, mostMs] = timedTogether(() => parseSheet(quarterText), () => parseSheet(blankText));
    expect(inStep(quarterMs!, mostMs!), `${quarterMs} ms, then ${mostMs} ms`).toBe(true);
  }, TIMING_LIMIT_MS);

  it("2 MB of line breaks, of short rows, and of format characters", () => {
    for (const text of [`Name\n${"\r".repeat(TWO_MB - 5)}`, `Name\n${"\r\n".repeat(TWO_MB / 2 - 3)}`, `Name\n${"a\n".repeat(TWO_MB / 2 - 3)}`,
      `Name\n${cp(0x200b).repeat(TWO_MB / 2)}`, `Name,Team\n${"a,b\n".repeat(TWO_MB / 4 - 3)}`]) {
      const time = timed(text);
      expectCheap(time, JSON.stringify(text.slice(0, 12)));
      expect(time.result.ok).toBe(true);
    }
  }, TIMING_LIMIT_MS);
});
