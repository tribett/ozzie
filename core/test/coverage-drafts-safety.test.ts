import { expect, test } from "vitest";
import { reviewCoverageDraft } from "../src/coverage-drafts.js";
import type { DraftRequest } from "../src/coverage-drafts.js";
import { invitation, request, state } from "./fixtures/coverage-drafts/base.js";

test.each(["select", "prepare", "edit", "refresh", "review-changes", "prepare-copy", "cancel"] as const)("%s rechecks current permission and never returns private state on denial", type => {
  const req = request(), s = state(reviewCoverageDraft(null, req));
  req.access.allowed = false;
  req.event = type === "select" ? { type, purpose: "invitation", person_ids: ["person-a"] }
    : type === "edit" ? { type, plaintext: "PRIVATE_EDIT_CANARY" } : { type };
  expect(reviewCoverageDraft(s, req)).toEqual({ status: "rejected", code: "unauthorized", state: null });
});

test.each(["access", "source", "authorization", "person access", "position access"])("%s mismatch denies private review", variant => {
  const req = request(), s = state(reviewCoverageDraft(null, req));
  if (variant === "access") req.access.scope.workspace_id = "other-workspace";
  if (variant === "source") req.source.scope.plan_id = "other-plan";
  if (variant === "authorization") req.access.authorization_id = "other-grant";
  if (variant === "person access") req.access.person_ids = ["leader-a"];
  if (variant === "position access") req.access.position_ids = [];
  req.event = { type: "refresh" };
  expect(reviewCoverageDraft(s, req)).toEqual({ status: "rejected",
    code: variant === "source" || variant === "access" ? "scope-mismatch" : "unauthorized", state: null });
});

test.each(["extra", "getter", "symbol", "sparse", "duplicate identity", "missing identity", "duplicate person", "unknown target", "bad zone", "bad Sunday", "oversize"])("closed malformed %s input is sanitized", variant => {
  const req = request();
  const untyped = req as unknown as Record<string, unknown>;
  if (variant === "extra") untyped.private_canary = "PRIVATE_CANARY";
  if (variant === "getter") Object.defineProperty(req.source, "canary", { enumerable: true, get() { throw new Error("PRIVATE_CANARY"); } });
  if (variant === "symbol") Object.defineProperty(req.source, Symbol("private"), { value: "PRIVATE_CANARY" });
  if (variant === "sparse") req.source.identities = new Array(2);
  if (variant === "duplicate identity") req.source.identities.push({ ...req.source.identities[0]! });
  if (variant === "missing identity") req.source.identities.shift();
  if (variant === "duplicate person") req.source.input.positions[0]!.candidates.push(req.source.input.positions[0]!.candidates[0]!);
  if (variant === "unknown target") req.event = { type: "start", position_id: "unknown" };
  if (variant === "bad zone") req.source.church_timezone = "Eastern Sunday morning PRIVATE_CANARY";
  if (variant === "bad Sunday") req.source.scope.sunday = req.access.scope.sunday = "2026-11-23";
  if (variant === "oversize") req.source.identities[0]!.display_name = "x".repeat(201);
  expect(reviewCoverageDraft(null, untyped as unknown as DraftRequest)).toEqual({ status: "rejected", code: "invalid", state: null });
});

test("all private outputs are independently copied and recursively frozen", () => {
  const req = request();
  const s = state(reviewCoverageDraft(null, req));
  req.source.identities[1]!.display_name = "CHANGED";
  expect(s.current.candidates[0]!.display_name).toBe("Ada Fiction");
  expect(() => { s.current.candidates[0]!.display_name = "CHANGED"; }).toThrow();
  expect(() => { s.source.input.positions[0]!.candidates.length = 0; }).toThrow();
});

test("untyped manufactured selection cannot promote an excluded person or invent an unknown recipient", () => {
  const req = request();
  req.source.input.positions[0]!.candidates[1]!.eligibility.value = false;
  const s = structuredClone(state(reviewCoverageDraft(null, req)));
  s.selection.person_ids = ["person-a"];
  s.current.candidates[0]!.disposition = "suggestion";
  req.event = { type: "prepare" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "unverified", code: "recipient-unverified" });
  req.event = { type: "select", purpose: "invitation", person_ids: ["unknown"] };
  expect(reviewCoverageDraft(s, req)).toEqual({ status: "rejected", code: "invalid", state: null });
});

test("duplicate explicit recipients are rejected rather than silently merged", () => {
  const req = request(), s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a", "person-a"] };
  expect(reviewCoverageDraft(s, req)).toEqual({ status: "rejected", code: "invalid", state: null });
});

test("a fresh Sunday or workspace starts empty; cancellation returns no retained text", () => {
  const req = request();
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(reviewCoverageDraft(s, req));
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  req.source.scope.sunday = req.access.scope.sunday = "2026-11-29";
  req.source.scope.workspace_id = req.access.scope.workspace_id = "workspace-b";
  req.event = { type: "start", position_id: "position-a" };
  const next = state(reviewCoverageDraft(s, req));
  expect(next.selection.person_ids).toEqual([]);
  expect(next.draft).toBeNull();
  req.event = { type: "cancel" };
  expect(reviewCoverageDraft(next, req)).toEqual({ status: "applied", code: "cancelled", state: null });
});


