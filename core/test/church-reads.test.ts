// People forms, Check-Ins and Registrations over fixed, fictional data: what each read says as facts
// with their source and check time, what wasn't checked, and when a church rule the leader set for a
// room isn't met. Every name, number and id here is invented. No child is ever named, and the facts
// never carry a person's name (who submitted a form is a person id, resolved on the Mac at render).
import { describe, expect, it } from "vitest";
import type { SundayCapture, SundayRead, SundayRules } from "../src/sunday-capture.js";
import { checkInsFacts, formsFacts, registrationsFacts, type RoomRuleFact } from "../src/church-reads/index.js";
import {
  checkInsEvent, formIdsForCheck, MAX_WATCHED_FORMS, roomMatches, watchedForms, withCheckInsEvent, withFormsOn, withRoomMatch, withWatchedForm,
} from "../src/church-reads/rules.js";
import { applyFeedback, canCorrect, canPromote, correctionEntry, stopEntry, stopScopes } from "../src/finding-feedback.js";
import { checkInsTarget } from "../src/church-reads/checkins.js";
import { formTarget } from "../src/church-reads/forms.js";

const ZONE = "America/Chicago";
const CHECKED = "2026-11-13T12:00:03.000Z";
const WINDOW = { starts_at: "2026-11-05T12:00:00Z", ends_at: "2026-11-13T12:00:00Z" };
const base: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 0 };
const rel = (type: string, id: string) => ({ data: { type, id } });
const page = (data: unknown[], included?: unknown[]) => ({ data, ...(included ? { included } : {}), meta: { count: data.length, total_count: data.length } });
const read = (collection: string, body: SundayRead["body"] | undefined, extra: Partial<SundayRead> = {}, outcome = "ok"): SundayRead =>
  ({ collection, offset: 0, checked_at: CHECKED, outcome, ...(body ? { body } : {}), ...extra });

function capture(reads: SundayRead[], labels: Record<string, string> = {}, more: Partial<SundayCapture> = {}): SundayCapture {
  return {
    version: 1, kind: "live", organization: "1001", service_type_id: "10", plan_id: "20",
    started_at: "2026-11-13T12:00:00.000Z", completed_at: "2026-11-13T12:00:09.000Z",
    reads: [read("organization", { data: { type: "Organization", id: "1001", attributes: { time_zone: ZONE } } }), ...reads],
    // A Services name that must never reach a church fact.
    names: { "50": "Avery Fictional" }, labels, ...more,
  };
}

// ---- Check-Ins ------------------------------------------------------------------------------------------
// Shaped like Planning Center's published examples (Check-Ins 2025-05-28): an EventTime renders `event` and
// `event_period`; an EventPeriod renders `event` only; a Location renders `parent` only; a LocationEventTime
// names its room only because the read includes it.

const time = (id: string, event: string, period: string, starts_at: string) => ({ type: "EventTime", id, attributes: { starts_at },
  relationships: { event: rel("Event", event), event_period: rel("EventPeriod", period) } });
const period = (id: string, event: string, starts_at: string, ends_at: string) => ({
  type: "EventPeriod", id, attributes: { starts_at, ends_at }, relationships: { event: rel("Event", event) } });
const room = (id: string, kind = "Location") => ({ type: "Location", id, attributes: { kind }, relationships: { parent: { data: null } } });
const counts = (time: string, rooms: [string, number, number, number][], outcome = "ok") => read("checkins_location_counts",
  outcome === "ok" || outcome === "truncated" ? page(rooms.map(([location, regular, guest, volunteer], i) => ({
    type: "LocationEventTime", id: `67${i}${time}`, attributes: { regular_count: regular, guest_count: guest, volunteer_count: volunteer },
    relationships: { location: rel("Location", location) } }))) : undefined,
  { checkins_event_time_id: time, checked_at: "2026-11-13T12:00:06.000Z" }, outcome);
const CHECK_INS_LABELS = {
  "checkins_event:620": "Sunday Kids", "checkins_event:621": "Wednesday Night",
  "checkins_location:650": "Nursery", "checkins_location:651": "Preschool", "checkins_location:655": "Kids Wing", "checkins_location:652": "Youth Room",
};
/** Last Sunday (November 8, Chicago): 9:00 and 11:00 in Sunday Kids; Wednesday Night on November 11; next Sunday's time is later. */
function checkIns(over: { counts630?: SundayRead | null; counts631?: SundayRead | null; zone?: boolean; events?: SundayRead } = {}): SundayCapture {
  const reads = [
    over.events ?? read("checkins_events", page([
      { type: "Event", id: "620", attributes: { archived_at: null } }, { type: "Event", id: "621", attributes: { archived_at: null } }])),
    read("checkins_locations", page([room("650"), room("651"), room("655", "Folder")]), { checkins_event_id: "620" }),
    read("checkins_event_periods", page(
      [period("660", "620", "2026-11-08T06:00:00Z", "2026-11-09T06:00:00Z"), period("661", "620", "2026-11-09T06:00:00Z", "2026-11-16T06:00:00Z")],
      [time("630", "620", "660", "2026-11-08T15:00:00Z"), time("631", "620", "660", "2026-11-08T17:00:00Z"), time("632", "620", "661", "2026-11-15T15:00:00Z")]),
    { checkins_event_id: "620", window: WINDOW }),
    read("checkins_locations", page([room("652")]), { checkins_event_id: "621" }),
    read("checkins_event_periods", page([period("662", "621", "2026-11-11T06:00:00Z", "2026-11-12T06:00:00Z")], [time("633", "621", "662", "2026-11-12T00:30:00Z")]),
      { checkins_event_id: "621", window: WINDOW }),
    counts("633", [["652", 12, 2, 3]]),
    ...(over.counts631 === null ? [] : [over.counts631 ?? counts("631", [["650", 5, 0, 2]])]),
    ...(over.counts630 === null ? [] : [over.counts630 ?? counts("630", [["650", 8, 1, 1], ["651", 10, 0, 2]])]),
  ];
  const c = capture(reads, CHECK_INS_LABELS);
  if (over.zone === false) c.reads = c.reads.filter(r => r.collection !== "organization");
  return c;
}
/**
 * A check run during the 9:00 service on Sunday, November 8 (Chicago) at 9:20 (or at `readAt`): November 1 is finished;
 * the 11:00 time hadn't started at 9:20.
 */
