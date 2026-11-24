// Kids teams on B1 Church and kids roles on Breeze: the Church rule Planning Center churches have ("at least N confirmed
// people at each service time"), from the roles and answers each check already reads. Fictional data only.
import { describe, expect, it } from "vitest";
import { buildSystemBrief, type SystemBriefRules } from "../../src/church-systems/brief.js";
import { recordSystemCheck } from "../../src/church-systems/changes.js";
import { cannotSee } from "../../src/church-systems/facts.js";
import {
  kidsChoices, kidsMarked, kidsTeamId, kidsUncounted, roleKey, systemKidsFindings, systemKidsMarks, withSystemKids,
} from "../../src/church-systems/kids.js";
import { placeholderScope } from "../../src/church-systems/placeholders.js";
import type { SystemCapture } from "../../src/church-systems/types.js";
import { briefTarget } from "../../src/finding-feedback.js";
import { KIDS_MAX_TEAMS } from "../../src/kids-rules.js";
import { sundayShownCount } from "../../src/sunday-brief.js";
import type { SundayRules } from "../../src/sunday-capture.js";
import { applyDecisions } from "../../src/sunday-decisions.js";
import { SUNDAY_WORDS } from "../../src/service-day.js";
import { b1KidsCapture, breezeKidsCapture, breezeUntimedCapture, NOW } from "./fixtures.js";

const NONE: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const B1 = "b1:CHU0000cedar", BREEZE = "breeze:juniperstreet";

const b1Kids = b1KidsCapture, breezeKids = breezeKidsCapture;
const marked = (church: string, id: string, min: number, name?: string) => withSystemKids(NONE, church, id, min, name);
function brief(capture: SystemCapture, rules: { systemKids?: SundayRules["systemKids"] } = {}) {
  const own: SystemBriefRules = { confirmedZone: capture.church.time_zone, ...(rules.systemKids ? { systemKids: rules.systemKids } : {}) };
  const built = buildSystemBrief(capture, own, NOW);
  if (!built.ok) throw new Error(built.reason);
  return built.brief;
}
const kidsOf = (capture: SystemCapture, rules: SundayRules) => brief(capture, { systemKids: rules.systemKids }).findings.filter(f => f.kind === "too-few-confirmed");

describe("marking a kids team (B1 Church) or role (Breeze)", () => {
  it("keeps marks per church, by B1's own group id or Breeze's role name, and never touches Planning Center's kids teams", () => {
    const pc: SundayRules = { ...NONE, kidsTeams: [{ team_id: "101", min_confirmed: 2, name: "Nursery" }] };
    const one = withSystemKids(pc, B1, "GRP-kids", 3, "Kids Ministry");
    expect(one.kidsTeams).toEqual(pc.kidsTeams);
    expect(systemKidsMarks(one, B1)).toEqual([{ id: "GRP-kids", min_confirmed: 3, name: "Kids Ministry" }]);
    // Another church on the same system, and Breeze, have none.
    expect(systemKidsMarks(one, "b1:CHU0000other")).toEqual([]);
    expect(systemKidsMarks(one, BREEZE)).toEqual([]);
    const both = withSystemKids(one, BREEZE, roleKey(" Nursery  Room "), 2, "Nursery Room");
    expect(systemKidsMarks(both, BREEZE)).toEqual([{ id: "nursery room", min_confirmed: 2, name: "Nursery Room" }]);
    expect(systemKidsMarks(both, B1)).toHaveLength(1);
    // Unmarking the last one leaves nothing behind for that church.
    const off = withSystemKids(both, B1, "GRP-kids", null);
    expect(off.systemKids).toEqual({ [BREEZE]: [{ id: "nursery room", min_confirmed: 2, name: "Nursery Room" }] });
    expect(withSystemKids(off, BREEZE, "nursery room", null)).toEqual(pc);
  });

  it("clamps the count to 1–10, refuses ids a system can't hold, Genesis and an eleventh mark", () => {
    expect(systemKidsMarks(marked(B1, "GRP-kids", 0), B1)[0]!.min_confirmed).toBe(1);
    expect(systemKidsMarks(marked(B1, "GRP-kids", 40), B1)[0]!.min_confirmed).toBe(10);
    expect(marked(B1, "not an id!", 2)).toEqual(NONE);
    expect(marked(BREEZE, "Nursery", 2)).toEqual(NONE);
    expect(marked("genesis:ORG-maple", "G1", 2)).toEqual(NONE);
    let rules = NONE;
    for (let i = 0; i < KIDS_MAX_TEAMS + 1; i++) rules = withSystemKids(rules, B1, `GRP-${i}`, 2);
    expect(systemKidsMarks(rules, B1)).toHaveLength(KIDS_MAX_TEAMS);
    // Stored entries that aren't valid are ignored, never trusted.
    const odd = { ...NONE, systemKids: { [B1]: [{ id: "GRP-kids", min_confirmed: 2.5 }, { id: "GRP-x", min_confirmed: 2 }, { id: "GRP-x", min_confirmed: 3 }] } } as SundayRules;
    expect(systemKidsMarks(odd, B1)).toEqual([{ id: "GRP-x", min_confirmed: 2 }]);
  });

  it("offers B1 Church's teams by B1's own group name, and Breeze's roles by name", () => {
    expect(kidsChoices(b1Kids())).toEqual([
      { id: "GRP-worship", name: "Worship", roles: ["Vocals", "Guitar"] },
      { id: "GRP-hosp", name: "Hospitality", roles: ["Greeter"] },
      { id: "GRP-kids", name: "Kids Ministry", roles: ["Nursery", "Preschool"] },
    ]);
    // A team B1 didn't name is named by its roles, as Planning Center's teams are.
    const unnamed = b1Kids({ labels: Object.fromEntries(Object.entries(b1Kids().labels).filter(([k]) => k !== "team:GRP-kids")) });
    expect(kidsChoices(unnamed).at(-1)).toEqual({ id: "GRP-kids", name: "Nursery, Preschool", roles: ["Nursery", "Preschool"] });
    expect(kidsChoices(breezeKids())).toEqual([
      { id: "teacher", name: "Teacher", roles: ["Teacher"] }, { id: "usher", name: "Usher", roles: ["Usher"] }, { id: "nursery", name: "Nursery", roles: ["Nursery"] },
    ]);
  });
});

