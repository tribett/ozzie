import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "../src/coverage.js";
import { candidate, coverageFixture, observed, scheduled } from "./fixtures/coverage/base.js";

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

// Blockouts of people already scheduled (fixture matrix C30-C37). Planning Center still counts them, so remaining need
// never changes; the overlap is a fact to look at, never a gap. Times: the fixture's 9:30-10:30 Eastern service.
describe("scheduled people with a blockout", () => {
  const SERVICE = { starts_at: "2026-11-22T09:30:00-05:00", ends_at: "2026-11-22T10:30:00-05:00" };
  // Planning Center's all-day blockout: the church-local day as UTC instants, ending a second before midnight.
  const ALL_DAY = { starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T04:59:59Z" };
  const evaluate = (people: ReturnType<typeof scheduled>[], remaining = 0) => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(remaining);
    input.positions[0]!.assignments = observed(people.map(p => p.assignment));
    input.positions[0]!.scheduled = people.map(p => p.person);
    return { input, result: evaluateCoverage(input) };
  };

  it.each(["C", "U"] as const)("C30 a %s person whose all-day blockout covers the service is a finding, and the need is Planning Center's own", status => {
    const { result } = evaluate([scheduled("a1", status, [ALL_DAY])]);
    expect(result.positions[0]?.scheduled_blockouts).toEqual([{ assignment_id: "a1", person_id: "person-a1", interval: SERVICE }]);
    expect(result.positions[0]?.remaining_need).toBe(0);
    expect(result.status).toBe("findings");
    expect(result.issues).toEqual([]);
    // With an open request too, the count stays Planning Center's: nothing is added or subtracted.
    expect(evaluate([scheduled("a1", status, [ALL_DAY])], 1).result.positions[0]?.remaining_need).toBe(1);
  });

  it("C30 a timed blockout that overlaps part of the serving time counts, compared as instants whatever the offset", () => {
    const { result } = evaluate([scheduled("a1", "C", [{ starts_at: "2026-11-22T15:15:00Z", ends_at: "2026-11-22T17:00:00Z" }])]);
    expect(result.positions[0]?.scheduled_blockouts.map(b => b.assignment_id)).toEqual(["a1"]);
  });

  it.each(["D", "cancelled"] as const)("C31 a %s person's blockout produces nothing", status => {
    const { result } = evaluate([scheduled("a1", status, [ALL_DAY])]);
    expect(result.positions[0]?.scheduled_blockouts).toEqual([]);
    expect(result.status).toBe("checked-scope-clear");
  });

  it("C32 someone no longer on the plan produces nothing, even with their blockouts still supplied", () => {
    const input = coverageFixture();
    input.positions[0]!.remaining_need = observed(0);
    input.positions[0]!.scheduled = [scheduled("gone", "C", [ALL_DAY]).person];
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.scheduled_blockouts).toEqual([]);
    expect(result.status).toBe("checked-scope-clear");
  });

  it.each([
    ["ends as the service starts", { starts_at: "2026-11-22T08:00:00-05:00", ends_at: "2026-11-22T09:30:00-05:00" }],
    ["starts as the service ends", { starts_at: "2026-11-22T15:30:00Z", ends_at: "2026-11-22T18:00:00Z" }],
    ["the day before", { starts_at: "2026-11-21T05:00:00Z", ends_at: "2026-11-22T04:59:59Z" }],
  ])("C33 a blockout that %s doesn't overlap and produces nothing", (_, blockout) => {
    const { result } = evaluate([scheduled("a1", "C", [blockout])]);
    expect(result.positions[0]?.scheduled_blockouts).toEqual([]);
    expect(result.status).toBe("checked-scope-clear");
  });

  it("C33 uses the same overlap rule as people who could help: the same blockout settles both the same way", () => {
    for (const blockout of [ALL_DAY, { starts_at: "2026-11-22T08:00:00-05:00", ends_at: "2026-11-22T09:30:00-05:00" }]) {
      const input = coverageFixture(), person = candidate();
      person.blockouts = observed([blockout]);
      input.positions[0]!.candidates = [person];
      const one = scheduled("a1", "C", [blockout]);
      input.positions[0]!.assignments = observed([one.assignment]);
      input.positions[0]!.scheduled = [one.person];
      const p = evaluateCoverage(input).positions[0]!;
      expect(p.scheduled_blockouts.length > 0).toBe(p.candidates[0]!.disposition === "excluded");
    }
  });

  it("C34 two overlapping blockouts for one person make one entry", () => {
    const { result } = evaluate([scheduled("a1", "C", [ALL_DAY, { starts_at: "2026-11-22T14:00:00Z", ends_at: "2026-11-22T16:00:00Z" }])]);
    expect(result.positions[0]?.scheduled_blockouts).toHaveLength(1);
  });

  it("C35 a blockout that can't be checked (a repeating one arrives as null) is never read as clear", () => {
    const { result } = evaluate([scheduled("a1", "C", null)]);
    expect(result.positions[0]?.scheduled_blockouts).toEqual([]);
    expect(result.status).toBe("unverified");
    expect(result.issues).toEqual([expect.objectContaining({ code: "blockout-unverified", person_id: "person-a1", position_id: "position-a" })]);
    expect(result.issues[0]!.message).toMatch(/^Worth a look: /);
  });

  it("C35 a blockout read that wasn't complete leaves that person unchecked, never clear", () => {
    const input = evaluate([scheduled("a1", "C", [ALL_DAY])]).input;
    input.positions[0]!.scheduled![0]!.blockouts.scope_id = "person:a1";
    const result = evaluateCoverage(input);
    expect(result.positions[0]?.scheduled_blockouts).toEqual([]);
    expect(result.status).toBe("unverified");
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "observation-unverified", scope_id: "person:a1" }));
  });

  it("C36 a serving time that couldn't be verified is left to the existing assignment issue, not called clear or blocked out", () => {
    const one = scheduled("a1", "C", [ALL_DAY]);
    one.assignment.time_semantics = "unverified";
    const { result } = evaluate([one]);
    expect(result.positions[0]?.scheduled_blockouts).toEqual([]);
    expect(result.status).toBe("unverified");
    expect(result.issues.map(i => i.code)).toEqual(["assignment-unverified"]);
  });

  it("lists each scheduled person in the source's order, and checks nothing when no one's blockouts were supplied", () => {
    const { result } = evaluate([scheduled("a2", "U", [ALL_DAY]), scheduled("a1", "C", []), scheduled("a3", "C", [ALL_DAY])]);
    expect(result.positions[0]?.scheduled_blockouts.map(b => b.assignment_id)).toEqual(["a2", "a3"]);
    const input = coverageFixture();
    input.positions[0]!.assignments = observed([scheduled("a1", "C", [ALL_DAY]).assignment]);
    expect(evaluateCoverage(input).positions[0]?.scheduled_blockouts).toEqual([]);
  });

  it("never changes its input", () => {
    const { input } = evaluate([scheduled("a1", "C", [ALL_DAY])]);
    const before = structuredClone(input);
    evaluateCoverage(input);
    expect(input).toEqual(before);
  });
});