function duringService(readAt = "2026-11-08T15:20:00Z"): SundayCapture {
  const start = Date.parse(readAt);
  const window = { starts_at: new Date(start - 8 * 86_400_000).toISOString().replace(".000Z", "Z"), ends_at: readAt };
  const c = capture([
    read("checkins_events", page([{ type: "Event", id: "620", attributes: { archived_at: null } }])),
    read("checkins_locations", page([room("650")]), { checkins_event_id: "620" }),
    read("checkins_event_periods", page(
      [period("659", "620", "2026-11-01T05:00:00Z", "2026-11-02T06:00:00Z"), period("660", "620", "2026-11-08T06:00:00Z", "2026-11-09T06:00:00Z")],
      [time("628", "620", "659", "2026-11-01T15:00:00Z"), time("629", "620", "659", "2026-11-01T17:00:00Z"),
        time("630", "620", "660", "2026-11-08T15:00:00Z"), time("631", "620", "660", "2026-11-08T17:00:00Z")]),
    { checkins_event_id: "620", window }),
    counts("630", [["650", 6, 0, 1]]), counts("629", [["650", 7, 0, 2]]), counts("628", [["650", 8, 1, 1]]),
    ...(start >= Date.parse("2026-11-08T17:00:00Z") ? [counts("631", [["650", 5, 0, 2]])] : []),
  ], CHECK_INS_LABELS, { started_at: readAt.replace("Z", ".000Z"), completed_at: new Date(start + 9000).toISOString() });
  return c;
}
const nurseryTeam = (more: Partial<SundayRules> = {}): SundayRules =>
  ({ ...base, kidsTeams: [{ team_id: "71", min_confirmed: 2, name: "Nursery" }], ...more });
const matched = (more: Partial<SundayRules> = {}) => nurseryTeam({ checkIns: { rooms: [{ location_id: "650", team_id: "71" }] }, ...more });

