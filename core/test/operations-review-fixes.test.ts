// Regression tests for the second independent review of rooms, follow-ups and group meetings
// (ported from the reviewer's probes, asserting the fixed behaviour). Fictional fixed data only.
import { afterEach, describe, expect, it } from "vitest";
import { sundayOperations, type OperationsOptions } from "../src/operations-capture.js";
import { FICTIONAL_ROOM, FICTIONAL_WORKFLOW, withFictionalOperations } from "../src/fictional-operations.js";
import { nov22Capture } from "../src/fictional-sunday.js";
import type { RoomFinding } from "../src/operations-findings/index.js";
import type { SundayCapture, SundayRead, SundayRules } from "../src/sunday-capture.js";

const none: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const notShared = (setup = 0): SundayRules => ({ ...none, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: setup }] });
const capture = () => withFictionalOperations(nov22Capture());
const ops = (c: SundayCapture, rules: SundayRules = none, o: OperationsOptions = {}) => sundayOperations(c, rules, o)!;
const reads = (c: SundayCapture, collection: string) => c.reads.filter(r => r.collection === collection);
type BookingRow = { id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, { data: { type: string; id: string } | null }> };
const bookings = (c: SundayCapture) => reads(c, "calendar_resource_bookings")[0]!.body!.data as BookingRow[];
const overlaps = (c: SundayCapture, rules: SundayRules = none) => ops(c, rules).result!.findings.filter((f): f is RoomFinding => f.kind === "room-overlap");
const setZone = (c: SundayCapture, zone: unknown) => {
  (reads(c, "organization")[0]!.body!.data as { attributes: Record<string, unknown> }).attributes.time_zone = zone;
  return c;
};
const ZONE_LINE = "so room bookings and group meetings weren't checked.";

describe("H1: an out-of-date live check", () => {
  it("shows no result, no clear line and no fresh-looking check time (P4)", () => {
    const c: SundayCapture = { ...capture(), kind: "live" };
    const o = ops(c, notShared(), { now: "2026-11-20T16:30:00Z" });
    expect(o.stale).toBe(true);
    expect(o.result).toBeNull();
    expect(o.clear).toEqual([]);
    expect(o.checked_at).toBeNull();
    expect(o.group_meetings).toEqual([]);
    expect(o.not_checked).toContain("Rooms, follow-ups and group meetings: this check is out of date, so they aren't shown.");
  });
  it("names its check time only from Planning Center reads, never Church rules or the clock", () => {
    const o = ops(capture(), notShared());
    expect(o.checked_at).toBe(reads(capture(), "calendar_rooms")[0]!.checked_at);
    // The rule scope holds as of the evaluation; it isn't what the page names as "checked".
    const rule = o.result!.checked_scopes.find(s => s.source === "church-rule")!;
    expect(rule.check_time).toBe(capture().completed_at);
    expect(o.checked_at).not.toBe(rule.check_time);
    // With no overlapping pairs, the pairs scope rests on the bookings read, not the evaluation time.
    const quiet = capture();
    bookings(quiet)[1]!.attributes.starts_at = "2026-11-22T16:30:00Z";
    bookings(quiet)[1]!.attributes.ends_at = "2026-11-22T17:00:00Z";
    const pairs = ops(quiet).result!.checked_scopes.find(s => s.kind === "room-resolutions")!;
    expect(pairs.check_time).toBe(reads(quiet, "calendar_resource_bookings")[0]!.checked_at);
  });
});

