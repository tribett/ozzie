import { describe, expect, it } from "vitest";
import { evaluateOperations } from "../../src/operations-findings/index.js";
import type { OperationsInput } from "../../src/operations-findings/types.js";
import { card, followup, rooms } from "./fixtures.js";
function freeze(value: unknown): void {
  if (value !== null && typeof value === "object") { Object.freeze(value); for (const v of Object.values(value)) freeze(v); }
}

describe("stable local results without mutation or hidden truncation", () => {
  it("is identical under row/scope/required/property order changes and reversed pair identities", () => {
    const input = rooms(60), f = followup();
    input.required_scopes.push(...f.required_scopes); input.scopes.push(...f.scopes); input.cards = [card(), { ...card(), card_id: "card2" }];
    for (const s of input.scopes.slice(3)) s.expected_count = 2;
    const other = structuredClone(input);
    other.required_scopes.reverse(); other.scopes.reverse(); other.bookings.reverse(); other.cards.reverse(); other.resolutions.reverse();
    for (const r of other.resolutions) r.booking_ids.reverse();
    other.binding = { access_epoch: "epoch1", organization_id: "org1", workspace_id: "workspace1" };
    expect(evaluateOperations(other)).toEqual(evaluateOperations(input));
  });
  it("isolates result identities by workspace/organization/epoch and step", () => {
    const original = evaluateOperations(followup()).findings[0]!.finding_id;
    for (const key of ["workspace_id", "organization_id", "access_epoch"] as const) {
      const input = followup(); input.binding[key] = "other"; for (const s of input.scopes) s.binding[key] = "other";
      expect(evaluateOperations(input).findings[0]!.finding_id).not.toBe(original);
    }
    const moved = followup(); moved.cards[0]!.step_id = "next"; moved.cards[0]!.lifecycle.value.current_step_id = "next";
    for (const r of moved.required_scopes) if (r.target.kind === "step") r.target.step_id = "next";
    expect(evaluateOperations(moved).findings[0]!.finding_id).not.toBe(original);
  });
  it("accepts deeply frozen inputs and detaches returned evidence", () => {
    const input = rooms(), before = structuredClone(input); freeze(input);
    const result = evaluateOperations(input);
    expect(input).toEqual(before);
    result.binding!.workspace_id = "mutated"; result.checked_scopes[0]!.target = { kind: "room", resource_id: "changed" };
    if (result.findings[0]?.kind === "room-overlap") result.findings[0].bookings[0]!.original.starts_at = "changed";
    expect(input).toEqual(before); expect(evaluateOperations(input).findings).toHaveLength(1);
  });
  it.each(["bookings", "cards", "scopes", "required_scopes", "resolutions", "room_rules"] as const)("rejects over-limit %s instead of a truncated clear", key => {
    const input = rooms(); const caps = { bookings: 65, cards: 129, scopes: 129, required_scopes: 129, resolutions: 513, room_rules: 65 };
    const rows = key === "cards" ? [card()] : input[key];
    (input as unknown as Record<string, unknown>)[key] = Array.from({ length: caps[key] }, () => rows[0]);
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [], uncertainties: [{ code: "limit-exceeded" }] });
  });
  it("bounds all-pair evaluation at 64 bookings without silently dropping pairs", () => {
    const input = rooms(0); input.bookings = Array.from({ length: 64 }, (_, i) => ({ ...structuredClone(input.bookings[0]!), booking_id: `booking${i}` }));
    input.resolutions = []; input.scopes[0]!.expected_count = 64; input.scopes[2]!.expected_count = 0;
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified"); expect(result.findings).toHaveLength(2016);
    expect(new Set(result.findings.map(f => f.finding_id)).size).toBe(2016);
    expect(result.uncertainties).toHaveLength(1);
  });
  it("rejects invalid bounds, missing field, numeric strings, provider statuses and policy overflow", () => {
    const inputs: unknown[] = [];
    const bad = (change: (v: Record<string, unknown>) => void) => { const v = rooms() as unknown as Record<string, unknown>; change(v); inputs.push(v); };
    bad(v => delete v.window); bad(v => v.evaluated_at = NaN); bad(v => v.churchTimeZone = {});
    const invalid = rooms(); invalid.window.ends_at = invalid.window.starts_at; inputs.push(invalid);
    const long = rooms(); long.window.ends_at = "2026-12-24T00:00:00-05:00"; inputs.push(long);
    for (const minutes of [-1, 0.5, 1441, "30", null]) {
      if (minutes === null) continue;
      const input = rooms() as unknown as { room_rules: Array<Record<string, unknown>> }; input.room_rules[0]!.additional_setup_minutes = minutes; inputs.push(input);
    }
    const status = rooms() as unknown as { bookings: Array<Record<string, unknown>> }; status.bookings[0]!.status = "A"; inputs.push(status);
    for (const value of inputs) expect(evaluateOperations(value as OperationsInput)).toMatchObject({ status: "unverified", findings: [] });
  });
});
