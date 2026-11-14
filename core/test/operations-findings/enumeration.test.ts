import { describe, expect, it } from "vitest";
import { evaluateOperations } from "../../src/operations-findings/index.js";
import { followup, rooms, scope } from "./fixtures.js";

describe("unique normalized identities and independent enumeration", () => {
  it("collapses identical duplicate booking/card/resolution rows with explicit uncertainty", () => {
    for (const input of [rooms(), followup()]) {
      input.bookings.push(...structuredClone(input.bookings)); input.cards.push(...structuredClone(input.cards)); input.resolutions.push(...structuredClone(input.resolutions));
      const result = evaluateOperations(input);
      expect(result.findings).toHaveLength(1); expect(result.status).toBe("unverified");
      expect(result.uncertainties).toContainEqual(expect.objectContaining({ code: "duplicate-row" }));
    }
  });
  it("excludes contradictory booking and card identities", () => {
    const input = rooms(); input.bookings.push({ ...structuredClone(input.bookings[0]!), status: "cancelled" });
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
    const cards = followup(); cards.cards.push({ ...structuredClone(cards.cards[0]!), assignment: { scope_id: "owners", value: "assigned" } });
    expect(evaluateOperations(cards)).toMatchObject({ status: "unverified", findings: [] });
  });
  it.each(["count", "enumeration", "errors", "window", "source", "duplicate-source", "duplicate-required", "undeclared", "wrong-kind", "wrong-target"])("preserves explicit %s gap", control => {
    const input = rooms();
    if (control === "count") input.scopes[0]!.expected_count = 7;
    if (control === "enumeration") input.scopes[0]!.enumeration_complete = false;
    if (control === "errors") input.scopes[0]!.errors = ["provider-failure"];
    if (control === "window") input.scopes[0]!.window.ends_at = "2026-11-24T00:00:00-05:00";
    if (control === "source") input.scopes[0]!.source = "normalized-workflow";
    if (control === "duplicate-source") input.scopes.push(structuredClone(input.scopes[0]!));
    if (control === "duplicate-required") input.required_scopes.push(structuredClone(input.required_scopes[0]!));
    if (control === "undeclared") input.required_scopes = [];
    if (control === "wrong-kind") input.required_scopes[0]!.kind = "cards";
    if (control === "wrong-target") input.required_scopes[0]!.target = { kind: "room", resource_id: "other" };
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified"); expect(result.findings).toEqual([]);
    expect(result.uncertainties.length).toBeGreaterThan(0);
  });
  it("does not clear a checked empty room unless every declared scope is complete", () => {
    const input = rooms(); input.bookings = []; input.resolutions = []; input.scopes[0]!.expected_count = 0; input.scopes[2]!.expected_count = 0;
    expect(evaluateOperations(input)).toMatchObject({ status: "checked-scope-clear", findings: [], uncertainties: [] });
    input.scopes[0]!.expected_count = 1;
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
  });
  it("retains independently checked room findings while another declared source is denied", () => {
    const input = rooms(), other = followup();
    input.required_scopes.push(...other.required_scopes); input.scopes.push(...other.scopes); input.cards = other.cards;
    input.scopes.find(s => s.scope_id === "owners")!.completeness = "denied";
    const result = evaluateOperations(input);
    expect(result.status).toBe("unverified"); expect(result.findings).toHaveLength(1); expect(result.findings[0]?.certainty).toBe("confirmed");
    expect(result.unchecked_scope_ids).toEqual(["owners"]);
  });
  it("separates different rooms and multi-resource bookings without duplicate alerts", () => {
    const input = rooms();
    input.required_scopes.push(
      { scope_id: "b2", kind: "bookings", target: { kind: "room", resource_id: "room2" } },
      { scope_id: "r2", kind: "room-rule", target: { kind: "room", resource_id: "room2" } },
      { scope_id: "p2", kind: "room-resolutions", target: { kind: "room", resource_id: "room2" } });
    input.scopes.push(scope("b2", 1, "normalized-calendar"), scope("r2", 1, "church-rule"), scope("p2", 0, "normalized-calendar"));
    input.bookings.push({ ...structuredClone(input.bookings[0]!), resource_id: "room2", scope_id: "b2" });
    input.room_rules.push({ scope_id: "r2", resource_id: "room2", rule_id: "exclusive2", exclusive: true, additional_setup_minutes: 30 });
    expect(evaluateOperations(input).findings).toHaveLength(1);
    input.bookings[1]!.resource_id = "room2"; input.bookings[1]!.scope_id = "b2";
    input.scopes[0]!.expected_count = 5; input.scopes.find(s => s.scope_id === "b2")!.expected_count = 2;
    const result = evaluateOperations(input);
    expect(result.findings).toHaveLength(1); expect(result.findings[0]).toMatchObject({ resource_id: "room2", certainty: "uncertain" });
  });
});

describe("references must resolve to their exact declared local facts", () => {
  it("reports a resolution referring to an absent booking instead of clearing the scope", () => {
    const input = rooms(); input.resolutions[1]!.booking_ids = ["earlyB", "absent"];
    expect(evaluateOperations(input).status).toBe("unverified");
    expect(evaluateOperations(input).uncertainties).toContainEqual(expect.objectContaining({ code: "unknown-resolution" }));
  });
  it("reports duplicate semantic scope kinds even with different IDs", () => {
    const input = rooms(); input.required_scopes.push({ ...structuredClone(input.required_scopes[0]!), scope_id: "other" });
    input.scopes.push({ ...structuredClone(input.scopes[0]!), scope_id: "other", expected_count: 0 });
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
  });
  it("does not count an unrelated room scope as a booking's evidence", () => {
    const input = rooms(); input.bookings[0]!.scope_id = "rule";
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [] });
  });
  it("empty undeclared input never clears a schedule", () => {
    const input = rooms(); input.required_scopes = []; input.scopes = []; input.bookings = []; input.room_rules = []; input.resolutions = [];
    expect(evaluateOperations(input)).toMatchObject({ status: "unverified", findings: [], uncertainties: [{ code: "missing-scope" }] });
  });
});

it("same-time bookings in two independently checked different rooms stay clear", () => {
  const input = rooms(); input.bookings = input.bookings.slice(0, 2); input.resolutions = [];
  input.scopes[0]!.expected_count = 1; input.scopes[2]!.expected_count = 0;
  input.required_scopes.push(
    { scope_id: "b2", kind: "bookings", target: { kind: "room", resource_id: "room2" } },
    { scope_id: "r2", kind: "room-rule", target: { kind: "room", resource_id: "room2" } },
    { scope_id: "p2", kind: "room-resolutions", target: { kind: "room", resource_id: "room2" } });
  input.scopes.push(scope("b2", 1, "normalized-calendar"), scope("r2", 1, "church-rule"), scope("p2", 0, "normalized-calendar"));
  input.bookings[1]!.resource_id = "room2"; input.bookings[1]!.scope_id = "b2";
  input.room_rules.push({ scope_id: "r2", resource_id: "room2", rule_id: "exclusive2", exclusive: true, additional_setup_minutes: 30 });
  expect(evaluateOperations(input)).toMatchObject({ status: "checked-scope-clear", findings: [], uncertainties: [] });
});
