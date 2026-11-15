import { describe, expect, it } from "vitest";
import { devKidsRules } from "../src/autopilot.js";
import { kidsTeams } from "../../../core/src/kids-rules.js";

describe("devKidsRules (debug autopilot only)", () => {
  it("leaves the saved rules alone without a value", () => {
    const rules = { kidsTeams: [{ team_id: "1", min_confirmed: 3 }] } as never;
    expect(devKidsRules(rules, undefined)).toBe(rules);
    expect(devKidsRules(rules, "")).toBe(rules);
  });
  it("marks the given teams as kids teams for the run", () => {
    expect(kidsTeams(devKidsRules({} as never, "7593352:2,6938634:1"))).toEqual([
      { team_id: "7593352", min_confirmed: 2 },
      { team_id: "6938634", min_confirmed: 1 },
    ]);
  });
});
