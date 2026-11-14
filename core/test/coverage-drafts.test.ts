import { expect, test } from "vitest";
import { reviewCoverageDraft } from "../src/coverage-drafts.js";
import { invitation, request, state } from "./fixtures/coverage-drafts/base.js";

test("explicit review starts alphabetical and unranked with no recipient or prepared text", () => {
  const result = reviewCoverageDraft(null, request());
  expect(result.status).toBe("applied");
  const s = state(result);
  expect(s.current.candidates.map(p => [p.person_id, p.display_name, p.disposition])).toEqual([
    ["person-a", "Ada Fiction", "suggestion"], ["person-b", "Zoe Fiction", "suggestion"],
  ]);
  expect(s.selection).toEqual({ purpose: "invitation", person_ids: [] });
  expect(s.draft).toBeNull();
});

test("selection shows the exact source-backed outline; only explicit preparation creates an invitation", () => {
  const req = request();
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(reviewCoverageDraft(s, req));
  expect(s.draft).toBeNull();
  expect(s.current.facts.target).toEqual({ position_id: "position-a", team_id: "team-a", sunday: "2026-11-22",
    ministry: "Ministry A", role: "Welcome desk", remaining_need: 1, church_timezone: "America/New_York",
    interval: { starts_at: "2026-11-22T14:30:00.000Z", ends_at: "2026-11-22T15:30:00.000Z" },
    formatted_interval: "2026-11-22 09:30:00 GMT-05:00 – 2026-11-22 10:30:00 GMT-05:00 (America/New_York)" });
  expect(s.current.facts.recipients.map(p => p.display_name)).toEqual(["Ada Fiction"]);
  expect(s.current.evidence.scopes[0]?.check_time).toBe("2026-11-22T11:55:00Z");
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  expect(s.draft?.plaintext).toBe("Hello Ada Fiction,\n\nWould you be willing to serve with Ministry A as Welcome desk for Sunday 2026-11-22?\nServing interval: 2026-11-22 09:30:00 GMT-05:00 – 2026-11-22 10:30:00 GMT-05:00 (America/New_York).\n\nPlease let me know. This invitation does not confirm availability or willingness.");
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req)).toEqual({ status: "copy-prepared", plaintext: s.draft!.plaintext,
    recipients: [{ person_id: "person-a", display_name: "Ada Fiction" }], state: s });
});

test.each([
  ["not member", "excluded", "Team membership excludes this suggestion."],
  ["not eligible", "excluded", "Required role eligibility excludes this suggestion."],
  ["unavailable", "excluded", "Recorded availability excludes this suggestion."],
  ["unknown availability", "unverified", "Recorded availability couldn't be verified."],
  ["confirmed overlap", "excluded", "Confirmed overlapping serving assignment."],
] as const)("%s retains evaluator evidence and cannot become a selected suggestion", (variant, disposition, reason) => {
  const req = request(), c = req.source.input.positions[0]!.candidates[1]!;
  if (variant === "not member") c.membership.value = false;
  if (variant === "not eligible") c.eligibility.value = false;
  if (variant === "unavailable") c.availability.value = "unavailable";
  if (variant === "unknown availability") c.availability.value = "unknown";
  if (variant === "confirmed overlap") c.assignments.value = [{ assignment_id: "other-service", status: "C", notification: "sent",
    intervals: [{ starts_at: "2026-11-22T10:00:00-05:00", ends_at: "2026-11-22T11:00:00-05:00" }], time_semantics: "verified" }];
  let s = state(reviewCoverageDraft(null, req));
  expect(s.current.candidates[0]).toMatchObject({ person_id: "person-a", disposition, reasons: [reason], observation: c });
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  const denied = reviewCoverageDraft(s, req);
  expect(denied).toMatchObject({ status: "unverified", code: "recipient-unverified" });
  s = state(denied);
  expect(s.selection.person_ids).toEqual([]);
  expect(s.draft).toBeNull();
});

test.each(["sent", "unsent", "unknown"] as const)("unanswered %s overlap remains explicitly possible at selection and copy preparation", notification => {
  const req = request();
  req.source.input.positions[0]!.candidates[1]!.assignments.value = [{ assignment_id: "other-service", status: "U", notification,
    intervals: [{ starts_at: "2026-11-22T10:00:00-05:00", ends_at: "2026-11-22T11:00:00-05:00" }], time_semantics: "verified" }];
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(reviewCoverageDraft(s, req));
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  expect(s.current.facts.recipients[0]).toMatchObject({ disposition: "possible-conflict", reasons: [
    notification === "sent" ? "Possible conflict: source records an unanswered sent request."
      : notification === "unsent" ? "Possible conflict: unconfirmed scheduling record; invitation not sent."
        : "Possible conflict: unconfirmed scheduling record; sending couldn't be verified.",
  ] });
  expect(s.draft?.original_facts.recipients[0]?.disposition).toBe("possible-conflict");
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req).status).toBe("copy-prepared");
});

