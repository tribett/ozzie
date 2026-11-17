// "Open in Planning Center" (audit item 25): the page sends only which page and a Planning Center id it already holds;
// native code builds the address (src-tauri/src/planning_center_pages.rs, with its own tests). Fictional data only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { NOT_OPENED, OPEN_PERSON, OPEN_PLAN, openInPlanningCenter } from "../src/planning-center-pages.js";
import { SundayPage } from "../src/sunday-page.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { text } from "./harness-fakes.js";

afterEach(() => invoke.mockClear());
const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const page = (b: SundayBrief, open: ((p: "plan" | "person", id: string) => Promise<boolean>) | null) => renderToStaticMarkup(React.createElement(SundayPage, {
  brief: b, names: nov22Capture().names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
  decisions: [], onDecisions: () => {}, operations: null, onCheck: () => {}, onRecording: () => {}, onExample: () => {}, openInPlanningCenter: open,
}));

describe("opening a Planning Center page", () => {
  it("sends the kind of page and a digits-only id, nothing else", async () => {
    expect(await openInPlanningCenter("plan", "92902197")).toBe(true);
    expect(await openInPlanningCenter("person", "511")).toBe(true);
    expect(invoke.mock.calls).toEqual([["open_in_planning_center", { page: "plan", id: "92902197" }], ["open_in_planning_center", { page: "person", id: "511" }]]);
  });

  it("never sends anything that isn't a Planning Center id, and says false when the browser didn't open", async () => {
    for (const odd of ["", "0511", "Riley Thornbury", "riley@example.org", "511/edit", "https://example.org", " 511"]) expect(await openInPlanningCenter("person", odd)).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockRejectedValueOnce("not-opened");
    expect(await openInPlanningCenter("plan", "92902197")).toBe(false);
    expect(NOT_OPENED).toBe("Planning Center couldn't be opened in your browser just now.");
  });

  it("is on each Sunday card beside where the facts came from, and on each person row, for a real check only", () => {
    const live: SundayBrief = { ...buildSundayBrief(nov22Capture(), rules, nov22Capture().completed_at), mode: "live" };
    const html = page(live, async () => true);
    const t = text(html);
    // Under the card's More choices since audit item 29, before where the facts came from.
    expect(t).toMatch(/More choices [^]*?Open the plan in Planning Center Why I flagged this Planning Center Checked /u);
    expect((t.match(new RegExp(OPEN_PLAN, "gu")) ?? []).length).toBeGreaterThanOrEqual(3);
    const names = nov22Capture().names;
    expect(html).toContain(`aria-label="Open ${names["511"]} in Planning Center">${OPEN_PERSON}</button>`);
    // Read-only words: it opens a page, it changes nothing.
    expect(t).not.toMatch(/\b(?:schedule (?:them|her|him)|add (?:them|to the plan)|send the request)\b/iu);
    // The fictional example's people aren't in Planning Center: no buttons at all.
    const example = page(buildSundayBrief(nov22Capture(), rules, nov22Capture().completed_at, true), async () => true);
    expect(example).not.toContain(OPEN_PLAN);
    expect(example).not.toContain(`>${OPEN_PERSON}<`);
    // Without the opener (the page as tests render it elsewhere), none either.
    expect(page(live, null)).not.toContain(OPEN_PLAN);
  });
});
