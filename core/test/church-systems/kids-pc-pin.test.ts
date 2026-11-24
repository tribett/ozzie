// Planning Center churches are byte-for-byte unchanged by the kids rule for B1 Church and Breeze (0.10.0): marks kept for
// a church on another system (SundayRules `systemKids`) change nothing Planning Center's check, Ask or the briefing says.
// Fictional data only.
import { describe, expect, it } from "vitest";
import { withSystemKids } from "../../src/church-systems/kids.js";
import { nov22Capture, TEAMS, withFictionalBackgroundChecks } from "../../src/fictional-sunday.js";
import { kidsAnswer, kidsQuestion } from "../../src/harness/compose.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools } from "../../src/harness/tools.js";
import { kidsFindings } from "../../src/kids-rules.js";
import { buildSpokenBriefing } from "../../src/spoken-briefing.js";
import { buildSundayBrief } from "../../src/sunday-brief.js";
import type { SundayRules } from "../../src/sunday-capture.js";
import { allEnvelopes, FRESH, harnessData, KIDS_RULES } from "../harness/fixtures.js";

/** The kids rules Planning Center's church set, plus marks for a B1 Church and a Breeze church kept on the same Mac. */
const withOthers = (rules: SundayRules): SundayRules =>
  withSystemKids(withSystemKids(rules, "b1:CHU0000cedar", "GRP-kids", 3, "Kids Ministry"), "breeze:juniperstreet", "nursery", 2, "Nursery");
const signal = new AbortController().signal;

describe("a Planning Center church, with kids marks kept for other systems' churches", () => {
  it("keeps its own kids teams exactly", () => {
    const rules = withOthers(KIDS_RULES);
    expect(rules.kidsTeams).toEqual(KIDS_RULES.kidsTeams);
    expect(rules.systemKids).toBeDefined();
  });

  it("builds exactly the same brief, kids findings and not-checked lines", () => {
    for (const capture of [nov22Capture(), withFictionalBackgroundChecks(nov22Capture())]) {
      expect(buildSundayBrief(capture, withOthers(KIDS_RULES), FRESH)).toEqual(buildSundayBrief(capture, KIDS_RULES, FRESH));
      expect(JSON.stringify(buildSundayBrief(capture, withOthers(KIDS_RULES), FRESH))).toBe(JSON.stringify(buildSundayBrief(capture, KIDS_RULES, FRESH)));
    }
    const ctx = { teamNames: new Map([[TEAMS.nursery, "Nursery"]]), sundayDate: "2026-11-22", zone: "America/New_York" };
    expect(kidsFindings(nov22Capture(), withOthers(KIDS_RULES), ctx)).toEqual(kidsFindings(nov22Capture(), KIDS_RULES, ctx));
  });

  it("gives Ask exactly the same tool results", async () => {
    const before = await allEnvelopes(harnessData({ mode: "live", rules: KIDS_RULES }));
    const after = await allEnvelopes(harnessData({ mode: "live", rules: withOthers(KIDS_RULES) }));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("answers kids questions on this Mac exactly as before", async () => {
    for (const typed of ["Is the nursery ready for Sunday?", "Are the kids teams covered?", "Any background check problems?", "Who could cover the nursery?"]) {
      const run = async (rules: SundayRules) => {
        const data = harnessData({ mode: "live", rules, capture: withFictionalBackgroundChecks(nov22Capture()) });
        const q = kidsQuestion(typed, data);
        if (!q) return null;
        const out = await kidsAnswer(new HarnessTools(data, new HarnessSession(), { now: () => FRESH }), q, signal);
        return { q, paragraphs: out.paragraphs, gaps: out.gaps, sources: out.sources, filled: out.paragraphs.map(out.fill) };
      };
      expect(await run(withOthers(KIDS_RULES)), typed).toEqual(await run(KIDS_RULES));
    }
  });

  it("reads its briefing exactly as before", () => {
    const brief = (rules: SundayRules) => buildSundayBrief(nov22Capture(), rules, FRESH);
    const said = (rules: SundayRules) => buildSpokenBriefing({ attention: null, sunday: brief(rules) }, { timeZone: "America/New_York" });
    expect(said(withOthers(KIDS_RULES))).toEqual(said(KIDS_RULES));
  });
});