describe("H2: the clear line", () => {
  it("never appears when bookings and workflows were refused, even with every room ruled (P3)", () => {
    const c = capture();
    for (const r of [...reads(c, "calendar_resource_bookings"), ...c.reads.filter(r => r.collection.startsWith("people_"))]) { r.outcome = "denied"; delete r.body; }
    const o = ops(c, notShared());
    expect(o.clear).toEqual([]);
    expect(o.not_checked).toEqual(expect.arrayContaining(["Room bookings: Planning Center didn't allow it.", "Follow-up workflows: Planning Center didn't allow it."]));
  });
  it("names only the parts fully checked, and only when every part present was", () => {
    // Nothing found anywhere: no overlaps (lunch moved), no unowned overdue card.
    const quiet = () => {
      const c = capture();
      bookings(c)[1]!.attributes.starts_at = "2026-11-22T16:30:00Z";
      bookings(c)[1]!.attributes.ends_at = "2026-11-22T17:00:00Z";
      (reads(c, "people_workflow_ready_cards")[0]!.body!.data as unknown[]).splice(0, 1);
      return c;
    };
    expect(ops(quiet(), notShared()).clear).toEqual(["rooms", "follow-ups"]);
    // A booked room with no Church rule is itself worth a look, so nothing is called clear.
    expect(ops(quiet()).clear).toEqual([]);
    // Rooms turned off: the line names follow-ups alone.
    const off = quiet();
    for (const r of [...reads(off, "calendar_rooms"), ...reads(off, "calendar_resource_bookings"), ...reads(off, "calendar_conflicts")]) { r.outcome = "not-requested"; delete r.body; }
    expect(ops(off).clear).toEqual(["follow-ups"]);
    // A refused part blocks the line for both.
    const refused = quiet();
    for (const r of reads(refused, "people_workflow_snoozed_cards")) { r.outcome = "denied"; delete r.body; }
    expect(ops(refused, notShared()).clear).toEqual([]);
  });
  it("a large room list no longer leaves rooms unchecked: only rooms booked that Sunday are evaluated (P9)", () => {
    const c = capture();
    const list = reads(c, "calendar_rooms")[0]!.body!.data as unknown[];
    for (let i = 0; i < 42; i++) list.push({ type: "Resource", id: String(900000 + i), attributes: { kind: "Room" } });
    (reads(c, "people_workflow_ready_cards")[0]!.body!.data as unknown[]).splice(0, 1);
    const o = ops(c, notShared());
    expect(o.not_checked).toEqual([]);
    expect(overlaps(c, notShared()).map(f => f.label)).toEqual(["Room use needs review"]);
    expect(o.result!.checked_scopes.filter(s => s.target.kind === "room").map(s => s.target.kind === "room" && s.target.resource_id)).toEqual(Array(3).fill(`room${FICTIONAL_ROOM}`));
  });
  it("more booked rooms than one check holds: rooms are not checked, never clear", () => {
    const c = capture();
    const list = reads(c, "calendar_rooms")[0]!.body!.data as unknown[];
    const rows = bookings(c);
    for (let i = 0; i < 43; i++) {
      list.push({ type: "Resource", id: String(900000 + i), attributes: { kind: "Room" } });
      rows.push({ ...structuredClone(rows[2]!), id: String(42000000 + i), relationships: { ...structuredClone(rows[2]!.relationships), resource: { data: { type: "Resource", id: String(900000 + i) } } } });
    }
    const o = ops(c);
    expect(o.not_checked).toContain("Room bookings: more than Ozzie checks at once, so none are shown.");
    expect(o.clear).toEqual([]);
    expect(o.result!.findings.map(f => f.kind)).toEqual(["unowned-overdue"]);
  });
  it("follow-ups are checked per workflow: one too large to check leaves only itself unchecked", () => {
    const c = capture();
    const big = "795990";
    (reads(c, "people_workflows")[0]!.body!.data as unknown[]).push({ type: "Workflow", id: big, attributes: {} });
    const card = (id: string, step: string) => ({ type: "WorkflowCard", id, attributes: { stage: "ready", calculated_due_at: "2026-10-26T21:27:40Z", overdue: true, snooze_until: null, completed_at: null, removed_at: null },
      relationships: { assignee: { data: null }, current_step: { data: { type: "WorkflowStep", id: step } }, workflow: { data: { type: "Workflow", id: big } } } });
    const page = (data: unknown[]) => ({ data, meta: { count: data.length, total_count: data.length } });
    const read = (collection: string, data: unknown[]): SundayRead => ({ collection, offset: 0, checked_at: c.completed_at, outcome: "ok", workflow_id: big, body: page(data) });
    const steps = Array.from({ length: 26 }, (_, i) => String(3000000 + i));
    c.reads.push(read("people_workflow_steps", steps.map(id => ({ type: "WorkflowStep", id, attributes: {}, relationships: { workflow: { data: { type: "Workflow", id: big } } } }))),
      read("people_workflow_ready_cards", steps.map((s, i) => card(String(57000000 + i), s))), read("people_workflow_snoozed_cards", []));
    const o = ops(c);
    expect(o.not_checked).toEqual(["Follow-ups in 1 workflow: more than Ozzie checks at once, so none are shown."]);
    const follow = o.result!.findings.filter(f => f.kind === "unowned-overdue");
    expect(follow.map(f => f.kind === "unowned-overdue" && f.workflow_id)).toEqual([`workflow${FICTIONAL_WORKFLOW}`]);
    expect(o.clear).toEqual([]);
  });
});

