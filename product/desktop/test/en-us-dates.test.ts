// Ozzie's interface is English only, so every date and time a person reads is written the American English way, whatever
// this Mac's own language and region are (polish 4): a Mac set to German once showed the heading's "Sunday, November 22"
// beside cards reading "So., 22. Nov.". Each formatter names "en-US"; "en-CA" and "en" are only ever machine keys (a
// YYYY-MM-DD day to compare, the parts of an ISO time), never shown. Display only: nothing here is sent anywhere.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { savedLine } from "../src/today-page.js";
import { sundayLabel } from "../src/planning-center-changes.js";

const ROOTS = ["../src", "../../../core/src", "../../../core/mcp"].map(r => new URL(r, import.meta.url).pathname);
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "node_modules" || name === "dist" ? [] : files(full);
    return /\.(?:ts|tsx)$/u.test(name) && !/\.d\.ts$/u.test(name) ? [full] : [];
  });
}

describe("every date and time a person reads is written in American English", () => {
  it("names en-US in every formatter (en-CA and en only as machine keys), never this Mac's own language", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(files)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // toLocaleString / toLocaleDateString / toLocaleTimeString with no locale, or with undefined or [].
        if (/\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined|\[\]|\{)/u.test(line)) offenders.push(`${file}:${i + 1}`);
        // Intl.DateTimeFormat with no locale, except to ask this Mac its zone.
        if (/Intl\.DateTimeFormat\(\s*(?:undefined|\[\]|\{|\)(?!\.resolvedOptions\(\)\.timeZone))/u.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("reads the same on a Mac set to another language: the saved-copy line and a day's label", () => {
    // Each page's own words, from the same formatters: English and en-US whatever the process's own locale.
    expect(savedLine("2026-11-20T15:00:00Z")).toMatch(/^Saved copy of the check from [A-Z][a-z]{2}, Nov 2[01], \d{1,2}:\d{2}\s[AP]M\.$/u);
    expect(sundayLabel("2026-11-22")).toBe("Sunday, Nov 22");
  });
});