describe("Check-Ins: last Sunday's counts", () => {
  it("states each room's counts at each time of the most recent finished Sunday, as Planning Center records them", () => {
    const facts = checkInsFacts(checkIns(), base)!;
    expect(facts.sunday).toBe("2026-11-08");
    expect(facts.sunday_words).toBe("Sunday, November 8");
    expect(facts.on).toBe("on Sunday, November 8");
    expect(facts.times.map(t => [t.event, t.clock, t.complete])).toEqual([["Sunday Kids", "9:00 AM", true], ["Sunday Kids", "11:00 AM", true]]);
    expect(facts.times[0]!.rooms.map(r => r.line)).toEqual([
      "Nursery: 9 checked in (8 regular, 1 guest) and 1 volunteer",
      "Preschool: 10 checked in (10 regular, 0 guests) and 2 volunteers",
    ]);
    expect(facts.times[1]!.rooms.map(r => [r.location_id, r.regular, r.guest, r.volunteer])).toEqual([["650", 5, 0, 2]]);
    // Wednesday's time is in the window but isn't a Sunday; next Sunday's hasn't started.
    expect(facts.times.some(t => t.event_time_id === "633" || t.event_time_id === "632")).toBe(false);
    expect(facts.so_far).toBeNull();
    expect(facts.checked_at).toBe(CHECKED);
    expect(facts.source).toBe("Planning Center Check-Ins");
    expect(facts.not_checked).toEqual([]);
    expect(facts.below).toEqual([]);
    // Every room listed, for matching in Church rules: folders aren't rooms anyone checks in to.
    expect(facts.rooms.map(r => [r.location_id, r.name, r.event])).toEqual([["650", "Nursery", "Sunday Kids"], ["651", "Preschool", "Sunday Kids"], ["652", "Youth Room", "Wednesday Night"]]);
  });

  it("a time placed by another event, or by a period not on the page, isn't counted", () => {
    const c = checkIns();
    const periods = c.reads.find(r => r.collection === "checkins_event_periods")!;
    (periods.body!.included as unknown[]).push(time("634", "621", "660", "2026-11-08T19:00:00Z"), time("635", "620", "699", "2026-11-08T21:00:00Z"));
    expect(checkInsFacts(c, base)!.times.map(t => t.event_time_id)).toEqual(["630", "631"]);
  });

  it("never carries a person's name, and has no field that could name a child", () => {
    const text = JSON.stringify(checkInsFacts(checkIns(), matched()));
    expect(text).not.toContain("Avery");
    expect(text).not.toMatch(/person|first_name|last_name|child/u);
  });

  it("is absent without any Check-Ins read: Check-Ins wasn't connected for this check", () => {
    expect(checkInsFacts(capture([]), base)).toBeNull();
  });

  it("without the church's time zone, last Sunday isn't placed and nothing is called clear", () => {
    const facts = checkInsFacts(checkIns({ zone: false }), matched())!;
    expect(facts.times).toEqual([]);
    expect(facts.below).toEqual([]);
    expect(facts.held).toBe(false);
    expect(facts.not_checked).toEqual(["Check-Ins: the church's time zone wasn't read, so last Sunday's check-ins couldn't be placed."]);
  });

  it("the chosen event narrows last Sunday to that event; one with no Sunday time says so", () => {
    const wednesday = checkInsFacts(checkIns(), withCheckInsEvent(base, "621"))!;
    expect(wednesday.times).toEqual([]);
    expect(wednesday.not_checked).toEqual(["Check-Ins shows no check-in times on a Sunday in the 8 days before this check for Wednesday Night."]);
  });

  it("an events list cut at the bound never says there were no Sunday times; it asks for the event", () => {
    const cut = read("checkins_events", page([{ type: "Event", id: "621", attributes: { archived_at: null } }]), {}, "truncated");
    const c = checkIns({ events: cut });
    c.reads = c.reads.filter(r => r.checkins_event_id !== "620");
    const facts = checkInsFacts(c, base)!;
    expect(facts.times).toEqual([]);
    expect(facts.not_checked).toEqual(["Check-Ins lists more events than Ozzie reads at once, so some weren't read. Choose your Sunday event on Church rules."]);
  });

  it("during the service, today's counts are only so far and last week's finished Sunday is the one shown", () => {
    const facts = checkInsFacts(duringService(), matched(), { now: "2026-11-08T15:25:00Z" })!;
    expect(facts.sunday).toBe("2026-11-01");
    expect(facts.times.map(t => t.clock)).toEqual(["9:00 AM", "11:00 AM"]);
    expect(facts.below.map(f => [f.event_time_id, f.title])).toEqual([["628", "Nursery at 9:00 AM on Sunday, November 1: 1 volunteer checked in, fewer than your rule's 2"]]);
    // Today: the 9:00 count so far, still changing, never compared; 11:00 hasn't started.
    expect(facts.so_far?.sunday).toBe("2026-11-08");
    expect(facts.so_far?.on).toBe("today");
    expect(facts.so_far?.times.map(t => [t.clock, t.rooms.map(r => r.volunteer)])).toEqual([["9:00 AM", [1]]]);
    expect(facts.so_far?.as_of).toBe("9:20 AM");
    expect(facts.so_far?.over).toBe(false);
    expect(facts.below.some(f => f.sunday === "2026-11-08")).toBe(false);
    // A time that hadn't started when Check-Ins was read is named, never silently left out.
    expect(facts.not_checked).toContain("The 11:00 AM Check-Ins time on Sunday, November 8 hadn't started when Ozzie read Check-Ins at 9:20 AM, so it wasn't read.");
  });

  it("a check read during the service stays so far, as of when it was read, however late it's looked at", () => {
    // Read at 9:20; still on screen at 3:00 PM, after the Sunday is over.
    const facts = checkInsFacts(duringService(), matched(), { now: "2026-11-08T21:00:00Z" })!;
    expect(facts.sunday).toBe("2026-11-01");
    expect(facts.below.some(f => f.sunday === "2026-11-08")).toBe(false);
    expect(facts.so_far).toMatchObject({ sunday: "2026-11-08", as_of: "9:20 AM", over: true });
    expect(facts.so_far?.times.map(t => t.clock)).toEqual(["9:00 AM"]);
    expect(facts.not_checked).toContain("The 11:00 AM Check-Ins time on Sunday, November 8 hadn't started when Ozzie read Check-Ins at 9:20 AM, so it wasn't read.");
  });

  it("a Sunday read three hours after its last time starts is finished and compared, and called today only in a live check", () => {
    // Read at 2:30 PM in Chicago: three and a half hours after 11:00.
    const facts = checkInsFacts(duringService("2026-11-08T20:30:00Z"), matched(), { now: "2026-11-08T20:35:00Z" })!;
    expect(facts.sunday).toBe("2026-11-08");
    expect(facts.on).toBe("today");
    expect(facts.so_far).toBeNull();
    expect(facts.times.map(t => t.clock)).toEqual(["9:00 AM", "11:00 AM"]);
    // Read at 1:30 PM: the 11:00 time wasn't over when read, so November 8 is only so far.
    expect(checkInsFacts(duringService("2026-11-08T19:30:00Z"), matched(), { now: "2026-11-08T21:00:00Z" })!.sunday).toBe("2026-11-01");
    // A saved recording viewed days later names the date, never "today".
    const recording = { ...duringService("2026-11-08T20:30:00Z"), kind: "recording" as const };
    const later = checkInsFacts(recording, matched())!;
    expect(later.on).toBe("on Sunday, November 8");
    expect(later.below[0]?.title ?? "").not.toContain("today");
  });

  it("a room count that was partly read is shown for the rooms read, and says which matched room wasn't compared", () => {
    const facts = checkInsFacts(checkIns({ counts630: counts("630", [["651", 10, 0, 2]], "truncated") }), matched())!;
    expect(facts.times[0]!.complete).toBe(false);
    expect(facts.times[0]!.rooms.map(r => r.location_id)).toEqual(["651"]);
    // The matched Nursery isn't in the part that was read: never a finding, never "held".
    expect(facts.below).toEqual([]);
    expect(facts.held).toBe(false);
    expect(facts.matched.map(m => [m.location_id, m.state])).toEqual([["650", "not-compared"]]);
    expect(facts.not_checked).toEqual([
      "Check-Ins room counts at 9:00 AM: only partly read.",
      "Nursery (matched to the Nursery kids team) wasn't compared at 9:00 AM: its count wasn't read in full.",
    ]);
  });

  it("a refused, failed or unread room count is not checked, never zero", () => {
    for (const [counts630, line] of [
      [counts("630", [], "denied"), "Check-Ins room counts at 9:00 AM: Planning Center didn't allow it."],
      [counts("630", [], "provider-failure"), "Check-Ins room counts at 9:00 AM: couldn't be read."],
      [null, "Check-Ins room counts at 9:00 AM: weren't part of this check."],
    ] as const) {
      const facts = checkInsFacts(checkIns({ counts630 }), matched())!;
      expect(facts.times[0]!.rooms).toEqual([]);
      expect(facts.below).toEqual([]);
      expect(facts.held).toBe(false);
      expect(facts.not_checked[0]).toBe(line);
    }
  });
});

