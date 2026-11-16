// What Today shows from the leader's calendars: the days, each event once (with every calendar it came from), and
// "two things at the same time". Fixed fictional reads; the Mac is on Eastern time and it is Monday, November 16,
// 2026, 9:00 AM (14:00Z). Every finding here is deterministic and covered before it is shown.
import { describe, expect, it } from "vitest";
import {
  APPLE_SOURCE, calendarOverlaps, calendarView, calendarWindow, failedRead, readFromApple, readFromLink,
  type CalendarEntry, type CalendarRead, type CalendarSource,
} from "../../src/calendar/events.js";
import type { CalendarTime } from "../../src/calendar/ics.js";

const zone = "America/New_York";
const now = "2026-11-16T14:00:00.000Z";
const window = calendarWindow(now, zone)!;
const office: CalendarSource = { kind: "link", id: "a1b2c3d4e5f60718", label: "Church office" };
const at = (start: string, end: string): CalendarTime => ({ all_day: false, start, end });
const read = (source: CalendarSource, events: Partial<CalendarRead["events"][number]>[], checked_at = "2026-11-16T13:58:00.000Z"): CalendarRead => ({
  source, checked_at, problem: null, truncated: false, looks: [],
  events: events.map((e, i) => ({ key: `k${i}-${source.id}`, title: "Event", location: null, status: "confirmed", free: false, uncertain: null,
    time: at("2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z"), ...e })),
});
const entry = (title: string, time: CalendarTime, more: Partial<CalendarEntry> = {}): CalendarEntry => ({
  key: title, title, location: null, time, status: "confirmed", free: false, uncertain: null, sources: [APPLE_SOURCE], ...more,
});

describe("the days shown", () => {
  it("are today and the next seven, from this Mac's midnight", () => {
    expect(window).toEqual({
      from: "2026-11-16T05:00:00.000Z", to: "2026-11-24T05:00:00.000Z",
      dates: ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"],
    });
  });

  it("follow the clock across a daylight-saving change", () => {
    const w = calendarWindow("2026-10-30T16:00:00.000Z", zone)!;
    expect(w.from).toBe("2026-10-30T04:00:00.000Z");
    expect(w.to).toBe("2026-11-07T05:00:00.000Z");
    expect(w.dates).toHaveLength(8);
    expect(calendarWindow("not a time", zone)).toBeNull();
  });
});

