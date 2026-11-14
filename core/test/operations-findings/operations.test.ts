import { describe, expect, it } from "vitest";
import { evaluateOperations } from "../../src/operations-findings/index.js";
import { rooms } from "./fixtures.js";

describe("evaluateOperations: designed normalized room evidence", () => {
  it("finds one exclusive unresolved pair at additional 30, preserving original source intervals", () => {
    const result = evaluateOperations(rooms());
    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "room-overlap", certainty: "confirmed", resource_id: "room1",
      additional_setup_minutes: 30, overlap: { starts_at: "2026-11-22T15:15:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" },
      bookings: [
        { booking_id: "lunch", status: "approved", original: { starts_at: "2026-11-22T10:45:00-05:00", ends_at: "2026-11-22T11:15:00-05:00" }, effective: { starts_at: "2026-11-22T15:15:00.000Z", ends_at: "2026-11-22T16:15:00.000Z" } },
        { booking_id: "service", status: "approved", original: { starts_at: "2026-11-22T09:00:00-05:00", ends_at: "2026-11-22T11:00:00-05:00" }, effective: { starts_at: "2026-11-22T13:30:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" } },
      ], next_action: "Review these room bookings in your church tools.",
    });
    expect(result.findings[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope_id: "bookings", source: "normalized-calendar", check_time: "2026-11-22T12:00:00Z" }),
    ]));
  });
});

describe("room evidence and setup controls", () => {
  it("re-evaluates 30 to 60 from originals: one then two pairs, never cumulative", () => {
    const input = rooms();
    const before = structuredClone(input);
    expect(evaluateOperations(input).findings).toHaveLength(1);
    input.room_rules[0]!.additional_setup_minutes = 60;
    const at60 = evaluateOperations(input);
    expect(at60.findings).toHaveLength(2);
    expect(at60.findings[0]).toMatchObject({ overlap: { starts_at: "2026-11-23T00:00:00.000Z", ends_at: "2026-11-23T00:15:00.000Z" } });
    expect(evaluateOperations(input)).toEqual(at60);
    input.room_rules[0]!.additional_setup_minutes = 30;
    expect(input).toEqual(before);
    expect(evaluateOperations(input).findings).toHaveLength(1);
  });
  it.each(["shared", "resolved"] as const)("does not rediscover an explicitly %s pair", state => {
    const input = rooms();
    input.resolutions[0]!.state = state;
    expect(evaluateOperations(input).findings).toEqual([]);
    expect(evaluateOperations(input).status).toBe("checked-scope-clear");
  });
  it("requires separate unresolved evidence: approval alone yields only exact original Worth a look", () => {
    const input = rooms(); input.resolutions = []; input.scopes[2]!.expected_count = 0;
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified");
    expect(result.findings[0]).toMatchObject({ certainty: "uncertain", label: "Worth a look", additional_setup_minutes: 0,
      overlap: { starts_at: "2026-11-22T15:45:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" } });
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-resolution", scope_id: "pairs" }));
  });
});

