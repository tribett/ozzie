import { describe, expect, it } from "vitest";
import { composeBrief, type BriefScopeCheck, type Finding } from "../src/brief.js";

const finding = (over: Partial<Finding>): Finding => ({
  fact: "Nursery still needs one person.",
  why_now: "Sunday is in 2 days.",
  rule: "Two adults in every kids room (your church rule)",
  source: "Planning Center Services",
  check_time: "2026-11-20T09:00:00Z",
  group: "attention",
  uncertain: false,
  ...over,
});

const scopeCheck = (over: Partial<BriefScopeCheck> = {}): BriefScopeCheck => ({
  scope: "Nursery",
  source: "Planning Center Services",
  check_time: "2026-11-20T09:00:00Z",
  completeness: "complete",
  ...over,
});

describe("composeBrief", () => {
  it("does not turn an empty partial check into an all-clear", () => {
    const brief = composeBrief([], "Sunday, November 22", [{
      scope: "Nursery",
      source: "Planning Center Services",
      check_time: "2026-11-20T09:00:00Z",
      completeness: "partial",
    }]);
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("Some checks couldn't be verified");
    expect(brief).toContain("Nursery");
  });

  it("does not confirm a complete check without its check time", () => {
    const brief = composeBrief([], "Sunday", [{
      scope: "Nursery",
      source: "Planning Center Services",
      check_time: "",
      completeness: "complete",
    }]);
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("Not verified");
    expect(brief).toContain("Check time unavailable");
  });

  it("does not let a rolled-over February date confirm a checked scope", () => {
    const brief = composeBrief([], "Sunday", [scopeCheck({ check_time: "2026-02-30T09:00:00Z" })]);
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("Not verified");
    expect(brief).toContain("Check time unavailable");
  });

  it.each([
    "2026-04-31T09:00:00Z",
    "2026-02-29T09:00:00-05:00",
    "1900-02-29T09:00:00Z",
    "2026-00-20T09:00:00Z",
    "2026-11-00T09:00:00Z",
    "2026-11-20T24:00:00Z",
    "2026-11-20T09:60:00Z",
    "2026-11-20T09:00:00+99:00",
  ])("keeps impossible date or time evidence unverified: %s", (check_time) => {
    const brief = composeBrief([], "Sunday", [scopeCheck({ check_time })]);
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("Check time unavailable");
  });

  it.each([
    "2024-02-29T09:00:00Z",
    "2000-02-29T09:00:00Z",
    "2026-11-20T23:30:00-05:00",
    "2026-11-20T00:30:00+05:30",
    "2026-11-20T09:00:00.123Z",
  ])("preserves valid calendar dates and explicit offsets: %s", (check_time) => {
    const brief = composeBrief([], "Sunday", [scopeCheck({ check_time })]);
    expect(brief).toContain("Nothing needs your attention within the checked scope: Nursery");
    expect(brief).toContain(`checked ${check_time}`);
  });

  it.each(["partial", "stale", "denied", "unverified"] as const)("keeps an empty %s check visibly unverified", (completeness) => {
    const brief = composeBrief([], "Sunday", [scopeCheck({ completeness })]);
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("Some checks couldn't be verified");
    expect(brief).toContain("Nursery");
  });

  it("never infers that an empty result means any scope was checked", () => {
    const brief = composeBrief([], "Sunday");
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("No scope check evidence was supplied");
  });

  it("preserves a checked finding alongside the scope that could not be read", () => {
    const brief = composeBrief([finding({})], "Sunday", [
      scopeCheck(),
      scopeCheck({ scope: "Welcome Team", completeness: "denied" }),
    ]);
    expect(brief).toContain("Nursery still needs one person");
    expect(brief).toContain("Welcome Team: Access unavailable");
    expect(brief).toContain("Some checks couldn't be verified");
    expect(brief).not.toContain("Nothing needs your attention");
  });

  it.each([
    { scope: "" },
    { source: "" },
    { check_time: "not-a-time" },
    { check_time: "2026-11-20" },
  ])("does not confirm a nominally complete scope with missing or invalid evidence: %j", (missing) => {
    const brief = composeBrief([], "Sunday", [scopeCheck(missing)]);
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("Not verified");
  });

  it("cannot let a complete scope hide an empty incomplete scope", () => {
    const brief = composeBrief([], "Sunday", [
      scopeCheck(),
      scopeCheck({ scope: "Welcome Team", completeness: "partial" }),
    ]);
    expect(brief).not.toContain("Nothing needs your attention");
    expect(brief).toContain("Welcome Team: Only part of this scope was checked");
  });

  it("groups findings, keeps source and check time on every one", () => {
    const brief = composeBrief([finding({}), finding({ fact: "Lyrics has a pending assignment.", group: "review" })], "Sunday, November 22");
    expect(brief).toContain("Needs your attention (1)");
    expect(brief).toContain("Ready to review (1)");
    expect(brief).toContain("Planning Center Services · checked 2026-11-20T09:00:00Z");
    expect(brief).toContain("Why I flagged this: Two adults in every kids room");
  });

  it("counts items, never people, and labels uncertainty Worth a look", () => {
    const brief = composeBrief([finding({ uncertain: true, fact: "A room booking may overlap." })], "Sunday");
    expect(brief).toContain("Worth a look: A room booking may overlap.");
    expect(brief).not.toMatch(/\d+ (people|volunteers) (need|still)/);
  });

  it("an empty checked scope says so plainly, with its scope named", () => {
    const brief = composeBrief([], "Sunday, November 22", [{
      scope: "Nursery and Welcome teams",
      source: "Planning Center Services",
      check_time: "2026-11-20T09:00:00Z",
      completeness: "complete",
    }]);
    expect(brief).toContain("Nothing needs your attention");
    expect(brief).toContain("Nursery and Welcome teams");
  });

  it("never claims anything was sent or confirmed in Planning Center", () => {
    const brief = composeBrief([finding({})], "Sunday");
    expect(brief).not.toContain("It was sent");
    expect(brief).not.toContain("Message sent");
    expect(brief).toContain("Nothing has been sent");
  });
});
