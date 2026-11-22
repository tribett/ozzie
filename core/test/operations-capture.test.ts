import { describe, expect, it } from "vitest";
import { capturePlanDate, captureRooms, operationsFromCapture, operationsNotChecked, roomsReadComplete, sundayOperations, type OperationsOptions } from "../src/operations-capture.js";
import {
  FICTIONAL_CARDS, FICTIONAL_GROUP, FICTIONAL_ROOM, FICTIONAL_STEP, FICTIONAL_TIME_ZONE, FICTIONAL_WINDOW, FICTIONAL_WORKFLOW,
  fictionalOperations, withFictionalOperations, withFictionalOperationsOff,
} from "../src/fictional-operations.js";
import { CHECKED, nov22Capture, PEOPLE } from "../src/fictional-sunday.js";
import { buildSundayBrief } from "../src/sunday-brief.js";
import type { SundayCapture, SundayRead, SundayRules } from "../src/sunday-capture.js";
import type { RoomFinding } from "../src/operations-findings/index.js";
import { backgroundWording } from "../src/harness/background-wording.js";

// Fictional fixed data only (see fictional-operations.ts). Evaluated in the fictional church's zone,
// which the capture's own Services Organization read gives.
const none: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const sanctuary: SundayRules = { ...none, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 30 }] };
const capture = () => withFictionalOperations(nov22Capture());
const ops = (c: SundayCapture = capture(), rules: SundayRules = none, o: OperationsOptions = {}) => sundayOperations(c, rules, o)!;
const reads = (c: SundayCapture, collection: string) => c.reads.filter(r => r.collection === collection);
const edit = (c: SundayCapture, collection: string, change: (r: SundayRead) => void) => { reads(c, collection).forEach(change); return c; };
const RESOLUTION = "Whether overlapping room bookings were already worked out in Planning Center couldn't be read.";
const room = `room${FICTIONAL_ROOM}`;
const booking = (n: number) => `booking4100000${n}`;
const roomFindings = (c = capture(), rules = none) => ops(c, rules).result!.findings.filter((f): f is RoomFinding => f.kind === "room-overlap");
/** Same capture, every Calendar, People and Groups read recorded as the native check records it without consent. */
const notRequested = () => withFictionalOperationsOff(nov22Capture());

