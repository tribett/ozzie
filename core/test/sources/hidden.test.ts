// The hidden characters, shared with native code: core/native-auth/src/sheet_link.rs skips them (with white space)
// before deciding whether a sheet link's body starts like a web page, and keeps its own copy of the rule, because that
// crate cannot use the desktop app's (src-tauri/src/calendars.rs `hidden`, which text.ts copies). This file writes
// text.ts's rule out as ranges of code points, kept in core/test/fixtures/sources/hidden.json, which
// sheet_link_tests.rs reads and checks every character against: a change to either copy shows up on one side.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hidden } from "../../src/sources/text.js";

/** Every code point `hidden` holds, as [first, last] ranges in order. */
function hiddenRanges(): [number, number][] {
  const ranges: [number, number][] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (!hidden(c)) continue;
    const last = ranges.at(-1);
    if (last && last[1] === c - 1) last[1] = c;
    else ranges.push([c, c]);
  }
  return ranges;
}

describe("hidden characters, shared with native code", () => {
  it("are the ones kept in core/test/fixtures/sources/hidden.json", () => {
    const kept = JSON.parse(readFileSync(new URL("../fixtures/sources/hidden.json", import.meta.url), "utf8")) as [number, number][];
    const made = hiddenRanges();
    // The five the sheet link once skipped alone, and the rest of the set beside them.
    for (const c of [0xfeff, 0x200b, 0x200c, 0x200d, 0x2060, 0xad, 0x180e, 0x200e, 0x200f, 0x2061, 0xe0041]) {
      expect(made.some(([from, to]) => c >= from && c <= to), c.toString(16)).toBe(true);
    }
    expect(kept).toEqual(made);
  });
});
