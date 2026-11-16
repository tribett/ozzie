// Church-added text is made plain by the same rules as calendar text on the native side (src-tauri/src/calendars.rs
// `plain`, `hidden`, `joinable`): these are that file's own test vectors, built at run time so no invisible
// character sits in this source. Then how bytes become text: a byte-order mark, strict UTF-8, or windows-1252 marked
// as a guess; a workbook, binary and an oversized file refused.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeText, hidden, joinable, noteLine, plainLine, plainLineCut } from "../../src/sources/text.js";

const cp = (...points: number[]) => String.fromCodePoint(...points);
/** calendars.rs MAX_TEXT, which its vectors use. */
const MAX_TEXT = 300;
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/sources/${name}`, import.meta.url)));
const hexFixture = (name: string) => Uint8Array.from(readFileSync(new URL(`../fixtures/sources/${name}`, import.meta.url), "utf8").trim().split(/\s+/u).map(h => parseInt(h, 16)));

describe("plainLine: calendars.rs `plain`, vector for vector", () => {
  it("takes direction overrides, zero-width characters and controls out, and line breaks become spaces (calendar_text_is_made_plain_here_too)", () => {
    expect(plainLine(`Board${cp(0x202e)}gnitee${cp(0x202c)} \n meeting${cp(0x200b)}${cp(0x7)}`, MAX_TEXT)).toBe("Boardgnitee meeting");
    expect(plainLine(`A${cp(0xe0041, 0xe0042)}B${cp(0x180e)}C${cp(0xad)}D${cp(0x2066)}E${cp(0x2069)}${cp(0xfeff)}`, MAX_TEXT)).toBe("ABCDE");
    expect([...plainLine("x".repeat(MAX_TEXT * 3), MAX_TEXT)]).toHaveLength(MAX_TEXT);
    // The calendar list's title and account in the same test.
    expect(plainLine(`Church${cp(0x202e)} staff`, MAX_TEXT)).toBe("Church staff");
    expect(plainLine(`${cp(0x2066)}pastor@fictional.example${cp(0x2069)}`, MAX_TEXT)).toBe("pastor@fictional.example");
    // the_calendar_list_is_only_kept_with_full_access_and_bounded: a title of MAX_TEXT + 50 is cut to MAX_TEXT.
    expect([...plainLine("x".repeat(MAX_TEXT + 50), MAX_TEXT)]).toHaveLength(MAX_TEXT);
  });

  it("keeps the joiners inside an emoji family, an emoji with its variation, a Persian word and a Hindi conjunct, and nowhere else (joiners_stay_where_they_join)", () => {
    const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    const heart = cp(0x2764, 0xfe0f, 0x200d, 0x1f525);
    const persian = cp(0x645, 0x6cc, 0x200c, 0x62e, 0x648, 0x627, 0x647, 0x645);
    const hindi = cp(0x915, 0x94d, 0x200d, 0x937);
    const text = `${family} picnic ${heart} ${persian} ${hindi}${cp(0x200d)} ${cp(0x200c)}x${cp(0x202e)}`;
    expect(plainLine(text, MAX_TEXT)).toBe(`${family} picnic ${heart} ${persian} ${hindi} x`);
  });

  it("matches the Rust sets exactly: every hidden character, and only those", () => {
    const listed = [0xad, 0x61c, 0x180e, 0xfeff, 0xe0001];
    const ranges: [number, number][] = [[0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], [0xfff9, 0xfffb], [0xe0020, 0xe007f]];
    for (const c of listed) expect(hidden(c), c.toString(16)).toBe(true);
    for (const [from, to] of ranges) for (let c = from; c <= to; c++) expect(hidden(c), c.toString(16)).toBe(true);
    for (const c of [0x20, 0x41, 0xac, 0xae, 0x200a, 0x2010, 0x2029, 0x2065, 0x2070, 0xfffc, 0xe0000, 0xe0002, 0xe001f, 0xe0080]) expect(hidden(c), c.toString(16)).toBe(false);
    // Joinable: letters (Unicode Alphabetic, as Rust's is_alphabetic), the listed mark and emoji ranges.
    for (const c of [0x41, 0x645, 0x915, 0x300, 0x94d, 0xfe0f, 0x2764, 0x1f525]) expect(joinable(c), c.toString(16)).toBe(true);
    for (const c of [0x20, 0x31, 0x2d, 0x200d, 0x202e]) expect(joinable(c), c.toString(16)).toBe(false);
  });

  it("turns every control (C0, delete, C1) and the two Unicode line breaks into a space, and collapses every Unicode space", () => {
    expect(plainLine(`a${cp(0x0)}b${cp(0x9)}c${cp(0x7f)}d${cp(0x85)}e${cp(0x9f)}f${cp(0x2028)}g${cp(0x2029)}h`, 50)).toBe("a b c d e f g h");
    expect(plainLine(`  a${cp(0xa0)}${cp(0x3000)}b${cp(0x2003)} `, 50)).toBe("a b");
    // A lone surrogate half (not possible in Rust text) is never passed on as it is.
    expect(plainLine(`a${String.fromCharCode(0xd800)}b`, 50)).toBe(`a${cp(0xfffd)}b`);
  });

  it("reads only the first max * 8 characters, as Rust's take(MAX_TEXT * 8) does", () => {
    expect(plainLine(`${" ".repeat(80)}late`, 10)).toBe("");
    expect(plainLine(`${" ".repeat(79)}late`, 10)).toBe("l");
  });
});

describe("plainLineCut and noteLine say when something was left out", () => {
  it("cuts at max with … as the last character, and only then", () => {
    expect(plainLineCut("x".repeat(600), 500)).toEqual({ text: `${"x".repeat(499)}…`, cut: true });
    expect(plainLineCut("x".repeat(500), 500)).toEqual({ text: "x".repeat(500), cut: false });
    expect(plainLineCut("a b  c", 500)).toEqual({ text: "a b c", cut: false });
    // A cut never ends in a space before the mark.
    expect(plainLineCut("abcd efgh", 6)).toEqual({ text: "abcd…", cut: true });
    // Text past what is read counts as left out, even when what was read is short.
    expect(plainLineCut(`${" ".repeat(80)}late`, 10)).toEqual({ text: "…", cut: true });
    // A cut line is already plain: making it plain again changes nothing.
    const cut = plainLineCut(`${"word ".repeat(200)}`, 120).text;
    expect(plainLine(cut, 120)).toBe(cut);
  });

  it("keeps a note line's own spacing but takes format characters out and trims the end", () => {
    expect(noteLine(`  - Two${cp(0x200b)} adults,${cp(0x9)}always${cp(0x202e)}   `, 2000)).toEqual({ text: "  - Two adults, always", cut: false });
    expect(noteLine("y".repeat(2001), 2000)).toEqual({ text: `${"y".repeat(1999)}…`, cut: true });
  });
});

describe("a cut never leaves a joiner before its mark (review V: native code would drop it)", () => {
  it("drops a joiner the cut leaves at the end, as calendars.rs `plain` does with nothing after it to join", () => {
    const zwj = String.fromCodePoint(0x200d), zwnj = String.fromCodePoint(0x200c);
    // A joiner between two letters, kept, until the cut falls right after it.
    expect(plainLineCut(`${"a".repeat(118)}${zwj}${"b".repeat(10)}`, 120)).toEqual({ text: `${"a".repeat(118)}…`, cut: true });
    expect(noteLine(`${"a".repeat(1998)}${zwnj}${"b".repeat(10)}`, 2000)).toEqual({ text: `${"a".repeat(1998)}…`, cut: true });
    // A joiner away from the cut stays where it joins.
    expect(plainLineCut(`ab${zwj}cd${"e".repeat(200)}`, 120).text.startsWith(`ab${zwj}cd`)).toBe(true);
    // What a cut gives is what the plain-line rule keeps as it is.
    for (const raw of [`${"a".repeat(118)}${zwj}${"b".repeat(10)}`, `${"\u0915".repeat(118)}${zwnj}${"\u0937".repeat(5)}`]) {
      const { text } = plainLineCut(raw, 120);
      expect(plainLine(text, 120)).toBe(text);
    }
  });
});

describe("decodeText: bytes to text", () => {
  const MAX = 2 * 1024 * 1024;
  it("reads UTF-8 with and without a byte-order mark the same, and drops the mark", () => {
    const plain = decodeText(fixture("utf8.csv"), MAX), marked = decodeText(fixture("utf8-bom.csv"), MAX);
    expect(fixture("utf8-bom.csv").subarray(0, 3)).toEqual(Uint8Array.from([0xef, 0xbb, 0xbf]));
    expect(plain).toMatchObject({ ok: true, encoding: "utf-8", guessed: false });
    expect(marked).toEqual(plain);
    expect(plain.ok && plain.text.startsWith("Name,Team")).toBe(true);
  });

  it("reads UTF-16 with a byte-order mark, little or big end, NUL bytes and all", () => {
    const bytes = hexFixture("utf16le-bom.hex");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    const read = decodeText(bytes, MAX);
    expect(read).toMatchObject({ ok: true, encoding: "utf-16le", guessed: false });
    expect(read.ok && read.text).toBe(`Name,Team\r\nZo${cp(0xeb)} Fictional,Greeters ${cp(0x1f44b)}\r\nDana Fictional,Ushers\r\n`);
    const be = Uint8Array.from([0xfe, 0xff, 0x00, 0x41, 0x00, 0x2c, 0x00, 0x42]);
    expect(decodeText(be, MAX)).toEqual({ ok: true, text: "A,B", encoding: "utf-16be", guessed: false });
    // An odd byte count under a UTF-16 mark is read with a replacement character, marked as a guess.
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42]), MAX)).toMatchObject({ ok: true, encoding: "utf-16le", guessed: true });
  });

  it("reads bytes that aren't UTF-8 as windows-1252 and says it guessed", () => {
    const read = decodeText(fixture("windows-1252.csv"), MAX);
    expect(read).toMatchObject({ ok: true, encoding: "windows-1252", guessed: true });
    expect(read.ok && read.text).toBe(`Name,Team,Notes\r\nRen${cp(0xe9)} Fictional,Caf${cp(0xe9)} crew,Coffee ${cp(0x20ac)}2\r\nZo${cp(0xeb)} Sample,Ushers,Lee${cp(0x2019)}s spare key\r\n`);
    // Byte for byte the WHATWG windows-1252 the browser has.
    const all = Uint8Array.from({ length: 255 }, (_, i) => i + 1);
    const ours = decodeText(Uint8Array.from([0xff, ...all.filter(b => b !== 0xff)]), MAX);
    expect(ours.ok && ours.encoding).toBe("windows-1252");
    expect(ours.ok && ours.text).toBe(new TextDecoder("windows-1252").decode(Uint8Array.from([0xff, ...all.filter(b => b !== 0xff)])));
  });

  it("refuses a workbook (a ZIP or an older Office file), NUL bytes without a UTF-16 mark, and too many bytes", () => {
    expect(decodeText(hexFixture("workbook-start.hex"), MAX)).toEqual({ ok: false, problem: "workbook" });
    expect(decodeText(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]), MAX)).toEqual({ ok: false, problem: "workbook" });
    expect(decodeText(Uint8Array.from([0x41, 0x00, 0x42]), MAX)).toEqual({ ok: false, problem: "not-text" });
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41, 0x00]), MAX)).toEqual({ ok: false, problem: "not-text" });
    expect(decodeText(new Uint8Array(MAX + 1).fill(0x41), MAX)).toEqual({ ok: false, problem: "too-large" });
    expect(decodeText(new Uint8Array(MAX).fill(0x41), MAX)).toMatchObject({ ok: true, encoding: "utf-8" });
  });

  it("reads no bytes, or only a mark, as empty text", () => {
    expect(decodeText(fixture("empty.csv"), MAX)).toEqual({ ok: true, text: "", encoding: "utf-8", guessed: false });
    expect(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf]), MAX)).toEqual({ ok: true, text: "", encoding: "utf-8", guessed: false });
  });
});
