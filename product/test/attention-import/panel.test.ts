import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { AttentionPanel } from "../../web/src/attention/panel.js";
import { confirmAttentionReview, createAttentionReview } from "../../src/attention-import/review.js";
import { cancelAttentionReview, updateAttentionOutline } from "../../src/attention-import/review.js";
import { Workbench } from "../../web/src/workbench.js";

const render = (review = createAttentionReview()) => renderToStaticMarkup(createElement(AttentionPanel, { review, onChange: () => {} }));

test("the actual panel discloses the fictional import and fixed date before confirmation", () => {
  const html = render();
  expect(html).toContain("Fictional email/calendar import.");
  expect(html).toContain("No mail or calendar account is connected.");
  expect(html).toContain("Facts in this example were prepared for review.");
  expect(html).toContain("Prepare this example brief");
  expect(html).toContain("November 19, 2026");
  expect(html).toContain("Church office");
  expect(html).toContain("America/New_York");
  expect(html).not.toContain("Tonight&#x27;s orientation needs a location decision.");
});

test("denied/partial/stale/cancelled and changed outlines expose honest limits and hide invalidated facts", () => {
  for (const coverage of ["calendar-denied", "calendar-partial", "mail-denied", "mail-partial", "stale"]) {
    const outline = updateAttentionOutline(createAttentionReview(), { coverage });
    const html = render(confirmAttentionReview(outline, outline.generation));
    expect(html).toContain("Worth a look");
    expect(html).toContain("Missing coverage");
    expect(html).toContain("Other mail, calendars and church work were not checked.");
    if (coverage === "mail-denied") {
      expect(html).not.toContain("plumbing");
      expect(html).not.toContain("MSG-01");
      expect(html).not.toContain("password");
    }
  }
  const checked = confirmAttentionReview(createAttentionReview(), 0);
  const changed = updateAttentionOutline(checked, { variant: "cancellation" });
  expect(render(changed)).not.toContain("Tonight&#x27;s orientation needs a location decision.");
  expect(render(changed)).toContain("Prepare this example brief");
  const cancelled = render(cancelAttentionReview(checked));
  expect(cancelled).toContain("No account was read");
  expect(cancelled).not.toContain("Why I flagged this");
  expect(cancelled).toContain("Review this example again");
});

test("source markup and Markdown are literal text without active links or executable tags", () => {
  const state = confirmAttentionReview(createAttentionReview(), 0);
  if (!state.result?.ok) throw new Error("Prepared import failed");
  const message = state.result.sources.find(s => s.id === "MSG-02");
  if (!message || !("body" in message)) throw new Error("Missing prepared message");
  message.subject = "<img src=x onerror=alert(1)>";
  message.body = "<script>alert(1)</script> [follow](javascript:alert(1))";
  const html = render(state);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("&lt;img");
  expect(html).toContain("[follow](javascript:alert(1))");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
});

test("Workbench still defaults to the Sunday outline and offers the new navigation", () => {
  const html = renderToStaticMarkup(createElement(Workbench));
  expect(html).toContain("Sunday coverage");
  expect(html).toContain("Run the example check");
  expect(html).toContain("Attention brief");
  expect(html).not.toContain("Fictional email/calendar import.");
});

test("the confirmed actual panel shows literal paired sources and distinct source/import/evaluation times", () => {
  const html = render(confirmAttentionReview(createAttentionReview(), 0));
  expect(html).toContain("Tonight&#x27;s orientation needs a location decision.");
  expect(html).toContain("Why I flagged this");
  expect(html).toContain("MSG-01");
  expect(html).toContain("CAL-01");
  expect(html).toContain("2026-11-18T21:00:00Z");
  expect(html).toContain("2026-11-19T13:15:00Z");
  expect(html).toContain("Imported / checked");
  expect(html).toContain("Evaluated");
  expect(html).toContain("7:00");
  expect(html).toContain("According to the message");
});
