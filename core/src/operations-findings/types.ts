/** Local normalized evidence only. These types are not a model payload or authentication. */
export interface Binding { workspace_id: string; organization_id: string; access_epoch: string }
export interface Interval { starts_at: string; ends_at: string }
export type Target = { kind: "room"; resource_id: string } | { kind: "step"; workflow_id: string; step_id: string };
export type ScopeKind = "bookings" | "room-rule" | "room-resolutions" | "cards" | "card-state" | "assignments" | "due" | "snooze";
export interface RequiredScope { scope_id: string; kind: ScopeKind; target: Target }
export interface SourceScope {
  scope_id: string; binding: Binding; window: Interval;
  source: "normalized-calendar" | "normalized-workflow" | "church-rule";
  check_time: string; valid_until: string;
  completeness: "complete" | "partial" | "stale" | "denied" | "unreadable" | "unverified";
  enumeration_complete: boolean; expected_count: number; errors: Array<"denied" | "partial" | "stale" | "provider-failure" | "unverified">;
}
export interface Fact<T> { scope_id: string; value: T }
export type BookingStatus = "requested" | "approved" | "declined" | "cancelled" | "unknown";
export interface Booking {
  scope_id: string; resource_id: string; booking_id: string;
  status: BookingStatus; interval: Interval | null;
}
export interface RoomRule {
  scope_id: string; resource_id: string; rule_id: string;
  exclusive: boolean | null; additional_setup_minutes: number | null;
}
export interface PairResolution {
  scope_id: string; resource_id: string; booking_ids: [string, string]; interval: Interval;
  state: "unresolved" | "shared" | "resolved" | "unknown";
}
export interface WorkflowCard {
  scope_id: string; workflow_id: string; step_id: string; card_id: string;
  lifecycle: Fact<{ state: "active" | "completed" | "removed" | "unknown";
    readiness: "ready" | "not-ready" | "unknown"; current_step_id: string | null }>;
  assignment: Fact<"assigned" | "unassigned" | "unknown">;
  due: Fact<string | null>;
  snooze: Fact<{ state: "unsnoozed" | "snoozed" | "unknown"; until: string | null }>;
}
export interface OperationsInput {
  binding: Binding; evaluated_at: string; window: Interval; churchTimeZone: string;
  required_scopes: RequiredScope[]; scopes: SourceScope[];
  bookings: Booking[]; room_rules: RoomRule[]; resolutions: PairResolution[]; cards: WorkflowCard[];
}
export type IssueCode = "invalid-input" | "limit-exceeded" | "missing-scope" | "duplicate-scope" |
  "undeclared-scope" | "binding-mismatch" | "window-mismatch" | "incomplete-scope" |
  "invalid-clock" | "enumeration-gap" | "count-mismatch" | "duplicate-row" | "conflicting-row" |
  "unknown-rule" | "unknown-booking" | "unknown-resolution" | "unknown-card" | "snooze-recheck";
export interface Uncertainty {
  code: IssueCode; scope_id: string | null; subject_id: string | null; label: "Worth a look";
}
export interface Evidence extends RequiredScope {
  source: SourceScope["source"]; check_time: string; valid_until: string;
}
export interface RoomFinding {
  kind: "room-overlap"; finding_id: string; label: "Room use needs review" | "Worth a look";
  certainty: "confirmed" | "uncertain"; resource_id: string;
  bookings: Array<{ booking_id: string; status: BookingStatus; original: Interval; effective: Interval }>;
  overlap: Interval; additional_setup_minutes: number; rule: RoomRule | null;
  resolution: PairResolution | null; evidence: Evidence[];
  next_action: "Review these room bookings in your church tools.";
}
export interface FollowUpFinding {
  kind: "unowned-overdue"; finding_id: string; label: "Follow-up needs an owner"; certainty: "confirmed";
  workflow_id: string; step_id: string; card_id: string; due_at: string;
  lifecycle: WorkflowCard["lifecycle"]["value"]; assignment: "unassigned";
  snooze: WorkflowCard["snooze"]["value"]; evidence: Evidence[];
  next_action: "Choose who will handle this follow-up in your church tools.";
}
export interface OperationsResult {
  status: "checked-scope-clear" | "findings" | "unverified";
  binding: Binding | null; evaluated_at: string | null; window: Interval | null; churchTimeZone: string | null;
  findings: Array<RoomFinding | FollowUpFinding>; uncertainties: Uncertainty[];
  unchecked_scope_ids: string[]; checked_scopes: Evidence[];
}
