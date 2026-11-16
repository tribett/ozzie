// Private calendar links: the iCalendar text a leader's calendar publishes, read on this Mac only. Fixed fictional
// calendars; the Mac's zone is America/New_York and the window is Monday November 16 through Monday November 23, 2026
// (the eight local days from 2026-11-16T05:00Z to 2026-11-24T05:00Z). Daylight saving ended on November 1.
import { describe, expect, it } from "vitest";
import { parseIcs, type IcsEvent } from "../../src/calendar/ics.js";

const zone = "America/New_York";
const window = { from: "2026-11-16T05:00:00.000Z", to: "2026-11-24T05:00:00.000Z" };
const calOf = (lines: readonly string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fictional//EN", ...lines, "END:VCALENDAR"].join("\r\n");
const cal = (...lines: string[]) => calOf(lines);
const event = (...lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
const parse = (text: string, z = zone) => {
  const result = parseIcs(text, { window, zone: z });
  if (!result.ok) throw new Error(`not read: ${result.problem}`);
  return result;
};
const timed = (e: IcsEvent | undefined) => {
  if (!e || e.time.all_day) throw new Error("not a timed event");
  return [e.time.start, e.time.end];
};
const starts = (events: readonly IcsEvent[]) => events.map(e => e.time.all_day ? e.time.start_date : e.time.start);

describe("reading the text", () => {
  it("unfolds long lines, reads escapes, and keeps only the title, place, time and status", () => {
    const text = cal(...event(
      "UID:a1@fictional.example",
      "SUMMARY:Elders\\, deacons and staff\\; quarterly",
      " planning",
      "LOCATION:Fellowship hall\\nRoom 2",
      "DTSTART:20261117T150000Z",
      "DTEND:20261117T163000Z",
      "STATUS:CONFIRMED",
    ));
    const { events } = parse(text);
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe("Elders, deacons and staff; quarterlyplanning");
    expect(events[0]!.location).toBe("Fellowship hall Room 2");
    expect(timed(events[0])).toEqual(["2026-11-17T15:00:00.000Z", "2026-11-17T16:30:00.000Z"]);
    expect(events[0]!.status).toBe("confirmed");
    expect(events[0]!.free).toBe(false);
    expect(events[0]!.uncertain).toBeNull();
  });

  it("accepts plain line feeds and a byte-order mark", () => {
    const text = "\uFEFF" + cal(...event("UID:b", "SUMMARY:Choir", "DTSTART:20261118T000000Z", "DTEND:20261118T010000Z")).replaceAll("\r\n", "\n");
    expect(parse(text).events.map(e => e.title)).toEqual(["Choir"]);
  });

  it("never reads notes, who is invited, who organized it, links or alarms", () => {
    const text = cal(...event(
      "UID:c",
      "SUMMARY:Hospital visit",
      "DESCRIPTION:Fictional private note about Avery Brightwater",
      "ATTENDEE;CN=Blake Ashgrove:mailto:blake@fictional.example",
      "ORGANIZER;CN=Cameron Larkspur:mailto:cameron@fictional.example",
      "URL:https://fictional.example/meeting",
      "DTSTART:20261119T140000Z",
      "DURATION:PT1H",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "SUMMARY:Alarm text that is not the title",
      "DESCRIPTION:Reminder about Riley Thornbury",
      "TRIGGER:-PT15M",
      "END:VALARM",
    ));
    const result = parse(text);
    expect(result.events.map(e => e.title)).toEqual(["Hospital visit"]);
    const all = JSON.stringify(result);
    for (const kept of ["Avery", "Blake", "Cameron", "Riley", "mailto", "fictional.example/meeting", "Alarm text", "Reminder"]) expect(all).not.toContain(kept);
  });

  it("makes titles plain, short text: no line breaks, controls, direction overrides or zero-width characters", () => {
    const long = "A".repeat(400);
    const text = cal(
      ...event("UID:d1", "SUMMARY:Board\u202Egnitee\u202C meeting\u200B\u0007", "DTSTART:20261117T150000Z", "DTEND:20261117T160000Z"),
      ...event("UID:d2", `SUMMARY:${long}`, "DTSTART:20261117T170000Z", "DTEND:20261117T180000Z"),
      ...event("UID:d3", "SUMMARY:<a href=\"https://fictional.example\">Click</a>", "DTSTART:20261117T190000Z", "DTEND:20261117T200000Z"),
    );
    const titles = parse(text).events.map(e => e.title);
    expect(titles[0]).toBe("Boardgnitee meeting");
    expect(titles[1]!.length).toBeLessThanOrEqual(200);
    expect(titles[1]!.endsWith("…")).toBe(true);
    // Kept as the words it is; the page shows it as text, never as markup or a link.
    expect(titles[2]).toBe("<a href=\"https://fictional.example\">Click</a>");
  });

  it("refuses text that isn't a calendar, and an unfinished one", () => {
    expect(parseIcs("<html><body>Sign in</body></html>", { window, zone })).toEqual({ ok: false, problem: "not-a-calendar" });
    expect(parseIcs("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\n", { window, zone })).toEqual({ ok: false, problem: "not-a-calendar" });
    expect(parseIcs("", { window, zone })).toEqual({ ok: false, problem: "not-a-calendar" });
  });

  it("skips an event without a start, and counts it", () => {
    const result = parse(cal(...event("UID:e", "SUMMARY:No time"), ...event("UID:f", "SUMMARY:Has time", "DTSTART:20261117T150000Z")));
    expect(result.events.map(e => e.title)).toEqual(["Has time"]);
    expect(result.skipped).toBe(1);
  });
});

describe("times", () => {
  it("places a named zone's wall-clock time, quoted or not", () => {
    const { events } = parse(cal(
      ...event("UID:g1", "SUMMARY:Chicago", "DTSTART;TZID=America/Chicago:20261117T090000", "DTEND;TZID=America/Chicago:20261117T100000"),
      ...event("UID:g2", "SUMMARY:Quoted", "DTSTART;TZID=\"America/Los_Angeles\":20261117T090000", "DTEND;TZID=\"America/Los_Angeles\":20261117T093000"),
    ));
    expect(timed(events.find(e => e.title === "Chicago"))).toEqual(["2026-11-17T15:00:00.000Z", "2026-11-17T16:00:00.000Z"]);
    expect(timed(events.find(e => e.title === "Quoted"))).toEqual(["2026-11-17T17:00:00.000Z", "2026-11-17T17:30:00.000Z"]);
  });

  it("knows Outlook's zone names and a zone at the end of a longer name", () => {
    const { events } = parse(cal(
      ...event("UID:h1", "SUMMARY:Outlook", "DTSTART;TZID=Eastern Standard Time:20261118T100000", "DTEND;TZID=Eastern Standard Time:20261118T110000"),
      ...event("UID:h2", "SUMMARY:Longer", "DTSTART;TZID=/fictional.example/20070129_1/America/Denver:20261118T100000", "DURATION:PT1H"),
    ));
    expect(timed(events.find(e => e.title === "Outlook"))).toEqual(["2026-11-18T15:00:00.000Z", "2026-11-18T16:00:00.000Z"]);
    expect(timed(events.find(e => e.title === "Longer"))).toEqual(["2026-11-18T17:00:00.000Z", "2026-11-18T18:00:00.000Z"]);
    expect(events.every(e => e.uncertain === null)).toBe(true);
  });

  it("says when a zone is unknown instead of pretending to know the time", () => {
    const { events } = parse(cal(...event("UID:i", "SUMMARY:Somewhere", "DTSTART;TZID=Fictional Standard Time:20261118T100000", "DTEND;TZID=Fictional Standard Time:20261118T110000")));
    expect(events[0]!.uncertain).toBe("This calendar uses a time zone Ozzie doesn't know (“Fictional Standard Time”), so the time may be off.");
    // Shown at that wall-clock time on this Mac, labeled as uncertain.
    expect(timed(events[0])).toEqual(["2026-11-18T15:00:00.000Z", "2026-11-18T16:00:00.000Z"]);
  });

  it("reads a time with no zone as this Mac's local time", () => {
    const { events } = parse(cal(...event("UID:j", "SUMMARY:Floating", "DTSTART:20261119T190000", "DTEND:20261119T203000")), "America/Chicago");
    expect(timed(events[0])).toEqual(["2026-11-20T01:00:00.000Z", "2026-11-20T02:30:00.000Z"]);
  });

  it("reads all-day events as dates, one day when no end is given", () => {
    const { events } = parse(cal(
      ...event("UID:k1", "SUMMARY:Thanksgiving week", "DTSTART;VALUE=DATE:20261123", "DTEND;VALUE=DATE:20261128"),
      ...event("UID:k2", "SUMMARY:Office closed", "DTSTART;VALUE=DATE:20261120"),
    ));
    expect(events.find(e => e.title === "Thanksgiving week")!.time).toEqual({ all_day: true, start_date: "2026-11-23", end_date: "2026-11-28" });
    expect(events.find(e => e.title === "Office closed")!.time).toEqual({ all_day: true, start_date: "2026-11-20", end_date: "2026-11-21" });
  });

  it("reads a duration, and an event with no end as having none", () => {
    const { events } = parse(cal(
      ...event("UID:l1", "SUMMARY:Ninety minutes", "DTSTART:20261117T150000Z", "DURATION:PT1H30M"),
      ...event("UID:l2", "SUMMARY:Two days", "DTSTART;VALUE=DATE:20261117", "DURATION:P2D"),
      ...event("UID:l3", "SUMMARY:A moment", "DTSTART:20261117T150000Z"),
    ));
    expect(timed(events.find(e => e.title === "Ninety minutes"))).toEqual(["2026-11-17T15:00:00.000Z", "2026-11-17T16:30:00.000Z"]);
    expect(events.find(e => e.title === "Two days")!.time).toEqual({ all_day: true, start_date: "2026-11-17", end_date: "2026-11-19" });
    expect(timed(events.find(e => e.title === "A moment"))).toEqual(["2026-11-17T15:00:00.000Z", "2026-11-17T15:00:00.000Z"]);
  });

  it("labels an end before its start as uncertain", () => {
    const { events } = parse(cal(...event("UID:m", "SUMMARY:Backwards", "DTSTART:20261117T160000Z", "DTEND:20261117T150000Z")));
    expect(events[0]!.uncertain).toBe("Its end is before its start in the calendar.");
  });

  it("keeps cancelled, tentative and free-time markings", () => {
    const { events } = parse(cal(
      ...event("UID:n1", "SUMMARY:Cancelled", "STATUS:CANCELLED", "DTSTART:20261117T150000Z", "DTEND:20261117T160000Z"),
      ...event("UID:n2", "SUMMARY:Maybe", "STATUS:TENTATIVE", "DTSTART:20261117T150000Z", "DTEND:20261117T160000Z"),
      ...event("UID:n3", "SUMMARY:Free", "TRANSP:TRANSPARENT", "DTSTART:20261117T150000Z", "DTEND:20261117T160000Z"),
    ));
    const by = (t: string) => events.find(e => e.title === t)!;
    expect(by("Cancelled").status).toBe("cancelled");
    expect(by("Maybe").status).toBe("tentative");
    expect(by("Free").free).toBe(true);
  });

  it("keeps only what touches the window", () => {
    const { events } = parse(cal(
      ...event("UID:o1", "SUMMARY:Last week", "DTSTART:20261110T150000Z", "DTEND:20261110T160000Z"),
      ...event("UID:o2", "SUMMARY:Overnight into Monday", "DTSTART:20261116T030000Z", "DTEND:20261116T060000Z"),
      ...event("UID:o3", "SUMMARY:Next month", "DTSTART:20261210T150000Z", "DTEND:20261210T160000Z"),
      ...event("UID:o4", "SUMMARY:Ends at the window's start", "DTSTART:20261116T040000Z", "DTEND:20261116T050000Z"),
      ...event("UID:o5", "SUMMARY:Starts at the window's end", "DTSTART;VALUE=DATE:20261124"),
    ));
    expect(events.map(e => e.title)).toEqual(["Overnight into Monday"]);
  });
});

describe("repeating events", () => {
  it("expands a weekly series on chosen days inside the window", () => {
    const { events } = parse(cal(...event("UID:p", "SUMMARY:Staff prayer", "DTSTART;TZID=America/New_York:20261006T090000", "DTEND;TZID=America/New_York:20261006T093000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU,TH")));
    expect(starts(events)).toEqual(["2026-11-17T14:00:00.000Z", "2026-11-19T14:00:00.000Z"]);
    expect(new Set(events.map(e => e.key)).size).toBe(2);
  });

  it("keeps a series at its wall-clock time after daylight saving ends", () => {
    // 10:00 Eastern on Tuesdays from October 20 (EDT, 14:00Z): on November 17 it is 15:00Z.
    const { events } = parse(cal(...event("UID:q", "SUMMARY:Bible study", "DTSTART;TZID=America/New_York:20261020T100000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY")));
    expect(starts(events)).toEqual(["2026-11-17T15:00:00.000Z"]);
  });

  it("counts COUNT from the first one, and stops at UNTIL", () => {
    const { events } = parse(cal(
      ...event("UID:r1", "SUMMARY:Three mornings", "DTSTART:20261115T130000Z", "DTEND:20261115T140000Z", "RRULE:FREQ=DAILY;COUNT=3"),
      ...event("UID:r2", "SUMMARY:Until Wednesday", "DTSTART:20261110T200000Z", "DTEND:20261110T210000Z", "RRULE:FREQ=DAILY;UNTIL=20261118T200000Z"),
    ));
    expect(starts(events.filter(e => e.title === "Three mornings"))).toEqual(["2026-11-16T13:00:00.000Z", "2026-11-17T13:00:00.000Z"]);
    expect(starts(events.filter(e => e.title === "Until Wednesday"))).toEqual(["2026-11-16T20:00:00.000Z", "2026-11-17T20:00:00.000Z", "2026-11-18T20:00:00.000Z"]);
  });

  it("expands every other week, and weekdays only", () => {
    const { events } = parse(cal(
      ...event("UID:s1", "SUMMARY:Every other Monday", "DTSTART:20261102T230000Z", "DTEND:20261103T000000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2"),
      ...event("UID:s2", "SUMMARY:Weekdays", "DTSTART;TZID=America/New_York:20261101T080000", "DURATION:PT15M", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"),
    ));
    expect(starts(events.filter(e => e.title === "Every other Monday"))).toEqual(["2026-11-16T23:00:00.000Z"]);
    expect(starts(events.filter(e => e.title === "Weekdays"))).toEqual([
      "2026-11-16T13:00:00.000Z", "2026-11-17T13:00:00.000Z", "2026-11-18T13:00:00.000Z", "2026-11-19T13:00:00.000Z", "2026-11-20T13:00:00.000Z", "2026-11-23T13:00:00.000Z",
    ]);
  });

  it("leaves out excluded dates and replaces a moved or cancelled one", () => {
    const { events } = parse(cal(
      ...event("UID:t@fictional.example", "SUMMARY:Rehearsal", "DTSTART;TZID=America/New_York:20261102T190000", "DURATION:PT2H", "RRULE:FREQ=DAILY",
        "EXDATE;TZID=America/New_York:20261117T190000,20261118T190000"),
      ...event("UID:t@fictional.example", "RECURRENCE-ID;TZID=America/New_York:20261119T190000", "SUMMARY:Rehearsal (moved)",
        "DTSTART;TZID=America/New_York:20261119T180000", "DURATION:PT2H"),
      ...event("UID:t@fictional.example", "RECURRENCE-ID;TZID=America/New_York:20261120T190000", "SUMMARY:Rehearsal", "STATUS:CANCELLED",
        "DTSTART;TZID=America/New_York:20261120T190000", "DURATION:PT2H"),
    ));
    const rehearsal = events.filter(e => e.title.startsWith("Rehearsal"));
    expect(rehearsal.map(e => [e.title, e.time.all_day ? "" : e.time.start, e.status])).toEqual([
      ["Rehearsal", "2026-11-17T00:00:00.000Z", "confirmed"],
      ["Rehearsal (moved)", "2026-11-19T23:00:00.000Z", "confirmed"],
      ["Rehearsal", "2026-11-21T00:00:00.000Z", "cancelled"],
      ["Rehearsal", "2026-11-22T00:00:00.000Z", "confirmed"],
      ["Rehearsal", "2026-11-23T00:00:00.000Z", "confirmed"],
      ["Rehearsal", "2026-11-24T00:00:00.000Z", "confirmed"],
    ]);
  });

  it("expands an all-day weekly series by date", () => {
    const { events } = parse(cal(...event("UID:u", "SUMMARY:Sabbath", "DTSTART;VALUE=DATE:20261002", "RRULE:FREQ=WEEKLY;BYDAY=FR")));
    expect(events.map(e => e.time)).toEqual([{ all_day: true, start_date: "2026-11-20", end_date: "2026-11-21" }]);
  });

  it("labels what it can't work out as worth a look instead of guessing", () => {
    const result = parse(cal(
      ...event("UID:v1", "SUMMARY:Elders meeting", "DTSTART:20260105T000000Z", "DURATION:PT2H", "RRULE:FREQ=MONTHLY;BYDAY=3TU"),
      ...event("UID:v2", "SUMMARY:Anniversary", "DTSTART;VALUE=DATE:20200101", "RRULE:FREQ=YEARLY"),
      ...event("UID:v3", "SUMMARY:Odd days", "DTSTART:20261001T120000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;BYMONTHDAY=1,3,5"),
      ...event("UID:v4", "SUMMARY:Ended long ago", "DTSTART:20200101T120000Z", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;UNTIL=20200601T000000Z"),
      ...event("UID:v5", "SUMMARY:Extra dates", "DTSTART:20261001T120000Z", "DURATION:PT1H", "RDATE:20261117T120000Z"),
    ));
    expect(result.events).toEqual([]);
    expect(result.looks).toEqual([
      { title: "Elders meeting", reason: "It repeats monthly, which Ozzie can't work out yet, so it may fall in these days." },
      { title: "Anniversary", reason: "It repeats yearly, which Ozzie can't work out yet, so it may fall in these days." },
      { title: "Odd days", reason: "It repeats in a way Ozzie can't work out yet, so it may fall in these days." },
      { title: "Extra dates", reason: "It has extra dates Ozzie can't work out yet, so it may fall in these days." },
    ]);
  });

  it("works out a series that began years ago without stepping through every day", () => {
    const { events } = parse(cal(...event("UID:w", "SUMMARY:Daily since 1990", "DTSTART:19900101T120000Z", "DURATION:PT10M", "RRULE:FREQ=DAILY")));
    expect(events).toHaveLength(8);
    expect(starts(events)[0]).toBe("2026-11-16T12:00:00.000Z");
  });
});

// A calendar file is outside input: a hostile one must not make the read take unbounded time or throw. Each case
// below took seconds or threw before the work was bounded; the time limits are generous so a slow machine passes.
describe("a hostile calendar file", () => {
  const timedRun = (text: string) => {
    const started = performance.now();
    const result = parseIcs(text, { window, zone });
    return { result, ms: performance.now() - started };
  };

  it("reads many changed occurrences in linear time and caps them per series", () => {
    const lines: string[] = [];
    // 30,000 changed occurrences whose series isn't in the file, each with its own UID, outside the window.
    for (let i = 0; i < 30_000; i++) lines.push(...event(`UID:lone-${i}`, `RECURRENCE-ID:20250101T${String(i % 24).padStart(2, "0")}0000Z`, "SUMMARY:Lone", "DTSTART:20250101T120000Z", "DURATION:PT1H"));
    // 5,000 changes to one weekly series, which comes last in the file.
    for (let i = 0; i < 5_000; i++) lines.push(...event("UID:busy", `RECURRENCE-ID:2025${String(1 + (i % 12)).padStart(2, "0")}01T120000Z`, "SUMMARY:Busy", "DTSTART:20250101T130000Z", "DURATION:PT1H"));
    lines.push(...event("UID:busy", "SUMMARY:Busy", "DTSTART:20261002T120000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY"));
    const { result, ms } = timedRun(calOf(lines));
    expect(ms).toBeLessThan(5_000);
    if (!result.ok) throw new Error(result.problem);
    expect(result.events.filter(e => e.title === "Busy")).toEqual([]);
    expect(result.looks).toEqual([{ title: "Busy", reason: "It has more changed dates than Ozzie can work out, so it may fall in these days." }]);
  });

  it("skips ahead to the window for a long COUNT series, and labels one it can't skip", () => {
    const lines: string[] = [];
    // 3,000 daily series counted from 1990: 13,000 days ends in August 2025, so none reaches the window. Counting each
    // from its start would take 39 million steps.
    for (let i = 0; i < 3_000; i++) lines.push(...event(`UID:ended-${i}`, "SUMMARY:Ended before", "DTSTART:19900101T120000Z", "DURATION:PT10M", "RRULE:FREQ=DAILY;COUNT=13000"));
    for (let i = 0; i < 3_000; i++) lines.push(...event(`UID:mondays-${i}`, "SUMMARY:Mondays since 1990", "DTSTART:19900101T120000Z", "DURATION:PT10M", "RRULE:FREQ=DAILY;BYDAY=MO;COUNT=100000"));
    lines.push(...event("UID:count-0", "SUMMARY:Daily since 1990", "DTSTART:19900101T120000Z", "DURATION:PT10M", "RRULE:FREQ=DAILY;COUNT=100000"));
    const { result, ms } = timedRun(calOf(lines));
    expect(ms).toBeLessThan(5_000);
    if (!result.ok) throw new Error(result.problem);
    expect(result.events.some(e => e.title === "Ended before")).toBe(false);
    const daily = result.events.filter(e => e.key.startsWith("count-0|"));
    expect(daily.map(e => e.time.all_day ? "" : e.time.start)).toEqual(Array.from({ length: 8 }, (_, i) => `2026-11-${String(16 + i).padStart(2, "0")}T12:00:00.000Z`));
    expect(result.looks[0]).toEqual({ title: "Mondays since 1990", reason: "It repeats a set number of times from long ago, which Ozzie can't work out yet, so it may fall in these days." });
    // Thousands of the same: only the first few are kept, and the read says it was cut short.
    expect(result.looks.length).toBeLessThanOrEqual(25);
    expect(result.truncated).toBe(true);
  });

  it("stops at one step budget for the whole file instead of a silent partial read", () => {
    const lines: string[] = [];
    // Each series must step day by day from 390 days before the window: together far more than one read may take.
    for (let i = 0; i < 3_000; i++) lines.push(...event(`UID:steps-${i}`, "SUMMARY:Weekdays this year", "DTSTART:20251022T120000Z", "DURATION:PT10M", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=100000"));
    const { result, ms } = timedRun(calOf(lines));
    expect(ms).toBeLessThan(5_000);
    expect(result).toEqual({ ok: false, problem: "too-large" });
  });

  it("refuses an absurd duration or length instead of throwing", () => {
    const text = cal(
      ...event("UID:x1", "SUMMARY:Forever", "DTSTART:20261117T150000Z", "DURATION:P99999999999999999999W"),
      ...event("UID:x2", "SUMMARY:Ten thousand years", "DTSTART:20261117T150000Z", "DTEND:99991231T000000Z"),
      ...event("UID:x3", "SUMMARY:Long all-day", "DTSTART;VALUE=DATE:20261117", "DURATION:P99999999D"),
      ...event("UID:x4", "SUMMARY:Many digits", "DTSTART:20261117T150000Z", "DURATION:PT999999999999999999999999H"),
      ...event("UID:x5", "SUMMARY:Fine", "DTSTART:20261117T150000Z", "DURATION:PT1H"),
      ...event("UID:x6", "SUMMARY:Huge interval", "DTSTART:99991225T120000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;INTERVAL=1000"),
    );
    let result: ReturnType<typeof parseIcs> | undefined;
    expect(() => { result = parseIcs(text, { window, zone }); }).not.toThrow();
    if (!result?.ok) throw new Error("not read");
    expect(result.events.map(e => e.title)).toEqual(["Fine"]);
    const longer = "It lasts longer than a year in the calendar, which Ozzie can't show.";
    expect(result.looks).toEqual([
      { title: "Forever", reason: longer }, { title: "Ten thousand years", reason: longer }, { title: "Long all-day", reason: longer }, { title: "Many digits", reason: longer },
    ]);
  });
});

describe("a hostile calendar file, continued", () => {
  it("labels a series with thousands of skipped dates instead of reading them all", () => {
    const skips = Array.from({ length: 5_000 }, (_, i) => `2020${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T120000Z`).join(",");
    const started = performance.now();
    const result = parseIcs(cal(...event("UID:skips", "SUMMARY:Skips", "DTSTART:20261001T120000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY", `EXDATE:${skips}`)), { window, zone });
    expect(performance.now() - started).toBeLessThan(2_000);
    if (!result.ok) throw new Error(result.problem);
    expect(result.events).toEqual([]);
    expect(result.looks).toEqual([{ title: "Skips", reason: "It has more skipped dates than Ozzie can work out, so it may fall in these days." }]);
  });
});

// Review C (Session B): a hostile file must not freeze the page through time-zone names, and nothing may be dropped
// silently. The reviewer's own inputs, each with a generous time limit so a slow machine passes.
describe("review C: time zones in a hostile file", () => {
  const timed = (text: string, extra: Partial<Parameters<typeof parseIcs>[1]> = {}) => {
    const started = performance.now();
    const result = parseIcs(text, { window, zone, ...extra });
    return { result, ms: performance.now() - started };
  };

  it("doesn't build every tail of a 60 KB zone name (H1a)", () => {
    const { result, ms } = timed(cal(...event("UID:z", "SUMMARY:Long zone", `DTSTART;TZID=${"a/".repeat(30_000)}a:20261117T100000`, "DURATION:PT1H")));
    expect(ms).toBeLessThan(1_000);
    if (!result.ok) throw new Error(result.problem);
    expect(result.events.map(e => e.title)).toEqual(["Long zone"]);
    expect(result.events[0]!.uncertain).toMatch(/^This calendar uses a time zone Ozzie doesn't know/u);
  });

  it("works out 8 MB of zoned skipped dates without looking the zone up for each (H1b)", () => {
    const lines: string[] = [];
    for (let e = 0; e < 520; e++) {
      const skips = Array.from({ length: 999 }, (_, i) => `20${String(20 + (i % 10)).padStart(2, "0")}${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}T100000`).join(",");
      lines.push(...event(`UID:x-${e}`, "SUMMARY:Weekly", "DTSTART;TZID=America/New_York:20261006T100000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY", `EXDATE;TZID=America/New_York:${skips}`));
    }
    const text = calOf(lines);
    expect(text.length).toBeGreaterThan(8_000_000);
    const { result, ms } = timed(text);
    expect(ms).toBeLessThan(3_000);
    expect(result.ok).toBe(true);
  });

  it("works out times only for events near the window, however many zoned starts the file has (H1c)", () => {
    const lines: string[] = [];
    for (let e = 0; e < 40_000; e++) lines.push(...event(`UID:old-${e}`, "SUMMARY:Old", `DTSTART;TZID=America/Chicago:2019${String(1 + (e % 12)).padStart(2, "0")}15T090000`, "DURATION:PT1H"));
    lines.push("BEGIN:VEVENT", "UID:many-starts", "SUMMARY:Many starts");
    for (let i = 0; i < 120_000; i++) lines.push(`DTSTART;TZID=America/Denver:2019${String(1 + (i % 12)).padStart(2, "0")}10T090000`);
    lines.push("DTSTART;TZID=America/Denver:20261117T090000", "DURATION:PT1H", "END:VEVENT");
    const { result, ms } = timed(calOf(lines));
    expect(ms).toBeLessThan(3_000);
    if (!result.ok) throw new Error(result.problem);
    expect(result.events.map(e => e.title)).toEqual(["Many starts"]);
  });

  it("looks up at most a handful of different zone names, and the rest are unknown", () => {
    const lines: string[] = [];
    for (let e = 0; e < 5_000; e++) lines.push(...event(`UID:z-${e}`, `SUMMARY:Z${e}`, `DTSTART;TZID=Fictional/Zone_${e}:20261117T100000`, "DURATION:PT1H"));
    const { result, ms } = timed(calOf(lines));
    expect(ms).toBeLessThan(3_000);
    expect(result.ok ? "read" : result.problem).toMatch(/^(read|too-large)$/u);
  });

  it("refuses a read that runs past its time limit instead of freezing", () => {
    let now = 0;
    const lines = Array.from({ length: 2_000 }, (_, i) => event(`UID:t-${i}`, "SUMMARY:Tick", "DTSTART:20261117T150000Z", "DURATION:PT1H")).flat();
    const { result } = timed(calOf(lines), { timeLimitMs: 100, clock: () => (now += 5) });
    expect(result).toEqual({ ok: false, problem: "too-large" });
  });

  it("treats a zone named like a built-in property as an unknown zone, never breaking the calendar (M3)", () => {
    const names = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];
    const result = parse(cal(
      ...names.flatMap((n, i) => event(`UID:p-${i}`, `SUMMARY:${n}`, `DTSTART;TZID=${n}:20261117T100000`, "DURATION:PT1H", `X-${n};${n}=x:y`)),
      ...event("UID:fine", "SUMMARY:Fine", "DTSTART:20261117T150000Z", "DURATION:PT1H", "STATUS:CONSTRUCTOR"),
    ));
    expect(result.events.map(e => e.title).sort()).toEqual([...names, "Fine"].sort());
    for (const e of result.events.filter(e => e.title !== "Fine")) expect(e.uncertain).toMatch(/^This calendar uses a time zone Ozzie doesn't know/u);
    expect(result.events.find(e => e.title === "Fine")!.status).toBe("confirmed");
  });
});

describe("review C: nothing dropped silently", () => {
  it("expands repeating events without a UID, and both of two that share one, saying so (L2a)", () => {
    const result = parse(cal(
      ...event("SUMMARY:Standup", "DTSTART:20261116T140000Z", "DURATION:PT15M", "RRULE:FREQ=DAILY;COUNT=2"),
      ...event("SUMMARY:Choir", "DTSTART:20261117T230000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY"),
      ...event("UID:same", "SUMMARY:First", "DTSTART:20261118T140000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY"),
      ...event("UID:same", "SUMMARY:Second", "DTSTART:20261119T140000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY"),
    ));
    expect(result.events.map(e => e.title)).toEqual(["Standup", "Standup", "Choir", "First", "Second"]);
    expect(result.looks).toEqual([{ title: "Second", reason: "This calendar lists more than one repeating event with the same identifier, so a changed date may not show on the right one." }]);
  });

  it("keeps reading after a stray or missing END, and says the text was out of order (L2b)", () => {
    const damaged = "Part of this calendar's text is out of order or unfinished, so some events may be missing.";
    const stray = parse(cal("END:VALARM", ...event("UID:a", "SUMMARY:After stray", "DTSTART:20261117T150000Z")));
    expect(stray.events.map(e => e.title)).toEqual(["After stray"]);
    expect(stray.looks).toEqual([{ title: null, reason: damaged }]);
    const unclosed = parse(cal(
      "BEGIN:VEVENT", "UID:b", "SUMMARY:Has an open alarm", "DTSTART:20261117T150000Z", "BEGIN:VALARM", "TRIGGER:-PT15M", "END:VEVENT",
      ...event("UID:c", "SUMMARY:Next", "DTSTART:20261117T170000Z"),
    ));
    expect(unclosed.events.map(e => e.title)).toEqual(["Has an open alarm", "Next"]);
    expect(unclosed.looks).toEqual([{ title: null, reason: damaged }]);
    expect(parse(cal(...event("UID:d", "SUMMARY:Clean", "DTSTART:20261117T150000Z"))).looks).toEqual([]);
  });

  it("shows a changed occurrence moved into the window when its series is outside it (L2c)", () => {
    const result = parse(cal(
      ...event("UID:ended", "SUMMARY:Ended series", "DTSTART:20250105T150000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;UNTIL=20250301T000000Z"),
      ...event("UID:ended", "RECURRENCE-ID:20250112T150000Z", "SUMMARY:Ended series (moved)", "DTSTART:20261118T150000Z", "DURATION:PT1H"),
      ...event("UID:later", "SUMMARY:Later series", "DTSTART:20270105T150000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY"),
      ...event("UID:later", "RECURRENCE-ID:20270112T150000Z", "SUMMARY:Later series (moved up)", "DTSTART:20261119T150000Z", "DURATION:PT1H"),
    ));
    expect(result.events.map(e => e.title)).toEqual(["Ended series (moved)", "Later series (moved up)"]);
  });

  it("says how many events have no start it can read (L2d)", () => {
    const result = parse(cal(...event("UID:e1", "SUMMARY:No time"), ...event("UID:e2", "SUMMARY:Bad time", "DTSTART:2026-11-17"),
      ...event("UID:e3", "SUMMARY:Has time", "DTSTART:20261117T150000Z")));
    expect(result.skipped).toBe(2);
    expect(result.looks).toEqual([{ title: null, reason: "2 events in this calendar have no start time Ozzie can read, so they aren't shown." }]);
  });

  it("says when some text couldn't be read (L10)", () => {
    const result = parse(cal(...event("UID:g", "SUMMARY:Caf\uFFFD", "DTSTART:20261117T150000Z")));
    expect(result.looks).toEqual([{ title: null, reason: "Some text in this calendar couldn't be read and shows as “\uFFFD”." }]);
  });
});

describe("review C: small calendar rules", () => {
  it("reads an all-day event ending on its own start date as one day (L5)", () => {
    const { events, looks } = parse(cal(
      ...event("UID:a1", "SUMMARY:Same day end", "DTSTART;VALUE=DATE:20261118", "DTEND;VALUE=DATE:20261118"),
      ...event("UID:a2", "SUMMARY:No length", "DTSTART;VALUE=DATE:20261119", "DURATION:P0D"),
    ));
    expect(events.map(e => [e.title, e.time, e.uncertain])).toEqual([
      ["Same day end", { all_day: true, start_date: "2026-11-18", end_date: "2026-11-19" }, null],
      ["No length", { all_day: true, start_date: "2026-11-19", end_date: "2026-11-20" }, null],
    ]);
    expect(looks).toEqual([]);
  });

  it("skips the whole day for a date-only EXDATE on a timed series (L5)", () => {
    const { events } = parse(cal(...event("UID:x", "SUMMARY:Morning prayer", "DTSTART;TZID=America/New_York:20261116T070000", "DURATION:PT30M",
      "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;VALUE=DATE:20261117")));
    expect(events.map(e => e.time.all_day ? "" : e.time.start)).toEqual(["2026-11-16T12:00:00.000Z", "2026-11-18T12:00:00.000Z"]);
  });

  it("takes out tag characters, the soft hyphen and other format characters, and keeps combining marks to three (L6)", () => {
    const { events } = parse(cal(...event("UID:t", "SUMMARY:A\u{E0041}\u{E0042}B\u180EC\u0301\u0301\u0301\u0301\u0301\u00ADD\u2066E\u2069", "DTSTART:20261117T150000Z")));
    expect(events[0]!.title).toBe("ABC\u0301\u0301\u0301DE");
  });
});

describe("review C2", () => {
  it("says nothing about extra dates far from these days, so the read doesn't look cut short (N2)", () => {
    const old = Array.from({ length: 30 }, (_, i) => event(`UID:old-${i}`, `SUMMARY:Old ${i}`, `DTSTART:2010${String(1 + (i % 12)).padStart(2, "0")}05T150000Z`,
      "DURATION:PT1H", `RDATE:2010${String(1 + (i % 12)).padStart(2, "0")}12T150000Z,2010${String(1 + (i % 12)).padStart(2, "0")}19T150000Z`)).flat();
    const result = parse(cal(...old, ...event("UID:today", "SUMMARY:Today", "DTSTART:20261116T150000Z", "DURATION:PT1H")));
    expect(result.events.map(e => e.title)).toEqual(["Today"]);
    expect(result.looks).toEqual([]);
    expect(result.truncated).toBe(false);
    // An extra date that does fall in these days is still said.
    const near = parse(cal(...event("UID:n", "SUMMARY:Extra this week", "DTSTART:20261001T150000Z", "DURATION:PT1H", "RDATE:20261118T150000Z")));
    expect(near.looks).toEqual([{ title: "Extra this week", reason: "It has extra dates Ozzie can't work out yet, so it may fall in these days." }]);
  });

  it("keeps joiners inside emoji and words, and takes out the other format characters", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const heart = "\u2764\uFE0F\u200D\u{1F525}";
    const persian = "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645";
    const { events } = parse(cal(...event("UID:j", `SUMMARY:${family} picnic ${heart} ${persian}\u200D \u200Cx\u202E`, "DTSTART:20261117T150000Z")));
    expect(events[0]!.title).toBe(`${family} picnic ${heart} ${persian} x`);
  });
});
