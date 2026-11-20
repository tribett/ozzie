// The service check from a B1 Church or Breeze capture, as the same brief a Planning Center check gives: findings, their
// "Why I flagged this" in the system's own name, and every gap said as Worth a look. Fictional data only.
import { describe, expect, it } from "vitest";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { cannotSee } from "../../src/church-systems/facts.js";
import { briefTarget, stopEntry } from "../../src/finding-feedback.js";
import { fictionalB1, fictionalBreeze } from "../../src/church-systems/fictional.js";
import { parseSystemCapture } from "../../src/church-systems/types.js";
import type { SystemCapture } from "../../src/church-systems/types.js";
import { B1_READS, b1Capture, breezeCapture, factsCapture, NOW, readsOf } from "./fixtures.js";

const confirmed = (capture: SystemCapture) => ({ confirmedZone: capture.church.time_zone });
function brief(capture: SystemCapture, rules = confirmed(capture), now = NOW) {
  const built = buildSystemBrief(capture, rules, now);
  if (!built.ok) throw new Error(built.reason);
  return built;
}
const kinds = (capture: SystemCapture) => brief(capture).brief.findings.map(f => [f.kind, f.position?.name ?? null]);

describe("buildSystemBrief: B1 Church", () => {
  it("names the open roles and who hasn't answered, with the plan's own day and title", () => {
    const { brief: b } = brief(b1Capture());
    expect(b.mode).toBe("live");
    expect(b.plan).toEqual({ id: "PLA0000nov22", title: "Sunday Gathering", dates: "Sunday, November 22", sort_date: null, date: "2026-11-22",
      starts_at: "2026-11-22T09:00:00-06:00" });
    expect(b.day?.question).toBe("Are your services covered?");
    expect(b.day?.day).toBe("Sunday");
    expect(b.status).toBe("findings");
    expect(kinds(b1Capture())).toEqual([["needs-people", "Vocals"], ["needs-people", "Guitar"], ["needs-people", "Greeter"], ["pending", "Greeter"]]);
    expect(b.positions).toEqual([
      { team_id: "GRP-worship", name: "Vocals", remaining: 1, pending: 0, lead: "not-required" },
      { team_id: "GRP-worship", name: "Guitar", remaining: 1, pending: 0, lead: "not-required" },
      { team_id: "GRP-hosp", name: "Greeter", remaining: 1, pending: 1, lead: "not-required" },
    ]);
  });

  it("says why in B1 Church's own name, never Planning Center's", () => {
    const { brief: b } = brief(b1Capture());
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/Planning Center/u);
    const vocals = b.findings.find(f => f.id === "need:POS-vocals")!;
    expect(vocals.why).toEqual([
      "B1 Church asks for 2 people for Vocals, and 1 person has said yes or is waiting to answer.",
      "Ozzie counts each person once, and doesn't count anyone who said no.",
      "People are listed from this role's team in B1 Church, checked against their blockouts and other plans. They are not ranked.",
    ]);
    expect(vocals.confirmed).toEqual(["PER-rowan"]);
    // Bram is free; Ember is blocked out all weekend and is left out.
    expect(vocals.people?.suggestions.map(p => p.person_id)).toEqual(["PER-bram"]);
    expect(vocals.people?.left_out.map(p => p.person_id)).toEqual(["PER-ember"]);
    const guitar = b.findings.find(f => f.id === "need:POS-guitar")!;
    expect(guitar.why[0]).toBe("B1 Church asks for 1 person for Guitar, and nobody has said yes or is waiting to answer.");
  });

  it("a request not sent yet says so; one B1 doesn't report is said as unknown, never as not sent", () => {
    const lark = brief(b1Capture()).brief.findings.find(f => f.kind === "pending")!;
    expect(lark).toMatchObject({ person_id: "PER-lark", notification: "unsent" });
    expect(lark.why).toEqual(["B1 Church shows this person hasn't answered yet.", "B1 Church shows the request hasn't been sent yet. Not answered isn't the same as asked."]);
    const unknown = b1Capture({ assignments: b1Capture().assignments.map(a => a.id === "ASN-lark" ? { ...a, asked: null } : a) });
    const said = brief(unknown).brief.findings.find(f => f.kind === "pending")!;
    expect(said.notification).toBeUndefined();
    expect(said.why[1]).toBe("B1 Church doesn't say whether the request was sent.");
  });

  it("points out someone who said yes and is blocked out over the service, without changing the count", () => {
    const capture = b1Capture({ blockouts: [{ person_id: "PER-rowan", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" }] });
    const { brief: b } = brief(capture);
    const blockout = b.findings.find(f => f.kind === "blockout")!;
    expect(blockout).toMatchObject({ person_id: "PER-rowan", tone: "look", serving: [{ name: "Vocals", status: "confirmed" }] });
    expect(blockout.why[0]).toBe("B1 Church has them saying yes for Vocals.");
    expect(b.positions[0]!.remaining).toBe(1);
  });

  it("holds the check back until the leader confirms the church's time zone, and says so", () => {
    const built = brief(b1Capture(), { confirmedZone: null });
    expect(built.coverage.waiting_for_zone).toBe(true);
    expect(built.brief.status).toBe("unverified");
    expect(built.brief.findings.some(f => f.kind === "needs-people")).toBe(false);
    const look = built.brief.findings.find(f => f.kind === "worth-a-look")!;
    expect(look.why[0]).toBe("Ozzie is waiting for you to confirm your church's time zone before it checks this plan.");
    // No day is named while the zone waits.
    expect(built.brief.day?.question).toBe("Are your services covered?");
    expect(built.brief.day?.day).toBe("your service");
  });

  it("a read that didn't finish is Worth a look with the part named, never covered", () => {
    const capture = b1Capture({ reads: readsOf(B1_READS, { "b1.blockouts": "timeout", "b1.group_members": "refused" }) });
    const { brief: b } = brief(capture);
    const look = b.findings.find(f => f.kind === "worth-a-look")!;
    // Each part with what to do about it (round 4).
    expect(look.unread).toEqual(["Team members: B1 Church didn't allow it. The key sees only what the person who made it can see.",
      "Blockouts: took too long. Check B1 Church again in a moment."]);
    expect(look.why).toContain("2 B1 Church reads didn't complete, so this check isn't a full picture.");
    expect(b.sources.failed).toEqual([{ collection: "b1.group_members", outcome: "refused" }, { collection: "b1.blockouts", outcome: "timeout" }]);
    expect(b.status).toBe("unverified");
  });

  it("an old check is out of date, and every line of what wasn't checked comes from B1 Church's own list", () => {
    const { brief: b } = brief(b1Capture(), confirmed(b1Capture()), "2026-11-20T16:00:00Z");
    expect(b.stale).toBe(true);
    // Only what bears on checking the service (round 4); the whole list is under "Also read" and in Settings.
    expect(b.not_checked.slice(0, cannotSee("b1", "service").length)).toEqual([...cannotSee("b1", "service")]);
    expect(b.not_checked).not.toContain("Ozzie doesn't read attendance from B1 Church yet.");
    expect(b.not_checked).toContain("Anything changed in B1 Church since this check isn't shown. Check again before relying on it.");
  });

  it("a plan not shared with volunteers yet is said beside the findings", () => {
    const capture = b1Capture({ service: { ...b1Capture().service!, shared: false } });
    expect(brief(capture).notices).toEqual(["This plan isn't shared with volunteers yet in B1 Church, so they may not have seen it."]);
    expect(brief(b1Capture()).notices).toEqual([]);
  });

  it("a finding the leader set aside (Stop flagging this) stays set aside on the next check", () => {
    const first = brief(b1Capture()).brief.findings.find(f => f.id === "pending:ASN-lark")!;
    const target = briefTarget(first, "PLA0000nov22", "Sunday, November 22");
    const stop = stopEntry(target, target.scope, "2026-11-20T15:05:00Z");
    const built = buildSystemBrief(b1Capture(), { ...confirmed(b1Capture()), feedback: [stop] }, NOW);
    if (!built.ok) throw new Error(built.reason);
    expect(built.brief.findings.map(f => f.id)).not.toContain("pending:ASN-lark");
    expect(built.brief.hidden?.map(h => h.finding.id)).toEqual(["pending:ASN-lark"]);
  });
});

describe("buildSystemBrief: Breeze", () => {
  const answered = (over: Partial<SystemCapture> = {}) => breezeCapture({
    assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "unconfirmed", asked: null },
    ],
    ...over,
  });

  it("counts the open place, says nobody can be suggested, and never claims a request wasn't sent", () => {
    const { brief: b } = brief(answered());
    const teacher = b.findings.find(f => f.kind === "needs-people")!;
    expect(teacher.why[2]).toBe("Breeze doesn't tie a team to each role, so Ozzie can't suggest who could help.");
    const pending = b.findings.find(f => f.kind === "pending")!;
    expect(pending.notification).toBeUndefined();
    expect(pending.why).toEqual(["Breeze shows this person hasn't answered yet.", "Breeze doesn't say whether the request was sent."]);
    expect(JSON.stringify(b)).not.toMatch(/Planning Center/u);
    expect(b.not_checked).toContain("Ozzie can't read blockout dates from Breeze.");
  });

  it("a role with no number when others have one is Worth a look, by name (review of round 4, M2)", () => {
    const capture = answered({ positions: [{ id: "9627", team_id: null, needed: null }, { id: "9628", team_id: null, needed: 1 }] });
    const b = brief(capture).brief;
    const said = "Breeze didn't share how many people Teacher needs, so Ozzie can't say whether it is full.";
    expect(b.findings.find(f => f.kind === "worth-a-look")?.why).toContain(said);
    expect(b.not_checked).toContain(said);
    expect(b.status).toBe("unverified");
    // The same on B1 Church: a role whose count B1 didn't give is never silently left out.
    const b1 = b1Capture({ positions: b1Capture().positions.map(p => p.id === "POS-guitar" ? { ...p, needed: null } : p) });
    expect(brief(b1, confirmed(b1)).brief.findings.find(f => f.kind === "worth-a-look")?.why).toContain(
      "B1 Church didn't share how many people Guitar needs, so Ozzie can't say whether it is full.");
  });

  it("someone on the service with no role is said beside the findings", () => {
    const capture = answered({ on_service: ["157803"], names: { "157801": "Juniper Fictional", "157802": "Linden Fictional", "157803": "Sorrel Fictional" } });
    expect(brief(capture).notices).toEqual(["1 person is listed on this service without a role."]);
  });
});

describe("buildSystemBrief: what isn't a service check", () => {
  it("Genesis has none, and a capture with no service or no roles says so", () => {
    expect(buildSystemBrief(factsCapture("genesis"), {}, NOW)).toEqual({ ok: false, reason: "no-sunday-check" });
    expect(buildSystemBrief(b1Capture({ service: null }), {}, NOW)).toEqual({ ok: false, reason: "no-service" });
    const noRoles = b1Capture({ positions: [], assignments: [], labels: { church: "Cedar Hollow Fellowship", service: "Sunday Gathering",
      "group:GRP-worship": "Worship", "group:GRP-youth": "Youth Night", "event:SES-nov15": "Sunday Gathering", "form:FRM-serve": "Serve Sign-up" },
    team_members: [], names: {}, busy: [], blockouts: [] });
    expect(buildSystemBrief(noRoles, confirmed(noRoles), NOW)).toEqual({ ok: false, reason: "no-roles" });
  });
});

describe("the fictional example church on each system", () => {
  it("is a capture the page accepts, read as of its own check, in that system's own words", () => {
    for (const make of [fictionalB1, fictionalBreeze]) {
      const capture = make();
      expect(parseSystemCapture(JSON.parse(JSON.stringify(capture))).ok).toBe(true);
      const built = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, "2027-01-01T00:00:00Z", { fictional: true });
      if (!built.ok) throw new Error(built.reason);
      expect(built.brief.mode).toBe("fictional");
      expect(built.brief.stale).toBe(false);
      // Read as of its own check: every read was whole, so nothing is "couldn't be checked".
      expect(built.brief.findings.some(f => f.kind === "worth-a-look")).toBe(false);
      expect(built.brief.status).toBe("findings");
      expect(JSON.stringify(built.brief)).not.toMatch(/Planning Center/u);
      expect(Object.values(capture.names).every(n => n.endsWith("Fictional"))).toBe(true);
    }
    expect(buildSystemBrief(fictionalB1(), { confirmedZone: "America/Chicago" }, "2026-11-20T15:05:00Z", { fictional: true }).ok).toBe(true);
  });
});