describe("room negatives and precise evidence", () => {
  it.each(["cancelled", "declined"] as const)("%s booking does not occupy", status => {
    const input = rooms(); input.bookings[0]!.status = status;
    expect(evaluateOperations(input)).toMatchObject({ status: "checked-scope-clear", findings: [] });
  });
  it("keeps requested separate from approved without assuming an unresolved relationship", () => {
    const input = rooms(); input.bookings[1]!.status = "requested";
    expect(evaluateOperations(input).findings[0]).toMatchObject({ certainty: "confirmed", bookings: [{ status: "requested" }, { status: "approved" }] });
  });
  it("treats equality after additional setup as adjacent; recorded setup is already inside originals", () => {
    const input = rooms();
    input.bookings[1]!.interval = { starts_at: "2026-11-22T11:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00" };
    expect(evaluateOperations(input)).toMatchObject({ status: "checked-scope-clear", findings: [] });
    input.bookings[1]!.interval.starts_at = "2026-11-22T11:29:59.999-05:00";
    input.resolutions[0]!.interval.ends_at = "2026-11-22T12:00:00-05:00";
    expect(evaluateOperations(input).findings[0]).toMatchObject({ overlap: { starts_at: "2026-11-22T15:59:59.999Z", ends_at: "2026-11-22T16:00:00.000Z" } });
  });
  it("different days and out-of-window pairs do not overlap", () => {
    const input = rooms(); input.bookings[1]!.interval = { starts_at: "2026-11-23T10:45:00-05:00", ends_at: "2026-11-23T11:15:00-05:00" };
    expect(evaluateOperations(input).findings).toEqual([]);
    input.bookings[0]!.interval = { starts_at: "2026-11-23T09:00:00-05:00", ends_at: "2026-11-23T11:00:00-05:00" };
    expect(evaluateOperations(input).findings).toEqual([]);
  });
  it.each(["exclusive", "buffer", "rule", "status", "interval"])("unknown %s never confirms or clears", control => {
    const input = rooms();
    if (control === "exclusive") input.room_rules[0]!.exclusive = null;
    if (control === "buffer") input.room_rules[0]!.additional_setup_minutes = null;
    if (control === "rule") { input.room_rules = []; input.scopes[1]!.expected_count = 0; }
    if (control === "status") input.bookings[0]!.status = "unknown";
    if (control === "interval") input.bookings[0]!.interval = null;
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified"); expect(result.findings.every(f => f.certainty === "uncertain")).toBe(true);
    if (control !== "interval") expect(result.findings[0]).toMatchObject({ label: "Worth a look", additional_setup_minutes: 0,
      overlap: { starts_at: "2026-11-22T15:45:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" } });
  });
  it("shared exception for a different time cannot hide an overlapping pair", () => {
    const input = rooms(); input.resolutions[0]!.state = "shared";
    input.resolutions[0]!.interval = { starts_at: "2026-11-22T16:30:00Z", ends_at: "2026-11-22T17:00:00Z" };
    expect(evaluateOperations(input).findings[0]).toMatchObject({ label: "Worth a look", certainty: "uncertain" });
  });
  it("conflicting resolution rows stay unknown rather than picking the first", () => {
    const input = rooms(); input.resolutions.push({ ...structuredClone(input.resolutions[0]!), state: "shared" }); input.scopes[2]!.expected_count = 2;
    expect(evaluateOperations(input).findings[0]).toMatchObject({ label: "Worth a look", certainty: "uncertain" });
    expect(evaluateOperations(input).status).toBe("unverified");
  });
});

describe("resolution and rule uncertainty stays truthful", () => {
  it("cannot confirm a fully unresolved interval contradicted by partial shared evidence", () => {
    const input = rooms(); input.resolutions.push({ ...structuredClone(input.resolutions[0]!), state: "shared",
      interval: { starts_at: "2026-11-22T15:45:00Z", ends_at: "2026-11-22T16:00:00Z" } }); input.scopes[2]!.expected_count = 3;
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified"); expect(result.findings[0]?.certainty).toBe("uncertain");
  });
  it("unknown exclusivity reports rule uncertainty, without inventing unknown pair resolution", () => {
    const input = rooms(); input.room_rules[0]!.exclusive = false;
    const result = evaluateOperations(input);
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-rule", scope_id: "rule" }));
    expect(result.uncertainties.some(u => u.code === "unknown-resolution")).toBe(false);
  });
  it("empty non-overlapping observations still cannot clear an unknown church rule", () => {
    const input = rooms(); input.bookings = []; input.resolutions = []; input.scopes[0]!.expected_count = 0; input.scopes[2]!.expected_count = 0;
    input.room_rules[0]!.exclusive = null;
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
  });
  it("does not use unknown booking status or partial rule/resolution scope to confirm", () => {
    for (const id of ["rule", "pairs"]) {
      const input = rooms(); input.scopes.find(s => s.scope_id === id)!.completeness = "partial";
      expect(evaluateOperations(input).findings[0]).toMatchObject({ label: "Worth a look", certainty: "uncertain", additional_setup_minutes: 0 });
    }
  });
});