test("revocation covers original draft identities even after their current source records disappear", () => {
  const { req, s } = invitation(reviewCoverageDraft);
  req.source.input.positions[0]!.candidates = req.source.input.positions[0]!.candidates.filter(c => c.person_id !== "person-a");
  req.source.identities = req.source.identities.filter(p => p.person_id !== "person-a");
  req.event = { type: "refresh" };
  const next = state(reviewCoverageDraft(s, req));
  expect(next.current.verification).toBe("unverified");
  req.access.person_ids = req.access.person_ids.filter(id => id !== "person-a");
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(next, req)).toEqual({ status: "rejected", code: "unauthorized", state: null });
});

test("editing, preparing or reviewing cannot requalify a selected person whose eligibility was lost", () => {
  const { req, s } = invitation(reviewCoverageDraft);
  req.source.input.positions[0]!.candidates[1]!.eligibility.value = false;
  for (const type of ["edit", "prepare", "review-changes", "prepare-copy"] as const) {
    req.event = type === "edit" ? { type, plaintext: "new human words" } : { type };
    const result = reviewCoverageDraft(s, req);
    expect(result.status).not.toBe("copy-prepared");
    expect(state(result).current.facts.recipients[0]!.disposition).toBe("excluded");
  }
});

test.each(["cyclic", "non JSON", "array limit", "selection limit", "text limit", "request bytes", "previous extra", "interval prose"])("%s is closed without echoing the malformed value", variant => {
  const { req, s } = invitation(reviewCoverageDraft);
  let prior = s;
  if (variant === "cyclic") (req as unknown as Record<string, unknown>).self = req;
  if (variant === "non JSON") (req.source as unknown as Record<string, unknown>).date = new Date();
  if (variant === "array limit") req.source.input.positions[0]!.assignments.value = new Array(2001).fill({});
  if (variant === "selection limit") req.event = { type: "select", purpose: "invitation", person_ids: new Array(21).fill("person-a") };
  if (variant === "text limit") req.event = { type: "edit", plaintext: "x".repeat(8001) };
  if (variant === "request bytes") req.source.identities[0]!.display_name = "秘".repeat(400000);
  if (variant === "previous extra") { prior = structuredClone(s); (prior as unknown as Record<string, unknown>).extra = "PRIVATE_CANARY"; }
  if (variant === "interval prose") (req.source.input.positions[0]!.interval as unknown as Record<string, unknown>).formatted = "PRIVATE_CANARY";
  expect(reviewCoverageDraft(prior, req)).toEqual({ status: "rejected", code: "invalid", state: null });
});

test("a legal-size source whose operational output would exceed the JSON budget fails closed", () => {
  const req = request();
  req.source.input.positions[0]!.candidates = [];
  req.source.identities = [];
  req.source.leaders = [];
  req.access.person_ids = [];
  for (let n = 0; n < 160; n++) {
    const person_id = `fiction-${n}`;
    req.access.person_ids.push(person_id);
    req.source.identities.push({ person_id, display_name: `Fiction ${n}` });
    req.source.input.positions[0]!.candidates.push({ person_id,
      membership: { scope_id: "fictional-sunday", value: true }, eligibility: { scope_id: "fictional-sunday", value: true },
      availability: { scope_id: "fictional-sunday", value: "available" }, blockouts: { scope_id: "fictional-sunday", value: [] },
      assignments: { scope_id: "fictional-sunday", value: [{ assignment_id: "other-day", status: "C", notification: "sent", time_semantics: "verified",
        intervals: new Array(50).fill({ starts_at: "2026-11-23T14:30:00Z", ends_at: "2026-11-23T15:30:00Z" }) }] } });
  }
  expect(new TextEncoder().encode(JSON.stringify(req)).length).toBeLessThan(1_048_576);
  const result = reviewCoverageDraft(null, req);
  expect(result.status).toBe("rejected");
  expect(result).toEqual({ status: "rejected", code: "invalid", state: null });
});

test.each(["difference", "original scope", "current scope"])("malformed prior %s cannot cross the local seam", variant => {
  const { req, s } = invitation(reviewCoverageDraft);
  const altered = structuredClone(s);
  if (variant === "difference") (altered.differences as unknown[]).push({ field: "target", before: { private: "PRIVATE_CANARY" }, after: {} });
  if (variant === "original scope") altered.draft!.original_facts.target.sunday = "2026-11-29";
  if (variant === "current scope") altered.current.facts.target.position_id = "other-position";
  req.event = { type: "refresh" };
  const result = reviewCoverageDraft(altered, req);
  expect(result.status).toBe("rejected");
  expect(result).toEqual({ status: "rejected", code: "invalid", state: null });
});
