import { describe, expect, it } from "vitest";
import { canEscalate, escalationDraft, restoreEscalation } from "../src/escalation-draft.js";
import { buildRewordRequest } from "../src/draft-request.js";
import { buildSundayBrief, type Finding } from "../src/sunday-brief.js";
import type { SundayRules } from "../src/sunday-capture.js";
import { nov22Capture, PEOPLE, TEAMS } from "../src/fictional-sunday.js";

const NOW = "2026-11-20T15:05:00Z";
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const capture = nov22Capture();
const findings = buildSundayBrief(capture, rules, NOW).findings;
const nursery = findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
const greeter = findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
const lead = buildSundayBrief(capture, { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] }, NOW)
  .findings.find(f => f.kind === "lead-missing")!;

describe("note to the team's leader", () => {
  it("is offered only when nobody on the team qualifies and Planning Center lists a leader", () => {
    expect(canEscalate(nursery)).toBe(true);
    expect(canEscalate(greeter)).toBe(false); // someone could help, so ask them first
    expect(canEscalate({ ...nursery, leaders: [] })).toBe(false);
    const unread: Finding = { ...nursery };
    delete unread.leaders; // the team-leader read didn't complete
    expect(canEscalate(unread)).toBe(false);
    expect(canEscalate(lead)).toBe(true);
    expect(canEscalate(findings.find(f => f.kind === "pending")!)).toBe(false);
  });

  it("is written in placeholder form on this Mac, with no name in it", () => {
    const draft = escalationDraft({ finding: nursery, leader_id: PEOPLE.nurseryLeader });
    expect(draft.text.startsWith("Hi [Leader A],")).toBe(true);
    expect(draft.text).toContain("[Role] on ");
    expect(draft.text).toContain("still needs one more person");
    expect(draft.text).toContain("couldn't find anyone else on the team");
    expect(draft.text.endsWith("Thank you,\n[Your name]")).toBe(true);
    for (const name of Object.values(capture.names).flatMap(n => n.split(" "))) expect(draft.text).not.toContain(name);
    expect(draft.text).not.toMatch(/\b(pray|bless|god|lord|scripture)/i);
  });

  it("restores the leader's first name, the role and the sender locally", () => {
    const ctx = { finding: nursery, leader_id: PEOPLE.nurseryLeader };
    const text = restoreEscalation(escalationDraft(ctx), ctx, capture.names, "Pat");
    expect(text.startsWith("Hi Jordan,")).toBe(true);
    expect(text).toContain("Nursery on ");
    expect(text.endsWith("Thank you,\nPat")).toBe(true);
    expect(text).not.toContain("[");
    expect(restoreEscalation(escalationDraft(ctx), ctx, {}, "").startsWith("Hi there,")).toBe(true);
  });

  it("asks about a missing scheduled lead without treating the leader as the lead", () => {
    const ctx = { finding: lead, leader_id: PEOPLE.nurseryLeader };
    const text = restoreEscalation(escalationDraft(ctx), ctx, capture.names, "Pat");
    expect(text).toContain("I don't see anyone scheduled to lead the Nursery team on ");
    expect(text).toContain("Is that expected this week, or should we find someone?");
  });

  it("only addresses a leader Planning Center lists for this team", () => {
    expect(() => escalationDraft({ finding: nursery, leader_id: PEOPLE.riley })).toThrow();
    expect(() => escalationDraft({ finding: greeter, leader_id: PEOPLE.nurseryLeader })).toThrow();
  });

  it("can't be sent for AI rewording; the volunteer-request boundary refuses it", () => {
    const draft = escalationDraft({ finding: nursery, leader_id: PEOPLE.nurseryLeader });
    expect(() => buildRewordRequest(draft as never, "warmer", capture.names)).toThrow(/Only Ozzie's own/);
  });
});
