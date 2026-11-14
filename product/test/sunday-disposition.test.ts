import { expect, test } from "vitest";
import { confirmSundayReview, createSundayReview, recordSundayDecision, sundayFindings, updateSundayOutline } from "../src/sunday-review.js";

test("a Sunday-only decision keeps the exact private note separate from the source need", () => {
  const checked = confirmSundayReview(createSundayReview());
  const nursery = sundayFindings(checked).find(f => f.ministry === "Nursery")!;
  const decided = recordSundayDecision(checked, nursery.id, "covered-outside-pco", "Sam is helping in the Nursery.");
  expect(sundayFindings(decided).find(f => f.id === nursery.id)).toMatchObject({
    status: "resolved-by-you", note: "Sam is helping in the Nursery.",
    title: "Nursery still needs one person",
  });
  expect(decided.result?.positions.find(p => p.team_id === "nursery")?.remaining_need).toBe(1);
  expect(sundayFindings(checked).find(f => f.id === nursery.id)?.note).toBeNull();
});

test("removing a Sunday lead requirement keeps the leader's note and the distinct rule-check label", () => {
  const checked = confirmSundayReview(createSundayReview());
  const lead = sundayFindings(checked).find(f => f.ministry === "Welcome Team")!;
  const decided = recordSundayDecision(checked, lead.id, "intentional-exception", "No separate lead is required this Sunday.");
  expect(decided.error).toBeNull();
  const outline = updateSundayOutline(decided, { welcomeLeadRequired: false });
  expect(sundayFindings(outline)).toEqual([]);
  const rechecked = confirmSundayReview(outline);
  expect(sundayFindings(rechecked).find(f => f.id === lead.id)).toMatchObject({
    status: "source-confirmed", label: "Role requirement checked",
    note: "No separate lead is required this Sunday.", canRecordDecision: false,
  });
});

test("a relevant fictional decline reopens the same Sunday item with concrete changed facts", () => {
  const checked = confirmSundayReview(createSundayReview());
  const nursery = sundayFindings(checked).find(f => f.ministry === "Nursery")!;
  const decided = recordSundayDecision(checked, nursery.id, "covered-outside-pco", "Sam is helping in the Nursery.");
  const unchanged = confirmSundayReview(decided);
  expect(sundayFindings(unchanged).find(f => f.id === nursery.id)?.status).toBe("resolved-by-you");
  const outline = updateSundayOutline(unchanged, { schedule: "decline" });
  expect(outline.result).toBeNull();
  const refreshed = confirmSundayReview(outline);
  expect(sundayFindings(refreshed).find(f => f.id === nursery.id)).toMatchObject({
    status: "attention", note: "Sam is helping in the Nursery.",
    title: "Nursery still needs 2 people", change: expect.stringContaining("1 to 2"),
  });
  expect(refreshed.result?.evaluated_at).toBe("2026-11-20T09:01:00Z");
  expect(sundayFindings(refreshed).find(f => f.id === nursery.id)?.change).toContain("confirmed to declined");
});

test("source-confirmed closure retains the exact earlier Sunday decision without claiming who filled it", () => {
  const checked = confirmSundayReview(createSundayReview());
  const nursery = sundayFindings(checked).find(f => f.ministry === "Nursery")!;
  const decided = recordSundayDecision(checked, nursery.id, "covered-outside-pco", "Sam is helping in the Nursery.");
  const filled = confirmSundayReview(updateSundayOutline(decided, { schedule: "filled" }));
  expect(sundayFindings(filled).find(f => f.id === nursery.id)).toMatchObject({
    status: "source-confirmed", label: "Source-confirmed", canRecordDecision: false,
    note: "Sam is helping in the Nursery.", checkTime: "2026-11-20T09:01:00Z",
    title: "Nursery's previous serving need is no longer open.",
  });
  expect(filled.result?.positions.find(p => p.team_id === "nursery")?.remaining_need).toBe(0);
});

test("a previously checked serving need stays inspectable when the source closes it without a manual note", () => {
  const checked = confirmSundayReview(updateSundayOutline(createSundayReview(), { ministryIds: ["nursery"] }));
  const nursery = sundayFindings(checked)[0]!;
  expect(nursery.note).toBeNull();
  const outline = updateSundayOutline(checked, { schedule: "filled" });
  expect(sundayFindings(outline)).toEqual([]);
  const filled = confirmSundayReview(outline);
  expect(sundayFindings(filled)).toEqual([expect.objectContaining({
    id: nursery.id, status: "source-confirmed", label: "Source-confirmed", note: null,
    canRecordDecision: false, checkTime: "2026-11-20T09:01:00Z",
    source: "Fictional Services fixture: Nursery",
    title: "Nursery's previous serving need is no longer open.",
  })]);
});