describe("Check-Ins: the event the check read, not the one chosen since", () => {
  /** A check that read only Sunday Kids, because it was chosen on Church rules then. */
  const readSundayKids = () => {
    const c = { ...checkIns(), checkins_event: "620" };
    c.reads = c.reads.filter(r => r.checkins_event_id !== "621" && r.checkins_event_time_id !== "633");
    return c;
  };
  const youth = (more: Partial<SundayRules> = {}) => matched({
    kidsTeams: [{ team_id: "71", min_confirmed: 2, name: "Nursery" }, { team_id: "72", min_confirmed: 5, name: "Youth" }],
    checkIns: { rooms: [{ location_id: "650", team_id: "71" }, { location_id: "652", team_id: "72" }] }, ...more });

  it("switched back to every event: never says a matched room is gone; says it read only one event", () => {
    const facts = checkInsFacts(readSundayKids(), youth())!;
    expect(facts.not_checked).not.toContain("1 Check-Ins room you matched to a kids team isn't in Check-Ins any more.");
    expect(facts.not_checked).toEqual([
      "This check read only Sunday Kids. Check again to read every event.",
      "A Check-Ins room you matched to the Youth kids team wasn't read in this check (it may be in another event than the one read), so it wasn't compared.",
    ]);
    // What was read is still stated: Sunday Kids' Sunday.
    expect(facts.times.map(t => t.event)).toEqual(["Sunday Kids", "Sunday Kids"]);
  });

  it("switched to another event: never says that event had no Sunday times; says to check again", () => {
    const facts = checkInsFacts(readSundayKids(), withCheckInsEvent(base, "621"))!;
    expect(facts.not_checked).toEqual(["This check read a different Check-Ins event than the one chosen on Church rules now. Check again to read the event you chose."]);
    expect(facts.not_checked.join(" ")).not.toContain("Wednesday Night");
    expect(facts.times.map(t => t.event)).toEqual(["Sunday Kids", "Sunday Kids"]);
  });

  it("a read event with no Sunday time is named as the one read, never the one chosen since", () => {
    const wednesday = { ...checkIns(), checkins_event: "621" };
    wednesday.reads = wednesday.reads.filter(r => r.checkins_event_id !== "620" && !["630", "631"].includes(r.checkins_event_time_id ?? ""));
    expect(checkInsFacts(wednesday, withCheckInsEvent(base, "620"))!.not_checked).toEqual([
      "This check read a different Check-Ins event than the one chosen on Church rules now. Check again to read the event you chose.",
      "Check-Ins shows no check-in times on a Sunday in the 8 days before this check for Wednesday Night.",
    ]);
  });

  it("a chosen event with no Sunday time names each matched room that wasn't compared", () => {
    const two = { ...base, kidsTeams: [{ team_id: "71", min_confirmed: 2, name: "Nursery" }, { team_id: "72", min_confirmed: 5, name: "Youth" }],
      checkIns: { event_id: "621", rooms: [{ location_id: "650", team_id: "71" }, { location_id: "652", team_id: "72" }] } };
    const facts = checkInsFacts(checkIns(), two)!;
    expect(facts.held).toBe(false);
    expect(facts.not_checked).toEqual([
      "Check-Ins shows no check-in times on a Sunday in the 8 days before this check for Wednesday Night.",
      "Nursery (matched to the Nursery kids team) is in another Check-Ins event than the one you chose, so it wasn't compared.",
      "Youth Room (matched to the Youth kids team) wasn't compared: its event has no Sunday check-in time in this check.",
    ]);
  });

  it("the same choice as the check read says nothing extra", () => {
    const facts = checkInsFacts(readSundayKids(), withCheckInsEvent(base, "620"))!;
    expect(facts.not_checked).toEqual([]);
  });
});