test("human edits survive unchanged and relevant refreshes; explicit current review alone clears a stale draft", () => {
  const req = request();
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(reviewCoverageDraft(s, req));
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  const original = s.draft!.original_facts;
  req.event = { type: "edit", plaintext: "  My own words\n\nPRIVATE_EDIT_CANARY — do not replace.  " };
  s = state(reviewCoverageDraft(s, req));
  expect(s.draft!.plaintext).toBe("  My own words\n\nPRIVATE_EDIT_CANARY — do not replace.  ");
  req.source.input.scopes[0]!.source = "renamed fictional source";
  req.source.input.scopes[0]!.check_time = "2026-11-22T11:56:00Z";
  req.source.input.positions[0]!.candidates.reverse();
  req.event = { type: "refresh" };
  s = state(reviewCoverageDraft(s, req));
  expect(s.differences).toEqual([]);
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "copy-prepared", plaintext: "  My own words\n\nPRIVATE_EDIT_CANARY — do not replace.  " });
  req.source.labels[0]!.role.value = "Door welcome";
  req.event = { type: "refresh" };
  s = state(reviewCoverageDraft(s, req));
  expect(s.differences).toEqual([{ field: "target", before: original.target,
    after: { ...original.target, role: "Door welcome" } }]);
  expect(s.draft!.original_facts).toEqual(original);
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "unverified", code: "draft-stale" });
  req.event = { type: "review-changes" };
  s = state(reviewCoverageDraft(s, req));
  expect(s.differences).toEqual([]);
  expect(s.draft!.original_facts).toEqual(original);
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "copy-prepared", plaintext: "  My own words\n\nPRIVATE_EDIT_CANARY — do not replace.  " });
});


test.each(["partial", "stale", "denied", "unreadable", "unverified", "expired", "future", "older", "missing scope", "missing target", "missing labels", "unknown time", "zero need"])("%s evidence preserves edits and prevents source revalidation/copy", variant => {
  const { req, s } = invitation(reviewCoverageDraft);
  if (["partial", "stale", "denied", "unreadable", "unverified"].includes(variant))
    req.source.input.scopes[0]!.completeness = variant as "partial";
  if (variant === "expired") req.access.now = "2026-11-22T12:06:00Z";
  if (variant === "future") req.source.input.scopes[0]!.check_time = "2026-11-22T12:01:00Z";
  if (variant === "older") req.source.input.scopes[0]!.check_time = "2026-11-22T11:54:00Z";
  if (variant === "missing scope") req.source.input.scopes = [];
  if (variant === "missing target") { req.source.input.positions = []; req.source.labels = []; }
  if (variant === "missing labels") req.source.labels = [];
  if (variant === "unknown time") req.source.input.positions[0]!.interval = null;
  if (variant === "zero need") req.source.input.positions[0]!.remaining_need.value = 0;
  req.event = { type: "refresh" };
  const refreshed = reviewCoverageDraft(s, req);
  expect(state(refreshed).draft!.plaintext).toBe("Verbatim human text\n  keep spacing  ");
  if (variant !== "zero need") expect(state(refreshed).current.verification).toBe("unverified");
  req.event = { type: "prepare-copy" };
  const result = reviewCoverageDraft(state(refreshed), req);
  expect(result.status).toBe("unverified");
  expect(state(result).draft!.plaintext).toBe("Verbatim human text\n  keep spacing  ");
});

test.each(["availability", "membership", "eligibility", "conflict", "interval", "recipient"])("relevant %s change is detected at copy even without a prior refresh", variant => {
  const { req, s } = invitation(reviewCoverageDraft);
  const c = req.source.input.positions[0]!.candidates[1]!;
  if (variant === "availability") c.availability.value = "unknown";
  if (variant === "membership") c.membership.value = false;
  if (variant === "eligibility") c.eligibility.value = false;
  if (variant === "conflict") c.assignments.value = [{ assignment_id: "later", status: "U", notification: "unsent", time_semantics: "verified",
    intervals: [{ starts_at: "2026-11-22T15:00:00Z", ends_at: "2026-11-22T16:00:00Z" }] }];
  if (variant === "interval") req.source.input.positions[0]!.interval!.starts_at = "2026-11-22T09:00:00-05:00";
  if (variant === "recipient") req.source.identities[1]!.display_name = "Ada Renamed Fiction";
  req.event = { type: "prepare-copy" };
  const result = reviewCoverageDraft(s, req);
  expect(result.status).toBe("unverified");
  expect(state(result).differences.map(d => d.field)).toEqual([variant === "interval" ? "target" : "recipients"]);
  expect(state(result).draft!.plaintext).toBe("Verbatim human text\n  keep spacing  ");
});