test("a source failure preserves the previous Sunday note and successful check time without confirming anything", () => {
  const checked = confirmSundayReview(createSundayReview());
  const nursery = sundayFindings(checked).find(f => f.ministry === "Nursery")!;
  const decided = recordSundayDecision(checked, nursery.id, "covered-outside-pco", "Sam is helping in the Nursery.");
  const denied = confirmSundayReview(updateSundayOutline(decided, { partialExample: true, partialMinistry: "nursery" }));
  expect(denied.result?.status).toBe("unverified");
  expect(sundayFindings(denied).find(f => f.ministry === "Nursery")).toMatchObject({
    status: "worth-a-look", label: "Worth a look", canRecordDecision: false,
    note: "Sam is helping in the Nursery.", title: "Nursery could not be checked",
    checkTime: "2026-11-20T09:01:00Z", lastSuccessfulCheckTime: "2026-11-20T09:00:00Z",
  });
  const recovered = confirmSundayReview(updateSundayOutline(denied, { partialExample: false }));
  expect(sundayFindings(recovered).find(f => f.id === nursery.id)).toMatchObject({
    status: "resolved-by-you", note: "Sam is helping in the Nursery.",
  });
});

test("excluding a ministry hides its note and re-including it preserves the same Sunday decision", () => {
  const checked = confirmSundayReview(createSundayReview());
  const nursery = sundayFindings(checked).find(f => f.ministry === "Nursery")!;
  const decided = recordSundayDecision(checked, nursery.id, "intentional-exception", "One spot is intentionally unfilled this Sunday.");
  const excluded = confirmSundayReview(updateSundayOutline(decided, { ministryIds: ["welcome", "lyrics"] }));
  expect(sundayFindings(excluded).some(f => f.note !== null)).toBe(false);
  expect(recordSundayDecision(excluded, nursery.id, "covered-outside-pco", "A different decision").error).toBeTruthy();
  const included = confirmSundayReview(updateSundayOutline(excluded, { ministryIds: ["nursery"] }));
  expect(sundayFindings(included)).toHaveLength(1);
  expect(sundayFindings(included)[0]).toMatchObject({
    id: nursery.id, status: "resolved-by-you", note: "One spot is intentionally unfilled this Sunday.",
  });
});

test("blank reasons and attempts to overwrite pending or source-confirmed facts are refused", () => {
  const checked = confirmSundayReview(createSundayReview());
  const nursery = sundayFindings(checked).find(f => f.ministry === "Nursery")!;
  expect(recordSundayDecision(checked, nursery.id, "intentional-exception", "   ").error).toContain("reason");
  expect(sundayFindings(checked).find(f => f.id === nursery.id)?.note).toBeNull();
  const pending = sundayFindings(checked).find(f => f.ministry === "Lyrics")!;
  expect(recordSundayDecision(checked, pending.id, "covered-outside-pco", "Not a serving gap").error).toBeTruthy();
  const decided = recordSundayDecision(checked, nursery.id, "covered-outside-pco", "Sam is helping.");
  const filled = confirmSundayReview(updateSundayOutline(decided, { schedule: "filled" }));
  expect(recordSundayDecision(filled, nursery.id, "intentional-exception", "Attempt to overwrite").error).toBeTruthy();
  expect(sundayFindings(filled).find(f => f.id === nursery.id)?.note).toBe("Sam is helping.");
});

test("source-time-only and repeated checks do not reopen or duplicate a Sunday decision", () => {
  const checked = confirmSundayReview(createSundayReview());
  const nursery = sundayFindings(checked).find(f => f.ministry === "Nursery")!;
  const decided = recordSundayDecision(checked, nursery.id, "covered-outside-pco", "Sam is helping.");
  // Partial mode stays off; moving its target only advances a designed snapshot clock.
  const timed = confirmSundayReview(updateSundayOutline(decided, { partialMinistry: "welcome" }));
  const repeated = confirmSundayReview(timed);
  expect(sundayFindings(repeated).filter(f => f.id === nursery.id)).toHaveLength(1);
  expect(sundayFindings(repeated).find(f => f.id === nursery.id)).toMatchObject({
    status: "resolved-by-you", note: "Sam is helping.", change: null, checkTime: "2026-11-20T09:01:00Z",
  });
  expect(repeated.decisions.nursery?.findings[0]?.history).toHaveLength(1);
});

test("unknown scenarios and out-of-bounds example clocks cannot produce a checked sheet", () => {
  const unknown = updateSundayOutline(createSundayReview(), { schedule: "invented" as "original" });
  for (const state of [unknown, { ...createSundayReview(), revision: -1 }, { ...createSundayReview(), revision: 21 }]) {
    const result = confirmSundayReview(state);
    expect(result.phase).toBe("outline"); expect(result.result).toBeNull(); expect(result.error).toBeTruthy();
  }
});
