import { describe, expect, it } from "vitest";
import { plainIssue, plainIssues, roleFacts } from "../src/coverage-words.js";

const issue = (code: string, message = "", position_id: string | null = "p1") => ({ code, message, position_id });

describe("the coverage engine's open questions, in plain words for Why I flagged this", () => {
  it("names the role and says what to do when a role has no service time", () => {
    expect(plainIssue(issue("time-unverified", "Some coverage couldn't be verified: required serving interval is missing or ambiguous."), "Greeter", "Planning Center"))
      .toBe("Greeter isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked.");
  });

  it("never shows the engine's own wording", () => {
    const engine = ["Some coverage couldn't be verified: required serving interval is missing or ambiguous.",
      "Remaining need couldn't be verified; no zero is inferred.", "Duplicate serving assignment identities couldn't be verified.",
      "Serving responses or time semantics couldn't be verified.", "Some coverage couldn't be verified: no positions were supplied.",
      "Some coverage couldn't be verified: missing, duplicate, incomplete or out-of-date scope."];
    const codes = ["time-unverified", "need-unverified", "assignment-unverified", "assignment-unverified", "positions-unverified", "scope-unverified"];
    for (const [i, message] of engine.entries()) {
      const line = plainIssue(issue(codes[i]!, message), "Vocals", "B1 Church");
      expect(line).not.toContain(message);
      expect(line).not.toMatch(/interval|semantics|identities|scope|inferred|supplied/u);
      expect(line).toMatch(/B1 Church/u);
    }
  });

  it("tells a repeated person apart from an unreadable answer", () => {
    expect(plainIssue(issue("assignment-unverified", "Duplicate serving assignment identities couldn't be verified."), "Usher", "Planning Center"))
      .toBe("Planning Center listed the same person on Usher more than once, so Ozzie couldn't count it.");
    expect(plainIssue(issue("assignment-unverified", "Serving responses or time semantics couldn't be verified."), "Usher", "Planning Center"))
      .toBe("Ozzie couldn't tell from Planning Center who said yes for Usher, or when they serve.");
  });

  it("says how many roles, and each reason, only when every question is a fact about a role (polish 2026-11-21, item 6)", () => {
    const roleOf = (id: string) => ({ p1: "Greeter", p2: "Lyrics" } as Record<string, string>)[id] ?? null;
    expect(roleFacts([issue("time-unverified"), issue("assignment-unverified", "Serving responses or time semantics couldn't be verified.")], roleOf, "Planning Center")).toEqual({
      roles: 1, reasons: [
        "Greeter isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked.",
        "Ozzie couldn't tell from Planning Center who said yes for Greeter, or when they serve.",
      ] });
    expect(roleFacts([issue("time-unverified"), issue("need-unverified", "", "p2")], roleOf, "Planning Center")?.roles).toBe(2);
    // A question about the check as a whole, or one that names no role, is never said as a role.
    expect(roleFacts([issue("time-unverified"), issue("scope-unverified", "", null)], roleOf, "Planning Center")).toBeNull();
    expect(roleFacts([issue("positions-unverified", "", null)], roleOf, "Planning Center")).toBeNull();
    expect(roleFacts([issue("need-unverified", "", null)], roleOf, "Planning Center")).toBeNull();
    expect(roleFacts([], roleOf, "Planning Center")).toBeNull();
  });

  it("works without a role name, and says each line once", () => {
    expect(plainIssue(issue("need-unverified", "", null), null, "Breeze")).toBe("Breeze didn't say how many people a role needs, so Ozzie doesn't count it as full.");
    expect(plainIssues([issue("scope-unverified"), issue("scope-unverified", "", "p2")], () => null, "Planning Center"))
      .toEqual(["Part of what Planning Center sent was missing, repeated or out of date, so Ozzie didn't rely on it."]);
  });
});
