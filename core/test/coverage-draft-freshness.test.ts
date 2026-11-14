import { expect, test } from "vitest";
import { reviewCoverageDraft } from "../src/coverage-drafts.js";
import { request, state } from "./fixtures/coverage-drafts/base.js";

function preparedWithTwoScopes() {
  const req = request();
  req.source.input.scopes[0]!.check_time = "2026-11-22T11:50:00Z";
  req.source.input.scopes.push({ ...req.source.input.scopes[0]!, scope_id: "fictional-people" });
  req.source.input.required_scope_ids.push("fictional-people");
  for (const candidate of req.source.input.positions[0]!.candidates) {
    for (const observation of [candidate.membership, candidate.eligibility, candidate.availability,
      candidate.blockouts, candidate.assignments]) observation.scope_id = "fictional-people";
  }
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(reviewCoverageDraft(s, req));
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  req.event = { type: "edit", plaintext: "  Keep these exact words.\nNothing has been sent.  " };
  s = state(reviewCoverageDraft(s, req));
  return { req, s };
}

test("a mixed-scope rollback cannot erase newer unavailable-person evidence", () => {
  const setup = preparedWithTwoScopes();
  const req = setup.req;
  let s = setup.s;
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req).status).toBe("copy-prepared");

  req.access.now = req.source.input.evaluated_at = "2026-11-22T12:01:00Z";
  req.source.input.scopes[0]!.check_time = "2026-11-22T11:49:00Z";
  req.source.input.scopes[1]!.check_time = "2026-11-22T11:55:00Z";
  req.source.input.positions[0]!.candidates.find(c => c.person_id === "person-a")!.availability.value = "unavailable";
  req.event = { type: "refresh" };
  const mixed = reviewCoverageDraft(s, req);
  expect(mixed.status).toBe("unverified");
  s = state(mixed);
  expect(s.current.facts.recipients[0]!.disposition).toBe("excluded");
  expect(s.current.evidence.scopes.find(s => s.scope_id === "fictional-people")!.check_time).toBe("2026-11-22T11:55:00Z");
  expect(s.source.input.scopes.find(s => s.scope_id === "fictional-people")!.check_time).toBe("2026-11-22T11:50:00Z");
  expect(s.freshness.scope_check_times.find(s => s.scope_id === "fictional-people")!.check_time).toBe("2026-11-22T11:55:00Z");
  expect(s.draft!.plaintext).toBe("  Keep these exact words.\nNothing has been sent.  ");

  req.access.now = req.source.input.evaluated_at = "2026-11-22T12:02:00Z";
  req.source.input.scopes[0]!.check_time = "2026-11-22T11:56:00Z";
  req.source.input.scopes[1]!.check_time = "2026-11-22T11:51:00Z";
  req.source.input.positions[0]!.candidates.find(c => c.person_id === "person-a")!.availability.value = "available";
  req.event = { type: "prepare-copy" };
  const rollback = reviewCoverageDraft(s, req);
  expect(rollback.status).toBe("unverified");
  expect(state(rollback).draft!.plaintext).toBe("  Keep these exact words.\nNothing has been sent.  ");
});

test("successful copy preparation carries newer scope freshness into the next operation", () => {
  const { req, s } = preparedWithTwoScopes();
  req.access.now = req.source.input.evaluated_at = "2026-11-22T12:01:00Z";
  req.source.input.scopes[1]!.check_time = "2026-11-22T11:55:00Z";
  req.event = { type: "prepare-copy" };
  const copied = reviewCoverageDraft(s, req);
  expect(copied.status).toBe("copy-prepared");
  const next = "state" in copied ? state(copied) : s;

  req.access.now = req.source.input.evaluated_at = "2026-11-22T12:02:00Z";
  req.source.input.scopes[1]!.check_time = "2026-11-22T11:51:00Z";
  expect(reviewCoverageDraft(next, req).status).toBe("unverified");
  expect(next.draft!.plaintext).toBe("  Keep these exact words.\nNothing has been sent.  ");
});

test("a missing schedule scope cannot discard newer people evidence", () => {
  const setup = preparedWithTwoScopes(), req = setup.req;
  req.source.input.scopes = [req.source.input.scopes[1]!];
  req.source.input.scopes[0]!.check_time = "2026-11-22T11:55:00Z";
  req.source.input.positions[0]!.candidates.find(c => c.person_id === "person-a")!.availability.value = "unavailable";
  req.event = { type: "refresh" };
  const s = state(reviewCoverageDraft(setup.s, req));
  req.source.input.scopes.unshift({ ...setup.s.source.input.scopes[0]!, check_time: "2026-11-22T11:56:00Z" });
  req.source.input.scopes[1]!.check_time = "2026-11-22T11:51:00Z";
  req.source.input.positions[0]!.candidates.find(c => c.person_id === "person-a")!.availability.value = "available";
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "unverified", code: "source-unverified" });
});

