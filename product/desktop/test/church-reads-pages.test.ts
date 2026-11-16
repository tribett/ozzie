// People forms, Check-Ins and Registrations on Settings, Today, Sunday and Church rules: the grant as the webview reads
// it, each opt-in's plain-English explanation, the facts with source and check time, and the autopilot's name-free
// lines. Fictional fixed data only; every name and id is invented.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { connection, disconnectNote, granted, moreOf, operationsGranted, type ConnectionStatus } from "../src/connection.js";
import { ConnectionPage, grantedCopy } from "../src/connection-page.js";
import { MORE_COPY, moreStatus } from "../src/planning-center-more.js";
import { CheckInsSunday, ChurchReadsRules, ChurchReadsToday } from "../src/church-reads-view.js";
import { activityLabel } from "../src/activity-page.js";
import { churchLines, devChurchRules } from "../src/autopilot.js";
import { sundaySource } from "../src/sunday-source.js";
import { CHURCH_COLLECTIONS, type SundayCapture, type SundayRead, type SundayRules } from "../../../core/src/sunday-capture.js";
import { checkInsFacts, checkInsTarget } from "../../../core/src/church-reads/index.js";
import { correctionEntry } from "../../../core/src/finding-feedback.js";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&amp;", "&").replace(/\s+/g, " ");
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|scopes?|score|rank(ed|ing)?|at risk|drifting|log)\b/i;
const status = (scopes?: ConnectionStatus["scopes"]): ConnectionStatus => ({ state: "connected", organization: "1001", checked_at_ms: 1, source: "native", problem: null, ...(scopes ? { scopes } : {}) });
const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "1500", planId: "92902197" };
const base: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 0 };

const CHECKED = "2026-11-13T12:00:03.000Z";
const WINDOW = { starts_at: "2026-11-05T12:00:00Z", ends_at: "2026-11-13T12:00:00Z" };
const rel = (type: string, id: string) => ({ data: { type, id } });
const page = (data: unknown[], included?: unknown[]) => ({ data, ...(included ? { included } : {}), meta: { count: data.length, total_count: data.length } });
const read = (collection: string, body: SundayRead["body"] | undefined, extra: Partial<SundayRead> = {}, outcome = "ok"): SundayRead =>
  ({ collection, offset: 0, checked_at: CHECKED, outcome, ...(body ? { body } : {}), ...extra });
/** A fictional church in Chicago checked Friday, November 13: last Sunday's Nursery at 9:00, a watched form and two signups. */
function church(): SundayCapture {
  return {
    version: 1, kind: "live", organization: "1001", service_type_id: "10", plan_id: "20",
    started_at: "2026-11-13T12:00:00.000Z", completed_at: "2026-11-13T12:00:09.000Z",
    names: { "190": "Dana Fictional", "191": "Emery Fictional" }, forms: ["610"],
    labels: { "form:610": "Volunteer interest", "checkins_event:620": "Sunday Kids", "checkins_location:650": "Nursery", "signup:640": "Fall retreat", "signup:641": "Summer camp" },
    reads: [
      read("organization", { data: { type: "Organization", id: "1001", attributes: { time_zone: "America/Chicago" } } }),
      read("people_forms", page([{ type: "Form", id: "610", attributes: { archived: false } }])),
      read("people_form_submissions", page([
        { type: "FormSubmission", id: "700", attributes: { created_at: "2026-11-08T15:00:00Z" }, relationships: { form: rel("Form", "610"), person: rel("Person", "190") } },
        { type: "FormSubmission", id: "701", attributes: { created_at: "2026-11-10T15:00:00Z" }, relationships: { form: rel("Form", "610"), person: rel("Person", "191") } },
        { type: "FormSubmission", id: "702", attributes: { created_at: "2026-11-11T15:00:00Z" }, relationships: { form: rel("Form", "610") } }]),
      { form_id: "610", window: WINDOW }),
      read("checkins_events", page([{ type: "Event", id: "620", attributes: { archived_at: null } }])),
      read("checkins_locations", page([{ type: "Location", id: "650", attributes: { kind: "Location" }, relationships: { parent: { data: null } } }]), { checkins_event_id: "620" }),
      read("checkins_event_periods", page([{ type: "EventPeriod", id: "660", attributes: { starts_at: "2026-11-08T06:00:00Z", ends_at: "2026-11-09T06:00:00Z" },
        relationships: { event: rel("Event", "620") } }],
      [{ type: "EventTime", id: "630", attributes: { starts_at: "2026-11-08T15:00:00Z" }, relationships: { event: rel("Event", "620"), event_period: rel("EventPeriod", "660") } }]),
      { checkins_event_id: "620", window: WINDOW }),
      read("checkins_location_counts", page([{ type: "LocationEventTime", id: "670", attributes: { regular_count: 8, guest_count: 1, volunteer_count: 1 },
        relationships: { location: rel("Location", "650") } }]), { checkins_event_time_id: "630" }),
      read("registrations_signups", page([
        { type: "Signup", id: "640", attributes: { archived: false, closed: false, close_at: "2026-11-21T00:00:00Z", maximum_capacity: 40 } },
        { type: "Signup", id: "641", attributes: { archived: false, closed: true, open_at: "2026-11-23T14:00:00Z", close_at: null, maximum_capacity: null } }])),
      read("registrations_attendees", page(Array.from({ length: 31 }, (_, i) => ({ type: "Attendee", id: `90${i}`, attributes: { active: true, canceled: false, waitlisted: false } }))),
        { signup_id: "640" }),
    ],
  };
}
const kids = (more: Partial<SundayRules> = {}): SundayRules =>
  ({ ...base, kidsTeams: [{ team_id: "71", min_confirmed: 2, name: "Nursery" }], checkIns: { rooms: [{ location_id: "650", team_id: "71" }] }, forms: { on: true, watched: ["610"] }, ...more });