describe("B1 Church: kids teams", () => {
  it("flags a team with fewer people who accepted than the rule asks, in B1 Church's own words", () => {
    const [f, ...more] = kidsOf(b1Kids(), marked(B1, "GRP-kids", 2, "Kids Ministry"));
    expect(more).toEqual([]);
    expect(f).toMatchObject({
      id: "kids:GRP-kids:service", kind: "too-few-confirmed", tone: "decision", source: "B1 Church",
      position: { id: "kids:GRP-kids", team_id: "GRP-kids", name: "Kids Ministry", interval: null },
      needed: 2, confirmed: ["PER-ivy"], asked: ["PER-moss"], not_sent: ["PER-fern"],
    });
    expect(f!.waiting).toBeUndefined();
    expect(f!.why).toEqual([
      "Your Church rules ask for at least 2 confirmed people on this kids team at each service.",
      // B1 doesn't say which time each person serves (privacy review L4), as the Church rules page says.
      "B1 Church doesn't say which of a plan's service times each person serves, so Ozzie counts everyone who accepted across the service.",
      "B1 Church shows 1 person who accepted for this Sunday, and Ozzie counts accepted as confirmed.",
      "Not answered yet isn't counted as confirmed: 1 asked with no answer yet, 1 not sent yet.",
      "Ozzie counts confirmed people on the team; it doesn't check ages.",
    ]);
    expect(JSON.stringify(f)).not.toMatch(/Planning Center|Fictional/u);
  });

  it("says nothing when enough accepted, counting someone on two of the team's roles once", () => {
    expect(kidsOf(b1Kids(), marked(B1, "GRP-kids", 1))).toEqual([]);
    const two = b1Kids({ assignments: b1Kids().assignments.map(a => a.id === "ASN-moss" ? { ...a, status: "accepted" as const } : a) });
    expect(kidsOf(two, marked(B1, "GRP-kids", 2))).toEqual([]);
    // Ivy on Nursery and Preschool is one person.
    expect(kidsOf(b1Kids(), marked(B1, "GRP-kids", 2))[0]!.confirmed).toEqual(["PER-ivy"]);
  });

  it("says nothing at all when no team is marked, and the brief is exactly as before", () => {
    const before = brief(b1Kids());
    expect(brief(b1Kids(), { systemKids: {} })).toEqual(before);
    expect(brief(b1Kids(), { systemKids: marked(BREEZE, "nursery", 2).systemKids })).toEqual(before);
    expect(brief(b1Kids(), { systemKids: marked("b1:CHU0000other", "GRP-kids", 2).systemKids })).toEqual(before);
  });

  it("an answer Ozzie couldn't read is uncertain: Worth a look, never confirmed", () => {
    const capture = b1Kids({ assignments: b1Kids().assignments.map(a => a.id === "ASN-moss" ? { ...a, status: "unknown" as const } : a) });
    const [f] = kidsOf(capture, marked(B1, "GRP-kids", 2));
    expect(f).toMatchObject({ tone: "look", confirmed: ["PER-ivy"], asked: [], not_sent: ["PER-fern"] });
    expect(f!.why).toContain("B1 Church gave an answer Ozzie couldn't read for 1 person on this team, so Ozzie can't count them.");
    // Short by more than the unreadable answers could make up: a decision.
    expect(kidsOf(capture, marked(B1, "GRP-kids", 3))[0]!.tone).toBe("decision");
  });

  it("says plainly when who is scheduled didn't fully load, and flags nothing from it", () => {
    for (const read of ["b1.assignments", "b1.positions"]) {
      const capture = b1Kids({ reads: b1Kids().reads.map(r => r.read === read ? { ...r, outcome: "truncated" as const } : r) });
      const b = brief(capture, { systemKids: marked(B1, "GRP-kids", 2).systemKids });
      expect(b.findings.filter(f => f.kind === "too-few-confirmed")).toEqual([]);
      expect(b.not_checked).toContain(kidsUncounted("team"));
      expect(kidsUncounted("team")).toBe("Kids team counts weren't checked, because who is scheduled didn't fully load.");
    }
  });

  it("says a marked team that isn't on this plan wasn't counted", () => {
    const b = brief(b1Kids(), { systemKids: withSystemKids(marked(B1, "GRP-kids", 1), B1, "GRP-youth", 2, "Youth").systemKids });
    expect(b.findings.filter(f => f.kind === "too-few-confirmed")).toEqual([]);
    expect(b.not_checked).toContain("1 kids team isn't on this Sunday's plan in B1 Church, so it wasn't counted.");
  });

  it("holds the rule back with the rest of the check while the church's time zone waits to be confirmed", () => {
    const built = buildSystemBrief(b1Kids(), { systemKids: marked(B1, "GRP-kids", 2).systemKids! }, NOW);
    if (!built.ok) throw new Error(built.reason);
    expect(built.coverage.waiting_for_zone).toBe(true);
    expect(built.brief.findings.map(f => f.kind)).toEqual(["worth-a-look"]);
    expect(built.brief.not_checked.join(" ")).not.toMatch(/[Kk]ids/u);
  });

  it("says background checks aren't read from B1 Church, and reads nothing new", () => {
    const b = brief(b1Kids(), { systemKids: marked(B1, "GRP-kids", 2).systemKids });
    expect(b.not_checked).toContain(cannotSee("b1").find(l => /background checks/u.test(l)));
    expect(b.findings.some(f => f.kind === "background-check")).toBe(false);
    // The same reads as without the rule: the rule reads what every check already holds.
    expect(b.sources).toEqual(brief(b1Kids()).sources);
  });

  it("counts as a decision on the service's page, beside the rest", () => {
    const without = brief(b1Kids()), withKids = brief(b1Kids(), { systemKids: marked(B1, "GRP-kids", 2).systemKids });
    const count = (b: typeof without) => sundayShownCount(applyDecisions(b, []), null);
    expect(count(withKids)).toEqual({ ...count(without), decisions: count(without).decisions + 1 });
    // What needs a decision comes first.
    expect(withKids.findings.findIndex(f => f.kind === "too-few-confirmed")).toBeLessThan(withKids.findings.findIndex(f => f.tone === "look"));
    // The comparison record counts it with the other decisions, so the schedule tells it like Planning Center's.
    expect(recordSystemCheck(b1Kids(), withKids).decisions).toBe(recordSystemCheck(b1Kids(), without).decisions + 1);
  });

  it("is never stopped from a card, and a correction stops hiding it once who is pending changes", () => {
    const f = kidsOf(b1Kids(), marked(B1, "GRP-kids", 2))[0]!;
    const target = briefTarget(f, "PLA0000nov22");
    expect(target.scope).toEqual({ team_id: "GRP-kids", position: "Kids Ministry" });
    const later = kidsOf(b1Kids({ assignments: b1Kids().assignments.filter(a => a.id !== "ASN-fern") }), marked(B1, "GRP-kids", 2))[0]!;
    expect(briefTarget(later, "PLA0000nov22").facts).not.toBe(target.facts);
  });
});

