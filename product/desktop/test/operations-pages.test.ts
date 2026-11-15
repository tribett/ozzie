import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { SundayPage } from "../src/sunday-page.js";
import { RulesPage, withRoomRule } from "../src/rules-page.js";
import { ConnectionPage, grantedCopy } from "../src/connection-page.js";
import { connection, operationsAsked, type ConnectionStatus } from "../src/connection.js";
import { ActivityPage, activityLabel, activityOutcome } from "../src/activity-page.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { captureRooms, roomRules, sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { FICTIONAL_ROOM, withFictionalOperations, withFictionalOperationsOff } from "../../../core/src/fictional-operations.js";
import { nov22Capture, PEOPLE } from "../../../core/src/fictional-sunday.js";
import { KIDS_COLLECTIONS, OPERATIONS_COLLECTIONS, type SundayCapture, type SundayRules } from "../../../core/src/sunday-capture.js";

// Fictional fixed data only. The example is evaluated on the fictional church's Eastern time.
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|score|rank(ed|ing)?|at risk|drifting|log)\b/i;
function sunday(capture: SundayCapture, r = rules) {
  const operations: SundayOperations | null = sundayOperations(capture, r);
  return text(renderToStaticMarkup(React.createElement(SundayPage, {
    brief: buildSundayBrief(capture, r, capture.completed_at, true), names: capture.names, busy: false, problem: "", sender: "Pat", connected: false,
    hasRecording: false, configured: false, canReword: false, decisions: [], onDecisions: () => undefined, operations,
    onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
  })));
}
const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const status = (scopes?: ConnectionStatus["scopes"]): ConnectionStatus => ({ state: "connected", organization: "1001", checked_at_ms: 1, source: "native", problem: null, ...(scopes ? { scopes } : {}) });
const connectionPage = (s: ConnectionStatus | null) => text(renderToStaticMarkup(React.createElement(ConnectionPage, { status: s, settings, onSettings: () => {}, onStatus: () => {} })));

describe("Sunday page: rooms, follow-ups and group meetings from the example capture", () => {
  it("shows the real mapper's results with local names and labels, and what wasn't checked", () => {
    const capture = withFictionalOperations(nov22Capture());
    const t = sunday(capture);
    expect(t).toContain(`${capture.names[PEOPLE.lyricsPending]} has a group meeting at the same time.`);
    expect(t).toContain("while they're pending for Lyrics.");
    expect(t).toMatch(/has a group meeting at the same time\. .* Why I flagged this Groups Planning Center Checked /);
    expect(t).toContain("Sanctuary (fictional) has overlapping bookings from");
    expect(t).toContain("“Call a first-time guest” has no owner.");
    expect(t).toContain("Welcome follow-up (fictional)");
    expect(t).toContain("A room isn't set as not shared in Church rules, so overlaps there can't be confirmed.");
    // Unread parts are named under What I didn't check, not repeated as a vague uncertainty.
    expect(t).not.toContain("Part of the room and follow-up check couldn't be read.");
    expect(t).not.toContain("Whether overlapping room bookings were already worked out in Planning Center");
    expect(t).not.toContain("Groups events weren't part of this check.");
    expect(t).not.toContain("Room bookings and follow-ups weren't part of this check.");
    expect(t.replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
  });

  it("a Services-only connection says rooms and follow-ups weren't checked, and shows none of them", () => {
    const t = sunday(withFictionalOperationsOff(nov22Capture()));
    expect(t).toContain("Rooms and follow-ups weren't checked. Turn this on in Settings.");
    expect(t).toContain("Group meetings weren't checked either.");
    expect(t).not.toContain("No room overlaps");
    expect(t).not.toContain("has a group meeting");
    expect(t).not.toContain("Some Planning Center reads didn't complete");
    expect(t).not.toContain("Part of this Sunday couldn't be checked.");
  });

  it("a capture from before these reads existed keeps the earlier wording", () => {
    const t = sunday(nov22Capture());
    expect(t).toContain("Room bookings and follow-ups weren't part of this check.");
    expect(t).toContain("Groups events weren't part of this check.");
  });
});

describe("Church rules: rooms", () => {
  it("lists the rooms read, defaults to no rule, and stores a rule with the other rules", () => {
    const capture = withFictionalOperations(nov22Capture());
    const html = renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [], rooms: captureRooms(capture) }));
    expect(text(html)).toContain("Sanctuary (fictional)");
    expect(html).toMatch(/<option value="none" selected="">No rule set<\/option>/);
    const set = renderToStaticMarkup(React.createElement(RulesPage, { rules: { ...rules, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }] },
      onChange: () => undefined, positions: [], rooms: captureRooms(capture) }));
    expect(set).toMatch(/<option value="exclusive" selected="">Not shared<\/option>/);
    expect(set).toContain('value="30"');
    // Says what Ozzie does now: setup time and Calendar's own conflict records for not-shared rooms.
    expect(text(set)).toContain("For a room set as not shared, Ozzie counts its setup time before each booking and reads Calendar's own conflict records");
    expect(text(set)).not.toContain("can't yet read");
  });
  it("\"No rule set\" stores no rule, never a \"can be shared\" one; setup time belongs to a not-shared room (L4)", () => {
    const set = withRoomRule(rules, FICTIONAL_ROOM, { setup_minutes: 30 });
    expect(set.rooms).toEqual([{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }]);
    expect(withRoomRule(set, FICTIONAL_ROOM, null).rooms).toEqual([]);
    // A "no rule" entry an earlier version stored is no rule at all.
    const legacy = { ...rules, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: false, setup_minutes: 10 }] };
    expect(roomRules(legacy)).toEqual([]);
    const html = renderToStaticMarkup(React.createElement(RulesPage, { rules: legacy, onChange: () => undefined, positions: [], rooms: captureRooms(withFictionalOperations(nov22Capture())) }));
    expect(html).toMatch(/<option value="none" selected="">No rule set<\/option>/);
    expect(html).toMatch(/<input type="number"[^>]*disabled=""/);
    // And no "can be shared" rule reaches the check: the overlap there is one with no rule set.
    const overlap = sundayOperations(withFictionalOperations(nov22Capture()), legacy)!.result!.findings.find(f => f.kind === "room-overlap")!;
    expect(overlap.kind === "room-overlap" && [overlap.rule, overlap.label]).toEqual([null, "Worth a look"]);
  });
  it("says where rooms come from before any are read", () => {
    const t = text(renderToStaticMarkup(React.createElement(RulesPage, { rules, onChange: () => undefined, positions: [] })));
    expect(t).toContain("Your rooms show here after a Sunday check that includes rooms. Turn that on in Settings.");
  });
});