test("no qualifying member established permits only an explicitly chosen source-backed ministry leader", () => {
  const req = request();
  req.source.input.positions[0]!.candidates.forEach(c => { c.membership.value = false; });
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "prepare" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "unverified", code: "recipient-unverified" });
  req.event = { type: "select", purpose: "escalation", person_ids: ["leader-a"] };
  s = state(reviewCoverageDraft(s, req));
  expect(s.draft).toBeNull();
  expect(s.current.facts.recipients).toMatchObject([{ person_id: "leader-a", display_name: "Lee Fiction", disposition: "leader" }]);
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  expect(s.draft!.plaintext).toBe("Hello Lee Fiction,\n\nMinistry A still has 1 remaining need for Welcome desk on Sunday 2026-11-22.\nServing interval: 2026-11-22 09:30:00 GMT-05:00 – 2026-11-22 10:30:00 GMT-05:00 (America/New_York).\nNo qualifying member was established in the checked scope. Please review the coverage need and the checked constraints.");
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "copy-prepared", recipients: [{ person_id: "leader-a", display_name: "Lee Fiction" }] });
});

test.each(["no grant", "no authority", "wrong ministry", "missing leader", "unknown authority", "qualified member exists"])("escalation %s stays unverified with no selected leader or generated text", variant => {
  const req = request();
  if (variant !== "qualified member exists") req.source.input.positions[0]!.candidates.forEach(c => { c.membership.value = false; });
  if (variant === "no grant") req.access.leader_ids = [];
  if (variant === "no authority") req.source.leaders[0]!.authority.value = false;
  if (variant === "wrong ministry") req.source.leaders[0]!.team_id = "other-team";
  if (variant === "missing leader") req.source.leaders = [];
  if (variant === "unknown authority") req.source.leaders[0]!.authority.value = null;
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "escalation", person_ids: ["leader-a"] };
  const result = reviewCoverageDraft(s, req);
  expect(result).toMatchObject({ status: "unverified", code: "leader-unverified" });
  s = state(result);
  expect(s.selection.person_ids).toEqual([]);
  expect(s.draft).toBeNull();
});

test.each([
  ["DST", "2026-11-01", "2026-11-01T01:30:00-04:00", "2026-11-01T01:30:00-05:00",
    "2026-11-01 01:30:00 GMT-04:00 – 2026-11-01 01:30:00 GMT-05:00 (America/New_York)"],
  ["overnight", "2026-11-22", "2026-11-21T23:30:00-05:00", "2026-11-22T00:30:00-05:00",
    "2026-11-21 23:30:00 GMT-05:00 – 2026-11-22 00:30:00 GMT-05:00 (America/New_York)"],
] as const)("%s draft formats both exact source instants without inferring time from Sunday", (_, sunday, starts_at, ends_at, formatted) => {
  const req = request();
  req.source.scope.sunday = req.access.scope.sunday = sunday;
  req.source.input.positions[0]!.interval = { starts_at, ends_at };
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(reviewCoverageDraft(s, req));
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  expect(s.draft!.original_facts.target.formatted_interval).toBe(formatted);
  expect(s.draft!.plaintext).toContain(`Serving interval: ${formatted}.`);
});

test.each(["adjacent before", "adjacent after", "declined", "cancelled"])("%s assignment does not become an overlap or subtract remaining need", variant => {
  const req = request();
  req.source.input.positions[0]!.candidates[1]!.assignments.value = [{ assignment_id: "other", status: variant === "declined" ? "D" : variant === "cancelled" ? "cancelled" : "C",
    notification: "sent", time_semantics: "verified", intervals: [{
      starts_at: variant === "adjacent before" ? "2026-11-22T13:30:00Z" : variant === "adjacent after" ? "2026-11-22T15:30:00Z" : "2026-11-22T15:00:00Z",
      ends_at: variant === "adjacent before" ? "2026-11-22T14:30:00Z" : "2026-11-22T16:30:00Z",
    }] }];
  const s = state(reviewCoverageDraft(null, req));
  expect(s.current.candidates[0]!.disposition).toBe("suggestion");
  expect(s.current.facts.target.remaining_need).toBe(1);
});


test("subsecond source instants remain exact in the outline and draft", () => {
  const req = request();
  req.source.input.positions[0]!.interval = { starts_at: "2026-11-22T14:30:00.123Z", ends_at: "2026-11-22T15:30:00.789Z" };
  const s = state(reviewCoverageDraft(null, req));
  expect(s.current.facts.target.formatted_interval).toBe("2026-11-22 09:30:00.123 GMT-05:00 – 2026-11-22 10:30:00.789 GMT-05:00 (America/New_York)");
});

