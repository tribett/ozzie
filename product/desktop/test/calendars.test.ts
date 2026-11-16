// The leader's own calendars in the app: Settings connects and chooses them, Today shows "On your calendar" in place
// of the fictional example. A stand-in for the native calendar commands; fictional calendars only. Monday, November
// 16, 2026, 9:00 AM Eastern.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "sent") }));
import { invoke as tauri } from "@tauri-apps/api/core";
import { APPLE_SOURCE, type CalendarRead } from "../../../core/src/calendar/events.js";
import { allowed, CALENDAR_COMMANDS, calendarsConnected, createCalendars, LINK_PROBLEMS, linkProblem, type Invoke } from "../src/calendars.js";
import { buildHarnessData } from "../src/harness-bridge.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { CalendarGroup, dayLabel, timeOnDay } from "../src/calendar-today.js";
import { CALENDARS_HOW, CalendarSettings } from "../src/calendar-settings.js";
import { TodayPage } from "../src/today-page.js";

const zone = "America/New_York";
let clockNow = "2026-11-16T14:00:00.000Z";
const SECRET = "https://calendar.google.com/calendar/ical/fictional%40example.org/private-0123456789abcdef/basic.ics";
const LINK_ID = "a1b2c3d4e5f60718";
const ICS = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:x@fictional.example", "SUMMARY:Hospital visit", "DTSTART;TZID=America/New_York:20261117T093000",
  "DURATION:PT1H", "END:VEVENT", "BEGIN:VEVENT", "UID:m@fictional.example", "SUMMARY:Elders meeting", "DTSTART:20260105T000000Z", "DURATION:PT2H",
  "RRULE:FREQ=MONTHLY;BYDAY=3TU", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const APPLE_EVENTS = { access: "full", truncated: false, events: [
  { calendar: "CAL-1", id: "E1", title: "Staff meeting", location: "Office", start: "2026-11-17T14:00:00Z", end: "2026-11-17T15:00:00Z", all_day: false, status: "confirmed", free: false },
  { calendar: "CAL-1", id: "E2", title: "Thanksgiving week", start: "2026-11-23", end: "2026-11-28", all_day: true, status: "confirmed", free: true },
] };

interface Fake { invoke: Invoke; calls: [string, Record<string, unknown> | undefined][]; answers: Record<string, unknown> }
function fake(answers: Record<string, unknown> = {}): Fake {
  const calls: Fake["calls"] = [];
  // Native code keeps the chosen calendars (review C, L8).
  let chosen: string[] = [];
  const all: Record<string, unknown> = {
    calendar_apple_chosen: () => chosen,
    calendar_apple_choose: (args: { ids: string[] }) => (chosen = [...new Set(args.ids)]),
    calendar_apple_status: "not-determined", calendar_apple_ask: "full",
    calendar_apple_calendars: { access: "full", calendars: [{ id: "CAL-1", title: "Church", account: "iCloud" }, { id: "CAL-2", title: "Home", account: "iCloud" }] },
    calendar_apple_events: APPLE_EVENTS, calendar_links: [], calendar_link_read: ICS, calendar_link_remove: null,
    calendar_link_add: (args: { label: string }) => ({ link: { id: LINK_ID, label: args.label, shown: "calendar.google.com/•••", missing: false }, text: ICS }),
    ...answers,
  };
  const invoke = (async (command: string, args?: Record<string, unknown>) => {
    calls.push([command, args]);
    const answer = all[command];
    if (answer instanceof Error) throw answer.message;
    return typeof answer === "function" ? (answer as (a: unknown) => unknown)(args) : answer;
  }) as Invoke;
  return { invoke, calls, answers: all };
}
const memory = () => { const kept = new Map<string, string>(); return { kept, get: (k: string) => kept.get(k) ?? null, set: (k: string, v: string) => { kept.set(k, v); } }; };
const setup = (answers: Record<string, unknown> = {}, callLimitMs?: number) => {
  const f = fake(answers);
  const calendars = createCalendars({ invoke: f.invoke, now: () => clockNow, zone: () => zone, ...(callLimitMs ? { callLimitMs } : {}) });
  return { f, calendars };
};
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&amp;", "&").replace(/\s+/gu, " ");

