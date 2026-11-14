import type { CoverageCandidate, CoverageInput, Observation } from "../../../src/coverage.js";

/** Designed fictional observations; not an authenticated provider recording. */
export const observed = <T>(value: T): Observation<T> => ({ scope_id: "fictional-sunday", value });

export function candidate(person_id = "person-b"): CoverageCandidate {
  return {
    person_id, membership: observed(true), eligibility: observed(true),
    availability: observed("available"), blockouts: observed([]), assignments: observed([]),
  };
}

export function coverageFixture(): CoverageInput {
  return {
    evaluated_at: "2026-11-22T12:00:00Z",
    required_scope_ids: ["fictional-sunday"],
    scopes: [{ scope_id: "fictional-sunday", source: "fictional fixed data", check_time: "2026-11-22T11:55:00Z", valid_until: "2026-11-22T12:05:00Z", completeness: "complete" }],
    positions: [{
      position_id: "position-a", team_id: "team-a",
      interval: { starts_at: "2026-11-22T09:30:00-05:00", ends_at: "2026-11-22T10:30:00-05:00" },
      remaining_need: observed(1), lead: observed({ mapping: "not-required", assignment_ids: [] }),
      assignments: observed([]), candidates: [],
    }],
  };
}
