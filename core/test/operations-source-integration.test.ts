import { describe, expect, it } from "vitest";
import { evaluateOperationsSources, type OperationsSources } from "../src/operations-source-integration.js";
import { followup, rooms } from "./operations-findings/fixtures.js";

function example(): OperationsSources {
  const room = rooms(0), follow = followup();
  return {
    binding: room.binding, evaluated_at: room.evaluated_at, window: room.window, churchTimeZone: room.churchTimeZone,
    required_scopes: [...room.required_scopes, ...follow.required_scopes],
    scopes: [...room.scopes, ...follow.scopes].map(observation => ({ observation, grant: "asserted" })),
    calendar: {
      bookings: room.bookings.map(row => ({ scope_id: row.scope_id, resource_id: row.resource_id, booking_id: row.booking_id,
        interval: row.interval, lifecycle: "present", setup_coverage: "asserted" })),
      requests: room.bookings.map(row => ({ resource_id: row.resource_id, booking_id: row.booking_id, status: "approved" })),
      request_scopes: [room.scopes[0]!].map(observation => ({ observation: structuredClone(observation), grant: "asserted" })),
      conflicts: room.resolutions,
    },
    church_rules: room.room_rules,
    workflow: { cards: follow.cards },
  };
}

describe("operations source integration", () => {
  it("evaluates fictional room and follow-up evidence through the actual evaluator", () => {
    const result = evaluateOperationsSources(example());
    expect(result.status).toBe("findings");
    expect(result.findings.map(f => f.kind).sort()).toEqual(["room-overlap", "unowned-overdue"]);
  });

  it("honors resolved conflicts and a cancelled booking", () => {
    const data = example();
    data.calendar.conflicts[0]!.state = "resolved";
    data.calendar.bookings.find(b => b.booking_id === "earlyB")!.lifecycle = "cancelled";
    const result = evaluateOperationsSources(data);
    expect(result.findings.map(f => f.kind)).toEqual(["unowned-overdue"]);
    expect(result.status).toBe("findings");
  });

  it("keeps an absent request and missing pair resolution uncertain", () => {
    const data = example();
    data.calendar.requests = data.calendar.requests.filter(r => r.booking_id !== "service");
    data.calendar.request_scopes[0]!.observation.expected_count = 5;
    data.calendar.conflicts = [];
    data.scopes.find(s => s.observation.scope_id === "pairs")!.observation.expected_count = 0;
    const result = evaluateOperationsSources(data);
    expect(result.status).toBe("unverified");
    expect(result.uncertainties.map(u => u.code)).toEqual(expect.arrayContaining(["unknown-booking", "unknown-resolution"]));
    expect(result.findings.some(f => f.kind === "room-overlap" && f.certainty === "uncertain")).toBe(true);
  });

  it.each(["assigned", "unknown"] as const)("handles %s ownership without inventing a follow-up", assignment => {
    const data = example();
    data.workflow.cards[0]!.assignment.value = assignment;
    const result = evaluateOperationsSources(data);
    expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(false);
    if (assignment === "unknown") expect(result.uncertainties.map(u => u.code)).toContain("unknown-card");
  });

  it("does not flag a currently snoozed follow-up and rechecks expired snoozes", () => {
    const data = example();
    data.workflow.cards[0]!.snooze.value = { state: "snoozed", until: "2026-11-22T13:00:00Z" };
    expect(evaluateOperationsSources(data).findings.some(f => f.kind === "unowned-overdue")).toBe(false);
    data.workflow.cards[0]!.snooze.value.until = "2026-11-22T11:00:00Z";
    expect(evaluateOperationsSources(data).uncertainties.map(u => u.code)).toContain("snooze-recheck");
  });

  it.each(["denied", "unknown"] as const)("does not treat a %s grant assertion as access", grant => {
    const data = example();
    data.scopes.find(s => s.observation.scope_id === "owners")!.grant = grant;
    const result = evaluateOperationsSources(data);
    expect(result.status).toBe("unverified");
    expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(false);
    expect(result.unchecked_scope_ids).toContain("owners");
  });

  it.each(["partial", "stale", "denied", "unreadable"] as const)("retains %s source status", completeness => {
    const data = example();
    data.scopes.find(s => s.observation.scope_id === "bookings")!.observation.completeness = completeness;
    expect(evaluateOperationsSources(data).status).toBe("unverified");
    expect(evaluateOperationsSources(data).findings.some(f => f.kind === "room-overlap")).toBe(false);
  });

  it("rejects mismatched binding, incomplete pagination, stale clock, missing and mixed scopes", () => {
    for (const change of [
      (d: OperationsSources) => { d.scopes[0]!.observation.binding.organization_id = "other"; },
      (d: OperationsSources) => { d.scopes[0]!.observation.enumeration_complete = false; },
      (d: OperationsSources) => { d.scopes[0]!.observation.valid_until = "2026-11-22T12:00:00Z"; },
      (d: OperationsSources) => { d.scopes.shift(); },
      (d: OperationsSources) => { d.workflow.cards[0]!.assignment.scope_id = "bookings"; },
      (d: OperationsSources) => { d.scopes[0]!.observation.expected_count++; },
      (d: OperationsSources) => { d.scopes[0]!.observation.errors = ["provider-failure"]; },
    ]) {
      const data = example(); change(data);
      expect(evaluateOperationsSources(data).status).toBe("unverified");
    }
  });

  it("rejects orphan or ambiguous joins and does not execute accessors", () => {
    const orphan = example(); orphan.calendar.requests[0]!.booking_id = "other";
    expect(evaluateOperationsSources(orphan).uncertainties[0]!.code).toBe("invalid-input");
    const duplicate = example(); duplicate.calendar.requests.push(duplicate.calendar.requests[0]!);
    expect(evaluateOperationsSources(duplicate).uncertainties[0]!.code).toBe("invalid-input");
    const data = example(); let called = false;
    Object.defineProperty(data, "notes", { enumerable: true, get() { called = true; return "private"; } });
    expect(evaluateOperationsSources(data).uncertainties[0]!.code).toBe("invalid-input");
    expect(called).toBe(false);
    const extra = example() as OperationsSources & { notes: string }; extra.notes = "private";
    expect(evaluateOperationsSources(extra).uncertainties[0]!.code).toBe("invalid-input");
  });

  it("keeps unknown lifecycle and setup uncertain", () => {
    const data = example();
    data.workflow.cards[0]!.lifecycle.value.state = "unknown";
    data.church_rules[0]!.additional_setup_minutes = null;
    const result = evaluateOperationsSources(data);
    expect(result.uncertainties.map(u => u.code)).toEqual(expect.arrayContaining(["unknown-card", "unknown-rule"]));
    expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(false);
  });

  it("does not confirm a room interval when its setup coverage is unknown", () => {
    const data = example();
    data.calendar.bookings[0]!.setup_coverage = "unknown";
    const result = evaluateOperationsSources(data);
    expect(result.uncertainties.map(u => u.code)).toContain("unknown-booking");
    expect(result.findings.some(f => f.kind === "room-overlap" && f.bookings.some(b => b.booking_id === "service") && f.certainty === "confirmed")).toBe(false);
  });

  it("does not confirm room findings from partial request pages", () => {
    const data = example();
    data.calendar.request_scopes[0]!.observation.enumeration_complete = false;
    const result = evaluateOperationsSources(data);
    expect(result.status).toBe("unverified");
    expect(result.uncertainties.map(u => u.code)).toContain("incomplete-scope");
    expect(result.findings.some(f => f.kind === "room-overlap")).toBe(false);
  });

  it("does not let request times repair invalid booking evidence", () => {
    for (const change of [
      (d: OperationsSources) => { d.scopes[0]!.observation.check_time = "2026-11-22T12:00:01Z"; },
      (d: OperationsSources) => {
        d.scopes[0]!.observation.check_time = "2026-11-22T11:00:00Z";
        d.scopes[0]!.observation.valid_until = "2026-11-23T12:00:00Z";
        d.calendar.request_scopes[0]!.observation.valid_until = "2026-11-22T13:00:00Z";
      },
    ]) {
      const data = example(); change(data);
      const result = evaluateOperationsSources(data);
      expect(result.status).toBe("unverified");
      expect(result.uncertainties.map(u => u.code)).toContain("invalid-clock");
      expect(result.findings.some(f => f.kind === "room-overlap")).toBe(false);
      expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(true);
    }
  });

  it("treats missing, denied, mismatched and miscounted request evidence as unverified", () => {
    for (const change of [
      (d: OperationsSources) => { d.calendar.request_scopes = []; },
      (d: OperationsSources) => { d.calendar.request_scopes[0]!.grant = "denied"; },
      (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.binding.access_epoch = "other"; },
      (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.expected_count = 0; },
      (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.errors = ["provider-failure"]; },
    ]) {
      const data = example(); change(data);
      const result = evaluateOperationsSources(data);
      expect(result.uncertainties).toContainEqual(expect.objectContaining({ code: "incomplete-scope", scope_id: "bookings" }));
      expect(result.findings.some(f => f.kind === "room-overlap")).toBe(false);
      expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(true);
    }
  });

  it.each([
    ["wrong source", (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.source = "normalized-workflow"; }],
    ["wrong window", (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.window.ends_at = "2026-11-24T00:00:00-05:00"; }],
    ["future check", (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.check_time = "2026-11-22T12:00:01Z"; }],
    ["expired evidence", (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.valid_until = "2026-11-22T12:00:00Z"; }],
    ["overlong evidence", (d: OperationsSources) => { d.calendar.request_scopes[0]!.observation.valid_until = "2026-11-23T12:00:01Z"; }],
  ])("keeps unrelated follow-up when request evidence has %s", (_label, change) => {
    const data = example();
    const baseline = evaluateOperationsSources(data);
    expect(baseline.status).toBe("findings");
    expect(baseline.uncertainties).toEqual([]);
    expect(baseline.findings).toContainEqual(expect.objectContaining({ kind: "room-overlap", certainty: "confirmed" }));
    expect(baseline.findings.some(f => f.kind === "unowned-overdue")).toBe(true);
    change(data);
    const result = evaluateOperationsSources(data);
    expect(result.status).toBe("unverified");
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ code: "incomplete-scope", scope_id: "bookings" }));
    expect(result.findings.some(f => f.kind === "room-overlap")).toBe(false);
    expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(true);
  });

  it("accepts a request window expressed with equivalent UTC instants", () => {
    const data = example();
    data.calendar.request_scopes[0]!.observation.window = {
      starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T05:00:00Z",
    };
    const result = evaluateOperationsSources(data);
    expect(result.status).toBe("findings");
    expect(result.findings.map(f => f.kind).sort()).toEqual(["room-overlap", "unowned-overdue"]);
    expect(result.uncertainties).toEqual([]);
  });

  it("does not confirm an overlap when a booking lifecycle is unknown", () => {
    const data = example();
    data.calendar.bookings.find(b => b.booking_id === "service")!.lifecycle = "unknown";
    const result = evaluateOperationsSources(data);
    expect(result.status).toBe("unverified");
    expect(result.uncertainties.map(u => u.code)).toContain("unknown-booking");
    expect(result.findings).toContainEqual(expect.objectContaining({
      kind: "room-overlap", certainty: "uncertain", label: "Worth a look",
      bookings: expect.arrayContaining([expect.objectContaining({ booking_id: "service" }), expect.objectContaining({ booking_id: "lunch" })]),
    }));
    expect(result.findings.some(f => f.kind === "room-overlap" && f.certainty === "confirmed")).toBe(false);
    expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(true);
  });

  it("preserves a confirmed room finding when follow-up ownership is denied", () => {
    const data = example();
    data.scopes.find(s => s.observation.scope_id === "owners")!.grant = "denied";
    const result = evaluateOperationsSources(data);
    expect(result.status).toBe("unverified");
    expect(result.unchecked_scope_ids).toContain("owners");
    expect(result.findings.some(f => f.kind === "unowned-overdue")).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({ kind: "room-overlap", certainty: "confirmed" }));
  });

  it("rejects oversized rows and extra source data", () => {
    const data = example();
    data.calendar.requests = Array.from({ length: 65 }, () => data.calendar.requests[0]!);
    expect(evaluateOperationsSources(data).uncertainties[0]!.code).toBe("invalid-input");
    const privateData = example();
    Object.assign(privateData.calendar.requests[0]!, { note: "private" });
    expect(evaluateOperationsSources(privateData).uncertainties[0]!.code).toBe("invalid-input");
  });

  it("can report a clean bounded scope when observations actually support it", () => {
    const data = example();
    data.calendar.conflicts[0]!.state = "resolved";
    data.calendar.bookings.find(b => b.booking_id === "earlyB")!.lifecycle = "cancelled";
    data.workflow.cards[0]!.assignment.value = "assigned";
    expect(evaluateOperationsSources(data).status).toBe("checked-scope-clear");
  });
});
