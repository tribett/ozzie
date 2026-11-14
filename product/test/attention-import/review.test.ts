import { expect, test } from "vitest";
import { cancelAttentionReview, confirmAttentionReview, createAttentionReview, updateAttentionOutline } from "../../src/attention-import/review.js";

test("only confirming the reviewed outline prepares the exact primary fictional brief", () => {
  const state = createAttentionReview();
  expect(state).toMatchObject({ phase: "outline", result: null, generation: 0 });
  const checked = confirmAttentionReview(state, state.generation);
  expect(checked.phase).toBe("review");
  expect(checked.result).toMatchObject({ ok: true, imported_at: "2026-11-19T14:00:00Z",
    findings: [{ title: "Tonight's orientation needs a location decision.", source_ids: ["CAL-01", "MSG-01"] }] });
  expect(checked.result?.ok && checked.result.sources.map(s => s.id)).toEqual(["CAL-01", "CAL-02", "MSG-01", "MSG-02", "MSG-03", "MSG-04"]);
  expect(state.result).toBeNull();
});

test("every designed cancellation/coverage/time choice uses the same controller seam without hidden mail leaks", () => {
  for (const variant of ["room", "cancellation"]) {
    for (const coverage of ["complete", "calendar-denied", "mail-denied", "calendar-partial", "mail-partial", "stale"]) {
      for (const evaluation of ["original", "later"]) {
        const outline = updateAttentionOutline(createAttentionReview(), { variant, coverage, evaluation });
        const checked = confirmAttentionReview(outline, outline.generation);
        expect(checked.result?.ok).toBe(true);
        if (!checked.result?.ok) continue;
        expect(checked.result.imported_at).toBe("2026-11-19T14:00:00Z");
        expect(checked.result.findings).toHaveLength(coverage === "mail-denied" ? 0 : 1);
        if (coverage === "mail-denied") {
          expect(JSON.stringify(checked.result)).not.toContain("plumbing");
          expect(JSON.stringify(checked.result)).not.toContain("MSG-01");
        }
        if (evaluation === "later") expect(checked.result.stale).toBe(true);
        if (coverage === "complete" && evaluation === "original" && variant === "cancellation") {
          expect(checked.result.findings[0]!.statement).toBe("A message reports tonight's orientation cancelled; the calendar still shows it confirmed.");
        }
      }
    }
  }
});

test("changing each selection invalidates current facts and rejects an old confirmation", () => {
  const checked = confirmAttentionReview(createAttentionReview(), 0);
  for (const patch of [{ variant: "cancellation" }, { coverage: "calendar-denied" }, { evaluation: "later" }]) {
    const next = updateAttentionOutline(checked, patch);
    expect(next).toMatchObject({ phase: "outline", result: null, generation: 1 });
    expect(confirmAttentionReview(next, 0).result).toBeNull();
    expect(confirmAttentionReview(next, 1).result?.ok).toBe(true);
  }
  const cancelled = cancelAttentionReview(checked);
  expect(cancelled).toMatchObject({ phase: "cancelled", result: null, generation: 1 });
  expect(confirmAttentionReview(cancelled, 0)).toEqual(cancelled);
  expect(confirmAttentionReview(cancelled, 1)).toEqual(cancelled);
  const recheck = updateAttentionOutline(cancelled, {});
  expect(confirmAttentionReview(recheck, recheck.generation)).toMatchObject({ phase: "review" });
  expect(updateAttentionOutline(checked, { evaluation: "today" })).toMatchObject({
    result: null, phase: "outline", error: "Choose one of the prepared examples.",
  });
});
