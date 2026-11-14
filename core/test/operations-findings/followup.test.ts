import { describe, expect, it } from "vitest";
import { evaluateOperations } from "../../src/operations-findings/index.js";
import { followup } from "./fixtures.js";

describe("current normalized workflow evidence", () => {
  it("flags only an active ready unassigned unsnoozed card with source due strictly before evaluation", () => {
    const result = evaluateOperations(followup());
    expect(result.status).toBe("findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ kind: "unowned-overdue", certainty: "confirmed", workflow_id: "welcome", step_id: "current", card_id: "card1",
      due_at: "2026-11-22T11:59:59.999Z", assignment: "unassigned", snooze: { state: "unsnoozed", until: null },
      next_action: "Choose who will handle this follow-up in your church tools." });
    expect(result.findings[0]?.evidence).toHaveLength(5);
  });
});

describe("follow-up clock, ownership and source lifecycle", () => {
  it.each([
    ["2026-11-22T11:59:59.999Z", 1], ["2026-11-22T12:00:00.000Z", 0], ["2026-11-22T12:00:00.001Z", 0],
    ["2026-11-23T12:00:00Z", 0],
  ] as const)("source due %s gives %i findings at the explicit clock", (due, count) => {
    const input = followup(); input.cards[0]!.due.value = due;
    expect(evaluateOperations(input).findings).toHaveLength(count);
  });
  it.each(["assigned", "completed", "removed", "not-ready", "snoozed"])("keeps %s as a negative control", control => {
    const input = followup(), c = input.cards[0]!;
    if (control === "assigned") c.assignment.value = "assigned";
    if (control === "completed" || control === "removed") c.lifecycle.value.state = control;
    if (control === "not-ready") c.lifecycle.value.readiness = "not-ready";
    if (control === "snoozed") c.snooze.value = { state: "snoozed", until: "2026-11-30T12:00:00Z" };
    expect(evaluateOperations(input).findings).toEqual([]);
    expect(evaluateOperations(input).status).toBe("checked-scope-clear");
  });
  it.each(["assignment", "due", "snooze", "status", "readiness", "step"])("keeps unknown %s Worth a look", control => {
    const input = followup(), c = input.cards[0]!;
    if (control === "assignment") c.assignment.value = "unknown";
    if (control === "due") c.due.value = null;
    if (control === "snooze") c.snooze.value = { state: "unknown", until: null };
    if (control === "status") c.lifecycle.value.state = "unknown";
    if (control === "readiness") c.lifecycle.value.readiness = "unknown";
    if (control === "step") c.lifecycle.value.current_step_id = null;
    const result = evaluateOperations(input);
    expect(result.findings).toEqual([]); expect(result.status).toBe("unverified");
    expect(result.uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-card", label: "Worth a look" }));
  });
  it("requires current unsnoozed evidence at expiry and uses recalculated source due", () => {
    const input = followup(), c = input.cards[0]!;
    c.snooze.value = { state: "snoozed", until: input.evaluated_at };
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
    expect(evaluateOperations(input).uncertainties).toContainEqual(expect.objectContaining({ code: "snooze-recheck" }));
    c.snooze.value = { state: "unsnoozed", until: null };
    c.due.value = "2026-12-03T12:00:00Z";
    expect(evaluateOperations(input).findings).toEqual([]);
    c.due.value = "2026-11-22T11:59:59.999Z";
    expect(evaluateOperations(input).findings).toHaveLength(1);
    c.assignment.value = "assigned";
    expect(evaluateOperations(input).findings).toEqual([]);
  });
  it("does not reuse a card at a new current step under the old identity", () => {
    const input = followup(); input.cards[0]!.lifecycle.value.current_step_id = "next-step";
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
  });
  it.each(["cards", "state", "owners", "due", "snooze"])("requires independent fresh %s evidence", id => {
    const input = followup(); input.scopes.find(s => s.scope_id === id)!.completeness = "partial";
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [], unchecked_scope_ids: [id] });
  });
});

describe("no inferred overdue/contact or invented response window", () => {
  it.each(["overdue", "created_at", "moved_to_step_at", "first_visit_at", "person_name", "notes", "contact"])("rejects unaccepted %s data rather than using it", field => {
    const input = followup();
    Object.assign(input.cards[0]!, { [field]: field === "overdue" ? true : "CANARY_PRIVATE_FOLLOWUP" });
    const result = evaluateOperations(input);
    expect(result).toMatchObject({ status: "unverified", findings: [] });
    expect(JSON.stringify(result)).not.toContain("CANARY_PRIVATE_FOLLOWUP");
  });
  it("keeps source check times instead of restamping them at evaluation", () => {
    const input = followup(); input.evaluated_at = "2026-11-22T12:00:01Z";
    const result = evaluateOperations(input);
    expect(result.findings[0]?.evidence.every(e => e.check_time === "2026-11-22T12:00:00Z")).toBe(true);
    expect(result.findings[0]).toMatchObject({ due_at: "2026-11-22T11:59:59.999Z" });
  });
});