const NOW = "2026-11-13T12:05:00Z";

describe("The grant as the webview reads it", () => {
  it("reads the eight spellings native writes and nothing else", () => {
    expect(granted(status("services"))).toEqual({ operations: false, checkIns: false, registrations: false });
    expect(granted(status("services-and-operations+check-ins+registrations"))).toEqual({ operations: true, checkIns: true, registrations: true });
    expect(granted(status("services+registrations"))).toEqual({ operations: false, checkIns: false, registrations: true });
    expect(operationsGranted(status("services-and-operations+check-ins"))).toBe(true);
    expect(granted(status())).toBeNull();
    for (const bad of ["services+registrations+check-ins", "services+giving", "everything", "services+check-ins+check-ins"]) {
      expect(granted({ scopes: bad as NonNullable<ConnectionStatus["scopes"]> })).toBeNull();
    }
    // The operations line and its button read the operations part of any spelling.
    expect(grantedCopy(status("services-and-operations+check-ins"))).toBe("Granted: Services, Calendar, People and Groups. Ozzie reads rooms, follow-ups and group events.");
    expect(grantedCopy(status("services+check-ins"))).toBe("Granted: Services only. Rooms, follow-ups and group events aren't checked.");
  });

  it("changing one choice keeps the others already granted", () => {
    expect(moreOf(status("services-and-operations+registrations"))).toEqual({ checkIns: false, registrations: true });
    expect(moreOf(null)).toEqual({ checkIns: false, registrations: false });
  });
});

