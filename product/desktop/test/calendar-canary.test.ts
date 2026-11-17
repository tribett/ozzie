// Review C, M4: calendar text stays on this Mac, shown at run time and not only by imports
// (core/test/calendar/stays-on-this-mac.test.ts). With the leader's calendars read and holding unique markers (an
// event title and place, an Apple calendar's name, a private link's label, a title in the link's text), every way
// something leaves Ozzie runs for real in the same process: Ask through the real harness (a question and a drafted
// note), rewording a note, the copy for other AI apps, the copy Siri and Shortcuts answer from (and the answer they
// would hear), both notices, and Today's briefing script. No marker is in any
// model request, any argument of a native command that sends or saves, or the briefing. App.tsx and today-page.tsx
// are also held to passing calendar state only into the calendar group, Settings, and whether a calendar is connected.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ calls: [] as [string, unknown][] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args?: unknown) => { native.calls.push([command, args]); return command === "reword_draft" ? "Hi [Volunteer A], could you help?" : null; }),
}));

import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { buildRewordRequest, templateDraft } from "../../../core/src/draft-request.js";
import { calendarsConnected, createCalendars, type Invoke } from "../src/calendars.js";
import { askOzzie, buildHarnessData, createAppHarness } from "../src/harness-bridge.js";
import { model } from "../src/model.js";
import { syncShared } from "../src/share-check.js";
import { syncShortcuts } from "../src/siri-shortcuts.js";
import { sharedCheckText } from "../../../core/mcp/snapshot.js";
import { shortcutsAnswer } from "../../../core/mcp/shortcuts.js";
import type { ToolEnvelope } from "../../../core/src/harness/contract.js";
import { notifySundayAttention } from "../src/proactive.js";
import { background } from "../src/background.js";
import { TodayPage } from "../src/today-page.js";
import { draftTurns, greeterTurns, scripted, RULES } from "./harness-fakes.js";

const MARKERS = ["QZX-TITLE-4417", "QZX-PLACE-4417", "QZX-CALNAME-4417", "QZX-LABEL-4417", "QZX-ICS-4417", "QZX-ACCOUNT-4417"];
const now = "2026-11-20T15:05:00.000Z";
const zone = "America/Chicago";
const ICS = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:c@fictional.example", "SUMMARY:QZX-ICS-4417", "LOCATION:QZX-PLACE-4417",
  "DTSTART:20261121T150000Z", "DURATION:PT1H", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
const calendarInvoke: Invoke = (async (command: string) => {
  switch (command) {
    case "calendar_apple_status": return "full";
    case "calendar_apple_calendars": return { access: "full", calendars: [{ id: "CAL-1", title: "QZX-CALNAME-4417", account: "QZX-ACCOUNT-4417" }] };
    case "calendar_apple_chosen": return ["CAL-1"];
    case "calendar_apple_events": return { access: "full", truncated: false, events: [
      { calendar: "CAL-1", id: "E1", title: "QZX-TITLE-4417", location: "QZX-PLACE-4417", start: "2026-11-21T15:30:00Z", end: "2026-11-21T16:30:00Z", all_day: false, status: "confirmed", free: false },
    ] };
    case "calendar_links": return [{ id: "a1b2c3d4e5f60718", label: "QZX-LABEL-4417", shown: "calendar.fictional.example/•••", missing: false }];
    case "calendar_link_read": return ICS;
    default: throw new Error(`not a calendar command: ${command}`);
  }
}) as Invoke;
/** Every native command that sends something off this Mac, shows a notice, or saves what another app reads. */
const SENDING = new Set(["ask_ozzie", "reword_draft", "agent_step", "responsibility_agent_step", "share_last_check", "save_shortcuts_check", "notify_sunday_attention", "notify_ozzie", "managed_connect", "ledger_admit", "ledger_event", "ledger_transition"]);
const leaks = (value: unknown) => { const text = JSON.stringify(value) ?? ""; return MARKERS.filter(m => text.includes(m)); };

