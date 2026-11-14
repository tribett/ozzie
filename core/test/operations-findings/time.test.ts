import { describe, expect, it } from "vitest";
import { evaluateOperations } from "../../src/operations-findings/index.js";
import { rooms, followup } from "./fixtures.js";

describe("explicit instants, offsets, local selection and dated source truth", () => {
  it("keeps the Sunday evening pair crossing UTC midnight inside the Eastern window", () => {
    const result = evaluateOperations(rooms(60));
    expect(result.findings.find(f => f.kind === "room-overlap" && f.bookings[0]?.booking_id === "earlyB")).toMatchObject({
      overlap: { starts_at: "2026-11-23T00:00:00.000Z", ends_at: "2026-11-23T00:15:00.000Z" }, additional_setup_minutes: 60 });
  });
  it("compares the repeated DST hour by its supplied offsets, not wall clock labels", () => {
    const input = rooms(0); input.evaluated_at = "2026-11-01T04:00:00Z";
    input.window = { starts_at: "2026-11-01T00:00:00-04:00", ends_at: "2026-11-02T00:00:00-05:00" };
    for (const s of input.scopes) { s.window = { ...input.window }; s.check_time = input.evaluated_at; s.valid_until = "2026-11-02T04:00:00Z"; }
    input.bookings = input.bookings.slice(0, 2); input.scopes[0]!.expected_count = 2; input.resolutions = [input.resolutions[0]!]; input.scopes[2]!.expected_count = 1;
    input.bookings[0]!.interval = { starts_at: "2026-11-01T01:30:00-04:00", ends_at: "2026-11-01T01:30:00-05:00" };
    input.bookings[1]!.interval = { starts_at: "2026-11-01T01:15:00-05:00", ends_at: "2026-11-01T01:45:00-05:00" };
    input.resolutions[0]!.interval = { starts_at: "2026-11-01T01:00:00-04:00", ends_at: "2026-11-01T02:00:00-05:00" };
    expect(evaluateOperations(input).findings[0]).toMatchObject({ certainty: "confirmed", overlap: { starts_at: "2026-11-01T06:15:00.000Z", ends_at: "2026-11-01T06:30:00.000Z" } });
  });
  it("the historical due Oct 26 is not overdue at an Oct 23 evaluation", () => {
    const input = followup(); input.evaluated_at = "2026-10-23T22:00:00Z";
    input.window = { starts_at: "2026-10-23T00:00:00-04:00", ends_at: "2026-10-24T00:00:00-04:00" };
    for (const s of input.scopes) { s.window = { ...input.window }; s.check_time = input.evaluated_at; s.valid_until = "2026-10-24T22:00:00Z"; }
    input.cards[0]!.due.value = "2026-10-26T21:27:40Z";
    expect(evaluateOperations(input)).toMatchObject({ status: "checked-scope-clear", findings: [] });
  });
});