describe("Settings: forms, check-ins and signups", () => {
  beforeEach(() => invoke.mockReset());
  const settingsPage = (s: ConnectionStatus | null) => text(renderToStaticMarkup(React.createElement(ConnectionPage, { status: s, settings, onSettings: () => {}, onStatus: () => {} })));

  it("explains each choice in plain English and that Ozzie only reads counts", () => {
    const t = settingsPage(status("services"));
    for (const copy of [MORE_COPY.forms.body, MORE_COPY.checkIns.body, MORE_COPY.registrations.body]) expect(t).toContain(copy);
    expect(t).toContain("it never reads children's names or who checked in");
    expect(t).toContain("It never reads the answers people gave.");
    expect(t).toContain("Planning Center grants it as read-and-write, and Ozzie only reads");
    expect(t).toContain("Also read Check-Ins counts");
    expect(t).toContain("Also read signup counts");
    expect(t.replaceAll("Sign in", "").replaceAll("sign in", "")).not.toMatch(FORBIDDEN);
  });

  it("says what's allowed from the grant, and not connected for this yet until allowed", () => {
    expect(moreStatus(status("services"))).toEqual({
      forms: "Needs People: turn on rooms, follow-ups and group events above.", checkIns: "Not connected for this yet.", registrations: "Not connected for this yet.",
    });
    expect(moreStatus(status("services-and-operations+check-ins"))).toEqual({
      forms: "People is allowed. Choose which forms to watch on Church rules.", checkIns: "Allowed: Ozzie reads Check-Ins counts on each check.", registrations: "Not connected for this yet.",
    });
    expect(moreStatus(status()).checkIns).toBe("What's allowed shows here once the connection has been checked.");
    const on = settingsPage(status("services+check-ins+registrations"));
    expect(on).toContain("Stop reading Check-Ins counts");
    expect(on).toContain("Stop reading signup counts");
  });

  it("after Disconnect removed a sign-in naming another church, says it may still be active at Planning Center", () => {
    const removed: ConnectionStatus = { state: "disconnected", organization: "1001", checked_at_ms: null, source: "native", problem: "organization-unverified" };
    const note = "Ozzie removed the saved sign-in from this Mac but didn't sign out of it at Planning Center, because it named another church. " +
      "It may stay active at Planning Center until it expires or an administrator disconnects it there (Account Settings, Integrations).";
    expect(disconnectNote(removed)).toBe(note);
    expect(settingsPage(removed)).toContain(note);
    // An ordinary disconnect, or a failed sign-in, says nothing of the kind.
    expect(disconnectNote({ ...removed, problem: null })).toBe("");
    expect(disconnectNote({ ...removed, state: "failed" })).toBe("");
  });

  it("asks Planning Center for Check-Ins or Registrations only when chosen; the default calls are unchanged", async () => {
    invoke.mockResolvedValue(status());
    await connection.connect("fictional-client", "1001", true);
    await connection.connect("fictional-client", "1001", true, true, { checkIns: true });
    await connection.connectApp(false, { registrations: true });
    await connection.connectApp();
    expect(invoke.mock.calls).toEqual([
      ["connect_planning_center", { clientId: "fictional-client", organization: "1001", registered: true }],
      ["connect_planning_center", { clientId: "fictional-client", organization: "1001", registered: true, operations: true, checkIns: true }],
      ["connect_planning_center_app", { registrations: true }],
      ["connect_planning_center_app", {}],
    ]);
  });

  it("the check sends watched forms only once forms are on, and the Check-Ins event once chosen", async () => {
    invoke.mockResolvedValue(church());
    await sundaySource.check("1500", "92902197", base);
    await sundaySource.check("1500", "92902197", { ...base, forms: { on: true, watched: [] } });
    await sundaySource.check("1500", "92902197", kids());
    await sundaySource.check("1500", "92902197", kids({ checkIns: { event_id: "620" } }));
    expect(invoke.mock.calls.map(c => c[1])).toEqual([
      { serviceTypeId: "1500", planId: "92902197" },
      { serviceTypeId: "1500", planId: "92902197", formIds: [] },
      { serviceTypeId: "1500", planId: "92902197", kidsTeamIds: ["71"], formIds: ["610"] },
      { serviceTypeId: "1500", planId: "92902197", kidsTeamIds: ["71"], formIds: ["610"], checkinsEventId: "620" },
    ]);
  });
});