describe("reading Apple Calendar's answer", () => {
  const apple = (events: unknown[], access = "full", truncated = false) => ({ access, events, truncated });

  it("keeps each event's title, place, time and status, within the days shown", () => {
    const r = readFromApple(apple([
      { calendar: "CAL-1", id: "EV-1", title: "Staff meeting", location: "Office", start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z", all_day: false, status: "confirmed", free: false },
      { calendar: "CAL-1", id: "EV-2", title: "Thanksgiving", location: null, start: "2026-11-26", end: "2026-11-27", all_day: true, status: "confirmed", free: true },
      { calendar: "CAL-2", id: "EV-3", title: "Choir", location: null, start: "2026-11-21", end: "2026-11-22", all_day: true, status: "tentative", free: false },
    ]), APPLE_SOURCE, now, window);
    expect(r.problem).toBeNull();
    expect(r.events.map(e => [e.title, e.location, e.time, e.status])).toEqual([
      ["Staff meeting", "Office", at("2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z"), "confirmed"],
      ["Choir", null, { all_day: true, start_date: "2026-11-21", end_date: "2026-11-22" }, "tentative"],
    ]);
    expect(r.events[0]!.key).toBe("CAL-1|EV-1|2026-11-17T15:00:00.000Z");
  });

  it("says plainly when macOS hasn't let Ozzie read the calendars", () => {
    expect(readFromApple(apple([], "denied"), APPLE_SOURCE, now, window).problem).toBe("macOS hasn't given Ozzie permission to read your calendars.");
    expect(readFromApple({ nonsense: true }, APPLE_SOURCE, now, window).problem).toBe("Apple Calendar's answer couldn't be read.");
  });

  it("skips anything malformed and makes every title plain text", () => {
    const r = readFromApple(apple([
      { calendar: "CAL-1", id: "EV-1", title: "Board\u202Egnitee\u202C\nmeeting", location: "", start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z", all_day: false, status: "confirmed", free: false },
      { calendar: "CAL-1", id: "EV-2", title: "No end", start: "2026-11-17T15:00:00Z", all_day: false, status: "confirmed", free: false },
      { calendar: "CAL-1", id: "EV-3", title: "Bad status", start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z", all_day: false, status: "maybe", free: false },
      "not an event",
    ], "full", true), APPLE_SOURCE, now, window);
    expect(r.events.map(e => [e.title, e.location])).toEqual([["Boardgnitee meeting", null]]);
    expect(r.truncated).toBe(true);
  });
});

describe("reading a private calendar link", () => {
  it("reads the calendar's text with the same days and zone", () => {
    const text = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "SUMMARY:Elders", "DTSTART;TZID=America/New_York:20261118T190000", "DURATION:PT2H", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const r = readFromLink(text, office, now, window, zone);
    expect(r.problem).toBeNull();
    expect(r.events.map(e => [e.title, e.time])).toEqual([["Elders", at("2026-11-19T00:00:00.000Z", "2026-11-19T02:00:00.000Z")]]);
  });

  it("says when the address didn't give back a calendar", () => {
    expect(readFromLink("<html></html>", office, now, window, zone).problem).toBe("The address didn't give back a calendar.");
    expect(failedRead(office, now, "The calendar's website didn't answer.")).toEqual({
      source: office, checked_at: now, problem: "The calendar's website didn't answer.", events: [], looks: [], truncated: false,
    });
  });
});

describe("each event once", () => {
  it("shows the same event from two calendars once, naming both", () => {
    const view = calendarView([
      read(APPLE_SOURCE, [{ title: "Staff meeting" }]),
      read(office, [{ title: "staff meeting " }, { title: "Lunch", time: at("2026-11-17T17:00:00.000Z", "2026-11-17T18:00:00.000Z") }]),
    ], now, zone);
    const tuesday = view.days.find(d => d.date === "2026-11-17")!;
    expect(tuesday.entries.map(e => [e.title, e.sources.map(s => s.label)])).toEqual([
      ["Staff meeting", ["Apple Calendar on this Mac", "Church office"]],
      ["Lunch", ["Church office"]],
    ]);
    expect(view.overlaps).toEqual([]);
  });

  it("puts all-day events first and lists one that spans days on each of them", () => {
    const view = calendarView([read(APPLE_SOURCE, [
      { title: "Evening", time: at("2026-11-20T23:00:00.000Z", "2026-11-21T00:00:00.000Z") },
      { title: "Retreat", time: { all_day: true, start_date: "2026-11-20", end_date: "2026-11-22" } },
      { title: "Overnight", time: at("2026-11-21T03:00:00.000Z", "2026-11-21T07:00:00.000Z") },
    ])], now, zone);
    const titles = (date: string) => view.days.find(d => d.date === date)!.entries.map(e => e.title);
    expect(titles("2026-11-20")).toEqual(["Retreat", "Evening", "Overnight"]);
    expect(titles("2026-11-21")).toEqual(["Retreat", "Overnight"]);
    expect(titles("2026-11-22")).toEqual([]);
    expect(view.days).toHaveLength(8);
  });

  it("keeps what was read and when, with any problem", () => {
    const view = calendarView([read(APPLE_SOURCE, [{ title: "A" }], "2026-11-16T13:00:00.000Z"), failedRead(office, "2026-11-16T13:01:00.000Z", "The calendar's website didn't answer.")], now, zone);
    expect(view.reads).toEqual([
      { source: APPLE_SOURCE, checked_at: "2026-11-16T13:00:00.000Z", problem: null, truncated: false, count: 1 },
      { source: office, checked_at: "2026-11-16T13:01:00.000Z", problem: "The calendar's website didn't answer.", truncated: false, count: 0 },
    ]);
  });
});

describe("two things at the same time", () => {
  const nine = at("2026-11-17T14:00:00.000Z", "2026-11-17T15:00:00.000Z");
  const nineThirty = at("2026-11-17T14:30:00.000Z", "2026-11-17T15:30:00.000Z");

  it("finds two timed events whose times overlap, with when they overlap", () => {
    const [o, ...rest] = calendarOverlaps([entry("Staff meeting", nine), entry("Hospital visit", nineThirty)], now, zone);
    expect(rest).toEqual([]);
    expect(o).toMatchObject({ tone: "decision", date: "2026-11-17", starts_at: "2026-11-17T14:30:00.000Z", ends_at: "2026-11-17T15:00:00.000Z", reason: null });
    expect([o!.first.title, o!.second.title]).toEqual(["Staff meeting", "Hospital visit"]);
    expect(o!.id).toMatch(/^calendar-overlap:[0-9a-f]{8}$/u);
  });

  it("is the same finding whatever order the calendars were read in", () => {
    const a = calendarOverlaps([entry("Staff meeting", nine), entry("Hospital visit", nineThirty)], now, zone);
    const b = calendarOverlaps([entry("Hospital visit", nineThirty), entry("Staff meeting", nine)], now, zone);
    expect(b).toEqual(a);
  });

  it("doesn't count back-to-back events, all-day events, cancelled ones, free time, or the same event twice", () => {
    expect(calendarOverlaps([
      entry("First", nine), entry("Right after", at("2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z")),
      entry("Holiday", { all_day: true, start_date: "2026-11-17", end_date: "2026-11-18" }),
      entry("Cancelled", nineThirty, { status: "cancelled" }),
      entry("Free", nineThirty, { free: true }),
    ], now, zone)).toEqual([]);
    const view = calendarView([read(APPLE_SOURCE, [{ title: "Staff meeting", time: nine }]), read(office, [{ title: "Staff meeting", time: nine }])], now, zone);
    expect(view.overlaps).toEqual([]);
  });

  it("calls one with a tentative event worth a look, saying why", () => {
    const [o] = calendarOverlaps([entry("Staff meeting", nine), entry("Coffee", nineThirty, { status: "tentative" })], now, zone);
    expect(o!.tone).toBe("look");
    expect(o!.reason).toBe("“Coffee” is marked tentative.");
  });

  it("leaves out an event whose time Ozzie isn't sure of", () => {
    expect(calendarOverlaps([entry("Staff meeting", nine), entry("Somewhere", nineThirty, { uncertain: "This calendar uses a time zone Ozzie doesn't know." })], now, zone)).toEqual([]);
  });

  it("leaves out an overlap that is already over, and dates one by the later start on this Mac's clock", () => {
    expect(calendarOverlaps([entry("Early", at("2026-11-16T12:00:00.000Z", "2026-11-16T13:00:00.000Z")), entry("Also early", at("2026-11-16T12:30:00.000Z", "2026-11-16T13:30:00.000Z"))], now, zone)).toEqual([]);
    const [late] = calendarOverlaps([entry("Late", at("2026-11-18T04:30:00.000Z", "2026-11-18T06:00:00.000Z")), entry("Later", at("2026-11-18T05:30:00.000Z", "2026-11-18T07:00:00.000Z"))], now, zone);
    expect(late!.date).toBe("2026-11-18");
  });

  it("finds every pair when three overlap, in time order", () => {
    const found = calendarOverlaps([
      entry("A", at("2026-11-19T14:00:00.000Z", "2026-11-19T16:00:00.000Z")),
      entry("B", at("2026-11-19T15:00:00.000Z", "2026-11-19T17:00:00.000Z")),
      entry("C", at("2026-11-19T15:30:00.000Z", "2026-11-19T15:45:00.000Z")),
    ], now, zone);
    expect(found.map(o => `${o.first.title}+${o.second.title}`)).toEqual(["A+B", "A+C", "B+C"]);
  });
});

describe("a hostile or very full calendar", () => {
  it("never lets reading a link throw", () => {
    const absurd = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x", "SUMMARY:Forever", "DTSTART:20261117T150000Z", "DURATION:P99999999999999999999W", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    expect(() => readFromLink(absurd, office, now, window, zone)).not.toThrow();
    expect(readFromLink(absurd, office, now, window, zone).problem).toBeNull();
  });

  it("keeps at most fifty overlaps, saying more were left out, and stays quick with many events at once", () => {
    const events = Array.from({ length: 1_500 }, (_, i) => ({ title: `Event ${i}`, time: at("2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z") }));
    const started = performance.now();
    const view = calendarView([read(APPLE_SOURCE, events)], now, zone);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(view.overlaps).toHaveLength(50);
    expect(view.overlaps_cut).toBe(true);
    expect(view.days.find(d => d.date === "2026-11-17")!.entries).toHaveLength(1_500);
  });
});

describe("review C: overlaps and merging", () => {
  const at9 = (day: number, h: number, m: number, mins: number) => {
    const start = Date.UTC(2026, 10, day, h, m);
    return at(new Date(start).toISOString(), new Date(start + mins * 60_000).toISOString());
  };

  it("leaves out events already over before comparing anything, so thousands that overlapped earlier cost almost nothing (M2)", () => {
    // Eight calendars of 500 busy events each, all overlapping one another this morning, before 9:00 AM.
    const reads = Array.from({ length: 8 }, (_, c) => read({ kind: "link", id: `link-${c}`, label: `Calendar ${c}` },
      Array.from({ length: 500 }, (_, i) => ({ title: `Busy ${c}-${i}`, time: at9(16, 6, i % 60, 240) }))));
    const started = performance.now();
    const view = calendarView(reads, now, zone);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(view.overlaps).toEqual([]);
    expect(view.days[0]!.entries).toHaveLength(4_000);
  });

  it("keeps the earliest overlaps when there are more than fifty, not the ones with the earliest event (L12)", () => {
    // A long busy block from Tuesday 8:00 to Thursday 8:00 overlaps sixty short events on Wednesday; two short events
    // on Tuesday morning overlap each other (and the block) earlier than any of those.
    const block = entry("Out of office", at9(17, 13, 0, 48 * 60));
    const wednesday = Array.from({ length: 60 }, (_, i) => entry(`Wednesday ${i}`, at9(18, 14, i * 10, 5)));
    const early = [entry("Early A", at9(17, 14, 0, 60)), entry("Early B", at9(17, 14, 30, 60))];
    const found = calendarOverlaps([block, ...wednesday, ...early], now, zone, 51);
    expect(found).toHaveLength(51);
    expect(found.some(o => o.first.title === "Early A" && o.second.title === "Early B")).toBe(true);
    const starts = found.map(o => o.starts_at);
    expect(starts).toEqual([...starts].sort());
    expect(found.filter(o => o.second.title.startsWith("Wednesday")).map(o => o.second.title)).toEqual(Array.from({ length: 48 }, (_, i) => `Wednesday ${i}`));
  });

  it("keeps two events with the same title and time in one calendar as two, and they overlap (L3)", () => {
    const view = calendarView([read(office, [{ title: "Rehearsal" }, { title: "Rehearsal" }])], now, zone);
    expect(view.days.find(d => d.date === "2026-11-17")!.entries.map(e => e.title)).toEqual(["Rehearsal", "Rehearsal"]);
    expect(new Set(view.days.find(d => d.date === "2026-11-17")!.entries.map(e => e.key)).size).toBe(2);
    expect(view.overlaps).toHaveLength(1);
  });

  it("still shows one event read from two Apple calendars, or from Apple and a link, once", () => {
    const apple = readFromApple({ access: "full", truncated: false, events: [
      { calendar: "CAL-1", id: "E1", title: "Staff meeting", start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z", all_day: false, status: "confirmed", free: false },
      { calendar: "CAL-2", id: "E9", title: "Staff meeting", start: "2026-11-17T15:00:00Z", end: "2026-11-17T16:00:00Z", all_day: false, status: "confirmed", free: false },
    ] }, APPLE_SOURCE, now, window);
    const view = calendarView([apple, read(office, [{ title: "Staff meeting", time: at("2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z") }])], now, zone);
    expect(view.days.find(d => d.date === "2026-11-17")!.entries.map(e => [e.title, e.sources.map(s => s.label)])).toEqual([["Staff meeting", ["Apple Calendar on this Mac", "Church office"]]]);
    expect(view.overlaps).toEqual([]);
  });
});
