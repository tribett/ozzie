// The example church moved in time (example-dates.ts, example.ts; owner decision 2026-11-25): whenever it is opened,
// its Sunday is the coming Sunday, nothing in it is later than now, every time of day is what it was written as, and
// what Ozzie finds in it is exactly what it finds in the fixed November 22 data. Checked for every day of two years,
// across both daylight-saving changes, at several times of day. Fictional data only.
import { describe, expect, it } from "vitest";
import { evaluateAttentionImport } from "../src/attention-import/index.js";
import { buildSystemBrief } from "../src/church-systems/brief.js";
import { fictionalB1, fictionalBreeze, fictionalGenesis } from "../src/church-systems/fictional.js";
import type { SystemCapture } from "../src/church-systems/types.js";
import { localDate } from "../src/church-time.js";
import { EXAMPLE_CHECK, EXAMPLE_SUNDAY, EXAMPLE_ZONE, exampleShift, NO_SHIFT, shiftExample, shiftNamedDays, type ExampleShift } from "../src/example-dates.js";
import { exampleAttention, exampleCapture, exampleLaterCapture, exampleSundayOnly, exampleSystem } from "../src/example.js";
import { harborAttentionImport } from "../src/fictional-attention.js";
import { withFictionalOperations } from "../src/fictional-operations.js";
import { nov22Capture, nov22LaterCapture } from "../src/fictional-sunday.js";
import { sundayOperations } from "../src/operations-capture.js";
import { buildSundayBrief } from "../src/sunday-brief.js";
import type { SundayCapture } from "../src/sunday-capture.js";