describe("Settings: opt in to rooms, follow-ups and group events", () => {
  beforeEach(() => invoke.mockReset());
  it("explains the access asked for and that Ozzie only reads", () => {
    const t = connectionPage(status("services"));
    expect(t).toContain("Also check rooms, follow-ups and group events");
    expect(t).toContain("asks Planning Center for Calendar, People and Groups access");
    expect(t).toContain("Planning Center grants each of those as read-and-write; Ozzie only reads");
    expect(t).toContain("Granted: Services only.");
    expect(t.replaceAll("Sign in", "")).not.toMatch(FORBIDDEN);
  });
  it("shows the granted set only once the connection is checked", () => {
    expect(grantedCopy(status("services-and-operations"))).toBe("Granted: Services, Calendar, People and Groups. Ozzie reads rooms, follow-ups and group events.");
    expect(grantedCopy(status())).toBe("What's granted shows here once the connection has been checked.");
    expect(grantedCopy(null)).toBe("What's granted shows here once the connection has been checked.");
    const on = connectionPage(status("services-and-operations"));
    expect(on).toContain("Sign in again with Services only");
    expect(on).not.toContain("Also check rooms, follow-ups and group events");
  });
  it("reconnects with operations only when asked; the default call is unchanged", async () => {
    invoke.mockResolvedValue(status());
    await connection.connect("fictional-client", "1001", true, true);
    await connection.connect("fictional-client", "1001", true);
    expect(invoke.mock.calls).toEqual([
      ["connect_planning_center", { clientId: "fictional-client", organization: "1001", registered: true, operations: true }],
      ["connect_planning_center", { clientId: "fictional-client", organization: "1001", registered: true }],
    ]);
  });
});

describe("What happened: the new reads", () => {
  it("names every operations read plainly and says when one wasn't asked", () => {
    for (const collection of OPERATIONS_COLLECTIONS) expect(activityLabel(collection)).not.toBe(collection);
    expect(activityOutcome("not-requested")).toBe("Not asked — turned off in Settings");
    const t = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: withFictionalOperationsOff(nov22Capture()) })));
    expect(t).toContain("Read room bookings for this Sunday");
    expect(t).toContain("Read one person's groups");
    expect(t).toContain("Not asked — turned off in Settings");
    expect(t).not.toMatch(/calendar_|people_workflow|groups_/);
    expect(activityLabel("organization")).toBe("Read the church's time zone");
  });
  it("names the kids rule's background-check read in words too, and later pages of a list without a raw offset", () => {
    for (const collection of KIDS_COLLECTIONS) expect(activityLabel(collection)).not.toBe(collection);
    expect(activityLabel("people_background_checks")).toBe("Read whether one person has a current background check");
    const c = nov22Capture();
    const paged: SundayCapture = { ...c, reads: c.reads.map((r, i) => i === 1 ? { ...r, offset: 25 } : r) };
    const t = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: paged })));
    expect(t).toContain("(continued)");
    expect(t).not.toMatch(/page from|\b25\b/);
  });
  it("says Planning Center didn't grant it when Ozzie asked and it granted Services only", async () => {
    expect(activityOutcome("not-requested", true)).toBe("Not asked — Planning Center didn't grant this");
    const t = text(renderToStaticMarkup(React.createElement(ActivityPage, { capture: withFictionalOperationsOff(nov22Capture()), notGranted: true })));
    expect(t).toContain("Not asked — Planning Center didn't grant this");
    expect(t).not.toContain("turned off in Settings");
    // The sign-in remembers on this Mac whether it asked.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    try {
      invoke.mockResolvedValue(status("services"));
      await connection.connect("fictional-client", "1001", true, true);
      expect(operationsAsked.get()).toBe(true);
      await connection.connect("fictional-client", "1001", true);
      expect(operationsAsked.get()).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });
});
