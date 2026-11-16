// Church-added text as Ozzie shows it: a list's headers and cells, a note's lines. Format characters come out, so a
// cell can't read as something else (a direction override, a zero-width space, a tag character); controls and line
// breaks become spaces. This is its own copy of the native calendar rules (src-tauri/src/calendars.rs `plain`,
// `hidden`, `joinable`), held to the same test vectors (core/test/sources/text.test.ts). It does not use the calendar
// code, which only Today and Settings may use, as core/test/calendar/stays-on-this-mac.test.ts holds.
//
// Pure: no I/O. Runs in the page.

/**
 * Format characters that make text read as something else: the soft hyphen, the Arabic letter mark, the Mongolian
 * vowel separator, zero-width characters and marks, direction overrides and isolates, invisible operators, the
 * byte-order mark, interlinear annotation and tag characters (calendars.rs `hidden`).
 */
export function hidden(c: number): boolean {
  return c === 0xad || c === 0x61c || c === 0x180e || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)
    || (c >= 0x2060 && c <= 0x2064) || (c >= 0x2066 && c <= 0x206f) || c === 0xfeff || (c >= 0xfff9 && c <= 0xfffb)
    || c === 0xe0001 || (c >= 0xe0020 && c <= 0xe007f);
}
const ALPHABETIC = /^\p{Alphabetic}$/u;
/**
 * What a zero-width joiner or non-joiner may join: letters, the marks and signs of Indic scripts, variation selectors
 * and emoji (calendars.rs `joinable`; Rust's `is_alphabetic` is Unicode's Alphabetic property).
 */
export function joinable(c: number): boolean {
  return (c >= 0x300 && c <= 0x36f) || (c >= 0x900 && c <= 0xdff) || (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0x2300 && c <= 0x27bf)
    || (c >= 0x2b00 && c <= 0x2bff) || (c >= 0x1f000 && c <= 0x1faff) || ALPHABETIC.test(String.fromCodePoint(c));
}
/** Rust's `char::is_control`: the C0 and C1 controls and delete. */
const control = (c: number) => c <= 0x1f || (c >= 0x7f && c <= 0x9f);
const SPACE = 0x20, LINE_SEPARATOR = 0x2028, PARAGRAPH_SEPARATOR = 0x2029, REPLACEMENT = 0xfffd;
/** Unicode's White_Space property, which Rust's `split_whitespace` splits on. */
const WHITE_SPACE = /\p{White_Space}+/u;
export const CUT_MARK = "…";

/** The first `limit` code points of `raw`, and whether it had more. Stops reading there, however long `raw` is. */
function codePoints(raw: string, limit: number): { points: number[]; over: boolean } {
  const points: number[] = [];
  for (const ch of raw) {
    if (points.length === limit) return { points, over: true };
    points.push(ch.codePointAt(0)!);
  }
  return { points, over: false };
}
/**
 * Format characters out, except a joiner between two things it may join (judged on its neighbours as written, as
 * calendars.rs does); controls and the two Unicode line breaks as spaces. A lone surrogate half, which Rust text can't
 * hold, becomes the replacement character.
 */
function strip(points: readonly number[]): string {
  const out: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const c = points[i]!;
    if (hidden(c)) {
      if ((c === 0x200c || c === 0x200d) && i > 0 && i + 1 < points.length && joinable(points[i - 1]!) && joinable(points[i + 1]!)) out.push(c);
      continue;
    }
    out.push(control(c) || c === LINE_SEPARATOR || c === PARAGRAPH_SEPARATOR ? SPACE : c >= 0xd800 && c <= 0xdfff ? REPLACEMENT : c);
  }
  let text = "";
  for (let i = 0; i < out.length; i += 4096) text += String.fromCodePoint(...out.slice(i, i + 4096));
  return text;
}
/** The first `max` code points of `text`. */
function take(text: string, max: number): string {
  let out = "", n = 0;
  for (const ch of text) {
    if (n++ === max) break;
    out += ch;
  }
  return out;
}
const count = (text: string) => [...text].length;
/**
 * The part of a cut line before its mark: spaces off the end, and a joiner left there by the cut too, since with the
 * mark after it there is nothing for it to join (calendars.rs `plain` drops it; review V).
 */
const beforeMark = (kept: string) => kept.trimEnd().replace(/[\u200c\u200d]+$/u, "").trimEnd();

/**
 * Outside text as one plain line, at most `max` characters, exactly as calendars.rs `plain` makes it: only the first
 * `max * 8` characters are read; format characters out (joiners kept where they join); controls and line breaks as
 * spaces; runs of spaces as one, none at either end; then cut at `max` with no mark.
 */