describe("rooms, follow-ups and group meetings from the capture", () => {
  it("returns nothing for a capture without operations reads (made before they existed)", () => {
    expect(sundayOperations(nov22Capture(), none)).toBeNull();
    expect(operationsFromCapture(nov22Capture(), none)).toBeNull();
    expect(operationsNotChecked(null)).toEqual(["Room bookings and follow-ups weren't part of this check."]);
  });

  it("the example runs the real mapper: one overlap worth a look, one unowned overdue follow-up, one group meeting", () => {
    const o = ops();
    const result = o.result!;
    expect(result.binding).not.toBeNull();
    expect(result.window).toEqual({ starts_at: "2026-11-22T05:00:00.000Z", ends_at: "2026-11-23T05:00:00.000Z" });
    expect(result.churchTimeZone).toBe(FICTIONAL_TIME_ZONE);
    // Service 09:00-11:00 and lunch setup 10:45-11:15 overlap by 15 minutes; the later pairs don't overlap.
    expect(result.findings.map(f => [f.kind, f.label, f.certainty])).toEqual([
      ["unowned-overdue", "Follow-up needs an owner", "confirmed"],
      ["room-overlap", "Worth a look", "uncertain"],
    ]);
    const [overlap] = roomFindings();
    expect(overlap!.resource_id).toBe(room);
    expect(overlap!.bookings.map(b => [b.booking_id, b.status])).toEqual([[booking(1), "approved"], [booking(2), "approved"]]);
    expect(overlap!.overlap).toEqual({ starts_at: "2026-11-22T15:45:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" });
    expect(overlap!.evidence.map(e => [e.kind, e.source, e.check_time])).toEqual([["bookings", "normalized-calendar", CHECKED], ["room-resolutions", "normalized-calendar", CHECKED], ["room-rule", "church-rule", nov22Capture().completed_at]]);
    // Owned-late and snoozed controls are not findings.
    const follow = result.findings.find(f => f.kind === "unowned-overdue")!;
    expect(follow.kind === "unowned-overdue" && [follow.workflow_id, follow.step_id, follow.card_id, follow.due_at])
      .toEqual([`workflow${FICTIONAL_WORKFLOW}`, `step${FICTIONAL_STEP}`, `card${FICTIONAL_CARDS.unowned}`, "2026-10-26T21:27:40Z"]);
    // Calendar records the pair as unresolved, but no room rule is set: worth a look, never confirmed.
    expect([...new Set(result.uncertainties.map(u => u.code))].sort()).toEqual(["unknown-rule"]);
    expect(result.unchecked_scope_ids).toEqual([]);
    expect(o.labels).toEqual({ [room]: "Sanctuary (fictional)", [`workflow${FICTIONAL_WORKFLOW}`]: "Welcome follow-up (fictional)", [`step${FICTIONAL_STEP}`]: "Call a first-time guest" });
    expect(o.group_meetings).toEqual([{ person_id: PEOPLE.lyricsPending, checked_at: CHECKED,
      serving: [{ position: "Lyrics", status: "pending", interval: { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z" } }],
      meetings: [{ starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z" }] }]);
    expect(o.not_checked).toEqual([]);
  });

  it("not shared + setup time + Calendar's unresolved conflict confirms the overlap, with setup applied", () => {
    const result = ops(capture(), sanctuary).result!;
    expect(result.uncertainties.map(u => u.code)).not.toContain("unknown-rule");
    const findings = roomFindings(capture(), sanctuary);
    expect(findings).toHaveLength(1);
    expect(findings[0]!).toMatchObject({ label: "Room use needs review", certainty: "confirmed", additional_setup_minutes: 30 });
    expect(findings[0]!.resolution).toMatchObject({ state: "unresolved", booking_ids: [booking(1), booking(2)] });
  });

  const conflict = (resolved_at: string | null, winner: string | null) => edit(capture(), "calendar_conflicts", r => {
    for (const row of r.body!.data as { attributes: Record<string, unknown>; relationships: Record<string, unknown> }[]) {
      row.attributes.resolved_at = resolved_at; row.relationships.winner = { data: winner ? { type: "Event", id: winner } : null };
    }
  });

  it("a conflict Calendar marks resolved is never hidden unless the other booking was declined: resolved with no winner, or a winner over an approved booking, is unknown", () => {
    for (const c of [conflict("2026-11-19T15:00:00Z", "23167823"), conflict("2026-11-19T15:00:00Z", null)]) {
      const findings = roomFindings(c, sanctuary);
      expect(findings.map(f => [f.label, f.certainty, f.resolution?.state])).toEqual([["Worth a look", "uncertain", "unknown"]]);
      expect(ops(c, sanctuary).result!.uncertainties.map(u => u.code)).toContain("unknown-resolution");
    }
    // The losing booking's request declined: Calendar settled it, and the declined booking isn't in the room.
    const declined = edit(conflict("2026-11-19T15:00:00Z", "23167823"), "calendar_resource_bookings", r => {
      (r.body!.included as { id: string; attributes: { approval_status: string } }[]).find(x => x.id === "52000002")!.attributes.approval_status = "R";
    });
    expect(roomFindings(declined, sanctuary)).toEqual([]);
  });

  it("an unreadable conflict read never confirms or clears an overlap, and is named as not checked", () => {
    const c = edit(capture(), "calendar_conflicts", r => { if (r.event_id === "23167837") { r.outcome = "denied"; delete r.body; } });
    const o = ops(c, sanctuary);
    expect(o.result!.findings.filter(f => f.kind === "room-overlap").map(f => f.certainty)).toEqual(["uncertain"]);
    expect(o.result!.unchecked_scope_ids).toEqual([`${room}-pairs`]);
    expect(o.not_checked).toEqual([RESOLUTION]);
  });

  it("ignores malformed stored room rules and rules for rooms that weren't read", () => {
    const junk = { ...none, rooms: [{ room_id: "x", exclusive: true, setup_minutes: 30 }, { room_id: "999", exclusive: true, setup_minutes: 5 },
      { room_id: FICTIONAL_ROOM, exclusive: "yes", setup_minutes: -1 }] } as unknown as SundayRules;
    expect(ops(capture(), junk).result!.uncertainties.map(u => u.code)).toContain("unknown-rule");
    expect(ops(capture(), { ...none, rooms: "nope" } as unknown as SundayRules).result!.binding).not.toBeNull();
  });

  it("turned off in Settings: nothing is shown as clear, with its own wording", () => {
    const o = ops(notRequested());
    expect(o.result).toBeNull();
    expect(o.group_meetings).toEqual([]);
    expect(o.not_checked).toEqual(["Rooms and follow-ups weren't checked. Turn this on in Settings.", "Group meetings weren't checked either."]);
    expect(o.labels).toEqual({});
  });

  it("Services stays a full picture when operations reads are turned off or refused", () => {
    for (const c of [notRequested(), edit(capture(), "calendar_resource_bookings", r => { r.outcome = "denied"; delete r.body; })]) {
      const brief = buildSundayBrief(c, none, c.completed_at, true);
      const plain = buildSundayBrief(nov22Capture(), none, c.completed_at, true);
      expect(brief.sources).toEqual(plain.sources);
      expect(brief.findings.map(f => f.key)).toEqual(plain.findings.map(f => f.key));
      expect(brief.status).toBe(plain.status);
      expect(brief.not_checked).not.toContain("Group events weren't part of this check.");
    }
    expect(buildSundayBrief(nov22Capture(), none, CHECKED, true).not_checked).toContain("Group events weren't part of this check.");
  });

  it.each([
    ["denied", "Room bookings: Planning Center didn't allow it."],
    ["truncated", "Room bookings: only partly read."],
    ["timeout", "Room bookings: took too long."],
    ["provider-failure", "Room bookings: couldn't be read."],
  ])("a %s bookings read leaves rooms unchecked, never clear, and follow-ups still count", (outcome, line) => {
    const c = edit(capture(), "calendar_resource_bookings", r => { r.outcome = outcome; if (outcome !== "truncated") delete r.body; });
    const o = ops(c);
    expect(o.result!.findings.map(f => f.kind)).toEqual(["unowned-overdue"]);
    // A partly read page's rooms are evaluated as unverified; an unanswered one has no booked room to evaluate.
    if (outcome === "truncated") expect(o.result!.unchecked_scope_ids).toEqual(expect.arrayContaining([`${room}-bookings`]));
    expect(o.clear).toEqual([]);
    expect(o.not_checked).toContain(line);
  });

  it("bookings read without a room list still name nothing clear when the bookings read fails", () => {
    const c = edit(edit(capture(), "calendar_rooms", r => { r.outcome = "denied"; delete r.body; }), "calendar_resource_bookings", r => { r.outcome = "denied"; delete r.body; });
    const o = ops(c);
    expect(o.result!.findings.map(f => f.kind)).toEqual(["unowned-overdue"]);
    expect(o.not_checked).toContain("Room bookings: Planning Center didn't allow it.");
  });

  it("a recorded window that doesn't cover the church-local Sunday makes rooms and group meetings unverified", () => {
    const shifted = { starts_at: "2026-11-22T10:00:00Z", ends_at: "2026-11-23T12:00:00Z" };
    const c = edit(edit(capture(), "calendar_resource_bookings", r => { r.window = shifted; }), "groups_group_events", r => { r.window = shifted; });
    const o = ops(c);
    expect(roomFindings(c)).toEqual([]);
    expect(o.result!.unchecked_scope_ids).toContain(`${room}-bookings`);
    expect(o.not_checked).toEqual(expect.arrayContaining(["Room bookings: the read didn't cover the whole day of the service.", "Group meetings for 1 person: the read didn't cover the whole day of the service."]));
    // A found meeting is still a fact; the missing coverage is listed, not hidden.
    expect(o.group_meetings.map(m => m.person_id)).toEqual([PEOPLE.lyricsPending]);
    const missing = edit(capture(), "calendar_resource_bookings", r => { delete r.window; });
    expect(ops(missing).not_checked).toContain("Room bookings: the read didn't cover the whole day of the service.");
  });

  it("the church-local day decides: evening bookings that cross the UTC date stay, a Saturday-evening one doesn't", () => {
    const c = edit(capture(), "calendar_resource_bookings", r => {
      const rows = r.body!.data as { id: string; attributes: { starts_at: string; ends_at: string } }[];
      // Saturday 19:30-20:30 Eastern, on the UTC Sunday: overlaps nothing on the local Sunday.
      rows.push({ ...structuredClone(rows[0]!), id: "41000007", attributes: { starts_at: "2026-11-22T00:30:00Z", ends_at: "2026-11-22T01:30:00Z" } } as never);
      // Sunday 19:00-20:15 Eastern (00:00-01:15Z Monday): overlaps the 18:00-19:15 and 20:00-20:30 bookings.
      rows.push({ ...structuredClone(rows[0]!), id: "41000008", attributes: { starts_at: "2026-11-23T00:00:00Z", ends_at: "2026-11-23T01:15:00Z" } } as never);
      (r.body!.meta as { total_count: number }).total_count = rows.length;
    });
    const pairs = roomFindings(c).map(f => f.bookings.map(b => b.booking_id));
    expect(pairs).toEqual([[booking(1), booking(2)], [booking(5), "booking41000008"], [booking(6), "booking41000008"]]);
    // In another church zone (UTC) the local Sunday moves, and so does what's on it.
    edit(c, "organization", r => { (r.body!.data as { attributes: { time_zone: string } }).attributes.time_zone = "UTC"; });
    expect(roomFindings(c).length).not.toBe(pairs.length);
  });

  it("maps approval: pending stays a booking, rejected is dropped, a missing or ambiguous request is unknown", () => {
    const status = (code: string | null, linkRequest = true) => {
      const c = edit(capture(), "calendar_resource_bookings", r => {
        const included = r.body!.included as { id: string; attributes: { approval_status: string } }[];
        if (code === null) r.body!.included = included.filter(x => x.id !== "52000002"); else included.find(x => x.id === "52000002")!.attributes.approval_status = code;
        if (!linkRequest) for (const row of r.body!.data as { relationships: Record<string, unknown> }[]) delete row.relationships.event_resource_request;
      });
      return ops(c).result!;
    };
    expect(roomFindings(capture()).length).toBe(1);
    const pending = status("P");
    expect(pending.findings.find(f => f.kind === "room-overlap")!.kind === "room-overlap" &&
      (pending.findings.find(f => f.kind === "room-overlap") as RoomFinding).bookings.map(b => b.status)).toEqual(["approved", "requested"]);
    expect(status("R").findings.filter(f => f.kind === "room-overlap")).toEqual([]);
    expect(status(null).uncertainties.map(u => u.code)).toContain("unknown-booking");
    // Joined by (event, resource) when the booking doesn't link its request.
    expect(status("A", false).uncertainties.map(u => u.code)).not.toContain("unknown-booking");
    const ambiguous = edit(capture(), "calendar_resource_bookings", r => {
      for (const row of r.body!.data as { relationships: Record<string, unknown> }[]) delete row.relationships.event_resource_request;
      const included = r.body!.included as { id: string; relationships: { event: { data: { id: string } } } }[];
      included.push({ ...structuredClone(included[0]!), id: "52000099" });
    });
    expect(ops(ambiguous).result!.uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-booking", subject_id: booking(1) }));
  });

  it("maps cards: an owner means no finding, a missing owner link is unknown, an ended snooze needs a fresh look", () => {
    const withCard = (change: (card: { attributes: Record<string, unknown>; relationships: Record<string, unknown> }) => void, collection = "people_workflow_ready_cards", id = FICTIONAL_CARDS.unowned) =>
      ops(edit(capture(), collection, r => change((r.body!.data as never[]).find((c: { id: string }) => c.id === id)!))).result!;
    expect(withCard(c => { c.relationships.assignee = { data: { type: "Assignee", id: "50002" } }; }).findings.filter(f => f.kind === "unowned-overdue")).toEqual([]);
    const unknown = withCard(c => { delete c.relationships.assignee; });
    expect(unknown.findings.filter(f => f.kind === "unowned-overdue")).toEqual([]);
    expect(unknown.uncertainties.map(u => u.code)).toContain("unknown-card");
    expect(withCard(c => { c.attributes.completed_at = "2026-11-01T12:00:00Z"; }).findings.filter(f => f.kind === "unowned-overdue")).toEqual([]);
    expect(withCard(c => { c.attributes.calculated_due_at = "2026-11-25T12:00:00Z"; }).findings.filter(f => f.kind === "unowned-overdue")).toEqual([]);
    const ended = withCard(c => { c.attributes.snooze_until = "2026-11-19T12:00:00Z"; }, "people_workflow_snoozed_cards", FICTIONAL_CARDS.snoozed);
    expect(ended.uncertainties.map(u => u.code)).toContain("snooze-recheck");
  });

  it("follow-ups that couldn't be fully read are listed, and the ones that were read still count", () => {
    const partial = edit(capture(), "people_workflows", r => { r.outcome = "truncated"; });
    expect(ops(partial).not_checked).toContain("Follow-up workflows: only partly read.");
    expect(ops(partial).result!.findings.map(f => f.kind)).toContain("unowned-overdue");
    const snoozed = edit(capture(), "people_workflow_snoozed_cards", r => { r.outcome = "denied"; delete r.body; });
    const o = ops(snoozed);
    expect(o.not_checked).toContain("Follow-ups in 1 workflow: Planning Center didn't allow it.");
    expect(o.result!.findings.map(f => f.kind)).not.toContain("unowned-overdue");
    expect(o.result!.unchecked_scope_ids).toContain(`w${FICTIONAL_WORKFLOW}-s${FICTIONAL_STEP}-owner`);
    const gone = capture();
    gone.reads = gone.reads.filter(r => r.collection !== "people_workflow_ready_cards");
    expect(ops(gone).not_checked).toContain("Follow-ups in 1 workflow: not read.");
  });

  it("an out-of-date live check shows its out-of-date state only: no result, no group meetings, nothing clear", () => {
    const live = capture();
    const o = ops(live, none, { now: "2026-11-20T16:00:00Z" });
    expect(o).toMatchObject({ result: null, stale: true, clear: [], checked_at: null, group_meetings: [] });
    expect(o.not_checked).toContain("Rooms, follow-ups and group meetings: this check is out of date, so they aren't shown.");
    // A recording is evaluated as of its own completion, whatever the clock says.
    expect(ops({ ...live, kind: "recording" }, none, { now: "2026-11-26T09:00:00Z" }).result!.findings).toHaveLength(2);
  });

  it("group meetings: a canceled or non-overlapping meeting, a declined assignment or an unread group says nothing is clear", () => {
    const event = (change: (e: { attributes: Record<string, unknown> }) => void) =>
      ops(edit(capture(), "groups_group_events", r => change((r.body!.data as never[])[0]!))).group_meetings;
    expect(event(e => { e.attributes.canceled = true; })).toEqual([]);
    expect(event(e => { e.attributes.starts_at = "2026-11-22T15:30:00Z"; e.attributes.ends_at = "2026-11-22T16:30:00Z"; })).toEqual([]);
    const declined = edit(capture(), "team_members", r => { (r.body!.data as { id: string; attributes: { status: string } }[]).find(m => m.id === "403")!.attributes.status = "D"; });
    expect(ops(declined).group_meetings).toEqual([]);
    const refused = edit(capture(), "groups_group_events", r => { r.outcome = "denied"; delete r.body; });
    expect(ops(refused).group_meetings).toEqual([]);
    expect(ops(refused).not_checked).toContain("Group meetings for 1 person: Planning Center didn't allow it.");
    const unread = capture();
    unread.reads = unread.reads.filter(r => !(r.collection === "groups_person_memberships" && r.groups_person_id === PEOPLE.greeterConfirmed));
    expect(ops(unread).not_checked).toContain("Group meetings for 1 person: not read.");
  });

  it("keeps ids and intervals only: no person or room names in the evaluated result or group meetings", () => {
    const c = capture();
    const o = ops(c, sanctuary);
    const json = JSON.stringify({ result: o.result, group_meetings: o.group_meetings, not_checked: o.not_checked });
    for (const name of [...Object.values(c.names), ...Object.values(c.labels!)]) expect(json).not.toContain(name);
  });

  it("labels come from the capture's local labels, falling back to read bodies only for older recordings", () => {
    const old = capture();
    delete old.labels;
    edit(old, "calendar_rooms", r => { (r.body!.data as { attributes: Record<string, unknown> }[])[0]!.attributes.name = "Old\u0007 Hall"; });
    edit(old, "people_workflows", r => { (r.body!.data as { attributes: Record<string, unknown> }[])[0]!.attributes.name = "Old welcome"; });
    expect(ops(old).labels).toEqual({ [room]: "Old Hall", [`workflow${FICTIONAL_WORKFLOW}`]: "Old welcome" });
    const current = capture();
    edit(current, "calendar_rooms", r => { (r.body!.data as { attributes: Record<string, unknown> }[])[0]!.attributes.name = "Body name"; });
    expect(ops(current).labels[room]).toBe("Sanctuary (fictional)");
    expect(captureRooms(current)).toEqual([{ room_id: FICTIONAL_ROOM, name: "Sanctuary (fictional)" }]);
    expect(captureRooms(nov22Capture())).toEqual([]);
  });

  it("a capture with an unusable clock or organization is never shown as clear", () => {
    expect(ops({ ...capture(), kind: "recording", completed_at: "not a time" })).toEqual({ result: null, labels: {}, group_meetings: [], stale: false, clear: [], checked_at: null,
      not_checked: ["Rooms, follow-ups and group meetings couldn't be checked, so nothing about them is shown."] });
    // Another organization's time zone is never this church's: rooms and group meetings aren't checked.
    const other = ops({ ...capture(), organization: "1002" });
    expect(other.not_checked).toContain("The church's time zone couldn't be read from Planning Center, so room bookings and group meetings weren't checked.");
    expect(other.result!.findings.map(f => f.kind)).toEqual(["unowned-overdue"]);
    expect(other.clear).toEqual([]);
    // An organization id the evaluator refuses (its time zone read under the same id) leaves both parts unchecked.
    const odd = edit({ ...capture(), organization: "org with spaces" }, "organization", r => { (r.body!.data as { id: string }).id = "org with spaces"; });
    const o = ops(odd);
    expect(o.result!.binding).toBeNull();
    expect(o.result!.status).toBe("unverified");
    expect(o.not_checked).toEqual(expect.arrayContaining(["Rooms couldn't be checked, so nothing about them is shown.", "Follow-ups couldn't be checked, so nothing about them is shown."]));
    expect(o.clear).toEqual([]);
  });

  it("the fictional window constant is what the native check derives for the Nov 22 plan", () => {
    expect(reads(capture(), "calendar_resource_bookings")[0]!.window).toEqual(FICTIONAL_WINDOW);
    expect(reads(capture(), "groups_group_events")[0]!.group_id).toBe(FICTIONAL_GROUP);
  });

  it("the normalized fixture still renders a confirmed overlap and names unreadable parts", () => {
    const { result, labels } = fictionalOperations();
    expect(result.findings.map(f => [f.kind, f.label, f.certainty])).toEqual([
      ["unowned-overdue", "Follow-up needs an owner", "confirmed"],
      ["room-overlap", "Room use needs review", "confirmed"],
    ]);
    expect(operationsNotChecked(result)).toEqual([]);
    for (const id of ["hall", "service", "lunch", "welcome", "call"]) expect(labels[id]).toBeTruthy();
    expect(operationsNotChecked({ ...result, unchecked_scope_ids: ["hall-rule"] })).toEqual(["1 part of the room and follow-up check couldn't be read."]);
    expect(operationsNotChecked({ ...result, status: "unverified", binding: null, findings: [], uncertainties: [{ code: "invalid-input", scope_id: null, subject_id: null, label: "Worth a look" }] }))
      .toEqual(["Rooms and follow-ups couldn't be checked, so nothing about them is shown."]);
  });
});

// Another watched service than the first (owner decision 2026-11-19): its own rooms and group meetings, never the
// church's follow-ups (they stay with the first service), and no rooms at all when an earlier service is on its day.
describe("another service's rooms and group meetings", () => {
  const roomsOnly = (c = capture(), rules = none, o: OperationsOptions = {}) => ops(c, rules, { followUps: false, ...o });
  it("one service: leaving the options at their defaults is exactly what it always was", () => {
    for (const c of [capture(), notRequested(), nov22Capture()]) {
      expect(sundayOperations(c, sanctuary, { followUps: true, rooms: true })).toEqual(sundayOperations(c, sanctuary));
      expect(sundayOperations(c, sanctuary, { now: "2026-11-20T16:00:00Z", followUps: true, rooms: true })).toEqual(sundayOperations(c, sanctuary, { now: "2026-11-20T16:00:00Z" }));
    }
  });

  it("without follow-ups: the same room overlap and group meeting, and nothing of the church's follow-ups anywhere", () => {
    const all = ops(capture(), sanctuary), own = roomsOnly(capture(), sanctuary);
    expect(own.result!.findings.map(f => [f.kind, f.label])).toEqual([["room-overlap", "Room use needs review"]]);
    expect(own.result!.findings[0]).toEqual(all.result!.findings.find(f => f.kind === "room-overlap"));
    expect(own.group_meetings).toEqual(all.group_meetings);
    expect(own.labels).toEqual({ [room]: "Sanctuary (fictional)" });
    expect(JSON.stringify(own.result)).not.toMatch(/workflow|step|card/u);
    expect(own.not_checked).toEqual([]);
    expect(own.checked_at).toBe(all.checked_at);
    // Nothing found and every room read: "nothing found" names rooms only, never follow-ups.
    const quiet = edit(capture(), "calendar_resource_bookings", r => { (r.body as { data: unknown[] }).data = []; });
    expect(roomsOnly(quiet).clear).toEqual(["rooms"]);
    expect(ops(quiet).clear).toEqual([]);
    // A follow-up read that failed is no line of this service's.
    const failed = edit(capture(), "people_workflow_ready_cards", r => { r.outcome = "denied"; delete r.body; });
    expect(roomsOnly(failed).not_checked).toEqual([]);
    expect(ops(failed).not_checked).toEqual(["Follow-ups in 1 workflow: Planning Center didn't allow it."]);
  });

  it("without rooms too (an earlier service holds that day's rooms): group meetings only, nothing clear, read when its groups were", () => {
    const o = roomsOnly(capture(), sanctuary, { rooms: false });
    expect(o).toMatchObject({ result: null, labels: {}, stale: false, clear: [], checked_at: CHECKED, not_checked: [] });
    expect(o.group_meetings).toEqual(ops().group_meetings);
    // Its group events refused: the memberships it did read still say when.
    expect(roomsOnly(edit(capture(), "groups_group_events", r => { r.outcome = "denied"; delete r.body; }), sanctuary, { rooms: false })
      .checked_at).toBe(CHECKED);
  });

  it("whether a check read its own day's rooms in full: never for a part refused, partial or unreadable, whatever the clock says", () => {
    expect(roomsReadComplete(capture(), sanctuary)).toBe(true);
    // A live check out of date by now is still the check it was (whether it is out of date never moves a day's rooms).
    const live = { ...capture(), kind: "live" as const };
    expect(ops(live, sanctuary, { now: "2026-11-21T15:00:00Z" }).stale).toBe(true);
    expect(roomsReadComplete(live, sanctuary)).toBe(true);
    expect(roomsReadComplete(edit(capture(), "calendar_resource_bookings", r => { r.outcome = "timeout"; delete r.body; }), sanctuary)).toBe(false);
    expect(roomsReadComplete(edit(capture(), "calendar_resource_bookings", r => { r.outcome = "truncated"; }), sanctuary)).toBe(false);
    expect(roomsReadComplete(edit(capture(), "calendar_conflicts", r => { if (r.event_id === "23167837") { r.outcome = "denied"; delete r.body; } }), sanctuary)).toBe(false);
    expect(roomsReadComplete(notRequested(), sanctuary)).toBe(false);
    expect(roomsReadComplete(nov22Capture(), sanctuary)).toBe(false);
    // No booking that day, read in full: complete.
    expect(roomsReadComplete(edit(capture(), "calendar_resource_bookings", r => { (r.body as { data: unknown[] }).data = []; }), sanctuary)).toBe(true);
  });

  it("its own words where a part is off, out of date or unreadable", () => {
    expect(roomsOnly(notRequested()).not_checked).toEqual(["Room bookings weren't checked. Turn this on in Settings.", "Group meetings weren't checked either."]);
    expect(roomsOnly(notRequested(), none, { rooms: false }).not_checked).toEqual(["Group meetings weren't checked. Turn this on in Settings."]);
    expect(roomsOnly(capture(), none, { now: "2026-11-20T16:00:00Z" }).not_checked).toEqual(["Rooms and group meetings aren't shown: they were read more than 30 minutes ago."]);
    expect(roomsOnly(capture(), none, { now: "2026-11-20T16:00:00Z", rooms: false }).not_checked).toEqual(["Group meetings aren't shown: they were read more than 30 minutes ago."]);
    expect(roomsOnly({ ...capture(), kind: "recording", completed_at: "not a time" }).not_checked).toEqual(["Rooms and group meetings couldn't be checked, so nothing about them is shown."]);
    const unreadPair = edit(capture(), "calendar_conflicts", r => { if (r.event_id === "23167837") { r.outcome = "denied"; delete r.body; } });
    expect(roomsOnly(unreadPair, sanctuary).not_checked).toEqual([RESOLUTION]);
  });

  it("no line of another service's part trips the background-check wording guard (only the first service's own sentence is set aside)", () => {
    const lines = [
      ...roomsOnly(notRequested()).not_checked, ...roomsOnly(notRequested(), none, { rooms: false }).not_checked,
      ...roomsOnly(capture(), none, { now: "2026-11-20T16:00:00Z" }).not_checked, ...roomsOnly(capture(), none, { now: "2026-11-20T16:00:00Z", rooms: false }).not_checked,
      ...roomsOnly({ ...capture(), kind: "recording", completed_at: "not a time" }).not_checked,
      ...roomsOnly(edit(capture(), "calendar_conflicts", r => { if (r.event_id === "23167837") { r.outcome = "denied"; delete r.body; } }), sanctuary).not_checked,
      ...roomsOnly(edit(capture(), "calendar_resource_bookings", r => { r.outcome = "timeout"; delete r.body; })).not_checked,
    ];
    expect(lines.length).toBeGreaterThan(6);
    for (const line of lines) expect(backgroundWording(line), line).toBe(false);
  });

  it("the plan's church-local date: the day its room check covers", () => {
    expect(capturePlanDate(capture())).toBe("2026-11-22");
    expect(capturePlanDate(edit(capture(), "plan", r => { r.outcome = "failed"; delete r.body; }))).toBeNull();
  });
});