describe("Breeze: kids roles", () => {
  it("flags a role with fewer people who accepted, never saying a request was or wasn't sent", () => {
    const [f, ...more] = kidsOf(breezeKids(), marked(BREEZE, "nursery", 2, "Nursery"));
    expect(more).toEqual([]);
    expect(f).toMatchObject({
      kind: "too-few-confirmed", tone: "decision", source: "Breeze", needed: 2, confirmed: ["157803"], asked: [], not_sent: [], waiting: ["157804"],
      position: { team_id: kidsTeamId("breeze", "nursery"), name: "Nursery", interval: { starts_at: "2026-11-22T10:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00" } },
    });
    expect(f!.position!.team_id).toBe("role:nursery");
    expect(f!.why).toEqual([
      "Your Church rules ask for at least 2 confirmed people on this kids role at each service time.",
      "Breeze shows 1 person who accepted for this service time, and Ozzie counts accepted as confirmed.",
      "Not answered yet isn't counted as confirmed: 1 hasn't answered, and Breeze doesn't say whether the request was sent.",
      "Ozzie counts confirmed people on the role; it doesn't check ages.",
    ]);
    expect(JSON.stringify(f)).not.toMatch(/Planning Center|Fictional|asked with no answer|not sent yet/u);
  });

  it("matches a role by its name, so a mark holds for the next event's own role ids", () => {
    const next = breezeKids({
      positions: [{ id: "9711", team_id: null, needed: null }], labels: { church: "Juniper Street Church", "position:9711": "  NURSERY " },
      assignments: [{ id: "72001", position_id: "9711", person_id: "157803", status: "accepted", asked: null }],
      names: { "157803": "Wren Fictional" },
    });
    const [f] = kidsOf(next, marked(BREEZE, "nursery", 2));
    expect(f).toMatchObject({ confirmed: ["157803"], position: { name: "NURSERY" } });
    expect(kidsOf(next, marked(BREEZE, "nursery", 1))).toEqual([]);
  });

  it("names the day, never 12:00 AM, for an event with no time of day", () => {
    const capture = breezeUntimedCapture();
    const [f] = kidsOf(capture, marked("breeze:perlandera", "greeter", 1));
    expect(f).toMatchObject({ position: { name: "Greeter", interval: null }, confirmed: [], waiting: ["P-wren"] });
    expect(f!.id).toBe("kids:role:greeter:service");
    expect(f!.why[1]).toBe("Breeze shows no one who accepted for this Sunday, and Ozzie counts accepted as confirmed.");
    // Kit is on the event with no role: said, never counted on the role.
    expect(f!.why).toContain("Breeze lists 1 person on the service with no role; Ozzie doesn't count them on this role.");
    expect(f!.confirmed).not.toContain("P-kit");
    // A Breeze service with no number for any role is never "nothing needs a decision": the kids rule needs one here.
    expect(brief(capture, { systemKids: marked("breeze:perlandera", "greeter", 1).systemKids }).findings.filter(x => x.tone === "decision")).toHaveLength(1);
  });

  it("says a marked role that isn't on this event wasn't counted, and that background checks aren't read", () => {
    const b = brief(breezeKids(), { systemKids: marked(BREEZE, "toddlers", 2).systemKids });
    expect(b.not_checked).toContain("1 kids role isn't on this Sunday's event in Breeze, so it wasn't counted.");
    expect(b.not_checked).toContain("Ozzie doesn't read background checks from Breeze.");
    const cut = breezeKids({ reads: breezeKids().reads.map(r => r.read === "breeze.volunteers" ? { ...r, outcome: "timeout" as const } : r) });
    expect(brief(cut, { systemKids: marked(BREEZE, "nursery", 2).systemKids }).not_checked).toContain(kidsUncounted("role"));
  });

  it("lets a kids question on this Mac find the role's own findings by its name", () => {
    expect(kidsMarked(breezeKids(), marked(BREEZE, "nursery", 2))).toEqual([{ team_id: "role:nursery", name: "Nursery", role: "nursery" }]);
    expect(kidsMarked(b1Kids(), marked(B1, "GRP-kids", 2, "Old name"))).toEqual([{ team_id: "GRP-kids", name: "Kids Ministry" }]);
    expect(kidsMarked(b1Kids(), marked(B1, "GRP-youth", 2, "Youth"))).toEqual([{ team_id: "GRP-youth", name: "Youth" }]);
  });
});

describe("only the church a mark was set for", () => {
  it("reads marks by the capture's own church, and nothing for Genesis", () => {
    expect(placeholderScope(b1Kids())).toBe(B1);
    const rules = marked(B1, "GRP-kids", 2);
    expect(systemKidsFindings(b1Kids({ church: { id: "CHU0000other", time_zone: "America/Chicago" } }), rules, { interval: null, day: SUNDAY_WORDS }))
      .toEqual({ findings: [], not_checked: [] });
    expect(systemKidsMarks(rules, "genesis:ORG-maple")).toEqual([]);
  });
});
