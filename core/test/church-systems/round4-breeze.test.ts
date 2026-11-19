// Round 4, live on Breeze (the test church "Perlandera"): every check said "Part of this Sunday couldn't be checked"
// without saying which part, an event with no time of day showed as 12:00 AM, and who said yes or no was nowhere.
import { describe, expect, it } from "vitest";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { systemCaptureToCoverage } from "../../src/church-systems/coverage.js";
import { cannotSee, numbersNotShared } from "../../src/church-systems/facts.js";
import { untimed } from "../../src/church-systems/types.js";
import { buildSpokenBriefing } from "../../src/spoken-briefing.js";
import { serviceOn } from "../../src/draft-request.js";
import { b1Capture, breezeUntimedCapture, NOW } from "./fixtures.js";

const built = (capture = breezeUntimedCapture()) => {
  const b = buildSystemBrief(capture, {}, NOW);
  if (!b.ok) throw new Error(b.reason);
  return b.brief;
};

describe("a Breeze service whose roles have no number needed", () => {
  it("isn't partial: Breeze doesn't share the number, so it is said once and the check is otherwise whole", () => {
    const b = built();
    expect(b.findings.some(f => f.kind === "worth-a-look")).toBe(false);
    expect(b.sources.failed).toEqual([]);
    const said = numbersNotShared("breeze", null);
    expect(said).toBe("Breeze doesn't share how many people each role needs, so Ozzie can't say whether a role is full. It shows who is on each one instead.");
    expect(b.not_checked.filter(l => l === said)).toHaveLength(1);
    expect(b.not_checked[0]).toBe(said);
    // The engine still never calls it covered.
    expect(b.status).toBe("unverified");
  });

  it("lists who is on each role, said yes, hasn't answered or said no, and who is on the service with no role", () => {
    expect(built().roster).toEqual({
      roles: [
        { position_id: "R1", team_id: null, name: "Greeter", needed: null, yes: [], waiting: ["P-wren"], declined: [], unknown: [] },
        { position_id: "R2", team_id: null, name: "Usher", needed: null, yes: ["P-sam"], waiting: [], declined: ["P-lee"], unknown: [] },
        { position_id: "R3", team_id: null, name: "Sound", needed: null, yes: ["P-ivy"], waiting: [], declined: [], unknown: [] },
      ],
      no_role: ["P-kit"],
    });
  });

  it("still says a read that truly failed, by its part", () => {
    const b = built(breezeUntimedCapture({ reads: breezeUntimedCapture().reads.map(r => r.read === "breeze.volunteers" ? { ...r, outcome: "timeout" } : r) }));
    expect(b.findings.some(f => f.kind === "worth-a-look")).toBe(true);
    expect(b.not_checked).toContain("Who is scheduled: took too long. Check Breeze again in a moment.");
    // Who is on each role is never said from answers not read whole.
    expect(b.roster).toBeUndefined();
  });

  it("lists only what bears on the service under What I didn't check, never tags, forms or head counts", () => {
    const b = built();
    expect(b.not_checked).toEqual(expect.arrayContaining([...cannotSee("breeze", "service")]));
    for (const line of b.not_checked) expect(line).not.toMatch(/tag|form entries|head count/u);
  });
});

describe("a Breeze event with no time of day", () => {
  it("is known by Breeze's midnight with the church's offset, never a UTC midnight", () => {
    expect(untimed("2026-11-22T00:00:00-06:00")).toBe(true);
    expect(untimed("2026-11-22T00:00:00.000+13:00")).toBe(true);
    expect(untimed("2026-11-22T00:00:00Z")).toBe(false);
    expect(untimed("2026-11-22T09:35:00-06:00")).toBe(false);
    expect(untimed("2026-11-22T00:00:30-06:00")).toBe(false);
    expect(untimed("2026-02-30T00:00:00-06:00")).toBe(false);
  });

  it("names its day only: no finding or plan carries 12:00 AM", () => {
    const b = built();
    expect(b.plan.starts_at).toBeNull();
    expect(b.plan.dates).toBe("Sunday, November 22");
    const pending = b.findings.find(f => f.kind === "pending")!;
    expect(pending.position?.interval).toBeNull();
    expect(JSON.stringify(b.findings)).not.toMatch(/T00:00:00/u);
  });

  it("is checked over its whole day when Breeze gives it no end, so nothing is unverified for want of a time", () => {
    const capture = breezeUntimedCapture({ service: { ...breezeUntimedCapture().service!, ends_at: null } });
    const mapped = systemCaptureToCoverage(capture, { sundayLeads: [] }, NOW);
    if (!mapped.ok) throw new Error(mapped.reason);
    expect(mapped.input.positions[0]!.interval).toEqual({ starts_at: "2026-11-22T00:00:00-06:00", ends_at: "2026-11-23T06:00:00.000Z" });
    expect(built(capture).findings.some(f => f.kind === "worth-a-look")).toBe(false);
    // A timed service with no end stays unverified, as before.
    const timed = breezeUntimedCapture({ service: { ...breezeUntimedCapture().service!, starts_at: "2026-11-22T09:35:00-06:00", ends_at: null } });
    expect(built(timed).findings.some(f => f.kind === "worth-a-look")).toBe(true);
  });
});

