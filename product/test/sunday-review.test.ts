import { expect, test } from "vitest";
import { confirmSundayReview, createSundayReview, sundayFindings, updateSundayOutline } from "../src/sunday-review.js";

test("the Sunday outline is reviewed before any fictional finding is produced", () => {
  const state = createSundayReview();
  expect(state.phase).toBe("outline");
  expect(state.result).toBeNull();
  const checked = confirmSundayReview(state);
  expect(checked.phase).toBe("review");
  expect(checked.result?.positions).toHaveLength(3);
});

test("the checked sheet separates one remaining request, a required lead and an unsent assignment", () => {
  const state = confirmSundayReview(createSundayReview());
  expect(state.result?.positions.find(p => p.team_id === "nursery")?.remaining_need).toBe(1);
  expect(sundayFindings(state).map(f => f.title)).toEqual([
    "Nursery still needs one person",
    "No Sunday lead assignment found for Welcome Team",
    "Lyrics has one unanswered assignment",
  ]);
  const lyrics = sundayFindings(state).find(f => f.ministry === "Lyrics")!;
  expect(lyrics.description).toContain("has not been sent");
  expect(lyrics.uncertain).toBe(false);
});

test("an unavailable scope stays uncertain while known findings remain visible", () => {
  const state = confirmSundayReview(updateSundayOutline(createSundayReview(), { partialExample: true }));
  expect(state.result?.status).toBe("unverified");
  const items = sundayFindings(state);
  expect(items.find(f => f.ministry === "Nursery")?.title).toBe("Nursery still needs one person");
  expect(items.find(f => f.ministry === "Lyrics")).toMatchObject({ uncertain: true, title: "Lyrics could not be checked" });
  expect(items.find(f => f.ministry === "Lyrics")?.description).not.toContain("0");
});

test("changing a rule or scope invalidates the sheet until the outline is confirmed again", () => {
  const checked = confirmSundayReview(createSundayReview());
  const changed = updateSundayOutline(checked, { welcomeLeadRequired: false, ministryIds: ["welcome"] });
  expect(changed.phase).toBe("outline"); expect(changed.result).toBeNull(); expect(sundayFindings(changed)).toEqual([]);
  const rechecked = confirmSundayReview(changed);
  expect(rechecked.result?.positions).toHaveLength(1);
  expect(rechecked.result?.status).toBe("checked-scope-clear");
  expect(sundayFindings(rechecked)).toEqual([]);
  expect(checked.result?.positions).toHaveLength(3);
});

test("empty, duplicate and unknown ministry selections cannot produce a checked result", () => {
  for (const ministryIds of [[], ["nursery", "nursery"], ["unknown"]]) {
    const changed = updateSundayOutline(createSundayReview(), { ministryIds: ministryIds as ReturnType<typeof createSundayReview>["outline"]["ministryIds"] });
    const state = confirmSundayReview(changed);
    expect(state.phase).toBe("outline"); expect(state.result).toBeNull(); expect(state.error).toBeTruthy();
  }
});

test("the same confirmed fictional outline yields the same source facts and check time", () => {
  const first = confirmSundayReview(createSundayReview());
  expect(confirmSundayReview(first).result).toEqual(first.result);
  expect(sundayFindings(first).every(f => f.checkTime === "2026-11-20T09:00:00Z" && f.source.startsWith("Fictional"))).toBe(true);
});
