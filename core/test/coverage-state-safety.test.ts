import { describe, expect, it } from "vitest";
import { createCoverageState, transitionCoverage, type CoverageEvent } from "../src/coverage-state.js";
import { access, observation, resolved, stateOf } from "./fixtures/coverage-state/base.js";

describe("coverage state public safety boundary", () => {
  it("fails closed rather than publishing a state larger than the public restore bound", () => {
    const input = observation();
    const position = input.positions[0]!;
    input.positions = Array.from({ length: 2000 }, (_, n) => ({ ...structuredClone(position), position_id: `position-${n}` }));
    const initial = stateOf(createCoverageState(access));
    const pending = stateOf(transitionCoverage(initial, access, { type: "refresh-requested", scope: access.scope,
      request_id: "bounded", generation: 1, origin: "on-demand" }));
    const result = transitionCoverage(pending, access, { type: "observation-received", scope: access.scope,
      request_id: "bounded", generation: 1, input });
    expect(result.status).toBe("rejected");
    expect(result).toEqual({ status: "rejected", code: "invalid", state: null });
    expect(pending.findings).toEqual([]);
  });
  it("malformed observations and sparse/cyclic/accessor payloads fail closed before source facts escape", () => {
    const state = resolved();
    const pending = stateOf(transitionCoverage(state, access, { type: "refresh-requested", scope: access.scope,
      request_id: "invalid-source", generation: 2, origin: "on-demand" }));
    const inputs: unknown[] = [null, {}, { ...observation(), evaluated_at: "2026-11-22T12:00:00" },
      { ...observation(), positions: new Array(3) }, { ...observation(), notes: "private-canary" }];
    const malformedClock = observation(); malformedClock.scopes[0]!.check_time = "2026-02-30T12:00:00Z"; inputs.push(malformedClock);
    const extraField = observation(); Object.assign(extraField.positions[0]!, { contact: "private-canary" }); inputs.push(extraField);
    for (const input of inputs) expect(transitionCoverage(pending, access, { type: "observation-received", scope: access.scope,
      request_id: "invalid-source", generation: 2, input } as never)).toEqual({ status: "rejected", code: "invalid", state: null });
    const unsafeArray = new Array(2001).fill("fictional-sunday");
    expect(transitionCoverage(pending, access, { type: "observation-received", scope: access.scope,
      request_id: "invalid-source", generation: 2, input: { ...observation(), required_scope_ids: unsafeArray } })).toEqual({ status: "rejected", code: "invalid", state: null });
    expect(pending.findings).toEqual(state.findings);
  });
  it("authorized state is immutable and serializable; malformed restored values fail closed", () => {
    const state = resolved();
    expect(() => { state.scope.workspace_id = "other-workspace"; }).toThrow();
    expect(() => { state.findings[0]!.history[0]!.reason = "mutated"; }).toThrow();
    const event = { type: "refresh-requested", scope: access.scope, request_id: "restore", generation: 2, origin: "automatic" } as const;
    const restored = JSON.parse(JSON.stringify(state));
    expect(transitionCoverage(restored, access, event).status).toBe("applied");
    const invalid = [
      { ...restored, findings: [...restored.findings, ...restored.findings] },
      { ...restored, findings: [{ ...restored.findings[0], id: "another-scope" }] },
      { ...restored, findings: [{ ...restored.findings[0], label: "private-canary" }] },
      { ...restored, pending: { request_id: "pending", generation: 99, origin: "automatic" } },
      { ...restored, source_clocks: [{ scope_id: "fictional-sunday", check_time: "not-a-clock" }] },
      { ...restored, extra: "private-canary" },
    ];
    for (const previous of invalid) expect(transitionCoverage(previous, access, event)).toEqual({ status: "rejected", code: "invalid", state: null });
    const cyclic: Record<string, unknown> = { ...event }; cyclic.extra = cyclic;
    expect(transitionCoverage(state, access, cyclic as never)).toEqual({ status: "rejected", code: "invalid", state: null });
    const hostile = { ...event };
    Object.defineProperty(hostile, "generation", { get() { throw new Error("private-canary"); } });
    expect(transitionCoverage(state, access, hostile)).toEqual({ status: "rejected", code: "invalid", state: null });
  });
  it("C26/C28 cancelled and old generations never publish, and a local decision invalidates in-flight work", () => {
    const original = resolved();
    const request = (generation: number) => ({ type: "refresh-requested", scope: access.scope,
      request_id: `race-${generation}`, generation, origin: "automatic" } as const);
    const received = (generation: number): CoverageEvent => ({ type: "observation-received", scope: access.scope,
      request_id: `race-${generation}`, generation, input: observation(5) });
    const pending = stateOf(transitionCoverage(original, access, request(2)));
    expect(pending.findings).toEqual(original.findings);
    const cancelled = stateOf(transitionCoverage(pending, access, { type: "refresh-cancelled", scope: access.scope, request_id: "race-2", generation: 2 }));
    expect(transitionCoverage(cancelled, access, received(2))).toEqual({ status: "ignored", code: "obsolete", state: cancelled });
    const newer = stateOf(transitionCoverage(pending, access, request(3)));
    expect(stateOf(transitionCoverage(newer, access, received(2)))).toEqual(newer);
    expect(stateOf(transitionCoverage(newer, access, { type: "refresh-cancelled", scope: access.scope, request_id: "race-2", generation: 2 }))).toEqual(newer);
    const decision = stateOf(transitionCoverage(newer, access, { type: "disposition-recorded", scope: access.scope,
      finding_id: newer.findings[0]!.id, choice: "intentional-exception", reason: "Newer human decision", actor_id: "leader-a",
      recorded_at: "2026-11-22T12:02:00Z" }));
    expect(stateOf(transitionCoverage(decision, access, received(3)))).toEqual(decision);
    const published = stateOf(transitionCoverage(newer, access, received(3)));
    expect(published.findings[0]?.facts.remaining_need).toBe(5);
    expect(stateOf(transitionCoverage(published, access, received(3)))).toEqual(published);
    expect(stateOf(transitionCoverage(published, access, request(3)))).toEqual(published);
  });
  it("C28 current revocation/workspace/authorization changes return no source facts or private reason, even with hostile getters", () => {
    const state = resolved();
    const event = { type: "refresh-requested", scope: access.scope, request_id: "request-b", generation: 2, origin: "automatic" } as const;
    const hostile = { ...state };
    Object.defineProperty(hostile, "findings", { get() { throw new Error("Private canary must never be read"); } });
    for (const current of [{ ...access, allowed: false }, { ...access, authorization_id: "authorization-new" },
      { ...access, scope: { ...access.scope, workspace_id: "workspace-b" } }])
      expect(transitionCoverage(hostile, current, event)).toEqual({ status: "rejected", code: "unauthorized", state: null });
    const newAccess = { ...access, scope: { ...access.scope, workspace_id: "workspace-b" } };
    const clean = stateOf(createCoverageState(newAccess));
    expect(transitionCoverage(clean, newAccess, event)).toEqual({ status: "rejected", code: "unauthorized", state: null });
    expect(clean.findings).toEqual([]);
  });
  it("rejects source clock regression even for the newest request without replacing the last successful source evidence", () => {
    const original = resolved();
    const input = observation(5);
    input.scopes[0]!.check_time = "2026-11-22T11:50:00Z";
    const pending = stateOf(transitionCoverage(original, access, { type: "refresh-requested", scope: access.scope,
      request_id: "regression", generation: 2, origin: "automatic" }));
    const result = transitionCoverage(pending, access, { type: "observation-received", scope: access.scope,
      request_id: "regression", generation: 2, input });
    expect(result).toEqual({ status: "ignored", code: "obsolete", state: pending });
    input.scopes[0]!.check_time = "2026-11-22T11:55:00Z";
    input.evaluated_at = "2026-11-22T11:59:00Z";
    expect(transitionCoverage(pending, access, { type: "observation-received", scope: access.scope,
      request_id: "regression", generation: 2, input })).toEqual({ status: "ignored", code: "obsolete", state: pending });
  });
  it("rejects malformed identities, clocks, choices and reasons without echoing private input or throwing", () => {
    const state = resolved();
    const disposition = { type: "disposition-recorded", scope: access.scope, finding_id: state.findings[0]!.id,
      choice: "intentional-exception", reason: "private canary", actor_id: "leader-a", recorded_at: "2026-11-22T12:01:00Z" };
    const requested = { type: "refresh-requested", scope: access.scope, request_id: "request-b", generation: 2, origin: "automatic" };
    const invalid = [null, undefined, {}, { ...disposition, choice: "send" }, { ...disposition, reason: " \n " },
      { ...disposition, reason: "x".repeat(1001) }, { ...disposition, reason: 5 }, { ...disposition, actor_id: "" },
      { ...disposition, recorded_at: "2026-11-22T12:00:00" }, { ...disposition, recorded_at: "2026-02-30T12:00:00Z" },
      { ...disposition, finding_id: "some other finding" }, { ...disposition, provenance: "invented" },
      { ...requested, generation: NaN }, { ...requested, generation: 1.2 }, { ...requested, generation: 0 },
      { ...requested, generation: Number.MAX_SAFE_INTEGER + 1 }, { ...requested, request_id: "" },
      { ...requested, request_id: "../private-canary" }, { ...requested, origin: "push" }];
    for (const event of invalid) expect(transitionCoverage(state, access, event as never)).toEqual({ status: "rejected", code: "invalid", state: null });
    for (const context of [null, {}, { ...access, allowed: "true" }, { ...access, authorization_id: "" },
      { ...access, scope: { ...access.scope, sunday: "2026-02-30" } }])
      expect(createCoverageState(context as never)).toEqual({ status: "rejected", code: "invalid", state: null });
  });
});