describe("Today, Sunday and Church rules", () => {
  const today = (capture: SundayCapture | null, rules: SundayRules) =>
    text(renderToStaticMarkup(React.createElement(ChurchReadsToday, { capture, rules, names: capture?.names ?? {}, now: NOW, feedback: { entries: [], onEntries: () => {} } })));

  it("Today shows each fact with its source and check time; only what was flagged says why, the rest where it comes from", () => {
    const t = today(church(), kids());
    expect(t).toContain("From Planning Center this week");
    // The Check-Ins comparison is Worth a look, never a rule breach.
    expect(t).toContain("Worth a look Nursery · 9:00 AM Nursery at 9:00 AM on Sunday, November 8: 1 volunteer checked in, fewer than your rule's 2");
    expect(t).not.toContain("Below your Church rules");
    expect(t).toContain("Sunday, November 8 How many checked in, by room");
    expect(t).toContain("Nursery: 9 checked in (8 regular, 1 guest) and 1 volunteer");
    expect(t).toContain("Volunteer interest: 3 new submissions since Thursday, November 5 at 6:00 AM");
    // "Why I flagged this" only on the flagged card; plain facts say where they come from.
    expect(t.split("Why I flagged this").length - 1).toBe(1);
    expect(t.split("Where this comes from").length - 1).toBe(4);
    expect(t).toContain("Fall retreat: 31 of 40 places taken; registration closes Friday, November 20 at 6:00 PM");
    expect(t).toContain("Summer camp: registration opens Monday, November 23 at 8:00 AM");
    for (const source of ["Planning Center Check-Ins Checked", "Planning Center People Checked", "Planning Center Registrations Checked"]) expect(t).toContain(source);
    expect(t).toContain("Why I flagged this");
    expect(t).toContain("This isn't right");
    // Whom a form is for is shown on this Mac, folded away; one whose person isn't named is only counted.
    expect(t).toContain("Who they're for Dana Fictional, Emery Fictional and 1 more not named here");
    // Review J H1: a child's name does arrive in Planning Center's answer and is dropped on arrival, so "never kept".
    // (Shown once "Where this comes from" is opened, so read from the card's source.)
    const card = readFileSync(new URL("../src/church-reads-view.tsx", import.meta.url), "utf8");
    expect(card).toContain("never the answers. A child's name is never kept. Names stay on this Mac.");
    expect(card).not.toContain("never read or kept");
    expect(t).not.toContain("Who sent them");
    // Worth a look can be stopped for a team, and never offers to interrupt.
    expect(t).toContain("Stop flagging this");
    expect(t).not.toContain("Always tell me right away");
    expect(t).not.toMatch(FORBIDDEN);
  });

  it("Today shows nothing for a check without church reads, and what wasn't checked when a read failed", () => {
    expect(today(null, base)).toBe("");
    const plain = church();
    plain.reads = plain.reads.filter(r => !CHURCH_COLLECTIONS.has(r.collection));
    delete plain.forms;
    expect(today(plain, base)).toBe("");
    const failed = church();
    failed.reads = failed.reads.map(r => { if (r.collection !== "registrations_attendees") return r; const unread: SundayRead = { ...r, outcome: "denied" }; delete unread.body; return unread; });
    const t = today(failed, kids());
    expect(t).toContain("What I didn't check");
    expect(t).toContain("How many registered for Fall retreat: Planning Center didn't allow it.");
    expect(t).toContain("Fall retreat: registration is open;");
  });

  it("Sunday sets Check-Ins beside the kids rule, and never says the rule held without a full comparison", () => {
    const sunday = (capture: SundayCapture, rules: SundayRules) =>
      text(renderToStaticMarkup(React.createElement(CheckInsSunday, { capture, rules, now: NOW, feedback: { entries: [], onEntries: () => {} } })));
    const below = sunday(church(), kids());
    expect(below).toContain("Check-Ins on Sunday, November 8");
    expect(below).toContain("Nursery at 9:00 AM on Sunday, November 8: 1 volunteer checked in, fewer than your rule's 2");
    expect(below).not.toContain("Each room you matched");
    const met = church();
    met.reads = met.reads.map(r => r.collection === "checkins_location_counts"
      ? { ...r, body: page([{ type: "LocationEventTime", id: "670", attributes: { regular_count: 8, guest_count: 1, volunteer_count: 2 }, relationships: { event_time: rel("EventTime", "630"), location: rel("Location", "650") } }]) } : r);
    expect(sunday(met, kids())).toContain("Each room you matched showed at least as many volunteers checked in as its kids rule's number on Sunday, November 8.");
    // Same name only: no line saying the rule held.
    expect(sunday(met, kids({ checkIns: {} }))).not.toContain("Each room you matched");
    // A second matched room that wasn't compared: no "held" line, and it says which.
    const two = kids({ kidsTeams: [{ team_id: "71", min_confirmed: 2, name: "Nursery" }, { team_id: "72", min_confirmed: 5, name: "Youth" }],
      checkIns: { rooms: [{ location_id: "650", team_id: "71" }, { location_id: "699", team_id: "72" }] } });
    const partly = sunday(met, two);
    expect(partly).not.toContain("Each room you matched");
    expect(partly).toContain("1 Check-Ins room you matched to a kids team isn't in Check-Ins any more.");
    // The only below card set aside with This isn't right: still no "held" line.
    const card = checkInsFacts(church(), kids(), { now: NOW })!.below[0]!;
    const aside = kids({ feedback: [correctionEntry(checkInsTarget(card), "", "2026-11-13T13:00:00Z")] });
    const shown = text(renderToStaticMarkup(React.createElement(CheckInsSunday, { capture: church(), rules: aside, now: NOW })));
    expect(shown).not.toContain("fewer than your rule's");
    expect(shown).not.toContain("Each room you matched");
    expect(sunday(church(), base)).toBe("");
  });

  it("during a service, today's counts show only as so far, still changing, never beside a rule", () => {
    const during = church();
    during.started_at = "2026-11-08T15:20:00.000Z"; during.completed_at = "2026-11-08T15:20:09.000Z";
    during.reads = during.reads.map(r => r.window ? { ...r, window: { starts_at: "2026-10-31T15:20:00Z", ends_at: "2026-11-08T15:20:00Z" } } : r);
    const t = text(renderToStaticMarkup(React.createElement(ChurchReadsToday, { capture: during, rules: kids(), now: "2026-11-08T15:25:00Z" })));
    expect(t).toContain("Today so far, as of 9:20 AM");
    expect(t).toContain("Nursery: 9 checked in (8 regular, 1 guest) and 1 volunteer");
    expect(t).not.toContain("fewer than your rule's");
    expect(t).not.toContain("Check again for the finished counts");
    // Still on screen at 3:00 PM: the counts stay as of 9:20, never beside the rule, and say to check again.
    const later = text(renderToStaticMarkup(React.createElement(ChurchReadsToday, { capture: during, rules: kids(), now: "2026-11-08T21:00:00Z" })));
    expect(later).toContain("Today so far, as of 9:20 AM");
    expect(later).toContain("This Sunday is over now. Check again for the finished counts.");
    expect(later).not.toContain("fewer than your rule's");
    const sunday = text(renderToStaticMarkup(React.createElement(CheckInsSunday, { capture: during, rules: kids(), now: "2026-11-08T21:00:00Z" })));
    expect(sunday).toContain("Today was read at 9:20 AM, before it was over. Check again for the finished counts.");
  });

  it("Church rules choose forms to watch and match a Check-Ins room to each kids team, by id", () => {
    const rules = (s: ConnectionStatus | null, r: SundayRules) =>
      text(renderToStaticMarkup(React.createElement(ChurchReadsRules, { rules: r, onChange: () => {}, capture: church(), status: s })));
    const t = rules(status("services-and-operations+check-ins"), kids());
    expect(t).toContain("Watch People forms for new submissions");
    expect(t).toContain("Volunteer interest");
    expect(t).toContain("Match the Check-Ins room each kids team uses");
    expect(t).toContain("Ozzie never matches a room for you");
    expect(t).toContain("Nursery team");
    expect(t).not.toMatch(FORBIDDEN);
    expect(rules(status("services"), { ...base, forms: { on: true } })).toContain("This needs People in your Planning Center connection");
  });

  it("What happened names every church read plainly", () => {
    for (const collection of CHURCH_COLLECTIONS) {
      expect(activityLabel(collection)).not.toBe(collection);
      expect(activityLabel(collection)).not.toMatch(FORBIDDEN);
    }
  });
});

