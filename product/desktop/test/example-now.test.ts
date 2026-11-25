// The example church follows the calendar in the app (example-now.ts, core example-dates.ts; owner decision
// 2026-11-25): opened on a Wednesday, its Sunday is the coming Sunday and its check was that Wednesday morning, on every
// page that shows it. Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { NO_SHIFT } from "../../../core/src/example-dates.js";
import { exampleCapture, exampleLaterCapture } from "../../../core/src/example.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { exampleRequest } from "../src/ai-parts.js";
import { exampleFirstCheck, exampleNow, leaveExampleVisit, openExample } from "../src/example-now.js";
import { genesisExample } from "../src/genesis-church.js";
import { TodayPage } from "../src/today-page.js";
import { text } from "./harness-fakes.js";

const WEDNESDAY = "2026-11-25T18:00:00Z"; // 1:00 PM Eastern, three days after the example's own Sunday
const memory = () => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); } }; };
afterAll(() => { openExample("2026-11-21T12:00:00Z"); });

describe("the example, opened on Wednesday, November 25", () => {
  it("keeps one shift for the whole visit, and works it out again when the example is opened again", () => {
    expect(openExample("2026-11-21T12:00:00Z")).toEqual(NO_SHIFT);
    expect(exampleFirstCheck()).toBe("2026-11-20T15:00:10Z");
    const shift = openExample(WEDNESDAY);
    expect(shift).toEqual({ weeks: 1, back: 2 });
    expect(exampleNow()).toBe(shift);
    // The first check and its later one, as App tells them apart for "See a later fictional check".
    expect(exampleFirstCheck()).toBe("2026-11-25T15:00:10Z");
    expect(exampleCapture(shift).completed_at).toBe(exampleFirstCheck());
    expect(exampleLaterCapture(shift).completed_at).toBe("2026-11-25T17:15:10Z");
  });
  it("the Sunday check is about Sunday, November 29, read on Wednesday morning", () => {
    const capture = exampleCapture(openExample(WEDNESDAY));
    const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true);
    expect(brief.mode).toBe("fictional");
    expect(brief.plan.dates).toBe("November 29, 2026");
    expect(brief.times).toEqual(["2026-11-29T14:30:00Z"]);
    expect(brief.checked_at).toBe("2026-11-25T15:00:00Z");
    expect(brief.findings.map(f => f.kind)).toEqual(buildSundayBrief(exampleCapture(NO_SHIFT), { sundayLeads: [], checkInAfterSundaysInARow: 3 }, "2026-11-20T15:00:10Z", true).findings.map(f => f.kind));
  });
  it("the sample of what the AI is sent names that Sunday", () => {
    openExample(WEDNESDAY);
    expect(exampleRequest()!.user).toContain("on Sunday, November 29 at 9:30 AM. Would you be able to help?");
  });
  it("Today's email import is the day before the check, and its orientation is still tonight", () => {
    openExample(WEDNESDAY);
    const today = text(renderToStaticMarkup(React.createElement(TodayPage, { brief: null, onSunday: () => undefined, store: memory(), example: true })));
    expect(today).toContain("2 things need your attention.");
    expect(today).toContain("Tonight's orientation needs a location decision.");
    expect(today).not.toMatch(/November 2[0-2]\b/u);
  });
  it("a Genesis example church moves with it, on its own clock", () => {
    openExample(WEDNESDAY);
    const { capture } = genesisExample();
    expect(capture.completed_at).toBe("2026-11-25T15:00:04Z");
    // Its Sunday services stay on Sundays at 9:00 AM Mountain; the midweek prayer that had already happened stays before the check.
    expect(capture.events.map(e => e.starts_at)).toEqual(["2026-11-19T18:30:00-07:00", "2026-11-29T09:00:00-07:00", "2026-12-03T18:30:00-07:00", "2026-12-06T09:00:00-07:00"]);
  });
  it("outside a visit the shift is this moment's, so an app left running never shows an old week (review M1, L2)", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-28T17:00:00Z"));
      leaveExampleVisit();
      expect(exampleNow()).toEqual({ weeks: 1, back: 0 });
      expect(exampleNow()).toBe(exampleNow());
      // Three days later, with nothing opened in between: the next week, checked that day.
      vi.setSystemTime(new Date("2026-12-01T18:00:00Z"));
      expect(exampleNow()).toEqual({ weeks: 2, back: 3 });
      expect(exampleRequest()!.user).toContain("on Sunday, December 6 at 9:30 AM.");
      expect(genesisExample().capture.completed_at).toBe("2026-12-01T15:00:04Z");
      // A visit keeps its week until it is left, whatever the clock does.
      const visit = openExample();
      vi.setSystemTime(new Date("2026-12-09T18:00:00Z"));
      expect(exampleNow()).toBe(visit);
      leaveExampleVisit();
      expect(exampleNow()).toEqual({ weeks: 3, back: 2 });
    } finally { vi.useRealTimers(); }
  });
});
