import type { OperationsInput, SourceScope, WorkflowCard } from "../../src/operations-findings/types.js";

// Designed normalized fiction: exclusive/unresolved/status/access mappings are assumptions,
// not verified Calendar or People semantics. Six times follow the dated staging arithmetic.
export const binding = { workspace_id: "workspace1", organization_id: "org1", access_epoch: "epoch1" };
export const window = { starts_at: "2026-11-22T00:00:00-05:00", ends_at: "2026-11-23T00:00:00-05:00" };
export function scope(scope_id: string, expected_count: number, source: SourceScope["source"]): SourceScope {
  return { scope_id, binding: { ...binding }, window: { ...window }, source,
    check_time: "2026-11-22T12:00:00Z", valid_until: "2026-11-23T12:00:00Z",
    completeness: "complete", enumeration_complete: true, expected_count, errors: [] };
}
export function rooms(additional = 30): OperationsInput {
  return {
    binding: { ...binding }, evaluated_at: "2026-11-22T12:00:00Z", window: { ...window }, churchTimeZone: "America/New_York",
    required_scopes: [
      { scope_id: "bookings", kind: "bookings", target: { kind: "room", resource_id: "room1" } },
      { scope_id: "rule", kind: "room-rule", target: { kind: "room", resource_id: "room1" } },
      { scope_id: "pairs", kind: "room-resolutions", target: { kind: "room", resource_id: "room1" } },
    ],
    scopes: [scope("bookings", 6, "normalized-calendar"), scope("rule", 1, "church-rule"), scope("pairs", 2, "normalized-calendar")],
    bookings: [
      { scope_id: "bookings", resource_id: "room1", booking_id: "service", status: "approved", interval: { starts_at: "2026-11-22T09:00:00-05:00", ends_at: "2026-11-22T11:00:00-05:00" } },
      { scope_id: "bookings", resource_id: "room1", booking_id: "lunch", status: "approved", interval: { starts_at: "2026-11-22T10:45:00-05:00", ends_at: "2026-11-22T11:15:00-05:00" } },
      { scope_id: "bookings", resource_id: "room1", booking_id: "earlyA", status: "approved", interval: { starts_at: "2026-11-22T13:00:00-05:00", ends_at: "2026-11-22T14:45:00-05:00" } },
      { scope_id: "bookings", resource_id: "room1", booking_id: "lateA", status: "approved", interval: { starts_at: "2026-11-22T16:00:00-05:00", ends_at: "2026-11-22T16:30:00-05:00" } },
      { scope_id: "bookings", resource_id: "room1", booking_id: "earlyB", status: "approved", interval: { starts_at: "2026-11-22T18:00:00-05:00", ends_at: "2026-11-22T19:15:00-05:00" } },
      { scope_id: "bookings", resource_id: "room1", booking_id: "lateB", status: "approved", interval: { starts_at: "2026-11-22T20:00:00-05:00", ends_at: "2026-11-22T20:30:00-05:00" } },
    ],
    room_rules: [{ scope_id: "rule", resource_id: "room1", rule_id: "exclusive1", exclusive: true, additional_setup_minutes: additional }],
    resolutions: [
      { scope_id: "pairs", resource_id: "room1", booking_ids: ["service", "lunch"], interval: { starts_at: "2026-11-22T09:00:00-05:00", ends_at: "2026-11-22T11:15:00-05:00" }, state: "unresolved" },
      { scope_id: "pairs", resource_id: "room1", booking_ids: ["earlyB", "lateB"], interval: { starts_at: "2026-11-22T18:00:00-05:00", ends_at: "2026-11-22T20:30:00-05:00" }, state: "unresolved" },
    ], cards: [],
  };
}
export function card(): WorkflowCard {
  return { scope_id: "cards", workflow_id: "welcome", step_id: "current", card_id: "card1",
    lifecycle: { scope_id: "state", value: { state: "active", readiness: "ready", current_step_id: "current" } },
    assignment: { scope_id: "owners", value: "unassigned" }, due: { scope_id: "due", value: "2026-11-22T11:59:59.999Z" },
    snooze: { scope_id: "snooze", value: { state: "unsnoozed", until: null } } };
}
export function followup(): OperationsInput {
  const kinds = ["cards", "card-state", "assignments", "due", "snooze"] as const;
  const ids = ["cards", "state", "owners", "due", "snooze"];
  return { binding: { ...binding }, evaluated_at: "2026-11-22T12:00:00Z", window: { ...window }, churchTimeZone: "America/New_York",
    required_scopes: kinds.map((kind, i) => ({ scope_id: ids[i]!, kind, target: { kind: "step", workflow_id: "welcome", step_id: "current" } })),
    scopes: ids.map(id => scope(id, 1, "normalized-workflow")), bookings: [], room_rules: [], resolutions: [], cards: [card()] };
}