const DAY = 86_400_000;
const RULES = { sundayLeads: [], checkInAfterSundaysInARow: 3, kidsTeams: [{ team_id: "7593352", min_confirmed: 2 }] };
const clock = (at: string | number, zone: string) => new Date(at).toLocaleString("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
/** Every string in a value. */
const strings = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings)
  : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATED = /\d{8}T\d{6}Z|\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?|(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(?:, \d{4})?|(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day|(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b\.?,? ?\d{0,2}|\d{1,2}:\d{2}(?: ?[AP]M)?|\b\d+ (?:day|week|hour)s?\b/gu;
/** What a check found, with every date and time taken out: the same for the example whenever it is opened. */
const found = (v: unknown) => JSON.stringify(v, (_, x: unknown) => typeof x === "string" ? x.replace(DATED, "<when>") : x);
const pcBrief = (capture: SundayCapture) => buildSundayBrief(capture, RULES, capture.completed_at, true);
const pcFound = (capture: SundayCapture) => {
  const b = pcBrief(capture);
  return found({ status: b.status, findings: b.findings.map(f => ({ ...f, position: f.position && { ...f.position, interval: null }, serving: f.serving?.map(s => ({ ...s, interval: null })) })),
    positions: b.positions, operations: sundayOperations(capture, RULES, { now: capture.completed_at }) });
};
const systemFound = (capture: SystemCapture) => {
  const b = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, capture.completed_at, { fictional: true });
  if (!b.ok) throw new Error(b.reason);
  return found({ status: b.brief.status, findings: b.brief.findings.map(f => ({ ...f, position: f.position && { ...f.position, interval: null }, serving: f.serving?.map(s => ({ ...s, interval: null })) })),
    positions: b.brief.positions, roster: b.brief.roster, notices: b.notices });
};
/** Moments to open the example at: each day from two months before the example's own week (a Mac whose clock is behind) to two years after, at four times of day. */
const MOMENTS = Array.from({ length: 2 * 366 + 60 }, (_, d) => [5 * 60 + 10, 13 * 60 + 5, 17 * 60 + 16, 28 * 60 + 55].map(minutes => Date.parse("2026-09-17T00:00:00Z") + d * DAY + minutes * 60_000)).flat();

describe("how far the example is moved", () => {
  it("as written on its own Friday afternoon, Saturday and Sunday", () => {
    for (const now of ["2026-11-20T17:15:10Z", "2026-11-21T12:00:00Z", "2026-11-22T14:30:00Z", "2026-11-23T04:59:59Z"])
      expect(exampleShift(now), now).toEqual(NO_SHIFT);
  });
  it("the day after its Sunday it is next week's, checked no later than now", () => {
    // Monday 12:05 AM Eastern: next Sunday, and the check back at the Sunday just past (five days before its Friday).
    expect(exampleShift("2026-11-23T05:05:00Z")).toEqual({ weeks: 1, back: 5 });
    // Wednesday, November 25 at 1:00 PM Eastern: Sunday the 29th, checked this Wednesday morning.
    expect(exampleShift("2026-11-25T18:00:00Z")).toEqual({ weeks: 1, back: 2 });
    // The same Wednesday at 9:00 AM, before the later check's time of day: checked on Tuesday.
    expect(exampleShift("2026-11-25T14:00:00Z")).toEqual({ weeks: 1, back: 3 });
    expect(exampleShift("2026-11-27T18:00:00Z")).toEqual({ weeks: 1, back: 0 });
  });
  it("is the example as written for a time that isn't one", () => {
    expect(exampleShift("not a time")).toEqual(NO_SHIFT);
    expect(exampleShift(Number.NaN)).toEqual(NO_SHIFT);
  });
  it("never steps the check back more than five days, and never moves a part of a week", () => {
    for (const now of MOMENTS) {
      const s = exampleShift(now);
      expect(Number.isInteger(s.weeks) && s.back >= 0 && s.back <= 5, new Date(now).toISOString()).toBe(true);
    }
  });
});

describe("with no shift, the example is the fixed data exactly", () => {
  it("each part equals its fixture", () => {
    expect(exampleCapture(NO_SHIFT)).toEqual(withFictionalOperations(nov22Capture()));
    expect(exampleLaterCapture(NO_SHIFT)).toEqual(withFictionalOperations(nov22LaterCapture()));
    expect(exampleSundayOnly(NO_SHIFT)).toEqual(nov22Capture());
    expect(exampleAttention(NO_SHIFT)).toEqual(harborAttentionImport());
    expect(exampleSystem("b1", NO_SHIFT)).toEqual(fictionalB1());
    expect(exampleSystem("breeze", NO_SHIFT)).toEqual(fictionalBreeze());
    expect(exampleSystem("genesis", NO_SHIFT)).toEqual(fictionalGenesis());
    // A new value every time: the fixtures are never handed out to be changed.
    expect(exampleCapture(NO_SHIFT)).not.toBe(exampleCapture(NO_SHIFT));
  });
});

describe("moved, only the dates and times change", () => {
  const moved = { weeks: 3, back: 2 };
  it("ids, names, counts and words are copied; every date-like string is still one", () => {
    const blank = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x: unknown) =>
      typeof x === "string" && (INSTANT.test(x) || /^\d{4}-\d{2}-\d{2}$/u.test(x) || /^[A-Z][a-z]+ \d{1,2}, \d{4}$/u.test(x)) ? "<when>" : x)) as unknown;
    expect(blank(exampleCapture(moved))).toEqual(blank(withFictionalOperations(nov22Capture())));
    expect(blank(exampleSystem("b1", moved))).toEqual(blank(fictionalB1()));
    expect(blank(exampleSystem("breeze", moved))).toEqual(blank(fictionalBreeze()));
    expect(blank(exampleSystem("genesis", moved))).toEqual(blank(fictionalGenesis()));
    // The import's one dated sentence is rebuilt with its day moved; nothing else in it changes.
    const day = (v: unknown) => JSON.parse(JSON.stringify(blank(v)).replace(/Friday, (?:November|December) \d+/gu, "<day>")) as unknown;
    expect(day(exampleAttention(moved))).toEqual(day(harborAttentionImport()));
    expect(JSON.stringify(exampleAttention(moved))).toContain("is due Friday, December 18.");
    // A name is never taken for a date, and the fixtures are untouched.
    expect(exampleCapture(moved).names).toEqual(nov22Capture().names);
    expect(JSON.stringify(nov22Capture())).toContain("2026-11-22T14:30:00Z");
  });
  it("keeps each timestamp's own form: Z or the church's offset, with or without seconds", () => {
    const zone = "America/Chicago";
    // Into summer: 9:00 AM Central is -05:00 there, and 15:00Z in winter is 14:00Z in summer for the same wall clock.
    const summer = { weeks: 30, back: 0 };
    expect(shiftExample({ a: "2026-11-22T09:00:00-06:00", b: "2026-11-22T15:00:00Z", c: "2026-11-22T15:00Z", d: "2026-11-22T15:00:00.000Z", e: "2026-11-22",
      sort_date: "2026-11-22T09:30:00Z", dates: "November 22, 2026", title: "Ozzie Demo — Main Sunday (fictional)" }, summer, zone))
      .toEqual({ a: "2027-06-20T09:00:00-05:00", b: "2027-06-20T14:00:00Z", c: "2027-06-20T14:00Z", d: "2027-06-20T14:00:00.000Z", e: "2027-06-20",
        sort_date: "2027-06-20T09:30:00Z", dates: "June 20, 2027", title: "Ozzie Demo — Main Sunday (fictional)" });
    expect(shiftNamedDays("is due Friday, November 27.", { weeks: 6, back: 4 })).toBe("is due Friday, January 8.");
    expect(shiftNamedDays("Someday, November 27", moved)).toBe("Someday, November 27");
  });
  it("what belongs to the check steps back with it; what belongs to the Sunday does not", () => {
    const c = exampleCapture({ weeks: 1, back: 2 });
    expect(c.completed_at).toBe("2026-11-25T15:00:10Z");
    expect(new Set(c.reads.map(r => r.checked_at))).toEqual(new Set(["2026-11-25T15:00:00Z"]));
    expect(JSON.stringify(c)).toContain("\"sort_date\":\"2026-11-29T09:30:00Z\"");
    expect(JSON.stringify(c)).toContain("\"dates\":\"November 29, 2026\"");
    // The email import was the day before the check, and its "tonight" is that evening.
    const a = exampleAttention({ weeks: 1, back: 2 });
    expect(a.imported_at).toBe("2026-11-24T14:00:00Z");
    expect(a.events.map(e => e.start_at)).toEqual(["2026-11-25T00:00:00Z", "2026-11-27T19:00:00Z"]);
    // Only these fixed timestamps count as the check's: a new fixture date near the check has to be looked at here.
    const near = (v: unknown) => [...new Set(strings(v).filter(s => INSTANT.test(s)).filter(s => Math.abs(Date.parse(s) - Date.parse(EXAMPLE_CHECK)) <= 4 * DAY))].sort();
    expect(near([withFictionalOperations(nov22LaterCapture()), withFictionalOperations(nov22Capture()), harborAttentionImport(), fictionalB1(), fictionalBreeze(), fictionalGenesis()])).toMatchInlineSnapshot(`
      [
        "2026-11-18T20:00:00Z",
        "2026-11-18T21:00:00Z",
        "2026-11-19T13:15:00Z",
        "2026-11-19T13:20:00Z",
        "2026-11-19T13:25:00Z",
        "2026-11-19T13:30:00Z",
        "2026-11-19T14:00:00Z",
        "2026-11-19T18:30:00-07:00",
        "2026-11-19T20:00:00-07:00",
        "2026-11-20T00:00:00Z",
        "2026-11-20T01:00:00Z",
        "2026-11-20T14:00:00Z",
        "2026-11-20T14:59:50Z",
        "2026-11-20T14:59:58Z",
        "2026-11-20T15:00:00Z",
        "2026-11-20T15:00:04Z",
        "2026-11-20T15:00:10Z",
        "2026-11-20T17:14:50Z",
        "2026-11-20T17:15:00Z",
        "2026-11-20T17:15:10Z",
        "2026-11-20T19:00:00Z",
        "2026-11-20T19:30:00Z",
        "2026-11-21T00:00:00-06:00",
        "2026-11-21T05:00:00Z",
        "2026-11-21T09:30:00Z",
        "2026-11-22T09:00:00-06:00",
        "2026-11-22T09:00:00-07:00",
        "2026-11-22T09:30:00Z",
        "2026-11-22T10:30:00-05:00",
        "2026-11-22T10:30:00-06:00",
        "2026-11-22T10:30:00-07:00",
        "2026-11-22T11:00:00-06:00",
        "2026-11-22T12:00:00-05:00",
        "2026-11-22T12:00:00-06:00",
        "2026-11-22T14:00:00Z",
        "2026-11-22T14:30:00Z",
        "2026-11-22T15:00:00Z",
        "2026-11-22T15:30:00Z",
        "2026-11-22T15:45:00Z",
        "2026-11-22T16:00:00Z",
        "2026-11-22T16:15:00Z",
        "2026-11-22T18:00:00Z",
        "2026-11-22T19:45:00Z",
        "2026-11-22T21:00:00Z",
        "2026-11-22T21:30:00Z",
        "2026-11-22T23:00:00Z",
        "2026-11-23T00:00:00-06:00",
        "2026-11-23T00:15:00Z",
        "2026-11-23T01:00:00Z",
        "2026-11-23T01:30:00Z",
        "2026-11-23T05:00:00Z",
        "2026-11-23T12:00:00Z",
      ]
    `);
  });
});