describe("connecting and reading", () => {
  it("asks macOS nothing on its own, and reads nothing until a calendar is connected", async () => {
    clockNow = "2026-11-16T14:00:00.000Z";
    const { f, calendars } = setup();
    await calendars.load();
    expect(f.calls.map(c => c[0])).toEqual(["calendar_apple_status", "calendar_apple_chosen", "calendar_links"]);
    expect(calendars.state()).toMatchObject({ access: "not-determined", chosen: [], links: [], reads: [] });
    expect(calendarsConnected(calendars.state())).toBe(false);
  });

  it("asks only from the person's click, lists the calendars, and reads only the ones chosen", async () => {
    const { f, calendars } = setup();
    await calendars.load();
    await calendars.connectApple();
    expect(f.calls.filter(c => c[0] === "calendar_apple_ask")).toHaveLength(1);
    expect(calendars.state().calendars?.map(c => c.title)).toEqual(["Church", "Home"]);
    expect(calendarsConnected(calendars.state())).toBe(false);
    await calendars.choose(["CAL-1"]);
    // The choice is kept natively, and the read asks only for the days: native code reads what it keeps as chosen.
    expect(f.calls.find(c => c[0] === "calendar_apple_choose")![1]).toEqual({ ids: ["CAL-1"] });
    const read = f.calls.find(c => c[0] === "calendar_apple_events")!;
    expect(read[1]).toEqual({ from: "2026-11-16T05:00:00.000Z", to: "2026-11-24T05:00:00.000Z" });
    expect(calendars.state().chosen).toEqual(["CAL-1"]);
    expect(calendars.state().reads.map(r => [r.source.label, r.events.map(e => e.title)])).toEqual([["Apple Calendar on this Mac", ["Staff meeting", "Thanksgiving week"]]]);
    await calendars.stopApple();
    expect(f.calls.filter(c => c[0] === "calendar_apple_choose").at(-1)![1]).toEqual({ ids: [] });
    expect(calendars.state().chosen).toEqual([]);
    expect(calendars.state().reads).toEqual([]);
  });

  it("adds a private link without keeping its address anywhere in the page", async () => {
    const { f, calendars } = setup();
    await calendars.load();
    expect(await calendars.addLink("Church office", SECRET)).toBeNull();
    expect(f.calls.find(c => c[0] === "calendar_link_add")![1]).toEqual({ label: "Church office", address: SECRET });
    const state = calendars.state();
    expect(state.links).toEqual([{ id: LINK_ID, label: "Church office", shown: "calendar.google.com/•••", missing: false }]);
    expect(state.reads[0]!.events.map(e => e.title)).toEqual(["Hospital visit"]);
    expect(state.reads[0]!.looks.map(l => l.title)).toEqual(["Elders meeting"]);
    expect(calendarsConnected(state)).toBe(true);
    expect(JSON.stringify(state)).not.toContain("private-0123456789abcdef");
  });

  it("says plainly why a link couldn't be added or read, and adds nothing", async () => {
    const { calendars } = setup({ calendar_link_add: new Error("not-on-the-internet") });
    await calendars.load();
    expect(await calendars.addLink("Office", "https://192.168.1.4/x.ics")).toBe(LINK_PROBLEMS["not-on-the-internet"]);
    expect(calendars.state().links).toEqual([]);
    const failing = setup({ calendar_links: [{ id: LINK_ID, label: "Office", shown: "calendar.google.com/•••", missing: false }], calendar_link_read: new Error("refused") });
    await failing.calendars.load();
    expect(failing.calendars.state().reads.map(r => [r.source.label, r.problem])).toEqual([["Office", LINK_PROBLEMS.refused]]);
  });

  it("forgets a removed link and everything read from it, even from a read still running", async () => {
    let release: (text: string) => void = () => undefined;
    const slow = new Promise<string>(resolve => { release = resolve; });
    const { calendars } = setup({ calendar_links: [{ id: LINK_ID, label: "Office", shown: "calendar.google.com/•••", missing: false }], calendar_link_read: () => slow });
    const loading = calendars.load();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await calendars.removeLink(LINK_ID)).toBeNull();
    release(ICS);
    await loading;
    expect(calendars.state().links).toEqual([]);
    expect(calendars.state().reads).toEqual([]);
  });

  it("reads again on Today only after a while", async () => {
    clockNow = "2026-11-16T14:00:00.000Z";
    const { f, calendars } = setup({ calendar_links: [{ id: LINK_ID, label: "Office", shown: "x/•••", missing: false }] });
    await calendars.load();
    const reads = () => f.calls.filter(c => c[0] === "calendar_link_read").length;
    expect(reads()).toBe(1);
    clockNow = "2026-11-16T14:10:00.000Z";
    await calendars.readIfOld();
    expect(reads()).toBe(1);
    clockNow = "2026-11-16T14:16:00.000Z";
    await calendars.readIfOld();
    expect(reads()).toBe(2);
    clockNow = "2026-11-16T14:00:00.000Z";
  });

  it("goes back to the button when macOS's question was never answered, instead of saying this copy can't read calendars", async () => {
    // Live run 2026-11-16: the question sat unanswered for five minutes, the ask gave up, and Settings was left
    // on "can't be read by this copy of Ozzie" with no way to ask again.
    for (const ask of [new Error("timeout"), "not-available"]) {
      const { f, calendars } = setup({ calendar_apple_ask: ask });
      await calendars.load();
      await calendars.connectApple();
      expect(f.calls.map(c => c[0]).slice(-2)).toEqual(["calendar_apple_ask", "calendar_apple_status"]);
      expect(calendars.state()).toMatchObject({ access: "not-determined", asking: false });
    }
    // A copy that really can't read calendars still says so.
    const { calendars } = setup({ calendar_apple_ask: "not-available", calendar_apple_status: "not-available" });
    await calendars.load();
    await calendars.connectApple();
    expect(calendars.state().access).toBe("not-available");
  });

  it("checks nothing when the window comes forward for a leader who never asked (review J, L2)", async () => {
    // Every account that never asked reads "not-determined"; coming forward must not start the helper for each one.
    const { f, calendars } = setup();
    await calendars.load();
    f.answers.calendar_apple_status = "full";
    const before = f.calls.length;
    await calendars.refreshAccess();
    await calendars.refreshAccess();
    expect(f.calls.length).toBe(before);
    expect(calendars.state().access).toBe("not-determined");
  });

  it("picks up macOS's answer when the window comes forward after an ask that came back undecided, without asking again", async () => {
    for (const ask of ["not-determined", new Error("timeout")]) {
      const { f, calendars } = setup({ calendar_apple_ask: ask });
      await calendars.load();
      await calendars.connectApple();
      expect(calendars.state()).toMatchObject({ access: "not-determined", asking: false });
      // Still undecided when the window first comes forward: checked again the next time too.
      let before = f.calls.length;
      await calendars.refreshAccess();
      expect(f.calls.slice(before).map(c => c[0])).toEqual(["calendar_apple_status"]);
      f.answers.calendar_apple_status = "full";
      before = f.calls.length;
      await calendars.refreshAccess();
      expect(f.calls.slice(before).map(c => c[0])).toEqual(["calendar_apple_status", "calendar_apple_calendars"]);
      expect(calendars.state()).toMatchObject({ access: "full" });
      expect(calendars.state().calendars?.map(c => c.title)).toEqual(["Church", "Home"]);
      // Decided now: nothing is asked of native code again, and macOS's question was asked only from the click.
      const after = f.calls.length;
      await calendars.refreshAccess();
      expect(f.calls.length).toBe(after);
      expect(f.calls.filter(c => c[0] === "calendar_apple_ask")).toHaveLength(1);
    }
  });

  it("checks nothing when the window comes forward while an ask is still waiting on the person", async () => {
    let answer: (access: string) => void = () => undefined;
    let asks = 0;
    const { f, calendars } = setup({
      calendar_apple_ask: () => ++asks === 1 ? "not-determined" : new Promise<string>(resolve => { answer = resolve; }),
    });
    await calendars.load();
    // The first ask came back undecided, so coming forward would check; the second is still open.
    await calendars.connectApple();
    const asking = calendars.connectApple();
    expect(calendars.state().asking).toBe(true);
    const before = f.calls.length;
    await calendars.refreshAccess();
    expect(f.calls.length).toBe(before);
    answer("full");
    await asking;
    expect(calendars.state()).toMatchObject({ access: "full", asking: false });
    const after = f.calls.length;
    await calendars.refreshAccess();
    expect(f.calls.length).toBe(after);
  });

  it("calls only the calendar commands", async () => {
    const { f, calendars } = setup();
    await calendars.load();
    await calendars.connectApple();
    await calendars.choose(["CAL-1", "CAL-2"]);
    await calendars.addLink("Office", SECRET);
    await calendars.read();
    await calendars.removeLink(LINK_ID);
    await calendars.stopApple();
    await calendars.forgetAllLinks();
    expect(new Set(f.calls.map(c => c[0])).size).toBe(CALENDAR_COMMANDS.length);
    for (const [command] of f.calls) expect(CALENDAR_COMMANDS).toContain(command);
  });

  it("keeps the choice native code answers with, and the earlier one when native refuses (review C, L8)", async () => {
    const { calendars } = setup({ calendar_apple_status: "full" });
    await calendars.load();
    await calendars.choose(["CAL-1", "CAL-1"]);
    expect(calendars.state().chosen).toEqual(["CAL-1"]);
    const refusing = setup({ calendar_apple_status: "full", calendar_apple_choose: new Error("invalid-input") });
    await refusing.calendars.load();
    await refusing.calendars.choose(["A\n1"]);
    expect(refusing.calendars.state().chosen).toEqual([]);
  });

  it("gives up on a calendar that never answers, so the others and Apple Calendar are still read (review C, M1)", async () => {
    const { calendars } = setup({
      calendar_apple_status: "full", calendar_apple_chosen: () => ["CAL-1"],
      calendar_links: [{ id: LINK_ID, label: "Stuck", shown: "x/\u2022\u2022\u2022", missing: false }, { id: "b1b2c3d4e5f60718", label: "Fine", shown: "y/\u2022\u2022\u2022", missing: false }],
      calendar_link_read: (args: { id: string }) => args.id === LINK_ID ? new Promise(() => undefined) : ICS,
    }, 60);
    await calendars.load();
    const state = calendars.state();
    expect(state.reading).toBe(false);
    expect(state.reads.map(r => [r.source.label, r.problem])).toEqual([
      ["Apple Calendar on this Mac", null], ["Stuck", LINK_PROBLEMS.timeout], ["Fine", null],
    ]);
    // A later read isn't held up either.
    await calendars.read();
    expect(calendars.state().reading).toBe(false);
  });

  it("looks problems up without prototypes, says when the list of links can't be read, and cleans names (review C, M3, L1, L6)", async () => {
    for (const code of ["constructor", "toString", "__proto__", "hasOwnProperty", 42, null]) expect(linkProblem(code)).toBe(LINK_PROBLEMS.unavailable);
    const unreadable = setup({ calendar_links: new Error("list-unreadable") });
    await unreadable.calendars.load();
    expect(unreadable.calendars.state().linksProblem).toBe(LINK_PROBLEMS["list-unreadable"]);
    expect(LINK_PROBLEMS["list-unreadable"]).toContain("nothing was removed");
    const names = setup({
      calendar_apple_status: "full",
      calendar_apple_calendars: { access: "full", calendars: [{ id: "CAL-1", title: "Church\u202E staff\u200B", account: "\u2066pastor@fictional.example\u2069" }] },
      calendar_links: [{ id: LINK_ID, label: "Office\u202Eecif", shown: "calendar.google.com/\u2022\u2022\u2022", missing: false }],
    });
    await names.calendars.load();
    expect(names.calendars.state().calendars).toEqual([{ id: "CAL-1", title: "Church staff", account: "pastor@fictional.example" }]);
    expect(names.calendars.state().links![0]!.label).toBe("Officeecif");
  });

  it("leaves the fictional email import out of Ask once a calendar is connected, as Today does (review C, L11)", () => {
    const snapshot = { capture: nov22Capture(), fictional: true, rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, decisions: [], status: null, configured: false, now: "2026-11-20T15:05:00Z" };
    expect(buildHarnessData(snapshot).attention).not.toBeNull();
    expect(buildHarnessData({ ...snapshot, fictionalImport: false }).attention).toBeNull();
  });
});