describe("Check-Ins beside a kids rule the leader set", () => {
  it("a matched room with fewer volunteers checked in than the rule's number is Worth a look about the room and time", () => {
    const facts = checkInsFacts(checkIns(), matched())!;
    expect(facts.below).toHaveLength(1);
    const f = facts.below[0]!;
    expect(f).toMatchObject({
      kind: "checkins-below-rule", tone: "look", matched: "chosen", location_id: "650", room: "Nursery", team_id: "71", team: "Nursery",
      needed: 2, volunteers: 1, event_time_id: "630", starts_at: "2026-11-08T15:00:00Z", clock: "9:00 AM", sunday: "2026-11-08",
      checked_at: "2026-11-13T12:00:06.000Z", source: "Planning Center Check-Ins",
    } satisfies Partial<RoomRuleFact>);
    expect(f.title).toBe("Nursery at 9:00 AM on Sunday, November 8: 1 volunteer checked in, fewer than your rule's 2");
    expect(f.why).toEqual([
      "Your Church rules ask for at least 2 confirmed people on the Nursery kids team at each service time.",
      "You matched the Check-Ins room Nursery to that team on Church rules.",
      "Planning Center Check-Ins shows 1 volunteer checked in to Nursery at 9:00 AM on Sunday, November 8.",
      "This sets volunteers who checked in to the room beside a rule about confirmed people on the team: someone who served without checking in isn't counted, someone not on the team may be, and Ozzie doesn't check ages.",
      "Check-Ins may lower a room's count when people check out, so a count read after the service can be lower than it was. That's why this is Worth a look.",
      "Ozzie reads only counts from Check-Ins. It never reads who checked in.",
    ]);
    // 11:00 had 2 volunteers: the number was met there. The room as a whole was below at 9:00.
    expect(facts.below.some(b => b.event_time_id === "631")).toBe(false);
    expect(facts.matched).toEqual([{ location_id: "650", room: "Nursery", team_id: "71", team: "Nursery", state: "below" }]);
    expect(facts.held).toBe(false);
  });

  it("is held only when every matched room was compared in full at every time and met its number", () => {
    const met = checkInsFacts(checkIns({ counts630: counts("630", [["650", 8, 1, 2]]) }), matched())!;
    expect(met.below).toEqual([]);
    expect(met.matched.map(m => m.state)).toEqual(["met"]);
    expect(met.held).toBe(true);
    // A second kids team matched to a room in the Wednesday event: it has no time that Sunday, so it wasn't compared.
    const two = matched({ kidsTeams: [{ team_id: "71", min_confirmed: 2, name: "Nursery" }, { team_id: "72", min_confirmed: 5, name: "Youth" }],
      checkIns: { rooms: [{ location_id: "650", team_id: "71" }, { location_id: "652", team_id: "72" }] } });
    const b = checkInsFacts(checkIns({ counts630: counts("630", [["650", 8, 1, 2]]) }), two)!;
    expect(b.matched.map(m => [m.location_id, m.state])).toEqual([["650", "met"], ["652", "not-compared"]]);
    expect(b.held).toBe(false);
    expect(b.not_checked).toEqual(["Youth Room (matched to the Youth kids team) has no Check-Ins time on Sunday, November 8, so it wasn't compared."]);
    // A check that read only Sunday Kids (chosen then): the Wednesday room isn't read at all, still never held.
    const chosen = { ...checkIns({ counts630: counts("630", [["650", 8, 1, 2]]) }), checkins_event: "620" };
    chosen.reads = chosen.reads.filter(r => r.checkins_event_id !== "621");
    const c = checkInsFacts(chosen, { ...two, checkIns: { ...two.checkIns, event_id: "620" } })!;
    expect(c.held).toBe(false);
    expect(c.not_checked).toEqual(["A Check-Ins room you matched to the Youth kids team wasn't read in this check (it may be in another event than the one read), so it wasn't compared."]);
    // Every event read, Sunday Kids chosen now: the Wednesday room was read but is in another event than the one chosen.
    const filtered = checkInsFacts(checkIns({ counts630: counts("630", [["650", 8, 1, 2]]) }), { ...two, checkIns: { ...two.checkIns, event_id: "620" } })!;
    expect(filtered.held).toBe(false);
    expect(filtered.not_checked).toEqual(["Youth Room (matched to the Youth kids team) is in another Check-Ins event than the one you chose, so it wasn't compared."]);
  });

  it("a card set aside with This isn't right is never counted as held", () => {
    const facts = checkInsFacts(checkIns(), matched())!;
    const entry = correctionEntry(checkInsTarget(facts.below[0]!), "Two volunteers served; one didn't check in", "2026-11-13T13:00:00Z");
    const after = checkInsFacts(checkIns(), { ...matched(), feedback: [entry] })!;
    expect(after.below).toEqual([]);
    expect(after.hidden?.map(h => h.key)).toEqual([facts.below[0]!.key]);
    expect(after.matched.map(m => m.state)).toEqual(["set-aside"]);
    expect(after.held).toBe(false);
    // The same room on a later Sunday is a new occurrence and shows again.
    expect(applyFeedback(facts.below, f => ({ ...checkInsTarget(f), occurrence: "2026-11-15" }), [entry]).shown).toHaveLength(1);
  });

  it("can be stopped for a team, and being Worth a look, never sends a notice", () => {
    const target = checkInsTarget(checkInsFacts(checkIns(), matched())!.below[0]!);
    expect(canCorrect(target)).toBe(true);
    expect(stopScopes(target)).toEqual([{ team_id: "71" }]);
    expect(canPromote(target)).toBe(false);
    const stopped = checkInsFacts(checkIns(), { ...matched(), feedback: [stopEntry(target, { team_id: "71" }, "2026-11-13T13:00:00Z")] })!;
    expect(stopped.below).toEqual([]);
    expect(stopped.held).toBe(false);
  });

  it("a room and a kids team that only share a name says so, and is never held", () => {
    const facts = checkInsFacts(checkIns(), nurseryTeam())!;
    expect(facts.below.map(f => [f.location_id, f.tone, f.matched])).toEqual([["650", "look", "same-name"]]);
    expect(facts.below[0]!.why[1]).toBe("The Check-Ins room Nursery has the same name as that kids team, but you haven't matched them on Church rules.");
    expect(facts.matched).toEqual([]);
    expect(facts.held).toBe(false);
    // A different name is never matched by Ozzie; the leader matches it on Church rules.
    const other = checkInsFacts(checkIns(), { ...base, kidsTeams: [{ team_id: "71", min_confirmed: 2, name: "Nursery Team" }] })!;
    expect(other.below).toEqual([]);
    expect(other.unmatched).toEqual([{ team_id: "71", team: "Nursery Team" }]);
  });

  it("a matched room with no count in a complete read is Worth a look, not zero volunteers", () => {
    const facts = checkInsFacts(checkIns({ counts630: counts("630", [["651", 10, 0, 2]]) }), matched())!;
    expect(facts.below.map(f => [f.event_time_id, f.tone, f.volunteers])).toEqual([["630", "look", null]]);
    expect(facts.below[0]!.title).toBe("Nursery at 9:00 AM on Sunday, November 8: Check-Ins shows no count");
    expect(facts.below[0]!.why[2]).toBe("Planning Center Check-Ins shows no count for Nursery at 9:00 AM on Sunday, November 8.");
  });

  it("a match to a team that is no longer a kids team compares nothing; a room gone from a complete list says so", () => {
    expect(checkInsFacts(checkIns(), { ...base, checkIns: { rooms: [{ location_id: "650", team_id: "71" }] } })!.below).toEqual([]);
    const gone = checkInsFacts(checkIns(), nurseryTeam({ checkIns: { rooms: [{ location_id: "699", team_id: "71" }] } }))!;
    expect(gone.below.map(f => f.matched)).toEqual(["same-name"]);
    expect(gone.not_checked).toEqual(["1 Check-Ins room you matched to a kids team isn't in Check-Ins any more."]);
    expect(gone.held).toBe(false);
  });
});