describe("whenever the example is opened", () => {
  const BASE = { pc: pcFound(withFictionalOperations(nov22Capture())), later: pcFound(withFictionalOperations(nov22LaterCapture())),
    b1: systemFound(fictionalB1()), breeze: systemFound(fictionalBreeze()), attention: found(evaluateAttentionImport(harborAttentionImport())) };
  it("its Sunday is the coming Sunday at 9:30 AM, nothing in it is later than now, and Ozzie finds what it always finds", { timeout: 120_000 }, () => {
    const seen = new Map<string, ExampleShift>();
    for (const now of MOMENTS) { const s = exampleShift(now); seen.set(`${s.weeks}/${s.back}`, s); }
    // Each distinct shift is built and checked once; then every moment is checked against its own.
    const built = new Map([...seen].map(([key, s]) => [key, { capture: exampleCapture(s), later: exampleLaterCapture(s), attention: exampleAttention(s), b1: exampleSystem("b1", s), breeze: exampleSystem("breeze", s), genesis: exampleSystem("genesis", s) }] as const));
    for (const [key, x] of built) {
      expect(pcFound(x.capture), key).toBe(BASE.pc);
      expect(pcFound(x.later), key).toBe(BASE.later);
      expect(systemFound(x.b1), key).toBe(BASE.b1);
      expect(systemFound(x.breeze), key).toBe(BASE.breeze);
      const attention = evaluateAttentionImport(x.attention);
      expect(attention.ok, key).toBe(true);
      expect(found(attention), key).toBe(BASE.attention);
      // The same clock times as written, on each church's own clock.
      const brief = pcBrief(x.capture);
      expect((brief.times ?? []).map(t => clock(t, EXAMPLE_ZONE)), key).toEqual(["Sun 09:30"]);
      expect(clock(x.capture.completed_at, EXAMPLE_ZONE).slice(4), key).toBe("10:00");
      expect(clock(x.later.completed_at, EXAMPLE_ZONE).slice(4), key).toBe("12:15");
      expect(clock(x.b1.service!.starts_at, "America/Chicago"), key).toBe("Sun 09:00");
      expect(clock(x.breeze.service!.starts_at, "America/New_York"), key).toBe("Sun 10:30");
      expect(clock(x.attention.imported_at, EXAMPLE_ZONE).slice(4), key).toBe("09:00");
      // Genesis: every event on its own weekday and time of day (Mountain), the one that had happened still before the check.
      expect(x.genesis.events.map(e => clock(e.starts_at, "America/Denver")), key).toEqual(["Thu 18:30", "Sun 09:00", "Thu 18:30", "Sun 09:00"]);
      expect(Date.parse(x.genesis.events[0]!.ends_at!) <= Date.parse(x.genesis.completed_at), key).toBe(true);
      expect(x.genesis.events.slice(1).every(e => Date.parse(e.starts_at) > Date.parse(x.genesis.completed_at)), key).toBe(true);
      expect(Date.parse(x.genesis.completed_at) - Date.parse(x.genesis.events[0]!.starts_at) < 8 * DAY, key).toBe(true);
      // The import is the day before the check, as written.
      expect(localDate(Date.parse(x.attention.imported_at) + DAY, EXAMPLE_ZONE), key).toBe(localDate(x.capture.completed_at, EXAMPLE_ZONE));
    }
    for (const now of MOMENTS) {
      const s = exampleShift(now), x = built.get(`${s.weeks}/${s.back}`)!, at = new Date(now).toISOString();
      const today = localDate(now, EXAMPLE_ZONE), sunday = x.capture.reads.find(r => r.collection === "plan")!.body!.data as { attributes: { sort_date: string } };
      const day = sunday.attributes.sort_date.slice(0, 10);
      expect(day >= today && Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`) < 7 * DAY, at).toBe(true);
      expect(x.b1.service!.day, at).toBe(day);
      expect(x.breeze.service!.day, at).toBe(day);
      for (const done of [x.capture.completed_at, x.later.completed_at, x.attention.imported_at, x.b1.completed_at, x.breeze.completed_at, x.genesis.completed_at])
        expect(Date.parse(done) <= now, `${at} ${done}`).toBe(true);
      // And it is never more than a week old: the check is within six days of now.
      expect(now - Date.parse(x.capture.completed_at) < 6 * DAY, at).toBe(true);
    }
    expect(EXAMPLE_SUNDAY).toBe("2026-11-22");
  });
});