const office = { kind: "link" as const, id: LINK_ID, label: "Church office" };
const read = (source: CalendarRead["source"], events: Partial<CalendarRead["events"][number]>[], checked_at: string, more: Partial<CalendarRead> = {}): CalendarRead => ({
  source, checked_at, problem: null, truncated: false, looks: [], ...more,
  events: events.map((e, i) => ({ key: `${source.id}-${i}`, title: "Event", location: null, status: "confirmed", free: false, uncertain: null,
    time: { all_day: false, start: "2026-11-17T14:00:00.000Z", end: "2026-11-17T15:00:00.000Z" }, ...e })),
});
const now = "2026-11-16T14:00:00.000Z";
const reads = [
  read(APPLE_SOURCE, [
    { title: "Staff meeting", location: "Office" },
    { title: "<a href=\"https://fictional.example\">Click</a>", time: { all_day: false, start: "2026-11-16T15:00:00.000Z", end: "2026-11-16T15:30:00.000Z" } },
    { title: "Thanksgiving week", time: { all_day: true, start_date: "2026-11-23", end_date: "2026-11-28" }, free: true },
  ], "2026-11-16T14:00:00.000Z"),
  read(office, [
    { title: "Hospital visit", time: { all_day: false, start: "2026-11-17T14:30:00.000Z", end: "2026-11-17T15:30:00.000Z" } },
    { title: "Coffee", status: "tentative", time: { all_day: false, start: "2026-11-18T14:00:00.000Z", end: "2026-11-18T15:00:00.000Z" } },
    { title: "Lunch", time: { all_day: false, start: "2026-11-18T14:30:00.000Z", end: "2026-11-18T15:30:00.000Z" } },
  ], "2026-11-16T13:58:00.000Z", { looks: [{ title: "Elders meeting", reason: "It repeats monthly, which Ozzie can't work out yet, so it may fall in these days." }] }),
];
const group = (r: readonly CalendarRead[] = reads) => renderToStaticMarkup(React.createElement(CalendarGroup, { reads: r, now, zone }));

