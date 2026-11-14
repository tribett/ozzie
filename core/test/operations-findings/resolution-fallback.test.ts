import { describe, expect, it } from "vitest";
import { evaluateOperations } from "../../src/operations-findings/index.js";
import { rooms } from "./fixtures.js";

// Designed normalized facts: these intervals and sharing are not provider evidence.
function overlappingPair() {
  const input = rooms(30);
  input.bookings = input.bookings.slice(0, 2);
  input.bookings[0]!.interval = { starts_at: "2026-11-22T14:00:00Z", ends_at: "2026-11-22T16:00:00Z" };
  input.bookings[1]!.interval = { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T17:00:00Z" };
  input.resolutions = [{ scope_id: "pairs", resource_id: "room1", booking_ids: ["service", "lunch"],
    interval: { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T16:00:00Z" }, state: "shared" }];
  input.scopes[0]!.expected_count = 2;
  input.scopes[2]!.expected_count = 1;
  return input;
}

describe("room resolution follows the interval actually reported", () => {
  it("does not rediscover a verified shared source overlap when the extra buffer is unchecked", () => {
    const input = overlappingPair();
    const original = structuredClone(input);
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified");
    expect(result.findings).toEqual([]);
    expect(result.uncertainties).toContainEqual({ code: "unknown-resolution", scope_id: "pairs", subject_id: "room1", label: "Worth a look" });
    expect(result.unchecked_scope_ids).toEqual([]);
    expect(input).toEqual(original);
  });
  it.each([
    { state: "shared", exclusive: null },
    { state: "shared", exclusive: false },
    { state: "resolved", exclusive: true },
    { state: "resolved", exclusive: null },
    { state: "resolved", exclusive: false },
  ] as const)("preserves $state source resolution with exclusivity $exclusive", ({ state, exclusive }) => {
    const input = overlappingPair();
    input.resolutions[0]!.state = state;
    input.room_rules[0]!.exclusive = exclusive;
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [], unchecked_scope_ids: [] });
    expect(evaluateOperations(input).uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-resolution" }));
  });
  it.each(["shared", "resolved"] as const)("keeps the fully checked %s buffer control clear", state => {
    const input = overlappingPair();
    input.resolutions[0]!.state = state;
    input.resolutions[0]!.interval.starts_at = "2026-11-22T14:30:00Z";
    expect(evaluateOperations(input)).toMatchObject({ status: "checked-scope-clear", findings: [], uncertainties: [] });
    input.resolutions[0]!.interval.starts_at = "2026-11-22T15:00:00Z";
    input.room_rules[0]!.additional_setup_minutes = 0;
    expect(evaluateOperations(input)).toMatchObject({ status: "checked-scope-clear", findings: [], uncertainties: [] });
  });
  it.each(["unresolved", "unknown"] as const)("extra-buffer %s evidence cannot rediscover a shared source interval", state => {
    const input = overlappingPair();
    input.resolutions.push({ ...structuredClone(input.resolutions[0]!), state,
      interval: { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:00:00Z" } });
    input.scopes[2]!.expected_count = 2;
    const result = evaluateOperations(input);
    expect(result).toMatchObject({ status: "unverified", findings: [], unchecked_scope_ids: [] });
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-resolution" }));
    input.resolutions.reverse();
    input.bookings.reverse();
    expect(evaluateOperations(input)).toEqual(result);
  });
  it("does not suppress contradictory evidence intersecting the source overlap", () => {
    const input = overlappingPair();
    input.resolutions.push({ ...structuredClone(input.resolutions[0]!), state: "unresolved",
      interval: { starts_at: "2026-11-22T15:30:00Z", ends_at: "2026-11-22T16:00:00Z" } });
    input.scopes[2]!.expected_count = 2;
    expect(evaluateOperations(input).findings).toEqual([expect.objectContaining({ certainty: "uncertain", resolution: null,
      overlap: { starts_at: "2026-11-22T15:00:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" } })]);
  });
  it("retains actual source unresolved evidence without promoting the unchecked buffer", () => {
    const input = overlappingPair();
    input.resolutions[0]!.state = "unresolved";
    input.resolutions.push({ ...structuredClone(input.resolutions[0]!), state: "shared",
      interval: { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:00:00Z" } });
    input.scopes[2]!.expected_count = 2;
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified");
    expect(result.findings).toEqual([expect.objectContaining({ certainty: "uncertain", additional_setup_minutes: 0,
      resolution: expect.objectContaining({ state: "unresolved", interval: { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T16:00:00Z" } }),
      overlap: { starts_at: "2026-11-22T15:00:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" } })]);
  });
  it.each(["partial", "denied"] as const)("cannot use a %s resolution scope to suppress the source overlap", completeness => {
    const input = overlappingPair();
    input.scopes[2]!.completeness = completeness;
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified");
    expect(result.unchecked_scope_ids).toContain("pairs");
    expect(result.findings).toEqual([expect.objectContaining({ certainty: "uncertain", resolution: null })]);
  });
  it.each([
    { starts_at: "2026-11-22T15:00:00.001Z", ends_at: "2026-11-22T16:00:00Z" },
    { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T15:59:59.999Z" },
    { starts_at: "2026-11-22T16:00:00Z", ends_at: "2026-11-22T17:00:00Z" },
  ])("keeps partial or adjacent resolution from clearing the entire source overlap: %o", interval => {
    const input = overlappingPair();
    input.resolutions[0]!.interval = interval;
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [expect.objectContaining({
      certainty: "uncertain", resolution: null, additional_setup_minutes: 0,
      overlap: { starts_at: "2026-11-22T15:00:00.000Z", ends_at: "2026-11-22T16:00:00.000Z" },
    })] });
  });
});