// ---- People forms ---------------------------------------------------------------------------------------

const submission = (id: string, created_at: string, person: string, form = "610") => ({
  type: "FormSubmission", id, attributes: { created_at }, relationships: { form: rel("Form", form), person: rel("Person", person) } });
const FORM_LABELS = { "form:610": "Volunteer interest", "form:611": "Prayer requests" };
function formsCapture(submissions: SundayRead[] = [
  read("people_form_submissions", page([submission("700", "2026-11-08T15:00:00Z", "190"), submission("701", "2026-11-10T15:00:00Z", "191"),
    submission("702", "2026-11-11T15:00:00Z", "190")]), { form_id: "610", window: WINDOW }),
], list: SundayRead = read("people_forms", page([{ type: "Form", id: "610", attributes: { archived: false } }, { type: "Form", id: "611", attributes: { archived: false } }])),
forms = ["610"]): SundayCapture {
  return capture([list, ...submissions], FORM_LABELS, { forms, names: { "50": "Avery Fictional", "190": "Dana Fictional", "191": "Emery Fictional" } });
}

describe("People forms: new submissions", () => {
  it("counts each watched form's new submissions since the window began, with who submitted by id", () => {
    const facts = formsFacts(formsCapture(), base)!;
    expect(facts.forms).toHaveLength(1);
    expect(facts.forms[0]).toMatchObject({ form_id: "610", name: "Volunteer interest", count: 3, at_least: false, submitters: ["190", "191"],
      unnamed: 0, since: WINDOW.starts_at, since_words: "Thursday, November 5 at 6:00 AM", checked_at: CHECKED, source: "Planning Center People" });
    expect(facts.forms[0]!.title).toBe("Volunteer interest: 3 new submissions since Thursday, November 5 at 6:00 AM");
    // Names are resolved on the Mac when shown; the facts hold ids only and never an answer.
    expect(JSON.stringify(facts)).not.toMatch(/Dana|Emery|Avery|answer/u);
    expect(facts.listed.map(f => [f.form_id, f.name])).toEqual([["610", "Volunteer interest"], ["611", "Prayer requests"]]);
    expect(facts.not_checked).toEqual([]);
  });

  it("a complete read with none is the fact that there were none; a partly read one says at least", () => {
    const none = formsFacts(formsCapture([read("people_form_submissions", page([]), { form_id: "610", window: WINDOW })]), base)!;
    expect(none.forms[0]!.title).toBe("Volunteer interest: no new submissions since Thursday, November 5 at 6:00 AM");
    const partial = formsFacts(formsCapture([read("people_form_submissions", page([submission("700", "2026-11-08T15:00:00Z", "190")]),
      { form_id: "610", window: WINDOW }, "truncated")]), base)!;
    expect(partial.forms[0]!.title).toBe("Volunteer interest: at least 1 new submission since Thursday, November 5 at 6:00 AM");
  });

  it("a submission whose person the check kept no name for (a child, or not said) is counted but never named", () => {
    const facts = formsFacts(formsCapture([read("people_form_submissions", page([submission("700", "2026-11-08T15:00:00Z", "190"),
      { type: "FormSubmission", id: "701", attributes: { created_at: "2026-11-10T15:00:00Z" }, relationships: { form: rel("Form", "610") } }]),
    { form_id: "610", window: WINDOW })]), base)!;
    expect(facts.forms[0]).toMatchObject({ count: 2, submitters: ["190"], unnamed: 1 });
  });

  it("without the church's time zone, dates say they're in this Mac's time zone", () => {
    const c = formsCapture();
    c.reads = c.reads.filter(r => r.collection !== "organization");
    const facts = formsFacts(c, base, { zone: "America/New_York" })!;
    expect(facts.forms[0]!.since_words).toBe("Thursday, November 5 at 7:00 AM");
    expect(facts.not_checked).toEqual(["Dates for forms are in this Mac's time zone: the church's time zone wasn't read."]);
  });

  it("a watched form that wasn't listed, or wasn't read, is not checked, never none", () => {
    const missing = formsFacts(formsCapture([], undefined, ["612"]), base)!;
    expect(missing.forms).toEqual([]);
    expect(missing.not_checked).toEqual(["1 form you watch isn't in Planning Center's list of forms any more. It may have been archived."]);
    const failed = formsFacts(formsCapture([read("people_form_submissions", undefined, { form_id: "610", window: WINDOW }, "denied")]), base)!;
    expect(failed.forms).toEqual([]);
    expect(failed.not_checked).toEqual(["New submissions for Volunteer interest: Planning Center didn't allow it."]);
    const list = formsFacts(formsCapture([], read("people_forms", undefined, {}, "timeout")), base)!;
    expect(list.not_checked).toEqual(["People forms: took too long."]);
  });

  it("without People in the connection, forms report not connected for this yet", () => {
    const off = formsFacts(formsCapture([], read("people_forms", undefined, {}, "not-requested")), base)!;
    expect(off.forms).toEqual([]);
    expect(off.connected).toBe(false);
    expect(off.not_checked).toEqual(["People forms weren't checked: this Planning Center connection doesn't include People. Allow Calendar, People and Groups in Settings."]);
  });

  it("This isn't right sets a form's count aside while the same submissions stand, on later days too", () => {
    const facts = formsFacts(formsCapture(), base)!;
    const entry = correctionEntry(formTarget(facts.forms[0]!), "Those were test submissions", "2026-11-13T13:00:00Z");
    const later = formsCapture();
    // The next day's check: its window starts a day later, the same three submissions are in it.
    later.reads = later.reads.map(r => r.window ? { ...r, window: { starts_at: "2026-11-06T12:00:00Z", ends_at: "2026-11-14T12:00:00Z" } } : r);
    expect(formsFacts(later, { ...base, feedback: [entry] })!.forms).toEqual([]);
    // A new submission brings it back.
    const more = formsCapture([read("people_form_submissions", page([submission("700", "2026-11-08T15:00:00Z", "190"), submission("701", "2026-11-10T15:00:00Z", "191"),
      submission("702", "2026-11-11T15:00:00Z", "190"), submission("703", "2026-11-12T15:00:00Z", "192")]), { form_id: "610", window: WINDOW })]);
    expect(formsFacts(more, { ...base, feedback: [entry] })!.forms).toHaveLength(1);
  });

  it("forms off reads nothing and says nothing; on with none chosen lists the forms to choose from", () => {
    expect(formsFacts(capture([]), base)).toBeNull();
    const none = formsFacts(formsCapture([], undefined, []), base)!;
    expect(none.forms).toEqual([]);
    expect(none.listed).toHaveLength(2);
    expect(none.not_checked).toEqual([]);
  });
});