describe("On your calendar, on Today", () => {
  it("calls out two things at the same time first, as facts with their calendars and check times", () => {
    const html = group();
    const words = text(html);
    expect(words).toContain("On your calendar 6 events");
    expect(words).toContain("Needs a decision");
    expect(words).toContain("Two things at the same time");
    expect(words).toContain("“Staff meeting” (9:00 AM – 10:00 AM) and “Hospital visit” (9:30 AM – 10:30 AM) overlap from 9:30 AM to 10:00 AM.");
    expect(words).toContain("Why I flagged this");
    expect(words).toContain("Read from Apple Calendar on this Mac at 9:00 AM and “Church office” at 8:58 AM.");
    expect(words).toContain("Ozzie only reads your calendars, and what's on them stays on this Mac.");
    expect(html.indexOf("Two things at the same time")).toBeLessThan(html.indexOf("cal-day-h"));
  });

  it("labels an overlap with a tentative event, and what Ozzie couldn't work out, as worth a look", () => {
    const words = text(group());
    expect(words).toContain("Worth a look Wednesday, November 18 · 9:30 AM – 10:00 AM");
    expect(words).toContain("“Coffee” is marked tentative.");
    expect(words).toContain("“Elders meeting” on “Church office”: It repeats monthly, which Ozzie can't work out yet, so it may fall in these days.");
  });

  it("lists the days with their events, all-day first, and says which days are empty", () => {
    const words = text(group());
    expect(words).toContain("Today, Monday, November 16");
    expect(words).toContain("Tomorrow, Tuesday, November 17");
    expect(words).toContain("9:00 AM – 10:00 AM Staff meeting · Office Apple Calendar on this Mac");
    expect(words).toContain("All day Thanksgiving week Free");
    expect(words).toContain("Nothing on your calendar Thursday, Friday, Saturday and Sunday.");
  });

  it("shows calendar text as plain text: never markup, never a link", () => {
    const html = group();
    expect(html).toContain("&lt;a href=&quot;https://fictional.example&quot;&gt;Click&lt;/a&gt;");
    expect(html).not.toMatch(/<a[\s>]/u);
  });

  it("says when a calendar couldn't be read, and that it hasn't read anything yet", () => {
    const failed = [read(APPLE_SOURCE, [{ title: "Staff meeting" }], now), { ...read(office, [], "2026-11-16T13:58:00.000Z"), problem: LINK_PROBLEMS.unreachable }];
    expect(text(group(failed))).toContain(`Couldn't read “Church office” at 8:58 AM. ${LINK_PROBLEMS.unreachable}`);
    expect(text(group([]))).toContain("Nothing read from your calendars yet.");
  });

  it("shows the part of an event that falls on each day", () => {
    const e = (start: string, end: string) => ({ key: "k", title: "x", location: null, status: "confirmed" as const, free: false, uncertain: null, sources: [APPLE_SOURCE], time: { all_day: false as const, start, end } });
    expect(timeOnDay(e("2026-11-17T03:00:00.000Z", "2026-11-17T07:00:00.000Z"), "2026-11-16", zone)).toBe("From 10:00 PM");
    expect(timeOnDay(e("2026-11-17T03:00:00.000Z", "2026-11-17T07:00:00.000Z"), "2026-11-17", zone)).toBe("Until 2:00 AM");
    expect(timeOnDay(e("2026-11-17T05:00:00.000Z", "2026-11-18T05:00:00.000Z"), "2026-11-17", zone)).toBe("12:00 AM – 12:00 AM");
    expect(timeOnDay(e("2026-11-17T14:00:00.000Z", "2026-11-17T14:00:00.000Z"), "2026-11-17", zone)).toBe("9:00 AM");
    expect(dayLabel("2026-11-18", "2026-11-16")).toBe("Wednesday, November 18");
  });

  it("replaces the fictional example on Today once a calendar is connected", () => {
    const store = memory();
    const page = (props: Partial<Parameters<typeof TodayPage>[0]>) => text(renderToStaticMarkup(React.createElement(TodayPage, { brief: null, onSunday: () => undefined, now, zone, store, ...props })));
    const withExample = page({ example: true });
    expect(withExample).toContain("Fictional import");
    expect(withExample).not.toContain("On your calendar");
    const withCalendar = page({ example: false, calendar: { reads, reading: false } });
    expect(withCalendar).toContain("On your calendar");
    expect(withCalendar).not.toContain("Fictional import");
    expect(withCalendar).not.toContain("Harbor Example Church");
  });
});