describe("calendar text at run time", async () => {
  // The leader's calendars, read and held in memory as the app holds them.
  const calendars = createCalendars({ invoke: calendarInvoke, now: () => now, zone: () => zone });
  await calendars.load();
  const state = calendars.state();
  const capture = withFictionalOperations(nov22Capture());
  const brief = buildSundayBrief(capture, RULES, now);
  // HarnessData as App builds it while a calendar is connected (App.tsx: fictionalImport is !calendarsConnected).
  const data = buildHarnessData({ capture, fictional: true, rules: RULES, decisions: [], status: null, configured: false, now, fictionalImport: !calendarsConnected(state) });
  const skills = await bundledSkills();

  it("has the markers in what it read (so the checks below aren't empty)", () => {
    expect(calendarsConnected(state)).toBe(true);
    const held = JSON.stringify([state.reads, state.calendars, state.links]);
    for (const m of MARKERS) expect(held, m).toContain(m);
  });

  it("never puts them in a model request from Ask, for a question or a drafted note", async () => {
    const requests: unknown[] = [];
    for (const [turns, question] of [[greeterTurns, "Who could cover Greeter?"], [draftTurns, "Draft a note asking someone to cover Greeter."]] as const) {
      const { model: step, requests: sent } = scripted([...turns]);
      const harness = createAppHarness({ workspace_id: "fictional", data, skills, session: new HarnessSession(), loop: "ts", step });
      await askOzzie(harness, question, { skills });
      expect(sent.length).toBeGreaterThan(0);
      requests.push(...sent);
    }
    expect(leaks(requests)).toEqual([]);
  });

  it("never puts them in a reworded note, the copy for other AI apps, a notice or Today's briefing", async () => {
    native.calls.length = 0;
    const finding = brief.findings.find(f => (f.people?.suggestions.length ?? 0) > 0)!;
    const ctx = { finding, person_id: finding.people!.suggestions[0]!.person_id };
    await model.reword(buildRewordRequest(templateDraft(ctx, capture.names), "warmer", capture.names));
    const shared: [string, unknown][] = [];
    const record: Invoke = (async (command: string, args?: unknown) => { shared.push([command, args]); return null; }) as Invoke;
    await syncShared(data, new HarnessSession(), { organization: "", status: null }, record);
    await syncShortcuts(data, new HarnessSession(), { organization: "", status: null }, record);
    await notifySundayAttention();
    await background.notify("briefing-ready");
    const sent = [...native.calls, ...shared].filter(([command]) => SENDING.has(command));
    expect(sent.map(([command]) => command).sort()).toEqual(["notify_ozzie", "notify_sunday_attention", "reword_draft", "save_shortcuts_check", "share_last_check"]);
    expect(leaks(sent)).toEqual([]);
    // What Siri would say from that copy, built as the helper builds it.
    const saved = shared.find(([command]) => command === "save_shortcuts_check")![1] as { envelopes: string[] };
    const heard = shortcutsAnswer("sunday", { on: true, text: sharedCheckText(saved.envelopes.map(e => JSON.parse(e) as ToolEnvelope), [], now, "B4K7Q2X9M3T8"),
      nowMs: Date.parse(now), timeZone: zone });
    expect(heard).toMatch(/^This is Ozzie's fictional example/u);
    expect(leaks(heard)).toEqual([]);

    const html = renderToStaticMarkup(React.createElement(TodayPage, {
      brief, onSunday: () => undefined, now, zone, example: false, store: { get: () => null, set: () => undefined },
      calendar: { reads: state.reads, reading: false },
    }));
    const group = /<section class="today-group today-calendar"[\s\S]*?<\/section>/u.exec(html)?.[0] ?? "";
    expect(leaks(group)).toEqual(["QZX-TITLE-4417", "QZX-PLACE-4417", "QZX-LABEL-4417", "QZX-ICS-4417"]);
    expect(leaks(html.replace(group, ""))).toEqual([]);
    expect(html).toContain("listen-script");
  });
});

describe("App and Today pass calendar state only where it is shown", () => {
  const code = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").split("\n").filter(l => !/^\s*(?:\/\/|\*|\/\*\*)/u.test(l));

  it("App: the calendar group on Today, Settings, and whether a calendar is connected", () => {
    const allowed = [
      /^ {2}const \[calendars\] = useState\(\(\) => createCalendars\(\)\);$/u,
      /^ {2}const calendarState = useCalendarState\(calendars\);$/u,
      /^ {6}if \(!info\.probe && !update\?\.probe\) void calendars\.load\(\);$/u,
      /^ {2}\}, \[calendars\]\);$/u,
      // Coming forward re-reads only what macOS has decided about access (calendars.ts refreshAccess): no calendar text.
      /^ {4}const forward = \(\) => \{ void calendars\.refreshAccess\(\); \};$/u,
      /^ {2}useEffect\(\(\) => \{ if \(page === "today" && visible\) void calendars\.readIfOld\(\); \}, \[page, visible, calendars, now\]\);$/u,
      /^ {2}const fictionalImport = !calendarsConnected\(calendarState\);$/u,
      // Never under the fictional example's band (audit item 2): the example is the whole of Today while it's on.
      /^ {10}calendar=\{!fictional && calendarsConnected\(calendarState\) \? \{ reads: calendarState\.reads, reading: calendarState\.reading, onSettings: \(\) => setPage\("connection"\) \} : null\} \/>\}$/u,
      /calendars=\{<CalendarSettings calendars=\{calendars\} \/>\}/u,
      /^import \{ calendarsConnected, createCalendars, useCalendarState \} from "\.\/calendars\.js";$/u,
    ];
    const uses = code("../src/App.tsx").filter(l => /\bcalendars?\b|calendarState|Calendar[A-Z]?\w*/u.test(l) && !/^import \{ CalendarSettings \}/u.test(l));
    for (const line of uses) expect(allowed.some(a => a.test(line)), line).toBe(true);
    expect(uses.length).toBeGreaterThanOrEqual(8);
  });

  it("Today: only into the calendar group", () => {
    const uses = code("../src/today-page.tsx").filter(l => /(?:^|[\s{(,])calendar(?:\s*=|\?:|\s*&&|\s*\?\.|\.\w)/u.test(l) && !l.startsWith("import "));
    const allowed = [
      /^ {2}feedback = null, example = false, church = null, calendar = null, regular = null, notConnected = null, asked = NO_ASKED, onSundayCard,$/u,
      /^ {2}calendar\?: \{ reads: readonly CalendarRead\[\]; reading: boolean; onSettings\?: \(\) => void \} \| null;$/u,
      /^ {4}\{calendar && <CalendarGroup reads=\{calendar\.reads\} now=\{now\} zone=\{zone\} reading=\{calendar\.reading\} onSettings=\{calendar\.onSettings\} \/>\}$/u,
    ];
    for (const line of uses) expect(allowed.some(a => a.test(line)), line).toBe(true);
    expect(uses).toHaveLength(3);
  });
});