test("equivalent instants, reordered evidence and unrelated outside assignments leave human text current", () => {
  const { req, s } = invitation(reviewCoverageDraft);
  req.source.input.positions[0]!.interval = { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z" };
  req.source.input.positions[0]!.candidates[1]!.assignments.value = [{ assignment_id: "other-day", status: "C", notification: "sent", time_semantics: "verified",
    intervals: [{ starts_at: "2026-11-23T15:00:00Z", ends_at: "2026-11-23T16:00:00Z" }] }];
  req.event = { type: "prepare-copy" };
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "copy-prepared", plaintext: "Verbatim human text\n  keep spacing  " });
});

test.each(["prepare", "edit", "review-changes"] as const)("%s cannot silently accept facts that changed after the displayed outline", type => {
  const { req, s } = invitation(reviewCoverageDraft);
  req.source.labels[0]!.role.value = "Changed while deciding";
  req.event = type === "edit" ? { type, plaintext: "Human text stays verbatim" } : { type };
  const result = reviewCoverageDraft(s, req);
  const next = state(result);
  expect(next.draft!.reviewed_facts.target.role).toBe("Welcome desk");
  expect(next.differences[0]).toMatchObject({ field: "target", before: { role: "Welcome desk" }, after: { role: "Changed while deciding" } });
  if (type === "edit") expect(next.draft!.plaintext).toBe("Human text stays verbatim");
  else expect(result).toMatchObject({ status: "unverified", code: "draft-stale" });
});

test("first preparation waits when source facts changed since explicit recipient selection", () => {
  const req = request();
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-a"] };
  s = state(reviewCoverageDraft(s, req));
  req.source.labels[0]!.role.value = "Changed before first preparation";
  req.event = { type: "prepare" };
  const result = reviewCoverageDraft(s, req);
  expect(result).toMatchObject({ status: "unverified", code: "draft-stale" });
  expect(state(result).draft).toBeNull();
});

test("missing source-backed role and unchecked label scope are concretely identified", () => {
  const req = request();
  req.source.labels = [];
  let s = state(reviewCoverageDraft(null, req));
  expect(s.current.evidence.issues.map(i => i.code)).toContain("labels-unverified");
  req.source.labels = [{ position_id: "position-a", ministry: { scope_id: "unread-label", value: "Ministry A" },
    role: { scope_id: "unread-label", value: "Welcome desk" } }];
  s = state(reviewCoverageDraft(null, req));
  expect(s.current.unchecked_scope_ids).toContain("unread-label");
  expect(s.current.verification).toBe("unverified");
});

test("UTC is a valid supplied church timezone without any caller time prose", () => {
  const req = request();
  req.source.church_timezone = "UTC";
  const s = state(reviewCoverageDraft(null, req));
  expect(s.current.facts.target.formatted_interval).toBe("2026-11-22 14:30:00 GMT+00:00 – 2026-11-22 15:30:00 GMT+00:00 (UTC)");
});

test("equal display names stay separate and stable by visible opaque identity, never merged or ranked", () => {
  const req = request();
  req.source.identities[0]!.display_name = req.source.identities[1]!.display_name = "Same Fictional Name";
  const s = state(reviewCoverageDraft(null, req));
  expect(s.current.candidates.map(c => [c.person_id, c.display_name])).toEqual([
    ["person-a", "Same Fictional Name"], ["person-b", "Same Fictional Name"],
  ]);
  req.event = { type: "select", purpose: "invitation", person_ids: ["person-b", "person-a"] };
  const selected = state(reviewCoverageDraft(s, req));
  expect(selected.current.facts.recipients.map(c => c.person_id)).toEqual(["person-a", "person-b"]);
});


test("leader permission or source authority lost after preparation prevents escalation copy", () => {
  const req = request();
  req.source.input.positions[0]!.candidates.forEach(c => { c.eligibility.value = false; });
  let s = state(reviewCoverageDraft(null, req));
  req.event = { type: "select", purpose: "escalation", person_ids: ["leader-a"] };
  s = state(reviewCoverageDraft(s, req));
  req.event = { type: "prepare" };
  s = state(reviewCoverageDraft(s, req));
  req.source.leaders[0]!.authority.value = false;
  req.event = { type: "prepare-copy" };
  const result = reviewCoverageDraft(s, req);
  expect(result).toMatchObject({ status: "unverified", code: "leader-unverified" });
  expect(state(result).current.facts.recipients[0]).toMatchObject({ disposition: "unverified", eligibility: false });
  req.source.leaders[0]!.authority.value = true;
  req.access.leader_ids = [];
  expect(reviewCoverageDraft(s, req)).toMatchObject({ status: "unverified", code: "leader-unverified" });
});