describe("Settings: Calendars", () => {
  const settings = async (answers: Record<string, unknown>, act?: (c: ReturnType<typeof setup>["calendars"]) => Promise<unknown>) => {
    const { calendars } = setup(answers);
    await calendars.load();
    if (act) await act(calendars);
    return renderToStaticMarkup(React.createElement(CalendarSettings, { calendars }));
  };

  it("offers to read Apple Calendar only on the person's click, saying macOS asks once and Ozzie only reads", async () => {
    const words = text(await settings({}));
    expect(words).toContain("Calendars Reads only.");
    expect(words).toContain("Let Ozzie read my calendar");
    expect(words).toContain("macOS asks once. Choose “Allow Full Access”: macOS calls it full access, but Ozzie only reads.");
    expect(words).toContain("See how this works");
    for (const line of CALENDARS_HOW) expect(words).toContain(line);
  });

  it("lists the calendars to choose from, none chosen until the person chooses", async () => {
    const html = await settings({ calendar_apple_status: "full" });
    const words = text(html);
    expect(words).toContain("Which calendars Ozzie reads None until you choose. iCloud Church Home");
    expect(html.match(/type="checkbox"/gu)).toHaveLength(2);
    expect(html).not.toMatch(/checked=""/u);
    const chosen = text(await settings({ calendar_apple_status: "full" }, c => c.choose(["CAL-1"])));
    expect(chosen).toContain("Last read at");
    expect(chosen).toContain("Stop reading Apple Calendar");
  });

  it("says what to do when macOS said no", async () => {
    expect(text(await settings({ calendar_apple_status: "denied" }))).toContain("open System Settings, then Privacy & Security, then Calendars, and turn on Ozzie");
    expect(text(await settings({ calendar_apple_status: "write-only" }))).toContain("choose Full Access for Ozzie");
  });

  it("shows a private link by its label and host only, with a way to stop reading it", async () => {
    const html = await settings({}, c => c.addLink("Church office", SECRET));
    const words = text(html);
    expect(words).toContain("Church office calendar.google.com/••• Last read at");
    expect(words).toContain("Stop reading this calendar");
    expect(html).not.toContain("private-0123456789abcdef");
    expect(html).not.toContain("fictional%40example.org");
    expect(html).toContain("type=\"password\"");
    expect(words).toContain("Add this calendar");
  });

  it("uses plain words: no product-internal terms, and buttons that say what happens", async () => {
    const all = [text(group()), text(await settings({ calendar_apple_status: "full" }, c => c.addLink("Office", SECRET))), text(await settings({}))].join(" ");
    expect(all).not.toMatch(/\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|approve|block|sync(?:ed|ing)?|token|api)\b/iu);
    expect(all).not.toMatch(/\b(?:at risk|drifting)\b/iu);
  });
});