describe("everything else a Breeze church hears or sends about that service", () => {
  it("the spoken briefing says what Breeze doesn't share, and no time of day", () => {
    const b = built();
    const spoken = buildSpokenBriefing({ attention: null, sunday: b }, { timeZone: "America/Chicago" }).text;
    expect(spoken).not.toMatch(/12:00\s?AM|midnight/u);
    expect(spoken).toContain("Breeze doesn't share how many people each role needs");
    expect(spoken).not.toMatch(/couldn't be checked/u);
  });

  it("a note from the pending card names the service's day, never 12:00 AM", () => {
    const b = built();
    const pending = b.findings.find(f => f.kind === "pending")!;
    expect(serviceOn(pending, b.plan.date)).toBe("on Sunday, November 22");
  });
});

describe("review of round 4", () => {
  it("only Breeze's midnight means no time of day: another system's midnight is a real time (L1)", () => {
    const b1 = b1Capture({ service: { ...b1Capture().service!, starts_at: "2026-11-22T00:00:00-06:00", ends_at: "2026-11-22T01:30:00-06:00" } });
    const b = buildSystemBrief(b1, { confirmedZone: "America/Chicago" }, NOW);
    if (!b.ok) throw new Error(b.reason);
    expect(b.brief.plan.starts_at).toBe("2026-11-22T00:00:00-06:00");
  });

  it("a whole day ends at the church's next midnight, on a clock-change day too (L2)", () => {
    // November 1, 2026: clocks go back in Chicago, so that day is 25 hours long.
    const capture = breezeUntimedCapture({ service: { id: "90001", day: "2026-11-01", starts_at: "2026-11-01T00:00:00-05:00", ends_at: null, shared: null } });
    const mapped = systemCaptureToCoverage(capture, { sundayLeads: [] }, "2026-10-30T15:00:00Z");
    if (!mapped.ok) throw new Error(mapped.reason);
    expect(Date.parse(mapped.input.positions[0]!.interval!.ends_at)).toBe(Date.parse("2026-11-02T06:00:00Z"));
  });

  it("What I didn't check lists the service lines by what they are about (L6)", () => {
    // What a pastor acts on, visible; the rare or technical ones folded under "More that Ozzie can't see" (round 5).
    expect(cannotSee("breeze", "service")).toEqual([
      "Ozzie can't see roles or volunteers on Breeze's newer scheduling page: Breeze only shares what's on its older Volunteers page.",
      "Ozzie can't tell from Breeze whether a volunteer who hasn't answered was sent the request: Breeze shows them only as no response.",
      "Ozzie can't read blockout dates from Breeze.",
      "Ozzie can't suggest who could help from Breeze: it doesn't tie a team to each role.",
      "Ozzie doesn't read background checks from Breeze.",
    ]);
    expect(cannotSee("breeze", "service-more")).toEqual([
      "Ozzie can't place a Breeze time in an hour the clocks skip or repeat, so it can't check a service that starts in one.",
      "Ozzie can't see a change to a Breeze service's time or name until Breeze shares it, which can take up to 15 minutes.",
    ]);
    expect(cannotSee("b1", "service")).toHaveLength(2);
    expect(cannotSee("b1", "service-more")).toHaveLength(4);
    for (const line of [...cannotSee("b1", "service"), ...cannotSee("b1", "service-more")]) expect(line).not.toMatch(/attendance|form|events/u);
  });
});

describe("round 5: never \"nothing needs a decision\" where Breeze can't say", () => {
  it("the spoken briefing says who is listed, what needs a look, and that Ozzie can't say it is covered", () => {
    const b = built(breezeUntimedCapture({ assignments: breezeUntimedCapture().assignments.filter(a => a.id !== "V2") }));
    const spoken = buildSpokenBriefing({ attention: null, sunday: b }, { timeZone: "America/Chicago" });
    expect(spoken.text).not.toMatch(/Nothing Ozzie read needs (?:a decision|you)/u);
    expect(spoken.sections[0]!.sentences[0]).toBe("Here is today's briefing. Ozzie can't say whether Sunday is covered, and 2 are worth a look.");
    expect(spoken.text).toContain("For Sunday, 3 people are listed: 1 said yes, 1 hasn't answered, 1 said no. Breeze doesn't share how many people each role needs, so Ozzie can't say whether Sunday is covered.");
    // Usher: the one who said no, with nobody in their place; said with no name.
    expect(spoken.text).toContain("Nobody on Usher has said yes: one person said no.");
  });
});
