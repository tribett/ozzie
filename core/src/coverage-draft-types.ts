import type { CandidateAssessment, CoverageCandidate, CoverageInput, CoverageIssue, CoverageScope, Observation, ServingAssignment, ServingInterval } from "./coverage.js";
import type { SundayScope } from "./coverage-state.js";

/** Private local host inputs, never a model payload or proof of authentication. */
export interface DraftAccess {
  allowed: boolean; authorization_id: string; scope: SundayScope; now: string;
  person_ids: string[]; position_ids: string[]; leader_ids: string[];
}
export interface DisplayIdentity { person_id: string; display_name: string }
export interface DraftSource {
  scope: SundayScope; input: CoverageInput; identities: DisplayIdentity[];
  labels: { position_id: string; ministry: Observation<string>; role: Observation<string> }[];
  leaders: { person_id: string; team_id: string; authority: Observation<boolean | null> }[];
  church_timezone: string;
}
export type DraftEvent =
  | { type: "start"; position_id: string }
  | { type: "select"; purpose: "invitation" | "escalation"; person_ids: string[] }
  | { type: "prepare" } | { type: "edit"; plaintext: string } | { type: "refresh" }
  | { type: "review-changes" } | { type: "prepare-copy" } | { type: "cancel" };
export interface DraftRequest { access: DraftAccess; source: DraftSource; event: DraftEvent }
export interface DraftSelection { purpose: "invitation" | "escalation"; person_ids: string[] }
export interface DraftRecipient { person_id: string; display_name: string }
export interface DraftFacts {
  target: { position_id: string; team_id: string; sunday: string; ministry: string; role: string;
    interval: ServingInterval | null; church_timezone: string; formatted_interval: string | null; remaining_need: number | null };
  recipients: (DraftRecipient & { disposition: CandidateAssessment["disposition"] | "leader";
    membership: boolean | null; eligibility: boolean | null; availability: "available" | "unavailable" | "unknown" | null;
    blockouts: ServingInterval[] | null; assignments: ServingAssignment[]; reasons: string[] })[];
  purpose: "invitation" | "escalation";
}
export interface DraftEvidence {
  evaluated_at: string; scopes: CoverageScope[]; required_scope_ids: string[]; issues: CoverageIssue[];
}
export interface DraftOutline {
  facts: DraftFacts;
  candidates: (CandidateAssessment & DisplayIdentity & { observation: CoverageCandidate })[];
  evidence: DraftEvidence; rules: string[]; unchecked_scope_ids: string[]; verification: "verified" | "unverified";
}
export interface PreparedDraft {
  plaintext: string; original_facts: DraftFacts; reviewed_facts: DraftFacts; original_evidence: DraftEvidence;
}
export type DraftDifference = { [K in keyof DraftFacts]: { field: K; before: DraftFacts[K]; after: DraftFacts[K] } }[keyof DraftFacts];
/** Observed clock watermarks only; never substitute these for source observations. */
export interface DraftFreshness {
  evaluated_at: string; required_scope_ids: string[];
  scope_check_times: { scope_id: string; check_time: string }[];
}
export interface DraftReviewState {
  version: 1; scope: SundayScope; authorization_id: string; position_id: string; selection: DraftSelection;
  current: DraftOutline; source: DraftSource; freshness: DraftFreshness; draft: PreparedDraft | null; differences: DraftDifference[];
}
export type DraftReviewResult =
  | { status: "applied"; code: "started" | "selected" | "prepared" | "edited" | "refreshed" | "reviewed"; state: DraftReviewState }
  | { status: "applied"; code: "cancelled"; state: null }
  | { status: "unverified"; code: "source-unverified" | "recipient-unverified" | "leader-unverified" | "draft-stale" | "draft-missing"; state: DraftReviewState }
  | { status: "rejected"; code: "invalid" | "unauthorized" | "scope-mismatch"; state: null }
  | { status: "copy-prepared"; plaintext: string; recipients: DraftRecipient[]; state: DraftReviewState };