test("a new required scope seen during another regression cannot disappear silently", () => {
  const { req, s } = preparedWithTwoScopes();
  req.source.input.scopes[0]!.check_time = "2026-11-22T11:49:00Z";
  req.source.input.scopes.push({ ...req.source.input.scopes[1]!, scope_id: "fictional-eligibility", check_time: "2026-11-22T11:55:00Z" });
  req.source.input.required_scope_ids.push("fictional-eligibility");
  req.event = { type: "refresh" };
  const next = state(reviewCoverageDraft(s, req));
  req.source.input.scopes = req.source.input.scopes.slice(0, 2).map(scope => ({ ...scope, check_time: "2026-11-22T11:56:00Z" }));
  req.source.input.required_scope_ids = ["fictional-sunday", "fictional-people"];
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(next, req)).toMatchObject({ status: "unverified", code: "source-unverified" });
});

test("an older host clock cannot lower the next check's freshness floor", () => {
  const { req, s } = preparedWithTwoScopes();
  req.access.now = req.source.input.evaluated_at = "2026-11-22T11:59:00Z";
  req.event = { type: "refresh" };
  const regressed = reviewCoverageDraft(s, req);
  expect(regressed.status).toBe("unverified");
  req.access.now = req.source.input.evaluated_at = "2026-11-22T11:59:30Z";
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(state(regressed), req).status).toBe("unverified");
});

test("genuinely newer recovery remains copyable with verbatim human wording", () => {
  const { req, s } = preparedWithTwoScopes();
  req.source.input.scopes[0]!.check_time = "2026-11-22T11:49:00Z";
  req.source.input.scopes[1]!.check_time = "2026-11-22T11:55:00Z";
  req.source.input.positions[0]!.candidates.find(c => c.person_id === "person-a")!.availability.value = "unavailable";
  req.event = { type: "refresh" };
  const next = state(reviewCoverageDraft(s, req));
  req.source.input.scopes = req.source.input.scopes.map(scope => ({ ...scope, check_time: "2026-11-22T11:56:00Z" }));
  req.source.input.positions[0]!.candidates.find(c => c.person_id === "person-a")!.availability.value = "available";
  req.event = { type: "prepare-copy" };
  const result = reviewCoverageDraft(next, req);
  expect(result).toMatchObject({ status: "copy-prepared", plaintext: "  Keep these exact words.\nNothing has been sent.  ",
    recipients: [{ person_id: "person-a", display_name: "Ada Fiction" }] });
  expect(state(result).current.verification).toBe("verified");
});

test.each(["lower scope", "lower clock", "duplicate scope", "missing required", "extra field"] as const)(
  "malformed prior freshness (%s) is rejected without a private payload", variant => {
    const { req, s } = preparedWithTwoScopes();
    const altered = structuredClone(s);
    if (variant === "lower scope") altered.freshness.scope_check_times[0]!.check_time = "2026-11-22T11:49:00Z";
    if (variant === "lower clock") altered.freshness.evaluated_at = "2026-11-22T11:59:00Z";
    if (variant === "duplicate scope") altered.freshness.scope_check_times.push({ ...altered.freshness.scope_check_times[0]! });
    if (variant === "missing required") altered.freshness.required_scope_ids = [];
    if (variant === "extra field") Object.assign(altered.freshness, { private_extra: "DO_NOT_ECHO_FRESHNESS_CANARY" });
    req.event = { type: "prepare-copy" };
    expect(reviewCoverageDraft(altered, req)).toEqual({ status: "rejected", code: "invalid", state: null });
  });

test.each([[62, "unverified"], [63, "rejected"]] as const)(
  "retaining %i new scopes respects the 64-scope watermark bound", (count, expected) => {
    const { req, s } = preparedWithTwoScopes();
    req.source.input.scopes = [req.source.input.scopes[0]!, ...Array.from({ length: count }, (_, i) => ({
      ...req.source.input.scopes[0]!, scope_id: `extra-${i}`, check_time: "2026-11-22T11:55:00Z",
    }))];
    req.source.input.required_scope_ids = req.source.input.scopes.map(scope => scope.scope_id);
    req.event = { type: "refresh" };
    const result = reviewCoverageDraft(s, req);
    expect(result.status).toBe(expected);
    if (result.status === "rejected") expect(result).toEqual({ status: "rejected", code: "invalid", state: null });
    else expect(state(result).freshness.scope_check_times).toHaveLength(64);
  });