// ---- Registrations --------------------------------------------------------------------------------------

const signup = (id: string, attributes: Record<string, unknown>) => ({ type: "Signup", id, attributes: { archived: false, ...attributes } });
const attendees = (signup: string, n: number, outcome = "ok") => read("registrations_attendees",
  outcome === "ok" || outcome === "truncated" ? page(Array.from({ length: n }, (_, i) => ({ type: "Attendee", id: `9${signup}${i}`, attributes: { active: true, canceled: false, waitlisted: false } }))) : undefined,
  { signup_id: signup }, outcome);
const SIGNUP_LABELS = { "signup:640": "Fall retreat", "signup:641": "Men's breakfast", "signup:642": "Christmas choir", "signup:643": "Summer camp", "signup:644": "Picnic" };
function registrations(extra: SundayRead[] = [attendees("640", 31), attendees("641", 12), attendees("642", 40)]): SundayCapture {
  return capture([
    read("registrations_signups", page([
      signup("640", { closed: false, open_at: "2026-10-01T12:00:00Z", close_at: "2026-11-21T00:00:00Z", maximum_capacity: 40 }),
      signup("641", { closed: false, open_at: "2026-10-01T12:00:00Z", close_at: null, maximum_capacity: null }),
      signup("642", { closed: false, open_at: "2026-10-01T12:00:00Z", close_at: "2026-11-15T00:00:00Z", maximum_capacity: 40 }),
      signup("643", { closed: true, open_at: "2026-11-23T14:00:00Z", close_at: "2027-01-10T00:00:00Z", maximum_capacity: 120 }),
      signup("644", { closed: true, open_at: "2026-06-01T12:00:00Z", close_at: "2026-08-01T00:00:00Z", maximum_capacity: 200 }),
    ])),
    ...extra,
  ], SIGNUP_LABELS);
}

