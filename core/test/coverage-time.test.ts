import { describe, expect, it } from "vitest";
import { evaluateCoverage, type ServingInterval } from "../src/coverage.js";
import { candidate, coverageFixture, observed } from "./fixtures/coverage/base.js";

describe("C29 explicit serving instants (application half-open convention)", () => {
  it.each([
    ["adjacent", "2026-11-22T15:30:00Z", "2026-11-22T16:00:00Z", "suggestion"],
    ["rehearsal overlap", "2026-11-22T14:00:00Z", "2026-11-22T14:31:00Z", "excluded"],
    ["local timestamp", "2026-11-22T10:00:00", "2026-11-22T11:00:00", "unverified"],
    ["invalid date", "2026-11-31T10:00:00Z", "2026-11-31T11:00:00Z", "unverified"],
    ["reversed", "2026-11-22T16:00:00Z", "2026-11-22T15:00:00Z", "unverified"],
  ])("%s", (_name, starts_at, ends_at, disposition) => {
    const input = coverageFixture(), person = candidate();
    input.positions[0]!.candidates = [person];
    person.assignments = observed([{ assignment_id: "other", status: "C", notification: "unsent", intervals: [{ starts_at: starts_at!, ends_at: ends_at! }], time_semantics: "verified" }]);
    expect(evaluateCoverage(input).positions[0]?.candidates[0]?.disposition).toBe(disposition);
  });

  it.each([
    [{ starts_at: "2026-11-21T23:30:00-05:00", ends_at: "2026-11-22T00:30:00-05:00" }, { starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-22T06:00:00Z" }, "excluded"],
    [{ starts_at: "2026-11-01T01:00:00-04:00", ends_at: "2026-11-01T01:30:00-04:00" }, { starts_at: "2026-11-01T01:00:00-05:00", ends_at: "2026-11-01T01:30:00-05:00" }, "suggestion"],
  ] as const)("handles overnight/DST by instant", (target, other, disposition) => {
    const input = coverageFixture(), person = candidate();
    input.positions[0]!.interval = target;
    input.positions[0]!.candidates = [person];
    person.assignments = observed([{ assignment_id: "other", status: "C", notification: "sent", intervals: [other], time_semantics: "verified" }]);
    expect(evaluateCoverage(input).positions[0]?.candidates[0]?.disposition).toBe(disposition);
  });

  it.each([null, { starts_at: "2026-11-22T09:30:00", ends_at: "2026-11-22T10:30:00" }] as (ServingInterval | null)[])("cannot clear a position with unresolved required time", target => {
    const input = coverageFixture();
    input.positions[0]!.interval = target;
    input.positions[0]!.remaining_need = observed(0);
    input.positions[0]!.candidates = [candidate()];
    const result = evaluateCoverage(input);
    expect(result.status).toBe("unverified");
    expect(result.positions[0]?.candidates[0]?.disposition).toBe("unverified");
  });

  it("does not claim provider per-time or recurrence interpretation", () => {
    const input = coverageFixture(), person = candidate();
    input.positions[0]!.candidates = [person];
    person.assignments = observed([{ assignment_id: "split-response", status: "C", notification: "sent", intervals: [input.positions[0]!.interval!], time_semantics: "unverified" }]);
    expect(evaluateCoverage(input).positions[0]?.candidates[0]?.disposition).toBe("unverified");
  });
});