describe("H3: a Calendar conflict names a pair only between two different visible events", () => {
  it("two bookings of one event don't borrow that event's conflict with a third (P2)", () => {
    const c = capture();
    const b = bookings(c);
    b[2]!.relationships.event = { data: { type: "Event", id: "23167823" } };
    b[3]!.relationships.event = { data: { type: "Event", id: "23167823" } };
    b[3]!.attributes.starts_at = "2026-11-22T19:30:00Z";
    c.reads = c.reads.filter(r => !(r.collection === "calendar_conflicts" && (r.event_id === "23167937" || r.event_id === "23167940")));
    const pair = overlaps(c, notShared(30)).find(f => f.bookings.some(x => x.booking_id === "booking41000003"))!;
    expect(pair).toMatchObject({ label: "Worth a look", certainty: "uncertain", resolution: { state: "unknown" } });
    // Overlapping only with setup time, the same pair is never confirmed either: it's a question, not a finding.
    b[3]!.attributes.starts_at = "2026-11-22T20:00:00Z";
    expect(overlaps(c, notShared(30)).filter(f => f.bookings.some(x => x.booking_id === "booking41000003"))).toEqual([]);
    expect(ops(c, notShared(30)).result!.uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-resolution", subject_id: `room${FICTIONAL_ROOM}` }));
    // The real pair keeps Calendar's own record.
    expect(overlaps(c, notShared(30)).find(f => f.bookings.some(x => x.booking_id === "booking41000001"))!.resolution!.state).toBe("unresolved");
  });
  it("a redacted BookedEvent side, or a conflict listed under a third event too, is unknown", () => {
    const stub = capture();
    bookings(stub)[1]!.relationships.event = { data: { type: "BookedEvent", id: "23167837" } };
    expect(overlaps(stub, notShared()).map(f => [f.certainty, f.resolution?.state])).toEqual([["uncertain", "unknown"]]);
    const third = capture();
    const extra = structuredClone(reads(third, "calendar_conflicts").find(r => r.event_id === "23167823")!);
    extra.event_id = "23167937";
    third.reads = third.reads.filter(r => !(r.collection === "calendar_conflicts" && r.event_id === "23167937")).concat(extra);
    expect(overlaps(third, notShared()).map(f => f.resolution?.state)).toEqual(["unknown"]);
  });
});

describe("M1: setup time and Calendar's record", () => {
  it("a confirmed overlap whose setup reaches before both starts still finds Calendar's unresolved record (P1)", () => {
    const c = capture();
    bookings(c)[1]!.attributes.starts_at = "2026-11-22T14:00:00Z";
    for (const setup of [0, 30]) {
      const [f] = overlaps(c, notShared(setup));
      expect(f).toMatchObject({ label: "Room use needs review", certainty: "confirmed", resolution: { state: "unresolved" } });
      expect(f!.resolution!.interval.starts_at).toBe(new Date(Date.parse("2026-11-22T14:00:00Z") - setup * 60_000).toISOString());
      expect(ops(c, notShared(setup)).result!.uncertainties.map(u => u.code)).not.toContain("unknown-resolution");
    }
  });
});

describe("M2: the church's own time zone decides its Sunday", () => {
  const original = process.env.TZ;
  afterEach(() => { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; });
  it("this Mac's zone never does (P5)", () => {
    const c = capture();
    const b = bookings(c);
    b[4]!.attributes.starts_at = "2026-11-23T04:00:00Z"; b[4]!.attributes.ends_at = "2026-11-23T05:30:00Z";
    b[5]!.attributes.starts_at = "2026-11-23T05:00:00Z"; b[5]!.attributes.ends_at = "2026-11-23T06:00:00Z";
    const windows = new Set<string>();
    for (const tz of ["Asia/Tokyo", "America/Los_Angeles", "UTC"]) {
      process.env.TZ = tz;
      windows.add(JSON.stringify(ops(c).result!.window));
    }
    expect([...windows]).toEqual([JSON.stringify({ starts_at: "2026-11-22T05:00:00.000Z", ends_at: "2026-11-23T05:00:00.000Z" })]);
    // A Pacific church's Sunday holds the late pair; an Eastern one's doesn't.
    const pacific = setZone(structuredClone(c), "America/Los_Angeles");
    expect(overlaps(pacific).map(f => f.bookings.map(x => x.booking_id))).toEqual([["booking41000001", "booking41000002"], ["booking41000005", "booking41000006"]]);
    expect(overlaps(c).map(f => f.bookings.map(x => x.booking_id))).toEqual([["booking41000001", "booking41000002"]]);
  });
  it.each([
    ["missing", (c: SundayCapture) => { c.reads = c.reads.filter(r => r.collection !== "organization"); }, "The church's time zone wasn't part of this check"],
    ["refused", (c: SundayCapture) => { const r = reads(c, "organization")[0]!; r.outcome = "denied"; delete r.body; }, "The church's time zone couldn't be read from Planning Center"],
    ["not an IANA name", (c: SundayCapture) => { setZone(c, "Eastern Time (US & Canada)"); }, "Planning Center's time zone for the church isn't one Ozzie recognizes"],
  ])("without a usable zone (%s), rooms and group meetings are not checked and follow-ups still are", (_, change, line) => {
    const c = capture();
    change(c);
    const o = ops(c);
    expect(o.not_checked).toContain(`${line}, ${ZONE_LINE}`);
    expect(o.result!.findings.map(f => f.kind)).toEqual(["unowned-overdue"]);
    expect(o.group_meetings).toEqual([]);
    expect(o.clear).toEqual([]);
  });
  it("accepts names this Mac canonicalizes (Asia/Kathmandu, Asia/Kolkata, Etc/UTC)", () => {
    expect(ops(setZone(capture(), "Asia/Kathmandu")).result!.window).toEqual({ starts_at: "2026-11-21T18:15:00.000Z", ends_at: "2026-11-22T18:15:00.000Z" });
    expect(ops(setZone(capture(), "Asia/Kolkata")).result!.churchTimeZone).toBe("Asia/Kolkata");
    expect(ops(setZone(capture(), "Etc/UTC")).not_checked.some(l => l.includes(ZONE_LINE))).toBe(false);
  });
});

describe("L7: only rooms in Calendar's room list", () => {
  it("a booking of a resource that isn't a listed room is ignored, not a failure", () => {
    const c = capture();
    bookings(c)[1]!.relationships.resource = { data: { type: "Resource", id: "990001" } };
    const o = ops(c, notShared());
    expect(overlaps(c, notShared())).toEqual([]);
    expect(o.not_checked).toEqual([]);
  });
  it("an unreadable room list leaves room bookings unchecked", () => {
    const c = capture();
    for (const r of reads(c, "calendar_rooms")) { r.outcome = "timeout"; delete r.body; }
    const o = ops(c, notShared());
    expect(overlaps(c, notShared())).toEqual([]);
    expect(o.not_checked).toEqual(["Room list: took too long.", "Room bookings: not checked without the room list."]);
    expect(o.clear).toEqual([]);
  });
});