describe("Autopilot: name-free lines for the live proof", () => {
  it("tallies each product's reads and counts, never a name, label or answer", () => {
    const lines = churchLines(church(), kids());
    expect(lines).toEqual([
      "forms: reads=2/2 listed=1 watched=1 facts=1 submissions=3 submitters=2 unnamed=1 not_checked=0",
      "checkins: reads=4/4 events=1 rooms=1 last_sunday=found so_far=none times=1 room_counts=1 count_rows=1 matched=below held=false below=look:chosen not_checked=0",
      "registrations: reads=2/2 upcoming=2 open=1 counted=1 limits=1 not_checked=0",
    ]);
    expect(lines.join(" ")).not.toMatch(/Dana|Emery|Nursery|retreat|interest|Kids/u);
    const plain = church();
    plain.reads = plain.reads.filter(r => !CHURCH_COLLECTIONS.has(r.collection));
    delete plain.forms;
    expect(churchLines(plain, base)).toEqual(["forms: off reads=0", "checkins: not-read reads=0", "registrations: not-read reads=0"]);
  });

  it("OZZIE_DEV_FORMS turns forms on with the list only, or watches the given forms", () => {
    expect(devChurchRules(base, undefined)).toBe(base);
    expect(devChurchRules(base, "1").forms).toEqual({ on: true, watched: [] });
    expect(devChurchRules(base, "610,611").forms).toEqual({ on: true, watched: ["610", "611"] });
  });
});