describe("review C2: links that can't be read", () => {
  const settingsOf = (calendars: ReturnType<typeof setup>["calendars"]) => renderToStaticMarkup(React.createElement(CalendarSettings, { calendars }));

  it("offers to forget all private links when the list can't be read, and starts empty after (N1)", async () => {
    let unreadable = true;
    const { f, calendars } = setup({
      calendar_links: () => unreadable ? Promise.reject("list-unreadable") : [],
      calendar_links_forget_all: () => { unreadable = false; return null; },
    });
    await calendars.load();
    expect(calendars.state().linksUnreadable).toBe(true);
    const before = text(settingsOf(calendars));
    expect(before).toContain(LINK_PROBLEMS["list-unreadable"]);
    expect(before).toContain("Forget all private calendar links");
    expect(before).not.toContain("Add this calendar");
    expect(await calendars.forgetAllLinks()).toBeNull();
    expect(f.calls.filter(c => c[0] === "calendar_links_forget_all")).toHaveLength(1);
    expect(calendars.state()).toMatchObject({ links: [], linksProblem: null, linksUnreadable: false });
    const after = text(settingsOf(calendars));
    expect(after).toContain("Add this calendar");
    expect(after).not.toContain("Forget all private calendar links");
  });

  it("shows an entry this version can't read with its own remove button, and never reads or counts it (N1)", async () => {
    const unusable = { id: "unusable-0", label: "", shown: "", missing: false, unusable: true };
    const { f, calendars } = setup({ calendar_links: [unusable] });
    await calendars.load();
    expect(f.calls.some(c => c[0] === "calendar_link_read")).toBe(false);
    expect(calendarsConnected(calendars.state())).toBe(false);
    const words = text(settingsOf(calendars));
    expect(words).toContain("A link this version of Ozzie can't read");
    expect(words).toContain("Remove this link");
    expect(words).toContain("Add this calendar");
    expect(await calendars.removeLink("unusable-0")).toBeNull();
    expect(f.calls.find(c => c[0] === "calendar_link_remove")![1]).toEqual({ id: "unusable-0" });
    expect(calendars.state().links).toEqual([]);
  });
});

describe("the calendar bridge to native code", () => {
  it("refuses any command not in its list before anything is sent, however the name was made (review S2, finding 1)", async () => {
    const sent = vi.mocked(tauri);
    sent.mockClear();
    for (const command of ["notify_ozzie", ["notify", "ozzie"].join("_"), "calendar_x", "", "church_sources", "toString", "__proto__"]) expect(allowed(command), command).toBe(false);
    for (const command of CALENDAR_COMMANDS) expect(allowed(command), command).toBe(true);
    // Review U, finding 1: literal comparisons, so widening a built-in's prototype widens nothing.
    const has = Set.prototype.has;
    try {
      Set.prototype.has = () => true;
      expect(allowed(["notify", "ozzie"].join("_"))).toBe(false);
    } finally { Set.prototype.has = has; }
    expect(sent).not.toHaveBeenCalled();
  });
});
