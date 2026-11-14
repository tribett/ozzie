import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "../src/coverage.js";
import { candidate, coverageFixture, observed } from "./fixtures/coverage/base.js";

describe("pure Sunday coverage", () => {
  it("C03/C24 contradictory duplicate assignment identities remain unverified", () => {
    const input = coverageFixture(), person = candidate();
    const confirmed = { assignment_id: "duplicate", status: "C" as const, notification: "sent" as const,
      intervals: [input.positions[0]!.interval!], time_semantics: "verified" as const };
    const duplicate = { ...confirmed, status: "U" as const };
    input.positions[0]!.remaining_need = observed(0);
    input.positions[0]!.lead = observed({ mapping: "required", assignment_ids: ["duplicate"] });
    input.positions[0]!.assignments = observed([confirmed, duplicate]);
    person.assignments = observed([confirmed, duplicate]);
    input.positions[0]!.candidates = [person];
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.lead).toBe("unverified");
    expect(result.positions[0]?.candidates[0]?.disposition).toBe("unverified");
    expect(result.status).toBe("unverified");
  });
  it("C08/C24 retains a known confirmed exclusion alongside an unresolved additional interval", () => {
    const input = coverageFixture(), person = candidate();
    input.positions[0]!.candidates = [person];
    person.assignments = observed([{ assignment_id: "mixed-times", status: "C", notification: "sent", time_semantics: "verified",
      intervals: [input.positions[0]!.interval!, { starts_at: "unknown", ends_at: "unknown" }],
    }]);
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.candidates[0]?.disposition).toBe("excluded");
    expect(result.status).toBe("unverified");
  });
  it("C24 an empty position set does not establish checked coverage", () => {
    const input = coverageFixture();
    input.positions = [];
    expect(evaluateCoverage(input).status).toBe("unverified");
  });
  it("preserves source metadata without sharing mutable source objects with its caller", () => {
    const input = coverageFixture();
    const result = evaluateCoverage(input);
    result.scopes[0]!.source = "changed by caller";
    expect(input.scopes[0]?.source).toBe("fictional fixed data");
  });
  it("C03 adjacent verified intervals of the same mapped confirmed lead cover the full requirement", () => {
    const input = coverageFixture();
    input.positions[0]!.lead = observed({ mapping: "required", assignment_ids: ["lead"] });
    input.positions[0]!.assignments = observed([{
      assignment_id: "lead", status: "C", notification: "unsent", time_semantics: "verified",
      intervals: [
        { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T15:30:00Z" },
        { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:00:00Z" },
      ],
    }]);
    const before = structuredClone(input);
    expect(evaluateCoverage(input).positions[0]?.lead).toBe("confirmed");
    expect(input).toEqual(before);
    input.positions[0]!.assignments.value[0]!.intervals[0]!.starts_at = "2026-11-22T15:00:01Z";
    expect(evaluateCoverage(input).positions[0]?.lead).toBe("missing");
  });
  it.each([null, -1, 1.5, NaN])("C01/C24 keeps invalid or absent remaining quantity %s unknown", quantity => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(quantity);
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.remaining_need).toBeNull();
    expect(result.status).toBe("unverified");
  });
  it("C25 an unreadable required service prevents a candidate availability assurance", () => {
    const input = coverageFixture();
    input.required_scope_ids.push("other-service");
    input.positions[0]!.candidates = [candidate()];
    expect(evaluateCoverage(input).positions[0]?.candidates[0]?.disposition).toBe("unverified");
  });
  it("C24 unknown position-assignment response cannot produce all-clear", () => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(0);
    input.positions[0]!.assignments = observed([{ assignment_id: "unknown", status: "unknown", notification: "unknown", intervals: [], time_semantics: "unverified" }]);
    expect(evaluateCoverage(input).status).toBe("unverified");
  });
  it.each([
    ["C", "unsent", "excluded", "Confirmed overlapping serving assignment."],
    ["U", "sent", "possible-conflict", "Possible conflict: source records an unanswered sent request."],
    ["U", "unsent", "possible-conflict", "Possible conflict: unconfirmed scheduling record; invitation not sent."],
    ["U", "unknown", "possible-conflict", "Possible conflict: unconfirmed scheduling record; sending couldn't be verified."],
    ["D", "sent", "suggestion", null],
    ["cancelled", "sent", "suggestion", null],
  ] as const)("C08-C11 overlapping %s/%s has truthful occupancy and notification meaning", (status, notification, disposition, reason) => {
    const input = coverageFixture(), person = candidate();
    input.positions[0]!.candidates = [person];
    person.assignments = observed([{ assignment_id: "other-service", status, notification,
      intervals: [{ starts_at: "2026-11-22T10:00:00-05:00", ends_at: "2026-11-22T11:00:00-05:00" }], time_semantics: "verified" }]);
    const assessment = evaluateCoverage(input).positions[0]!.candidates[0]!;
    expect(assessment.disposition).toBe(disposition);
    if (reason) expect(assessment.reasons).toContain(reason);
  });
  it("C06 excludes an explicit overlapping blockout", () => {
    const input = coverageFixture(), person = candidate();
    input.positions[0]!.candidates = [person];
    person.blockouts = observed([input.positions[0]!.interval!]);
    expect(evaluateCoverage(input).positions[0]?.candidates[0]?.disposition).toBe("excluded");
  });
  it.each(["unavailable", "not-member", "ineligible", "unknown-availability", "unknown-eligibility", "unknown-membership", "unknown-blockouts", "denied-schedules"] as const)("C06/C07/C12 evaluates %s without turning uncertainty into permission", kind => {
    const input = coverageFixture(), person = candidate();
    input.positions[0]!.candidates = [person];
    if (kind === "unavailable") person.availability = observed("unavailable");
    if (kind === "not-member") person.membership = observed(false);
    if (kind === "ineligible") person.eligibility = observed(false);
    if (kind === "unknown-availability") person.availability = observed("unknown");
    if (kind === "unknown-eligibility") person.eligibility = observed(null);
    if (kind === "unknown-membership") person.membership = observed(null);
    if (kind === "unknown-blockouts") person.blockouts = observed(null);
    if (kind === "denied-schedules") person.assignments.scope_id = "missing";
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.candidates[0]?.disposition).toBe(
      ["unavailable", "not-member", "ineligible"].includes(kind) ? "excluded" : "unverified",
    );
    if (kind.startsWith("unknown") || kind === "denied-schedules") expect(result.status).toBe("unverified");
  });
  it("C05 returns factual eligible suggestions in input order without inferring willingness", () => {
    const input = coverageFixture();
    input.positions[0]!.candidates = [candidate("person-d"), candidate("person-b")];
    expect(evaluateCoverage(input).positions[0]?.candidates).toEqual([
      { person_id: "person-d", disposition: "suggestion", reasons: ["Recorded team membership, role eligibility and availability; no overlapping serving assignment in checked scope. Willingness is not established."] },
      { person_id: "person-b", disposition: "suggestion", reasons: ["Recorded team membership, role eligibility and availability; no overlapping serving assignment in checked scope. Willingness is not established."] },
    ]);
  });
  it.each(["C", "U", "D", "cancelled"] as const)("C03 evaluates %s only in the explicitly mapped lead role and full serving interval", status => {
    const input = coverageFixture();
    input.positions[0]!.lead = observed({ mapping: "required", assignment_ids: ["sunday-lead"] });
    input.positions[0]!.assignments = observed([{
      assignment_id: "sunday-lead", status, notification: "unsent",
      intervals: [input.positions[0]!.interval!], time_semantics: "verified",
    }]);
    expect(evaluateCoverage(input).positions[0]?.lead).toBe(status === "C" ? "confirmed" : "missing");
  });
  it("C03 unverified per-time semantics cannot confirm or disprove scheduled lead coverage", () => {
    const input = coverageFixture();
    input.positions[0]!.lead = observed({ mapping: "required", assignment_ids: ["sunday-lead"] });
    input.positions[0]!.assignments = observed([{
      assignment_id: "sunday-lead", status: "C", notification: "unsent",
      intervals: [], time_semantics: "unverified",
    }]);
    expect(evaluateCoverage(input).positions[0]?.lead).toBe("unverified");
  });
  it.each(["unknown", "required"] as const)("C02-C04 %s Sunday lead mapping cannot be replaced by oversight or titles", mapping => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(0);
    input.positions[0]!.lead = observed({ mapping, assignment_ids: [] });
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.lead).toBe(mapping === "required" ? "missing" : "unverified");
    expect(result.status).toBe(mapping === "required" ? "findings" : "unverified");
  });
  it("C01 allows a zero remaining need only from fresh complete evidence", () => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(0);
    expect(evaluateCoverage(input).status).toBe("checked-scope-clear");
    expect(evaluateCoverage(input).issues).toEqual([]);
  });
  it("C25 preserves checked findings while naming an unreadable related scope", () => {
    const input = coverageFixture();
    input.required_scope_ids.push("other-service");
    input.scopes.push({ ...input.scopes[0]!, scope_id: "other-service", completeness: "denied" });
    const result = evaluateCoverage(input);
    expect(result.status).toBe("unverified");
    expect(result.positions[0]?.remaining_need).toBe(1);
    expect(result.issues).toContainEqual(expect.objectContaining({ scope_id: "other-service" }));
  });
  it.each(["missing", "expired", "future", "duplicate", "empty", "undeclared"] as const)("C24 refuses %s scope evidence", kind => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(0);
    if (kind === "missing") input.scopes = [];
    if (kind === "expired") input.scopes[0]!.valid_until = "2026-11-22T11:59:59Z";
    if (kind === "future") input.scopes[0]!.check_time = "2026-11-22T12:01:00Z";
    if (kind === "duplicate") input.scopes.push({ ...input.scopes[0]! });
    if (kind === "empty") input.required_scope_ids = [];
    if (kind === "undeclared") input.positions[0]!.remaining_need.scope_id = "not-declared";
    expect(evaluateCoverage(input).status).toBe("unverified");
  });
  it.each(["partial", "stale", "denied", "unreadable", "unverified"] as const)("C24 refuses an all-clear and invented zero from %s evidence", completeness => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(0);
    input.scopes[0]!.completeness = completeness;
    const result = evaluateCoverage(input);
    expect(result.status).toBe("unverified");
    expect(result.positions[0]?.remaining_need).toBeNull();
    expect(result.issues).toContainEqual(expect.objectContaining({ scope_id: "fictional-sunday", code: "scope-unverified" }));
  });
  it("C01 preserves remaining need without subtracting confirmed or pending assignments", () => {
    const input = coverageFixture();
    input.positions[0]!.assignments = observed([
      { assignment_id: "confirmed", status: "C", notification: "unsent", intervals: [input.positions[0]!.interval!], time_semantics: "verified" },
      { assignment_id: "pending", status: "U", notification: "unsent", intervals: [input.positions[0]!.interval!], time_semantics: "verified" },
    ]);
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.remaining_need).toBe(1);
    expect(result.positions[0]?.pending_assignment_ids).toEqual(["pending"]);
    expect(result.status).toBe("findings");
    expect(result.scopes).toEqual(input.scopes);
  });
});
