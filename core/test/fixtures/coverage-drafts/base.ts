import type { CoverageCandidate, Observation } from "../../../src/coverage.js";
import type { DraftRequest, DraftReviewResult, DraftReviewState } from "../../../src/coverage-drafts.js";
/** Designed fictional evidence only, never an authenticated provider recording. */
export const observed = <T>(value: T): Observation<T> => ({ scope_id: "fictional-sunday", value });
export const member = (person_id: string): CoverageCandidate => ({ person_id,
  membership: observed(true), eligibility: observed(true), availability: observed("available"),
  blockouts: observed([]), assignments: observed([]) });
export function request(): DraftRequest {
  const scope = { workspace_id: "workspace-a", service_type_id: "service-a", plan_id: "plan-a", sunday: "2026-11-22" };
  return {
    access: { allowed: true, authorization_id: "grant-a", scope: { ...scope }, now: "2026-11-22T12:00:00Z",
      person_ids: ["person-b", "person-a", "leader-a"], position_ids: ["position-a"], leader_ids: ["leader-a"] },
    source: { scope: { ...scope }, church_timezone: "America/New_York",
      identities: [{ person_id: "person-b", display_name: "Zoe Fiction" }, { person_id: "person-a", display_name: "Ada Fiction" },
        { person_id: "leader-a", display_name: "Lee Fiction" }],
      labels: [{ position_id: "position-a", ministry: observed("Ministry A"), role: observed("Welcome desk") }],
      leaders: [{ person_id: "leader-a", team_id: "team-a", authority: observed(true) }],
      input: { evaluated_at: "2026-11-22T12:00:00Z", required_scope_ids: ["fictional-sunday"],
        scopes: [{ scope_id: "fictional-sunday", source: "designed fictional Services observations",
          check_time: "2026-11-22T11:55:00Z", valid_until: "2026-11-22T12:05:00Z", completeness: "complete" }],
        positions: [{ position_id: "position-a", team_id: "team-a",
          interval: { starts_at: "2026-11-22T09:30:00-05:00", ends_at: "2026-11-22T10:30:00-05:00" },
          remaining_need: observed(1), lead: observed({ mapping: "not-required", assignment_ids: [] }),
          assignments: observed([]), candidates: [member("person-b"), member("person-a")] }] } },
    event: { type: "start", position_id: "position-a" },
  };
}
export function state(result: DraftReviewResult): DraftReviewState {
  if (!("state" in result) || !result.state) throw new Error("Expected authorized review state");
  return result.state;
}

export function invitation(step: (s: DraftReviewState | null, r: DraftRequest) => DraftReviewResult): { req: DraftRequest; s: DraftReviewState } {
  const req = request();
  let s = state(step(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(step(s, req));
  req.event = { type: "prepare" };
  s = state(step(s, req));
  req.event = { type: "edit", plaintext: "Verbatim human text\n  keep spacing  " };
  return { req, s: state(step(s, req)) };
}