describe("Registrations: upcoming signups", () => {
  it("says how many registered against the limit and when registration closes, soonest first", () => {
    const facts = registrationsFacts(registrations(), base)!;
    expect(facts.signups.map(s => s.title)).toEqual([
      "Christmas choir: 40 of 40 places taken (full); registration closes Saturday, November 14 at 6:00 PM",
      "Fall retreat: 31 of 40 places taken; registration closes Friday, November 20 at 6:00 PM",
      "Men's breakfast: 12 registered; no closing date is set in Planning Center",
      "Summer camp: registration opens Monday, November 23 at 8:00 AM",
    ]);
    expect(facts.signups[1]).toMatchObject({ signup_id: "640", registered: 31, limit: 40, full: false, state: "open", checked_at: CHECKED, source: "Planning Center Registrations" });
    // A signup whose registration closed in the past isn't upcoming.
    expect(facts.signups.some(s => s.signup_id === "644")).toBe(false);
    expect(facts.not_checked).toEqual([]);
    expect(JSON.stringify(facts)).not.toContain("Avery");
  });

  it("an unread, refused or partly read count is not checked or at least, never a number it isn't", () => {
    const facts = registrationsFacts(registrations([attendees("640", 300, "truncated"), attendees("641", 0, "denied")]), base)!;
    expect(facts.signups.find(s => s.signup_id === "640")!.title).toBe("Fall retreat: at least 300 of 40 places taken (full); registration closes Friday, November 20 at 6:00 PM");
    expect(facts.signups.find(s => s.signup_id === "641")!.registered).toBeNull();
    expect(facts.signups.find(s => s.signup_id === "641")!.title).toBe("Men's breakfast: registration is open; no closing date is set in Planning Center");
    expect(facts.not_checked).toEqual([
      "How many registered for Men's breakfast: Planning Center didn't allow it.",
      "How many registered for Christmas choir: weren't part of this check.",
    ]);
  });

  it("without the church's time zone, dates say they're in this Mac's time zone", () => {
    const c = registrations();
    c.reads = c.reads.filter(r => r.collection !== "organization");
    const facts = registrationsFacts(c, base, { zone: "America/New_York" })!;
    expect(facts.signups[1]!.title).toBe("Fall retreat: 31 of 40 places taken; registration closes Friday, November 20 at 7:00 PM");
    expect(facts.not_checked).toEqual(["Dates for signups are in this Mac's time zone: the church's time zone wasn't read."]);
  });

  it("is absent without any Registrations read; a failed list says so", () => {
    expect(registrationsFacts(capture([]), base)).toBeNull();
    const failed = registrationsFacts(capture([read("registrations_signups", undefined, {}, "rate-limited")]), base)!;
    expect(failed.signups).toEqual([]);
    expect(failed.not_checked).toEqual(["Registrations signups: couldn't be read."]);
  });
});

// ---- Church rules ---------------------------------------------------------------------------------------

describe("Church rules for the church reads", () => {
  it("forms are off until turned on, then watched by id, at most ten", () => {
    expect(formIdsForCheck(base)).toBeNull();
    const on = withFormsOn(base, true);
    expect(formIdsForCheck(on)).toEqual([]);
    let rules = on;
    for (let i = 0; i < MAX_WATCHED_FORMS + 1; i++) rules = withWatchedForm(rules, String(610 + i), true);
    expect(watchedForms(rules)).toHaveLength(MAX_WATCHED_FORMS);
    expect(watchedForms(withWatchedForm(rules, "610", false))).not.toContain("610");
    expect(watchedForms({ ...base, forms: { on: true, watched: ["610", "610", "0612", "x", 7 as unknown as string] } })).toEqual(["610"]);
    expect(formIdsForCheck(withFormsOn(rules, false))).toBeNull();
  });

  it("a Check-Ins room matches one kids team; the match can be changed or taken away", () => {
    let rules = withRoomMatch(base, "650", "71");
    rules = withRoomMatch(rules, "650", "72");
    expect(roomMatches(rules)).toEqual([{ location_id: "650", team_id: "72" }]);
    expect(roomMatches(withRoomMatch(rules, "650", null))).toEqual([]);
    expect(roomMatches({ ...base, checkIns: { rooms: [{ location_id: "650", team_id: "x" }, { location_id: "651", team_id: "71" }, { location_id: "651", team_id: "72" }] } }))
      .toEqual([{ location_id: "651", team_id: "71" }]);
    expect(checkInsEvent(withCheckInsEvent(rules, "620"))).toBe("620");
    expect(checkInsEvent(withCheckInsEvent(withCheckInsEvent(rules, "620"), null))).toBeNull();
    expect(roomMatches(withCheckInsEvent(rules, "620"))).toEqual(roomMatches(rules));
  });
});
