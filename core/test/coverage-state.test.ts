import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "../src/coverage.js";
import { observed } from "./fixtures/coverage/base.js";
import { createCoverageState, transitionCoverage } from "../src/coverage-state.js";
import { access, observation, refresh, resolved, stateOf } from "./fixtures/coverage-state/base.js";

describe("authorized Sunday dispositions", () => {
  it("a verified removal of the lead requirement clears stale attention and retains the Sunday reason", () => {
    const input = observation(0);
    input.positions[0]!.lead.value.mapping = "required";
    const checked = refresh(stateOf(createCoverageState(access)), input);
    const lead = checked.findings.find(f => f.kind === "required-lead")!;
    expect(lead.status).toBe("attention");
    const manual = stateOf(transitionCoverage(checked, access, { type: "disposition-recorded", scope: access.scope,
      finding_id: lead.id, choice: "intentional-exception", reason: "Fictional Sunday decision", actor_id: "leader-a",
      recorded_at: "2026-11-22T12:01:00Z" }));
    input.positions[0]!.lead.value.mapping = "not-required";
    const removed = refresh(manual, input);
    const updated = removed.findings.find(f => f.id === lead.id)!;
    expect(updated).toMatchObject({ status: "source-confirmed", label: "Role requirement checked", facts: { lead: "not-required" },
      history: [{ reason: "Fictional Sunday decision" }] });
    const open = refresh(checked, input).findings.find(f => f.id === lead.id)!;
    expect(open.status).toBe("source-confirmed");
    input.positions[0]!.lead.value.mapping = "required";
    const reopened = refresh(removed, input);
    expect(reopened.findings.find(f => f.id === lead.id)).toMatchObject({ status: "attention",
      change: { reasons: ["requirement-added"] }, history: [{ reason: "Fictional Sunday decision" }] });
  });
  it.each(["role-mapping", "source-confirmed"])("manual coverage cannot overwrite %s evidence", kind => {
    const input = observation(kind === "source-confirmed" ? 1 : 0);
    if (kind === "role-mapping") input.positions[0]!.lead.value.mapping = "unknown";
    let checked = refresh(stateOf(createCoverageState(access)), input);
    if (kind === "source-confirmed") checked = refresh(checked, observation(0));
    const finding = checked.findings.find(f => kind === "role-mapping" ? f.kind === "role-mapping" : f.status === "source-confirmed")!;
    const result = transitionCoverage(checked, access, { type: "disposition-recorded", scope: access.scope,
      finding_id: finding.id, choice: "covered-outside-pco", reason: "Fictional attempted rewrite", actor_id: "leader-a",
      recorded_at: "2026-11-22T12:01:00Z" });
    expect(result).toEqual({ status: "rejected", code: "invalid", state: null });
    expect(checked.findings.find(f => f.id === finding.id)).toEqual(finding);
  });
  it("C17 a decline outside the required serving interval does not reopen the local disposition", () => {
    const input = observation();
    input.positions[0]!.assignments = observed([{ assignment_id: "later", status: "C", notification: "sent", time_semantics: "verified",
      intervals: [{ starts_at: "2026-11-22T16:00:00Z", ends_at: "2026-11-22T17:00:00Z" }] }]);
    const checked = refresh(stateOf(createCoverageState(access)), input);
    const manual = stateOf(transitionCoverage(checked, access, { type: "disposition-recorded", scope: access.scope,
      finding_id: checked.findings[0]!.id, choice: "intentional-exception", reason: "Handled for the morning", actor_id: "leader-a",
      recorded_at: "2026-11-22T12:01:00Z" }));
    input.positions[0]!.assignments.value[0]!.status = "D";
    expect(refresh(manual, input).findings[0]?.status).toBe("resolved-by-you");
  });
  it("C02/C04 missing role mapping returns to Worth a look after a known mapping, without claiming lead loss", () => {
    const input = observation(0);
    input.positions[0]!.lead.value.mapping = "unknown";
    const unknown = refresh(stateOf(createCoverageState(access)), input);
    input.positions[0]!.lead.value.mapping = "not-required";
    const known = refresh(unknown, input);
    expect(known.findings[0]?.label).toBe("Role requirement checked");
    input.positions[0]!.lead.value.mapping = "unknown";
    const again = refresh(known, input);
    expect(again.findings).toHaveLength(1);
    expect(again.findings[0]).toMatchObject({ kind: "role-mapping", status: "worth-a-look", label: "Worth a look", change: null });
  });
  it.each(["partial", "stale", "denied", "unreadable", "unverified", "missing-scope", "expired", "future",
    "missing-position", "missing-need", "negative-need", "missing-lead-evidence", "invalid-interval", "ambiguous-interval", "missing-required-scope"])(
    "C24/C25 %s cannot replace human disposition or invent source-confirmed zero", kind => {
      const manual = resolved(), input = observation(0);
      if (["partial", "stale", "denied", "unreadable", "unverified"].includes(kind))
        input.scopes[0]!.completeness = kind as "partial" | "stale" | "denied" | "unreadable" | "unverified";
      if (kind === "missing-scope") input.scopes = [];
      if (kind === "expired") input.scopes[0]!.valid_until = "2026-11-22T11:59:59Z";
      if (kind === "future") input.scopes[0]!.check_time = "2026-11-22T12:01:00Z";
      if (kind === "missing-position") input.positions = [];
      if (kind === "missing-need") input.positions[0]!.remaining_need.value = null;
      if (kind === "negative-need") input.positions[0]!.remaining_need.value = -1;
      if (kind === "missing-lead-evidence") input.positions[0]!.lead.scope_id = "absent";
      if (kind === "invalid-interval") input.positions[0]!.interval = null;
      if (kind === "ambiguous-interval") input.positions[0]!.interval!.starts_at = "unknown";
      if (kind === "missing-required-scope") input.required_scope_ids = [];
      const result = refresh(manual, input);
      expect(result.findings).toEqual(manual.findings);
      expect(result.verification).toMatchObject({ status: "unverified", last_successful_check_time: "2026-11-22T11:55:00Z" });
    });
  it("C27 reordered positions, assignments and intervals preserve identities; duplicate requirement rows cannot confirm coverage", () => {
    const input = observation();
    input.positions.push({ ...structuredClone(input.positions[0]!), position_id: "position-b", remaining_need: observed(2) });
    input.positions[0]!.assignments = observed(["assignment-a", "assignment-b"].map(assignment_id => ({ assignment_id, status: "C",
      notification: "unsent", time_semantics: "verified", intervals: [
        { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:00:00Z" },
        { starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T15:30:00Z" },
      ] })));
    const state = refresh(stateOf(createCoverageState(access)), input);
    const reordered = structuredClone(input);
    reordered.positions.reverse();
    reordered.positions[1]!.assignments.value.reverse().forEach(a => a.intervals.reverse());
    const repeated = refresh(state, reordered);
    expect(repeated.findings).toEqual(state.findings);
    expect(repeated.findings).toHaveLength(2);
    const duplicate = observation(0);
    duplicate.positions.push(structuredClone(duplicate.positions[0]!));
    const manual = resolved();
    const invalid = refresh(manual, duplicate);
    expect(invalid.findings).toEqual(manual.findings);
    expect(invalid.verification.status).toBe("unverified");
  });
  it("C17 a newly uncovered requirement retains concrete previously checked facts even when the original check had no finding", () => {
    const input = observation(0), position = input.positions[0]!;
    position.lead = observed({ mapping: "required", assignment_ids: ["lead-a"] });
    position.assignments = observed([{ assignment_id: "lead-a", status: "C", notification: "sent",
      time_semantics: "verified", intervals: [position.interval!] }]);
    const clear = refresh(stateOf(createCoverageState(access)), input);
    expect(clear.findings).toEqual([]);
    position.assignments.value[0]!.status = "D";
    const newlyLost = refresh(clear, input);
    expect(newlyLost.findings[0]).toMatchObject({ kind: "required-lead", status: "attention",
      change: { reasons: ["required-lead-coverage-lost"], before: { lead: "confirmed" }, after: { lead: "missing" } } });
    const added = observation(0);
    added.positions.push({ ...structuredClone(added.positions[0]!), position_id: "position-new", remaining_need: observed(2) });
    const newRequirement = refresh(clear, added);
    expect(newRequirement.findings.find(f => f.position_id === "position-new")).toMatchObject({ status: "attention",
      change: { reasons: ["requirement-added"], before: null, after: { remaining_need: 2 } } });
  });
  it("C16/C17 exact required interval matters: another interval cannot fill the old gap, a new positive requirement reopens", () => {
    const manual = resolved();
    const changed = observation(0);
    changed.positions[0]!.interval!.starts_at = "2026-11-22T15:00:00Z";
    changed.positions[0]!.interval!.ends_at = "2026-11-22T16:00:00Z";
    const notProof = refresh(manual, changed);
    expect(notProof.findings).toEqual(manual.findings);
    expect(notProof.verification.status).toBe("unverified");
    changed.positions[0]!.remaining_need.value = 1;
    const reopened = refresh(manual, changed);
    expect(reopened.findings[0]).toMatchObject({ status: "attention", history: manual.findings[0]!.history,
      change: { reasons: ["requirement-interval-changed"], before: { interval: { starts_at: "2026-11-22T14:30:00.000Z" } },
        after: { interval: { starts_at: "2026-11-22T15:00:00.000Z" } } } });
  });
  it("C03/C16/C17 lost confirmed required-lead interval reopens; unknown mapping is a separate Worth a look finding", () => {
    const input = observation(0), position = input.positions[0]!;
    position.lead = observed({ mapping: "required", assignment_ids: ["lead-a"] });
    position.assignments = observed([{ assignment_id: "lead-a", status: "D", notification: "sent",
      intervals: [position.interval!], time_semantics: "verified" }]);
    const gap = refresh(stateOf(createCoverageState(access)), input);
    expect(gap.findings[0]).toMatchObject({ kind: "required-lead", status: "attention" });
    position.assignments.value[0]!.status = "C";
    const covered = refresh(gap, input);
    expect(covered.findings[0]?.status).toBe("source-confirmed");
    position.assignments.value[0]!.intervals[0] = { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:00:00Z" };
    const lost = refresh(covered, input);
    expect(lost.findings[0]).toMatchObject({ id: gap.findings[0]!.id, status: "attention",
      change: { reasons: ["required-lead-coverage-lost"], before: { lead: "confirmed" }, after: { lead: "missing" } } });
    position.lead = observed({ mapping: "unknown", assignment_ids: [] });
    const unclear = refresh(covered, input);
    expect(unclear.findings.find(f => f.kind === "required-lead")?.status).toBe("source-confirmed");
    expect(unclear.findings.find(f => f.kind === "role-mapping")).toMatchObject({ status: "worth-a-look", label: "Worth a look", change: null });
    expect(unclear.verification.status).toBe("unverified");
  });
  it("C17 a relevant confirmed/pending decline reopens even with unchanged remaining need; other assignment changes do not", () => {
    for (const status of ["C", "U"] as const) {
      const input = observation();
      input.positions[0]!.assignments = observed([{ assignment_id: "assignment-a", status, notification: "unsent",
        time_semantics: "verified", intervals: [input.positions[0]!.interval!] }]);
      const initial = refresh(stateOf(createCoverageState(access)), input);
      const manual = stateOf(transitionCoverage(initial, access, { type: "disposition-recorded", scope: access.scope,
        finding_id: initial.findings[0]!.id, choice: "covered-outside-pco", reason: "Handled locally", actor_id: "leader-a",
        recorded_at: "2026-11-22T12:01:00Z" }));
      const changed = structuredClone(input);
      changed.positions[0]!.assignments.value[0]!.notification = "sent";
      expect(refresh(manual, changed).findings[0]?.status).toBe("resolved-by-you");
      changed.positions[0]!.assignments.value[0]!.status = "D";
      const reopened = refresh(manual, changed);
      expect(reopened.findings[0]).toMatchObject({ status: "attention", history: manual.findings[0]!.history,
        change: { reasons: ["assignment-declined"], before: { remaining_need: 1, assignments: [{ status }] },
          after: { remaining_need: 1, assignments: [{ status: "D" }] } } });
      expect(refresh(reopened, changed).findings).toEqual(reopened.findings);
      expect(reopened.findings[0]?.facts.remaining_need).toBe(1);
    }
  });
  it("C17 increased remaining need reopens with concrete old/new facts; decreased need does not", () => {
    const manual = resolved();
    const reopened = refresh(manual, observation(2));
    expect(reopened.findings[0]).toMatchObject({ status: "attention", history: manual.findings[0]!.history,
      change: { reasons: ["remaining-need-increased"], before: { remaining_need: 1 }, after: { remaining_need: 2 } } });
    const decrease = refresh(manual, observation(0));
    expect(decrease.findings[0]?.status).toBe("source-confirmed");
    expect(refresh(reopened, observation(2)).findings).toEqual(reopened.findings);
    const fromConfirmed = refresh(decrease, observation(1));
    expect(fromConfirmed.findings[0]).toMatchObject({ status: "attention",
      change: { before: { remaining_need: 0 }, after: { remaining_need: 1 } } });
    const reduced = refresh(stateOf(transitionCoverage(reopened, access, { type: "disposition-recorded", scope: access.scope,
      finding_id: reopened.findings[0]!.id, choice: "intentional-exception", reason: "Two intentionally unfilled", actor_id: "leader-a",
      recorded_at: "2026-11-22T12:02:00Z" })), observation(1));
    expect(reduced.findings[0]?.status).toBe("resolved-by-you");
  });
  it("C16/C24 source confirmation is separate from manual history and denial preserves the last successful evidence", () => {
    const manual = resolved();
    const confirmed = refresh(manual, observation(0));
    expect(confirmed.findings[0]).toMatchObject({ status: "source-confirmed", label: "Source-confirmed",
      history: manual.findings[0]!.history, facts: { remaining_need: 0 },
      evidence: { evaluated_at: "2026-11-22T12:00:00Z", scopes: [{ check_time: "2026-11-22T11:55:00Z" }] } });
    const denied = observation(0);
    denied.scopes[0]!.completeness = "denied";
    denied.evaluated_at = "2026-11-22T12:02:00Z";
    const unavailable = refresh(confirmed, denied);
    expect(unavailable.findings).toEqual(confirmed.findings);
    expect(unavailable.verification).toMatchObject({ status: "unverified", observed_at: "2026-11-22T12:02:00Z",
      last_successful_check_time: "2026-11-22T11:55:00Z" });
    expect(unavailable.verification.issues).toContainEqual(expect.objectContaining({ code: "scope-unverified" }));
    expect(refresh(manual, denied).findings).toEqual(manual.findings);
  });
  it("C18/C27 unchanged on-demand/automatic observations preserve the continuing finding and private disposition", () => {
    const state = resolved();
    const again = refresh(refresh(state));
    expect(again.findings).toEqual(state.findings);
    const newer = observation();
    newer.scopes[0]!.source = "Fictional revised description";
    newer.scopes[0]!.check_time = "2026-11-22T11:59:00Z";
    const latest = refresh(again, newer);
    expect(latest.findings[0]).toMatchObject({ id: state.findings[0]!.id, status: "resolved-by-you",
      history: state.findings[0]!.history, change: null });
    expect(latest.findings).toHaveLength(1);
    expect(latest.findings[0]?.evidence?.scopes[0]?.check_time).toBe("2026-11-22T11:59:00Z");
    const otherAccess = { ...access, scope: { ...access.scope, sunday: "2026-11-29" } };
    const nextSunday = refresh(stateOf(createCoverageState(otherAccess)), observation(), otherAccess);
    expect(nextSunday.findings[0]?.id).not.toBe(state.findings[0]?.id);
    expect(nextSunday.findings[0]?.status).toBe("attention");
    expect(nextSunday.findings[0]?.history).toEqual([]);
  });
  it("C14/C15 preserves the exact private reason for this finding and Sunday without changing source coverage", () => {
    const input = observation();
    let state = stateOf(createCoverageState(access));
    state = stateOf(transitionCoverage(state, access, { type: "refresh-requested", scope: access.scope,
      request_id: "request-a", generation: 1, origin: "on-demand" }));
    expect(state.findings).toEqual([]); // Accepted work is not a completed read.
    state = stateOf(transitionCoverage(state, access, { type: "observation-received", scope: access.scope,
      request_id: "request-a", generation: 1, input }));
    expect(evaluateCoverage(input).positions[0]?.remaining_need).toBe(1);
    expect(state.findings).toHaveLength(1);
    const reason = "  Fictional private reason; agreed outside the schedule.\nKeep wording.  ";
    const result = transitionCoverage(state, access, { type: "disposition-recorded", scope: access.scope,
      finding_id: state.findings[0]!.id, choice: "covered-outside-pco", reason, actor_id: "leader-a",
      recorded_at: "2026-11-22T12:01:00Z" });
    state = stateOf(result);
    expect(state.findings[0]).toMatchObject({ status: "resolved-by-you", label: "Resolved by you",
      history: [{ reason, choice: "covered-outside-pco", actor_id: "leader-a", recorded_at: "2026-11-22T12:01:00Z" }] });
    expect(Object.keys(result).sort()).toEqual(["code", "state", "status"]);
    expect(JSON.stringify({ status: result.status, code: result.code })).not.toContain(reason);
    expect(evaluateCoverage(input).positions[0]?.remaining_need).toBe(1);
    expect(state.findings[0]?.facts.remaining_need).toBe(1);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
