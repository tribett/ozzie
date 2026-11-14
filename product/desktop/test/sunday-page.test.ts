import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionForm, LeaderNote, OperationsSection, SundayPage } from "../src/sunday-page.js";
import { RulesPage } from "../src/rules-page.js";
import { buildSundayBrief, teamLeaders, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { nov22Capture, nov22LaterCapture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { fictionalOperations } from "../../../core/src/fictional-operations.js";
import { decide, type SundayDecision } from "../../../core/src/sunday-decisions.js";

const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const leadRules: SundayRules = { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
const AT = "2026-11-20T15:10:00Z";
const brief = (capture: SundayCapture = nov22Capture(), r = rules, now = capture.completed_at) => buildSundayBrief(capture, r, now, true);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
function page(b: SundayBrief, decisions: SundayDecision[] = [], operations: ReturnType<typeof fictionalOperations> | null = null) {
  return renderToStaticMarkup(React.createElement(SundayPage, {
    brief: b, names: nov22Capture().names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
    canReword: false, decisions, onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
  }));
}
const nurseryDecision = (b = brief()) => decide(b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!, "not-needed", "Only two babies registered", AT);
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|score|rank(ed|ing)?|at risk|drifting)\b/i;

describe("Sunday page", () => {
  it("offers Sunday-only decisions and the leader note when nobody on the team qualifies", () => {
    const t = text(page(brief()));
    expect(t).toContain("Covered outside Planning Center");
    expect(t).toContain("Not needed this Sunday");
    expect(t).toContain("Prepare a note to the team's leader");
    expect(t).toContain("Or, for this Sunday only:");
  });

  it("uses no forbidden wording anywhere on the page", () => {
    // "not ranked" is the one allowed use: it says the list is unranked.
    for (const html of [page(brief(nov22LaterCapture()), [nurseryDecision()], fictionalOperations()), page(brief(), [nurseryDecision()]), page(brief(nov22Capture(), leadRules))])
      expect(text(html).replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
  });

  it("a decision shows as resolved by you for this Sunday only, never as confirmed coverage", () => {
    const t = text(page(brief(), [nurseryDecision()]));
    expect(t).toContain("Resolved by you — this Sunday only");
    expect(t).toContain("Nursery isn't needed this Sunday.");
    expect(t).toContain("“Only two babies registered”");
    expect(t).toContain("Planning Center still shows 1 remaining request; Ozzie hasn't changed anything there.");
    expect(t).not.toContain("Confirmed in Planning Center");
    expect(t).toContain("1 thing needs a decision");
    expect(t).toContain("You resolved 1 yourself.");
  });

  it("a later check that changes the facts brings it back, says what changed and keeps the reason", () => {
    const t = text(page(brief(nov22LaterCapture()), [nurseryDecision()]));
    expect(t).toContain("This needs attention again");
    expect(t).toContain("What changed since you decided");
    expect(t).toContain("Planning Center now shows 2 remaining requests; it was 1 when you decided.");
    expect(t).toContain("Blake Ashgrove is no longer confirmed in Planning Center.");
    expect(t).toContain("Earlier, you said not needed this Sunday");
    expect(t).toContain("“Only two babies registered”");
    expect(t).not.toContain("Resolved by you — this Sunday only");
  });

  it("a gap Planning Center shows filled is source-confirmed, with the manual note kept", () => {
    const capture = nov22Capture();
    const needs = capture.reads.find(r => r.collection === "needed_positions")!.body!.data as { attributes: { team_position_name: string } }[];
    needs.splice(needs.findIndex(n => n.attributes.team_position_name === "Nursery"), 1);
    const t = text(page(brief(capture), [nurseryDecision()]));
    expect(t).toContain("Confirmed in Planning Center");
    expect(t).toContain("Nursery is now filled in Planning Center.");
    expect(t).toContain("Earlier, you said not needed this Sunday");
  });

  it("asks the lead question when a team leader exists but no one is scheduled to lead", () => {
    const t = text(page(brief(nov22Capture(), leadRules)));
    expect(t).toContain("I found the team's leader in Planning Center, but no one scheduled to lead this Sunday. Is that expected?");
    expect(t).toContain("Yes, that's expected");
    expect(t).toContain("Prepare a note to the leader");
  });

  it("an incomplete check is Worth a look, listed first, and names what wasn't read", () => {
    const capture = nov22Capture();
    const read = capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.riley)!;
    read.outcome = "timeout"; delete read.body;
    const t = text(page(brief(capture)));
    expect(t).toContain("Part of this Sunday couldn't be checked.");
    expect(t).toContain("Blockouts for 1 person: took too long.");
    expect(t.indexOf("Part of this Sunday couldn't be checked.")).toBeLessThan(t.indexOf("Greeter still needs"));
    expect(t).toContain("Part of this Sunday couldn't be checked, so this isn't a full picture.");
    // Riley's blockout read failed; that is not the same as having a blockout.
    expect(t).toContain("Their blockouts couldn't be checked (one repeats, or the read didn't finish).");
    expect(t).not.toContain("Has a blockout Ozzie can't check");
    expect(t).not.toContain("Recorded availability couldn't be verified.");
  });

  it("never says nothing needs a decision when the check is incomplete", () => {
    const capture = nov22Capture();
    capture.reads.find(r => r.collection === "needed_positions")!.outcome = "timeout";
    const t = text(page(brief(capture)));
    expect(t).not.toContain("Nothing needs a decision");
    expect(t).toContain("Nothing in what was read needs a decision");
  });

  it("with only a possible conflict, says no one is clear rather than '0 people'", () => {
    const capture = nov22Capture();
    const riley = capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.riley)!;
    riley.body = { data: [{ type: "Blockout", id: "803", attributes: { starts_at: "2026-11-22T13:00:00Z", ends_at: "2026-11-22T17:00:00Z", repeat_frequency: "no_repeat" } }] };
    const t = text(page(brief(capture)));
    expect(t).toContain("No one else on the team is clear with no overlap found; one person has a possible conflict.");
    expect(t).not.toMatch(/\b0 people\b/);
  });

  it("an old live check says it's out of date", () => {
    const t = text(renderToStaticMarkup(React.createElement(SundayPage, {
      brief: buildSundayBrief(nov22Capture(), rules, "2026-11-20T18:00:00Z"), names: {}, busy: false, problem: "", sender: "", connected: true, hasRecording: false,
      configured: true, canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    })));
    expect(t).toContain("This check is out of date.");
    expect(t).toContain("This check is out of date, so it isn't a current picture.");
    expect(t).toContain("Check Planning Center again before relying on it.");
    expect(t).not.toContain("Nothing needs a decision");
  });

  it("What I didn't check says rooms and follow-ups weren't checked until there's a result", () => {
    expect(text(page(brief()))).toContain("Room bookings and follow-ups weren't part of this check.");
    const t = text(page(brief(), [], fictionalOperations()));
    expect(t).not.toContain("Room bookings and follow-ups weren't part of this check.");
    expect(t).toContain("Groups events weren't part of this check.");
  });
});

describe("rooms and follow-ups slot", () => {
  it("renders the operations findings with their labels, next steps and check times", () => {
    const t = text(renderToStaticMarkup(React.createElement(OperationsSection, { operations: fictionalOperations() })));
    expect(t).toContain("Room use needs review");
    expect(t).toContain("Fellowship Hall has overlapping bookings from");
    expect(t).toContain("counting the 30 minutes of setup your Church rules set for this room");
    expect(t).toContain("Review these room bookings in your church tools.");
    expect(t).toContain("Follow-up needs an owner");
    expect(t).toContain("“Call a first-time guest” has no owner.");
    expect(t).toContain("Why I flagged this");
    expect(t).toContain("Choose who will handle this follow-up in your church tools.");
    expect(t).toContain("Checked");
  });
  it("uncertain operations are Worth a look, never a clear", () => {
    const operations = fictionalOperations();
    const t = text(renderToStaticMarkup(React.createElement(OperationsSection, { operations: { ...operations, result: { ...operations.result, status: "unverified", findings: [],
      uncertainties: [{ code: "unknown-rule", scope_id: "hall-rule", subject_id: "hall", label: "Worth a look" }] } } })));
    expect(t).toContain("Worth a look");
    expect(t).toContain("A room isn't set as not shared in Church rules");
    expect(t).not.toContain("No room overlaps");
  });
});

describe("drafts and decision form", () => {
  it("the note to the leader is a draft only, addressed by first name, with no send action", () => {
    const nursery = brief().findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    const html = renderToStaticMarkup(React.createElement(LeaderNote, { finding: nursery, leader: PEOPLE.nurseryLeader, names: nov22Capture().names, sender: "Pat", onClose: () => undefined }));
    const t = text(html);
    expect(t).toContain("Draft only. Nothing has been sent.");
    expect(t).toContain("To Jordan Ashdown (team leader in Planning Center)");
    expect(t).toContain("Hi Jordan,");
    expect(t).toContain("Copy draft");
    expect(t).toContain("Change the wording");
    expect(t).not.toMatch(/\bSend\b|Ask Ozzie to reword/);
  });
  it("a decision needs a reason before it can be saved", () => {
    const html = renderToStaticMarkup(React.createElement(DecisionForm, { choice: "covered-outside", onSave: () => undefined, onCancel: () => undefined }));
    expect(html).toMatch(/<button type="submit"[^>]*disabled[^>]*>Mark it covered for this Sunday<\/button>/);
    expect(text(html)).toContain("It applies to this Sunday only");
  });
});

describe("Church rules page", () => {
  it("shows the team's leader as oversight, separate from a scheduled lead", () => {
    const capture = nov22Capture();
    const positions = [{ position_id: "position:2", team_id: TEAMS.nursery, name: "Nursery", interval: null }, { position_id: "position:1", team_id: TEAMS.greeter, name: "Greeter", interval: null }];
    const t = text(renderToStaticMarkup(React.createElement(RulesPage, { rules: leadRules, onChange: () => undefined, positions, leaders: teamLeaders(capture), names: capture.names })));
    expect(t).toContain("Planning Center lists Jordan Ashdown as this team's leader. That's oversight, not someone scheduled to lead on Sunday.");
    expect(t).toContain("Planning Center doesn't list a leader for this team.");
  });
});
