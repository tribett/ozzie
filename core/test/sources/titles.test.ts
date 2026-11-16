// The titles a section of notes gets, held to native code's rule for the same text (review V's open question): the
// page makes a title (notes.ts, text.ts), native code checks a pointer's title with its own copy of the rule
// (src-tauri/src/church_sources.rs `plain`), and the two read the joiner rule from each runtime's own Unicode data. This
// file makes titles from a fixed, seeded mix of text that leans on what could differ (joiners between letters of many
// scripts, recent Unicode letters, marks, emoji, hidden characters, cuts at the 120-character limit) and keeps them in
// core/test/fixtures/sources/titles.json, which church_sources_tests.rs reads: every title the page can make must be
// one native code keeps as it is, and a change to either side's rule shows up as a change to that file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_TITLE, parseNotes } from "../../src/sources/notes.js";

const POOL = [
  ..."abcXYZ019 .-'", "\t", " ", "　", " ",
  "‍", "‍", "‍", "‌", "‌", "​", "‮", "⁦", "﻿", "᠎", "­",
  "́", "क", "्", "ष", "م", "ی", "א", "中", "가", "ก",
  "\u{1f468}", "\u{1f469}", "\u{1f467}", "❤", "️", "\u{1f525}", "\u{1f3fd}",
  // Letters added in Unicode 15 and 16, which one runtime may know and the other not.
  "\u{11f04}", "\u{1e4d0}", "\u{10d50}", "\u{16d43}", "\u{11bc0}", "\u{105c0}", "\u{11380}", "\u{1e5d0}", "\u{11f50}",
  // Not yet assigned: alphabetic to neither.
  "\u{10ec5}", "\u{16ea1}",
];
/** A seeded generator, so the titles are the same on every run. */
function generator(seed: number) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}
/** The titles notes make from the generated text: of a `#` heading, and of a block without one. */
export function generatedTitles(count = 800): string[] {
  const next = generator(20261116);
  const titles: string[] = [];
  for (let n = 0; n < count; n++) {
    const length = n % 5 === 0 ? 110 + Math.floor(next() * 40) : 1 + Math.floor(next() * 40);
    let raw = "";
    for (let i = 0; i < length; i++) raw += POOL[Math.floor(next() * POOL.length)];
    for (const text of [`# ${raw}`, raw]) {
      const parsed = parseNotes(text);
      const title = parsed.ok ? parsed.notes.sections[0]!.title : "";
      if (title) titles.push(title);
    }
  }
  return titles;
}

describe("titles of notes, shared with native code", () => {
  it("are the ones kept in core/test/fixtures/sources/titles.json, at most MAX_TITLE characters each", () => {
    const kept = JSON.parse(readFileSync(new URL("../fixtures/sources/titles.json", import.meta.url), "utf8")) as string[];
    const made = generatedTitles();
    expect(made.length).toBeGreaterThan(1200);
    for (const t of made) expect([...t].length).toBeLessThanOrEqual(MAX_TITLE);
    // Joiners kept between letters, cuts at the limit, recent letters: the file has what it is meant to test.
    expect(made.some(t => t.includes("‍"))).toBe(true);
    expect(made.some(t => t.endsWith("…"))).toBe(true);
    expect(kept).toEqual(made);
  });
});