export function plainLine(raw: string, max: number): string {
  return take(strip(codePoints(raw, max * 8).points).split(WHITE_SPACE).filter(w => w !== "").join(" "), max);
}

/**
 * `plainLine`, saying whether anything was left out: when the text was longer than `max` (or than the `max * 8`
 * characters read), it is cut to `max` characters with the last one `…`, and `cut` is true.
 */
export function plainLineCut(raw: string, max: number): { text: string; cut: boolean } {
  const { points, over } = codePoints(raw, max * 8);
  const line = strip(points).split(WHITE_SPACE).filter(w => w !== "").join(" ");
  if (!over && count(line) <= max) return { text: line, cut: false };
  return { text: `${beforeMark(take(line, max - 1))}${CUT_MARK}`, cut: true };
}

/**
 * One line of a note: the same characters out and controls (a tab too) as spaces, but its own spacing kept apart from
 * the end, which is trimmed. Cut at `max` characters with `…` when longer.
 */
export function noteLine(raw: string, max: number): { text: string; cut: boolean } {
  const { points, over } = codePoints(raw, max * 8);
  const line = strip(points).trimEnd();
  if (!over && count(line) <= max) return { text: line, cut: false };
  return { text: `${beforeMark(take(line, max - 1))}${CUT_MARK}`, cut: true };
}

// ---- Bytes to text ----------------------------------------------------------------------------------------

export type Encoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1252";
/** Why bytes weren't read as text: over the size limit, a ZIP or older Office file (an Excel workbook), or binary. */
export type DecodeProblem = "too-large" | "workbook" | "not-text";
export type Decoded =
  | { ok: true; text: string; encoding: Encoding; guessed: boolean }
  | { ok: false; problem: DecodeProblem };

/** windows-1252's bytes 0x80 to 0x9F (the rest are Latin-1). Five unassigned bytes stay as their C1 controls, as WHATWG has them. */
const CP1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];
function windows1252(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    const units = Array.from(bytes.subarray(i, i + 8192), b => b >= 0x80 && b <= 0x9f ? CP1252[b - 0x80]! : b);
    text += String.fromCharCode(...units);
  }
  return text;
}
const starts = (bytes: Uint8Array, ...head: number[]) => bytes.length >= head.length && head.every((b, i) => bytes[i] === b);

/**
 * A file's bytes as text. A byte-order mark says UTF-8 or UTF-16 (little or big end); without one the bytes must be
 * strict UTF-8, or else they are read as windows-1252 (what Excel on Windows saves as "CSV") and `guessed` is true.
 * Refused: more than `maxBytes`; a ZIP (an .xlsx or .numbers file) or an older Office file (.xls); any NUL byte
 * without a UTF-16 byte-order mark. Text that doesn't decode cleanly under its mark is read with replacement
 * characters and `guessed`. The mark itself is not part of the text.
 */
export function decodeText(bytes: Uint8Array, maxBytes: number): Decoded {
  if (bytes.length > maxBytes) return { ok: false, problem: "too-large" };
  if (starts(bytes, 0x50, 0x4b, 0x03, 0x04) || starts(bytes, 0x50, 0x4b, 0x05, 0x06) || starts(bytes, 0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    return { ok: false, problem: "workbook" };
  }
  /** The text in `encoding` from byte `from`, or null when it isn't valid there. */
  const strict = (encoding: Exclude<Encoding, "windows-1252">, from: number) => {
    try { return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(from)); } catch { return null; }
  };
  const marked = (encoding: Exclude<Encoding, "windows-1252">, from: number): Decoded => {
    const text = strict(encoding, from);
    return text !== null ? { ok: true, text, encoding, guessed: false }
      : { ok: true, text: new TextDecoder(encoding, { ignoreBOM: true }).decode(bytes.subarray(from)), encoding, guessed: true };
  };
  if (starts(bytes, 0xff, 0xfe)) return marked("utf-16le", 2);
  if (starts(bytes, 0xfe, 0xff)) return marked("utf-16be", 2);
  if (bytes.includes(0)) return { ok: false, problem: "not-text" };
  if (starts(bytes, 0xef, 0xbb, 0xbf)) return marked("utf-8", 3);
  const utf8 = strict("utf-8", 0);
  return utf8 !== null ? { ok: true, text: utf8, encoding: "utf-8", guessed: false } : { ok: true, text: windows1252(bytes), encoding: "windows-1252", guessed: true };
}
